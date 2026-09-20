/**
 * Command-line scrape runner. This is the "headed run" required by the brief:
 *
 *   npm run scrape:headed -- --product 1            watch one product being scraped
 * (Do not use --slow-mo for demos: Playwright delays every mouse-move step too, which distorts
 *  the pointer timing the store measures and makes attempts time out. Natural speed is watchable.)
 *
 *   npm run scrape:headed -- --product 1 --chaos    ...and watch it recover from a slow + failing store
 *   npm run scrape -- --all                          headless run over every due product
 *
 * With no DATABASE_URL it uses an embedded Postgres kept in backend/.pglite.
 */
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    headed: { type: 'boolean', default: false },
    'slow-mo': { type: 'string' },
    product: { type: 'string' }, // the store's product id; tracked automatically if new
    all: { type: 'boolean', default: false },
    force: { type: 'boolean', default: false },
    chaos: { type: 'boolean', default: false },
    attempts: { type: 'string' },
  },
});

if (!process.env.DATABASE_URL && process.env.USE_PGLITE === undefined) {
  process.env.USE_PGLITE = '1';
  process.env.PGLITE_DIR ??= '.pglite';
}
if (values.attempts) process.env.SCRAPE_MAX_ATTEMPTS = values.attempts;

const { getDb, migrate } = await import('./db.js');
const { trackProduct, getProduct, getLog } = await import('./repo.js');
const { runScrapes, reconcileInterrupted } = await import('./scraper/runner.js');

const db = await getDb();
await migrate(db);
await reconcileInterrupted(db, true);

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

let productIds: number[] | undefined;
if (values.product) {
  const out = await trackProduct(Number(values.product));
  if (!out) {
    console.error(`Product ${values.product} was not found in the store.`);
    process.exit(2);
  }
  console.log(`${bold('Tracking')} #${out.product.storeProductId} ${out.product.name} ${dim(`(${out.created ? 'new' : 'already tracked'})`)}`);
  productIds = [out.product.id];
} else if (!values.all) {
  console.error('Pass --product <storeProductId> or --all');
  process.exit(2);
}

const started = Date.now();
const summary = await runScrapes({
  trigger: 'manual',
  productIds,
  force: values.force || Boolean(values.product),
  headed: values.headed,
  slowMo: values['slow-mo'] ? Number(values['slow-mo']) : undefined,
  chaos: values.chaos ? { failFirstAttempts: 2, slowMs: 6000 } : null,
  onStep: (name, msg) => console.log(`${dim(`+${((Date.now() - started) / 1000).toFixed(1).padStart(5)}s`)} ${dim(name.slice(0, 26).padEnd(26))} ${msg}`),
});

console.log('\n' + bold('Run summary'));
console.log(`  due=${summary.due} succeeded=${summary.succeeded} failed=${summary.failed}${summary.skipped ? ` (skipped: ${summary.skipped})` : ''}`);

for (const o of summary.outcomes) {
  const p = await getProduct(o.productId);
  const log = await getLog(o.productId, 10);
  console.log(`\n${bold(o.name)}  →  ${o.outcome === 'success' ? `₹${o.price}, stock ${o.stock}` : `FAILED (${o.errorCode})`}`);
  console.log(dim('  scrape log (newest first):'));
  for (const r of log.items) {
    console.log(`   ${new Date(r.startedAt).toISOString()}  attempt ${r.attempt}/${r.maxAttempts}  ${r.outcome.padEnd(7)} ${r.errorCode ?? ''} ${r.message ?? ''}`);
  }
  if (p) console.log(dim(`  history rows: ${p.readings}`));
}

await db.close();
process.exit(summary.failed > 0 && summary.succeeded === 0 ? 1 : 0);
