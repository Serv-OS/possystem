// supabase/functions/terminal-job-reconcile
//
// The PaxPay sweeper. Runs on a schedule (cron) under the SERVICE ROLE.
//
// WHAT IT DOES — and, more importantly, WHAT IT NEVER DOES
//   It resolves expired leases and nothing else. It NEVER starts a charge, NEVER
//   retries one, and NEVER re-issues a start-transaction. A timeout is an
//   UNKNOWN, not a failure: re-issuing is precisely how you double-charge a
//   customer (spec money-safety rules 6 and 7).
//
//     pending / claimed / tipping  -> expired    nothing was ever sent; safe
//     charging_unsent              -> cancelled  tip taken, request never sent; safe
//     charging                     -> unknown    dispatched, outcome unestablished
//                                                => needs_human, quarantined
//
//   'unknown' is a first-class terminal state. It is never auto-retried (double
//   charge) and never dropped (lost sale). A human resolves it from the Back
//   Office queue, and only then via terminal_job_reconcile().
//
//   It also does NOT reverse gift cards on an unknown job. Reversing against a
//   charge that may have succeeded loses the money the other way; it blocks in
//   both directions until a human decides (spec rule 8).
//
// HONEST GAP, DELIBERATELY LEFT OPEN
//   Until the Ryft G8:Cloud REST spec lands we cannot ASK the processor what
//   happened to a given transaction. So this sweeper cannot establish an outcome
//   — it can only quarantine. A PAX that is lost, wiped or dies mid-charge is
//   recoverable by hand against the Ryft dashboard and nowhere else. That is
//   bounded and pilot-only, and it must be in the runbook rather than discovered
//   by an operator. When lookupByReference() exists, the query goes in the
//   marked block below and unknowns start resolving themselves.
//
//   POST {}                                   → sweep (default)
//   POST { action: 'resolve', job_id, outcome, note }
//                                             → relay a HUMAN verdict
//
// Auth: service role ONLY. Both RPCs re-check the JWT role in the database, so
// this fence is belt and braces.
//
// Spec: docs/PAXPAY_TRANSPORT_SPEC.md § "Money-safety rules", § "Risks".

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const opsAdmin = createClient(Deno.env.get('SUPABASE_URL') ?? '', SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false },
});

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  // Service role only. No user token, no anon token, ever — this function's
  // verdicts are the last word on whether money moved.
  const token = (req.headers.get('Authorization') ?? '').replace('Bearer ', '').trim();
  if (!token || token !== SERVICE_ROLE) return json({ error: 'unauthorized' }, 401);

  let body: any = {};
  try { body = await req.json(); } catch { body = {}; }

  // ── relay a human verdict on a quarantined job ─────────────────────────────
  if (body?.action === 'resolve') {
    const { job_id, outcome, note } = body;
    if (!job_id || !outcome) return json({ error: 'job_id and outcome required' }, 400);
    const { data, error } = await opsAdmin.rpc('terminal_job_reconcile', {
      p_job_id: job_id, p_outcome: outcome, p_note: note ?? null,
    });
    if (error) return json({ error: error.message }, 400);
    return json(data ?? { ok: false });
  }

  // ── sweep ──────────────────────────────────────────────────────────────────
  const { data: swept, error: sweepErr } = await opsAdmin.rpc('terminal_jobs_sweep', {
    p_limit: Math.min(Number(body?.limit) || 200, 500),
  });
  if (sweepErr) return json({ error: sweepErr.message }, 500);

  // ─────────────────────────────────────────────────────────────────────────
  // BLOCKED ON RYFT — the recovery query goes here.
  //
  // When G8:Cloud exposes "look up a transaction by our own merchant reference"
  // (open question 3 in the spec — a go-live blocker), load the jobs now sitting
  // in 'unknown', call lookupByReference(job.id), and relay the answer through
  // terminal_job_reconcile(). Until then we quarantine and stop. Do NOT be
  // tempted to infer an outcome from elapsed time or from the absence of a
  // result — an inferred verdict on a real card is a double charge or a lost
  // sale, and this queue is exactly where those get made.
  // ─────────────────────────────────────────────────────────────────────────

  const { count } = await opsAdmin
    .from('terminal_jobs')
    .select('id', { count: 'exact', head: true })
    .eq('needs_human', true)
    .eq('status', 'unknown');

  return json({
    ok: true,
    swept,
    awaiting_human: count ?? 0,
    // Surfaced so the runbook/alerting can see it without reading this source.
    processor_lookup_available: false,
  });
});
