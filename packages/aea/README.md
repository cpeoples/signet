# @chrispeoples/aea

Decrypt Apple Encrypted Archives (`.aea`) and list or extract Apple Archives (`.aar`) on Linux,
macOS and Windows. Pure TypeScript, no dependencies beyond Node's built-in modules.

Apple ships OTA software updates as `.aea` files whose decryption keys it publishes. This package
reads them without Apple's `aea` and `aa` tools.

## Install

```sh
npm install @chrispeoples/aea      # library
npm install -g @chrispeoples/aea   # signet-aea command
```

Requires Node.js 22 or later.

## CLI

```sh
signet-aea decrypt FILE.aea --key KEY [-o OUT.aar]
signet-aea extract FILE [--key KEY] [-d DIR] [--include PREFIX]... [--no-verify]
signet-aea list    FILE [--key KEY] [--json]
signet-aea info    FILE.aea
```

`extract` and `list` accept an `.aea` (with a key) or an `.aar`, plain or compressed. `info` prints
the profile and the unencrypted auth data of an `.aea` and needs no key.

| Option | Meaning |
| --- | --- |
| `-k`, `--key KEY` | 32-byte key: base64 (optionally prefixed `base64:`), `hex:...` or 64 hex digits |
| `--key-file FILE` | read the key from a file instead of the command line |
| `-o`, `--output FILE` | `decrypt` output (default: input with `.aea` replaced by `.aar`) |
| `-d`, `--dir DIR` | `extract` destination (default: input file name without `.aea` or `.aar`, or with `.d` appended, in the current directory) |
| `-i`, `--include PREFIX` | `extract` only paths equal to or under `PREFIX`; repeatable |
| `--no-verify` | `extract` without checking file data against the archive's digests |
| `--json` | `list` as one JSON object per line |
| `-q`, `--quiet` | no progress or summary output |
| `-h`, `--help` | show usage |
| `-v`, `--version` | show the version |

Exit codes: 0 success, 1 failure (wrong key, corrupt or truncated input), 2 usage error. Set
`SIGNET_AEA_DEBUG=1` to print stack traces.

```sh
signet-aea extract update.aea --key-file update.key -d update -i AssetData/boot
```

## API

```js
import { decryptFile, extractArchive, listEntries, openArchive, readAeaHeader } from "@chrispeoples/aea";

// Decrypt to an .aar file. Throws AeaError (code WRONG_KEY, CORRUPT, TRUNCATED, ...) on failure.
const info = decryptFile("update.aea", "update.aar", key, {
  onProgress: (done, total) => console.log(`${done}/${total}`),
});

// List or extract straight from the .aea (or from an .aar without a key).
for (const e of listEntries(openArchive("update.aea", { key }))) console.log(e.type, e.path, e.size);
const result = extractArchive(openArchive("update.aea", { key }), "out", {
  filter: (path) => path.startsWith("AssetData/"),
  onWarning: console.warn,
});

// Read the unencrypted prologue without a key.
const { profile, authFields } = readAeaHeader("update.aea");
```

Everything is synchronous and streams in bounded memory, so multi-gigabyte inputs are fine.

Exports:

- `decryptFile(in, out, key, opts)`, `decryptFileChunks(path, key, opts)`, `decryptChunks(reader, key, opts)`:
  decrypt to a file or to a generator of verified plaintext chunks. Options: `onInfo`, `onProgress`,
  and `inputSize` for `decryptChunks` (the file functions take it from the file).
- `readAeaHeader(path)`, `parseKey(key)`, `parseAuthData(buf)`, `murmur64(data)`, `PROFILES`, `AeaError`.
- `openArchive(path, { key })`: returns a `Reader` over the archive entry stream, decrypting and
  unwrapping `pbz` compression as needed. `archiveStream(reader)` does the same for any `Reader`,
  and `detectKind(head)` tells `.aea`, `pbz` and `.aar` apart from the first bytes.
- `readEntries(reader)` (low-level `ArchiveEntry` objects with all fields and blobs), `parseHeader`,
  `ENTRY_TYPES`, `listEntries(reader)`, `extractArchive(reader, dest, opts)`. Options: `verify`,
  `filter`, `onEntry`, `onWarning`. `safeComponents(path)` and `PosixCksum` are the path check and
  CKS checksum it uses.
- `ArchiveError`, `UnsupportedCompressionError`, `DecompressError`, `TruncatedError`.
- Decoders: `lzfseDecompress`, `lz4Decompress`, `decompress`, `pbzChunks`, `ALGORITHMS`.
- Streams: `Reader`, `fileChunks`, `bufferChunks`.

## Supported formats

- AEA profile 1 (`hkdf_sha256_aesctr_hmac__symmetric__none`), the profile used for OTA updates.
  Segment checksums: none, murmur64, SHA-256. Padded and unpadded files.
- Apple Archive `AA01` and `YAA1` entries, raw or wrapped in a `pbz?` stream.
- Compression: none, LZFSE (with LZVN blocks), zlib, LZ4.
- OTA metadata entries: `YOP=E` archives are extracted, `YOP=O` modes and times are applied after.

## Security

- Every AEA header and segment MAC is checked before its data is used. A wrong key fails before any
  output is written, and `decryptFile` removes its output if a later block fails to verify.
- Extraction rejects absolute paths, drive letters, UNC paths, `..` components and NUL bytes.
- Nothing is written through a symlink: parent directories are checked with `lstat`, an existing
  symlink at a file's path is replaced rather than followed, and files are created with `O_EXCL`.
- File data is checked against the `SIZ`, `CKS`, `SH1`, `SH2`, `SH3` and `SH5` fields when present.
- setuid, setgid and sticky bits, ownership, BSD flags and extended attributes are not restored.

## Limitations

- Only AEA profile 1. Signed, ECDH and scrypt (password) profiles are rejected with `UNSUPPORTED`.
- LZMA, LZBITMAP and LZRAVEN compression raise `UnsupportedCompressionError`. On macOS, Apple's
  own `aea` and `aa` tools can read those.
- Hard links, devices, fifos and sockets are skipped with a warning. On Windows, symlinks need
  Developer Mode or administrator rights, and modes are not applied.

## License

MIT. `src/lzfse.ts` is ported from Apple's BSD-licensed LZFSE reference decoder; see `NOTICE`.
