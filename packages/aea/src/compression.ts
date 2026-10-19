/**
 * Decoders for the compression formats used by Apple Archive and AEA, plus the `pbz?` block stream
 * that wraps compressed .aar files. Algorithm codes (AEA root header and pbz magic):
 *
 *   '-'  none
 *   'e'  LZFSE, including LZVN blocks
 *   'z'  zlib (raw DEFLATE, as Apple's Compression framework writes it)
 *   '4'  LZ4 (raw blocks, or Apple's bv41 framing)
 *   'x'  LZMA: not supported, Node has no built-in decoder
 *   'b'  LZBITMAP, 'm' LZRAVEN: not supported, undocumented Apple formats
 */
import { inflateRawSync, inflateSync } from "node:zlib";
import { copyMatch, DecompressError, lzfseDecompress } from "./lzfse.js";
import { OutBuffer } from "./outbuffer.js";
import { asBuffer, Reader } from "./reader.js";

export { DecompressError } from "./lzfse.js";

export const ALGORITHMS: Record<string, string> = {
  "-": "none", e: "lzfse", z: "zlib", "4": "lz4", x: "lzma", b: "lzbitmap", m: "lzraven",
};
const SUPPORTED = new Set(["-", "e", "z", "4"]);
const UNSUPPORTED_REASON: Record<string, string> = {
  x: "Node has no built-in LZMA decoder",
  b: "it is an undocumented Apple format",
  m: "it is an undocumented Apple format",
};

const LZ4_END = 0x24347662; // "bv4$"
const LZ4_COMPRESSED = 0x31347662; // "bv41"
const LZ4_STORED = 0x2d347662; // "bv4-"

export class UnsupportedCompressionError extends Error {
  /** @param algorithm the one-character algorithm code (see `ALGORITHMS`) */
  constructor(readonly algorithm: string) {
    const name = ALGORITHMS[algorithm] ?? `unknown ('${algorithm}')`;
    const why = UNSUPPORTED_REASON[algorithm] ?? "it isn't a known Apple Archive compression";
    super(`${name} compression isn't supported: ${why}. On macOS, Apple's own aa and aea tools can read it.`);
    this.name = "UnsupportedCompressionError";
  }
}

const fail = (m: string): never => { throw new DecompressError(m); };

/** Decodes one raw LZ4 block (src[start..end)) onto `out`; matches may reach into earlier output. */
function lz4Block(src: Uint8Array, start: number, end: number, nRaw: number, out: OutBuffer): void {
  out.reserve(nRaw);
  const buf = out.buf, limit = out.length + nRaw;
  let s = start, o = out.length;
  while (s < end) {
    const token = src[s++];
    let L = token >> 4;
    if (L === 15) { let b; do { if (s >= end) fail("lz4: truncated length"); b = src[s++]; L += b; } while (b === 255); }
    if (s + L > end || o + L > limit) fail("lz4: literal overrun");
    buf.set(src.subarray(s, s + L), o);
    s += L; o += L;
    if (s >= end) break; // the last sequence carries literals only
    if (s + 2 > end) fail("lz4: truncated match offset");
    const D = src[s] | (src[s + 1] << 8);
    s += 2;
    let M = (token & 15) + 4;
    if ((token & 15) === 15) { let b; do { if (s >= end) fail("lz4: truncated length"); b = src[s++]; M += b; } while (b === 255); }
    if (D === 0 || D > o) fail("lz4: bad match distance");
    if (o + M > limit) fail("lz4: match overrun");
    copyMatch(buf, o, D, M);
    o += M;
  }
  out.length = o;
  if (o !== limit) fail("lz4: block size mismatch");
}

const u32 = (b: Uint8Array, o: number) => {
  if (o + 4 > b.length) fail("lz4: truncated block header");
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
};

/** Apple's LZ4 stream: bv41 (compressed), bv4- (stored) blocks, ended by bv4$. */
export function lz4Decompress(input: Uint8Array, sizeHint = 0): Buffer {
  const out = new OutBuffer(sizeHint || input.length * 4);
  let p = 0;
  for (;;) {
    const magic = u32(input, p);
    if (magic === LZ4_END) return out.result();
    const nRaw = u32(input, p + 4);
    if (magic === LZ4_COMPRESSED) {
      const n = u32(input, p + 8);
      if (p + 12 + n > input.length) fail("lz4: block runs past the end of the input");
      lz4Block(input, p + 12, p + 12 + n, nRaw, out);
      p += 12 + n;
    } else if (magic === LZ4_STORED) {
      if (p + 8 + nRaw > input.length) fail("lz4: stored block runs past the end of the input");
      out.append(input.subarray(p + 8, p + 8 + nRaw));
      p += 8 + nRaw;
    } else {
      fail(`lz4: bad block magic 0x${magic.toString(16)} at byte ${p}`);
    }
  }
}

/** Decodes a single raw LZ4 block (no framing) of exactly `rawSize` bytes. */
function lz4BlockDecompress(input: Uint8Array, rawSize: number): Buffer {
  const out = new OutBuffer(rawSize);
  lz4Block(input, 0, input.length, rawSize, out);
  return out.result();
}

const isBv4 = (d: Uint8Array) => d.length >= 4 && d[0] === 0x62 && d[1] === 0x76 && d[2] === 0x34;

function inflate(data: Uint8Array): Buffer {
  // Apple's Compression framework writes raw DEFLATE; accept a zlib-wrapped stream too.
  try {
    return inflateRawSync(data);
  } catch (e) {
    try {
      if (data[0] === 0x78) return inflateSync(data);
    } catch { /* report the raw DEFLATE error below */ }
    throw new DecompressError(`zlib: ${(e as Error).message}`);
  }
}

/**
 * Decompresses one buffer that holds exactly `rawSize` bytes once decoded. LZ4 data may be a raw
 * block (AEA segments) or Apple's bv4 framing (pbz4 streams); both are accepted.
 */
export function decompress(code: string, data: Uint8Array, rawSize: number): Buffer {
  let out: Buffer;
  switch (code) {
    case "-": out = asBuffer(data); break;
    case "e": out = lzfseDecompress(data, rawSize); break;
    case "z": out = inflate(data); break;
    case "4":
      if (!isBv4(data)) { out = lz4BlockDecompress(data, rawSize); break; }
      try { out = lz4Decompress(data, rawSize); } catch { out = lz4BlockDecompress(data, rawSize); }
      break;
    default: throw new UnsupportedCompressionError(code);
  }
  if (out.length !== rawSize) fail(`${ALGORITHMS[code]}: expected ${rawSize} bytes, got ${out.length}`);
  return out;
}

export const isPbz = (head: Uint8Array) =>
  head.length >= 4 && head[0] === 0x70 && head[1] === 0x62 && head[2] === 0x7a; // "pbz?"

/**
 * Decodes a `pbz?` block stream (how `aa archive` compresses .aar files, and the format of OTA
 * payload chunks): "pbz" plus the algorithm code, u64be block size, then blocks of u64be raw size,
 * u64be stored size and data. A block whose stored size equals its raw size is stored as is.
 */
export function* pbzChunks(r: Reader): Generator<Buffer> {
  const magic = r.read(4);
  if (!isPbz(magic)) fail("pbz: bad stream magic");
  const code = String.fromCharCode(magic[3]);
  if (!SUPPORTED.has(code)) throw new UnsupportedCompressionError(code);
  const blockSize = Number(r.read(8).readBigUInt64BE(0));
  while (!r.atEnd()) {
    const h = r.read(16);
    const raw = Number(h.readBigUInt64BE(0)), stored = Number(h.readBigUInt64BE(8));
    if (raw > blockSize || stored > Math.max(blockSize, raw) + 4096) fail(`pbz: implausible block sizes ${raw}/${stored}`);
    const data = r.read(stored);
    // A stored block is a view of the input, so copy it; the decoders allocate their own output.
    yield stored === raw ? Buffer.from(data) : decompress(code, data, raw);
  }
}
