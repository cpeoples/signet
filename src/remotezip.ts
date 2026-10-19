/**
 * Read individual files out of a remote ZIP (IPSW) using HTTP Range requests only.
 * Supports ZIP64 (IPSWs are > 4 GB). Methods: stored (0) and deflate (8).
 */
import { inflateRawSync } from "node:zlib";
import { ua } from "./config.js";
import { fetchRetry } from "./http.js";

export interface ZipEntry { name: string; method: number; csize: number; usize: number; offset: number }

const EOCD_SIG = 0x06054b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
/** A 32-bit field at this value means "see the ZIP64 extra field". */
const ZIP64_SATURATED = 0xffffffff;

/** One HTTP Range request (`spec` like "0-1023" or "-65558"); total file size from Content-Range. */
export async function range(url: string, spec: string): Promise<{ data: Buffer; total: number }> {
  const r = await fetchRetry(url, { headers: { ...ua(), Range: `bytes=${spec}` } });
  if (r.status !== 206) throw new Error(`range request not honoured (HTTP ${r.status}) for ${url}`);
  const total = Number((r.headers.get("content-range") ?? "").split("/")[1]);
  return { data: Buffer.from(await r.arrayBuffer()), total };
}

const readU64 = (b: Buffer, o: number) => Number(b.readBigUInt64LE(o));

export class RemoteZip {
  private entries = new Map<string, ZipEntry>();
  /** Total file size in bytes (from Content-Range of the first request). */
  size = 0;
  private constructor(private url: string) {}

  static async open(url: string): Promise<RemoteZip> {
    const z = new RemoteZip(url);
    await z.readDirectory();
    return z;
  }

  has(name: string): boolean { return this.entries.has(name); }

  private async readDirectory(): Promise<void> {
    const { data: tail, total } = await range(this.url, "-65558"); // max EOCD + comment
    this.size = total;
    const tailStart = total - tail.length;
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("not a zip (no end-of-central-directory)");

    let count = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOffset = tail.readUInt32LE(eocd + 16);

    // ZIP64: locator sits 20 bytes before the classic EOCD.
    const loc = eocd - 20;
    if (loc >= 0 && tail.readUInt32LE(loc) === ZIP64_LOCATOR_SIG) {
      const z64Off = readU64(tail, loc + 8);
      const rec = z64Off >= tailStart
        ? tail.subarray(z64Off - tailStart)
        : (await range(this.url, `${z64Off}-${z64Off + 55}`)).data;
      if (rec.readUInt32LE(0) !== ZIP64_EOCD_SIG) throw new Error("bad ZIP64 EOCD record");
      count = readU64(rec, 32);
      cdSize = readU64(rec, 40);
      cdOffset = readU64(rec, 48);
    }

    const cd = cdOffset >= tailStart
      ? tail.subarray(cdOffset - tailStart, cdOffset - tailStart + cdSize)
      : (await range(this.url, `${cdOffset}-${cdOffset + cdSize - 1}`)).data;

    let p = 0;
    for (let n = 0; n < count; n++) {
      if (cd.readUInt32LE(p) !== CENTRAL_SIG) throw new Error("bad central directory entry");
      const method = cd.readUInt16LE(p + 10);
      let csize = cd.readUInt32LE(p + 20);
      let usize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28), extraLen = cd.readUInt16LE(p + 30), commentLen = cd.readUInt16LE(p + 32);
      let offset = cd.readUInt32LE(p + 42);
      const name = cd.toString("utf8", p + 46, p + 46 + nameLen);

      // ZIP64 extra field (0x0001): 8-byte values for whichever fields are saturated, in order.
      let x = p + 46 + nameLen;
      const xEnd = x + extraLen;
      while (x + 4 <= xEnd) {
        const id = cd.readUInt16LE(x), len = cd.readUInt16LE(x + 2);
        if (id === 0x0001) {
          let q = x + 4;
          if (usize === ZIP64_SATURATED) { usize = readU64(cd, q); q += 8; }
          if (csize === ZIP64_SATURATED) { csize = readU64(cd, q); q += 8; }
          if (offset === ZIP64_SATURATED) offset = readU64(cd, q);
        }
        x += 4 + len;
      }
      this.entries.set(name, { name, method, csize, usize, offset });
      p += 46 + nameLen + extraLen + commentLen;
    }
  }

  async read(name: string): Promise<Buffer> {
    const e = this.entries.get(name);
    if (!e) throw new Error(`no item named '${name}' in the archive`);
    // One request: local header (30 + name + extra, extra usually small) + data, with slack.
    const slack = 30 + e.name.length + 1024;
    let { data } = await range(this.url, `${e.offset}-${e.offset + slack + e.csize - 1}`);
    if (data.readUInt32LE(0) !== LOCAL_SIG) throw new Error("bad local file header");
    const start = 30 + data.readUInt16LE(26) + data.readUInt16LE(28);
    if (start + e.csize > data.length) {
      data = (await range(this.url, `${e.offset}-${e.offset + start + e.csize - 1}`)).data;
    }
    const raw = data.subarray(start, start + e.csize);
    if (e.method === 0) return raw;
    if (e.method === 8) return inflateRawSync(raw);
    throw new Error(`unsupported zip compression method ${e.method}`);
  }
}
