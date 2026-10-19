import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  bufferChunks, decompress, DecompressError, lz4Decompress, lzfseDecompress, pbzChunks, Reader,
  UnsupportedCompressionError,
} from "../src/index.js";
import { collect, EXPECTED, fixture, sha256 } from "./helpers.js";

const corpus = readFileSync(fixture("corpus.bin"));

describe("decompressors (streams made by Apple's compression_tool)", () => {
  it("corpus fixture is intact", () => {
    assert.equal(corpus.length, EXPECTED.corpus.size);
    assert.equal(sha256(corpus), EXPECTED.corpus.sha256);
  });

  it("decodes LZVN (bvxn) blocks, which Apple writes for small inputs", () => {
    const src = readFileSync(fixture("small.lzfse"));
    assert.equal(src.toString("latin1", 0, 4), "bvxn", "fixture should exercise the LZVN path");
    assert.deepEqual(lzfseDecompress(src), readFileSync(fixture("small.txt")));
  });

  it("decodes LZFSE v2 (bvx2) blocks", () => {
    const src = readFileSync(fixture("corpus.lzfse"));
    assert.equal(src.toString("latin1", 0, 4), "bvx2");
    assert.equal(sha256(lzfseDecompress(src)), EXPECTED.corpus.sha256);
    assert.equal(sha256(lzfseDecompress(src, corpus.length)), EXPECTED.corpus.sha256);
  });

  it("decodes LZ4 with Apple's bv41 framing", () => {
    const src = readFileSync(fixture("corpus.lz4"));
    assert.equal(sha256(lz4Decompress(src)), EXPECTED.corpus.sha256);
    assert.equal(sha256(decompress("4", src, corpus.length)), EXPECTED.corpus.sha256);
  });

  it("decodes zlib streams (raw DEFLATE)", () => {
    const src = readFileSync(fixture("corpus.zlib"));
    assert.equal(sha256(decompress("z", src, corpus.length)), EXPECTED.corpus.sha256);
  });

  it("reports corrupt zlib data as DecompressError, with or without a zlib header", () => {
    for (const b of [Buffer.from([0x78, 0x9c, 1, 2, 3]), Buffer.from([0xff, 0xff, 0xff])])
      assert.throws(() => decompress("z", b, 10), DecompressError);
  });

  it("rejects truncated and corrupted streams with DecompressError, never hangs or overruns", () => {
    const src = readFileSync(fixture("corpus.lzfse"));
    for (const cut of [3, 20, 100, src.length >> 1, src.length - 4]) {
      assert.throws(() => lzfseDecompress(src.subarray(0, cut)), DecompressError, `cut at ${cut}`);
    }
    const lzvn = readFileSync(fixture("small.lzfse"));
    assert.throws(() => lzfseDecompress(lzvn.subarray(0, 20)), DecompressError);
    assert.throws(() => lzfseDecompress(Buffer.from("nope----")), DecompressError);
    assert.throws(() => decompress("e", src, corpus.length + 1), DecompressError, "size mismatch is detected");
  });

  it("fuzz: random corruption of LZFSE and LZ4 input only ever throws DecompressError", () => {
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0);
    for (const [name, fn] of [["corpus.lzfse", lzfseDecompress], ["corpus.lz4", lz4Decompress]] as const) {
      const src = readFileSync(fixture(name));
      for (let i = 0; i < 60; i++) {
        const b = Buffer.from(src);
        for (let j = 0; j < 4; j++) b[rnd() % b.length] ^= 1 << (rnd() % 8);
        try {
          fn(b);
        } catch (e) {
          assert.ok(e instanceof DecompressError, `${name}: unexpected ${(e as Error).name}: ${(e as Error).message}`);
        }
      }
    }
  });

  it("reports LZMA, LZBITMAP and LZRAVEN as unsupported", () => {
    for (const c of ["x", "b", "m", "?"]) assert.throws(() => decompress(c, Buffer.alloc(4), 4), UnsupportedCompressionError);
  });

  it("decodes a pbz stream mixing stored and compressed blocks", () => {
    const lzfseBlock = readFileSync(fixture("small.lzfse"));
    const small = readFileSync(fixture("small.txt"));
    const stored = Buffer.from("stored-block-that-is-not-compressed-at-all-0123456789abcdefghijk");
    const u64 = (n: number) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; };
    const stream = Buffer.concat([
      Buffer.from("pbze"), u64(64),
      u64(small.length), u64(lzfseBlock.length), lzfseBlock,
      u64(stored.length), u64(stored.length), stored,
    ]);
    const out = collect(pbzChunks(new Reader(bufferChunks(stream))));
    assert.deepEqual(out, Buffer.concat([small, stored]));
  });
});
