/**
 * Extracts Apple Archive entries to a directory, safely:
 *
 * - Entry paths must be relative and may not contain ".." components (no writing outside `dest`).
 * - Nothing is ever written through a symlink: every parent directory is checked with lstat, and
 *   an existing symlink at a file's own path is replaced rather than followed.
 * - File data is checked against the SIZ, CKS, SH1, SH2, SH3 and SH5 fields when present.
 *
 * OTA packages nest their contents in metadata entries: YOP=E entries hold archives of files to
 * extract, and YOP=O entries hold the modes and timestamps to apply afterwards. Other operations
 * (manifests, patches) are skipped.
 */
import { createHash } from "node:crypto";
import {
  chmodSync, closeSync, lstatSync, lutimesSync, mkdirSync, openSync, rmSync, Stats, symlinkSync,
  unlinkSync, utimesSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { ArchiveEntry, ArchiveError, ENTRY_TYPES, readEntries } from "./aar.js";
import { Reader, writeAll } from "./reader.js";

export interface ExtractOptions {
  /** Check file data against the archive's size and digest fields (default true). */
  verify?: boolean;
  /** Only extract entries whose path passes this filter. */
  filter?: (path: string, type: string) => boolean;
  /** Called after each entry is extracted or skipped (not for entries `filter` rejects). */
  onEntry?: (path: string, type: string, size: number | undefined) => void;
  /** Non-fatal problems: unsupported entry types, attributes the OS can't apply. */
  onWarning?: (message: string) => void;
}

export interface ExtractResult {
  files: number;
  directories: number;
  symlinks: number;
  /** Bytes of file data written. */
  bytes: number;
  /** Entries that weren't created: devices, fifos, hard links, symlinks without permission. */
  skipped: number;
  warnings: string[];
}

const isWindows = process.platform === "win32";

/** Validates an archive path and splits it into components. "" means the archive root. */
export function safeComponents(p: string): string[] {
  if (p.includes("\0")) throw new ArchiveError(`unsafe path ${JSON.stringify(p)}: contains NUL`);
  if (p.startsWith("/") || p.startsWith("\\") || /^[A-Za-z]:/.test(p))
    throw new ArchiveError(`unsafe path ${JSON.stringify(p)}: absolute paths aren't allowed`);
  const parts = p.split(isWindows ? /[\\/]/ : "/").filter((s) => s !== "" && s !== ".");
  for (const s of parts) {
    if (s === "..") throw new ArchiveError(`unsafe path ${JSON.stringify(p)}: ".." isn't allowed`);
    // eslint-disable-next-line no-control-regex -- control characters are exactly what's rejected
    if (isWindows && /[<>:"|?*\x00-\x1f]/.test(s))
      throw new ArchiveError(`path ${JSON.stringify(p)} contains characters Windows doesn't allow in file names`);
  }
  return parts;
}

/** POSIX `cksum` CRC (the CKS field). */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 24;
    for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
    t[i] = c >>> 0;
  }
  return t;
})();

export class PosixCksum {
  private crc = 0;
  private len = 0;
  update(b: Uint8Array): this {
    let c = this.crc;
    for (let i = 0; i < b.length; i++) c = ((c << 8) ^ CRC_TABLE[((c >>> 24) ^ b[i]) & 0xff]) >>> 0;
    this.crc = c;
    this.len += b.length;
    return this;
  }
  digest(): number {
    let c = this.crc, n = this.len;
    while (n > 0) { c = ((c << 8) ^ CRC_TABLE[((c >>> 24) ^ (n & 0xff)) & 0xff]) >>> 0; n = Math.floor(n / 256); }
    return (~c) >>> 0;
  }
}

const HASHES: [string, string][] = [["SH1", "sha1"], ["SH2", "sha256"], ["SH3", "sha384"], ["SH5", "sha512"]];

/** A running check of file data against one digest field. */
interface DataCheck { what: string; update(b: Uint8Array): void; matches(): boolean }

/** Checks for every digest field the entry carries (SH1, SH2, SH3, SH5, CKS). */
function dataChecks(e: ArchiveEntry): DataCheck[] {
  const checks: DataCheck[] = [];
  for (const [key, alg] of HASHES) {
    const want = e.digest(key);
    if (!want) continue;
    const h = createHash(alg);
    checks.push({ what: `${key} digest`, update: (b) => h.update(b), matches: () => h.digest().equals(want) });
  }
  const cks = e.digest("CKS");
  if (cks) {
    const c = new PosixCksum();
    checks.push({ what: "CKS checksum", update: (b) => c.update(b), matches: () => c.digest() === cks.readUInt32LE(0) });
  }
  return checks;
}

function lstatIfExists(p: string): Stats | undefined {
  try { return lstatSync(p); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

interface PendingAttrs { abs: string; type: string; mode?: number; mtime?: number }

class Extractor {
  readonly result: ExtractResult = { files: 0, directories: 0, symlinks: 0, bytes: 0, skipped: 0, warnings: [] };
  private readonly root: string;
  private readonly dirs = new Set<string>();
  private readonly pending: PendingAttrs[] = [];
  private readonly warned = new Set<string>();

  constructor(dest: string, private readonly opts: ExtractOptions) {
    this.root = resolve(dest);
    mkdirSync(this.root, { recursive: true });
    this.dirs.add(this.root);
  }

  private warn(msg: string, once?: string) {
    if (once) { if (this.warned.has(once)) return; this.warned.add(once); }
    this.result.warnings.push(msg);
    this.opts.onWarning?.(msg);
  }

  /** Ensures every directory along `parts` exists and is a real directory (not a symlink). */
  private ensureDirs(parts: string[]): void {
    let cur = this.root;
    for (const s of parts) {
      cur = join(cur, s);
      if (this.dirs.has(cur)) continue;
      const st = lstatIfExists(cur);
      if (!st) mkdirSync(cur);
      else if (st.isSymbolicLink()) throw new ArchiveError(`refusing to write through symlink ${cur}`);
      else if (!st.isDirectory()) throw new ArchiveError(`${cur} exists and isn't a directory`);
      this.dirs.add(cur);
    }
  }

  /**
   * Makes way for a new file or symlink at `parts`: creates its parent directories and removes an
   * existing file or symlink there, so the new one is never written through it.
   */
  private prepareLeaf(e: ArchiveEntry, parts: string[], abs: string, what: string) {
    if (!parts.length) throw new ArchiveError(`entry ${e.index}: a ${what} can't be the archive root`);
    this.ensureDirs(parts.slice(0, -1));
    const st = lstatIfExists(abs);
    if (!st) return;
    if (st.isDirectory()) throw new ArchiveError(`${abs} exists and is a directory`);
    unlinkSync(abs);
  }

  private deferAttrs(e: ArchiveEntry, abs: string, type: string) {
    const mode = e.num("MOD"), mtm = e.time("MTM");
    if (mode === undefined && !mtm) return;
    this.pending.push({ abs, type, mode, mtime: mtm ? mtm.sec + mtm.nsec / 1e9 : undefined });
  }

  /** Processes an archive stream. With `fixup` (YOP=O), only applies attributes to what exists. */
  run(r: Reader, fixup = false) {
    for (const e of readEntries(r)) {
      if (e.type === "M") { this.metadata(e); continue; }
      const path = e.path;
      if (path === undefined) { this.warn(`entry ${e.index} (type ${e.type}) has no path; skipped`); continue; }
      const parts = safeComponents(path);
      const rel = parts.join("/");
      const type = e.type;
      if (this.opts.filter && parts.length && !this.opts.filter(rel, type)) continue;
      const abs = parts.length ? join(this.root, ...parts) : this.root;

      if (fixup) {
        // Only touch paths this extraction created, and never through a symlink.
        const parent = parts.length > 1 ? join(this.root, ...parts.slice(0, -1)) : this.root;
        const st = lstatIfExists(abs);
        if (st && this.dirs.has(parent) && st.isDirectory() === (type === "D") && st.isSymbolicLink() === (type === "L"))
          this.deferAttrs(e, abs, type);
        continue;
      }
      if (e.fields.has("XAT")) this.warn("extended attributes (XAT) aren't restored", "xat");

      switch (type) {
        case "D":
          this.ensureDirs(parts);
          this.result.directories++;
          this.deferAttrs(e, abs, type);
          break;
        case "F":
          this.prepareLeaf(e, parts, abs, "file");
          this.writeFile(e, abs, rel);
          this.deferAttrs(e, abs, type);
          break;
        case "L": {
          const target = e.linkTarget;
          if (target === undefined) throw new ArchiveError(`symlink ${path} has no LNK target`);
          this.prepareLeaf(e, parts, abs, "symlink");
          try {
            symlinkSync(target, abs);
            this.result.symlinks++;
            this.deferAttrs(e, abs, type);
          } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            if (code !== "EPERM" && code !== "EACCES") throw err;
            this.result.skipped++;
            this.warn(`couldn't create symlinks (${code}); on Windows, enable Developer Mode or run as administrator`, "symlink");
          }
          break;
        }
        default:
          this.result.skipped++;
          this.warn(`skipped ${path}: ${ENTRY_TYPES[type] ?? `entry type '${type}'`} entries aren't extracted`);
      }
      this.opts.onEntry?.(rel, type, e.blobSize());
    }
  }

  private metadata(e: ArchiveEntry) {
    const op = e.operation;
    if (e.blobSize() === undefined) return;
    if (op === "E") this.run(e.blobReader());
    else if (op === "O") this.run(e.blobReader(), true);
    else if (op !== "M") this.warn(`skipped OTA metadata operation '${op ?? "?"}'`, `yop-${op}`);
  }

  private writeFile(e: ArchiveEntry, abs: string, rel: string) {
    const size = e.blobSize() ?? 0;
    const verify = this.opts.verify !== false;
    const checks = verify ? dataChecks(e) : [];
    const siz = e.num("SIZ");
    if (verify && siz !== undefined && siz !== size)
      throw new ArchiveError(`${rel}: data is ${size} bytes but SIZ says ${siz}`);

    // "wx" = O_CREAT | O_EXCL: never follows a symlink that appears at this path.
    const fd = openSync(abs, "wx", 0o644);
    try {
      if (size) {
        e.pipeBlob((c) => {
          for (const check of checks) check.update(c);
          writeAll(fd, c);
        });
      }
    } finally {
      closeSync(fd);
    }
    const failed = checks.find((check) => !check.matches());
    if (failed) {
      rmSync(abs, { force: true });
      throw new ArchiveError(`${rel}: ${failed.what} mismatch (corrupted archive?)`);
    }
    this.result.files++;
    this.result.bytes += size;
  }

  /** Applies modes and times last, deepest first, so read-only directories don't block writes. */
  finish() {
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const a = this.pending[i];
      try {
        // A later entry may have replaced this path with a symlink: never follow it.
        const st = lstatIfExists(a.abs);
        if (!st || st.isSymbolicLink() !== (a.type === "L")) continue;
        if (a.type === "L") {
          if (a.mtime !== undefined) lutimesSync(a.abs, a.mtime, a.mtime);
          continue;
        }
        if (a.mode !== undefined && !isWindows) chmodSync(a.abs, a.mode & 0o777);
        if (a.mtime !== undefined) utimesSync(a.abs, a.mtime, a.mtime);
      } catch (err) {
        this.warn(`couldn't set attributes on ${a.abs}: ${(err as Error).message}`, "attrs");
      }
    }
    return this.result;
  }
}

/**
 * Extracts an Apple Archive entry stream (see `openArchive`) into `dest`, creating it if needed.
 * Ownership, BSD flags, extended attributes, setuid and setgid bits are not restored.
 */
export function extractArchive(r: Reader, dest: string, opts: ExtractOptions = {}): ExtractResult {
  const x = new Extractor(dest, opts);
  x.run(r);
  return x.finish();
}
