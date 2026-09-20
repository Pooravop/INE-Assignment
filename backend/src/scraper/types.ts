export type ErrorCode =
  | 'PRODUCT_NOT_FOUND' // store says the product does not exist (not retryable)
  | 'STORE_ERROR' // product page failed to load (5xx, network)
  | 'PRICE_ENDPOINT_ERROR' // the store's own price lookup failed after its internal retries
  | 'TIMEOUT' // a wait or the whole attempt exceeded its budget
  | 'CLICK_IGNORED' // "Reveal price" click was swallowed too many times
  | 'PRICE_PENDING' // store still showed "Updating…" (provisional price)
  | 'PRICE_CONFLICT' // two independent extraction methods disagreed
  | 'SUSPICIOUS_JUMP' // price moved implausibly far from the last good reading
  | 'INVALID_DATA' // extracted values failed validation
  | 'STRUCTURE_CHANGED' // expected elements were not found: the page layout shifted
  | 'BROWSER_ERROR' // browser crashed / disconnected
  | 'INTERRUPTED'; // process died before the attempt finished

export class ScrapeError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public retryable = true,
  ) {
    super(message);
    this.name = 'ScrapeError';
  }
}

/** A fully validated reading. Only ever built from data that passed every check. */
export interface Quote {
  price: number;
  mrp: number | null;
  dealPrice: number | null;
  discountPct: number | null;
  stock: number;
  rating: number | null;
  ratingCount: number | null;
  seller: string | null;
}

export interface TrackedProduct {
  id: number;
  store_product_id: number;
  name: string;
  sku: string;
  interval_minutes: number;
  last_price: number | null;
  last_stock: number | null;
}

/** Deliberate faults injected into OUR browser's traffic to demo recovery (headed demo / tests). */
export interface Chaos {
  /** Fail the store's product lookup with HTTP 503 during attempts 1..N. */
  failFirstAttempts: number;
  /** Delay every store API call by this many ms during the failing attempts. */
  slowMs: number;
}

export type StepLogger = (message: string) => void;
