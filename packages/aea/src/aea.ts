/**
 * Apple Encrypted Archive (.aea) decryption for the symmetric-key profile (1) used by OTA updates:
 * HKDF-SHA256 key schedule, AES-256-CTR, HMAC-SHA256 over every header and segment. Every MAC is
 * checked before the data it covers is used.
 */
import { createDecipheriv, createHash, createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { closeSync, openSync, rmSync, statSync } from "node:fs";
import { ALGORITHMS, decompress, DecompressError, UnsupportedCompressionError } from "./compression.js";
import { fileChunks, Reader, TruncatedError, writeAll } from "./reader.js";

export type AeaErrorCode = "NOT_AEA" | "UNSUPPORTED" | "WRONG_KEY" | "CORRUPT" | "TRUNCATED" | "BAD_KEY";

export class AeaError extends Error {
  constructor(readonly code: AeaErrorCode, message: string) {
    super(message);
    this.name = "AeaError";
  }
}

export const PROFILES: Record<number, string> = {
  0: "hkdf_sha256_hmac__none__ecdsa_p256",
  1: "hkdf_sha256_aesctr_hmac__symmetric__none",
  2: "hkdf_sha256_aesctr_hmac__symmetric__ecdsa_p256",
  3: "hkdf_sha256_aesctr_hmac__ecdhe_p256__none",
  4: "hkdf_sha256_aesctr_hmac__ecdhe_p256__ecdsa_p256",
  5: "hkdf_sha256_aesctr_hmac__scrypt__none",
};
const PROFILE_SYMMETRIC = 1;
const PROLOGUE_SIZE = 12; // "AEA1", u32 profile | strength << 24, u32 auth data size
const MAC_SIZE = 32;
const SALT_SIZE = 32;
const ROOT_HEADER_SIZE = 48;
const KEY_SIZE = 32;
const EMPTY = Buffer.alloc(0);

/** Segment checksum types (root header byte 25). `matches` compares plaintext to the stored value. */
interface Checksum { name: string; size: number; matches?: (plain: Buffer, stored: Buffer) => boolean }
const CHECKSUMS: Record<number, Checksum> = {
  0: { name: "none", size: 0 },
  1: { name: "murmur64", size: 8, matches: (plain, stored) => murmur64(plain) === stored.readBigUInt64LE(0) },
  2: { name: "sha256", size: 32, matches: (plain, stored) => createHash("sha256").update(plain).digest().equals(stored) },
};

/**
 * Parses a 32-byte symmetric key: "base64:...", "hex:...", 64 hex digits, or plain base64 (the form
 * Apple's servers publish OTA keys in).
 */
export function parseKey(key: string | Uint8Array): Buffer {
  let k: Buffer;
  if (typeof key !== "string") k = Buffer.from(key);
  else {
    const v = key.trim();
    if (/^hex:/i.test(v)) {
      if (!/^[0-9a-f]*$/i.test(v.slice(4))) throw new AeaError("BAD_KEY", "hex key contains non-hex characters");
      k = Buffer.from(v.slice(4), "hex");
    } else if (/^[0-9a-f]{64}$/i.test(v)) k = Buffer.from(v, "hex");
    else {
      const b = v.replace(/^base64:/i, "");
      if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(b)) throw new AeaError("BAD_KEY", "key isn't valid base64 or hex");
      k = Buffer.from(b, "base64");
    }
  }
  if (k.length !== KEY_SIZE) throw new AeaError("BAD_KEY", `key must be ${KEY_SIZE} bytes, got ${k.length}`);
  return k;
}

const hkdf = (ikm: Buffer, info: Buffer, len: number, salt = EMPTY) =>
  Buffer.from(hkdfSync("sha256", ikm, salt, info, len));

interface Keys { mac: Buffer; key: Buffer; iv: Buffer }
/** MAC key (32), AES key (32) and CTR IV (16), derived together. */
function keys(ikm: Buffer, info: Buffer): Keys {
  const b = hkdf(ikm, info, 80);
  return { mac: b.subarray(0, 32), key: b.subarray(32, 64), iv: b.subarray(64, 80) };
}

const label = (s: string, n?: number) => {
  const l = Buffer.from(s, "latin1");
  if (n === undefined) return l;
  const i = Buffer.alloc(4);
  i.writeUInt32LE(n >>> 0);
  return Buffer.concat([l, i]);
};

/** AEA's MAC: HMAC-SHA256(key, salt || data || le64(len(salt))). */
function mac(key: Buffer, data: Buffer, salt = EMPTY): Buffer {
  const len = Buffer.alloc(8);
  len.writeBigUInt64LE(BigInt(salt.length));
  return createHmac("sha256", key).update(salt).update(data).update(len).digest();
}

/** CTR is a stream mode: update() returns every byte and final() adds none, so skip the concat. */
function aesCtr(k: Keys, data: Buffer): Buffer {
  const d = createDecipheriv("aes-256-ctr", k.key, k.iv);
  const out = d.update(data);
  d.final();
  return out;
}

const same = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b);

/** MurmurHash64A with AEA's seed: the "murmur64" segment checksum. */
export function murmur64(data: Uint8Array, seed = 0xe2236fdc26a5f6d2n): bigint {
  const M = (1n << 64n) - 1n, m = 0xc6a4a7935bd1e995n, r = 47n;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let h = (seed ^ ((BigInt(data.length) * m) & M)) & M;
  const n = Math.floor(data.length / 8);
  for (let i = 0; i < n; i++) {
    let k = dv.getBigUint64(i * 8, true);
    k = (k * m) & M; k ^= k >> r; k = (k * m) & M;
    h ^= k; h = (h * m) & M;
  }
  const t = data.length - n * 8;
  if (t) {
    let k = 0n;
    for (let i = t - 1; i >= 0; i--) k = (k << 8n) | BigInt(data[n * 8 + i]);
    h ^= k; h = (h * m) & M;
  }
  h ^= h >> r; h = (h * m) & M; h ^= h >> r;
  return h;
}

export interface AeaHeader {
  profile: number;
  profileName: string;
  /** Raw authentication data from the prologue (unencrypted, but covered by the MACs). */
  authData: Buffer;
  /** Auth data decoded as key-value pairs, when it uses that layout (OTA packages do). */
  authFields: Record<string, string> | null;
}

/** Decodes the key-value auth data layout: repeated (u32le record size, key NUL, value). */
export function parseAuthData(b: Buffer): Record<string, string> | null {
  const out: Record<string, string> = {};
  let p = 0;
  while (p < b.length) {
    if (p + 4 > b.length) return null;
    const n = b.readUInt32LE(p);
    if (n < 5 || p + n > b.length) return null;
    const rec = b.subarray(p + 4, p + n);
    const nul = rec.indexOf(0);
    if (nul < 1) return null;
    out[rec.toString("utf8", 0, nul)] = rec.toString("utf8", nul + 1);
    p += n;
  }
  return out;
}

function readPrologue(r: Reader): { header: AeaHeader; profileAndStrength: number } {
  const hdr = r.peek(PROLOGUE_SIZE);
  if (hdr.length < 4 || hdr.toString("latin1", 0, 4) !== "AEA1")
    throw new AeaError("NOT_AEA", "not an Apple Encrypted Archive (missing AEA1 magic)");
  r.read(PROLOGUE_SIZE);
  const profileAndStrength = hdr.readUInt32LE(4);
  const profile = profileAndStrength & 0xffffff;
  const authData = Buffer.from(r.read(hdr.readUInt32LE(8)));
  return {
    header: { profile, profileName: PROFILES[profile] ?? `unknown (${profile})`, authData, authFields: parseAuthData(authData) },
    profileAndStrength,
  };
}

/** Reads the unencrypted prologue (profile and auth data). No key needed. */
export function readAeaHeader(path: string): AeaHeader {
  const it = fileChunks(path, 1 << 16);
  try {
    return readPrologue(new Reader(it, path)).header;
  } catch (e) {
    throw e instanceof TruncatedError ? new AeaError("TRUNCATED", e.message) : e;
  } finally {
    it.return(undefined);
  }
}

export interface DecryptInfo {
  header: AeaHeader;
  /** Decrypted (plaintext) size in bytes. */
  size: number;
  segmentSize: number;
  segmentsPerCluster: number;
  compression: string;
  checksum: string;
}

export interface DecryptOptions {
  /** Called once the root header has been authenticated, before any data is produced. */
  onInfo?: (info: DecryptInfo) => void;
  /** Called after each cluster with plaintext bytes produced so far and the total. */
  onProgress?: (done: number, total: number) => void;
  /**
   * Size of the encrypted input, when known; enables an early, clear error for truncated files.
   * `decryptFile`, `decryptFileChunks` and `openArchive` set it from the file.
   */
  inputSize?: number;
}

/**
 * Decrypts an AEA stream, yielding the plaintext in order. Each chunk is yielded only after its
 * MAC (and checksum, if any) has been verified. The trailing padding MAC is checked before the
 * generator finishes, so consume it to completion to know the whole file verified.
 */
export function* decryptChunks(input: Reader, key: string | Uint8Array, opts: DecryptOptions = {}): Generator<Buffer> {
  const k = parseKey(key);
  try {
    const { header, profileAndStrength } = readPrologue(input);
    if (header.profile !== PROFILE_SYMMETRIC)
      throw new AeaError("UNSUPPORTED",
        `AEA profile ${header.profile} (${header.profileName}) isn't supported; only profile 1 (symmetric key, used by OTA updates) is`);
    const mainSalt = Buffer.from(input.read(SALT_SIZE));
    const mainKey = hkdf(k, label("AEA_AMK", profileAndStrength), KEY_SIZE, mainSalt);

    // Root header MAC, encrypted root header, then the first cluster's MAC. Reads return views that
    // may not outlive the next read, so blocks used across reads are copied.
    const rootBlock = Buffer.from(input.read(MAC_SIZE + ROOT_HEADER_SIZE + MAC_SIZE));
    const rootMac = rootBlock.subarray(0, MAC_SIZE);
    const rootEnc = rootBlock.subarray(MAC_SIZE, MAC_SIZE + ROOT_HEADER_SIZE);
    let clusterMac = rootBlock.subarray(MAC_SIZE + ROOT_HEADER_SIZE);
    const rk = keys(mainKey, label("AEA_RHEK"));
    if (!same(rootMac, mac(rk.mac, rootEnc, Buffer.concat([clusterMac, header.authData]))))
      throw new AeaError("WRONG_KEY", "wrong key: the archive's root header doesn't verify with it");
    // Root header: u64 plaintext size, u64 container size, u32 segment size, u32 segments per
    // cluster, compression code, checksum type.
    const root = aesCtr(rk, rootEnc);
    const size = Number(root.readBigUInt64LE(0));
    const containerSize = Number(root.readBigUInt64LE(8));
    const segSize = root.readUInt32LE(16);
    const spc = root.readUInt32LE(20);
    const compression = String.fromCharCode(root[24]);
    const ck = CHECKSUMS[root[25]];
    if (!ck) throw new AeaError("UNSUPPORTED", `unknown segment checksum type ${root[25]}`);
    if (!(compression in ALGORITHMS)) throw new UnsupportedCompressionError(compression);
    if (segSize === 0 || spc === 0) throw new AeaError("CORRUPT", "root header has a zero segment or cluster size");
    if (opts.inputSize !== undefined && containerSize && opts.inputSize < containerSize)
      throw new AeaError("TRUNCATED",
        `file is ${opts.inputSize} bytes but the archive is ${containerSize}: the download is incomplete`);
    opts.onInfo?.({
      header, size, segmentSize: segSize, segmentsPerCluster: spc,
      compression: ALGORITHMS[compression], checksum: ck.name,
    });

    // Cluster header: spc segment headers (u32 raw size, u32 encrypted size, checksum), the next
    // cluster's MAC, then spc segment MACs.
    const segHdrLen = 8 + ck.size;
    const hdrsLen = segHdrLen * spc;
    let written = 0;
    for (let cluster = 0; written < size; cluster++) {
      const ckey = hkdf(mainKey, label("AEA_CK", cluster), KEY_SIZE);
      const hk = keys(ckey, label("AEA_CHEK"));
      const block = Buffer.from(input.read(hdrsLen + MAC_SIZE + MAC_SIZE * spc));
      const encHdrs = block.subarray(0, hdrsLen);
      const nextMac = block.subarray(hdrsLen, hdrsLen + MAC_SIZE);
      const segMacs = block.subarray(hdrsLen + MAC_SIZE);
      // The MAC's salt is the next cluster MAC followed by the segment MACs: the rest of the block.
      if (!same(clusterMac, mac(hk.mac, encHdrs, block.subarray(hdrsLen))))
        throw new AeaError("CORRUPT", `cluster ${cluster}: header MAC mismatch (corrupted file?)`);
      const hdrs = aesCtr(hk, encHdrs);

      for (let i = 0; i < spc && written < size; i++) {
        const h = hdrs.subarray(i * segHdrLen, (i + 1) * segHdrLen);
        const rawSize = h.readUInt32LE(0), encSize = h.readUInt32LE(4);
        if (rawSize === 0) continue;
        const where = `cluster ${cluster} segment ${i}`;
        if (rawSize > segSize || written + rawSize > size)
          throw new AeaError("CORRUPT", `${where}: segment size ${rawSize} exceeds the archive layout`);
        if ((cluster * spc + i) * segSize !== written) throw new AeaError("CORRUPT", `${where}: segment is out of sequence`);
        // Not copied: the data is authenticated and decrypted before the next read.
        const data = input.read(encSize);
        const sk = keys(ckey, label("AEA_SK", i));
        if (!same(segMacs.subarray(i * MAC_SIZE, (i + 1) * MAC_SIZE), mac(sk.mac, data)))
          throw new AeaError("CORRUPT", `${where}: MAC mismatch (corrupted file?)`);
        let plain = aesCtr(sk, data);
        if (rawSize !== encSize) {
          try { plain = decompress(compression, plain, rawSize); } catch (e) {
            if (e instanceof DecompressError) throw new AeaError("CORRUPT", `${where}: ${e.message}`);
            throw e;
          }
        }
        if (ck.matches && !ck.matches(plain, h.subarray(8)))
          throw new AeaError("CORRUPT", `${where}: ${ck.name} checksum mismatch`);
        written += rawSize;
        yield plain;
      }
      opts.onProgress?.(written, size);
      clusterMac = nextMac;
    }

    // Trailing padding is authenticated by the last cluster's "next" MAC.
    if (!input.atEnd()) {
      const pk = keys(mainKey, label("AEA_PAK"));
      const h = createHmac("sha256", pk.mac);
      while (!input.atEnd()) h.update(input.chunk(1 << 20));
      if (!same(clusterMac, h.digest())) throw new AeaError("CORRUPT", "padding MAC mismatch (corrupted file?)");
    }
  } catch (e) {
    if (e instanceof TruncatedError) throw new AeaError("TRUNCATED", e.message);
    throw e;
  }
}

/** Opens an .aea file as a plaintext chunk stream (see `decryptChunks`). */
export function decryptFileChunks(path: string, key: string | Uint8Array, opts: DecryptOptions = {}): Generator<Buffer> {
  return decryptChunks(new Reader(fileChunks(path), path), key, { ...opts, inputSize: statSync(path).size });
}

/** Decrypts `inPath` to `outPath` (the plaintext is usually an Apple Archive, .aar). */
export function decryptFile(inPath: string, outPath: string, key: string | Uint8Array, opts: DecryptOptions = {}): DecryptInfo {
  let info: DecryptInfo | undefined;
  const chunks = decryptFileChunks(inPath, key, { ...opts, onInfo: (i) => { info = i; opts.onInfo?.(i); } });
  // Pull the first chunk (which validates the key) before creating the output file.
  let next = chunks.next();
  const out = openSync(outPath, "w");
  try {
    for (; !next.done; next = chunks.next()) writeAll(out, next.value);
  } catch (e) {
    closeSync(out);
    rmSync(outPath, { force: true }); // don't leave a partial, unverified file behind
    throw e;
  }
  closeSync(out);
  return info!;
}
