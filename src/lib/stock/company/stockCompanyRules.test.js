// node --test: the Shared stock rules (v5.11.80, multi site stock Phase 1).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  accessFromRpc, isNotInstalledError, refusalWords, ratePercent, parseRatePercent, planWords, healthLines, siteCardWords,
  versionWords, newsWords, mergeDraft, onAtSite, parseCsv, csvRowsFor, chunk, changeWords, versionRowWords, costLines, showDiscardAll,
} from './stockCompanyRules.js';
import { fmtWhen } from '../../../backoffice/sections/stock/mssShared.js';
import { createStockCompanyData } from './stockCompanyData.js';

test('access fails closed and needs both switches and a role', () => {
  assert.equal(accessFromRpc(null).canOpen, false);
  assert.equal(accessFromRpc({ error: { code: 'PGRST202', message: 'Could not find the function' } }).installed, false);
  assert.equal(accessFromRpc({ error: { message: 'boom' } }).installed, true);
  const data = { companies: [
    { org_id: 'a', org_name: 'A', role: 'viewer', enabled: true, menu_enabled: true },
    { org_id: 'b', org_name: 'B', role: 'editor', enabled: true, menu_enabled: false },
  ] };
  const a = accessFromRpc({ data });
  assert.equal(a.canOpen, true); assert.equal(a.canEdit, false); assert.equal(a.orgId, 'a');
  assert.equal(accessFromRpc({ data }, 'b').orgId, 'a', 'a company with the menu off is never opened');
  assert.equal(accessFromRpc({ data: { companies: [{ org_id: 'c', role: 'editor', enabled: false, menu_enabled: true }] } }).canOpen, false);
  assert.equal(accessFromRpc({ data: { companies: [{ org_id: 'c', role: 'owner', enabled: true, menu_enabled: true }] } }).canOpen, false);
});

test('not installed and refusal words', () => {
  assert.equal(isNotInstalledError({ code: '42883' }), true);
  assert.equal(isNotInstalledError({ message: 'relation "msm_stock_items" does not exist' }), true);
  assert.equal(isNotInstalledError({ message: 'Managed by head office' }), false);
  assert.match(refusalWords({ message: 'JWT expired' }), /sign in has expired/i);
  assert.match(refusalWords({ message: 'canceling statement due to statement timeout' }), /too long/);
  assert.equal(refusalWords({ message: 'Only the newest version can be undone.' }), 'Only the newest version can be undone.');
});

test('VAT as a percent and back', () => {
  assert.equal(ratePercent(0.2), '20%');
  assert.equal(ratePercent(0.125), '12.5%');
  assert.equal(ratePercent(null), '');
  assert.equal(parseRatePercent('20'), 0.2);
  assert.equal(parseRatePercent('12.5%'), 0.125);
  assert.equal(parseRatePercent(''), null);
  assert.ok(Number.isNaN(parseRatePercent('abc')));
  assert.ok(Number.isNaN(parseRatePercent('120')));
});

test('plan words say what reaches a site and that no quantity changes', () => {
  assert.equal(planWords('Leeds', { items_new: 42, suppliers_new: 3, prices_new: 120 }),
    'Leeds: 42 new stock items, 3 suppliers, 120 prices. No stock quantities change.');
  assert.equal(planWords('Leeds', { items_changed: 2, prices_changed: 1 }), 'Leeds: 3 changed. No stock quantities change.');
  assert.equal(planWords('Leeds', {}), 'Leeds: nothing to change.');
  assert.match(planWords('Preston', { items_changed: 1, items_off: 1, items_held: 1 }), /1 item switched off here\. 1 item still held here stays live \(with their packs and prices\) and are archived by the next publish/);
  assert.equal(planWords('X', { items_new: 1, packs_new: 1 }), 'X: 1 new stock item, 1 pack or unit. No stock quantities change.');
});

test('health lines, site cards, versions, news', () => {
  const h = healthLines({ block: [{ words: 'No VAT' }], warn: [{ words: 'Count them' }, 'plain'] });
  assert.deepEqual(h, { blocks: ['No VAT'], warns: ['Count them', 'plain'] });
  assert.deepEqual(healthLines(null), { blocks: [], warns: [] });
  assert.equal(siteCardWords({ last: { version_no: 4 } }).words, 'Stock in step (version 4)');
  assert.equal(siteCardWords({ waiting: { version_no: 5, due_at: 'T', status: 'waiting' } }, () => '05:00').words, 'Version 5 waits until 05:00');
  assert.equal(siteCardWords({ name: 'Location 2', waiting: { version_no: 5, due_at: 'T', status: 'waiting' } }, () => '05:00').words, 'Version 5 waits until 05:00 on Location 2\'s clock');
  assert.equal(siteCardWords({ waiting: { version_no: 5, status: 'failed', last_error: 'no VAT' } }).tone, 'bad');
  assert.match(siteCardWords({ waiting: { version_no: 5, status: 'waiting', last_error: 'busy' } }).words, /busy/);
  assert.equal(siteCardWords({}).words, 'Nothing published here yet');
  assert.equal(versionWords({ kind: 'publish', status: 'done', summary: { writes: 3 } }), 'Publish, done, 3 rows written');
  assert.equal(versionWords({ kind: 'undo', status: 'waiting', summary: {} }), 'Undo, waiting');
  assert.equal(newsWords({ items_added: 12, items_changed: 3 }), 'Head office added 12 items and changed 3 items.');
  assert.equal(newsWords({ items_added: 0 }), null);
  assert.equal(newsWords({ prices_changed: 1, last_at: 'x' }, () => 'Tuesday'), 'Head office changed 1 price (last on Tuesday).');
});

test('the draft lays over a page: fields, every site switch and site ticks', () => {
  const rows = [
    { id: 'i1', name: 'Milk', all_sites: false, sites: { L1: { active: true, own_tick: true }, L2: { active: false, own_tick: null } } },
    { id: 'i2', name: 'Beans', all_sites: true, sites: {} },
  ];
  const out = mergeDraft(rows, [
    { target: 'item', entity_id: 'i1', data: { name: 'Whole milk', all_sites: true } },
    { target: 'item_site', entity_id: 'i1', location_id: 'L1', data: { active: false } },
    { target: 'item_site', entity_id: 'i2', location_id: 'L3', data: { active: null } },
  ]);
  assert.equal(out[0].name, 'Whole milk'); assert.equal(out[0].staged, true);
  assert.equal(onAtSite(out[0], 'L1'), false, 'its own tick off wins');
  assert.equal(onAtSite(out[0], 'L2'), true, 'no tick follows every site');
  assert.equal(onAtSite(out[1], 'L3'), true);
  assert.equal(onAtSite(out[1], 'L9'), true);
  assert.equal(out[1].staged, true);
  assert.equal(mergeDraft(rows, [])[0], rows[0], 'an untouched row is the same object');
  assert.equal(onAtSite(rows[0], 'L2'), false);
});

test('CSV: quotes, doubled quotes, CR LF, blank lines and a BOM', () => {
  const t = parseCsv('﻿name,sku\r\n"Milk, whole",M1\n\n"Say ""hi""",\n');
  assert.deepEqual(t, [['name', 'sku'], ['Milk, whole', 'M1'], ['Say "hi"', '']]);
  assert.deepEqual(parseCsv('a,b'), [['a', 'b']]);
});

test('CSV headings map to the import fields, missing ones are named', () => {
  const r = csvRowsFor('items', [['Name', 'SKU', 'Base unit', 'VAT %', 'Colour'], ['Milk', 'M1', 'l', '0', 'white'], ['', '', '', '', '']]);
  assert.deepEqual(r.rows, [{ name: 'Milk', sku: 'M1', base_unit: 'l', purchase_vat: '0' }]);
  assert.deepEqual(r.missing, []); assert.deepEqual(r.unknown, ['Colour']);
  const p = csvRowsFor('prices', [['Supplier', 'Item', 'Price', 'Inner unit'], ['Dairy Co', 'M1', '6.60', 'l']]);
  assert.deepEqual(p.rows[0], { supplier: 'Dairy Co', item: 'M1', pack_price: '6.60', inner_unit: 'l' });
  assert.deepEqual(csvRowsFor('packs', [['Item', 'Name']]).missing, ['qty_in_base']);
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});

test('the data layer: one call per 2,000 staged changes, pages read past the cap, not installed', async () => {
  const calls = [];
  const client = {
    rpc: async (name, args) => { calls.push([name, args]); return name === 'boom' ? { error: { message: 'x' } } : { data: { staged: (args.p_changes || []).length } }; },
    from: (table) => {
      const q = { table, filters: [] };
      const api = {
        select: () => api, eq: (c, v) => { q.filters.push([c, v]); return api; }, order: () => api,
        range: async (a, b) => {
          if (table === 'msm_stock_drafts') return { data: [{ id: 'd1' }] };
          const total = 2300;
          const rows = []; for (let i = a; i <= Math.min(b, total - 1); i++) rows.push({ id: `c${i}` });
          return { data: rows };
        },
      };
      return api;
    },
  };
  const api = createStockCompanyData({ client });
  const changes = Array.from({ length: 4500 }, (_, i) => ({ target: 'item', entity_id: `e${i}`, data: {} }));
  const r = await api.stage('org', changes);
  assert.equal(r.ok, true);
  assert.deepEqual(calls.filter((c) => c[0] === 'msm_stock_stage').map((c) => c[1].p_changes.length), [2000, 2000, 500]);
  const d = await api.draft('org');
  assert.equal(d.ok, true); assert.equal(d.data.length, 2300, 'every page of the draft, past 1,000 rows');
  const missing = createStockCompanyData({ client: { rpc: async () => ({ error: { code: 'PGRST202', message: 'Could not find the function' } }) } });
  const m = await missing.itemsPage('org');
  assert.equal(m.ok, false); assert.equal(m.notInstalled, true);
  const acc = await missing.access();
  assert.equal(acc.installed, false); assert.equal(acc.canOpen, false);
});

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const ID = (n) => `c466af46-0000-4000-8000-${String(n).padStart(12, '0')}`;

test('round 1: a staged change in words names the item, supplier, pack and site; never an id', () => {
  const rows = [
    { target: 'sp', entity_id: ID(1), data: { _new: true, item_id: ID(2), supplier_id: ID(3), pack_price: 5.5, inner_unit: 'each', inner_qty: 100 }, item_name: 'Cups', supplier_name: 'Dairy Co' },
    { target: 'sp_site', entity_id: ID(1), location_id: ID(4), site_name: 'Provo', data: { pack_price: 4.8 }, item_name: 'Cups', supplier_name: 'Dairy Co' },
    { target: 'item', entity_id: ID(5), data: { purchase_tax_rate: 0.05, default_area_kind: 'walk_in', returns_to_shelf: true }, item_name: 'Lemons' },
    { target: 'item_site', entity_id: ID(5), location_id: ID(4), site_name: 'Location 2', data: { active: false }, item_name: 'Lemons' },
    { target: 'item_site', entity_id: ID(5), location_id: ID(4), site_name: 'Location 2', data: { link: ID(9), active: true }, item_name: 'Lemons' },
    { target: 'pack', entity_id: ID(6), data: { _new: true, item_id: ID(5), name: 'Crate', qty_in_base: 24, parent_pack_id: ID(7) }, item_name: 'Lemons', pack_name: 'Crate', parent_pack_name: 'Pallet' },
    { target: 'bridge', entity_id: ID(8), data: { _new: true, item_id: ID(5), from_qty: 1, from_unit: 'each', to_qty: 110, to_unit: 'g' }, item_name: 'Lemons' },
    { target: 'supplier_site', entity_id: ID(3), location_id: ID(4), site_name: 'Provo', data: { active: true, account_number: 'P-1' }, supplier_name: 'Dairy Co' },
  ];
  const words = rows.map(changeWords);
  for (const w of words) assert.doesNotMatch(w, UUID, w);
  assert.equal(words[0], 'New Supplier price: Cups from Dairy Co: price 5.5, unit each, each holds 100');
  assert.equal(words[1], 'Price: Cups from Dairy Co at Provo: price 4.8');
  assert.equal(words[2], 'Stock item: Lemons: VAT 5%, usual area Walk in fridge, can go back on the shelf yes');
  assert.equal(words[3], 'Stock item: Lemons at Location 2: off here');
  assert.match(words[4], /joins the site's own row, on here/);
  assert.equal(words[5], 'New Pack: Lemons, pack Crate: inside Pallet, name Crate, holds 24');
  assert.equal(words[6], 'New Unit bridge: Lemons: 1 each = 110 g');
  assert.equal(words[7], 'Supplier: Dairy Co at Provo: on here, account number P-1');
});

test('round 1: History rows in words: what, how, and fields without ids or bookkeeping', () => {
  const w = versionRowWords({ tbl: 'supplier_products', op: 'link', name: 'Cups from dairy co', before: { company_ref: null, supplier_id: ID(1), pack_price: 5.4, purchase_tax_rate_id: ID(2), updated_at: 'x' },
    after: { company_ref: ID(3), pack_price: 5, archived_at: null } }, () => 'Mon 19 Oct, 05:00');
  assert.deepEqual(w, { what: 'Supplier price: Cups from dairy co', how: 'Joined the company row', before: 'price 5.4', after: 'price 5, archived cleared' });
  const c = versionRowWords({ tbl: 'item_cost', op: 'update', name: 'Cups', before: { current_cost: 0.05, open_history: [ID(4)] }, after: { current_cost: 0.055, history_id: ID(5), name: 'Cups' } });
  assert.equal(c.what, 'Cost here: Cups');
  assert.equal(c.before, 'cost here 0.05');
  assert.equal(c.after, 'cost here 0.055, name Cups');
  const a = versionRowWords({ tbl: 'inventory_item_areas', op: 'insert', name: 'Whole milk in Bar', after: { item: ID(6), area_id: ID(7) } });
  assert.deepEqual([a.what, a.how, a.after], ['Area: Whole milk in Bar', 'Added', '']);
  for (const x of [w, c, a]) for (const v of Object.values(x)) assert.doesNotMatch(v, UUID);
});

test('round 1: the preview\'s cost here before and after, and its words', () => {
  const plan = { items_changed: 1, prices_changed: 1, costs_changed: 2, cost_rule: 'price_list', costs: [{ name: 'Cups', before: 0.05, after: 0.055 }, { name: 'Whole milk', before: null, after: 0.0011, new: true }] };
  assert.deepEqual(costLines(plan), ['Cups: 0.05 to 0.055', 'Whole milk: new here, cost 0.0011']);
  assert.match(planWords('Provo', plan), /No stock quantities change\. Cost here moves for 2 items \(this site follows its price list\)\./);
  assert.match(planWords('Leeds', { ...plan, cost_rule: 'deliveries' }), /deliveries rule: only items never received/);
  assert.deepEqual(costLines({}), []);
});

test('round 1: a wait time is on the site\'s clock, not the viewer\'s', () => {
  // 05:00 UK on 25 Oct is 04:00 UTC (BST ends on the 25th at 01:00 UTC, so 05:00 GMT = 05:00 UTC)
  const iso = '2026-10-25T05:00:00Z';
  assert.match(fmtWhen(iso, 'Europe/London'), /05:00/);
  assert.match(fmtWhen(iso, 'America/Los_Angeles'), /22:00/);
  const card = { name: 'Location 2', timezone: 'Europe/London', waiting: { version_no: 12, due_at: iso, status: 'waiting' } };
  assert.match(siteCardWords(card, fmtWhen).words, /^Version 12 waits until Sun 25 Oct, 05:00 on Location 2's clock$/);
});

test('round 1: a draft that cannot be read still offers Discard all; the Review page reads names from the server', async () => {
  assert.equal(showDiscardAll({ canEdit: true, total: 0, readError: 'Too many rows to show at once.' }), true);
  assert.equal(showDiscardAll({ canEdit: true, total: 3 }), true);
  assert.equal(showDiscardAll({ canEdit: true, total: 0 }), false);
  assert.equal(showDiscardAll({ canEdit: false, total: 3, readError: 'x' }), false);
  const calls = [];
  const api = createStockCompanyData({ client: { rpc: async (name, args) => { calls.push([name, args]); return { data: { total: 2, rows: [] }, error: null }; } } });
  const r = await api.draftRows('org', { limit: 300 });
  assert.equal(r.ok, true);
  assert.deepEqual(calls[0], ['msm_stock_draft_rows', { p_org: 'org', p_offset: 0, p_limit: 300 }]);
});
