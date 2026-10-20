// availability.parity.test.js: what each channel sells, and that every channel reaches stock (v5.11.78).
// Run: node --test src/lib/parity/availability.parity.test.js
//
// STOCK DEPLETION IS NOT CHANGED HERE. It belongs to the central stock work (v5.11.77,
// feat/central-stock-depletion), which depletes from the booked sale itself: every closed_checks
// row, whoever writes it. So the parity rule for stock is "every channel books a closed check".
// This file proves each channel's writer is there (ezCater's is new in v5.11.78: it booked none).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MENU } from './fixtures.js';
import { isOptionOnlyItem } from '../menuRules.js';
import { readRepo, between } from './src.js';

test('stock reach: every channel books a closed check, so the central stock depletion sees every sale', () => {
  const store = readRepo('src/store/index.js');
  const writers = [
    ['table service (recordClosedCheck)', between(store, 'recordClosedCheck: (tableId, paymentInfo = {}) => {', 'closeApprovedTerminalJob: async'), /insertClosedCheck\(record\);/],
    ['reader close, Table Pay, pay at table (closeApprovedTerminalJob)', between(store, 'closeApprovedTerminalJob: async (job) => {', '_reverseTerminalJobGift: async ('), /await upsertClosedCheck\(record\);/],
    ['bar tab (recordWalkInClosedCheck)', between(store, 'recordWalkInClosedCheck: (record, paymentInfo = {}) => {', 'recordWalkInClosed: (walkInOrder'), /insertClosedCheck\(fullRecord\)/],
    ['counter, drive thru, MPOS, HubRise balance at the till (recordWalkInClosed)', between(store, 'recordWalkInClosed: (walkInOrder', 'refundCheck: async'), /insertClosedCheck\(record\);/],
    ['HubRise prepaid (bookChannelSale)', between(store, 'bookChannelSale: async (o) => {', '\n  },\n'), /writeClosedCheckRow\(/],
  ];
  for (const [name, src, re] of writers) assert.match(src, re, name);
  assert.match(readRepo('src/surfaces/KioskApp.jsx'), /await writeClosedCheckRow\(supabase, checkRow, \{ tag: 'kiosk'/, 'kiosk');
  assert.match(readRepo('src/surfaces/online/OnlineCheckout.jsx'), /check: closedCheck,/, 'online (place_public_order writes the check)');
  assert.match(readRepo('src/surfaces/qr/QrCheckout.jsx'), /check: closedCheckRow,/, 'QR pay now');
  assert.match(readRepo('src/surfaces/catering/CateringCheckout.jsx'), /check: closedCheck,/, 'catering pay now');
  assert.match(readRepo('src/surfaces/OrdersHub.jsx'), /writeClosedCheckRow\(supabase, tabCheck, \{ tag: 'forceCloseQrTab' \}\)/, 'QR tab force close');
  const settle = readRepo('supabase/migrations/20261019a_OPS_channel_parity.sql');
  assert.match(between(settle, 'CREATE OR REPLACE FUNCTION public.settle_qr_tab(', '$function$;'), /insert into public\.closed_checks/, 'QR tab closed on the phone');
  assert.match(readRepo('supabase/functions/ezcater-webhook/index.ts'), /await sb\.from\('closed_checks'\)\.insert\(plan\.row\);/, 'ezCater (v5.11.78; a revision per change since v5.11.81)');
});

test('catering: an option only sub item is never sold as a product, the till\'s and the server\'s rule', () => {
  const oat = MENU.find((m) => m.id === 'oat');
  assert.equal(isOptionOnlyItem(oat), true);
  const s = readRepo('src/surfaces/catering/CateringSurface.jsx');
  assert.match(between(s, 'const itemsForCat = (catId) => items.filter((i) =>', ');'), /!isOptionOnlyItem\(i\)/);
});

test('catering: an item 86\'d while a guest browses greys out live, as on the online page', () => {
  const s = readRepo('src/surfaces/catering/CateringSurface.jsx');
  assert.match(s, /supabase\.channel\(`catering-86:\$\{opsId\}`\)/);
  assert.match(s, /\{ event: '\*', schema: 'public', table: 'eighty_six', filter: `location_id=eq\.\$\{opsId\}` \}/);
  assert.match(s, /return \(\) => \{ try \{ if \(e86chan\) supabase\.removeChannel\(e86chan\); \} catch/);
});

// ── v5.11.81, channel parity round 2: menus and availability (Peter, 19 Oct 2026, "fix it all
// please, we need to be bullet proof"). One rule per question, every channel through it. ─────────

test('visibility: the Back Office "Visible on" switches mean the same on every channel (lib/channelMenu.js)', async () => {
  const { channelVisible } = await import('../channelMenu.js');
  const { cateringVisible } = await import('../cateringPricing.js');
  const { buildCatalog } = await import('../../../supabase/functions/_shared/hubrise-map.ts');
  const row = (visibility) => ({ id: 'x', visibility });
  const cases = [undefined, null, {}, { pos: false }, { kiosk: false }, { online: false }, { onlineDelivery: false },
    { pos: true, kiosk: true, online: true, onlineDelivery: true }];
  for (const v of cases) {
    const it = row(v);
    const k = JSON.stringify(v);
    // POS switch: the till, a bar tab and the handheld.
    for (const ch of ['pos', 'bar', 'mpos']) assert.equal(channelVisible(it, ch), !(v && v.pos === false), `${ch} ${k}`);
    assert.equal(channelVisible(it, 'kiosk'), !(v && v.kiosk === false), `kiosk ${k}`);
    // Online switch: the online page, QR (no switch of its own) and catering; Delivery on a delivery order.
    for (const ch of ['online', 'qr', 'catering']) {
      for (const f of ['collection', 'delivery', 'dine-in']) {
        const want = !(v && v.online === false) && !(f === 'delivery' && v && v.onlineDelivery === false);
        assert.equal(channelVisible(it, ch, f), want, `${ch} ${f} ${k}`);
      }
    }
    // Catering's own helper (v5.11.81 builder A) is the same rule.
    for (const f of [null, 'collection', 'delivery']) assert.equal(cateringVisible(it, f), channelVisible(it, 'catering', f), `catering ${f} ${k}`);
    // The delivery platforms (HubRise) read Online and Delivery, in the helper AND in the catalog.
    const hub = !(v && (v.online === false || v.onlineDelivery === false));
    assert.equal(channelVisible(it, 'hubrise'), hub, `hubrise ${k}`);
    const cat = buildCatalog({ categories: [{ id: 'c', label: 'C' }], items: [{ id: 'x', name: 'X', cat: 'c', pricing: { base: 2 }, visibility: v }],
      modifierGroups: [], currency: 'GBP', itemMenuId: {}, channel: 'delivery' });
    assert.equal(cat.products.length === 1, hub, `hubrise catalog ${k}`);
  }
});

test('visibility: every channel\'s menu reads the one rule (online, QR, bar tab, handheld; kiosk and till already did)', () => {
  const online = readRepo('src/surfaces/online/OnlineSurface.jsx');
  assert.match(online, /const visibleChannel = isQr \? 'qr' : 'online';/);
  assert.match(between(online, 'const itemsForCat = (catId) =>', 'const unsafeFor'), /if \(!channelVisible\(i, visibleChannel, priceType\)\) return false;/);
  assert.match(between(online, 'const addToCart = (item, mods, qty', 'setCart(c => [...c'), /if \(!channelVisible\(item, visibleChannel, priceType\)/, 'a hidden product is never added');
  assert.match(readRepo('src/surfaces/BarSurface.jsx'), /if \(!channelVisible\(i, 'bar'\)\) return false;/);
  assert.match(readRepo('src/surfaces/mpos/MMenu.jsx'), /const onPhone = \(i\) => !!i && !i\.hidden && !i\.parentId && !i\.archived && !isOptionOnlyItem\(i\) && channelVisible\(i, 'mpos'\);/);
  assert.match(readRepo('src/surfaces/POSSurface.jsx'), /i\.visibility\?\.pos === false/, 'the till (reference)');
  assert.match(readRepo('src/lib/kioskMenu.js'), /item\.visibility\?\.kiosk !== false/, 'the kiosk (reference)');
});

test('timed menus: the online and QR pinned menu goes through the till\'s resolver (off schedule falls to the default)', async () => {
  const { storefrontMenuId, categoriesOnMenu } = await import('../channelMenu.js');
  const { resolveActiveMenu } = await import('../menus/resolveActiveMenu.js');
  const menus = [
    { id: 'main', is_default: true, priority: 0 },
    { id: 'bar', priority: 0, schedule: { days: [], from: '16:00', to: '23:00' } },
  ];
  const categories = [{ id: 'c-main', menu_id: 'main' }, { id: 'c-bar', menu_id: 'bar' }, { id: 'c-sub', parent_id: 'c-bar' }];
  const at = (hhmm) => new Date(`2026-10-20T${hhmm}:00Z`);   // London is UTC+1 on 20 Oct: 09:00Z = 10:00 there
  const args = (now) => ({ menus, categories, links: [], pinnedMenuId: 'bar', timezone: 'Europe/London', now });
  assert.equal(storefrontMenuId(args(at('09:00'))), 'main', 'the Bar pin at 10:00 falls to the default menu, as on the till');
  assert.equal(storefrontMenuId(args(at('16:00'))), 'bar', 'the pin on schedule');
  for (const t of ['06:00', '09:00', '15:30', '17:00', '22:59']) {
    assert.equal(storefrontMenuId(args(at(t))), resolveActiveMenu(args(at(t))), `same as the till and kiosk at ${t}`);
  }
  assert.equal(storefrontMenuId({ ...args(at('09:00')), menus: [] }), 'bar', 'menus not read: the pin still holds');
  assert.equal(storefrontMenuId({ ...args(at('09:00')), pinnedMenuId: null }), 'main', 'automatic');
  // The storefront's own rule, unchanged: home menu, links, and a sub category of a linked one
  // (a sub category of a home menu category is shown inside its parent's section, onlineSectionTrees).
  assert.deepEqual(categoriesOnMenu(categories, [], 'bar').map((c) => c.id), ['c-bar']);
  assert.deepEqual(categoriesOnMenu(categories, [{ menu_id: 'bar', category_id: 'c-bar' }], 'bar').map((c) => c.id), ['c-bar', 'c-sub'], 'a linked parent brings its sub categories');
  assert.deepEqual(categoriesOnMenu(categories, [{ menu_id: 'bar', category_id: 'c-main' }], 'bar').map((c) => c.id), ['c-main', 'c-bar'], 'links count');
  assert.equal(categoriesOnMenu(categories, [], 'empty').length, 3, 'never blank');
  const online = readRepo('src/surfaces/online/OnlineSurface.jsx');
  assert.match(online, /const active = storefrontMenuId\(\{ menus: menusRows, categories: rawCats, links: allLinks, pinnedMenuId: onlineMenuId, timezone: location\?\.timezone \}\);/);
  assert.match(online, /const effectiveMenuId = resolvedMenuId;/);
  assert.doesNotMatch(online, /if \(onlineMenuId\) return;\s+\/\/ pinned: load\(\) already filtered/, 'the bypass is gone');
});

test('allergens: every customer channel MARKS, never hides (the kiosk\'s rule), on the same allergen ids', async () => {
  const { unsafeAllergenIds } = await import('../kioskAllergens.js');
  const latte = { id: 'l', allergens: ['Dairy'] };
  assert.deepEqual(unsafeAllergenIds(latte, ['milk']), ['milk'], 'Dairy is milk on every channel');
  assert.deepEqual(unsafeAllergenIds({ id: 'p', allergens: [] }, ['milk'], [{ id: 's', allergens: ['milk'] }]), ['milk'], 'a size counts');
  const online = readRepo('src/surfaces/online/OnlineSurface.jsx');
  assert.match(online, /const unsafeFor = \(item, kids\) => unsafeAllergenIds\(item, activeAllergens, kids\);/);
  assert.match(online, /unsafe=\{unsafeFor\(item, childrenByParent\[item\.id\]\)\}/);
  assert.match(online, /avoidAllergens=\{activeAllergens\}/);
  assert.doesNotMatch(online, /activeAllergens\.includes\(a\)\)\) return false/, 'online and QR never hide');
  const cat = readRepo('src/surfaces/catering/CateringSurface.jsx');
  assert.match(cat, /const unsafeFor = \(item\) => unsafeAllergenIds\(item, activeAllergens, items\.filter\(\(k\) => k\.parent_id === item\.id\)\);/);
  assert.match(cat, /avoidAllergens=\{activeAllergens\}/);
  assert.doesNotMatch(cat, /activeAllergens\.includes\(a\)\)\)\);/, 'catering never hides');
  // The item sheet warns before adding: the product, its size, and a picked option's own item.
  const sheet = readRepo('src/surfaces/online/OnlineItemSheet.jsx');
  assert.match(sheet, /return unsafeAllergenIds\(\{ allergens: \[\.\.\.itemAllergenIds\(item\), \.\.\.extra\.flatMap\(\(r\) => itemAllergenIds\(r\)\)\] \}, avoidAllergens, sizes\);/);
  assert.match(sheet, /which you asked to avoid/);
});

test('translations: the venue\'s menu words reach the online page, QR, catering and both kiosks; the order keeps English', async () => {
  const { loadMenuTranslationRows, customerMenuLang } = await import('../menuTextLoad.js');
  // Paged past the Data API's 1,000 row cap (the kiosk's single read stopped there).
  const rows = Array.from({ length: 2345 }, (_, i) => ({ entity_type: 'item', entity_id: `i${i}`, text: { name: `n${i}` } }));
  const asked = [];
  const client = { from: () => {
    const q = { _r: null, select() { return q; }, eq() { return q; }, order() { return q; },
      range(a, b) { asked.push([a, b]); return Promise.resolve({ data: rows.slice(a, b + 1), error: null }); } };
    return q;
  } };
  const got = await loadMenuTranslationRows(client, 'L1', 'es');
  assert.equal(got.length, 2345);
  assert.deepEqual(asked, [[0, 999], [1000, 1999], [2000, 2999]]);
  assert.equal(await loadMenuTranslationRows({ from: () => ({ select() { return this; }, eq() { return this; }, order() { return this; }, range: () => Promise.resolve({ data: null, error: { message: 'x' } }) }) }, 'L1', 'es'), null, 'a failed page keeps English');
  assert.equal(customerMenuLang(['es-MX', 'en']), 'es');
  assert.equal(customerMenuLang(['en-GB', 'es']), null, 'English first stays English');
  assert.equal(customerMenuLang(['de', 'fr-CA']), 'fr');
  assert.equal(customerMenuLang(['de']), null);
  // Every customer channel shows through lib/menuText.js; the basket line keeps the English name.
  const online = readRepo('src/surfaces/online/OnlineSurface.jsx');
  assert.match(online, /\{tItemName\(item\) \|\| item\.name\}/);
  assert.match(online, /\{tCategoryLabel\(cat\) \|\| cat\.name\}/);
  assert.match(between(online, 'setCart(c => [...c, {', '}]);'), /name: item\.menu_name \|\| item\.name,/, 'the line is English');
  const sheet = readRepo('src/surfaces/online/OnlineItemSheet.jsx');
  assert.match(sheet, /title=\{tGroupName\(g\) \|\| g\.name\}/);
  assert.match(sheet, /label=\{tOptionName\(g, opt\) \|\| opt\.name \|\| opt\.label\}/);
  assert.match(sheet, /\? `\$\{item\.menu_name \|\| item\.name\} — \$\{selectedVariant\.menu_name \|\| selectedVariant\.name\}`/, 'the added line is English');
  assert.match(readRepo('src/surfaces/catering/CateringSurface.jsx'), /\{tItemName\(item\) \|\| item\.name\}/);
  assert.match(readRepo('src/surfaces/KioskApp.jsx'), /useClassicKioskMenuWords\(lang, locationId, !newDesign\);/);
  assert.match(readRepo('src/surfaces/kiosk/kioskApi.js'), /loadMenuTranslationRows\(supabase, locationId, lang\)/, 'the new design kiosk reads every page too');
  // The translations are kept up to date for every venue that holds some, kiosk or not.
  assert.match(readRepo('supabase/functions/menu-translate/index.ts'), /opsAdmin\.from\('menu_translations'\)\.select\('id'\)\.eq\('location_id', locationId\)\.limit\(1\)/);
  const sql = readRepo('supabase/migrations/20261020a_OPS_channel_parity_2.sql');
  assert.match(between(sql, 'create or replace function public.menu_translate_cron()', '$function$;'), /from public\.menu_translations/);
  assert.match(readRepo('src/backoffice/sections/OnlineOrdering.jsx'), /<MenuTranslations locationId=\{opsLocId\}/, 'Back Office, Online ordering: Menu languages');
});

test('HubRise: sold out items follow the till by themselves, as a difference only, never all at once on day one', async () => {
  const { inventoryDelta, inventoryPatchEntries, giveUpOnInventoryError } = await import('../../../supabase/functions/_shared/hubriseAutoSync.js');
  assert.deepEqual(inventoryDelta(null, ['a', 'b']), { soldOut: [], back: [] }, 'first run: recorded, nothing sent');
  assert.deepEqual(inventoryDelta(['a', 'b'], ['b', 'c']), { soldOut: ['c'], back: ['a'] }, 'an automatic 86 and an un 86');
  assert.deepEqual(inventoryDelta(['a'], ['a']), { soldOut: [], back: [] });
  assert.deepEqual(inventoryPatchEntries({ soldOut: ['c'], back: ['a'] }), [
    { sku_ref: 'c', stock: '0' }, { sku_ref: 'a', stock: null }, { option_ref: 'c', stock: '0' }, { option_ref: 'a', stock: null }]);
  assert.deepEqual(inventoryPatchEntries({ soldOut: ['c'], back: [] }, { skuOnly: true }), [{ sku_ref: 'c', stock: '0' }]);
  assert.equal(giveUpOnInventoryError({ status: 422 }), true, 'HubRise refused it: recorded, not retried');
  assert.equal(giveUpOnInventoryError({ status: 503 }), false, 'a HubRise or network failure: the next run tries again');
  assert.equal(giveUpOnInventoryError(new Error('fetch failed')), false);
  const rec = readRepo('supabase/functions/hubrise-reconcile/index.ts');
  assert.match(rec, /try \{ out\.inventory = await syncInventoryDelta\(conn\); \}/);
  assert.match(rec, /await patchInventory\(conn\.access_token, conn\.hubrise_catalog_id, inventoryPatchEntries\(delta\)\)/, 'a PATCH, never a PUT that replaces the inventory');
  assert.match(readRepo('supabase/functions/_shared/hubrise-ingest.ts'), /if \(r86\?\.error\) throw/, 'a half read 86 list is never sent');
});

test('HubRise: the menu follows a multi site publish or a Menu Manager save by itself, only where ServOS owns the catalog', async () => {
  const { catalogSyncStep, autoCatalogAllowed, catalogPayloadKey, QUIET_MS, RETRY_MS } = await import('../../../supabase/functions/_shared/hubriseAutoSync.js');
  const now = Date.parse('2026-10-20T10:00:00Z');
  const conn = { status: 'connected', access_token: 't', hubrise_catalog_id: 'cat', catalog_pushed_at: '2026-10-01T00:00:00Z',
    auto_catalog: true, menu_fingerprint: 'A', menu_fingerprint_at: new Date(now - QUIET_MS - 1).toISOString(), catalog_fingerprint: 'A' };
  assert.equal(catalogSyncStep(conn, 'A', now), 'idle', 'HubRise has this menu');
  assert.equal(catalogSyncStep(conn, 'B', now), 'note', 'a change is noted first');
  assert.equal(catalogSyncStep({ ...conn, menu_fingerprint: 'B', menu_fingerprint_at: new Date(now - 10_000).toISOString() }, 'B', now), 'wait', 'still being edited');
  assert.equal(catalogSyncStep({ ...conn, menu_fingerprint: 'B' }, 'B', now), 'push', 'still for 90 s: pushed once');
  assert.equal(catalogSyncStep({ ...conn, menu_fingerprint: 'B', catalog_push_error: 'x', catalog_auto_tried_at: new Date(now - 60_000).toISOString() }, 'B', now), 'wait', 'a failed push waits');
  assert.equal(catalogSyncStep({ ...conn, menu_fingerprint: 'B', catalog_push_error: 'x', catalog_auto_tried_at: new Date(now - RETRY_MS - 1).toISOString() }, 'B', now), 'push');
  assert.equal(autoCatalogAllowed({ ...conn, catalog_pushed_at: null }), false, 'never pushed from ServOS: a catalog kept in HubRise is never overwritten');
  assert.equal(autoCatalogAllowed({ ...conn, auto_catalog: false }), false, 'switched off');
  const noColumn = { ...conn }; delete noColumn.menu_fingerprint;
  assert.equal(catalogSyncStep(noColumn, 'B', now), 'off', 'before 20261020a runs: nothing');
  assert.equal(catalogSyncStep(conn, null, now), 'off', 'no fingerprint: nothing');
  assert.equal(catalogPayloadKey({ a: 1 }), catalogPayloadKey({ a: 1 }));
  assert.notEqual(catalogPayloadKey({ a: 1 }), catalogPayloadKey({ a: 2 }));
  const rec = readRepo('supabase/functions/hubrise-reconcile/index.ts');
  assert.match(rec, /const out = await pushCatalog\(sb, loc, false, \{ onlyIfChanged: true \}\);/);
  assert.match(rec, /if \(budget\.pushes >= MAX_PUSHES_PER_RUN\) return 'next run';/);
  const push = readRepo('supabase/functions/_shared/hubrise-catalog.ts');
  assert.match(push, /readAll\(\(\) => sb\.from\('menu_items'\)\.select\('\*'\)\.eq\('location_id', loc\)\.order\('id'\), 'menu items'\)/, 'every row, paged');
  assert.match(push, /sb\.from\('menu_category_links'\)\.select\('menu_id, category_id'\)\.in\('menu_id', menuIds\)/, 'only this venue\'s menus\' links');
  assert.match(push, /if \(conn\.catalog_payload_key && catalogPayloadKey\(doc\) === conn\.catalog_payload_key\)/, 'the same catalog is never sent twice');
  const sql = readRepo('supabase/migrations/20261020a_OPS_channel_parity_2.sql');
  assert.match(sql, /revoke all on function public\.hubrise_menu_fingerprint\(text\) from public, anon, authenticated;/);
  assert.match(sql, /grant execute on function public\.hubrise_menu_fingerprint\(text\) to service_role;/);
  for (const c of ['inventory_ids jsonb', 'menu_fingerprint text', 'menu_fingerprint_at timestamptz', 'catalog_fingerprint text',
    'catalog_payload_key text', 'catalog_auto_tried_at timestamptz', 'auto_catalog boolean not null default true']) {
    assert.ok(sql.includes(`alter table public.hubrise_connections add column if not exists ${c};`), c);
  }
});

test('ezCater: a rename keeps its link; a sold out line tells staff (ezCater has no menu or stock API to tell)', async () => {
  const { renamedTargetKept, EXACT_MATCHED_BY } = await import('../../../supabase/functions/_shared/ezcaterMenuSync.ts');
  const { ezcaterSoldOutNames, ezcaterSoldOutAlert } = await import('../../../supabase/functions/_shared/ezcaterSoldOut.js');
  const entry = { kind: 'item', ezName: 'Caesar Salad', exactName: 'Caesar Salad' };
  const was = { menuItemId: 'm-c', optionId: null, matchedBy: EXACT_MATCHED_BY };
  assert.deepEqual(renamedTargetKept(entry, was, [{ id: 'm-c', name: 'Caesar Salad Bowl' }]), { menuItemId: 'm-c', optionId: null }, 'renamed: kept');
  assert.equal(renamedTargetKept(entry, was, [{ id: 'm-x', name: 'Other' }]), null, 'gone from our menu: cleared');
  assert.equal(renamedTargetKept(entry, was, [{ id: 'm-c', name: 'Bowl' }, { id: 'm-n', name: 'Caesar Salad' }]), null, 'another of ours has the exact name: that rule decides');
  assert.equal(renamedTargetKept(entry, { ...was, matchedBy: 'name' }, [{ id: 'm-c', name: 'Bowl' }]), null, 'only an exact link');
  assert.equal(renamedTargetKept(entry, { ...was, optionId: 'o' }, [{ id: 'm-c', name: 'Bowl' }]), null, 'never an option');
  const items = [{ name: 'Caesar Salad', itemId: 'm-c', mods: [{ name: 'Bacon', itemId: 'm-b' }] }, { name: 'Cookie', itemId: 'm-k', mods: [] }, { name: 'Gone', itemId: 'm-c', voided: true }];
  assert.deepEqual(ezcaterSoldOutNames(items, ['m-c', 'm-b']), ['Caesar Salad', 'Caesar Salad: Bacon']);
  assert.deepEqual(ezcaterSoldOutNames(items, []), []);
  assert.match(ezcaterSoldOutAlert('ezCater 123', ['Caesar Salad']), /^ezCater 123: sold out here but ordered on ezCater: Caesar Salad\. ezCater cannot be told, call the customer or ezCater\.$/);
  assert.equal(ezcaterSoldOutAlert('x', []), null);
  const hook = readRepo('supabase/functions/ezcater-webhook/index.ts');
  assert.match(hook, /const names = ezcaterSoldOutNames\(queueRow\?\.items, \(e86 \|\| \[\]\)\.map\(\(r: any\) => r\.item_id\)\);/);
});
