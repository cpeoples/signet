import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ArchiveError, bufferChunks, extractArchive, parseHeader, Reader, safeComponents } from "../src/index.js";
import { archive, dat, entry, isWindows, lnk, mod, pat, tempDir, typ, yop } from "./helpers.js";

const extractBuf = (b: Buffer, dir: string) => extractArchive(new Reader(bufferChunks(b)), dir);

/** A destination inside a sandbox, plus a sibling directory that must never be touched. */
function sandbox() {
  const root = tempDir();
  const dest = join(root, "dest"), outside = join(root, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "victim.txt"), "original");
  return { dest, outside };
}

describe("extraction safety", () => {
  for (const bad of ["../escape.txt", "a/../../escape.txt", "/etc/escape.txt", "..", "a/b/../../../x"]) {
    it(`rejects path ${JSON.stringify(bad)}`, () => {
      const { dest, outside } = sandbox();
      assert.throws(() => extractBuf(archive(entry(typ("F"), pat(bad), dat("pwned"))), dest), ArchiveError);
      assert.equal(existsSync(join(outside, "..", "escape.txt")), false);
    });
  }

  it("rejects Windows drive and UNC style paths", () => {
    for (const p of ["C:/x", "c:x", "\\\\server\\share\\x", "\\x"]) assert.throws(() => safeComponents(p), ArchiveError, p);
  });

  it("allows harmless relative forms", () => {
    assert.deepEqual(safeComponents("./a//b/./c"), ["a", "b", "c"]);
    assert.deepEqual(safeComponents(""), []);
    assert.deepEqual(safeComponents("a..b/..c"), ["a..b", "..c"]);
  });

  it("never writes through a symlink in a parent directory", { skip: isWindows && "symlinks need privileges" }, () => {
    const { dest, outside } = sandbox();
    const a = archive(
      entry(typ("L"), pat("evil"), lnk(outside)),
      entry(typ("F"), pat("evil/victim.txt"), dat("pwned")),
    );
    assert.throws(() => extractBuf(a, dest), /symlink/);
    assert.equal(readFileSync(join(outside, "victim.txt"), "utf8"), "original");
  });

  it("replaces a symlink at a file's own path instead of following it", { skip: isWindows && "symlinks need privileges" }, () => {
    const { dest, outside } = sandbox();
    const a = archive(
      entry(typ("L"), pat("f"), lnk(join(outside, "victim.txt"))),
      entry(typ("F"), pat("f"), dat("new content")),
    );
    extractBuf(a, dest);
    assert.equal(readFileSync(join(outside, "victim.txt"), "utf8"), "original");
    assert.equal(lstatSync(join(dest, "f")).isSymbolicLink(), false);
    assert.equal(readFileSync(join(dest, "f"), "utf8"), "new content");
  });

  it("deferred modes are never applied through a symlink that replaced a file", { skip: isWindows && "POSIX modes" }, () => {
    const { dest, outside } = sandbox();
    const victim = join(outside, "victim.txt");
    const before = statSync(victim).mode & 0o777;
    const a = archive(
      entry(typ("F"), pat("f"), dat("x"), mod(0o777)),
      entry(typ("L"), pat("f"), lnk(victim)),
    );
    extractBuf(a, dest);
    assert.equal(statSync(victim).mode & 0o777, before);
  });

  it("OTA fixups (YOP=O) can't change files outside the extraction", { skip: isWindows && "POSIX modes" }, () => {
    const { dest, outside } = sandbox();
    const victim = join(outside, "victim.txt");
    const before = statSync(victim).mode & 0o777;
    const outsideBefore = statSync(outside).mode & 0o777;
    const files = archive(entry(typ("L"), pat("link"), lnk(outside)));
    const fixups = archive(entry(typ("F"), pat("link/victim.txt"), mod(0o777)), entry(typ("D"), pat("link"), mod(0o777)));
    const a = archive(
      entry(typ("M"), yop("E"), dat(files)),
      entry(typ("M"), yop("O"), dat(fixups)),
    );
    extractBuf(a, dest);
    assert.equal(statSync(victim).mode & 0o777, before);
    assert.equal(statSync(outside).mode & 0o777, outsideBefore);
  });

  it("a file can't replace a directory", () => {
    const { dest } = sandbox();
    assert.throws(() => extractBuf(archive(entry(typ("D"), pat("d")), entry(typ("F"), pat("d"), dat("x"))), dest), ArchiveError);
  });

  it("setuid and setgid bits are dropped", { skip: isWindows && "POSIX modes" }, () => {
    const { dest } = sandbox();
    extractBuf(archive(entry(typ("F"), pat("suid"), dat("x"), mod(0o4755))), dest);
    assert.equal(statSync(join(dest, "suid")).mode & 0o7777, 0o755);
  });

  it("rejects malformed headers instead of misreading them", () => {
    const good = entry(typ("F"), pat("x"), dat("abc"));
    const badMagic = Buffer.from(good); badMagic.write("XX01", 0);
    const badType = Buffer.from(good); badType[6 + 3] = "Z".charCodeAt(0);
    const shortSize = Buffer.from(good); shortSize.writeUInt16LE(3, 4);
    const overrun = Buffer.from(good); overrun.writeUInt16LE(good.readUInt16LE(4) - 2, 4);
    for (const b of [badMagic, badType, shortSize, overrun]) assert.throws(() => extractBuf(b, tempDir()), ArchiveError);
  });

  it("rejects 64-bit blob sizes that don't fit in a JavaScript number", () => {
    const h = Buffer.alloc(6 + 4 + 8);
    h.write("AA01", 0, "latin1");
    h.writeUInt16LE(h.length, 4);
    h.write("DATC", 6, "latin1");
    h.writeBigUInt64LE(2n ** 63n, 10);
    assert.throws(() => parseHeader(h), /too large/);
  });
});

describe("OTA archive structure (YOP metadata entries)", () => {
  it("extracts YOP=E contents, applies YOP=O attributes, skips manifests", { skip: isWindows && "POSIX modes" }, () => {
    const dest = tempDir();
    const files = archive(
      entry(typ("D"), pat("")),
      entry(typ("D"), pat("AssetData")),
      entry(typ("F"), pat("AssetData/Info.plist"), dat("<plist/>")),
    );
    const fixups = archive(
      entry(typ("F"), pat("AssetData/Info.plist"), mod(0o444), { key: "MTM", t: 1_700_000_000 }),
      entry(typ("F"), pat("AssetData/not-extracted"), mod(0o644)),
      entry(typ("D"), pat("AssetData"), mod(0o755), { key: "MTM", t: 1_600_000_000 }),
    );
    const a = archive(
      entry(typ("M"), yop("M"), dat(archive(entry(typ("M"), yop("E"))))),
      entry(typ("M"), yop("E"), { key: "LBL", s: "main" }, dat(files)),
      entry(typ("M"), yop("O"), { key: "LBL", s: "main" }, dat(fixups)),
    );
    const res = extractBuf(a, dest);
    assert.equal(res.files, 1);
    const st = statSync(join(dest, "AssetData/Info.plist"));
    assert.equal(st.mode & 0o777, 0o444);
    assert.equal(Math.floor(st.mtimeMs / 1000), 1_700_000_000);
    assert.equal(Math.floor(statSync(join(dest, "AssetData")).mtimeMs / 1000), 1_600_000_000);
    assert.equal(existsSync(join(dest, "AssetData/not-extracted")), false, "fixups never create files");
  });
});
