import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePushSnapshot, isNewerPush } from './configPushReceive.js';

test('a snapshot that came with the event is used as it is, no read', async () => {
  let reads = 0;
  const snap = { menuItems: [1] };
  assert.equal(await resolvePushSnapshot({ id: 'p1', snapshot: snap }, async () => { reads++; return {}; }), snap);
  assert.equal(reads, 0);
});

test('a push over the 1 MB realtime limit arrives without its snapshot: it is read by id (Barnsley)', async () => {
  const stored = { menuItems: new Array(498).fill(0) };
  const got = await resolvePushSnapshot({ id: 'p2', location_id: 'c5dd8483' }, async (id) => (id === 'p2' ? stored : null));
  assert.equal(got, stored);
});

test('a failed or empty read gives null and never throws', async () => {
  assert.equal(await resolvePushSnapshot({ id: 'p3' }, async () => { throw new Error('offline'); }), null);
  assert.equal(await resolvePushSnapshot({ id: 'p3' }, async () => null), null);
  assert.equal(await resolvePushSnapshot({ snapshot: null }, async () => ({})), null);
  assert.equal(await resolvePushSnapshot(null, async () => ({})), null);
});

test('an older push that finishes loading late never replaces a newer one', () => {
  const t1 = Date.parse('2026-09-30T08:00:00Z');
  assert.equal(isNewerPush({ created_at: '2026-09-30T07:59:00Z' }, t1), false);
  assert.equal(isNewerPush({ created_at: '2026-09-30T08:00:00Z' }, t1), true);
  assert.equal(isNewerPush({ created_at: '2026-09-30T08:01:00Z' }, t1), true);
  assert.equal(isNewerPush({}, t1), true);
  assert.equal(isNewerPush({ created_at: '2026-09-30T08:01:00Z' }, NaN), true);
});
