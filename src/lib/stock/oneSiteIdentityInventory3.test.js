// src/lib/stock/oneSiteIdentityInventory3.test.js
//
// Multi site stock Drop 3 (v5.11.96, contract 3.3): a ONE SITE company keeps exactly today's Stock
// counts, Wastage and Transfers screens. The proof for each file: take its text from the first
// import line, remove every line Drop 3 added (each carries the marker: the comment `// d3 multi`,
// or in JSX the empty expression {/* d3 multi */}), undo the few changed lines listed in its
// RESTORE table ([newText, oldText], each must be found exactly once), and the sha256 is main's
// (4f15e759, contract 0). Every changed line only adds a multi branch or reads a new server answer.
// The PIN prompt on Wastage renders only on the database's answer (no limit is set anywhere today).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';

const at = (p) => new URL(`../../backoffice/sections/${p}`, import.meta.url);
const MARK = /\/\/ d3 multi|\{\/\* d3 multi \*\/\}/;

const PINS = {
  'StockCounts.jsx': '2e77d1cbfa14257083ee2da1ffde474d2058699cc01592fe4f8bde1da5af8248',
  // v5.11.99 (Reports align): the Wastage log values waste from the stock ledger for EVERY company (one
  // source for every report), so the pin is that text, not 5.11.96's (was c0fcc4f9...).
  'Wastage.jsx': '07bccb49a573dc9deee7effd65408bb1abb7b38ff267f66d8c6ab2028a5a6472',
  'StockTransfers.jsx': 'bd342ab051e9e563e6436ec598bed3bc63aa063aae5f60d4d69a02b35c4be507',
};

const RESTORE = {
  'StockCounts.jsx': [
  // multi: a plain New count carries the site's matching plan id (null for one site)
  ["    const { data, error } = await createCount({ name, countType: type, areaIds, supplierId, itemIds, startedByName, items, tz: venueTz, planId: sc.multi ? planFor(type) : null }, locId);",
   "    const { data, error } = await createCount({ name, countType: type, areaIds, supplierId, itemIds, startedByName, items, tz: venueTz }, locId);"],
  // multi: the templates for the From a template card (null for one site)
  ["          loginName={loginName} onStart={startWithScope} onCancel={() => setStarting(false)} templates={sc.multi ? templates : null} onTemplate={startFromTemplate} />",
   "          loginName={loginName} onStart={startWithScope} onCancel={() => setStarting(false)} />"],
  // multi: the two new props, both off by default
  ["function NewCountPanel({ areas, suppliers, items, holdings, venueTz, busy, loginName, onStart, onCancel, templates = null, onTemplate = null }) {",
   "function NewCountPanel({ areas, suppliers, items, holdings, venueTz, busy, loginName, onStart, onCancel }) {"],
  ],
  'Wastage.jsx': [
  // the PIN is kept in a ref between the database's answer and the resend
  ["import { useState, useEffect, useMemo, useCallback, useRef } from 'react';",
   "import { useState, useEffect, useMemo, useCallback } from 'react';"],
  // server answer: the PIN answer of stock_record_waste; the reason shown; the PIN when asked
  ["    const { error, training, pin: pinState } = await logWaste({ inventoryItemId: row.item.id, qty: row.qty, unit: row.unit, reason: reasonNow, note: row.note, pin: pinNow.current }, locId);",
   "    const { error, training } = await logWaste({ inventoryItemId: row.item.id, qty: row.qty, unit: row.unit, reason: row.reason, note: row.note }, locId);"],
  // the first reason of the list shown (today's list for one site: the same first reason)
  ["    setRow({ item: null, qty: '', unit: 'each', reason: startReason(reasons), note: '' });",
   "    setRow({ item: null, qty: '', unit: 'each', reason: WASTE_REASONS[0], note: '' });"],
  // the reason shown (equals row.reason whenever it is on today's list, which is always for one site)
  ["              <select value={reasonNow} onChange={e => setRow(r => ({ ...r, reason: e.target.value }))} style={{ ...field, width: 160 }}>",
   "              <select value={row.reason} onChange={e => setRow(r => ({ ...r, reason: e.target.value }))} style={{ ...field, width: 160 }}>"],
  // the list shown (WASTE_REASONS for one site)
  ["                {reasons.map(r => <option key={r} value={r}>{r}</option>)}",
   "                {WASTE_REASONS.map(r => <option key={r} value={r}>{r}</option>)}"],
  ],
  'StockTransfers.jsx': [
  // multi: the request chip and its handler (off by default)
  ["        <NewTransfer locId={locId} areas={liveAreas} items={items} itemsById={itemsById} suppliers={suppliers} holdings={holdings} venues={venues.venues} byName={byName} multi={sc.multi} onRequest={() => setView({ kind: 'request' })}",
   "        <NewTransfer locId={locId} areas={liveAreas} items={items} itemsById={itemsById} suppliers={suppliers} holdings={holdings} venues={venues.venues} byName={byName}"],
  // multi: the Requested filter; one site keeps TRANSFER_FILTERS
  ["            {(sc.multi ? transferFilters({ multi: true }) : TRANSFER_FILTERS).map(f => <button key={f.id} style={chip(filter === f.id)} onClick={() => setFilter(f.id)}>{f.label}</button>)}",
   "            {TRANSFER_FILTERS.map(f => <button key={f.id} style={chip(filter === f.id)} onClick={() => setFilter(f.id)}>{f.label}</button>)}"],
  // multi: In transit and Short; one site keeps TRANSFER_STATUS_WORDS
  ["                  <span style={{ fontSize: 11, fontWeight: 700, color: statusColor(t.status), whiteSpace: 'nowrap' }}>{attention ? 'Receive' : (sc.multi ? statusWords({ ...t, shortLines: s.short }, { multi: true }) : (TRANSFER_STATUS_WORDS[t.status] || t.status))}</span>",
   "                  <span style={{ fontSize: 11, fontWeight: 700, color: statusColor(t.status), whiteSpace: 'nowrap' }}>{attention ? 'Receive' : (TRANSFER_STATUS_WORDS[t.status] || t.status)}</span>"],
  // multi: the two new props, both off by default
  ["function NewTransfer({ locId, areas, items, itemsById, suppliers, holdings, venues, byName, onDone, onError, multi = false, onRequest = null }) {",
   "function NewTransfer({ locId, areas, items, itemsById, suppliers, holdings, venues, byName, onDone, onError }) {"],
  // multi: In transit and Short on the detail; one site keeps TRANSFER_STATUS_WORDS
  ["          <span style={{ fontSize: 12, fontWeight: 700, color: statusColor(t.status) }}>{sc.multi ? statusWords(t, { multi: true }) : (TRANSFER_STATUS_WORDS[t.status] || t.status)}</span>",
   "          <span style={{ fontSize: 12, fontWeight: 700, color: statusColor(t.status) }}>{TRANSFER_STATUS_WORDS[t.status] || t.status}</span>"],
  // server answer: a line matched by company item (stock_transfer_matches), only ever set for multi
  ["                    <div style={{ fontSize: 11, color: 'var(--t3)' }}>{[l.skuSnapshot, l.dropped ? 'dropped' : receiving ? (l.matchedBy === 'sku' ? 'matched by SKU' : l.matchedBy === 'name' ? 'matched by name' : l.matchedBy === 'kept' ? 'matched' : l.matchedBy === 'company' ? 'matched by company item' : l.toInventoryItemId ? 'matched by hand' : (l.ambiguous?.length ? `${l.ambiguous.length} of your items match: pick one` : 'no match yet')) : null].filter(Boolean).join(' · ')}</div>",
   "                    <div style={{ fontSize: 11, color: 'var(--t3)' }}>{[l.skuSnapshot, l.dropped ? 'dropped' : receiving ? (l.matchedBy === 'sku' ? 'matched by SKU' : l.matchedBy === 'name' ? 'matched by name' : l.matchedBy === 'kept' ? 'matched' : l.toInventoryItemId ? 'matched by hand' : (l.ambiguous?.length ? `${l.ambiguous.length} of your items match: pick one` : 'no match yet')) : null].filter(Boolean).join(' · ')}</div>"],
  ],
};
// Multi site stock Drop 4a (v5.11.98, contract 2.4): the "See the report" links on an approved count and on
// Wastage. Each renders nothing for a one site company (canOpenReports is false there), so they are taken
// out first ([newText, oldText], each found exactly once), then the Drop 3 lines and pairs as above.
const D4A = {
  'StockCounts.jsx': [
    ['  // v5.11.92 (Drop 4a, contract 2.4): an approved count links to Reports > Stock and GP > Theoretical against actual.\n  const { takeOpenNew, openReport, canOpenReports } = useStockScope();\n', '  const { takeOpenNew } = useStockScope();\n'],
    ['            {approved && canOpenReports && locId && (\n              <button type="button" onClick={() => openReport({ report: \'stock_gap\', sites: { kind: \'sites\', ids: [locId] }, period: \'between-counts\' })}\n                style={{ background: \'transparent\', border: \'none\', padding: 0, color: \'var(--acc)\', fontSize: 12, fontWeight: 700, cursor: \'pointer\', fontFamily: \'inherit\' }}>See the gap report</button>\n            )}\n', ''],
  ],
  'Wastage.jsx': [
    ['  const { openReport, canOpenReports } = useStockScope();\n', ''],
    ['      {/* v5.11.92 (Drop 4a, contract 2.4): the link renders nothing for a one site company (canOpenReports false), so its HTML is today\'s. */}\n      {canOpenReports && locId && (\n        <button type="button" onClick={() => openReport({ report: \'stock_waste\', sites: { kind: \'sites\', ids: [locId] }, period: \'last-week\' })}\n          style={{ background: \'transparent\', border: \'none\', padding: \'0 0 6px\', color: \'var(--acc)\', fontSize: 13, fontWeight: 700, cursor: \'pointer\', fontFamily: \'inherit\' }}>See the report</button>\n      )}\n', ''],
  ],
  'StockTransfers.jsx': [],
};
// contract 3.3: at most 8 changed lines on Stock counts and Transfers
const MAX_PAIRS = { 'StockCounts.jsx': 8, 'Wastage.jsx': 8, 'StockTransfers.jsx': 8 };

function mainText(file) {
  const src = fs.readFileSync(at(file), 'utf8');
  let text = src.slice(src.indexOf('import '));
  for (const [now, was] of D4A[file]) {
    assert.equal(text.split(now).length - 1, 1, `${file}: the Drop 4a lines are there exactly once: ${now.trim().slice(0, 90)}`);
    text = text.replace(now, () => was);
  }
  text = text.split('\n').filter((l) => !MARK.test(l)).join('\n');
  for (const [now, was] of RESTORE[file]) {
    assert.equal(text.split(now).length - 1, 1, `${file}: the changed line is there exactly once: ${now.trim().slice(0, 90)}`);
    text = text.replace(now, () => was);
  }
  return text;
}

for (const file of Object.keys(PINS)) {
  test(`${file}: the marked lines out and the RESTORE pairs undone give main's text (sha256)`, () => {
    assert.ok(RESTORE[file].length <= MAX_PAIRS[file], `${file}: at most ${MAX_PAIRS[file]} changed lines`);
    const sha = crypto.createHash('sha256').update(mainText(file)).digest('hex');
    assert.equal(sha, PINS[file]);
  });
}

test('every marked line is real code for a multi site company or a server answer, never a dash', () => {
  for (const file of Object.keys(PINS)) {
    const src = fs.readFileSync(at(file), 'utf8');
    const marked = src.split('\n').filter((l) => MARK.test(l));
    assert.ok(marked.length > 0, `${file} has Drop 3 lines`);
    for (const l of marked) assert.doesNotMatch(l, /[\u2013\u2014]/, `${file}: ${l.trim().slice(0, 80)}`);
    for (const [now] of RESTORE[file]) assert.doesNotMatch(now, /[\u2013\u2014]/);
  }
});

test('Wastage: the PIN prompt and End of day are behind the answer and the multi flag', () => {
  const src = fs.readFileSync(at('Wastage.jsx'), 'utf8');
  assert.match(src, /\{pinAsk && <ManagerPinPrompt /, 'the prompt shows only once the database asked');
  assert.match(src, /if \(pinState\) \{ setPinAsk\(/);
  assert.match(src, /\{sc\.multi && <button onClick=\{\(\) => setCloseDown\(true\)\}/);
  assert.match(src, /useWasteReasons\(sc\.multi \? locId : null, stockApi\)/, 'a one site company makes no reasons read');
});

test('Stock counts and Transfers: the company pieces are behind sc.multi (and head office for plans)', () => {
  const counts = fs.readFileSync(at('StockCounts.jsx'), 'utf8');
  assert.match(counts, /const editor = sc\.multi && !!sc\.canEditCompany\?\.\('inventory'\);/);
  assert.match(counts, /\{sc\.multi && <CountDueStrip siteId=\{locId\} \/>\}/);
  assert.match(counts, /if \(!sc\.multi \|\| !sc\.orgId\) return/, 'a one site company never reads plans or templates');
  const tr = fs.readFileSync(at('StockTransfers.jsx'), 'utf8');
  assert.match(tr, /if \(!sc\.multi \|\| !rows\.length\) return/, 'a one site company never reads the new columns');
  for (const word of ["'Fulfil'", "'Refuse'", "'Dispute'", "'Resolve'"]) assert.ok(tr.includes(`>${word.slice(1, -1)}</button>`), word);
});
