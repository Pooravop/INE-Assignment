import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { createTestDb, setDb, type Db } from '../src/db.js';
import { reconcileInterrupted, runScrapes, type AttemptFn, type RunnerDeps } from '../src/scraper/runner.js';
import { ScrapeError, type Quote } from '../src/scraper/types.js';

let db: Db;

const quote = (price: number, stock = 10): Quote => ({
  price,
  mrp: price + 500,
  dealPrice: null,
  discountPct: null,
  stock,
  rating: 4.2,
  ratingCount: 100,
  seller: 'Test Seller',
});

/** Script a sequence of attempt results: a Quote resolves, an Error rejects. */
function scripted(results: Array<Quote | Error>): { deps: RunnerDeps; calls: () => number } {
  let n = 0;
  const attempt: AttemptFn = async () => {
    const r = results[Math.min(n++, results.length - 1)]!;
    if (r instanceof Error) throw r;
    return r;
  };
  return {
    calls: () => n,
    deps: { attempt, sleep: async () => undefined, maxAttempts: 4, backoffBaseMs: 1 },
  };
}

async function addProduct(over: Record<string, unknown> = {}): Promise<number> {
  const r = await db.query<{ id: number }>(
    `insert into tracked_products (store_product_id, name, sku, interval_minutes, last_price, last_stock, last_attempt_at)
     values ($1, 'Test Product', 'TST-1', $2, $3, $4, $5) returning id`,
    [over.storeId ?? 1, over.interval ?? 120, over.lastPrice ?? null, over.lastStock ?? null, over.lastAttemptAt ?? null],
  );
  return r.rows[0]!.id;
}

const rows = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows as any[];

beforeAll(async () => {
  db = await createTestDb();
  setDb(db);
});
afterAll(async () => {
  setDb(undefined);
  await db.close();
});
beforeEach(async () => {
  await db.exec('truncate scrape_log, price_history, alerts, scrape_lock, tracked_products restart identity cascade');
});

describe('a healthy run', () => {
  it('stores one price row and one success log row', async () => {
    const id = await addProduct();
    const { deps } = scripted([quote(999, 7)]);
    const s = await runScrapes({ trigger: 'cron' }, deps);
    expect(s).toMatchObject({ due: 1, succeeded: 1, failed: 0 });

    expect(await rows('select price, stock from price_history where product_id = $1', [id])).toEqual([{ price: 999, stock: 7 }]);
    const log = await rows('select attempt, outcome, price from scrape_log');
    expect(log).toEqual([{ attempt: 1, outcome: 'success', price: 999 }]);
    const p = (await rows('select last_price, last_stock, consecutive_failures from tracked_products'))[0];
    expect(p).toEqual({ last_price: 999, last_stock: 7, consecutive_failures: 0 });
  });
});

describe('retries and honest logging', () => {
  it('logs failed attempts as "retried", then the success, and stores exactly one reading', async () => {
    await addProduct();
    const { deps, calls } = scripted([
      new ScrapeError('STORE_ERROR', 'HTTP 503'),
      new ScrapeError('TIMEOUT', 'slow'),
      quote(1200),
    ]);
    const s = await runScrapes({ trigger: 'cron' }, deps);
    expect(s.succeeded).toBe(1);
    expect(calls()).toBe(3);

    const log = await rows('select attempt, outcome, error_code from scrape_log order by attempt');
    expect(log).toEqual([
      { attempt: 1, outcome: 'retried', error_code: 'STORE_ERROR' },
      { attempt: 2, outcome: 'retried', error_code: 'TIMEOUT' },
      { attempt: 3, outcome: 'success', error_code: null },
    ]);
    expect((await rows('select count(*)::int as n from price_history'))[0].n).toBe(1);
  });

  it('records a total failure honestly and stores NOTHING in price history', async () => {
    const id = await addProduct({ lastPrice: 500, lastStock: 3 });
    const { deps, calls } = scripted([new ScrapeError('STORE_ERROR', 'HTTP 500')]);
    const s = await runScrapes({ trigger: 'cron' }, deps);
    expect(s).toMatchObject({ succeeded: 0, failed: 1 });
    expect(calls()).toBe(4);

    expect((await rows('select outcome from scrape_log order by attempt')).map((r) => r.outcome)).toEqual([
      'retried',
      'retried',
      'retried',
      'failed',
    ]);
    expect((await rows('select count(*)::int as n from price_history'))[0].n).toBe(0);
    // the previous good reading is untouched, the failure streak is counted
    expect((await rows('select last_price, last_stock, consecutive_failures from tracked_products where id = $1', [id]))[0]).toEqual({
      last_price: 500,
      last_stock: 3,
      consecutive_failures: 1,
    });
  });

  it('does not retry a non-retryable failure', async () => {
    await addProduct();
    const { deps, calls } = scripted([new ScrapeError('PRODUCT_NOT_FOUND', '404', false)]);
    await runScrapes({ trigger: 'cron' }, deps);
    expect(calls()).toBe(1);
    expect((await rows('select outcome, error_code from scrape_log'))).toEqual([{ outcome: 'failed', error_code: 'PRODUCT_NOT_FOUND' }]);
  });

  it('an unexpected exception is logged as a failure, not swallowed', async () => {
    await addProduct();
    const { deps } = scripted([new Error('boom')]);
    await runScrapes({ trigger: 'cron' }, deps);
    const log = await rows('select outcome, message from scrape_log order by attempt desc limit 1');
    expect(log[0]).toEqual({ outcome: 'failed', message: 'boom' });
  });
});

describe('never storing wrong data', () => {
  it.each([
    ['zero price', quote(0)],
    ['negative price', quote(-10)],
    ['NaN price', quote(NaN)],
    ['fractional stock', quote(100, 1.5)],
  ])('rejects %s even if the scraper returns it', async (_n, bad) => {
    await addProduct();
    const { deps } = scripted([bad]);
    const s = await runScrapes({ trigger: 'cron' }, deps);
    expect(s.failed).toBe(1);
    expect((await rows('select count(*)::int as n from price_history'))[0].n).toBe(0);
  });

  it('confirms an implausible price jump with a second read before trusting it', async () => {
    const id = await addProduct({ lastPrice: 1000 });
    const { deps } = scripted([quote(9000), quote(9000)]);
    await runScrapes({ trigger: 'cron' }, deps);
    const log = await rows('select outcome, error_code from scrape_log order by attempt');
    expect(log).toEqual([
      { outcome: 'retried', error_code: 'SUSPICIOUS_JUMP' },
      { outcome: 'success', error_code: null },
    ]);
    expect((await rows('select price from price_history where product_id = $1', [id]))[0].price).toBe(9000);
  });

  it('discards a one-off glitch: a jump that does not repeat is never stored', async () => {
    const id = await addProduct({ lastPrice: 1000 });
    const { deps } = scripted([quote(9000), quote(1010)]);
    await runScrapes({ trigger: 'cron' }, deps);
    expect((await rows('select price from price_history where product_id = $1', [id])).map((r) => r.price)).toEqual([1010]);
  });
});

describe('scheduling', () => {
  it('skips products that are not due yet', async () => {
    const recent = new Date(Date.now() - 30 * 60_000).toISOString();
    await addProduct({ lastAttemptAt: recent });
    const { deps, calls } = scripted([quote(1)]);
    const s = await runScrapes({ trigger: 'cron' }, deps);
    expect(s.due).toBe(0);
    expect(calls()).toBe(0);
  });

  it('treats a product as due slightly early, so a trigger a few minutes soon is not skipped for 2 more hours', async () => {
    const nearlyDue = new Date(Date.now() - (120 - config.dueGraceMinutes + 1) * 60_000).toISOString();
    await addProduct({ lastAttemptAt: nearlyDue });
    const { deps } = scripted([quote(5)]);
    expect((await runScrapes({ trigger: 'cron' }, deps)).due).toBe(1);
  });

  it('honours a per-product interval', async () => {
    const t = new Date(Date.now() - 100 * 60_000).toISOString();
    await addProduct({ storeId: 1, interval: 60, lastAttemptAt: t }); // due (60 min interval)
    await addProduct({ storeId: 2, interval: 360, lastAttemptAt: t }); // not due (6 h interval)
    const { deps } = scripted([quote(5)]);
    expect((await runScrapes({ trigger: 'cron' }, deps)).due).toBe(1);
  });

  it('force overrides the schedule; inactive products are never scraped', async () => {
    const t = new Date().toISOString();
    await addProduct({ storeId: 1, lastAttemptAt: t });
    const off = await addProduct({ storeId: 2 });
    await db.query('update tracked_products set active = false where id = $1', [off]);
    const { deps } = scripted([quote(5)]);
    const s = await runScrapes({ trigger: 'manual', force: true }, deps);
    expect(s.due).toBe(1);
  });
});

describe('overlap and crash safety', () => {
  it('a second trigger while a run holds the lock is skipped, not double-scraped', async () => {
    await addProduct();
    await db.query(`insert into scrape_lock (name, holder, locked_until) values ('scrape', 'other', now() + interval '10 minutes')`);
    const { deps, calls } = scripted([quote(1)]);
    const s = await runScrapes({ trigger: 'cron' }, deps);
    expect(s.skipped).toBe('lock-held');
    expect(calls()).toBe(0);
  });

  it('an expired lock (crashed holder) is taken over', async () => {
    await addProduct();
    await db.query(`insert into scrape_lock (name, holder, locked_until) values ('scrape', 'dead', now() - interval '1 minute')`);
    const { deps } = scripted([quote(1)]);
    expect((await runScrapes({ trigger: 'cron' }, deps)).succeeded).toBe(1);
  });

  it('releases the lock after a run, even when every attempt fails', async () => {
    await addProduct();
    const { deps } = scripted([new ScrapeError('STORE_ERROR', 'x')]);
    await runScrapes({ trigger: 'cron' }, deps);
    expect((await rows('select count(*)::int as n from scrape_lock'))[0].n).toBe(0);
  });

  it('turns attempts orphaned by a crash into honest INTERRUPTED failures', async () => {
    const id = await addProduct();
    await db.query(
      `insert into scrape_log (run_id, product_id, attempt, max_attempts, outcome, started_at)
       values (gen_random_uuid(), $1, 1, 4, 'running', now() - interval '20 minutes')`,
      [id],
    );
    expect(await reconcileInterrupted(db)).toBe(1);
    expect((await rows('select outcome, error_code from scrape_log'))[0]).toEqual({ outcome: 'failed', error_code: 'INTERRUPTED' });
  });

  it('does not touch a recent running attempt unless the process just booted', async () => {
    const id = await addProduct();
    await db.query(
      `insert into scrape_log (run_id, product_id, attempt, max_attempts, outcome) values (gen_random_uuid(), $1, 1, 4, 'running')`,
      [id],
    );
    expect(await reconcileInterrupted(db, false)).toBe(0);
    expect(await reconcileInterrupted(db, true)).toBe(1);
  });
});

describe('alerts', () => {
  it('raises a price-drop alert only for a real drop', async () => {
    await addProduct({ lastPrice: 1000 });
    await runScrapes({ trigger: 'cron' }, scripted([quote(800)]).deps);
    expect((await rows('select kind, old_value, new_value from alerts'))).toEqual([{ kind: 'price_drop', old_value: 1000, new_value: 800 }]);
  });

  it('raises back-in-stock and out-of-stock alerts', async () => {
    await addProduct({ lastPrice: 100, lastStock: 0 });
    await runScrapes({ trigger: 'manual', force: true }, scripted([quote(100, 4)]).deps);
    await runScrapes({ trigger: 'manual', force: true }, scripted([quote(100, 0)]).deps);
    expect((await rows('select kind from alerts order by id')).map((r) => r.kind)).toEqual(['back_in_stock', 'out_of_stock']);
  });

  it('flags a structure change once, not on every retry', async () => {
    await addProduct();
    await runScrapes({ trigger: 'cron' }, scripted([new ScrapeError('STRUCTURE_CHANGED', 'no price block')]).deps);
    await runScrapes({ trigger: 'manual', force: true }, scripted([new ScrapeError('STRUCTURE_CHANGED', 'no price block')]).deps);
    expect((await rows("select count(*)::int as n from alerts where kind = 'structure_change'"))[0].n).toBe(1);
  });
});

describe('watchdog', () => {
  it('records a hung attempt as a TIMEOUT failure instead of stalling the run', async () => {
    await addProduct();
    const prev = config.attemptTimeoutMs;
    config.attemptTimeoutMs = 50; // watchdog fires at 50ms + 10s in production; shrink for the test
    try {
      const hang: AttemptFn = () => new Promise(() => undefined);
      const deps: RunnerDeps = { attempt: hang, sleep: async () => undefined, maxAttempts: 1, backoffBaseMs: 1 };
      const started = Date.now();
      // withTimeout adds a 10 s grace; cap the wait so the test stays fast.
      const run = runScrapes({ trigger: 'cron' }, deps);
      await Promise.race([run, new Promise((r) => setTimeout(r, 12_000))]);
      expect(Date.now() - started).toBeLessThan(12_500);
      expect((await rows('select outcome, error_code from scrape_log'))[0]).toEqual({ outcome: 'failed', error_code: 'TIMEOUT' });
    } finally {
      config.attemptTimeoutMs = prev;
    }
  }, 20_000);
});
