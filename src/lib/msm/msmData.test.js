// Multi site menu: the screens' data layer (msmData.js). Fail closed access with a stale guard,
// staging with compare and set (two editors on one cell get a conflict, never a silent last write
// wins), every write reported to saveHealth, publish now kicks the runner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMsmData, refusalWords } from './msmData.js';
import { fakeClient } from './fakeClient.js';

const reports = () => { const r = []; return { r, report: (entity, error) => r.push([entity, error ? String(error.message || error) : null]) }; };

test('access: named and switched on opens; not installed and failures hide; a late answer never wins', async () => {
  const on = createMsmData({ client: fakeClient({}, { rpcs: { msm_my_access: () => ({ data: { companies: [{ org_id: 'o', enabled: true, role: 'editor' }] }, error: null }) } }) });
  const a = await on.readAccess('o');
  assert.deepEqual([a.canOpen, a.canEdit], [true, true]);
  const missing = createMsmData({ client: fakeClient({}) });
  const m = await missing.readAccess('o');
  assert.deepEqual([m.installed, m.canOpen], [false, false]);
  let release;
  const slow = createMsmData({ client: { rpc: (name) => (name === 'msm_my_access' && !release ? new Promise((r) => { release = () => r({ data: { companies: [{ org_id: 'o', enabled: true, role: 'editor' }] } }); }) : Promise.resolve({ data: { companies: [] } })) } });
  const first = slow.readAccess('o');
  const second = await slow.readAccess('o');
  release();
  const late = await first;
  assert.equal(second.canOpen, false);
  assert.equal(late.stale, true);
  assert.equal(late.canOpen, false, 'the earlier read answered late: ignored');
  const hung = createMsmData({ client: { rpc: () => new Promise(() => {}) } });
  const h = await hung.readAccess('o', { timeoutMs: 20 });
  assert.equal(h.canOpen, false, 'a hung read hides it (fail closed)');
});

test('staging: insert, then update with compare and set on updated_at, then a conflict when another editor got there first', async () => {
  const client = fakeClient({ msm_changes: [] });
  const { r, report } = reports();
  const api = createMsmData({ client, report });
  const base = { target: 'product_site', entity_id: 'p', location_id: 's1', op: 'update' };
  const one = await api.stage('set1', { ...base, after: { price: 3.1 }, before: { price: 3 } }, null);
  assert.equal(one.ok, true);
  assert.equal(client.db.msm_changes.length, 1);
  const row = { ...client.db.msm_changes[0], id: 'c1', updated_at: 't1' };
  client.db.msm_changes[0] = row;
  const two = await api.stage('set1', { ...base, after: { price: 3.2 }, before: { price: 3.1 } }, row);
  assert.equal(two.ok, true);
  assert.deepEqual(client.db.msm_changes[0].after, { price: 3.2 });
  assert.deepEqual(client.db.msm_changes[0].before, { price: 3 }, 'the first before kept');
  client.db.msm_changes[0].updated_at = 't2';          // another editor saved meanwhile
  const three = await api.stage('set1', { ...base, after: { price: 3.3 }, before: { price: 3.2 } }, row);
  assert.equal(three.ok, false);
  assert.equal(three.conflict, true);
  assert.match(three.words, /Someone else changed this/);
  assert.deepEqual(client.db.msm_changes[0].after, { price: 3.2 }, 'their change stands');
  assert.ok(r.every(([e]) => e === 'multi site menu change'));
});

test('a write the database refuses is reported to saveHealth in words, and not shown as done', async () => {
  const client = fakeClient({}, { fail: { msm_changes: 'new row violates row-level security policy for table "msm_changes"' } });
  const { r, report } = reports();
  const api = createMsmData({ client, report });
  const res = await api.stage('s', { target: 'product', entity_id: 'p', op: 'update', after: { name: 'x' }, before: { name: 'y' } }, null);
  assert.equal(res.ok, false);
  assert.match(res.words, /only people ServOS added as an editor/);
  assert.equal(r.at(-1)[1] !== null, true, 'the banner hears about it');
  assert.equal(refusalWords({ message: 'JWT expired' }), 'Your sign in has expired. Sign in again; nothing was saved.');
});

test('stageMany stages in order, merging into the draft\'s rows', async () => {
  const client = fakeClient({ msm_changes: [] });
  const api = createMsmData({ client });
  const out = await api.stageMany('s', [
    { target: 'product', entity_id: 'a', op: 'update', after: { default_price: 3 }, before: { default_price: 2.8 } },
    { target: 'product', entity_id: 'b', op: 'update', after: { default_price: 2 }, before: { default_price: 2 } },
  ]);
  assert.deepEqual([out.ok, out.done, out.failed.length], [true, 1, 0], 'a change that changes nothing is skipped');
});

test('publish now: freezes in the database, then asks the runner straight away; a lost call says it will start within a minute', async () => {
  const invoked = [];
  const client = fakeClient({}, { rpcs: { msm_publish_now: () => ({ data: { ok: true, version_id: 'v9', sites: [] }, error: null }) } });
  client.functions = { invoke: async (name, opts) => { invoked.push([name, opts.body]); return { data: { ok: true, status: 'done' }, error: null }; } };
  const api = createMsmData({ client });
  const res = await api.publishNow('set1');
  assert.equal(res.ok, true);
  assert.deepEqual(invoked, [['msm-publish', { action: 'run_version', version_id: 'v9' }]]);
  client.functions.invoke = async () => ({ data: null, error: { message: 'Failed to fetch' } });
  const lost = await api.publishNow('set1');
  assert.equal(lost.ok, true);
  assert.equal(lost.data.runWords, 'Publishing will start within a minute.');
});

test('schedule sends the wall clock time as the database reads it', async () => {
  let seen;
  const api = createMsmData({ client: fakeClient({}, { rpcs: { msm_schedule_set: (a) => { seen = a; return { data: { ok: true }, error: null }; } } }) });
  await api.schedule('s', '2026-12-01T06:00', 5, true);
  assert.deepEqual(seen, { p_set: 's', p_run_local: '2026-12-01 06:00', p_lead_minutes: 5, p_apply_when_idle: true });
});

test('the Menu Manager lock list: a Map, or null (as today) whenever it cannot be read', async () => {
  const api = createMsmData({ client: fakeClient({}, { rpcs: { msm_managed_items: () => ({ data: [{ venue_item_id: 'v1', product_id: 'p1', kept: ['cat'] }], error: null }) } }) });
  const m = await api.managedItems('loc');
  assert.deepEqual(m.get('v1'), { productId: 'p1', kept: ['cat'] });
  const none = createMsmData({ client: fakeClient({}) });
  assert.equal(await none.managedItems('loc'), null);
});

test('drafts need a name; renaming a set that is no longer a draft says so', async () => {
  const client = fakeClient({ msm_change_sets: [{ id: 's1', status: 'scheduled', title: 'x' }] });
  const api = createMsmData({ client });
  assert.equal((await api.createDraft('m', '  ')).ok, false);
  const r = await api.renameDraft('s1', 'New');
  assert.equal(r.ok, false);
  assert.match(r.words, /no longer a draft/);
});
