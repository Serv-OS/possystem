// supabase/functions/_shared/stuart.ts
//
// Stuart courier client (UK last-mile API) — the self-serve alternative to Uber Direct.
// OAuth2 client_credentials (cached token), live pricing (quote before booking), create job,
// status, cancel, and webhook auth. Money is MAJOR units (pounds) at Stuart; we convert to MINOR
// (pence) so the rest of the ServOS delivery pipeline is unchanged.
//
// Sandbox is SELF-SERVE (dashboard.sandbox.stuart.com) — no sales gate, unlike Uber Direct in the
// UK. Exact request/response field names are locked against the live sandbox on first test; the
// builders below are tolerant best-effort per api-docs.stuart.com (Jun 2026).

const STUART_HOSTS = {
  sandbox: 'https://api.sandbox.stuart.com',
  prod: 'https://api.stuart.com',
};

export class StuartError extends Error {
  status: number; body: unknown;
  constructor(status: number, body: unknown) {
    super(`Stuart ${status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
    this.status = status; this.body = body;
  }
}

// ── OAuth token cache (per env+clientId; ~30-day tokens, refreshed early) ─────
type Cached = { token: string; expMs: number };
const _tokens = new Map<string, Cached>();

export async function getStuartToken(env: 'sandbox' | 'prod', clientId: string, clientSecret: string): Promise<string> {
  const key = `${env}:${clientId}`;
  const hit = _tokens.get(key);
  if (hit && hit.expMs - Date.now() > 60_000) return hit.token;
  const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials', scope: 'api' });
  const res = await fetch(`${STUART_HOSTS[env]}/oauth/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString(),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) throw new StuartError(res.status, j);
  const ttlMs = (Number(j.expires_in) || 2_592_000) * 1000;
  _tokens.set(key, { token: j.access_token, expMs: Date.now() + ttlMs });
  return j.access_token;
}

async function stuartFetch(env: 'sandbox' | 'prod', token: string, method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${STUART_HOSTS[env]}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const parsed = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null;
  if (!res.ok) throw new StuartError(res.status, parsed);
  return parsed;
}

const addrObj = (a: any) => (typeof a === 'string' ? { line1: a } : (a || {}));
const addrStr = (a: any) => { const o = addrObj(a); return [o.line1, o.line2, o.city, o.postcode, o.country || 'UK'].filter(Boolean).join(', '); };
const e164 = (raw: string) => { const s = String(raw || '').replace(/[\s()-]/g, ''); if (!s) return ''; if (s.startsWith('+')) return s; if (s.startsWith('0')) return '+44' + s.slice(1); if (s.startsWith('44')) return '+' + s; return s; };

/**
 * Live pricing (quote) BEFORE booking. Returns the Stuart job-pricing payload (amount in pounds).
 * Normalise to minor with normaliseStuartPricing on the client / in the edge fn.
 * transport_type omitted → Stuart prices the cheapest available vehicle.
 */
export async function getStuartPricing(opts: { env: 'sandbox' | 'prod'; token: string; pickup: any; dropoff: any; transportType?: string; packageType?: string }): Promise<any> {
  const job: Record<string, unknown> = {
    pickups: [{ address: addrStr(opts.pickup) }],
    dropoffs: [{ address: addrStr(opts.dropoff), package_type: opts.packageType || 'small' }],
  };
  if (opts.transportType) (job as any).transport_type = opts.transportType;
  return stuartFetch(opts.env, opts.token, 'POST', '/v2/jobs/pricing', { job });
}

/** Build the Stuart create-job body from a ServOS order + quote + venue pickup config. */
export function buildStuartJob(order: any, quote: any, cfg: any) {
  const cust = order?.customer || {};
  const pc = cfg?.pickup_contact || {};
  const full = String(cust.name || '').trim().split(/\s+/);
  return {
    job: {
      ...(cfg?.stuart_transport_type ? { transport_type: cfg.stuart_transport_type } : {}),
      pickups: [{
        address: addrStr(cfg?.pickup_address),
        comment: pc.instructions || '',
        contact: { firstname: pc.name || 'Restaurant', phone: e164(pc.phone || ''), company: pc.name || '' },
      }],
      dropoffs: [{
        package_type: cfg?.stuart_package_type || 'small',
        client_reference: order?.ref || null,
        address: addrStr(quote?.dropoff || cust.address),
        comment: cust.notes || '',
        contact: { firstname: full[0] || 'Customer', lastname: full.slice(1).join(' '), phone: e164(cust.phone) },
      }],
    },
  };
}

/** Stuart pricing (pounds) → the Uber-classic quote shape { fee:<minor>, currency } the
 *  quoteService normaliser ingests. Mirror of src/lib/delivery/stuart.js. */
export function normaliseStuartPricing(resp: any): { fee: number; currency: string } | null {
  if (!resp || typeof resp !== 'object') return null;
  const p = resp.pricing && typeof resp.pricing === 'object' ? resp.pricing : resp;
  const amt = p.amount ?? p.amount_tax_included ?? p.price_tax_included ?? p.price ?? null;
  if (amt == null) return null;            // Number(null) === 0 (finite!) — guard explicitly
  const n = Number(amt);
  if (!Number.isFinite(n)) return null;
  return { fee: Math.max(0, Math.round(n * 100)), currency: String(resp.currency || p.currency || 'GBP').toUpperCase() };
}

export async function createStuartJob(env: 'sandbox' | 'prod', token: string, jobBody: unknown): Promise<any> {
  return stuartFetch(env, token, 'POST', '/v2/jobs', jobBody);
}
export async function getStuartJob(env: 'sandbox' | 'prod', token: string, id: string): Promise<any> {
  return stuartFetch(env, token, 'GET', `/v2/jobs/${id}`);
}
/** Cancel a Stuart job. (Stuart: POST /v2/jobs/{id}/cancel — confirm exact path in sandbox.) */
export async function cancelStuartJob(env: 'sandbox' | 'prod', token: string, id: string): Promise<any> {
  return stuartFetch(env, token, 'POST', `/v2/jobs/${id}/cancel`, {});
}

// ── Status map (mirror of src/lib/delivery/stuart.js) ─────────────────────────
const STUART_STATUS: Record<string, string> = {
  new: 'pending', searching: 'pending', scheduled: 'pending', pending: 'pending',
  in_progress: 'pickup', picking: 'pickup', almost_picking: 'pickup', waiting_at_pickup: 'pickup',
  delivering: 'dropoff', almost_delivering: 'dropoff', waiting_at_dropoff: 'dropoff',
  delivered: 'delivered', finished: 'delivered',
  cancelled: 'canceled', canceled: 'canceled', expired: 'canceled', voided: 'canceled', failed: 'canceled',
  returning: 'returned', returned: 'returned', returning_to_pickup: 'returned',
};
export function mapStuartStatus(raw: string | null): string {
  if (!raw) return 'pending';
  return STUART_STATUS[String(raw).toLowerCase().trim()] || 'pending';
}

/** Extract id / tracking / status / driver from a Stuart job payload (tolerant). */
export function parseStuartJob(r: any): { id: string | null; trackingUrl: string | null; rawStatus: string | null; courierName: string | null; courierPhone: string | null; lat: number | null; lng: number | null } {
  const d = r?.data || r || {};
  const job = d.job || d;
  const delivery = Array.isArray(job.deliveries) ? job.deliveries[0] : (d.delivery || null);
  const driver = delivery?.driver || job.driver || null;
  return {
    id: job.id != null ? String(job.id) : (delivery?.id != null ? String(delivery.id) : null),
    trackingUrl: delivery?.tracking_url || job.tracking_url || null,
    rawStatus: delivery?.status || job.status || null,
    courierName: driver ? ([driver.firstname, driver.lastname].filter(Boolean).join(' ') || driver.name || null) : null,
    courierPhone: driver?.phone || null,
    lat: driver?.latitude ?? driver?.location?.latitude ?? null,
    lng: driver?.longitude ?? driver?.location?.longitude ?? null,
  };
}

/** Actual cost (in minor) from a Stuart job payload (pricing.amount, pounds → pence). */
export function parseStuartCost(r: any): { totalMinor: number; currency: string } | null {
  const d = r?.data || r || {};
  const job = d.job || d;
  const amt = job?.pricing?.price_tax_included ?? job?.pricing?.amount ?? job?.pricing?.price ?? null;
  const n = Number(amt);
  if (!Number.isFinite(n)) return null;
  return { totalMinor: Math.round(n * 100), currency: String(job?.pricing?.currency || job?.currency || 'GBP').toUpperCase() };
}

// ── Webhook auth ──────────────────────────────────────────────────────────────
// Stuart webhooks are configured per-account in the dashboard. We secure the endpoint with a
// shared secret passed as a ?key= query param on the registered URL (simple + reliable across
// Stuart's webhook variants); if Stuart HMAC-signs in your account, swap to a signature check.
export function verifyStuartKey(reqUrl: string, secret: string): boolean {
  if (!secret) return false;
  try { return new URL(reqUrl).searchParams.get('key') === secret; } catch { return false; }
}
