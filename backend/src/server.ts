import { createApp } from './app.js';
import { config } from './config.js';
import { getDb, migrate } from './db.js';
import { log } from './log.js';
import { reconcileInterrupted } from './scraper/runner.js';
import { catalogSize, syncCatalog } from './store/catalog.js';

const db = await getDb();
await migrate(db);
// Any attempt still 'running' belongs to a previous process that died mid-scrape.
await reconcileInterrupted(db, true);

const app = createApp();
const server = app.listen(config.port, () => log.info(`API listening on :${config.port}`));

// Warm the search catalogue in the background so the first search is instant.
void catalogSize()
  .then((n) => (n === 0 ? syncCatalog() : undefined))
  .catch((e) => log.warn('initial catalogue sync failed; it will retry on first search', { message: (e as Error).message }));

const shutdown = (signal: string) => {
  log.info(`${signal} received, shutting down`);
  server.close(() => void db.close().finally(() => process.exit(0)));
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
