import { CONFIG } from "./config.js";

export class HttpError extends Error {
  constructor(readonly status: number, url: string) {
    super(`HTTP ${status} for ${url}`);
    this.name = "HttpError";
  }
}

const retryable = (e: unknown) => !(e instanceof HttpError) || e.status === 429 || e.status >= 500;

/**
 * Runs `attempt` up to http.retries times with exponential backoff. Network errors, timeouts, 429
 * and 5xx are retried; any other HttpError fails at once.
 */
export async function withRetries<T>(attempt: () => Promise<T>): Promise<T> {
  const tries = Math.max(1, CONFIG.http.retries);
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    if (i) await new Promise((r) => setTimeout(r, 500 * 2 ** i + Math.random() * 250));
    try {
      return await attempt();
    } catch (e) {
      if (!retryable(e)) throw e;
      last = e;
    }
  }
  throw new Error(`${describeError(last)} (after ${tries} attempts)`);
}

/**
 * fetch() hides the reason in `cause`, sometimes as an AggregateError (one per address tried) with
 * an empty message, so fall back to its code and the addresses.
 */
function describeError(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const c = e.cause as (Error & { code?: string; address?: string; port?: number; errors?: unknown[] }) | undefined;
  if (!(c instanceof Error)) return e.message;
  const one = (x: any) => x?.message || [x?.code, x?.address && `${x.address}${x.port ? `:${x.port}` : ""}`].filter(Boolean).join(" ");
  const parts = c.errors?.length ? c.errors.map(one) : [one(c)];
  return `${e.message}: ${parts.filter(Boolean).join("; ") || c.name}`;
}

/** fetch() with a timeout, retried as in withRetries(). Other non-2xx responses are returned. */
export const fetchRetry = (url: string, init: RequestInit = {}): Promise<Response> => withRetries(async () => {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(CONFIG.http.timeout_ms) });
  if (r.status === 429 || r.status >= 500) throw new HttpError(r.status, url);
  return r;
});

/** fetchRetry() that also rejects any non-2xx response. */
export async function fetchOk(url: string, init?: RequestInit): Promise<Response> {
  const r = await fetchRetry(url, init);
  if (!r.ok) throw new HttpError(r.status, url);
  return r;
}
