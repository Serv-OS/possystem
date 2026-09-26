// bulkScope.test.js — sharing many products at once must be safe and honest.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { bulkScopeTargets, runBulkScope, bulkScopeWords, bulkScopeConfirmWords, bulkScopeResendWords, missingMasters } from './bulkScope.js';

test('re-send words say what will be refreshed', () => { assert.match(bulkScopeResendWords(7, 'global'), /Re-send 7 products already global.*modifiers, tax, category/); });

const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const items = [
  { id: 'a', name: 'Americano', scope: 'local' },
  { id: 'b', name: 'Latte', scope: 'shared' },
  { id: 'c', name: 'Large', parentId: 'a', scope: 'local' },        // a size child
  { id: 'd', name: 'Oat milk', type: 'subitem', scope: 'local' },  // an option-only sub-item
  { id: 'e', name: 'Old', archived: true, scope: 'local' },
  { id: 'f', name: 'Glazed donut', type: 'subitem', soldAlone: true, scope: 'local' },  // a sub-item SOLD ALONE: a product (v5.9.75)
];

test('targets are top-level, live products not already at that scope', () => {
  assert.deepEqual(bulkScopeTargets(items, 'shared').map((i) => i.id), ['a', 'f'], 'a sold-alone sub item shares like any product; an option-only one never does');
  assert.deepEqual(bulkScopeTargets(items, 'local').map((i) => i.id), ['b']);
  assert.deepEqual(bulkScopeTargets(items, 'global').map((i) => i.id), ['a', 'b', 'f']);
});

test('re-send includes products already at that level, so broken copies can be repaired', () => {
  assert.deepEqual(bulkScopeTargets(items, 'global', { includeSame: true }).map((i) => i.id), ['a', 'b', 'f']);
  const already = [{ id: 'g', name: 'Latte', scope: 'global' }];
  assert.deepEqual(bulkScopeTargets(already, 'global').map((i) => i.id), [], 'normally skipped');
  assert.deepEqual(bulkScopeTargets(already, 'global', { includeSame: true }).map((i) => i.id), ['g'], 're-send takes it');
  assert.deepEqual(bulkScopeTargets(already, 'local', { includeSame: true }).map((i) => i.id), [], 'local is never a re-send');
});

test('it runs ONE product at a time, in order', async () => {
  // Two promotions at once would race to create the same peer category twice.
  let inFlight = 0, maxInFlight = 0; const order = [];
  const setScope = async (item) => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 2));
    order.push(item.id); inFlight--;
    return { ok: true, action: 'promoted', createdCount: 3 };
  };
  const r = await runBulkScope({ targets: bulkScopeTargets(items, 'global'), scope: 'global', setScope });
  assert.equal(maxInFlight, 1);
  assert.deepEqual(order, ['a', 'b', 'f']);
  assert.equal(r.promoted, 3); assert.equal(r.copies, 9); assert.equal(r.failed.length, 0);
});

test('one failure does not stop the rest, and is named', async () => {
  const setScope = async (item) => item.id === 'a' ? { ok: false, error: { message: 'not in an org' } } : { ok: true, action: 'rescoped' };
  const r = await runBulkScope({ targets: bulkScopeTargets(items, 'global'), scope: 'global', setScope });
  assert.equal(r.done, 3); assert.equal(r.ok.length, 2); assert.equal(r.failed.length, 1);
  assert.equal(r.failed[0].error, 'not in an org');
  assert.match(bulkScopeWords(r, 'global'), /1 product failed: Americano \(not in an org\)/);
});

test('a thrown error is a failure, not a crash', async () => {
  const r = await runBulkScope({ targets: [items[0]], scope: 'shared', setScope: async () => { throw new Error('boom'); } });
  assert.equal(r.failed[0].error, 'boom');
});

test('it can be stopped between products', async () => {
  let n = 0;
  const r = await runBulkScope({ targets: bulkScopeTargets(items, 'global'), scope: 'global', setScope: async () => ({ ok: true, action: 'rescoped' }), shouldStop: () => n++ >= 1 });
  assert.equal(r.done, 1); assert.equal(r.stopped, true);
  assert.match(bulkScopeWords(r, 'global'), /Stopped early/);
});

test('the words say what happened, in plain English', () => {
  assert.equal(bulkScopeWords({ promoted: 2, copies: 6, rescoped: 0, demoted: 0, failed: [] }, 'shared'), '2 products shared out to other venues (6 copies made).');
  assert.equal(bulkScopeWords({ promoted: 0, copies: 0, rescoped: 0, demoted: 1, failed: [] }, 'local'), '1 product set to local here.');
  assert.match(bulkScopeConfirmWords(12, 'shared', 5), /share 12 products with every venue.*5 other venues.*one product at a time/);
  assert.match(bulkScopeConfirmWords(1, 'local'), /set 1 product to Local at this venue only/);
});

test('the Items list has the strip and runs it through runBulkScope', () => {
  const src = read('../backoffice/sections/MenuManager.jsx');
  assert.match(src, /import \{ bulkScopeTargets, runBulkScope, bulkScopeWords, bulkScopeConfirmWords(, bulkScopeResendWords)? \} from '\.\.\/\.\.\/lib\/bulkScope'/);
  assert.match(src, /Sharing quick apply/);
  assert.match(src, /window\.confirm\((bulkResend && bulkScope !== 'local' \? bulkScopeResendWords|bulkScopeConfirmWords)\(/, 'nothing moves without a confirm');
  assert.match(src, /runBulkScope\(\{ targets, scope: bulkScope, setScope: setMenuItemScope/);
});

test('a new venue is missing every organisation master that has no copy there yet', () => {
  // Peter, 23 Sep: "if we add a new location these products hit that location also".
  const venue = '11111111-2222-3333-4444-aaaaaaaa9999';
  const masters = [
    { id: 'm-1', location_id: 'provo', scope: 'global' },
    { id: 'm-2', location_id: 'provo', scope: 'shared' },
    { id: 'm-3', location_id: 'provo', scope: 'local' },                 // never shared
    { id: 'm-4', location_id: 'provo', scope: 'global', archived: true }, // retired
    { id: 'm-5_0000loc2', location_id: 'loc2', scope: 'global', master_id: 'm-5' }, // a copy, not a master
    { id: 'm-6', location_id: venue, scope: 'global' },                  // the venue's own
  ];
  assert.deepEqual(missingMasters(masters, ['m-2_aaaa9999'], venue).map((m) => m.id), ['m-1'], 'm-2 already has its copy (the suffix is the LAST 8 characters of the venue id)');
  assert.deepEqual(missingMasters(masters, [], venue).map((m) => m.id), ['m-1', 'm-2']);
  assert.deepEqual(missingMasters([], [], venue), []);
});

test('the Items list offers to pull missing shared products, and creating a venue pulls them', () => {
  const src = read('../backoffice/sections/MenuManager.jsx');
  assert.match(src, /listSharedMastersMissingAt\(/, 'the Items list asks what is missing here');
  assert.match(src, /not here yet/, 'and says so in words');
  const admin = read('../backoffice/sections/CompanyAdmin.jsx');
  assert.match(admin, /pullSharedProductsTo\(loc\.id\)/, 'a new venue gets every shared product at once');
});

test('the Items list shows each product\'s sharing in its own column, before Type', () => {
  const src = read('../backoffice/sections/MenuManager.jsx');
  const hdr = src.slice(src.indexOf("<div style={hdrSt}>Item</div>"), src.indexOf("<div style={hdrSt}>Type</div>"));
  assert.match(hdr, />Sharing</, 'Sharing sits between Item and Type');
  assert.match(src, /SCOPE_PILL\[item\.scope \|\| 'local'\]/);
  assert.match(src, /'26px minmax\(200px,1fr\) 84px 100px/, 'the grid has the extra column');
});

test('the bookings iPad can pick a date, get back to today, and fix the date on a new booking', () => {
  for (const f of ['../surfaces/bookings/DiaryScreen.jsx', '../surfaces/bookings/ServiceScreen.jsx']) {
    const src = read(f);
    assert.match(src, /<input type="date" value=\{bookingsDate \|\| todayISO\(\)\}/, f + ' has a real date picker');
    assert.match(src, /\{!isToday && <button[\s\S]*?>Today<\/button>\}/, f + ' offers Today when away from it');
  }
  const book = read('../surfaces/bookings/BookScreen.jsx');
  assert.match(book, /aria-label="Booking date"/);
  assert.match(book, /import \{[^}]*\btodayISO\b[^}]*\} from '\.\/bits/, 'todayISO is IMPORTED (24 Sep: it shipped undefined once)');
  const store = read('../store/index.js');
  assert.match(store, /functions\/v1\/customer-search/);
  const fn = read('../../supabase/functions/customer-search/index.ts');
  assert.match(fn, /from\('waitlist_devices'\)/); assert.match(fn, /from\('devices'\)/);
  assert.doesNotMatch(fn, /\.(insert|update|upsert|delete)\(/, 'read-only');
});

test('the Archived view loads archived products from the database, not just this session\'s', () => {
  // 24 Sep: Barnsley Train Station had 153 archived products; the view showed the one archived
  // since the page opened, because the boot load fetches archived=false only.
  const db = read('./db.js');
  assert.match(db, /export const fetchArchivedMenuItems = async/);
  assert.match(db, /\.eq\('archived', true\)/);
  const store = read('../store/index.js');
  assert.match(store, /loadArchivedMenuItems: async \(\) => \{/);
  assert.match(store, /const fresh = rows\.filter\(\(r\) => !have\.has\(r\.id\)\);/, 'rows already in memory win');
  const mm = read('../backoffice/sections/MenuManager.jsx');
  assert.match(mm, /loadArchivedMenuItems\?\.\(\)/);
  assert.match(mm, /\}, \[showArchived\]\);/, 'loaded when the view opens');
  assert.match(read('./realtime.js'), /export function mapMenuItemRow/);
});
