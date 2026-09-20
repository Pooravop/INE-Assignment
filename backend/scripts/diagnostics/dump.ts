import { BrowserProvider } from '../../src/scraper/browser.js';
import { scrapeOnce } from '../../src/scraper/scrapeOnce.js';
const id = Number(process.argv[2]);
const bp = new BrowserProvider({ headed: false });
try {
  const ctx = await (await bp.get()).newContext({ viewport: { width: 1280, height: 900 } });
  await scrapeOnce(ctx, { storeProductId: id, attempt: 1, onRaw: (raw, layout) => {
    console.log('LAYOUT', JSON.stringify(layout));
    console.log('pending', raw.pending, 'markerPrice', raw.markerPrice);
    for (const e of raw.els) console.log(`  el#${e.i} parent=${e.parent} vis=${e.visible} font=${e.fontPx} strike=${e.strike} op=${e.opacity} text=${JSON.stringify(e.text.slice(0, 60))}`);
    for (const f of raw.facets) console.log('  facet', JSON.stringify({ ...f, text: f.text.slice(0, 50) }));
  }}).then((q) => console.log('QUOTE', JSON.stringify(q))).catch((e) => console.log('ERR', e.code, e.message));
} finally { await bp.close(); }
