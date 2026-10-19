/** `signet decrypt`: a thin front end over @chrispeoples/aea that keeps signet's own flags and output. */
import { parseArgs } from "node:util";
import { decryptFile } from "@chrispeoples/aea";

const USAGE = `Usage: signet decrypt FILE.aea --key KEY [-o OUTPUT]

Decrypts an Apple OTA package (.aea) on macOS, Linux or Windows. KEY is the base64
decryption key shown on the device page (a "base64:" prefix is fine). OUTPUT defaults to
FILE with .aea replaced by .aar (an Apple Archive). Every block is authenticated, so a wrong key or a damaged
download is reported instead of producing a broken file.`;

export function decryptCli(argv: string[]): number {
  const { values: a, positionals } = parseArgs({
    args: argv, allowPositionals: true,
    options: { key: { type: "string", short: "k" }, output: { type: "string", short: "o" }, help: { type: "boolean", short: "h" } },
  });
  const input = positionals[0];
  if (a.help || !input || !a.key) { console.error(USAGE); return a.help ? 0 : 2; }
  const output = a.output ?? input.replace(/\.aea$/i, "") + ".aar";
  const start = Date.now();
  const tty = process.stderr.isTTY;
  let last = 0;
  const info = decryptFile(input, output, a.key, {
    onProgress: (done, total) => {
      const now = Date.now();
      if (!tty || now - last < 200) return;
      last = now;
      process.stderr.write(`\rDecrypting ${((done / Math.max(total, 1)) * 100).toFixed(1)}%`);
    },
  });
  if (tty) process.stderr.write("\r\x1b[K");
  const secs = (Date.now() - start) / 1000;
  const clusters = Math.ceil(info.size / (info.segmentSize * info.segmentsPerCluster));
  console.error(`Decrypted ${(info.size / 1e6).toFixed(1)} MB -> ${output} in ${secs.toFixed(1)}s (all ${clusters} clusters verified)`);
  return 0;
}
