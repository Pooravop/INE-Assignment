import { describe, expect, it } from 'vitest';
import { parseCount, parseDiscountPct, parsePrice, parseSeller, parseStock } from '../src/scraper/parse.js';

describe('parsePrice — every disguise the store uses for the same amount', () => {
  const zw = '\u200B';
  const nb = '\u00A0';
  const cases: [string, string, number][] = [
    ['default en-IN', '₹1,23,456', 123456],
    ['small', '₹999', 999],
    ['western grouping', '₹12,345', 12345],
    ['spaced', '₹1 23 456', 123456],
    ['euro', '₹1.23.456,00', 123456],
    ['euro small', '₹999,00', 999],
    ['trailing suffix', '₹1,23,456/- (incl. of all taxes)', 123456],
    ['fullwidth unicode digits', '₹１，２３，４５６', 123456],
    ['nbsp + zero-width between every char', [...'₹1,23,456'].join(`${nb}${zw}`), 123456],
    ['lakh with Rs.', `Rs.${nb}1,23,456.00`, 123456],
    ['lakh with decimals', 'Rs. 4,999.50', 4999.5],
    ['zero-width inside digits (split carrier)', `₹1${zw},2${zw}3${zw},456`, 123456],
  ];
  for (const [name, input, want] of cases) {
    it(name, () => expect(parsePrice(input)).toBe(want));
  }

  it.each(['', 'Price hidden', 'Deal price ₹1,234', '₹', '₹-5', '₹0', 'NaN', '1,2,x', 'Updating…'])(
    'refuses %j instead of guessing',
    (s) => expect(parsePrice(s)).toBeNull(),
  );
});

describe('parseStock', () => {
  it.each([
    ['In stock · 12 left', 12],
    ['Only 3 left', 3],
    ['48 in stock', 48],
    ['Selling fast — 5 left', 5],
    ['Hurry, just 1 left', 1],
    ['Out of stock', 0],
    ['In stock · 1,200 left', 1200],
  ])('%s -> %d', (s, n) => expect(parseStock(s)).toBe(n));
  it.each(['', 'Delivery by Tue', 'In stock'])('unrecognised %j -> null', (s) => expect(parseStock(s)).toBeNull());
});

describe('other fields', () => {
  it('discount', () => {
    expect(parseDiscountPct('23% off')).toBe(23);
    expect(parseDiscountPct('nope')).toBeNull();
  });
  it('rating counts', () => {
    expect(parseCount('1.2k ratings')).toBe(1200);
    expect(parseCount('842 ratings')).toBe(842);
  });
  it('seller with zero-width chars', () => {
    expect(parseSeller('Sold by Zen\u200Bith Retail')).toBe('Zenith Retail');
  });
});
