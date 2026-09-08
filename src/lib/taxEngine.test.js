/**
 * taxEngine.test.js - tax profiles engine (v5.7.32, slice 1: engine lands dark).
 * Run: `npm test` (Node's built-in runner).
 *
 * Covers: the Omaha compound case, the Chicago 4-line stack, the UK sugar levy
 * (inclusive VAT + exclusive per_unit), mixed inclusive+exclusive, post_discount
 * basis, order-type filtering, per-unit validation, the resolution cascade, the
 * two rounding levels, and the GOLDEN PARITY corpus that pins engine-through-
 * adapter output to today's calculateOrderTax to the penny.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeTax,
  makeCascadeResolver,
  validateProfile,
  lineAppliesToOrderType,
} from './taxEngine.js';
import { buildLegacyProfiles, legacyProfileId } from './taxAdapter.js';
import { calculateOrderTax } from './tax.js';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

// ── helpers ──────────────────────────────────────────────────────────────────

const line = (over = {}) => ({
  id: over.id || `pl-${Math.random().toString(36).slice(2, 8)}`,
  name: 'Tax',
  lineType: 'rate',
  rate: 0,
  flatAmount: 0,
  mode: 'exclusive',
  compound: false,
  taxable: false,
  taxBasis: 'pre_discount',
  orderTypes: ['all'],
  sortOrder: 0,
  active: true,
  ...over,
});

const profile = (id, lines, rounding = { mode: 'half_up', level: 'invoice' }) =>
  ({ id, name: id, rounding, lines });

/** One-profile engine run: every order line resolves the same profile. */
const run = (p, orderLines, orderType = 'dine-in') => computeTax({
  lines: orderLines,
  profilesById: { [p.id]: p },
  resolveProfileId: () => p.id,
  orderType,
});

/** Map legacy calculateOrderTax items to engine order lines. */
const toEngineLines = items => items.map((i, n) => ({
  price: i.price,
  qty: i.qty,
  voided: i.voided,
  itemId: i.id || `item-${n}`,
  legacy: { taxRateId: i.taxRateId, taxOverrides: i.taxOverrides },
}));

/** Engine-through-adapter run over a legacy config. */
const runLegacy = (items, taxRates, orderType) => {
  const { profilesById, legacyRateToProfileId, legacyDefaultProfileId } = buildLegacyProfiles(taxRates);
  const resolveProfileId = makeCascadeResolver({ legacyRateToProfileId, legacyDefaultProfileId });
  return computeTax({ lines: toEngineLines(items), profilesById, resolveProfileId, orderType });
};

/** Assert engine-through-adapter === calculateOrderTax to the penny. */
const assertParity = (items, taxRates, orderType) => {
  const eng = runLegacy(items, taxRates, orderType);
  const leg = calculateOrderTax(items, taxRates, orderType);
  near(eng.legacyBreakdown.totalTax, leg.totalTax);
  assert.equal(eng.exclusiveTaxTotal, leg.exclusiveTax);
  // Per-rate breakdown: same rate ids, same tax, penny for penny.
  const engByRate = Object.fromEntries(eng.legacyBreakdown.breakdown.map(b => [b.rate?.id, b.tax]));
  const legByRate = Object.fromEntries(leg.breakdown.map(b => [b.rate.id, b.tax]));
  assert.deepEqual(Object.keys(engByRate).sort(), Object.keys(legByRate).sort());
  for (const id of Object.keys(legByRate)) near(engByRate[id], legByRate[id]);
  return { eng, leg };
};

// ── Omaha NE: occupation tax inside the sales-tax base (compounding) ─────────

const OMAHA = profile('omaha', [
  line({ id: 'occ', name: 'Restaurant Occupation Tax', jurisdiction: 'City of Omaha',
    rate: 0.025, taxable: true, sortOrder: 0 }),
  line({ id: 'sales', name: 'Sales Tax', jurisdiction: 'Nebraska',
    rate: 0.075, compound: true, sortOrder: 1 }),
]);

test('Omaha: 2.5% occupation then 7.5% sales compounds on 102.50 - 110.19 total charge', () => {
  const r = run(OMAHA, [{ price: 100, qty: 1, itemId: 'steak' }]);
  const occ = r.lines.find(l => l.lineId === 'occ');
  const sales = r.lines.find(l => l.lineId === 'sales');
  assert.equal(occ.amount, 2.50);          // 100 x 2.5%
  assert.equal(sales.amount, 7.69);        // 7.5% of 102.50 = 7.6875 -> half-up 7.69
  assert.equal(r.exclusiveTaxTotal, 10.19);
  assert.equal(r.inclusiveExtractedTotal, 0);
  near(100 + r.exclusiveTaxTotal, 110.19);
});

test('Omaha: non-compound ordering matters - without compound the sales line taxes only the base', () => {
  const flat = profile('flat', [
    line({ id: 'occ', rate: 0.025, taxable: true, sortOrder: 0 }),
    line({ id: 'sales', rate: 0.075, compound: false, sortOrder: 1 }),
  ]);
  const r = run(flat, [{ price: 100, qty: 1 }]);
  assert.equal(r.lines.find(l => l.lineId === 'sales').amount, 7.50);   // 7.5% of 100, not 102.50
  assert.equal(r.exclusiveTaxTotal, 10.00);
});

// ── Chicago IL: four stacked exclusive lines, no compounding ─────────────────

test('Chicago: 6.25 + 1.75 + 1.25 + 0.5 all exclusive on 100 = 9.75', () => {
  const chi = profile('chicago', [
    line({ id: 'il',   name: 'Illinois State',  rate: 0.0625, sortOrder: 0 }),
    line({ id: 'cook', name: 'Cook County',     rate: 0.0175, sortOrder: 1 }),
    line({ id: 'chi',  name: 'City of Chicago', rate: 0.0125, sortOrder: 2 }),
    line({ id: 'rta',  name: 'RTA',             rate: 0.0050, sortOrder: 3 }),
  ]);
  const r = run(chi, [{ price: 100, qty: 1 }]);
  assert.equal(r.exclusiveTaxTotal, 9.75);
  assert.deepEqual(r.lines.map(l => l.amount), [6.25, 1.75, 1.25, 0.50]);
});

// ── UK sugar levy: inclusive VAT + exclusive per_unit line ───────────────────

const SUGAR = profile('uk-sugar', [
  line({ id: 'vat', name: 'VAT', jurisdiction: 'HMRC', rate: 0.20, mode: 'inclusive', sortOrder: 0 }),
  line({ id: 'levy', name: 'Sugar Levy', lineType: 'per_unit', flatAmount: 0.25, sortOrder: 1 }),
]);

test('UK sugar: VAT extracts unchanged, levy adds 0.25 per unit x 3 = 0.75 on top', () => {
  const r = run(SUGAR, [{ price: 1.50, qty: 3 }]);
  const vat = r.lines.find(l => l.lineId === 'vat');
  const levy = r.lines.find(l => l.lineId === 'levy');
  near(vat.amount, 0.75);                     // 4.50 - 4.50/1.2 - extraction untouched by the levy
  assert.equal(levy.amount, 0.75);            // 0.25 x 3, exclusive: charged on top
  assert.equal(levy.rate, null);              // per_unit lines report rate null
  assert.equal(r.exclusiveTaxTotal, 0.75);    // ONLY the levy is added to the payable
  assert.equal(r.inclusiveExtractedTotal, 0.75);
  // VAT alone on the same lines extracts the identical amount - the levy changed nothing.
  const vatOnly = run(profile('v', [line({ id: 'vat', rate: 0.20, mode: 'inclusive' })]),
    [{ price: 1.50, qty: 3 }]);
  near(vatOnly.lines[0].amount, vat.amount);
});

test('inclusive lines join compounding bases ONLY when taxable=true', () => {
  const mk = taxable => profile('p', [
    line({ id: 'vat', rate: 0.20, mode: 'inclusive', taxable, sortOrder: 0 }),
    line({ id: 'surtax', rate: 0.10, compound: true, sortOrder: 1 }),
  ]);
  const items = [{ price: 12, qty: 1 }];
  // taxable=false (the UK norm): the surtax never sees the extracted VAT.
  assert.equal(run(mk(false), items).lines.find(l => l.lineId === 'surtax').amount, 1.20);
  // taxable=true: base 12 + extracted 2 = 14.
  assert.equal(run(mk(true), items).lines.find(l => l.lineId === 'surtax').amount, 1.40);
});

// ── mixed inclusive + exclusive across profiles ──────────────────────────────

test('mixed check: only the exclusive share is added, inclusive VAT never re-charged', () => {
  const vatP = profile('vat', [line({ id: 'vat', rate: 0.20, mode: 'inclusive' })]);
  const usP = profile('us', [line({ id: 'us', rate: 0.08875 })]);
  const r = computeTax({
    lines: [
      { price: 12.00, qty: 1, itemId: 'uk-item' },
      { price: 10.00, qty: 1, itemId: 'us-item' },
    ],
    profilesById: { vat: vatP, us: usP },
    resolveProfileId: ol => (ol.itemId === 'uk-item' ? 'vat' : 'us'),
    orderType: 'dine-in',
  });
  assert.equal(r.exclusiveTaxTotal, 0.89);        // 0.8875 -> half-up, never + the 2.00 VAT
  assert.equal(r.inclusiveExtractedTotal, 2.00);
});

// ── basis: pre_discount vs post_discount ─────────────────────────────────────

test('post_discount basis taxes the discounted price; pre_discount ignores it', () => {
  const items = [{ price: 10, qty: 2, discountedPrice: 8 }];
  const post = run(profile('p', [line({ id: 't', rate: 0.10, taxBasis: 'post_discount' })]), items);
  const pre = run(profile('q', [line({ id: 't', rate: 0.10, taxBasis: 'pre_discount' })]), items);
  assert.equal(post.exclusiveTaxTotal, 1.60);   // 10% of 8 x 2
  assert.equal(pre.exclusiveTaxTotal, 2.00);    // 10% of 10 x 2
});

test('post_discount with no discountedPrice falls back to price', () => {
  const r = run(profile('p', [line({ id: 't', rate: 0.10, taxBasis: 'post_discount' })]),
    [{ price: 10, qty: 1 }]);
  assert.equal(r.exclusiveTaxTotal, 1.00);
});

// ── order-type filtering ─────────────────────────────────────────────────────

test('a line scoped to takeaway is skipped for dine-in and applied for takeaway', () => {
  const p = profile('p', [line({ id: 't', rate: 0.10, orderTypes: ['takeaway'] })]);
  assert.equal(run(p, [{ price: 10, qty: 1 }], 'dine-in').exclusiveTaxTotal, 0);
  assert.equal(run(p, [{ price: 10, qty: 1 }], 'takeaway').exclusiveTaxTotal, 1.00);
  assert.ok(lineAppliesToOrderType(line({ orderTypes: ['all'] }), 'anything'));
});

test('inactive lines are skipped', () => {
  const p = profile('p', [
    line({ id: 'on', rate: 0.10 }),
    line({ id: 'off', rate: 0.50, active: false }),
  ]);
  assert.equal(run(p, [{ price: 10, qty: 1 }]).exclusiveTaxTotal, 1.00);
});

// ── per-unit validation ──────────────────────────────────────────────────────

test('an inclusive per_unit line is invalid and computeTax refuses it', () => {
  const bad = profile('bad', [line({ id: 'x', lineType: 'per_unit', flatAmount: 0.25, mode: 'inclusive' })]);
  assert.equal(validateProfile(bad).length, 1);
  assert.throws(() => run(bad, [{ price: 1, qty: 1 }]), /exclusive-only/);
  assert.deepEqual(validateProfile(SUGAR), []);   // the valid shape passes
});

// ── rounding levels ──────────────────────────────────────────────────────────

test('invoice level rounds once across the order; item level rounds per order line', () => {
  const items = [{ price: 1.30, qty: 1 }, { price: 1.30, qty: 1 }];
  const inv = run(profile('i', [line({ id: 't', rate: 0.08875 })],
    { mode: 'half_up', level: 'invoice' }), items);
  const itm = run(profile('j', [line({ id: 't', rate: 0.08875 })],
    { mode: 'half_up', level: 'item' }), items);
  assert.equal(inv.exclusiveTaxTotal, 0.23);   // raw 0.230675 rounded once
  assert.equal(itm.exclusiveTaxTotal, 0.24);   // 0.1153.. -> 0.12 per line, x2
});

// ── the resolution cascade ───────────────────────────────────────────────────

test('cascade: item profile beats legacy rate beats category beats venue default beats legacy default', () => {
  const resolve = makeCascadeResolver({
    itemProfileIds: { burger: 'p-item' },
    categoryProfileIds: { mains: 'p-cat' },
    venueDefaultProfileId: 'p-venue',
    legacyRateToProfileId: { r20: legacyProfileId('r20') },
    legacyDefaultProfileId: legacyProfileId('rdef'),
  });
  // 1. item profile wins even with a legacy rate set
  assert.equal(resolve({ itemId: 'burger', legacy: { taxRateId: 'r20' } }, 'dine-in'), 'p-item');
  // 2. legacy rate id (mapped) beats the category profile
  assert.equal(resolve({ itemId: 'x', categoryId: 'mains', legacy: { taxRateId: 'r20' } }, 'dine-in'),
    legacyProfileId('r20'));
  // 3. no item/legacy -> category profile
  assert.equal(resolve({ itemId: 'x', categoryId: 'mains', legacy: {} }, 'dine-in'), 'p-cat');
  // 4. nothing item/category-level -> venue default profile
  assert.equal(resolve({ itemId: 'x', legacy: {} }, 'dine-in'), 'p-venue');
  // 5. no venue default -> legacy default rate
  const r2 = makeCascadeResolver({ legacyDefaultProfileId: legacyProfileId('rdef') });
  assert.equal(r2({ itemId: 'x', legacy: {} }, 'dine-in'), legacyProfileId('rdef'));
  // 6. nothing at all -> null
  assert.equal(makeCascadeResolver({})({ itemId: 'x', legacy: {} }, 'dine-in'), null);
});

test('the __not_in_menu__ sentinel resolves NO tax, never the default', () => {
  const resolve = makeCascadeResolver({
    venueDefaultProfileId: 'p-venue',
    legacyRateToProfileId: {},
    legacyDefaultProfileId: legacyProfileId('rdef'),
  });
  assert.equal(resolve({ itemId: 'x', legacy: { taxRateId: '__not_in_menu__' } }, 'delivery'), null);
});

test('a legacy taxOverride for the order type wins; explicit zero override beats the default', () => {
  const resolve = makeCascadeResolver({
    legacyRateToProfileId: { r20: legacyProfileId('r20'), zero: legacyProfileId('zero') },
    legacyDefaultProfileId: legacyProfileId('r20'),
  });
  const ol = { itemId: 'x', legacy: { taxRateId: null, taxOverrides: { takeaway: 'zero' } } };
  assert.equal(resolve(ol, 'takeaway'), legacyProfileId('zero'));
  assert.equal(resolve(ol, 'dine-in'), legacyProfileId('r20'));   // falls to the legacy default
});

test('voided lines are excluded', () => {
  const p = profile('p', [line({ id: 't', rate: 0.10 })]);
  const r = run(p, [{ price: 10, qty: 1 }, { price: 99, qty: 1, voided: true }]);
  assert.equal(r.exclusiveTaxTotal, 1.00);
});

// ── GOLDEN PARITY CORPUS: engine-through-adapter === calculateOrderTax ───────

test('parity: UK 20% inclusive default ("Use default" + explicit + no tax fields)', () => {
  const rates = [{ id: 'vat20', name: 'Standard Rate', rate: 0.20, type: 'inclusive', active: true, is_default: true }];
  const items = [
    { id: 'a', price: 36.00, qty: 1, taxRateId: 'vat20' },
    { id: 'b', price: 6.50, qty: 2, taxRateId: 'vat20' },
    { id: 'c', price: 9.95, qty: 3, taxRateId: null },   // "Use default"
    { id: 'd', price: 5.00, qty: 1 },                    // no tax fields at all
  ];
  const { eng } = assertParity(items, rates, 'dine-in');
  assert.equal(eng.exclusiveTaxTotal, 0);                // the UK lock: EXACTLY 0
  assert.ok(eng.legacyBreakdown.totalTax > 0);
});

test('parity: UK 20/5/0 mix with per-item overrides and order types', () => {
  const rates = [
    { id: 'vat20', name: 'Standard Rate', rate: 0.20, type: 'inclusive', active: true, is_default: true },
    { id: 'vat5', name: 'Reduced Rate', rate: 0.05, type: 'inclusive', active: true, is_default: false },
    { id: 'zero', name: 'Zero Rate', rate: 0, type: 'inclusive', active: true, is_default: false },
  ];
  const items = [
    { id: 'a', price: 12.00, qty: 1, taxRateId: 'vat20' },
    { id: 'b', price: 4.00, qty: 2, taxRateId: 'vat5' },
    { id: 'c', price: 2.50, qty: 1, taxRateId: 'zero' },
    { id: 'd', price: 6.00, qty: 1, taxRateId: 'vat20', taxOverrides: { takeaway: 'zero' } },
    { id: 'e', price: 9.95, qty: 1, taxRateId: null },                  // default
    { id: 'f', price: 5.00, qty: 1, taxRateId: '__not_in_menu__' },     // channel opt-out: no tax
  ];
  for (const orderType of ['dine-in', 'takeaway']) {
    const { eng } = assertParity(items, rates, orderType);
    assert.equal(eng.exclusiveTaxTotal, 0);   // still all-inclusive: exactly 0 added on
  }
});

test('parity: US 8.875% exclusive charges the same penny on top', () => {
  const rates = [
    { id: 'us', name: 'Sales Tax', rate: 0.08875, type: 'exclusive', active: true, is_default: true },
    { id: 'exempt', name: 'Tax Exempt', rate: 0, type: 'exclusive', active: true, is_default: false },
  ];
  const items = [
    { id: 'a', price: 47.20, qty: 1, taxRateId: 'us' },
    { id: 'b', price: 3.00, qty: 2, taxRateId: 'exempt' },
    { id: 'c', price: 10.00, qty: 1, taxRateId: null },   // default -> us
  ];
  const { eng, leg } = assertParity(items, rates, 'dine-in');
  assert.equal(eng.exclusiveTaxTotal, leg.exclusiveTax);
  assert.equal(eng.exclusiveTaxTotal, 5.08);   // (47.20 + 10.00) x 8.875% = 5.0764 -> 5.08
});

test('parity: voided items ignored by both engines', () => {
  const rates = [{ id: 'us', name: 'Sales Tax', rate: 0.08875, type: 'exclusive', active: true, is_default: true }];
  const items = [
    { id: 'a', price: 20.00, qty: 1, taxRateId: 'us' },
    { id: 'b', price: 50.00, qty: 1, taxRateId: 'us', voided: true },
  ];
  assertParity(items, rates, 'dine-in');
});

test('parity: legacyBreakdown carries the ORIGINAL rate objects, sorted rate-descending', () => {
  const rates = [
    { id: 'vat20', name: 'Standard Rate', rate: 0.20, type: 'inclusive', active: true, is_default: true },
    { id: 'vat5', name: 'Reduced Rate', rate: 0.05, type: 'inclusive', active: true, is_default: false },
  ];
  const items = [
    { id: 'a', price: 12.00, qty: 1, taxRateId: 'vat5' },
    { id: 'b', price: 12.00, qty: 1, taxRateId: 'vat20' },
  ];
  const eng = runLegacy(items, rates, 'dine-in');
  assert.deepEqual(eng.legacyBreakdown.breakdown.map(b => b.rate.id), ['vat20', 'vat5']);
  assert.equal(eng.legacyBreakdown.breakdown[0].rate, rates[0]);   // the very same object
});

test('legacyBreakdown reports rate null for per_unit lines', () => {
  const r = run(SUGAR, [{ price: 1.50, qty: 3 }]);
  const perUnit = r.legacyBreakdown.breakdown.find(b => b.rate === null);
  near(perUnit.tax, 0.75);
});

// ── Review-fix regression cases (v5.7.32 review: ADV1, ADV4, ADV6) ──────────
test('legacy parity: two exclusive rates round ONCE over the sum like tax.js (0.25 not 0.26)', () => {
  const rates = [
    { id: 'r5', name: 'A', rate: 0.05, type: 'exclusive', active: true },
    { id: 'r10', name: 'B', rate: 0.10, type: 'exclusive', active: true },
  ];
  const { profilesById, legacyRateToProfileId } = buildLegacyProfiles(rates);
  const resolve = makeCascadeResolver({ legacyRateToProfileId });
  const out = computeTax({
    lines: [
      { itemId: 'a', price: 2.50, qty: 1, legacy: { taxRateId: 'r5' } },
      { itemId: 'b', price: 1.25, qty: 1, legacy: { taxRateId: 'r10' } },
    ],
    profilesById, resolveProfileId: resolve, orderType: 'dine-in',
  });
  assert.equal(out.exclusiveTaxTotal, 0.25);   // raw 0.125 + 0.125 rounded once
});

test('FP half boundary rounds UP: 3 x 0.99 inclusive extraction = 0.50 not 0.49', () => {
  const profilesById = { p: { id: 'p', rounding: { mode: 'half_up', level: 'invoice' }, lines: [
    { id: 'vat', name: 'VAT', lineType: 'rate', rate: 0.20, mode: 'inclusive', compound: false, taxable: false, taxBasis: 'pre_discount', orderTypes: ['all'], sortOrder: 0, active: true },
  ] } };
  const out = computeTax({
    lines: [{ itemId: 'x', price: 0.99, qty: 3 }],
    profilesById, resolveProfileId: () => 'p', orderType: 'dine-in',
  });
  assert.equal(out.inclusiveExtractedTotal, 0.50);
});

test('line id collisions across profiles stay separate lines', () => {
  const mk = (pid, name, rate) => ({ id: pid, rounding: { mode: 'half_up', level: 'invoice' }, lines: [
    { id: 'shared', name, lineType: 'rate', rate, mode: 'exclusive', compound: false, taxable: false, taxBasis: 'pre_discount', orderTypes: ['all'], sortOrder: 0, active: true },
  ] });
  const profilesById = { p1: mk('p1', 'A', 0.10), p2: mk('p2', 'B', 0.20) };
  const out = computeTax({
    lines: [
      { itemId: 'a', price: 10, qty: 1, taxProfileId: 'p1' },
      { itemId: 'b', price: 10, qty: 1, taxProfileId: 'p2' },
    ],
    profilesById,
    resolveProfileId: (ol) => ol.taxProfileId,
    orderType: 'dine-in',
  });
  assert.equal(out.lines.length, 2);
  assert.equal(out.exclusiveTaxTotal, 3.00);
  const names = out.lines.map(l => l.name).sort();
  assert.deepEqual(names, ['A', 'B']);
});

