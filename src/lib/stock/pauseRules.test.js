/**
 * pauseRules.test.js: the paused item words and sets of Drop 1 (v5.11.86, multi site stock, map
 * 4.3), and the same words built on the server for the Manager app's po.raise (manager-approve).
 * Run: npm test. Synthetic ids and names only.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { dayWords, pausedNow, pauseWords, pausedSet, pausedMap, pausedLineWords } from './pauseRules.js';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');

test('dayWords: D Mon, en-GB short months, never the device clock', () => {
  assert.equal(dayWords('2026-11-03'), '3 Nov');
  assert.equal(dayWords('2026-09-30'), '30 Sep');
  assert.equal(dayWords('2026-01-01'), '1 Jan');
  assert.equal(dayWords('2026-12-31T00:00:00Z'), '31 Dec');
  for (const bad of [null, undefined, '', 'soon', '2026-13-01', '2026-00-10']) assert.equal(dayWords(bad), '', String(bad));
});

test('pausedNow: no end day is on; an end day is on through that day', () => {
  assert.equal(pausedNow({ everywhere: false, until: null }, '2026-11-03'), true);
  assert.equal(pausedNow({ everywhere: true, until: '2026-11-03' }, '2026-11-03'), true, 'the last day is inclusive');
  assert.equal(pausedNow({ until: '2026-11-03' }, '2026-11-04'), false);
  assert.equal(pausedNow({ until: '2026-11-03' }, '2026-10-30'), true);
  assert.equal(pausedNow({ until: '2026-11-03' }, null), true, 'no day known: the server said it is paused today');
  assert.equal(pausedNow(undefined, '2026-11-03'), true);
});

test('pauseWords: the four sentences of the mockup', () => {
  assert.equal(pauseWords({ siteName: 'Leeds', until: '2026-11-03' }), 'Paused at Leeds until 3 Nov');
  assert.equal(pauseWords({ siteName: 'Leeds' }), 'Paused at Leeds');
  assert.equal(pauseWords({ everywhere: true, until: '2026-11-03', siteName: 'Leeds' }), 'Paused everywhere until 3 Nov');
  assert.equal(pauseWords({ everywhere: true }), 'Paused everywhere');
  assert.equal(pauseWords({}), 'Paused');
  assert.equal(pauseWords(), 'Paused');
});

test('pausedSet and pausedMap: the site item ids; a pause that ended is left out', () => {
  const rows = [
    { site_item_id: 'si1', item_id: 'c1', everywhere: false, until: null },
    { site_item_id: 'si2', item_id: 'c2', everywhere: true, until: '2026-11-03' },
    { site_item_id: 'si3', item_id: 'c3', everywhere: false, until: '2026-10-01' },
    null, { item_id: 'x' },
  ];
  assert.deepEqual([...pausedSet(rows)], ['si1', 'si2', 'si3']);
  assert.deepEqual(pausedSet(null).size, 0);
  const m = pausedMap(rows, '2026-10-22');
  assert.deepEqual([...m.keys()], ['si1', 'si2']);
  assert.deepEqual(m.get('si2'), { siteItemId: 'si2', itemId: 'c2', everywhere: true, until: '2026-11-03' });
  assert.equal(pausedMap(rows).size, 3, 'no day given: every row the server sent');
  assert.equal(pausedLineWords('Oat milk', m.get('si1'), 'Leeds'), 'Oat milk: Paused at Leeds.');
  assert.equal(pausedLineWords('Oat milk', m.get('si2'), 'Leeds'), 'Oat milk: Paused everywhere until 3 Nov.');
  assert.equal(pausedLineWords('', null, ''), 'This item: Paused.');
});

// ── the server's copy (manager-approve po.raise) says the same words ─────────────────────────────
test('manager-approve po.raise: one service role read of the paused items, the same words, the order refused', () => {
  const src = read('../../../supabase/functions/manager-approve/index.ts');
  const start = src.indexOf('// pause words (src/lib/stock/pauseRules.js): start');
  const end = src.indexOf('// pause words: end');
  assert.ok(start > 0 && end > start, 'the words block is marked');
  const block = stripTypeScriptTypes(src.slice(start, end), { mode: 'strip' });
  const serverWords = new Function(`${block}; return { pauseDay, pauseWordsOf };`)();
  for (const until of [null, '2026-11-03', '2026-01-01', '2026-12-31', 'junk']) {
    for (const everywhere of [false, true]) {
      for (const siteName of ['Leeds', '', 'North Cafe']) {
        assert.equal(serverWords.pauseWordsOf({ siteName, everywhere, until }), pauseWords({ siteName, everywhere, until }), JSON.stringify({ siteName, everywhere, until }));
      }
    }
  }
  const raise = src.slice(src.indexOf("if (action === 'po.raise') {"), src.indexOf("const reference = 'MGR-'"));
  assert.match(raise, /await sb\.rpc\('stock_paused_items', \{ p_location: loc \}\)/, 'one read, with the service role client');
  assert.ok(raise.indexOf("rpc('stock_paused_items'") > raise.indexOf("if (itemIds.some((id) => !itemBy[id]))"), 'after the items are fenced to this venue');
  assert.ok(raise.indexOf("rpc('stock_paused_items'") < raise.indexOf("from('purchase_orders').insert") || raise.indexOf("from('purchase_orders').insert") === -1, 'before anything is written');
  assert.match(raise, /if \(paused\.length\) return json\(\{ error: paused\.join\(' '\) \}, 400\);/, 'a paused line refuses the order, naming it');
  assert.match(raise, /isMissingFn\(pausedErr\)/, 'a database before Drop 1 has no pause: nothing is refused');
});
