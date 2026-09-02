// supabase/functions/adyen-checkout/index.ts
//
// Adyen ONLINE payments (programme slice 1a) — Checkout API v72 sessions.
// The online checkout (OnlineCheckout.jsx → AdyenPaymentForm) asks for a
// session; Adyen's Drop-in completes the payment client-side; AUTHORISATION
// lands on adyen-webhook (stored raw, HMAC-verified) for reconciliation.
//
// Pattern-matched to the existing stripe-create-payment-intent contract:
// anonymous-auth'd customers call it, amounts arrive from the client (same
// trust model as Stripe/Ryft online today — the webhook records what was
// ACTUALLY paid, and orders reconcile on merchantReference = our order ref).
//
// Raw REST from Deno (X-API-Key) per the plan — the Adyen Node SDK has no
// Deno support. Secrets: ADYEN_API_KEY / ADYEN_MERCHANT_ACCOUNT / ADYEN_ENV /
// ADYEN_CLIENT_KEY (served to the client — it is a publishable key).

import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const API_KEY = Deno.env.get('ADYEN_API_KEY') ?? '';
const MERCHANT = Deno.env.get('ADYEN_MERCHANT_ACCOUNT') ?? '';
const CLIENT_KEY = Deno.env.get('ADYEN_CLIENT_KEY') ?? '';
const ENV = (Deno.env.get('ADYEN_ENV') ?? 'test').toLowerCase();
const CHECKOUT_BASE = ENV === 'live' ? 'https://checkout-live.adyen.com' : 'https://checkout-test.adyen.com';

// ── Store routing (26 Aug 2026) ─────────────────────────────────────────────
// FranPOS's Adyen account moved onto the Balance Platform, where card routing
// hangs off the STORE, not the merchant account. Terminals name their store
// implicitly, so POS kept working while every ECOM request (no store) started
// refusing with 905_1 "could not find an acquirer account". The venue's store
// id already lives in merchant_adyen_accounts (terminal provisioning wrote it)
// so resolve it from there: by location when the caller sends one, else the
// single receive_payments_ok row for this merchant. Never fails the payment —
// no store resolved just means the request goes out exactly as before.
const platformAdmin = createClient(
  Deno.env.get('PLATFORM_SUPABASE_URL') ?? '',
  Deno.env.get('PLATFORM_SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { autoRefreshToken: false, persistSession: false } },
);
let storeCache: { at: number; key: string; store: string | null } | null = null;
async function resolveStore(locationId?: string): Promise<string | null> {
  const key = locationId || '*';
  if (storeCache && storeCache.key === key && Date.now() - storeCache.at < 60_000) return storeCache.store;
  let store: string | null = null;
  try {
    let q = platformAdmin.from('merchant_adyen_accounts')
      .select('location_id, store_id, receive_payments_ok')
      .eq('merchant_account', MERCHANT);
    if (locationId) q = q.eq('location_id', locationId);
    const { data, error } = await q;
    if (error) console.error('[adyen-checkout] store lookup failed:', error.message);
    const rows = (data ?? []).filter((r) => r.receive_payments_ok && r.store_id);
    if (rows.length === 1) store = rows[0].store_id as string;
    else if (rows.length > 1) console.error('[adyen-checkout] ambiguous store: pass location_id (rows:', rows.length, ')');
  } catch (e) {
    console.error('[adyen-checkout] store lookup threw:', (e as Error).message);
  }
  storeCache = { at: Date.now(), key, store };
  return store;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    if (!API_KEY || !MERCHANT || !CLIENT_KEY) return json({ error: 'Adyen is not configured on this environment' }, 500);
    const body = await req.json().catch(() => ({}));
    const action = body.action || 'create_session';

    // Live connection status for the admin portal — replaces a hardcoded
    // "coming soon" sign that outlived its truth within a week (v5.6.20).
    // No secrets in the response; merchant account NAME is admin-visible info.
    if (action === 'status') {
      return json({
        ok: true,
        configured: true,
        environment: ENV,
        merchantAccount: MERCHANT,
        clientKey: CLIENT_KEY,            // publishable — the card form needs it to render
        online: true,                     // slice 1a shipped — advanced flow + Drop-in
        inPerson: false,                  // awaits test terminals (slice 1b)
      });
    }

    if (action === 'create_session') {
      const amount = Math.round(Number(body.amount_minor));
      if (!Number.isFinite(amount) || amount < 1) return json({ error: 'amount_minor must be a positive integer (pence)' }, 400);
      const currency = String(body.currency || 'GBP').toUpperCase();
      const reference = String(body.reference || '').slice(0, 80);
      if (!reference) return json({ error: 'reference required (the order ref)' }, 400);

      const session: Record<string, unknown> = {
        merchantAccount: MERCHANT,
        amount: { value: amount, currency },
        reference,
        returnUrl: String(body.return_url || 'https://dev.serv-os.app/'),
        countryCode: String(body.country || 'GB').toUpperCase(),
        channel: 'Web',
      };
      if (body.shopper_email) session.shopperEmail = String(body.shopper_email);
      const sessionStore = await resolveStore(body.location_id ? String(body.location_id) : undefined);
      if (sessionStore) session.store = sessionStore;

      const res = await fetch(`${CHECKOUT_BASE}/v72/sessions`, {
        method: 'POST',
        headers: { 'X-API-Key': API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify(session),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        console.error('[adyen-checkout] sessions failed:', res.status, JSON.stringify(j).slice(0, 400));
        return json({ error: j.message || `Adyen refused the session (${res.status})` }, 502);
      }
      return json({
        ok: true,
        id: j.id,
        sessionData: j.sessionData,
        clientKey: CLIENT_KEY,
        environment: ENV,
        reference,
        amount: j.amount,
      });
    }

    // ── make_payment: the ADVANCED flow. Drop-in encrypts the card in the
    //    browser and hands us the blob; WE make the payment server-side with
    //    the API key. Adopted 11 Aug after the sessions flow's checkoutshopper
    //    /payments returned an unexplainable 403 (origin+key+role all verified
    //    good — a probe with invalid sessionData got 422, the real payment
    //    403, so the refusal sits deeper in Adyen's hosted stack). Server-side
    //    we see EVERY error in full, and this is the same path the terminal
    //    work needs anyway. ──────────────────────────────────────────────────
    if (action === 'make_payment') {
      const amount = Math.round(Number(body.amount_minor));
      if (!Number.isFinite(amount) || amount < 1) return json({ error: 'amount_minor must be a positive integer (pence)' }, 400);
      const reference = String(body.reference || '').slice(0, 80);
      if (!reference) return json({ error: 'reference required' }, 400);
      if (!body.payment_method || typeof body.payment_method !== 'object') {
        return json({ error: 'payment_method (the encrypted card from the form) required' }, 400);
      }
      const payment: Record<string, unknown> = {
        merchantAccount: MERCHANT,
        amount: { value: amount, currency: String(body.currency || 'GBP').toUpperCase() },
        reference,
        paymentMethod: body.payment_method,
        channel: 'Web',
        origin: String(body.origin || ''),
        returnUrl: String(body.return_url || 'https://dev.serv-os.app/'),
        shopperInteraction: 'Ecommerce',
      };
      // v5.8.17 QR OPEN TAB: a pre-authorisation that is captured LATER for the
      // real bill (or cancelled). Both additional-data keys are the ones our
      // terminal path already sends in SaleToAcquirerData, so they are proven
      // on this account. No captureDelayHours: the earlier attempt used a 7-day
      // delay, which would have auto-charged an abandoned tab in full. A tab
      // nobody closes now simply expires on Adyen (28 days, sooner per scheme).
      if (body.capture_method === 'manual') {
        payment.additionalData = { ...(payment.additionalData as object || {}), authorisationType: 'PreAuth', manualCapture: 'true' };
      }
      if (body.store_card && body.shopper_reference) {
        payment.shopperReference = String(body.shopper_reference).slice(0, 80);
        payment.storePaymentMethod = true;
        payment.recurringProcessingModel = 'UnscheduledCardOnFile';
      }
      if (body.browser_info) payment.browserInfo = body.browser_info;
      if (body.shopper_email) payment.shopperEmail = String(body.shopper_email);
      const store = await resolveStore(body.location_id ? String(body.location_id) : undefined);
      if (store) payment.store = store;

      const res = await fetch(`${CHECKOUT_BASE}/v72/payments`, {
        method: 'POST',
        headers: { 'X-API-Key': API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify(payment),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        console.error('[adyen-checkout] payments failed:', res.status, JSON.stringify(j).slice(0, 500));
        return json({ error: j.message || `Adyen refused the payment (${res.status})`, errorCode: j.errorCode || null }, 502);
      }
      // resultCode: Authorised | Refused | RedirectShopper | IdentifyShopper | …
      // `action` present = 3DS or redirect step the client must run.
      return json({
        ok: true,
        resultCode: j.resultCode || null,
        pspReference: j.pspReference || null,
        refusalReason: j.refusalReason || null,
        action: j.action || null,
        merchantReference: reference,
      });
    }

    // ── payment_details: completes a 3DS/redirect flow started above ─────────
    if (action === 'payment_details') {
      if (!body.details) return json({ error: 'details required' }, 400);
      const res = await fetch(`${CHECKOUT_BASE}/v72/payments/details`, {
        method: 'POST',
        headers: { 'X-API-Key': API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ details: body.details }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) return json({ error: j.message || `Adyen refused (${res.status})` }, 502);
      return json({ ok: true, resultCode: j.resultCode || null, pspReference: j.pspReference || null, refusalReason: j.refusalReason || null, action: j.action || null });
    }

    // ── v5.8.17 QR open tab close: customer-callable, like ryft-tab ──────────
    // The psp reference is the secret (only the tab holder's phone and the
    // venue know it), exactly as the Ryft session id is on ryft-tab. Capture can
    // only move money TO the venue, never out.
    //   tab_capture { psp_reference, amount_minor, hold_minor?, currency?, reference? }
    //     -> { ok, captured, captured_amount, shortfall, currency }
    //   tab_cancel  { psp_reference, reference? } -> { ok }
    if (action === 'tab_capture' || action === 'tab_cancel') {
      const psp = String(body.psp_reference || '').trim();
      if (!psp) return json({ error: 'psp_reference required' }, 400);
      const currency = String(body.currency || 'GBP').toUpperCase();
      const hdr = (key: string) => ({ 'X-API-Key': API_KEY, 'Content-Type': 'application/json', 'Idempotency-Key': key.slice(0, 64) });
      if (action === 'tab_cancel') {
        const res = await fetch(`${CHECKOUT_BASE}/v72/payments/${encodeURIComponent(psp)}/cancels`, {
          method: 'POST', headers: hdr(`tabcan:${psp}`),
          body: JSON.stringify({ merchantAccount: MERCHANT, reference: String(body.reference || `tab-cancel:${psp}`).slice(0, 80) }),
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) return json({ ok: false, error: j.message || `Adyen refused the cancel (${res.status})` }, 200);
        return json({ ok: true, status: j.status || 'received' });
      }
      const wanted = Math.round(Number(body.amount_minor));
      if (!Number.isFinite(wanted) || wanted < 1) return json({ error: 'amount_minor must be a positive integer' }, 400);
      const hold = Number.isFinite(Number(body.hold_minor)) && Number(body.hold_minor) > 0 ? Math.round(Number(body.hold_minor)) : null;
      const tryCapture = async (value: number, salt: string) => {
        const res = await fetch(`${CHECKOUT_BASE}/v72/payments/${encodeURIComponent(psp)}/captures`, {
          method: 'POST', headers: hdr(`tabcap:${psp}:${value}:${salt}`),
          body: JSON.stringify({ merchantAccount: MERCHANT, amount: { value, currency }, reference: String(body.reference || `tab-capture:${psp}`).slice(0, 80) }),
        });
        const j = await res.json().catch(() => ({}));
        return { ok: res.ok, j, status: res.status };
      };
      // Bill above the hold: try the real bill first (some schemes allow an
      // overcapture), then fall back to the hold and report the shortfall so
      // staff collect it, the same contract the Stripe path returns.
      let r = await tryCapture(wanted, 'a');
      let captured = wanted;
      if (!r.ok && hold && wanted > hold) { r = await tryCapture(hold, 'b'); captured = hold; }
      if (!r.ok) return json({ ok: false, captured: false, error: r.j?.message || `Adyen refused the capture (${r.status})` }, 200);
      return json({ ok: true, captured: true, captured_amount: captured, shortfall: Math.max(0, wanted - captured), currency: currency.toLowerCase(), amount: captured, modification_psp: r.j?.pspReference || null });
    }

    return json({ error: `unknown action: ${action}` }, 400);
  } catch (e) {
    console.error('[adyen-checkout]', e);
    return json({ error: (e as Error).message || 'server error' }, 500);
  }
});
