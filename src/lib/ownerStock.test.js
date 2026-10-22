// node --test: the Owner app's Stock line and Stock card words (src/lib/ownerStock.js, v5.11.92,
// multi site stock Drop 4a), and the wiring of the two screens that draw them.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  canStock, STOCK_NOTES, stockNote, stockTone, pctWords, daysWords, dayWords, moneyWords, stockLine, stockTiles, attentionRows, stockCardNote, ATTENTION_LABELS,
} from './ownerStock.js';

const read = (p) => fs.readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
// The two long dashes, built from their codes so this file carries neither of them itself.
const LONG_DASHES = new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`);

const block = (extra = {}) => ({
  value: 3210, gp_pct_theo: 74.1, gp_pct_actual: 72.8, gap_pct: 1.3, waste_pct: 1.9, comps_pct: 0.8, days_on_hand: 6.2,
  last_full_count_day: '2026-10-13', last_full_count_words: 'Tue 13 Oct', below_par_count: 4, negative_count: 0, no_recipe_pct: 2.1,
  sales_net: 18420, purchases: 4880, budget: null, kitchen: false,
  rag: { gp_pct: 'green', gap_pct: 'green', waste_pct: 'amber', comps_pct: 'green', days_on_hand: 'green' }, currency: 'GBP', ...extra,
});

test('the feature and the reasons: only a function that says stock draws anything; a missing block says why', () => {
  assert.equal(canStock({ features: ['period', 'compare', 'stock'] }), true);
  assert.equal(canStock({ features: ['period', 'compare'] }), false);
  assert.equal(canStock(null), false);
  assert.deepEqual(STOCK_NOTES, { not_installed: 'Stock reports need a ServOS update', no_stock: 'No stock at this venue', failed: 'Stock could not be read' });
  assert.equal(stockNote('not_installed'), 'Stock reports need a ServOS update');
  assert.equal(stockNote('no_stock'), 'No stock at this venue');
  assert.equal(stockNote('failed'), 'Stock could not be read');
  assert.equal(stockNote(null), null);
  assert.equal(stockNote('anything else'), null, 'never a made up reason');
  for (const w of Object.values(STOCK_NOTES)) assert.doesNotMatch(w, LONG_DASHES, w);
});

test('colours are the database\'s rag words; grey when it gave none', () => {
  assert.equal(stockTone('green'), 'var(--grn, #16a34a)');
  assert.equal(stockTone('amber'), 'var(--amber, #F5A623)');
  assert.equal(stockTone('red'), 'var(--red)');
  assert.equal(stockTone(null), 'var(--t3)');
  assert.equal(stockTone('purple'), 'var(--t3)');
});

test('words for the figures: one decimal percents, days, the count day, money in the venue\'s currency; nothing for a missing figure', () => {
  assert.equal(pctWords(72.84), '72.8%');
  assert.equal(pctWords(0), '0.0%');
  assert.equal(pctWords(null), null);
  assert.equal(pctWords('72.8'), null, 'a figure is a number from the function, never text');
  assert.equal(daysWords(6.24), '6.2');
  assert.equal(daysWords(null), null);
  assert.equal(dayWords('2026-10-13'), 'Tue 13 Oct');
  assert.equal(dayWords('2026-10-12'), 'Mon 12 Oct');
  assert.equal(dayWords('2026-13-40'), null);
  assert.equal(dayWords(null), null);
  assert.equal(dayWords('yesterday'), null);
  assert.equal(moneyWords(3210, 'GBP'), '£3,210');
  assert.equal(moneyWords(3210.4, 'USD'), 'US$3,210');
  assert.equal(moneyWords(null, 'GBP'), '£0');
  assert.doesNotMatch(moneyWords(1, 'nope'), LONG_DASHES);
});

test('the Stock line: value, GP, gap, waste, last count, in that order, the gap and waste coloured; a kitchen has no sales words', () => {
  const line = stockLine(block(), 'GBP');
  assert.equal(line.text, 'Stock £3,210 · GP 72.8% · gap 1.3% · waste 1.9% · last count Tue 13 Oct');
  assert.deepEqual(line.parts.map((p) => p.key), ['value', 'gp', 'gap', 'waste', 'count']);
  assert.equal(line.parts[2].tone, 'var(--grn, #16a34a)');
  assert.equal(line.parts[3].tone, 'var(--amber, #F5A623)', 'the waste carries its amber');
  assert.equal(line.parts[0].tone, null);
  assert.equal(line.parts[1].tone, null);
  // the block's own currency wins over the card's
  assert.equal(stockLine(block({ currency: 'USD' }), 'GBP').parts[0].text, 'Stock US$3,210');
  // no actual GP yet (no count both ends): the theoretical with its word; no sales: said so, never 100%
  assert.equal(stockLine(block({ gp_pct_actual: null }), 'GBP').parts[1].text, 'GP 74.1% theo');
  const none = stockLine(block({ gp_pct_actual: null, gp_pct_theo: null, gap_pct: null, waste_pct: null, rag: {} }), 'GBP');
  assert.equal(none.text, 'Stock £3,210 · GP: no sales · gap: no sales · waste: no sales · last count Tue 13 Oct');
  assert.equal(none.parts[2].tone, null, 'no colour on no figure');
  // no full count yet
  assert.equal(stockLine(block({ last_full_count_day: null }), 'GBP').parts.at(-1).text, 'no full count yet');
  // a budget shows only when one is set (none until the purchasing update), as money of money, never a percent
  assert.equal(stockLine(block({ budget: 5100 }), 'GBP').text, 'Stock £3,210 · GP 72.8% · gap 1.3% · waste 1.9% · budget £4,880 of £5,100 · last count Tue 13 Oct');
  assert.equal(stockLine(block({ budget: 5100, rag: { budget_pct: 'red' } }), 'GBP').parts.find((p) => p.key === 'budget').tone, 'var(--red)');
  assert.equal(stockLine(block({ budget: 0 }), 'GBP').parts.some((p) => p.key === 'budget'), false);
  // a central kitchen sells nothing
  assert.equal(stockLine(block({ kitchen: true }), 'GBP').text, 'Stock £3,210 · central kitchen, no sales · last count Tue 13 Oct');
  assert.equal(stockLine(null, 'GBP'), null);
  assert.equal(stockLine('x', 'GBP'), null);
  assert.doesNotMatch(line.text, LONG_DASHES);
  // the money format can be handed in (the screen's own)
  assert.equal(stockLine(block(), 'GBP', (n) => `#${n}`).parts[0].text, 'Stock #3210');
});

test('the Stock card tiles: nine figures with their colours, a missing one in grey words, never 0', () => {
  const tiles = stockTiles(block(), 'GBP');
  assert.deepEqual(tiles.map((t) => [t.key, t.label, t.text]), [
    ['value', 'Stock value', '£3,210'],
    ['gp_theo', 'GP % theoretical', '74.1%'],
    ['gp_actual', 'GP % actual', '72.8%'],
    ['gap', 'Gap %', '1.3%'],
    ['waste', 'Waste %', '1.9%'],
    ['comps', 'Loyalty, staff and comps %', '0.8%'],
    ['days', 'Days on hand', '6.2'],
    ['count', 'Last full count', 'Tue 13 Oct'],
    ['par', 'Below par', '4'],
  ]);
  const by = Object.fromEntries(tiles.map((t) => [t.key, t.tone]));
  assert.equal(by.value, 'var(--t1)');
  assert.equal(by.gp_theo, 'var(--t1)', 'the theoretical GP has no target of its own');
  assert.equal(by.gp_actual, 'var(--grn, #16a34a)');
  assert.equal(by.waste, 'var(--amber, #F5A623)');
  assert.equal(by.par, 'var(--amber, #F5A623)', 'items below par are a warning');
  assert.equal(stockTiles(block({ below_par_count: 0 }), 'GBP').find((t) => t.key === 'par').tone, 'var(--t1)');
  const bare = stockTiles(block({ gp_pct_actual: null, days_on_hand: null, last_full_count_day: null, rag: {} }), 'GBP');
  const b = Object.fromEntries(bare.map((t) => [t.key, t]));
  assert.deepEqual([b.gp_actual.text, b.gp_actual.tone], ['No sales', 'var(--t3)']);
  assert.deepEqual([b.days.text, b.days.tone], ['No use', 'var(--t3)']);
  assert.deepEqual([b.count.text, b.count.tone], ['None yet', 'var(--t3)']);
  // the budget tile appears only with a budget, before days on hand
  const withBudget = stockTiles(block({ budget: 5100, rag: { budget_pct: 'amber' } }), 'GBP');
  assert.equal(withBudget[6].key, 'budget');
  assert.equal(withBudget[6].text, '£4,880 of £5,100');
  assert.equal(withBudget[6].tone, 'var(--amber, #F5A623)');
  assert.equal(withBudget.length, 10);
  assert.deepEqual(stockTiles(null, 'GBP'), []);
  for (const t of tiles) { assert.doesNotMatch(t.label, LONG_DASHES); assert.doesNotMatch(t.text, LONG_DASHES); }
});

test('attention rows: one per kind, the biggest first, plain labels for the 4a kinds, rows worth nothing dropped', () => {
  const rows = attentionRows([
    { kind: 'below_minimum', location_id: 'L', site: 'Site A', count: 3, words: '3 items below minimum', ref: null },
    { kind: 'negative_stock', count: 1, words: '1 item below zero' },
    { kind: 'out_of_step', count: 0, words: 'Site out of step. Fix.' },
    { kind: 'below_minimum', count: 2, words: 'more' },
    { kind: 'something_new', count: 1 },
    null, 'junk',
  ]);
  assert.deepEqual(rows, [
    { kind: 'below_minimum', label: 'Below minimum', count: 5, words: '3 items below minimum' },
    { kind: 'negative_stock', label: 'Negative stock', count: 1, words: '1 item below zero' },
    { kind: 'something_new', label: 'Something new', count: 1, words: null },
  ]);
  assert.deepEqual(attentionRows(null), []);
  assert.deepEqual(Object.keys(ATTENTION_LABELS), ['negative_stock', 'below_minimum', 'out_of_step', 'invoice_review', 'clock_disagrees', 'demo_history', 'not_posted']);
  for (const w of Object.values(ATTENTION_LABELS)) assert.doesNotMatch(w, LONG_DASHES, w);
  // the card's grey line
  assert.equal(stockCardNote(block()), 'Stored day totals, each venue on its own business day.');
  assert.equal(stockCardNote(block({ demo_left_out: true })), 'Stored day totals, each venue on its own business day. Demo history left out.');
  assert.equal(stockCardNote(block({ not_posted: { count: 1, value: 12 } })), 'Stored day totals, each venue on its own business day. 1 sale not yet posted to stock.');
  assert.equal(stockCardNote(block({ demo_left_out: true, not_posted: { count: 3, value: 40 } })), 'Stored day totals, each venue on its own business day. Demo history left out. 3 sales not yet posted to stock.');
  assert.equal(stockCardNote(null), 'Stored day totals, each venue on its own business day.');
});

test('the screens: the Stock line only from a function with the feature, the card after Labour, no percent worked out, no long dashes (source)', () => {
  const surface = read('../surfaces/OwnerSurface.jsx');
  const reports = read('../surfaces/owner/OwnerReports.jsx');
  const lib = read('./ownerStock.js');
  for (const [name, src] of Object.entries({ surface, reports, lib })) {
    assert.doesNotMatch(src, LONG_DASHES, `${name} has no long dashes`);
    assert.doesNotMatch(src, /vsPct\(|\/ *100\)/, `${name} works out no percent`);
  }
  // the venue card: the line under the stats, only when the function says stock
  assert.ok(surface.includes("import { canStock, stockLine, stockNote } from '../lib/ownerStock';"));
  assert.ok(surface.includes('const stockOn = canStock(data);'));
  assert.ok(surface.includes('stockOn={stockOn} onOpen={() => openDetail(venueTarget(l))}'), 'every venue card is told whether the function sends stock');
  assert.ok(surface.includes('{stockOn && <StockLine stock={l.stock} reason={l.stock_reason} currency={l.currency} />}'));
  assert.ok(surface.includes('const line = stockLine(stock, currency);'));
  assert.ok(surface.includes('const note = stockNote(reason);'));
  assert.ok(surface.includes('return note ? <div') && surface.includes(': null;'), 'no block and no reason draws nothing: never a wrong label');
  // the venue screen: the eighth card, after Labour, hidden without a block
  const labourAt = reports.indexOf('<LabourCard labour={detail.labour} m={m} />');
  const stockAt = reports.indexOf('<StockCard stock={detail.stock} reason={detail.stock_reason} currency={currency} />');
  assert.ok(labourAt > 0 && stockAt > labourAt, 'Stock is the card after Labour');
  assert.ok(reports.includes('title="Stock"'));
  assert.ok(reports.includes("import { stockTiles, attentionRows, stockNote, stockCardNote } from '../../lib/ownerStock';"));
  assert.match(reports, /function StockCard\(\{ stock, reason, currency \}\) \{\s+if \(!stock\) \{\s+const note = stockNote\(reason\);\s+return note \? <ReportCard title="Stock"><Empty>\{note\}<\/Empty><\/ReportCard> : null;/);
  // nothing imported but React and the app's own files
  for (const m of reports.matchAll(/from '([^']+)'/g)) assert.ok(m[1] === 'react' || m[1].startsWith('.'), `unexpected import ${m[1]}`);
});

test('a stock value the database did not send is never shown as a zero', () => {
  assert.equal(stockLine(block({ value: null }), 'GBP').parts[0].text, 'Stock value not known');
  assert.equal(stockLine(block({ value: undefined }), 'GBP').parts[0].text, 'Stock value not known');
  assert.equal(stockLine(block({ value: 0 }), 'GBP').parts[0].text, `Stock ${moneyWords(0, 'GBP')}`, 'a true zero is a figure');
  const tile = stockTiles(block({ value: null }), 'GBP').find((t) => t.key === 'value');
  assert.deepEqual([tile.text, tile.tone], ['Not known', 'var(--t3)']);
  assert.equal(stockTiles(block(), 'GBP').find((t) => t.key === 'value').text, moneyWords(3210, 'GBP'));
});
