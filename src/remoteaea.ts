/**
 * Read small files from the start of a remote encrypted OTA update (.aea) with HTTP ranges.
 *
 * Full OTA updates put AssetData/boot/BuildManifest.plist in the first megabyte or two, so the TSS
 * check doesn't need the whole download. The key comes from Apple's asset server.
 */
import {
  AeaError, archiveStream, bufferChunks, decryptChunks, Reader, readEntries,
} from "@chrispeoples/aea";
import { range } from "./remotezip.js";

const MB = 1 << 20;
/** Stop growing the prefix here (the DeviceTree of a HomePod update sits at about 23 MB). */
const DEFAULT_MAX = 64 * MB;

/** The archive paths still wanted, given the files found so far (may grow as files are read). */
export type Wanted = (found: Map<string, Buffer>) => Set<string>;

const allFound = (wanted: Wanted, found: Map<string, Buffer>) => [...wanted(found)].every((p) => found.has(p));

/** Files in an archive stream, descending into OTA metadata entries (YOP=E) that nest archives. */
function collect(r: Reader, wanted: Wanted, found: Map<string, Buffer>): boolean {
  for (const e of readEntries(r)) {
    const path = e.path ?? "";
    if (e.type === "F" && !found.has(path) && wanted(found).has(path)) {
      found.set(path, e.readBlob());
      if (allFound(wanted, found)) return true;
    } else if (e.type === "M" && e.operation === "E" && e.blobSize() !== undefined) {
      if (collect(archiveStream(e.blobReader()), wanted, found)) return true;
    }
  }
  return false;
}

export interface AeaHead {
  /** Wanted files found, by archive path. */
  files: Map<string, Buffer>;
  /** Size of the whole .aea in bytes. */
  size: number;
}

/**
 * Wanted files from a remote .aea. Downloads a growing prefix (2 MB, doubling up to `max`) until
 * every wanted file is found; files not found within `max` are left out of the result.
 */
export async function readAeaHead(url: string, key: string, wanted: Wanted, max = DEFAULT_MAX): Promise<AeaHead> {
  let buf = Buffer.alloc(0);
  let total = Infinity, size = 2 * MB;
  while (true) {
    const end = Math.min(size, total) - 1;
    if (end >= buf.length) {
      const got = await range(url, `${buf.length}-${end}`);
      total = got.total;
      buf = Buffer.concat([buf, got.data]);
    }
    const files = new Map<string, Buffer>();
    try {
      const plain = new Reader(decryptChunks(new Reader(bufferChunks(buf)), key, { inputSize: total }), "decrypted OTA");
      if (collect(archiveStream(plain), wanted, files)) return { files, size: total };
    } catch (e) {
      // A short read shows up as TRUNCATED: fetch more. Anything else is a real error.
      if (buf.length >= total || !(e instanceof AeaError && e.code === "TRUNCATED")) throw e;
    }
    if (buf.length >= total || size >= max) return { files, size: total };
    size *= 2;
  }
}
