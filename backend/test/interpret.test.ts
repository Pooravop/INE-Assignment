import { describe, expect, it } from 'vitest';
import { interpretDom, validateQuote, type RawDom, type RawEl, type RawFacet } from '../src/scraper/interpret.js';
import { ScrapeError } from '../src/scraper/types.js';

const el = (i: number, text: string, o: Partial<RawEl> = {}): RawEl => ({
  i,
  parent: -1,
  text,
  fontPx: 16,
  strike: false,
  opacity: 1,
  visible: true,
  ...o,
});

const facets = (stockText = 'In stock · 12 left'): RawFacet[] => [
  { text: ' 2.5k ratings', cls: 'rt', aria: 'Rated 4.5 out of 5', title: '', barPct: 90 },
  { text: 'Sold by Zen​ith Retail', cls: 'sr', aria: '', title: 'Zenith Retail', barPct: null },
  { text: 'Get it by Tue, 22 Sept', cls: 'dl', aria: '', title: '', barPct: null },
  { text: stockText, cls: 'st', aria: '', title: '', barPct: null },
];

/** The shape the real page produced for product 512: two hidden decoys around the real price. */
const page = (over: Partial<RawDom> = {}): RawDom => ({
  ok: true,
  pending: false,
  markerPrice: 2,
  facets: facets(),
  els: [
    el(0, '₹46,301', { visible: false, fontPx: 38.4 }), // decoy .price-value (display:none)
    el(1, '₹53,509', { strike: true, opacity: 0.55 }), // MRP
    el(2, '₹49,228', { fontPx: 38.4 }), // the real price
    el(3, '8% off'),
    el(4, '₹52,828', { visible: false }), // decoy .amount[data-price]
  ],
  ...over,
});

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof ScrapeError ? e.code : `non-ScrapeError: ${e}`;
  }
  return 'no error';
};

describe('interpretDom', () => {
  it('reads the real price, ignoring hidden decoys, MRP and badge', () => {
    const q = interpretDom(page());
    expect(q).toMatchObject({ price: 49228, mrp: 53509, stock: 12, rating: 4.5, ratingCount: 2500, seller: 'Zenith Retail' });
  });

  it('derives discount from price and MRP, never from the unreliable badge', () => {
    expect(interpretDom(page()).discountPct).toBe(8);
  });

  it('handles fullwidth-digit prices (the bug that once picked "2% off" as the price)', () => {
    const raw = page({
      els: [
        el(0, '₹46,301', { visible: false, fontPx: 38.4 }),
        el(1, '₹53,509', { strike: true }),
        el(2, '₹４９，２２８', { fontPx: 38.4 }),
        el(3, '2% off'),
      ],
    });
    expect(interpretDom(raw).price).toBe(49228);
  });

  it('handles the split-digit layout (one span per character) without treating digits as prices', () => {
    const chars = [...'₹49,228'];
    const raw = page({
      markerPrice: 2,
      els: [
        el(0, '₹46,301', { visible: false, fontPx: 38.4 }),
        el(1, '₹53,509', { strike: true }),
        el(2, chars.join('​'), { fontPx: 38.4 }),
        ...chars.map((c, k) => el(3 + k, c, { parent: 2, fontPx: 38.4 })),
      ],
    });
    expect(interpretDom(raw).price).toBe(49228);
  });

  it('reads the "Deal price" variant as an extra, not as the price', () => {
    const raw = page({
      els: [
        el(0, '₹46,301', { visible: false, fontPx: 38.4 }),
        el(1, '₹53,509', { strike: true }),
        el(2, 'Deal price ₹44,000'),
        el(3, '₹49,228', { fontPx: 38.4 }),
        el(4, '8% off'),
      ],
      markerPrice: 3,
    });
    const q = interpretDom(raw);
    expect(q.price).toBe(49228);
    expect(q.dealPrice).toBe(44000);
  });

  it('reads Out of stock as zero', () => {
    expect(interpretDom(page({ facets: facets('Out of stock') })).stock).toBe(0);
  });

  it('refuses a provisional "Updating…" price', () => {
    expect(code(() => interpretDom(page({ pending: true })))).toBe('PRICE_PENDING');
  });

  it('refuses when the structural price and the layout-marked price disagree', () => {
    const raw = page({ markerPrice: 4 }); // marker points at the hidden decoy
    expect(code(() => interpretDom(raw))).toBe('PRICE_CONFLICT');
  });

  it('flags a structure change when there is no stock statement', () => {
    expect(code(() => interpretDom(page({ facets: [] })))).toBe('STRUCTURE_CHANGED');
  });

  it('flags a structure change when the price block is missing', () => {
    expect(code(() => interpretDom({ ok: false, reason: 'gone', els: [], facets: [], pending: false, markerPrice: -1 }))).toBe(
      'STRUCTURE_CHANGED',
    );
  });

  it('refuses ambiguity: two equally prominent visible prices', () => {
    const raw = page({
      markerPrice: -1,
      els: [el(0, '₹49,228', { fontPx: 38.4 }), el(1, '₹51,000', { fontPx: 38.4 })],
    });
    expect(code(() => interpretDom(raw))).toBe('STRUCTURE_CHANGED');
  });

  it('refuses a price it cannot parse instead of guessing', () => {
    const raw = page({ markerPrice: -1, els: [el(0, 'Call 1800-123', { fontPx: 38.4 })] });
    expect(code(() => interpretDom(raw))).toBe('INVALID_DATA');
  });

  it('skips the marker cross-check when the page received no layout', () => {
    expect(interpretDom(page({ markerPrice: -1 })).price).toBe(49228);
  });
});

describe('validateQuote', () => {
  const ok = { price: 100, mrp: 150, dealPrice: null, discountPct: 33, stock: 5, rating: 4, ratingCount: 10, seller: 's' };
  it('accepts a sane quote', () => expect(code(() => validateQuote(ok))).toBe('no error'));
  it.each([
    ['zero price', { price: 0 }],
    ['negative price', { price: -3 }],
    ['NaN price', { price: NaN }],
    ['absurd price', { price: 5e9 }],
    ['fractional stock', { stock: 2.5 }],
    ['negative stock', { stock: -1 }],
    ['price above MRP', { price: 500 }],
  ])('rejects %s', (_n, patch) => expect(code(() => validateQuote({ ...ok, ...patch }))).toBe('INVALID_DATA'));
});
