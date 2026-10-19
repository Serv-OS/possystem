// Multi site menu ROUND 2: central option groups, sub items and VAT per order type, proved on the
// round 2 fixture (msmGroupFixture.js): the import, the planner (supabase/functions/_shared/msmPlan.js),
// the health check, drift, undo and the price tool for options.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proposeImport, buildCentral, settleKept } from '../../../supabase/functions/_shared/msmImport.js';
import { planSite, touchedFromChanges, lineWords, groupsNeedRefresh } from '../../../supabase/functions/_shared/msmPlan.js';
import { applyChanges, siteDrift, keepVenueChanges, bringOptionIn, undoChanges, sitesReached } from '../../../supabase/functions/_shared/msmDiff.js';
import { checkSite, checkCentral } from '../../../supabase/functions/_shared/msmHealth.js';
import { applyPriceChange } from '../../../supabase/functions/_shared/msmPrice.js';
import { overlaps } from '../../../supabase/functions/_shared/msmSchedule.js';
import { newOptionId, hex12 } from '../../../supabase/functions/_shared/msmModel.js';
import { A, B, C, ORG, idGen } from './msmFixture.js';
import { groupVenues, groupSites, S, ZERO, VAT, PROFILE_A } from './msmGroupFixture.js';

function setup() {
  const v = groupVenues();
  const sites = groupSites(v);
  const built = buildCentral(proposeImport(sites, { idGen: idGen() }), sites, {}, { idGen: idGen('g') });
  const central = built.central;
  central.menu = { id: '99999999-0000-4000-8000-000000000001', name: 'Group menu', description: '', use_name_everywhere: false, refreshed_at: '2026-10-17' };
  const P = (name) => central.products.find((p) => p.name === name);
  const G = (name) => central.groups.find((g) => g.name === name);
  const O = (name, group = 'Milk') => central.options.find((o) => o.name === name && o.group_id === G(group).id);
  const OS = (name, loc, group) => central.optionSites.find((r) => r.option_id === O(name, group).id && r.location_id === loc);
  return { v, sites, built, central, P, G, O, OS };
}
const plan = (central, changes, loc, venue) => planSite({ central: applyChanges(central, changes).central, touched: touchedFromChanges(changes), locationId: loc, orgId: ORG, venue });
const after = (venue, p) => ({ ...venue, items: p.applied.items, groups: p.applied.groups });
const group = (p, id) => p.applied.groups.find((g) => g.id === id);

// ── The import ──────────────────────────────────────────────────────────────

test('import: Milk in three shapes comes in as ONE group; options are the union, the most common price is the default', () => {
  const { built, central, G, O, OS } = setup();
  assert.ok(built.check.ok, JSON.stringify(built.check.problems));
  assert.equal(built.check.writes, 0, 'publishing now would change 0 things at 0 sites');
  assert.deepEqual(central.groups.map((g) => g.name).sort(), ['Milk', 'Tea choice', 'Which syrup']);
  assert.equal(central.groupSites.filter((r) => r.group_id === G('Milk').id).length, 3);
  assert.equal(O('Oat milk').price, 0.4);
  assert.equal(O('Coconut milk').price, 0.5, 'a tie takes the master site\'s price');
  assert.equal(OS('Coconut milk', B).price, 0, 'site B charges its own 0.00');
  assert.equal(OS('Coconut milk', C).active, false, 'site C has the group but not the option: off (an explicit row)');
  assert.equal(OS('Coconut milk', C).venue_option_id, null);
  assert.equal(OS('Oat milk', C).venue_option_id, 'opt-oat', 'the venue option id is kept for ever');
  assert.deepEqual(G('Milk').options, [], 'the old jsonb list is not used');
});

test('import: a group rule one site differs on is KEPT by that site; "Then ask" groups come in as groups', () => {
  const { central, G, O } = setup();
  const tea = central.groupSites.find((r) => r.group_id === G('Tea choice').id && r.location_id === B);
  assert.deepEqual(tea.kept, { max: 2 });
  assert.equal(G('Tea choice').max, 1);
  assert.equal(O('Syrup').sub_group_id, G('Which syrup').id, 'the option asks the central group next');
  assert.equal(central.groupSites.filter((r) => r.group_id === G('Which syrup').id).length, 1);
});

test('import: VAT by order type: the most common becomes the group\'s; a site keeps its own key, its null and its other keys', () => {
  const { central, P } = setup();
  assert.deepEqual(P('Donut').tax_by_type, { takeaway: { name: 'Zero Rate', percent: 0 } });
  const b = central.productSites.find((r) => r.product_id === P('Donut').id && r.location_id === B);
  assert.deepEqual(b.kept.tax_overrides, { takeaway: false, counter: VAT.B, 'drive-thru': null }, 'no takeaway key at B (false), its counter key and explicit null kept as they are');
  const a = central.productSites.find((r) => r.product_id === P('Donut').id && r.location_id === A);
  assert.equal(a.kept.tax_overrides, undefined);
});

test('import: an option a site names differently or links differently is kept, so the self check still says zero', () => {
  const v = groupVenues();
  v[B].groups[0].options[0].name = 'Oat';                       // the same sub item, another name
  delete v[B].groups[0].options[1].itemId;                       // Coconut as free text at B
  const sites = groupSites(v);
  const built = buildCentral(proposeImport(sites, { idGen: idGen() }), sites, {}, { idGen: idGen('g') });
  assert.ok(built.check.ok, JSON.stringify(built.check.problems));
  const milk = built.central.groups.find((g) => g.name === 'Milk');
  const oat = built.central.options.find((o) => o.group_id === milk.id && o.name === 'Oat milk');
  const coco = built.central.options.find((o) => o.group_id === milk.id && o.name === 'Coconut milk');
  assert.deepEqual(built.central.optionSites.find((r) => r.option_id === oat.id && r.location_id === B).kept, { name: 'Oat' });
  assert.deepEqual(built.central.optionSites.find((r) => r.option_id === coco.id && r.location_id === B).kept, { item_link: false });
});

// ── Options one by one ──────────────────────────────────────────────────────

test('an option price change at one site writes ONLY that option, by its venue id; options the group menu does not know stay put', () => {
  const { v, central, O } = setup();
  v[A].groups[0].options.splice(1, 0, { id: 'opt-hemp', name: 'Hemp milk', price: 0.6 });      // added at the venue later
  const p = plan(central, [{ target: 'modifier_option_site', entity_id: O('Oat milk').id, location_id: A, op: 'update', after: { price: 0.55 }, before: { price: null } }], A, v[A]);
  assert.deepEqual(p.writes.groups.update, [{ id: 'mgd-milk', set: {}, options: [{ op: 'patch', id: 'opt-oat', set: { price: 0.55 } }] }]);
  assert.deepEqual(group(p, 'mgd-milk').options.map((o) => [o.id, o.price]), [['opt-oat', 0.55], ['opt-hemp', 0.6], ['opt-coco', 0.5], ['opt-syrup', 0]]);
  assert.equal(p.writes.items.update.length, 0);
  assert.match(lineWords(p.lines[0], { [central.groups[0].id]: 'Milk' }), /Oat milk: 0\.40 to 0\.55/);
});

test('an option default price moves every site that follows it, never a site with its own price', () => {
  const { v, central, O } = setup();
  const ch = [{ target: 'modifier_option', entity_id: O('Coconut milk').id, op: 'update', after: { price: 0.6 }, before: { price: 0.5 } }];
  assert.deepEqual(plan(central, ch, A, v[A]).writes.groups.update[0].options, [{ op: 'patch', id: 'opt-coco', set: { price: 0.6 } }]);
  assert.equal(plan(central, ch, B, v[B]).empty, true, 'site B keeps its own 0.00');
  assert.equal(plan(central, ch, C, v[C]).empty, true, 'off at site C');
});

test('off then back on keeps the SAME venue id, in its place', () => {
  const { v, central, O } = setup();
  const off = plan(central, [{ target: 'modifier_option_site', entity_id: O('Coconut milk').id, location_id: A, op: 'update', after: { active: false }, before: { active: true } }], A, v[A]);
  assert.deepEqual(off.writes.groups.update[0].options, [{ op: 'drop', id: 'opt-coco' }]);
  const venue2 = after(v[A], off);
  const central2 = applyChanges(central, [{ target: 'modifier_option_site', entity_id: O('Coconut milk').id, location_id: A, op: 'update', after: { active: false } }]).central;
  const on = plan(central2, [{ target: 'modifier_option_site', entity_id: O('Coconut milk').id, location_id: A, op: 'update', after: { active: true }, before: { active: false } }], A, venue2);
  const add = on.writes.groups.update[0].options[0];
  assert.equal(add.op, 'add');
  assert.equal(add.entry.id, 'opt-coco', 'the same id comes back');
  assert.equal(add.after, 'opt-oat', 'right after the option before it in the group menu\'s order');
  assert.deepEqual(group(on, 'mgd-milk').options.map((o) => o.id), ['opt-oat', 'opt-coco', 'opt-syrup']);
  assert.deepEqual(on.writes.maps.options, [], 'its id was already recorded');
});

test('a new option gets opt-msm-<12 hex>, recorded centrally; an entry already carrying it is adopted, never doubled', () => {
  const { v, central, G } = setup();
  const id = 'a1b2c3d4-0000-4000-8000-0000000000aa';
  const ch = [
    { target: 'modifier_option', entity_id: id, op: 'create', after: { group_id: G('Milk').id, name: 'Soya milk', price: 0.45, sort_order: 9 } },
    { target: 'modifier_option_site', entity_id: id, location_id: A, op: 'create', after: { active: true, price: null } },
    { target: 'modifier_option_site', entity_id: id, location_id: B, op: 'create', after: { active: false, price: null } },
  ];
  const p = plan(central, ch, A, v[A]);
  const add = p.writes.groups.update[0].options.find((o) => o.op === 'add');
  assert.equal(add.entry.id, `opt-msm-${hex12(id)}`);
  assert.equal(add.entry.id, newOptionId(id));
  assert.deepEqual(p.writes.maps.options, [{ option_id: id, venue_option_id: newOptionId(id) }]);
  assert.equal(plan(central, ch, B, v[B]).empty, true, 'off at B: nothing written there');
  // The same version again on the venue as it now is: one option, not two.
  const again = plan(central, ch, A, after(v[A], p));
  assert.equal(group(again, 'mgd-milk').options.filter((o) => o.id === newOptionId(id)).length, 1);
  assert.equal(again.writes.groups.update.length, 0);
  assert.deepEqual(again.writes.maps.options, [{ option_id: id, venue_option_id: newOptionId(id) }], 'adopted and recorded');
});

test('two options whose ids share their first 12 characters never share a venue id (the second gets the whole id)', () => {
  const { v, central, G } = setup();
  const one = 'f1000000-0000-4000-8000-00000000050a', two = 'f1000000-0000-4000-8000-0000000000a2';
  const ch = [
    { target: 'modifier_option', entity_id: one, op: 'create', after: { group_id: G('Milk').id, name: 'Soya', price: 0.45, sort_order: 5 } },
    { target: 'modifier_option_site', entity_id: one, location_id: A, op: 'create', after: { active: true } },
  ];
  const p1 = plan(central, ch, A, v[A]);
  const central1 = applyChanges(central, ch).central;
  central1.optionSites.find((r) => r.option_id === one && r.location_id === A).venue_option_id = newOptionId(one);
  const ch2 = [
    { target: 'modifier_option', entity_id: two, op: 'create', after: { group_id: G('Milk').id, name: 'Almond', price: 0.5, sort_order: 6 } },
    { target: 'modifier_option_site', entity_id: two, location_id: A, op: 'create', after: { active: true } },
  ];
  const p2 = plan(central1, ch2, A, after(v[A], p1));
  const add = p2.writes.groups.update[0].options;
  assert.equal(add.length, 1);
  assert.equal(add[0].op, 'add', 'never a patch of Soya\'s entry');
  assert.equal(add[0].entry.id, `opt-msm-${two.replace(/-/g, '')}`);
  assert.equal(group(p2, 'mgd-milk').options.find((o) => o.id === newOptionId(one)).name, 'Soya');
});

test('an option on at a site whose sub item is not there: the sub item is added there as option only, and recorded', () => {
  const { v, central, G, P } = setup();
  const id = 'a1b2c3d4-0000-4000-8000-0000000000bb';
  const ch = [
    { target: 'modifier_option', entity_id: id, op: 'create', after: { group_id: G('Milk').id, name: 'Coconut milk', price: 0.5, product_id: P('Coconut milk').id, sort_order: 9 } },
    { target: 'modifier_option_site', entity_id: id, location_id: C, op: 'create', after: { active: true } },
  ];
  const p = plan(central, ch, C, v[C]);
  const ins = p.writes.items.insert[0];
  assert.equal(ins.type, 'subitem');
  assert.equal(ins.sold_alone, false);
  assert.deepEqual(ins.visibility, { pos: false, kiosk: false, online: false, onlineDelivery: false });
  assert.equal(ins.cat, null);
  assert.deepEqual(p.writes.maps.items, [{ product_id: P('Coconut milk').id, venue_item_id: ins.id, active: true }], 'an option only product is "on" where an option needs it');
  assert.equal(p.writes.groups.update[0].options[0].entry.itemId, ins.id, 'never a missing or foreign item id');
  assert.equal(checkSite(p).blocking.length, 0, 'an option only sub item needs no category');
  assert.match(lineWords(p.lines.find((l) => l.column === '(new)')), /added here as a sub item for "Coconut milk"/);
});

test('a name a site keeps is never written; "Use the group\'s" writes it', () => {
  const v = groupVenues();
  v[B].groups[0].options[0].name = 'Oat';
  const sites = groupSites(v);
  const { central } = buildCentral(proposeImport(sites, { idGen: idGen() }), sites, {}, { idGen: idGen('g') });
  central.menu = { id: 'm', name: 'G', refreshed_at: 'x' };
  const milk = central.groups.find((g) => g.name === 'Milk');
  const oat = central.options.find((o) => o.group_id === milk.id && o.name === 'Oat milk');
  const rename = [{ target: 'modifier_option', entity_id: oat.id, op: 'update', after: { name: 'Oat drink' }, before: { name: 'Oat milk' } }];
  assert.equal(plan(central, rename, B, v[B]).empty, true, 'site B keeps "Oat"');
  assert.deepEqual(plan(central, rename, A, v[A]).writes.groups.update[0].options, [{ op: 'patch', id: 'opt-oat', set: { name: 'Oat drink' } }]);
  const give = [{ target: 'modifier_option_site', entity_id: oat.id, location_id: B, op: 'update', after: { kept: {} }, before: { kept: { name: 'Oat' } } }];
  assert.deepEqual(plan(central, give, B, v[B]).writes.groups.update[0].options, [{ op: 'patch', id: 'opt-oat', set: { name: 'Oat milk' } }]);
});

test('a group rule: written as the till reads it (min_select mirrors min), never at a site that keeps its own', () => {
  const { v, central, G } = setup();
  const ch = [{ target: 'modifier_group', entity_id: G('Tea choice').id, op: 'update', after: { min: 1, max: 1 }, before: { min: 0, max: 1 } }];
  assert.deepEqual(plan(central, ch, A, v[A]).writes.groups.update, [{ id: 'mgd-tea', set: { min: 1, min_select: 1 }, options: [] }]);
  const b = plan(central, ch, B, v[B]);
  assert.deepEqual(b.writes.groups.update, [{ id: S('mgd-tea', B), set: { min: 1, min_select: 1 }, options: [] }], 'B keeps its own "up to 2", the minimum is the group\'s');
});

test('a group removed: never deleted; taken off the group menu\'s products; a site\'s own product keeps it (named)', () => {
  const { v, central, G } = setup();
  v[A].items.push({ ...v[A].items.find((i) => i.id === 'm-mocha'), id: 'l-own-a', name: 'House special', menu_name: 'House special', scope: 'local', assigned_modifier_groups: [{ groupId: 'mgd-tea' }] });
  const p = plan(central, [{ target: 'modifier_group', entity_id: G('Tea choice').id, op: 'remove', after: { archived: true } }], A, v[A]);
  assert.equal(p.writes.groups.update.length, 0, 'no group write');
  assert.deepEqual(p.writes.items.update, [{ id: 'm-tea', set: { assigned_modifier_groups: [] } }]);
  assert.ok(p.problems.some((x) => x.code === 'group_used_by_own' && /House special/.test(x.words)));
});

test('a change to a group a site\'s own product uses too says so (not blocking)', () => {
  const { v, central, O } = setup();
  v[A].items.push({ ...v[A].items.find((i) => i.id === 'm-mocha'), id: 'l-own-b', scope: 'local', assigned_modifier_groups: [{ groupId: 'mgd-milk' }] });
  const p = plan(central, [{ target: 'modifier_option', entity_id: O('Oat milk').id, op: 'update', after: { price: 0.45 }, before: { price: 0.4 } }], A, v[A]);
  const h = checkSite(p);
  assert.ok(h.ok);
  assert.ok(h.warnings.some((w) => w.code === 'group_shared_with_own'));
});

test('a new site: the "Then ask" group is made first and the option points at it; a loop is blocking', () => {
  const { central, G, O, P } = setup();
  const D = 'dddddddd-0000-4000-8000-0000000d0004';
  const blank = { locationId: D, menus: [], categories: [], items: [], links: [], groups: [], taxRates: [{ id: 'tr-d', name: 'VAT', rate: 20, active: true }], printRouting: { centres: [], routing: {} } };
  const ch = [
    { target: 'menu_site', entity_id: central.menu.id, location_id: D, op: 'create', after: { venue_menu_id: null } },
    { target: 'product_site', entity_id: P('Latte').id, location_id: D, op: 'create', after: { venue_item_id: `m-latte_${D.slice(-8)}`, active: true } },
    ...central.options.filter((o) => [G('Milk').id, G('Which syrup').id].includes(o.group_id)).map((o) => ({ target: 'modifier_option_site', entity_id: o.id, location_id: D, op: 'create', after: { active: true } })),
  ];
  const p = plan(central, ch, D, blank);
  const ids = p.writes.groups.insert.map((g) => g.name);
  assert.deepEqual(ids, ['Which syrup', 'Milk'], 'the nested group first');
  const milk = p.writes.groups.insert[1];
  assert.equal(milk.options.find((o) => o.name === 'Syrup').subGroupId, p.writes.groups.insert[0].id);
  // A loop: Which syrup asks Milk again.
  const loop = [...ch, { target: 'modifier_option', entity_id: O('Vanilla', 'Which syrup').id, op: 'update', after: { sub_group_id: G('Milk').id } }];
  const pl = plan(central, loop, D, blank);
  assert.ok(checkSite(pl).blocking.some((b) => b.code === 'then_ask_loop'));
  assert.ok(checkCentral(applyChanges(central, loop).central, touchedFromChanges(loop)).blocking.some((b) => b.code === 'then_ask_loop'));
});

test('ROUND 2 health: a required group with no options on at a site blocks; "up to" below "must choose" blocks', () => {
  const { v, central, G, O } = setup();
  const ch = [
    { target: 'modifier_group', entity_id: G('Tea choice').id, op: 'update', after: { min: 1 } },
    { target: 'modifier_option_site', entity_id: O('Earl grey', 'Tea choice').id, location_id: A, op: 'update', after: { active: false } },
  ];
  const h = checkSite(plan(central, ch, A, v[A]), { siteName: 'Site A' });
  assert.ok(h.blocking.some((b) => b.code === 'required_group_empty' && /Site A customers could never finish ordering Tea/.test(b.words)), JSON.stringify(h.blocking));
  const bad = [{ target: 'modifier_group', entity_id: G('Milk').id, op: 'update', after: { min: 2, max: 1 } }];
  assert.ok(checkCentral(applyChanges(central, bad).central, touchedFromChanges(bad)).blocking.some((b) => b.code === 'group_max_below_min'));
});

// ── VAT per order type ──────────────────────────────────────────────────────

test('VAT by order type: only the key changed is written; a site\'s counter key and explicit null stay', () => {
  const { v, central, P } = setup();
  const ch = [{ target: 'product', entity_id: P('Donut').id, op: 'update', after: { tax_by_type: { takeaway: { name: 'Zero Rate', percent: 0 }, delivery: { name: 'Zero Rate', percent: 0 } } }, before: { tax_by_type: { takeaway: { name: 'Zero Rate', percent: 0 } } } }];
  const a = plan(central, ch, A, v[A]);
  assert.deepEqual(a.writes.items.update, [{ id: 'm-donut', set: {}, tax_overrides: { set: { delivery: ZERO.A }, remove: [] } }]);
  const b = plan(central, ch, B, v[B]);
  assert.deepEqual(b.writes.items.update, [{ id: S('m-donut', B), set: {}, tax_overrides: { set: { delivery: ZERO.B }, remove: [] } }], 'B keeps "no takeaway key"');
  const row = b.applied.items.find((i) => i.id === S('m-donut', B));
  assert.deepEqual(row.tax_overrides, { counter: VAT.B, 'drive-thru': null, delivery: ZERO.B }, 'counter and the explicit null untouched');
  // "Same as the product" takes the key away (never an explicit null).
  const same = plan(central, [{ target: 'product', entity_id: P('Donut').id, op: 'update', after: { tax_by_type: null } }], C, v[C]);
  assert.deepEqual(same.writes.items.update[0].tax_overrides, { set: {}, remove: ['takeaway'] });
});

test('VAT by order type: a rate the site lacks blocks it in words; a Drive thru key of its own is named', () => {
  const { v, central, P } = setup();
  const ch = [{ target: 'product', entity_id: P('Donut').id, op: 'update', after: { tax_by_type: { takeaway: { name: 'Reduced', percent: 5 } } } }];
  assert.ok(checkSite(plan(central, ch, A, v[A])).blocking.some((x) => x.code === 'no_tax_rate_type' && /5% VAT rate called "Reduced"/.test(x.words)));
  v[A].items.find((i) => i.id === 'm-donut').tax_overrides['drive-thru'] = VAT.A;
  const ok = [{ target: 'product', entity_id: P('Donut').id, op: 'update', after: { tax_by_type: { takeaway: { name: 'Zero Rate', percent: 0 }, 'dine-in': { name: 'VAT', percent: 20 } } } }];
  const h = checkSite(plan(central, ok, A, v[A]));
  assert.ok(h.warnings.some((w) => w.code === 'own_alias_vat' && /own Drive thru VAT on "Donut"/.test(w.words)));
});

test('VAT by order type and the tax profile trap: a generated copy of its own rate is cleared; a real profile blocks', () => {
  const { v, central, P } = setup();
  const ch = [{ target: 'product', entity_id: P('Cola').id, op: 'update', after: { tax_by_type: { takeaway: { name: 'Zero Rate', percent: 0 } } } }];
  const p = plan(central, ch, A, v[A]);
  assert.deepEqual(p.writes.items.update, [{ id: 'm-cola', set: { tax_profile_id: null }, tax_overrides: { set: { takeaway: ZERO.A }, remove: [] } }]);
  assert.match(lineWords(p.lines.find((l) => l.column === 'tax_profile_id'), { [P('Cola').id]: 'Cola' }), /old tax profile hid it/);
  // A copy an operator changed is a real profile.
  v[A].taxProfileLines[0].compound = true;
  assert.ok(checkSite(plan(central, ch, A, v[A])).blocking.some((x) => x.code === 'real_tax_profile'));
});

test('Undo puts the cleared copy back: no order type VAT left, the copy recorded, still a copy of its rate', () => {
  const { v, central, P } = setup();
  v[A].items.find((i) => i.id === 'm-cola').tax_profile_id = null;
  v[A].items.find((i) => i.id === 'm-cola').tax_overrides = { takeaway: ZERO.A };
  const ps = central.productSites.find((r) => r.product_id === P('Cola').id && r.location_id === A);
  ps.cleared_tax_profile_id = PROFILE_A;
  P('Cola').tax_by_type = { takeaway: { name: 'Zero Rate', percent: 0 } };
  const undo = [{ target: 'product', entity_id: P('Cola').id, op: 'update', after: { tax_by_type: null }, before: { tax_by_type: P('Cola').tax_by_type } }];
  const p = plan(central, undo, A, v[A]);
  assert.deepEqual(p.writes.items.update, [{ id: 'm-cola', set: { tax_profile_id: PROFILE_A }, tax_overrides: { set: {}, remove: ['takeaway'] } }]);
});

test('17 Oct recheck: a size takes its product\'s four keys, as Menu Manager cascades them; its other keys and a key it keeps stay', () => {
  const { v, central, P } = setup();
  const ch = [{ target: 'product', entity_id: P('Latte').id, op: 'update', after: { tax_by_type: { takeaway: { name: 'Zero Rate', percent: 0 } } } }];
  const a = plan(central, ch, A, v[A]);
  assert.deepEqual(a.writes.items.update.map((u) => u.id).sort(), ['m-latte', 'm-latte-l'], 'the product and its size');
  assert.deepEqual(a.writes.items.update.find((u) => u.id === 'm-latte-l').tax_overrides, { set: { takeaway: ZERO.A }, remove: [] });
  // The size's other keys stay as they are (only the four keys are ever written).
  v[A].items.find((i) => i.id === 'm-latte-l').tax_overrides = { counter: VAT.A };
  const a2 = plan(central, ch, A, v[A]);
  assert.deepEqual(a2.writes.items.update.find((u) => u.id === 'm-latte-l').tax_overrides, { set: { takeaway: ZERO.A }, remove: [] });
  assert.deepEqual(a2.applied.items.find((i) => i.id === 'm-latte-l').tax_overrides, { counter: VAT.A, takeaway: ZERO.A });
  // A size that keeps its own Takeaway VAT keeps it.
  const c2 = JSON.parse(JSON.stringify(central));
  c2.productSites.find((r) => r.product_id === P('Large latte').id && r.location_id === A).kept = { tax_overrides: { takeaway: false } };
  const a3 = plan(c2, ch, A, v[A]);
  assert.deepEqual(a3.writes.items.update.map((u) => u.id), ['m-latte'], 'the size kept its own: nothing written there');
  // Undo: the product's key goes, and the size's goes with it, its other keys still as they were.
  const v4 = JSON.parse(JSON.stringify(v[A]));
  v4.items = a2.applied.items;
  const c4 = JSON.parse(JSON.stringify(central));
  c4.products.find((x) => x.id === P('Latte').id).tax_by_type = { takeaway: { name: 'Zero Rate', percent: 0 } };
  const undo = [{ target: 'product', entity_id: P('Latte').id, op: 'update', after: { tax_by_type: null }, before: { tax_by_type: { takeaway: { name: 'Zero Rate', percent: 0 } } } }];
  const u = plan(c4, undo, A, v4);
  assert.deepEqual(u.applied.items.find((i) => i.id === 'm-latte-l').tax_overrides, { counter: VAT.A }, 'the size is back exactly');
  assert.deepEqual(u.applied.items.find((i) => i.id === 'm-latte').tax_overrides, v[A].items.find((i) => i.id === 'm-latte').tax_overrides || {});
});

test('17 Oct recheck: the import and drift treat a size whose keys equal its product\'s as following it', () => {
  const v = groupVenues();
  // Both the product and its size already carry the zero rate for takeaway at A (as Menu Manager left them).
  v[A].items.find((i) => i.id === 'm-latte').tax_overrides = { takeaway: ZERO.A };
  v[A].items.find((i) => i.id === 'm-latte-l').tax_overrides = { takeaway: ZERO.A };
  const sites = groupSites(v);
  const built = buildCentral(proposeImport(sites, { idGen: idGen() }), sites, {}, { idGen: idGen('g') });
  assert.ok(built.check.ok, JSON.stringify(built.check.problems));
  assert.equal(built.check.writes, 0);
  const size = built.central.products.find((p) => p.name === 'Large latte');
  assert.equal(built.central.productSites.find((r) => r.product_id === size.id && r.location_id === A).kept.tax_overrides, undefined, 'following its product: nothing kept');
  built.central.menu = { id: '99999999-0000-4000-8000-000000000001', name: 'Group menu', refreshed_at: '2026-10-17' };
  assert.deepEqual(siteDrift(built.central, A, v[A]).filter((d) => d.venueItemId === 'm-latte-l'), [], 'no drift');
  // A size whose takeaway differs from its product's keeps its own.
  const v2 = groupVenues();
  v2[A].items.find((i) => i.id === 'm-latte-l').tax_overrides = { takeaway: ZERO.A };
  const s2 = groupSites(v2);
  const b2 = buildCentral(proposeImport(s2, { idGen: idGen() }), s2, {}, { idGen: idGen('g') });
  assert.equal(b2.check.writes, 0);
  const size2 = b2.central.products.find((p) => p.name === 'Large latte');
  assert.deepEqual(b2.central.productSites.find((r) => r.product_id === size2.id && r.location_id === A).kept.tax_overrides, { takeaway: ZERO.A });
});

test('the self check covers VAT: after import, touching VAT everywhere still plans nothing (and settles a stray key)', () => {
  const { v, central } = setup();
  const sites = groupSites(v);
  const res = settleKept(central, sites);
  assert.equal(res.writes, 0);
});

// ── Drift, keep, bring in, undo, reach, schedule ────────────────────────────

test('drift: an option price changed at the venue, and an option the group does not know; keep the site\'s, bring it in', () => {
  const { v, central, G, O } = setup();
  v[A].groups[0].options[0].price = 0.45;
  v[A].groups[0].options.push({ id: 'opt-hemp', name: 'Hemp milk', price: 0.6 });
  const d = siteDrift(central, A, v[A]);
  const price = d.find((x) => x.kind === 'group' && x.optionId === O('Oat milk').id);
  assert.match(price.words, /Oat milk is 0\.45 at the venue, the group says 0\.40/);
  const unknown = d.find((x) => x.kind === 'unknown_option');
  assert.match(unknown.words, /does not know: Hemp milk 0\.60/);
  const keep = keepVenueChanges(central, A, [price]);
  assert.deepEqual(keep, [{ target: 'modifier_option_site', entity_id: O('Oat milk').id, location_id: A, op: 'update', after: { price: 0.45 }, before: { price: null } }]);
  const bring = bringOptionIn(central, A, unknown, 'b0000000-0000-4000-8000-0000000000cc');
  assert.equal(bring[0].after.group_id, G('Milk').id);
  assert.deepEqual(bring.find((c) => c.location_id === A).after, { venue_option_id: 'opt-hemp', active: true, price: null, kept: {} });
  assert.equal(bring.filter((c) => c.target === 'modifier_option_site' && c.after.active === false).length, 2, 'off at every other site');
  // Bringing it in writes nothing at A.
  assert.equal(plan(central, bring, A, v[A]).writes.groups.update.length, 0);
});

test('undo: an option added is turned off everywhere (its ids stay); a price goes back; option site rows reach only their site', () => {
  const { central, O } = setup();
  const u = undoChanges({ changes: [
    { target: 'modifier_option', entity_id: 'x', op: 'create', before: null, after: { group_id: 'g', name: 'New' } },
    { target: 'modifier_option_site', entity_id: O('Oat milk').id, location_id: A, op: 'update', before: { price: null }, after: { price: 0.5 } },
  ] }, central);
  assert.deepEqual(u.changes, [
    { target: 'modifier_option', entity_id: 'x', location_id: null, op: 'update', after: { archived: true } },
    { target: 'modifier_option_site', entity_id: O('Oat milk').id, location_id: A, op: 'update', after: { price: null } },
  ]);
  assert.deepEqual(sitesReached(central, [{ target: 'modifier_option_site', entity_id: O('Oat milk').id, location_id: B, op: 'update', after: { price: 1 } }]), [B]);
  assert.equal(sitesReached(central, [{ target: 'modifier_option', entity_id: O('Oat milk').id, op: 'update', after: { price: 1 } }]).length, 3);
});

test('two scheduled sets that change the same option at the same site: the overlap says which wins', () => {
  const { O } = setup();
  const id = O('Oat milk').id;
  const r = overlaps([
    { id: 's1', title: 'Monday', due_at: Date.parse('2026-10-19T05:55:00Z'), changes: [{ target: 'modifier_option_site', entity_id: id, location_id: A, after: { price: 0.5 } }] },
    { id: 's2', title: 'Tuesday', due_at: Date.parse('2026-10-20T05:55:00Z'), changes: [{ target: 'modifier_option_site', entity_id: id, location_id: A, after: { price: 0.6 } }] },
  ], { [id]: 'Oat milk', [A]: 'Site A' });
  assert.match(r.overlaps[0].words, /Monday .* also changes Oat milk at Site A\. Tuesday .* runs later and wins\./);
});

// ── The price tool on options ──────────────────────────────────────────────

test('Change prices on option groups: Every site moves the default (own prices move too); free options stay free', () => {
  const { central, G, O } = setup();
  const out = applyPriceChange(central, { scope: { optionGroupIds: [G('Milk').id] }, change: { direction: 'up', mode: 'amount', value: 0.1 }, sites: 'all' });
  const byOpt = (name) => out.changes.filter((c) => c.entity_id === O(name).id);
  assert.deepEqual(byOpt('Oat milk'), [{ target: 'modifier_option', entity_id: O('Oat milk').id, location_id: null, op: 'update', after: { price: 0.5 } }]);
  assert.deepEqual(byOpt('Coconut milk'), [{ target: 'modifier_option', entity_id: O('Coconut milk').id, location_id: null, op: 'update', after: { price: 0.6 } }], 'B\'s own 0.00 is a free option: left at 0.00');
  assert.equal(byOpt('Syrup').length, 0, 'a 0.00 option stays free');
  assert.ok(out.summary.freeKept >= 2);
  const loose = applyPriceChange(central, { scope: { optionGroupIds: [G('Milk').id] }, change: { direction: 'up', mode: 'amount', value: 0.1 }, sites: 'all', keepFree: false });
  assert.ok(loose.changes.some((c) => c.entity_id === O('Syrup').id));
});

test('Change prices on option groups: Only some sites gives them their own price; option only sub items are never products in scope', () => {
  const { central, G, O, P } = setup();
  const out = applyPriceChange(central, { scope: { optionGroupIds: [G('Milk').id] }, change: { direction: 'up', mode: 'percent', value: 50 }, sites: [A] });
  assert.deepEqual(out.changes.find((c) => c.entity_id === O('Oat milk').id), { target: 'modifier_option_site', entity_id: O('Oat milk').id, location_id: A, op: 'update', after: { price: 0.6 } });
  const all = applyPriceChange(central, { scope: { all: true }, change: { direction: 'up', mode: 'amount', value: 0.1 }, sites: 'all' });
  assert.ok(!all.rows.some((r) => r.productId === P('Oat milk').id), 'Oat milk is only ever an option');
});

test('the one time refresh is needed only for a group menu whose groups are still a jsonb list', () => {
  const { central } = setup();
  assert.equal(groupsNeedRefresh(central), false);
  const old = { ...central, menu: { ...central.menu, refreshed_at: null }, options: [], groups: central.groups.map((g) => ({ ...g, options: [{ id: 'o', name: 'x', price: 0 }] })) };
  assert.equal(groupsNeedRefresh(old), true);
});

// ── Round 2 review fixes (17 Oct 2026) ──────────────────────────────────────

const COLD = 'f0000000-0000-4000-8000-000000000002';
const clone = (x) => JSON.parse(JSON.stringify(x));

test('review: an option only sub item made "sold on its own" is written whole at a site, so the till shows it', () => {
  const { v, central, P } = setup();
  const coco = P('Coconut milk');
  const ch = [{ target: 'product', entity_id: coco.id, op: 'update', after: { sold_alone: true, category_id: COLD }, before: { sold_alone: false, category_id: coco.category_id } }];
  const p = plan(central, ch, A, v[A]);
  const row = p.applied.items.find((i) => i.id === 'm-coco');
  assert.equal(row.visibility.pos, true, 'POSSurface hides visibility.pos false');
  assert.equal(row.sold_alone, true);
  assert.equal(row.type, 'subitem');
  assert.equal(row.cat, 'cat-cold');
  assert.equal(row.pricing.base, 0.5);
  assert.ok(p.lines.some((l) => l.column === 'visibility'), 'the preview lists it');
  // A plain edit on a product sold on its own still never writes where it shows (UI issue 2).
  const rename = [{ target: 'product', entity_id: P('Latte').id, op: 'update', after: { name: 'Latte 2' }, before: { name: 'Latte' } }];
  assert.ok(!plan(central, rename, A, v[A]).lines.some((l) => l.column === 'visibility'));
});

test('review: a product sold on its own, off at a site and used there only by an option, is promoted when turned on there', () => {
  const { v, central, P, O } = setup();
  const c1 = clone(central);
  const coco = c1.products.find((p) => p.id === P('Coconut milk').id);
  Object.assign(coco, { sold_alone: true, category_id: COLD, visibility: { pos: true, kiosk: true, online: true, onlineDelivery: true } });
  const vid = 'm-coco_000c0003';
  c1.productSites.push({ product_id: coco.id, location_id: C, venue_item_id: vid, active: false, price: null, channel_prices: null, kept: {} });
  const on = [{ target: 'modifier_option_site', entity_id: O('Coconut milk').id, location_id: C, op: 'update', after: { active: true }, before: { active: false } }];
  const p1 = plan(c1, on, C, v[C]);
  const ins = p1.writes.items.insert.find((i) => i.id === vid);
  assert.ok(ins, 'the option only row is added for the option');
  assert.equal(ins.visibility.pos, false);
  assert.deepEqual(p1.writes.maps.items, [], 'its product site row already exists (off)');
  const c2 = applyChanges(c1, on).central;
  const sell = [{ target: 'product_site', entity_id: coco.id, location_id: C, op: 'update', after: { active: true }, before: { active: false } }];
  const p2 = plan(c2, sell, C, after(v[C], p1));
  const row = p2.applied.items.find((i) => i.id === vid);
  assert.equal(row.visibility.pos, true);
  assert.equal(row.sold_alone, true);
  assert.equal(row.cat, S('cat-cold', C));
  assert.equal(row.pricing.base, 0.5);
  assert.ok(!p2.empty, 'turning it on is never a silent nothing');
});

test('review: a product sold on its own that an option adds at a site is recorded there as OFF (not on sale)', () => {
  const { v, central, P, O } = setup();
  const c1 = clone(central);
  Object.assign(c1.products.find((p) => p.id === P('Coconut milk').id), { sold_alone: true, category_id: COLD });
  const on = [{ target: 'modifier_option_site', entity_id: O('Coconut milk').id, location_id: C, op: 'update', after: { active: true }, before: { active: false } }];
  const p = plan(c1, on, C, v[C]);
  assert.equal(p.writes.maps.items.length, 1);
  assert.equal(p.writes.maps.items[0].active, false, 'the grid, Change prices and the sales checks never count it at C');
  assert.equal(p.writes.items.insert[0].visibility.pos, false);
});

test('review: an option that is off at a site never adopts an entry there (central would say on while the plan drops it)', () => {
  const { v, central, G, O } = setup();
  const c1 = clone(central);
  const coco = O('Coconut milk');
  c1.optionSites = c1.optionSites.filter((r) => !(r.option_id === coco.id && r.location_id === C));
  const v2 = clone(v[C]);
  v2.groups.find((g) => g.id === S('mgd-milk', C)).options.push({ id: newOptionId(coco.id), name: 'Coconut milk', price: 0.5 });
  const ch = [{ target: 'modifier_option', entity_id: coco.id, op: 'update', after: { name: 'Coconut' }, before: { name: 'Coconut milk' } }];
  const p = plan(c1, ch, C, v2);
  assert.deepEqual(p.writes.maps.options, [], 'nothing recorded as on');
  assert.ok(!(p.writes.groups.update[0]?.options || []).some((o) => o.op === 'drop'), 'and the entry is left alone for drift');
  assert.ok(G('Milk'));
});

test('review: takeaway VAT reaches a size that carries its own generated tax profile copy (Provo, Location 2)', () => {
  const { v, central, P } = setup();
  const va = clone(v[A]);
  va.items.find((i) => i.id === 'm-latte-l').tax_profile_id = PROFILE_A;
  const latte = P('Latte');
  const ch = [{ target: 'product', entity_id: latte.id, op: 'update', after: { tax_by_type: { takeaway: { name: 'Zero Rate', percent: 0 } } }, before: { tax_by_type: null } }];
  const p = plan(central, ch, A, va);
  assert.equal(p.applied.items.find((i) => i.id === 'm-latte').tax_overrides.takeaway, ZERO.A);
  const size = p.applied.items.find((i) => i.id === 'm-latte-l');
  assert.equal(size.tax_profile_id, null, 'the size line no longer hides the takeaway VAT');
  assert.deepEqual(size.tax_overrides, { takeaway: ZERO.A }, 'the size takes its product\'s keys (17 Oct recheck)');
  assert.ok(p.lines.some((l) => l.id === 'm-latte-l' && l.column === 'tax_profile_id' && l.profileCleared));
  // A real profile on the size blocks, in words.
  va.taxProfiles.push({ id: 'pf-real', location_id: A, name: 'Hot food', active: true, sort_order: 1, generated_from_rate_id: null });
  va.taxProfileLines.push({ id: 'pl-2', profile_id: 'pf-real', location_id: A, name: 'Hot', line_type: 'rate', rate: 20, mode: 'exclusive', compound: false, taxable: false, tax_basis: 'post_discount', order_types: ['dine-in'], active: true });
  va.items.find((i) => i.id === 'm-latte-l').tax_profile_id = 'pf-real';
  const p2 = plan(central, ch, A, va);
  assert.ok(p2.problems.some((x) => x.code === 'real_tax_profile' && /size "Large latte"/.test(x.words)), JSON.stringify(p2.problems));
});

test('review: Keep or Put back on one order type price writes only that key, never a separate drift on another', () => {
  const { v, central, P } = setup();
  const latte = P('Latte');
  const ps = central.productSites.find((r) => r.product_id === latte.id && r.location_id === A);
  const ch = [{ target: 'product_site', entity_id: latte.id, location_id: A, op: 'update', after: { channel_prices: { takeaway: 3.2, dineIn: 3.5 } }, before: { channel_prices: { dineIn: 3.5 } } }];
  const p = plan(central, ch, A, v[A]);
  assert.deepEqual(p.lines.filter((l) => l.productId === latte.id).map((l) => l.column), ['pricing.takeaway']);
  // No before (an older row): every order type key, as before.
  const p2 = plan(central, [{ ...ch[0], before: {} }], A, v[A]);
  assert.ok(p2.lines.some((l) => l.column === 'pricing.dineIn'));
  assert.ok(ps);
});

test('review: "Keep the site\'s" on an order type price the site cleared keeps what it really charges', () => {
  const { central, P } = setup();
  const c1 = clone(central);
  const latte = c1.products.find((p) => p.id === P('Latte').id);
  latte.default_channels = { ...(latte.default_channels || {}), takeaway: 3.2 };
  const d = [{ productId: latte.id, column: 'pricing.takeaway', venue: null, group: 3.2 }];
  const out = keepVenueChanges(c1, A, d);
  const ps = c1.productSites.find((r) => r.product_id === latte.id && r.location_id === A);
  assert.equal(out[0].after.channel_prices.takeaway, ps.price ?? latte.default_price, 'the site charges its Standard price there');
  // The group has no takeaway price: null still means "follow", which is what the site does.
  latte.default_channels.takeaway = null;
  assert.equal(keepVenueChanges(c1, A, d)[0].after.channel_prices.takeaway, null);
});
