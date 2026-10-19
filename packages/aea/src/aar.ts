/**
 * Apple Archive (.aar) reader: the "AA01" / "YAA1" entry format written by `aa archive`, by
 * AppleArchive.framework, and inside OTA packages.
 *
 * Each entry is a header (magic, u16le header size, then fields) followed by the entry's blobs (file
 * data, extended attributes) in field order. A field is a 3-character key plus a 1-character type:
 *
 *   '*'            flag, no value
 *   '1' '2' '4' '8' unsigned little-endian integer of that many bytes
 *   'P'            string: u16le length + bytes
 *   'S' 'T'        timestamp: s64le seconds ('S'), plus u32le nanoseconds ('T')
 *   'F'..'J'       digest: CRC32 (4), SHA-1 (20), SHA-256 (32), SHA-384 (48), SHA-512 (64)
 *   'A' 'B' 'C'    blob whose size is a u16le, u32le or u64le; the bytes follow the header
 *
 * Archives made by `aa archive` are usually wrapped in a `pbz?` compressed stream, which
 * `openArchive` unwraps.
 */
import { decryptFileChunks, DecryptOptions } from "./aea.js";
import { isPbz, pbzChunks } from "./compression.js";
import { asBuffer, fileChunks, Reader, TruncatedError } from "./reader.js";

export class ArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchiveError";
  }
}

export interface Timestamp { sec: number; nsec: number }
export type FieldValue = true | number | string | Timestamp | Buffer | { blobSize: number };

const DIGEST_SIZE: Record<string, number> = { F: 4, G: 20, H: 32, I: 48, J: 64 };
const BLOB_SIZE_BYTES: Record<string, number> = { A: 2, B: 4, C: 8 };
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const PREFIX_SIZE = 6; // magic + u16le header size

export interface EntryHeader {
  /** Raw decoded fields, keyed by their 3-letter key (TYP, PAT, DAT, ...). */
  fields: Map<string, FieldValue>;
  /** Blob fields in data order. */
  blobs: { key: string; size: number }[];
}

export function parseHeader(h: Buffer, where = "entry"): EntryHeader {
  const fields = new Map<string, FieldValue>();
  const blobs: { key: string; size: number }[] = [];
  let p = PREFIX_SIZE;
  const take = (n: number) => {
    if (p + n > h.length) throw new ArchiveError(`${where}: header field runs past the header`);
    const at = p;
    p += n;
    return at;
  };
  const uint = (key: string, n: number) => {
    const at = take(n);
    if (n < 8) return h.readUIntLE(at, n);
    const v = h.readBigUInt64LE(at);
    if (v > MAX_SAFE) throw new ArchiveError(`${where}: field ${key} is too large`);
    return Number(v);
  };
  while (p < h.length) {
    const at = take(4);
    const key = h.toString("latin1", at, at + 3), t = String.fromCharCode(h[at + 3]);
    let v: FieldValue;
    switch (t) {
      case "*": v = true; break;
      case "1": case "2": case "4": case "8": v = uint(key, +t); break;
      case "P": {
        const n = uint(key, 2), s = take(n);
        v = h.toString("utf8", s, s + n);
        break;
      }
      case "S": v = { sec: Number(h.readBigInt64LE(take(8))), nsec: 0 }; break;
      case "T": {
        const s = take(12);
        v = { sec: Number(h.readBigInt64LE(s)), nsec: h.readUInt32LE(s + 8) };
        break;
      }
      case "F": case "G": case "H": case "I": case "J": {
        const n = DIGEST_SIZE[t], s = take(n);
        v = Buffer.from(h.subarray(s, s + n));
        break;
      }
      case "A": case "B": case "C": {
        const size = uint(key, BLOB_SIZE_BYTES[t]);
        v = { blobSize: size };
        blobs.push({ key, size });
        break;
      }
      default:
        throw new ArchiveError(`${where}: field ${key} has unknown type '${t}'`);
    }
    fields.set(key, v);
  }
  return { fields, blobs };
}

/** Entry types (the TYP field). */
export const ENTRY_TYPES: Record<string, string> = {
  F: "file", D: "directory", L: "symlink", H: "hardlink", M: "metadata",
  B: "block device", C: "character device", P: "fifo", S: "socket", W: "whiteout", R: "door",
};

export class ArchiveEntry {
  private blobIndex = 0;
  constructor(readonly header: EntryHeader, private readonly r: Reader, readonly index: number) {}

  get fields() { return this.header.fields; }
  /** One-letter entry type: F, D, L, M, ... */
  get type(): string {
    const t = this.fields.get("TYP");
    return typeof t === "number" ? String.fromCharCode(t) : "?";
  }
  get path(): string | undefined { return this.str("PAT"); }
  get linkTarget(): string | undefined { return this.str("LNK"); }
  num(key: string): number | undefined { const v = this.fields.get(key); return typeof v === "number" ? v : undefined; }
  str(key: string): string | undefined { const v = this.fields.get(key); return typeof v === "string" ? v : undefined; }
  time(key: string): Timestamp | undefined {
    const v = this.fields.get(key);
    return v && typeof v === "object" && "sec" in v ? v : undefined;
  }
  digest(key: string): Buffer | undefined { const v = this.fields.get(key); return Buffer.isBuffer(v) ? v : undefined; }
  /** Size of a blob (DAT = file data), or undefined if the entry has none. */
  blobSize(key = "DAT"): number | undefined { return this.header.blobs.find((b) => b.key === key)?.size; }
  /** The YOP field of OTA metadata entries, as a letter. */
  get operation(): string | undefined {
    const v = this.num("YOP");
    return v === undefined ? undefined : String.fromCharCode(v);
  }

  private seek(key: string): number {
    const i = this.header.blobs.findIndex((b, j) => j >= this.blobIndex && b.key === key);
    if (i < 0) throw new ArchiveError(`entry ${this.index}: blob ${key} is missing or was already read`);
    while (this.blobIndex < i) this.r.skip(this.header.blobs[this.blobIndex++].size);
    this.blobIndex++;
    return this.header.blobs[i].size;
  }

  /** Reads a whole blob into memory (fine for XAT and small files). */
  readBlob(key = "DAT"): Buffer {
    return Buffer.from(this.r.read(this.seek(key)));
  }
  /** Streams a blob in chunks. */
  pipeBlob(fn: (chunk: Buffer) => void, key = "DAT"): void {
    this.r.forEach(this.seek(key), fn);
  }
  /** A reader over a blob, e.g. to parse the nested archive inside an OTA metadata entry. */
  blobReader(key = "DAT"): Reader {
    return this.r.limit(this.seek(key), `entry ${this.index} ${key}`);
  }
  /** Skips whatever blobs haven't been consumed. Called automatically before the next entry. */
  finish(): void {
    while (this.blobIndex < this.header.blobs.length) this.r.skip(this.header.blobs[this.blobIndex++].size);
  }
}

/**
 * Iterates over the entries of an Apple Archive stream. Each entry's blobs can be consumed until
 * the iterator advances; anything not consumed is skipped.
 */
export function* readEntries(r: Reader): Generator<ArchiveEntry> {
  let index = 0;
  try {
    while (!r.atEnd()) {
      const head = r.read(PREFIX_SIZE);
      const magic = head.toString("latin1", 0, 4);
      if (magic !== "AA01" && magic !== "YAA1")
        throw new ArchiveError(`entry ${index} at byte ${r.position - PREFIX_SIZE}: bad magic ${JSON.stringify(magic)} (not an Apple Archive, or corrupted)`);
      const size = head.readUInt16LE(4);
      if (size < PREFIX_SIZE) throw new ArchiveError(`entry ${index}: bad header size ${size}`);
      const h = Buffer.concat([head, r.read(size - PREFIX_SIZE)]);
      const entry = new ArchiveEntry(parseHeader(h, `entry ${index}`), r, index++);
      yield entry;
      entry.finish();
    }
  } catch (e) {
    if (e instanceof TruncatedError) throw new ArchiveError(e.message);
    throw e;
  }
}

export type ArchiveKind = "aea" | "pbz" | "aar";

export function detectKind(head: Uint8Array): ArchiveKind | undefined {
  const m = asBuffer(head).toString("latin1", 0, 4);
  if (m === "AEA1") return "aea";
  if (m === "AA01" || m === "YAA1") return "aar";
  if (isPbz(head)) return "pbz";
  return undefined;
}

/** Returns `r` as an Apple Archive entry stream, unwrapping pbz compression if present. */
export function archiveStream(r: Reader): Reader {
  const kind = detectKind(r.peek(4));
  if (kind === "pbz") return new Reader(pbzChunks(r), "decompressed archive");
  if (kind === "aar") return r;
  if (kind === "aea") throw new ArchiveError("this is an encrypted archive (.aea): pass its key to decrypt it");
  throw new ArchiveError("not an Apple Archive (expected AA01, YAA1 or a pbz compressed stream)");
}

export interface OpenOptions extends DecryptOptions {
  /** Required for .aea input. */
  key?: string | Uint8Array;
}

/** Opens an .aar (plain or pbz-compressed) or, with `key`, an .aea file, as an entry stream. */
export function openArchive(path: string, opts: OpenOptions = {}): Reader {
  const chunks = fileChunks(path);
  const file = new Reader(chunks, path);
  if (detectKind(file.peek(4)) === "aea") {
    chunks.return(undefined); // closes the file; decryptFileChunks reopens it
    if (!opts.key) throw new ArchiveError(`${path} is encrypted (.aea): a key is required`);
    return archiveStream(new Reader(decryptFileChunks(path, opts.key, opts), "decrypted archive"));
  }
  return archiveStream(file);
}

export interface ListedEntry {
  type: string;
  path: string;
  size?: number;
  link?: string;
  mode?: number;
}

/**
 * Lists the filesystem entries of an archive. OTA metadata entries (TYP=M with YOP=E) carry nested
 * archives; their contents are listed in place.
 */
export function* listEntries(r: Reader): Generator<ListedEntry> {
  for (const e of readEntries(r)) {
    if (e.type === "M") {
      if (e.operation === "E" && e.blobSize() !== undefined) yield* listEntries(e.blobReader());
      continue;
    }
    yield { type: e.type, path: e.path ?? "", size: e.blobSize(), link: e.linkTarget, mode: e.num("MOD") };
  }
}
