// src/lib/menuBoardPairingWiring.test.js
//
// 12 Oct 2026. The rules in menuBoardPairing.js only protect a TV if MenuBoardSurface.jsx really
// runs them, and if the things they lean on stay true: the client library lets a request carry
// the device's own token, and the server function used as the second opinion still tells
// "you own no such screen" apart from "you are not signed in". These tests pin that wiring, so
// a later edit or a library upgrade that would bring the night of 11 to 12 Oct back fails here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const count = (text, part) => text.split(part).length - 1;
const SURFACE = read('../surfaces/MenuBoardSurface.jsx');
const between = (text, from, to) => {
  const a = text.indexOf(from); assert.ok(a >= 0, `marker not found: ${from}`);
  const b = text.indexOf(to, a + from.length); assert.ok(b > a, `end marker not found: ${to}`);
  return text.slice(a, b);
};
// The pairing effect, from its opening comment to its dependency list.
const EFFECT = between(SURFACE, 'device pairing: find or register this screen', '}, [pairing]);');

test('the live handler no longer hands the record straight to the screen', () => {
  // Before: (p) => apply(p.new), and apply only checked that the record was truthy. {} is truthy.
  assert.equal(count(SURFACE, 'apply(p.new)'), 0);
  assert.equal(count(EFFECT, 'p.new'), 0, 'the effect never reads the record itself');
  assert.equal(count(EFFECT, '.new'), 0);
  assert.match(EFFECT, /\.on\('postgres_changes', \{ event: 'UPDATE', schema: 'public', table: 'menu_board_screens', filter: `id=eq\.\$\{sid\}` \}, onLive\)/);
  assert.equal(count(EFFECT, 'applyLiveUpdate(mem, p)'), 1, 'every live update goes through the rules');
});

test('a bad live update causes no read and no heartbeat (one bad change reaches every TV at once)', () => {
  const ignored = between(EFFECT, 'ignored a live update', '// Realtime for our own row');
  assert.equal(count(ignored, 'tick('), 0);
  assert.equal(count(ignored, 'early('), 0);
  assert.equal(count(ignored, 'supabase.'), 0);
  // The only early read is for a good update that would take the board down.
  assert.match(EFFECT, /if \(r\.action === 'confirm'\) \{ console\.warn\([^)]*\); early\(\); return; \}/);
});

test('the tick is the rules, one at a time, and nothing else decides', () => {
  assert.equal(count(EFFECT, 'runPairingTick(mem, io)'), 1);
  assert.match(EFFECT, /if \(busy\) \{ again = true; return; \}/);
  for (const gone of ['screenIdRef', 'localStorage.removeItem(LS_SCREEN)', 'window.location.reload(', 'createRow', 'MISS_SPACING_MS']) {
    assert.equal(count(SURFACE, gone), 0, `${gone} is gone`);
  }
  assert.equal(count(SURFACE, 'localStorage.setItem(LS_SCREEN'), 1, 'one place saves the screen');
  assert.match(EFFECT, /const show = \(s\) => \{\s*if \(!alive \|\| !s\) return;/, 'and it never saves nothing');
  assert.match(SURFACE, /try \{ return readSavedScreen\(localStorage\.getItem\(LS_SCREEN\)\)\.screen; \} catch \{ return null; \}/, 'a saved screen with no id is not loaded as a screen');
});

test('every pairing request carries the device\'s own token', () => {
  assert.match(EFFECT, /const asMe = \(q, token\) => q\.setHeader\('Authorization', `Bearer \$\{token\}`\);/);
  const io = between(EFFECT, 'const io = {', 'tickRef.current = tick;');
  for (const name of ['readRow', 'checkGone', 'readOwned', 'insertRow', 'heartbeat']) {
    const line = io.split('\n').find((l) => l.trim().startsWith(`${name}:`));
    assert.ok(line, `${name} is wired`);
    assert.ok(line.includes('asMe('), `${name} runs as this device`);
  }
  assert.equal(count(io, 'supabase.from(') + count(io, 'supabase.rpc('), 5, 'no request outside those five');
  assert.match(io, /supabase\.rpc\('order_status_feed', \{ p_screen_id: id \}\)/);
  assert.match(io, /\.eq\('device_uid', uid\)/, 'a Back Office login can see every screen at its venues, so the owner filter is a must');
  assert.match(io, /getToken: \(\) => timed\(ensureAuthToken\(\), 'Auth session'\)/);
});

test('what the TV draws is decided by the tested rule, and the saved venue lets a cached board show', () => {
  assert.match(SURFACE, /decideView\(\{ pairing, screen, urlBoardId, hasData: !!data, resolving \}\)/);
  assert.match(SURFACE, /const locId = netLocId \|\| savedLocId;/);
  assert.equal(count(SURFACE, 'if (pairing && !effectiveBoardId) return <PairScreen'), 0);
});

test('a failed content read never replaces the board on screen or its saved copy', () => {
  const load = between(SURFACE, 'const load = useCallback(async (id) => {', '}, [effectiveBoardId]);');
  const guard = load.indexOf("const failed = failedBoardRead({ board: boardRes, categories: catsRes, items: itemsRes });");
  assert.ok(guard > 0);
  assert.match(load.slice(guard), /^[^\n]*\n\s*if \(failed\) \{ console\.warn\([^\n]*\); return; \}/);
  assert.ok(guard < load.indexOf('setData(next)'), 'checked before anything is drawn');
  assert.ok(guard < load.indexOf('localStorage.setItem(cacheKey('), 'and before anything is saved');
  assert.match(load, /six: sixRes\?\.error \? new Set\(dataRef\.current\?\.six \|\| \[\]\)/, 'a failed sold out read keeps the last list');
});

test('the note a TV leaves is written by the tested rules, already read, so no till bell counts it', () => {
  // What a note is (the row, written already read, the limits) is makeNoteStamper, run by
  // menuBoardPairing.test.js. Here: menuBoardNotes.js really uses it, on the right table.
  const notes = read('./menuBoardNotes.js');
  assert.match(notes, /const stamp = makeNoteStamper\(\{\s*write: \(row\) => supabase\.from\('activity_events'\)\.insert\(row\),/);
  assert.match(notes, /export function stampScreenNote\(note\) \{\s*try \{\s*if \(isMock \|\| !supabase\) return;\s*stamp\(note\);/);
  assert.equal(count(notes, ".from('activity_events')"), 2, 'one write, one read, nothing else');
  assert.match(notes, /const code = noteCode\(r\.title\);/, 'Back Office reads the code with the same rule that wrote it');
  // The bell counts rows with no acked_at (components/ActivityFeed.jsx).
  assert.match(read('../components/ActivityFeed.jsx'), /const live = events\.filter\(e => !e\.ackedAt\);/);
  const bo = read('../backoffice/sections/MenuBoards.jsx');
  assert.match(bo, /fetchScreenNotes\(id\)\.then\(/);
  // Which line shows is screenNoteView (tested), over EVERY screen row at the venue.
  assert.match(bo, /const tvNoteView = \(notes, screens\) => screenNoteView\(\{ notes, screens, now: Date\.now\(\) \}\);/);
  assert.match(bo, /const tvView = tvNoteView\(tvNotes, paired\);/);
  assert.match(bo, /\{tvView\.byScreen\[s\.id\] && <div[^>]*title=\{tvView\.byScreen\[s\.id\]\.body\}>\{tvView\.byScreen\[s\.id\]\.text\}<\/div>\}/);
  assert.match(bo, /\{tvView\.lost\.map\(\(n\) => \(\s*<div key=\{n\.id\}[^>]*title=\{n\.body\}>\{n\.text\}<\/div>\s*\)\)\}/, 'the code of a TV whose old screen is gone from the list');
});

test('review fixes in the effect: a tick that learned nothing keeps a live update, and a dead effect is told so', () => {
  // The behaviour is run in menuBoardPairingReplay.test.js. These pins say which lines carry it.
  assert.match(EFFECT, /const started = mem\.screen;\s*const next = await runPairingTick\(mem, io\);\s*if \(alive\) \{\s*mem = sameScreen\(next\.screen, started\) \? \{ \.\.\.next, screen: mem\.screen \} : next;/);
  assert.equal(count(EFFECT, 'mem = next;'), 0, 'the tick result is never taken blind');
  const io = between(EFFECT, 'const io = {', 'tickRef.current = tick;');
  assert.match(io, /alive: \(\) => alive,/);
  assert.match(EFFECT, /supabase\.channel\(`mbscreen-\$\{sid\}-\$\{\+\+chSeq\}`\)/, 'a new topic for each subscription');
});

// ── the client library: a request that says who it is, is sent as that, never as the public key ──
test('the real client sends OUR token when a request carries one, and the public key when it does not', async () => {
  const seen = [];
  const fakeFetch = async (input, init = {}) => {
    const h = new Headers(init.headers);
    const url = new URL(typeof input === 'string' ? input : input.url);
    seen.push({ method: init.method || 'GET', path: url.pathname, auth: h.get('Authorization') });
    const body = url.pathname.includes('/rpc/') ? { paired: false, reason: 'no_screen' } : [];
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  // No session at all: left to itself this client sends the public key.
  const supabase = createClient('https://fake-ops.supabase.co', 'PUBLIC-KEY', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: fakeFetch },
  });
  const asMe = (q, token) => q.setHeader('Authorization', `Bearer ${token}`);
  const id = 'caa49948-8820-4aeb-a4ce-e40f32edb1d5';
  await asMe(supabase.from('menu_board_screens').select('*').eq('id', id).maybeSingle(), 'DEVICE-TOKEN');
  await asMe(supabase.rpc('order_status_feed', { p_screen_id: id }), 'DEVICE-TOKEN');
  await asMe(supabase.from('menu_board_screens').select('*').eq('device_uid', id).order('created_at', { ascending: false }).limit(50), 'DEVICE-TOKEN');
  await asMe(supabase.from('menu_board_screens').insert({ code: 'ABCD-EFGH' }).select().maybeSingle(), 'DEVICE-TOKEN');
  await asMe(supabase.rpc('mb_screen_heartbeat', { p_id: id }), 'DEVICE-TOKEN');
  const unpinned = await supabase.from('menu_board_screens').select('*').eq('id', id).maybeSingle();
  assert.deepEqual(seen.slice(0, 5).map((s) => s.auth), Array(5).fill('Bearer DEVICE-TOKEN'));
  assert.deepEqual(seen.slice(0, 5).map((s) => `${s.method} ${s.path}`), [
    'GET /rest/v1/menu_board_screens', 'POST /rest/v1/rpc/order_status_feed', 'GET /rest/v1/menu_board_screens',
    'POST /rest/v1/menu_board_screens', 'POST /rest/v1/rpc/mb_screen_heartbeat']);
  // This is the trap the token closes: no session, so the public key, and "no rows" with NO error.
  assert.equal(seen[5].auth, 'Bearer PUBLIC-KEY');
  assert.deepEqual([unpinned.data, unpinned.error], [null, null]);
});

test('the library text the token leans on is still there (an upgrade that drops it fails here)', () => {
  const postgrest = read('../../node_modules/@supabase/postgrest-js/dist/index.mjs');
  assert.ok(postgrest.includes('setHeader(name, value)'));
  const client = read('../../node_modules/@supabase/supabase-js/dist/index.mjs');
  assert.ok(client.includes('if (!headers.has("Authorization"))'), 'the client only adds its own token when the request has none');
});

// ── the second opinion: order_status_feed must tell "no such screen of yours" from "not signed in" ──
test('order_status_feed still answers no_screen only for a signed in device that owns no such row', () => {
  const dir = new URL('../../supabase/migrations/', import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql'))
    .filter((f) => /create or replace function public\.order_status_feed\(/i.test(readFileSync(new URL(f, dir), 'utf8')));
  assert.ok(files.length >= 3, `found ${files.length}`);
  for (const f of files) {
    const sql = readFileSync(new URL(f, dir), 'utf8');
    const body = sql.slice(sql.search(/create or replace function public\.order_status_feed\(/i));
    const noSession = body.indexOf("'reason', 'no_session'");
    const owner = body.indexOf('ms.id = p_screen_id and ms.device_uid = v_uid');
    const noScreen = body.indexOf("'reason', 'no_screen'");
    const notAssigned = body.indexOf("'reason', 'not_assigned'");
    assert.ok(noSession > 0 && owner > noSession && noScreen > owner && notAssigned > noScreen, `${f}: no_session, then the owner check, then no_screen, then not_assigned`);
    assert.match(body.slice(0, noSession), /v_uid uuid := auth\.uid\(\);[\s\S]*if v_uid is null then/, `${f}: nobody is told no_session, never no_screen`);
    assert.match(body.slice(0, 400), /security definer/i, `${f}: it runs as the owner, so row level security cannot hide the row from it`);
  }
});
