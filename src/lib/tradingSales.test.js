/**
 * tradingSales.test.js: the Daily trading (P&L) report's gross, VAT and net per check.
 * Run: `npm test`, or `node --test src/lib/tradingSales.test.js`.
 *
 * 27 Sep 2026: trading-report made gross = subtotal + tax_amount. A UK subtotal already
 * includes VAT, so gross takings were overstated by the VAT and net sales with them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSalesParts } from '../../supabase/functions/_shared/tradingSales.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test('UK inclusive VAT: gross is the subtotal, net takes the VAT out', () => {
  // £12 of shelf prices at 20%: £2 VAT inside it.
  const p = checkSalesParts({ subtotal: 12, total: 12, tax_amount: 2, tax_breakdown: { hasExclusiveTax: false, totalTax: 2 }, service: 0, tip: 0 });
  near(p.gross, 12);
  near(p.vat, 2);
  near(p.net, 10);
});

test('UK row with tax_amount and no stored breakdown (every inclusive writer) is inclusive', () => {
  const p = checkSalesParts({ subtotal: 24, total: 26, tax_amount: 4, tax_breakdown: null, service: 0, tip: 2 });
  near(p.gross, 24);
  near(p.net, 20);
});

test('US added-on tax: net is the subtotal, gross adds the tax', () => {
  const p = checkSalesParts({ subtotal: 100, total: 108.88, tax_amount: 8.88, tax_breakdown: { hasExclusiveTax: true, exclusiveTax: 8.88 }, service: 0, tip: 0 });
  near(p.net, 100);
  near(p.vat, 8.88);
  near(p.gross, 108.88);
});

test('no stored tax_amount keeps the old fallback exactly', () => {
  const p = checkSalesParts({ subtotal: 50, total: 60, tax_amount: null, service: 3, tip: 2 });
  near(p.net, 50);
  near(p.vat, 5);
  near(p.gross, 55);
  // A UK reader close from before v5.9.97 (tax null): nothing on top, no VAT found, gross = subtotal.
  const uk = checkSalesParts({ subtotal: 9.5, total: 9.5, tax_amount: null, tax_breakdown: null, service: 0, tip: 0 });
  near(uk.gross, 9.5);
  near(uk.vat, 0);
});

test('a comp that booked zero VAT: net equals gross', () => {
  const p = checkSalesParts({ subtotal: 8, total: 0, tax_amount: 0, tax_breakdown: { hasExclusiveTax: false, totalTax: 0 } });
  near(p.gross, 8);
  near(p.net, 8);
});

test('trading-report uses checkSalesParts for gross (never net + VAT)', () => {
  const src = fs.readFileSync(path.join(here, '../../supabase/functions/trading-report/index.ts'), 'utf8');
  assert.match(src, /import \{ checkSalesParts \} from '\.\.\/_shared\/tradingSales\.js';/);
  assert.match(src, /const p = checkSalesParts\(c\);/);
  assert.match(src, /select\('subtotal, total, tax_amount, tax_breakdown,/);
  assert.match(src, /const grossSales = s\.gross;/);
  assert.doesNotMatch(src, /const grossSales = actualSales \+ vat/);
});
