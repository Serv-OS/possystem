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
  onlineChargedTotalMinor, buildDeclaredDiscounts, loyaltyProofKey, withinMs, publicOrderRefusalMessage,
  tabRoundJoinCode, mergeResumeTab, verifyPaymentInBackground, VERIFY_DELAYS_MS, trackerPaymentChecking,
  qrRowOnFloor, tabHoldFor, tabCloseRefusalMessage, mergeTrackerRow,
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
  assert.equal(UNVERIFIED_MESSAGE, 'Your order is in. The venue is confirming your payment.');
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
  // Fix round 2: the update and delete go through mustChangeRow (rows counted, never kept for a
  // late replay: parkable false); their match still carries session->>source = 'qr'.
  assert.equal((src.match(/match: \{ location_id: locationId, table_id: floorId, 'session->>source': 'qr' \}/g) || []).length, 2, 'update and delete are conditional in the database too');
  assert.equal((src.match(/parkable: false/g) || []).length, 2, 'a floor summary is never replayed late');
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

// ── Fix round (19 Sep 2026), docs/FENCE_STAGE_1_APP.md section 11 ──────────────

test('C15: the online total is what the customer is charged across card and gift card', () => {
  // A 30.00 bill, 2.00 auto offer already net, 5.00 promo, 3.00 reward, 10.00 on a gift card:
  // the card pays 30 - 2 - 5 - 3 - 10 = 10.00, the order total is 10 + 10 = 20.00.
  assert.equal(onlineChargedTotalMinor({ remainingMinor: 1000, giftAppliedMinor: 1000 }), 2000);
  assert.equal(onlineChargedTotalMinor({ remainingMinor: 0, giftAppliedMinor: 2350 }), 2350, 'gift only');
  assert.equal(onlineChargedTotalMinor({ remainingMinor: 1234 }), 1234, 'card only');
  assert.equal(onlineChargedTotalMinor({ remainingMinor: -5, giftAppliedMinor: 'x' }), 0);
});

test('C15: the order declares its discounts in pence (auto, promo, loyalty)', () => {
  const d = buildDeclaredDiscounts({
    autoDiscounts: [{ label: '2 for 1 cookies', value: 2 }, { label: 'zero', value: 0 }],
    promo: { code: 'SUMMER5', amountMinor: 500 },
    reward: { name: 'Free coffee', amountMinor: 300 },
  });
  assert.deepEqual(d, [
    { type: 'auto', label: '2 for 1 cookies', amount_minor: 200 },
    { type: 'promo', label: 'SUMMER5', amount_minor: 500 },
    { type: 'loyalty', label: 'Free coffee', amount_minor: 300 },
  ]);
  assert.deepEqual(buildDeclaredDiscounts({}), []);
});

test('C15: the server sees an honest order as paid (the rule, mirrored)', () => {
  // place_public_order: due = max(order total, check total, goods - declared discounts - slack);
  // paid = card + gift proofs >= due. Goods 30.00, auto 2, promo 5, reward 3 (proven), gift 10.
  const items = [{ price: 10, qty: 3, mods: [] }];
  const goods = items.reduce((s, it) => s + Math.round(it.price * it.qty * 100), 0);
  const declared = buildDeclaredDiscounts({ autoDiscounts: [{ value: 2 }], promo: { code: 'P', amountMinor: 500 }, reward: { name: 'R', amountMinor: 300 } });
  const floor = Math.max(0, goods - declared.reduce((s, x) => s + x.amount_minor, 0) - (items.length + 2));
  const total = onlineChargedTotalMinor({ remainingMinor: 1000, giftAppliedMinor: 1000 });
  const checkTotal = 1000;   // the check books the card amount (net of gift)
  const due = Math.max(total, checkTotal, floor);
  assert.equal(due, 2000);
  assert.ok(1000 /* card */ + 1000 /* gift */ >= due, 'card plus gift proofs cover it: paid, not "checking"');
  // Before the fix round the total was the gross 28.00 and nothing was declared: never paid.
  assert.ok(1000 + 1000 < Math.max(2800, goods - (items.length + 2)));
});

test('C15: the loyalty proof key is the one loyalty-redeem writes', () => {
  assert.equal(loyaltyProofKey({ reward_id: 'r1' }, 'chk-OL-1-x'), 'redeem:chk-OL-1-x:r1');
  assert.equal(loyaltyProofKey({ stamp_program_id: 's1' }, 'chk-OL-1-x'), 'stampredeem:chk-OL-1-x:s1');
  assert.equal(loyaltyProofKey({ idempotency_key: 'k9', reward_id: 'r1' }, 'c'), 'k9');
  assert.equal(loyaltyProofKey(null, 'c'), null);
});

test('C15: a slow reward redeem never holds a paid order back', async () => {
  const fast = await withinMs(Promise.resolve('done'), 7000, async () => new Promise(() => {}));
  assert.equal(fast, 'done');
  const slow = await withinMs(new Promise(() => {}), 7000, async () => {});
  assert.equal(slow, null, 'placed anyway, it arrives "Payment being checked"');
  const failed = await withinMs(Promise.reject(new Error('x')), 7000, async () => new Promise(() => {}));
  assert.equal(failed, null);
});

test('C15: both online paths send the charged total, the declared discounts and all proofs', () => {
  const oc = read('../surfaces/online/OnlineCheckout.jsx');
  assert.equal((oc.match(/total: chargedTotal\(\),/g) || []).length, 2, 'card path and gift only path');
  // fix round 7: menu_id rides on the RPC payload only (order_queue has no such column, and
  // the legacy insert writes queueRow itself).
  assert.equal((oc.match(/order: \{ \.\.\.queueRow, menu_id: menuId \|\| null, discounts: declaredDiscounts\(\) \}/g) || []).length, 2);
  assert.ok(oc.includes('proofIds: [...(proof.proofId ? [proof.proofId] : []), ...giftProofIds, ...rewardProofIds],'), 'the card path sends card, gift and loyalty proofs');
  const card = oc.slice(oc.indexOf('const onPaymentSuccess = async'), oc.indexOf('const placed = await placePublicOrder({', oc.indexOf('const onPaymentSuccess = async')));
  assert.ok(card.includes("processor: 'gift', kind: 'gift', paymentRef: giftCommit.idempotency_key"), 'the gift proof after commitGift');
  assert.ok(card.includes('await redeemLoyaltyBeforePlacing()'), 'the reward is redeemed BEFORE placing');
  // The legacy insert writes queueRow itself: order_queue has no discounts column.
  assert.ok(oc.includes("const { error: insErr } = await supabase.from('order_queue').insert(queueRow);"));
});

test('C16: a round carries the table code only when this phone really holds it', () => {
  assert.equal(tabRoundJoinCode({ tab_join_code: '123456' }), '123456');
  assert.equal(tabRoundJoinCode({ rounds: [{ customer: { tab_join_code: '4321' } }] }), '4321', 'an old 4 digit tab');
  assert.equal(tabRoundJoinCode({ tab_join_code: null, rounds: [{ customer: {} }] }), null, 'never a code made up here (it would count towards the lock)');
  assert.equal(tabRoundJoinCode(null), null);
  const qc = read('../surfaces/qr/QrCheckout.jsx');
  assert.ok(qc.includes('const roundCode = tabRoundJoinCode(existingTab);'));
  assert.ok(qc.includes("order: { ...queueRow, menu_id: menuId || null, customer: roundCustomerForServer, ...(roundCode ? { tab_join_code: roundCode } : {}) },"), 'p_order.tab_join_code');
  assert.ok(qc.includes("throw new Error(publicOrderRefusalMessage(placed, placed.message || 'Could not add to tab.'));"));
});

test('C16: the resume screen keeps the stash code when the server does not return it', () => {
  const stashed = { tab_ref: 'QR-1', payment_intent_id: 'pi_1', tab_join_code: '654321', joined: true };
  const m = mergeResumeTab(stashed, { tab_ref: 'QR-1', payment_intent_id: 'pi_1', tab_join_code: null, has_join_code: true, table_label: '4.1' });
  assert.equal(m.tab_join_code, '654321');
  assert.equal(m.table_label, '4.1');
  assert.equal(m.joined, true);
  assert.equal(mergeResumeTab(stashed, { tab_join_code: '111222' }).tab_join_code, '111222', 'the server code wins when it sends one');
  const os = read('../surfaces/online/OnlineSurface.jsx');
  assert.ok(os.includes('setResumeTab(mergeResumeTab(stashed, rr.data.tab));'));
  const join = os.indexOf("await supabase.rpc('qr_tab_join', {");
  assert.ok(join > 0 && os.slice(join - 300, join).includes('await ensureCustomerSession();'), 'a session BEFORE joining, so the server remembers the member');
});

test('C16, C19: refusals the customer can act on are shown in plain words', () => {
  assert.equal(publicOrderRefusalMessage({ reason: 'tab_not_yours' }, 'x'), 'Ask the person who opened this tab for the table code.');
  assert.match(publicOrderRefusalMessage({ reason: 'locked' }, 'x'), /Too many wrong codes/);
  assert.equal(publicOrderRefusalMessage({ reason: 'payment' }, 'x'), 'Please pay for your order to send it.');
  assert.equal(publicOrderRefusalMessage({ reason: 'payment', message: 'Server words.' }, 'x'), 'Server words.');
  assert.equal(publicOrderRefusalMessage({ reason: 'error' }, 'fallback'), 'fallback');
  assert.equal(publicOrderRefusalMessage(null, 'fallback'), 'fallback');
});

test('C17: an unproven payment is checked again in the background, then verified', async () => {
  const calls = [];
  let n = 0;
  const r = await verifyPaymentInBackground({
    reprove: [{ processor: 'stripe', kind: 'card', paymentRef: 'pi_1' }], proofIds: ['g1'], sleep: async () => {},
    requestProof: async (req) => { calls.push(['proof', req.paymentRef]); n += 1; return n < 2 ? { failed: true } : { proofId: 'c1' }; },
    verify: async (ids) => { calls.push(['verify', ids]); return ids.includes('c1') ? { data: { ok: true, paid: true, check_id: 'chk-9' } } : { data: { ok: true, paid: false } }; },
  });
  assert.deepEqual(r, { verified: true, checkId: 'chk-9' });
  assert.deepEqual(calls, [['proof', 'pi_1'], ['verify', ['g1']], ['proof', 'pi_1'], ['verify', ['g1', 'c1']]]);
});

test('C17: it stops on an answer that cannot change, and gives up after about 3 minutes', async () => {
  const total = VERIFY_DELAYS_MS.reduce((a, b) => a + b, 0);
  assert.ok(total >= 150000 && total <= 240000, `about 3 minutes (${total} ms)`);
  const stop = await verifyPaymentInBackground({ sleep: async () => {}, verify: async () => ({ data: { ok: false, reason: 'no_check' } }) });
  assert.deepEqual(stop, { verified: false, reason: 'no_check' });
  const missing = await verifyPaymentInBackground({ sleep: async () => {}, verify: async () => ({ error: { code: 'PGRST202' } }) });
  assert.equal(missing.reason, 'unsupported');
  let tries = 0;
  const timeout = await verifyPaymentInBackground({ sleep: async () => {}, verify: async () => { tries += 1; return tries % 2 ? { error: { message: 'Failed to fetch' } } : { data: { ok: true, paid: false } }; } });
  assert.deepEqual(timeout, { verified: false, reason: 'timeout' });
  assert.equal(tries, VERIFY_DELAYS_MS.length, 'a network error is tried again at the next step');
});

test('C17: the customer is told the venue is confirming the payment, never to pay again', () => {
  assert.equal(UNVERIFIED_MESSAGE, 'Your order is in. The venue is confirming your payment.');
  assert.ok(!/pay again|try again|retry/i.test(UNVERIFIED_MESSAGE));
  assert.equal(trackerPaymentChecking({ paid: false, payment_state: 'checking' }), true, 'order_track_row');
  assert.equal(trackerPaymentChecking({ customer: { payment_state: 'checking' } }), true, 'the old direct read');
  assert.equal(trackerPaymentChecking({ paid: true, payment_state: 'checking' }), false, 'paid wins');
  assert.equal(trackerPaymentChecking({ paid: false, payment_state: 'verified' }), false);
  const tr = read('../surfaces/online/OrderTracker.jsx');
  // v5.9.26: the answer is merged first (a collected order answers thin), so the
  // comparison is against the MERGED row. Same guard, one name along.
  assert.ok(tr.includes('trackerPaymentChecking(prev) === trackerPaymentChecking(next)'), 'a change of payment state re-renders');
  assert.ok(tr.includes('const next = mergeTrackerRow(prev, data);'), 'and it is the merged row that is compared');
  assert.ok(tr.includes('{UNVERIFIED_MESSAGE} You do not need to pay again.'));
  const client = read('./publicOrderClient.js');
  assert.ok(client.includes("if (placed && placed.ok && placed.unverified && placed.path === 'rpc' && order && order.ref) {"));
  assert.ok(client.includes("supabase.rpc('verify_public_order_payment', { p_location_id: String(opsLocationId), p_ref: String(ref), p_proof_ids: ids })"));
  for (const f of ['../surfaces/qr/QrCheckout.jsx', '../surfaces/catering/CateringCheckout.jsx']) {
    assert.ok(read(f).includes("[{ processor, kind: 'card', paymentRef: payId }]"), `${f} checks its card payment again`);
  }
  assert.ok(read('../surfaces/online/OnlineSurface.jsx').includes("window.addEventListener('rpos-public-payment-verified', onVerified);"));
});

// ── Fix round 2 (19 Sep 2026) ───────────────────────────────────────────────────

test('LOW: the phone\'s floor sync never puts an order whose payment is being checked on the floor plan', () => {
  // Same rule as the order_queue_qr_floor trigger of 20260919b: paid, or a round of an open tab.
  assert.equal(qrRowOnFloor({ paid: true, customer: {} }), true);
  assert.equal(qrRowOnFloor({ paid: false, customer: { tab_open: true } }), true, 'a round of an open tab');
  assert.equal(qrRowOnFloor({ paid: false, customer: { tab_open: 'true' } }), true, 'the server\'s own boolean reading');
  assert.equal(qrRowOnFloor({ paid: false, customer: { payment_state: 'checking', payment_unverified: true } }), false);
  assert.equal(qrRowOnFloor({ paid: false, customer: { payment_state: 'short', payment_unverified: true } }), false);
  assert.equal(qrRowOnFloor({ paid: false, customer: { payment_unverified: true } }), false);
  assert.equal(qrRowOnFloor({ customer: { paid: true } }), true, 'an order the old direct insert wrote (before 20260919a2)');
  assert.equal(qrRowOnFloor(null), false);
  const src = read('./qrTableSession.js');
  assert.ok(src.includes(".select('ref, items, customer, total, sent_at, paid')"), 'the paid column is read');
  assert.ok(src.includes('const rows = (allRows || []).filter(qrRowOnFloor);'), 'and the rule applied before anything is written');
});

test('C21: "short" reads as being checked for the customer, never "pay again"', () => {
  assert.equal(trackerPaymentChecking({ paid: false, payment_state: 'short' }), true);
  assert.equal(trackerPaymentChecking({ customer: { payment_state: 'short' } }), true);
  assert.equal(trackerPaymentChecking({ paid: true, payment_state: 'short' }), false);
});

test('C22: a new QR tab holds at least its first round; a round past the hold is explained', () => {
  assert.equal(tabHoldFor({ configured: 0, minimum: 25, firstRound: 12.5 }), 25);
  assert.equal(tabHoldFor({ configured: 50, minimum: 25, firstRound: 12.5 }), 50);
  assert.equal(tabHoldFor({ configured: 50, minimum: 25, firstRound: 62.4 }), 63, 'whole units, rounded up');
  assert.equal(tabHoldFor({ configured: 30, minimum: 25, firstRound: 30 }), 30);
  assert.equal(tabHoldFor({ configured: 'x', minimum: 25, firstRound: -4 }), 25);
  assert.match(publicOrderRefusalMessage({ reason: 'over_hold' }, 'fallback'), /past its card hold/);
  assert.equal(publicOrderRefusalMessage({ reason: 'over_hold', message: 'Server words.' }, 'fallback'), 'Server words.');
  const qr = read('../surfaces/qr/QrCheckout.jsx');
  assert.ok(qr.includes('const tabPreAuthAmount = tabHoldFor({ configured: configuredPreAuth, minimum: MIN_PRE_AUTH, firstRound: total });'));
  assert.ok(qr.indexOf('const tabPreAuthAmount = ') > qr.indexOf('const total = useMemo('), 'worked out once the round total is known');
  assert.ok(qr.includes('? Math.round(tabPreAuthAmount * 100)'), 'the Stripe hold is that amount');
});

test('C23: closing a tab from the phone: short and not yours in plain words, the card is never charged again', async () => {
  const short = await settleQrTabWithFallback({
    rpc: async () => ({ data: { ok: false, reason: 'short', paid_minor: 5000, due_minor: 6200, message: 'Your card paid part of this tab. A member of staff will settle the rest with you.' }, error: null }),
    locationId: 'L1', paymentIntentId: 'pi', sleep: noSleep,
  });
  assert.equal(short.ok, false);
  assert.equal(short.reason, 'short');
  assert.equal(short.paidMinor, 5000);
  assert.equal(short.dueMinor, 6200);
  assert.equal(tabCloseRefusalMessage(short), 'Your card paid part of this tab. A member of staff will settle the rest with you.');
  assert.match(tabCloseRefusalMessage({ reason: 'not_yours' }, { tabRef: 'QR-1' }), /Only the phone that opened this tab, or one that joined it with the table code, can close it here/);
  assert.match(tabCloseRefusalMessage({ reason: 'not_yours' }, { tabRef: 'QR-1' }), /\(QR-1\)\.$/);
  assert.match(tabCloseRefusalMessage({ reason: 'error' }, { tabRef: 'QR-1' }), /^We charged your card\. The venue will close your tab on the till/);
  for (const r of ['short', 'not_yours', 'error', 'not_captured']) assert.doesNotMatch(tabCloseRefusalMessage({ reason: r }), /pay again|try again to pay/i);
  const tr = read('../surfaces/qr/TabResumeScreen.jsx');
  assert.ok(tr.includes("setError(tabCloseRefusalMessage(settled, { tabRef: tab.tab_ref || '' }));"));
  assert.ok(tr.indexOf('clearStashedTab(slug, tableId);') < tr.indexOf('setError(tabCloseRefusalMessage('), 'the stash goes first, so a second tap never captures again');
});

// ── the customer's page must reach "Collected" (21 Sep 2026, live) ─────────────────────────
// Peter marked OL-909CZ collected in Orders Hub and the customer's page stayed on "Ready".
// Marking an order collected REMOVES it from order_queue, which is what the tracker reads, so
// there was nothing left to read and the page held its last state for ever. 20260921t answers
// from order_status_marks instead, deliberately thin (the items and the total went with the
// queue row), and only for an order that departed FROM ready or collected: telling somebody
// their CANCELLED order was handed over would be worse than telling them nothing.

test('a collected order finishes the journey without blanking the page', () => {
  const onScreen = {
    ref: 'OL-909CZ', status: 'ready', total: 4.5, type: 'collection',
    items: [{ name: 'Flat White', qty: 1 }], customer: { phone: '1234' },
  };
  const fromTheMark = { ref: 'OL-909CZ', status: 'collected', type: 'collection', source: 'online', departed: true };
  const after = mergeTrackerRow(onScreen, fromTheMark);
  assert.equal(after.status, 'collected', 'the last step lights up');
  assert.equal(after.total, 4.5, 'the customer keeps their total');
  assert.deepEqual(after.items, onScreen.items, 'and their order summary');
  assert.deepEqual(after.customer, onScreen.customer);
});

test('a normal answer still replaces, so nothing stale survives', () => {
  const onScreen = { ref: 'OL-1', status: 'prep', total: 9, items: [{ name: 'Bun' }, { name: 'Fries' }] };
  // the venue took a line off the order: the new row is the whole truth
  const fresh = { ref: 'OL-1', status: 'prep', total: 5, items: [{ name: 'Bun' }] };
  assert.deepEqual(mergeTrackerRow(onScreen, fresh), fresh);
  assert.equal(mergeTrackerRow(onScreen, fresh).items.length, 1);
});

test('nothing to merge is never a reason to lose the page', () => {
  const onScreen = { ref: 'OL-1', status: 'ready' };
  assert.equal(mergeTrackerRow(onScreen, null), onScreen, 'a null answer keeps the last good state');
  assert.equal(mergeTrackerRow(null, null), null);
  assert.deepEqual(mergeTrackerRow(null, { ref: 'OL-1', status: 'received' }), { ref: 'OL-1', status: 'received' });
});

test('the SQL only says collected for an order that was ready to collect', () => {
  const sql = read('../../supabase/migrations/20260921t_OPS_order_track_collected.sql');
  assert.match(sql, /if coalesce\(v_mark\.departed_from, ''\) not in \('ready', 'collected'\) then\s*\n\s*return null;/,
    'a cancelled order is never reported as handed over');
  // the token must work after the order leaves the queue, or the customer is locked
  // out of their own order the moment it is collected
  const ok = sql.slice(sql.indexOf('create or replace function public._order_track_ok'), sql.indexOf('create or replace function public.order_track_row'));
  const tokenAt = ok.indexOf('public.public_order_tokens t');
  const queueAt = ok.indexOf('select * into v_q from public.order_queue');
  assert.ok(tokenAt > 0 && tokenAt < queueAt, 'the token is checked BEFORE the queue row is needed');
  // the private helper stays private
  assert.match(sql, /revoke all on function public\._order_track_ok\(text, text, text\) from public, anon, authenticated;/);
  assert.match(sql, /grant execute on function public\.order_track_row\(text, text, text\) to anon, authenticated, service_role;/);
  assert.match(sql, /Self test: the wrong key was accepted/);
});
