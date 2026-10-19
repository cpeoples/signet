// Runs the compiled tests with an explicit file list. `node --test <glob>` behaves differently
// across Node versions and shells (Windows cmd doesn't expand globs), so list the files ourselves.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const dir = join("build-test", "test");
const files = readdirSync(dir).filter((f) => f.endsWith(".test.js")).sort().map((f) => join(dir, f));
if (!files.length) {
  console.error(`run-tests: no compiled tests in ${dir}`);
  process.exit(1);
}
const r = spawnSync(process.execPath, ["--test", "--test-reporter=spec", ...process.argv.slice(2), ...files], { stdio: "inherit" });
process.exit(r.status ?? 1);
