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
import { parsePaymentResponse, buildMenuInputRequest, parseMenuInputResponse, buildAmountInputRequest, parseAmountInputResponse, newServiceId, adyenFetch, terminalEndpoint } from '../_shared/adyen.ts';

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
        .select('id, status, charge_minor, due_minor, processor, target_terminal_id, location_id, check_draft')
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
          // v5.6.70 — credit an ON-READER gratuity before settling, exactly as
          // adyen-terminal-charge's settleFromResponse does. This branch is the
          // recovery path for a /sync call whose connection died, and pay-at-table
          // jobs ask for a tip: without the recompute the RPC saw "processor 2200
          // vs server 2000", parked the leg needs_human, and its tip vanished from
          // the final split check (and the leg could never be reconciled).
          const chargeMinor = Number(tj.charge_minor);
          const tip = parsed.tipMinor ?? 0;
          if (success && parsed.authorizedMinor != null && parsed.authorizedMinor !== chargeMinor
              && tip > 0 && chargeMinor + tip === parsed.authorizedMinor) {
            const { error: tipErr } = await opsAdmin.from('terminal_jobs')
              .update({ tip_minor: tip, charge_minor: parsed.authorizedMinor })
              .eq('id', tj.id).is('tip_minor', null);
            if (tipErr) console.error('[adyen-terminal-events] tip recompute', tipErr.message);
          }
          const { data: settled, error } = await opsAdmin.rpc('terminal_job_settle_from_processor', {
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
          // Split-leg toast (kept in lockstep with adyen-terminal-charge): a
          // PARTIAL pay-at-table leg never books a check, so this activity event
          // is the only thing the floor sees. Gate on the RPC's non-idempotent
          // approved transition — exactly-once across sync/async settle races.
          const d = (tj.check_draft ?? {}) as Record<string, unknown>;
          if (!error && (settled as any)?.ok === true && (settled as any)?.idempotent !== true
              && (settled as any)?.status === 'approved'
              && d.source === 'adyen_pay_at_table' && d.partial === true) {
            // Publish paid-so-far onto the live session FIRST — that column is
            // what every till and the reader read to know what is still owed.
            await opsAdmin.rpc('terminal_sync_table_paid', { p_job_id: tj.id })
              .then(() => {}, (e: Error) => console.error('[adyen-terminal-events] sync paid', e?.message));
            const left = Number(d.remainingAfterMinor) || 0;
            await opsAdmin.from('activity_events').insert({
              location_id: tj.location_id, kind: 'system', severity: 'action',
              title: `Part payment — ${d.tableLabel ?? d.tableId ?? 'table'}`,
              body: `£${((Number(tj.due_minor) || 0) / 100).toFixed(2)} taken on the card reader. £${(left / 100).toFixed(2)} left to pay — take the rest with Pay at table.`,
              ref_type: 'terminal_job', ref_id: tj.id,
            }).then(() => {}, () => {});
          }
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
          // Pre-warm the charge fn NOW (its cold start was most of the ~25s
          // button-to-bill lag): an OPTIONS request costs nothing and runs
          // while staff are still looking at the menu.
          fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/adyen-terminal-charge`, { method: 'OPTIONS' }).catch(() => {});
          // An EMPTY reference is the "show me the tables" gesture — staff
          // pressed straight through the pin pad. Fall to the menu path (the
          // empty ref matches no candidates below).
          const { data: term } = await opsAdmin.from('terminal_devices')
            .select('id, location_id, modes').eq('adyen_terminal_id', poiid)
            .eq('status', 'paired').eq('active', true).maybeSingle();
          if (!term) { console.log(`[pay-at-table] no paired terminal for ${poiid}`); return; }

          // Table match: staff type "2" for a table labelled "T2" (or "2").
          // Only tables with an OPEN session are candidates; refuse ambiguity.
          // The third query pulls this venue's settled split legs (6h window —
          // the SAME scan the RPC's paid-so-far uses) so every figure the
          // reader shows is what's LEFT to pay, not the gross bill.
          // active_sessions.paid_minor is server-maintained (terminal_sync_table_paid
          // runs after every settled leg), so "what is left" is ONE column read —
          // no windowed job scan to drift out of step with the RPC's own maths.
          const [{ data: sess }, { data: floor }] = await Promise.all([
            opsAdmin.from('active_sessions')
              .select('table_id, total_minor, paid_minor, session').eq('location_id', term.location_id),
            opsAdmin.from('floor_tables').select('id, label').eq('location_id', term.location_id),
          ]);
          const sessBy = new Map((sess || []).map((r) => [String(r.table_id), r]));
          const remainingFor = (tableId: string): number => {
            const row = sessBy.get(String(tableId));
            if (!row) return 0;
            return Math.max(0, (Number(row.total_minor) || 0) - (Number(row.paid_minor) || 0));
          };
          const open = new Set((sess || []).map((r) => String(r.table_id)));
          const norm = (x: string) => String(x || '').toLowerCase();
          const digits = (x: string) => String(x || '').replace(/[^0-9]/g, '');
          let candidates = (floor || []).filter((f) => open.has(String(f.id)) && (
            norm(f.label) === norm(ref) || (digits(f.label) === digits(ref) && digits(ref) !== '')
          ));

          // Merchant + sync-Input plumbing, needed on EVERY path now (the
          // pay-all/split menu and amount entry ride the same pipe as the
          // table list).
          const { data: maaRow } = await platformAdmin.from('locations')
            .select('id').eq('ops_location_id', term.location_id).maybeSingle();
          const { data: maa } = await platformAdmin.from('merchant_adyen_accounts')
            .select('merchant_account, region').eq('location_id', maaRow?.id ?? term.location_id).maybeSingle();
          if (!maa?.merchant_account) { console.log('[pay-at-table] no merchant account'); return; }
          const saleId = `servos-${String(term.location_id).slice(0, 8)}`;
          const askInput = (msg: unknown) =>
            adyenFetch('POST', terminalEndpoint(maa.merchant_account, poiid, 'sync', maa.region === 'US' ? 'us' : 'eu'), msg, { timeoutMs: 90_000 });

          // v5.6.70 — SAY IT ON THE READER. Every refusal below used to `return`
          // silently, so the screen simply fell back to the home menu and staff
          // had no idea why ("choose the table, fires back to the home screen").
          // A one-entry menu is the shape already proven on this hardware.
          const say = async (text: string) => {
            try {
              await askInput(buildMenuInputRequest({
                poiid, saleId, serviceId: newServiceId(),
                title: text, entries: ['OK'], maxInputTime: 20,
              }));
            } catch { /* telling staff is best-effort; never mask the real reason */ }
            console.log(`[pay-at-table] told reader: ${text}`);
          };

          // No/ambiguous match → show the OPEN TABLES as a menu ON THE READER
          // (Peter, 15 Aug: "load all the tables so I can see what's open then
          // choose"). Staff pick from the list; billed table resolved from the
          // 1-based selection.
          if (candidates.length !== 1) {
            const openTables = (floor || [])
              .filter((f) => open.has(String(f.id)))
              .sort((a, b) => String(a.label).localeCompare(String(b.label), undefined, { numeric: true }))
              .slice(0, 20);
            if (!openTables.length) { await say('No open tables to pay right now.'); return; }
            const menu = buildMenuInputRequest({
              poiid,
              saleId,
              serviceId: newServiceId(),
              title: 'Pay at table — choose the table',
              entries: openTables.map((f) => `${f.label}  ·  £${(remainingFor(f.id) / 100).toFixed(2)}`),
            });
            const mres = await askInput(menu);
            const pick = parseMenuInputResponse(mres.data);
            console.log(`[pay-at-table] menu result ${pick.result}, selected ${pick.selected}`);
            // Durable diagnostics — console logs proved unreadable through the
            // analytics API, so the reader's exact menu answer is recorded where
            // we can always query it.
            await platformAdmin.from('adyen_webhook_events').insert({
              event_key: `menu:${poiid}:${Date.now()}`,
              raw: { httpStatus: mres.status, parsed: pick, entries: openTables.map((f) => f.label), response: mres.data ?? null },
            }).then(() => {}, () => {});
            if (!pick.selected || pick.selected < 1 || pick.selected > openTables.length) return;
            candidates = [openTables[pick.selected - 1]];
          }

          // ── Pay all, or split? (task #103) ─────────────────────────────────
          // Always asked — it doubles as bill confirmation on the typed-number
          // path (title shows the table + what's owed before anything charges).
          const table = candidates[0];

          // ── Unwedge a stuck job BEFORE refusing (v5.6.70) ──────────────────
          // A job left 'unknown' (dispatched, no result — live 15 Aug on T4)
          // sits in a status the mutex treats as in-flight, so EVERY later
          // wake-up on that table was refused and the reader bounced home with
          // no explanation. The charge fn's 'result' action asks the terminal
          // what actually happened: NotFound proves nothing was charged and
          // reverts the job so it can be retried; a real outcome settles it.
          const sess0 = sessBy.get(String(table.id));
          const ckey = `${term.location_id}:${table.id}:${(sess0?.session as Record<string, unknown>)?.id ?? '-'}`;
          const LIVE = ['pending', 'claimed', 'tipping', 'charging_unsent', 'charging', 'unknown'];
          const { data: stuck } = await opsAdmin.from('terminal_jobs')
            .select('id, status').eq('check_key', ckey).in('status', LIVE).limit(1).maybeSingle();
          if (stuck) {
            if (stuck.status === 'charging' || stuck.status === 'unknown') {
              const rr = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/adyen-terminal-charge`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}` },
                body: JSON.stringify({ action: 'result', job_id: stuck.id }),
              }).then((r) => r.text()).catch((e) => String(e));
              console.log(`[pay-at-table] recovery on stuck ${stuck.status} job ${stuck.id}: ${rr.slice(0, 200)}`);
              const { data: after } = await opsAdmin.from('terminal_jobs')
                .select('status').eq('id', stuck.id).maybeSingle();
              // charging_unsent = terminal never saw it, safe to supersede.
              if (after && LIVE.includes(after.status) && after.status !== 'charging_unsent') {
                await say('That table has a payment in progress. Finish it on the reader.');
                return;
              }
              await opsAdmin.from('terminal_jobs')
                .update({ status: 'cancelled', last_error: 'superseded — terminal never received it (pay-at-table retry)', updated_at: new Date().toISOString() })
                .eq('id', stuck.id).eq('status', 'charging_unsent').is('payment_session_id', null);
            } else {
              await say('That table has a payment in progress. Finish it on the reader.');
              return;
            }
          }

          const remaining = remainingFor(table.id);
          if (remaining <= 0) {
            const t = Number(sess0?.total_minor);
            await say(Number.isFinite(t) && t > 0
              ? `${table.label} is fully paid — settle any difference on the till.`
              : `${table.label} has no bill yet — send the order from the till first.`);
            return;
          }
          let amountMinor: number | null = null;               // null = charge everything owed
          const pres = await askInput(buildMenuInputRequest({
            poiid, saleId, serviceId: newServiceId(),
            title: `${table.label}  ·  £${(remaining / 100).toFixed(2)}`,
            entries: [`Pay all  ·  £${(remaining / 100).toFixed(2)}`, 'Split — enter amount'],
            maxInputTime: 45,
          }));
          const payPick = parseMenuInputResponse(pres.data);
          await platformAdmin.from('adyen_webhook_events').insert({
            event_key: `paymenu:${poiid}:${Date.now()}`,
            raw: { httpStatus: pres.status, parsed: payPick, remaining, response: pres.data ?? null },
          }).then(() => {}, () => {});
          if (!payPick.selected) return;                       // cancelled / timed out
          if (payPick.selected === 2) {
            const ares = await askInput(buildAmountInputRequest({
              poiid, saleId, serviceId: newServiceId(),
              title: 'Split — enter amount to pay',
            }));
            const amt = parseAmountInputResponse(ares.data);
            await platformAdmin.from('adyen_webhook_events').insert({
              event_key: `amount:${poiid}:${Date.now()}`,
              raw: { httpStatus: ares.status, parsed: amt, remaining, response: ares.data ?? null },
            }).then(() => {}, () => {});
            if (!amt.amountMinor || amt.amountMinor <= 0) return;   // cancelled / zero — staff chose to back out
            if (amt.amountMinor > remaining) {
              await say(`Only £${(remaining / 100).toFixed(2)} left on ${table.label} — taking that.`);
            }
            amountMinor = Math.min(amt.amountMinor, remaining);      // the RPC clamps too
          }

          // PIN THE OCCUPATION staff just confirmed on the reader. Menus + typing
          // take minutes; without this the RPC would bind the charge to whoever is
          // sitting there when it finally runs (a re-seat mid-flow charged the new
          // party for the old party's bill).
          const pinned = sessBy.get(String(table.id));
          const pinnedSession = (pinned?.session ?? {}) as Record<string, unknown>;
          const { data: job, error: rpcErr } = await opsAdmin.rpc('terminal_start_table_payment_for', {
            p_terminal_device_id: term.id,
            p_table_id: table.id,
            p_amount_minor: amountMinor,
            p_session_id: pinnedSession.id == null ? null : String(pinnedSession.id),
            p_seated_at: pinnedSession.seatedAt == null ? null : String(pinnedSession.seatedAt),
          });
          if (rpcErr) {
            // The RPC's messages are already written for staff ("this table has
            // already been paid", "changed while you were choosing"). Show them
            // rather than dropping to the home screen.
            console.log(`[pay-at-table] job refusal: ${rpcErr.message}`);
            await say(String(rpcErr.message || 'Could not start that payment').slice(0, 120));
            return;
          }
          const jobId = (job as Record<string, unknown>)?.job_id;
          if (!jobId) { await say('Could not start that payment — try again'); return; }

          // Kick the charge at the SAME reader — the bill appears on its screen.
          const res = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/adyen-terminal-charge`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}` },
            body: JSON.stringify({ action: 'start', job_id: jobId }),
          });
          const out = await res.text();
          console.log(`[pay-at-table] charge kick for table ${table.label} (${amountMinor == null ? 'pay all' : `split £${(amountMinor / 100).toFixed(2)}`}): ${res.status} ${out.slice(0, 200)}`);
          if (!res.ok) {
            // The card screen never came up. Release the job we just minted so
            // the table is not wedged for the next attempt (it cannot have
            // charged — 'start' failed before or at dispatch), then say so.
            await opsAdmin.from('terminal_jobs')
              .update({ status: 'cancelled', last_error: `charge kick failed: ${out.slice(0, 200)}`, updated_at: new Date().toISOString() })
              .eq('id', jobId).eq('status', 'charging_unsent').is('payment_session_id', null);
            let why = 'Could not reach the card reader — try again';
            try { why = JSON.parse(out)?.error || why; } catch { /* keep the default */ }
            await say(String(why).slice(0, 120));
          }
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
