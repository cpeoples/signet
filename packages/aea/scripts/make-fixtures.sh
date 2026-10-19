#!/bin/sh
# Regenerates test/fixtures with Apple's own tools. macOS 13+ only (needs /usr/bin/aea, aa,
# compression_tool). The outputs are committed, so the tests can check our decoders against
# Apple's encoders on every OS. Encryption uses random salts, so rerunning changes the bytes;
# only rerun when adding fixtures.
set -eu

for t in aea aa compression_tool; do
  command -v "$t" >/dev/null || { echo "make-fixtures: '$t' not found (macOS 13+ required)" >&2; exit 1; }
done

cd "$(dirname "$0")/.."
OUT=test/fixtures
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
rm -rf "$OUT"
mkdir -p "$OUT"

# corpus.bin: text, long repeats, random bytes and zeros, so every compressor takes several paths.
node -e '
const fs = require("fs");
let s = 0x9e3779b9;
const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s; };
const parts = [];
for (let i = 0; i < 1500; i++) parts.push(Buffer.from(`line ${i}: the quick brown fox ${i % 7 ? "jumps" : "naps"} over ${rnd() % 1000}\n`));
parts.push(Buffer.alloc(20000, 0));
parts.push(Buffer.from(Array.from({ length: 30000 }, () => rnd() & 0xff)));
parts.push(Buffer.from("abcabcabcabd".repeat(2000)));
fs.writeFileSync(process.argv[1], Buffer.concat(parts));
' "$WORK/corpus.bin"
cp "$WORK/corpus.bin" "$OUT/corpus.bin"
printf 'hello hello hello hello world\n' > "$OUT/small.txt"

# The test key. It protects nothing: it's only for these fixtures.
KEY="base64:$(head -c 32 /dev/urandom | base64)"
echo "$KEY" > "$OUT/key.txt"

# A directory tree covering every entry type aa writes that we extract.
T="$WORK/tree"
mkdir -p "$T/dir/nested/deeper" "$T/empty-dir" "$T/ünïcødé"
printf 'hello\n' > "$T/hello.txt"
: > "$T/empty"
cp "$WORK/corpus.bin" "$T/dir/corpus.bin"
printf '#!/bin/sh\necho hi\n' > "$T/dir/run.sh"; chmod 755 "$T/dir/run.sh"
printf 'read only\n' > "$T/dir/nested/readonly.txt"; chmod 444 "$T/dir/nested/readonly.txt"
printf 'deep\n' > "$T/dir/nested/deeper/file"
printf 'naïve\n' > "$T/ünïcødé/fïlé.txt"
ln -s hello.txt "$T/link-to-hello"
ln -s ../hello.txt "$T/dir/link-up"
ln -s does/not/exist "$T/dangling"
find "$T" -exec touch -h -t 202401020304.05 {} +

# Apple Archives (.aar)
for a in raw lzfse zlib lz4 lzma; do
  aa archive -d "$T" -o "$OUT/tree.$a.aar" -a "$a" -b 64k
done
# Every digest field, to exercise verification.
aa archive -d "$T" -o "$OUT/tree.digests.aar" -a raw -include-field siz,cks,sh1,sh2,sh3,sh5
# An archive inside an encrypted archive, as OTA packages ship.
aa archive -d "$T" -a raw -o "$WORK/tree.aar"
aea encrypt -profile 1 -key-value "$KEY" -a lzfse -b 16k -i "$WORK/tree.aar" -o "$OUT/tree.aea"

# Encrypted archives (.aea)
enc() { name=$1; shift; aea encrypt -profile 1 -key-value "$KEY" -i "$WORK/corpus.bin" -o "$OUT/corpus.$name.aea" "$@"; }
enc lzfse     -a lzfse -b 16k
enc zlib      -a zlib  -b 16k
enc lz4       -a lz4   -b 16k
enc none      -a none  -b 16k
enc lzma      -a lzma  -b 16k
enc lzbitmap  -a lzbitmap -b 16k
enc clusters  -a lzfse -b 256b                 # aea clamps tiny blocks; kept as a small-block case
# More than 256 segments, so the archive spans two clusters: 4.9 MB that compresses to almost nothing
# (each 16 KiB segment is zeros plus its own index, so no two segments are identical).
node -e '
const b = Buffer.alloc(300 * 16384);
for (let i = 0; i < 300; i++) b.write(`segment ${i}`, i * 16384);
require("fs").writeFileSync(process.argv[1], b);
' "$WORK/multi.bin"
aea encrypt -profile 1 -key-value "$KEY" -a lzfse -b 16k -i "$WORK/multi.bin" -o "$OUT/multi-cluster.aea"
enc murmur    -a lzfse -b 16k -checksum murmur64
enc nocheck   -a lzfse -b 16k -checksum none
enc nopad     -a lzfse -b 16k -padding none
enc padme     -a lzfse -b 16k -padding adaptive
enc authdata  -a lzfse -b 16k -auth-data-key com.example.url -auth-data-value "hex:$(printf 'https://example.com/x' | xxd -p | tr -d '\n')" \
                               -auth-data-key com.example.note -auth-data-value "hex:$(printf 'test fixture' | xxd -p | tr -d '\n')"
: > "$WORK/empty"
aea encrypt -profile 1 -key-value "$KEY" -i "$WORK/empty" -o "$OUT/empty.aea"

# Raw compressed streams
compression_tool -encode -a lzfse -i "$OUT/small.txt" -o "$OUT/small.lzfse"   # LZVN block (bvxn)
compression_tool -encode -a lzfse -i "$WORK/corpus.bin" -o "$OUT/corpus.lzfse" # LZFSE v2 blocks
compression_tool -encode -a lz4 -i "$WORK/corpus.bin" -o "$OUT/corpus.lz4"
compression_tool -encode -a zlib -i "$WORK/corpus.bin" -o "$OUT/corpus.zlib"

# What extracting the tree must produce, recorded from the source tree itself.
node -e '
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const root = process.argv[1], out = [];
(function walk(rel) {
  for (const name of fs.readdirSync(path.join(root, rel)).sort()) {
    const r = rel ? rel + "/" + name : name, p = path.join(root, r), st = fs.lstatSync(p);
    const e = { path: r.normalize("NFC"), mode: st.mode & 0o777, mtime: Math.floor(st.mtimeMs / 1000) };
    if (st.isSymbolicLink()) Object.assign(e, { type: "L", link: fs.readlinkSync(p) });
    else if (st.isDirectory()) { out.push(Object.assign(e, { type: "D" })); walk(r); continue; }
    else Object.assign(e, { type: "F", size: st.size, sha256: crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex") });
    out.push(e);
  }
})("");
const corpus = fs.readFileSync(process.argv[2]), multi = fs.readFileSync(process.argv[4]);
const digest = (b) => ({ size: b.length, sha256: crypto.createHash("sha256").update(b).digest("hex") });
fs.writeFileSync(process.argv[3], JSON.stringify({ corpus: digest(corpus), multi: digest(multi), tree: out }, null, 2) + "\n");
' "$T" "$WORK/corpus.bin" "$OUT/expected.json" "$WORK/multi.bin"

chmod 644 "$OUT"/*
echo "Wrote $(ls "$OUT" | wc -l | tr -d ' ') fixtures to $OUT ($(du -sh "$OUT" | cut -f1))"
