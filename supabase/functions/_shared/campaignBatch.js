// supabase/functions/_shared/campaignBatch.js (29 Oct 2026, v5.11.117). PURE, no imports: node tests
// load it directly and the engine, the campaigns function and the cron share one rule.
//
// WHY. Coffee Boy's first big blast (8,820 recipients) sent 10 emails. The engine called our own
// marketing-send function once per recipient, six at a time; Supabase rate limits calls between
// functions ("Rate limit exceeded for trace ... Retry after"), so 1,242 failed, and then the run
// overran the function's time limit and the Back Office got "Edge Function returned a non-2xx".
//
// THE RULES. Recipients are sent in batches (one Resend batch request per 100 emails), a run is
// time boxed and leaves its unsent rows 'pending' under its own run id, and a continuation (the
// same function calling itself, or the hourly cron) picks those rows up. A recipient is never sent
// twice: the claim row and the provider idempotency key both pin that.

export const EMAIL_BATCH = 100;            // Resend batch endpoint maximum
export const SMS_BATCH = 25;               // Twilio has no batch; small groups between time checks
export const RESEND_BATCH_GAP_MS = 650;    // Resend allows 2 requests a second; one batch every 650 ms
export const SMS_GAP_MS = 120;
export const STALE_PENDING_MS = 5 * 60 * 1000;
export const DEFAULT_BUDGET_MS = 80 * 1000;   // well inside the edge function wall clock
export const STALLED_RUN_MS = 3 * 60 * 1000;  // a 'running' run older than this with pending rows is resumed by the cron

export function chunk(items, size) {
  const out = [];
  const n = Math.max(1, Math.floor(Number(size) || 1));
  const list = Array.isArray(items) ? items : [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

/**
 * What to do with an existing campaign_sends row for this recipient.
 * 'claim'   no row: insert and send
 * 'reclaim' a failed attempt, a pending row this run owns (a continuation), or a pending row older
 *           than five minutes (a crashed run): send again under this run
 * 'skip'    sent, partial or skipped (terminal), or a fresh pending row another run owns
 */
export function claimDecision(existing, { ownRunId = null, nowMs = Date.now(), staleMs = STALE_PENDING_MS } = {}) {
  if (!existing) return 'claim';
  const st = String(existing.status || '');
  if (st === 'sent' || st === 'partial' || st === 'skipped') return 'skip';
  if (st === 'failed') return 'reclaim';
  if (st === 'pending') {
    if (ownRunId && existing.run_id === ownRunId) return 'reclaim';
    const age = nowMs - new Date(existing.created_at || 0).getTime();
    return Number.isFinite(age) && age > staleMs ? 'reclaim' : 'skip';
  }
  return 'skip';
}

export function outOfTime(startedMs, nowMs, budgetMs) {
  return nowMs - startedMs >= Math.max(1000, Number(budgetMs) || DEFAULT_BUDGET_MS);
}

/** One recipient's campaign_sends status from its per channel results. */
export function sendOutcome(perChannel) {
  const list = Array.isArray(perChannel) ? perChannel : [];
  const ok = list.some((r) => r && r.ok);
  const failed = list.some((r) => r && !r.ok && r.status === 'failed');
  const gated = list.some((r) => r && !r.ok && r.status !== 'failed');
  if (ok && (failed || gated)) return 'partial';
  if (ok) return 'sent';
  if (failed) return 'failed';          // reclaimable on the next run
  return 'skipped';                     // no consent, suppressed, unreachable: terminal
}

/** The body of one Resend batch request: at most EMAIL_BATCH mails, in the order given. */
export function resendBatchItems(mails, sender) {
  const list = (Array.isArray(mails) ? mails : []).slice(0, EMAIL_BATCH);
  return list.map((m) => ({
    from: sender.from,
    to: m.to,
    subject: m.subject || '(no subject)',
    html: m.html || '',
    ...(m.text ? { text: m.text } : {}),
    ...(m.listUnsub ? { headers: { 'List-Unsubscribe': `<${m.listUnsub}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } } : {}),
    ...(sender.replyTo ? { reply_to: sender.replyTo } : {}),
  }));
}

/** Is a 'running' run stalled (no finish, older than the limit)? The cron resumes those. */
export function runStalled(run, nowMs = Date.now(), limitMs = STALLED_RUN_MS) {
  if (!run || run.status !== 'running' || run.finished_at) return false;
  const age = nowMs - new Date(run.run_at || run.created_at || 0).getTime();
  return Number.isFinite(age) && age > limitMs;
}

/** Progress for a screen: how many are done, how many are still to go. */
export function blastProgress(counts) {
  const c = counts || {};
  const n = (k) => Number(c[k] || 0);
  const done = n('sent') + n('partial') + n('skipped') + n('failed');
  return { done, pending: n('pending'), total: done + n('pending'), sent: n('sent') + n('partial'), failed: n('failed'), skipped: n('skipped') };
}
