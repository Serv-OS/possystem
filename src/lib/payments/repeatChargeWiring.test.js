/**
 * repeatChargeWiring.test.js (30 Sep 2026): the double charge net is WIRED, not only written.
 * Reads the real sources, like checkoutPaxWiring.test.js and terminalKick.test.js do, because
 * there is no Deno here to run terminal-job-create: a perfect _shared/repeatCharge.js is worth
 * nothing unless the create function runs it before the insert, honours repeat_ok_job_id, and
 * the checkout shows the answer and re-sends with the ack.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const before = (src, first, second, why) => {
  const a = src.indexOf(first);
  const b = src.indexOf(second);
  assert.ok(a >= 0, `${why}: missing ${first}`);
  assert.ok(b >= 0, `${why}: missing ${second}`);
  assert.ok(a < b, why);
};

const create = read('../../../supabase/functions/terminal-job-create/index.ts');
const charge = read('../../../supabase/functions/adyen-terminal-charge/index.ts');
const co = read('../../surfaces/CheckoutModal.jsx');
const tj = read('./terminalJobs.js');

test('terminal-job-create runs the repeat check BEFORE the insert, only for the sources repeatCharge.js names, failing open', () => {
  assert.ok(create.includes("from '../_shared/repeatCharge.js';"));
  before(create, 'if (shouldCheckRepeat(check_draft)) {', "let { data: inserted, error: insErr } = await opsAdmin\n    .from('terminal_jobs').insert(row)", 'check, then insert');
  // The sources are the pure module's, not a second list in the function.
  assert.ok(!/pos_send_to_terminal'\s*,\s*'mpos_cloud_terminal/.test(create), 'the source list lives in repeatCharge.js');
  // The read is bounded: this venue, this till or this reader, another check, the last window.
  assert.ok(create.includes(".neq('check_key', check_key)"));
  assert.ok(create.includes('REPEAT_WINDOW_MS'));
  assert.ok(create.includes("`pos_device_id.eq.${pos_device_id},target_terminal_id.eq.${target_terminal_id}`"));
  // Its closed_checks rows ride along for the booked state.
  assert.ok(create.includes(".select('id, ref, source, refunded, status, voided').in('id', checkIds)"));
  // Fail open: a read error is logged and the sale continues.
  assert.ok(create.includes("console.error('[terminal-job-create] repeat check skipped (read failed, failing open):'"));
});

test('same_basket is an ADVISORY on the 200 body (repeat_warning), shown on the card screen, never a 409 (review 30 Sep)', () => {
  assert.ok(create.includes('repeatWarning,'), 'imported');
  assert.ok(create.includes('repeatWarn = repeatWarning(hit, { tz });'));
  before(create, 'const refusal = repeatRefusal(hit, body.repeat_ok_job_id ?? null, { tz });', 'repeatWarn = repeatWarning(hit, { tz });', 'a refusal wins, then the advisory');
  assert.ok(create.includes("...(repeatWarn ? { repeat_warning: repeatWarn } : {}) });"), 'rides on the fresh insert answer');
  // The till hands it to the card screen.
  assert.ok(tj.includes('repeatWarning: j.repeat_warning ?? null };'));
  assert.ok(co.includes('const { job, kickError, serverKick, kickPending, kick, repeatWarning } = await dispatchTerminalJob({'));
  assert.ok(co.includes('setPaxAdvisory(repeatWarning || null);'));
  assert.ok(co.includes('advisory={paxAdvisory}'));
  const px = read('../../surfaces/PaxTerminal.jsx');
  assert.ok(px.includes('advisory = null }'), 'PaxTerminal takes it');
  assert.ok(px.includes("{advisory?.message && LIVE.includes(status) && ("), 'shown while the tender is live only');
});

test("adyen-terminal-charge 'result' never cancels a tender under 120 s from an empty ledger (the till now asks while the customer pays)", () => {
  const result = charge.slice(charge.indexOf("if (action === 'result') {"), charge.indexOf("if (cond === 'not_found') {"));
  assert.ok(result.includes('const tenderStalled = Date.now() - new Date(job.dispatched_at ?? job.created_at).getTime() > 120_000;'));
  assert.equal((result.match(/if \(v\.verdict === 'nothing' && !tenderStalled\) \{/g) || []).length, 2, 'the unreachable and the unknown branches both wait');
  before(result, "if (v.verdict === 'nothing' && !tenderStalled) {", "if (v.verdict === 'nothing') {", 'the guard comes before the cancel');
  assert.equal((result.match(/return json\(\{ ok: true, state: 'processing', status: job\.status \}\);/g) || []).length >= 4, true);
});

test('terminal-job-create answers 409 POSSIBLE_REPEAT (or TERMINAL_BUSY) with the detail, unless repeat_ok_job_id names that job; the ack is written to the draft', () => {
  assert.ok(create.includes('repeat_ok_job_id?: string;'));
  assert.ok(create.includes('const refusal = repeatRefusal(hit, body.repeat_ok_job_id ?? null, { tz });'));
  assert.ok(create.includes('if (refusal) {'));
  assert.ok(create.includes('detail: refusal.detail,'));
  assert.ok(create.includes("...(refusal.code === 'TERMINAL_BUSY' ? { busy_job_id: hit.job.job_id, busy_status: hit.job.status } : {}),"));
  assert.ok(create.includes('}, refusal.status);'));
  assert.ok(create.includes('repeatAck = repeatAckRecord(hit, {'));
  assert.ok(create.includes('check_draft: repeatAck ? { ...check_draft, repeatAck } : check_draft,'));
  // The message is formatted on the venue's clock.
  assert.ok(create.includes(".from('locations').select('timezone').eq('id', locationId).maybeSingle();"));
});

test('the 23505 TERMINAL_BUSY path carries the same detail (job id, amount, time, ref, items, adoptable)', () => {
  const busy = create.slice(create.indexOf('// 2. Terminal busy with another bill.'), create.indexOf('// 3. THE PRIMARY KEY.'));
  assert.ok(busy.includes("select('id, check_key, status, due_minor, charge_minor, currency, check_draft, pos_device_id, target_terminal_id, closed_check_id, card, created_at, dispatched_at, settled_at')"));
  assert.ok(busy.includes('const detail = repeatDetail(busy as Record<string, unknown>, null, { now: Date.now() });'));
  assert.ok(busy.includes("const adoptable = !!pos_device_id && busy.pos_device_id === pos_device_id && busyDraft.source === 'pos_send_to_terminal';"));
  assert.ok(busy.includes("code: 'TERMINAL_BUSY',"));
  assert.ok(busy.includes("detail: { tier: 'live', adoptable, same_items: false, subset_items: false, ...detail },"));
  assert.ok(busy.includes('error: repeatMessage(hit, {'));
});

test('adyen-terminal-charge writes ONE activity feed alert after an approved settle when the same card paid the same amount for another check', () => {
  assert.ok(charge.includes("from '../_shared/repeatCharge.js';"));
  const after = charge.slice(charge.indexOf('async function afterSettle('), charge.indexOf('// ── Settle from ADYEN'));
  assert.ok(after.includes("(settled as any)?.idempotent !== true"), 'exactly once across the sync/async settle race');
  assert.ok(after.includes('const prior = findSameCardRepeat(me, rows, Date.now());'));
  assert.ok(after.includes(".in('status', ['approved', 'reconciled'])"));
  assert.ok(after.includes(".eq('charge_minor', me.charge_minor)"));
  assert.ok(after.includes("severity: 'urgent',"));
  assert.ok(after.includes("ref_type: 'terminal_job', ref_id: jobId,"));
  assert.ok(after.includes("console.error('adyen-terminal-charge: double charge check skipped'"), 'advisory: never blocks a settle');
});

test('the till sends repeat_ok_job_id only when staff pressed "Different customer", once', () => {
  assert.ok(tj.includes("...(p.repeatOkJobId ? { repeat_ok_job_id: String(p.repeatOkJobId) } : {}),"));
  assert.ok(tj.includes("err.detail = j?.detail ?? null;"), 'the fn detail rides on the error');
  const startJob = co.slice(co.indexOf('const startTerminalJob = async () => {'), co.indexOf('// 30 Sep 2026: WATCH THAT PAYMENT.'));
  assert.ok(co.includes('const takeRepeatOk = () => { const id = repeatOkRef.current; repeatOkRef.current = null; return id; };'), 'read and forgotten in one step');
  assert.ok(startJob.includes('repeatOkJobId: takeRepeatOk(),'), 'sent on the create, once');
  assert.equal(startJob.split('takeRepeatOk()').length - 1, 1, 'one read per send');
  assert.ok(co.includes('const takePaymentAnyway = (jobId) => { repeatOkRef.current = jobId; setRepeatWarn(null); startTerminalJob(); };'));
});

test('the checkout shows the POSSIBLE_REPEAT dialog with Open <ref>, Clear this order and Different customer', () => {
  assert.ok(co.includes("if (e?.code === 'POSSIBLE_REPEAT' && detail?.job_id) {"));
  assert.ok(co.includes('setRepeatWarn({ ...detail, message: e.message'));
  assert.ok(co.includes('<button className="btn btn-sm" onClick={()=>openPriorCheck(repeatWarn.ref)} style={{ fontWeight:700 }}>Open {repeatWarn.ref}</button>'));
  assert.ok(co.includes('<button className="btn btn-sm" onClick={clearRepeatedOrder}>Clear this order</button>'));
  assert.ok(co.includes('<button className="btn btn-ghost btn-sm" onClick={()=>takePaymentAnyway(repeatWarn.job_id)}>Different customer, take payment</button>'));
  // Open lands on History searching that ref; Clear empties the walk in. Both close the checkout.
  // A gift card debited at dispatch goes back on the card first: nothing was sent to the reader.
  assert.ok(co.includes("const openPriorCheck = (ref) => { setRepeatWarn(null); reverseDispatchedGift('Card machine payment not sent (possible repeat)'); useStore.getState().openCheckHistoryFor?.(ref); onClose?.(); };"));
  assert.ok(co.includes("const clearRepeatedOrder = () => { setRepeatWarn(null); reverseDispatchedGift('Card machine payment not sent (possible repeat)'); useStore.getState().clearWalkIn?.(); onClose?.(); };"));
  const store = read('../../store/index.js');
  assert.ok(store.includes("openCheckHistoryFor: (ref) => set({ checkHistoryFocus: ref ? { ref: String(ref), at: Date.now() } : null }),"));
  assert.ok(read('../../surfaces/POSSurface.jsx').includes("useEffect(() => { if (_checkHistoryFocus?.ref) setRightTab('history'); }, [_checkHistoryFocus]);"));
  const hist = read('../../components/CheckHistory.jsx');
  assert.ok(hist.includes('setSearch(ref);'));
  assert.ok(hist.includes('useStore.getState().openCheckHistoryFor?.(null);'), 'the focus is cleared once used');
});

test('TERMINAL_BUSY with an adoptable job offers "Watch that payment", which books under the job\'s own check id and ref', () => {
  assert.ok(co.includes("} else if (e?.code === 'TERMINAL_BUSY') {"));
  assert.ok(co.includes('if (canWatchBusyJob(detail)) setBusyOffer(detail);'));
  // Only a counter sale this till sent, same amount, no gift staged here.
  assert.ok(co.includes('const canWatchBusyJob = (detail) => !!detail?.adoptable && !!detail?.job_id && !!detail?.closed_check_id'));
  assert.ok(co.includes('&& !tableId && !isBarTab && !paxGiftRef.current'));
  assert.ok(co.includes('&& Number(detail.due_minor) === toMinor(grand);'));
  const watch = co.slice(co.indexOf('const watchBusyPayment = async (detail) => {'), co.indexOf('const openPriorCheck'));
  assert.ok(watch.includes('const job = (await fetchJobs([detail.job_id]))?.[0] || null;'), 'the job row is re-read, never trusted from the error');
  // Review 30 Sep: WATCH FIRST. The reader can approve between the refusal and the tap; the
  // reconciler on this till must already be waiting when the row is read.
  before(watch, 'checkIdRef.current = detail.closed_check_id;', 'const job = (await fetchJobs([detail.job_id]))', 'the check id is taken over before the read');
  before(watch, 'checkIdRef.current = detail.closed_check_id;\n    watchThisCheck();', 'const job = (await fetchJobs([detail.job_id]))', 'watched before the read');
  assert.ok(watch.includes("if (job.status === 'approved' || job.status === 'reconciled') {"), 'an approved job is not mounted');
  assert.ok(watch.includes('That payment was approved and is being booked'));
  before(watch, 'That payment was approved and is being booked', 'onClose?.();', 'the checkout closes, leaving one writer');
  before(watch, "if (job.status === 'approved' || job.status === 'reconciled') {", "setScreen('pax_terminal');", 'the approved branch returns before the mount');
  assert.ok(watch.includes("const giveBack = () => { checkIdRef.current = ownCheckId; orderRefRef.current = ownOrderRef; watchThisCheck(); };"));
  assert.ok(watch.includes('    } catch (e) {\n      giveBack();'), 'any failure hands the checkout its own check id back');
  assert.ok(watch.includes('checkIdRef.current = job.closed_check_id;'));
  assert.ok(watch.includes('if (jobRef) orderRefRef.current = jobRef;'));
  assert.ok(watch.includes('setPaxAdopted(true);'), 'the card screen treats the adopted tender like an open kick');
  before(watch, 'checkIdRef.current = job.closed_check_id;', "setScreen('pax_terminal');", 'the watch is re-keyed to the adopted check before the card screen shows');
  assert.ok(watch.includes("if (['declined', 'cancelled', 'expired'].includes(job.status)) {"), 'a settled failure is said, not watched');
  assert.ok(watch.includes("if (job.status === 'unknown') throw new Error("));
  assert.ok(co.includes('<button className="btn btn-sm" disabled={paxBusy} onClick={()=>watchBusyPayment(busyOffer)} style={{ fontWeight:700 }}>Watch that payment</button>'));
  assert.ok(co.includes('Or cancel it on the card machine first.'));
});

test('staff copy: no em or en dashes as punctuation in the new checkout wording', () => {
  for (const line of [
    'Already paid?', 'Clear this order', 'Different customer, take payment', 'Watch that payment',
    'Or cancel it on the card machine first.',
    'That payment needs a manager to check it in Back Office before anything else is taken.',
    'Could not read that payment. Check the card machine.',
    'That payment was approved and is being booked',
    '. Do not take payment again.',
  ]) {
    assert.ok(co.includes(line), line);
    assert.ok(!/[–—]/.test(line), line);
  }
});
