// src/lib/campaignBatch.test.js (29 Oct 2026, v5.11.117): a quick send to thousands goes out in batches,
// time boxed and resumable, and nobody gets the same campaign twice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  chunk, claimDecision, outOfTime, sendOutcome, resendBatchItems, runStalled, blastProgress,
  EMAIL_BATCH, RESEND_BATCH_GAP_MS,
} from '../../supabase/functions/_shared/campaignBatch.js';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const NOW = Date.parse('2026-10-29T19:00:00Z');

test('8,820 recipients become 89 Resend batches of at most 100, two a second', () => {
  const parts = chunk(Array.from({ length: 8820 }, (_, i) => i), EMAIL_BATCH);
  assert.equal(parts.length, 89);
  assert.equal(parts[0].length, 100);
  assert.equal(parts[88].length, 20);
  assert.ok(RESEND_BATCH_GAP_MS >= 500, 'Resend allows two requests a second');
  assert.deepEqual(chunk([], 100), []);
});

test('a recipient is claimed once: sent, partial and skipped rows are never resent', () => {
  assert.equal(claimDecision(null, { nowMs: NOW }), 'claim');
  for (const status of ['sent', 'partial', 'skipped']) assert.equal(claimDecision({ status, created_at: new Date(NOW - 1000).toISOString() }, { nowMs: NOW }), 'skip', status);
  assert.equal(claimDecision({ status: 'failed' }, { nowMs: NOW }), 'reclaim', 'a failed attempt is tried again');
});

test('a pending row: our own run continues it, a crashed run is taken over after five minutes, a live run is left alone', () => {
  const fresh = { status: 'pending', run_id: 'run-A', created_at: new Date(NOW - 30 * 1000).toISOString() };
  assert.equal(claimDecision(fresh, { ownRunId: 'run-A', nowMs: NOW }), 'reclaim', 'the continuation of run A');
  assert.equal(claimDecision(fresh, { ownRunId: 'run-B', nowMs: NOW }), 'skip', 'run A still owns it');
  const old = { ...fresh, created_at: new Date(NOW - 6 * 60 * 1000).toISOString() };
  assert.equal(claimDecision(old, { ownRunId: 'run-B', nowMs: NOW }), 'reclaim', 'run A died');
});

test('the time box: a run stops sending once its budget is spent', () => {
  assert.equal(outOfTime(NOW, NOW + 79_000, 80_000), false);
  assert.equal(outOfTime(NOW, NOW + 80_000, 80_000), true);
});

test('one recipient status from the channel results', () => {
  assert.equal(sendOutcome([{ ok: true, status: 'sent' }]), 'sent');
  assert.equal(sendOutcome([{ ok: true, status: 'sent' }, { ok: false, status: 'no_consent' }]), 'partial');
  assert.equal(sendOutcome([{ ok: false, status: 'no_consent' }]), 'skipped', 'terminal: a gate, not a fault');
  assert.equal(sendOutcome([{ ok: false, status: 'failed' }]), 'failed', 'reclaimable: the provider refused');
  assert.equal(sendOutcome([]), 'skipped');
});

test('the Resend batch body carries every mail in order with the unsubscribe headers and never more than 100', () => {
  const sender = { from: 'Coffee Boy <hello@coffeeboy.co.uk>', email: 'hello@coffeeboy.co.uk', replyTo: 'reply@coffeeboy.co.uk' };
  const mails = Array.from({ length: 120 }, (_, i) => ({ to: `c${i}@example.com`, subject: `Hi ${i}`, html: '<p>x</p>', text: 'x', listUnsub: i === 0 ? 'https://u/1' : null }));
  const items = resendBatchItems(mails, sender);
  assert.equal(items.length, 100);
  assert.equal(items[0].to, 'c0@example.com');
  assert.equal(items[0].headers['List-Unsubscribe'], '<https://u/1>');
  assert.equal(items[0].headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  assert.equal(items[1].headers, undefined);
  assert.equal(items[99].reply_to, 'reply@coffeeboy.co.uk');
});

test('a stalled run is one still marked running, unfinished, older than the limit', () => {
  assert.equal(runStalled({ status: 'running', run_at: new Date(NOW - 4 * 60 * 1000).toISOString() }, NOW), true);
  assert.equal(runStalled({ status: 'running', run_at: new Date(NOW - 60 * 1000).toISOString() }, NOW), false);
  assert.equal(runStalled({ status: 'done', run_at: new Date(NOW - 60 * 60 * 1000).toISOString() }, NOW), false);
  assert.equal(runStalled({ status: 'running', run_at: new Date(NOW - 60 * 60 * 1000).toISOString(), finished_at: 'x' }, NOW), false);
});

test("tonight's campaign as the screen will show it", () => {
  assert.deepEqual(blastProgress({ sent: 10, failed: 1242, skipped: 20, pending: 3 }), { done: 1272, pending: 3, total: 1275, sent: 10, failed: 1242, skipped: 20 });
});

test('the engine claims in bulk, sends through deliverBatch, time boxes and resumes; no per recipient HTTP call remains', () => {
  const src = read('supabase/functions/_shared/campaign-engine.ts');
  assert.ok(src.includes("import { deliverBatch } from './marketingDeliver.ts';"));
  assert.ok(!src.includes("`${opts.supabaseUrl}/functions/v1/marketing-send`") || !/await sendOne\(/.test(src), 'sendOne is no longer called per recipient');
  assert.ok(src.includes("{ onConflict: 'campaign_id,customer_id,dedupe_key', ignoreDuplicates: true })\n        .select('id, customer_id')"), 'bulk claim');
  assert.ok(src.includes("claimDecision(r, { ownRunId: runId, nowMs })"), 'reclaim by the one rule');
  assert.ok(src.includes("if (outOfTime(startedMs, Date.now(), budgetMs)) break;"), 'time boxed');
  assert.ok(src.includes("summary.status = 'running';\n      return summary;"), 'a time boxed run stays running with the rest pending');
  assert.ok(src.includes('export async function resumeStalledRuns('), 'the cron can resume');
  // Peter 29 Oct: a quick send has no schedule. The hour job never resumes an ephemeral campaign.
  const rs = src.slice(src.indexOf('export async function resumeStalledRuns('));
  assert.ok(rs.includes('if (c.ephemeral === true) {') && rs.indexOf('if (c.ephemeral === true) {') < rs.indexOf('resumeRunId: run.id'), 'a quick send is closed, not resumed');
  assert.ok(src.includes("if (opts.resumeRunId) {"), 'a continuation reuses its run');
});

test('marketing-campaigns continues a blast by itself and the screen can continue or follow it', () => {
  const fn = read('supabase/functions/marketing-campaigns/index.ts');
  for (const a of ["action === 'blast_continue'", "action === 'blast_status'", "action === 'blast_recent'"]) assert.ok(fn.includes(a), a);
  assert.ok(fn.includes('deadlineMs: DEFAULT_BUDGET_MS'), 'blast_send is time boxed');
  assert.ok(fn.includes('if (continuing) continueLater(ops, camp.id, summary.run_id || null);'));
  assert.ok(fn.includes("rt.waitUntil(p)"), 'the continuation outlives the response');
  const run = read('supabase/functions/marketing-run/index.ts');
  assert.ok(run.includes('await resumeStalledRuns(sb, opts)'));
  const ui = read('src/backoffice/sections/marketing/QuickSend.jsx');
  assert.ok(ui.includes("action: 'blast_status'") && ui.includes("action: 'blast_continue'") && ui.includes("action: 'blast_recent'"));
  assert.ok(ui.includes('Continue sending'));
});

test('the batch sender keeps every gate of the single path: suppression, consent, reachability, dedupe, footer, one record each', () => {
  const d = read('supabase/functions/_shared/marketingDeliver.ts');
  for (const needle of ["from('marketing_suppressions')", "from('customer_consents')", "in('idempotency_key'", "status: 'unreachable'", "status: 'no_consent'", "status: 'suppressed'", 'listUnsub: s.link', "https://api.resend.com/emails/batch", "from('marketing_messages').insert(rows)"]) {
    assert.ok(d.includes(needle), needle);
  }
  assert.ok(d.includes("if (res.status === 429 || res.status >= 500) throw"), 'rate limited or down: retry; anything else is final');
});
