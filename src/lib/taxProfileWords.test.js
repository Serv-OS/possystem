import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pctText, profileRateWords, profileLabel, rateLabel, taxRuleFor, taxRuleWords, venueRunsOnProfiles, productsOnOldRate, rateForNewProduct } from './taxProfileWords.js';
import { isLegacyMirror, buildLocalTaxCtx, computeOrderTaxUnified } from './taxCompute.js';
import { formatRateLabel } from './tax.js';

// Mozz Sandy as it stood on 25 Nov 2026 (the SQL 20261208a rows plus the rate Peter typed).
const line = (name, rate, extra = {}) => ({ id: name, name, lineType: 'rate', rate, mode: 'exclusive', compound: false, orderTypes: ['all'], active: true, ...extra });
const prepared = { id: 'p-food', name: 'Prepared food', active: true, generatedFromRateId: null, lines: [line('Sales tax', '0.074500'), line('Restaurant tax', '0.010000')] };
const retail = { id: 'p-retail', name: 'Retail', active: true, generatedFromRateId: null, lines: [line('Sales tax', '0.074500')] };
const exempt = { id: 'p-exempt', name: 'Tax exempt', active: true, generatedFromRateId: null, lines: [line('Tax exempt', '0.000000')] };
const profiles = [prepared, retail, exempt];
const salesTax = { id: 'r-sales', name: 'Sales tax', rate: '0.074500', type: 'exclusive', isDefault: true, active: true };
const exemptRate = { id: 'r-exempt', name: 'Tax Exempt', rate: '0.000000', type: 'exclusive', isDefault: false, active: true };
const rates = [salesTax, exemptRate];
const pizza = { id: 'i1', name: 'Cheese', cat: 'c1' };
const cat = { id: 'c1', label: 'Sourdough Pizza' };

test('a percent keeps its full figure: 7.45 is never 7.4 and 0 is never blank', () => {
  assert.equal(pctText('0.074500'), '7.45');
  assert.equal(pctText(0.01), '1');
  assert.equal(pctText(0), '0');
  assert.equal(pctText('0.000000'), '0');
  assert.equal(pctText(0.2), '20');
  assert.equal(pctText(0.08875), '8.875');
  assert.equal(pctText(1), '100');
  assert.equal(pctText('junk'), '0');
});

test('a profile is named with what it charges', () => {
  assert.equal(profileLabel(prepared), 'Prepared food (8.45%)');
  assert.equal(profileLabel(retail), 'Retail (7.45%)');
  assert.equal(profileLabel(exempt), 'Tax exempt (0%)');
  assert.equal(profileRateWords({ lines: [] }), 'no lines');
  assert.equal(profileRateWords({ lines: [line('VAT', 0.2, { mode: 'inclusive' })] }), '20% incl.');
  // The Cabin's three line stack adds up exactly.
  assert.equal(profileRateWords({ lines: [line('a', 0.0725), line('b', 0.02125), line('c', 0.0025)] }), '9.625%');
  // A switched off line is not counted.
  assert.equal(profileRateWords({ lines: [line('a', 0.0745), line('b', 0.01, { active: false })] }), '7.45%');
});

test('a profile that cannot be given as one figure says why', () => {
  assert.equal(profileRateWords({ lines: [line('a', 0.0745), line('b', 0.01, { orderTypes: ['dine-in'] })] }), 'varies by order type');
  assert.equal(profileRateWords({ lines: [line('a', 0.07), line('b', 0.02, { compound: true })] }), '7% + 2% compound');
  assert.equal(profileRateWords({ lines: [line('a', 0.0845), { id: 'u', lineType: 'per_unit', flatAmount: 0.1, orderTypes: ['all'], active: true }] }), '8.45% + 0.10 each');
});

test('an old style rate is named with its full figure', () => {
  assert.equal(rateLabel(salesTax), 'Sales tax (7.45% excl.)');
  assert.equal(rateLabel(exemptRate), 'Tax Exempt (0% excl.)');
  assert.equal(rateLabel({ name: 'Standard', rate: 0.2, type: 'inclusive' }), 'Standard (20% incl.)');
  assert.equal(formatRateLabel(exemptRate), '0% Tax Exempt');
  assert.equal(formatRateLabel(salesTax), '7.45% Sales tax');
  assert.equal(formatRateLabel({ name: 'VAT', rate: 0.2 }), '20% VAT');
});

test('Mozz Sandy: a pizza with nothing of its own charges the venue default profile, 8.45%', () => {
  const rule = taxRuleFor({ item: pizza, category: cat, taxRates: rates, taxProfiles: profiles, venueDefaultProfileId: 'p-food' });
  assert.equal(rule.from, 'venue');
  assert.equal(rule.kind, 'profile');
  assert.equal(taxRuleWords(rule), 'Prepared food (8.45%), the venue default.');
});

test('the order is the engine order: own profile, own old rate, category, venue profile, old default', () => {
  const base = { category: cat, taxRates: rates, taxProfiles: profiles, venueDefaultProfileId: 'p-food' };
  // An old style rate on the product comes BEFORE the venue profile: the trap the yellow bar set.
  const onOld = taxRuleFor({ ...base, item: { ...pizza, taxRateId: 'r-sales' } });
  assert.equal(taxRuleWords(onOld), 'Sales tax (7.45% excl.), an old style rate set on this product.');
  // Its own profile comes before its own old rate.
  const both = taxRuleFor({ ...base, item: { ...pizza, taxRateId: 'r-sales', taxProfileId: 'p-retail' } });
  assert.equal(taxRuleWords(both), 'Retail (7.45%), set on this product.');
  // A category profile comes before the venue default.
  const viaCat = taxRuleFor({ ...base, item: pizza, category: { ...cat, taxProfileId: 'p-exempt' } });
  assert.equal(taxRuleWords(viaCat), 'Tax exempt (0%), from its category (Sourdough Pizza).');
  // No venue profile: the old default rate.
  const old = taxRuleFor({ ...base, item: pizza, venueDefaultProfileId: null });
  assert.equal(taxRuleWords(old), "Sales tax (7.45% excl.), the venue's default rate.");
  // Nothing anywhere.
  assert.equal(taxRuleWords(taxRuleFor({ item: pizza })), 'No tax: nothing is set on this product, its category or the venue.');
});

test('a switched off or unknown profile or rate is passed over, as the engine does', () => {
  const base = { category: cat, taxRates: rates, taxProfiles: profiles, venueDefaultProfileId: 'p-food' };
  assert.equal(taxRuleFor({ ...base, item: { ...pizza, taxProfileId: 'gone' } }).from, 'venue');
  assert.equal(taxRuleFor({ ...base, item: { ...pizza, taxRateId: 'another-venues' } }).from, 'venue');
  const off = [{ ...prepared, active: false }, retail, exempt];
  assert.equal(taxRuleFor({ ...base, taxProfiles: off, item: pizza }).kind, 'rate');
});

test('what a product would follow without its own setting (the first option in the picker)', () => {
  const args = { item: { ...pizza, taxProfileId: 'p-retail' }, category: cat, taxRates: rates, taxProfiles: profiles, venueDefaultProfileId: 'p-food', skipOwn: true };
  assert.equal(taxRuleFor(args).label, 'Prepared food (8.45%)');
});

test('a venue runs on profiles only when its default is a real one, not a copy of an old rate', () => {
  const args = { taxProfiles: profiles, taxRates: rates, venueDefaultProfileId: 'p-food', isMirror: isLegacyMirror };
  assert.equal(venueRunsOnProfiles(args), true);
  assert.equal(venueRunsOnProfiles({ ...args, venueDefaultProfileId: null }), false);
  assert.equal(venueRunsOnProfiles({ ...args, venueDefaultProfileId: 'gone' }), false);
  // A UK venue: the default profile is the generated copy of its 20% rate. Old rates still rule.
  const vat = { id: 'r-vat', name: 'Standard', rate: 0.2, type: 'inclusive', isDefault: true, active: true };
  const mirror = { id: 'p-vat', name: 'Standard', active: true, generatedFromRateId: 'r-vat', rounding: { mode: 'half_up', level: 'invoice' },
    lines: [{ id: 'l', name: 'Standard', lineType: 'rate', rate: 0.2, mode: 'inclusive', compound: false, taxable: false, orderTypes: ['all'], active: true, taxBasis: 'pre_discount', taxServiceCharge: false, taxDeliveryFee: false }] };
  assert.equal(isLegacyMirror(mirror, { 'r-vat': vat }), true);
  assert.equal(venueRunsOnProfiles({ taxProfiles: [mirror], taxRates: [vat], venueDefaultProfileId: 'p-vat', isMirror: isLegacyMirror }), false);
  // The same copy once someone has edited it (two lines) is a real profile.
  const edited = { ...mirror, lines: [...mirror.lines, { ...mirror.lines[0], id: 'l2', name: 'Levy', rate: 0.01 }] };
  assert.equal(venueRunsOnProfiles({ taxProfiles: [edited], taxRates: [vat], venueDefaultProfileId: 'p-vat', isMirror: isLegacyMirror }), true);
});

test('products holding an old style rate are found, the ones with their own profile are not', () => {
  const items = [
    pizza,
    { id: 'i2', name: 'Shirt', taxRateId: 'r-sales' },
    { id: 'i3', name: 'Mug', taxRateId: 'r-sales', taxProfileId: 'p-retail' },
    { id: 'i4', name: 'Old', taxRateId: 'r-sales', archived: true },
    { id: 'i5', name: 'Foreign', taxRateId: 'another-venues' },
  ];
  assert.deepEqual(productsOnOldRate(items, rates).map(i => i.id), ['i2']);
});

test('the words agree with the real tax engine at Mozz Sandy: a 14.00 pizza', () => {
  const sale = (item) => {
    const ctx = buildLocalTaxCtx({ taxProfiles: profiles, menuItems: [item], menuCategories: [cat], venueDefaultProfileId: 'p-food', taxRates: rates });
    return computeOrderTaxUnified([{ ...item, itemId: item.id, price: 14, qty: 1 }], ctx, 'dine-in');
  };
  // Nothing of its own: Prepared food. 14.00 x 7.45% = 1.04 and 14.00 x 1% = 0.14.
  const covered = sale(pizza);
  assert.equal(covered.source, 'profiles');
  assert.equal(covered.exclusiveTax.toFixed(2), '1.18');
  assert.deepEqual(covered.taxV2.lines.map(l => `${l.name} ${Number(l.amount).toFixed(2)}`), ['Sales tax 1.04', 'Restaurant tax 0.14']);
  // The old style rate put on it by "Apply to all": 7.45% only, the restaurant tax is lost.
  const trapped = sale({ ...pizza, taxRateId: 'r-sales' });
  assert.equal(trapped.exclusiveTax.toFixed(2), '1.04');
  // Its own profile wins over that old rate.
  const own = sale({ ...pizza, taxRateId: 'r-sales', taxProfileId: 'p-exempt' });
  assert.equal(own.exclusiveTax.toFixed(2), '0.00');
});

test('the Menu screen uses these words and no longer says profiles do not charge', () => {
  const src = readFileSync(new URL('../backoffice/sections/MenuManager.jsx', import.meta.url), 'utf8');
  assert.ok(src.includes('This product charges:'));
  assert.ok(src.includes('{activeProfiles.map(p => <option key={p.id} value={p.id}>{profileLabel(p)}</option>)}'));
  assert.ok(src.includes('{profiles.map(p=><option key={p.id} value={p.id}>{profileLabel(p)}</option>)}'));
  assert.ok(src.includes('const noRate = onProfiles ? { ...found, all: [] } : found;'));
  assert.ok(!src.includes('the legacy rate below is what actually charges'));
  assert.ok(!src.includes('Tills switch to profile based calculation in an upcoming update'));
  assert.ok(!src.includes(".toFixed(1).replace('.0','')"));
});

// 5.12.103. Mozz Sandy, 25 Nov 2026: Half and Entree under Caesar Salad and Garden Salad were born
// on the old "Sales tax 7.45%" rate, in front of the 8.45% venue profile.
test('a new product is not stamped with the old default rate at a venue that charges through a real profile', () => {
  const args = { taxRates: rates, taxProfiles: profiles, venueDefaultProfileId: 'p-food', isMirror: isLegacyMirror };
  assert.equal(rateForNewProduct(args), null, 'Sandy: nothing stamped, the product follows the profile');
  // No venue profile (or one that is gone): the old default rate, as since v5.5.961.
  assert.equal(rateForNewProduct({ ...args, venueDefaultProfileId: null }), 'r-sales');
  assert.equal(rateForNewProduct({ ...args, venueDefaultProfileId: 'gone' }), 'r-sales');
  // No default rate and no profile: nothing to stamp.
  assert.equal(rateForNewProduct({ taxRates: [exemptRate] }), null);
  assert.equal(rateForNewProduct(), null);
  // An inactive default is not stamped.
  assert.equal(rateForNewProduct({ taxRates: [{ ...salesTax, active: false }] }), null);
});

test('a UK venue (its default profile is a copy of its VAT rate) is stamped exactly as before', () => {
  const vat = { id: 'r-vat', name: 'Standard', rate: 0.2, type: 'inclusive', isDefault: true, active: true };
  const mirror = { id: 'p-vat', name: 'Standard', active: true, generatedFromRateId: 'r-vat', rounding: { mode: 'half_up', level: 'invoice' },
    lines: [{ id: 'l', name: 'Standard', lineType: 'rate', rate: 0.2, mode: 'inclusive', compound: false, taxable: false, orderTypes: ['all'], active: true, taxBasis: 'pre_discount', taxServiceCharge: false, taxDeliveryFee: false }] };
  assert.equal(rateForNewProduct({ taxRates: [vat], taxProfiles: [mirror], venueDefaultProfileId: 'p-vat', isMirror: isLegacyMirror }), 'r-vat');
});

test('the store stamps a new product through that one rule', () => {
  const store = readFileSync(new URL('../store/index.js', import.meta.url), 'utf8');
  assert.ok(store.includes('const stamp = rateForNewProduct({ taxRates: rates, taxProfiles: st.taxProfiles, venueDefaultProfileId: st.venueDefaultTaxProfileId, isMirror: isLegacyMirror });'));
  assert.ok(store.includes('if (stamp) newItem.taxRateId = stamp;'));
  assert.ok(!store.includes('if (def) newItem.taxRateId = def.id;'));
});

test('the engine agrees: a new size with no stamp charges the venue profile, 8.45%', () => {
  const size = { id: 'half', name: 'Half', parentId: 'caesar', cat: 'c1' };
  const ctx = buildLocalTaxCtx({ taxProfiles: profiles, menuItems: [size], menuCategories: [cat], venueDefaultProfileId: 'p-food', taxRates: rates });
  const unstamped = computeOrderTaxUnified([{ ...size, itemId: 'half', price: 10, qty: 1 }], ctx, 'dine-in');
  assert.equal(unstamped.exclusiveTax.toFixed(2), '0.85');
  const stamped = computeOrderTaxUnified([{ ...size, itemId: 'half', price: 10, qty: 1, taxRateId: 'r-sales' }], ctx, 'dine-in');
  assert.equal(stamped.exclusiveTax.toFixed(2), '0.75', 'what the four sizes charged: the restaurant tax missing');
});
