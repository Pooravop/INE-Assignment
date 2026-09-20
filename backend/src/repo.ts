import { getDb } from './db.js';
import { config } from './config.js';
import { storeJson } from './store/client.js';
import { toCatalogItem, type CatalogItem } from './store/catalog.js';

export interface ProductRow {
  id: number;
  storeProductId: number;
  name: string;
  brand: string;
  category: string;
  sku: string;
  description: string;
  intervalMinutes: number;
  active: boolean;
  createdAt: string;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  consecutiveFailures: number;
  lastPrice: number | null;
  lastStock: number | null;
  lowPrice: number | null;
  highPrice: number | null;
  readings: number;
  lastOutcome: 'running' | 'success' | 'retried' | 'failed' | null;
  lastError: string | null;
  nextDueAt: string | null;
  mrp: number | null;
  dealPrice: number | null;
  discountPct: number | null;
  rating: number | null;
  ratingCount: number | null;
  seller: string | null;
  prevPrice: number | null;
}

const PRODUCT_SELECT = `
  select t.id, t.store_product_id as "storeProductId", t.name, t.brand, t.category, t.sku, t.description,
         t.interval_minutes as "intervalMinutes", t.active, t.created_at as "createdAt",
         t.last_attempt_at as "lastAttemptAt", t.last_success_at as "lastSuccessAt",
         t.consecutive_failures as "consecutiveFailures", t.last_price as "lastPrice", t.last_stock as "lastStock",
         agg.low as "lowPrice", agg.high as "highPrice", coalesce(agg.n, 0) as readings,
         lg.outcome as "lastOutcome", lg.message as "lastError",
         case when t.active then coalesce(t.last_attempt_at, t.created_at) + t.interval_minutes * interval '1 minute' end as "nextDueAt",
         ph.mrp, ph.deal_price as "dealPrice", ph.discount_pct as "discountPct", ph.rating,
         ph.rating_count as "ratingCount", ph.seller,
         prev.price as "prevPrice"
    from tracked_products t
    left join lateral (select min(price) as low, max(price) as high, count(*)::int as n
                         from price_history where product_id = t.id) agg on true
    left join lateral (select outcome, message from scrape_log where product_id = t.id
                        order by started_at desc, id desc limit 1) lg on true
    left join lateral (select * from price_history where product_id = t.id
                        order by scraped_at desc, id desc limit 1) ph on true
    left join lateral (select price from price_history where product_id = t.id
                        order by scraped_at desc, id desc offset 1 limit 1) prev on true
`;

export async function listProducts(): Promise<ProductRow[]> {
  const db = await getDb();
  const r = await db.query<ProductRow>(`${PRODUCT_SELECT} order by t.created_at desc, t.id desc`);
  return r.rows;
}

export async function getProduct(id: number): Promise<ProductRow | null> {
  const db = await getDb();
  const r = await db.query<ProductRow>(`${PRODUCT_SELECT} where t.id = $1`, [id]);
  return r.rows[0] ?? null;
}

/** Resolve a store product id to catalogue data: local cache first, then the live store. */
async function resolveCatalogItem(storeProductId: number): Promise<CatalogItem | null> {
  const db = await getDb();
  const cached = await db.query<CatalogItem>(
    'select id, slug, name, brand, category, sku, description from catalog_products where id = $1',
    [storeProductId],
  );
  if (cached.rows[0]) return cached.rows[0];
  try {
    return toCatalogItem(await storeJson(`/api/product/${storeProductId}`, { retries: 2 }));
  } catch {
    return null;
  }
}

export async function trackProduct(
  storeProductId: number,
  intervalMinutes?: number,
): Promise<{ product: ProductRow; created: boolean } | null> {
  const item = await resolveCatalogItem(storeProductId);
  if (!item) return null;
  const db = await getDb();
  const interval = intervalMinutes ?? config.defaultIntervalMinutes;
  const ins = await db.query<{ id: number }>(
    `insert into tracked_products (store_product_id, slug, name, brand, category, sku, description, interval_minutes)
     values ($1,$2,$3,$4,$5,$6,$7,$8)
     on conflict (store_product_id) do update set active = true
     returning id, (xmax = 0) as inserted`,
    [item.id, item.slug, item.name, item.brand, item.category, item.sku, item.description, interval],
  );
  const row = ins.rows[0] as { id: number; inserted?: boolean } | undefined;
  const product = await getProduct(row!.id);
  return { product: product!, created: row?.inserted !== false };
}

export async function updateProduct(
  id: number,
  patch: { intervalMinutes?: number; active?: boolean },
): Promise<ProductRow | null> {
  const db = await getDb();
  const sets: string[] = [];
  const params: unknown[] = [id];
  if (patch.intervalMinutes !== undefined) {
    params.push(patch.intervalMinutes);
    sets.push(`interval_minutes = $${params.length}`);
  }
  if (patch.active !== undefined) {
    params.push(patch.active);
    sets.push(`active = $${params.length}`);
  }
  if (sets.length) await db.query(`update tracked_products set ${sets.join(', ')} where id = $1`, params);
  return getProduct(id);
}

export async function deleteProduct(id: number): Promise<boolean> {
  const db = await getDb();
  const r = await db.query('delete from tracked_products where id = $1', [id]);
  return r.rowCount > 0;
}

export interface HistoryPoint {
  scrapedAt: string;
  price: number;
  stock: number;
  mrp: number | null;
  dealPrice: number | null;
  discountPct: number | null;
  rating: number | null;
}

export async function getHistory(id: number, limit = 1000): Promise<HistoryPoint[]> {
  const db = await getDb();
  const r = await db.query<HistoryPoint>(
    `select * from (
       select scraped_at as "scrapedAt", price, stock, mrp, deal_price as "dealPrice",
              discount_pct as "discountPct", rating, id
         from price_history where product_id = $1 order by scraped_at desc, id desc limit $2
     ) x order by "scrapedAt" asc, id asc`,
    [id, Math.min(Math.max(limit, 1), 5000)],
  );
  return r.rows.map(({ ...p }) => {
    delete (p as any).id;
    return p;
  });
}

export interface LogRow {
  id: number;
  runId: string;
  attempt: number;
  maxAttempts: number;
  trigger: string;
  startedAt: string;
  durationMs: number | null;
  outcome: 'running' | 'success' | 'retried' | 'failed';
  errorCode: string | null;
  message: string | null;
  price: number | null;
  stock: number | null;
}

export async function getLog(id: number, limit = 50, offset = 0): Promise<{ total: number; items: LogRow[] }> {
  const db = await getDb();
  const total = await db.query<{ n: number }>('select count(*)::int as n from scrape_log where product_id = $1', [id]);
  const r = await db.query<LogRow>(
    `select id, run_id as "runId", attempt, max_attempts as "maxAttempts", trigger, started_at as "startedAt",
            duration_ms as "durationMs", outcome, error_code as "errorCode", message, price, stock
       from scrape_log where product_id = $1
      order by started_at desc, id desc limit $2 offset $3`,
    [id, Math.min(Math.max(limit, 1), 200), Math.max(offset, 0)],
  );
  return { total: total.rows[0]?.n ?? 0, items: r.rows };
}

export interface ReliabilityStats {
  attempts: number;
  successes: number;
  retried: number;
  failed: number;
  /** share of scrape RUNS (not attempts) that ended in a stored reading */
  runSuccessRate: number | null;
}

export async function getStats(id: number): Promise<ReliabilityStats> {
  const db = await getDb();
  const r = await db.query<{ attempts: number; successes: number; retried: number; failed: number; runs: number; ok_runs: number }>(
    `select count(*)::int as attempts,
            count(*) filter (where outcome = 'success')::int as successes,
            count(*) filter (where outcome = 'retried')::int as retried,
            count(*) filter (where outcome = 'failed')::int as failed,
            count(distinct run_id) filter (where outcome <> 'running')::int as runs,
            count(distinct run_id) filter (where outcome = 'success')::int as ok_runs
       from scrape_log where product_id = $1`,
    [id],
  );
  const s = r.rows[0]!;
  return {
    attempts: s.attempts,
    successes: s.successes,
    retried: s.retried,
    failed: s.failed,
    runSuccessRate: s.runs > 0 ? s.ok_runs / s.runs : null,
  };
}

export interface AlertRow {
  id: number;
  productId: number | null;
  productName: string | null;
  kind: string;
  message: string;
  oldValue: number | null;
  newValue: number | null;
  createdAt: string;
}

export async function listAlerts(limit = 30): Promise<AlertRow[]> {
  const db = await getDb();
  const r = await db.query<AlertRow>(
    `select a.id, a.product_id as "productId", t.name as "productName", a.kind, a.message,
            a.old_value as "oldValue", a.new_value as "newValue", a.created_at as "createdAt"
       from alerts a left join tracked_products t on t.id = a.product_id
      order by a.created_at desc, a.id desc limit $1`,
    [Math.min(Math.max(limit, 1), 100)],
  );
  return r.rows;
}

export async function lastCatalogSync(): Promise<{ items: number; syncedAt: string | null }> {
  const db = await getDb();
  const r = await db.query<{ n: number; at: string | null }>('select count(*)::int as n, max(fetched_at) as at from catalog_products');
  return { items: r.rows[0]?.n ?? 0, syncedAt: r.rows[0]?.at ?? null };
}
