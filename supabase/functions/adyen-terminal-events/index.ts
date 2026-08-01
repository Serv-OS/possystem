// supabase/functions/adyen-terminal-events
//
// Adyen Terminal API EVENT NOTIFICATIONS endpoint (configured in CA → event
// notifications). Two message families arrive here:
//
//   1. ASYNC cloud Terminal API results — SaleToPOIResponse (PaymentResponse)
//      for /async dispatches and for /sync calls whose connection died. Settled
//      through the SAME single settle-writer the sync path uses, matched by the
//      job's persisted nexo ServiceID.
//   2. SaleToPOIRequest EVENT notifications — most importantly SaleWakeUp
//      (staff started Pay-at-table ON the terminal). Phase 0 records them into
//      adyen_webhook_events; Phase 3 wires the POS to answer with the bill.
//
// Auth: Basic auth credentials configured on the CA endpoint —
// ADYEN_EVENTS_USER / ADYEN_EVENTS_PASS. Fail closed until set.
// Deployed with verify_jwt=false (Adyen calls this).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { parsePaymentResponse } from '../_shared/adyen.ts';

const opsAdmin = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { autoRefreshToken: false, persistSession: false } },
);
const platformAdmin = createClient(
  Deno.env.get('PLATFORM_SUPABASE_URL') ?? '',
  Deno.env.get('PLATFORM_SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const USER = Deno.env.get('ADYEN_EVENTS_USER') ?? '';
const PASS = Deno.env.get('ADYEN_EVENTS_PASS') ?? '';

function authorized(req: Request): boolean {
  if (!USER || !PASS) return false; // fail closed pre-keys
  const h = req.headers.get('Authorization') ?? '';
  if (!h.startsWith('Basic ')) return false;
  try {
    const [u, p] = atob(h.slice(6)).split(':');
    return u === USER && p === PASS;
  } catch { return false; }
}

// settle card shape shared with adyen-terminal-charge (duplicated deliberately —
// edge fns bundle per-function; keep in lockstep).
function settleCard(p: ReturnType<typeof parsePaymentResponse>) {
  const c = p.card;
  if (!c.brand && !c.last4 && !c.authCode) return null;
  return { brand: c.brand, last4: c.last4, auth_code: c.authCode, read_method: c.readMethod, aid: c.aid, application_name: c.applicationName, cvm: c.cvm, account_type: null };
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
  if (!authorized(req)) return new Response('unauthorized', { status: 401 });

  let body: any;
  try { body = await req.json(); } catch { return new Response('bad json', { status: 400 }); }

  // ── Async PaymentResponse → settle by persisted ServiceID ─────────────────
  const resp = body?.SaleToPOIResponse;
  if (resp?.PaymentResponse) {
    const serviceId = resp?.MessageHeader?.ServiceID ?? null;
    const poiid = resp?.MessageHeader?.POIID ?? null;
    if (serviceId) {
      const { data: tj } = await opsAdmin.from('terminal_jobs')
        .select('id, status, charge_minor, processor')
        .eq('nexo_service_id', serviceId).eq('processor', 'adyen').maybeSingle();
      if (tj && tj.status === 'charging') {
        const parsed = parsePaymentResponse(body);
        if (parsed.result !== 'Unknown') {
          const success = parsed.result === 'Success';
          const { error } = await opsAdmin.rpc('terminal_job_settle_from_processor', {
            p_job_id: tj.id,
            p_outcome: success ? 'approved' : 'declined',
            p_payment_session_id: parsed.pspReference,
            p_transaction_id: parsed.poiTransactionId ?? parsed.pspReference,
            p_auth_code: parsed.card.authCode,
            p_card: settleCard(parsed),
            p_decline_reason: success ? null : (parsed.errorCondition ?? 'declined'),
            p_source: 'event_notification',
            p_session_amount_minor: parsed.authorizedMinor ?? (success ? Number(tj.charge_minor) : null),
          });
          if (error) console.error('[adyen-terminal-events] settle rpc', error.message);
        }
      } else if (!tj) {
        console.log(`[adyen-terminal-events] PaymentResponse for unknown ServiceID ${serviceId} (POIID ${poiid})`);
      }
    }
    // Record raw for audit either way (idempotent on retry).
    await platformAdmin.from('adyen_webhook_events')
      .insert({ event_key: `tapi:${poiid ?? 'unknown'}:${serviceId ?? crypto.randomUUID()}`, raw: body })
      .then(() => {}, () => {});
    return new Response('ok', { status: 200 });
  }

  // ── Event notifications (SaleWakeUp = Pay-at-table started on terminal) ────
  const evt = body?.SaleToPOIRequest?.EventNotification;
  if (evt) {
    const poiid = body?.SaleToPOIRequest?.MessageHeader?.POIID ?? 'unknown';
    const eventKind = evt?.EventToNotify ?? 'unknown';
    // Phase 3 wires the POS answer (find the bill → PaymentRequest back). For
    // now the event is durably recorded so nothing is lost and the flow can be
    // bench-tested the day hardware arrives.
    await platformAdmin.from('adyen_webhook_events')
      .insert({ event_key: `tevt:${poiid}:${eventKind}:${Date.now()}`, raw: body })
      .then(() => {}, () => {});
    if (eventKind === 'SaleWakeUp') {
      console.log(`[adyen-terminal-events] SaleWakeUp from ${poiid} — pay-at-table initiated on terminal (POS wiring: Phase 3)`);
    }
    return new Response('ok', { status: 200 });
  }

  return new Response('ok', { status: 200 });
});
