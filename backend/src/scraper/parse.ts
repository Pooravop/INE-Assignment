/**
 * Pure text -> number parsing for values scraped from the store.
 *
 * The store renders one price in many disguises (Indian digit grouping, spaces,
 * European separators, "/- (incl. of all taxes)" suffixes, fullwidth Unicode
 * digits, non-breaking and zero-width characters, "Rs." prefixes). Everything
 * here returns `null` rather than guessing when the input is not clearly a
 * value, so a caller can never store a wrong number by accident.
 */

const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF]/g;

/** NFKC folds fullwidth digits to ASCII and NBSP to a space; then we strip zero-width chars. */
export function normalizeText(s: string): string {
  return s.normalize('NFKC').replace(ZERO_WIDTH, '').replace(/\s+/g, ' ').trim();
}

/** Parse a displayed price such as "₹1,23,456", "Rs. 1,234.00" or "₹1.234,00". */
export function parsePrice(raw: string): number | null {
  let t = normalizeText(raw).replace(/\s+/g, '');
  t = t.replace(/\/-.*$/, ''); // "₹1,234/- (incl. of all taxes)"
  t = t.replace(/^(?:₹|rs\.?|inr)/i, '').replace(/(?:₹|rs\.?|inr)$/i, '');
  if (!/^\d[\d.,]*$/.test(t)) return null;

  const commas = (t.match(/,/g) ?? []).length;
  const dots = (t.match(/\./g) ?? []).length;
  const lastComma = t.lastIndexOf(',');
  const lastDot = t.lastIndexOf('.');

  let intPart = t;
  let frac = '';

  if (commas > 0 && dots > 0) {
    // Both present: whichever comes last is the decimal mark, the other groups thousands.
    const decAt = Math.max(lastComma, lastDot);
    intPart = t.slice(0, decAt);
    frac = t.slice(decAt + 1);
  } else if (commas === 1 && /^\d{1,2}$/.test(t.slice(lastComma + 1))) {
    intPart = t.slice(0, lastComma); // "999,00" (European decimal comma)
    frac = t.slice(lastComma + 1);
  } else if (dots === 1 && /^\d{1,2}$/.test(t.slice(lastDot + 1))) {
    intPart = t.slice(0, lastDot); // "12.50"
    frac = t.slice(lastDot + 1);
  }

  intPart = intPart.replace(/[.,]/g, '');
  if (!/^\d+$/.test(intPart) || (frac !== '' && !/^\d+$/.test(frac))) return null;

  const n = Number(frac ? `${intPart}.${frac}` : intPart);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** "In stock · 12 left", "Only 3 left", "7 in stock", "Out of stock" -> units, or null if unrecognised. */
export function parseStock(raw: string): number | null {
  const t = normalizeText(raw).toLowerCase();
  if (/out of stock|sold out|unavailable/.test(t)) return 0;
  if (!/(in stock|left)/.test(t)) return null;
  const m = t.match(/(\d[\d,]*)/);
  if (!m || !m[1]) return null;
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** "12% off" -> 12 */
export function parseDiscountPct(raw: string): number | null {
  const m = normalizeText(raw).match(/(\d{1,3})\s*%/);
  if (!m || !m[1]) return null;
  const n = Number(m[1]);
  return n >= 0 && n <= 100 ? n : null;
}

/** "1.2k ratings" -> 1200, "842 ratings" -> 842 */
export function parseCount(raw: string): number | null {
  const m = normalizeText(raw).toLowerCase().match(/(\d+(?:\.\d+)?)\s*(k)?/);
  if (!m || !m[1]) return null;
  const n = Math.round(Number(m[1]) * (m[2] ? 1000 : 1));
  return Number.isFinite(n) ? n : null;
}

/** "Sold by Zenith Retail" (with zero-width characters mid-word) -> "Zenith Retail" */
export function parseSeller(raw: string): string | null {
  const t = normalizeText(raw).replace(/^sold by\s*/i, '').trim();
  return t.length > 0 && t.length <= 120 ? t : null;
}
