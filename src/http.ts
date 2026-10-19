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
  const msg = last instanceof Error ? (last.cause instanceof Error ? `${last.message}: ${last.cause.message}` : last.message) : String(last);
  throw new Error(`${msg} (after ${tries} attempts)`);
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
