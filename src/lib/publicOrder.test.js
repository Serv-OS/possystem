// publicOrder.test.js: database fence stage 1, the customer pages (contract C0 to C14, S1).
//
// The rules under test:
//   - every server call falls back to today's direct write while it does not exist (PGRST202);
//   - money that was taken is never dropped: a refused or failed call is retried or surfaced,
//     a missing proof places the order unpaid (marked), never not at all;
//   - the rows sent are the rows built today (same keys);
//   - the tracker key, the QR join code and the open tab list follow the contract;
//   - the QR floor sync never writes or removes a till's session.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  requestProofWithRetry, buildPlaceOrderArgs, placePublicOrderWithFallback, settleQrTabWithFallback,
  chooseTrackKey, trackLinkParams, normalizeJoinCode, joinCodeReady, tabFromRoundsResult,
  openTabsFromResult, qrSessionWriteAction, UNVERIFIED_MESSAGE,
} from './publicOrder.js';

const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const MISSING = { code: 'PGRST202', message: 'Could not find the function public.place_public_order in the schema cache' };
const noSleep = async () => {};

// ── C0: the proof request ────────────────────────────────────────────────────

test('a proof is returned as soon as the server saw the payment', async () => {
  let n = 0;
  const r = await requestProofWithRetry({
    body: { processor: 'stripe', kind: 'card', payment_ref: 'pi_1' }, sleep: noSleep,
    invoke: async () => { n += 1; return n < 2 ? { status: 409, data: { ok: false, reason: 'not_seen' } } : { status: 200, data: { ok: true, proof_id: 'p1', amount_minor: 1250 } }; },
  });
  assert.deepEqual(r, { proofId: 'p1', amountMinor: 1250 });
  assert.equal(n, 2, 'a lagging processor is asked again');
});

test('FENCE STAGE 1 FALLBACK: a function or table not deployed yet is "unavailable"', async () => {
  const a = await requestProofWithRetry({ body: { processor: 'stripe', kind: 'card', payment_ref: 'x' }, sleep: noSleep, invoke: async () => ({ status: 404, data: {} }) });
  assert.deepEqual(a, { unavailable: true });
  const b = await requestProofWithRetry({ body: { processor: 'stripe', kind: 'card', payment_ref: 'x' }, sleep: noSleep, invoke: async () => ({ status: 200, data: { ok: false, reason: 'unsupported' } }) });
  assert.deepEqual(b, { unavailable: true });
});

test('a refusal that cannot change stops asking; network errors are retried then reported', async () => {
  let n = 0;
  const r = await requestProofWithRetry({ body: { processor: 'stripe', kind: 'card', payment_ref: 'x' }, sleep: noSleep,
    invoke: async () => { n += 1; return { status: 409, data: { ok: false, reason: 'other_venue' } }; } });
  assert.equal(n, 1); assert.equal(r.failed, true); assert.equal(r.reason, 'other_venue');
  let m = 0;
  const net = await requestProofWithRetry({ body: { processor: 'adyen', kind: 'card', payment_ref: 'x' }, sleep: noSleep,
    invoke: async () => { m += 1; throw new Error('Failed to fetch'); } });
  assert.equal(net.failed, true); assert.equal(net.reason, 'network');
  assert.equal(m, 4, 'Adyen (webhook ledger) gets the longer retry plan');
  assert.deepEqual(await requestProofWithRetry({ body: { processor: 'stripe' } }), { failed: true, reason: 'missing' });
});

// ── C1, C8, C11: placing the order ───────────────────────────────────────────

const row = { ref: 'OL-ABC12', location_id: 'L1', type: 'collection', status: 'prep', source: 'online', items: [{ n: 1 }], customer: { name: 'A' }, total: 12.5, paid: true, payment_method: 'card' };
const check = { id: 'chk-1', ref: 'OL-ABC12', total: 12.5, items: [] };

test('the RPC gets the rows exactly as built today', () => {
  const a = buildPlaceOrderArgs({ locationId: 'L1', order: row, check, proofIds: ['p1', null] });
  assert.deepEqual(a, { p_location_id: 'L1', p_order: row, p_check: check, p_proof_ids: ['p1'] });
  assert.equal(a.p_order, row, 'same object, same keys');
  assert.equal(buildPlaceOrderArgs({ locationId: 'L1', order: row }).p_check, null);
});

test('FENCE STAGE 1 FALLBACK: while place_public_order does not exist, today\'s direct insert runs', async () => {
  let legacy = 0;
  const r = await placePublicOrderWithFallback({
    rpc: async () => ({ data: null, error: MISSING }), locationId: 'L1', order: row, check, moneyTaken: true,
    legacyInsert: async () => { legacy += 1; return { ok: true }; }, sleep: noSleep,
  });
  assert.equal(legacy, 1);
  assert.deepEqual({ ok: r.ok, path: r.path, paid: r.paid }, { ok: true, path: 'legacy', paid: true });
});

test('RPC path: paid with proof, track token returned, nothing written directly', async () => {
  const calls = [];
  const r = await placePublicOrderWithFallback({
    rpc: async (name, args) => { calls.push([name, args]); return { data: { ok: true, ref: 'OL-ABC12', paid: true, payment_unverified: false, track_token: 'tok', check_id: 'chk-1', status: 'prep' }, error: null }; },
    locationId: 'L1', order: row, check, proofIds: ['p1'], moneyTaken: true,
    legacyInsert: async () => { throw new Error('must not run'); }, sleep: noSleep,
  });
  assert.equal(calls.length, 1); assert.equal(calls[0][0], 'place_public_order');
  assert.deepEqual(calls[0][1].p_proof_ids, ['p1']);
  assert.equal(r.ok, true); assert.equal(r.path, 'rpc'); assert.equal(r.paid, true); assert.equal(r.unverified, false);
  assert.equal(r.trackToken, 'tok'); assert.equal(r.checkId, 'chk-1');
});

test('no proof: the order is still placed, unpaid and marked unverified (money is never dropped)', async () => {
  const r = await placePublicOrderWithFallback({
    rpc: async () => ({ data: { ok: true, paid: false, payment_unverified: true, track_token: 't2' }, error: null }),
    locationId: 'L1', order: row, check, proofIds: [], moneyTaken: true, sleep: noSleep,
  });
  assert.equal(r.ok, true); assert.equal(r.paid, false); assert.equal(r.unverified, true);
  assert.equal(UNVERIFIED_MESSAGE, 'Your order is in. The venue will confirm your payment.');
});

test('a network error is retried (the RPC is idempotent per session and ref), then surfaced', async () => {
  let n = 0;
  const ok = await placePublicOrderWithFallback({
    rpc: async () => { n += 1; return n < 3 ? { data: null, error: { message: 'Failed to fetch' } } : { data: { ok: true, paid: true, idempotent: true }, error: null }; },
    locationId: 'L1', order: row, sleep: noSleep,
  });
  assert.equal(n, 3); assert.equal(ok.ok, true); assert.equal(ok.idempotent, true);
  const fail = await placePublicOrderWithFallback({ rpc: async () => ({ data: null, error: { message: 'down' } }), locationId: 'L1', order: row, sleep: noSleep });
  assert.equal(fail.ok, false); assert.equal(fail.message, 'down');
});

test('a server refusal is surfaced with its reason, never retried blindly', async () => {
  let n = 0;
  const r = await placePublicOrderWithFallback({
    rpc: async () => { n += 1; return { data: { ok: false, reason: 'tab_not_verified', message: 'We could not confirm the card hold' }, error: null }; },
    locationId: 'L1', order: row, sleep: noSleep,
  });
  assert.equal(n, 1); assert.equal(r.ok, false); assert.equal(r.reason, 'tab_not_verified');
});

test('proof function not deployed yet but money taken: today\'s path first, the RPC only if it is refused', async () => {
  const calls = [];
  const kept = await placePublicOrderWithFallback({
    rpc: async (n) => { calls.push(n); return { data: { ok: true }, error: null }; },
    locationId: 'L1', order: row, check, proofUnavailable: true, moneyTaken: true,
    legacyInsert: async () => ({ ok: true }), sleep: noSleep,
  });
  assert.equal(kept.path, 'legacy'); assert.equal(kept.paid, true); assert.deepEqual(calls, []);
  const refused = await placePublicOrderWithFallback({
    rpc: async (n) => { calls.push(n); return { data: { ok: true, paid: false, payment_unverified: true }, error: null }; },
    locationId: 'L1', order: row, check, proofUnavailable: true, moneyTaken: true,
    legacyInsert: async () => ({ ok: false, error: { code: '42501', message: 'new row violates row-level security policy' } }), sleep: noSleep,
  });
  assert.equal(refused.path, 'rpc'); assert.equal(refused.ok, true); assert.equal(refused.unverified, true);
  const broken = await placePublicOrderWithFallback({
    rpc: async () => ({ data: { ok: true }, error: null }), locationId: 'L1', order: row, check, proofUnavailable: true, moneyTaken: true,
    legacyInsert: async () => ({ ok: false, error: { message: 'duplicate key' } }), sleep: noSleep,
  });
  assert.equal(broken.ok, false); assert.equal(broken.path, 'legacy', 'a real insert error is surfaced, not hidden');
});

// ── C10: settle ──────────────────────────────────────────────────────────────

test('settle: fallback, success, and not_captured asked again', async () => {
  let legacy = 0;
  const f = await settleQrTabWithFallback({ rpc: async () => ({ data: null, error: MISSING }), locationId: 'L1', paymentIntentId: 'pi', legacySettle: async () => { legacy += 1; return { ok: true }; }, sleep: noSleep });
  assert.deepEqual({ ok: f.ok, path: f.path }, { ok: true, path: 'legacy' }); assert.equal(legacy, 1);
  let n = 0;
  const s = await settleQrTabWithFallback({
    rpc: async (name, args) => { n += 1; assert.equal(name, 'settle_qr_tab'); assert.deepEqual(args.p_proof_ids, ['ov1']);
      return n < 2 ? { data: { ok: false, reason: 'not_captured' }, error: null } : { data: { ok: true, closed: 2, booked: 40, shortfall: 5 }, error: null }; },
    locationId: 'L1', paymentIntentId: 'pi', proofIds: ['ov1', null], sleep: noSleep,
  });
  assert.equal(n, 2); assert.deepEqual({ ok: s.ok, closed: s.closed, booked: s.booked, shortfall: s.shortfall }, { ok: true, closed: 2, booked: 40, shortfall: 5 });
  const already = await settleQrTabWithFallback({ rpc: async () => ({ data: { ok: true, closed: 0, reason: 'already_closed' }, error: null }), locationId: 'L1', paymentIntentId: 'pi', sleep: noSleep });
  assert.equal(already.ok, true); assert.equal(already.alreadyClosed, true);
});

// ── C3: tracker key ──────────────────────────────────────────────────────────

test('tracker key: token, else the QR card payment id, else the last 4 digits', () => {
  assert.equal(chooseTrackKey({ trackToken: 'tok', paymentIntentId: 'pi', phone: '07700 900123' }), 'tok');
  assert.equal(chooseTrackKey({ paymentIntentId: 'pi_9', phone: '07700 900123' }), 'pi_9');
  assert.equal(chooseTrackKey({ phone: '+44 7700 900123' }), '0123');
  assert.equal(chooseTrackKey({ phone: '12' }), null);
  assert.equal(chooseTrackKey({}), null);
  assert.equal(trackLinkParams({ ref: 'OL-1', trackToken: 'abc' }), 'track=OL-1&t=abc');
  assert.equal(trackLinkParams({ ref: 'OL-1', phone: '07700900123' }), 'track=OL-1&p=0123');
});

test('the tracker reads order_track_row and no longer listens to every order of the venue', () => {
  const src = read('../surfaces/online/OrderTracker.jsx');
  assert.ok(src.includes("publicRead('order_track_row',"));
  assert.ok(!src.includes('postgres_changes'), 'the realtime channel on order_queue is gone');
  assert.ok(src.includes("if (token) u.searchParams.set('t', token);") && src.includes("if (p4) u.searchParams.set('p', p4);"));
});

// ── C4, C5, C6: QR tabs ──────────────────────────────────────────────────────

test('open tabs at a table carry handles only', () => {
  const rows = openTabsFromResult([{ tab_handle: 'h1', tab_ref: 'QR-1', table_label: '4.1', opened_at: 't', processor: 'stripe', total: '23.5', rounds: '2', has_join_code: true, payment_intent_id: 'pi_leak', tab_join_code: '123456' }]);
  assert.deepEqual(rows, [{ tab_handle: 'h1', tab_ref: 'QR-1', table_label: '4.1', opened_at: 't', processor: 'stripe', total: 23.5, rounds: 2, has_join_code: true }]);
  assert.ok(!('payment_intent_id' in rows[0]) && !('tab_join_code' in rows[0]), 'nothing a stranger could use');
  assert.deepEqual(openTabsFromResult(null), []);
});

test('qr_tab_rounds answers become the tab object the QR screens use', () => {
  const t = tabFromRoundsResult({ tab: { payment_intent_id: 'pi', tab_ref: 'QR-1', processor: 'ryft' }, rounds: [{ ref: 'a', total: 10, items: [1] }, { ref: 'b', total: '5.5', items: [2, 3] }] });
  assert.equal(t.payment_intent_id, 'pi'); assert.equal(t.total, 15.5); assert.deepEqual(t.items, [1, 2, 3]); assert.equal(t.rounds.length, 2);
  assert.equal(tabFromRoundsResult(null), null);
  assert.equal(tabFromRoundsResult({ rounds: [] }), null);
});

test('table codes are digits; old 4 digit codes still work', () => {
  assert.equal(normalizeJoinCode(' 12-34 56 7'), '123456');
  assert.equal(joinCodeReady('123'), false);
  assert.equal(joinCodeReady('1234'), true);
  assert.equal(joinCodeReady('123456'), true);
});

test('joining a tab is checked on the server when the list carries handles', () => {
  const src = read('../surfaces/online/OnlineSurface.jsx');
  assert.ok(src.includes("const { data, error } = await supabase.rpc('qr_tab_join', {"));
  assert.ok(src.includes("stashed.tab_ref && stashed.tab_ref === tab.tab_ref"), 'the opener is matched on tab_ref');
  assert.ok(src.includes("publicRead('qr_table_open_tabs',") && src.includes("publicRead('qr_tab_rounds',"));
  const join = read('../surfaces/qr/JoinTabScreen.jsx');
  assert.ok(join.includes('res = await onJoin(normalizeJoinCode(code));'), 'the gate awaits the server');
});

// ── S1: the QR floor sync never touches a till's session ─────────────────────

test('QR floor sync writes or removes only a session QR made', () => {
  assert.equal(qrSessionWriteAction({ existing: null, hasItems: true }), 'insert');
  assert.equal(qrSessionWriteAction({ existing: { session: { source: 'qr' } }, hasItems: true }), 'update_qr');
  assert.equal(qrSessionWriteAction({ existing: { session: { items: [1] } }, hasItems: true }), 'skip', "a till's session is never overwritten");
  assert.equal(qrSessionWriteAction({ existing: { session: { source: 'qr' } }, hasItems: false }), 'delete_qr');
  assert.equal(qrSessionWriteAction({ existing: { session: { items: [1] } }, hasItems: false }), 'skip', "a till's session is never removed");
  assert.equal(qrSessionWriteAction({ existing: null, hasItems: false }), 'skip');
  const src = read('./qrTableSession.js');
  assert.ok(!src.includes('.upsert('), 'no blind upsert');
  assert.equal((src.match(/\.filter\('session->>source', 'eq', 'qr'\)/g) || []).length, 2, 'update and delete are conditional in the database too');
  assert.ok(src.includes("if (exErr) { console.warn('[syncQrTableSession] session read failed, not writing:'"), 'a failed read writes nothing');
});

// ── Customer pages write only through the server (or the marked fallback) ───

test('every remaining direct write on a customer page is inside a FENCE STAGE 1 FALLBACK', () => {
  const files = ['../surfaces/online/OnlineCheckout.jsx', '../surfaces/qr/QrCheckout.jsx', '../surfaces/qr/TabResumeScreen.jsx', '../surfaces/catering/CateringCheckout.jsx'];
  for (const f of files) {
    const src = read(f);
    const re = /supabase\.from\('(order_queue|closed_checks)'\)\s*\.(insert|update|upsert)\(/g;
    let m; let n = 0;
    while ((m = re.exec(src))) {
      n += 1;
      const before = src.slice(Math.max(0, m.index - 1400), m.index);
      assert.ok(/FENCE STAGE 1 FALLBACK/.test(before) && /legacy(Insert|Settle)/.test(before), `${f}: a direct ${m[1]} write outside the marked fallback`);
    }
    assert.ok(n > 0, `${f} keeps today's path as the fallback`);
  }
  const oc = read('../surfaces/online/OnlineCheckout.jsx');
  assert.equal((oc.match(/await placePublicOrder\(\{/g) || []).length, 2, 'both online paths (card, gift only) place through the server');
  assert.equal((oc.match(/trackToken: placed\.trackToken/g) || []).length, 2, 'both pass the track token up (gap B12)');
  const qc = read('../surfaces/qr/QrCheckout.jsx');
  assert.ok(qc.includes("kind: tabMode ? 'preauth' : 'card'"), 'a tab needs a hold proof, pay now a card proof');
  assert.ok(qc.includes("placed.reason === 'tab_not_verified' && tabPi"), 'an old tab asks for its hold proof once');
  assert.ok(read('../surfaces/qr/TabResumeScreen.jsx').includes("kind: 'capture', paymentRef: tab.payment_intent_id"));
  assert.ok(read('../surfaces/catering/CateringSurface.jsx').includes("publicRead('catering_day_load',"));
});

test('C12: the busy time no longer reads tables, tabs and orders from a customer browser', () => {
  const src = read('./prepTime.js');
  const fn = src.slice(src.indexOf('export async function liveOrderCount('), src.indexOf('export function kitchenLoadFromStore('));
  assert.ok(fn.includes("supabase.rpc('online_kitchen_load'"));
  for (const t of ['active_sessions', 'bar_tabs', 'order_queue', 'floor_tables']) assert.ok(!fn.includes(`from('${t}')`), `no direct read of ${t}`);
});
