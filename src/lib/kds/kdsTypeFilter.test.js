// The type filter cannot hide tickets unnoticed (30 Sep 2026, Coffee Boy). See kdsTypeFilter.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import { FILTER_SNAP_BACK_MS, filterAfterIdle, hiddenByFilter, filterAfterArrival, hiddenCount, filterBanner } from './kdsTypeFilter.js';

test('snap back to All three minutes after the last pill tap, not before', () => {
  assert.equal(FILTER_SNAP_BACK_MS, 3 * 60 * 1000);
  const t0 = 1_000_000;
  assert.equal(filterAfterIdle({ filter: 'dineinName', tappedAt: t0, now: t0 + FILTER_SNAP_BACK_MS - 1 }), 'dineinName');
  assert.equal(filterAfterIdle({ filter: 'dineinName', tappedAt: t0, now: t0 + FILTER_SNAP_BACK_MS }), 'all');
  assert.equal(filterAfterIdle({ filter: 'dineinName', tappedAt: t0, now: t0 + 3 * 60 * 60 * 1000 }), 'all', 'the 3 hour incident');
  assert.equal(filterAfterIdle({ filter: 'all', tappedAt: t0, now: t0 }), 'all');
  assert.equal(filterAfterIdle({ filter: 'takeaway', tappedAt: null, now: t0 }), 'all', 'no tap time on record: never keep a filter');
  assert.equal(filterAfterIdle({ filter: undefined, tappedAt: t0, now: t0 }), 'all');
});

test('a ticket of a hidden type arriving snaps the filter back at once, with the chime', () => {
  assert.equal(hiddenByFilter('dineinName', 'takeaway'), true);
  assert.equal(hiddenByFilter('dineinName', 'dineinName'), false);
  assert.equal(hiddenByFilter('all', 'takeaway'), false);
  assert.deepEqual(filterAfterArrival({ filter: 'dineinName', typeKeys: ['takeaway'] }), { filter: 'all', snapped: true });
  assert.deepEqual(filterAfterArrival({ filter: 'dineinName', typeKeys: ['dineinName', 'dineinTable'] }), { filter: 'all', snapped: true });
  assert.deepEqual(filterAfterArrival({ filter: 'dineinName', typeKeys: ['dineinName'] }), { filter: 'dineinName', snapped: false }, 'a ticket the filter shows changes nothing');
  assert.deepEqual(filterAfterArrival({ filter: 'dineinName', typeKeys: [] }), { filter: 'dineinName', snapped: false });
  assert.deepEqual(filterAfterArrival({ filter: 'all', typeKeys: ['takeaway'] }), { filter: 'all', snapped: false });
  assert.deepEqual(filterAfterArrival({ filter: null, typeKeys: ['takeaway'] }), { filter: 'all', snapped: false });
});

test('the banner counts the hidden tickets and names the filter in plain words', () => {
  const views = [{ typeKey: 'dineinName' }, { typeKey: 'takeaway' }, { typeKey: 'takeaway' }, { typeKey: 'dineinTable' }];
  assert.equal(hiddenCount(views, 'dineinName'), 3);
  assert.equal(hiddenCount(views, 'takeaway'), 2);
  assert.equal(hiddenCount(views, 'all'), 0);
  assert.equal(hiddenCount([], 'takeaway'), 0);
  assert.equal(filterBanner('dineinName', 3), 'Showing Dine-in name only. 3 hidden.');
  assert.equal(filterBanner('takeaway', 0), 'Showing Takeaway only. 0 hidden.');
  assert.equal(filterBanner('drivethru', 1), 'Showing Drive thru only. 1 hidden.');
  assert.equal(filterBanner('all', 5), null);
  assert.equal(filterBanner(null, 5), null);
});

test('the board never saves the filter: no storage key for it anywhere in the KDS code', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../../surfaces/kds/KDSSurface.jsx', import.meta.url), 'utf8');
  const m = /const \[typeFilter, setTypeFilter\] = useState\(([^)]*)\)/.exec(src);
  assert.ok(m, 'typeFilter state not found');
  assert.equal(m[1], "'all'", 'every boot starts on All');
  assert.ok(!/typeFilter[^\n]*localStorage|localStorage[^\n]*typeFilter/.test(src), 'the filter must never touch storage');
});
