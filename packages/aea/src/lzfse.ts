/**
 * LZFSE and LZVN decoders, ported from Apple's reference implementation
 * (https://github.com/lzfse/lzfse, BSD-3-Clause, see NOTICE).
 *
 * Handles every block type Apple's encoder writes: bvx2 (LZFSE v2), bvxn (LZVN, used for small
 * inputs), bvx- (stored) and bvx$ (end of stream). bvx1 (v1, uncompressed header) is never written
 * by Apple's encoder and is rejected.
 */
import { OutBuffer } from "./outbuffer.js";

const L_SYMBOLS = 20, M_SYMBOLS = 20, D_SYMBOLS = 64, LITERAL_SYMBOLS = 256;
const L_STATES = 64, M_STATES = 64, D_STATES = 256, LITERAL_STATES = 1024;
// Offsets of each table's frequencies in the v2 header.
const M_FREQ = L_SYMBOLS, D_FREQ = M_FREQ + M_SYMBOLS, LITERAL_FREQ = D_FREQ + D_SYMBOLS;
const FREQ_COUNT = LITERAL_FREQ + LITERAL_SYMBOLS;
const V2_HEADER_SIZE = 32; // magic, raw size, then three packed 64-bit words

const L_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 3, 5, 8];
const L_BASE = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 20, 28, 60];
const M_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3, 5, 8, 11];
const M_BASE = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 24, 56, 312];
const D_EXTRA = Array.from({ length: 64 }, (_, i) => i >> 2);
const D_BASE = [
  0, 1, 2, 3, 4, 6, 8, 10, 12, 16, 20, 24, 28, 36, 44, 52, 60, 76, 92, 108, 124, 156, 188, 220,
  252, 316, 380, 444, 508, 636, 764, 892, 1020, 1276, 1532, 1788, 2044, 2556, 3068, 3580, 4092,
  5116, 6140, 7164, 8188, 10236, 12284, 14332, 16380, 20476, 24572, 28668, 32764, 40956, 49148,
  57340, 65532, 81916, 98300, 114684, 131068, 163836, 196604, 229372,
];

const FREQ_NBITS = [2, 3, 2, 5, 2, 3, 2, 8, 2, 3, 2, 5, 2, 3, 2, 14, 2, 3, 2, 5, 2, 3, 2, 8, 2, 3, 2, 5, 2, 3, 2, 14];
const FREQ_VALUE = [0, 2, 1, 4, 0, 3, 1, -1, 0, 2, 1, 5, 0, 3, 1, -1, 0, 2, 1, 6, 0, 3, 1, -1, 0, 2, 1, 7, 0, 3, 1, -1];

const MAGIC_END = 0x24787662; // "bvx$"
const MAGIC_RAW = 0x2d787662; // "bvx-"
const MAGIC_V1 = 0x31787662;  // "bvx1"
const MAGIC_V2 = 0x32787662;  // "bvx2"
const MAGIC_LZVN = 0x6e787662; // "bvxn"

export class DecompressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecompressError";
  }
}
const fail = (m: string): never => { throw new DecompressError(m); };

/**
 * FSE bit stream, read backwards from the end of its region. Bit j of the stream is bit (j & 7) of
 * byte (j >> 3); reading n bits returns bits [pos - n, pos) with the highest bit most significant.
 */
class BitReader {
  private pos: number;
  constructor(private readonly buf: Uint8Array, private readonly start: number, end: number, extraBits: number) {
    if (end > buf.length) fail("lzfse: block runs past the end of the input");
    this.pos = (end - start) * 8 + extraBits; // extraBits in [-7, 0]: padding at the top of the last byte
    if (this.pos < 0) fail("lzfse: bad stream size");
  }
  read(n: number): number {
    if (n === 0) return 0;
    if (n > this.pos) fail("lzfse: bit stream underflow");
    this.pos -= n;
    const bit = this.pos, byte = this.start + (bit >> 3), b = this.buf;
    // n <= 26 here, so the requested bits always fit in the four bytes starting at `byte`.
    const w = (b[byte] | (b[byte + 1] << 8) | (b[byte + 2] << 16) | ((b[byte + 3] ?? 0) << 24)) >>> 0;
    return ((w >>> (bit & 7)) & ((1 << n) - 1)) >>> 0;
  }
}

interface Table { k: Uint8Array; symbol: Uint16Array; delta: Int32Array }

function initTable(nstates: number, freq: number[]): Table {
  const t: Table = { k: new Uint8Array(nstates), symbol: new Uint16Array(nstates), delta: new Int32Array(nstates) };
  const nClz = Math.clz32(nstates);
  let sum = 0, j = 0;
  for (let symbol = 0; symbol < freq.length; symbol++) {
    const f = freq[symbol];
    if (!f) continue;
    sum += f;
    if (sum > nstates) fail("lzfse: bad frequency table");
    const k = Math.clz32(f) - nClz;
    const j0 = ((2 * nstates) >> k) - f;
    for (let i = 0; i < f; i++, j++) {
      t.symbol[j] = symbol;
      if (i < j0) { t.k[j] = k; t.delta[j] = ((f + i) << k) - nstates; }
      else { t.k[j] = k - 1; t.delta[j] = (i - j0) << (k - 1); }
    }
  }
  return t;
}

interface ValueTable { totalBits: Uint8Array; valueBits: Uint8Array; delta: Int32Array; vbase: Int32Array }

function initValueTable(nstates: number, freq: number[], vbits: number[], vbase: number[]): ValueTable {
  const t = initTable(nstates, freq);
  const v: ValueTable = {
    totalBits: new Uint8Array(nstates), valueBits: new Uint8Array(nstates),
    delta: new Int32Array(nstates), vbase: new Int32Array(nstates),
  };
  for (let i = 0; i < nstates; i++) {
    const s = t.symbol[i];
    v.totalBits[i] = t.k[i] + vbits[s];
    v.valueBits[i] = vbits[s];
    v.delta[i] = t.delta[i];
    v.vbase[i] = vbase[s];
  }
  return v;
}

const u32 = (b: Uint8Array, o: number) => {
  if (o + 4 > b.length) fail("lzfse: truncated block header");
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
};
const u64 = (b: Uint8Array, o: number) => BigInt(u32(b, o)) | (BigInt(u32(b, o + 4)) << 32n);
/** n bits starting at bit `off` of a packed 64-bit v2 header word. */
const bits = (v: bigint, off: number, n: number) => Number((v >> BigInt(off)) & ((1n << BigInt(n)) - 1n));

/** Decodes the frequency values (L, M, D, literal) packed after a v2 header. */
function decodeFreqs(b: Uint8Array, start: number, end: number): number[] {
  const out: number[] = [];
  let src = start, accum = 0, accumBits = 0;
  for (let i = 0; i < FREQ_COUNT; i++) {
    while (src < end && accumBits + 8 <= 32) {
      accum = (accum | (b[src++] << accumBits)) >>> 0;
      accumBits += 8;
    }
    const low = accum & 31;
    const n = FREQ_NBITS[low];
    const v = n === 8 ? 8 + ((accum >>> 4) & 0xf) : n === 14 ? 24 + ((accum >>> 4) & 0x3ff) : FREQ_VALUE[low];
    if (n > accumBits) fail("lzfse: bad frequency header");
    out.push(v);
    accum >>>= n;
    accumBits -= n;
  }
  if (accumBits >= 8 || src !== end) fail("lzfse: bad frequency header size");
  return out;
}

function decodeV2(input: Uint8Array, p: number, out: OutBuffer): number {
  const nRaw = u32(input, p + 4);
  const v0 = u64(input, p + 8), v1 = u64(input, p + 16), v2 = u64(input, p + 24);
  const nLiterals = bits(v0, 0, 20);
  const nLitPayload = bits(v0, 20, 20);
  const nMatches = bits(v0, 40, 20);
  const literalBits = bits(v0, 60, 3) - 7;
  const litState = [bits(v1, 0, 10), bits(v1, 10, 10), bits(v1, 20, 10), bits(v1, 30, 10)];
  const nLmdPayload = bits(v1, 40, 20);
  const lmdBits = bits(v1, 60, 3) - 7;
  const headerSize = bits(v2, 0, 32);
  let lState = bits(v2, 32, 10), mState = bits(v2, 42, 10), dState = bits(v2, 52, 10);
  if (headerSize < V2_HEADER_SIZE || p + headerSize > input.length) fail("lzfse: bad v2 header size");

  const freqs = headerSize > V2_HEADER_SIZE
    ? decodeFreqs(input, p + V2_HEADER_SIZE, p + headerSize)
    : new Array<number>(FREQ_COUNT).fill(0);
  const litTable = initTable(LITERAL_STATES, freqs.slice(LITERAL_FREQ));
  const lTable = initValueTable(L_STATES, freqs.slice(0, M_FREQ), L_EXTRA, L_BASE);
  const mTable = initValueTable(M_STATES, freqs.slice(M_FREQ, D_FREQ), M_EXTRA, M_BASE);
  const dTable = initValueTable(D_STATES, freqs.slice(D_FREQ, LITERAL_FREQ), D_EXTRA, D_BASE);

  // Literals: four interleaved FSE states over one backwards bit stream.
  const litStart = p + headerSize;
  const litIn = new BitReader(input, litStart, litStart + nLitPayload, literalBits);
  const literals = new Uint8Array(nLiterals + 4);
  for (let i = 0; i < nLiterals; i += 4) {
    for (let s = 0; s < 4; s++) {
      const st = litState[s];
      if (st >= LITERAL_STATES) fail("lzfse: bad literal state");
      literals[i + s] = litTable.symbol[st];
      litState[s] = litTable.delta[st] + litIn.read(litTable.k[st]);
    }
  }

  // L, M, D commands: literal run length, match length, match distance (0 = reuse the last).
  const lmdStart = litStart + nLitPayload;
  const lmdIn = new BitReader(input, lmdStart, lmdStart + nLmdPayload, lmdBits);
  const blockStart = out.length;
  out.reserve(nRaw);
  const buf = out.buf;
  let o = out.length;
  let lit = 0, D = -1;
  for (let m = 0; m < nMatches; m++) {
    if (lState >= L_STATES || mState >= M_STATES || dState >= D_STATES) fail("lzfse: bad LMD state");
    let x = lmdIn.read(lTable.totalBits[lState]);
    const L = lTable.vbase[lState] + (x & ((1 << lTable.valueBits[lState]) - 1));
    lState = lTable.delta[lState] + (x >>> lTable.valueBits[lState]);
    x = lmdIn.read(mTable.totalBits[mState]);
    const M = mTable.vbase[mState] + (x & ((1 << mTable.valueBits[mState]) - 1));
    mState = mTable.delta[mState] + (x >>> mTable.valueBits[mState]);
    x = lmdIn.read(dTable.totalBits[dState]);
    const newD = dTable.vbase[dState] + (x & ((1 << dTable.valueBits[dState]) - 1));
    dState = dTable.delta[dState] + (x >>> dTable.valueBits[dState]);
    if (newD) D = newD;

    if (lit + L > nLiterals || o - blockStart + L + M > nRaw) fail("lzfse: block overruns its declared size");
    buf.set(literals.subarray(lit, lit + L), o);
    o += L; lit += L;
    if (M) {
      if (D <= 0 || D > o) fail("lzfse: bad match distance");
      copyMatch(buf, o, D, M);
      o += M;
    }
  }
  out.length = o;
  if (o - blockStart !== nRaw) fail("lzfse: block size mismatch");
  return lmdStart + nLmdPayload;
}

/** Copies an LZ match of length `len` from `dist` bytes back, allowing overlap (repeating patterns). */
export function copyMatch(buf: Uint8Array, at: number, dist: number, len: number): void {
  if (dist >= len) { buf.copyWithin(at, at - dist, at - dist + len); return; }
  for (let i = 0; i < len; i++) buf[at + i] = buf[at + i - dist];
}

/** Decodes one LZVN payload (src[start..end)) appending exactly `nRaw` bytes to `out`. */
function lzvnDecode(src: Uint8Array, start: number, end: number, nRaw: number, out: OutBuffer): void {
  out.reserve(nRaw);
  const buf = out.buf;
  const limit = out.length + nRaw;
  let o = out.length, s = start, D = 0;
  if (end > src.length) fail("lzvn: block runs past the end of the input");
  for (;;) {
    if (s >= end) fail("lzvn: missing end-of-stream marker");
    const op = src[s];
    let L = 0, M = 0, len = 1;
    if (op === 0x06) break; // end of stream (followed by 7 bytes of padding)
    if (op === 0x0e || op === 0x16) { s++; continue; } // nop
    if (op >= 0xa0 && op <= 0xbf) { // medium distance: 101LLMMM DDDDDDMM DDDDDDDD
      const w = src[s + 1] | (src[s + 2] << 8);
      L = (op >> 3) & 3; M = (((op & 7) << 2) | (w & 3)) + 3; D = w >> 2; len = 3;
    } else if (op === 0xe0) { L = src[s + 1] + 16; len = 2; } // large literal
    else if (op > 0xe0 && op <= 0xef) L = op & 0xf;              // small literal
    else if (op === 0xf0) { M = src[s + 1] + 16; len = 2; }      // large match, previous distance
    else if (op > 0xf0) M = op & 0xf;                             // small match, previous distance
    else if ((op >= 0x70 && op <= 0x7f) || (op >= 0xd0 && op <= 0xdf)) fail(`lzvn: undefined opcode 0x${op.toString(16)}`);
    else if ((op & 7) === 6) { // previous distance: LLMMM110
      if (op >> 6 === 0) fail(`lzvn: undefined opcode 0x${op.toString(16)}`);
      L = op >> 6; M = ((op >> 3) & 7) + 3;
    } else if ((op & 7) === 7) { // large distance: LLMMM111 DDDDDDDD DDDDDDDD
      L = op >> 6; M = ((op >> 3) & 7) + 3; D = src[s + 1] | (src[s + 2] << 8); len = 3;
    } else { // small distance: LLMMMDDD DDDDDDDD
      L = op >> 6; M = ((op >> 3) & 7) + 3; D = ((op & 7) << 8) | src[s + 1]; len = 2;
    }
    s += len;
    if (s + L > end) fail("lzvn: literal runs past the end of the input");
    if (o + L + M > limit) fail("lzvn: block overruns its declared size");
    if (L) { buf.set(src.subarray(s, s + L), o); s += L; o += L; }
    if (M) {
      if (D <= 0 || D > o) fail("lzvn: bad match distance");
      copyMatch(buf, o, D, M);
      o += M;
    }
  }
  out.length = o;
  if (o !== limit) fail("lzvn: block size mismatch");
}

/**
 * Decompresses a complete LZFSE stream. `sizeHint` (the expected output size, when known) avoids
 * reallocation. Matches may reach back into earlier blocks, so the whole stream shares one output.
 */
export function lzfseDecompress(input: Uint8Array, sizeHint = 0): Buffer {
  const out = new OutBuffer(sizeHint || input.length * 4);
  let p = 0;
  for (;;) {
    const magic = u32(input, p);
    switch (magic) {
      case MAGIC_END:
        return out.result();
      case MAGIC_RAW: {
        const n = u32(input, p + 4);
        if (p + 8 + n > input.length) fail("lzfse: stored block runs past the end of the input");
        out.append(input.subarray(p + 8, p + 8 + n));
        p += 8 + n;
        break;
      }
      case MAGIC_LZVN: {
        const nRaw = u32(input, p + 4), nPayload = u32(input, p + 8);
        lzvnDecode(input, p + 12, p + 12 + nPayload, nRaw, out);
        p += 12 + nPayload;
        break;
      }
      case MAGIC_V2:
        p = decodeV2(input, p, out);
        break;
      case MAGIC_V1:
        fail("lzfse: bvx1 blocks aren't supported (Apple's encoder never writes them)");
        break;
      default:
        fail(`lzfse: bad block magic 0x${magic.toString(16)} at byte ${p}`);
    }
  }
}
