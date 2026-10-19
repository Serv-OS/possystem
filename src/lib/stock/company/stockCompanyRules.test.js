// node --test: the Shared stock rules (v5.11.80, multi site stock Phase 1).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  accessFromRpc, isNotInstalledError, refusalWords, ratePercent, parseRatePercent, planWords, healthLines, siteCardWords,
  versionWords, newsWords, mergeDraft, onAtSite, parseCsv, csvRowsFor, chunk,
} from './stockCompanyRules.js';
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
  assert.match(planWords('Preston', { items_changed: 1, items_off: 1, items_held: 1 }), /1 item switched off here\. 1 item still held here stays live/);
  assert.equal(planWords('X', { items_new: 1, packs_new: 1 }), 'X: 1 new stock item, 1 pack or unit. No stock quantities change.');
});

test('health lines, site cards, versions, news', () => {
  const h = healthLines({ block: [{ words: 'No VAT' }], warn: [{ words: 'Count them' }, 'plain'] });
  assert.deepEqual(h, { blocks: ['No VAT'], warns: ['Count them', 'plain'] });
  assert.deepEqual(healthLines(null), { blocks: [], warns: [] });
  assert.equal(siteCardWords({ last: { version_no: 4 } }).words, 'Stock in step (version 4)');
  assert.equal(siteCardWords({ waiting: { version_no: 5, due_at: 'T', status: 'waiting' } }, () => '05:00').words, 'Version 5 waits until 05:00');
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
