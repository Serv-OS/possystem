// src/lib/menuBoardPairingReplay.test.js
//
// 12 Oct 2026 (review), WHY THIS FILE. menuBoardPairingWiring.test.js checks that certain words
// are in MenuBoardSurface.jsx, and menuBoardPairing.test.js runs the rules on their own. Neither
// RUNS the effect that joins the two. An edit that dropped "mem = next" after a tick (misses
// never add up, so a removed screen never shows its code), or stopped a live update from being
// kept, or put the old screen back after a failed read, passed every test.
//
// This file runs the pairing effect itself. Its text is cut, as it is, from MenuBoardSurface.jsx
// when the test starts and is run in a tiny stand in for React, against the REAL supabase-js
// client (the real postgrest-js and realtime-js). Only the network is a stand in: fetch is a
// small in memory database that applies row level security BY THE TOKEN ON EACH REQUEST (the
// public key sees no screen rows, as in production), and the WebSocket is a stand in realtime
// server that can push any frame down the library's real receive path. Timers and the clock are
// stand ins too, so a test moves time by hand. Nothing here touches a real network or database.
//
// IF THIS FILE FAILS WITH "x is not defined": the effect now uses a name this stand in does not
// hand it. Add it to `env` in boot() below. If it fails with "a marker this test cuts by is
// gone": the lines it finds the effect by were renamed; update the find() calls just below.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { setImmediate } from 'node:timers';
import { createClient } from '@supabase/supabase-js';
import { withTimeout } from './withTimeout.js';
import { generatePairingCode } from './pairingCode.js';
import * as P from './menuBoardPairing.js';

// realtime-js leaves a 10 s timer behind every time its socket is closed (its disconnect starts
// one and never clears it). Nothing waits on it, but it would keep this test process idling for
// 10 s after the last test. So in THIS process only (node runs each test file in its own), a
// long timer does not hold the process open. It still fires if the process is still running.
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...rest) => {
  const t = realSetTimeout(fn, ms, ...rest);
  if (ms >= 5000 && t && typeof t.unref === 'function') t.unref();
  return t;
};

// ── the effect, cut from the surface file ──
const lines = readFileSync(new URL('../surfaces/MenuBoardSurface.jsx', import.meta.url), 'utf8').split('\n');
const find = (pred, from = 0) => { for (let i = from; i < lines.length; i += 1) if (pred(lines[i])) return i; throw new Error('MenuBoardSurface.jsx moved: a marker this test cuts by is gone'); };
const iConsts = ['TICK_TIMEOUT_MS', 'LS_SCREEN'].map((n) => find((l) => l.startsWith(`const ${n} = `)));
const iHead0 = find((l) => l.includes('const urlBoardId = useMemo('));
const iHead1 = find((l) => l.includes('const effectiveBoardId = urlBoardId || screen?.board_id || null;'));
const iEff0 = find((l) => l.trim() === 'useEffect(() => {', find((l) => l.includes('device pairing: find or register this screen')));
const iEff1 = find((l) => l.trim() === '}, [pairing]);', iEff0);
const COMPONENT = `
${iConsts.map((i) => lines[i]).join('\n')}
return function Harness() {
${lines.slice(iHead0, iHead1 + 1).join('\n')}
${lines.slice(iEff0, iEff1 + 1).join('\n')}
  return { view: decideView({ pairing, screen, urlBoardId, hasData: true, resolving: false }), id: screen && screen.id, board: screen && screen.board_id, code: screen && screen.code };
};`;

// ── a stand in realtime server for the real realtime-js: it answers joins and heartbeats, and
// lets a test push any postgres_changes frame to every joined topic (as the server fans out). ──
const servers = [];
class FakeWS {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  constructor(url) {
    this.url = url; this.readyState = 0; this.joins = new Map(); this.nextSubId = 1000;
    servers.push(this);
    setTimeout(() => { this.readyState = 1; if (this.onopen) this.onopen({}); }, 0);
  }
  send(raw) {
    if (typeof raw !== 'string') return;
    const [joinRef, ref, topic, event, payload] = JSON.parse(raw);
    if (event === 'phx_join') {
      const pc = (payload?.config?.postgres_changes || []).map((f) => ({ ...f, id: this.nextSubId++ }));
      this.joins.set(topic, { pc });
      this.reply(joinRef, ref, topic, { status: 'ok', response: { postgres_changes: pc } });
    } else if (event === 'phx_leave') {
      this.joins.delete(topic);
      this.reply(joinRef, ref, topic, { status: 'ok', response: {} });
    } else if (event === 'heartbeat' || event === 'access_token') {
      this.reply(joinRef, ref, topic, { status: 'ok', response: {} });
    }
  }
  reply(joinRef, ref, topic, payload) { setTimeout(() => this.deliver([joinRef, ref, topic, 'phx_reply', payload]), 0); }
  deliver(frame) { if (this.onmessage) this.onmessage({ data: JSON.stringify(frame) }); }
  pushChange(data, onlyTopicStart) {
    let n = 0;
    for (const [topic, j] of this.joins) {
      if (onlyTopicStart && !topic.startsWith(onlyTopicStart)) continue;
      if (!j.pc.length) continue;
      this.deliver([null, null, topic, 'postgres_changes', { ids: j.pc.map((p) => p.id), data }]);
      n += 1;
    }
    return n;
  }
  close() { this.readyState = 3; if (this.onclose) this.onclose({ code: 1000 }); }
}

const iso = (ms) => new Date(ms).toISOString();
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const jwt = (claims) => `${b64u({ alg: 'HS256', typ: 'JWT' })}.${b64u(claims)}.sig`;
const uidOf = (auth) => { try { return JSON.parse(Buffer.from(String(auth || '').replace(/^Bearer /, '').split('.')[1], 'base64').toString('utf8')).sub || null; } catch { return null; } };
const UID = '9e695ca5-0000-4000-8000-00000000d0d0';
const UID2 = '9e695ca5-0000-4000-8000-00000000d0d1';
const LOC = 'c5dd8483-0000-4000-8000-000000000001';
const BOARD = 'bbbbbbbb-0000-4000-8000-00000000000b';
const BOARD2 = 'bbbbbbbb-0000-4000-8000-00000000000c';
const OLD_ID = 'aaaaaaaa-0000-4000-8000-00000000000a';
const mkRow = (id, over = {}) => ({ id, device_uid: UID, location_id: LOC, org_id: null, board_id: BOARD, code: 'KQ7M-2X9P', name: null, status: 'paired',
  last_seen_at: null, paired_at: '2026-09-30T07:41:45.526Z', created_at: '2026-09-30T07:35:26.582Z', updated_at: '2026-09-30T07:41:45.526Z', order_display_id: null, ...over });
const COLS = Object.keys(mkRow(OLD_ID)).map((n) => ({ name: n, type: n.endsWith('_at') ? 'timestamptz' : (n === 'code' || n === 'name' || n === 'status') ? 'text' : 'uuid' }));
const errFrame = (msg) => ({ schema: 'public', table: 'menu_board_screens', type: 'UPDATE', commit_timestamp: null, columns: [], record: {}, old_record: {}, errors: [msg] });
const updFrame = (row) => ({ schema: 'public', table: 'menu_board_screens', type: 'UPDATE', commit_timestamp: '2026-10-12T02:10:00.000Z', columns: COLS, record: { ...row }, old_record: { id: row.id }, errors: null });
// A request that is cut. WHY AN ABORT AND NOT "Failed to fetch": postgrest-js tries a GET that
// failed on the network three more times (1 s, 2 s, 4 s of real time) before it gives the page
// an error. An aborted request is not tried again, and reaches the page as the same thing: a
// read that answered with an error. So these tests take milliseconds, not minutes.
const cut = () => Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
// Let the real client's promises, the stand in socket's zero delay timers and their replies all run.
const settle = async (rounds = 8) => { for (let i = 0; i < rounds; i += 1) { await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setImmediate(r)); } };

/** Mount the effect on a stand in TV. rows = the database, saved = the text in rpos-mbscreen (undefined = the OLD four field shape of rows[0]). */
async function boot({ rows = [mkRow(OLD_ID)], saved, uid = UID, mounts = 1, warmUp = 2 } = {}) {
  const c = { now: Date.parse('2026-10-12T02:09:22.500Z'), db: rows.map((r) => ({ ...r })), rest: [], said: [], notes: [], uid, token: 'device', restDown: false, hold: null, seq: 0 };
  const json = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fakeFetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const method = (init.method || 'GET').toUpperCase();
    const me = uidOf(new Headers(init.headers).get('Authorization'));   // null = the public key (nobody)
    const as = me ? `as ${me.slice(-4)}` : 'as NOBODY';
    const p = url.pathname;
    if (c.restDown) { c.rest.push(`${method} ${p} ${as} network down`); throw cut(); }
    if (p === '/rest/v1/menu_board_screens' && method === 'GET') {
      const id = url.searchParams.get('id'); const dev = url.searchParams.get('device_uid');
      if (c.hold) await c.hold;
      if (id) { const v = id.replace(/^eq\./, ''); c.rest.push(`GET screen ${v.slice(0, 8)} ${as}`); return json(200, c.db.filter((r) => r.id === v && r.device_uid === me)); }
      if (dev) { const v = dev.replace(/^eq\./, ''); c.rest.push(`GET my screens ${as}`); return json(200, c.db.filter((r) => r.device_uid === v && r.device_uid === me)); }
    }
    if (p === '/rest/v1/menu_board_screens' && method === 'POST') {
      if (!me) { c.rest.push(`POST new screen ${as} refused`); return json(403, { code: '42501', message: 'new row violates row-level security policy' }); }
      const row = mkRow(`cccccccc-0000-4000-8000-00000000000${++c.seq}`, { code: JSON.parse(init.body).code, device_uid: me, location_id: null, board_id: null, status: 'unpaired', paired_at: null, created_at: iso(c.now), updated_at: iso(c.now) });
      c.db.push(row);
      c.rest.push(`POST new screen ${as}`);
      return json(201, [row]);
    }
    if (p === '/rest/v1/rpc/mb_screen_heartbeat' && method === 'POST') {
      const row = c.db.find((r) => r.id === JSON.parse(init.body).p_id && r.device_uid === me);
      c.rest.push(`RPC heartbeat ${as}`);
      if (row) { row.last_seen_at = iso(c.now); row.updated_at = iso(c.now); }
      return json(204);
    }
    if (p === '/rest/v1/rpc/order_status_feed' && method === 'POST') {
      const row = me && c.db.find((r) => r.id === JSON.parse(init.body).p_screen_id && r.device_uid === me);
      const body = !me ? { paired: false, reason: 'no_session' } : !row ? { paired: false, reason: 'no_screen' } : { paired: false, reason: 'not_assigned' };
      c.rest.push(`RPC order_status_feed ${as} ${body.reason}`);
      return json(200, body);
    }
    c.rest.push(`${method} ${p} ${as} (unexpected)`);
    return json(404, { message: 'not found' });
  };
  const supabase = createClient('https://fake-ops.supabase.co', 'PUBLIC-KEY', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: fakeFetch },
    realtime: { transport: FakeWS, heartbeatIntervalMs: 3600000 },
  });
  const firstServer = servers.length;
  const ws = () => (servers.length > firstServer ? servers[servers.length - 1] : null);

  const store = new Map();
  let removes = 0; let reloads = 0;
  const localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); }, removeItem: (k) => { removes += 1; store.delete(k); } };
  const first = c.db[0];
  if (saved !== undefined) { if (saved !== null) store.set('rpos-mbscreen', saved); }
  else store.set('rpos-mbscreen', JSON.stringify({ id: first.id, code: first.code, board_id: first.board_id, order_display_id: first.order_display_id }));
  const window = { location: { search: '', reload: () => { reloads += 1; } }, addEventListener() {}, removeEventListener() {} };
  const document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} };
  const intervals = []; const timers = [];
  const ensureAuthToken = async () => (c.token === 'none' ? null : c.token === 'public' ? jwt({ role: 'anon', iss: 'supabase' }) : jwt({ sub: c.uid, role: 'authenticated', exp: Math.floor(c.now / 1000) + 3600 }));

  // A tiny stand in for React: hooks by call order, effects run after the render that queued them.
  const hooks = []; const effects = []; const queued = []; let hi = 0; let Comp = null;
  const render = () => { hi = 0; c.view = Comp(); for (const f of queued.splice(0)) effects.push({ f, cleanup: f() }); };
  const env = {
    useMemo: (f) => { const k = hi++; if (!hooks[k]) hooks[k] = { v: f() }; return hooks[k].v; },
    useRef: (v) => { const k = hi++; if (!hooks[k]) hooks[k] = { current: v }; return hooks[k]; },
    useState: (init) => { const k = hi++; if (!hooks[k]) hooks[k] = { v: typeof init === 'function' ? init() : init };
      const cell = hooks[k];
      return [cell.v, (next) => { const nv = typeof next === 'function' ? next(cell.v) : next; if (!Object.is(nv, cell.v)) { cell.v = nv; render(); } }]; },
    useEffect: (f, deps) => { const k = hi++; const prev = hooks[k]; if (!prev || deps.some((d, j) => !Object.is(d, prev.deps[j]))) { hooks[k] = { deps }; queued.push(f); } },
    supabase, isMock: false, ensureAuthToken, withTimeout, generatePairingCode, localStorage, window, document, URLSearchParams,
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
    clearInterval: (id) => { if (intervals[id - 1]) intervals[id - 1].fn = null; },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: (id) => { if (id && timers[id - 1]) timers[id - 1].fn = null; },
    Date: { now: () => c.now },
    console: { warn: (...a) => { c.said.push(a.join(' ')); }, log() {}, error() {} },
    stampScreenNote: (n) => { c.notes.push({ kind: n.kind, detail: n.detail || '', id: n.screen && n.screen.id }); },
    readSavedScreen: P.readSavedScreen, sameScreen: P.sameScreen, newPairingMemory: P.newPairingMemory, runPairingTick: P.runPairingTick, applyLiveUpdate: P.applyLiveUpdate,
    decideView: P.decideView, shouldReadEarly: P.shouldReadEarly, failedBoardRead: P.failedBoardRead, EARLY_READ_DELAY_MS: P.EARLY_READ_DELAY_MS, TICK_MS: P.TICK_MS,
  };
  Comp = new Function(...Object.keys(env), COMPONENT)(...Object.values(env));

  const live = () => intervals.filter((x) => x.fn && x.ms === P.TICK_MS);
  Object.assign(c, {
    ws, intervals, timers, effects,
    saved: () => (store.has('rpos-mbscreen') ? JSON.parse(store.get('rpos-mbscreen')) : null),
    advance: (ms) => { c.now += ms; },
    /** Start the interval tick now (every live effect's). Hands back its promise, so a test can hold a read mid tick. */
    startTick: () => Promise.all(live().map((x) => x.fn())),
    /** 12 s later, one tick, and everything it set off. */
    tick: async (after = P.TICK_MS) => { c.now += after; await c.startTick(); await settle(); },
    /** Run the timers that are due (the early read). Gives how many ran. */
    runTimers: async () => { const due = timers.filter((x) => x.fn); for (const x of due) { const f = x.fn; x.fn = null; await f(); } await settle(); return due.length; },
    pushAll: (data) => (ws() ? ws().pushChange(data) : 0),
    pushTo: (rowId, data) => (ws() ? ws().pushChange(data, `realtime:mbscreen-${rowId}-`) : 0),
    topics: () => (ws() ? [...ws().joins.keys()] : []),
    count: (part) => c.rest.filter((r) => r.includes(part)).length,
    asNobody: () => c.rest.filter((r) => r.includes('as NOBODY')).length,
    unexpected: () => c.rest.filter((r) => r.includes('(unexpected)')).length,
    storage: () => ({ removes, reloads }),
    unmount: () => { for (const e of effects) if (typeof e.cleanup === 'function') { e.cleanup(); e.cleanup = null; } },
    end: async () => { c.unmount(); await settle(); try { await supabase.removeAllChannels(); } catch { /* done */ } await settle(2); },
  });
  render();
  // React StrictMode in dev, or any remount: the effect runs, is cleaned up, and runs again.
  for (let i = 1; i < mounts; i += 1) { const e = effects[effects.length - 1]; if (typeof e.cleanup === 'function') e.cleanup(); effects.push({ f: e.f, cleanup: e.f() }); }
  await settle();
  for (let i = 0; i < warmUp; i += 1) await c.tick();
  return c;
}
// Nothing was read as nobody, nothing unexpected was asked, the saved screen was never removed, the page never reloaded.
const clean = (c) => { assert.equal(c.asNobody(), 0, 'as nobody'); assert.equal(c.unexpected(), 0, 'unexpected requests'); assert.deepEqual(c.storage(), { removes: 0, reloads: 0 }); };

test('the cut found the effect', () => {
  assert.ok(iEff1 - iEff0 > 80, 'the whole effect');
  assert.match(COMPONENT, /runPairingTick\(mem, io\)/); assert.match(COMPONENT, /applyLiveUpdate\(mem, p\)/);
});

test('LAST NIGHT, wired: one errored change to every TV between two ticks. No request, pairing kept, board shown', async () => {
  const c = await boot();
  assert.equal(c.view.view, 'board'); assert.equal(c.topics().length, 1, 'the TV listens to its own row');
  assert.equal(c.saved().device_uid, UID, 'the saved screen now carries its owner'); assert.equal(c.saved().location_id, LOC, 'and its venue');
  c.advance(10300);
  const before = c.rest.length; const savedBefore = JSON.stringify(c.saved());
  assert.equal(c.pushAll(errFrame('Error 401: Unauthorized')), 1); await settle();
  assert.equal(c.rest.length, before, 'a bad live update causes NO request (one bad change reaches every TV at once)');
  assert.equal(c.timers.filter((x) => x.fn).length, 0, 'and sets no early read');
  assert.equal(JSON.stringify(c.saved()), savedBefore); assert.equal(c.view.id, OLD_ID); assert.equal(c.view.view, 'board');
  assert.ok(c.said.some((l) => l.includes('ignored a live update (errors: Error 401: Unauthorized). Pairing kept.')));
  await c.tick(1700); await c.tick();
  assert.equal(c.db.length, 1); assert.equal(c.count('POST new screen'), 0); assert.equal(c.view.id, OLD_ID); assert.equal(c.view.view, 'board');
  assert.deepEqual(c.notes.map((n) => n.kind), ['live_ignored']); clean(c);
  // The 400 shape, an empty record with no errors, and twenty more: still one row.
  for (let i = 0; i < 20; i += 1) { c.pushAll(i % 2 ? errFrame('Error 400: Bad Request, no primary key') : { ...errFrame('x'), errors: null, columns: COLS }); await settle(2); await c.tick(); }
  assert.equal(c.db.length, 1); assert.equal(c.view.id, OLD_ID); assert.equal(c.count('RPC heartbeat'), 3 + 2 + 20, 'one heartbeat per tick, none extra');
  await c.end();
});

test('wired: the ticks add up. Back Office removes the screen, three spaced misses, then a new code', async () => {
  // Holds "mem = next": with the memory dropped after each tick the misses never reach three.
  const c = await boot();
  c.db.length = 0;
  await c.tick(); assert.equal(c.view.view, 'board');
  await c.tick(); assert.equal(c.view.view, 'board'); assert.equal(c.count('POST new screen'), 0);
  await c.tick();
  assert.equal(c.view.view, 'pair'); assert.match(c.view.code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/); assert.equal(c.db.length, 1); assert.equal(c.count('POST new screen'), 1);
  assert.equal(c.count('GET my screens'), 1, 'it looked for its own rows first');
  assert.deepEqual(c.notes.map((n) => [n.kind, n.id]), [['unpaired', OLD_ID]]);
  assert.equal(c.topics().length, 1); assert.ok(c.topics()[0].includes(c.view.id), 'and it now listens to the new row only');
  for (let i = 0; i < 5; i += 1) await c.tick();
  assert.equal(c.db.length, 1); assert.equal(c.count('GET my screens'), 1); clean(c);
  await c.end();
});

test('wired: a good live update is kept. Back Office swaps the board, shown at once and saved, no read needed', async () => {
  // Holds "mem = r.mem" in the live handler.
  const c = await boot();
  const row = c.db[0]; row.board_id = BOARD2; const before = c.rest.length;
  assert.equal(c.pushTo(row.id, updFrame(row)), 1); await settle();
  assert.equal(c.view.board, BOARD2); assert.equal(c.saved().board_id, BOARD2); assert.equal(c.rest.length, before);
  // And the next good update is judged against the NEW screen: swapping back is a change too.
  row.board_id = BOARD; c.pushTo(row.id, updFrame(row)); await settle();
  assert.equal(c.view.board, BOARD); assert.equal(c.saved().board_id, BOARD);
  await c.tick(); assert.equal(c.view.board, BOARD); clean(c);
  await c.end();
});

test('wired: Back Office sets the TV to Unpaired. The live update alone does not take the board down; one early read does', async () => {
  const c = await boot();
  const row = c.db[0]; Object.assign(row, { board_id: null, status: 'unpaired', paired_at: null });
  c.pushTo(row.id, updFrame(row)); await settle();
  assert.equal(c.view.view, 'board', 'not from the live update');
  c.pushTo(row.id, updFrame(row)); await settle();
  assert.equal(c.timers.filter((x) => x.fn).length, 1, 'one early read, however many times it is said');
  c.advance(1000); assert.equal(await c.runTimers(), 1);
  assert.equal(c.view.view, 'pair'); assert.equal(c.view.code, 'KQ7M-2X9P', 'the same row, the same code'); assert.equal(c.db.length, 1); clean(c);
  await c.end();
});

test('wired: wake, online and the interval at once. One tick at a time, one heartbeat', async () => {
  const c = await boot();
  c.advance(12000); const before = c.rest.length;
  const tick = c.intervals.find((x) => x.fn).fn;
  await Promise.all([tick(), tick(), tick(), tick()]); await settle();
  const made = c.rest.slice(before);
  assert.equal(made.filter((r) => r.includes('RPC heartbeat')).length, 1);
  assert.equal(made.filter((r) => r.includes('GET screen')).length, 2, 'the tick in flight, then ONE more for every trigger that landed during it');
  await c.end();
});

// ── review finding: a tick that learned nothing must not undo a good live update ──
test('wired: a board swap by live update, then the read in flight FAILS. The new board stays on screen and in storage', async () => {
  const c = await boot();
  c.advance(12000);
  let fail; c.hold = new Promise((_, rej) => { fail = rej; });
  const p = c.startTick(); await settle();
  const row = c.db[0]; row.board_id = BOARD2;
  c.pushTo(row.id, updFrame(row)); await settle();
  assert.equal(c.view.board, BOARD2, 'shown at once');
  c.hold = null; c.restDown = true; fail(cut()); await p; await settle();
  assert.equal(c.view.board, BOARD2, 'the failed read did not put the old board back'); assert.equal(c.saved().board_id, BOARD2);
  for (let i = 0; i < 25; i += 1) await c.tick();
  assert.equal(c.view.board, BOARD2, 'nor did five minutes of failed reads'); assert.equal(c.saved().board_id, BOARD2);
  c.restDown = false; await c.tick();
  assert.equal(c.view.board, BOARD2); assert.equal(c.db.length, 1);
  await c.end();
});

test('wired: a TV on its code is paired by live update, then the read in flight fails. It does not drop back to its code', async () => {
  const c = await boot({ rows: [mkRow(OLD_ID, { location_id: null, board_id: null, status: 'unpaired', paired_at: null })] });
  assert.equal(c.view.view, 'pair');
  c.advance(12000);
  let fail; c.hold = new Promise((_, rej) => { fail = rej; });
  const p = c.startTick(); await settle();
  const row = c.db[0]; Object.assign(row, { location_id: LOC, board_id: BOARD2, status: 'paired', paired_at: '2026-10-12T02:10:00.000Z' });
  c.pushTo(row.id, updFrame(row)); await settle();
  assert.equal(c.view.view, 'board');
  c.hold = null; c.restDown = true; fail(cut()); await p; await settle();
  assert.equal(c.view.view, 'board');
  for (let i = 0; i < 10; i += 1) await c.tick();
  assert.equal(c.view.view, 'board'); assert.equal(c.saved().board_id, BOARD2);
  await c.end();
});

test('wired: a board swap by live update while a tick holds an OLDER read. The older read does not win, not even for one tick', async () => {
  const c = await boot();
  c.advance(12000);
  let release; c.hold = new Promise((res) => { release = res; });
  const p = c.startTick(); await settle();
  const row = c.db[0]; const stale = { ...row }; row.board_id = BOARD2;
  c.pushTo(row.id, updFrame(row)); await settle();
  assert.equal(c.view.board, BOARD2);
  // The held read answers with the row as it was BEFORE the swap.
  c.db[0] = stale; c.hold = null; release(); await p; await settle(); c.db[0] = row;
  assert.equal(c.view.board, BOARD2); assert.equal(c.saved().board_id, BOARD2);
  await c.tick(); assert.equal(c.view.board, BOARD2);
  await c.end();
});

// ── review finding: an effect that was cleaned up must not make a row ──
test('wired: mount, clean up, mount on a brand new TV makes ONE row', async () => {
  const c = await boot({ rows: [], saved: null, mounts: 2, warmUp: 0 });
  for (let i = 0; i < 3; i += 1) await c.tick();
  assert.equal(c.db.length, 1); assert.equal(c.count('POST new screen'), 1); assert.equal(c.view.view, 'pair'); assert.equal(c.view.code, c.db[0].code);
  assert.equal(c.intervals.filter((x) => x.fn).length, 1, 'one tick running'); clean(c);
  await c.end();
});

test('wired: one channel at a time, and nothing left running after the TV page goes', async () => {
  const rows = [mkRow(OLD_ID, { paired_at: '2026-10-12T08:00:00.000Z' }), mkRow('aaaaaaaa-0000-4000-8000-00000000000b', { code: 'ROW2-2222', paired_at: '2026-10-11T08:00:00.000Z' })];
  const c = await boot({ rows });
  c.db.shift(); for (let i = 0; i < 3; i += 1) await c.tick();
  assert.equal(c.view.id, 'aaaaaaaa-0000-4000-8000-00000000000b', 'it went to the other paired row it owns'); assert.equal(c.count('POST new screen'), 0);
  assert.deepEqual(c.topics().length, 1); assert.match(c.topics()[0], /^realtime:mbscreen-aaaaaaaa-0000-4000-8000-00000000000b-2$/, 'a new topic each time, with its number');
  c.unmount(); await settle();
  assert.deepEqual(c.topics(), []); assert.equal(c.intervals.filter((x) => x.fn).length, 0); assert.equal(c.timers.filter((x) => x.fn).length, 0);
  await c.end();
});

// ── review finding: sign in changed on a menu board was a dead end ──
test('wired: sign in changed on a menu board. The board stays, Back Office gets a code, pairs it, and can then remove the TV', async () => {
  const c = await boot();
  c.uid = UID2;                                   // a new anonymous user: the old row cannot be seen any more
  for (let i = 0; i < 10; i += 1) await c.tick();
  assert.equal(c.view.view, 'board'); assert.equal(c.view.id, OLD_ID); assert.equal(c.saved().id, OLD_ID);
  assert.equal(c.db.length, 2); assert.equal(c.count('POST new screen'), 1, 'one spare row, never a second');
  const spare = c.db[1];
  assert.equal(spare.device_uid, UID2); assert.equal(spare.location_id, null); assert.ok(spare.last_seen_at, 'kept seen, so its code can be paired');
  assert.equal(c.count('GET my screens'), 1); assert.equal(c.count('RPC order_status_feed'), 0, 'no miss is counted');
  assert.deepEqual(c.notes.at(-1), { kind: 'sign_in_changed', detail: spare.code, id: OLD_ID }, 'the code is said about the OLD screen, where Back Office lists the TV');
  // Back Office removes the old screen. The TV cannot know. The code still works.
  c.db.shift();
  for (let i = 0; i < 5; i += 1) await c.tick();
  assert.equal(c.view.view, 'board'); assert.equal(c.db.length, 1);
  // Back Office pairs the code (at the TV's own venue).
  Object.assign(spare, { location_id: LOC, board_id: BOARD2, status: 'paired', paired_at: iso(c.now) });
  await c.tick();
  assert.equal(c.view.id, spare.id); assert.equal(c.view.board, BOARD2); assert.equal(c.saved().device_uid, UID2);
  assert.deepEqual(c.notes.at(-1), { kind: 'adopted', detail: 'new_code', id: spare.id });
  assert.equal(c.topics().length, 1); assert.ok(c.topics()[0].includes(spare.id));
  // Now it is an ordinary TV: Remove shows a code after three spaced misses.
  c.db.length = 0;
  await c.tick(); await c.tick(); assert.equal(c.view.view, 'board');
  await c.tick();
  assert.equal(c.view.view, 'pair', 'a removed screen under a changed sign in reaches a code'); assert.equal(c.db.length, 1); clean(c);
  await c.end();
});

test('wired: no sign in, or only the public key. Nothing is asked, nothing is lost', async () => {
  for (const mode of ['none', 'public']) {
    const c = await boot();
    c.token = mode; const before = c.rest.length;
    for (let i = 0; i < 10; i += 1) await c.tick();
    assert.equal(c.rest.length, before, `${mode}: no request without a sign in`); assert.equal(c.view.view, 'board'); assert.equal(c.db.length, 1); clean(c);
    await c.end();
  }
});
