import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Numeric-aware string order: "iPhone9,1" < "iPhone10,1", "17.2" < "17.10". */
export const naturalCompare = new Intl.Collator(undefined, { numeric: true }).compare;

/** ProductType family: "iPhone17,1" -> "iPhone". */
export const productClass = (id: string) => /^[A-Za-z]+/.exec(id)?.[0];

/** A whole ProductType ("iPhone17,1"), as opposed to a board ("D47AP") or a bare family. */
export const PRODUCT_TYPE = /^[A-Za-z]+\d+,\d+$/;

/** First `[prefix, value]` in `table` whose prefix starts `id`. */
export const byPrefix = <T>(table: Record<string, T>, id: string) =>
  Object.entries(table).find(([prefix]) => id.startsWith(prefix));

/**
 * Run `fn` over `items` with at most `limit` in flight, showing "label[done/total]" on stderr.
 * Results keep the order of `items`.
 */
export async function pool<T, R>(items: T[], limit: number, label: string, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0, done = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
      process.stderr.write(`\r  ${label}[${++done}/${items.length}]`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, limit) }, worker));
  if (items.length) process.stderr.write("\n");
  return out;
}

/** A JSON cache file's contents; undefined when unset, missing or unreadable (the cache is rebuilt). */
export function readCache<T>(path: string): T | undefined {
  if (!path || !existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** Pretty-printed JSON, written to a temp file and renamed so a crash never leaves half a file. */
export function writeJson(path: string, value: unknown): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  renameSync(tmp, path);
}
