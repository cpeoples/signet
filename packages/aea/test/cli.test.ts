import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { EXPECTED, fixture, isWindows, KEY, sha256, tempDir } from "./helpers.js";

// Runs the real compiled bin (build-test/src/cli.js), the way npm would.
const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");
const run = (...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });

describe("signet-aea CLI", () => {
  it("--help prints usage and --version the package version", () => {
    const h = run("--help");
    assert.equal(h.status, 0);
    assert.match(h.stdout, /Usage:/);
    const v = run("--version");
    assert.equal(v.stdout.trim(), JSON.parse(readFileSync(join(dirname(CLI), "..", "..", "package.json"), "utf8")).version);
  });

  it("usage errors exit 2", () => {
    assert.equal(run().status, 2);
    assert.equal(run("decrypt").status, 2);
    assert.equal(run("decrypt", fixture("corpus.lzfse.aea")).status, 2, "missing --key");
    assert.equal(run("bogus", "x").status, 2);
    assert.equal(run("list", "x", "--frobnicate").status, 2);
  });

  it("decrypt writes the plaintext", () => {
    const out = join(tempDir(), "o.aar");
    const r = run("decrypt", fixture("corpus.lzfse.aea"), "--key", KEY, "-o", out);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(sha256(readFileSync(out)), EXPECTED.corpus.sha256);
  });

  it("decrypt reads the key from --key-file, and -q silences stderr", () => {
    const out = join(tempDir(), "o.aar");
    const r = run("decrypt", fixture("corpus.lzfse.aea"), "--key-file", fixture("key.txt"), "-o", out, "-q");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, "");
  });

  it("wrong key exits 1 with a clear message", () => {
    const out = join(tempDir(), "o.aar");
    const r = run("decrypt", fixture("corpus.lzfse.aea"), "--key", Buffer.alloc(32).toString("base64"), "-o", out);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /wrong key/);
    assert.equal(existsSync(out), false);
  });

  it("extract an .aea straight to files", () => {
    const dir = join(tempDir(), "x");
    const r = run("extract", fixture("tree.aea"), "-k", KEY, "-d", dir);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /Extracted \d+ files/);
    const f = EXPECTED.tree.find((e) => e.path === "dir/corpus.bin")!;
    assert.equal(sha256(readFileSync(join(dir, "dir", "corpus.bin"))), f.sha256);
  });

  it("extract --include limits output to a subtree", () => {
    const dir = join(tempDir(), "x");
    assert.equal(run("extract", fixture("tree.lzfse.aar"), "-d", dir, "-i", "dir/nested", "-q").status, 0);
    assert.ok(existsSync(join(dir, "dir", "nested", "readonly.txt")));
    assert.equal(existsSync(join(dir, "hello.txt")), false);
  });

  it("list prints entries, and --json one object per line", () => {
    const r = run("list", fixture("tree.raw.aar"));
    assert.equal(r.status, 0);
    assert.match(r.stdout, /hello\.txt/);
    const j = run("list", fixture("tree.aea"), "--json", "-k", KEY);
    const rows = j.stdout.trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(rows.some((e) => e.path === "link-to-hello" && e.type === "L" && e.link === "hello.txt"));
  });

  it("info prints auth data fields without a key", () => {
    const r = run("info", fixture("corpus.authdata.aea"));
    assert.equal(r.status, 0);
    assert.match(r.stdout, /com\.example\.url: https:\/\/example\.com\/x/);
  });

  it("is executable through a shebang on POSIX", { skip: isWindows && "no shebangs" }, () => {
    assert.match(readFileSync(CLI, "utf8"), /^#!\/usr\/bin\/env node/);
    assert.equal(execFileSync(process.execPath, [CLI, "-v"], { encoding: "utf8" }).trim().length > 0, true);
  });
});
