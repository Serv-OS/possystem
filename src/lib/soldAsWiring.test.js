// 5.12.115 "Sold as": every way of ordering follows the one rule (src/lib/soldAs.js), head office
// sets it in the Multi site menu, and a publish carries it to each site without touching the
// site's own "where it shows" switches.
//
// Peter, 26 Nov 2026: "we also need to be able to say if a product can be sold as that order
// type", "a prime example is Wine: they only serve this on dine in orders, never online or to be
// taken away", and for the POS "grey it out and say not available for X order type when clicked".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { notSoldAs, isSoldAs } from './soldAs.js';
import { repriceKioskCart } from './kioskBasket.js';
import { lockedItemPatch, lockWord } from './msm/msmLock.js';
import { changeWords } from './msm/msmWords.js';
import { productUpdate } from './msm/msmEdit.js';
import { proposeImport, buildCentral, touchEverything } from '../../supabase/functions/_shared/msmImport.js';
import { planSite, touchedFromChanges, lineWords } from '../../supabase/functions/_shared/msmPlan.js';
import { applyChanges, siteDrift } from '../../supabase/functions/_shared/msmDiff.js';
import { checkChange } from '../../supabase/functions/_shared/msmModel.js';
import { A, B, ORG, idGen } from './msm/msmFixture.js';
import { groupVenues, groupSites } from './msm/msmGroupFixture.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, p), 'utf8');
const DINE_IN_ONLY = ['takeaway', 'collection', 'delivery', 'drive-thru'];

function setup() {
  const v = groupVenues();
  const sites = groupSites(v);
  const { central } = buildCentral(proposeImport(sites, { idGen: idGen() }), sites, {}, { idGen: idGen('g') });
  central.menu = { id: '99999999-0000-4000-8000-000000000001', name: 'Group menu', description: '', use_name_everywhere: false, refreshed_at: '2026-10-17' };
  const p = central.products.find((x) => x.type !== 'subitem' && !x.archived && !x.parent_product_id
    && [A, B].every((loc) => central.productSites.some((s) => s.product_id === x.id && s.location_id === loc && s.active !== false && v[loc].items.some((i) => i.id === s.venue_item_id))));
  assert.ok(p, 'a product sold at both sites');
  const vRow = (loc) => v[loc].items.find((i) => i.id === central.productSites.find((s) => s.product_id === p.id && s.location_id === loc).venue_item_id);
  return { v, central, p, vRow, ctx: { live: central, eff: applyChanges(central, []).central } };
}

// ── The Multi site menu: staged, published, and nothing else moved ──────────

test('head office sets wine to dine in only: one staged change, and each site gets only that', () => {
  const { v, central, p, vRow, ctx } = setup();
  // Two sites with different "where it shows" switches of their own.
  vRow(A).visibility = { pos: true, kiosk: true, online: true, onlineDelivery: true };
  vRow(B).visibility = { pos: true, kiosk: false, online: false, onlineDelivery: false };
  const want = { ...(p.visibility || { pos: true, kiosk: true, online: true, onlineDelivery: true }), notSoldAs: DINE_IN_ONLY };
  const r = productUpdate(ctx, p.id, { visibility: want });
  assert.deepEqual(Object.keys(r.change.after), ['visibility']);
  assert.equal(checkChange(r.change).ok, true);
  assert.match(changeWords(r.change, { products: new Map([[p.id, p.name]]) }).words, /dine in only/);
  const after = applyChanges(central, [r.change]).central;
  for (const loc of [A, B]) {
    const mine = { ...vRow(loc).visibility };
    const plan = planSite({ central: after, touched: touchedFromChanges([r.change]), locationId: loc, orgId: ORG, venue: v[loc] });
    assert.deepEqual(plan.problems.filter((x) => x.level === 'block'), []);
    const lines = plan.lines.filter((l) => l.id === vRow(loc).id);
    assert.deepEqual(lines.map((l) => l.column), ['visibility'], 'only the one field is written');
    assert.deepEqual(lines[0].after, { ...mine, notSoldAs: DINE_IN_ONLY }, 'the site keeps its own switches');
    assert.match(lineWords(lines[0], { [p.id]: p.name }), /now dine in only/);
    const row = plan.applied.items.find((i) => i.id === vRow(loc).id);
    assert.equal(isSoldAs(row, 'takeaway'), false);
    assert.equal(isSoldAs(row, 'dine-in'), true);
  }
});

test('sold on everything again takes the list off the site, switches untouched', () => {
  const { v, central, p, vRow, ctx } = setup();
  p.visibility = { pos: true, kiosk: true, online: true, onlineDelivery: true, notSoldAs: ['delivery'] };
  vRow(A).visibility = { pos: true, kiosk: false, online: true, notSoldAs: ['delivery'] };
  const eff = applyChanges(central, []).central;
  const r = productUpdate({ live: ctx.live, eff }, p.id, { visibility: { pos: true, kiosk: true, online: true, onlineDelivery: true } });
  const plan = planSite({ central: applyChanges(central, [r.change]).central, touched: touchedFromChanges([r.change]), locationId: A, orgId: ORG, venue: v[A] });
  const line = plan.lines.find((l) => l.id === vRow(A).id && l.column === 'visibility');
  assert.deepEqual(line.after, { pos: true, kiosk: false, online: true });
  assert.match(lineWords(line, { [p.id]: p.name }), /now sold on every order type/);
});

test('where a product shows is still the site\'s own: a publish never writes those switches', () => {
  const { v, central, p, vRow } = setup();
  // The group menu and the site disagree about the switches, and agree about the order types.
  p.visibility = { pos: true, kiosk: true, online: true, onlineDelivery: true };
  vRow(A).visibility = { pos: true, kiosk: false, online: false, onlineDelivery: false };
  const plan = planSite({ central, touched: touchedFromChanges(touchEverything(central)), locationId: A, orgId: ORG, venue: v[A] });
  assert.equal(plan.lines.filter((l) => l.id === vRow(A).id && l.column === 'visibility').length, 0);
  assert.equal(siteDrift(central, A, v[A]).filter((d) => d.column === 'visibility').length, 0, 'and it is not reported as changed at the site');
});

test('a site that changed the order types itself is reported, so head office can put it back', () => {
  const { v, central, p, vRow } = setup();
  p.visibility = { pos: true, kiosk: true, online: true, onlineDelivery: true, notSoldAs: DINE_IN_ONLY };
  vRow(A).visibility = { pos: true, kiosk: true, online: true };          // somebody sold it to take away
  assert.equal(siteDrift(central, A, v[A]).filter((d) => d.venueItemId === vRow(A).id && d.column === 'visibility').length, 1);
});

// ── Menu Manager at a site in a group menu: the list is head office's ───────

test('the lock: a site may flip its own switches, never the order types', () => {
  const cur = { id: 'wine', visibility: { pos: true, kiosk: true, online: true, notSoldAs: DINE_IN_ONLY } };
  // The site hides it from the kiosk: allowed, the list stays.
  const a = lockedItemPatch({ visibility: { pos: true, kiosk: false, online: true, notSoldAs: DINE_IN_ONLY } }, cur, []);
  assert.deepEqual(a, { patch: { visibility: { pos: true, kiosk: false, online: true, notSoldAs: DINE_IN_ONLY } }, dropped: [] });
  // The site tries to sell it to take away: the list goes back to what it was, the switch still saves.
  const b = lockedItemPatch({ visibility: { pos: true, kiosk: false, online: true } }, cur, []);
  assert.deepEqual(b.patch.visibility, { pos: true, kiosk: false, online: true, notSoldAs: DINE_IN_ONLY });
  assert.deepEqual(b.dropped, ['sold_as']);
  assert.equal(lockWord('sold_as'), 'order types it is sold on');
  // Only the list changed: nothing is saved at all.
  const c = lockedItemPatch({ visibility: { pos: true, kiosk: true, online: true } }, cur, []);
  assert.deepEqual(c, { patch: {}, dropped: ['sold_as'] });
  // A product with no list: a site cannot add one either.
  const d = lockedItemPatch({ visibility: { pos: true, notSoldAs: ['delivery'] } }, { id: 'p', visibility: { pos: true } }, []);
  assert.deepEqual(d, { patch: {}, dropped: ['sold_as'] });
});

// ── The kiosk basket when eat in becomes take away ──────────────────────────

test('the kiosk basket: a line not sold on the new order type is taken out, the rest repriced as before', () => {
  const wine = { id: 'wine', name: 'Wine', pricing: { base: 7 }, visibility: { notSoldAs: DINE_IN_ONLY } };
  const pizza = { id: 'pizza', name: 'Pizza', pricing: { base: 12, takeaway: 11 } };
  const large = { id: 'wine-l', name: 'Large', parent_id: 'wine', pricing: { base: 9 } };
  const cart = [
    { key: 'a', item: pizza, qty: 1, linePrice: 12, lineTotal: 12, modsArray: [] },
    { key: 'b', item: wine, qty: 2, linePrice: 7, lineTotal: 14, modsArray: [] },
    { key: 'c', item: wine, variant: large, qty: 1, linePrice: 9, lineTotal: 9, modsArray: [] },
  ];
  const out = repriceKioskCart(cart, [wine, pizza, large], 'takeaway');
  assert.deepEqual(out.map((l) => l.key), ['a'], 'the wine and its size are gone');
  assert.equal(out[0].linePrice, 11, 'the pizza is repriced for take away, as before');
  // Still eat in: nothing is taken out and the same basket comes back.
  assert.equal(repriceKioskCart(cart, [wine, pizza, large], 'dineIn'), cart);
});

// ── Every screen asks the one rule ──────────────────────────────────────────

test('the POS: greyed tile, the words on a tap, the switch refused, and one guard where every line is added', () => {
  const pos = read('../surfaces/POSSurface.jsx');
  assert.match(pos, /if \(!isSoldAs\(item, orderType, rawItems\)\) \{ showToast\(notSoldAsWords\(item, orderType\), 'error'\); return; \}/);
  assert.match(pos, /const notForType = !is86 && !isSoldAs\(item, orderType, rawItems\);/);
  assert.match(pos, /\.\.\.\(notForType \? \{ opacity:\.42, filter:'grayscale\(\.85\)' \} : \{\}\)/);
  assert.match(pos, /data-testid="pos-not-sold-as"/);
  assert.match(pos, /const stuck = linesNotSoldAs\(items, t, rawItems\);\s+if \(stuck\.length\) \{ showToast\(switchBlockedWords\(stuck, t\), 'error'\); return false; \}/);
  assert.match(pos, /if \(handleTypeChange\(answers\.orderType\) === false\) return;/, 'the order details pop up stops too');
  const store = read('../store/index.js');
  assert.match(store, /const _soldAsType = activeTableId \? 'dine-in' : _currentOrderType;/);
  assert.match(store, /if \(!opts\.fromPreorder && !isSoldAs\(item, _soldAsType, get\(\)\.menuItems\)\) \{/);
});

test('the phone POS and the bar', () => {
  const phone = read('../surfaces/mpos/MMenu.jsx');
  assert.match(phone, /const soldType = activeTableId \? 'dine-in' : orderType;/);
  assert.match(phone, /onTap=\{\(\) => is86 \? null : notFor \? onNotSold\?\.\(item\) : onPick\?\.\(item\)\}/);
  assert.match(phone, /data-testid="mpos-not-sold-as"/);
  assert.match(read('../surfaces/BarSurface.jsx'), /if \(!isSoldAs\(item, 'bar-tab', storeMenuItems \|\| MENU_ITEMS\)\)/);
});

test('both kiosk designs: not shown for the order type, never added', () => {
  const app = read('../surfaces/KioskApp.jsx');
  assert.match(app, /\.filter\(i => isSoldAs\(i, orderType, items\)\)/);
  assert.match(app, /if \(!isSoldAs\(variantItem \|\| item, orderType, items\) \|\| !isSoldAs\(item, orderType, items\)\) \{/);
  assert.match(read('../surfaces/kiosk/KioskMenuScreen.jsx'), /const items = useMemo\(\(\) => \(allItems \|\| \[\]\)\.filter\(i => isSoldAs\(i, orderType, allItems\)\), \[allItems, orderType\]\);/);
});

test('online ordering and QR: not listed, not added, and taken out when the order type changes', () => {
  const online = read('../surfaces/online/OnlineSurface.jsx');
  assert.match(online, /if \(!isSoldAs\(i, priceType, items\)\) return false;/);
  assert.match(online, /if \(!isSoldAs\(item, priceType, items\)\) \{ alert\(`Sorry, \$\{notSoldAsWords\(item, priceType\)\}`\); return; \}/);
  assert.match(online, /\|\| !isSoldAs\(row, isQr \? 'dine-in' : orderType, byId\);/);
});

test('the delivery platforms never get a product that is not sold for delivery', () => {
  assert.match(read('../../supabase/functions/_shared/hubrise-map.ts'), /!\(Array\.isArray\(it\.visibility\?\.notSoldAs\) && it\.visibility\.notSoldAs\.includes\('delivery'\)\) &&/);
});

test('the tick boxes: Menu Manager (locked for a group product) and the Multi site menu, each with "use for the whole category"', () => {
  const mm = read('../backoffice/sections/MenuManager.jsx');
  assert.match(mm, /<MsmLocked on=\{!!msmLock\} label="Sold as">\s+<div data-testid="mm-sold-as">/);
  assert.match(mm, /onClick=\{\(\) => f\('visibility', toggleSoldAs\(item\.visibility, k, !on\)\)\}/);
  assert.match(mm, /data-testid="mm-sold-as-category"/);
  const sheet = read('../backoffice/sections/msm/MsmProductSheet.jsx');
  assert.match(sheet, /data-testid="msm-sold-as"/);
  assert.match(sheet, /onClick=\{\(\) => set\('visibility', toggleSoldAs\(form\.visibility, k, !on\)\)\}/);
  assert.match(sheet, /data-testid="msm-sold-as-category"/);
  assert.match(sheet, /\{!isSizeForm && !optionOnly && \(\(\) => \{\s+const no = notSoldAs\(\{ visibility: form\.visibility \}\);/, 'a size and an option only sub item have no boxes');
});

test('nothing reads the list by hand: every screen goes through lib/soldAs.js', () => {
  for (const f of ['../surfaces/POSSurface.jsx', '../surfaces/BarSurface.jsx', '../surfaces/mpos/MMenu.jsx', '../surfaces/KioskApp.jsx', '../surfaces/kiosk/KioskMenuScreen.jsx', '../surfaces/online/OnlineSurface.jsx', '../backoffice/sections/MenuManager.jsx', '../backoffice/sections/msm/MsmProductSheet.jsx', '../store/index.js']) {
    assert.doesNotMatch(read(f), /\.notSoldAs\b/, `${f} asks the rule, it does not read the list`);
  }
  assert.deepEqual(notSoldAs({ visibility: { notSoldAs: ['delivery'] } }), ['delivery']);
});
