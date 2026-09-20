import { getDb } from '../db.js';
import { log } from '../log.js';
import { storeJson, StoreHttpError } from './client.js';

export interface CatalogItem {
  id: number;
  slug: string;
  name: string;
  brand: string;
  category: string;
  sku: string;
  description: string;
}

interface CatalogPage {
  page: number;
  pages: number;
  total: number;
  items: unknown[];
}

const PAGE_SIZE = 60; // the store silently caps pageSize at 60

/** Validate the shape of an item; a store redesign surfaces here, not as garbage rows. */
export function toCatalogItem(x: any): CatalogItem | null {
  if (!x || !Number.isInteger(x.id) || typeof x.name !== 'string' || x.name.trim() === '') return null;
  return {
    id: x.id,
    slug: String(x.slug ?? ''),
    name: x.name.trim(),
    brand: String(x.brand ?? ''),
    category: String(x.category ?? ''),
    sku: String(x.sku ?? ''),
    description: String(x.description ?? ''),
  };
}

/**
 * The store re-shuffles catalogue order on EVERY request, so walking pages
 * 1..N yields duplicates and misses (one full pass returned only ~650 of
 * 1000). We union several passes, then close any remaining gap by fetching the
 * missing ids directly, which is deterministic.
 */
export async function crawlCatalog(onProgress?: (items: CatalogItem[]) => Promise<void>): Promise<CatalogItem[]> {
  const seen = new Map<number, CatalogItem>();
  const absorb = (items: unknown[]) => {
    for (const raw of items) {
      const it = toCatalogItem(raw);
      if (it) seen.set(it.id, it);
    }
  };

  const first = await storeJson<CatalogPage>(`/api/catalog?page=1&pageSize=${PAGE_SIZE}`);
  if (!Array.isArray(first.items) || !Number.isInteger(first.total)) {
    throw new Error('catalogue response shape changed (items/total missing)');
  }
  const { total, pages } = first;
  absorb(first.items);

  const snapshot = () => [...seen.values()];
  await onProgress?.(snapshot()); // search can start working on the first ~60 items immediately

  // Each pass re-shuffles server-side, so coverage climbs ~65% -> 88% -> 96% -> 99%.
  // Passes are sequential and cheap (17 requests); parallel bursts trigger the store's 429s.
  for (let pass = 0; pass < 6 && seen.size < total; pass++) {
    for (let p = pass === 0 ? 2 : 1; p <= pages && seen.size < total; p++) {
      try {
        absorb((await storeJson<CatalogPage>(`/api/catalog?page=${p}&pageSize=${PAGE_SIZE}`)).items);
      } catch (e) {
        log.warn('catalogue page failed, continuing', { page: p, error: (e as Error).message });
      }
    }
    await onProgress?.(snapshot()); // ...and gets more complete after every pass
  }

  // Deterministic gap fill for whatever the shuffled passes missed: ids are 1..total.
  // Gentle on purpose (2 workers): 6 in parallel got HTTP 429 and left ~100 products missing.
  const missing: number[] = [];
  for (let id = 1; id <= total; id++) if (!seen.has(id)) missing.push(id);
  if (missing.length) log.info('filling catalogue gaps by id', { missing: missing.length });
  const workers = Array.from({ length: 2 }, async () => {
    for (let id = missing.pop(); id !== undefined; id = missing.pop()) {
      try {
        absorb([await storeJson(`/api/product/${id}`, { retries: 5 })]);
      } catch (e) {
        if (!(e instanceof StoreHttpError && e.status === 404)) {
          log.warn('could not fetch product', { id, error: (e as Error).message });
        }
      }
    }
  });
  await Promise.all(workers);

  if (seen.size < total) log.warn('catalogue incomplete after crawl', { have: seen.size, total });

  return [...seen.values()].sort((a, b) => a.id - b.id);
}

async function upsertItems(items: CatalogItem[]): Promise<void> {
  const db = await getDb();
  await db.tx(async (q) => {
    for (const it of items) {
      await q.query(
        `insert into catalog_products (id, slug, name, brand, category, sku, description, fetched_at)
         values ($1,$2,$3,$4,$5,$6,$7, now())
         on conflict (id) do update set slug=excluded.slug, name=excluded.name, brand=excluded.brand,
           category=excluded.category, sku=excluded.sku, description=excluded.description, fetched_at=now()`,
        [it.id, it.slug, it.name, it.brand, it.category, it.sku, it.description],
      );
    }
  });
}

let syncing: Promise<number> | null = null;

/** Crawl and upsert the catalogue. Concurrent callers share one crawl. */
export function syncCatalog(): Promise<number> {
  syncing ??= (async () => {
    const started = Date.now();
    const items = await crawlCatalog(upsertItems);
    if (items.length === 0) throw new Error('catalogue crawl returned no items');
    await upsertItems(items);
    log.info('catalogue synced', { items: items.length, ms: Date.now() - started });
    return items.length;
  })().finally(() => {
    syncing = null;
  });
  return syncing;
}

export async function catalogSize(): Promise<number> {
  const db = await getDb();
  const r = await db.query<{ n: number }>('select count(*)::int as n from catalog_products');
  return r.rows[0]?.n ?? 0;
}

/**
 * Make sure a catalogue exists before serving a search (first request after a deploy).
 * The crawl saves progress after every pass, so this returns as soon as ANY items exist
 * instead of waiting a minute for the last few percent.
 */
export async function ensureCatalog(): Promise<void> {
  if ((await catalogSize()) > 0) return;
  const sync = syncCatalog();
  let finished = false;
  let failure: unknown;
  sync.then(
    () => void (finished = true),
    (e) => {
      finished = true;
      failure = e;
    },
  );
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    if ((await catalogSize()) > 0) return;
    if (finished) throw failure ?? new Error('catalogue is empty');
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error('the catalogue is still loading; try again in a few seconds');
}

export interface SearchHit extends CatalogItem {
  tracked_id: number | null;
}

/**
 * Case-insensitive search by partial or full name. Every whitespace-separated
 * token must appear in the name, brand, category or SKU, so "nord monitor"
 * finds "Nordkraft Curved Monitor Studio". Prefix and whole-name matches rank first.
 */
export async function searchCatalog(q: string, limit = 25): Promise<SearchHit[]> {
  const db = await getDb();
  const tokens = q.trim().toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);
  const params: unknown[] = [];
  const where = tokens.map((t) => {
    params.push(`%${t.replace(/[\\%_]/g, '\\$&')}%`);
    const p = `$${params.length}`;
    return `(lower(c.name) like ${p} or lower(c.brand) like ${p} or lower(c.category) like ${p} or lower(c.sku) like ${p})`;
  });
  params.push(q.trim().toLowerCase());
  const qi = params.length;
  params.push(Math.min(Math.max(limit, 1), 100));
  const li = params.length;

  const r = await db.query<SearchHit>(
    `select c.id, c.slug, c.name, c.brand, c.category, c.sku, c.description, t.id as tracked_id
       from catalog_products c
       left join tracked_products t on t.store_product_id = c.id
      ${where.length ? 'where ' + where.join(' and ') : ''}
      order by (lower(c.name) = $${qi}) desc,
               (lower(c.name) like $${qi} || '%') desc,
               c.name asc
      limit $${li}`,
    params,
  );
  return r.rows;
}
