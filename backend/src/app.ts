import { timingSafeEqual } from 'node:crypto';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import { config } from './config.js';
import { getDb } from './db.js';
import { log } from './log.js';
import {
  deleteProduct,
  getHistory,
  getLog,
  getProduct,
  getStats,
  lastCatalogSync,
  listAlerts,
  listProducts,
  trackProduct,
  updateProduct,
} from './repo.js';
import { isRunning, startBackgroundRun } from './scraper/runner.js';
import { catalogSize, ensureCatalog, searchCatalog, syncCatalog } from './store/catalog.js';

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const intParam = (v: unknown, name: string): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `${name} must be a positive integer`);
  return n;
};

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** cron-job.org sends `Authorization: Bearer <CRON_SECRET>`; `?secret=` is accepted for services that cannot set headers. */
function requireCronSecret(req: Request, _res: Response, next: NextFunction) {
  if (!config.cronSecret) throw new HttpError(503, 'CRON_SECRET is not configured on the server');
  const header = req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? req.header('x-cron-secret') ?? '';
  const supplied = header || (typeof req.query.secret === 'string' ? req.query.secret : '');
  if (!supplied || !safeEqual(supplied, config.cronSecret)) throw new HttpError(401, 'invalid cron secret');
  next();
}

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(
    cors({
      origin: config.corsOrigin === '*' ? true : config.corsOrigin.split(',').map((s) => s.trim()),
    }),
  );
  app.use(express.json({ limit: '50kb' }));

  // Liveness + keep-warm target for a 10-minute uptime ping (see README).
  app.get('/health', async (_req, res) => {
    let db = false;
    try {
      await (await getDb()).query('select 1');
      db = true;
    } catch {
      /* reported below */
    }
    res.status(db ? 200 : 503).json({ ok: db, db, scraping: isRunning(), time: new Date().toISOString() });
  });

  app.get('/api/status', async (_req, res) => {
    res.json({
      scraping: isRunning(),
      schedule: { defaultIntervalMinutes: config.defaultIntervalMinutes, trigger: 'external cron (cron-job.org), every 2 hours' },
      catalog: await lastCatalogSync(),
    });
  });

  // --- Product search (against the locally cached catalogue) ---------------
  app.get('/api/catalog/search', async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 100) : '';
    const limit = req.query.limit ? intParam(req.query.limit, 'limit') : 25;
    try {
      await ensureCatalog();
    } catch (e) {
      throw new HttpError(503, `catalogue is not available yet: ${(e as Error).message}`);
    }
    res.json({ query: q, results: await searchCatalog(q, limit) });
  });

  app.post('/api/catalog/sync', async (_req, res) => {
    const { syncedAt } = await lastCatalogSync();
    if (syncedAt && Date.now() - new Date(syncedAt).getTime() < 10 * 60_000 && (await catalogSize()) > 0) {
      return void res.json({ synced: false, reason: 'synced less than 10 minutes ago', ...(await lastCatalogSync()) });
    }
    await syncCatalog();
    res.json({ synced: true, ...(await lastCatalogSync()) });
  });

  // --- Tracked products -----------------------------------------------------
  app.get('/api/products', async (_req, res) => {
    res.json(await listProducts());
  });

  app.post('/api/products', async (req, res) => {
    const storeProductId = intParam(req.body?.storeProductId, 'storeProductId');
    let intervalMinutes: number | undefined;
    if (req.body?.intervalMinutes !== undefined) {
      intervalMinutes = intParam(req.body.intervalMinutes, 'intervalMinutes');
      if (intervalMinutes < 15 || intervalMinutes > 10080) throw new HttpError(400, 'intervalMinutes must be between 15 and 10080');
    }
    const out = await trackProduct(storeProductId, intervalMinutes);
    if (!out) throw new HttpError(404, `product ${storeProductId} was not found in the store`);
    // Take the first reading now so the dashboard is not empty for two hours.
    if (out.created) startBackgroundRun({ trigger: 'track', productIds: [out.product.id], force: true });
    res.status(out.created ? 201 : 200).json(out);
  });

  app.get('/api/products/:id', async (req, res) => {
    const id = intParam(req.params.id, 'id');
    const product = await getProduct(id);
    if (!product) throw new HttpError(404, 'not tracked');
    res.json({ product, stats: await getStats(id) });
  });

  app.patch('/api/products/:id', async (req, res) => {
    const id = intParam(req.params.id, 'id');
    const patch: { intervalMinutes?: number; active?: boolean } = {};
    if (req.body?.intervalMinutes !== undefined) {
      const n = intParam(req.body.intervalMinutes, 'intervalMinutes');
      if (n < 15 || n > 10080) throw new HttpError(400, 'intervalMinutes must be between 15 and 10080');
      patch.intervalMinutes = n;
    }
    if (req.body?.active !== undefined) {
      if (typeof req.body.active !== 'boolean') throw new HttpError(400, 'active must be a boolean');
      patch.active = req.body.active;
    }
    const product = await updateProduct(id, patch);
    if (!product) throw new HttpError(404, 'not tracked');
    res.json(product);
  });

  app.delete('/api/products/:id', async (req, res) => {
    if (!(await deleteProduct(intParam(req.params.id, 'id')))) throw new HttpError(404, 'not tracked');
    res.status(204).end();
  });

  app.get('/api/products/:id/history', async (req, res) => {
    const id = intParam(req.params.id, 'id');
    if (!(await getProduct(id))) throw new HttpError(404, 'not tracked');
    res.json(await getHistory(id, req.query.limit ? intParam(req.query.limit, 'limit') : 1000));
  });

  app.get('/api/products/:id/log', async (req, res) => {
    const id = intParam(req.params.id, 'id');
    if (!(await getProduct(id))) throw new HttpError(404, 'not tracked');
    const limit = req.query.limit ? intParam(req.query.limit, 'limit') : 50;
    const offset = req.query.offset ? Math.max(0, Number(req.query.offset) || 0) : 0;
    res.json(await getLog(id, limit, offset));
  });

  // Manual "scrape now", with a cooldown so the public button cannot hammer the store.
  app.post('/api/products/:id/scrape', async (req, res) => {
    const id = intParam(req.params.id, 'id');
    const product = await getProduct(id);
    if (!product) throw new HttpError(404, 'not tracked');
    if (product.lastAttemptAt && Date.now() - new Date(product.lastAttemptAt).getTime() < 60_000) {
      throw new HttpError(429, 'scraped less than a minute ago; try again shortly');
    }
    const r = startBackgroundRun({ trigger: 'manual', productIds: [id], force: true });
    res.status(202).json({ accepted: true, ...r });
  });

  // --- Alerts -----------------------------------------------------------------
  app.get('/api/alerts', async (req, res) => {
    res.json(await listAlerts(req.query.limit ? intParam(req.query.limit, 'limit') : 30));
  });

  // --- Scheduled trigger (cron-job.org, every 2 hours) -----------------------
  app.all('/api/cron/scrape', requireCronSecret, (req, res) => {
    if (req.method !== 'GET' && req.method !== 'POST') throw new HttpError(405, 'use GET or POST');
    // Reply immediately: the scrape takes minutes, cron services time out after ~30 s.
    const r = startBackgroundRun({ trigger: 'cron' });
    log.info('cron trigger received', r);
    res.status(202).json({ accepted: true, ...r, at: new Date().toISOString() });
  });

  app.use((_req, _res, next) => next(new HttpError(404, 'not found')));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) return void res.status(err.status).json({ error: err.message });
    if (err instanceof SyntaxError && 'body' in err) return void res.status(400).json({ error: 'invalid JSON body' });
    log.error('unhandled error', { message: (err as Error)?.message });
    res.status(500).json({ error: 'internal error' });
  });

  return app;
}
