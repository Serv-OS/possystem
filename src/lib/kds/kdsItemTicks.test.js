// v5.9.96: untick an item on the kitchen screen (Peter, 27 Sep 2026: "you can't untick an item
// if you click by accident"), and the save order that keeps the last tap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  toggleTick, touchedTicks, ticksMatch, overlayTicks, mergeIncomingTicks, ticksActive, tickFlags, LOCAL_TICKS_GRACE_MS,
} from './kdsItemTicks.js';

const it3 = () => [{ name: 'Latte' }, { name: 'Toastie', _bumped: false }, { name: 'Brownie', voided: true }];

test('a tap ticks, a second tap unticks', () => {
  const a = toggleTick(it3(), 0);
  assert.equal(a.ticked, true);
  assert.equal(a.items[0]._bumped, true);
  const b = toggleTick(a.items, 0);
  assert.equal(b.ticked, false);
  assert.equal(b.items[0]._bumped, false);
  assert.equal(b.items[1], a.items[1], 'other lines are not copied');
  assert.equal(toggleTick(it3(), 7), null);
  assert.equal(toggleTick(it3(), -1), null);
  assert.equal(toggleTick(null, 0), null);
});

test('touched lines: the tapped line plus an active earlier tap, valued from what is being saved', () => {
  const now = 1000;
  const items = [{ _bumped: true }, { _bumped: false }, {}];
  const first = touchedTicks(null, 0, items, now);
  assert.deepEqual([...first], [[0, true]]);
  const active = { touched: first, settledBy: null };
  const second = touchedTicks(active, 1, [{ _bumped: true }, { _bumped: true }, {}], now);
  assert.deepEqual([...second].sort(), [[0, true], [1, true]]);
  const expired = { touched: first, settledBy: now - 1 };
  assert.deepEqual([...touchedTicks(expired, 1, items, now)], [[1, false]], 'an expired tap is not carried');
});

test('an older save arriving late never flips an item back', () => {
  const now = 5000;
  // Ticked by accident, then unticked: the screen holds line 0 as NOT ticked.
  const pending = { touched: new Map([[0, false]]), settledBy: null };
  const lateEcho = { id: 'k1', items: [{ _bumped: true }, { _bumped: true, name: 'other screen' }] };
  const { row, settled } = mergeIncomingTicks(lateEcho, pending, now);
  assert.equal(row.items[0]._bumped, false, 'our untick stays');
  assert.equal(row.items[1]._bumped, true, 'another screen tick on another line still shows');
  assert.equal(settled, false);
});

test('the database copy settles the tap once it matches, or after the grace', () => {
  const t0 = 10_000;
  const pending = { touched: new Map([[0, false]]), settledBy: t0 + LOCAL_TICKS_GRACE_MS };
  const match = { id: 'k1', items: [{ _bumped: false }, { voided: true }] };
  const r1 = mergeIncomingTicks(match, pending, t0);
  assert.equal(r1.settled, true);
  assert.equal(r1.row, match, 'a matching row is shown as it came (voids from the till included)');
  // Still saving: a matching copy is shown but the tap is kept (an older save may still echo).
  const saving = { touched: new Map([[0, false]]), settledBy: null };
  assert.equal(mergeIncomingTicks(match, saving, t0).settled, false);
  // Past the grace the database wins even when it disagrees.
  const stale = { id: 'k1', items: [{ _bumped: true }] };
  const r2 = mergeIncomingTicks(stale, { ...pending, sent: [[true]] }, t0 + LOCAL_TICKS_GRACE_MS + 1);
  assert.equal(r2.settled, true);
  assert.equal(r2.row.items[0]._bumped, true);
  assert.equal(ticksActive(pending, t0 + LOCAL_TICKS_GRACE_MS + 1), false);
  assert.equal(ticksActive(saving, Number.MAX_SAFE_INTEGER), true);
});

test('overlay and match only look at touched lines', () => {
  const touched = new Map([[1, true]]);
  const items = [{ _bumped: false, voided: true }, { _bumped: false }];
  const out = overlayTicks(items, touched);
  assert.equal(out[0], items[0]);
  assert.equal(out[1]._bumped, true);
  assert.equal(ticksMatch(out, touched), true);
  assert.equal(ticksMatch(items, touched), false);
  assert.equal(ticksMatch(items, null), true);
});

test('wiring: the tick box toggles and the screen saves in order (source pins)', () => {
  const card = fs.readFileSync(new URL('../../surfaces/kds/KdsTicketCard.jsx', import.meta.url), 'utf8');
  assert.match(card, /onClick=\{\(e\) => \{ e\.stopPropagation\(\); if \(!disabled\) onTick\(\); \}\}/);
  assert.doesNotMatch(card, /if \(!ticked && !disabled\) onTick\(\)/, 'a ticked box must not ignore taps');
  const surf = fs.readFileSync(new URL('../../surfaces/kds/KDSSurface.jsx', import.meta.url), 'utf8');
  assert.match(surf, /const next = toggleTick\(t\.items, index\);/);
  assert.match(surf, /if \(ticked && shouldBumpAfterTick\(items, settingsRef\.current\)\) \{ bump\(id\); return; \}/, 'unticking never bumps');
  assert.match(surf, /entry\.chain = \(prev\?\.chain \|\| Promise\.resolve\(\)\)\.then\(/, 'saves for one ticket run in order');
  assert.match(surf, /if \(localTicks\.current\.get\(id\) !== entry\) return;/, 'only the newest tap saves');
  assert.match(surf, /setRows\(data\.map\(r => withLocalTicksRef\.current\(mapRow\(r\)\)\)\);/, 'the refetch keeps local ticks');
  assert.equal((surf.match(/const t = withLocalTicksRef\.current\(mapRow\(payload\.new\)\);/g) || []).length, 2, 'both live update paths keep local ticks');
});

test('review round: after our last save, only a late copy of our OWN save is held back', () => {
  const t0 = 50_000;
  // Ticked by accident (sent [T]) then unticked (sent [F]); the last save has finished.
  const pending = { touched: new Map([[0, false]]), sent: [[true, false], [false, false]], settledBy: t0 + LOCAL_TICKS_GRACE_MS };
  const lateOwn = { id: 'k1', items: [{ _bumped: true }, { _bumped: false }] };
  const a = mergeIncomingTicks(lateOwn, pending, t0 + 100);
  assert.equal(a.row.items[0]._bumped, false, 'a late echo of our tick save does not flip the untick back');
  assert.equal(a.settled, false);
  // Another screen unticked a line we had ticked: that was never one of our saves, so it shows.
  const mine = { touched: new Map([[0, true]]), sent: [[true, false]], settledBy: t0 + LOCAL_TICKS_GRACE_MS };
  const foreign = { id: 'k1', items: [{ _bumped: false }, { _bumped: false }] };
  const b = mergeIncomingTicks(foreign, mine, t0 + 100);
  assert.equal(b.row, foreign, 'another screen change on a touched line shows straight away');
  assert.equal(b.settled, true);
  // While our save is still waiting or running, ours wins (it lands after anything arriving now).
  const c = mergeIncomingTicks(foreign, { ...mine, settledBy: null }, t0 + 100);
  assert.equal(c.row.items[0]._bumped, true);
  assert.deepEqual(tickFlags([{ _bumped: 1 }, {}, null]), [true, false, false]);
});

test('review round: the save is built when it starts, from the newest copy on screen (source pin)', () => {
  const surf = fs.readFileSync(new URL('../../surfaces/kds/KDSSurface.jsx', import.meta.url), 'utf8');
  assert.match(surf, /const cur = ticketsRef\.current\.find\(x => x\.id === id\);\n\s*const payload = cur \? overlayTicks\(cur\.items, entry\.touched\) : entry\.items;/);
  assert.match(surf, /ticketWrite\(id, \{ items: payload \}/);
  assert.doesNotMatch(surf, /ticketWrite\(id, \{ items: entry\.items \}/, 'never the copy taken at tap time');
});
