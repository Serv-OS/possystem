// Multi site menu ROUND 2: the changes the Option groups screen stages (msmGroupEdit.js), the
// sentences before Add to draft and Publish (msmSummary.js), the warnings that need a tick
// (msmRisk.js) and the sharing engine's target side gate (msmManaged.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proposeImport, buildCentral } from '../../../supabase/functions/_shared/msmImport.js';
import { checkChange } from '../../../supabase/functions/_shared/msmModel.js';
import {
  ruleWords, newGroupChanges, groupUpdate, removeGroupChanges, newOptionChanges, optionSiteChange, optionUpdate, setEveryPrice,
  newSubItemOption, addGroupToProducts, copyGroupChanges, whereUsed, optionsUsingProduct, groupSiteKeep, reorderOptions,
} from './msmGroupEdit.js';
import { summarise, publishButtonWords, siteList } from './msmSummary.js';
import { riskChecks, moreThan20, allTicked } from './msmRisk.js';
import { readManagedAt, gateFor, setMsmManaged, isMsmManagedGroup, resetMsmManagedForTest } from './msmManaged.js';
import { fakeClient } from './fakeClient.js';
import { A, B, C, idGen } from './msmFixture.js';
import { groupSites } from './msmGroupFixture.js';

function ctx() {
  const sites = groupSites();
  const { central } = buildCentral(proposeImport(sites, { idGen: idGen() }), sites, {}, { idGen: idGen('g') });
  central.menu = { id: 'm1', name: 'Group menu', refreshed_at: 'x' };
  const G = (n) => central.groups.find((g) => g.name === n);
  const O = (n, g = 'Milk') => central.options.find((o) => o.name === n && o.group_id === G(g).id);
  const P = (n) => central.products.find((p) => p.name === n);
  return { central, eff: central, G, O, P };
}
const names = { [A]: 'Leeds', [B]: 'Barnsley', [C]: 'Headingley' };

test('rule words: exactly, up to, between, as many as they like', () => {
  assert.equal(ruleWords(1, 1), 'Choose exactly 1');
  assert.equal(ruleWords(0, 3), 'Choose up to 3');
  assert.equal(ruleWords(1, 3), 'Choose between 1 and 3');
  assert.equal(ruleWords(0, 99), 'Choose as many as they like');
});

test('a new group and a new option: an explicit option row for EVERY site where the group is (no row would mean off)', () => {
  const c = ctx();
  const g = newGroupChanges(c, { id: 'g-new', name: 'Sauces', min: 0, max: 2 });
  assert.equal(g[0].after.name, 'Sauces');
  const o = newOptionChanges(c, { id: 'o-new', groupId: c.G('Milk').id, name: 'Soya', price: 0.45, sites: { [B]: { active: false } } });
  assert.equal(o.filter((x) => x.target === 'modifier_option_site').length, 3);
  assert.equal(o.find((x) => x.location_id === B).after.active, false);
  for (const ch of [...g, ...o]) assert.ok(checkChange(ch).ok, JSON.stringify(ch));
});

test('"Same choice more than once" sets must choose = up to; only what changed is staged', () => {
  const c = ctx();
  const u = groupUpdate(c, c.G('Tea choice').id, { selection_type: 'quantity', max: 3 });
  assert.deepEqual(u[0].after, { selection_type: 'quantity', min: 3, max: 3 });
  assert.deepEqual(groupUpdate(c, c.G('Tea choice').id, { name: 'Tea choice' }), []);
});

test('an option price at a site: equal to the default follows it (null); a site with no row gets one', () => {
  const c = ctx();
  const oat = c.O('Oat milk');
  assert.deepEqual(optionSiteChange(c, oat.id, A, { price: 0.5 })[0].after, { price: 0.5 });
  assert.deepEqual(optionSiteChange(c, oat.id, A, { price: 0.4 }), [], 'already follows 0.40');
  assert.deepEqual(optionUpdate(c, oat.id, { price: 0.45, group_id: 'x' })[0].after, { price: 0.45 }, 'an option never moves group');
});

test('remove a group: off every product too, never a delete', () => {
  const c = ctx();
  const r = removeGroupChanges(c, c.G('Milk').id);
  assert.equal(r[0].op, 'remove');
  assert.ok(r.some((x) => x.target === 'product' && x.after.modifier_groups.every((a) => a.groupId !== c.G('Milk').id)));
});

test('a new sub item from the group editor: only an option (hidden everywhere), or also sold on its own (a product at every site)', () => {
  const c = ctx();
  const only = newSubItemOption(c, { productId: 'p-sub', optionId: 'o-sub', groupId: c.G('Milk').id, name: 'Almond milk', price: 0.5 });
  assert.equal(only[0].after.type, 'subitem');
  assert.equal(only[0].after.sold_alone, false);
  assert.deepEqual(only[0].after.visibility, { pos: false, kiosk: false, online: false, onlineDelivery: false });
  assert.equal(only.filter((x) => x.target === 'product_site').length, 0, 'publish adds it where an option needs it');
  const alone = newSubItemOption(c, { productId: 'p-sub2', optionId: 'o-sub2', groupId: c.G('Milk').id, name: 'Donut', price: 0, productPrice: 1.5, soldAlone: true, categoryId: 'cat' });
  assert.equal(alone.filter((x) => x.target === 'product_site').length, 3);
  assert.equal(alone[0].after.default_price, 1.5);
});

test('put a group on products: a product with sizes means its sizes; copy a group; where used; options using a sub item', () => {
  const c = ctx();
  const ch = addGroupToProducts(c, c.G('Tea choice').id, [c.P('Latte').id]);
  assert.deepEqual(ch.map((x) => x.entity_id), [c.P('Large latte').id], 'the size, not the main product');
  const cp = copyGroupChanges(c, c.G('Milk').id, { groupId: 'g-copy', optionId: (id) => `copy-${id}` });
  assert.equal(cp[0].after.name, 'Milk (copy)');
  assert.ok(cp.filter((x) => x.target === 'modifier_option').length >= 3);
  assert.match(whereUsed(c, c.G('Milk').id).words, /Used by \d+ products?/);
  assert.equal(optionsUsingProduct(c, c.P('Oat milk').id)[0].group.name, 'Milk');
  assert.deepEqual(groupSiteKeep(c, c.G('Tea choice').id, B, 'max', undefined)[0].after, { kept: {} });
  assert.deepEqual(reorderOptions(c, c.G('Milk').id, [c.O('Coconut milk').id, c.O('Oat milk').id]).map((x) => x.after.sort_order), [0, 1]);
  assert.ok(setEveryPrice(c, c.G('Milk').id, 0.5).some((x) => x.target === 'modifier_option_site' && x.after.price === null), 'Barnsley\'s own 0.00 follows again');
});

test('the summary: sentences grouped by what and where', () => {
  const c = ctx();
  const changes = [
    { target: 'product_site', entity_id: c.P('Latte').id, location_id: A, op: 'update', after: { price: 3.4 }, before: { price: 3 } },
    { target: 'product_site', entity_id: c.P('Cola').id, location_id: B, op: 'update', after: { price: 2.5 }, before: { price: null } },
    { target: 'modifier_option', entity_id: c.O('Oat milk').id, op: 'update', after: { price: 0.6 }, before: { price: 0.4 } },
    { target: 'product_site', entity_id: c.P('Mocha').id, location_id: C, op: 'update', after: { active: false }, before: { active: true } },
    { target: 'product', entity_id: c.P('Donut').id, op: 'update', after: { tax_by_type: { takeaway: { name: 'Zero Rate', percent: 0 }, delivery: { name: 'Zero Rate', percent: 0 } } }, before: { tax_by_type: { takeaway: { name: 'Zero Rate', percent: 0 } } } },
  ];
  const s = summarise(changes, c.central, { siteNames: names, when: 'Mon 20 Oct 06:00' });
  assert.ok(s.includes('2 prices go up at Leeds and Barnsley from Mon 20 Oct 06:00.'), s.join(' | '));
  assert.ok(s.includes('Oat milk goes from 0.40 to 0.60 in Milk at every site from Mon 20 Oct 06:00.'));
  assert.ok(s.includes('Mocha is turned off at Headingley.'));
  assert.ok(s.includes('Donut: delivery VAT becomes Zero Rate at every site.'));
  assert.equal(publishButtonWords({ sites: 6 }), 'Publish to 6 sites now');
  assert.equal(publishButtonWords({ when: 'Mon 20 Oct 06:00' }), 'Schedule for Mon 20 Oct 06:00');
  assert.equal(siteList(['a', 'b', 'c', 'd', 'e']), 'a, b and 3 more');
});

test('risks: 20% exactly needs no tick, 20.01% does; zero; VAT; a seller removed; trading; overwrites; made required', () => {
  assert.equal(moreThan20(300, 360), false, 'exactly 20%');
  assert.equal(moreThan20(10000, 12001), true, '20.01%');
  const c = ctx();
  const latteA = c.central.productSites.find((r) => r.product_id === c.P('Latte').id && r.location_id === A);
  const changes = [
    { target: 'product_site', entity_id: c.P('Latte').id, location_id: A, op: 'update', after: { price: 3.8 }, before: { price: 3 } },
    { target: 'product_site', entity_id: c.P('Cola').id, location_id: B, op: 'update', after: { price: 0 }, before: { price: null } },
    { target: 'product', entity_id: c.P('Donut').id, op: 'update', after: { tax_by_type: null }, before: { tax_by_type: { takeaway: { name: 'Zero Rate', percent: 0 } } } },
    { target: 'product_site', entity_id: c.P('Latte').id, location_id: A, op: 'update', after: { active: false }, before: { active: true } },
    { target: 'modifier_group', entity_id: c.G('Milk').id, op: 'update', after: { min: 1 }, before: { min: 0 } },
  ];
  const sold = new Map([[`${A}|${latteA.venue_item_id}`, 214]]);
  const r = riskChecks(changes, c.central, sold, [{ location_id: A, trading: true }, { location_id: B, trading: false }], { siteNames: names, publishNow: true, sitesReached: [A, B], drift: { [A]: 3 } });
  const codes = r.map((x) => x.code);
  for (const k of ['big_price', 'zero_price', 'vat', 'removes_seller', 'trading', 'overwrites', 'made_required']) assert.ok(codes.includes(k), `${k}: ${codes.join(',')}`);
  assert.ok(r.some((x) => x.words === 'Latte goes from 3.00 to 3.80 at Leeds (up 27%). I meant this.'));
  assert.ok(r.some((x) => /Latte sold 214 times at Leeds in the last 7 days and will come off the till\./.test(x.words)));
  assert.ok(r.some((x) => x.words === 'Leeds is trading now. Tills change between sales.' && x.action === 'schedule_tonight'));
  assert.ok(r.some((x) => x.words === 'This publish overwrites 3 changes made at Leeds.'));
  assert.equal(allTicked(r, new Set(r.map((x) => x.key))), true);
  assert.equal(allTicked(r, new Set()), false);
  // When the reads failed, the risk is shown anyway.
  const blind = riskChecks([changes[3]], c.central, null, null, { siteNames: names, publishNow: true });
  assert.ok(blind.some((x) => /We could not check sales, so please check/.test(x.words)));
  assert.ok(blind.some((x) => x.code === 'trading' && /could not check which sites are trading/.test(x.words)));
});

test('THE TARGET SIDE GATE: the managed groups and products at a venue, read afresh; a failed read blocks only when the company may be on', async () => {
  resetMsmManagedForTest();
  const on = fakeClient({}, { rpcs: { msm_managed_at: () => ({ data: { on: true, groups: [{ location_id: B, venue_group_id: 'mgd-milk_b' }], items: [{ location_id: B, venue_item_id: 'm-oat_b' }] }, error: null }) } });
  const r = await readManagedAt(on, [B]);
  const g = gateFor(r, B);
  assert.equal(g.blocked, false);
  assert.ok(g.groups.has('mgd-milk_b') && g.items.has('m-oat_b'));
  assert.equal(gateFor(r, C).groups.size, 0, 'nothing managed at another venue');
  // A failed read now that the company is known to be on: copy nothing there.
  const broken = fakeClient({}, { rpcs: { msm_managed_at: () => ({ data: null, error: { code: '57014', message: 'canceling statement' } }) } });
  assert.equal(gateFor(await readManagedAt(broken, [B]), B).blocked, true);
  // Before 20261017c has run: exactly as before.
  const old = fakeClient({}, {});
  assert.equal(gateFor(await readManagedAt(old, [B]), B).blocked, false);
  // A company known to be off: a failed read lets the engine through, as before.
  resetMsmManagedForTest();
  const off = fakeClient({}, { rpcs: { msm_managed_at: () => ({ data: { on: false, groups: [], items: [] }, error: null }) } });
  await readManagedAt(off, [B]);
  assert.equal(gateFor(await readManagedAt(broken, [B]), B).blocked, false);
  resetMsmManagedForTest();
  assert.equal(gateFor(await readManagedAt(broken, [B]), B).blocked, true, 'not known yet: fail closed');
  setMsmManaged(A, new Map(), new Map([['mgd-milk', { groupId: 'g', kept: [], optionIds: ['opt-oat'] }]]), true);
  assert.equal(isMsmManagedGroup('mgd-milk'), true);
  assert.equal(isMsmManagedGroup('mgd-own'), false);
  resetMsmManagedForTest();
});

// ── Round 2 review (17 Oct 2026) ────────────────────────────────────────────

test('review: a tick holds the value it confirmed: a new price or VAT needs a new tick', () => {
  const c = ctx();
  const ch = (v) => [{ target: 'product_site', entity_id: c.P('Latte').id, location_id: A, op: 'update', after: { price: v }, before: { price: 3 } }];
  const k1 = riskChecks(ch(3.8), c.central, null, null, { siteNames: names })[0].key;
  const k2 = riskChecks(ch(38), c.central, null, null, { siteNames: names })[0].key;
  assert.notEqual(k1, k2);
  const vat = (pct) => [{ target: 'product', entity_id: c.P('Donut').id, op: 'update', after: { tax_by_type: { takeaway: { name: 'Zero Rate', percent: pct } } }, before: { tax_by_type: null } }];
  assert.notEqual(riskChecks(vat(0), c.central)[0].key, riskChecks(vat(5), c.central)[0].key);
});

test('review: order type prices get a tick and a sentence; a first VAT by order type ticks at Publish too', () => {
  const c = ctx();
  const latte = c.P('Latte');
  const ch = [{ target: 'product', entity_id: latte.id, op: 'update', after: { default_channels: { takeaway: 35 } }, before: { default_channels: { takeaway: 3.2 } } }];
  const r = riskChecks(ch, c.central, null, null, { siteNames: names });
  assert.ok(r.some((x) => x.code === 'big_price' && /Latte takeaway price goes from 3\.20 to 35\.00 at every site that follows it/.test(x.words)), JSON.stringify(r));
  const z = riskChecks([{ ...ch[0], after: { default_channels: { takeaway: 0 } } }], c.central);
  assert.ok(z.some((x) => x.code === 'zero_price'));
  assert.ok(summarise(ch, c.central, { siteNames: names }).some((x) => /Latte: Takeaway price becomes 35\.00/.test(x)));
  const site = [{ target: 'product_site', entity_id: latte.id, location_id: A, op: 'update', after: { channel_prices: { dineIn: 3.2 } }, before: { channel_prices: null } }];
  assert.ok(summarise(site, c.central, { siteNames: names }).some((x) => x === 'Latte: Eat in price becomes 3.20 at Leeds.'));
  // Publish passes the menu AFTER the draft: a product with no VAT by order type before still ticks.
  const donut = c.P('Cola');
  const first = [{ target: 'product', entity_id: donut.id, op: 'update', after: { tax_by_type: { takeaway: { name: 'Zero Rate', percent: 0 } } }, before: { tax_by_type: null } }];
  const after = { ...c.central, products: c.central.products.map((p) => (p.id === donut.id ? { ...p, tax_by_type: first[0].after.tax_by_type } : p)) };
  assert.ok(riskChecks(first, after).some((x) => x.code === 'vat'));
});

test('review: a site giving back its own VAT by order type needs the VAT tick, in words', () => {
  const c = ctx();
  const donut = c.P('Donut');
  const ch = [{ target: 'product_site', entity_id: donut.id, location_id: B, op: 'update', after: { kept: {} }, before: { kept: { tax_overrides: { takeaway: false } } } }];
  const r = riskChecks(ch, c.central, null, null, { siteNames: names });
  assert.ok(r.some((x) => x.code === 'vat' && /Barnsley stops using its own takeaway VAT \(the product's own VAT\) for Donut and uses the group's \(Zero Rate \(0%\)\)/.test(x.words)), JSON.stringify(r));
  assert.ok(summarise(ch, c.central, { siteNames: names }).some((x) => /Barnsley uses the group's VAT by order type for Donut/.test(x)));
});

test('review: every kind of change has at least one sentence before Add to draft and Publish', () => {
  const c = ctx();
  const P = c.P('Latte').id, G = c.G('Milk').id, O = c.O('Oat milk').id;
  const cases = [
    { target: 'product', entity_id: P, op: 'update', after: { name: 'Latte 2', image: 'x', allergens: ['milk'] }, before: {} },
    { target: 'product', entity_id: P, op: 'update', after: { modifier_groups: [] }, before: { modifier_groups: [{ groupId: G }] } },
    { target: 'product_site', entity_id: P, location_id: A, op: 'update', after: { kept: {} }, before: { kept: { cat: 'x' } } },
    { target: 'modifier_group', entity_id: G, op: 'update', after: { name: 'Milks' }, before: { name: 'Milk' } },
    { target: 'modifier_group', entity_id: G, op: 'update', after: { selection_type: 'multiple' }, before: { selection_type: 'single' } },
    { target: 'modifier_group_site', entity_id: G, location_id: B, op: 'update', after: { kept: {} }, before: { kept: { max: 2 } } },
    { target: 'modifier_option', entity_id: O, op: 'update', after: { name: 'Oat drink' }, before: { name: 'Oat milk' } },
    { target: 'modifier_option', entity_id: O, op: 'update', after: { sub_group_id: G }, before: { sub_group_id: null } },
    { target: 'modifier_option', entity_id: O, op: 'update', after: { sort_order: 3 }, before: { sort_order: 0 } },
    { target: 'modifier_option_site', entity_id: O, location_id: C, op: 'create', after: { active: true, price: null }, before: {} },
    { target: 'modifier_option_site', entity_id: O, location_id: B, op: 'update', after: { kept: {} }, before: { kept: { name: 'Oat' } } },
    { target: 'category', entity_id: 'cat-new', op: 'create', after: { label: 'Christmas' }, before: {} },
    { target: 'menu', entity_id: 'm', op: 'update', after: { name: 'Menu 2' }, before: {} },
  ];
  for (const ch of cases) assert.ok(summarise([ch], c.central, { siteNames: names }).length >= 1, JSON.stringify(ch));
  assert.ok(summarise([cases[1]], c.central, { siteNames: names }).some((x) => /Milk is taken off Latte/.test(x)));
});
