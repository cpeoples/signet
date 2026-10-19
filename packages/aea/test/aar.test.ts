import assert from "node:assert/strict";
import { lstatSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  ArchiveError, extractArchive, listEntries, openArchive, PosixCksum, UnsupportedCompressionError,
} from "../src/index.js";
import { EXPECTED, fixture, isWindows, KEY, sha256, tempDir } from "./helpers.js";

/** Reads a directory back into the same shape as expected.json. */
function snapshot(root: string) {
  const out: Record<string, any> = {};
  (function walk(rel: string) {
    for (const name of readdirSync(join(root, rel)).sort()) {
      const r = rel ? `${rel}/${name}` : name, p = join(root, r), st = lstatSync(p);
      const e: any = { mode: st.mode & 0o777, mtime: Math.floor(st.mtimeMs / 1000) };
      if (st.isSymbolicLink()) Object.assign(e, { type: "L", link: readlinkSync(p).replace(/\\/g, "/") }); // Windows stores "..\\x"
      else if (st.isDirectory()) e.type = "D";
      else Object.assign(e, { type: "F", size: st.size, sha256: sha256(readFileSync(p)) });
      out[r.normalize("NFC")] = e;
      if (e.type === "D") walk(r);
    }
  })("");
  return out;
}

function checkTree(dir: string, warnings: string[]) {
  const got = snapshot(dir);
  const symlinksSkipped = isWindows && warnings.some((w) => w.includes("symlink"));
  for (const want of EXPECTED.tree) {
    if (want.type === "L" && symlinksSkipped) continue;
    const g = got[want.path];
    assert.ok(g, `missing ${want.path}`);
    assert.equal(g.type, want.type, `${want.path}: type`);
    if (want.type === "F") {
      assert.equal(g.size, want.size, `${want.path}: size`);
      assert.equal(g.sha256, want.sha256, `${want.path}: content`);
    }
    if (want.type === "L") assert.equal(g.link, want.link, `${want.path}: link target`);
    if (!isWindows) assert.equal(g.mode, want.mode, `${want.path}: mode ${g.mode.toString(8)} != ${want.mode.toString(8)}`);
    if (want.type !== "L" || !isWindows) assert.equal(g.mtime, want.mtime, `${want.path}: mtime`);
  }
  const extra = Object.keys(got).filter((p) => !EXPECTED.tree.some((w) => w.path === p));
  assert.deepEqual(extra, [], "no unexpected files");
}

describe("Apple Archive extraction (archives made by Apple's aa tool)", () => {
  for (const name of ["tree.raw.aar", "tree.lzfse.aar", "tree.zlib.aar", "tree.lz4.aar", "tree.digests.aar"]) {
    it(`extracts ${name} exactly`, () => {
      const dir = tempDir();
      const res = extractArchive(openArchive(fixture(name)), dir);
      checkTree(dir, res.warnings);
      assert.equal(res.files, EXPECTED.tree.filter((e) => e.type === "F").length);
    });
  }

  it("extracts straight from an encrypted archive (tree.aea)", () => {
    const dir = tempDir();
    const res = extractArchive(openArchive(fixture("tree.aea"), { key: KEY }), dir);
    checkTree(dir, res.warnings);
  });

  it("requires a key for .aea input", () => {
    assert.throws(() => openArchive(fixture("tree.aea")), ArchiveError);
  });

  it("refuses LZMA-compressed archives with a clear error", () => {
    assert.throws(() => extractArchive(openArchive(fixture("tree.lzma.aar")), tempDir()), UnsupportedCompressionError);
  });

  it("lists every entry with its type, size and link target", () => {
    const list = [...listEntries(openArchive(fixture("tree.lzfse.aar")))];
    const byPath = new Map(list.map((e) => [e.path.normalize("NFC"), e]));
    for (const w of EXPECTED.tree) {
      const e = byPath.get(w.path);
      assert.ok(e, w.path);
      assert.equal(e.type, w.type);
      if (w.type === "F") assert.equal(e.size, w.size);
      if (w.type === "L") assert.equal(e.link, w.link);
    }
  });

  it("detects corrupted file data through the archive's digests", () => {
    const b = readFileSync(fixture("tree.digests.aar"));
    const at = b.indexOf("line 700:");
    assert.ok(at > 0);
    b[at] ^= 1;
    const p = join(tempDir(), "bad.aar");
    writeFileSync(p, b);
    assert.throws(() => extractArchive(openArchive(p), tempDir()), /digest mismatch|CKS checksum mismatch/);
    // ...and --no-verify still extracts it.
    extractArchive(openArchive(p), tempDir(), { verify: false });
  });

  it("rejects truncated archives", () => {
    const b = readFileSync(fixture("tree.raw.aar"));
    const p = join(tempDir(), "cut.aar");
    writeFileSync(p, b.subarray(0, b.length - 100));
    assert.throws(() => extractArchive(openArchive(p), tempDir()), ArchiveError);
  });

  it("extracts only the entries the filter accepts", () => {
    const dir = tempDir();
    extractArchive(openArchive(fixture("tree.raw.aar")), dir, { filter: (p) => p === "dir" || p.startsWith("dir/") });
    assert.deepEqual(Object.keys(snapshot(dir)).filter((p) => !p.startsWith("dir")), []);
    assert.ok(snapshot(dir)["dir/corpus.bin"]);
  });

  it("POSIX cksum matches the cksum(1) value", () => {
    // `printf 'hello\n' | cksum` => 3015617425 6
    assert.equal(new PosixCksum().update(Buffer.from("hello\n")).digest(), 3015617425);
    assert.equal(new PosixCksum().digest(), 4294967295);
  });
});
