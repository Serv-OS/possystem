// src/lib/liveRow.test.js
//
// 12 Oct 2026. A live change with an error carries no record. The realtime library hands it to
// the page as new = {} (truthy), and the server sends it to every subscriber on the table. That
// is how the menu boards lost their pairing on the night of 11 to 12 Oct. liveRow is the one
// check a handler runs before it uses the row. These tests are the rule and the three places
// outside the menu board that now use it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { liveRow } from './liveRow.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const count = (text, part) => text.split(part).length - 1;

test('a change with no usable row gives null', () => {
  assert.equal(liveRow(null), null);
  assert.equal(liveRow(undefined), null);
  assert.equal(liveRow('x'), null);
  assert.equal(liveRow({}), null);
  assert.equal(liveRow({ new: null }), null);
  assert.equal(liveRow({ new: {} }), null, 'the shape of 12 Oct with no errors key');
  assert.equal(liveRow({ new: {}, old: {}, errors: ['Error 401: Unauthorized'] }), null, 'the shape of 12 Oct');
  assert.equal(liveRow({ new: { id: null } }), null);
  assert.equal(liveRow({ new: { id: '' } }), null);
  assert.equal(liveRow({ new: 'row' }), null);
});

test('a change with errors is never a row, even when it kept its id', () => {
  // Error 413 (too large) keeps the small fields, the id among them, and drops the rest.
  assert.equal(liveRow({ new: { id: 'a' }, errors: ['Error 413: Payload Too Large'] }), null);
  assert.equal(liveRow({ new: { id: 'a', x: 1 }, errors: 'x' }), null);
  assert.equal(liveRow({ new: { id: 'a', x: 1 }, errors: ['x'] }), null);
});

test('a real row comes back as it is', () => {
  const row = { id: 'a', x: 1 };
  assert.equal(liveRow({ new: row, errors: null }), row);
  assert.equal(liveRow({ new: row, errors: [] }), row);
  assert.equal(liveRow({ new: row }), row);
  assert.deepEqual(liveRow({ new: { id: 0 } }), { id: 0 }, 'an id of 0 is still an id');
});

test('the kitchen screen never draws a ticket from a change with no row', () => {
  const kds = read('../surfaces/kds/KDSSurface.jsx');
  assert.match(kds, /import \{ liveRow \} from '\.\.\/\.\.\/lib\/liveRow'/);
  // Both handlers check the change on the line before they hand its row to the board engine
  // (v5.11.62: the engine, lib/kds/kdsBoardEngine.js, owns the live changes; the screen only
  // guards them).
  assert.equal(count(kds, "          if (!liveRow(payload)) return;\n          if (alive) eng.liveInsert(payload.new);\n"), 1, 'the INSERT handler');
  assert.equal(count(kds, "          if (!liveRow(payload)) return;\n          if (alive) eng.liveUpdate(payload.new);\n"), 1, 'the UPDATE handler');
  // The third use is the screen's own device row (centre_id): apply() ignores a row with no
  // centre_id, so an empty change does nothing there either.
  assert.equal(count(kds, 'payload.new'), 3, 'no other use of a live row');
  assert.equal(count(kds, "(payload) => apply(payload.new))"), 1, 'the device row handler');
  assert.match(kds, /if \(!alive \|\| !row \|\| !\('centre_id' in row\)\) return;/, 'which ignores a change with no row');
  assert.equal(count(kds, 'mapRow(payload.new)'), 0, 'the screen no longer maps a live row itself');
});

test('the till bell and the ops page skip a change with no row', () => {
  const bell = read('../components/ActivityFeed.jsx');
  assert.equal(count(bell, 'liveRow(p)'), 2, 'INSERT and UPDATE');
  assert.equal(count(bell, '(p) => { const r = liveRow(p); if (!r) return; setEvents('), 2, 'each handler stops when there is no row');
  assert.equal(count(bell, '({ new: r })'), 0);
  assert.equal(count(bell, '.new'), 0, 'the row is only ever taken through liveRow (no "liveRow(p) || p.new")');
  const ops = read('../backoffice/sections/operations/OpsOverview.jsx');
  assert.equal(count(ops, 'liveRow(p)'), 1);
  assert.equal(count(ops, 'p.new'), 0, 'no toast for an alert that does not exist');
  assert.match(ops, /if \(r\) showToast\?\.\(r\.title \|\| 'New ops alert', 'error'\); reload\(\);/, 'it still reloads, which is an ordinary read');
});
