/**
 * readerLockWiring.test.js (13 Oct 2026): the reader lock fix is WIRED, not only written.
 * Reads the real sources, like repeatChargeWiring.test.js and readerTipWiring.test.js do: the edge
 * functions are Deno and cannot run under `npm test`, so the order and the guards that make the
 * pure rules in _shared/readerLock.js matter are pinned in their text.
 *
 * What these protect (Peter's bar for the card path, 9 Sep 2026): nothing like a stranded live
 * job again; a customer is never charged twice; a till is never left unable to take a card when
 * the reader is fine.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const count = (src, needle) => src.split(needle).length - 1;
const before = (src, first, second, why) => {
  const a = src.indexOf(first);
  const b = src.indexOf(second);
  assert.ok(a >= 0, `${why}: missing ${first}`);
  assert.ok(b >= 0, `${why}: missing ${second}`);
  assert.ok(a < b, why);
};
const between = (src, from, to) => {
  const a = src.indexOf(from);
  assert.ok(a >= 0, `missing: ${from}`);
  const b = src.indexOf(to, a + from.length);
  assert.ok(b > a, `missing after it: ${to}`);
  return src.slice(a, b);
};

const charge = read('../../../supabase/functions/adyen-terminal-charge/index.ts');
const create = read('../../../supabase/functions/terminal-job-create/index.ts');
const kick = read('../../../supabase/functions/_shared/terminalKick.js');
const bo = read('../../backoffice/sections/AdyenTerminals.jsx');

// The action blocks, cut on the function's own markers.
const start = between(charge, "if (action === 'start' || action === 'prepare_local') {", "if (action === 'report_local') {");
const result = between(charge, "if (action === 'result') {", "if (action === 'abort') {");
const sweep = between(charge, "if (action === 'sweep_unsent') {", "const jobId = String(body.job_id ?? '');");
const unreachable = between(result, 'if (!res.ok) {', 'const ts = res.data?.SaleToPOIResponse?.TransactionStatusResponse ?? {};');
const inProgress = between(result, "if (cond === 'in_progress') {", "if (cond === 'unknown') {");
const noAnswer = between(result, "if (cond === 'unknown') {", "if (cond === 'not_found') {");
const notFound = between(result, "if (cond === 'not_found') {", 'const inner = ts?.RepeatedMessageResponse?.RepeatedResponseMessageBody ?? {};');
// The module helpers, each up to the next one.
const selfAsk = between(charge, 'function scheduleSelfAsk(', '\nasync function raiseNoPaymentNote(');
const note = between(charge, 'async function raiseNoPaymentNote(', '\nasync function runReaderAskSweep(');
const askSweep = between(charge, 'async function runReaderAskSweep(', '\nasync function runLateMoneyWatch(');
const lateMoney = between(charge, 'async function runLateMoneyWatch(', '\nasync function logRefusal(');

test('result: the status ask sits in a try, and a throw is "could not be reached", never an HTTP 500', () => {
  const ask = between(result, 'let res: { ok: boolean; status?: number; data: any };', 'const tenderStalled =');
  before(ask, 'try {', "res = await adyenFetch('POST', terminalEndpoint(maa!.merchant_account, poiid as string, 'sync', cfg.region, cfg), statusReq, { cfg, timeoutMs: STATUS_ASK_TIMEOUT_MS });", 'the ask is inside the try');
  before(ask, 'timeoutMs: STATUS_ASK_TIMEOUT_MS });', '} catch (e) {', 'its own catch follows it');
  before(ask, '} catch (e) {', 'res = { ok: false, status: 0, data: null };', 'the catch sets a not ok result');
  assert.match(ask, /catch \(e\) \{\s*console\.error\(`adyen-terminal-charge: result for job \$\{job\.id\}: the status ask did not come back/);
  // Only ONE status ask in the action, so no second, unguarded copy exists.
  assert.equal(count(result, 'statusReq, {'), 1);
  // The not ok result falls into the existing branch, which is the next thing that reads `res`.
  before(result, 'res = { ok: false, status: 0, data: null };', 'if (!res.ok) {', 'falls into the could not be reached branch');
});

test("result never writes status 'charging_unsent' again: nothing re sends a payment after a not found", () => {
  assert.ok(!result.includes("status: 'charging_unsent'"));
  assert.ok(!result.includes('charging_unsent'), 'not even in a comment, so a search finds only the real writers');
  // In the whole function the only writer left is the 4xx revert in 'start'.
  assert.equal(count(charge, "status: 'charging_unsent'"), 1);
  assert.ok(start.includes(".update({ status: 'charging_unsent', nexo_service_id: null, last_error: refusal, updated_at: new Date().toISOString() })"));
  // The 409 "safe" answer that told the till to send again is no longer produced by 'result'.
  assert.ok(!result.includes('safe: true'));
  assert.equal(count(charge, 'safe: true'), 1, "only the 4xx refusal in 'start' says safe");
});

test('result, not found: the ledger guard is unchanged and first, then the verdict, then ONE compare and set cancel on the service id', () => {
  // The guard, byte for byte as v5.11.16 left it.
  assert.ok(notFound.includes([
    "      const lg = (early.verdict === 'charged' || (early as any).ambiguous === true)",
    '        ? early',
    "        : await askAdyenLedger(job).catch(() => ({ verdict: 'too_soon' as const }));",
    '      const ledgerApproved = ledgerShowsApproval(lg as any);',
    '      if (ledgerApproved) {',
    "        if (lg.verdict === 'charged') {",
    '          try { await settleFromLedger(job, (lg as any).row, { allowPark: true }); }',
    '          catch (e) {',
    '            if (isSettleDeferred(e)) return deferredBody(job.status);',
    '            console.error(`adyen-terminal-charge: ledger settle after NotFound for job ${job.id} failed: ${(e as Error).message}`);',
    '          }',
    '        }',
    "        const { data: st } = await opsAdmin.from('terminal_jobs').select('*').eq('id', job.id).maybeSingle();",
    '        if (st && SETTLED.includes(st.status)) return json(await withCapture(settledBody(st), st));',
    "        return json({ ok: true, state: 'processing', status: st?.status ?? job.status });",
    '      }',
  ].join('\n')));
  const cancel = ".update({ status: 'cancelled', decline_reason: NEVER_RECEIVED_REASON, last_error: NEVER_RECEIVED_ERROR, updated_at: new Date().toISOString() })";
  before(notFound, 'if (ledgerApproved) {', 'neverReceivedVerdict(', 'the ledger guard runs first');
  before(notFound, 'neverReceivedVerdict(', cancel, 'the verdict comes before the cancel');
  before(notFound, 'if (!proof.proven) {', cancel, 'not proven returns before the cancel');
  assert.match(notFound, /if \(!proof\.proven\) \{[\s\S]{0,300}?return processing\(why\);\s*\}/);
  // The proof is made of a FRESH ledger read, the marker for THIS service id, and the time since the send.
  assert.ok(notFound.includes('const fresh = await ledgerRowsForJob(platformAdmin, job.id);'));
  assert.ok(notFound.includes(".select('raw').eq('event_key', sendEndedKey(job.id, job.nexo_service_id)).maybeSingle();"));
  assert.ok(notFound.includes('marker = mkErr ? null : (mk?.raw ?? null);'), 'a marker that cannot be read is no marker');
  assert.ok(notFound.includes('} catch { marker = null; }'));
  assert.ok(notFound.includes([
    '      const proof = neverReceivedVerdict({',
    '        ledgerReadOk: !fresh.error, ledgerRowCount: fresh.rows.length,',
    '        sendAnswered: sendAnswered(marker), sinceSendMs,',
    '      });',
  ].join('\n')));
  // ONE compare and set: the status AND the service id that was asked about.
  assert.ok(notFound.includes([
    cancel,
    "        .eq('id', job.id).in('status', ['charging', 'unknown']).eq('nexo_service_id', job.nexo_service_id)",
    "        .select('id');",
  ].join('\n')));
  assert.equal(count(notFound, '.update('), 1, 'the cancel is the only write in the branch');
  // The raw facts are kept, and a job another path changed first is reported as it is.
  assert.ok(notFound.includes('await logDurable(platformAdmin, `not-found:${job.id}:${Date.now()}`, {'));
  assert.ok(notFound.includes("if (st && !SETTLED.includes(st.status)) return processing('not_found_waiting', { status: st.status });"));
});

test('the time since the send is read AFTER the status ask, from dispatched_at only', () => {
  before(result, 'timeoutMs: STATUS_ASK_TIMEOUT_MS });', 'const sinceSendMs = sinceSend();', 'read after the ask');
  before(result, 'const tenderStalled = Date.now() - new Date(job.dispatched_at ?? job.created_at).getTime() > 120_000;', 'const sinceSendMs = sinceSend();', 'next to the pinned line');
  assert.ok(result.includes("const sentAtMs = Date.parse(String(job.dispatched_at ?? ''));"));
  assert.ok(result.includes('const sinceSend = (): number | null => (Number.isFinite(sentAtMs) ? Date.now() - sentAtMs : null);'));
});

test('result, in progress: a timer answers "processing" before any abort is built', () => {
  before(inProgress, "if (conservative) return processing('in_progress');", 'buildAbortRequest(', 'the conservative return comes before the abort');
  before(inProgress, "if (conservative) return processing('in_progress');", 'const stalled =', 'and before the 120 s rule is even read');
  assert.equal(count(result, 'buildAbortRequest('), 1, 'one abort site in the action, inside the in progress branch');
  assert.equal(count(inProgress, 'buildAbortRequest('), 1);
  // For a till or a person the rule is what it was.
  assert.ok(inProgress.includes('const stalled = Date.now() - new Date(job.dispatched_at ?? job.created_at).getTime() > 120_000;'));
  assert.ok(inProgress.includes("if (stalled && led.verdict === 'nothing') {"));
});

test('result, no usable answer: the timer wait sits between the young guard and the cancel, in both branches', () => {
  const young = "if (v.verdict === 'nothing' && !tenderStalled) {";
  const wait = "if (v.verdict === 'nothing' && timerMustWait({ conservative, sinceSendMs })) return processing('no_answer_yet');";
  const cancel = "if (v.verdict === 'nothing') {";
  for (const [name, block, reason] of [
    ['could not be reached', unreachable, 'Card machine could not be reached and Adyen has no record of this payment, so nothing was charged'],
    ['no answer', noAnswer, 'The card machine gave no answer and Adyen has no record of this payment, so nothing was charged'],
  ]) {
    assert.equal(count(block, young), 1, name);
    assert.equal(count(block, wait), 1, name);
    before(block, young, wait, `${name}: the young guard first`);
    before(block, wait, cancel, `${name}: the wait before the cancel`);
    before(block, wait, ".update({ status: 'cancelled'", `${name}: the wait before the write`);
    // The decline reason is the one it always was, and the cancel now says whether it won.
    assert.ok(block.includes(`.update({ status: 'cancelled', decline_reason: '${reason}', updated_at: new Date().toISOString() })\n          .eq('id', job.id).in('status', ['charging', 'unknown']).select('id');`), name);
    assert.equal(count(block, '.update('), 1, name);
  }
  assert.equal(count(result, wait), 2);
});

test('each server cancel for never received or no answer raises its note only when ITS update returned one row', () => {
  assert.equal(count(result, "if (Array.isArray(won) && won.length === 1) await raiseNoPaymentNote(job, 'no_answer', askedBy);"), 2);
  assert.equal(count(result, "if (Array.isArray(won) && won.length === 1) await raiseNoPaymentNote(job, 'never_received', askedBy);"), 1);
  assert.equal(count(charge, 'await raiseNoPaymentNote('), 3, 'no other caller');
  // The note: once per job by its key, best effort, never able to undo or block the cancel.
  assert.ok(note.includes('const told = await insertActivity(opsAdmin, job, note, noPaymentNoteKey(job.id));'));
  assert.ok(note.includes("if (told === 'inserted') {"));
  assert.ok(!note.includes('.update(') && !note.includes('throw '), 'it changes nothing and throws nothing');
  assert.match(note, /^async function raiseNoPaymentNote\(job: any, kind: 'never_received' \| 'no_answer', askedBy: string\): Promise<void> \{\n {2}try \{/);
  assert.match(note, /\} catch \(e\) \{\n {4}console\.error\(`adyen-terminal-charge: note for cancelled job/);
  assert.ok(charge.includes('ledgerRowVerified, readTipEvidence, insertActivity,\n} from \'../_shared/readerTipHeal.ts\';'));
});

test("start writes the send ended marker at exactly the three UNKNOWN_OUTCOME exits, and not in the 4xx branch", () => {
  const exit = "return json({ ok: false, error: 'terminal_unreachable — result pending recovery', code: 'UNKNOWN_OUTCOME' }, 502);";
  assert.equal(count(start, exit), 3);
  assert.equal(count(charge, "code: 'UNKNOWN_OUTCOME'"), 3);
  assert.equal(count(charge, 'sendEndedKey(job.id, serviceId), sendEndedRecord({'), 3);
  assert.equal(count(charge, "scheduleSelfAsk(job.id, SEND_ENDED_ASK_AFTER_MS, 'send_ended');"), 3);
  const hows = [...start.matchAll(/await logDurable\(platformAdmin, sendEndedKey\(job\.id, serviceId\), sendEndedRecord\(\{ how: '([a-z_]+)'[^\n]*\}\)\);\n\s*scheduleSelfAsk\(job\.id, SEND_ENDED_ASK_AFTER_MS, 'send_ended'\);\n\s*return json\(\{ ok: false, error: 'terminal_unreachable — result pending recovery', code: 'UNKNOWN_OUTCOME' \}, 502\);/g)].map((m) => m[1]);
  assert.deepEqual(hows, ['no_answer', 'adyen_error', 'answered_no_payment'], 'marker, then the ask, then the exit, in that order at each');
  // Only a 2xx with no payment answer is recorded as answered.
  assert.ok(start.includes("if (parsed.result === 'Unknown') {"));
  before(start, "if (parsed.result === 'Unknown') {", "sendEndedRecord({ how: 'answered_no_payment', httpStatus: res.status, body: res.data, now: Date.now() })", 'the answered marker is the parsed Unknown exit');
  // The 4xx branch (a clean refusal, reverted so the till can retry) has no marker and no ask.
  const refused = between(start, 'if (!res.ok && res.status >= 400 && res.status < 500) {', 'if (!res.ok) {');
  assert.ok(refused.includes("return json({ ok: false, safe: true, error: refusal }, 409);"));
  assert.ok(!refused.includes('sendEnded') && !refused.includes('scheduleSelfAsk'));
  // The claim, the 5 minute lease stamp, the 165 s hold and the success path are what they were.
  assert.ok(start.includes("claim_expires_at: new Date(Date.now() + 5 * 60_000).toISOString(), updated_at: nowIso,"));
  assert.ok(start.includes(".eq('id', job.id).eq('status', 'charging_unsent').select('id');"));
  assert.ok(start.includes("res = await adyenFetch('POST', hostUsed, nexo, { cfg, timeoutMs: 165_000 });"));
  assert.ok(start.includes("try { await settleFromResponse(job.id, parsed, 'charge_sync', chargeMinor, maa.merchant_account); }"));
});

test("scheduleSelfAsk only ever sends the status ask, always conservative; one place in the file sends 'start'", () => {
  assert.equal(count(selfAsk, 'fetch('), 1);
  assert.ok(selfAsk.includes("body: JSON.stringify({ action: 'result', job_id: jobId, asked_by: askedBy, conservative: true }),"));
  assert.ok(selfAsk.includes("await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/adyen-terminal-charge`, {"), "this function's own URL");
  assert.ok(selfAsk.includes('Authorization: `Bearer ${SERVICE_ROLE}`'), 'the service role');
  assert.ok(!selfAsk.includes("'start'") && !selfAsk.includes('buildPaymentRequest') && !selfAsk.includes('adyenFetch'));
  // No token is logged: the two log lines carry the asker, the job, the status and the answer's first 200 characters.
  for (const line of selfAsk.split('\n').filter((l) => /console\.(log|error)\(/.test(l))) assert.ok(!/SERVICE_ROLE|Authorization|apiKey/.test(line), line);
  assert.ok(selfAsk.includes('out.slice(0, 200)'));
  // Never throws: the whole run is in a try.
  assert.match(selfAsk, /const run = async \(\) => \{\n {4}try \{/);
  // Every caller: the three send ended asks and the timer.
  assert.equal(count(charge, 'scheduleSelfAsk('), 5, 'the definition, three in start, one in the timer');
  assert.equal(count(charge, "action: 'start'"), 1, 'the unsent sweep kick is still the only sender of a start');
  assert.ok(sweep.includes("body: JSON.stringify({ action: 'start', job_id: id, kicked_by: 'sweep_unsent' }),"));
  // No new call to Adyen's payment or refund endpoints anywhere: a payment request is still built
  // in the same two places as before (the bar tab hold and 'start'), and in none of the new code.
  assert.equal(count(charge, 'buildPaymentRequest('), 2);
  assert.equal(count(start, 'buildPaymentRequest('), 1);
  for (const block of [result, selfAsk, note, askSweep, lateMoney]) {
    assert.ok(!block.includes('buildPaymentRequest(') && !block.includes('checkoutBase(') && !/\/(refunds|captures|cancels|reversals)\b/.test(block), 'no payment or refund call');
  }
  assert.equal(count(charge, "action: 'result'"), 1, 'and one place sends the status ask to itself');
});

test('sweep_unsent: service role first, then both new riders under waitUntil, each in its own try, before the early return', () => {
  before(sweep, 'if (!isServiceRole) {', 'runReaderTipSweep(locationId)', 'the fence is first');
  before(sweep, "return json({ error: 'sweep_unsent: service role only' }, 403);", 'runReaderAskSweep(locationId)', 'no rider before the fence');
  const early = "if (!jobs.length) return json({ ok: true, scanned: 0, kicked: [], skipped: [] });";
  assert.equal(count(sweep, early), 1, 'the answer for an empty sweep is what it was');
  for (const [fn, name] of [['runReaderAskSweep', 'readerAsks'], ['runLateMoneyWatch', 'lateMoney']]) {
    before(sweep, `${fn}(locationId)`, early, `${fn} starts before the early return`);
    before(sweep, `${fn}(locationId)`, ".eq('processor', 'adyen').eq('status', 'charging_unsent')", `${fn} starts before the unsent select`);
    assert.match(sweep, new RegExp(`try \\{\\n\\s*const ${name} = ${fn}\\(locationId\\);\\n\\s*if \\(rt\\?\\.waitUntil\\) rt\\.waitUntil\\(${name}\\);\\n\\s*\\} catch \\(e\\) \\{`), `${fn}: own try, under waitUntil`);
    assert.equal(count(charge, `${fn}(locationId)`), 1);
  }
  // The unsent sweep's own select, kicks and answer are what they were.
  assert.ok(sweep.includes(".select('id, location_id, target_terminal_id, pos_device_id, processor, status, charge_minor, simulated, training, check_draft, created_at, updated_at')"));
  assert.ok(sweep.includes('minAgeMs: UNSENT_SWEEP_MIN_AGE_MS, maxAgeMs: UNSENT_SWEEP_MAX_AGE_MS, limit: UNSENT_SWEEP_LIMIT,'));
  assert.ok(sweep.includes('return json({ ok: true, scanned: jobs.length, kicked: kick, skipped });'));
});

test('the timer: only sent Adyen jobs inside the lease, the local bridge left alone by the pure rule, asks only', () => {
  assert.ok(askSweep.includes(".eq('processor', 'adyen').eq('status', 'charging')"));
  assert.ok(askSweep.includes(".eq('simulated', false).eq('training', false)"));
  assert.ok(askSweep.includes(".not('nexo_service_id', 'is', null)"));
  assert.ok(askSweep.includes(".gte('dispatched_at', new Date(now - READER_ASK_MAX_SINCE_SEND_MS).toISOString())"));
  assert.ok(askSweep.includes(".order('dispatched_at', { ascending: true })"), 'oldest send first');
  // The rows the local bridge check needs are loaded the way the unsent sweep loads them.
  assert.ok(askSweep.includes("opsAdmin.from('terminal_devices').select('id, device_uid').in('id', termIds)"));
  assert.ok(askSweep.includes("opsAdmin.from('devices').select('id, device_uid').in('id', devIds)"));
  assert.match(askSweep, /const plan = selectReaderAskJobs\(jobs, \{\s*now,\s*terminalsById: new Map\([^\n]*\),\s*devicesById: new Map\([^\n]*\),\s*limit: READER_ASK_LIMIT,\s*\}\);/);
  assert.ok(askSweep.includes("for (const one of plan) for (const delay of one.delays) asks.push(scheduleSelfAsk(one.id, delay, 'reader_ask_sweep'));"));
  assert.ok(askSweep.includes('reader ask sweep: ${asks.length} ask(s) planned'), 'the line the after deploy check looks for');
  assert.ok(!askSweep.includes('.update(') && !askSweep.includes('.insert(') && !askSweep.includes('settle') && !askSweep.includes('adyenFetch'), 'it only plans asks');
  // The pure rule imports the one local bridge test there is.
  const lock = read('../../../supabase/functions/_shared/readerLock.js');
  assert.ok(lock.includes("import { isLocalBridgeJob } from './terminalKick.js';"));
  assert.ok(kick.includes('export function isLocalBridgeJob('));
});

test('the late money watch tells a person and changes nothing: no job update, no settle, an HMAC verified approval only', () => {
  assert.ok(lateMoney.includes(".eq('processor', 'adyen').in('status', ['cancelled', 'expired'])"));
  assert.ok(lateMoney.includes(".eq('simulated', false).eq('training', false)"));
  assert.ok(lateMoney.includes(".gte('updated_at', new Date(now - LATE_MONEY_WINDOW_MS).toISOString())"));
  assert.ok(lateMoney.includes(".order('updated_at', { ascending: false })"));
  assert.ok(lateMoney.includes('.limit(LATE_MONEY_LIMIT);'));
  assert.ok(lateMoney.includes(".in('merchant_reference', [...byRef.keys()]).eq('success', true);"), 'one ledger read for the whole run');
  assert.equal(count(lateMoney, "platformAdmin.from('adyen_payments')"), 1);
  const told = 'const told = await insertActivity(opsAdmin, job, alert, lateMoneyAlertKey(job.id));';
  before(lateMoney, "if (ledgerApproval(row) !== 'approved') continue;", told, 'refunded, reversed or changed rows are skipped first');
  before(lateMoney, 'if ((await ledgerRowVerified(opsAdmin, row, job.id)) !== true) continue;', told, 'and an unverified row');
  assert.equal(count(lateMoney, 'insertActivity('), 1);
  assert.ok(!lateMoney.includes('.update(') && !lateMoney.includes('.delete('), 'it never changes a job');
  assert.ok(!/settleFrom|settleRpc|terminal_job_settle|closed_checks/.test(lateMoney), 'it never books or settles a sale');
  assert.ok(!lateMoney.includes('adyenFetch') && !lateMoney.includes('fetch('), 'it never calls Adyen');
});

test('result answers stay backward compatible: processing keeps ok, state and status and only adds fields', () => {
  assert.ok(result.includes([
    "    const processing = (why: string, extra: Record<string, unknown> = {}) => json({",
    "      ok: true, state: 'processing', status: job.status, why,",
    '      since_send_ms: sinceSend(),',
    '      retry_after: Number.isFinite(sentAtMs) ? new Date(sentAtMs + TENDER_STALL_MS).toISOString() : null,',
    '      clears_by: Number.isFinite(sentAtMs) ? new Date(sentAtMs + BUSY_CLEARS_AFTER_MS).toISOString() : null,',
    '      ...extra,',
    '    });',
  ].join('\n')));
  // The reasons a caller can be given, and no others.
  const known = ['in_progress', 'ledger_unclear', 'no_answer_yet', 'not_found_waiting', 'not_in_flight'];
  const literal = new Set([...result.matchAll(/processing\('([a-z_]+)'/g)].map((m) => m[1]));
  for (const why of literal) assert.ok(known.includes(why), why);
  for (const why of known) assert.ok(result.includes(`'${why}'`), why);
  assert.ok(result.includes("(v.verdict === 'charged' || v.ambiguous === true || tenderStalled ? 'ledger_unclear' : 'no_answer_yet');"));
  assert.ok(result.includes("return processing('not_in_flight');"), 'the early exit');
  // Settled answers are the same body as ever.
  assert.ok(result.includes('if (SETTLED.includes(job.status)) return json(await withCapture(settledBody(job), job));'));
  // Who asked is one console line, and the two new body fields are read, not required.
  assert.ok(result.includes('const conservative = body.conservative === true;'));
  assert.ok(charge.includes('asked_by?: string;') && charge.includes('conservative?: boolean;'));
});

test('terminal-job-create reads the processor in both busy reads, and still asks once at 25 s without re sending', () => {
  assert.ok(create.includes(".select('id, check_key, status, processor, location_id, pos_device_id, target_terminal_id, due_minor, charge_minor, currency, closed_check_id, check_draft, card, simulated, training, created_at, dispatched_at, charged_at, settled_at, updated_at')"));
  const busy = between(create, '// 2. Terminal busy with another bill.', '// 3. THE PRIMARY KEY.');
  assert.ok(busy.includes(".select('id, check_key, status, processor, due_minor, charge_minor, currency, check_draft, pos_device_id, target_terminal_id, closed_check_id, card, created_at, dispatched_at, settled_at')"));
  assert.ok(create.includes("body: JSON.stringify({ action: 'result', job_id: jobId, asked_by: 'terminal-job-create' }),"), 'the 25 s one shot is what it was');
  assert.equal(count(create, "action: 'start'"), 1, 'one server kick, as before');
  // The busy tiers and the index's own set are not touched.
  assert.ok(create.includes(".in('status', ['claimed', 'tipping', 'charging_unsent', 'charging'])"));
});

test('Back Office Release asks the server about each sent payment BEFORE the release, and never writes terminal_jobs', () => {
  const release = between(bo, 'const release = async () => {', 'const setPin = async () => {');
  const ask = 'for (const job of jobsToAsk(before)) asked.push({ job, ...(await askCardMachine(job.id)) });';
  const rpc = "await supabase.rpc('release_terminal_jobs', { p_terminal_id: r.id, p_note: null });";
  before(release, 'const before = await liveOn();', ask, 'read, then ask');
  before(release, ask, rpc, 'ask, then the release');
  before(release, rpc, 'const still = await liveOn();', 'then read again');
  before(release, 'const still = await liveOn();', 'const out = releaseLines({ label: r.label, asked, rpc, still, tz, now: Date.now() });', 'then say it');
  assert.equal(count(release, rpc), 1, 'the release itself is the call it always was');
  // The ask is the status ask, with the manager's own sign in.
  const fn = between(bo, 'async function askCardMachine(jobId) {', 'const fmtWhen = (iso) => {');
  assert.ok(bo.includes('const CHARGE_FN_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/adyen-terminal-charge`;'));
  assert.ok(fn.includes("body: JSON.stringify({ action: 'result', job_id: jobId, asked_by: 'manager_release' }),"));
  assert.ok(fn.includes('Authorization: `Bearer ${session.access_token}`'));
  assert.ok(!fn.includes('conservative'), "a person's ask keeps the 120 s rules");
  assert.ok(!bo.includes("action: 'start'") && !bo.includes("action: 'abort'"));
  // The page reads the live payments and never writes them.
  assert.ok(release.includes("supabase.from('terminal_jobs').select(RELEASE_JOB_COLUMNS)"));
  assert.ok(release.includes(".eq('target_terminal_id', r.id).in('status', RELEASE_LIVE_STATUSES).limit(5);"));
  assert.ok(!bo.includes(".from('terminal_jobs').update"));
  assert.ok(!/from\('terminal_jobs'\)[\s\S]{0,80}\.(update|insert|upsert|delete)\(/.test(bo));
  // The words on the page.
  for (const line of [
    'Checking with the card machine',
    'A payment that is still on the card machine is checked first. It is only released if it was not taken.',
  ]) {
    assert.ok(bo.includes(line), line);
    assert.ok(!/[–—]| - /.test(line), line);
  }
  // The outcome picks the colour: green only when nothing live remains.
  assert.ok(release.includes("setNotice({ where: 'advanced', kind: out.free ? 'ok' : 'error', text: out.lines[0], lines: out.lines.slice(1) });"));
});

test("the till's payment files are not part of the change: an old till reads the new cancel on its existing path", () => {
  const tj = read('./terminalJobs.js');
  const px = read('../../surfaces/PaxTerminal.jsx');
  // checkJobWithReader: a settled body (the cancel is one) is kind 'settled'; processing is in_progress.
  const check = between(tj, 'export async function checkJobWithReader(jobId) {', 'export async function abortTerminalJob(jobId) {');
  assert.ok(check.includes("const j = await callFn('adyen-terminal-charge', { action: 'result', job_id: jobId });"));
  assert.ok(check.includes("if (j?.state === 'processing') return { kind: 'in_progress', status: j?.status ?? null };"));
  assert.ok(check.includes("if (j?.ok === true && j?.job_status) return { kind: 'settled', body: j };"));
  // PaxTerminal: a settled answer re reads the row, and a cancelled row takes the failed path.
  assert.ok(px.includes("if (r.kind === 'settled') {"));
  assert.ok(px.includes("if (['declined', 'cancelled', 'expired'].includes(job.status)) {"));
  before(px, "if (['declined', 'cancelled', 'expired'].includes(job.status)) {", 'onFailedRef.current?.(job);', 'cancelled goes through onFailed');
  assert.ok(px.includes("cancelled:       { icon: '✋', title: 'Cancelled',                  sub: 'Nothing was charged.' },"));
  // The server's settled body carries the fields that path reads.
  assert.ok(charge.includes("ok: true, state, status: state, job_status: job.status,"));
});

test('the comments that promised a re send after "not found" are gone', () => {
  assert.ok(!kick.includes('the row resets to charging_unsent, where the'));
  assert.ok(!kick.includes("so does a 'result' NotFound revert."));
  assert.ok(!create.includes('never saw back to charging_unsent for the sweep to re-kick safely'));
  assert.ok(!charge.includes('Revert so\n      // the till can retry (the one branch where reverting in-flight is safe).'));
});
