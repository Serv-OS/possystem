// src/lib/menuBoardPairing.test.js
//
// 12 Oct 2026. The night of 11 to 12 Oct every Coffee Boy menu board but one dropped to its
// pairing code: one bad realtime message (an error, an empty record) was saved as the screen and
// one tick later each TV made itself a new unpaired row. These tests drive the TV's own rules
// (runPairingTick, applyLiveUpdate, decideView) against a small stand in for the server that
// counts every call. The first test is that night, step by step.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import * as P from './menuBoardPairing.js';

const U1 = '9e695ca5-0000-4000-8000-000000000001';
const U2 = '9e695ca5-0000-4000-8000-000000000002';
const A = 'caa49948-8820-4aeb-a4ce-e40f32edb1d5';
const N = '0a749919-9473-4738-b9ef-157dfa171a58';
const C = '4c0674cd-a34a-4b14-977e-cd8e152d32f5';
const BOARD = 'b0000000-0000-4000-8000-0000000000b1';
const BOARD2 = 'b0000000-0000-4000-8000-0000000000b2';
const OSD = 'd0000000-0000-4000-8000-0000000000d1';
const LOC = 'e0000000-0000-4000-8000-0000000000e1';

const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const jwt = (claims) => `${b64u({ alg: 'HS256', typ: 'JWT' })}.${b64u(claims)}.sig`;
const row = (id, over = {}) => ({ id, device_uid: U1, code: 'ABCD-EFGH', location_id: LOC, org_id: null, board_id: BOARD, order_display_id: null,
  name: null, status: 'paired', last_seen_at: '2026-10-12T02:09:47.000Z', paired_at: '2026-09-30T09:46:28.000Z', created_at: '2026-09-30T09:42:30.000Z', updated_at: null, ...over });
const unclaimed = (id, over = {}) => row(id, { location_id: null, board_id: null, status: 'unpaired', paired_at: null, code: 'WXYZ-2345', ...over });
const BAD_ECHO = { schema: 'public', table: 'menu_board_screens', eventType: 'UPDATE', new: {}, old: {}, errors: ['Error 401: Unauthorized'] };

// A tiny stand in for the server and the TV shell. Rows live in `rows`; every call is counted.
function world({ rows = [], uid = U1, saved = null, startAt = 1_800_000_000_000 } = {}) {
  const w = {
    rows: rows.map((r) => ({ ...r })), uid, now: startAt, token: true, tokenLifeS: 3600, expired: false,
    calls: { readRow: 0, checkGone: 0, readOwned: 0, insertRow: 0, heartbeat: 0, setScreen: 0 },
    said: [], notes: [], persisted: saved, subscribed: null, beatTokens: [], readTokens: [],
    fail: { readRow: false, checkGone: false, readOwned: false }, hideRows: false, insertErrors: [], codes: 0,
  };
  const who = (token) => P.readToken(token).uid;
  // What the real server answers when the token has run out: an error, never "no rows".
  const EXPIRED = { data: null, error: { code: 'PGRST303', message: 'JWT expired' } };
  w.io = {
    now: () => w.now,
    getToken: async () => (w.token ? jwt({ sub: w.uid, role: 'authenticated', exp: Math.floor(w.now / 1000) + w.tokenLifeS }) : null),
    readRow: async (id, token) => {
      w.calls.readRow += 1; w.readTokens.push(token);
      if (w.expired) return EXPIRED;
      if (w.fail.readRow) return { data: null, error: { message: 'Failed to fetch' } };
      if (w.hideRows) return { data: null, error: null };
      return { data: w.rows.find((r) => r.id === id && r.device_uid === who(token)) || null, error: null };
    },
    checkGone: async (id, token) => {
      w.calls.checkGone += 1;
      if (w.expired) return EXPIRED;
      if (w.fail.checkGone) return { data: null, error: { message: 'timeout' } };
      const r = w.rows.find((x) => x.id === id && x.device_uid === who(token));
      if (!r) return { data: { paired: false, reason: 'no_screen' }, error: null };
      return { data: { paired: false, reason: 'not_assigned' }, error: null };
    },
    readOwned: async (u, token) => {
      w.calls.readOwned += 1;
      if (w.expired) return EXPIRED;
      if (w.fail.readOwned) return { data: null, error: { message: 'Failed to fetch' } };
      return { data: w.rows.filter((r) => r.device_uid === u && r.device_uid === who(token)), error: null };
    },
    insertRow: async (token) => {
      w.calls.insertRow += 1;
      if (w.expired) return EXPIRED;
      const e = w.insertErrors.shift();
      if (e) return { data: null, error: e };
      const r = unclaimed(`f0000000-0000-4000-8000-00000000000${w.rows.length % 10}`, { device_uid: who(token), code: `NEWC-000${++w.codes}`, last_seen_at: null });
      w.rows.push(r);
      return { data: { ...r }, error: null };
    },
    heartbeat: (id, token) => { w.calls.heartbeat += 1; w.beatTokens.push(token); const r = w.rows.find((x) => x.id === id); if (r) r.last_seen_at = new Date(w.now).toISOString(); },
    subscribe: (id) => { w.subscribed = id; },
    setScreen: (s) => { w.calls.setScreen += 1; assert.ok(P.isUuid(s.id), 'a screen with no id is never saved'); w.persisted = JSON.stringify(s); },
    say: (line) => w.said.push(line),
    note: (kind, detail, screen) => w.notes.push({ kind, detail, id: screen && screen.id }),
  };
  w.mem = P.newPairingMemory(P.readSavedScreen(saved).screen);
  w.tick = async (afterMs = P.TICK_MS) => { w.now += afterMs; w.mem = await P.runPairingTick(w.mem, w.io); return w.mem; };
  // As the effect does it: a live update is applied to the memory, and only a real change is shown and saved.
  w.live = (payload) => { const r = P.applyLiveUpdate(w.mem, payload); w.mem = r.mem; if (r.action === 'apply' && r.changed) w.io.setScreen(r.mem.screen); return r; };
  w.view = () => P.decideView({ pairing: true, screen: w.mem.screen, urlBoardId: null, hasData: true, resolving: false });
  return w;
}
const savedOf = (r) => JSON.stringify(P.screenFromRow(r));
const OLD_SAVED = (r) => JSON.stringify({ id: r.id, code: r.code, board_id: r.board_id || null, order_display_id: r.order_display_id || null });

test('LAST NIGHT: found, heartbeat, errored echo with new = {}, next tick. Pairing kept, no new row, board still shown', async () => {
  const w = world({ rows: [row(A)], saved: OLD_SAVED(row(A)) });
  await w.tick();
  assert.equal(w.calls.heartbeat, 1);
  const before = w.persisted;
  const r = w.live(BAD_ECHO);
  assert.equal(r.action, 'ignore'); assert.equal(r.reason, 'errors'); assert.equal(r.detail, 'Error 401: Unauthorized');
  assert.equal(w.mem.screen.id, A); assert.equal(w.persisted, before); assert.equal(w.view(), 'board');
  await w.tick();
  assert.equal(w.mem.screen.id, A); assert.equal(w.mem.screen.board_id, BOARD);
  assert.equal(w.rows.length, 1); assert.equal(w.calls.insertRow, 0); assert.equal(w.calls.readOwned, 0);
  assert.equal(w.calls.readRow, 2); assert.equal(w.calls.heartbeat, 2); assert.equal(w.view(), 'board');
  for (let i = 0; i < 5; i++) { w.live(BAD_ECHO); await w.tick(); }
  assert.equal(w.rows.length, 1, 'more bad messages never make a second or third row');
});

test('the same sequence on a TV paired to an order screen', async () => {
  const r0 = row(A, { board_id: null, order_display_id: OSD });
  const w = world({ rows: [r0], saved: savedOf(r0) });
  await w.tick(); w.live({ ...BAD_ECHO, errors: ['Error 400: Bad Request, no primary key'] }); await w.tick();
  assert.equal(w.mem.screen.order_display_id, OSD); assert.equal(w.rows.length, 1); assert.equal(w.view(), 'order_screen');
});

test('live update rules', () => {
  const screen = P.screenFromRow(row(A));
  const d = (payload) => P.decideLiveUpdate({ payload, screen });
  assert.equal(d(null).reason, 'empty');
  assert.equal(d({ new: {}, old: {} }).reason, 'empty');
  assert.equal(d({ new: null, errors: null }).reason, 'empty');
  assert.equal(d({ new: row(A), errors: 'boom' }).reason, 'errors');
  assert.equal(d({ new: { id: A, code: 'ABCD-EFGH', board_id: BOARD }, errors: ['Error 413: Payload Too Large'] }).action, 'ignore');
  assert.equal(d({ new: row(N), errors: null }).reason, 'other_id');
  const part = row(A); delete part.board_id;
  assert.deepEqual([d({ new: part }).reason, d({ new: part }).detail], ['missing_fields', 'board_id']);
  assert.equal(d({ new: row(A, { code: '' }) }).reason, 'missing_fields');
  assert.equal(d({ new: row(A), errors: null }).action, 'apply');
  assert.equal(d({ new: row(A, { board_id: BOARD2 }), errors: [] }).action, 'apply');
  assert.equal(d({ new: row(A, { board_id: null, status: 'unpaired' }) }).action, 'confirm');
  assert.equal(P.decideLiveUpdate({ payload: { new: row(A) }, screen: null }).reason, 'no_screen_held');
});

test('saved screen and token', () => {
  assert.equal(P.screenFromRow({}), null); assert.equal(P.screenFromRow({ code: 'X', board_id: BOARD }), null);
  assert.deepEqual(P.readSavedScreen('{"board_id":null,"order_display_id":null}'), { screen: null, broken: true });
  assert.deepEqual(P.readSavedScreen(''), { screen: null, broken: false });
  assert.deepEqual(P.readSavedScreen('null'), { screen: null, broken: false });
  assert.equal(P.readSavedScreen('{oops').broken, true);
  assert.deepEqual(P.readSavedScreen(OLD_SAVED(row(A))).screen, { id: A, code: 'ABCD-EFGH', board_id: BOARD, order_display_id: null, location_id: null, device_uid: null });
  const now = 1_800_000_000_000;
  assert.deepEqual(P.readToken(jwt({ sub: U1, exp: now / 1000 + 600 })), { ok: true, uid: U1, expMs: now + 600000 });
  // A token that has run out still names its owner. The server refuses it; the TV clock is not asked.
  assert.deepEqual(P.readToken(jwt({ sub: U1, exp: 1 })), { ok: true, uid: U1, expMs: 1000 });
  assert.equal(P.readToken(jwt({ sub: U1 })).ok, true);
  assert.equal(P.readToken(jwt({ role: 'anon', iss: 'supabase' })).ok, false, 'the public key names nobody');
  assert.equal(P.readToken(jwt({ sub: 'not-a-uuid' })).ok, false);
  assert.equal(P.readToken('nope').ok, false); assert.equal(P.readToken(null).ok, false);
  assert.equal(P.readToken('a.b.c').ok, false, 'a middle part that is not JSON');
  assert.equal(P.readToken(jwt({ sub: U1, exp: now / 1000 + 600, name: 'ÿþ?>~~' })).ok, true);
});

test('a TV whose clock is wrong still works: the server judges the token, not the TV', async () => {
  // The TV clock is two hours fast, so every token looks run out to the TV. The server takes it.
  const w = world({ rows: [row(A)], saved: savedOf(row(A)) });
  w.tokenLifeS = -3600;
  await w.tick(); await w.tick();
  assert.equal(w.calls.readRow, 2); assert.equal(w.calls.heartbeat, 2); assert.equal(w.mem.screen.id, A); assert.equal(w.view(), 'board');
  const fresh = world({ rows: [], saved: null });
  fresh.tokenLifeS = -3600;
  await fresh.tick();
  assert.equal(fresh.rows.length, 1, 'a new TV with a fast clock still gets its row and its code'); assert.ok(fresh.mem.screen.code);
});

test('a token the server refuses is an error, so it is unknown and never a miss', async () => {
  const w = world({ rows: [row(A)], saved: savedOf(row(A)) });
  await w.tick();
  w.expired = true; for (let i = 0; i < 50; i++) await w.tick();
  assert.equal(w.mem.misses, 0); assert.equal(w.mem.screen.id, A); assert.equal(w.calls.checkGone, 0);
  assert.equal(w.calls.readOwned, 0); assert.equal(w.calls.insertRow, 0); assert.equal(w.view(), 'board');
  assert.equal(w.said.filter((l) => l.includes('read_failed')).length, 1, 'said once, not every tick');
  w.expired = false; await w.tick();
  assert.equal(w.mem.lastWait, ''); assert.equal(w.mem.screen.id, A);
});

test('every read and the heartbeat carry the device\'s own token', async () => {
  const w = world({ rows: [row(A)], saved: savedOf(row(A)) });
  await w.tick();
  assert.equal(w.readTokens.length, 1); assert.equal(w.beatTokens.length, 1);
  assert.equal(P.readToken(w.readTokens[0]).uid, U1); assert.equal(w.beatTokens[0], w.readTokens[0]);
});

test('three spaced misses, no other row: only then a new row and the code', async () => {
  const w = world({ rows: [row(A)], saved: savedOf(row(A)) });
  await w.tick(); w.rows = [];
  await w.tick(); assert.equal(w.mem.misses, 1); assert.equal(w.view(), 'board');
  await w.tick(); assert.equal(w.mem.misses, 2); assert.equal(w.calls.insertRow, 0); assert.equal(w.mem.screen.id, A);
  await w.tick();
  assert.equal(w.calls.readOwned, 1); assert.equal(w.calls.insertRow, 1); assert.equal(w.rows.length, 1);
  assert.equal(w.mem.screen.board_id, null); assert.equal(w.view(), 'pair'); assert.ok(w.mem.screen.code);
  assert.deepEqual(w.notes.map((n) => n.kind), ['unpaired']); assert.equal(w.notes[0].id, A);
});

test('three spaced misses but the device owns another paired row: adopt it, make nothing', async () => {
  const older = row(C, { paired_at: '2026-09-29T11:00:00.000Z' });
  const newest = row(N, { paired_at: '2026-10-12T08:06:26.000Z', board_id: BOARD2 });
  const w = world({ rows: [row(A), older, newest], saved: savedOf(row(A)) });
  await w.tick(); w.rows = w.rows.filter((r) => r.id !== A);
  await w.tick(); await w.tick(); await w.tick();
  assert.equal(w.mem.screen.id, N, 'the most recently paired'); assert.equal(w.calls.insertRow, 0); assert.equal(w.view(), 'board');
  assert.deepEqual(w.notes.map((n) => n.kind), ['adopted']);
});

test('a burst of triggers counts one miss', async () => {
  const w = world({ rows: [row(A)], saved: savedOf(row(A)) });
  await w.tick(); w.rows = [];
  await w.tick(); await w.tick(500); await w.tick(500); await w.tick(2000);
  assert.equal(w.mem.misses, 1); assert.equal(w.mem.screen.id, A); assert.equal(w.calls.insertRow, 0);
});

test('unknown is never a miss: failed read, failed check, hidden row, no sign in', async () => {
  const w = world({ rows: [row(A)], saved: savedOf(row(A)) });
  await w.tick();
  w.fail.readRow = true; for (let i = 0; i < 50; i++) await w.tick();
  assert.equal(w.mem.misses, 0);
  w.fail.readRow = false; w.hideRows = true; for (let i = 0; i < 50; i++) await w.tick();   // row level security hides it, the owner's function still sees it
  assert.equal(w.mem.misses, 0); assert.ok(w.said.some((l) => l.includes('not_confirmed_row_exists')));
  w.rows = []; w.fail.checkGone = true; for (let i = 0; i < 50; i++) await w.tick();
  assert.equal(w.mem.misses, 0);
  const reads = w.calls.readRow; w.token = false; for (let i = 0; i < 50; i++) await w.tick();
  assert.equal(w.calls.readRow, reads, 'no read at all without a sign in');
  assert.equal(w.mem.screen.id, A); assert.equal(w.calls.insertRow, 0); assert.equal(w.calls.readOwned, 0); assert.equal(w.view(), 'board');
});

test('boot with a saved screen with no id: adopt the paired row it already owns', async () => {
  const w = world({ rows: [row(A), unclaimed(N, { last_seen_at: '2026-10-12T02:30:00.000Z' })], saved: '{"board_id":null,"order_display_id":null}' });
  assert.equal(w.mem.screen, null); assert.equal(w.view(), 'pair');
  await w.tick();
  assert.equal(w.mem.screen.id, A); assert.equal(w.calls.insertRow, 0); assert.equal(w.view(), 'board'); assert.equal(w.rows.length, 2);
  assert.deepEqual(w.notes.map((n) => n.kind), ['adopted']);
});

test('boot holding a row it made itself while it owns an older paired row: self heal, once', async () => {
  const w = world({ rows: [row(A), unclaimed(N)], saved: savedOf(unclaimed(N)) });
  await w.tick();
  assert.equal(w.mem.screen.id, A); assert.equal(w.calls.readOwned, 1); assert.equal(w.calls.insertRow, 0);
  for (let i = 0; i < 20; i++) await w.tick();
  assert.equal(w.calls.readOwned, 1, 'the owned rows read is not an every tick read');
});

test('a TV Back Office set to Unpaired keeps its code, even when it owns an older paired row', async () => {
  const idle = row(N, { board_id: null, status: 'unpaired', paired_at: null });
  const w = world({ rows: [row(A), idle], saved: savedOf(idle) });
  for (let i = 0; i < 5; i++) await w.tick();
  assert.equal(w.mem.screen.id, N); assert.equal(w.calls.readOwned, 0); assert.equal(w.view(), 'pair');
});

test('boot with no rows: look first, then make one row, and never a second', async () => {
  const w = world({ rows: [], saved: null });
  await w.tick();
  assert.equal(w.calls.readOwned, 1); assert.equal(w.calls.insertRow, 1); assert.equal(w.rows.length, 1); assert.equal(w.view(), 'pair');
  for (let i = 0; i < 50; i++) await w.tick();
  assert.equal(w.rows.length, 1); assert.equal(w.calls.readOwned, 1); assert.equal(w.calls.insertRow, 1);
});

test('a TV that could not look for its own rows makes nothing', async () => {
  const w = world({ rows: [row(A)], saved: null });
  w.fail.readOwned = true; for (let i = 0; i < 10; i++) await w.tick();
  assert.equal(w.calls.insertRow, 0); assert.equal(w.rows.length, 1);
  w.fail.readOwned = false; await w.tick();
  assert.equal(w.mem.screen.id, A);
});

test('a code collision on insert is tried again, three times at most', async () => {
  const w = world({ rows: [], saved: null });
  w.insertErrors = [{ code: '23505' }];
  await w.tick(); assert.equal(w.calls.insertRow, 2); assert.equal(w.rows.length, 1);
  const x = world({ rows: [], saved: null });
  x.insertErrors = [{ code: '23505' }, { code: '23505' }, { code: '23505' }];
  await x.tick(); assert.equal(x.calls.insertRow, 3); assert.equal(x.rows.length, 0); assert.equal(x.mem.screen, null);
  await x.tick(); assert.equal(x.rows.length, 1);
  const y = world({ rows: [], saved: null });
  y.insertErrors = [{ code: '42501' }];
  await y.tick(); assert.equal(y.calls.insertRow, 1); assert.equal(y.rows.length, 0);
});

test('sign in changed: a menu board keeps its board and reads nothing', async () => {
  const w = world({ rows: [row(A)], saved: savedOf(row(A)), uid: U2 });
  for (let i = 0; i < 20; i++) await w.tick();
  assert.equal(w.mem.screen.id, A); assert.equal(w.calls.readRow, 0); assert.equal(w.calls.insertRow, 0); assert.equal(w.view(), 'board');
  assert.equal(w.notes[0].kind, 'sign_in_changed');
});

test('sign in changed: an order screen cannot work, so after three spaced misses it shows a code', async () => {
  const r0 = row(A, { board_id: null, order_display_id: OSD });
  const w = world({ rows: [r0], saved: savedOf(r0), uid: U2 });
  await w.tick(); await w.tick(); assert.equal(w.mem.screen.id, A);
  await w.tick();
  assert.equal(w.calls.insertRow, 1); assert.equal(w.view(), 'pair'); assert.deepEqual(w.notes.at(-1), { kind: 'unpaired', detail: 'sign_in_changed', id: A });
});

test('heartbeat at most once per 10 s', async () => {
  const w = world({ rows: [row(A)], saved: savedOf(row(A)) });
  await w.tick(); await w.tick(1000); await w.tick(1000);
  assert.equal(w.calls.heartbeat, 1);
  await w.tick(9000); assert.equal(w.calls.heartbeat, 2);
});

test('Back Office sets the TV to Unpaired: the live update is checked by a read, then the code shows', async () => {
  const w = world({ rows: [row(A)], saved: savedOf(row(A)) });
  await w.tick();
  Object.assign(w.rows[0], { board_id: null, status: 'unpaired', paired_at: null });
  const r = w.live({ new: { ...w.rows[0] }, old: {}, errors: null });
  assert.equal(r.action, 'confirm'); assert.equal(w.mem.screen.board_id, BOARD, 'not applied from the live update');
  await w.tick(P.EARLY_READ_DELAY_MS);
  assert.equal(w.mem.screen.board_id, null); assert.equal(w.mem.screen.code, 'ABCD-EFGH'); assert.equal(w.view(), 'pair'); assert.equal(w.rows.length, 1);
});

test('a good live update swaps the board at once', async () => {
  const w = world({ rows: [row(A)], saved: savedOf(row(A)) });
  await w.tick();
  const r = w.live({ new: row(A, { board_id: BOARD2 }), old: {}, errors: null });
  assert.equal(r.action, 'apply'); assert.equal(w.mem.screen.board_id, BOARD2); assert.equal(JSON.parse(w.persisted).board_id, BOARD2);
});

test('small rules', () => {
  assert.deepEqual(P.countMiss({ misses: 0, lastMissAt: 0, now: 5 }), { misses: 1, lastMissAt: 5, counted: true, unpair: false });
  assert.equal(P.countMiss({ misses: 2, lastMissAt: 0, now: 10000 }).unpair, true);
  assert.equal(P.countMiss({ misses: 3, lastMissAt: 0, now: 20000 }).misses, 3);
  assert.equal(P.rowRank(row(A, { board_id: null })), 2, "status 'paired' with no board is not paired");
  assert.equal(P.pickOwnedRow([row(A, { device_uid: U2 })], U1), null);
  assert.equal(P.decideOwned({ result: { data: [row(A)], error: null }, uid: U1, held: P.screenFromRow(row(A)), why: 'removed' }).reason, 'row_still_there');
  assert.equal(P.decideOwned({ result: { data: [unclaimed(N), row(C, { board_id: null })], error: null }, uid: U1, held: P.screenFromRow(unclaimed(N)), why: 'self_heal' }).row.id, C);
  assert.equal(P.decideOwned({ result: { data: [unclaimed(N)], error: null }, uid: U1, held: P.screenFromRow(unclaimed(N)), why: 'self_heal' }).action, 'stay');
  assert.equal(P.decideGoneCheck({ result: { data: { paired: false, reason: 'no_session' }, error: null } }).verdict, 'unknown');
  assert.equal(P.decideGoneCheck({ result: { data: { paired: true }, error: null } }).verdict, 'unknown');
  assert.equal(P.decideTickStart({ screen: P.readSavedScreen(OLD_SAVED(row(A))).screen, who: { ok: true, uid: U2 } }).action, 'read_row');
  assert.equal(P.shouldReadEarly({ now: 20000, lastAt: 5000, pending: false }), true);
  assert.equal(P.shouldReadEarly({ now: 20000, lastAt: 15000, pending: false }), false);
  assert.equal(P.shouldNote({ kind: 'live_ignored', now: 3600001, lastAt: 1 }), true);
  assert.equal(P.shouldNote({ kind: 'live_ignored', now: 3000000, lastAt: 1 }), false);
  assert.equal(P.shouldNote({ kind: 'nope', now: 9e12, lastAt: 0 }), false);
  const v = (o) => P.decideView({ pairing: true, urlBoardId: null, hasData: false, resolving: false, screen: null, ...o });
  assert.equal(v({}), 'pair');
  assert.equal(v({ screen: P.screenFromRow(row(A)), hasData: true }), 'board');
  assert.equal(v({ screen: P.screenFromRow(row(A)), resolving: true }), 'starting');
  assert.equal(v({ screen: P.screenFromRow(row(A)) }), 'loading');
  assert.equal(v({ screen: P.screenFromRow(row(A, { board_id: null })), hasData: true }), 'pair');
  assert.equal(v({ pairing: false, urlBoardId: BOARD, hasData: true }), 'board');
  assert.equal(P.agoLabel('2026-10-12T02:10:00Z', Date.parse('2026-10-12T05:10:00Z')), '3h ago');
  for (const k of Object.keys(P.NOTE_GAP_MS)) assert.ok(P.noteText(k).title);
});

test('removed while the TV was off: the same three spaced misses at boot, never a new row on one empty read', async () => {
  // Before 12 Oct 2026 the first empty read after a page load dropped the id and made a row at once.
  const w = world({ rows: [], saved: savedOf(row(A)) });
  await w.tick(); assert.equal(w.calls.insertRow, 0); assert.equal(w.mem.screen.id, A); assert.equal(w.view(), 'board');
  await w.tick(); assert.equal(w.calls.insertRow, 0); assert.equal(w.mem.misses, 2);
  await w.tick(); assert.equal(w.calls.insertRow, 1); assert.equal(w.view(), 'pair'); assert.equal(w.rows.length, 1);
});

test('a confirmed removal with nothing to put in its place keeps the old screen until a row is in hand', async () => {
  const w = world({ rows: [row(A)], saved: savedOf(row(A)) });
  await w.tick(); w.rows = [];
  w.insertErrors = [{ code: '42501' }, { code: '42501' }];
  await w.tick(); await w.tick(); await w.tick();
  assert.equal(w.calls.insertRow, 1); assert.equal(w.mem.screen.id, A, 'the screen is only ever replaced by a row in hand');
  assert.equal(w.persisted, savedOf(row(A))); assert.ok(w.said.some((l) => l.includes('create_failed')));
  await w.tick(); assert.equal(w.mem.screen.id, A);
  await w.tick(); assert.equal(w.rows.length, 1); assert.equal(w.view(), 'pair');
  assert.deepEqual(w.notes.map((n) => [n.kind, n.id]), [['unpaired', A]]);
});

test('live update details: said twice is one change, the owner is kept, nothing held means nothing applied', async () => {
  const w = world({ rows: [row(A)], saved: savedOf(row(A)) });
  await w.tick();
  const swap = { new: row(A, { board_id: BOARD2 }), old: {}, errors: null };
  assert.equal(w.live(swap).changed, true); assert.equal(w.live(swap).changed, false);
  const noOwner = row(A, { board_id: BOARD }); delete noOwner.device_uid;
  w.live({ new: noOwner, old: {}, errors: null });
  assert.equal(w.mem.screen.device_uid, U1); assert.equal(w.mem.screen.board_id, BOARD);
  const saves = w.calls.setScreen;
  for (const bad of [BAD_ECHO, { new: {}, old: {} }, { new: row(N) }, null, undefined, 'x', { errors: [] }]) {
    assert.equal(w.live(bad).action, 'ignore');
  }
  assert.equal(w.calls.setScreen, saves, 'an ignored live update saves nothing'); assert.equal(w.mem.screen.id, A);
  const first = world({ rows: [], saved: null });
  assert.equal(first.live({ new: row(A), old: {}, errors: null }).reason, 'no_screen_held'); assert.equal(first.mem.screen, null);
});

test('a board deleted in Back Office: the read finds the row with no board, so the code shows on the same row', async () => {
  // Deleting a board sets board_id to null and leaves status 'paired'. The server said so on a read that worked.
  const w = world({ rows: [row(A)], saved: savedOf(row(A)) });
  await w.tick(); w.rows[0].board_id = null;
  await w.tick();
  assert.equal(w.mem.screen.id, A); assert.equal(w.mem.screen.board_id, null); assert.equal(w.view(), 'pair');
  assert.equal(w.rows.length, 1); assert.equal(w.calls.readOwned, 0, 'a row that has a venue is a deliberate idle TV');
});

test('a failed content read is named, an empty answer is not a failure', () => {
  const ok = { data: [], error: null };
  const down = { data: null, error: { message: 'TypeError: Failed to fetch' } };
  assert.equal(P.failedBoardRead({ board: { data: null, error: null }, categories: ok, items: ok }), '', 'no board row and no rows are answers, and are drawn');
  assert.equal(P.failedBoardRead({ board: down, categories: ok, items: ok }), 'board');
  assert.equal(P.failedBoardRead({ board: ok, categories: ok, items: down }), 'items');
  assert.equal(P.failedBoardRead({ board: ok, categories: undefined, items: ok }), 'categories', 'no answer at all is a failure');
  assert.equal(P.failedBoardRead({}), ''); assert.equal(P.failedBoardRead(null), '');
});
