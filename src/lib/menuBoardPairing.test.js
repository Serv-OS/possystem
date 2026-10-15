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
import { setImmediate } from 'node:timers';
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
    said: [], notes: [], persisted: saved, subscribed: null, beatTokens: [], readTokens: [], readIds: [], beatIds: [],
    fail: { readRow: false, checkGone: false, readOwned: false }, hideRows: false, insertErrors: [], codes: 0,
    alive: true, latency: [], throwOn: {}, afterOwned: null, wrongRow: null,
  };
  const who = (token) => P.readToken(token).uid;
  // What the real server answers when the token has run out: an error, never "no rows".
  const EXPIRED = { data: null, error: { code: 'PGRST303', message: 'JWT expired' } };
  w.io = {
    alive: () => w.alive,
    now: () => w.now,
    getToken: async () => {
      if (w.throwOn.getToken) throw w.throwOn.getToken;
      return (w.token ? jwt({ sub: w.uid, role: 'authenticated', exp: Math.floor(w.now / 1000) + w.tokenLifeS }) : null);
    },
    readRow: async (id, token) => {
      w.calls.readRow += 1; w.readTokens.push(token); w.readIds.push(id);
      if (w.latency.length) w.now += w.latency.shift();     // how long this read took
      if (w.throwOn.readRow) throw w.throwOn.readRow;
      if (w.wrongRow) return { data: { ...w.wrongRow }, error: null };
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
      if (w.afterOwned) w.afterOwned();
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
    heartbeat: (id, token) => { w.calls.heartbeat += 1; w.beatTokens.push(token); w.beatIds.push(id); const r = w.rows.find((x) => x.id === id); if (r) r.last_seen_at = new Date(w.now).toISOString(); },
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

// ── sign in changed on a menu board (the hold). Review, 12 Oct 2026: the first build kept the
// board for ever and sent nothing, so Back Office could never change or remove that TV again.
// Now it keeps the board AND one spare row whose code Back Office can pair. ──
const claim = (w, code, over = {}) => Object.assign(w.rows.find((r) => r.code === code), { location_id: LOC, board_id: BOARD2, status: 'paired', paired_at: '2026-10-12T09:00:00.000Z', ...over });

test('sign in changed: a menu board keeps its board, makes ONE spare row and says its code', async () => {
  const w = world({ rows: [row(A)], saved: savedOf(row(A)), uid: U2 });
  for (let i = 0; i < 20; i++) await w.tick();
  assert.equal(w.mem.screen.id, A); assert.equal(w.view(), 'board'); assert.equal(w.persisted, savedOf(row(A)), 'the saved screen is untouched');
  assert.equal(w.readIds.includes(A), false, 'the old row is never read: it cannot be seen under the new sign in');
  assert.equal(w.calls.checkGone, 0); assert.equal(w.mem.misses, 0);
  assert.equal(w.calls.insertRow, 1, 'one spare row, never a second'); assert.equal(w.rows.length, 2);
  assert.equal(w.calls.readOwned, 1, 'the owned rows read is once, not every tick');
  const spare = w.rows[1];
  assert.equal(spare.device_uid, U2); assert.equal(spare.location_id, null);
  assert.equal(w.mem.standby.id, spare.id);
  assert.equal(w.calls.readRow, 19, 'after that, one read of the spare row per tick, like any TV');
  assert.equal(w.calls.heartbeat, 20, 'the spare row is kept seen, so its code can be paired (the server wants it seen in the last 30 minutes)');
  assert.ok(w.beatIds.every((id) => id === spare.id));
  assert.equal(w.subscribed, null);
  assert.deepEqual(w.notes[0], { kind: 'sign_in_changed', detail: spare.code, id: A }, 'the note is about the OLD screen, and carries the new code');
  assert.ok(w.notes.every((n) => n.kind === 'sign_in_changed' && n.detail === spare.code));
  assert.equal(w.said.filter((l) => l.includes('sign in changed, this screen cannot be checked. Board kept.')).length, 1, 'said once');
  assert.equal(w.said.filter((l) => l.includes(`pair code ${spare.code} in Back Office`)).length, 1, 'said once');
});

test('sign in changed: Back Office pairs the new code and the TV moves to that row. Then Remove shows a code', async () => {
  const w = world({ rows: [row(A)], saved: savedOf(row(A)), uid: U2 });
  await w.tick(); await w.tick();
  const spare = w.rows[1];
  claim(w, spare.code);
  await w.tick();
  assert.equal(w.mem.screen.id, spare.id); assert.equal(w.mem.screen.board_id, BOARD2); assert.equal(w.mem.screen.device_uid, U2);
  assert.equal(w.view(), 'board'); assert.equal(w.mem.standby, null); assert.equal(w.subscribed, spare.id);
  assert.equal(JSON.parse(w.persisted).id, spare.id, 'a row in hand replaced the saved screen');
  assert.deepEqual(w.notes.at(-1), { kind: 'adopted', detail: 'new_code', id: spare.id });
  assert.ok(w.said.some((l) => l.includes('the new code was paired in Back Office')));
  // From here it is an ordinary TV: it reads its own row, and Back Office can remove it.
  const owned = w.calls.readOwned;
  for (let i = 0; i < 5; i++) await w.tick();
  assert.equal(w.calls.readOwned, owned); assert.equal(w.mem.lastWait, '');
  w.rows = w.rows.filter((r) => r.id !== spare.id);
  await w.tick(); await w.tick(); assert.equal(w.view(), 'board');
  await w.tick();
  assert.equal(w.view(), 'pair', 'a removed screen under a changed sign in reaches a code'); assert.ok(w.mem.screen.code);
  assert.equal(w.mem.screen.device_uid, U2);
});

test('sign in changed, and Back Office already removed the old screen: the code is still the way out', async () => {
  const w = world({ rows: [], saved: savedOf(row(A)), uid: U2 });
  for (let i = 0; i < 10; i++) await w.tick();
  assert.equal(w.view(), 'board', 'the TV cannot know its old row is gone, so the board stays');
  assert.equal(w.rows.length, 1); assert.equal(w.notes[0].detail, w.rows[0].code);
  // Back Office pairs the code, then sets the TV to Unpaired: the TV follows both.
  claim(w, w.rows[0].code);
  await w.tick(); assert.equal(w.view(), 'board'); assert.equal(w.mem.screen.board_id, BOARD2);
  Object.assign(w.rows[0], { board_id: null, status: 'unpaired', paired_at: null });
  await w.tick(); assert.equal(w.view(), 'pair'); assert.equal(w.mem.screen.id, w.rows[0].id); assert.equal(w.rows.length, 1);
});

test('sign in changed: the code paired and set to Unpaired before the TV looked still takes the board down', async () => {
  const w = world({ rows: [row(A)], saved: savedOf(row(A)), uid: U2 });
  await w.tick();
  claim(w, w.rows[1].code, { board_id: null, status: 'unpaired', paired_at: null });   // a venue, nothing to show
  await w.tick();
  assert.equal(w.mem.screen.id, w.rows[1].id); assert.equal(w.view(), 'pair'); assert.equal(w.notes.some((n) => n.kind === 'adopted'), false);
});

test('sign in changed: the code used at ANOTHER venue is ignored, and no second code is offered', async () => {
  const OTHER = 'e0000000-0000-4000-8000-0000000000e2';
  const w = world({ rows: [row(A)], saved: savedOf(row(A)), uid: U2 });
  await w.tick();
  claim(w, w.rows[1].code, { location_id: OTHER });
  for (let i = 0; i < 10; i++) await w.tick();
  assert.equal(w.mem.screen.id, A); assert.equal(w.mem.screen.board_id, BOARD); assert.equal(w.view(), 'board');
  assert.equal(w.calls.insertRow, 1, 'no second row'); assert.equal(w.rows.length, 2);
  assert.equal(w.mem.standbyOff, true); assert.equal(w.mem.standby, null);
  assert.equal(w.said.filter((l) => l.includes('no new code for this TV (code_used_elsewhere)')).length, 1);
  assert.deepEqual(w.notes.at(-1), { kind: 'sign_in_changed', detail: '', id: A });
  const reads = w.calls.readRow + w.calls.readOwned; const beats = w.calls.heartbeat;
  for (let i = 0; i < 10; i++) await w.tick();
  assert.equal(w.calls.readRow + w.calls.readOwned, reads, 'and then it sends nothing, as before'); assert.equal(w.calls.heartbeat, beats);
  // After a restart it finds that row again and still offers nothing.
  const again = world({ rows: w.rows, saved: savedOf(row(A)), uid: U2 });
  for (let i = 0; i < 5; i++) await again.tick();
  assert.equal(again.calls.insertRow, 0); assert.equal(again.view(), 'board'); assert.equal(again.calls.readOwned, 1);
});

test('sign in changed: a restart finds the spare row it already owns, and never makes a second', async () => {
  const w = world({ rows: [row(A)], saved: savedOf(row(A)), uid: U2 });
  await w.tick();
  const again = world({ rows: w.rows, saved: savedOf(row(A)), uid: U2 });
  for (let i = 0; i < 5; i++) await again.tick();
  assert.equal(again.calls.insertRow, 0); assert.equal(again.rows.length, 2); assert.equal(again.mem.standby.id, w.rows[1].id);
  assert.equal(again.notes[0].detail, w.rows[1].code, 'the same code as before the restart');
});

test('sign in changed: no spare row can be read or made, so nothing is made twice and the board stays', async () => {
  const w = world({ rows: [row(A)], saved: savedOf(row(A)), uid: U2 });
  w.fail.readOwned = true; for (let i = 0; i < 10; i++) await w.tick();
  assert.equal(w.calls.insertRow, 0, 'it never makes a row it could not look for first'); assert.equal(w.view(), 'board');
  assert.equal(w.said.filter((l) => l.includes('no new code for this TV yet (owned_read_failed)')).length, 1, 'said once');
  assert.equal(w.notes.length, 0, 'no note until there is a code to give');
  w.fail.readOwned = false; w.insertErrors = [{ code: '42501' }];
  await w.tick(); assert.equal(w.mem.standby, null); assert.equal(w.view(), 'board'); assert.ok(w.said.some((l) => l.includes('(create_failed)')));
  await w.tick(); assert.equal(w.rows.length, 2); assert.ok(w.mem.standby.code);
  // The spare row is hidden for a while (a failed read): the code and the board are kept.
  w.fail.readRow = true; for (let i = 0; i < 10; i++) await w.tick();
  assert.ok(w.mem.standby); assert.equal(w.calls.insertRow, 2); assert.equal(w.view(), 'board');
  // The spare row is deleted: this page made its one row, so it offers no second code.
  w.fail.readRow = false; w.rows = [w.rows[0]];
  for (let i = 0; i < 10; i++) await w.tick();
  assert.equal(w.calls.insertRow, 2, 'one new row per page load at most'); assert.equal(w.mem.standbyOff, true); assert.equal(w.view(), 'board');
});

test('standby rules', () => {
  const held = P.screenFromRow(row(A));
  const mine = (over) => unclaimed(N, { device_uid: U2, ...over });
  const d = (rows, h = held) => P.decideStandby({ rows, uid: U2, held: h });
  assert.equal(d([]).action, 'create');
  assert.equal(d(null).action, 'create');
  assert.equal(d([row(A)]).action, 'create', 'a row of the OLD sign in is not mine');
  assert.deepEqual([d([mine()]).action, d([mine()]).row.id], ['offer', N]);
  assert.equal(d([mine({ location_id: LOC, board_id: BOARD2, status: 'paired' })]).action, 'adopt');
  assert.equal(d([mine({ location_id: LOC, board_id: null, order_display_id: OSD, status: 'paired' })]).action, 'adopt', 'paired as an order screen at this venue');
  assert.equal(d([mine({ location_id: LOC })]).action, 'adopt', 'claimed at this venue with nothing to show: Back Office said so');
  assert.deepEqual(d([mine({ location_id: 'e0000000-0000-4000-8000-0000000000e2', board_id: BOARD2 })]), { action: 'none', reason: 'code_used_elsewhere' });
  assert.equal(d([mine({ location_id: 'e0000000-0000-4000-8000-0000000000e2', board_id: BOARD2 }), mine({ id: C })]).action, 'none', 'a spare row next to a row used elsewhere is not offered');
  assert.deepEqual(d([mine()], { ...held, location_id: null }), { action: 'none', reason: 'no_venue' }, 'no venue known, so a pairing could not be checked');
  assert.deepEqual(P.newPairingMemory(null).standby, null);
});

test('sign in changed: an order screen cannot work, so after three spaced misses it shows a code', async () => {
  const r0 = row(A, { board_id: null, order_display_id: OSD });
  const w = world({ rows: [r0], saved: savedOf(r0), uid: U2 });
  await w.tick(); await w.tick(); assert.equal(w.mem.screen.id, A);
  await w.tick();
  assert.equal(w.calls.insertRow, 1); assert.equal(w.view(), 'pair'); assert.deepEqual(w.notes.at(-1), { kind: 'unpaired', detail: 'sign_in_changed', id: A });
});

test('heartbeat: a burst sends one, and never more often than every 6 s', async () => {
  const w = world({ rows: [row(A)], saved: savedOf(row(A)) });
  await w.tick(); await w.tick(1000); await w.tick(1000); await w.tick(3000);
  assert.equal(w.calls.heartbeat, 1, 'three more triggers inside 5 s send none');
  await w.tick(1000); assert.equal(w.calls.heartbeat, 2, '6 s after the first');
  assert.equal(P.HEARTBEAT_MIN_MS * 2, P.TICK_MS, 'half a tick');
});

test('heartbeat: one on every ordinary tick, however long the reads take', async () => {
  // Review, 12 Oct 2026: with a 10 s floor measured after the read, a slow read then a quick one
  // left under 10 s between two stamps and every other tick sent none (one per 24 s).
  const w = world({ rows: [row(A)], saved: savedOf(row(A)) });
  for (let i = 0; i < 10; i++) {
    const took = i % 2 ? 200 : 3000;
    w.latency = [took];
    await w.tick(P.TICK_MS - (i ? (i % 2 ? 3000 : 200) : 0));   // the interval fires on the wall clock, every 12 s
  }
  assert.equal(w.calls.heartbeat, 10);
  const slow = world({ rows: [row(A)], saved: savedOf(row(A)) });
  for (let i = 0; i < 6; i++) { slow.latency = [i % 2 ? 100 : 9000]; await slow.tick(P.TICK_MS - (i ? (i % 2 ? 9000 : 100) : 0)); }
  assert.equal(slow.calls.heartbeat, 6, 'even a 9 s read next to a quick one');
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

// ── Review, 12 Oct 2026: rules that were right in the code but that no test held. ──

test('no sign in: nothing is read, counted or made, whatever the TV holds', async () => {
  // An old saved screen (no owner saved), so only the "no sign in" rule stands between it and a read.
  const old = world({ rows: [row(A)], saved: OLD_SAVED(row(A)) });
  old.token = false; for (let i = 0; i < 10; i++) await old.tick();
  assert.equal(old.calls.readRow, 0); assert.equal(old.calls.checkGone, 0); assert.equal(old.mem.misses, 0); assert.equal(old.view(), 'board');
  assert.equal(old.mem.lastWait, 'no_sign_in');
  // A TV with nothing saved: it must not look for rows or make one as nobody.
  const fresh = world({ rows: [], saved: null });
  fresh.token = false; for (let i = 0; i < 10; i++) await fresh.tick();
  assert.equal(fresh.calls.readOwned, 0); assert.equal(fresh.calls.insertRow, 0); assert.equal(fresh.rows.length, 0);
  assert.deepEqual(fresh.said, ['[menuboard] no screen yet (no_sign_in). Trying again.'], 'said once, and not "Pairing kept": it has none');
  // An order screen TV.
  const r0 = row(A, { board_id: null, order_display_id: OSD });
  const osd = world({ rows: [r0], saved: savedOf(r0) });
  osd.token = false; for (let i = 0; i < 10; i++) await osd.tick();
  assert.equal(osd.mem.misses, 0); assert.equal(osd.calls.readRow, 0); assert.equal(osd.calls.insertRow, 0); assert.equal(osd.view(), 'order_screen');
});

test('a TV sitting on its own code looks for its other rows once, not every tick', async () => {
  // The commonest unpaired TV: one row, never claimed. The owned rows read answers "stay".
  const w = world({ rows: [unclaimed(N)], saved: savedOf(unclaimed(N)) });
  for (let i = 0; i < 20; i++) await w.tick();
  assert.equal(w.calls.readOwned, 1); assert.equal(w.calls.insertRow, 0); assert.equal(w.mem.screen.id, N); assert.equal(w.view(), 'pair');
  // A paired TV never looks at all, and its one look per page load is marked as used.
  const p = world({ rows: [row(A)], saved: savedOf(row(A)) });
  for (let i = 0; i < 20; i++) await p.tick();
  assert.equal(p.calls.readOwned, 0); assert.equal(p.mem.healChecked, true);
});

test('a read that throws (a timeout) is unknown: never a miss, never a throw, said once', async () => {
  const w = world({ rows: [row(A)], saved: savedOf(row(A)) });
  await w.tick();
  w.throwOn.readRow = Object.assign(new Error('Screen row timed out'), { name: 'TimeoutError' });
  for (let i = 0; i < 10; i++) await w.tick();
  assert.equal(w.mem.misses, 0); assert.equal(w.mem.screen.id, A); assert.equal(w.calls.insertRow, 0); assert.equal(w.mem.lastWait, 'error_TimeoutError');
  assert.equal(w.said.filter((l) => l.includes('error_TimeoutError')).length, 1);
  w.throwOn.readRow = null; w.throwOn.getToken = new Error('anonymous sign in failed');
  for (let i = 0; i < 10; i++) await w.tick();
  assert.equal(w.mem.lastWait, 'error_Error'); assert.equal(w.mem.screen.id, A); assert.equal(w.view(), 'board');
  w.throwOn.getToken = null; await w.tick();
  assert.equal(w.mem.lastWait, ''); assert.equal(w.calls.insertRow, 0); assert.equal(w.calls.readOwned, 0);
});

test('a miss is forgotten as soon as the row is found again', async () => {
  const w = world({ rows: [row(A)], saved: savedOf(row(A)) });
  await w.tick();
  const kept = w.rows; w.rows = [];
  await w.tick(); await w.tick(); assert.equal(w.mem.misses, 2);
  w.rows = kept; await w.tick(); assert.equal(w.mem.misses, 0, 'found: the count starts again');
  w.rows = []; await w.tick(); await w.tick();
  assert.equal(w.mem.misses, 2); assert.equal(w.calls.insertRow, 0); assert.equal(w.mem.screen.id, A, 'two misses, a find, two misses is not three');
});

test('a read that answers with another row is an odd answer: not taken, not a miss', async () => {
  const w = world({ rows: [row(A)], saved: savedOf(row(A)) });
  await w.tick();
  w.wrongRow = row(N, { board_id: BOARD2 });
  for (let i = 0; i < 5; i++) await w.tick();
  assert.equal(w.mem.screen.id, A); assert.equal(w.mem.screen.board_id, BOARD); assert.equal(w.mem.misses, 0); assert.equal(w.mem.lastWait, 'odd_answer');
  assert.equal(P.decideRowRead({ result: { data: row(N), error: null }, id: A }).action, 'wait');
});

test('a TV with no screen that cannot get one says so once, not two lines every tick', async () => {
  const w = world({ rows: [row(A)], saved: null });
  w.fail.readOwned = true; for (let i = 0; i < 10; i++) await w.tick();
  assert.deepEqual(w.said, ['[menuboard] no screen id saved. Looking for my own rows first.', '[menuboard] no screen yet (owned_read_failed). Trying again.']);
  const x = world({ rows: [], saved: null });
  x.insertErrors = Array(10).fill({ code: '42501' });
  for (let i = 0; i < 10; i++) await x.tick();
  assert.deepEqual(x.said, ['[menuboard] no screen id saved. Looking for my own rows first.', '[menuboard] no screen yet (create_failed). Trying again.']);
  assert.ok(x.said.every((l) => !l.includes('Pairing kept')), 'it has no pairing to keep');
});

test('a tick the page has let go of sends nothing more, says nothing and changes nothing', async () => {
  // Mount, clean up, mount on a brand new TV: the first tick is still waiting for its rows when
  // the effect is cleaned up. Before the review it went on to insert a row, and so did the new tick.
  const w = world({ rows: [], saved: null });
  w.afterOwned = () => { w.alive = false; };
  const before = w.mem;
  await w.tick();
  assert.equal(w.calls.readOwned, 1); assert.equal(w.calls.insertRow, 0, 'no row from a dead tick'); assert.equal(w.rows.length, 0);
  assert.equal(w.mem, before, 'the memory it was given comes back as it was');
  assert.equal(w.calls.setScreen, 0); assert.equal(w.calls.heartbeat, 0); assert.equal(w.said.filter((l) => !l.includes('no screen id saved')).length, 0);
  // The same on a found row: no heartbeat, nothing shown.
  const p = world({ rows: [row(A)], saved: OLD_SAVED(row(A)) });
  p.alive = false; await p.tick();
  assert.equal(p.calls.heartbeat, 0); assert.equal(p.calls.setScreen, 0); assert.equal(p.calls.readRow, 0, 'stopped at the first answer');
  // No io.alive at all (the tests above): every tick runs.
  const plain = world({ rows: [], saved: null }); delete plain.io.alive;
  await plain.tick(); assert.equal(plain.rows.length, 1);
});

// ── the notes a TV leaves (makeNoteStamper is what menuBoardNotes.js runs) ──
function noteWorld({ storage = true } = {}) {
  const n = { now: 1_800_000_000_000, rows: [], answers: [], stored: {}, loads: 0, pending: [] };
  n.stamp = P.makeNoteStamper({
    write: (r) => { n.rows.push(r); const a = n.answers.length ? n.answers.shift() : { error: null };
      return a === 'hang' ? new Promise((res) => n.pending.push(res)) : a === 'throw' ? Promise.reject(new TypeError('Failed to fetch')) : Promise.resolve(a); },
    now: () => n.now,
    load: () => { n.loads += 1; if (!storage) throw new Error('storage blocked'); return { ...n.stored }; },
    save: (o) => { if (!storage) throw new Error('storage blocked'); n.stored = o; },
    version: '9.9.9',
  });
  n.settle = () => new Promise((r) => setImmediate(r));
  return n;
}
const SCREEN = { id: A, code: 'ABCD-EFGH', board_id: BOARD, order_display_id: null, location_id: LOC, device_uid: U1 };

test('a note is one row, written already read, with the version', async () => {
  const n = noteWorld();
  assert.equal(n.stamp({ screen: SCREEN, kind: 'live_ignored', detail: 'Error 401: Unauthorized' }), 'sent');
  await n.settle();
  assert.deepEqual(n.rows, [{ location_id: LOC, kind: 'system', severity: 'info', title: 'TV kept its pairing',
    body: 'It ignored a bad live update (Error 401: Unauthorized). Nothing to do. (v9.9.9)',
    ref_type: 'menu_board_screen', ref_id: A, actor_name: 'TV', acked_at: new Date(n.now).toISOString(), acked_by: 'auto' }]);
  assert.deepEqual(n.stored, { live_ignored: n.now });
});

test('a note needs a screen with an id and a venue, and a kind that has words', () => {
  const n = noteWorld();
  for (const bad of [undefined, {}, { screen: null, kind: 'adopted' }, { screen: { ...SCREEN, id: 'x' }, kind: 'adopted' },
    { screen: { ...SCREEN, location_id: null }, kind: 'adopted' }, { screen: SCREEN, kind: 'nope' }]) {
    assert.equal(n.stamp(bad), 'skipped');
  }
  assert.equal(n.rows.length, 0); assert.equal(n.loads, 0);
});

test('the limit: one per kind per gap, and it starts when the write WORKED', async () => {
  const n = noteWorld();
  const again = () => n.stamp({ screen: SCREEN, kind: 'live_ignored', detail: 'x' });
  assert.equal(again(), 'sent'); assert.equal(again(), 'limited', 'one insert at a time, even before the first answers');
  await n.settle();
  n.now += 3599000; assert.equal(again(), 'limited'); assert.equal(n.rows.length, 1);
  n.now += 1000; assert.equal(again(), 'sent'); await n.settle(); assert.equal(n.rows.length, 2);
  assert.equal(n.stamp({ screen: SCREEN, kind: 'adopted' }), 'sent', 'another kind has its own limit');
  await n.settle();
  // The cheap check: a limited call does not even read storage (this runs every tick while a TV holds).
  const loads = n.loads; for (let i = 0; i < 50; i++) again(); assert.equal(n.loads, loads);
});

test('a note whose write failed is not lost for the whole gap: it is tried again a minute later', async () => {
  // Review, 12 Oct 2026: the limit used to be set before the insert was sent. A TV that was
  // offline at that moment lost the note for an hour, or a day for "lost its sign in".
  for (const bad of [{ error: { message: 'Failed to fetch' } }, 'throw']) {
    const n = noteWorld();
    const again = () => n.stamp({ screen: SCREEN, kind: 'sign_in_changed', detail: 'WXYZ-2345' });
    n.answers = [bad];
    assert.equal(again(), 'sent'); await n.settle();
    assert.deepEqual(n.stored, {}, 'nothing is marked as written');
    n.now += 12000; assert.equal(again(), 'limited', 'not every tick');
    n.now += 48000; assert.equal(again(), 'sent', 'a minute later'); await n.settle();
    assert.equal(n.rows.length, 2); assert.deepEqual(Object.keys(n.stored), ['sign_in_changed:WXYZ-2345']);
    n.now += 3600000; assert.equal(again(), 'limited', 'written now: once a day');
    n.now += 86400000; assert.equal(again(), 'sent');
  }
  // A write the server refuses every time is not sent every minute for ever: 1, 2, 4 ... 60 minutes.
  const n = noteWorld();
  const again = () => n.stamp({ screen: SCREEN, kind: 'sign_in_changed', detail: 'WXYZ-2345' });
  n.answers = Array(40).fill({ error: { code: '42501' } });
  const gaps = []; let last = n.now;
  again(); await n.settle();
  for (let i = 0; i < 12 * 3600 / 12; i++) { n.now += 12000; if (again() === 'sent') { gaps.push((n.now - last) / 60000); last = n.now; await n.settle(); } }
  assert.deepEqual(gaps.slice(0, 7), [1, 2, 4, 8, 16, 32, 60]); assert.ok(gaps.slice(7).every((g) => g === 60));
  assert.equal(n.rows.length, 1 + gaps.length); assert.ok(n.rows.length < 20, 'twelve hours of a held TV: under 20 tries, not 720');
});

test('the limit survives a restart (storage), a new code is news, and blocked storage does not switch it off', async () => {
  const n = noteWorld();
  const say = (code) => n.stamp({ screen: SCREEN, kind: 'sign_in_changed', detail: code });
  assert.equal(say('WXYZ-2345'), 'sent'); await n.settle();
  assert.equal(say('NEWC-0002'), 'sent', 'another code has its own limit'); await n.settle();
  assert.equal(P.noteSlot('sign_in_changed', ''), 'sign_in_changed'); assert.equal(P.noteSlot('adopted', 'new_code'), 'adopted');
  // A restart: a new stamper over the same storage.
  const after = noteWorld(); after.stored = { ...n.stored }; after.now = n.now + 60000;
  assert.equal(after.stamp({ screen: SCREEN, kind: 'sign_in_changed', detail: 'WXYZ-2345' }), 'limited'); assert.equal(after.rows.length, 0);
  // Old entries are dropped when a note is saved, so the list cannot grow for ever.
  after.now += 3 * 86400000;
  assert.equal(after.stamp({ screen: SCREEN, kind: 'adopted' }), 'sent'); await after.settle();
  assert.deepEqual(Object.keys(after.stored), ['adopted']);
  const blocked = noteWorld({ storage: false });
  const b = () => blocked.stamp({ screen: SCREEN, kind: 'live_ignored', detail: 'x' });
  assert.equal(b(), 'sent'); await blocked.settle(); assert.equal(b(), 'limited'); assert.equal(blocked.rows.length, 1);
});

test('the code in a "lost its sign in" note reads back, and nothing else reads as a code', () => {
  for (const code of ['WXYZ-2345', 'K7P2-9XQM', 'NEWC-0001']) assert.equal(P.noteCode(P.noteText('sign_in_changed', code).title), code);
  assert.equal(P.noteCode(P.noteText('sign_in_changed').title), null);
  for (const k of ['live_ignored', 'adopted', 'unpaired']) assert.equal(P.noteCode(P.noteText(k, 'WXYZ-2345').title), null);
  assert.equal(P.noteCode('TV lost its sign in. Pair it again with code WXYZ-2345 now'), null);
  assert.equal(P.noteCode(null), null);
  assert.equal(P.noteText('adopted', 'new_code').title, 'TV paired again');
  assert.equal(P.noteText('adopted').title, 'TV found its pairing again');
});

test('Back Office: which note line shows under a screen, and the code of a TV whose screen is gone', () => {
  const now = Date.parse('2026-10-13T12:00:00Z');
  const ago = (h) => new Date(now - h * 3600000).toISOString();
  const title = P.noteText('sign_in_changed', 'WXYZ-2345').title;
  const screens = [{ id: A, code: 'ABCD-EFGH' }, { id: N, code: 'K7P2-9XQM' }];
  const view = (notes, list = screens) => P.screenNoteView({ notes, screens: list, now });
  // An ordinary note.
  assert.deepEqual(view({ [A]: { title: 'TV kept its pairing', body: 'b', at: ago(3), code: null, codeAt: null } }),
    { byScreen: { [A]: { text: 'TV kept its pairing · 3h ago', body: 'b' } }, lost: [] });
  // A code that is still open, on a screen in the list. It wins over a newer note of another kind.
  const open = view({ [A]: { title: 'TV kept its pairing', body: 'b', at: ago(1), code: 'WXYZ-2345', codeAt: ago(5) } });
  assert.equal(open.byScreen[A].text, `${title} · 5h ago`); assert.match(open.byScreen[A].body, /type the code under Paired screens/); assert.deepEqual(open.lost, []);
  // The code was used (a screen in the list now has it): the line goes, it would only mislead.
  const used = view({ [A]: { title, body: 'b', at: ago(5), code: 'WXYZ-2345', codeAt: ago(5) } }, [...screens, { id: C, code: 'WXYZ-2345' }]);
  assert.deepEqual(used, { byScreen: {}, lost: [] });
  // The TV stopped saying it two days ago (re paired by hand, or switched off): not shown.
  assert.deepEqual(view({ [A]: { title, body: 'b', at: ago(49), code: 'WXYZ-2345', codeAt: ago(49) } }), { byScreen: {}, lost: [] });
  // The old screen was removed from the list first: the code is listed on its own.
  const lost = view({ [C]: { title, body: 'b', at: ago(2), code: 'WXYZ-2345', codeAt: ago(2) } });
  assert.deepEqual(lost.byScreen, {});
  assert.deepEqual(lost.lost.map((l) => [l.id, l.code, l.text]), [[C, 'WXYZ-2345', 'A TV lost its sign in. Pair it again with code WXYZ-2345 · 2h ago']]);
  // A note for a screen that is gone and has no code (it showed its code, was paired again) is not listed.
  assert.deepEqual(view({ [C]: { title: 'TV shows its code', body: 'b', at: ago(2), code: null, codeAt: null } }), { byScreen: {}, lost: [] });
  assert.deepEqual(P.screenNoteView({ notes: null, screens: null, now }), { byScreen: {}, lost: [] });
});
