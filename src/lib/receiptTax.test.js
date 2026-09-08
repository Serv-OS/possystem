/**
 * receiptTax.test.js - receipt tax rendering helpers (v5.7.34 receipts half).
 * Run: `npm test` (Node's built-in runner).
 *
 * Pins the two rules every renderer leans on:
 *   1. THE UK GATE (shouldRenderV2): post-cutover every check carries taxV2,
 *      but a pure inclusive legacy-shaped check (every UK VAT check) must NOT
 *      take the named-lines path - it keeps the byte-identical legacy output.
 *      v2 renders ONLY for an exclusive/per_unit component or a real
 *      non-mirror profile.
 *   2. rate-null guards (breakdown*): per-unit entries book rate: null in the
 *      legacy-shaped breakdown; they must render name + amount with no percent
 *      and no crash, while rate-backed entries keep byte-identical strings.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  taxTermFor, shouldRenderV2, v2ReceiptLines, taxLineLabel,
  breakdownPct, breakdownName, breakdownLabel, breakdownIsExclusive,
} from './receiptTax.js';

// ── fixtures ────────────────────────────────────────────────────────────────

const v2Line = (over = {}) => ({
  lineId: 'legacy-line:vat20', name: 'Standard Rate', jurisdiction: null,
  mode: 'inclusive', rate: 0.2, amount: 6.0, ...over,
});

/** A post-cutover UK inclusive check: legacy shape + adapter-line v2 record. */
const ukCheckBk = () => ({
  subtotal: 30, totalTax: 6, total: 36, exclusiveTax: 0, hasExclusiveTax: false,
  breakdown: [{ rate: { id: 'vat20', name: 'Standard Rate', rate: 0.2, type: 'inclusive' }, tax: 6, net: 30, gross: 36, items: 1 }],
  taxV2: { version: 2, source: 'legacy', orderType: 'dine-in', lines: [v2Line()], exclusiveTaxTotal: 0, inclusiveExtractedTotal: 6 },
});

/** A US check: exclusive named lines from a real profile. */
const usCheckBk = () => ({
  subtotal: 100, totalTax: 9.75, total: 109.75, exclusiveTax: 9.75, hasExclusiveTax: true,
  breakdown: [{ rate: { id: 'il', name: 'Illinois State', rate: 0.0625, type: 'exclusive' }, tax: 6.25, net: 100, gross: 106.25, items: 1 }],
  taxV2: {
    version: 2, source: 'profiles', orderType: 'dine-in',
    lines: [
      v2Line({ lineId: 'il', name: 'Illinois State', mode: 'exclusive', rate: 0.0625, amount: 6.25 }),
      v2Line({ lineId: 'rta', name: 'RTA', mode: 'exclusive', rate: 0.005, amount: 0.5 }),
    ],
    exclusiveTaxTotal: 6.75, inclusiveExtractedTotal: 0,
  },
});

// ── 1. the UK gate ──────────────────────────────────────────────────────────

test('UK REGRESSION PIN: a pure inclusive legacy-shaped check does NOT render v2', () => {
  const bk = ukCheckBk();
  assert.equal(shouldRenderV2(bk), false);
  assert.equal(v2ReceiptLines(bk), null);   // callers fall back to the legacy rendering
});

test('a check with no v2 record never renders v2', () => {
  assert.equal(shouldRenderV2(null), false);
  assert.equal(shouldRenderV2({ breakdown: [] }), false);
  assert.equal(v2ReceiptLines({ hasExclusiveTax: true }), null);
});

test('any exclusive component turns the v2 rendering on (even source legacy)', () => {
  const bk = ukCheckBk();
  bk.taxV2.lines.push(v2Line({ lineId: 'legacy-line:us', name: 'Sales Tax', mode: 'exclusive', rate: 0.08875, amount: 4.19 }));
  assert.equal(shouldRenderV2(bk), true);
  const lines = v2ReceiptLines(bk);
  assert.equal(lines.length, 2);
  assert.deepEqual(lines.map(l => l.exclusive), [false, true]);
});

test('a per_unit line (rate null) turns the v2 rendering on and prints no percent', () => {
  const bk = ukCheckBk();
  bk.taxV2.lines.push(v2Line({ lineId: 'levy', name: 'Sugar Levy', mode: 'exclusive', rate: null, amount: 0.75 }));
  assert.equal(shouldRenderV2(bk), true);
  const levy = v2ReceiptLines(bk).find(l => l.name === 'Sugar Levy');
  assert.equal(levy.pct, null);
  assert.equal(taxLineLabel(levy), 'Sugar Levy');
});

test('source profiles + all-inclusive: mirror adapter lines stay legacy, a real profile line renders v2', () => {
  // Mirror-remapped venue default: all lines are adapter lines -> legacy output.
  const mirror = ukCheckBk();
  mirror.taxV2.source = 'profiles';
  assert.equal(shouldRenderV2(mirror), false);
  // An edited/real profile line id -> named-lines rendering.
  const real = ukCheckBk();
  real.taxV2.source = 'profiles';
  real.taxV2.lines = [v2Line({ lineId: 'l-gen-vat20' })];
  assert.equal(shouldRenderV2(real), true);
});

test('v2ReceiptLines drops zero-amount lines and formats trimmed percents', () => {
  const bk = usCheckBk();
  bk.taxV2.lines.push(v2Line({ lineId: 'zero', name: 'Zero', mode: 'exclusive', rate: 0, amount: 0 }));
  const lines = v2ReceiptLines(bk);
  assert.deepEqual(lines.map(l => [l.name, l.pct]), [
    ['Illinois State', '6.25'], ['RTA', '0.5'],
  ]);
  assert.equal(taxLineLabel(lines[0]), 'Illinois State (6.25%)');
});

// ── 2. wording ──────────────────────────────────────────────────────────────

test('taxTermFor: inclusive-only says VAT, any exclusive component says Sales Tax', () => {
  assert.equal(taxTermFor(null), 'VAT');
  assert.equal(taxTermFor(ukCheckBk()), 'VAT');
  assert.equal(taxTermFor(usCheckBk()), 'Sales Tax');
  // No v2 record: falls back to hasExclusiveTax, then the breakdown shape.
  assert.equal(taxTermFor({ hasExclusiveTax: true }), 'Sales Tax');
  assert.equal(taxTermFor({ breakdown: [{ rate: { type: 'exclusive' }, tax: 1 }] }), 'Sales Tax');
  assert.equal(taxTermFor({ breakdown: [{ rate: { type: 'inclusive' }, tax: 1 }] }), 'VAT');
});

// ── 3. rate-null guards over the legacy-shaped breakdown ────────────────────

const rated = { rate: { id: 'vat20', name: 'Standard Rate', rate: 0.2, type: 'inclusive' }, tax: 6 };
const perUnit = { rate: null, name: 'Sugar Levy', tax: 0.75 };

test('breakdownPct reproduces the inline percent strings byte-for-byte', () => {
  // dp 1: (rate*100).toFixed(1).replace('.0','')
  assert.equal(breakdownPct(rated, 1), (0.2 * 100).toFixed(1).replace('.0', ''));
  assert.equal(breakdownPct({ rate: { rate: 0.105 } }, 1), '10.5');
  // dp 3: (rate*100).toFixed(3).replace(/\.?0+$/,'')
  assert.equal(breakdownPct({ rate: { rate: 0.08875 } }, 3), (0.08875 * 100).toFixed(3).replace(/\.?0+$/, ''));
  // dp 0: (rate*100).toFixed(0)
  assert.equal(breakdownPct({ rate: { rate: 0.08875 } }, 0), (0.08875 * 100).toFixed(0));
  // null rate object or null rate value: no percent
  assert.equal(breakdownPct(perUnit, 1), null);
  assert.equal(breakdownPct({ rate: { name: 'X', rate: null } }, 1), null);
});

test('breakdownLabel: "Name (pct%)" for rate entries, plain name for per-unit', () => {
  assert.equal(breakdownLabel(rated, 1), 'Standard Rate (20%)');
  assert.equal(breakdownLabel(perUnit, 1), 'Sugar Levy');
  assert.equal(breakdownLabel({ rate: null }, 1), 'Tax');   // no name anywhere
  assert.equal(breakdownName(perUnit), 'Sugar Levy');
});

test('breakdownIsExclusive: per-unit (rate null) is added-on; inclusive rates are not', () => {
  assert.equal(breakdownIsExclusive(perUnit), true);
  assert.equal(breakdownIsExclusive(rated), false);
  assert.equal(breakdownIsExclusive({ rate: { type: 'exclusive' } }), true);
});
