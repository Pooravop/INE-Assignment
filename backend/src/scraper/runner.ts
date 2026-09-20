import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { getDb, type Db } from '../db.js';
import { log } from '../log.js';
import { BrowserProvider } from './browser.js';
import { scrapeOnce } from './scrapeOnce.js';
import { validateQuote } from './interpret.js';
import { ScrapeError, type Chaos, type Quote, type TrackedProduct } from './types.js';

/** One attempt at one product. The real one drives Playwright; tests inject a fake. */
export type AttemptFn = (product: TrackedProduct, attempt: number, step: (m: string) => void) => Promise<Quote>;

export interface RunnerDeps {
  attempt: AttemptFn;
  sleep: (ms: number) => Promise<void>;
  maxAttempts: number;
  /** delay before retry n is roughly backoffBaseMs * 2.2^(n-1), with jitter, capped at 30 s */
  backoffBaseMs: number;
  /** release browser resources when the run ends */
  dispose?: () => Promise<void>;
}

export type Trigger = 'cron' | 'manual' | 'track';

export interface RunOptions {
  trigger: Trigger;
  /** limit the run to these tracked-product ids */
  productIds?: number[];
  /** scrape even if the product is not due yet */
  force?: boolean;
  chaos?: Chaos | null;
  headed?: boolean;
  slowMo?: number;
  /** progress narration (used by the CLI / headed demo) */
  onStep?: (productName: string, message: string) => void;
}

export interface ProductOutcome {
  productId: number;
  name: string;
  outcome: 'success' | 'failed';
  attempts: number;
  errorCode?: string;
  price?: number;
  stock?: number;
}

export interface RunSummary {
  runId: string;
  skipped?: 'lock-held';
  due: number;
  succeeded: number;
  failed: number;
  outcomes: ProductOutcome[];
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function defaultDeps(opts: RunOptions): RunnerDeps {
  const provider = new BrowserProvider({ headed: opts.headed ?? config.headed, slowMo: opts.slowMo });
  return {
    sleep: defaultSleep,
    maxAttempts: config.maxAttempts,
    backoffBaseMs: 2000,
    dispose: () => provider.close(),
    async attempt(product, attempt, step) {
      let browser;
      try {
        browser = await provider.get();
      } catch (e) {
        // A missing browser will not appear by retrying, and Playwright's message is a multi-line banner.
        const full = e instanceof Error ? e.message : String(e);
        const missing = /Executable doesn't exist/i.test(full);
        const first = full.split(/\r?\n/)[0] ?? 'browser failed to launch';
        throw new ScrapeError(
          'BROWSER_ERROR',
          missing ? `${first} - run "npx playwright install chromium" or set BROWSER_CHANNEL=chrome` : first,
          !missing,
        );
      }
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      let timedOut = false;
      // Watchdog: a hung page can never stall a run. Closing the context aborts every pending wait.
      const timer = setTimeout(() => {
        timedOut = true;
        void ctx.close().catch(() => undefined);
      }, config.attemptTimeoutMs);
      try {
        return await scrapeOnce(ctx, {
          storeProductId: product.store_product_id,
          expectedSku: product.sku || undefined,
          attempt,
          chaos: opts.chaos,
          step,
        });
      } catch (e) {
        if (timedOut) throw new ScrapeError('TIMEOUT', `attempt exceeded ${config.attemptTimeoutMs / 1000}s and was aborted`);
        throw e;
      } finally {
        clearTimeout(timer);
        await ctx.close().catch(() => undefined);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Lock: overlapping cron triggers must never double-scrape or fight over Chromium.
// ---------------------------------------------------------------------------

const LOCK_NAME = 'scrape';
const LOCK_MINUTES = 30;

async function acquireLock(db: Db, holder: string): Promise<boolean> {
  const r = await db.query(
    `insert into scrape_lock (name, holder, locked_until)
     values ($1, $2, now() + $3 * interval '1 minute')
     on conflict (name) do update set holder = excluded.holder, locked_until = excluded.locked_until
       where scrape_lock.locked_until < now()
     returning holder`,
    [LOCK_NAME, holder, LOCK_MINUTES],
  );
  return r.rows.length > 0;
}

async function renewLock(db: Db, holder: string) {
  await db.query(`update scrape_lock set locked_until = now() + $2 * interval '1 minute' where name = $1 and holder = $3`, [
    LOCK_NAME,
    LOCK_MINUTES,
    holder,
  ]);
}

async function releaseLock(db: Db, holder: string) {
  await db.query('delete from scrape_lock where name = $1 and holder = $2', [LOCK_NAME, holder]);
}

/**
 * An attempt is written as 'running' before it starts. If the process dies
 * (deploy, OOM, crash) that row never gets an outcome. Turn such orphans into
 * honest failures so the log has no silent gaps.
 */
export async function reconcileInterrupted(db: Db, onBoot = false): Promise<number> {
  const r = await db.query(
    `update scrape_log
        set outcome = 'failed', error_code = 'INTERRUPTED',
            message = 'the process stopped before this attempt finished',
            duration_ms = (extract(epoch from (now() - started_at)) * 1000)::int
      where outcome = 'running' and ($1::boolean or started_at < now() - $2 * interval '1 minute')`,
    [onBoot, config.staleAttemptMinutes],
  );
  if (r.rowCount) log.warn('marked interrupted attempts as failed', { count: r.rowCount });
  return r.rowCount;
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

async function selectDue(db: Db, opts: RunOptions): Promise<TrackedProduct[]> {
  const params: unknown[] = [];
  const where: string[] = ['active'];
  if (!opts.force) {
    params.push(config.dueGraceMinutes);
    where.push(
      `(last_attempt_at is null or last_attempt_at <= now() - (interval_minutes - $${params.length}) * interval '1 minute')`,
    );
  }
  if (opts.productIds?.length) {
    params.push(opts.productIds);
    where.push(`id = any($${params.length}::bigint[])`);
  }
  const r = await db.query<TrackedProduct>(
    `select id, store_product_id, name, sku, interval_minutes, last_price, last_stock
       from tracked_products where ${where.join(' and ')}
      order by last_attempt_at asc nulls first, id asc`,
    params,
  );
  return r.rows;
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export async function runScrapes(opts: RunOptions, deps: RunnerDeps = defaultDeps(opts)): Promise<RunSummary> {
  const db = await getDb();
  const runId = randomUUID();
  const summary: RunSummary = { runId, due: 0, succeeded: 0, failed: 0, outcomes: [] };

  await reconcileInterrupted(db);
  if (!(await acquireLock(db, runId))) {
    log.warn('another scrape run holds the lock; skipping', { trigger: opts.trigger });
    return { ...summary, skipped: 'lock-held' };
  }

  try {
    const products = await selectDue(db, opts);
    summary.due = products.length;
    log.info('scrape run started', { runId, trigger: opts.trigger, due: products.length });

    const queue = [...products];
    const worker = async () => {
      for (let p = queue.shift(); p; p = queue.shift()) {
        await renewLock(db, runId);
        const out = await scrapeProduct(db, p, runId, opts, deps);
        summary.outcomes.push(out);
        if (out.outcome === 'success') summary.succeeded++;
        else summary.failed++;
      }
    };
    await Promise.all(Array.from({ length: Math.min(config.concurrency, products.length || 1) }, worker));
    log.info('scrape run finished', { runId, succeeded: summary.succeeded, failed: summary.failed });
  } finally {
    await releaseLock(db, runId).catch((e) => log.error('failed to release lock', { message: (e as Error).message }));
    await deps.dispose?.().catch(() => undefined);
  }
  return summary;
}

/** Reject with a TIMEOUT ScrapeError if `p` takes longer than `ms`; the timer never outlives the call. */
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ScrapeError('TIMEOUT', `attempt watchdog fired after ${Math.round(ms / 1000)}s`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

const isImplausibleJump = (prev: number, next: number) => next > prev * 3 || next < prev / 3;

function backoffMs(base: number, attempt: number): number {
  return Math.min(30_000, base * 2.2 ** (attempt - 1)) * (0.75 + Math.random() * 0.5);
}

function asScrapeError(e: unknown): ScrapeError {
  if (e instanceof ScrapeError) return e;
  return new ScrapeError('STORE_ERROR', e instanceof Error ? e.message : String(e));
}

async function scrapeProduct(
  db: Db,
  product: TrackedProduct,
  runId: string,
  opts: RunOptions,
  deps: RunnerDeps,
): Promise<ProductOutcome> {
  const max = deps.maxAttempts;
  const step = (m: string) => opts.onStep?.(product.name, m);

  // Measured from the START of the run so "every 2 hours" does not drift by scrape duration.
  await db.query('update tracked_products set last_attempt_at = now() where id = $1', [product.id]);

  let suspectPrice: number | null = null;
  let last: ScrapeError | null = null;

  for (let attempt = 1; attempt <= max; attempt++) {
    const started = Date.now();
    const ins = await db.query<{ id: number }>(
      `insert into scrape_log (run_id, product_id, attempt, max_attempts, trigger, outcome)
       values ($1, $2, $3, $4, $5, 'running') returning id`,
      [runId, product.id, attempt, max, opts.trigger],
    );
    const logId = ins.rows[0]!.id;
    log.info('attempt', { product: product.name, attempt, of: max });

    try {
      // Safety net in case an attempt ignores its own timeout.
      const quote = await withTimeout(deps.attempt(product, attempt, step), config.attemptTimeoutMs + 10_000);
      validateQuote(quote); // nothing reaches the database without passing this

      // A price that leaps far from the last good one is confirmed by a second read before it is trusted.
      if (product.last_price !== null && isImplausibleJump(product.last_price, quote.price)) {
        const confirmed = suspectPrice !== null && Math.abs(quote.price - suspectPrice) / suspectPrice <= 0.02;
        if (!confirmed) {
          suspectPrice = quote.price;
          throw new ScrapeError(
            'SUSPICIOUS_JUMP',
            `₹${quote.price} is far from the last good reading ₹${product.last_price}; needs a confirming read`,
          );
        }
      }

      await persistSuccess(db, product, runId, logId, started, quote);
      step(`saved ₹${quote.price}, stock ${quote.stock}`);
      return { productId: product.id, name: product.name, outcome: 'success', attempts: attempt, price: quote.price, stock: quote.stock };
    } catch (e) {
      const err = asScrapeError(e);
      last = err;
      const final = attempt === max || !err.retryable;
      await db.query(
        `update scrape_log set outcome = $2, error_code = $3, message = $4, duration_ms = $5 where id = $1`,
        [logId, final ? 'failed' : 'retried', err.code, err.message.slice(0, 500), Date.now() - started],
      );
      log.warn('attempt failed', { product: product.name, attempt, code: err.code, message: err.message, final });
      step(`attempt ${attempt} ${final ? 'FAILED' : 'failed → will retry'}: [${err.code}] ${err.message}`);
      if (final) break;
      const wait = backoffMs(deps.backoffBaseMs, attempt);
      step(`backing off ${(wait / 1000).toFixed(1)}s before attempt ${attempt + 1}`);
      await deps.sleep(wait);
    }
  }

  await persistFailure(db, product, last!);
  return { productId: product.id, name: product.name, outcome: 'failed', attempts: max, errorCode: last?.code };
}

async function persistSuccess(
  db: Db,
  product: TrackedProduct,
  runId: string,
  logId: number,
  started: number,
  q: Quote,
): Promise<void> {
  await db.tx(async (tx) => {
    await tx.query(
      `insert into price_history (product_id, price, mrp, deal_price, discount_pct, stock, rating, rating_count, seller, run_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [product.id, q.price, q.mrp, q.dealPrice, q.discountPct, q.stock, q.rating, q.ratingCount, q.seller, runId],
    );
    await tx.query(
      `update tracked_products
          set last_price = $2, last_stock = $3, last_success_at = now(), consecutive_failures = 0
        where id = $1`,
      [product.id, q.price, q.stock],
    );
    await tx.query(
      `update scrape_log set outcome = 'success', price = $2, stock = $3, duration_ms = $4, error_code = null, message = null
        where id = $1`,
      [logId, q.price, q.stock, Date.now() - started],
    );

    const prev = product.last_price;
    if (prev !== null && q.price < prev && (prev - q.price) / prev >= 0.01) {
      const pct = (((prev - q.price) / prev) * 100).toFixed(1);
      await tx.query(
        `insert into alerts (product_id, kind, message, old_value, new_value) values ($1,'price_drop',$2,$3,$4)`,
        [product.id, `${product.name}: price dropped from ₹${prev} to ₹${q.price} (−${pct}%)`, prev, q.price],
      );
    }
    if (product.last_stock === 0 && q.stock > 0) {
      await tx.query(
        `insert into alerts (product_id, kind, message, old_value, new_value) values ($1,'back_in_stock',$2,0,$3)`,
        [product.id, `${product.name} is back in stock (${q.stock} available)`, q.stock],
      );
    } else if ((product.last_stock ?? 0) > 0 && q.stock === 0) {
      await tx.query(
        `insert into alerts (product_id, kind, message, old_value, new_value) values ($1,'out_of_stock',$2,$3,0)`,
        [product.id, `${product.name} just went out of stock`, product.last_stock],
      );
    }
  });
}

async function persistFailure(db: Db, product: TrackedProduct, err: ScrapeError): Promise<void> {
  await db.query('update tracked_products set consecutive_failures = consecutive_failures + 1 where id = $1', [product.id]);
  if (err.code === 'STRUCTURE_CHANGED') {
    // One alert per product per 6 hours is enough to flag "the store's page changed".
    await db.query(
      `insert into alerts (product_id, kind, message)
       select $1, 'structure_change', $2
        where not exists (select 1 from alerts where product_id = $1 and kind = 'structure_change'
                             and created_at > now() - interval '6 hours')`,
      [product.id, `The store's page structure appears to have changed for ${product.name}: ${err.message}`],
    );
  }
}

// ---------------------------------------------------------------------------
// In-process scheduling helper used by the HTTP layer
// ---------------------------------------------------------------------------

let running: Promise<RunSummary> | null = null;
const queued = new Set<number>();

export function isRunning(): boolean {
  return running !== null;
}

/**
 * Start a run without blocking the caller (cron-job.org gives up after ~30 s).
 * If a run is already active, product-specific requests are queued and run right after it.
 */
export function startBackgroundRun(opts: RunOptions): { started: boolean; queued: boolean } {
  if (running) {
    if (opts.productIds?.length) {
      opts.productIds.forEach((id) => queued.add(id));
      return { started: false, queued: true };
    }
    return { started: false, queued: false };
  }
  const go = (o: RunOptions): void => {
    running = runScrapes(o)
      .catch((e) => {
        log.error('scrape run crashed', { message: (e as Error).message });
        return undefined as unknown as RunSummary;
      })
      .finally(() => {
        running = null;
        if (queued.size) {
          const ids = [...queued];
          queued.clear();
          go({ trigger: 'manual', productIds: ids, force: true });
        }
      });
  };
  go(opts);
  return { started: true, queued: false };
}
