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

export const ryftPublicKey = () => Deno.env.get('RYFT_PUBLIC_KEY') ?? '';
export const ryftConfigured = () => !!RYFT_SECRET;
