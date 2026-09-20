import type { BrowserContext, Page } from 'playwright';
import { config } from '../config.js';
import { interpretDom, type RawDom } from './interpret.js';
import { humanClick, wanderOver } from './mouse.js';
import { ScrapeError, type Chaos, type Quote, type StepLogger } from './types.js';

/**
 * Runs inside the page. Kept as a string (not a function) so a TypeScript
 * transpiler can never inject helper calls that do not exist in the browser.
 * It only REPORTS facts (visibility, computed font size, strike-through,
 * marker-class hits); every decision is made in Node by interpretDom().
 */
const EXTRACT_DOM = `(markerPriceClass) => {
  const block = document.querySelector('.price-block.price-success');
  if (!block) return { ok: false, reason: 'no .price-success block', els: [], facets: [], pending: false, markerPrice: -1 };
  const main = block.querySelector('.price-main');
  if (!main) return { ok: false, reason: 'no .price-main', els: [], facets: [], pending: false, markerPrice: -1 };

  const visible = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
    if (el.closest('[aria-hidden="true"]')) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  const nodes = Array.from(main.querySelectorAll('*'));
  const els = nodes.map((el, i) => {
    const cs = getComputedStyle(el);
    return {
      i,
      parent: nodes.indexOf(el.parentElement),
      text: el.textContent || '',
      fontPx: parseFloat(cs.fontSize) || 0,
      strike: (cs.textDecorationLine || '').indexOf('line-through') >= 0,
      opacity: Number(cs.opacity),
      visible: visible(el),
    };
  });

  let markerPrice = -1;
  if (markerPriceClass) {
    try {
      const m = main.querySelector('.' + CSS.escape(markerPriceClass));
      markerPrice = m ? nodes.indexOf(m) : -1;
    } catch (e) { markerPrice = -2; }
  }

  const facetsEl = block.querySelector('.price-facets');
  const facets = facetsEl ? Array.from(facetsEl.children).map((el) => {
    const inner = el.querySelector('span > span');
    const w = inner && inner.style ? inner.style.width : '';
    return {
      text: el.textContent || '',
      cls: String(el.className || ''),
      aria: el.getAttribute('aria-label') || '',
      title: el.getAttribute('title') || '',
      barPct: w && w.endsWith('%') ? parseFloat(w) : null,
    };
  }) : [];

  return { ok: true, els, facets, pending: /updating/i.test(block.textContent || ''), markerPrice };
}`;

export interface ScrapeOnceOptions {
  storeProductId: number;
  expectedSku?: string;
  /** 1-based attempt number, only used to decide when chaos applies. */
  attempt: number;
  chaos?: Chaos | null;
  step?: StepLogger;
  /** Diagnostics: receives the raw DOM facts and the layout the page used. */
  onRaw?: (raw: RawDom, layout: unknown) => void;
}

/**
 * One attempt to read the current price and stock of one product.
 * Throws a ScrapeError (with a stable code) on any failure; never returns partial data.
 */
export async function scrapeOnce(ctx: BrowserContext, opts: ScrapeOnceOptions): Promise<Quote> {
  const step = opts.step ?? (() => undefined);
  const page = await ctx.newPage();
  page.setDefaultTimeout(15_000);
  try {
    return await drive(page, opts, step);
  } catch (e) {
    throw classify(e);
  } finally {
    await page.close().catch(() => undefined);
  }
}

/** Playwright errors -> our stable ScrapeError codes. */
function classify(e: unknown): ScrapeError {
  if (e instanceof ScrapeError) return e;
  const msg = e instanceof Error ? e.message : String(e);
  if (/Target (page, context or browser )?has been closed|browser has been closed|Browser closed|disconnected/i.test(msg)) {
    return new ScrapeError('BROWSER_ERROR', msg.split('\n')[0] ?? msg);
  }
  if (/Timeout \d+ms exceeded|timed out/i.test(msg)) return new ScrapeError('TIMEOUT', msg.split('\n')[0] ?? msg);
  if (/net::ERR_/.test(msg)) return new ScrapeError('STORE_ERROR', msg.split('\n')[0] ?? msg);
  return new ScrapeError('STORE_ERROR', msg.split('\n')[0] ?? msg);
}

async function drive(page: Page, opts: ScrapeOnceOptions, step: StepLogger): Promise<Quote> {
  const { storeProductId, attempt, chaos } = opts;
  const url = `${config.storeBaseUrl}/product/${storeProductId}`;

  // The store publishes which CSS classes mark each element for this layout revision.
  // We read the SAME response the page received, so the marker always matches what is rendered.
  let markerPriceClass = '';
  let layoutJson: unknown = null;
  // Remember the store's own error responses so the scrape log says WHY, not just "failed".
  const apiErrors: string[] = [];
  page.on('response', async (res) => {
    const u = res.url();
    if (u.startsWith(config.storeBaseUrl + '/api/') && res.status() >= 400) {
      const body = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 160);
      apiErrors.push(`${res.request().method()} ${u.replace(config.storeBaseUrl, '')} → HTTP ${res.status()} ${body}`.trim());
    }
    if (!u.endsWith('/api/layout')) return;
    try {
      const j = await res.json();
      layoutJson = j;
      if (typeof j?.classes?.priceValue === 'string') markerPriceClass = j.classes.priceValue;
    } catch {
      /* page fell back to the default layout */
    }
  });

  if (chaos && attempt <= chaos.failFirstAttempts) {
    await page.route('**/api/**', async (route) => {
      const u = route.request().url();
      if (chaos.slowMs > 0) await new Promise((r) => setTimeout(r, chaos.slowMs));
      if (u.includes('/api/product/')) {
        step(`[chaos] injecting HTTP 503 into ${u.replace(config.storeBaseUrl, '')}`);
        return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"chaos"}' });
      }
      return route.continue();
    });
    step(`[chaos] attempt ${attempt}: store API will be slow (${chaos.slowMs}ms) and product lookup will 503`);
  }

  // The store sometimes throws a cookie dialog over the page at a random moment; it blocks
  // clicks and needs up to three "Accept" presses. Playwright runs this whenever it appears.
  await page.addLocatorHandler(
    page.locator('.cookie-overlay'),
    async (overlay) => {
      step('cookie dialog appeared → accepting');
      for (let i = 0; i < 4 && (await overlay.isVisible().catch(() => false)); i++) {
        await overlay.getByRole('button', { name: 'Accept cookies' }).click({ timeout: 3000 }).catch(() => undefined);
        await page.waitForTimeout(150);
      }
    },
    { times: 12 },
  );

  step(`opening ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });

  // Either the product renders, or the store shows its own error box.
  await page.locator('.detail-info h1, .grid-error').first().waitFor({ timeout: 30_000 });
  const errBox = page.locator('.grid-error');
  if (await errBox.count()) {
    const text = ((await errBox.first().textContent()) ?? '').trim();
    if (/\b404\b/.test(text)) throw new ScrapeError('PRODUCT_NOT_FOUND', text, false);
    throw new ScrapeError('STORE_ERROR', text || 'product page failed to load');
  }
  step('product page loaded');

  if (opts.expectedSku) {
    const brandLine = (await page.locator('.detail-brand').first().textContent().catch(() => '')) ?? '';
    if (!brandLine.includes(opts.expectedSku)) {
      throw new ScrapeError('INVALID_DATA', `page shows "${brandLine.trim()}" but expected SKU ${opts.expectedSku}`);
    }
  }

  await revealPrice(page, step);
  return await readQuote(page, () => markerPriceClass, () => apiErrors, step, (raw) => opts.onRaw?.(raw, layoutJson));
}

const STATE = '.price-success, .price-error, .price-block[aria-busy="true"]';

/** Click "Reveal price" until the store actually starts loading. ~35% of clicks are swallowed. */
async function revealPrice(page: Page, step: StepLogger) {
  const reveal = page.getByRole('button', { name: 'Reveal price' });
  const MAX_CLICKS = 7;

  for (let n = 1; n <= MAX_CLICKS; n++) {
    if (!(await reveal.count())) break; // already loading or loaded

    await wanderOver(page, page.locator('.price-block').first());
    // The button stays disabled until the store has seen enough mouse movement.
    const enabled = await reveal.isEnabled().catch(() => false);
    if (!enabled) {
      step('reveal button still disabled → moving the mouse more');
      continue;
    }
    step(`clicking "Reveal price" (click ${n})`);
    await humanClick(page, reveal);

    // Did anything happen? A swallowed click leaves the idle block untouched.
    const started = await page
      .locator(STATE)
      .first()
      .waitFor({ timeout: 2500 })
      .then(() => true)
      .catch(() => false);
    if (started) {
      step('click registered');
      return;
    }
    step('click was ignored by the page → retrying');
  }
  if (await page.locator(STATE).count()) return;
  throw new ScrapeError('CLICK_IGNORED', 'the Reveal price button never started a lookup');
}

/** Wait for the store to finish (or give up) and read the result, refreshing provisional prices. */
async function readQuote(
  page: Page,
  markerClass: () => string,
  apiErrors: () => string[],
  step: StepLogger,
  onRaw?: (raw: RawDom) => void,
): Promise<Quote> {
  const MAX_READS = 4;
  for (let read = 1; read <= MAX_READS; read++) {
    step('waiting for the store to answer…');
    await page.locator('.price-success, .price-error').first().waitFor({ timeout: 45_000 });

    const errBox = page.locator('.price-error');
    if (await errBox.count()) {
      const text = ((await errBox.first().textContent()) ?? '').replace(/\s+/g, ' ').trim();
      const why = apiErrors().slice(-2).join('; ');
      throw new ScrapeError('PRICE_ENDPOINT_ERROR', `${text || 'store price lookup failed'}${why ? ` [${why}]` : ''}`);
    }

    // A string passed to evaluate() is evaluated as an expression, not called, so build the call.
    const raw = (await page.evaluate(`(${EXTRACT_DOM})(${JSON.stringify(markerClass())})`)) as RawDom;
    onRaw?.(raw);
    try {
      const quote = interpretDom(raw);
      step(`read price ₹${quote.price}, stock ${quote.stock}`);
      return quote;
    } catch (e) {
      if (e instanceof ScrapeError && e.code === 'PRICE_PENDING' && read < MAX_READS) {
        step('store shows a provisional "Updating…" price → pressing Refresh');
        const refresh = page.getByRole('button', { name: 'Refresh price' });
        await humanClick(page, refresh); // same natural motion as the first click; a teleporting click gets rejected
        await page.waitForTimeout(1200);
        continue;
      }
      throw e;
    }
  }
  throw new ScrapeError('PRICE_PENDING', 'price stayed provisional after several refreshes');
}
