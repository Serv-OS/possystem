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
// For prepare_local/report_local the caller IS the on-terminal app, which boots
// as a paired device the same way.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  adyenConfigured, terminalEndpoint, adyenFetch,
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
  const { error } = await opsAdmin.rpc('terminal_job_settle_from_processor', {
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
  const jobId = String(body.job_id ?? '');
  if (!jobId || !['start', 'prepare_local', 'report_local', 'result', 'abort'].includes(action)) {
    return json({ error: "action ('start'|'prepare_local'|'report_local'|'result'|'abort') and job_id required" }, 400);
  }

  const { data: job, error: jobErr } = await opsAdmin.from('terminal_jobs').select('*').eq('id', jobId).maybeSingle();
  if (jobErr) return json({ error: jobErr.message }, 500);
  if (!job) return json({ error: 'job not found' }, 404);
  if (job.processor !== 'adyen') return json({ error: `job is ${job.processor ?? 'ryft'} — wrong charge path` }, 409);

  // Fence: a paired POS device AT THIS JOB'S LOCATION (till, kiosk, or our app
  // running on the Adyen terminal itself), or the service role.
  if (!isServiceRole) {
    const { data: dev } = await opsAdmin.from('devices')
      .select('id').eq('device_uid', callerUid).eq('location_id', job.location_id).maybeSingle();
    if (!dev) return json({ error: 'no access to this job' }, 403);
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
    if (job.charge_minor == null) return json({ ok: false, error: 'job has no server-computed charge — the tip was never committed' }, 409);

    const { term, maa, poiid } = await resolveTarget();
    if (!term || term.status !== 'paired' || !term.active) return json({ ok: false, error: 'terminal not paired' }, 409);
    if (!poiid) return json({ ok: false, error: 'terminal_not_linked' }, 409);
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
