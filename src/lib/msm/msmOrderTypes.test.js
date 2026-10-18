// Multi site menu, round 2: price and VAT per order type on the screens (msmOrderTypes.js), and the
// status bar and first run guide (msmStatus.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  shownPriceTypes, shownTaxTypes, groupTypeFallback, siteTypeFallback, siteRateChoices, choiceToRate, rateToChoice,
  sitesMissingRate, siteOverridesAfter, vatExample,
} from './msmOrderTypes.js';
import { statusBar, whyReadOnly, draftTitle, GUIDE_STEPS, guideClosed, setGuideClosed, cellNoteWords } from './msmStatus.js';

const VAT = { id: 'v', name: 'VAT', rate: 20, active: true, is_default: true };
const ZERO = { id: 'z', name: 'Zero Rate', rate: 0, active: true };

test('which order type prices show: the menu\'s own list, else those priced anywhere', () => {
  assert.deepEqual(shownPriceTypes({ menu: {}, products: [{ default_channels: { delivery: 4, takeaway: 3 } }], productSites: [{ channel_prices: { dineIn: 3 } }] }).types, ['dineIn', 'takeaway'], 'Delivery is a platform price, never shown (UI issue 2)');
  assert.deepEqual(shownPriceTypes({ menu: { order_types: ['takeaway', 'delivery', 'bar'] }, products: [{ default_channels: { dineIn: 4 } }] }).types, ['takeaway'], 'the setting wins; hidden prices stay');
  assert.deepEqual(shownPriceTypes({ menu: {}, products: [{ default_channels: { dineIn: null } }] }).types, [], 'Coffee Boy: Standard only');
  assert.deepEqual(shownTaxTypes({ menu: {} }), ['dine-in', 'takeaway', 'delivery']);
  assert.deepEqual(shownTaxTypes({ menu: { order_types: ['bar'] } }), ['dine-in', 'takeaway', 'delivery', 'bar'], 'Bar tab only when it is sold');
});

test('fall backs come from the till\'s own chain: collection uses Standard, drive thru uses Takeaway', () => {
  const p = { default_price: 3.4, default_channels: { takeaway: 3.2 } };
  assert.deepEqual(groupTypeFallback(p, 'collection'), { value: 3.4, words: 'Blank uses the Standard price, 3.40' });
  assert.deepEqual(groupTypeFallback(p, 'driveThru'), { value: 3.2, words: 'Blank uses the Takeaway price, 3.20' });
  assert.equal(siteTypeFallback(p, { price: 3.6 }, 'collection').value, 3.6, 'the site\'s own Standard price');
  assert.equal(siteTypeFallback(p, { price: 3.6 }, 'takeaway').words, "Blank uses the group's Takeaway price, 3.20");
  assert.equal(siteTypeFallback({ default_price: 3 }, { price: null }, 'dineIn', 3.5).value, 3.5, 'what is typed in the Standard box now');
});

test('VAT choices are the sites\' own rates by name and percent, most sites first; a site without one is named', () => {
  const ch = siteRateChoices({ a: [VAT, ZERO], b: [VAT], c: [{ ...ZERO, active: false }] });
  assert.deepEqual(ch.map((x) => [x.label, x.sites]), [['VAT (20%)', 2], ['Zero Rate (0%)', 1]]);
  assert.deepEqual(choiceToRate('Zero Rate|0'), { name: 'Zero Rate', percent: 0 });
  assert.equal(choiceToRate(''), null);
  assert.equal(rateToChoice({ name: 'VAT', percent: 20 }), 'VAT|20');
  assert.deepEqual(sitesMissingRate({ name: 'Zero Rate', percent: 0 }, { a: [VAT, ZERO], b: [VAT] }, ['a', 'b']), ['b']);
});

test('the site\'s overrides as publish leaves them: the four keys from the group or kept, every other key as it is', () => {
  const r = siteOverridesAfter({ takeaway: { name: 'Zero Rate', percent: 0 }, delivery: { name: 'Zero Rate', percent: 0 } }, { counter: 'z', 'drive-thru': null, delivery: false }, [VAT, ZERO]);
  assert.deepEqual(r.overrides, { counter: 'z', 'drive-thru': null, takeaway: 'z' }, 'delivery: the site keeps no key; counter and the explicit null stay');
  assert.deepEqual(siteOverridesAfter({ takeaway: { name: 'Zero Rate', percent: 0 } }, null, [VAT]).unmatched, ['takeaway']);
});

test('the live example is worked out by the real VAT engine', () => {
  const product = { name: 'Galaxy donut', tax_rate_name: 'VAT', tax_rate_percent: 20 };
  const tbt = { takeaway: { name: 'Zero Rate', percent: 0 } };
  assert.equal(vatExample({ product, taxByType: tbt, rates: [VAT, ZERO], orderType: 'takeaway', price: 3.5, siteName: 'Leeds' }).words, 'A 3.50 Galaxy donut, takeaway at Leeds: VAT 0.00 (Zero Rate).');
  assert.equal(vatExample({ product, taxByType: tbt, rates: [VAT, ZERO], orderType: 'collection', price: 3.5, siteName: 'Leeds' }).words, 'A 3.50 Galaxy donut, collection at Leeds: VAT 0.00 (Zero Rate).', 'collection reads Takeaway');
  assert.equal(vatExample({ product, taxByType: tbt, rates: [VAT, ZERO], orderType: 'dine-in', price: 3.5, siteName: 'Leeds' }).words, 'A 3.50 Galaxy donut, eat in at Leeds: VAT 0.58 (VAT, 20%).');
  assert.equal(vatExample({ product, taxByType: tbt, kept: { collection: 'v' }, rates: [VAT, ZERO], orderType: 'collection', price: 3.5, siteName: 'Leeds' }).rate.id, 'v', "the site's own collection key wins over the alias");
  assert.match(vatExample({ product, taxByType: tbt, rates: [VAT], orderType: 'takeaway', price: 3.5, siteName: 'Leeds' }).words, /Leeds has no Zero Rate at 0%/);
  assert.match(vatExample({ product, taxByType: tbt, rates: null, siteName: 'Leeds' }).words, /Reading Leeds/);
});

test('the status bar: live, a draft with its count, a scheduled push read only', () => {
  assert.equal(statusBar({}).state, 'live');
  assert.match(statusBar({}).words, /nothing reaches the tills until you publish/);
  const d = statusBar({ working: { status: 'draft', title: 'Changes 17 Oct 14:05' }, rows: [1, 2, 3] });
  assert.deepEqual([d.state, d.title, d.words], ['draft', 'Draft "Changes 17 Oct 14:05"', '3 changes, not on the tills yet.']);
  const s = statusBar({ working: { status: 'scheduled', title: 'Christmas' }, when: 'Mon 1 Dec 06:00' });
  assert.equal(s.state, 'scheduled');
  assert.match(s.words, /As it will be on Mon 1 Dec 06:00/);
  assert.match(whyReadOnly({ canEdit: true, working: { status: 'scheduled' } }), /Read only while viewing a scheduled push/);
  assert.equal(whyReadOnly({ canEdit: true, working: null }), null);
  assert.match(whyReadOnly({ canEdit: false }), /look but not change/);
});

test('draft names carry the time; the guide has four steps and remembers being closed (and survives no storage)', () => {
  assert.match(draftTitle(new Date(2026, 9, 17, 14, 5)), /^Changes 17 Oct 14:05$/);
  assert.equal(GUIDE_STEPS.length, 4);
  const mem = new Map();
  const store = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) };
  assert.equal(guideClosed('m1', store), false);
  setGuideClosed('m1', true, store);
  assert.equal(guideClosed('m1', store), true);
  const broken = { getItem: () => { throw new Error('private'); }, setItem: () => { throw new Error('private'); } };
  assert.equal(guideClosed('m1', broken), false);
  assert.doesNotThrow(() => setGuideClosed('m1', true, broken));
  assert.equal(cellNoteWords({ product: 'Latte', site: 'Leeds', active: false }), 'Latte turned off at Leeds (in the draft).');
});

test('the grid VAT view: the group\'s VAT by order type, else its own VAT; a site that keeps its own shows that', async () => {
  const { vatCell } = await import('./msmOrderTypes.js');
  const p = { tax_rate_name: 'VAT', tax_rate_percent: 20, tax_by_type: { takeaway: { name: 'Zero Rate', percent: 0 } } };
  assert.deepEqual(vatCell(p, null, null, 'takeaway'), { words: 'Zero Rate 0%', byType: true, own: false });
  assert.deepEqual(vatCell(p, null, null, 'dine-in'), { words: 'VAT 20%', byType: false, own: false });
  assert.equal(vatCell({ tax_rate_percent: 20, tax_rate_name: 'VAT' }, p, null, 'takeaway').words, 'Zero Rate 0%', 'a size reads its product\'s');
  assert.deepEqual(vatCell(p, null, { kept: { tax_overrides: { takeaway: 'v' } } }, 'takeaway', [VAT]), { words: 'VAT 20%', own: true, byType: true });
  assert.equal(vatCell(p, null, { kept: { tax_overrides: { takeaway: false } } }, 'takeaway').words, 'VAT 20%', 'no key at that site: the product\'s VAT');
  assert.equal(vatCell(p, null, { kept: { tax_overrides: { takeaway: null } } }, 'takeaway').words, "Site's default VAT");
  assert.equal(vatCell(p, null, { kept: { tax_overrides: { counter: 'z' } } }, 'takeaway').own, false, 'other keys never count');
});

test('a site\'s menu times in words, read as the tills read them', async () => {
  const { menuTimesWords } = await import('./msmStatus.js');
  assert.equal(menuTimesWords({}), 'All day, every day');
  assert.equal(menuTimesWords({ schedule: { from: '16:00', to: '23:00', days: [] } }), '16:00 to 23:00, every day');
  assert.equal(menuTimesWords({ schedule: { from: '07:00', to: '11:30', days: [1, 2, 3, 4, 5] } }), '07:00 to 11:30, Mon to Fri');
  assert.equal(menuTimesWords({ schedule: { days: ['6', '7'] } }), 'All day, Sat, Sun');
  assert.equal(menuTimesWords({ schedule: { from: '22:00', to: '02:00', days: [1, 2, 3, 4, 5, 6, 7] } }), '22:00 to 02:00, every day');
});
