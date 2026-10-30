/**
 * readerLockReplay.test.js (13 Oct 2026): THE CARD READER FUNCTIONS ARE RUN, NOT ONLY READ.
 *
 * Every other test of the edge functions matches their text, because they are Deno and cannot be
 * imported under `npm test`. A review of the reader lock fix made 81 small breaks in a copy of it
 * and 11 survived every test: the timer could be switched off and all 6,112 tests still passed.
 * So this file bundles the two real functions (adyen-terminal-charge and terminal-job-create,
 * with the rolldown that vite already brings), points their supabase-js import at an in memory
 * database (edgeFnMockDb.js), and replays real card reader timelines against them with a frozen
 * clock and a scripted Adyen.
 *
 * IT CAN NOT REACH A REAL HOST. fetch is replaced outright and refuses anything it does not
 * script. No payment, no status ask and no database call ever leaves this process.
 *
 * What the replays protect (Peter's bar for the card path, 9 Sep 2026): nothing like a stranded
 * live job again; a customer is never charged twice; a till is never left unable to take a card
 * when the reader is fine. Every replay also checks: at most ONE payment request per job ever
 * goes to Adyen, every ask a function sends to itself is a conservative status ask, no call ends
 * as an HTTP 500, nothing ever puts a job back to "not sent yet", and a note is written once.
 *
 * Set READER_LOCK_REPLAY_VERBOSE=1 to print each timeline.
 */

import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setImmediate } from 'node:timers';

import { dbs, rpcs, writes, users, resetDb } from './edgeFnMockDb.js';
import { busyClearsAtMs } from '../../../supabase/functions/_shared/readerLock.js';

const VERBOSE = process.env.READER_LOCK_REPLAY_VERBOSE === '1';
const NO_DASH = /[–—]| - /;

// ── load the two real functions ──────────────────────────────────────────────

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const MOCK_DB_URL = new URL('./edgeFnMockDb.js', import.meta.url).href;
const SERVICE = 'replay-service-role';
const OPS_URL = 'http://ops.mock.invalid';
const CHARGE_URL = `${OPS_URL}/functions/v1/adyen-terminal-charge`;
const ENV = {
  SUPABASE_URL: OPS_URL, SUPABASE_SERVICE_ROLE_KEY: SERVICE,
  PLATFORM_SUPABASE_URL: 'http://platform.mock.invalid', PLATFORM_SUPABASE_SERVICE_ROLE_KEY: 'replay-platform',
  ADYEN_API_KEY: 'replay-not-a-real-key', ADYEN_ENV: 'test',
};

let served = null;
const background = [];
globalThis.Deno = { env: { get: (k) => ENV[k] }, serve: (h) => { served = h; } };
globalThis.EdgeRuntime = { waitUntil: (p) => { background.push(p); } };

// THE ONE REAL WAIT ON THIS PATH IS TAKEN OUT. A note's id is a SHA-256 of its key
// (activityIdFor), and crypto.subtle.digest does that work on another thread and answers in its
// own real time. The replay clock is frozen and stepped by hand, so that one real wait raced it:
// on a busy runner the note landed seconds "late", or after the replay had ended and inside the
// next one (the first run of this file on GitHub failed two tests exactly that way). Here the
// same hash is worked out at once, so every step of a replay happens on the stepped clock.
mock.method(globalThis.crypto.subtle, 'digest', async (algorithm, data) => {
  const name = typeof algorithm === 'string' ? algorithm : algorithm?.name;
  assert.equal(name, 'SHA-256', 'the replay only knows the one hash the card path uses');
  const out = createHash('sha256').update(new Uint8Array(data.buffer ?? data, data.byteOffset ?? 0, data.byteLength)).digest();
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
});

const require = createRequire(import.meta.url);
const { build } = await import(pathToFileURL(createRequire(require.resolve('vite/package.json')).resolve('rolldown')).href);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'servos-reader-replay-'));
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

async function loadFunction(name) {
  const file = path.join(tmp, `${name}.bundle.mjs`);
  await build({ cwd: ROOT, input: path.join(ROOT, 'supabase/functions', name, 'index.ts'), external: [/^https:\/\//], output: { file, format: 'esm' }, logLevel: 'warn' });
  const src = fs.readFileSync(file, 'utf8');
  const swapped = src.replace(/["']https:\/\/esm\.sh\/@supabase\/supabase-js@2["']/g, JSON.stringify(MOCK_DB_URL));
  assert.notEqual(swapped, src, `${name}: the supabase-js import was not found in the bundle`);
  assert.ok(!/from\s+["']https:\/\//.test(swapped), `${name}: a remote import is left in the bundle`);
  fs.writeFileSync(file, swapped);
  served = null;
  await import(pathToFileURL(file).href);
  assert.equal(typeof served, 'function', `${name}: the function did not call Deno.serve`);
  return served;
}

// ── the scripted world ───────────────────────────────────────────────────────

const LOC = '5435c88e-6a58-4ebf-b2a0-b5ed5c9bdaa9';
const JOB = 'df9c6528-1111-4222-8333-444444444444';
const JOB2 = 'aaaaaaaa-2222-4333-8444-555555555555';
const TILL_TOKEN = 'replay-till-session';
const MANAGER_TOKEN = 'replay-manager-session';
const MANAGER_UID = 'user-manager-1';
const iso = (ms) => new Date(ms).toISOString();
const hhmmss = (ms) => new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Europe/London' }).format(new Date(ms));

let scenario = null;   // { adyen }
let sentAt = 0;
const adyenCalls = []; const selfAsks = []; const logs = []; const answers = [];
const since = () => Math.round((Date.now() - sentAt) / 100) / 10;

const realLog = console.log.bind(console);
const realError = console.error.bind(console);
const capture = (level) => (...a) => { logs.push({ t: since(), level, m: a.map(String).join(' ') }); };

let chargeHandler = null;
let createHandler = null;

globalThis.fetch = (url, init = {}) => {
  const u = String(url);
  if (u === CHARGE_URL) {
    // A function calling adyen-terminal-charge itself (a kick, or a status ask).
    selfAsks.push({ t: since(), ...JSON.parse(init.body) });
    return chargeHandler(new Request(u, { method: 'POST', headers: init.headers, body: init.body }));
  }
  if (u.startsWith(`${OPS_URL}/rest/v1/second_step_settings`)) return Promise.resolve(new Response('[]', { status: 200 }));
  if (/^https:\/\/[a-z0-9-]+\.adyen\.com\//.test(u)) {
    const msg = JSON.parse(init.body);
    const cat = msg?.SaleToPOIRequest?.MessageHeader?.MessageCategory ?? '?';
    const ref = msg?.SaleToPOIRequest?.PaymentRequest?.SaleData?.SaleTransactionID?.TransactionID ?? null;
    const call = { t: since(), cat, ref };
    adyenCalls.push(call);
    const plan = scenario.adyen(cat, msg, since());
    return new Promise((resolve, reject) => {
      let timer = null;
      const onAbort = () => { if (timer) clearTimeout(timer); call.aborted = since(); reject(new DOMException('The signal has been aborted', 'AbortError')); };
      if (init.signal) { if (init.signal.aborted) { onAbort(); return; } init.signal.addEventListener('abort', onAbort, { once: true }); }
      if (plan.hang) return;
      timer = setTimeout(() => {
        init.signal?.removeEventListener('abort', onAbort);
        call.answered = since(); call.says = plan.says ?? null;
        resolve(new Response(JSON.stringify(plan.json ?? {}), { status: plan.status ?? 200 }));
      }, plan.afterMs ?? 300);
    });
  }
  throw new Error(`replay: refused to reach ${u}`);
};

// Adyen's scripted answers (nexo 3.0 shapes).
const head = (msg) => ({ ...msg.SaleToPOIRequest.MessageHeader, MessageType: 'Response' });
const paymentResponse = (minor, psp) => ({
  PaymentResponse: {
    Response: { Result: 'Success', AdditionalResponse: `pspReference=${psp}&cardSummary=1234` },
    PaymentResult: { AmountsResp: { AuthorizedAmount: minor / 100, Currency: 'GBP' }, PaymentInstrumentData: { CardData: { MaskedPan: '541333 **** 1234', PaymentBrand: 'mc' } } },
    POIData: { POITransactionID: { TransactionID: `tx.${psp}`, TimeStamp: iso(Date.now()) } },
  },
});
const A = {
  paid: (msg, afterMs, { minor = 600, psp = 'REPLAYPSP0001' } = {}) => ({ afterMs, says: 'Success', json: { SaleToPOIResponse: { MessageHeader: head(msg), ...paymentResponse(minor, psp) } } }),
  noPaymentAnswer: (afterMs) => ({ afterMs, says: '200 no payment answer', json: { SaleToPOIRequest: { EventNotification: { EventToNotify: 'Reject', EventDetails: 'message=Did+not+receive+a+response+from+the+POI.' } } } }),
  error: (afterMs, status) => ({ afterMs, status, says: `HTTP ${status}`, json: { errorCode: '000', message: 'replay' } }),
  hang: () => ({ hang: true }),
  status: (cond, afterMs = 400) => ({ afterMs, says: cond, json: { SaleToPOIResponse: { TransactionStatusResponse: { Response: { Result: 'Failure', ErrorCondition: cond } } } } }),
  noUsableAnswer: (afterMs = 400) => ({ afterMs, says: 'no usable answer', json: { SaleToPOIResponse: { TransactionStatusResponse: { Response: { Result: 'Failure' } } } } }),
  found: (msg, afterMs = 400, o = {}) => ({ afterMs, says: 'found Success', json: { SaleToPOIResponse: { TransactionStatusResponse: { Response: { Result: 'Success' }, RepeatedMessageResponse: { RepeatedResponseMessageBody: paymentResponse(o.minor ?? 600, o.psp ?? 'REPLAYPSP0001') } } } } }),
  ok: (afterMs = 300) => ({ afterMs, says: 'ok', json: {} }),
};

// The settle function, as the live database defines it (read 13 Oct 2026): a settled job is
// never changed (the answer is idempotent with its status; a missing session id is filled in).
rpcs.terminal_job_settle_from_processor = (a, db) => {
  const j = db.terminal_jobs.find((r) => r.id === a.p_job_id);
  if (!j) throw new Error('job not found');
  if (['approved', 'declined', 'cancelled', 'expired', 'reconciled'].includes(j.status)) {
    if (j.payment_session_id == null && a.p_payment_session_id != null) j.payment_session_id = a.p_payment_session_id;
    return { ok: true, idempotent: true, status: j.status };
  }
  Object.assign(j, { status: a.p_outcome, payment_session_id: a.p_payment_session_id, transaction_id: a.p_transaction_id, auth_code: a.p_auth_code, card: a.p_card, decline_reason: a.p_decline_reason, settled_at: iso(Date.now()), updated_at: iso(Date.now()), verified_source: a.p_source });
  writes.push({ at: Date.now(), db: 'ops', table: 'terminal_jobs', op: 'settle_rpc', patch: { status: a.p_outcome, source: a.p_source }, ids: [j.id] });
  return { ok: true, status: a.p_outcome, needs_human: false };
};
rpcs.terminal_sync_table_paid = () => ({ ok: true });

const jobRow = (startMs, over = {}) => ({
  id: JOB, processor: 'adyen', status: 'charging_unsent', location_id: LOC, target_terminal_id: 'term-1', pos_device_id: 'dev-1',
  charge_minor: 600, due_minor: 600, tip_minor: null, currency: 'GBP', simulated: false, training: false, capture_mode: null, tip_config: null,
  check_draft: { source: 'pos_send_to_terminal', orderRef: 'R14202', items: [{ name: 'Flat White', qty: 2, price: 3, mods: [] }] },
  check_key: `${LOC}:walkin:-:chk-1`, closed_check_id: 'chk-1',
  nexo_service_id: null, payment_session_id: null, transaction_id: null, needs_human: false, last_error: null, decline_reason: null, card: null,
  created_at: iso(startMs - 1000), updated_at: iso(startMs - 1000), dispatched_at: null, claim_expires_at: iso(startMs + 15 * 60_000), ...over,
});

function seed(startMs, jobOver = {}) {
  resetDb();
  Object.assign(dbs.ops, {
    terminal_jobs: [jobRow(startMs, jobOver)],
    terminal_devices: [
      { id: 'term-1', status: 'paired', active: true, adyen_terminal_id: 'AMS1-000168254080000', device_uid: 'random-admin-uid-1', label: 'DRIVE THRU', location_id: LOC, serial_number: 'AMS1-0000', tip_config: null },
      { id: 'term-2', status: 'paired', active: true, adyen_terminal_id: 'AMS1-000168254080002', device_uid: 'random-admin-uid-2', label: 'COUNTER', location_id: LOC, serial_number: 'AMS1-0002', tip_config: null },
    ],
    devices: [{ id: 'dev-1', device_uid: 'uid-till', location_id: LOC }, { id: 'dev-2', device_uid: 'uid-till-2', location_id: LOC }],
    locations: [{ id: LOC, timezone: 'Europe/London' }],
    user_locations: [{ user_id: MANAGER_UID, location_id: LOC }],
    activity_events: [], adyen_events: [], terminal_captures: [], closed_checks: [], user_profiles: [],
  });
  Object.assign(dbs.platform, {
    locations: [{ id: 'ploc-1', ops_location_id: LOC, currency: 'GBP' }],
    merchant_adyen_accounts: [{ location_id: 'ploc-1', merchant_account: 'ReplayMerchantTEST', store_id: null, region: 'UK', environment: 'test', receive_payments_ok: true }],
    payment_devices: [], adyen_payments: [], adyen_webhook_events: [], adyen_platform_settings: [],
  });
  users[TILL_TOKEN] = 'uid-till';
  users[MANAGER_TOKEN] = MANAGER_UID;
}

/** Adyen's own record of a payment, as the webhook writes it (the ledger row and its signed event). */
function ledgerRow(jobId, { psp = 'REPLAYPSP0009', minor = 600, at = Date.now(), refunded = 0, event = 'AUTHORISATION' } = {}) {
  dbs.platform.adyen_payments.push({ psp_reference: psp, merchant_reference: `tj-${jobId}`, success: true, amount_minor: minor, amount_refunded_minor: refunded, currency: 'GBP', last_event_code: event, card: { brand: 'visa', last4: '1234' }, raw: {}, created_at: iso(at), merchant_account: 'ReplayMerchantTEST', live: false });
  dbs.ops.adyen_events.push({ event_code: 'AUTHORISATION', psp_reference: psp, merchant_reference: `tj-${jobId}`, success: true, hmac_valid: true, live: false });
}

const flush = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
async function advanceTo(ms) {
  while (Date.now() < ms) { mock.timers.tick(Math.min(250, ms - Date.now())); await flush(); }
}
function call(handler, url, label, body, token = SERVICE) {
  const entry = { t: since(), label, done: false };
  answers.push(entry);
  Promise.resolve(handler(new Request(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body),
  }))).then(async (res) => { entry.status = res.status; entry.body = await res.json().catch(() => null); entry.back = since(); entry.done = true; },
    (e) => { entry.status = 'THREW'; entry.body = String(e?.message || e); entry.back = since(); entry.done = true; });
  return entry;
}
const charge = (label, body, token) => call(chargeHandler, CHARGE_URL, label, body, token);
/** A Pay press on a till: terminal-job-create, with the till's own sign in. */
const press = (label, over = {}) => call(createHandler, `${OPS_URL}/functions/v1/terminal-job-create`, label, {
  job_id: JOB2, check_key: `${LOC}:walkin:-:chk-2`, target_terminal_id: 'term-1', pos_device_id: 'dev-1', closed_check_id: 'chk-2',
  tip_basis_minor: 450, due_minor: 450, currency: 'GBP',
  check_draft: { source: 'pos_send_to_terminal', orderRef: 'R14203', items: [{ name: 'Latte', qty: 1, price: 4.5, mods: [] }] }, ...over,
}, TILL_TOKEN);

const jobOf = (id = JOB) => dbs.ops.terminal_jobs.find((j) => j.id === id);
const notes = () => dbs.ops.activity_events;
const durable = (prefix) => dbs.platform.adyen_webhook_events.filter((r) => String(r.event_key).startsWith(prefix));
const heldS = (id = JOB) => (Date.parse(jobOf(id).updated_at) - sentAt) / 1000;
const asksBy = (who) => selfAsks.filter((c) => c.action === 'result' && c.asked_by === who);
/** Whole seconds after the send (an ask booked "now" leaves on the clock's next step, 0.3 s later). */
const whenS = (list) => list.map((c) => Math.round(c.t));

/**
 * One timeline. `sent` is the venue's send time (UTC ISO); every time below is seconds after it.
 *   adyen(cat, msg, t)   what Adyen answers to each request
 *   asks                 status asks: { at, by, conservative?, token? }
 *   events               anything else: { at, run }
 *   cron                 true = the every minute call arrives on each whole minute; an array =
 *                        it arrives at exactly these seconds after the send; false = never
 *   start                false = do not fire 'start' at 0 (the job is seeded as it should be)
 */
async function replay(name, { sent, adyen, asks = [], events = [], untilS, cron = true, start = true, before, check }) {
  sentAt = Date.parse(sent);
  adyenCalls.length = 0; selfAsks.length = 0; logs.length = 0; answers.length = 0; background.length = 0;
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: sentAt - 1000 });
  console.log = capture('log'); console.error = capture('err');
  try {
    seed(sentAt);
    if (before) before();
    scenario = { adyen };
    const timeline = [...events];
    if (start) timeline.push({ at: 0, run: () => charge('start (server kick)', { action: 'start', job_id: JOB, kicked_by: 'terminal-job-create' }) });
    for (const a of asks) {
      timeline.push({ at: a.at, run: () => charge(`ask by ${a.by}`, { action: a.action ?? 'result', job_id: a.job ?? JOB, asked_by: a.by, ...(a.conservative ? { conservative: true } : {}) }, a.token) });
    }
    const ticks = Array.isArray(cron) ? cron
      : cron ? Array.from({ length: Math.floor(untilS / 60) + 2 }, (_, i) => (Math.ceil(sentAt / 60_000) * 60_000 + i * 60_000 - sentAt) / 1000).filter((s) => s <= untilS)
      : [];
    for (const at of ticks) timeline.push({ at, run: () => charge('cron sweep_unsent', { action: 'sweep_unsent' }) });
    timeline.sort((x, y) => x.at - y.at);
    for (const ev of timeline) { await advanceTo(sentAt + ev.at * 1000); ev.run(); await flush(); }
    await advanceTo(sentAt + untilS * 1000);
    await flush(200);
  } finally {
    scenario = null; console.log = realLog; console.error = realError;
  }
  try {
    if (VERBOSE) {
      realLog(`\n════ ${name} ════  sent ${hhmmss(sentAt)} (venue clock)`);
      realLog('  Adyen calls   :', adyenCalls.map((c) => `${c.cat}@${c.t}s→${c.aborted != null ? `our limit at ${c.aborted}s` : c.answered != null ? `${c.says} at ${c.answered}s` : 'still open'}`).join(' | '));
      realLog('  asks to self  :', selfAsks.map((c) => `${c.action}@${c.t}s by ${c.asked_by ?? c.kicked_by}${c.conservative ? ' (conservative)' : ''}`).join(' | ') || 'none');
      for (const a of answers) if (a.label !== 'cron sweep_unsent') realLog(`  ${a.label} @${a.t}s → ${a.done ? `HTTP ${a.status} at ${a.back}s ${JSON.stringify(a.body).slice(0, 260)}` : 'NO ANSWER'}`);
      for (const j of dbs.ops.terminal_jobs) realLog(`  job ${j.id.slice(0, 8)}  : ${j.status}${j.decline_reason ? ` (${j.decline_reason})` : ''}, last changed ${Math.round((Date.parse(j.updated_at) - sentAt) / 100) / 10}s after the send`);
      for (const n of notes()) realLog(`  NOTE [${n.severity}] ${n.title}\n       ${n.body}`);
    }
    // The rules every replay must keep.
    const perJob = new Map();
    for (const c of adyenCalls.filter((x) => x.cat === 'Payment')) perJob.set(c.ref, (perJob.get(c.ref) ?? 0) + 1);
    for (const [ref, n] of perJob) assert.equal(n, 1, `exactly ONE payment request ever goes to Adyen for ${ref}`);
    for (const c of selfAsks) {
      if (c.action === 'start') assert.ok(['terminal-job-create', 'sweep_unsent'].includes(c.kicked_by), `a start only from the two kicks that existed before: ${JSON.stringify(c)}`);
      else assert.ok(c.action === 'result' && c.conservative === true, `every ask a function sends itself is a conservative status ask: ${JSON.stringify(c)}`);
    }
    // Every call answered. The one exception is a 'start' whose send is still open with Adyen
    // when the replay stops (a send that hangs is held for 165 s).
    const sendOpen = adyenCalls.some((c) => c.cat === 'Payment' && c.answered == null && c.aborted == null);
    for (const a of answers) assert.ok(a.done || (sendOpen && a.label.startsWith('start')), `no answer to: ${a.label} at ${a.t}s`);
    assert.ok(answers.every((a) => a.status !== 500 && a.status !== 'THREW'), `no call ended as a 500 or threw: ${JSON.stringify(answers.filter((a) => a.status === 500 || a.status === 'THREW'))}`);
    assert.ok(!writes.some((w) => w.table === 'terminal_jobs' && w.op === 'update' && w.patch?.status === 'charging_unsent'), 'nothing ever puts a job back to charging_unsent');
    assert.equal(new Set(notes().map((n) => n.id)).size, notes().length, 'a note is written once');
    for (const n of notes()) assert.ok(!NO_DASH.test(n.title) && !NO_DASH.test(n.body), `${n.title} ${n.body}`);
    if (check) check();
  } finally {
    mock.timers.reset();
  }
}

chargeHandler = await loadFunction('adyen-terminal-charge');
createHandler = await loadFunction('terminal-job-create');

const SENT_13_OCT = '2026-10-13T06:37:50.000Z';   // 07:37:50 on the venue clock
const silentUntil229 = (cat, msg, t) => (cat === 'Payment' ? A.hang() : cat === 'TransactionStatus' ? (t >= 229 ? A.status('NotFound') : A.hang()) : A.ok());

// ── the day itself ───────────────────────────────────────────────────────────

test('13 Oct, Huddersfield Drive Thru, with the cron arriving: a silent reader is freed at about 165 s, not 310 s, and staff are told', async () => {
  // Sent 07:37:50. The send hangs (the reader never gets it). Every status ask runs into our own
  // 30 s limit until 229 s after the send. The till asked at 38 s and 57 s (HTTP 500 on the day).
  await replay('13 Oct: silent reader, the cron arrives', {
    sent: SENT_13_OCT, untilS: 200, adyen: silentUntil229,
    asks: [{ at: 38, by: 'till', token: TILL_TOKEN }, { at: 57, by: 'till', token: TILL_TOKEN }],
    check: () => {
      const j = jobOf();
      assert.equal(j.status, 'cancelled');
      assert.equal(j.decline_reason, 'Card machine could not be reached and Adyen has no record of this payment, so nothing was charged');
      // The 125 s ask comes back at 155 s (the send is dead), looks at the ledger again 10 s later, then cancels.
      assert.ok(heldS() >= 165 && heldS() <= 168, `cancelled ${heldS()}s after the send`);
      // The timer: ticks at 10 s, 70 s and 130 s after the send. Each plans its own minute, and
      // asks at once for the ask time that passed just before it (65 s, then 125 s).
      assert.deepEqual(whenS(asksBy('reader_ask_sweep')).slice(0, 7), [45, 65, 70, 85, 105, 125, 130]);
      assert.ok(asksBy('reader_ask_sweep').every((c) => c.conservative === true && c.job_id === JOB));
      // The till's asks were cut off by our own limit: 200 and "processing", never a 500.
      for (const a of answers.filter((x) => x.label === 'ask by till')) { assert.equal(a.status, 200); assert.equal(a.body.state, 'processing'); assert.equal(a.body.why, 'no_answer_yet'); }
      // One note, with what staff need: the reader's name, the venue clock, the amount, what to do.
      assert.equal(notes().length, 1);
      const n = notes()[0];
      assert.equal(n.severity, 'action');
      assert.equal(n.title, 'Card machine is free. £6.00 (R14202) was not charged.');
      assert.ok(n.body.startsWith('If the customer has not paid another way, check the card machine screen, then take the payment again. '), n.body);
      assert.ok(n.body.includes('£6.00 for the order was sent to the DRIVE THRU card machine at 07:37.'), n.body);
      assert.ok(n.body.includes('did not answer and Adyen has no record of a payment'), n.body);
      assert.equal(adyenCalls.filter((c) => c.cat === 'Abort').length, 0, 'no abort was ever sent');
      // Who it is recorded against: a timer.
      assert.equal(durable(`reader-no-payment:${JOB}`).length, 1);
      assert.equal(durable(`reader-no-payment:${JOB}`)[0].raw.caller, 'service_role');
      assert.equal(durable(`reader-no-payment:${JOB}`)[0].raw.asked_by, 'reader_ask_sweep');
    },
  });
});

test('13 Oct AS THE MORNING WAS, no cron call arrives: the refused Pay press at 07:39:32 asks the reader, and the 07:41:44 press goes through', async () => {
  let refused = null; let young = null; let again = null;
  await replay('13 Oct: silent reader, no cron (06:32 to 06:47 UTC)', {
    sent: SENT_13_OCT, untilS: 250, cron: false,
    adyen: (cat, msg, t) => {
      if (cat === 'Payment' && msg.SaleToPOIRequest.PaymentRequest.SaleData.SaleTransactionID.TransactionID === `tj-${JOB2}`) return A.paid(msg, 5_000, { minor: 450, psp: 'REPLAYPSP0002' });
      return silentUntil229(cat, msg, t);
    },
    asks: [{ at: 38, by: 'till', token: TILL_TOKEN }, { at: 57, by: 'till', token: TILL_TOKEN }],
    events: [
      { at: 30, run: () => { young = press('Pay press at 30 s'); } },
      { at: 102, run: () => { refused = press('Pay press at 07:39:32'); } },
      { at: 234, run: () => { again = press('Pay press at 07:41:44'); } },
    ],
    check: () => {
      // 30 s after the send the job is young: refused with the words it always had, and nobody is asked.
      assert.equal(young.status, 409); assert.equal(young.body.code, 'TERMINAL_BUSY');
      assert.equal(young.body.error, 'The card machine is still taking £6.00 for the order sent at 07:37 (R14202). If it is this customer, do not send it again.');
      assert.equal(asksBy('busy_press').filter((c) => c.t < 102).length, 0, 'a young payment is left alone');
      // 07:39:32: still refused (a live payment is never overridable), with words that are true.
      assert.equal(refused.status, 409); assert.equal(refused.body.code, 'TERMINAL_BUSY'); assert.equal(refused.body.busy_job_id, JOB);
      assert.equal(refused.body.error, 'The card machine has not finished £6.00 for the order sent at 07:37 (R14202). If the customer is paying on it, wait. '
        + 'If it shows nothing, this should clear by itself by about 07:41. Then press Card again.');
      // That press booked the asks: now, then each timer ask time up to 185 s after the send.
      assert.deepEqual(whenS(asksBy('busy_press')), [102, 105, 125, 145, 165, 185]);
      assert.ok(asksBy('busy_press').every((c) => c.conservative === true && c.job_id === JOB));
      assert.equal(asksBy('reader_ask_sweep').length, 0, 'no cron, so no timer ask: the press was the only trigger');
      // The 125 s ask clears it, inside what staff were told (07:41:00 is 190 s after the send).
      const j = jobOf();
      assert.equal(j.status, 'cancelled');
      assert.ok(heldS() >= 165 && heldS() <= 168, `cancelled ${heldS()}s after the send`);
      assert.ok(Date.parse(j.updated_at) < busyClearsAtMs(SENT_13_OCT), 'before the time the busy words gave');
      assert.equal(notes().filter((n) => n.severity === 'action').length, 1);
      // 07:41:44: the next Pay press is taken and paid.
      assert.equal(again.status, 200); assert.equal(again.body.ok, true); assert.equal(again.body.existing, false);
      assert.equal(jobOf(JOB2).status, 'approved');
      assert.equal(adyenCalls.filter((c) => c.cat === 'Abort').length, 0);
    },
  });
});

test('a Pay press refused by the one live job per reader index books the same asks; a job on another processor books none', async () => {
  let kiosk = null;
  await replay('reader index refusal', {
    sent: SENT_13_OCT, untilS: 130, cron: false, adyen: silentUntil229,
    events: [
      // A kiosk order is not checked for a repeat, so the insert itself meets the busy reader.
      { at: 110, run: () => { kiosk = press('kiosk press at 110 s', { pos_device_id: 'dev-2', check_draft: { source: 'kiosk', orderRef: 'K7', items: [{ name: 'Latte', qty: 1, price: 4.5, mods: [] }] } }); } },
    ],
    check: () => {
      assert.equal(kiosk.status, 409); assert.equal(kiosk.body.code, 'TERMINAL_BUSY'); assert.equal(kiosk.body.busy_job_id, JOB);
      assert.deepEqual(whenS(asksBy('busy_press')), [110, 125]);
      assert.equal(jobOf().status, 'charging', 'under 155 s a silent reader is not cancelled by these asks');
    },
  });
});

// ── an ask we cut off is not an answer (the double charge path the review found) ──

test('a till check that our own 30 s limit cuts off at 121 s decides nothing, and the payment approved at 132 s is PAID', async () => {
  // Headingley 22f54a98 and Barnsley bfac9814 (10 Oct): the status ask hung while the customer
  // was still paying, and the card was approved seconds later. Read as "could not be reached"
  // plus the 120 s rule, that ask would cancel the job, the approval would find it cancelled,
  // and the note would tell staff to take the payment again.
  await replay('ask hangs 91 s to 121 s, approved at 132 s', {
    sent: '2026-10-10T11:51:00.000Z', untilS: 200, cron: false,
    adyen: (cat, msg) => (cat === 'Payment' ? A.paid(msg, 132_000) : cat === 'TransactionStatus' ? A.hang() : A.ok()),
    asks: [{ at: 91, by: 'till', token: TILL_TOKEN }],
    check: () => {
      const ask = answers.find((a) => a.label === 'ask by till');
      assert.equal(ask.back, 121); assert.equal(ask.status, 200); assert.equal(ask.body.state, 'processing'); assert.equal(ask.body.why, 'no_answer_yet');
      assert.equal(jobOf().status, 'approved'); assert.equal(jobOf().payment_session_id, 'REPLAYPSP0001');
      assert.ok(!writes.some((w) => w.table === 'terminal_jobs' && w.patch?.status === 'cancelled'), 'nothing ever tried to cancel it');
      assert.equal(notes().length, 0, 'no note: the payment was taken and booked');
    },
  });
});

test('Cancel payment at 100 s and the auto check at 95 s both hang 30 s, a third ask comes back past 155 s: approved at 132 s stays PAID', async () => {
  await replay('cancel at 100 s, approved at 132 s', {
    sent: '2026-10-10T12:28:00.000Z', untilS: 200, cron: true,
    adyen: (cat, msg) => (cat === 'Payment' ? A.paid(msg, 132_000) : cat === 'TransactionStatus' ? A.hang() : A.ok()),
    asks: [
      { at: 95, by: 'till', token: TILL_TOKEN },
      { at: 100, by: 'till', token: TILL_TOKEN, action: 'abort' },      // Cancel payment: the abort, then the check
      { at: 100.5, by: 'till', token: TILL_TOKEN },
      { at: 126, by: 'till', token: TILL_TOKEN },                       // comes back at 156 s, after the approval
    ],
    check: () => {
      assert.equal(jobOf().status, 'approved');
      for (const a of answers.filter((x) => x.label === 'ask by till' && x.t < 126 && x.body?.state)) assert.equal(a.body.state, 'processing', JSON.stringify(a));
      const late = answers.find((a) => a.label === 'ask by till' && a.t === 126);
      assert.equal(late.body.job_status, 'approved', 'the late ask reports the paid job, it does not cancel it');
      assert.equal(notes().length, 0);
    },
  });
});

test('a real answer from Adyen that is not a 2xx keeps the 120 s rule for a person, now with a second look at the ledger', async () => {
  // The status ask is REFUSED (HTTP 503 at once), not cut off. A till asking at 124 s may cancel,
  // as before. It waits 10 s and reads the ledger again first; the ledger is still empty.
  await replay('503 on the status ask at 124 s, nothing ever paid', {
    sent: SENT_13_OCT, untilS: 150, cron: false,
    adyen: (cat) => (cat === 'Payment' ? A.hang() : cat === 'TransactionStatus' ? A.error(300, 503) : A.ok()),
    asks: [{ at: 100, by: 'till', token: TILL_TOKEN }, { at: 124, by: 'till', token: TILL_TOKEN }],
    check: () => {
      assert.equal(answers.find((a) => a.t === 100).body.why, 'no_answer_yet', 'under 120 s nothing is cancelled');
      assert.equal(jobOf().status, 'cancelled');
      assert.ok(heldS() >= 134 && heldS() <= 136, `cancelled ${heldS()}s after the send: 124 s, the answer, then 10 s`);
      assert.equal(notes().length, 1);
      assert.equal(durable(`reader-no-payment:${JOB}`)[0].raw.caller, 'uid-till', 'recorded against the till that asked');
    },
  });
});

test('the second look: a payment approved seconds before a "no answer" cancel is in the ledger by the second read, and is PAID', async () => {
  // The reader approved at 119 s but the answer to the send was lost. At 121 s the reader cannot
  // be reached and the ledger is still empty (the webhook lands a median 4.8 s after the answer).
  // One read taken at once would cancel a paid job and tell staff to take it again.
  await replay('approved at 119 s, the ledger row lands at 125 s', {
    sent: SENT_13_OCT, untilS: 160, cron: false,
    adyen: (cat) => (cat === 'Payment' ? A.hang() : cat === 'TransactionStatus' ? A.error(300, 503) : A.ok()),
    asks: [{ at: 121, by: 'till', token: TILL_TOKEN }, { at: 140, by: 'till', token: TILL_TOKEN }],
    events: [{ at: 125, run: () => ledgerRow(JOB, { psp: 'REPLAYPSP0119' }) }],
    check: () => {
      const first = answers.find((a) => a.t === 121);
      assert.equal(first.body.state, 'processing'); assert.equal(first.body.why, 'ledger_unclear');
      assert.ok(first.back >= 131, 'it waited before deciding');
      assert.equal(jobOf().status, 'approved', 'the next ask settles it from Adyen\'s record');
      assert.equal(jobOf().payment_session_id, 'REPLAYPSP0119');
      assert.equal(notes().filter((n) => n.title.startsWith('Card machine is free')).length, 0, 'nobody was told to take it again');
    },
  });
});

test('a "no answer" cancel names the attempt it asked about: a job sent again meanwhile is not cancelled by the old answer', async () => {
  await replay('sent again during the second look', {
    sent: SENT_13_OCT, untilS: 164, cron: false,
    adyen: (cat) => (cat === 'Payment' ? A.hang() : cat === 'TransactionStatus' ? A.error(300, 503) : A.ok()),
    asks: [{ at: 150, by: 'till', token: TILL_TOKEN }],
    events: [{ at: 155, run: () => { Object.assign(jobOf(), { nexo_service_id: 'svc-sent-again', dispatched_at: iso(Date.now()) }); } }],
    check: () => {
      assert.equal(jobOf().status, 'charging');
      assert.equal(jobOf().nexo_service_id, 'svc-sent-again');
      assert.equal(notes().length, 0);
      // The ask says what the job is now: still open, never "settled as charging".
      const ask = answers.find((a) => a.label === 'ask by till');
      assert.equal(ask.body.state, 'processing'); assert.equal(ask.body.status, 'charging'); assert.equal(ask.body.job_status, undefined);
    },
  });
});

// ── money on a payment we cancelled is said at once ──────────────────────────

test('a payment approved AFTER a cancel: the venue is told at once by the settle, not a minute later by the watch, and only once', async () => {
  // Today's rule for a person, unchanged: Adyen refuses the status ask at 124 s, the ledger is
  // empty twice, the job is cancelled at 134 s. The reader approves at 140 s. The settle finds a
  // cancelled job, which it can never change, so it says so there and then. No cron arrives.
  await replay('cancelled at 134 s, approved at 140 s', {
    sent: SENT_13_OCT, untilS: 150, cron: false,
    adyen: (cat, msg) => (cat === 'Payment' ? A.paid(msg, 140_000) : cat === 'TransactionStatus' ? A.error(300, 503) : A.ok()),
    asks: [{ at: 124, by: 'till', token: TILL_TOKEN }],
    check: () => {
      assert.equal(jobOf().status, 'cancelled', 'the settle function never changes a cancelled job');
      assert.equal(jobOf().payment_session_id, 'REPLAYPSP0001', 'but the payment reference is kept on it');
      const urgent = notes().filter((n) => n.severity === 'urgent');
      assert.equal(urgent.length, 1);
      assert.equal(urgent[0].title, 'Card payment taken after it was cancelled: £6.00');
      assert.ok(urgent[0].body.includes('for order R14202'), urgent[0].body);
      assert.ok(urgent[0].body.includes('refund this card payment in Adyen'), urgent[0].body);
      assert.ok((Date.parse(urgent[0].created_at) - sentAt) / 1000 <= 142, 'written when the approval arrived');
      assert.equal(durable(`late-money:${JOB}`)[0].raw.by, 'charge_sync');
      assert.equal(durable(`late-money:${JOB}`)[0].raw.psp, 'REPLAYPSP0001');
    },
  });
  // The watch then sees the same payment in the ledger: still ONE note.
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: sentAt + 200_000 });
  console.log = capture('log'); console.error = capture('err');
  try {
    ledgerRow(JOB, { psp: 'REPLAYPSP0001' });
    scenario = { adyen: () => { throw new Error('the watch must not call Adyen'); } };
    for (let i = 0; i < 2; i++) { charge('cron sweep_unsent', { action: 'sweep_unsent' }); await flush(100); mock.timers.tick(60_000); await flush(100); }
  } finally { scenario = null; console.log = realLog; console.error = realError; mock.timers.reset(); }
  assert.equal(notes().filter((n) => n.severity === 'urgent').length, 1, 'one urgent note for the job, whoever saw the money first');
});

test('the late money watch: one urgent note, a job is never changed, a refund raises nothing, and it looks back 3 days', async () => {
  const start = Date.parse('2026-10-13T06:45:00.000Z');
  const run = async (jobOver, rowOver, ticks = 3) => {
    sentAt = start; adyenCalls.length = 0; answers.length = 0; selfAsks.length = 0; logs.length = 0;
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: start });
    console.log = capture('log'); console.error = capture('err');
    try {
      seed(start, { status: 'cancelled', nexo_service_id: 'svc-1', dispatched_at: iso(start - 7 * 60_000), updated_at: iso(start - 4 * 60_000), decline_reason: 'The card machine never received this payment, so nothing was charged', ...jobOver });
      ledgerRow(JOB, { at: start - 60_000, ...rowOver });
      scenario = { adyen: () => { throw new Error('the watch must not call Adyen'); } };
      for (let i = 0; i < ticks; i++) { charge('cron sweep_unsent', { action: 'sweep_unsent' }); await flush(100); mock.timers.tick(60_000); await flush(100); }
    } finally { scenario = null; console.log = realLog; console.error = realError; mock.timers.reset(); }
  };
  await run({}, {});
  assert.equal(notes().length, 1, 'one urgent note, once, over three runs');
  assert.equal(notes()[0].severity, 'urgent');
  assert.equal(notes()[0].title, 'Card payment taken after it was cancelled: £6.00');
  assert.ok(notes()[0].body.includes('(Visa ••1234) for order R14202 at 07:44'), notes()[0].body);
  assert.equal(jobOf().status, 'cancelled', 'the job is not changed');
  assert.ok(!writes.some((w) => w.table === 'terminal_jobs'), 'no write to terminal_jobs at all');
  assert.equal(adyenCalls.length, 0);
  assert.equal(durable(`late-money:${JOB}`)[0].raw.by, 'late_money_watch');
  // A refunded payment is not this note.
  await run({}, { refunded: 600, event: 'REFUND' }, 1);
  assert.equal(notes().length, 0);
  // A reader that was off over a closed day sends its payment in two and a half days later.
  await run({ updated_at: iso(start - 60 * 60 * 60_000) }, {}, 1);
  assert.equal(notes().length, 1, 'a job cancelled 60 hours ago is still watched');
  await run({ updated_at: iso(start - 73 * 60 * 60_000) }, {}, 1);
  assert.equal(notes().length, 0, 'past 3 days it is not');
});

// ── who a cancel is recorded against ─────────────────────────────────────────

test("a manager's Release that clears the payment is recorded against the manager's own sign in", async () => {
  // Release at 130 s with the manager's session. The reader is silent, so the ask is cut off at
  // 160 s; the send is dead by then, the ledger is empty twice, and the job is cancelled.
  await replay('manager Release at 130 s, silent reader', {
    sent: SENT_13_OCT, untilS: 200, cron: false, adyen: silentUntil229,
    asks: [{ at: 130, by: 'manager_release', token: MANAGER_TOKEN }],
    check: () => {
      const rel = answers.find((a) => a.label === 'ask by manager_release');
      assert.equal(rel.status, 200); assert.equal(rel.body.job_status, 'cancelled');
      assert.ok(heldS() >= 170 && heldS() <= 172, `cancelled ${heldS()}s after the send`);
      const row = durable(`reader-no-payment:${JOB}`);
      assert.equal(row.length, 1);
      assert.equal(row[0].raw.caller, MANAGER_UID, 'the verified sign in, not a label from the request');
      assert.equal(row[0].raw.asked_by, 'manager_release');
      assert.equal(row[0].raw.kind, 'no_answer');
    },
  });
});

// ── the rule itself, run ─────────────────────────────────────────────────────

test('Adyen ends the send with no payment answer at 60 s and the reader says not found: cancelled 3 s later, with plain words on the till', async () => {
  await replay('send answered at 60 s, not found', {
    sent: SENT_13_OCT, untilS: 120,
    adyen: (cat) => (cat === 'Payment' ? A.noPaymentAnswer(60_000) : cat === 'TransactionStatus' ? A.status('NotFound') : A.ok()),
    before: () => { Object.assign(jobOf(), { charge_minor: 650, due_minor: 600 }); },
    check: () => {
      const j = jobOf();
      assert.equal(j.status, 'cancelled');
      assert.equal(j.decline_reason, 'The card machine never received this payment, so nothing was charged');
      assert.equal(j.last_error, 'terminal never received the payment (Adyen: not found)');
      assert.ok(heldS() >= 63 && heldS() <= 66, `cancelled ${heldS()}s after the send, 3 s after the send ended`);
      const marker = durable('send-ended:');
      assert.equal(marker.length, 1); assert.equal(marker[0].raw.answered, true);
      assert.deepEqual(whenS(asksBy('send_ended')), [63]);
      // The note carries the amount SENT to the card machine (6.50 with the tip), not the bill.
      assert.equal(notes().length, 1);
      assert.equal(notes()[0].title, 'Card machine is free. £6.50 (R14202) was not charged.');
      assert.ok(notes()[0].body.startsWith('If the customer has not paid another way, take the payment again. £6.50 for the order was sent to the DRIVE THRU card machine at 07:37. The card machine never received it.'), notes()[0].body);
      // What the till shows for the send: plain words, the same code.
      const start = answers.find((a) => a.label.startsWith('start'));
      assert.equal(start.status, 502); assert.equal(start.body.code, 'UNKNOWN_OUTCOME');
      assert.equal(start.body.error, 'The card machine did not answer. Checking what happened.');
      assert.ok(!NO_DASH.test(start.body.error) && !/_/.test(start.body.error));
    },
  });
});

test('15 Aug: "not found" 25 s after the send while the send is still open decides nothing, and the payment approved at 30 s is PAID', async () => {
  await replay('not found at 25 s, approved at 30 s', {
    sent: '2026-08-15T12:00:00.000Z', untilS: 200,
    adyen: (cat, msg, t) => (cat === 'Payment' ? A.paid(msg, 30_000) : cat === 'TransactionStatus' ? (t < 30 ? A.status('NotFound') : A.found(msg)) : A.ok()),
    asks: [{ at: 25, by: 'terminal-job-create' }, { at: 26, by: 'till', token: TILL_TOKEN }, { at: 27, by: 'send_ended', conservative: true }],
    check: () => {
      assert.equal(jobOf().status, 'approved'); assert.equal(jobOf().payment_session_id, 'REPLAYPSP0001');
      for (const a of answers.filter((x) => x.label.startsWith('ask'))) { assert.equal(a.status, 200); assert.equal(a.body.state, 'processing'); assert.equal(a.body.why, 'not_found_waiting'); assert.equal(a.body.status, 'charging'); }
      assert.equal(notes().length, 0);
      assert.equal(adyenCalls.filter((c) => c.cat === 'Abort').length, 0);
    },
  });
});

test('6 Oct: a payment the reader says is in progress is never touched by a timer, and is PAID at 132 s', async () => {
  await replay('in progress until paid at 132 s', {
    sent: '2026-10-06T11:00:07.000Z', untilS: 200,
    adyen: (cat, msg) => (cat === 'Payment' ? A.paid(msg, 132_000) : cat === 'TransactionStatus' ? A.status('InProgress') : A.ok()),
    check: () => {
      assert.equal(jobOf().status, 'approved');
      assert.ok(asksBy('reader_ask_sweep').filter((c) => c.t > 120 && c.t < 132).length >= 1, 'a timer did ask past 120 s');
      assert.equal(adyenCalls.filter((c) => c.cat === 'Abort').length, 0, 'and still no abort was sent');
      assert.equal(notes().length, 0);
      assert.equal(answers.find((a) => a.label.startsWith('start')).status, 200);
    },
  });
});

test('unchanged for a person: in progress past 120 s with an empty ledger is aborted, looked at again after 10 s, then cancelled', async () => {
  await replay('till asks at 125 s, in progress', {
    sent: '2026-10-06T11:00:07.000Z', untilS: 150, cron: false,
    adyen: (cat) => (cat === 'Payment' ? A.hang() : cat === 'TransactionStatus' ? A.status('InProgress') : A.ok()),
    asks: [{ at: 100, by: 'till', token: TILL_TOKEN }, { at: 125, by: 'till', token: TILL_TOKEN }],
    check: () => {
      assert.equal(answers.find((a) => a.t === 100).body.why, 'in_progress');
      assert.equal(adyenCalls.filter((c) => c.cat === 'Abort').length, 1);
      assert.equal(jobOf().status, 'cancelled');
      assert.equal(jobOf().decline_reason, 'The card machine was still waiting and Adyen has no record of this payment, so it was cancelled and nothing was charged');
      assert.ok(heldS() >= 135 && heldS() <= 137, `cancelled ${heldS()}s after the send: the abort, then 10 s for a racing approval`);
    },
  });
});

test('after an abort, an approval that raced it is in the ledger by the second look, and the job is PAID, not cancelled', async () => {
  await replay('abort at 125 s races an approval', {
    sent: '2026-10-06T11:00:07.000Z', untilS: 150, cron: false,
    adyen: (cat) => (cat === 'Payment' ? A.hang() : cat === 'TransactionStatus' ? A.status('InProgress') : A.ok()),
    asks: [{ at: 125, by: 'manager_release', token: MANAGER_TOKEN }],
    events: [{ at: 131, run: () => ledgerRow(JOB, { psp: 'REPLAYPSP0126' }) }],   // 5 s after the abort
    check: () => {
      assert.equal(jobOf().status, 'approved');
      assert.equal(jobOf().payment_session_id, 'REPLAYPSP0126');
      assert.equal(notes().length, 0);
    },
  });
});

test('the send ends with an Adyen 503 (not proof) and the reader says not found throughout: nothing before 155 s, then cancelled', async () => {
  await replay('503 on the send at 10 s, not found', {
    sent: SENT_13_OCT, untilS: 200,
    adyen: (cat) => (cat === 'Payment' ? A.error(10_000, 503) : cat === 'TransactionStatus' ? A.status('NotFound') : A.ok()),
    asks: [{ at: 40, by: 'till', token: TILL_TOKEN }, { at: 130, by: 'manager_release', token: MANAGER_TOKEN }],
    check: () => {
      const marker = durable('send-ended:');
      assert.equal(marker[0].raw.how, 'adyen_error'); assert.equal(marker[0].raw.answered, false);
      for (const a of answers.filter((x) => x.label.startsWith('ask'))) assert.equal(a.body.why, 'not_found_waiting', `${a.label} at ${a.t}s`);
      assert.equal(jobOf().status, 'cancelled');
      assert.ok(heldS() >= 155 && heldS() <= 170, `cancelled ${heldS()}s after the send`);
      assert.equal(notes().length, 1); assert.ok(notes()[0].body.includes('never received it'));
    },
  });
});

test('the ledger cannot be read: a "not found" at 200 s decides nothing', async () => {
  await replay('not found at 200 s, ledger unreadable', {
    sent: SENT_13_OCT, untilS: 215, cron: false,
    adyen: (cat) => (cat === 'Payment' ? A.hang() : cat === 'TransactionStatus' ? A.status('NotFound') : A.ok()),
    before: () => { Object.defineProperty(dbs.platform, 'adyen_payments', { get() { throw new Error('connection reset'); }, configurable: true }); },
    asks: [{ at: 200, by: 'till', token: TILL_TOKEN }],
    check: () => {
      assert.equal(jobOf().status, 'charging');
      assert.equal(answers.find((a) => a.label === 'ask by till').body.why, 'ledger_unclear');
      assert.equal(notes().length, 0);
    },
  });
});

// ── the timer, run ───────────────────────────────────────────────────────────

test('the timer asks about every stuck reader, not only the first', async () => {
  await replay('two silent readers', {
    sent: SENT_13_OCT, untilS: 200, adyen: silentUntil229,
    before: () => { dbs.ops.terminal_jobs.push(jobRow(sentAt, { id: JOB2, target_terminal_id: 'term-2', pos_device_id: 'dev-2', check_key: `${LOC}:walkin:-:chk-2`, closed_check_id: 'chk-2', check_draft: { source: 'pos_send_to_terminal', orderRef: 'R14203' } })); },
    events: [{ at: 0, run: () => charge('start (server kick) 2', { action: 'start', job_id: JOB2, kicked_by: 'terminal-job-create' }) }],
    check: () => {
      for (const id of [JOB, JOB2]) {
        assert.deepEqual(whenS(asksBy('reader_ask_sweep').filter((c) => c.job_id === id)).slice(0, 3), [45, 65, 70], id);
        assert.equal(jobOf(id).status, 'cancelled', id);
      }
      assert.equal(notes().length, 2, 'one note for each');
      assert.ok(notes().some((n) => n.body.includes('COUNTER card machine')) && notes().some((n) => n.body.includes('DRIVE THRU card machine')));
    },
  });
});

test('Barnsley, 12 Oct: a cron call 4.6 s late asks at once for the ask time it missed, so the reader is freed at about 177 s, not 196 s', async () => {
  // Sent 12:41:17.73. The send ended in 1.4 s with an error (not proof). The reader gave no
  // usable answer. The cron calls arrived at 42.31 s, 102.31 s and then 166.9 s after the send.
  await replay('late tick at 166.9 s', {
    sent: '2026-10-12T11:41:17.730Z', untilS: 200, cron: [42.31, 102.31, 166.9],
    adyen: (cat) => (cat === 'Payment' ? A.error(1_400, 502) : cat === 'TransactionStatus' ? A.noUsableAnswer() : A.ok()),
    check: () => {
      const t = asksBy('reader_ask_sweep').map((c) => c.t);
      assert.ok(t.some((x) => x >= 166.9 && x <= 167.5), `the late tick asked at once: ${JSON.stringify(t)}`);
      assert.ok(!t.some((x) => x > 145.5 && x < 166.9), 'and nobody had asked for the 165 s time before it');
      assert.equal(jobOf().status, 'cancelled');
      assert.equal(jobOf().decline_reason, 'The card machine gave no answer and Adyen has no record of this payment, so nothing was charged');
      assert.ok(heldS() >= 176 && heldS() <= 179, `cancelled ${heldS()}s after the send`);
      assert.equal(notes().length, 1);
    },
  });
});
