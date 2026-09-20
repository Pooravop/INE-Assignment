import { BrowserProvider } from '../../src/scraper/browser.js';
import { scrapeOnce } from '../../src/scraper/scrapeOnce.js';

const ids = (process.argv[2] ?? '1,2,3').split(',').map(Number);
const bp = new BrowserProvider({ headed: process.argv.includes('--headed') });
const tally: Record<string, number> = {};
for (const id of ids) {
  const t0 = Date.now();
  const steps: string[] = [];
  let out = '';
  try {
    const browser = await bp.get();
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    try {
      const q = await scrapeOnce(ctx, { storeProductId: id, attempt: 1, step: (m) => steps.push(m) });
      out = `OK  price=${q.price} mrp=${q.mrp} deal=${q.dealPrice} disc=${q.discountPct} stock=${q.stock} rating=${q.rating}/${q.ratingCount} seller=${q.seller}`;
      tally.OK = (tally.OK ?? 0) + 1;
    } finally { await ctx.close(); }
  } catch (e: any) {
    out = `ERR ${e.code ?? '?'} ${String(e.message).slice(0, 140)}`;
    tally[e.code ?? 'ERR'] = (tally[e.code ?? 'ERR'] ?? 0) + 1;
  }
  const notable = steps.filter((s) => /ignored|cookie|provisional|disabled/.test(s)).length;
  console.log(`#${id} ${((Date.now() - t0) / 1000).toFixed(1)}s notable-events=${notable} ${out}`);
}
console.log('TALLY', JSON.stringify(tally));
await bp.close();
