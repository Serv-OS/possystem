// Multi site menu, 17 Oct 2026 verification fixes: the words, helpers and screen wiring. Each test
// here failed on the branch before the fix (a1710ba2) and passes after it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { changeWords, keptValueWords, PRICE_TYPE_HELP } from './msmWords.js';
import { driftWords } from './msmDriftView.js';
import { auditLines, spreadRows, spreadSummary, siteCards, changingSites, defaultRunLocal } from './msmPublishView.js';
import { bulkActiveWords, noCategoryHint, undoTarget, adminSwitchState, draftTitle } from './msmStatus.js';
import { lockedItemPatch, droppedWords } from './msmLock.js';
import { counterTillState, resetTillUiState, kioskMenuAfterRead } from './msmTillWatch.js';
import { holdPaymentBusy, _resetPaymentBusyForTests } from '../paymentBusy.js';
import { readManagedAt, gateFor, resetMsmManagedForTest, setManagedRetryMsForTest } from './msmManaged.js';
import { stagedIndex, cellStaged } from './msmGrid.js';
import { groupPendingSiteIds } from './msmGroupView.js';
import { summarise } from './msmSummary.js';
import { newItemId } from '../../../supabase/functions/_shared/msmModel.js';

const dir = new URL('../../backoffice/sections/msm/', import.meta.url);
const read = (f) => fs.readFileSync(new URL(f, dir), 'utf8');
const readSrc = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');

const names = { products: new Map([['latte', 'Latte'], ['fw', 'Flat white']]), sites: new Map([['l1', 'Riverside']]), groups: new Map(), options: new Map([['oat', 'Oat milk']]) };
const w = (row) => changeWords(row, names).words;

test('the draft list never says "price the group price to 3.10"; Put back lists only what moves, never a Delivery line', () => {
  assert.equal(w({ target: 'product_site', entity_id: 'latte', location_id: 'l1', op: 'update', after: { price: 3.1 }, before: { price: null } }), 'Riverside: price set to 3.10 (was the group price)');
  assert.equal(w({ target: 'product_site', entity_id: 'latte', location_id: 'l1', op: 'update', after: { channel_prices: { takeaway: 3.3 } }, before: { channel_prices: null } }), 'Riverside: Takeaway price set to 3.30 (was the Standard price)');
  assert.equal(w({ target: 'modifier_option_site', entity_id: 'oat', location_id: 'l1', op: 'update', after: { price: 0.5 }, before: { price: null } }), 'Riverside: price set to 0.50 (was the group price)');
  // Version 6 set only the takeaway price; putting it back stages all five as blank.
  const back = w({ target: 'product', entity_id: 'fw', op: 'update', after: { default_channels: { dineIn: null, takeaway: null, collection: null, delivery: null, driveThru: null } }, before: { default_channels: { takeaway: 3.3 } } });
  assert.equal(back, 'Takeaway goes back to the Standard price');
  assert.doesNotMatch(back, /Delivery|group channel prices/);
  assert.equal(w({ target: 'product', entity_id: 'g', op: 'create', after: { name: 'Babka', default_price: 3.9, image: 'https://example.invalid/x.jpg' } }), 'New product, group price 3.90, with a photo');
  assert.doesNotMatch(PRICE_TYPE_HELP.dineIn, /bar tabs/);
});

test('a value a site keeps is said in words, never a rate id, true or false, a kind code or a link', () => {
  const rates = [{ id: '5f0c2a7e-9b1d-4c3e-8a2f-0d6b1e7c9a44', name: 'Standard Rate', rate: 0.2 }];
  assert.equal(keptValueWords('tax_rate_id', '5f0c2a7e-9b1d-4c3e-8a2f-0d6b1e7c9a44', { rates }), 'Standard Rate 20%');
  assert.equal(keptValueWords('tax_rate_id', 'zz-unknown', { rates }), 'a VAT rate of its own');
  assert.equal(keptValueWords('sold_alone', false), 'no');
  assert.equal(keptValueWords('type', 'subitem'), 'a sub item');
  assert.equal(keptValueWords('image', 'https://example.invalid/a.jpg'), 'its own photo');
  assert.equal(keptValueWords('parent_id', 'item-1776_ab12cd34'), 'its own');
  const sheet = read('MsmProductSheet.jsx');
  assert.match(sheet, /keptValueWords\(col, v, \{ rates: ratesByLoc\[s\.id\] \}\)/);
  assert.doesNotMatch(sheet, /function keptValueWords/, 'one helper, in msmWords');
  // The changes made at the sites panel: a photo, a kept VAT key, a renamed product.
  assert.equal(driftWords({ productId: 'p', column: 'image', kept: true, venue: 'https://example.invalid/b.jpg', group: 'https://example.invalid/a.jpg' }, 'Station', { p: 'Latte' }),
    'Latte: photo was changed again at Station; Station was keeping its own photo, now its own photo');
  assert.equal(driftWords({ productId: 'p', column: 'tax_overrides.takeaway', kept: true, venue: 'rate-b', group: 'rate-a' }, 'Station', { p: 'Latte' }),
    'Latte: Takeaway VAT was changed again at Station; Station was keeping its own');
  assert.equal(driftWords({ productId: 'p', column: 'name', venue: 'Chocolate brownie', group: 'Brownie' }, 'Riverside', { p: 'Brownie' }),
    'Brownie: name is "Chocolate brownie" at Riverside (group menu: "Brownie")');
});

test('what a publish wrote: never a raw value; a size in Price check is never alone', () => {
  const lines = auditLines([
    { table: 'items', id: 'v1', before: { tax_rate_id: 'tr-a', image: null, sold_alone: true, cat: 'cat-1' }, after: { name: 'Cola', tax_rate_id: 'tz-a', image: 'https://example.invalid/x.jpg', sold_alone: false, cat: 'cat-2' } },
  ]);
  for (const l of lines) assert.doesNotMatch(l, /https?:|tr-a|tz-a|cat-|\btrue\b|\bfalse\b/, l);
  const central = {
    products: [
      { id: 'am', name: 'Americano', type: 'variants', default_price: 0 },
      { id: 'big', name: 'Regular', parent_product_id: 'am', default_price: 3 },
      { id: 'xl', name: 'Large', parent_product_id: 'am', default_price: 3.5 },
    ],
    productSites: [
      { product_id: 'big', location_id: 'a', price: 3.1, active: true }, { product_id: 'big', location_id: 'b', price: 3.2, active: true },
      { product_id: 'xl', location_id: 'a', price: null, active: true }, { product_id: 'xl', location_id: 'b', price: 3.6, active: true },
    ],
  };
  const rows = spreadRows(central, ['a', 'b']);
  assert.deepEqual(rows.map((r) => r.label).sort(), ['Americano, Large', 'Americano, Regular']);
  assert.match(spreadSummary(rows, 2), /widest is Americano, /);
  assert.match(read('MsmSpread.jsx'), /String\(r\.label \|\| r\.product\.menu_name \|\| r\.product\.name\)\.toLowerCase\(\)\.includes\(q\)/, 'search finds a size by its product');
});

test('the Sites tab: never "In sync" before anyone looked; the publish button names only the sites that change', () => {
  const sites = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }];
  assert.equal(siteCards(sites, [], { checked: false })[0].label, 'Not checked yet');
  assert.equal(siteCards(sites, [], { checked: true })[0].label, 'In sync');
  assert.equal(siteCards(sites, [], { checked: true, drift: { a: 2 } })[0].label, 'Changed at the site');
  assert.match(read('MsmSites.jsx'), /checked: !!check/);
  const preview = { sites: [{ location_id: 'a', plan: { lines: [1] } }, { location_id: 'b', plan: { lines: [] } }] };
  assert.deepEqual(changingSites(preview, ['a', 'b']), ['a']);
  assert.deepEqual(changingSites(null, ['a', 'b']), ['a', 'b'], 'before the preview is read: every site reached');
  assert.match(read('MsmPublish.jsx'), /Nothing changes at the other \$\{quietSites\} site/);
});

test('the schedule shortcut is the NEXT 06:00 and names its day', () => {
  assert.equal(defaultRunLocal(Date.UTC(2026, 9, 18, 2, 12), 'Europe/London'), '2026-10-18T06:00');
  const pub = read('MsmPublish.jsx');
  assert.doesNotMatch(pub, />\s*Or schedule it for tomorrow 06:00\s*</);
  assert.match(pub, /nextMorningWords\(defaultRunLocal\(now, tz\), whenText\(localToUtc\(defaultRunLocal\(now, tz\), tz\), tz\)\)/);
});

test('the bulk note counts site rows (House Red and 3 sizes: 4), and a product with no category is told at the flip', () => {
  const changes = [
    ...['red', 's175', 's250', 'btl'].map((id) => ({ target: 'product_site', entity_id: id, location_id: 'b', op: 'create', after: {} })),
    ...['red', 's175', 's250', 'btl'].map((id) => ({ target: 'product', entity_id: id, location_id: null, op: 'update', after: { site_only_location_id: null } })),
  ];
  assert.equal(bulkActiveWords({ changes, words: [] }, true), '4 products turned on (in the draft).');
  // Builder B recheck: one counting rule; with the group menu a size counts with its product.
  const central = { products: [{ id: 'red' }, ...['s175', 's250', 'btl'].map((id) => ({ id, parent_product_id: 'red' }))] };
  assert.equal(bulkActiveWords({ changes, words: [] }, true, central), '1 product turned on (in the draft).');
  assert.equal(bulkActiveWords({ changes: [], words: ['That site is not in the group menu yet.'] }, true), 'That site is not in the group menu yet.');
  assert.match(noCategoryHint({ id: 'h', name: 'hawaiian', category_id: null, type: 'simple' }), /no category yet: open the product/);
  assert.equal(noCategoryHint({ id: 'o', type: 'subitem', sold_alone: false }), '', 'an option only sub item needs none');
  assert.match(read('MsmGrid.jsx'), /bulkActiveWords\(r, true, eff\)/);
});

test('an old note\'s Undo after a publish never stages: it says the change is already out', () => {
  const sets = [{ id: 'd1', status: 'published', title: 'Changes 17 Oct 19:10' }];
  const r = undoTarget({ sets, workingId: null, noteSetId: 'd1' });
  assert.equal(r.ok, false);
  assert.match(r.words, /already published or scheduled/);
  assert.equal(undoTarget({ sets: [{ id: 'd1', status: 'draft' }], workingId: 'd1', noteSetId: 'd1' }).ok, true);
  assert.match(undoTarget({ sets: [{ id: 'd1', status: 'draft', title: 'A' }, { id: 'd2', status: 'draft' }], workingId: 'd2', noteSetId: 'd1' }).words, /in the draft "A"/);
  const msm = read('MultiSiteMenu.jsx');
  assert.match(msm, /const can = undoTarget\(\{ sets: setsRef\.current, workingId: workingIdRef\.current, noteSetId \}\);\n\s*if \(!can\.ok\) \{ setNote\(\{ tone: 'warn', text: can\.words \}\); return; \}/);
  assert.match(msm, /onClick: \(\) => undoRef\.current\?\.\(back, setId\)/);
  assert.match(read('MsmPublish.jsx'), /setNote\(null\);\n\s*setTracking\(/, 'publish clears the old note');
  assert.match(draftTitle(new Date(Date.UTC(2026, 9, 17, 18, 10)), 'Europe/London'), /^Changes 17 Oct 19:10$/, 'named by the sites\' clock');
});

test('the Admin switch stays blocked while the check runs or after it fails, and looks blocked', () => {
  const checking = adminSwitchState({ enabled: false, many: null });
  assert.equal(checking.disabled, true);
  assert.match(checking.note, /Checking/);
  const failed = adminSwitchState({ enabled: false, many: { ok: false, sites: [] } });
  assert.equal(failed.needsTick, true);
  assert.equal(failed.disabled, true);
  assert.match(failed.note, /Could not check the sites' menus/);
  assert.equal(adminSwitchState({ enabled: false, many: { ok: false, sites: [] }, ticked: true }).disabled, false);
  assert.equal(adminSwitchState({ enabled: false, many: { ok: true, sites: [] } }).disabled, false, 'one menu per site: no tick');
  assert.equal(adminSwitchState({ enabled: true, many: null }).disabled, false, 'switching off never waits');
  const card = fs.readFileSync(new URL('../../admin/sections/AdminMultiSiteMenu.jsx', import.meta.url), 'utf8');
  assert.match(card, /disabled=\{sw\.disabled\}/);
  assert.match(card, /cursor: sw\.blocked \? 'not-allowed' : 'pointer'/);
  assert.match(card, /\.catch\(\(\) => \{ if \(live\) setManyBy/);
});

test('the lock: Delivery price, where it shows and the counter VAT stay the site\'s; the toast grammar', () => {
  const cur = { name: 'Latte', pricing: { base: 3, delivery: 3.6 }, visibility: { pos: true, kiosk: true }, taxOverrides: { takeaway: 'z' } };
  assert.deepEqual(lockedItemPatch({ pricing: { base: 3, delivery: 4 } }, cur, []).patch, { pricing: { base: 3, delivery: 4 } });
  assert.deepEqual(lockedItemPatch({ visibility: { pos: true, kiosk: false } }, cur, []).patch, { visibility: { pos: true, kiosk: false } });
  const tax = lockedItemPatch({ taxOverrides: { takeaway: 'other', counter: 'c' } }, cur, []);
  assert.deepEqual(tax.patch, { taxOverrides: { takeaway: 'z', counter: 'c' } }, 'the counter key goes through, the takeaway key stays head office\'s');
  assert.deepEqual(tax.dropped, ['tax_overrides']);
  assert.deepEqual(lockedItemPatch({ pricing: { base: 4 } }, cur, []).dropped, ['pricing'], 'the Standard price is still head office\'s');
  const one = droppedWords('Latte', ['pricing']);
  assert.equal(one, 'Latte: head office sets the prices in the Multi site menu, so this was not changed here.');
  assert.doesNotMatch(one, / is set/);
  const mm = fs.readFileSync(new URL('../../backoffice/sections/MenuManager.jsx', import.meta.url), 'utf8');
  assert.match(mm, /<MsmLocked key=\{k\} on=\{k !== 'delivery' && lockOn\('pricing'\)\}/);
  assert.match(mm, /<MsmLocked key=\{ot\} on=\{lockOverrides && OWNED_TAX_KEYS\.includes\(ot\)\}/);
  const note = read('MsmLockNote.jsx');
  assert.match(note, /kind === 'group' && <div style=\{\{ marginTop: 3 \}\}>This site keeps its own \{keptWords\.join\(', '\)\}\. Head office can change it for this site in the Multi site menu\./);
});

test('a counter till never takes a head office push while a payment is busy anywhere (the Bar screen\'s checkout)', () => {
  resetTillUiState();
  _resetPaymentBusyForTests();
  assert.equal(counterTillState({}).paymentInProgress, false);
  const release = holdPaymentBusy('checkout');
  assert.equal(counterTillState({}).paymentInProgress, true);
  release();
  _resetPaymentBusyForTests();
});

test('the kiosk keeps its menu on screen when a reload after a head office push fails', () => {
  const prev = { items: [{ id: 'a' }, { id: 'b' }], categories: [{ id: 'c' }], menus: [{ id: 'm' }], links: [], taxProfiles: [{ id: 'p' }], venueDefaultTaxProfileId: null };
  const bad = { items: { data: null, error: { message: 'timeout' } }, categories: { data: [] }, menus: { data: [] }, links: { data: [] }, taxProfiles: { data: [] }, taxProfileLines: { data: [] } };
  const r = kioskMenuAfterRead(prev, bad, { reload: true });
  assert.equal(r.failed, true);
  assert.equal(r.data.items.length, 2, 'never an empty menu');
  const first = kioskMenuAfterRead(prev, bad, { reload: false });
  assert.equal(first.failed, false, 'the first load keeps today\'s behaviour');
  const ok = kioskMenuAfterRead(prev, { items: { data: [{ id: 'x' }] }, categories: { data: [] }, menus: { data: [] }, links: { data: [] }, taxProfiles: { data: null, error: {} }, taxProfileLines: { data: [] } }, { reload: true });
  assert.deepEqual(ok.data.taxProfiles, [{ id: 'p' }], 'a failed profile read keeps the profiles on a reload');
  const kiosk = fs.readFileSync(new URL('../../surfaces/KioskApp.jsx', import.meta.url), 'utf8');
  // Recheck (Builder B): a failed re read is read again later through the one at a time controller.
  assert.match(kiosk, /isIdle: \(\) => kioskMayRefresh\(\{ pending: true, \.\.\.idleRef\.current \}\)/);
  // 18 Oct follow up: it also says when a read landed mid order (busy), so it is read again, not shown.
  assert.match(kiosk, /setReloadDone\(\{ key: reloadKey, failed, busy \}\)/);
});

test('the sharing gate asks once more before blocking (a blip fails only the check)', async () => {
  resetMsmManagedForTest();
  setManagedRetryMsForTest(0);
  let calls = 0;
  const client = { rpc: async () => { calls++; return calls === 1 ? { data: null, error: { message: 'Failed to fetch' } } : { data: { on: false, groups: [], items: [] }, error: null }; } };
  const r = await readManagedAt(client, ['L1']);
  assert.equal(calls, 2);
  assert.equal(r.ok, true);
  assert.equal(gateFor(r, 'L1').blocked, false);
  calls = 0;
  const down = { rpc: async () => { calls++; return { data: null, error: { message: 'Failed to fetch' } }; } };
  resetMsmManagedForTest();
  const r2 = await readManagedAt(down, ['L1']);
  assert.equal(calls, 2);
  assert.equal(gateFor(r2, 'L1').blocked, true, 'still fails closed when nothing is known');
  setManagedRetryMsForTest(400);
  resetMsmManagedForTest();
});

test('"Use the group\'s settings" leaves the amber bar; a group put on products says where it goes', () => {
  const s = stagedIndex([{ target: 'product_site', entity_id: 'fw', location_id: 'l1', op: 'update', after: { kept: {} } }]);
  assert.equal(cellStaged(s, 'fw', 'l1').kept, true);
  assert.match(read('MsmGrid.jsx'), /\(st\.price \|\| st\.active \|\| st\.kept\) && <span style=\{stagedMark\} \/>/);
  const central = {
    groups: [{ id: 'g' }], groupSites: [],
    products: [{ id: 'p', modifier_groups: [{ groupId: 'g' }] }],
    productSites: [{ product_id: 'p', location_id: 'a', active: true }, { product_id: 'p', location_id: 'b', active: false }],
  };
  assert.deepEqual([...groupPendingSiteIds(central, 'g')], ['a']);
  const sheet = read('MsmGroupSheet.jsx');
  assert.match(sheet, /Goes to \$\{pending\.size\} site\$\{pending\.size === 1 \? '' : 's'\} when you publish/);
  assert.match(sheet, /const absentSites = sites\.filter\(\(s\) => !at\.has\(s\.id\) && !pending\.has\(s\.id\)\)/);
});

test('a site with no row yet: off at a site where it never was is no sentence', () => {
  const p = { id: 'aaaaaaaa-0000-4000-8000-000000000001', name: 'Large', family_base: null };
  const central = { sites: [{ location_id: 'L1' }, { location_id: 'L2' }], products: [p], productSites: [] };
  const rows = [{ target: 'product_site', entity_id: p.id, location_id: 'L2', op: 'create', after: { venue_item_id: newItemId(p, 'L2'), active: false } }];
  assert.deepEqual(summarise(rows, central, { siteNames: { L2: 'Old Town' } }), []);
});

test('the option groups list says what every mark means, and wraps long names', () => {
  const list = read('MsmGroups.jsx');
  assert.match(list, / · not the same at every site/);
  assert.match(list, / · changed in the draft/);
  assert.doesNotMatch(list, /title="Differs between sites"/);
  assert.match(list, /overflowWrap: 'anywhere' \}\}>\{g\.group\.name\}/);
  assert.match(list, /\{round2 && g\.legacy && <Pill tone="warn">Needs refresh<\/Pill>\}/);
});

test('the grid key: the VAT sample has its dot, GP colours are explained (low GP is coral, never amber)', () => {
  const grid = read('MsmGrid.jsx');
  assert.match(grid, /\{dot\('var\(--blu\)'\)\}<span style=\{\{ color: 'var\(--t1\)', fontWeight: 750 \}\}>Zero 0%<\/span>/);
  assert.match(grid, /'Grey: follows the group\\'s VAT for this order type\.'/);
  assert.match(grid, /`Coral: GP under \$\{GP_LOW\}%\.`/);
  assert.match(grid, /gp\.gpPct < GP_LOW \? GP_LOW_COLOUR/);
  assert.doesNotMatch(grid, /gp\.gpPct < 60 \? 'var\(--amber/);
  assert.match(grid, /'\+ Sell here'|>\+ Sell here<\/span>, 'Not sold at that site yet/);
});

test('the blue dot: a bigger tap target, and its button wraps inside the panel', () => {
  const grid = read('MsmGrid.jsx');
  assert.match(grid, /btnStyle=\{\{ padding: '14px 6px 14px 10px', margin: '-12px -2px -12px -8px' \}\}/);
  assert.match(grid, /style=\{\{ whiteSpace: 'normal', textAlign: 'left', width: '100%' \}\} disabled=\{words\.length > 0 && !ok\} onClick=\{onUseGroup\}>Use the group's \{list\}/);
  assert.match(read('msmUi.jsx'), /data-testid=\{testId\} style=\{btnStyle\}/);
});

test('a warning beside its button wraps; switches are named with the product and the site', () => {
  const uiSrc = read('msmUi.jsx');
  assert.match(uiSrc, /display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'flex-start', padding: '5px 0'/);
  assert.match(uiSrc, /<span style=\{\{ flex: '1 1 180px', minWidth: 0 \}\}>\{r\.words\}<\/span>/);
  assert.match(uiSrc, /aria-label=\{ariaLabel\}/);
  assert.match(read('MsmGrid.jsx'), /ariaLabel=\{`\$\{nm\} at \$\{siteName\}: \$\{off \? 'off' : 'on'\}`\}/);
});

test('the product sheet: "Sold at" sits under the price; a rename carries the names; a new size is sold where its product is', () => {
  const sheet = read('MsmProductSheet.jsx');
  assert.ok(sheet.indexOf("{optionOnly ? 'Sites (used as an option)' : 'Sold at'}") < sheet.indexOf('{/* Prices by order type */}'), 'Sold at before the order type blocks');
  assert.match(sheet, /setForm\(\(f\) => renameFields\(f, v\)\)/);
  assert.match(sheet, /if \(create && v\) setSiteForm\(/);
  assert.doesNotMatch(sheet, /has no \{v\.name\} rate\./, 'never "Zero Rate rate"');
  assert.doesNotMatch(sheet, /\{productRate\.percent\}%/, 'percent through pctText');
});

test('wording: Change prices starts with no site ticked; the timeline and screens use plain words', () => {
  assert.match(read('MsmChangePrices.jsx'), /const \[chosen, setChosen\] = useState\(\[\]\);/);
  assert.match(read('MsmChangePrices.jsx'), /'Tick at least one site in 4\. Sites\.'/);
  const tl = read('MsmTimeline.jsx');
  assert.doesNotMatch(tl, /The put back is a draft|Add the put back to a draft/);
  assert.match(tl, /`Version \$\{v\.version_no\}`/);
  assert.match(tl, /What changed at \{siteNames/);
  assert.match(read('MsmAddToProducts.jsx'), /`Which products ask "\$\{groupName\}"\?`/);
  assert.match(read('MsmDetails.jsx'), /Goes into the <strong>/);
  assert.doesNotMatch(readSrc('./msmPublishHelp.js'), /looks quiet/);
  assert.match(read('MsmPublish.jsx'), /if \(p\.code !== 'changed_at_venue'\) warn\.push/);
});

test('a group takeaway price reaching a site with its own Standard price gets its own tick; Undo warnings are words', async () => {
  const { riskChecks } = await import('./msmRisk.js');
  const { undoChanges } = await import('../../../supabase/functions/_shared/msmDiff.js');
  const central = {
    sites: [{ location_id: 'A' }, { location_id: 'B' }],
    products: [{ id: 'fw', name: 'Flat white', default_price: 3.2, default_channels: null }],
    productSites: [{ product_id: 'fw', location_id: 'A', price: null, active: true }, { product_id: 'fw', location_id: 'B', price: 5, active: true }],
  };
  const ch = { target: 'product', entity_id: 'fw', location_id: null, op: 'update', after: { default_channels: { takeaway: 3.1 } }, before: { default_channels: null } };
  const risks = riskChecks([ch], central, null, null, { siteNames: { A: 'Market Street', B: 'Station' } });
  assert.ok(risks.some((r) => r.code === 'big_price' && /5\.00 to 3\.10 at Station/.test(r.words)), JSON.stringify(risks));
  const u = undoChanges({ changes: [{ target: 'product', entity_id: 'fw', op: 'update', after: { sold_alone: false }, before: { sold_alone: true } }] }, { products: [{ id: 'fw', name: 'Flat white', sold_alone: true }] });
  assert.deepEqual(u.warnings, ['Flat white: its sold on its own was changed since; undo puts back the one before.']);
});
