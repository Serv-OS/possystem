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
import { parsePaymentResponse, buildMenuInputRequest, parseMenuInputResponse, newServiceId, adyenFetch, terminalEndpoint } from '../_shared/adyen.ts';

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
  // Accept EITHER Basic auth OR the shared key as a query param — Adyen
  // terminals post event notifications THEMSELVES and some firmware drops
  // userinfo (user:pass@) from URLs silently (14 Aug: zero arrivals at the
  // gateway with credentials-in-URL config verified stored at Adyen).
  try {
    const k = new URL(req.url).searchParams.get('k');
    if (k && k === PASS) return true;
  } catch { /* fall through to Basic */ }
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
        .select('id, status, charge_minor, processor, target_terminal_id')
        .eq('nexo_service_id', serviceId).eq('processor', 'adyen').maybeSingle();
      // v968 review hardening: ServiceIDs are now random+DB-unique, and the match
      // is additionally scoped to the sending terminal's POIID; swept 'unknown'
      // jobs recover here too (they had NO automated recovery path before).
      let poiidOk = true;
      if (tj && poiid) {
        const { data: td } = await opsAdmin.from('terminal_devices')
          .select('adyen_terminal_id').eq('id', tj.target_terminal_id).maybeSingle();
        if (td?.adyen_terminal_id && td.adyen_terminal_id !== poiid) {
          poiidOk = false;
          console.error(`[adyen-terminal-events] POIID mismatch: response from ${poiid}, job terminal ${td.adyen_terminal_id}`);
        }
      }
      if (tj && poiidOk && (tj.status === 'charging' || tj.status === 'unknown')) {
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
      // THE RESPONDER (v5.6.59, task #102). Real payload proven 14 Aug:
      //   EventDetails: "reference_id=2"  ← the table number staff typed.
      // Answer: match the table at this reader's venue, freeze its bill into a
      // terminal job (terminal_start_table_payment_for), and kick the charge
      // back at the SAME reader. Ack fast; the long charge rides waitUntil.
      const details = String(evt?.EventDetails ?? '');
      const ref = (details.match(/reference_id=([A-Za-z0-9]+)/) || [])[1]
        || (details.match(/^([A-Za-z0-9]+)$/) || [])[1] || '';
      const respond = async () => {
        try {
          // An EMPTY reference is the "show me the tables" gesture — staff
          // pressed straight through the pin pad. Fall to the menu path (the
          // empty ref matches no candidates below).
          const { data: term } = await opsAdmin.from('terminal_devices')
            .select('id, location_id, modes').eq('adyen_terminal_id', poiid)
            .eq('status', 'paired').eq('active', true).maybeSingle();
          if (!term) { console.log(`[pay-at-table] no paired terminal for ${poiid}`); return; }

          // Table match: staff type "2" for a table labelled "T2" (or "2").
          // Only tables with an OPEN session are candidates; refuse ambiguity.
          const [{ data: sess }, { data: floor }] = await Promise.all([
            opsAdmin.from('active_sessions').select('table_id').eq('location_id', term.location_id),
            opsAdmin.from('floor_tables').select('id, label').eq('location_id', term.location_id),
          ]);
          const open = new Set((sess || []).map((r) => String(r.table_id)));
          const norm = (x: string) => String(x || '').toLowerCase();
          const digits = (x: string) => String(x || '').replace(/[^0-9]/g, '');
          let candidates = (floor || []).filter((f) => open.has(String(f.id)) && (
            norm(f.label) === norm(ref) || (digits(f.label) === digits(ref) && digits(ref) !== '')
          ));

          // No/ambiguous match → show the OPEN TABLES as a menu ON THE READER
          // (Peter, 15 Aug: "load all the tables so I can see what's open then
          // choose"). Staff pick from the list; billed table resolved from the
          // 1-based selection.
          if (candidates.length !== 1) {
            const { data: bills } = await opsAdmin.from('active_sessions')
              .select('table_id, total_minor').eq('location_id', term.location_id);
            const billBy = new Map((bills || []).map((r) => [String(r.table_id), Number(r.total_minor) || 0]));
            const openTables = (floor || [])
              .filter((f) => open.has(String(f.id)))
              .sort((a, b) => String(a.label).localeCompare(String(b.label), undefined, { numeric: true }))
              .slice(0, 20);
            if (!openTables.length) { console.log('[pay-at-table] no open tables to list'); return; }
            const { data: maaRow } = await platformAdmin.from('locations')
              .select('id').eq('ops_location_id', term.location_id).maybeSingle();
            const { data: maa } = await platformAdmin.from('merchant_adyen_accounts')
              .select('merchant_account, region').eq('location_id', maaRow?.id ?? term.location_id).maybeSingle();
            if (!maa?.merchant_account) { console.log('[pay-at-table] no merchant for menu'); return; }
            const menu = buildMenuInputRequest({
              poiid,
              saleId: `servos-${String(term.location_id).slice(0, 8)}`,
              serviceId: newServiceId(),
              title: 'Pay at table — choose the table',
              entries: openTables.map((f) => {
                const b = billBy.get(String(f.id));
                return `${f.label}  ·  £${((b || 0) / 100).toFixed(2)}`;
              }),
            });
            const mres = await adyenFetch('POST', terminalEndpoint(maa.merchant_account, poiid, 'sync', maa.region === 'US' ? 'us' : 'eu'), menu, { timeoutMs: 90_000 });
            const pick = parseMenuInputResponse(mres.data);
            console.log(`[pay-at-table] menu result ${pick.result}, selected ${pick.selected}`);
            if (!pick.selected || pick.selected < 1 || pick.selected > openTables.length) return;
            candidates = [openTables[pick.selected - 1]];
          }

          const { data: job, error: rpcErr } = await opsAdmin.rpc('terminal_start_table_payment_for', {
            p_terminal_device_id: term.id, p_table_id: candidates[0].id,
          });
          if (rpcErr) { console.log(`[pay-at-table] job refusal: ${rpcErr.message}`); return; }
          const jobId = (job as Record<string, unknown>)?.job_id;
          if (!jobId) { console.log('[pay-at-table] RPC returned no job id'); return; }

          // Kick the charge at the SAME reader — the bill appears on its screen.
          const res = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/adyen-terminal-charge`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}` },
            body: JSON.stringify({ action: 'start', job_id: jobId }),
          });
          const out = await res.text();
          console.log(`[pay-at-table] charge kick for table ${candidates[0].label}: ${res.status} ${out.slice(0, 200)}`);
        } catch (e) {
          console.error('[pay-at-table] responder failed:', (e as Error)?.message || e);
        }
      };
      // deno-lint-ignore no-explicit-any
      const rt = (globalThis as any).EdgeRuntime;
      if (rt?.waitUntil) rt.waitUntil(respond());
      else respond();
    }
    return new Response('ok', { status: 200 });
  }

  return new Response('ok', { status: 200 });
});
