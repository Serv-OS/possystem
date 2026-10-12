// src/lib/kds/kdsTillWiring.test.js: where the till side of the 12 Oct 2026 Barnsley build is
// wired (K6 the till says when a kitchen screen stops showing orders, K7 a till replay can never
// un bump a kitchen ticket).
//
// The rules have their own tests (kdsScreenWatch.test.js, kdsTicketReplay.test.js) and the queue
// is run for real in src/sync/kdsTicketReplayQueue.test.js. Perfect rules are worth nothing if the
// till does not call them, or calls them on the order path, and only reading the real files can
// check that.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ROOT = path.resolve(SRC, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const count = (hay, needle) => hay.split(needle).length - 1;
const between = (src, startMarker, endMarker) => {
  const i = src.indexOf(startMarker);
  assert.ok(i >= 0, `marker not found: ${startMarker}`);
  const j = src.indexOf(endMarker, i + startMarker.length);
  assert.ok(j > i, `end marker not found after ${startMarker}: ${endMarker}`);
  return src.slice(i, j);
};
function sourceFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) sourceFiles(p, out);
    else if (/\.(jsx?|mjs)$/.test(e.name) && !/\.test\.js$/.test(e.name)) out.push(p);
  }
  return out;
}
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');
const filesImporting = (name) => {
  const re = new RegExp(`from\\s+['"][^'"]*/${name}(\\.js)?['"]`);
  return sourceFiles(SRC).filter((p) => re.test(fs.readFileSync(p, 'utf8'))).map(rel).sort();
};

// ── K7: the kitchen ticket is inserted once ─────────────────────────────────────────────────────

test('PIN K7: db.js queues a failed kitchen ticket as insert if missing, and the first send is still a plain insert', () => {
  const db = read('src/lib/db.js');
  const fn = between(db, 'export const insertKDSTicket = async (ticket, locationId = null) => {', 'export const bumpKDSTicket');
  assert.ok(db.includes("import { kitchenTicketQueueItem, isDuplicateTicketError } from './kds/kdsTicketReplay';"));
  assert.equal(count(fn, 'await queueWrite(kitchenTicketQueueItem(_kdsMetaColumn === true ? withMeta : row));'), 1);
  assert.equal(count(fn, 'if (isDuplicateTicketError(err)) return true;'), 1, 'a duplicate key answer means it is already there');
  assert.equal(count(fn, 'if (res?.error && await handleFailure(res.error)) return { data: null, error: null };'), 1, 'and the caller is told it was sent');
  // The order path does not change: one plain insert, no upsert, no read first.
  assert.equal(count(fn, "supabase.from('kds_tickets').insert(withMeta)"), 1);
  assert.equal(count(fn, "supabase.from('kds_tickets').insert(row)"), 1, 'the retry without meta before the migration');
  assert.equal(count(fn, '.upsert('), 0);
  assert.equal(count(fn, '.select('), 0);
  // The merging upsert that un bumped a ticket is gone from the whole file.
  assert.equal(count(db, "queueWrite({ type: 'upsert', table: 'kds_tickets'"), 0);
  assert.equal(count(db, "table: 'kds_tickets', payload"), 0);
});

test('PIN K7: OfflineQueue replays a queued upsert with the replay options, one by one and in a batch', () => {
  const oq = read('src/sync/OfflineQueue.js');
  assert.ok(oq.includes("import { replayUpsertOptions, upsertRunKey } from '../lib/kds/kdsTicketReplay';"));
  assert.equal(count(oq, 'supabase.from(item.table).upsert(item.payload, replayUpsertOptions(item));'), 1, 'one by one');
  assert.equal(count(oq, "it.type === 'upsert' ? upsertRunKey(it)"), 1, 'a merge and an insert if missing never share a statement');
  assert.equal(count(oq, 'upsertOptions: replayUpsertOptions(item), items: [item] }'), 1);
  assert.equal(count(oq, 'supabase.from(run.table).upsert(fresh.map(i => i.payload), run.upsertOptions);'), 1, 'in a batch');
  // The old calls, which merged whatever the table, are gone.
  assert.equal(count(oq, "upsert(item.payload, { onConflict: item.onConflict || 'id' })"), 0);
  assert.equal(count(oq, '{ onConflict: run.onConflict })'), 0);
  assert.equal(count(oq, "it.type === 'upsert' ? `u|${it.table}|${it.onConflict || 'id'}`"), 0);
  // Every upsert the queue sends goes through the options: there is no third call.
  assert.equal(count(oq, '.upsert('), 2);
});

test('PIN K7: the replay rules are pure and only the till queue code uses them', () => {
  const rules = read('src/lib/kds/kdsTicketReplay.js');
  assert.equal(/^import /m.test(rules), false, 'no imports: no Supabase, no storage');
  assert.deepEqual(filesImporting('kdsTicketReplay'), ['src/lib/db.js', 'src/sync/OfflineQueue.js']);
});

// ── K6: the till says it too ────────────────────────────────────────────────────────────────

test('PIN K6: the bar is mounted in the fixed till slot, through KioskStaffAlert', () => {
  const kiosk = read('src/components/KioskStaffAlert.jsx');
  assert.ok(kiosk.includes("import KdsScreenAlert from './KdsScreenAlert';"));
  const mount = between(kiosk, 'export default function KioskStaffAlert() {', 'function KioskAlertCard() {');
  assert.equal(count(mount, '<KdsScreenAlert />'), 1);
  assert.equal(count(mount, '<KioskAlertCard />'), 1, 'the kiosk card is still there');
  assert.equal(count(kiosk, 'export default'), 1);
  // The kiosk card itself is as it was: its own queue, its own chime, its own OK.
  const card = kiosk.slice(kiosk.indexOf('function KioskAlertCard() {'));
  assert.ok(card.includes('const queue = useStore(s => s.kioskStaffAlerts) || EMPTY;'));
  assert.ok(card.includes('acknowledgeKioskAlert(useStore, front.key, who);'));
  assert.deepEqual(filesImporting('KdsScreenAlert'), ['src/components/KioskStaffAlert.jsx'], 'mounted once, nowhere else');
});

test('PIN K6: the bar runs on counter tills only and makes exactly two small reads, never a write', () => {
  const bar = read('src/components/KdsScreenAlert.jsx');
  assert.ok(bar.includes('const on = !isMock && !!supabase && !!locationId && watchRunsOn({ type: device?.type, defaultSurface });'));
  assert.ok(bar.includes('if (!on) return undefined;'), 'no timer, no subscription and no read on any other device');
  // READ 1 and READ 2, exactly.
  assert.equal(count(bar, "supabase.from('devices').select('id,name,type,status,centre_id,last_seen,kds_settings').eq('location_id', locationId)"), 1);
  assert.equal(count(bar, "supabase.from('kds_tickets').select('id,status').in('id', ids)"), 1);
  assert.equal(count(bar, 'supabase.from('), 2, 'no third read');
  // Both are selects (pinned above), so there is no delete either; the timers Set has its own delete.
  for (const write of ['.insert(', '.update(', '.upsert(', '.rpc(', 'mustChangeRow', 'queueWrite']) assert.equal(count(bar, write), 0, write);
  assert.equal(/from '\.\.\/lib\/db(\.js)?'|import\('\.\.\/lib\/db/.test(bar), false, 'nothing from lib/db');
  assert.ok(bar.includes('READ_LIMIT_MS = 10000') && bar.includes('const res = await withTimeout(q, READ_LIMIT_MS, label);'), 'each read is given up after 10 seconds');
  assert.ok(bar.includes("if (typeof q.retry === 'function') q = q.retry(false);"), "one request per look: the client's own repeats are off");
  assert.ok(bar.includes("if (ctrl && typeof q.abortSignal === 'function') q = q.abortSignal(ctrl.signal);") && bar.includes('if (ctrl) ctrl.abort();'), 'and cancelled, so a hung request does not stay open');
  // The rules decide; the component only hands in the till's list and the two reads.
  assert.ok(bar.includes('const next = await watchLook({'));
  assert.ok(bar.includes('tickets: st.kdsTickets,'), "the orders waiting come from the till's own list");
  assert.ok(bar.includes('trading: isTrading({ openingHours: cfg.opening_hours, timeZone: tz, now, isOpenNow }),'));
  assert.ok(bar.includes('getAlerts: () => alertsRef.current, watch, now, readDevices, readStatuses,'));
  assert.ok(bar.includes('for (const station of leftWaiting(prev.kdsTickets, state.kdsTickets)) watch.bumpSeenAt.set(station, at);'), 'a ticket leaving the list is a bump seen');
  // A slow timer, never the order path.
  assert.ok(bar.includes('const firstLook = setTimeout(look, FIRST_LOOK_MS);') && bar.includes('FIRST_LOOK_MS = 15000'));
  assert.ok(bar.includes('const every = setInterval(look, WATCH_TICK_MS);'));
  assert.ok(bar.includes('if (!alive || busy) return;'), 'one look at a time');
  assert.ok(bar.includes('clearTimeout(firstLook);') && bar.includes('clearInterval(every);') && bar.includes('unsub();'));
  // The chime, and never while a customer holds the till.
  assert.equal(count(bar, 'playOrderChime()'), 1);
  assert.ok(bar.includes('if (next.sound && !useStore.getState().tillCustomerFacing) playOrderChime();'));
  assert.ok(bar.includes('if (!on || held) return null;'));
});

test('PIN K6: it is a bar, not a pop up, and its words come from the rules', () => {
  const bar = read('src/components/KdsScreenAlert.jsx');
  assert.ok(bar.includes("position: 'fixed', top: 0, left: 0, right: 0, zIndex: 10030,"), 'under the device link bar (10040)');
  assert.ok(read('src/components/DeviceLinkBanner.jsx').includes("position: 'fixed', top: 0, left: 0, right: 0, zIndex: 10040,"));
  assert.equal(count(bar, 'inset: 0'), 0, 'it never covers the till');
  assert.equal(count(bar, 'createPortal'), 0);
  assert.ok(bar.includes('role="alert"') && bar.includes('role="status"'));
  assert.ok(bar.includes('const w = alertWords(a);') && bar.includes('{w.title}') && bar.includes('{w.body}'));
  assert.ok(bar.includes('text: backWords(b)'));
  assert.ok(bar.includes('const ok = (screenId) => { const next = hideAlert(alertsRef.current, screenId); alertsRef.current = next; setAlerts(next); };'), 'OK hides it until the next chime');
  assert.ok(bar.includes('onClick={() => ok(a.screenId)}'));
  assert.ok(bar.includes("background: '#b91c1c'") && bar.includes("background: '#14532d'"));
});

test('PIN K6: the watch rules are free of React, Supabase and timers, and only the till uses them', () => {
  const rules = read('src/lib/kds/kdsScreenWatch.js');
  assert.equal(/^import /m.test(rules), false, 'no imports at all');
  for (const banned of ['setTimeout', 'setInterval', 'localStorage', 'supabase.', 'Date.now()']) assert.equal(count(rules, banned), 0, banned);
  assert.deepEqual(filesImporting('kdsScreenWatch'), ['src/components/KdsScreenAlert.jsx', 'src/components/StatusDrawer.jsx']);
});

test('PIN: the status drawer judges a kitchen screen by its own heartbeat and says the test ticket honestly', () => {
  const drawer = read('src/components/StatusDrawer.jsx');
  assert.equal(count(drawer, 'ONLINE_THRESHOLD_MS'), 0);
  assert.equal(count(drawer, 'bumpAge'), 0, '"any bump at the venue in 10 minutes" no longer makes a screen ONLINE');
  const load = between(drawer, 'const loadKDS = useCallback(async () => {', '// Load printer health');
  assert.equal(count(load, 'supabase.from('), 1, 'ONE read (it used to be two)');
  assert.ok(load.includes("supabase.from('devices').select('id,name,type,last_seen,status,centre_id').eq('location_id', locId);"), 'every device of the venue, same columns');
  assert.equal(count(load, "from('kds_tickets')"), 0);
  assert.ok(load.includes('const serverNow = serverNowFrom(data);'));
  assert.ok(load.includes('heard[d.id] = screenStatus({ lastSeenMs: d.last_seen ? new Date(d.last_seen).getTime() : NaN, serverNow });'));
  assert.equal(count(load, 'Date.now()'), 0, "never this till's own clock");
  assert.ok(drawer.includes("{heardWords(kdsHeard[device.id] || { state: 'unknown' })}"));
  assert.ok(drawer.includes('const waitingLine = waitingWords(waitingSummary(storeTickets, { centreId: device.centre_id || null, now: Date.now(), dayStartMs: kdsDayStartMs }));'));
  assert.ok(drawer.includes('const storeTickets = useStore(s => s.kdsTickets);'), "orders waiting come from the till's own list, no read");
  // The test button.
  const testFn = between(drawer, 'const testKDS = async (device) => {', 'const retryJob = async (job) => {');
  assert.equal(count(testFn, 'Test ticket sent to'), 0, '"sent" alone is no longer the last word');
  assert.ok(testFn.includes("testTicketWords({ state: silent ? 'silent' : 'sent', name: device.name, silentMs: heard?.silentMs || 0 })"));
  assert.ok(testFn.includes('const here = (useStore.getState().kdsTickets || []).some(t => t.id === testTicket.id);'), "it watches the till's own list");
  assert.ok(testFn.includes("if (seen && !here) { stop(); finish('bumped'); return; }"));
  assert.ok(testFn.includes('if (Date.now() - sentAt < TEST_WATCH_MS) return;') && drawer.includes('const TEST_WATCH_MS = 60 * 1000;') && drawer.includes('const TEST_CHECK_MS = 3000;'));
  assert.equal(count(testFn, "supabase.from('kds_tickets').select('status').eq('id', testTicket.id).maybeSingle()"), 1, 'then one read of that row');
  assert.ok(testFn.includes("finish(status === 'bumped' ? 'bumped' : 'waiting');"));
  assert.ok(testFn.includes('clearInterval(testTimers.current.get(device.id));'), 'pressed again: only the newest test ticket is watched');
  assert.ok(drawer.includes('return () => { drawerOpen.current = false; held.forEach(clearInterval); held.clear(); };'), 'timers are cleared when the drawer closes');
});

test('PIN: no dash punctuation and no "N/A" in the words the till shows', () => {
  for (const file of ['src/lib/kds/kdsScreenWatch.js', 'src/lib/kds/kdsTicketReplay.js', 'src/components/KdsScreenAlert.jsx']) {
    const src = read(file);
    assert.equal(/[\u2013\u2014]/.test(src), false, `${file}: a dash`);
    assert.equal(/N\/A/.test(src), false, `${file}: N/A`);
  }
});
