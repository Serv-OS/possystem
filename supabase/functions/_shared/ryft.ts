// supabase/functions/_shared/ryft.ts
//
// Minimal Ryft REST client for edge functions. Ryft auth = the API key in the
// Authorization header (raw, no "Bearer "). Sub-accounts (marketplace) are
// addressed with the `Account` header (like Stripe's Stripe-Account). Amounts
// are in MINOR units (pence/cents), matching how we already pass amount_minor.
//
// Env: RYFT_SECRET_KEY (sk_…), RYFT_API_BASE (defaults to sandbox).
//   sandbox  https://sandbox-api.ryftpay.com/v1
//   prod     https://api.ryftpay.com/v1

const RYFT_BASE = (Deno.env.get('RYFT_API_BASE') ?? 'https://sandbox-api.ryftpay.com/v1').replace(/\/+$/, '');
const RYFT_SECRET = Deno.env.get('RYFT_SECRET_KEY') ?? '';

export interface RyftOpts {
  /** Sub-account id (acc_…) to act on behalf of — marketplace payments. */
  accountId?: string;
  /** Override the secret key (default: RYFT_SECRET_KEY env). */
  secret?: string;
  /** Idempotency key for safe retries on writes. */
  idempotencyKey?: string;
}

export interface RyftResult<T = any> { ok: boolean; status: number; data: T; }

export async function ryftFetch<T = any>(method: string, path: string, body?: unknown, opts: RyftOpts = {}): Promise<RyftResult<T>> {
  const headers: Record<string, string> = {
    'Authorization': opts.secret ?? RYFT_SECRET,
    'Content-Type': 'application/json',
  };
  if (opts.accountId) headers['Account'] = opts.accountId;
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
  const res = await fetch(`${RYFT_BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  return { ok: res.ok, status: res.status, data };
}

// ── Payment sessions ────────────────────────────────────────────────────────
export interface CreateSessionInput {
  amount: number;                 // minor units
  currency: string;               // ISO, e.g. "GBP"
  captureFlow?: 'Automatic' | 'Manual';
  customerEmail?: string;
  platformFee?: number;           // minor units kept by the platform (marketplace)
  metadata?: Record<string, string>;
  [k: string]: unknown;           // forward-compat for fields we confirm in sandbox
}

export const createPaymentSession = (input: CreateSessionInput, opts: RyftOpts = {}) =>
  ryftFetch('POST', '/payment-sessions', input, opts);

export const getPaymentSession = (id: string, opts: RyftOpts = {}) =>
  ryftFetch('GET', `/payment-sessions/${id}`, undefined, opts);

export const capturePaymentSession = (id: string, body: Record<string, unknown> = {}, opts: RyftOpts = {}) =>
  ryftFetch('POST', `/payment-sessions/${id}/captures`, body, opts);

export const voidPaymentSession = (id: string, body: Record<string, unknown> = {}, opts: RyftOpts = {}) =>
  ryftFetch('POST', `/payment-sessions/${id}/voids`, body, opts);

export const refundPaymentSession = (id: string, body: Record<string, unknown>, opts: RyftOpts = {}) =>
  ryftFetch('POST', `/payment-sessions/${id}/refunds`, body, opts);

// ── In-person / card-present terminals ──────────────────────────────────────
// Take a payment on a Ryft Android terminal. The response carries
// action.transaction.paymentSessionId — poll THAT payment session for the
// PendingPayment → Approved → Captured lifecycle (same as card-not-present).
export interface TerminalPaymentInput {
  amounts: { requested: number };            // minor units
  currency: string;                          // ISO, e.g. "GBP"
  captureFlow?: 'Automatic' | 'Manual';
  settings?: { receiptPrintingSource?: 'PointOfSale' | 'Terminal' };
  metadata?: Record<string, string>;
  [k: string]: unknown;
}

// ── In-person locations + terminal registration (pairing hardware) ──────────
// A terminal lives under an in-person LOCATION (iploc_) which belongs to the
// sub-account. Pass opts.accountId (Account header) to act for that merchant.
export const createInPersonLocation = (input: { name: string; address: Record<string, unknown>; metadata?: Record<string, string> }, opts: RyftOpts = {}) =>
  ryftFetch('POST', '/in-person/locations', input, opts);

export const listInPersonLocations = (opts: RyftOpts = {}) =>
  ryftFetch('GET', '/in-person/locations', undefined, opts);

// Register a physical terminal by its serial number under an iploc_ location.
export const registerTerminal = (input: { serialNumber: string; locationId: string; name?: string; metadata?: Record<string, string> }, opts: RyftOpts = {}) =>
  ryftFetch('POST', '/in-person/terminals', input, opts);

export const listTerminals = (opts: RyftOpts = {}) =>
  ryftFetch('GET', '/in-person/terminals', undefined, opts);

export const deleteTerminal = (terminalId: string, opts: RyftOpts = {}) =>
  ryftFetch('DELETE', `/in-person/terminals/${terminalId}`, undefined, opts);

export const createTerminalPayment = (terminalId: string, input: TerminalPaymentInput, opts: RyftOpts = {}) =>
  ryftFetch('POST', `/in-person/terminals/${terminalId}/payment`, input, opts);

export const cancelTerminalAction = (terminalId: string, body: Record<string, unknown> = {}, opts: RyftOpts = {}) =>
  ryftFetch('POST', `/in-person/terminals/${terminalId}/cancel-action`, body, opts);

export const confirmTerminalReceipt = (terminalId: string, body: Record<string, unknown>, opts: RyftOpts = {}) =>
  ryftFetch('POST', `/in-person/terminals/${terminalId}/confirm-receipt`, body, opts);

export const refundTerminalPayment = (terminalId: string, body: Record<string, unknown>, opts: RyftOpts = {}) =>
  ryftFetch('POST', `/in-person/terminals/${terminalId}/refund`, body, opts);

// ── Marketplace sub-accounts (platform onboarding) ──────────────────────────
// A platform (us) creates Sub-Accounts (merchants) under our Main account with
// the PLATFORM secret key (no Account header on creation). The returned id
// (ac_<uuid>) is then used as the `Account` header on that merchant's payments.
// Verified against the Ryft OpenAPI spec (subAccountCreate / accountLinksCreate).
export interface CreateSubAccountInput {
  email?: string;                                  // required for Hosted when entityType omitted
  onboardingFlow?: 'Hosted' | 'NonHosted';         // defaults to Hosted
  entityType?: 'Business' | 'Individual';
  business?: Record<string, unknown>;              // required when entityType=Business
  individual?: Record<string, unknown>;            // required when entityType=Individual
  metadata?: Record<string, string>;
  [k: string]: unknown;
}

export const createSubAccount = (input: CreateSubAccountInput, opts: RyftOpts = {}) =>
  ryftFetch('POST', '/accounts', input, opts);

export const getAccount = (id: string, opts: RyftOpts = {}) =>
  ryftFetch('GET', `/accounts/${id}`, undefined, opts);

// Mint a temporary HOSTED onboarding portal URL the merchant uses to create a
// login, submit KYC/KYB, add bank + payout details. Sandbox host:
// https://sandbox-dash.ryftpay.com/join?l=al_...
export const createAccountLink = (input: { accountId: string; redirectUrl: string }, opts: RyftOpts = {}) =>
  ryftFetch('POST', '/account-links', input, opts);

// Sign-in link for a RETURNING merchant that already has a Ryft login (Hosted only).
export const authorizeAccount = (input: { email: string; redirectUrl: string }, opts: RyftOpts = {}) =>
  ryftFetch('POST', '/accounts/authorize', input, opts);

// ── Actual fees (read back what Ryft really charged / we collected) ─────────
// Pass opts.accountId to scope to a sub-account (Account header). These are the
// source of truth for cost + margin — Ryft computes the card-network fees, we
// just read them. /balance-transactions item.feeTotal = fees taken on a txn;
// /platform-fees = the markup we collected.
export const listBalanceTransactions = (opts: RyftOpts = {}, limit = 50) =>
  ryftFetch('GET', `/balance-transactions?limit=${limit}`, undefined, opts);

export const listPlatformFees = (opts: RyftOpts = {}, limit = 50) =>
  ryftFetch('GET', `/platform-fees?limit=${limit}`, undefined, opts);

// Account balance (available + pending). Account header scopes to a sub-account.
export const listBalances = (opts: RyftOpts = {}) =>
  ryftFetch('GET', '/balances', undefined, opts);

// Payouts for a sub-account. The sub-account id is the {id} PATH param (no
// Account header needed — it's account-scoped by path).
export const listPayouts = (accountId: string, limit = 50, opts: RyftOpts = {}) =>
  ryftFetch('GET', `/accounts/${accountId}/payouts?limit=${limit}`, undefined, opts);

export const ryftPublicKey = () => Deno.env.get('RYFT_PUBLIC_KEY') ?? '';
export const ryftConfigured = () => !!RYFT_SECRET;
