// 12 Oct 2026, Coffee Boy Barnsley: source pins for the wiring of the slow link build. The rules
// are proven in kdsWriteLane.test.js, kdsBoardRows.test.js, kdsLinkHealth.test.js,
// kdsBoardEngine.test.js and kdsSlowLink.test.js; these pins hold the kitchen screen to them, so a
// later edit cannot quietly go back to painting a bumped ticket or to a write with no time limit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const count = (text, needle) => text.split(needle).length - 1;
/** Source with its comments taken out (line comments, block comments and JSX comments). */
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/([^:'"`])\/\/ .*$/gm, '$1');

const surf = read('../../surfaces/kds/KDSSurface.jsx');
const card = read('../../surfaces/kds/KdsTicketCard.jsx');
const engine = read('./kdsBoardEngine.js');

test('the board runs on the engine, and the old rules are gone', () => {
  assert.ok(surf.includes("import { createBoardEngine } from '../../lib/kds/kdsBoardEngine';"));
  assert.ok(surf.includes('eng = createBoardEngine({'));
  assert.ok(surf.includes('eng.start();'));
  assert.ok(surf.includes('eng.stop();'), 'stopped when the screen is re pointed or closed');
  assert.ok(surf.includes('const [board, setBoard] = useState(EMPTY_BOARD);'));
  assert.ok(surf.includes('onChange: () => { if (alive && eng) setBoard(eng.view()); },'));
  assert.ok(surf.includes('if (live) return board.rows;'), 'the board paints the engine\'s rows');
  for (const gone of ['writeSeq', 'pendingBumps', 'setLoadError', 'loadError', 'tracked(', "Can't reach the kitchen list", 'setRows(']) {
    assert.equal(surf.includes(gone), false, `${gone} must not come back`);
  }
  assert.equal(surf.includes('Bump did not save'), false, 'a failed bump says so on its card, not in a 2.8 second message');
  assert.equal(/writeFailed\('Bump'\)/.test(surf), false);
});

test('the engine is handed the browser through arrow wrappers (the v5.8.56 "Illegal invocation" lesson)', () => {
  // A bare { setTimeout, clearTimeout } called as an object method throws in a browser and not in
  // node, so no node test can catch it. The wrappers make each one a plain global call.
  assert.ok(surf.includes('now: () => Date.now(),'));
  assert.ok(surf.includes('setTimer: (fn, ms) => setTimeout(fn, ms),'));
  assert.ok(surf.includes('clearTimer: (id) => clearTimeout(id),'));
  assert.ok(surf.includes('? () => { const c = new AbortController(); return { signal: c.signal, abort: () => c.abort() }; }'));
  // The engine itself touches nothing of the browser, React, the store or Supabase.
  const src = code(engine);
  const imports = src.match(/from '[^']+'/g) || [];
  assert.deepEqual(imports.sort(), ["from './kdsBoardRows.js'", "from './kdsLinkHealth.js'", "from './kdsWriteLane.js'"]);
  for (const banned of ['supabase', 'useStore', 'setTimeout(', 'clearTimeout(', 'setInterval(', 'Date.now(', 'localStorage', 'window.', 'document.', 'AbortController']) {
    assert.equal(src.includes(banned), false, `kdsBoardEngine.js must not use ${banned}`);
  }
  for (const pure of ['./kdsWriteLane.js', './kdsBoardRows.js', './kdsLinkHealth.js']) {
    const p = code(read(pure));
    for (const banned of ["from 'react'", 'supabase', 'setTimeout(', 'localStorage', 'window.', 'document.']) {
      assert.equal(p.includes(banned), false, `${pure} must not use ${banned}`);
    }
  }
});

test('K2, K8: every ticket write of the screen carries a cancel signal and goes through the kitchen client', () => {
  assert.ok(surf.includes("import { supabase, isMock, kitchenClient } from '../../lib/supabase';"));
  assert.ok(surf.includes('const kitchenDb = () => (kitchenDbClient || (kitchenDbClient = kitchenClient() || supabase));'), 'the one line to hold K8 back: make this return supabase');
  assert.ok(surf.includes("const ticketWrite = (id, payload, label, signal) =>\n  mustChangeRow({ table: 'kds_tickets', type: 'update', payload, match: { id }, kind: 'kds_ticket', label, signal }, { client: kitchenDb() })"));
  assert.ok(surf.includes('writeTicket: ticketWrite,'));
  // The board's own kds_tickets reads: the list, last bumped, the note's rows, Recall last, History.
  assert.equal(count(surf, "kitchenDb().from('kds_tickets')"), 5);
  assert.equal(/\.from\('kds_tickets'\)\.update\(/.test(surf), false, 'no uncounted ticket write');

  const fence = read('../rowWriteFence.js');
  assert.ok(fence.includes("inList = null, returning: cols = null, signal = null } = {}, { returning } = {}) {"));
  assert.ok(fence.includes("return signal && typeof built.abortSignal === 'function' ? built.abortSignal(signal) : built;"));
  // A parked or queued copy of a write must never carry the signal (it cannot be stored, and a
  // cancelled signal would kill the replay).
  const parked = fence.slice(fence.indexOf('export function parkedWriteItem'), fence.indexOf('const safe = async'));
  assert.equal(parked.includes('signal'), false);

  const writes = read('../rowWrites.js');
  assert.ok(writes.includes('export async function mustChangeRow(write, { client = null } = {}) {'));
  assert.ok(writes.includes('runMustChangeWrite(write, client ? { ...liveDeps(), client } : liveDeps())'));

  const supa = read('../supabase.js');
  assert.ok(supa.includes("import { kitchenTokenSource } from './kds/kdsToken';"));
  assert.ok(supa.includes('export function kitchenClient() {'));
  assert.ok(supa.includes('if (isMock) return null;'));
  assert.ok(supa.includes('accessToken: kitchenTokenSource({'));
  assert.ok(supa.includes('storageKey: AUTH_STORAGE_KEY,\n        sessionToken: async () => {\n          const { data } = await supabase.auth.getSession();'), 'the same stored session, and the main client once it has run out');
  assert.ok(supa.includes('let _kitchenClient = null;'), 'made on first use: no till, kiosk or Back Office builds it');
});

test('K4: the list read is cancellable, not repeated by the client, and an untrusted empty answer is not used', () => {
  assert.ok(surf.includes("if (signal && typeof q.abortSignal === 'function') q = q.abortSignal(signal);"));
  assert.ok(surf.includes("if (typeof q.retry === 'function') q = q.retry(false);"));
  assert.ok(surf.includes('if (error) return { error };'));
  // Kept word for word (lib/deviceFence.test.js pins it too): undefined = "cannot tell".
  assert.ok(surf.includes('if (data && !trustSharedRead({ linkUncertain: isDeviceLinkUncertain(), rowCount: data.length })) return;'));
  assert.ok(surf.includes('return { data: data || [] };'));
  assert.ok(surf.includes("document.addEventListener('visibilitychange', onVisible);"));
  assert.ok(surf.includes("window.addEventListener('online', reload);"));
  assert.equal(surf.includes('setInterval(load, 20000)'), false, 'the 20 s poll is the engine\'s');
});

test('K1, K3: bump, hold, resume, recall and undo are handed to the engine', () => {
  assert.ok(surf.includes("if (t.unsaved === 'bump') eng.retryBump(id);\n      else eng.bump(t);"), 'a card that says "Bump not saved" sends the SAME bump again');
  assert.ok(surf.includes('if (live) engineRef.current?.hold(id);'));
  assert.ok(surf.includes('if (live) engineRef.current?.resume(id);'));
  assert.ok(surf.includes('eng.restore(row, status);'));
  assert.ok(surf.includes('if (live) engineRef.current?.patchRow(id, patch);'));
  assert.ok(surf.includes('onBumpSaved: (row) => { if (alive && row) scheduleAutoStatusRef.current(row); },'), 'the auto ready step runs once the bump is in the database');
  // Undo: the card goes back at the tap with the ticket as it was; no wait on the bump, no read of the row.
  const undo = surf.slice(surf.indexOf('const doUndo = useCallback('), surf.indexOf('}, [live, restore, patchRow, cancelAutoStatus]);'));
  assert.ok(undo.length > 100);
  assert.ok(undo.includes('restore(u.row, u.prevStatus)'));
  assert.equal(undo.includes('.from('), false, 'Undo reads no row');
  assert.equal(undo.includes('await'), false, 'Undo waits for nothing');
  assert.ok(surf.includes('setUndo({ id, prevStatus: t.held ? \'held\' : \'pending\', headline: ticketView(t).headline, at: Date.now(), row: t });'));
  // Undo stays quiet when it lands, as before; Recall last and History say "Ticket recalled".
  assert.ok(surf.includes('if (restore(u.row, u.prevStatus)) quietRestores.current.add(u.id);'));
  assert.ok(surf.includes("if (!quietRestores.current.delete(entry.id)) useStore.getState().showToast?.('Ticket recalled', 'success');"));
  assert.ok(surf.includes("onGaveUp: (entry) => { if (alive && entry.kind !== 'bump') writeFailedRef.current(GAVE_UP_WORD[entry.kind] || 'Change'); },"));
  assert.ok(surf.includes("const GAVE_UP_WORD = { hold: 'Hold', resume: 'Resume', restore: 'Recall' };"));
});

test('K2: item ticks, notes and the auto ready step have a time limit too', () => {
  assert.ok(surf.includes('? await eng.limitedWrite(`tick:${id}`, send, { tries: 3, stillWanted: () => localTicks.current.get(id) === entry })'));
  assert.ok(surf.includes('const { error: e } = eng ? await eng.limitedWrite(`note:${r.id}`, send) : await send();'));
  assert.ok(surf.includes("signal: ctl ? ctl.signal : undefined,\n          }), LOAD_TIMEOUT_MS, 'Order status')"), 'cancelled after 15 s, never sent again');
  assert.ok(surf.includes("limitedRead(q, LOAD_TIMEOUT_MS, 'Last bumped')"));
  assert.ok(surf.includes("limitedRead(q, LOAD_TIMEOUT_MS, 'Recall last')"));
  assert.ok(surf.includes("limitedRead(q, LOAD_TIMEOUT_MS, 'History')"));
  assert.ok(surf.includes('if (recallBusy.current) return;'), 'two impatient taps on Recall last recall one ticket');
  // Recall last looks at this screen's own unsaved bumps first: no read, the card is back at the tap.
  const recall = surf.slice(surf.indexOf('const recallLast = useCallback('), surf.indexOf('// History: today only'));
  assert.ok(recall.indexOf('const mine = engineRef.current?.lastUnsavedBump();') > 0);
  assert.ok(recall.indexOf('const mine = engineRef.current?.lastUnsavedBump();') < recall.indexOf("kitchenDb().from('kds_tickets')"), 'before the read');
  assert.ok(recall.includes('if (restore(mine) && undoRef.current?.id === mine.id) setUndo(null);\n      return;'));
  assert.ok(surf.includes('const canRecall = live ? (lastBumpedToday || board.unsavedBumps > 0) :'), 'the button shows while a bump is unsaved, whatever the database says');
});

test('K5: the banner, the header count, the empty board and "more below" take their words from kdsLinkHealth', () => {
  assert.ok(surf.includes("import { bannerWords, savingWords, emptyWords, countBelow, belowWords, traceWords } from '../../lib/kds/kdsLinkHealth';"));
  assert.ok(surf.includes('const linkBanner = live ? bannerWords({ level: board.level, unsavedBumps: board.unsavedBumps }) : null;'));
  assert.ok(surf.includes('const savingNote = live && board.showSaving ? savingWords({ bumps: board.unsavedBumps, others: board.unsavedOthers }) : null;'));
  // The empty board counts a bump as "not saved yet" only once the header does (3 s), so clearing a healthy board never flashes it.
  assert.ok(surf.includes('? emptyWords({ sure: board.sure, everApplied: board.everApplied, level: board.level, unsavedBumps: board.showSaving ? board.unsavedBumps : 0 })'));
  assert.ok(surf.includes('const belowNote = showHistory ? null : belowWords(below);'));
  assert.ok(surf.includes('{linkBanner && (\n        <div role="alert" style={{'), 'shown on History too: no showHistory test');
  assert.ok(surf.includes("background: linkBanner.tone === 'offline' ? '#B91C1C' : '#F5A524',"));
  assert.ok(surf.includes('font: `800 24px/1.25 ${SANS}`,'));
  assert.ok(surf.includes('{empty.clear && ('), 'the green tick only when the screen is sure');
  assert.ok(surf.includes('{empty.title}</div>'));
  assert.ok(surf.includes('{empty.sub}</div>'));
  assert.equal(surf.includes('>Kitchen clear<'), false, 'never a fixed "Kitchen clear"');
  assert.ok(surf.includes('{savingNote && (\n            <div role="status" style={{'));
  assert.ok(surf.includes('const n = countBelow(tops, bottom);'));
  assert.ok(surf.includes('<div ref={scrollRef} onScroll={measureBelow}'));
  assert.ok(surf.includes('box.scrollTop += Math.round(box.clientHeight * 0.8);'));
  // No `inset` (Chrome 87): the build targets the Chrome 80 WebView on older kitchen tablets.
  assert.equal(/\binset\b/.test(code(surf)), false);
});

test('K1: the card and the pop out say "Bump not saved. Tap to try again."', () => {
  assert.ok(card.includes("import { BUMP_NOT_SAVED } from '../../lib/kds/kdsLinkHealth';"));
  assert.equal(count(card, "view.unsaved === 'bump'"), 2, 'the card and the pop out');
  assert.ok(card.includes('{BUMP_NOT_SAVED}</button>'));
  assert.ok(card.includes('function BumpNotSaved({ big, onRetry }) {'));
  assert.ok(card.includes('onClick={(e) => { e.stopPropagation(); onRetry(); }}'), 'a tap on the strip does not also open the pop out');
  assert.equal(count(card, 'onRetry={() => onBump(view.id)}'), 2, 'the same bump goes again from either place');
});

test('K8: the live channel is made again when it stays unjoined, under a new name', () => {
  assert.ok(surf.includes("const REJOIN_AFTER_MS = 60000;"));
  assert.ok(surf.includes("const CHANNEL_CHECK_MS = 20000;"));
  assert.ok(surf.includes(".channel(`kds-tickets-${locationId}${centreId ? `-${centreId}` : ''}-${joins}`)"));
  assert.ok(surf.includes("if (!channel || channel.state === 'joined') { notJoinedSince = 0; return; }"));
  assert.ok(surf.includes("if (typeof supabase.realtime?.isConnected === 'function' && !supabase.realtime.isConnected()) { notJoinedSince = 0; return; }"), 'the 60 s only count while the socket is connected');
  assert.ok(surf.includes('if (Date.now() - notJoinedSince < REJOIN_AFTER_MS) return;'));
  assert.ok(surf.includes('const old = channel;\n      join();\n      try { supabase.removeChannel(old); } catch { /* already gone */ }'), 'the new channel is made before the old one goes');
  assert.ok(surf.includes('if (alive) eng.liveInsert(payload.new);'));
  assert.ok(surf.includes('if (alive) eng.liveUpdate(payload.new);'));
  assert.ok(surf.includes('if (subscribedOnce) eng.load();'), 'every rejoin reads the list');
});

test('K9: one activity feed event per spell, and unsaved bumps are kept per device across a restart', () => {
  assert.ok(surf.includes("import { logActivity } from '../../lib/activity';"));
  assert.ok(surf.includes("kind: 'system', severity: 'info', title: w.title, body: w.body, refType: 'kds_link', refId: device.id, actorName: device.name,"));
  assert.ok(surf.includes('onSpell: (summary) => { writeTrace(summary, 5); },'));
  assert.ok(surf.includes('const unsavedKey = (deviceId) => `rpos-kds-unsaved-${deviceId || \'screen\'}`;'));
  assert.ok(surf.includes('load: () => { try { return localStorage.getItem(unsavedKey(device.id)); } catch { return null; } },'));
  assert.ok(surf.includes('}, [live, locationId, centreId, device.id, device.name]);'));
});
