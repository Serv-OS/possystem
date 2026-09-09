// supabase/functions/adyen-checkout/index.ts
//
// Adyen ONLINE payments (programme slice 1a), Checkout API v72 sessions.
// The online checkout (OnlineCheckout.jsx, then AdyenPaymentForm) asks for a
// session; Adyen's Drop-in completes the payment client-side; AUTHORISATION
// lands on adyen-webhook (stored raw, HMAC-verified) for reconciliation.
//
// Pattern-matched to the existing stripe-create-payment-intent contract:
// anonymous-auth'd customers call it, amounts arrive from the client (same
// trust model as Stripe/Ryft online today; the webhook records what was
// ACTUALLY paid, and orders reconcile on merchantReference = our order ref).
//
// Raw REST from Deno (X-API-Key) per the plan; the Adyen Node SDK has no
// Deno support.
//
// PER VENUE ENVIRONMENT (7 Sep 2026): every request resolves the venue from
// location_id (either id space) and reads merchant_adyen_accounts.environment
// for it; the matching secret set (ADYEN_* for test, ADYEN_LIVE_<REGION>_*
// for live) supplies the key, the client key, the merchant account and the
// Checkout host. A live venue without live keys fails closed. A request that
// names no venue (the admin portal's global status call) uses the ADYEN_ENV
// fallback.
//
// PER VENUE REGION (8 Sep 2026): merchant_adyen_accounts.region ('UK' | 'US',
// a legacy 'EU' reads as UK, no row = by the location's currency) picks the
// live secret set, the Checkout host (the region's own prefix) and the
// Drop-in environment ('live' for UK, 'live-us' for US). status returns
// { environment, region, dropinEnvironment, clientKey } so the card form
// mounts the Drop-in against the right data centre.

import { createClient } from 'npm:@supabase/supabase-js@2';
import {
  adyenConfig, adyenAccountForLocation, adyenFallbackEnv, platformLocationIdFor, isUnknownColumnError,
  checkoutBase, adyenFetch, adyenNotConfiguredMessage, maskMerchantAccount, paymentIdempotencyKey, effectiveMerchantAccount, adyenSecretName,
  type AdyenConfig,
} from '../_shared/adyen.ts';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

// Live host for the shopper's return leg. The caller's own return_url always
// wins; this is only the default when it sends none.
const DEFAULT_RETURN_URL = 'https://app.serv-os.app/';

const platformAdmin = createClient(
  Deno.env.get('PLATFORM_SUPABASE_URL') ?? '',
  Deno.env.get('PLATFORM_SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { autoRefreshToken: false, persistSession: false } },
);

// ── Venue resolution (7 Sep 2026) ────────────────────────────────────────────
// location_id arrives as the PLATFORM id from AdyenPaymentForm and as the OPS
// id from the QR tab close (adyenTab.js), so both are accepted.
//
// What is cached and what is not: ONLY the id mapping (ops or platform id ->
// platform id), which never changes. The venue's environment, merchant
// account and store are read from merchant_adyen_accounts on EVERY request
// (one indexed maybeSingle), so a Back Office flip between test and live takes
// effect on the very next card call. A cached environment would have kept
// charging real cards for up to a minute after an operator switched to test.
//
// A supplied id the platform DB does not know is `known: false`, never the
// ADYEN_ENV fallback: the handler answers 404 for every money action. A DB
// error THROWS (platformLocationIdFor and adyenAccountForLocation both do)
// and the outer catch turns it into a 500. Neither is cached.
interface VenueAccountRow extends Record<string, unknown> {
  merchant_account?: string | null;
  store_id?: string | null;
  receive_payments_ok?: boolean | null;
}
interface Venue {
  known: boolean;                       // false = an id was supplied but no platform location matches it
  platformLocationId: string | null;
  cfg: AdyenConfig;
  merchantAccount: string;              // the venue row's account, else the set's ADYEN[_LIVE]_MERCHANT_ACCOUNT
  store: string | null;                 // the venue's own store when it can receive payments
}
const idCache = new Map<string, string>();   // supplied id -> platform location id (non null only)
async function resolveVenue(id?: string): Promise<Venue> {
  const key = String(id ?? '').trim();
  if (!key) {
    const cfg = adyenConfig(adyenFallbackEnv());
    return { known: true, platformLocationId: null, cfg, merchantAccount: cfg.merchantAccount, store: await fallbackStore(cfg) };
  }
  let platformLocationId = idCache.get(key) ?? null;
  if (!platformLocationId) {
    platformLocationId = await platformLocationIdFor(platformAdmin, key);
    if (platformLocationId) idCache.set(key, platformLocationId);
  }
  if (!platformLocationId) {
    // Unknown venue: only `status` may answer (with the fallback set's
    // publishable facts); every money action is refused by the handler.
    const cfg = adyenConfig(adyenFallbackEnv());
    return { known: false, platformLocationId: null, cfg, merchantAccount: cfg.merchantAccount, store: null };
  }
  const { env, region, row } = await adyenAccountForLocation<VenueAccountRow>(platformAdmin, platformLocationId,
    ['merchant_account', 'store_id', 'receive_payments_ok']);
  const cfg = adyenConfig(env, region);   // the venue's environment AND region set
  // The venue's own merchant account and store travel together (a store only
  // exists under its merchant account), the way adyen-create-session and the
  // terminal path already send them. The secret set's account is the fallback
  // for a venue with no row.
  // 8 Sep 2026: a row still naming the OTHER environment's secret account
  // (a venue flipped to live before set_environment rewrote merchant_account)
  // falls back to this environment's secret account.
  const merchantAccount = effectiveMerchantAccount(cfg, row?.merchant_account);
  const store = row?.receive_payments_ok && row?.store_id ? String(row.store_id) : null;
  return { known: true, platformLocationId, cfg, merchantAccount, store };
}

// ── Store routing (26 Aug 2026) ─────────────────────────────────────────────
// FranPOS's Adyen account moved onto the Balance Platform, where card routing
// hangs off the STORE, not the merchant account. Terminals name their store
// implicitly, so POS kept working while every ECOM request (no store) started
// refusing with 905_1 "could not find an acquirer account". The venue's store
// id already lives in merchant_adyen_accounts (terminal provisioning wrote it).
// With a venue named, resolveVenue reads it off the venue's OWN row above.
// This is the no venue fallback only: the single receive_payments_ok row on
// this environment's merchant account, scoped to the environment (the same
// merchant account name exists in test and live). Never fails the payment; no
// store resolved just means the request goes out exactly as before.
const storeCache = new Map<string, { at: number; store: string | null }>();
async function fallbackStore(cfg: AdyenConfig): Promise<string | null> {
  const key = `${cfg.env}:*`;
  const hit = storeCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.store;
  let store: string | null = null;
  try {
    const q = (scoped: boolean) => {
      let b = platformAdmin.from('merchant_adyen_accounts')
        .select('location_id, store_id, receive_payments_ok').eq('merchant_account', cfg.merchantAccount);
      if (scoped) b = b.eq('environment', cfg.env);
      return b;
    };
    let { data, error } = await q(true);
    if (error && isUnknownColumnError(error)) ({ data, error } = await q(false));
    if (error) console.error('[adyen-checkout] store lookup failed:', error.message);
    const rows = (data ?? []).filter((r) => r.receive_payments_ok && r.store_id);
    if (rows.length === 1) store = rows[0].store_id as string;
    else if (rows.length > 1) console.error('[adyen-checkout] ambiguous store: pass location_id (rows:', rows.length, ')');
  } catch (e) {
    console.error('[adyen-checkout] store lookup threw:', (e as Error).message);
  }
  storeCache.set(key, { at: Date.now(), store });
  return store;
}

// Idempotency-Key for /payments. The card form mints a UUID per submit
// (attempt_id), so a retransmit of that submit replays Adyen's answer and a
// fresh submit (a retry after a refusal) gets a fresh decision. It is NEVER
// derived from the order ref alone: refs are five random base36 chars minted
// client side, Adyen scopes keys to the whole company for at least a week,
// and a colliding ref would have replayed a stranger's Authorised response
// onto a new order. A caller without attempt_id gets a one off key.
const ATTEMPT_ID_RE = /^[A-Za-z0-9._-]{8,60}$/;
async function paymentKeyFor(body: Record<string, unknown>, platformLocationId: string | null, reference: string): Promise<string> {
  const attemptId = String(body.attempt_id ?? '').trim();
  if (ATTEMPT_ID_RE.test(attemptId)) return `pay:${attemptId}`;
  return await paymentIdempotencyKey(`${platformLocationId || 'x'}:${reference}:${crypto.randomUUID()}`, 1);
}

// Does the venue have a registered card reader? payment_devices is the
// platform registry adyen-terminal-admin writes on assign.
async function hasTerminal(platformLocationId: string | null): Promise<boolean> {
  if (!platformLocationId) return false;
  try {
    const { data } = await platformAdmin.from('payment_devices')
      .select('id').eq('location_id', platformLocationId).eq('processor', 'adyen').neq('status', 'retired').limit(1);
    return Array.isArray(data) && data.length > 0;
  } catch { return false; }
}

// Checkout base + path. cfg.checkoutBase already carries the version segment
// for BOTH shapes (test .../v72, live .../checkout/v72), so paths join without
// a version of their own. checkoutBase(cfg) fails closed on live without keys.
const checkoutUrl = (cfg: AdyenConfig, path: string) => `${checkoutBase(cfg)}${path}`;

// Defaults when the caller sends no currency or country: the venue's region
// (8 Sep 2026; they were hardcoded GBP and GB). Callers always send the
// currency, so this only ever decides the country code.
const defaultCurrency = (cfg: AdyenConfig) => (cfg.region === 'US' ? 'USD' : 'GBP');
const defaultCountry = (cfg: AdyenConfig) => (cfg.region === 'US' ? 'US' : 'GB');

// The ONLY payment method types this checkout mounts (Card, ApplePay,
// GooglePay; 'paywithgoogle' is the legacy Google name the GooglePay class
// also registers). It is BOTH the allowlist for a caller's allowed_types and
// the filter on what is echoed back, so a caller cannot ask for a method this
// checkout never renders and get its configuration block in return.
const CHECKOUT_PAYMENT_TYPES = ['scheme', 'applepay', 'googlepay', 'paywithgoogle'];
const isCheckoutType = (t: unknown) => CHECKOUT_PAYMENT_TYPES.includes(String(t ?? '').toLowerCase());

// KEEP IN SYNC with NO_NATIVE_3DS_TYPES in src/lib/payments/adyenWallets.js
// (Deno cannot import from src/); adyenWallets.test.js is the contract for
// both copies. See the comment at make_payment for why it is Apple Pay ALONE
// and not every wallet.
const NO_NATIVE_3DS_TYPES = ['applepay'];

// Wallet readiness for the ADMIN portal, answered on `status` when the caller
// asks for it (`wallets: true`). It is one extra Adyen call, so it is never
// on the shopper's path: the checkout gets the real list from
// payment_methods, and this exists so "why did Apple Pay not load?" is
// answerable from the venue's own Adyen screen instead of a browser console.
//
// A wallet counts as ON only when Adyen both OFFERS it and sends the
// identifiers the browser cannot render it without (see usableWalletMethods
// in src/lib/payments/adyenWallets.js, which drops the rest before Drop-in
// can throw on them). Never throws: a failed probe is { error }.
interface WalletProbe { applepay: boolean; googlepay: boolean; offered: string[]; error: string | null }
async function probeWallets(cfg: AdyenConfig, merchantAccount: string, store: string | null): Promise<WalletProbe> {
  const out: WalletProbe = { applepay: false, googlepay: false, offered: [], error: null };
  try {
    const res = await adyenFetch('POST', checkoutUrl(cfg, '/paymentMethods'), {
      merchantAccount,
      // A nominal amount: Adyen decides what to offer from the amount and the
      // country, and a real basket is not available on a status call.
      amount: { value: 1000, currency: defaultCurrency(cfg) },
      countryCode: defaultCountry(cfg),
      channel: 'Web',
      allowedPaymentMethods: CHECKOUT_PAYMENT_TYPES,
      ...(store ? { store } : {}),
    }, { cfg });
    const j = res.data ?? {};
    if (!res.ok) {
      out.error = String(j.message || `Adyen refused the payment methods lookup (${res.status})`);
      return out;
    }
    const list = Array.isArray(j.paymentMethods) ? j.paymentMethods as Record<string, unknown>[] : [];
    const unusable: string[] = [];
    for (const pm of list) {
      const type = String(pm?.type ?? '').toLowerCase();
      if (type !== 'applepay' && type !== 'googlepay' && type !== 'paywithgoogle') continue;
      out.offered.push(type);
      const conf = (pm?.configuration && typeof pm.configuration === 'object' ? pm.configuration : {}) as Record<string, unknown>;
      const has = (k: string) => String(conf[k] ?? '').trim() !== '';
      if (type === 'applepay') {
        if (has('merchantId')) out.applepay = true;
        else unusable.push('Apple Pay is offered but carries no merchant identifier');
      } else if (has('merchantId') && has('gatewayMerchantId')) {
        out.googlepay = true;
      } else {
        unusable.push('Google Pay is offered but carries no Google merchant ID');
      }
    }
    if (unusable.length) out.error = unusable.join('; ');
  } catch (e) {
    out.error = (e as Error).message || String(e);
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const body = await req.json().catch(() => ({}));
    const action = body.action || 'create_session';
    const venue = await resolveVenue(body.location_id ? String(body.location_id) : undefined);
    const { platformLocationId, cfg, merchantAccount, store } = venue;
    // A named venue the platform DB does not know: nothing that moves money
    // may run against the fallback environment. status still answers (the
    // admin portal probes venues by id) but says the venue is unknown.
    if (!venue.known && action !== 'status') return json({ error: 'location not found' }, 404);
    // No venue named = the ADYEN_ENV fallback set. That is fine for the admin
    // portal's status probe and for nothing else: a money action without a
    // venue would run a live venue's card, hold or capture on the test host
    // (8 Sep 2026).
    if (!String(body.location_id ?? '').trim() && action !== 'status') return json({ error: 'location_id required' }, 400);
    if (!cfg.configured || !merchantAccount || !cfg.clientKey) {
      // Name EVERY missing secret for the venue's region, the client key and
      // the merchant account included (8 Sep 2026: cfg.missing only covers
      // the api key, the prefix and the merchant account secret, so a live
      // venue with no client key was told nothing to set).
      const missing = new Set<string>(cfg.missing);
      if (!cfg.clientKey) missing.add(adyenSecretName(cfg.env, 'clientKey', cfg.region));
      if (!merchantAccount) missing.add(adyenSecretName(cfg.env, 'merchantAccount', cfg.region));
      return json({ error: cfg.live ? adyenNotConfiguredMessage({ ...cfg, missing: [...missing] }) : 'Adyen is not configured on this environment' }, 500);
    }

    // Live connection status for the admin portal and the card form. No
    // secrets in the response: the client key is publishable, the merchant
    // account name is masked.
    //
    // MASKING IS A STATUS-ONLY POLICY, BY DESIGN (8 Sep 2026): Google Pay
    // cannot render without configuration.gatewayMerchantId, and on Adyen
    // that IS the merchant account code, so payment_methods below hands the
    // browser the same value in clear. The mask here is tidiness on an admin
    // screen, not a secret.
    if (action === 'status') {
      // One extra Adyen call, so only when the caller asks (the admin portal
      // does; the checkout never does). This is where "why did Apple Pay not
      // load?" gets an answer an operator can read.
      const wallets = body.wallets === true ? await probeWallets(cfg, merchantAccount, store) : null;
      return json({
        ok: true,
        configured: true,
        environment: cfg.env,
        region: cfg.region,                  // 'UK' | 'US', the secret set and hosts in use
        dropinEnvironment: cfg.dropinEnvironment,   // 'test' | 'live' | 'live-us' for the Drop-in
        merchantAccount: maskMerchantAccount(merchantAccount),
        clientKey: cfg.clientKey,            // publishable, the card form needs it to render
        online: true,                        // slice 1a shipped, advanced flow + Drop-in
        inPerson: await hasTerminal(platformLocationId),
        ...(wallets ? { wallets } : {}),
        locationId: platformLocationId,
        ...(venue.known ? {} : { warning: 'location not found in platform DB; payments for it will be refused' }),
      });
    }

    // ── payment_methods: what this venue can actually offer (8 Sep 2026) ──────
    // The card form used to hand Drop-in a HARDCODED card only list, so Apple
    // Pay and Google Pay could never appear however the merchant account was
    // set up. That was the whole reason Apple Pay did not load in checkout.
    //
    //   POST {checkoutBase}/paymentMethods
    //     required: merchantAccount, amount { currency, value }
    //     optional: countryCode, channel, shopperLocale, store,
    //               allowedPaymentMethods, blockedPaymentMethods
    //   https://docs.adyen.com/api-explorer/Checkout/72/post/paymentMethods
    //   https://docs.adyen.com/online-payments/build-your-integration/advanced-flow
    //
    // NOTHING IS CACHED here. Adyen decides what to offer from the amount, the
    // currency and the country, so a cache keyed on the venue would hand a
    // £4.50 coffee the method list of a £450 function booking.
    //
    // The store travels exactly as it does on /payments: on the Balance
    // Platform, card routing hangs off the store, and a paymentMethods lookup
    // without it can answer for a different acquirer than the payment will.
    //
    // A refusal is answered 200 with { ok: false, cardOnly: true } and the
    // publishable config, NOT a 5xx: the checkout must still mount the card
    // form. Losing the wallets is a degraded checkout; losing the card form is
    // a dead one.
    if (action === 'payment_methods') {
      const amountIn = (body.amount && typeof body.amount === 'object') ? body.amount as Record<string, unknown> : null;
      const amount = Math.round(Number(amountIn?.value ?? body.amount_minor));
      if (!Number.isFinite(amount) || amount < 1) return json({ error: 'amount.value must be a positive integer (minor units)' }, 400);
      const currency = String(amountIn?.currency || body.currency || defaultCurrency(cfg)).toUpperCase();
      const countryCode = String(body.countryCode || body.country || defaultCountry(cfg)).toUpperCase();
      // The publishable facts the caller needs whether or not Adyen answers,
      // so a cardOnly fallback still knows which data centre to mount against.
      const publishable = {
        clientKey: cfg.clientKey,
        environment: cfg.env,
        dropinEnvironment: cfg.dropinEnvironment,
        region: cfg.region,
      };

      const request: Record<string, unknown> = {
        merchantAccount,
        amount: { value: amount, currency },
        countryCode,
        channel: 'Web',
      };
      if (body.shopperLocale || body.shopper_locale) request.shopperLocale = String(body.shopperLocale || body.shopper_locale).slice(0, 16);
      // The caller names the types it can actually mount (scheme, applepay,
      // googlepay, the legacy paywithgoogle). Without it Adyen answers with
      // every method enabled on the account and Drop-in drops the ones we
      // never imported, with a console warning each. Documented
      // /paymentMethods request field.
      //
      // INTERSECTED WITH THE SERVER'S OWN ALLOWLIST: allowed_types is caller
      // controlled, and a method this checkout never mounts must not have its
      // configuration block handed back on request.
      const allowed = Array.isArray(body.allowed_types)
        ? [...new Set((body.allowed_types as unknown[]).map((t) => String(t || '').trim().toLowerCase()).filter(isCheckoutType))]
        : [];
      request.allowedPaymentMethods = allowed.length ? allowed : CHECKOUT_PAYMENT_TYPES;
      if (store) request.store = store;

      const res = await adyenFetch('POST', checkoutUrl(cfg, '/paymentMethods'), request, { cfg });
      const j = res.data ?? {};
      if (!res.ok) {
        console.error('[adyen-checkout] paymentMethods failed:', res.status, JSON.stringify(j).slice(0, 400));
        return json({
          ok: false,
          cardOnly: true,
          error: j.message || `Adyen refused the payment methods lookup (${res.status})`,
          errorCode: j.errorCode || null,
          ...publishable,
        });
      }
      // Each ENTRY is returned as is (the shape Drop-in wants for
      // paymentMethodsResponse is Adyen's own, and re-mapping would silently
      // drop a wallet's `configuration` block, the merchantId and the
      // gatewayMerchantId that Apple Pay and Google Pay cannot render
      // without), but the LIST
      // is filtered to what this checkout mounts and nothing else of Adyen's
      // answer is echoed. In particular storedPaymentMethods is not: no
      // caller sends a shopperReference, so there are none today, and shopper
      // data must not become a passthrough the day one does.
      const methods = Array.isArray(j.paymentMethods)
        ? (j.paymentMethods as Record<string, unknown>[]).filter((pm) => isCheckoutType(pm?.type))
        : [];
      return json({ paymentMethods: methods, ...publishable, ok: true });
    }

    if (action === 'create_session') {
      const amount = Math.round(Number(body.amount_minor));
      if (!Number.isFinite(amount) || amount < 1) return json({ error: 'amount_minor must be a positive integer (pence)' }, 400);
      const currency = String(body.currency || defaultCurrency(cfg)).toUpperCase();
      const reference = String(body.reference || '').slice(0, 80);
      if (!reference) return json({ error: 'reference required (the order ref)' }, 400);

      const session: Record<string, unknown> = {
        merchantAccount,
        amount: { value: amount, currency },
        reference,
        returnUrl: String(body.return_url || DEFAULT_RETURN_URL),
        countryCode: String(body.country || defaultCountry(cfg)).toUpperCase(),
        channel: 'Web',
      };
      if (body.shopper_email) session.shopperEmail = String(body.shopper_email);
      if (store) session.store = store;
      if (platformLocationId) session.metadata = { location_id: platformLocationId };

      const res = await adyenFetch('POST', checkoutUrl(cfg, '/sessions'), session, { cfg });
      const j = res.data ?? {};
      if (!res.ok) {
        console.error('[adyen-checkout] sessions failed:', res.status, JSON.stringify(j).slice(0, 400));
        return json({ error: j.message || `Adyen refused the session (${res.status})` }, 502);
      }
      return json({
        ok: true,
        id: j.id,
        sessionData: j.sessionData,
        clientKey: cfg.clientKey,
        environment: cfg.env,
        region: cfg.region,
        dropinEnvironment: cfg.dropinEnvironment,
        reference,
        amount: j.amount,
      });
    }

    // ── make_payment: the ADVANCED flow. Drop-in encrypts the card in the
    //    browser and hands us the blob; WE make the payment server-side with
    //    the API key. Adopted 11 Aug after the sessions flow's checkoutshopper
    //    /payments returned an unexplainable 403 (origin+key+role all verified
    //    good; a probe with invalid sessionData got 422, the real payment
    //    403, so the refusal sits deeper in Adyen's hosted stack). Server-side
    //    we see EVERY error in full, and this is the same path the terminal
    //    work needs anyway. ───────────────────────────────────────────────────
    if (action === 'make_payment') {
      const amount = Math.round(Number(body.amount_minor));
      if (!Number.isFinite(amount) || amount < 1) return json({ error: 'amount_minor must be a positive integer (pence)' }, 400);
      const reference = String(body.reference || '').slice(0, 80);
      if (!reference) return json({ error: 'reference required' }, 400);
      if (!body.payment_method || typeof body.payment_method !== 'object') {
        return json({ error: 'payment_method (the encrypted card or wallet token from the form) required' }, 400);
      }
      // 8 Sep 2026 WALLETS: paymentMethod arrives verbatim from Drop-in, so a
      // wallet ({ type: 'applepay', applePayToken } or { type: 'googlepay',
      // googlePayToken, googlePayCardNetwork }) needs nothing translated here.
      // Everything else (origin, returnUrl, browserInfo when the component
      // sends one, shopperInteraction Ecommerce, the store, the metadata) is
      // identical for a card and a wallet. Apple Pay's state.data carries no
      // browserInfo at all, which is expected and fine: the
      // `if (body.browser_info)` guard below already omits it.
      //
      // NATIVE 3DS2 IS SKIPPED FOR APPLE PAY ALONE, not for every wallet.
      // The premise (the device already authenticated the shopper and the
      // token carries the scheme cryptogram) holds for Apple Pay and for a
      // Google Pay CRYPTOGRAM_3DS (DPAN) token. It does NOT hold for a Google
      // Pay PAN_ONLY (FPAN) token: adyen-web's GooglePay defaults to
      // allowedAuthMethods ['PAN_ONLY','CRYPTOGRAM_3DS'] and we do not narrow
      // it, so an FPAN token can arrive with no cryptogram, is processed as
      // raw card data and is expected to go through 3D Secure. Without the
      // flag Adyen answers RedirectShopper on a challenge, and the storefront
      // cannot complete a redirect (see below), an unexplained dead end for
      // a shopper paying with a Google-account card. GooglePay.formatData()
      // does send browserInfo, so the flag is the only missing half.
      // KEEP IN SYNC with NO_NATIVE_3DS_TYPES in src/lib/payments/adyenWallets.js.
      const pmType = String((body.payment_method as Record<string, unknown>).type || '').toLowerCase();
      const skipNativeThreeDS = NO_NATIVE_3DS_TYPES.includes(pmType);
      const payment: Record<string, unknown> = {
        merchantAccount,
        amount: { value: amount, currency: String(body.currency || defaultCurrency(cfg)).toUpperCase() },
        reference,
        paymentMethod: body.payment_method,
        channel: 'Web',
        origin: String(body.origin || ''),
        returnUrl: String(body.return_url || DEFAULT_RETURN_URL),
        shopperInteraction: 'Ecommerce',
        // Native 3DS2 (the challenge runs inside the Drop-in, completed by
        // onAdditionalDetails -> payment_details). Without this Adyen may
        // answer RedirectShopper, and nothing on the storefront handles the
        // redirect return, so the order would be lost (8 Sep 2026).
        // Everything but Apple Pay: see the wallet note above.
        ...(skipNativeThreeDS ? {} : { authenticationData: { threeDSRequestData: { nativeThreeDS: 'preferred' } } }),
        // Echoed back on the webhook as additionalData['metadata.location_id']
        // (with "Include Metadata" on in the Customer Area) so an online
        // payment resolves its venue directly, not by merchant account name,
        // which stops working at the second venue on the same account.
        ...(platformLocationId ? { metadata: { location_id: platformLocationId, ops_location_id: String(body.location_id || '') } } : {}),
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
      if (store) payment.store = store;

      // Idempotency-Key from the form's per submit attempt_id (see paymentKeyFor).
      const idempotencyKey = await paymentKeyFor(body, platformLocationId, reference);
      const res = await adyenFetch('POST', checkoutUrl(cfg, '/payments'), payment, { cfg, idempotencyKey });
      const j = res.data ?? {};
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

    // ── payment_details: completes a 3DS/redirect flow started above ──────────
    if (action === 'payment_details') {
      if (!body.details) return json({ error: 'details required' }, 400);
      const res = await adyenFetch('POST', checkoutUrl(cfg, '/payments/details'), { details: body.details }, { cfg });
      const j = res.data ?? {};
      if (!res.ok) return json({ error: j.message || `Adyen refused (${res.status})` }, 502);
      return json({ ok: true, resultCode: j.resultCode || null, pspReference: j.pspReference || null, refusalReason: j.refusalReason || null, action: j.action || null });
    }

    // ── v5.8.17 QR open tab close: customer-callable, like ryft-tab ───────────
    // The psp reference is the secret (only the tab holder's phone and the
    // venue know it), exactly as the Ryft session id is on ryft-tab. Capture can
    // only move money TO the venue, never out.
    //   tab_capture { psp_reference, amount_minor, hold_minor?, currency?, reference? }
    //     -> { ok, captured, captured_amount, shortfall, currency }
    //   tab_cancel  { psp_reference, reference? } -> { ok }
    if (action === 'tab_capture' || action === 'tab_cancel') {
      const psp = String(body.psp_reference || '').trim();
      if (!psp) return json({ error: 'psp_reference required' }, 400);
      const currency = String(body.currency || defaultCurrency(cfg)).toUpperCase();
      if (action === 'tab_cancel') {
        const res = await adyenFetch('POST', checkoutUrl(cfg, `/payments/${encodeURIComponent(psp)}/cancels`),
          { merchantAccount, reference: String(body.reference || `tab-cancel:${psp}`).slice(0, 80) },
          { cfg, idempotencyKey: `tabcan:${psp}`.slice(0, 64) });
        const j = res.data ?? {};
        if (!res.ok) return json({ ok: false, error: j.message || `Adyen refused the cancel (${res.status})` }, 200);
        return json({ ok: true, status: j.status || 'received' });
      }
      const wanted = Math.round(Number(body.amount_minor));
      if (!Number.isFinite(wanted) || wanted < 1) return json({ error: 'amount_minor must be a positive integer' }, 400);
      const hold = Number.isFinite(Number(body.hold_minor)) && Number(body.hold_minor) > 0 ? Math.round(Number(body.hold_minor)) : null;
      const tryCapture = async (value: number, salt: string) => {
        const res = await adyenFetch('POST', checkoutUrl(cfg, `/payments/${encodeURIComponent(psp)}/captures`),
          { merchantAccount, amount: { value, currency }, reference: String(body.reference || `tab-capture:${psp}`).slice(0, 80) },
          // Salted with the caller's reference tail: a capture Adyen refused
          // at this amount must not replay the refusal on the retry.
          { cfg, idempotencyKey: `tabcap:${psp}:${value}:${salt}:${String(body.reference || '').slice(-8)}`.slice(0, 64) });
        return { ok: res.ok, j: res.data ?? {}, status: res.status };
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
