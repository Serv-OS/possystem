/**
 * readerTipWiring.test.js - source pins for the v5.11.16 reader tip fix (R3618), in the
 * terminalKick.test.js style: the edge functions are Deno and cannot run here, so the
 * wiring that makes the pure rules matter is pinned in their source.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(`../../../${rel}`, import.meta.url), 'utf8');
const charge = read('supabase/functions/adyen-terminal-charge/index.ts');
const webhook = read('supabase/functions/adyen-webhook/index.ts');
const events = read('supabase/functions/adyen-terminal-events/index.ts');
const localTerminal = read('src/lib/payments/adyenLocalTerminal.js');

const fnBody = (src, header) => {
  const start = src.indexOf(header);
  assert.ok(start >= 0, `missing: ${header}`);
  const next = src.indexOf('\nasync function ', start + header.length);
  const nextFn = src.indexOf('\nfunction ', start + header.length);
  const ends = [next, nextFn, src.indexOf('\nconst ', start + header.length)].filter((i) => i > 0);
  return src.slice(start, Math.min(...ends));
};

test('settleFromResponse: a tip it cannot record defers BEFORE the settle RPC, and no unchecked tip write is left', () => {
  const body = fnBody(charge, 'async function settleFromResponse(');
  const deferAt = body.indexOf('throw new SettleDeferred(');
  const settleAt = body.indexOf('settleRpcWithRetry(opsAdmin');
  assert.ok(deferAt > 0 && settleAt > deferAt, 'SettleDeferred must come before the settle');
  assert.match(body, /recordTipWithRetry\(opsAdmin, \{ jobId, tipMinor: tip, authorizedMinor: p\.authorizedMinor, chargeMinor \}\)/);
  assert.ok(!/\.update\(\{ tip_minor: tip, charge_minor: p\.authorizedMinor \}\)/.test(charge), 'the old fire and forget write is gone');
  assert.ok(!/rpc\('terminal_job_settle_from_processor'/.test(charge), 'every settle goes through settleRpcWithRetry');
  assert.match(body, /reportParkedMismatch\(opsAdmin, platformAdmin, jobId, settled,/);
});

test('the broken settleCard(job.id, ...) recovery calls are gone; result settles from the ledger', () => {
  assert.ok(!charge.includes('settleCard(job.id'), 'settleCard is the one argument card mapper');
  assert.match(charge, /await settleFromLedger\(job, early\.row, \{ allowPark: false \}\)/);
  assert.match(charge, /await settleFromLedger\(job, after\.row, \{ allowPark: true \}\)/);
});

test('every settle call site answers SETTLE_DEFERRED as 200 processing, never a 500', () => {
  const handler = charge.slice(charge.indexOf('Deno.serve('));
  const sites = handler.split(/await settleFrom(?:Response|Ledger)\(/).length - 1;
  const guarded = handler.split('isSettleDeferred(e)').length - 1;
  assert.ok(sites >= 6, `settle sites ${sites}`);
  assert.ok(guarded >= sites - 1, `guards ${guarded} for ${sites} sites`);
  assert.match(charge, /const deferredBody = \(status: string\) => json\(\{ ok: true, state: 'processing', status, code: 'SETTLE_DEFERRED' \}\)/);
  // report_local: Adyen's own answer deferring must not fall through to the device's claim.
  assert.match(charge, /if \(isSettleDeferred\(e\)\) return deferredBody\(job\.status\);\s*\/\* cloud unreachable/);
});

test('askAdyenLedger: an unreadable ledger never reads as "nothing charged"', () => {
  const body = fnBody(charge, 'async function askAdyenLedger(');
  assert.match(body, /if \(error\) return \{ verdict: 'too_soon' \}/);
  assert.match(body, /if \(pick\.ambiguous\) return \{ verdict: 'too_soon', ambiguous: true \}/);
  // After the abort only a PROVEN empty ledger cancels.
  assert.match(charge, /\} else if \(after\.verdict === 'nothing'\) \{/);
});

test('sweep_unsent runs the reader tip sweep first, under waitUntil', () => {
  const block = charge.slice(charge.indexOf("if (action === 'sweep_unsent') {"));
  const sweepAt = block.indexOf('runReaderTipSweep(locationId)');
  const unsentSelectAt = block.indexOf(".eq('processor', 'adyen').eq('status', 'charging_unsent')");
  assert.ok(sweepAt > 0 && unsentSelectAt > sweepAt, 'before any early return of the unsent sweep');
  assert.match(block.slice(sweepAt, unsentSelectAt), /rt\.waitUntil\(tipSweep\)/);
  const sweep = fnBody(charge, 'async function runReaderTipSweep(');
  assert.match(sweep, /settleFromLedger\(j, row, \{ allowPark, source: 'adyen_ledger_sweep' \}\)/);
  assert.match(sweep, /healReaderTip\(opsAdmin, platformAdmin, j\.id, \{ trigger: 'sweep', now \}\)/);
  assert.match(sweep, /correctHealedSale\(opsAdmin, platformAdmin, j, \{ trigger: 'sweep' \}\)/);
  assert.match(sweep, /if \(!row \|\| row\.success !== true\) continue;/, 'success rows only: declines stay with the reader ask');
});

test('adyen-webhook heals only on the live applied AUTHORISATION path, never in the backfill', () => {
  const backfill = webhook.slice(webhook.indexOf('async function runBackfill('), webhook.indexOf('Deno.serve('));
  assert.ok(!backfill.includes('healReaderTip'), 'a backfill must never mass heal');
  const live = webhook.slice(webhook.indexOf('Deno.serve('));
  assert.equal(live.split('healReaderTip(').length - 1, 1);
  assert.match(live, /if \(res === 'applied' && String\(item\.eventCode \|\| ''\) === 'AUTHORISATION' && String\(item\.success\) === 'true'\) \{/);
  assert.match(live, /jobIdFromMerchantReference\(item\.merchantReference\)/);
  assert.match(live, /rt\.waitUntil\(heal\)/);
});

test('adyen-terminal-events records the tip with the same retry, and skips the settle if it cannot', () => {
  assert.match(events, /recordTipWithRetry\(opsAdmin, \{ jobId: tj\.id, tipMinor: tip, authorizedMinor: parsed\.authorizedMinor, chargeMinor \}\)/);
  assert.ok(!/\.update\(\{ tip_minor: tip, charge_minor: parsed\.authorizedMinor \}\)/.test(events));
  assert.match(events, /if \(rec === 'unrecorded'\) \{\s*deferred = true;/);
  assert.match(events, /if \(!deferred\) \{\s*try \{\s*settled = await settleRpcWithRetry\(/);
  assert.ok(!/rpc\('terminal_job_settle_from_processor'/.test(events));
});

test('the MPOS local flow treats a deferred report as pending recovery, never "declined"', () => {
  assert.match(localTerminal, /if \(reported\?\.state !== 'processing'\) return reported;/);
});

test('result, NotFound: a job Adyen approved is never reverted to "never received" (review: the ledger skip fall through)', () => {
  const block = charge.slice(charge.indexOf("if (cond === 'not_found') {"));
  const guardAt = block.indexOf('if (ledgerApproved) {');
  const revertAt = block.indexOf(".update({ status: 'charging_unsent', nexo_service_id: null");
  assert.ok(guardAt > 0 && revertAt > guardAt, 'the ledger guard comes before the revert');
  const guard = block.slice(guardAt, revertAt);
  assert.match(guard, /settleFromLedger\(job, \(lg as any\)\.row, \{ allowPark: true \}\)/);
  assert.match(guard, /return json\(\{ ok: true, state: 'processing'/, 'otherwise it stays in flight, never charging_unsent');
  // The ledger is asked again when the early look had nothing: a row may have landed since.
  assert.match(block.slice(0, guardAt), /: await askAdyenLedger\(job\)/);
  assert.match(block.slice(0, guardAt), /const ledgerApproved = ledgerShowsApproval\(lg as any\);/);
});

test('settleFromLedger: an HMAC verified AUTHORISATION only, checked before any write', () => {
  const body = fnBody(charge, 'async function settleFromLedger(');
  const verifyAt = body.indexOf('await ledgerRowVerified(opsAdmin, row, job.id)');
  assert.ok(verifyAt > 0);
  assert.ok(body.indexOf('recordTipWithRetry(') > verifyAt && body.indexOf('settleRpcWithRetry(') > verifyAt);
  assert.match(body, /if \(verified !== true\) \{/);
  // The reader's own TipAmount evidence is consulted for an amount the bound cannot explain.
  assert.match(body, /readTipEvidence\(platformAdmin, job\.id\)/);
  assert.match(body, /`tip-unrecorded-ledger:\$\{job\.id\}:/, 'a ledger derived tip never poses as reader evidence');
});

test('the reader evidence is stored under ONE fixed key recovery can read back', () => {
  assert.match(fnBody(charge, 'async function settleFromResponse('), /logDurable\(platformAdmin, tipEvidenceKey\(jobId\), \{/);
  assert.match(events, /logDurable\(platformAdmin, tipEvidenceKey\(tj\.id\), \{/);
  assert.ok(!/`tip-unrecorded:\$\{/.test(charge) && !/`tip-unrecorded:\$\{/.test(events));
});

test('the sweep never settles a job the till gave up on, alerts reversals, and takes the newest first', () => {
  const sweep = fnBody(charge, 'async function runReaderTipSweep(');
  const unknownAt = sweep.indexOf("if (j.status === 'unknown') {");
  const settleAt = sweep.indexOf("settleFromLedger(j, row, { allowPark, source: 'adyen_ledger_sweep' })");
  assert.ok(unknownAt > 0 && settleAt > unknownAt);
  const unknownBlock = sweep.slice(unknownAt, settleAt);
  assert.ok(!unknownBlock.includes('settleFromLedger') && !unknownBlock.includes('settleRpcWithRetry'));
  assert.match(unknownBlock, /alertOnce\(opsAdmin, platformAdmin, j, 'confirmed_late', facts\)/);
  assert.match(unknownBlock, /continue;/);
  const reversedAt = sweep.indexOf("const approval = ledgerApproval(row);");
  assert.ok(reversedAt > 0 && reversedAt < unknownAt, 'a reversed row is caught before either branch');
  assert.match(sweep, /alertOnce\(opsAdmin, platformAdmin, j, 'reversed'/);
  assert.equal(sweep.split("{ ascending: false }").length - 1, 3, 'all three selects newest first');
  assert.ok(!sweep.includes('{ ascending: true }'));
  assert.match(sweep, /'id, location_id, processor, [^']*/);
  assert.match(sweep, /closed_check_id, check_key, check_draft/, 'check_key: a split leg finds its final leg');
});

test('adyen-webhook: a LIVE item without a signature is refused, a test item keeps null', () => {
  assert.match(webhook, /if \(!item\?\.additionalData\?\.hmacSignature\) return \{ valid: live \? false : null, region: null \};/);
});

test('the header no longer promises a webhook settle backstop that does not exist', () => {
  assert.ok(!charge.includes('the AUTHORISATION webhook backstop in adyen-webhook, the sweeper'));
  assert.match(charge, /adyen-webhook does NOT\s*\n\/\/\s*settle jobs/);
});
