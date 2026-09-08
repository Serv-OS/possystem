// supabase/functions/terminal-job-charge
//
// Ryft slice 3: the REAL charge path for a PaxPay terminal job. The PAX app
// (or a service-role bench curl) drives it:
//
//   POST { action: 'start',  job_id }   initiate the on-terminal payment at Ryft
//   POST { action: 'result', job_id }   what actually happened? (session verify)
//
// WHY THIS IS AN EDGE FUNCTION, NOT DEVICE-SIDE CODE
//   The device never holds a Ryft key and never supplies an amount. 'start'
//   charges exactly terminal_jobs.charge_minor — the server-computed figure
//   tj_charge_identity already enforces — and 'result' believes only what the
//   payment session (or the webhook/sweeper via the same settle RPC) says.
//   The device's own reportResult is an advisory claim (migration 20260729).
//
// THE IDEMPOTENCY LAYER RYFT LACKS (money-safety rule: never initiate twice)
//   'start' performs a CAS write-ahead — UPDATE … SET status='charging' WHERE
//   status='charging_unsent' — BEFORE any network call to Ryft. Exactly one
//   caller wins the row; the loser gets the stored payment_session_id (an
//   idempotent replay) or 409 { error:'in_flight' }. There is NO code path that
//   calls Ryft without having just won that CAS, so a double-tap, a retry after
//   a lost response, or two racing processes can never double-initiate.
//
//   Failure taxonomy after the CAS:
//     definitive Ryft 4xx  → nothing was charged. CAS-revert to charging_unsent,
//                            return { ok:false, safe:true, error } — retryable.
//     timeout / 5xx / no response → outcome UNKNOWABLE. The row STAYS 'charging'
//                            (never re-initiate); 'result', the webhook (slice 4)
//                            and the sweeper (slice 6) own recovery. 502.
//
// AUTH FENCE (stronger than ryft-terminal-payment's any-valid-token)
//   Bearer = the PAX's anon session → terminal_devices WHERE device_uid =
//   auth.uid() AND status='paired' AND active AND id = job.target_terminal_id —
//   only the terminal a job is ADDRESSED TO can charge or read it. Or the
//   service role (byte-compared) for bench/testing. Simulated and training
//   jobs are refused outright: this function touches real money only.
//
// Spec: docs/PAXPAY_TRANSPORT_SPEC.md; plan: Ryft slices 2-3.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { createTerminalPayment, getPaymentSession, getTerminal, confirmTerminalReceipt, ryftConfigured } from '../_shared/ryft.ts';

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
const platformAdmin = createClient(
  Deno.env.get('PLATFORM_SUPABASE_URL') ?? '',
  Deno.env.get('PLATFORM_SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const SETTLED = ['approved', 'declined', 'cancelled', 'expired', 'reconciled'];

// Ryft session status → outcome. Port of ryft-terminal-poll's stateOf (see the
// long note there): the OpenAPI status enum has NO 'Declined' — a declined tap
// leaves PendingPayment with lastError populated, and Approved/Captured beat a
// stale lastError from an earlier attempt that later succeeded.
function stateOf(status: string, lastError?: string | null): 'processing' | 'succeeded' | 'failed' {
  if (status === 'Approved' || status === 'Captured') return 'succeeded';
  if (status === 'Voided') return 'failed';
  if (lastError) return 'failed';
  return 'processing';
}

// UK card-receipt block — best-effort extraction, port of ryft-terminal-poll.
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

// Settled job → the device-facing terminal state. 'reconciled' is approved-and-
// closed; 'expired' never dispatched, so to the device it is a cancel.
const settledState = (s: string) => (s === 'reconciled' ? 'approved' : s === 'expired' ? 'cancelled' : s);

function settledBody(job: any) {
  const state = settledState(job.status);
  return {
    ok: true,
    state,
    status: state,
    job_status: job.status,
    transaction_id: job.transaction_id ?? null,
    auth_code: job.auth_code ?? null,
    card: job.card ?? null,
    decline_reason: job.decline_reason ?? null,
    payment_session_id: job.payment_session_id ?? null,
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  if (!ryftConfigured()) return json({ error: 'Ryft not configured — set RYFT_SECRET_KEY' }, 500);

  const token = (req.headers.get('Authorization') ?? '').replace('Bearer ', '').trim();
  if (!token) return json({ error: 'unauthorized' }, 401);
  const isServiceRole = token === SERVICE_ROLE;
  let callerUid: string | null = null;
  if (!isServiceRole) {
    try {
      const { data } = await opsAdmin.auth.getUser(token);
      callerUid = data?.user?.id ?? null;
    } catch { callerUid = null; }
    if (!callerUid) return json({ error: 'unauthorized' }, 401);
  }

  let body: { action?: string; job_id?: string };
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const action = String(body.action ?? '');
  const jobId = String(body.job_id ?? '');
  if (!jobId || (action !== 'start' && action !== 'result')) {
    return json({ error: "action ('start'|'result') and job_id required" }, 400);
  }

  const { data: job, error: jobErr } = await opsAdmin
    .from('terminal_jobs').select('*').eq('id', jobId).maybeSingle();
  if (jobErr) return json({ error: jobErr.message }, 500);
  if (!job) return json({ error: 'job not found' }, 404);

  // The terminal row: both the auth fence and the Ryft hardware link.
  const { data: term, error: termErr } = await opsAdmin
    .from('terminal_devices')
    .select('id, device_uid, status, active, ryft_terminal_id')
    .eq('id', job.target_terminal_id).maybeSingle();
  if (termErr) return json({ error: termErr.message }, 500);
  if (!term) return json({ error: 'terminal not found' }, 404);

  if (!isServiceRole) {
    // ONLY the addressed terminal. A stolen anon token from another device —
    // even one paired at the same venue — matches nothing here.
    if (term.device_uid !== callerUid || term.status !== 'paired' || !term.active) {
      return json({ error: 'no access to this job' }, 403);
    }
  }

  // Real money only. A SIMULATED bench job settles via the old device path, and
  // a training job must never reach a card (both fences also exist upstream —
  // belt and braces on the one function that talks to the processor).
  if (job.simulated === true) return json({ error: 'simulated job — the real charge path refuses it', code: 'SIMULATED' }, 409);
  if (job.training === true) return json({ error: 'training job — no card may be charged', code: 'TRAINING' }, 409);

  // ── start ──────────────────────────────────────────────────────────────────
  if (action === 'start') {
    if (SETTLED.includes(job.status)) {
      return json({ ok: false, error: `job already ${job.status}`, ...settledBody(job) }, 409);
    }

    // Fail closed BEFORE any money movement.
    if (!term.ryft_terminal_id) {
      // Pairing exists but the Ryft link was never stamped (ryft-terminals
      // register/adopt does it since slice 1). Without it we cannot address the
      // hardware — and guessing a terminal is how money lands on the wrong PAX.
      return json({ ok: false, error: 'terminal_not_linked' }, 409);
    }
    if (job.charge_minor == null) {
      return json({ ok: false, error: 'job has no server-computed charge — the tip was never committed' }, 409);
    }

    // Idempotent replay fast-path: this job already initiated and we know the session.
    if (job.status === 'charging' && job.payment_session_id) {
      return json({ ok: true, payment_session_id: job.payment_session_id, account_id: job.account_id ?? null, idempotent: true });
    }
    if (job.status !== 'charging_unsent' && job.status !== 'charging') {
      return json({ ok: false, error: `job is ${job.status} — not ready to charge` }, 409);
    }

    // CAS write-ahead — THE idempotency layer. Winner proceeds to Ryft; the row
    // is marked in-flight before the network is touched, so a crash between here
    // and the response can only ever leave 'charging' (recoverable), never a
    // second initiate. The lease gets the same 5 minutes terminal_claim_job
    // grants, so the sweeper doesn't quarantine a card mid-insert.
    const nowIso = new Date().toISOString();
    const { data: cas, error: casErr } = await opsAdmin
      .from('terminal_jobs')
      .update({
        status: 'charging',
        dispatched_at: nowIso,
        claim_expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
        updated_at: nowIso,
      })
      .eq('id', job.id).eq('status', 'charging_unsent')
      .select('id');
    if (casErr) return json({ error: casErr.message }, 500);

    if (!Array.isArray(cas) || cas.length !== 1) {
      // Lost the race (or a stale read above). NEVER re-initiate — hand back
      // what the winner produced, or say in_flight.
      const { data: fresh } = await opsAdmin
        .from('terminal_jobs').select('status, payment_session_id, account_id')
        .eq('id', job.id).maybeSingle();
      if (fresh?.payment_session_id) {
        return json({ ok: true, payment_session_id: fresh.payment_session_id, account_id: fresh.account_id ?? null, idempotent: true });
      }
      if (fresh?.status === 'charging') return json({ ok: false, error: 'in_flight' }, 409);
      return json({ ok: false, error: `job is ${fresh?.status ?? 'gone'} — not ready to charge` }, 409);
    }

    // Sub-account + platformFee — same markup model as ryft-terminal-payment:
    // ops location → platform location (ops_location_id) → merchant_ryft_accounts;
    // fee = markup% × charge + fixed pence (merchant override → platform default).
    let accountId: string | undefined;
    let platformFee: number | undefined;
    const chargeMinor = Number(job.charge_minor);
    const { data: ploc } = await platformAdmin.from('locations')
      .select('id').eq('ops_location_id', job.location_id).maybeSingle();
    const platformLocId = ploc?.id ?? job.location_id;

    // ── Authoritative Ryft terminal id ──────────────────────────────────────────
    // The Ryft terminal id lives in TWO places that can drift: ops
    // terminal_devices.ryft_terminal_id (stamped by ryft-terminals at pair time)
    // and platform payment_devices.ryft_terminal_id (written by the "Ryft card
    // reader" pairing flow). Re-pairing through the reader flow updates only the
    // latter, leaving the ops column pointing at a terminal Ryft no longer knows —
    // an initiate 404 ("resource not found"), the exact failure this guards.
    // payment_devices is the source of truth the WORKING path
    // (ryft-terminal-payment) already trusts, so reconcile to it here rather than
    // trusting a column that silently goes stale on every re-pair.
    let ryftTerminalId = term.ryft_terminal_id as string;
    {
      const { data: pds } = await platformAdmin.from('payment_devices')
        .select('ryft_terminal_id')
        .eq('location_id', platformLocId).eq('processor', 'ryft')
        .not('ryft_terminal_id', 'is', null);
      const ids = Array.isArray(pds)
        ? pds.map((r) => r.ryft_terminal_id as string).filter(Boolean)
        : [];
      if (ids.includes(ryftTerminalId)) {
        // ops and platform agree — nothing to reconcile.
      } else if (ids.length === 1) {
        console.log(`terminal-job-charge: ops ryft id ${ryftTerminalId} absent from payment_devices; using authoritative ${ids[0]} (drift, job ${job.id})`);
        ryftTerminalId = ids[0];
      } else if (ids.length > 1) {
        console.log(`terminal-job-charge: ${ids.length} ryft terminals at location and ops id ${ryftTerminalId} matches none — keeping ops id (job ${job.id})`);
      }
      // ids.length === 0 → nothing better to use; keep the ops id.
    }
    const { data: mra } = await platformAdmin.from('merchant_ryft_accounts')
      .select('ryft_account_id, markup_percent, markup_fixed_pence')
      .eq('location_id', platformLocId).maybeSingle();
    accountId = mra?.ryft_account_id ?? undefined;
    if (accountId) {
      const { data: ps } = await platformAdmin.from('platform_settings')
        .select('default_ryft_markup_percent, default_ryft_markup_fixed_pence')
        .eq('id', true).maybeSingle();
      const pct = mra?.markup_percent != null ? Number(mra.markup_percent) : Number(ps?.default_ryft_markup_percent ?? 0);
      const fixed = mra?.markup_fixed_pence != null ? Number(mra.markup_fixed_pence) : Number(ps?.default_ryft_markup_fixed_pence ?? 0);
      const fee = Math.round(chargeMinor * (pct / 100)) + Math.round(fixed);
      if (fee > 0) platformFee = fee;
    }

    // Session metadata — the recovery breadcrumbs. The webhook (slice 4) and the
    // sweeper (slice 6) match a session back to its job by terminal_job_id when
    // the initiate response was lost. Values must be strings (Ryft: ≤10 entries,
    // keys ≤30 chars, values ≤250 chars).
    const psMetadata: Record<string, string> = {
      terminal_job_id: String(job.id),
      check_key: String(job.check_key ?? '').slice(0, 250),
      base_minor: String(job.due_minor ?? ''),
      tip_minor: String(job.tip_minor ?? 0),
      closed_check_id: String(job.closed_check_id ?? '').slice(0, 250),
    };

    let res;
    try {
      res = await createTerminalPayment(ryftTerminalId, {
        // THE AMOUNT IS THE DB'S, NEVER THE CALLER'S. tj_charge_identity has
        // already proven charge = due + tip on this row.
        amounts: { requested: chargeMinor },
        currency: String(job.currency || 'GBP').toUpperCase(),
        // 'PointOfSale' (v5.5.863, second attempt — WITH the receipt pump). The first
        // attempt (v5.5.862) deadlocked BY CONSTRUCTION: the controller waits
        // ON-DEVICE for confirm-receipt BEFORE returning to our app, but our
        // confirms rode the device's result poll, which only starts AFTER the
        // controller returns. Nobody confirmed → Ryft voided real taps →
        // "declined / cannot confirm" on live payments. Killing the PAX merchant
        // receipt (owner requirement) needs the confirms to arrive DURING the
        // controller wait: either the app polling result concurrently with the
        // tender, or a terminal.action_updated webhook watcher. Do NOT flip this
        // back without one of those in place and proven on hardware.
        settings: { receiptPrintingSource: 'PointOfSale' },
        paymentSession: {
          ...(platformFee != null ? { platformFee } : {}),
          ...(accountId ? { paymentSettings: { platform: { paymentFees: { combined: { bookTo: accountId } } } } } : {}),
          metadata: psMetadata,
        },
      }, accountId ? { accountId } : {});
    } catch (e) {
      // Network failure AFTER the CAS: the request may or may not have reached
      // Ryft. The row stays 'charging' — result/webhook/sweeper resolve it.
      return json({ ok: false, error: 'could not reach the card processor — outcome unknown', detail: (e as Error).message }, 502);
    }

    if (!res.ok) {
      if (res.status >= 400 && res.status < 500) {
        // Definitive rejection — Ryft refused the initiate; no card was touched.
        // CAS-revert so a retry (or the sweeper's clean cancel) can proceed. The
        // psId-is-null guard means a webhook that somehow raced us can't be undone.
        await opsAdmin.from('terminal_jobs')
          .update({
            status: 'charging_unsent',
            last_error: `Ryft rejected the initiate (${res.status}): ${res.data?.errors?.[0]?.message ?? res.data?.message ?? res.data?.code ?? 'unknown'}`,
            updated_at: new Date().toISOString(),
          })
          .eq('id', job.id).eq('status', 'charging').is('payment_session_id', null);
        return json({
          ok: false,
          safe: true,   // nothing charged — the POS may retry freely
          error: res.data?.errors?.[0]?.message ?? res.data?.message ?? `Ryft rejected the payment (${res.status})`,
          ryft: res.data,
        });
      }
      // 5xx — Ryft may have accepted it before failing. Leave 'charging'.
      return json({ ok: false, error: `Ryft error (${res.status}) — outcome unknown`, ryft: res.data }, 502);
    }

    const act = res.data?.action ?? {};
    const psId: string | null = act?.transaction?.paymentSessionId ?? null;
    await opsAdmin.from('terminal_jobs')
      .update({
        // Never null-out a psId a racing webhook may have backfilled.
        ...(psId ? { payment_session_id: psId } : {}),
        account_id: accountId ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', job.id);

    return json({ ok: true, payment_session_id: psId, account_id: accountId ?? null });
  }

  // ── result ─────────────────────────────────────────────────────────────────
  // Settled → answer from the row (the webhook or sweeper may have won).
  // In flight + psId → ask the payment session and, on a terminal state, settle
  // through the ONE writer (terminal_job_settle_from_processor, source 'session').
  // In flight, no psId → 'processing'; recovery belongs to the sweeper.
  if (SETTLED.includes(job.status)) return json(settledBody(job));

  if (!job.payment_session_id) {
    return json({ ok: true, state: 'processing', status: 'processing' });
  }

  // ── PointOfSale receipt confirmation (v5.5.865 — probe-verified shapes) ──────
  // With receiptPrintingSource:'PointOfSale' a tapped card is authorised but the
  // terminal WAITS on confirm-receipt before completing; unconfirmed → Ryft VOIDS
  // (the v5.5.862 live failures). Ryft's contract, confirmed against a real A50:
  //   GET /in-person/terminals/{id} → data.action.transaction.receiptDetail
  //        .merchantCopy.status / .customerCopy.status  (NotRequired → Required)
  //   confirm ONE copy at a time, MERCHANT FIRST, only when its status=='Required'.
  // Run this on EVERY result poll (the device pumps it ~1s during the tender),
  // BEFORE reading the session — the session won't reach Captured until both are
  // confirmed. Idempotent: once a copy leaves 'Required' we don't resend it. All
  // errors swallowed so a receipt hiccup never breaks the result poll.
  if (term.ryft_terminal_id) {
    try {
      const t = await getTerminal(term.ryft_terminal_id, job.account_id ? { accountId: job.account_id } : {});
      const act = (t.data as any)?.action ?? null;
      const txn = act?.transaction ?? null;
      if (t.ok && txn && txn.paymentSessionId === job.payment_session_id) {
        const rd = txn.receiptDetail ?? {};
        const mStatus = rd?.merchantCopy?.status ?? null;
        const cStatus = rd?.customerCopy?.status ?? null;
        const opts = job.account_id ? { accountId: job.account_id } : {};
        if (mStatus === 'Required') {
          const m = await confirmTerminalReceipt(term.ryft_terminal_id, { merchantCopy: { status: 'Succeeded' } }, opts);
          console.log(`terminal-job-charge: confirmed merchant receipt for job ${job.id} (http ${m.status})`);
        } else if (cStatus === 'Required') {
          // Only after the merchant copy has left 'Required' does Ryft ask for the
          // customer copy — so this branch is reached on a later poll, in order.
          const c = await confirmTerminalReceipt(term.ryft_terminal_id, { customerCopy: { status: 'Succeeded' } }, opts);
          console.log(`terminal-job-charge: confirmed customer receipt for job ${job.id} (http ${c.status})`);
        }
      }
    } catch (e) {
      console.log(`terminal-job-charge: receipt-confirm poll failed for job ${job.id}: ${(e as Error).message}`);
    }
  }

  let got;
  try {
    got = await getPaymentSession(job.payment_session_id, job.account_id ? { accountId: job.account_id } : {});
  } catch (e) {
    return json({ ok: false, error: 'could not reach the card processor', detail: (e as Error).message }, 502);
  }
  if (!got.ok) {
    return json({ ok: false, error: got.data?.message ?? `Ryft error (${got.status})`, ryft: got.data }, 502);
  }

  const d = got.data ?? {};
  const sessionState = stateOf(d.status ?? 'PendingPayment', d.lastError ?? null);
  if (sessionState === 'processing') {
    return json({ ok: true, state: 'processing', status: 'processing', session_status: d.status ?? null });
  }

  const outcome = sessionState === 'succeeded' ? 'approved' : 'declined';
  const { card, authCode, txnId } = cardOf(d);
  const sessionAmount = Number.isFinite(Number(d.amount)) ? Math.round(Number(d.amount)) : null;
  const declineReason = outcome === 'declined'
    ? (d.lastError ?? (d.status === 'Voided' ? 'voided' : null))
    : null;

  const { data: settled, error: rpcErr } = await opsAdmin.rpc('terminal_job_settle_from_processor', {
    p_job_id: job.id,
    p_outcome: outcome,
    p_payment_session_id: job.payment_session_id,
    p_transaction_id: txnId,
    p_auth_code: authCode,
    p_card: card,
    p_decline_reason: declineReason,
    p_source: 'session',
    p_session_amount_minor: sessionAmount,
  });
  if (rpcErr) return json({ ok: false, error: rpcErr.message }, 500);

  return json({
    ok: true,
    state: outcome,
    status: outcome,
    transaction_id: txnId,
    auth_code: authCode,
    card,
    decline_reason: declineReason,
    payment_session_id: job.payment_session_id,
    settle: settled ?? null,
  });
});
