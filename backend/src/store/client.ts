import { config } from '../config.js';
import { log } from '../log.js';

export class StoreHttpError extends Error {
  constructor(
    public status: number,
    public path: string,
    /** delay the store asked for via Retry-After, in ms */
    public retryAfterMs?: number,
  ) {
    super(`store responded ${status} for ${path}`);
  }
}

export interface FetchOpts {
  timeoutMs?: number;
  retries?: number;
  baseDelayMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 4xx (except 408/429) is our mistake or a genuinely missing item: retrying will not help. */
function retryable(e: unknown): boolean {
  if (e instanceof StoreHttpError) return e.status >= 500 || e.status === 429 || e.status === 408;
  return true; // network error, timeout, invalid JSON body
}

/** GET JSON from the store with a per-request timeout and jittered exponential backoff. */
export async function storeJson<T = any>(path: string, opts: FetchOpts = {}): Promise<T> {
  const { timeoutMs = 15_000, retries = 4, baseDelayMs = 700 } = opts;
  let lastErr: unknown;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(config.storeBaseUrl + path, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: 'application/json' },
      });
      if (!res.ok) {
        const ra = Number(res.headers.get('retry-after'));
        throw new StoreHttpError(res.status, path, Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 15_000) : undefined);
      }
      return (await res.json()) as T;
    } catch (e) {
      lastErr = e;
      if (!retryable(e) || i === retries) break;
      // The store's 429s are its way of saying "slow down": honour Retry-After when given.
      const asked = e instanceof StoreHttpError ? e.retryAfterMs : undefined;
      const delay = asked ?? baseDelayMs * 2 ** i * (0.75 + Math.random() * 0.5);
      log.warn('store request failed, retrying', {
        path,
        attempt: i + 1,
        delayMs: Math.round(delay),
        error: (e as Error).message,
      });
      await sleep(delay);
    }
  }
  throw lastErr;
}
