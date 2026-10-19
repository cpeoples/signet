/** A growable byte buffer for decompressor output. */
export class OutBuffer {
  buf: Uint8Array;
  length = 0;

  constructor(capacity = 1 << 16) {
    this.buf = new Uint8Array(Math.max(16, capacity));
  }

  /** Makes room for `n` more bytes. Callers re-read `buf` afterwards, since it may be replaced. */
  reserve(n: number): void {
    const need = this.length + n;
    if (need <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < need) cap *= 2;
    const b = new Uint8Array(cap);
    b.set(this.buf.subarray(0, this.length));
    this.buf = b;
  }

  append(data: Uint8Array): void {
    this.reserve(data.length);
    this.buf.set(data, this.length);
    this.length += data.length;
  }

  result(): Buffer {
    return Buffer.from(this.buf.buffer, this.buf.byteOffset, this.length);
  }
}
