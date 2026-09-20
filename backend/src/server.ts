import { createApp } from './app.js';
import { config } from './config.js';
import { getDb, migrate } from './db.js';
import { log } from './log.js';
import { reconcileInterrupted } from './scraper/runner.js';
import { catalogSize, syncCatalog } from './store/catalog.js';

log.info('starting', {
  node: process.version,
  port: config.port,
  database: config.usePglite ? 'pglite' : config.databaseUrl ? 'postgres' : 'NOT CONFIGURED',
  headed: config.headed,
  display: process.env.DISPLAY ?? null,
});

// Bind the port FIRST. Hosting platforms (Render) kill a service that has not opened its port
// within minutes, and a slow or failing database must show up in the logs and on /health,
// not as a silent, portless process.
const app = createApp();
const server = app.listen(config.port, () => log.info(`API listening on :${config.port}`));

/** Connect, apply the schema, and clean up after a previous crash. Retries so a slow DB never leaves the API dead. */
async function initDatabase(): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      const db = await getDb();
      await migrate(db);
      // Any attempt still 'running' belongs to a previous process that died mid-scrape.
      await reconcileInterrupted(db, true);
      log.info('database ready');
      return;
    } catch (e) {
      log.error('database startup failed; retrying in 10 s', { attempt, message: (e as Error).message });
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }
}

void initDatabase().then(() =>
  // Warm the search catalogue in the background so the first search is fast.
  catalogSize()
    .then((n) => (n === 0 ? syncCatalog() : undefined))
    .catch((e) => log.warn('initial catalogue sync failed; it will retry on first search', { message: (e as Error).message })),
);

const shutdown = (signal: string) => {
  log.info(`${signal} received, shutting down`);
  server.close(() => void getDb().then((db) => db.close()).catch(() => undefined).finally(() => process.exit(0)));
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// A stray rejection must never kill the API silently.
process.on('unhandledRejection', (reason) => log.error('unhandled rejection', { reason: String(reason) }));
