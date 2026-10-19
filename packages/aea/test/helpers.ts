import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after } from "node:test";
import { fileURLToPath } from "node:url";

// Compiled tests live in build-test/test/, fixtures in test/fixtures/.
const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURES = join(here, "..", "..", "test", "fixtures");
export const fixture = (name: string) => join(FIXTURES, name);
export const KEY = readFileSync(fixture("key.txt"), "utf8").trim();

export interface ExpectedEntry { path: string; type: string; mode: number; mtime: number; size?: number; sha256?: string; link?: string }
export const EXPECTED: {
  corpus: { size: number; sha256: string };
  multi: { size: number; sha256: string };
  tree: ExpectedEntry[];
} = JSON.parse(readFileSync(fixture("expected.json"), "utf8"));

export const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

export const isWindows = process.platform === "win32";

const temps: string[] = [];
export function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "signet-aea-test-"));
  temps.push(d);
  return d;
}
after(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

export const collect = (it: Iterable<Uint8Array>) => Buffer.concat([...it]);

// A minimal Apple Archive writer, for crafting archives Apple's tools won't produce.

export type Field =
  | { key: string; u: number; size?: 1 | 2 | 4 | 8 }
  | { key: string; s: string }
  | { key: string; blob: Uint8Array }
  | { key: string; t: number };

export const typ = (c: string): Field => ({ key: "TYP", u: c.charCodeAt(0), size: 1 });
export const pat = (s: string): Field => ({ key: "PAT", s });
export const lnk = (s: string): Field => ({ key: "LNK", s });
export const dat = (b: string | Uint8Array): Field => ({ key: "DAT", blob: typeof b === "string" ? Buffer.from(b) : b });
export const mod = (m: number): Field => ({ key: "MOD", u: m, size: 2 });
export const yop = (c: string): Field => ({ key: "YOP", u: c.charCodeAt(0), size: 1 });

export function entry(...fields: Field[]): Buffer {
  const parts: Buffer[] = [];
  const blobs: Uint8Array[] = [];
  for (const f of fields) {
    const k = Buffer.from(f.key, "latin1");
    if ("u" in f) {
      const n = f.size ?? 4;
      const v = Buffer.alloc(n);
      v.writeUIntLE(f.u, 0, Math.min(n, 6));
      parts.push(k, Buffer.from(String(n)), v);
    } else if ("s" in f) {
      const s = Buffer.from(f.s, "utf8"), l = Buffer.alloc(2);
      l.writeUInt16LE(s.length);
      parts.push(k, Buffer.from("P"), l, s);
    } else if ("t" in f) {
      const v = Buffer.alloc(12);
      v.writeBigInt64LE(BigInt(f.t));
      parts.push(k, Buffer.from("T"), v);
    } else {
      const l = Buffer.alloc(4);
      l.writeUInt32LE(f.blob.length);
      parts.push(k, Buffer.from("B"), l);
      blobs.push(f.blob);
    }
  }
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(6);
  head.write("AA01", 0, "latin1");
  head.writeUInt16LE(6 + body.length, 4);
  return Buffer.concat([head, body, ...blobs]);
}

export const archive = (...entries: Buffer[]) => Buffer.concat(entries);
