/**
 * Sequential byte reading over a stream of chunks, so multi-gigabyte inputs are processed in bounded
 * memory. Everything here is synchronous: a `Reader` pulls from an iterator of Buffers on demand.
 * Also holds the file I/O helpers shared by decryption and extraction.
 */
import { closeSync, fstatSync, openSync, readSync, writeSync } from "node:fs";

export class TruncatedError extends Error {
  constructor(what: string, at: number) {
    super(`${what}: unexpected end of data at byte ${at} (truncated or incomplete file?)`);
    this.name = "TruncatedError";
  }
}

/** Views a Uint8Array as a Buffer without copying. */
export const asBuffer = (b: Uint8Array) => Buffer.isBuffer(b) ? b : Buffer.from(b.buffer, b.byteOffset, b.byteLength);

export class Reader {
  private cur: Buffer = Buffer.alloc(0);
  private off = 0;
  private done = false;
  /** Total bytes consumed so far. */
  position = 0;

  constructor(private readonly src: Iterator<Uint8Array>, private readonly what = "input") {}

  private fill(): boolean {
    while (this.off >= this.cur.length) {
      if (this.done) return false;
      const r = this.src.next();
      if (r.done) { this.done = true; return false; }
      this.cur = asBuffer(r.value);
      this.off = 0;
    }
    return true;
  }

  /** True once every byte has been consumed. */
  atEnd(): boolean {
    return !this.fill();
  }

  /** Returns the next up-to-`max` bytes as a view (no copy). Throws at end of data. */
  chunk(max: number): Buffer {
    if (!this.fill()) throw new TruncatedError(this.what, this.position);
    const n = Math.min(max, this.cur.length - this.off);
    const b = this.cur.subarray(this.off, this.off + n);
    this.off += n;
    this.position += n;
    return b;
  }

  /** Reads exactly `n` bytes. The result may be a view into an internal buffer: copy it to keep it. */
  read(n: number): Buffer {
    if (n === 0) return Buffer.alloc(0);
    if (this.fill() && this.cur.length - this.off >= n) return this.chunk(n);
    const out = Buffer.allocUnsafe(n);
    let got = 0;
    while (got < n) {
      const c = this.chunk(n - got);
      c.copy(out, got);
      got += c.length;
    }
    return out;
  }

  /** Returns up to `n` upcoming bytes without consuming them (fewer at end of data). */
  peek(n: number): Buffer {
    if (!this.fill()) return Buffer.alloc(0);
    if (this.cur.length - this.off >= n) return this.cur.subarray(this.off, this.off + n);
    // Merge the head of the stream into one buffer so it can be peeked.
    const parts: Buffer[] = [this.cur.subarray(this.off)];
    let have = parts[0].length;
    while (have < n && !this.done) {
      const r = this.src.next();
      if (r.done) { this.done = true; break; }
      parts.push(asBuffer(r.value));
      have += r.value.length;
    }
    this.cur = Buffer.concat(parts);
    this.off = 0;
    return this.cur.subarray(0, Math.min(n, this.cur.length));
  }

  /** Yields the next `n` bytes as views into the internal buffers. */
  private *take(n: number): Generator<Buffer> {
    let left = n;
    while (left > 0) {
      const c = this.chunk(left);
      left -= c.length;
      yield c;
    }
  }

  skip(n: number): void {
    let left = n;
    while (left > 0) left -= this.chunk(left).length;
  }

  /** Streams the next `n` bytes to `fn` in chunks (views, valid only during the call). */
  forEach(n: number, fn: (chunk: Buffer) => void): void {
    for (const c of this.take(n)) fn(c);
  }

  /** A reader over exactly the next `n` bytes of this one. Consume it fully before using the parent. */
  limit(n: number, what = this.what): Reader {
    return new Reader(this.take(n), what);
  }
}

/** Yields a file's bytes in chunks. The file descriptor is closed when iteration finishes or stops. */
export function* fileChunks(path: string, chunkSize = 4 << 20): Generator<Buffer> {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    let pos = 0;
    while (pos < size) {
      const b = Buffer.allocUnsafe(Math.min(chunkSize, size - pos));
      let got = 0;
      while (got < b.length) {
        const r = readSync(fd, b, got, b.length - got, pos + got);
        if (r === 0) break;
        got += r;
      }
      if (got === 0) break;
      pos += got;
      yield got === b.length ? b : b.subarray(0, got);
    }
  } finally {
    closeSync(fd);
  }
}

/** Writes all of `b` to `fd` (writeSync may write less than asked). */
export function writeAll(fd: number, b: Uint8Array): void {
  let off = 0;
  while (off < b.length) off += writeSync(fd, b, off, b.length - off);
}

/** Yields `buf` as a single chunk, so in-memory data can be read through a `Reader`. */
export function* bufferChunks(buf: Uint8Array): Generator<Buffer> {
  if (buf.length) yield asBuffer(buf);
}
