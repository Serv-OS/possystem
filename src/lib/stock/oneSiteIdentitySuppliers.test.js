// src/lib/stock/oneSiteIdentitySuppliers.test.js
//
// Multi site stock Drop 1 (Rule 2): a one site company sees exactly today's Suppliers screen. The
// screen moved whole from src/backoffice/sections/Suppliers.jsx (main f1a8f397, v5.11.84) into
// src/backoffice/sections/stock/suppliers/SuppliersSplit.jsx. Node tests cannot render JSX here, so
// the proof is the text: undo the allowed edits and the sha256 must be main's file, from its first
// import line. Any other change (a word, a style, a field, a save) fails this test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(here, rel), 'utf8');
const SPLIT = '../../backoffice/sections/stock/suppliers/SuppliersSplit.jsx';
const ROUTER = '../../backoffice/sections/Suppliers.jsx';
const MAIN_SHA = 'f086cad13d4fbee23b8231eab79b3184779154ce5d951ca8b4c9370dccdacd97';

const count = (text, needle) => text.split(needle).length - 1;
const fromFirstImport = (text) => {
  const at = text.search(/^import /m);
  assert.ok(at >= 0, 'the file has an import line');
  return text.slice(at);
};

// The edits the move is allowed to make, each with how many times it must appear.
const EDITS = [
  { moved: "from '../../../../", was: "from '../../", times: 5 },
  { moved: "from '../../reports/reportKit'", was: "from './reports/reportKit'", times: 1 },
  { moved: 'export default function SuppliersSplit({ siteId = null } = {}) {', was: 'export default function Suppliers() {', times: 1 },
  { moved: 'useState(siteId || getActiveLocationSync())', was: 'useState(getActiveLocationSync())', times: 1 },
];

test('SuppliersSplit is main\'s Suppliers.jsx byte for byte, apart from the allowed edits', () => {
  let body = fromFirstImport(read(SPLIT));
  for (const e of EDITS) {
    assert.equal(count(body, e.moved), e.times, `${e.moved} appears ${e.times} time(s)`);
    body = body.split(e.moved).join(e.was);
  }
  const sha = createHash('sha256').update(body).digest('hex');
  assert.equal(sha, MAIN_SHA, 'the one site Suppliers screen changed: put it back exactly as main had it');
});

test('SuppliersSplit keeps every one site field, word and save of today', () => {
  const s = read(SPLIT);
  // the form fields and the words a one site owner sees today
  for (const words of ['title="Suppliers"', 'Search suppliers…', 'No suppliers yet. Press + to add one.', 'Select a supplier, or press + to add one.',
    'Contact name', 'Account number', 'Payment terms (days)', 'Min order value', 'Cut-off time', 'Delivery days', 'Notes',
    "'Save changes' : 'Create supplier'", 'Archive']) {
    assert.ok(s.includes(words), words);
  }
  assert.match(s, /upsertSupplier\(draft, locId, \{ section: 'purchasing' \}\)/, 'one save of every field, named as Purchasing');
  assert.match(s, /setSupplierArchived\(draft\.id, true, locId, \{ section: 'purchasing', version: draft\.rowVersion \}\)/);
  // no multi site words or pieces leak into the one site screen
  for (const word of ['useStockScope', 'StockScope', 'Can order', 'Order rules', 'Local to', 'head office', 'stockApi']) {
    assert.ok(!s.includes(word), `no ${word} in the one site screen`);
  }
});

test('the router sends a one site company straight to SuppliersSplit and nothing else', () => {
  const r = read(ROUTER);
  assert.match(r, /export default function Suppliers\(\{ siteId = null \} = \{\}\) \{/);
  assert.match(r, /import SuppliersSplit from '\.\/stock\/suppliers\/SuppliersSplit';/);
  // the body, in order: the scope, not ready, one site, an open supplier, the list
  const body = r.slice(r.indexOf('export default function Suppliers('));
  const lines = ['const sc = useStockScope();',
    "if (!sc.ready) return <div style={{ padding: 16, color: 'var(--t3)', fontSize: 13 }}>Loading…</div>;",
    'if (!sc.multi) return <SuppliersSplit siteId={siteId} />;',
    // integrator (Drop 1): a supplier another screen asked for opens on arrival, multi site only
    "if (!open && sc.peekOpen?.('suppliers')?.id) return <OpenOnArrival take={sc.takeOpen} onOpen={setOpen} />;",
    "if (open) return <SupplierPage supplierId={open.id} startTab={open.tab || 'sites'} onBack={() => setOpen(null)} />;",
    'return <SupplierList onOpen={(id, opts = {}) => setOpen({ id, ...opts })} />;'];
  let at = -1;
  for (const line of lines) {
    const next = body.indexOf(line);
    assert.ok(next > at, `in order: ${line}`);
    at = next;
  }
  // nothing is drawn around the one site screen: no wrapper, no picker, no extra words
  assert.equal(count(body, 'return '), 5, 'five answers: loading, one site, a supplier asked for, a supplier page, the list');
  assert.ok(!/<SuppliersSplit[^/]*\/>\s*<\//.test(body), 'SuppliersSplit is never inside another element');
});

test('no em or en dash in the new Suppliers files (the moved file keeps its own words)', () => {
  const files = [ROUTER, '../../backoffice/sections/stock/suppliers/SupplierList.jsx', '../../backoffice/sections/stock/suppliers/AddSupplierModal.jsx',
    '../../backoffice/sections/stock/suppliers/SupplierPage.jsx', '../../backoffice/sections/stock/suppliers/SupplierDetailsTab.jsx',
    '../../backoffice/sections/stock/suppliers/SupplierSitesTab.jsx', '../../backoffice/sections/stock/suppliers/SupplierOrderRulesTab.jsx',
    '../../backoffice/sections/stock/suppliers/SupplierItemsTab.jsx', '../../backoffice/sections/stock/suppliers/SupplierItemSitesPopover.jsx',
    '../../backoffice/sections/stock/suppliers/SupplierChangesTab.jsx', './orderRules.js', './supplierListRules.js'];
  // the tests too (they name the banned words only to look for them, so only the dash rule here)
  for (const f of ['./orderRules.test.js', './supplierListRules.test.js', './oneSiteIdentitySuppliers.test.js']) {
    assert.ok(!/[\u2013\u2014]/.test(read(f)), `${f} has no em or en dash`);
  }
  for (const f of files) {
    const text = read(f);
    assert.ok(!/[\u2013\u2014]/.test(text), `${f} has no em or en dash`);
    assert.ok(!/window\.confirm/.test(text), `${f} never uses window.confirm`);
    assert.ok(!new RegExp(['str', 'ipe'].join(''), 'i').test(text), `${f} never names the old card processor`);
  }
  // the moved file's leading comment is new, so it follows the rule too
  const split = read(SPLIT);
  assert.ok(!/[\u2013\u2014]/.test(split.slice(0, split.search(/^import /m))), 'the SuppliersSplit comment has no dash');
});

// ── the company supplier screens (multi site only): what they call, read from the source ────────
const DIR = '../../backoffice/sections/stock/suppliers/';
const SCREENS = ['SupplierList.jsx', 'AddSupplierModal.jsx', 'SupplierPage.jsx', 'SupplierDetailsTab.jsx', 'SupplierSitesTab.jsx',
  'SupplierOrderRulesTab.jsx', 'SupplierItemsTab.jsx', 'SupplierItemSitesPopover.jsx', 'SupplierChangesTab.jsx'];

test('the company supplier screens talk to the database only through stockApi, never a table write', () => {
  for (const f of SCREENS) {
    const s = read(DIR + f);
    assert.ok(!/from '[./]*lib\/supabase'/.test(s), `${f} never imports the browser client`);
    assert.ok(!/\.from\(\s*['"`]/.test(s), `${f} reads or writes no table directly`);
    assert.ok(!/\.(rpc|upsert|insert)\(/.test(s), `${f} calls no database function itself`);
    assert.ok(!/lib\/stock\/data'/.test(s), `${f} never uses the one site data.js saves`);
  }
});

test('each save names Purchasing and carries the version the screen read', () => {
  const list = read(DIR + 'SupplierList.jsx');
  assert.match(list, /stockApi\.suppliersPage\(\{ orgId: sc\.orgId, sites, search: query \|\| null, filters: archived \? \{ archived: true \} : null, after \}\)/, '100 a page, keyset (after), the Archived chip');
  const add = read(DIR + 'AddSupplierModal.jsx');
  assert.match(add, /stockApi\.saveSupplier\(\{ supplier, sites, version: null, section: 'purchasing' \}\)/, 'one call with the ticked sites');
  assert.match(add, /if \(!local && !ticked\.length\)/, 'a company supplier needs a site ticked (none would make it local to one site)');
  const details = read(DIR + 'SupplierDetailsTab.jsx');
  assert.match(details, /stockApi\.saveSupplier\(\{ supplier: \{ id: s\.id, \.\.\.where, \.\.\.supplier \}, sites: null, version: v, section: 'purchasing' \}\)/);
  assert.match(details, /const placeOf = s\.local_location_id \|\| \(detail\?\.sites \|\| \[\]\)\.find\(\(d\) => d && d\.site_supplier_id\)\?\.location_id \|\| null;/,
    'named at its own site, or a site that has its row (never a site with no row: "This supplier is not set up at that site.")');
  assert.match(details, /if \(r\.error\) \{ setError\(r\.error\); return \{ error: r\.error \}; \}/, 'Save mine on top answers the refusal, so the modal says no "Saved" toast');
  assert.ok(!/showToast\?\.\(`Saved on top/.test(details), 'the modal says Saved on top itself: never twice');
  assert.match(details, /send\(checked\.supplier, version\)/, 'the company row_version it read');
  assert.match(details, /<SavedFirstModal /, 'someone saved first opens the modal');
  const sites = read(DIR + 'SupplierSitesTab.jsx');
  assert.match(sites, /stockApi\.saveSupplier\(\{ supplier: \{ id: s\.id \}, sites: \[\{ location_id: row\.site\.id, on \}\], version: detail\?\.row_version \?\? null, section: 'purchasing' \}\)/, 'Can order: only sites, with the version');
  assert.match(sites, /stockApi\.saveSupplierSite\(s\.id, row\.site\.id, \{ \[key\]: v\.value \}, link\.link_row_version \?\? null\)/, 'one value per save, the link version');
  const rules = read(DIR + 'SupplierOrderRulesTab.jsx');
  assert.match(rules, /stockApi\.saveOrderRules\(supplier\.id, row\.site\.id, checked\.rules, row\.link\?\.link_row_version \?\? null\)/, 'the whole set of one site, checked first');
  assert.match(rules, /const checked = validRules\(next\);/);
  assert.match(rules, /stockApi\.copyOrderRules\(s\.id, from\.site\.id, to\)/);
  const items = read(DIR + 'SupplierItemsTab.jsx');
  assert.match(items, /stockApi\.pricesPage\(\{ supplierId: s\.id, siteId: site \? site\.id : null, search: query \|\| null, after \}\)/);
  assert.match(items, /<ChangePricesModal[\s\S]*?section="purchasing"/, 'Change prices as a Purchasing change');
  assert.match(items, /<PauseModal[\s\S]*?section="purchasing"/, 'Pause at sites as a Purchasing change');
  assert.match(items, /<ImportModal [^>]*kind="supplier_item" supplier=\{\{ id: s\.id, name: s\.name \}\}/);
  assert.match(items, /const canImport = editor && sc\.canEditCompany\('inventory'\);/, 'an import is an Inventory change: never offered when it would be refused');
  const pop = read(DIR + 'SupplierItemSitesPopover.jsx');
  assert.match(pop, /stockApi\.saveSupplierItemSite\(row\.supplier_item_id, site\.id, patch, version, 'purchasing'\)/);
  const changes = read(DIR + 'SupplierChangesTab.jsx');
  assert.match(changes, /stockApi\.changesPage\('supplier', supplierId, null\)/);
  const page = read(DIR + 'SupplierPage.jsx');
  assert.match(page, /stockApi\.makeCompanyRecord\('supplier', supplierId, detail\?\.row_version \?\? null\)/);
});

test('greyed, never refused: each edit control follows the rights the database checks', () => {
  const sites = read(DIR + 'SupplierSitesTab.jsx');
  assert.match(sites, /canEditSiteField\('can_order', id, can\) && !local/, 'a local supplier ticks no other site');
  assert.match(sites, /const editable = canEditSiteField\(c\.key, id, can\);/);
  assert.match(sites, /company: sc\.canEditCompany\('purchasing'\), site: sc\.canEditSite/);
  const rules = read(DIR + 'SupplierOrderRulesTab.jsx');
  assert.match(rules, /const editor = sc\.canEditCompany\('purchasing'\);/);
  assert.match(rules, /\{!editor && <div style=\{\{ marginBottom: 12 \}\}><LockLine entity="supplier"/, 'others see the lock line');
  const page = read(DIR + 'SupplierPage.jsx');
  assert.match(page, /editable=\{editor \|\| \(local && sc\.canEditSite\(localId, 'site_facts'\)\)\}/, 'a site edits its own local supplier freely');
  assert.match(page, /\{local && editor && <Btn onClick=\{makeCompany\}/, 'Make it a company supplier: company editors only');
  const list = read(DIR + 'SupplierList.jsx');
  assert.match(list, /\{editor \? '\+ Add supplier' : '\+ Add a local supplier'\}/);
  const pop = read(DIR + 'SupplierItemSitesPopover.jsx');
  assert.match(pop, /sc\.canEditSite\(site\.id, 'site_price'\) \|\| sc\.canEditCompany\('purchasing'\)/, 'price here: full control or the company');
});
