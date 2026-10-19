/** The signet-aea command. The bin entry point is cli.ts. */
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { parseArgs } from "node:util";
import { listEntries, openArchive } from "./aar.js";
import { decryptFile, readAeaHeader } from "./aea.js";
import { extractArchive } from "./extract.js";

// dist/command.js -> ../package.json (and build-test/src/command.js -> ../../package.json in tests).
const VERSION: string = (() => {
  for (const rel of ["../package.json", "../../package.json"]) {
    const u = new URL(rel, import.meta.url);
    if (existsSync(u)) {
      const p = JSON.parse(readFileSync(u, "utf8"));
      if (p.name === "@chrispeoples/aea") return p.version;
    }
  }
  return "unknown";
})();

const USAGE = `signet-aea ${VERSION}: Apple Encrypted Archive (.aea) and Apple Archive (.aar) tool

Usage:
  signet-aea decrypt FILE.aea --key KEY [-o OUT.aar]
  signet-aea extract FILE [--key KEY] [-d DIR] [--include PREFIX]... [--no-verify]
  signet-aea list    FILE [--key KEY] [--json]
  signet-aea info    FILE.aea

FILE for extract and list can be an .aea (with --key), or an .aar, plain or compressed.
KEY is the 32-byte key as base64 (a "base64:" prefix is fine), "hex:..." or 64 hex digits.
Use --key-file FILE to read it from a file instead of the command line.

Options:
  -k, --key KEY        decryption key
      --key-file FILE  read the key from FILE
  -o, --output FILE    decrypt: output file (default: FILE with .aea replaced by .aar)
  -d, --dir DIR        extract: destination directory (default: FILE without its extension)
  -i, --include PREFIX extract: only paths equal to or under PREFIX (repeatable)
      --no-verify      extract: skip checking file data against the archive's digests
      --json           list: one JSON object per line
  -q, --quiet          no progress or summary output
  -h, --help           show this help
  -v, --version        show the version

Every block of an .aea is authenticated, so a wrong key or a damaged download is reported as an
error instead of producing a broken file.`;

const fmtBytes = (n: number) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${(n / 1e3).toFixed(1)} kB` : `${n} B`;

const elapsed = (start: number) => `${((Date.now() - start) / 1000).toFixed(1)}s`;

class UsageError extends Error {}

/** --include filter: paths equal to or under a prefix, plus the directories leading to one. */
function prefixFilter(prefixes: string[]): ((path: string) => boolean) | undefined {
  if (!prefixes.length) return undefined;
  return (path) => prefixes.some((x) => path === x || path.startsWith(x + "/") || x.startsWith(path + "/"));
}

function progress(quiet: boolean, verb: string) {
  const tty = !quiet && process.stderr.isTTY;
  let last = 0;
  return {
    update(done: number, total: number) {
      const now = Date.now();
      if (!tty || now - last < 200) return;
      last = now;
      process.stderr.write(`\r${verb} ${((done / Math.max(total, 1)) * 100).toFixed(1)}%`);
    },
    clear() { if (tty) process.stderr.write("\r\x1b[K"); },
  };
}

function main(argv: string[]): number {
  const { values: a, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      key: { type: "string", short: "k" },
      "key-file": { type: "string" },
      output: { type: "string", short: "o" },
      dir: { type: "string", short: "d" },
      include: { type: "string", short: "i", multiple: true },
      "no-verify": { type: "boolean" },
      json: { type: "boolean" },
      quiet: { type: "boolean", short: "q" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  if (a.version) { console.log(VERSION); return 0; }
  if (a.help) { console.log(USAGE); return 0; }
  const [cmd, input, ...extra] = positionals;
  if (!cmd) { console.error(USAGE); return 2; }
  if (!input) throw new UsageError(`${cmd}: missing FILE`);
  if (extra.length) throw new UsageError(`unexpected argument ${JSON.stringify(extra[0])}`);
  if (a.key && a["key-file"]) throw new UsageError("use --key or --key-file, not both");
  const key = a["key-file"] ? readFileSync(a["key-file"], "utf8").trim() : a.key;
  const quiet = !!a.quiet;
  const log = (s: string) => { if (!quiet) console.error(s); };

  switch (cmd) {
    case "decrypt": {
      if (!key) throw new UsageError("decrypt: --key is required");
      const output = a.output ?? input.replace(/\.aea$/i, "") + ".aar";
      const p = progress(quiet, "Decrypting");
      const start = Date.now();
      const info = decryptFile(input, output, key, { onProgress: p.update });
      p.clear();
      log(`Decrypted ${fmtBytes(info.size)} -> ${output} in ${elapsed(start)} (every block verified)`);
      return 0;
    }
    case "extract": {
      const base = basename(input);
      const dir = a.dir ?? (/\.(aea|aar)$/i.test(base) ? base.slice(0, -4) : `${base}.d`);
      const p = progress(quiet, "Extracting");
      const start = Date.now();
      const res = extractArchive(openArchive(input, { key, onProgress: p.update }), dir, {
        verify: !a["no-verify"],
        filter: prefixFilter((a.include ?? []).map((s) => s.replace(/^\/+|\/+$/g, ""))),
        onWarning: (w) => { p.clear(); log(`warning: ${w}`); },
      });
      p.clear();
      const parts = [`${res.files} files (${fmtBytes(res.bytes)})`, `${res.directories} directories`];
      if (res.symlinks) parts.push(`${res.symlinks} symlinks`);
      if (res.skipped) parts.push(`${res.skipped} skipped`);
      log(`Extracted ${parts.join(", ")} to ${dir} in ${elapsed(start)}`);
      return 0;
    }
    case "list": {
      for (const e of listEntries(openArchive(input, { key }))) {
        if (a.json) console.log(JSON.stringify(e));
        else console.log(`${e.type} ${String(e.size ?? "").padStart(12)}  ${e.path}${e.link !== undefined ? ` -> ${e.link}` : ""}`);
      }
      return 0;
    }
    case "info": {
      const h = readAeaHeader(input);
      console.log(`profile: ${h.profile} (${h.profileName})`);
      if (h.authFields) for (const [k, v] of Object.entries(h.authFields))
        console.log(`${k}: ${v.length > 120 ? v.slice(0, 117) + "..." : v}`);
      else console.log(`auth data: ${h.authData.length} bytes`);
      return 0;
    }
    default:
      throw new UsageError(`unknown command ${JSON.stringify(cmd)}`);
  }
}

/** Runs the CLI and returns the exit code: 0 ok, 1 failure, 2 usage error. Errors are printed, not thrown. */
export function run(argv: string[]): number {
  try {
    return main(argv);
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    const code = (err as NodeJS.ErrnoException).code;
    if (err instanceof UsageError || (typeof code === "string" && code.startsWith("ERR_PARSE_ARGS"))) {
      console.error(`signet-aea: ${err.message}\nRun 'signet-aea --help' for usage.`);
      return 2;
    }
    console.error(`signet-aea: ${err.message}`);
    if (process.env.SIGNET_AEA_DEBUG) console.error(err.stack);
    return 1;
  }
}
