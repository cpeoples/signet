// Live parity with Apple's own tools: macOS only (needs /usr/bin/aea and /usr/bin/aa). Generates
// fresh random inputs on every run, so it covers more than the committed fixtures.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { decryptFileChunks, extractArchive, openArchive } from "../src/index.js";
import { collect, sha256, tempDir } from "./helpers.js";

const hasTools = process.platform === "darwin" && existsSync("/usr/bin/aea") && existsSync("/usr/bin/aa");

function randomInput(size: number): Buffer {
  // Mix compressible and random regions so compressors use stored and compressed segments.
  const parts: Buffer[] = [];
  let n = 0;
  while (n < size) {
    const len = Math.min(size - n, 1 + Math.floor(Math.random() * 40000));
    const kind = Math.random();
    const b = kind < 0.3 ? randomBytes(len)
      : kind < 0.6 ? Buffer.from("signet ".repeat(Math.ceil(len / 7))).subarray(0, len)
      : kind < 0.8 ? Buffer.alloc(len, Math.floor(Math.random() * 256))
      : Buffer.from(Array.from({ length: len }, (_, i) => (i * 31 + (i >> 5)) & 0xff));
    parts.push(b);
    n += len;
  }
  return Buffer.concat(parts);
}

describe("parity with Apple's aea and aa", { skip: !hasTools && "needs macOS with /usr/bin/aea and /usr/bin/aa" }, () => {
  const algorithms = ["lzfse", "zlib", "lz4", "none"];
  const blocks = ["1k", "64k", "1m"];
  const checksums = ["none", "murmur64", "sha256"];

  for (const a of algorithms) {
    for (const b of blocks) {
      it(`decrypts aea encrypt -a ${a} -b ${b}`, () => {
        const d = tempDir();
        const input = randomInput(b === "1k" ? 300_000 : 3_000_000);
        const key = `base64:${randomBytes(32).toString("base64")}`;
        writeFileSync(join(d, "in"), input);
        const ck = checksums[Math.floor(Math.random() * checksums.length)];
        execFileSync("aea", ["encrypt", "-profile", "1", "-key-value", key, "-a", a, "-b", b, "-checksum", ck,
          "-i", join(d, "in"), "-o", join(d, "in.aea")]);
        assert.equal(sha256(collect(decryptFileChunks(join(d, "in.aea"), key))), sha256(input), `checksum ${ck}`);
      });
    }
  }

  for (const a of ["raw", "lzfse", "zlib", "lz4"]) {
    it(`extracts aa archive -a ${a} identically`, () => {
      const d = tempDir(), src = join(d, "src");
      mkdirSync(join(src, "a", "b"), { recursive: true });
      for (let i = 0; i < 25; i++) writeFileSync(join(src, i % 2 ? "a" : "a/b", `f${i}.bin`), randomInput(Math.floor(Math.random() * 200_000)));
      writeFileSync(join(src, "empty"), "");
      symlinkSync("a/f1.bin", join(src, "ln"));
      execFileSync("aa", ["archive", "-d", src, "-o", join(d, "t.aar"), "-a", a, "-b", "256k"]);
      const out = join(d, "out");
      extractArchive(openArchive(join(d, "t.aar")), out);
      const walk = (root: string, rel = ""): string[] => readdirSync(join(root, rel)).sort().flatMap((n) => {
        const r = rel ? `${rel}/${n}` : n, st = lstatSync(join(root, r));
        if (st.isSymbolicLink()) return [`L ${r} ${readlinkSync(join(root, r))}`];
        if (st.isDirectory()) return [`D ${r} ${st.mode & 0o777}`, ...walk(root, r)];
        return [`F ${r} ${st.mode & 0o777} ${sha256(readFileSync(join(root, r)))}`];
      });
      assert.deepEqual(walk(out), walk(src));
    });
  }
});
