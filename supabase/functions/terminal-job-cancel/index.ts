// supabase/functions/terminal-job-cancel
//
// The POS's "cancel this terminal payment" — the ONE path that both stops the job
// AND aborts the LIVE in-person action on the Ryft PAX.
//
// THE BUG THIS FIXES (v5.5.871)
//   Before this, the POS cancel called ONLY the terminal_job_cancel RPC. That RPC
//   flips a PRE-charge row (pending/claimed/tipping) to 'cancelled', but REFUSES
//   once charged_at is set (terminal_commit_tip stamps it before the controller
//   launches). Nothing then voided the live action at Ryft — so the card prompt
//   stayed up on the terminal, and a force-close/relaunch of paxpay resurrected the
//   unfinished payment. This function closes that gap by actually calling Ryft's
//   in-person cancel-action.
//
// FLOW
//   1. Run terminal_job_cancel AS THE CALLER (its own fence: a device at the job's
//      location, or a BO user). Pre-charge → 'cancelled', done — no Ryft action ever
//      existed. A raise means "no access" → 401/403.
//   2. If the RPC refuses because the job is live, abort the in-person action at Ryft
//      (cancelTerminalAction) and settle from the SESSION VERDICT — never from staff
//      intent. Money-safety: a card that captured despite the cancel is 'approved'
//      (ALREADY_CAPTURED → refund, never "cancelled"); a voided/declined session
//      settles 'declined'; still-processing is left for the result poll / sweeper.
//
// This mirrors ryft-terminal-cancel (which only voids, never touches the job) but
// resolves the Ryft terminal + settles the job the way terminal-job-charge does.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { cancelTerminalAction, getPaymentSession, ryftConfigured } from '../_shared/ryft.ts';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const opsAdmin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const platformAdmin = createClient(
  Deno.env.get('PLATFORM_SUPABASE_URL') ?? '',
  Deno.env.get('PLATFORM_SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const SETTLED = ['approved', 'declined', 'cancelled', 'expired', 'reconciled'];
const settledState = (s: string) => (s === 'reconciled' ? 'approved' : s === 'expired' ? 'cancelled' : s);

// Ryft session status → outcome. Port of terminal-job-charge's stateOf: the enum
// has no 'Declined' (a declined tap stays PendingPayment with lastError), and
// Approved/Captured beat a stale lastError from an earlier attempt.
function stateOf(status: string, lastError?: string | null): 'processing' | 'succeeded' | 'failed' {
  if (status === 'Approved' || status === 'Captured') return 'succeeded';
  if (status === 'Voided') return 'failed';
  if (lastError) return 'failed';
  return 'processing';
}

// UK card-receipt block — best-effort, port of terminal-job-charge's cardOf.
function cardOf(d: any): { card: Record<string, unknown> | null; authCode: string | null; txnId: string | null } {
  let card: Record<string, unknown> | null = null;
  let authCode: string | null = null;
  let txnId: string | null = null;
  try {
    const pm = d?.paymentMethod ?? {};
    const c = pm.card ?? d?.card ?? {};
    const tx = d?.lastPaymentTransaction ?? d?.transaction ?? {};
    const brand = c.scheme ?? c.brand ?? pm.scheme ?? null;
    const last4 = c.last4 ?? c.lastFour ?? null;
    authCode = tx.approvalCode ?? tx.authorizationCode ?? d?.approvalCode ?? d?.authorizationCode ?? null;
    txnId = tx.id ?? null;
    if (brand || last4 || authCode) {
      card = { brand, last4, auth_code: authCode, read_method: d?.entryMode ?? tx.entryMode ?? null, aid: null, application_name: null, cvm: null, account_type: null };
    }
  } catch { /* best-effort */ }
  return { card, authCode, txnId };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const token = (req.headers.get('Authorization') ?? '').replace('Bearer ', '').trim();
  if (!token) return json({ error: 'unauthorized' }, 401);

  let body: { job_id?: string };
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const jobId = String(body.job_id ?? '');
  if (!jobId) return json({ error: 'job_id required' }, 400);

  // ── 1. Fenced pre-charge cancel, AS THE CALLER ──────────────────────────────
  // terminal_job_cancel raises on no-access and, for a not-yet-charging job,
  // flips it to 'cancelled'. Delegating the fence here means we never diverge from
  // the RPC's own auth rules (device at the location, or a BO user).
  const caller = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: rpcRes, error: rpcErr } = await caller.rpc('terminal_job_cancel', { p_job_id: jobId });
  if (rpcErr) {
    const msg = rpcErr.message || 'cancel failed';
    const code = /no session/i.test(msg) ? 401 : /no access/i.test(msg) ? 403 : 400;
    return json({ error: msg }, code);
  }
  // ok:true → pre-charge, cancelled cleanly, no live Ryft action existed.
  if (rpcRes?.ok) return json({ ok: true, state: 'cancelled', status: 'cancelled', phase: 'pre_charge' });

  // The caller is authorised (the RPC didn't raise) but the job is LIVE or settled.
  if (!ryftConfigured()) return json({ error: 'Ryft not configured — set RYFT_SECRET_KEY' }, 500);

  const { data: job, error: jobErr } = await opsAdmin
    .from('terminal_jobs').select('*').eq('id', jobId).maybeSingle();
  if (jobErr) return json({ error: jobErr.message }, 500);
  if (!job) return json({ error: 'job not found' }, 404);

  // Already resolved — report it, never re-void.
  if (SETTLED.includes(job.status)) {
    const st = settledState(job.status);
    return json({ ok: true, state: st, status: st, job_status: job.status, phase: 'already_settled' });
  }

  // Resolve the Ryft hardware id + sub-account (mirror terminal-job-charge's
  // reconcile: payment_devices is the source of truth the working path trusts, so
  // an ops column that went stale on a re-pair can't send the void to the wrong
  // terminal / a terminal Ryft no longer knows).
  const { data: term } = await opsAdmin
    .from('terminal_devices').select('id, ryft_terminal_id')
    .eq('id', job.target_terminal_id).maybeSingle();

  // v5.5.905 — RECONCILE FIRST, THEN FAIL CLOSED. This used to return 409 terminal_not_linked
  // BEFORE the payment_devices reconcile below, which meant cancel refused in exactly the
  // drift case the reconcile exists to repair: an ops row whose ryft_terminal_id went stale
  // or null on a re-pair. Refusing to cancel leaves a LIVE card prompt on the terminal with
  // no way to call it off — the worst possible failure for this endpoint. The platform
  // payment_devices row is the source of truth the charging path already trusts, so consult
  // it first and only give up if it cannot name a terminal either.
  let ryftTerminalId = (term?.ryft_terminal_id as string) || '';
  const { data: ploc } = await platformAdmin.from('locations')
    .select('id').eq('ops_location_id', job.location_id).maybeSingle();
  const platformLocId = ploc?.id ?? job.location_id;
  {
    const { data: pds } = await platformAdmin.from('payment_devices')
      .select('ryft_terminal_id')
      .eq('location_id', platformLocId).eq('processor', 'ryft')
      .not('ryft_terminal_id', 'is', null);
    const ids = Array.isArray(pds) ? pds.map((r) => r.ryft_terminal_id as string).filter(Boolean) : [];
    if (!ryftTerminalId && ids.length === 1) ryftTerminalId = ids[0];
    else if (ryftTerminalId && !ids.includes(ryftTerminalId) && ids.length === 1) ryftTerminalId = ids[0];
  }
  if (!ryftTerminalId) return json({ ok: false, error: 'terminal_not_linked' }, 409);
  const opts = job.account_id ? { accountId: job.account_id } : {};

  // ── 2. Abort the LIVE action on the terminal ────────────────────────────────
  let voidRes;
  try {
    voidRes = await cancelTerminalAction(ryftTerminalId, {}, opts);
  } catch (e) {
    // Couldn't reach Ryft — the row stays 'charging'; the result poll / sweeper own
    // recovery. Do NOT tell staff "cancelled".
    return json({ ok: false, error: 'could not reach the card processor to cancel — try again', detail: (e as Error).message }, 502);
  }

  // ── 3. Settle from the SESSION VERDICT, never from intent ───────────────────
  if (!job.payment_session_id) {
    // Void sent but this job never captured a session id — nothing to verify. Leave
    // 'charging'; the sweeper resolves the lease. Report the void was attempted.
    return json({ ok: true, state: 'processing', status: 'processing', voided: !!voidRes?.ok, phase: 'voided_no_session' });
  }

  let got;
  try {
    got = await getPaymentSession(job.payment_session_id, opts);
  } catch (e) {
    return json({ ok: false, error: 'cancel sent, but the outcome could not be verified — it will reconcile', detail: (e as Error).message }, 502);
  }
  if (!got.ok) return json({ ok: false, error: got.data?.message ?? `Ryft error (${got.status})`, ryft: got.data }, 502);

  const d = got.data ?? {};
  const st = stateOf(d.status ?? 'PendingPayment', d.lastError ?? null);

  if (st === 'processing') {
    // The void may still be propagating on the terminal. Leave 'charging'; the
    // result poll and sweeper will settle it. Never assert cancelled prematurely.
    return json({ ok: true, state: 'processing', status: 'processing', session_status: d.status ?? null, voided: !!voidRes?.ok, phase: 'voided_pending' });
  }

  if (st === 'succeeded') {
    // The card CAPTURED despite the cancel. NEVER say cancelled — settle 'approved'
    // so the sale closes and staff are told to refund, not re-cancel.
    const { card, authCode, txnId } = cardOf(d);
    const amt = Number.isFinite(Number(d.amount)) ? Math.round(Number(d.amount)) : null;
    await opsAdmin.rpc('terminal_job_settle_from_processor', {
      p_job_id: job.id, p_outcome: 'approved', p_payment_session_id: job.payment_session_id,
      p_transaction_id: txnId, p_auth_code: authCode, p_card: card, p_source: 'session', p_session_amount_minor: amt,
    });
    return json({
      ok: false, code: 'ALREADY_CAPTURED', state: 'approved', status: 'approved',
      error: 'This payment was already taken on the card machine — refund it, do not cancel.',
      phase: 'captured',
    }, 409);
  }

  // failed → the action was voided (or the tap declined). This is the successful cancel.
  const declineReason = d.lastError ?? 'cancelled by staff';
  await opsAdmin.rpc('terminal_job_settle_from_processor', {
    p_job_id: job.id, p_outcome: 'declined', p_payment_session_id: job.payment_session_id,
    p_decline_reason: declineReason, p_source: 'session',
  });
  return json({ ok: true, state: 'cancelled', status: 'cancelled', voided: !!voidRes?.ok, phase: 'voided_settled' });
});
