// supabase/functions/_shared/adyen.ts
//
// Minimal Adyen REST client + protocol helpers for edge functions (raw REST —
// the official SDK targets Node 18/node-https and does not run on Deno).
// Built per ADYEN_INTEGRATION_PLAN.md Phase 0; API facts from docs/adyen/research/*.
//
// Auth: X-API-Key header. Amounts: Checkout + webhooks use MINOR units
// ({value, currency}); Terminal API (nexo 3.0) uses DECIMAL MAJOR units.
//
// Env (Supabase secrets — set when the test keys arrive):
//   ADYEN_API_KEY            ws user API key (Checkout/Terminal/Management roles as needed)
//   ADYEN_HMAC_KEY           standard-webhook HMAC key (hex, from CA webhook config)
//   ADYEN_BP_HMAC_KEY        balance-platform webhook HMAC key (raw-body flavour)
//   ADYEN_ENV                'test' (default) | 'live'
//   ADYEN_LIVE_PREFIX        e.g. 1797a841fbb37ca7-ServOS — REQUIRED live for Checkout/LEM
//   ADYEN_MERCHANT_ACCOUNT   default merchant account (per-venue override via merchant_adyen_accounts)
//   ADYEN_CHECKOUT_BASE / ADYEN_LEM_BASE / ADYEN_BP_BASE / ADYEN_MGMT_BASE / ADYEN_DEVICE_BASE
//                            optional explicit overrides (else derived below)

const ENV = (Deno.env.get('ADYEN_ENV') ?? 'test').toLowerCase();
const LIVE = ENV === 'live';
const PREFIX = Deno.env.get('ADYEN_LIVE_PREFIX') ?? '';
const API_KEY = Deno.env.get('ADYEN_API_KEY') ?? '';

export const ADYEN_MERCHANT_ACCOUNT = Deno.env.get('ADYEN_MERCHANT_ACCOUNT') ?? '';
export const adyenConfigured = () => !!API_KEY;

// ── Endpoint bases (docs/adyen/research/adyen-setup-golive.md §4) ────────────
// Checkout v72: live REQUIRES the per-company URL prefix.
export function checkoutBase(): string {
  const o = Deno.env.get('ADYEN_CHECKOUT_BASE'); if (o) return o.replace(/\/+$/, '');
  if (!LIVE) return 'https://checkout-test.adyen.com/v72';
  if (!PREFIX) throw new Error('ADYEN_LIVE_PREFIX required for live Checkout API');
  return `https://${PREFIX}-checkout-live.adyenpayments.com/checkout/v72`;
}
// Management v3: NO prefix.
export function managementBase(): string {
  const o = Deno.env.get('ADYEN_MGMT_BASE'); if (o) return o.replace(/\/+$/, '');
  return LIVE ? 'https://management-live.adyen.com/v3' : 'https://management-test.adyen.com/v3';
}
// Legal Entity Management v4 (KYC host). Verify base on first key-holding call.
export function lemBase(): string {
  const o = Deno.env.get('ADYEN_LEM_BASE'); if (o) return o.replace(/\/+$/, '');
  return LIVE ? 'https://kyc-live.adyen.com/lem/v4' : 'https://kyc-test.adyen.com/lem/v4';
}
// Balance Platform Configuration v2. Verify base on first key-holding call.
export function balancePlatformBase(): string {
  const o = Deno.env.get('ADYEN_BP_BASE'); if (o) return o.replace(/\/+$/, '');
  return LIVE ? 'https://balanceplatform-api-live.adyen.com/bcl/v2' : 'https://balanceplatform-api-test.adyen.com/bcl/v2';
}
// Cloud Terminal API (device-api hosts — NOT the legacy terminal-api ones).
// Live is REGIONAL, not prefixed. region: 'eu' | 'us' | 'au' | 'apse' | 'nea'.
export function terminalEndpoint(merchantAccount: string, poiid: string, mode: 'sync' | 'async', region = 'eu'): string {
  const o = Deno.env.get('ADYEN_DEVICE_BASE');
  const base = o ? o.replace(/\/+$/, '')
    : !LIVE ? 'https://device-api-test.adyen.com'
    : region === 'eu' ? 'https://device-api-live.adyen.com'
    : `https://device-api-live-${region}.adyen.com`;
  // CLASSIC cloud Terminal API hosts (terminal-api-*) take the bare /sync
  // path — the POIID rides in the nexo MessageHeader, not the URL. The newer
  // device-api hosts are account-gated (14 Aug: 00_403 with every role ticked),
  // so ADYEN_DEVICE_BASE=https://terminal-api-test.adyen.com is the reliable
  // default until Adyen enables device-api on the account.
  if (/terminal-api/.test(base)) return `${base}/${mode}`;
  return `${base}/v1/merchants/${encodeURIComponent(merchantAccount)}/devices/${encodeURIComponent(poiid)}/${mode}`;
}

export interface AdyenResult<T = any> { ok: boolean; status: number; data: T; }

export async function adyenFetch<T = any>(method: string, url: string, body?: unknown, opts: { idempotencyKey?: string; timeoutMs?: number } = {}): Promise<AdyenResult<T>> {
  const headers: Record<string, string> = { 'X-API-Key': API_KEY, 'Content-Type': 'application/json' };
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
  const ctrl = new AbortController();
  // Terminal API /sync holds the connection for the whole cardholder interaction —
  // callers pass ~165s there; everything else defaults to 30s.
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 30_000);
  try {
    const res = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal: ctrl.signal });
    const text = await res.text();
    let data: any = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    return { ok: res.ok, status: res.status, data };
  } finally { clearTimeout(t); }
}

// ── Webhook HMAC — TWO different schemes (docs/adyen/research/adyen-webhooks-reporting.md)
//
// (1) STANDARD webhooks: per-NotificationRequestItem signature. The signing
//     string is built from FIELDS (not the raw body), signed with the HMAC key
//     decoded from HEX, output base64, carried in additionalData.hmacSignature:
//     pspReference:originalReference:merchantAccountCode:merchantReference:
//     value:currency:eventCode:success
export function hmacSigningString(item: any): string {
  const amount = item?.amount ?? {};
  return [
    item?.pspReference ?? '',
    item?.originalReference ?? '',
    item?.merchantAccountCode ?? '',
    item?.merchantReference ?? '',
    amount?.value ?? '',
    amount?.currency ?? '',
    item?.eventCode ?? '',
    item?.success ?? '',
  ].join(':');
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim();
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function b64(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}
function constantTimeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function signNotificationItem(item: any, hmacHexKey: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', hexToBytes(hmacHexKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(hmacSigningString(item)));
  return b64(sig);
}

export async function verifyNotificationItem(item: any, hmacHexKey: string): Promise<boolean> {
  const given = item?.additionalData?.hmacSignature ?? '';
  if (!hmacHexKey || !given) return false;
  try { return constantTimeEq(await signNotificationItem(item, hmacHexKey), given); }
  catch { return false; }
}

// (2) BALANCE PLATFORM webhooks: classic raw-body HMAC-SHA256 (base64) in the
//     HmacSignature header, key used as raw text.
export async function verifyRawBodyHmac(rawBody: string, headerSig: string, key: string): Promise<boolean> {
  if (!key || !headerSig) return false;
  try {
    const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = b64(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(rawBody)));
    return constantTimeEq(sig, headerSig);
  } catch { return false; }
}

// ── Terminal API (nexo 3.0) message builders ─────────────────────────────────
// docs/adyen/research/adyen-in-person.md. POIID format: {Model}-{Serial},
// e.g. AMS1-000168243358252. ServiceID: 1-10 alphanumerics, unique per POIID
// within 48h. Amounts are DECIMAL MAJOR units.

export const minorToMajor = (minor: number): number => Math.round(minor) / 100;

// On-screen MENU on the terminal (nexo Input / GetMenuEntry) — Pay at Table's
// open-table picker. The response carries the 1-based selected entry in
// InputResponse.Input.MenuEntryNumber.
export function buildMenuInputRequest(o: { poiid: string; saleId: string; serviceId: string; title: string; entries: string[]; maxInputTime?: number }): any {
  return {
    SaleToPOIRequest: {
      MessageHeader: {
        ProtocolVersion: '3.0', MessageClass: 'Device', MessageCategory: 'Input', MessageType: 'Request',
        ServiceID: o.serviceId, SaleID: o.saleId, POIID: o.poiid,
      },
      InputRequest: {
        DisplayOutput: {
          Device: 'CustomerDisplay', InfoQualify: 'Display',
          // Hardware-verified 15 Aug: OutputContent.OutputFormat must be 'Text'
          // ("value 'MenuEntry': Value not supported") — the menu itself rides
          // the sibling MenuEntry array.
          OutputContent: {
            OutputFormat: 'Text',
            PredefinedContent: { ReferenceID: 'MenuButtons' },
            OutputText: [{ Text: o.title }],
          },
          MenuEntry: o.entries.map((text) => ({
            OutputFormat: 'Text',
            OutputText: [{ Text: text }],
          })),
        },
        InputData: {
          Device: 'CustomerInput', InfoQualify: 'Input', InputCommand: 'GetMenuEntry',
          MaxInputTime: o.maxInputTime ?? 60,
        },
      },
    },
  };
}

// NON-BLOCKING text on the reader (nexo Display). Unlike an InputRequest — which
// renders a widget and holds the /sync call open until someone answers or
// MaxInputTime expires — this paints and returns, so it can be fired and
// forgotten while the responder is still gathering the bill. That preamble is
// several serial network legs, during which the reader showed its HOME screen
// and staff had no idea anything was happening (Peter, 15 Aug: "the reader looks
// like nothing is happening which will cause confusion").
// Envelope mirrors the proven buildMenuInputRequest DisplayOutput exactly, minus
// the MenuEntry array and InputData. The shape is NOT hardware-verified on this
// fleet — every call site must ignore failures, so a rejection costs nothing but
// the dead air we already have.
export function buildDisplayRequest(o: { poiid: string; saleId: string; serviceId: string; text: string }): any {
  return {
    SaleToPOIRequest: {
      MessageHeader: {
        ProtocolVersion: '3.0', MessageClass: 'Device', MessageCategory: 'Display', MessageType: 'Request',
        ServiceID: o.serviceId, SaleID: o.saleId, POIID: o.poiid,
      },
      DisplayRequest: {
        DisplayOutput: {
          Device: 'CustomerDisplay', InfoQualify: 'Status',
          OutputContent: { OutputFormat: 'Text', OutputText: [{ Text: o.text }] },
        },
      },
    },
  };
}

// FULL-SCREEN IMAGE on the terminal (nexo Display / MessageRef+Image) — the
// branding/"screensaver" push. Docs (display-image): OutputFormat 'MessageRef',
// PredefinedContent.ReferenceID 'Image', base64 image in OutputText. With no
// MinimumDisplayTime the image HOLDS until the next request — a payment, another
// image, or the Idle push below. NOT yet hardware-verified on this fleet (which
// has contradicted the docs three times); that is what admin test_image is for.
// NOTE the contrast with buildDisplayRequest above (OutputFormat 'Text', no
// PredefinedContent, unverified): if Image works and Text does not, that is the
// answer to why "Loading tables…" never showed.
export function buildDisplayImageRequest(o: { poiid: string; saleId: string; serviceId: string; imageB64: string }): any {
  return {
    SaleToPOIRequest: {
      MessageHeader: {
        ProtocolVersion: '3.0', MessageClass: 'Device', MessageCategory: 'Display', MessageType: 'Request',
        ServiceID: o.serviceId, SaleID: o.saleId, POIID: o.poiid,
      },
      DisplayRequest: {
        DisplayOutput: {
          Device: 'CustomerDisplay', InfoQualify: 'Display',
          OutputContent: {
            OutputFormat: 'MessageRef',
            PredefinedContent: { ReferenceID: 'Image' },
            OutputText: [{ Text: o.imageB64 }],
          },
        },
      },
    },
  };
}

// Force the terminal BACK to its standby screen (ReferenceID 'Idle') — docs say
// this works "regardless of the terminal model".
export function buildDisplayIdleRequest(o: { poiid: string; saleId: string; serviceId: string }): any {
  return {
    SaleToPOIRequest: {
      MessageHeader: {
        ProtocolVersion: '3.0', MessageClass: 'Device', MessageCategory: 'Display', MessageType: 'Request',
        ServiceID: o.serviceId, SaleID: o.saleId, POIID: o.poiid,
      },
      DisplayRequest: {
        DisplayOutput: {
          Device: 'CustomerDisplay', InfoQualify: 'Display',
          OutputContent: { OutputFormat: 'MessageRef', PredefinedContent: { ReferenceID: 'Idle' } },
        },
      },
    },
  };
}

export function parseMenuInputResponse(data: any): { selected: number | null; result: string } {
  // Docs + hardware, 15 Aug: MenuEntryNumber is a SELECTION-MASK array — the
  // chosen option's position holds 1, every other item 0 ("if the third option
  // is selected, the third item is 1"). Tap row 3 → [0,0,1]. The single-entry
  // case [1] is the same rule, which is why only that probe ever "worked".
  const r = data?.SaleToPOIResponse?.InputResponse;
  const result = r?.InputResult?.Response?.Result ?? r?.Response?.Result ?? 'Failure';
  const raw = r?.InputResult?.Input?.MenuEntryNumber ?? r?.Input?.MenuEntryNumber;
  let sel: number | null = null;
  if (Array.isArray(raw)) {
    const i = raw.findIndex((v: unknown) => Number(v) === 1);
    if (i >= 0) sel = i + 1;                          // 1-based position of the 1
  } else if (Number(raw) >= 1) {
    sel = Number(raw);                                // defensive: plain index form
  }
  return { selected: result === 'Success' && sel != null ? sel : null, result: String(result) };
}

// On-screen AMOUNT ENTRY on the terminal (nexo Input / DecimalString) — the
// split-payment "enter amount" step. Docs (point-of-sale/shopper-engagement/
// shopper-input/amount): PredefinedContent ReferenceID 'GetAmount' renders the
// currency keypad; entry populates RIGHT-TO-LEFT (typing 3,6,5,9 shows 0.03 →
// 0.36 → 3.65 → 36.59); the entered amount returns as a decimal STRING in
// InputResult.Input.DigitInput ("36.59"). Cancel/timeout → Result 'Failure'.
export function buildAmountInputRequest(o: { poiid: string; saleId: string; serviceId: string; title: string; maxInputTime?: number }): any {
  return {
    SaleToPOIRequest: {
      MessageHeader: {
        ProtocolVersion: '3.0', MessageClass: 'Device', MessageCategory: 'Input', MessageType: 'Request',
        ServiceID: o.serviceId, SaleID: o.saleId, POIID: o.poiid,
      },
      InputRequest: {
        DisplayOutput: {
          Device: 'CustomerDisplay', InfoQualify: 'Display',
          OutputContent: {
            OutputFormat: 'Text',
            PredefinedContent: { ReferenceID: 'GetAmount' },
            OutputText: [{ Text: o.title }],
          },
        },
        InputData: {
          Device: 'CustomerInput', InfoQualify: 'Input', InputCommand: 'DecimalString',
          MaxInputTime: o.maxInputTime ?? 45,
          DefaultInputString: '0.00',
        },
      },
    },
  };
}

export function parseAmountInputResponse(data: any): { amountMinor: number | null; result: string } {
  const r = data?.SaleToPOIResponse?.InputResponse;
  const result = r?.InputResult?.Response?.Result ?? r?.Response?.Result ?? 'Failure';
  // HARDWARE-VERIFIED 15 Aug (AMS1): a DecimalString answer comes back as
  // `TextInput`, NOT the `DigitInput` the docs show — £10.00 typed on the
  // reader arrived as Input.TextInput "10.00" and the DigitInput-only parser
  // read null, so the flow bailed silently to the home screen. Accept both,
  // plus DecimalString, and take whichever the firmware actually sends.
  const inp = r?.InputResult?.Input ?? r?.Input ?? {};
  const raw = inp.TextInput ?? inp.DigitInput ?? inp.DecimalString ?? inp.DigitString;
  let minor: number | null = null;
  if (raw != null && String(raw).trim() !== '') {
    const n = Number(String(raw).replace(/[^0-9.]/g, ''));
    if (Number.isFinite(n) && n > 0) minor = Math.round(n * 100);
  }
  return { amountMinor: result === 'Success' ? minor : null, result: String(result) };
}

export function newServiceId(): string {
  // 10 RANDOM base36 chars (~51 bits). Three jobs in one review finding hang off
  // this: (1) uniqueness within Adyen's 48h/POIID window — randomness beats the
  // old time+per-isolate-counter scheme, which collided across fresh isolates in
  // the same second; (2) idx_tj_nexo_service enforces it DB-side (a collision
  // fails the CAS stamp and the initiator re-mints); (3) it doubles as the
  // report_local capability token — only the device that received prepare_local's
  // response can present it, so a forged report from another device at the venue
  // can't bind to the job.
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += (b % 36).toString(36);
  return out;
}

export interface NexoPaymentOpts {
  poiid: string;
  saleId: string;              // our POS component id (till/kiosk id)
  serviceId: string;           // newServiceId(); PERSIST it — status recovery needs it
  transactionId: string;       // our reference → shows as merchantReference in CA/reports
  amountMinor: number;
  currency: string;            // 'GBP' | 'USD' | ...
  tipMinor?: number;           // pre-agreed tip (tipping-from-POS mode)
  askGratuity?: boolean;       // terminal prompts for tip (tipping-from-terminal mode)
  preAuth?: boolean;           // bar tabs: authorisation only, capture later
  allowPartial?: boolean;      // partial approvals (gift/prepaid top-ups)
  merchantAccount?: string;
  storeId?: string;            // AfP: route to the venue's store
}

export function buildPaymentRequest(o: NexoPaymentOpts): any {
  const saleToAcquirer: string[] = [];
  if (o.preAuth) saleToAcquirer.push('authorisationType=PreAuth');
  if (o.allowPartial) saleToAcquirer.push('tenderOption=AllowPartialAuthorisation');
  if (o.askGratuity) saleToAcquirer.push('tenderOption=AskGratuity');
  if (o.storeId) saleToAcquirer.push(`store=${o.storeId}`);
  const amounts: any = { Currency: o.currency, RequestedAmount: minorToMajor(o.amountMinor) };
  if (o.tipMinor && o.tipMinor > 0) amounts.TipAmount = minorToMajor(o.tipMinor);
  return {
    SaleToPOIRequest: {
      MessageHeader: {
        ProtocolVersion: '3.0', MessageClass: 'Service', MessageCategory: 'Payment', MessageType: 'Request',
        ServiceID: o.serviceId, SaleID: o.saleId, POIID: o.poiid,
      },
      PaymentRequest: {
        SaleData: {
          SaleTransactionID: { TransactionID: o.transactionId, TimeStamp: new Date().toISOString() },
          ...(saleToAcquirer.length ? { SaleToAcquirerData: saleToAcquirer.join('&') } : {}),
        },
        PaymentTransaction: { AmountsReq: amounts },
      },
    },
  };
}

export function buildTransactionStatusRequest(o: { poiid: string; saleId: string; serviceId: string; origServiceId: string }): any {
  return {
    SaleToPOIRequest: {
      MessageHeader: {
        ProtocolVersion: '3.0', MessageClass: 'Service', MessageCategory: 'TransactionStatus', MessageType: 'Request',
        ServiceID: o.serviceId, SaleID: o.saleId, POIID: o.poiid,
      },
      TransactionStatusRequest: {
        ReceiptReprintFlag: false,
        MessageReference: { SaleID: o.saleId, ServiceID: o.origServiceId, MessageCategory: 'Payment' },
      },
    },
  };
}

export function buildAbortRequest(o: { poiid: string; saleId: string; serviceId: string; origServiceId: string; reason?: string }): any {
  return {
    SaleToPOIRequest: {
      MessageHeader: {
        ProtocolVersion: '3.0', MessageClass: 'Service', MessageCategory: 'Abort', MessageType: 'Request',
        ServiceID: o.serviceId, SaleID: o.saleId, POIID: o.poiid,
      },
      AbortRequest: {
        AbortReason: o.reason ?? 'MerchantAbort',
        MessageReference: { SaleID: o.saleId, ServiceID: o.origServiceId, MessageCategory: 'Payment' },
      },
    },
  };
}

// Referenced refund/reversal on-terminal (full reversal of a same-day auth).
export function buildReversalRequest(o: { poiid: string; saleId: string; serviceId: string; origPoiTransactionId: string; origTimestamp: string; reason?: string }): any {
  return {
    SaleToPOIRequest: {
      MessageHeader: {
        ProtocolVersion: '3.0', MessageClass: 'Service', MessageCategory: 'Reversal', MessageType: 'Request',
        ServiceID: o.serviceId, SaleID: o.saleId, POIID: o.poiid,
      },
      ReversalRequest: {
        ReversalReason: o.reason ?? 'MerchantCancel',
        OriginalPOITransaction: {
          POITransactionID: { TransactionID: o.origPoiTransactionId, TimeStamp: o.origTimestamp },
        },
      },
    },
  };
}

// ── Response parsing ─────────────────────────────────────────────────────────
// additionalResponse arrives as base64 JSON, plain JSON, or a URL-encoded query
// string depending on terminal config — parse all three tolerantly.
export function parseAdditionalResponse(raw: unknown): Record<string, string> {
  if (!raw) return {};
  if (typeof raw === 'object') return raw as Record<string, string>;
  const s = String(raw);
  try { return JSON.parse(s); } catch { /* not plain JSON */ }
  try {
    const decoded = atob(s);
    try { return JSON.parse(decoded); } catch { /* not b64 JSON */ }
  } catch { /* not base64 */ }
  const out: Record<string, string> = {};
  for (const part of s.split('&')) {
    const i = part.indexOf('=');
    if (i > 0) out[decodeURIComponent(part.slice(0, i))] = decodeURIComponent(part.slice(i + 1));
  }
  return out;
}

// Extract everything the POS needs from a nexo PaymentResponse: result, ids,
// and the EMV receipt block (same shape src/lib/cardReceipt.js renders today).
export function parsePaymentResponse(body: any): {
  result: 'Success' | 'Partial' | 'Failure' | 'Unknown';
  serviceId: string | null;   // MessageHeader.ServiceID — binds a response to ITS attempt
  poiid: string | null;       // MessageHeader.POIID — binds it to ITS terminal
  errorCondition: string | null;
  pspReference: string | null;
  poiTransactionId: string | null;
  poiTimestamp: string | null;
  authorizedMinor: number | null;
  tipMinor: number | null;
  card: { brand: string | null; last4: string | null; authCode: string | null; aid: string | null; applicationName: string | null; cvm: string | null; readMethod: string | null };
  additional: Record<string, string>;
} {
  const resp = body?.SaleToPOIResponse?.PaymentResponse ?? body?.PaymentResponse ?? {};
  const header = body?.SaleToPOIResponse?.MessageHeader ?? {};
  const response = resp?.Response ?? {};
  const result = (response?.Result === 'Success' || response?.Result === 'Partial' || response?.Result === 'Failure')
    ? response.Result : 'Unknown';
  const additional = parseAdditionalResponse(response?.AdditionalResponse);
  const pRes = resp?.PaymentResult ?? {};
  const amounts = pRes?.AmountsResp ?? {};
  const poiTx = resp?.POIData?.POITransactionID ?? {};
  const instrument = pRes?.PaymentInstrumentData?.CardData ?? {};
  const toMinor = (v: unknown) => (v === undefined || v === null || isNaN(Number(v))) ? null : Math.round(Number(v) * 100);
  const maskedPan: string = instrument?.MaskedPan ?? additional['cardSummary'] ?? '';
  const last4 = maskedPan ? maskedPan.replace(/[^0-9]/g, '').slice(-4) || null : (additional['cardSummary'] ?? null);
  return {
    result,
    serviceId: header?.ServiceID ?? null,
    poiid: header?.POIID ?? null,
    errorCondition: response?.ErrorCondition ?? additional['refusalReason'] ?? null,
    pspReference: additional['pspReference'] ?? null,
    poiTransactionId: poiTx?.TransactionID ?? null,
    poiTimestamp: poiTx?.TimeStamp ?? null,
    authorizedMinor: toMinor(amounts?.AuthorizedAmount),
    tipMinor: toMinor(amounts?.TipAmount),
    card: {
      brand: instrument?.PaymentBrand ?? additional['paymentMethod'] ?? null,
      last4,
      authCode: additional['authCode'] ?? null,
      aid: additional['aid'] ?? null,
      applicationName: additional['applicationLabel'] ?? additional['applicationPreferredName'] ?? null,
      cvm: additional['cardHolderVerificationMethodResults'] ?? additional['cvmResult'] ?? null,
      readMethod: additional['posEntryMode'] ?? null,
    },
    additional,
  };
}

// Standard-webhook card block (AUTHORISATION additionalData) → same shape.
export function cardFromWebhookAdditionalData(ad: Record<string, any> | undefined | null) {
  if (!ad) return null;
  return {
    brand: ad['paymentMethod'] ?? ad['paymentMethodVariant'] ?? null,
    last4: ad['cardSummary'] ?? null,
    authCode: ad['authCode'] ?? null,
    aid: ad['aid'] ?? null,
    applicationName: ad['applicationLabel'] ?? null,
    cvm: ad['cardHolderVerificationMethodResults'] ?? null,
    readMethod: ad['posEntryMode'] ?? ad['shopperInteraction'] ?? null,
  };
}
