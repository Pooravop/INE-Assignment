import { normalizeText, parseCount, parsePrice, parseSeller, parseStock } from './parse.js';
import { ScrapeError, type Quote } from './types.js';

/** What the in-page script reports for each element inside the price area. */
export interface RawEl {
  i: number;
  /** index of the parent element within `els`, or -1 when the parent is the price container */
  parent: number;
  text: string;
  fontPx: number;
  strike: boolean;
  opacity: number;
  visible: boolean;
}

export interface RawFacet {
  text: string;
  cls: string;
  aria: string;
  title: string;
  /** width of the star-fill bar as a percentage, when this facet has one */
  barPct: number | null;
}

export interface RawDom {
  ok: boolean;
  reason?: string;
  els: RawEl[];
  facets: RawFacet[];
  /** true when the store labels the price "Updating…" (provisional) */
  pending: boolean;
  /** index into `els` of the element carrying the layout API's priceValue class; -1 none, -2 lookup failed */
  markerPrice: number;
}

const fail = (code: ConstructorParameters<typeof ScrapeError>[0], msg: string, retryable = true): never => {
  throw new ScrapeError(code, msg, retryable);
};

/**
 * Turn a raw DOM dump into a validated Quote, or throw a ScrapeError explaining
 * exactly why not. Two independent methods must agree on the price:
 *
 *   1. structural: the single visible, non-struck-through element with the
 *      largest font (the store renders the price big; MRP is struck through;
 *      decoy prices are display:none);
 *   2. marker: the element carrying the class named by the store's own
 *      /api/layout response (when the page received one).
 *
 * Disagreement is an error, never a coin flip.
 */
export function interpretDom(raw: RawDom): Quote {
  if (!raw.ok) return fail('STRUCTURE_CHANGED', raw.reason ?? 'price block not found');
  if (raw.pending) return fail('PRICE_PENDING', 'store is still showing "Updating…" (provisional price)');

  const byIndex = new Map(raw.els.map((e) => [e.i, e]));
  const isDescendantOf = (e: RawEl, ancestor: RawEl): boolean => {
    for (let p = e.parent; p >= 0; p = byIndex.get(p)?.parent ?? -1) if (p === ancestor.i) return true;
    return false;
  };

  // Normalise BEFORE testing for digits: the store sometimes renders fullwidth digits (１２３),
  // which /\d/ does not match; testing raw text silently dropped the real price element.
  const visible = raw.els.filter((e) => e.visible && /\d/.test(normalizeText(e.text)));
  const plain = visible.filter((e) => !e.strike);
  const maxFont = Math.max(0, ...plain.map((e) => e.fontPx));
  const biggest = plain.filter((e) => e.fontPx === maxFont && maxFont > 0);
  // Split-digit layouts wrap every character in its own span: keep only the outermost element.
  const top = biggest.filter((e) => !biggest.some((o) => o !== e && isDescendantOf(e, o)));
  if (top.length !== 1) {
    return fail('STRUCTURE_CHANGED', `expected one primary price element, found ${top.length}`);
  }
  const priceEl = top[0]!;

  const price = parsePrice(priceEl.text);
  if (price === null) return fail('INVALID_DATA', `unparseable price text: ${JSON.stringify(normalizeText(priceEl.text))}`);

  if (raw.markerPrice >= 0) {
    const marked = byIndex.get(raw.markerPrice);
    const markedPrice = marked ? parsePrice(marked.text) : null;
    if (markedPrice !== price) {
      return fail('PRICE_CONFLICT', `structural price ${price} disagrees with layout-marked price ${markedPrice}`);
    }
  }

  const mrpEl = raw.els.find((e) => e.visible && e.strike && parsePrice(e.text) !== null);
  const mrp = mrpEl ? parsePrice(mrpEl.text) : null;

  const dealEl = raw.els.find((e) => e.visible && /^deal price/i.test(normalizeText(e.text)));
  const dealPrice = dealEl ? parsePrice(normalizeText(dealEl.text).replace(/^deal price/i, '')) : null;

  // The "N% off" badge is NOT read: measured across repeated reads of the same product it changes
  // between 35% and 54% while price and MRP stay identical. Discount is derived from price and MRP.
  const discountPct = mrp !== null && mrp > 0 ? Math.max(0, Math.round((1 - price / mrp) * 100)) : null;

  // Stock: exactly one facet must read as a stock statement.
  const stocks = raw.facets.map((f) => parseStock(f.text)).filter((n): n is number => n !== null);
  if (stocks.length === 0) return fail('STRUCTURE_CHANGED', 'no stock statement found in facets');
  if (stocks.length > 1) return fail('INVALID_DATA', `ambiguous stock: ${stocks.join(', ')}`);
  const stock = stocks[0]!;

  const ratingFacet = raw.facets.find((f) => /rated\s+[\d.]+\s+out of 5/i.test(f.aria) || f.barPct !== null);
  let rating: number | null = null;
  if (ratingFacet) {
    const m = ratingFacet.aria.match(/rated\s+([\d.]+)\s+out of 5/i);
    rating = m?.[1] ? Number(m[1]) : ratingFacet.barPct !== null ? Math.round((ratingFacet.barPct / 100) * 5 * 100) / 100 : null;
    if (rating !== null && (!Number.isFinite(rating) || rating < 0 || rating > 5)) rating = null;
  }
  const countMatch = ratingFacet ? normalizeText(ratingFacet.text).match(/([\d.,]+\s*k?)\s*ratings?/i) : null;
  const ratingCount = countMatch?.[1] ? parseCount(countMatch[1]) : null;

  const sellerFacet = raw.facets.find((f) => /^sold by/i.test(normalizeText(f.text)));
  const seller = sellerFacet ? parseSeller(sellerFacet.text) : null;

  const quote: Quote = { price, mrp, dealPrice, discountPct, stock, rating, ratingCount, seller };
  validateQuote(quote);
  return quote;
}

/** Last line of defence before anything is stored. */
export function validateQuote(q: Quote): void {
  if (!Number.isFinite(q.price) || q.price <= 0 || q.price > 10_000_000) {
    fail('INVALID_DATA', `price out of range: ${q.price}`);
  }
  if (!Number.isInteger(q.stock) || q.stock < 0 || q.stock > 1_000_000) {
    fail('INVALID_DATA', `stock out of range: ${q.stock}`);
  }
  if (q.mrp !== null && q.price > q.mrp * 1.001) {
    fail('INVALID_DATA', `price ${q.price} is above MRP ${q.mrp}`);
  }
}
