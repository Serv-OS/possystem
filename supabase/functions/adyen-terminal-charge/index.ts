// supabase/functions/adyen-terminal-charge
//
// The Adyen in-person charge path for terminal_jobs (processor='adyen') —
// the sibling of terminal-job-charge (Ryft/PAX), sharing its money-safety
// contract but speaking nexo 3.0 to Adyen hardware. ADYEN_INTEGRATION_PLAN.md
// Phase 3 core, built key-independent in Phase 0.
//
// THREE TRANSPORTS, ONE CONTRACT (server computes, device transports, server settles):
//   'start'         cloud Terminal API /sync → AMS1-style terminals the TILL drives.
//                   One long HTTP call returns the final PaymentResponse.
//   'prepare_local' our app ON an Adyen Android terminal (S1E2L / S1E4 Pro MPOS)
//                   asks for the server-built nexo PaymentRequest, posts it to
//                   localhost:8443/nexo itself, then calls…
//   'report_local'  …with the terminal's PaymentResponse. The device's claim is
//                   ADVISORY: we parse, sanity-check the amount, and settle via
//                   the single settle-writer RPC. (Tap to Pay on iPhone/Android
//                   uses this same pair — the POS Mobile SDK consumes the exact
//                   nexo PaymentRequest that prepare_local returns.)
//   'result'        recovery: job settled → say so; else TransactionStatusRequest
//                   over cloud using the PERSISTED nexo_service_id.
//
// MONEY-SAFETY (inherited verbatim from terminal-job-charge):
//   • CAS write-ahead: UPDATE … SET status='charging' WHERE status='charging_unsent'
//     BEFORE any network call — exactly one initiator ever reaches the terminal.
//   • The amount is THE DB'S (terminal_jobs.charge_minor, tj_charge_identity-proven),
//     never the caller's.
//   • Timeout / unknown outcome → row STAYS 'charging'; recovery owns it ('result',
//     the AUTHORISATION webhook backstop in adyen-webhook, the sweeper).
//   • Settlement ONLY via terminal_job_settle_from_processor.
//   • Simulated/training jobs refused.
//
// AUTH FENCE: Adyen jobs are driven by the POS DEVICE (there is no on-terminal
// pairing session like PaxPay for cloud mode) — caller must be a paired device
// at the job's location (devices.device_uid = auth.uid()), or the service role.
// For prepare_local/report_local the caller IS the on-terminal app; v5.6.81 also
// accepts it as THE JOB'S OWN TARGET TERMINAL (terminal_devices.device_uid =
// auth.uid() AND id = job.target_terminal_id, paired + active) — see the fence
// block for why that is narrower, not wider, than the device branch.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  adyenConfigured, terminalEndpoint, adyenFetch, checkoutBase,
  buildPaymentRequest, buildTransactionStatusRequest, buildAbortRequest,
  parsePaymentResponse, newServiceId, ADYEN_MERCHANT_ACCOUNT,
} from '../_shared/adyen.ts';

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
const settledState = (s: string) => (s === 'reconciled' ? 'approved' : s === 'expired' ? 'cancelled' : s);

function settledBody(job: any) {
  const state = settledState(job.status);
  return {
    ok: true, state, status: state, job_status: job.status,
    transaction_id: job.transaction_id ?? null, auth_code: job.auth_code ?? null,
    card: job.card ?? null, decline_reason: job.decline_reason ?? null,
    payment_session_id: job.payment_session_id ?? null,
  };
}

// nexo card block → the snake_case receipt shape terminal_job_settle_from_processor
// stores and the POS/receipts already render (same keys the Ryft path writes).
function settleCard(p: ReturnType<typeof parsePaymentResponse>) {
  const c = p.card;
  if (!c.brand && !c.last4 && !c.authCode) return null;
  return {
    brand: c.brand, last4: c.last4, auth_code: c.authCode,
    read_method: c.readMethod, aid: c.aid, application_name: c.applicationName,
    cvm: c.cvm, account_type: null,
  };
}

// Settle a job from a parsed PaymentResponse — the ONE downstream for every
// transport. Declines settle 'declined'; Success settles 'approved'. A Partial
// result is settled DECLINED for now: partial approval on a till flow needs the
// staff-alert UX (plan Phase 3) before we can safely leave a remainder unpaid.
//
// REVIEW HARDENING (v968): the authorised-amount fallback to chargeMinor exists
// ONLY for trusted server-side sources (a sync/status/webhook response that came
// from Adyen). A DEVICE-supplied response must carry a real AmountsResp — the
// fallback would let a forged Success blob with no amounts vacuously pass the
// RPC's mismatch check.
const TRUSTED_AMOUNT_SOURCES = new Set(['charge_sync', 'status_recovery', 'event_notification']);
async function settleFromResponse(jobId: string, p: ReturnType<typeof parsePaymentResponse>, source: string, chargeMinor: number) {
  const success = p.result === 'Success';
  if (p.result === 'Partial') {
    console.log(`adyen-terminal-charge: PARTIAL approval on job ${jobId} (${p.authorizedMinor}/${chargeMinor}) — settling declined until partial UX exists`);
  }
  if (success && p.authorizedMinor == null && !TRUSTED_AMOUNT_SOURCES.has(source)) {
    throw new Error('device report has no AuthorizedAmount — refusing to settle approved');
  }
  let effectiveAuthorized = p.authorizedMinor;
  if (success && p.authorizedMinor != null && p.authorizedMinor !== chargeMinor) {
    // Tip added ON the terminal (AskGratuity). Credit it ONLY when the
    // processor's own TipAmount explains the difference EXACTLY — then the
    // job's money is recomputed (charge = due + tip, the tj_charge_identity
    // shape) BEFORE settle so the RPC's mismatch guard agrees. Any other
    // difference still parks for a manager (v5.6.54 — live £1 gratuity parked
    // as 'amount mismatch: processor 5799 vs server 5699').
    const tip = p.tipMinor ?? 0;
    if (tip > 0 && chargeMinor + tip === p.authorizedMinor) {
      const { data: fixed, error: tipErr } = await opsAdmin.from('terminal_jobs')
        .update({ tip_minor: tip, charge_minor: p.authorizedMinor })
        .eq('id', jobId).is('tip_minor', null)
        .select('id').maybeSingle();
      if (tipErr || !fixed) {
        console.log(`adyen-terminal-charge: tip recompute skipped on job ${jobId}: ${tipErr?.message || 'tip already set'}`);
      } else {
        console.log(`adyen-terminal-charge: on-reader tip ${tip} credited on job ${jobId} (${chargeMinor} + tip = ${p.authorizedMinor})`);
      }
    } else {
      console.log(`adyen-terminal-charge: authorised ${p.authorizedMinor} != charge ${chargeMinor} on job ${jobId} and TipAmount ${tip} does not explain it — parking via RPC guard`);
    }
  }
  const { data: settled, error } = await opsAdmin.rpc('terminal_job_settle_from_processor', {
    p_job_id: jobId,
    p_outcome: success ? 'approved' : 'declined',
    p_payment_session_id: p.pspReference,          // pspReference rides the session column
    p_transaction_id: p.poiTransactionId ?? p.pspReference,
    p_auth_code: p.card.authCode,
    p_card: settleCard(p),
    p_decline_reason: success ? null : (p.errorCondition ?? 'declined'),
    p_source: source,
    p_session_amount_minor: effectiveAuthorized ?? (success ? chargeMinor : null),
  });
  if (error) throw new Error(`settle rpc: ${error.message}`);
  // Split-leg toast (kept in lockstep with adyen-terminal-events): a PARTIAL
  // pay-at-table leg never books a check, so this activity_events row is the
  // only thing the floor sees. Gated on the RPC's non-idempotent approved
  // transition — exactly-once across the sync/async settle race. Best-effort.
  try {
    if ((settled as any)?.ok === true && (settled as any)?.idempotent !== true
        && (settled as any)?.status === 'approved') {
      const { data: j } = await opsAdmin.from('terminal_jobs')
        .select('location_id, due_minor, check_draft').eq('id', jobId).maybeSingle();
      const d = (j?.check_draft ?? {}) as Record<string, unknown>;
      if (j && d.source === 'adyen_pay_at_table' && d.partial === true) {
        // Publish paid-so-far onto the live session FIRST — that column is what
        // every till and the reader read to know what is still owed.
        await opsAdmin.rpc('terminal_sync_table_paid', { p_job_id: jobId })
          .then(() => {}, (e: Error) => console.error('adyen-terminal-charge: sync paid', e?.message));
        const left = Number(d.remainingAfterMinor) || 0;
        await opsAdmin.from('activity_events').insert({
          location_id: j.location_id, kind: 'system', severity: 'action',
          title: `Part payment — ${d.tableLabel ?? d.tableId ?? 'table'}`,
          body: `£${((Number(j.due_minor) || 0) / 100).toFixed(2)} taken on the card reader. £${(left / 100).toFixed(2)} left to pay — take the rest with Pay at table.`,
          ref_type: 'terminal_job', ref_id: jobId,
        });
      }
    }
  } catch { /* toast is advisory — never block a settle */ }
}

// v5.6.87 — DURABLE REFUSAL LOG. Peter has now hit "payments are still not going
// to the device" three times with jobs stuck at charging_unsent and
// nexo_service_id NULL, meaning this function refused BEFORE its write-ahead CAS
// and told nobody why: the till swallowed the reason (fixed v5.6.86) and Supabase
// console logs have proved unreadable through the analytics API all week. Record
// every pre-CAS refusal where we can always query it — the same trick that
// finally cracked pay-at-table.
async function logRefusal(reason: string, ctx: Record<string, unknown>) {
  console.log(`adyen-terminal-charge REFUSED: ${reason} ${JSON.stringify(ctx)}`);
  await platformAdmin.from('adyen_webhook_events').insert({
    event_key: `charge-refused:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    raw: { reason, ...ctx },
  }).then(() => {}, () => {});
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  if (!adyenConfigured()) return json({ error: 'Adyen not configured — set ADYEN_API_KEY' }, 503);

  const token = (req.headers.get('Authorization') ?? '').replace('Bearer ', '').trim();
  if (!token) return json({ error: 'unauthorized' }, 401);
  const isServiceRole = token === SERVICE_ROLE;
  let callerUid: string | null = null;
  if (!isServiceRole) {
    try { const { data } = await opsAdmin.auth.getUser(token); callerUid = data?.user?.id ?? null; } catch { callerUid = null; }
    if (!callerUid) return json({ error: 'unauthorized' }, 401);
  }

  let body: { action?: string; job_id?: string; response?: unknown };
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const action = String(body.action ?? '');

  // ── BAR-TAB HOLDS (v5.6.57) — pre-auth on the reader, no job row: the tab
  // (bar_tabs pre_auth_* columns) carries the hold. Fence: service role, or a
  // paired POS device at the venue. Capture/release/increase mirror the
  // adyen-modify endpoints but stay HERE because that fn's fence is BO-user
  // based and a till must be able to close its own tab.
  if (['hold_start', 'hold_capture', 'hold_release', 'hold_increase'].includes(action)) {
    const deviceAt = async (locId: string) => {
      if (isServiceRole) return true;
      const { data: dev } = await opsAdmin.from('devices')
        .select('id').eq('device_uid', callerUid).eq('location_id', locId).maybeSingle();
      return !!dev;
    };
    const maaFor = async (opsLocId: string) => {
      const { data: ploc } = await platformAdmin.from('locations')
        .select('id').eq('ops_location_id', opsLocId).maybeSingle();
      const platformLocId = ploc?.id ?? opsLocId;
      const { data: maa } = await platformAdmin.from('merchant_adyen_accounts')
        .select('merchant_account, store_id, region').eq('location_id', platformLocId).maybeSingle();
      return maa;
    };

    if (action === 'hold_start') {
      const terminalDeviceId = String(body.terminal_device_id ?? '');
      const amountMinor = Math.round(Number(body.amount_minor));
      const currency = String(body.currency || 'GBP').toUpperCase().slice(0, 3);
      if (!terminalDeviceId || !Number.isFinite(amountMinor) || amountMinor < 100 || amountMinor > 100_000) {
        return json({ error: 'terminal_device_id and amount_minor (£1–£1000) required' }, 400);
      }
      const { data: term } = await opsAdmin.from('terminal_devices')
        .select('id, location_id, status, active, adyen_terminal_id')
        .eq('id', terminalDeviceId).maybeSingle();
      if (!term?.adyen_terminal_id || term.status !== 'paired' || !term.active) {
        return json({ ok: false, error: 'terminal not paired to Adyen' }, 409);
      }
      if (!(await deviceAt(term.location_id))) return json({ error: 'no access to this venue' }, 403);
      const maa = await maaFor(term.location_id);
      if (!maa?.merchant_account) {
      await logRefusal('venue has no Adyen merchant account', { action, jobId: job.id, jobLocation: job.location_id });
      return json({ ok: false, error: 'venue has no Adyen account — onboarding incomplete' }, 409);
    }

      const serviceId = newServiceId();
      const nexo = buildPaymentRequest({
        poiid: term.adyen_terminal_id,
        saleId: `servos-${String(term.location_id).slice(0, 8)}`,
        serviceId,
        transactionId: `tabhold-${crypto.randomUUID().slice(0, 12)}`,
        amountMinor,
        currency,
        preAuth: true,
        storeId: maa.store_id ?? undefined,
      });
      const res = await adyenFetch('POST', terminalEndpoint(maa.merchant_account, term.adyen_terminal_id, 'sync', maa.region === 'US' ? 'us' : 'eu'), nexo, { timeoutMs: 165_000 });
      if (!res.ok) return json({ ok: false, error: `adyen ${res.status}` }, 200);
      const parsed = parsePaymentResponse(res.data);
      if (parsed.result !== 'Success') {
        return json({ ok: false, error: parsed.errorCondition || 'declined', declined: true }, 200);
      }
      return json({
        ok: true,
        psp_reference: parsed.pspReference,
        held_minor: parsed.authorizedMinor ?? amountMinor,
        card: settleCard(parsed),
      });
    }

    // capture / release / increase — by pspReference, venue-fenced.
    const psp = String(body.psp_reference ?? '');
    const opsLocId = String(body.location_id ?? '');
    if (!psp || !opsLocId) return json({ error: 'psp_reference and location_id required' }, 400);
    if (!(await deviceAt(opsLocId))) return json({ error: 'no access to this venue' }, 403);
    const maa = await maaFor(opsLocId);
    if (!maa?.merchant_account) return json({ ok: false, error: 'venue has no Adyen account' }, 409);
    const amountMinor = body.amount_minor != null ? Math.round(Number(body.amount_minor)) : null;
    const currency = String(body.currency || 'GBP').toUpperCase().slice(0, 3);
    let path = ''; let payload: Record<string, unknown> = {};
    if (action === 'hold_capture') {
      if (!Number.isFinite(amountMinor)) return json({ error: 'amount_minor required' }, 400);
      path = `/payments/${encodeURIComponent(psp)}/captures`;
      payload = { merchantAccount: maa.merchant_account, amount: { value: amountMinor, currency }, reference: `tabcap:${psp}` };
    } else if (action === 'hold_release') {
      path = `/payments/${encodeURIComponent(psp)}/cancels`;
      payload = { merchantAccount: maa.merchant_account, reference: `tabrel:${psp}` };
    } else { // hold_increase — new TOTAL, not a delta (Adyen amountUpdates semantics)
      if (!Number.isFinite(amountMinor)) return json({ error: 'amount_minor (new total) required' }, 400);
      path = `/payments/${encodeURIComponent(psp)}/amountUpdates`;
      payload = { merchantAccount: maa.merchant_account, amount: { value: amountMinor, currency }, industryUsage: 'delayedCharge', reference: `tabinc:${psp}` };
    }
    // capture/release keep replay-safe deterministic keys; INCREASE must be
    // unique per attempt (Adyen replays the first response for a reused key —
    // a fixed request after a 400 kept echoing the 400).
    const idem = action === 'hold_increase'
      ? `ti:${psp}:${crypto.randomUUID().slice(0, 13)}`
      : `tab:${action}:${psp}:${amountMinor ?? 'full'}`;
    const res = await adyenFetch('POST', `${checkoutBase()}${path}`, payload, { idempotencyKey: idem });
    if (!res.ok) return json({ ok: false, error: `adyen ${res.status}`, detail: res.data }, res.status >= 500 ? 502 : 200);
    return json({ ok: true, status: (res.data as Record<string, unknown>)?.status ?? 'received', modification_psp: (res.data as Record<string, unknown>)?.pspReference ?? null });
  }

  const jobId = String(body.job_id ?? '');
  if (!jobId || !['start', 'prepare_local', 'report_local', 'result', 'abort'].includes(action)) {
    return json({ error: "action ('start'|'prepare_local'|'report_local'|'result'|'abort') and job_id required" }, 400);
  }

  const { data: job, error: jobErr } = await opsAdmin.from('terminal_jobs').select('*').eq('id', jobId).maybeSingle();
  if (jobErr) return json({ error: jobErr.message }, 500);
  if (!job) return json({ error: 'job not found' }, 404);
  if (job.processor !== 'adyen') return json({ error: `job is ${job.processor ?? 'ryft'} — wrong charge path` }, 409);

  // ── Fence ──────────────────────────────────────────────────────────────────
  // Two accepted identities (or the service role). BOTH are server-stamped from
  // auth.uid() by a SECURITY DEFINER RPC — neither can be self-asserted by a caller.
  //
  //   (a) TILL: a paired POS-family device at this job's location
  //       (devices.device_uid = auth.uid(), stamped by claim_device() and gated on
  //       the pairing code). This is the cloud transport's caller.
  //
  //   (b) THE JOB'S OWN TARGET TERMINAL (v5.6.81): a paired, active terminal_devices
  //       row whose id IS job.target_terminal_id and whose device_uid = auth.uid()
  //       (stamped by register_terminal_device(); location set only by
  //       claim_terminal_device() after a manager validated it in Back Office).
  //
  // WHY (b) IS NEEDED: our MPOS wrapper running ON an Adyen Android terminal is both
  // the till and the reader, and one browser holds ONE Supabase session — so a single
  // auth.uid() has to satisfy the till fence here AND the terminal_devices fence that
  // terminal_commit_tip / terminal_jobs RLS use. It usually does (MPOS also pairs as a
  // POS device, so claim_device stamps the same uid), but claim_device is best-effort
  // and both of its call sites swallow the failure — a device whose claim silently
  // failed would hold a manager-claimed reader row and still be told 'no access to
  // this job'. That is a 403 on a card the customer is standing in front of.
  //
  // WHY IT IS STILL TIGHT: (b) is NARROWER than (a), not wider. It is not "any
  // terminal at the venue" — it is THIS job's addressed terminal and no other, so it
  // grants exactly the capability the job already gives that terminal (terminal_jobs'
  // own SELECT policy fences the same way). It cannot reach another venue's jobs,
  // another terminal's jobs, or an unpaired/retired row.
  if (!isServiceRole) {
    // v5.6.89 — (c) a signed-in USER with user_locations access to the job's
    // venue (or super_admin), MIRRORING terminal-job-create's fence. Proven live
    // 19 Aug: Peter's browser POS shares its session with Back Office, so the
    // caller was his BO user — terminal-job-create ACCEPTED it and minted the
    // job, this fence REFUSED it, and the job deadlocked at charging_unsent
    // forever ("fence: caller is neither a paired device..." in the refusal
    // log, callerUid = his BO login). Creating a job is strictly MORE powerful
    // than kicking it (create freezes the money; the kick only transports the
    // DB's own amount behind a CAS), so any identity trusted to create must be
    // trusted to kick — otherwise that identity can only ever wedge terminals.
    const [{ data: dev }, { data: ownTerm }, { data: ul }, { data: prof }] = await Promise.all([
      opsAdmin.from('devices')
        .select('id').eq('device_uid', callerUid).eq('location_id', job.location_id).maybeSingle(),
      opsAdmin.from('terminal_devices')
        .select('id').eq('id', job.target_terminal_id).eq('device_uid', callerUid)
        .eq('status', 'paired').eq('active', true).maybeSingle(),
      opsAdmin.from('user_locations')
        .select('location_id').eq('user_id', callerUid).eq('location_id', job.location_id).maybeSingle(),
      opsAdmin.from('user_profiles')
        .select('role').eq('id', callerUid).maybeSingle(),
    ]);
    const isVenueUser = !!ul || prof?.role === 'super_admin';
    if (!dev && !ownTerm && !isVenueUser) {
      await logRefusal('fence: caller is neither a paired device at this location nor the job\'s own terminal', {
        action, jobId: job.id, jobLocation: job.location_id,
        targetTerminalId: job.target_terminal_id, callerUid,
      });
      return json({ error: 'no access to this job' }, 403);
    }
    if (!dev && ownTerm) {
      console.log(`adyen-terminal-charge: caller authorised as the job's own target terminal ${job.target_terminal_id} (job ${job.id}, action ${action})`);
    }
  }

  if (job.simulated === true) return json({ error: 'simulated job — the real charge path refuses it', code: 'SIMULATED' }, 409);
  if (job.training === true) return json({ error: 'training job — no card may be charged', code: 'TRAINING' }, 409);

  // Terminal + venue resolution shared by the initiating actions.
  const resolveTarget = async () => {
    const { data: term } = await opsAdmin.from('terminal_devices')
      .select('id, status, active, adyen_terminal_id')
      .eq('id', job.target_terminal_id).maybeSingle();
    const { data: ploc } = await platformAdmin.from('locations')
      .select('id').eq('ops_location_id', job.location_id).maybeSingle();
    const platformLocId = ploc?.id ?? job.location_id;
    const { data: maa } = await platformAdmin.from('merchant_adyen_accounts')
      .select('merchant_account, store_id, region, receive_payments_ok')
      .eq('location_id', platformLocId).maybeSingle();

    // Drift-reconcile the POIID against platform payment_devices — the exact
    // guard that saved the Ryft path (ops column can go stale on re-pair).
    let poiid = term?.adyen_terminal_id as string | null;
    const { data: pds } = await platformAdmin.from('payment_devices')
      .select('adyen_terminal_id').eq('location_id', platformLocId)
      .eq('processor', 'adyen').not('adyen_terminal_id', 'is', null);
    const ids = Array.isArray(pds) ? pds.map((r) => r.adyen_terminal_id as string).filter(Boolean) : [];
    if (poiid && ids.length && !ids.includes(poiid) && ids.length === 1) {
      console.log(`adyen-terminal-charge: ops POIID ${poiid} absent from payment_devices; using authoritative ${ids[0]} (job ${job.id})`);
      poiid = ids[0];
    }
    return { term, maa, poiid };
  };

  // ── start (cloud sync — the till drives an AMS1-class terminal) ────────────
  if (action === 'start' || action === 'prepare_local') {
    if (SETTLED.includes(job.status)) return json({ ok: false, error: `job already ${job.status}`, ...settledBody(job) }, 409);
    if (job.charge_minor == null) {
      await logRefusal('job has no server-computed charge', { action, jobId: job.id, status: job.status });
      return json({ ok: false, error: 'job has no server-computed charge — the tip was never committed' }, 409);
    }

    const { term, maa, poiid } = await resolveTarget();
    if (!term || term.status !== 'paired' || !term.active) {
      await logRefusal('terminal not paired', { action, jobId: job.id, targetTerminalId: job.target_terminal_id, termStatus: term?.status ?? null, termActive: term?.active ?? null });
      return json({ ok: false, error: 'terminal not paired' }, 409);
    }
    if (!poiid) {
      await logRefusal('terminal_not_linked (no POIID on the terminal row)', { action, jobId: job.id, targetTerminalId: job.target_terminal_id });
      return json({ ok: false, error: 'terminal_not_linked' }, 409);
    }
    if (!maa?.merchant_account) return json({ ok: false, error: 'venue has no Adyen account — onboarding incomplete' }, 409);

    // Idempotent replay: already in flight.
    if (job.status === 'charging') {
      if (job.payment_session_id) return json({ ok: true, payment_session_id: job.payment_session_id, idempotent: true });
      return json({ ok: false, error: 'in_flight', service_id: job.nexo_service_id ?? null }, 409);
    }
    if (job.status !== 'charging_unsent') return json({ ok: false, error: `job is ${job.status} — not ready to charge` }, 409);

    // CAS write-ahead — stamp the ServiceID in the SAME winning update so status
    // recovery always has the key, whatever happens next.
    const serviceId = newServiceId();
    const nowIso = new Date().toISOString();
    const { data: cas, error: casErr } = await opsAdmin.from('terminal_jobs')
      .update({
        status: 'charging', dispatched_at: nowIso, nexo_service_id: serviceId,
        claim_expires_at: new Date(Date.now() + 5 * 60_000).toISOString(), updated_at: nowIso,
      })
      .eq('id', job.id).eq('status', 'charging_unsent').select('id');
    if (casErr) return json({ error: casErr.message }, 500);
    if (!Array.isArray(cas) || cas.length !== 1) {
      const { data: fresh } = await opsAdmin.from('terminal_jobs')
        .select('status, payment_session_id, nexo_service_id').eq('id', job.id).maybeSingle();
      if (fresh?.payment_session_id) return json({ ok: true, payment_session_id: fresh.payment_session_id, idempotent: true });
      if (fresh?.status === 'charging') return json({ ok: false, error: 'in_flight' }, 409);
      return json({ ok: false, error: `job is ${fresh?.status ?? 'gone'} — not ready to charge` }, 409);
    }

    const chargeMinor = Number(job.charge_minor);
    // THE AMOUNT IS THE DB'S. Platform commission is NOT computed here — the
    // venue's store split profile (set from the admin portal at onboarding)
    // books it automatically on every payment.
    const nexo = buildPaymentRequest({
      poiid,
      saleId: `servos-${String(job.location_id).slice(0, 8)}`,
      serviceId,
      // v968: merchantReference IS the job pointer — `tj-{id}` lets the
      // AUTHORISATION webhook find and settle an in-flight job (review finding:
      // payment_session_id only exists AFTER settle, so it could never backstop).
      transactionId: `tj-${job.id}`,
      amountMinor: chargeMinor,
      currency: String(job.currency || 'GBP').toUpperCase(),
      storeId: maa.store_id ?? undefined,
      // Tip prompt ON the reader — from the job's FROZEN tip config (the same
      // config PaxPay renders on-device). The gratuity presets shown come from
      // the store's terminalSettings, synced from Back Office (sync_gratuities).
      askGratuity: (job.tip_config as { enabled?: boolean } | null)?.enabled === true,
    });

    // LOCAL TRANSPORT: hand the message to the on-terminal app / Tap to Pay SDK.
    // The row is 'charging' — the device MUST come back via report_local or the
    // recovery paths own it. Never expose keys; the payload is amount-fixed.
    //
    // ⚠ TODO(GO-LIVE BLOCKER — nexo local protection): `nexo` below is a PLAINTEXT
    // SaleToPOIRequest. A TEST terminal accepts that, which is what makes bench
    // testing on the S1F2L possible today. A LIVE Adyen terminal REFUSES it: the
    // local endpoint requires a SaleToPOISecuredMessage (AES-CBC body + HMAC-SHA256
    // MAC, keys derived from the store's local-comms passphrase via the Adyen
    // Customer Area). THIS FUNCTION IS THE PLACE THAT MUST DO THAT ENCRYPTION —
    // the wrapper posts the bytes verbatim and the web seam never inspects them, so
    // wrapping here (and unwrapping the PaymentResponse in report_local, before
    // parsePaymentResponse) is a change confined to this file plus a new secret.
    // Do NOT switch a venue to LIVE on the local transport until that ships.
    if (action === 'prepare_local') {
      return json({ ok: true, service_id: serviceId, poiid, nexo_request: nexo, charge_minor: chargeMinor, currency: String(job.currency || 'GBP').toUpperCase() });
    }

    // CLOUD TRANSPORT: one long sync call carries the whole cardholder interaction.
    let res;
    try {
      res = await adyenFetch('POST', terminalEndpoint(maa.merchant_account, poiid, 'sync', maa.region === 'US' ? 'us' : 'eu'), nexo, { timeoutMs: 165_000 });
    } catch (e) {
      // Outcome UNKNOWABLE (timeout/network) — row stays 'charging'; recovery owns it.
      console.error('adyen-terminal-charge: sync transport error', (e as Error).message);
      return json({ ok: false, error: 'terminal_unreachable — result pending recovery', code: 'UNKNOWN_OUTCOME' }, 502);
    }
    if (!res.ok && res.status >= 400 && res.status < 500) {
      // Definitive rejection before any card interaction — nothing charged.
      // CAS-revert so the till can retry cleanly.
      await opsAdmin.from('terminal_jobs')
        .update({ status: 'charging_unsent', nexo_service_id: null, updated_at: new Date().toISOString() })
        .eq('id', job.id).eq('status', 'charging');
      return json({ ok: false, safe: true, error: `adyen ${res.status}: ${JSON.stringify(res.data).slice(0, 300)}` }, 409);
    }
    if (!res.ok) {
      return json({ ok: false, error: 'terminal_unreachable — result pending recovery', code: 'UNKNOWN_OUTCOME' }, 502);
    }

    const parsed = parsePaymentResponse(res.data);
    // REVIEW HARDENING (v968, critical): a 200 with an empty/non-PaymentResponse
    // body (documented when the terminal is unreachable or the response timed
    // out mid-tender) parses 'Unknown'. Settling that as DECLINED while the
    // tender may still be LIVE is the double-charge — leave the row 'charging'
    // and let 'result'/events/webhook recovery own the truth.
    if (parsed.result === 'Unknown') {
      return json({ ok: false, error: 'terminal_unreachable — result pending recovery', code: 'UNKNOWN_OUTCOME' }, 502);
    }
    try { await settleFromResponse(job.id, parsed, 'charge_sync', chargeMinor); }
    catch (e) { return json({ ok: false, error: (e as Error).message }, 500); }
    const { data: settled } = await opsAdmin.from('terminal_jobs').select('*').eq('id', job.id).maybeSingle();
    return json(settledBody(settled ?? job));
  }

  // ── report_local (device returns the terminal's PaymentResponse) ───────────
  // REVIEW HARDENING (v968, critical): the device's report is ADVISORY. Three
  // gates before it can settle: (1) the response must carry THIS job's ServiceID
  // — a 51-bit random capability only the prepare_local caller ever received, so
  // stale attempts, other jobs and other devices can't bind; (2) POIID must match
  // the job's terminal when both are known; (3) a Success settle needs a real
  // AuthorizedAmount (enforced in settleFromResponse — no fallback for
  // 'device_report'). We ALSO try a cloud TransactionStatusRequest first: when
  // Adyen itself can answer, its answer wins over the device's claim.
  if (action === 'report_local') {
    if (SETTLED.includes(job.status)) return json(settledBody(job));
    if (job.status !== 'charging' && job.status !== 'unknown') {
      return json({ ok: false, error: `job is ${job.status} — nothing in flight` }, 409);
    }
    if (!body.response) return json({ error: 'response (nexo PaymentResponse) required' }, 400);
    const parsed = parsePaymentResponse(body.response);
    if (parsed.result === 'Unknown') return json({ ok: false, error: 'unparseable PaymentResponse' }, 400);
    if (!job.nexo_service_id || parsed.serviceId !== job.nexo_service_id) {
      return json({ ok: false, error: 'response does not match this job\'s attempt (ServiceID)' }, 409);
    }
    const { term: rTerm, maa: rMaa, poiid: rPoiid } = await resolveTarget();
    if (parsed.poiid && rPoiid && parsed.poiid !== rPoiid) {
      return json({ ok: false, error: 'response came from a different terminal (POIID)' }, 409);
    }
    void rTerm;
    // Prefer Adyen's own answer when reachable (boarded terminals stay cloud-
    // addressable even when the app used local comms).
    if (rMaa?.merchant_account && rPoiid) {
      try {
        const statusReq = buildTransactionStatusRequest({
          poiid: rPoiid, saleId: `servos-${String(job.location_id).slice(0, 8)}`,
          serviceId: newServiceId(), origServiceId: job.nexo_service_id,
        });
        const sres = await adyenFetch('POST', terminalEndpoint(rMaa.merchant_account, rPoiid, 'sync', rMaa.region === 'US' ? 'us' : 'eu'), statusReq, { timeoutMs: 15_000 });
        const ts = sres.ok ? (sres.data?.SaleToPOIResponse?.TransactionStatusResponse ?? null) : null;
        if (ts?.Response?.Result === 'Success') {
          const inner = parsePaymentResponse(ts?.RepeatedMessageResponse?.RepeatedResponseMessageBody ?? {});
          if (inner.result !== 'Unknown') {
            await settleFromResponse(job.id, inner, 'status_recovery', Number(job.charge_minor));
            const { data: settled } = await opsAdmin.from('terminal_jobs').select('*').eq('id', job.id).maybeSingle();
            return json(settledBody(settled ?? job));
          }
        }
      } catch { /* cloud unreachable — fall through to the gated device report */ }
    }
    try { await settleFromResponse(job.id, parsed, 'device_report', Number(job.charge_minor)); }
    catch (e) { return json({ ok: false, error: (e as Error).message }, 409); }
    const { data: settled } = await opsAdmin.from('terminal_jobs').select('*').eq('id', job.id).maybeSingle();
    return json(settledBody(settled ?? job));
  }

  // ── result (recovery via TransactionStatusRequest) ─────────────────────────
  if (action === 'result') {
    if (SETTLED.includes(job.status)) return json(settledBody(job));
    // v968: also recover jobs the sweeper flipped charging→'unknown' — that was
    // a dead end (review finding: no automated recovery path existed for them).
    if ((job.status !== 'charging' && job.status !== 'unknown') || !job.nexo_service_id) {
      return json({ ok: true, state: 'processing', status: job.status });
    }
    const { maa, poiid } = await resolveTarget();
    if (!maa?.merchant_account || !poiid) return json({ ok: true, state: 'processing', status: job.status });
    const statusReq = buildTransactionStatusRequest({
      poiid, saleId: `servos-${String(job.location_id).slice(0, 8)}`,
      serviceId: newServiceId(), origServiceId: job.nexo_service_id,
    });
    const res = await adyenFetch('POST', terminalEndpoint(maa.merchant_account, poiid, 'sync', maa.region === 'US' ? 'us' : 'eu'), statusReq, { timeoutMs: 30_000 });
    if (!res.ok) return json({ ok: true, state: 'processing', status: job.status });
    const ts = res.data?.SaleToPOIResponse?.TransactionStatusResponse ?? {};
    const cond = ts?.Response?.Result === 'Success' ? 'found'
      : ts?.Response?.ErrorCondition === 'InProgress' ? 'in_progress'
      : ts?.Response?.ErrorCondition === 'NotFound' ? 'not_found' : 'unknown';
    if (cond === 'in_progress' || cond === 'unknown') return json({ ok: true, state: 'processing', status: job.status });
    if (cond === 'not_found') {
      // The terminal never saw the request — provably nothing charged. Revert so
      // the till can retry (the one branch where reverting in-flight is safe).
      await opsAdmin.from('terminal_jobs')
        .update({ status: 'charging_unsent', nexo_service_id: null, updated_at: new Date().toISOString() })
        .eq('id', job.id).in('status', ['charging', 'unknown']);
      return json({ ok: false, safe: true, error: 'terminal never received the payment — retry' }, 409);
    }
    const inner = ts?.RepeatedMessageResponse?.RepeatedResponseMessageBody ?? {};
    const parsed = parsePaymentResponse(inner);
    if (parsed.result === 'Unknown') return json({ ok: true, state: 'processing', status: job.status });
    try { await settleFromResponse(job.id, parsed, 'status_recovery', Number(job.charge_minor)); }
    catch (e) { return json({ ok: false, error: (e as Error).message }, 500); }
    const { data: settled } = await opsAdmin.from('terminal_jobs').select('*').eq('id', job.id).maybeSingle();
    return json(settledBody(settled ?? job));
  }

  // ── abort (best-effort cancel of an in-flight tender) ──────────────────────
  if (action === 'abort') {
    if (SETTLED.includes(job.status)) return json({ ...settledBody(job), ok: false, error: `job already ${job.status}` });
    if (job.status !== 'charging' || !job.nexo_service_id) return json({ ok: true, state: 'processing', note: 'nothing in flight to abort' });
    const { maa, poiid } = await resolveTarget();
    if (maa?.merchant_account && poiid) {
      const ab = buildAbortRequest({
        poiid, saleId: `servos-${String(job.location_id).slice(0, 8)}`,
        serviceId: newServiceId(), origServiceId: job.nexo_service_id,
      });
      await adyenFetch('POST', terminalEndpoint(maa.merchant_account, poiid, 'sync', maa.region === 'US' ? 'us' : 'eu'), ab, { timeoutMs: 15_000 }).catch(() => null);
    }
    // Abort is advisory — the tender may already have completed. The job stays
    // 'charging'; 'result' / the webhook decides the truth.
    return json({ ok: true, state: 'processing', note: 'abort sent — confirm with result' });
  }

  return json({ error: 'unhandled action' }, 400);
});
