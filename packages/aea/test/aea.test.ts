import assert from "node:assert/strict";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  AeaError, decryptFile, decryptFileChunks, murmur64, parseKey, readAeaHeader, UnsupportedCompressionError,
} from "../src/index.js";
import { collect, EXPECTED, fixture, KEY, sha256, tempDir } from "./helpers.js";

const SUPPORTED = ["lzfse", "zlib", "lz4", "none", "clusters", "murmur", "nocheck", "nopad", "padme", "authdata"];
const code = (fn: () => unknown) => {
  try { fn(); } catch (e) { return e instanceof AeaError ? e.code : `${(e as Error).name}: ${(e as Error).message}`; }
  return "no error";
};

describe("AEA decryption (archives made by Apple's aea tool)", () => {
  for (const name of SUPPORTED) {
    it(`decrypts corpus.${name}.aea byte-for-byte`, () => {
      const out = collect(decryptFileChunks(fixture(`corpus.${name}.aea`), KEY));
      assert.equal(out.length, EXPECTED.corpus.size);
      assert.equal(sha256(out), EXPECTED.corpus.sha256);
    });
  }

  it("decrypts an archive spanning several clusters", () => {
    let info: any;
    const out = collect(decryptFileChunks(fixture("multi-cluster.aea"), KEY, { onInfo: (i) => (info = i) }));
    assert.equal(sha256(out), EXPECTED.multi.sha256);
    assert.ok(info.size / info.segmentSize > info.segmentsPerCluster, "fixture spans 2+ clusters");
    assert.equal(info.compression, "lzfse");
    assert.equal(info.checksum, "sha256");
  });

  it("decrypts an empty archive", () => {
    assert.equal(collect(decryptFileChunks(fixture("empty.aea"), KEY)).length, 0);
  });

  it("refuses LZMA and LZBITMAP segments with a clear error", () => {
    for (const n of ["lzma", "lzbitmap"])
      assert.throws(() => collect(decryptFileChunks(fixture(`corpus.${n}.aea`), KEY)), UnsupportedCompressionError);
  });

  it("decryptFile writes the plaintext", () => {
    const out = join(tempDir(), "out.aar");
    const info = decryptFile(fixture("corpus.lzfse.aea"), out, KEY);
    assert.equal(info.size, EXPECTED.corpus.size);
    assert.equal(sha256(readFileSync(out)), EXPECTED.corpus.sha256);
  });

  it("reads auth data without a key", () => {
    const h = readAeaHeader(fixture("corpus.authdata.aea"));
    assert.equal(h.profile, 1);
    assert.deepEqual(h.authFields, { "com.example.url": "https://example.com/x", "com.example.note": "test fixture" });
  });

  it("accepts every key spelling Apple and the site use", () => {
    const raw = parseKey(KEY);
    const b64 = raw.toString("base64"), hex = raw.toString("hex");
    for (const k of [b64, `base64:${b64}`, ` ${b64}\n`, `hex:${hex}`, hex, hex.toUpperCase(), raw]) assert.deepEqual(parseKey(k), raw);
    for (const k of ["", "abc", "hex:zz", "base64:AAAA", "not base64 !!", Buffer.alloc(16)])
      assert.equal(code(() => parseKey(k)), "BAD_KEY", String(k));
  });

  it("matches AEA's murmur64 on a known vector", () => {
    // Recorded from Apple's aea: the checksum of corpus.bin's first 16 KiB segment. corpus.bin is
    // generated deterministically by scripts/make-fixtures.sh, so this value is stable.
    const corpus = readFileSync(fixture("corpus.bin"));
    assert.equal(murmur64(corpus.subarray(0, 16384)), 0x5441272d9b2d2caen);
    assert.notEqual(murmur64(Buffer.from("a")), murmur64(Buffer.from("b")));
  });
});

describe("AEA failure modes", () => {
  const wrongKey = Buffer.alloc(32, 7).toString("base64");

  it("wrong key fails at the root header, before any output", () => {
    assert.equal(code(() => collect(decryptFileChunks(fixture("corpus.lzfse.aea"), wrongKey))), "WRONG_KEY");
    const out = join(tempDir(), "never.aar");
    assert.equal(code(() => decryptFile(fixture("corpus.lzfse.aea"), out, wrongKey)), "WRONG_KEY");
    assert.equal(existsSync(out), false, "no output file is created for a wrong key");
  });

  it("rejects a file without the AEA1 magic as NOT_AEA", () => {
    assert.equal(code(() => collect(decryptFileChunks(fixture("corpus.bin"), KEY))), "NOT_AEA");
  });

  it("rejects profiles other than 1 as UNSUPPORTED", () => {
    const d = tempDir(), p = join(d, "p.aea");
    const b = readFileSync(fixture("corpus.lzfse.aea"));
    b.writeUInt32LE(5, 4); // scrypt password profile
    writeFileSync(p, b);
    assert.equal(code(() => collect(decryptFileChunks(p, KEY))), "UNSUPPORTED");
  });

  it("any flipped bit is detected, and decryptFile leaves no partial output", () => {
    const src = readFileSync(fixture("corpus.lzfse.aea"));
    const d = tempDir();
    const header = 12 + src.readUInt32LE(8);
    // Prologue (auth data length excluded), salt, root header, cluster header, segment data, padding.
    const offsets = [header - 1, header + 5, header + 40, header + 120, header + 600, src.length >> 1, src.length - 1];
    for (const at of offsets) {
      const b = Buffer.from(src);
      b[at] ^= 0x10;
      const p = join(d, `flip-${at}.aea`), out = join(d, `flip-${at}.aar`);
      writeFileSync(p, b);
      const c = code(() => decryptFile(p, out, KEY));
      // Inside the prologue a flip can also change the auth data length, which reads as truncation.
      const ok = at < header ? ["CORRUPT", "WRONG_KEY", "TRUNCATED"] : ["CORRUPT", "WRONG_KEY"];
      assert.ok(ok.includes(c), `byte ${at}: got ${c}`);
      assert.equal(existsSync(out), false, `byte ${at}: partial output was left behind`);
    }
  });

  it("truncated downloads are reported as TRUNCATED", () => {
    const src = readFileSync(fixture("corpus.lzfse.aea"));
    const d = tempDir();
    for (const n of [10, 200, src.length >> 1, src.length - 1]) {
      const p = join(d, `cut-${n}.aea`);
      writeFileSync(p, src.subarray(0, n));
      assert.equal(code(() => collect(decryptFileChunks(p, KEY))), "TRUNCATED", `cut at ${n}`);
    }
  });

  it("trailing garbage after an unpadded archive is rejected", () => {
    const d = tempDir(), p = join(d, "extra.aea");
    copyFileSync(fixture("corpus.nopad.aea"), p);
    writeFileSync(p, Buffer.concat([readFileSync(p), Buffer.from("junk")]));
    assert.equal(code(() => collect(decryptFileChunks(p, KEY))), "CORRUPT");
  });

  it("a corrupted cluster in a multi-cluster archive is caught", () => {
    const b = readFileSync(fixture("multi-cluster.aea"));
    b[Math.floor(b.length * 0.8)] ^= 4;
    const p = join(tempDir(), "mc.aea");
    writeFileSync(p, b);
    assert.equal(code(() => collect(decryptFileChunks(p, KEY))), "CORRUPT");
  });
});

// Optional end-to-end check against a real OTA package. Not in CI (the file is hundreds of MB):
//   AEA_OTA_PKG=/tmp/aea-test/pkg.aea AEA_OTA_KEY=... AEA_OTA_AAR=/tmp/aea-test/ota.aar npm test
const ota = process.env.AEA_OTA_PKG;
describe("real OTA package", { skip: !ota && "set AEA_OTA_PKG, AEA_OTA_KEY (and optionally AEA_OTA_AAR) to run" }, () => {
  it("decrypts to the same bytes as Apple's aea", () => {
    const out = join(tempDir(), "ota.aar");
    decryptFile(ota!, out, process.env.AEA_OTA_KEY!);
    const ref = process.env.AEA_OTA_AAR;
    if (ref) assert.equal(sha256(readFileSync(out)), sha256(readFileSync(ref)));
  });
});
