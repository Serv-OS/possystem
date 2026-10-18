// Multi site menu round 2: Review and publish helpers (src/lib/msm/msmPublishHelp.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clockOf, tradingWords, optionOffFix, healthProduct } from './msmPublishHelp.js';

test('trading words name each site with its own clock', () => {
  const rows = [
    { location_id: 'l1', trading: true, local_time: '2026-10-17T14:05:22.1' },
    { location_id: 'l2', trading: false, local_time: '2026-10-17 23:10:00' },
    { location_id: 'l3', trading: true, local_time: null },
  ];
  const t = tradingWords(rows, { l1: 'Leeds', l2: 'Headingley', l3: 'Barnsley' }, ['l1', 'l2']);
  assert.equal(t.words, 'Leeds is trading now (14:05 there). Headingley looks quiet (23:10 there).');
  assert.deepEqual(t.busy, ['Leeds']);
  assert.equal(clockOf('nope'), null);
  assert.match(tradingWords(null).words, /could not check/);
  assert.equal(tradingWords([], {}).words, '');
});

test('Turn the option off there too: the group menu\'s option at that site only', () => {
  const central = {
    groupSites: [{ group_id: 'g1', location_id: 'l1', venue_group_id: 'mgd-milk' }, { group_id: 'g1', location_id: 'l2', venue_group_id: 'mgd-milk_2' }],
    options: [{ id: 'o1', group_id: 'g1' }, { id: 'o2', group_id: 'g1' }],
    optionSites: [
      { option_id: 'o1', location_id: 'l1', venue_option_id: 'opt-coco', active: true },
      { option_id: 'o1', location_id: 'l2', venue_option_id: 'opt-coco', active: true },
      { option_id: 'o2', location_id: 'l1', venue_option_id: 'opt-oat', active: true },
    ],
  };
  assert.deepEqual(optionOffFix(central, 'l1', 'mgd-milk', ['opt-coco', 'opt-own']), [
    { target: 'modifier_option_site', entity_id: 'o1', location_id: 'l1', op: 'update', after: { active: false }, before: { active: true } },
  ]);
  assert.deepEqual(optionOffFix(central, 'l1', 'mgd-other', ['opt-coco']), []);
});

test('a health line names its product for [Open product]', () => {
  const central = { products: [{ id: 'p1', name: 'Latte' }] };
  assert.equal(healthProduct(central, { productId: 'p1' }).name, 'Latte');
  assert.equal(healthProduct(central, { productId: 'gone' }), null);
  assert.equal(healthProduct(central, {}), null);
});

test('the HubRise reminder fires for product, option group and VAT changes, not for a menu name', async () => {
  const { hubriseReminder } = await import('./msmPublishHelp.js');
  assert.match(hubriseReminder([{ target: 'modifier_option_site', op: 'update', after: { price: 0.6 } }]), /push the catalogue again/);
  assert.match(hubriseReminder([{ target: 'product', op: 'update', after: { tax_by_type: {} } }]), /HubRise/);
  assert.equal(hubriseReminder([{ target: 'menu', op: 'update', after: { use_name_everywhere: true } }]), null);
  assert.equal(hubriseReminder([]), null);
});
