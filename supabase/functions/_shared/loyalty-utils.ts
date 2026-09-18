// supabase/functions/_shared/loyalty-utils.ts
//
// Shared utilities for loyalty edge functions.
// Follows the same patterns as gift-card-utils.ts:
//   - CORS headers, JSON helper, opsAdmin + platformAdmin clients
//   - Auth + company resolution
//   - Member code generation
//   - Points calculation helpers

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  decideLoyaltyAuthority, loyaltyAuthorityMode, applyAuthorityMode, authorityLogRow,
  type AuthorityMode, type LoyaltyAuthority,
} from './loyalty-authority.ts';
import { inspectSessionToken, memberTokenCoversCheck } from './loyalty-session.ts';
import { decideStaffAccess } from './staffAccess.ts';
import { createAuthorityLogLimiter } from './authorityLogLimiter.ts';
import { decideGiftStaffOnly } from './gift-authority.ts';

// ── CORS + JSON helpers ────────────────────────────────────────────────────
export const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-member-token',
};

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });

// ── Supabase clients ───────────────────────────────────────────────────────
export const opsAdmin = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { autoRefreshToken: false, persistSession: false } },
);

export const platformAdmin = createClient(
  Deno.env.get('PLATFORM_SUPABASE_URL') ?? '',
  Deno.env.get('PLATFORM_SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { autoRefreshToken: false, persistSession: false } },
);

// ── Auth helper ────────────────────────────────────────────────────────────
export async function authenticateCaller(
  req: Request,
): Promise<{ user: any } | Response> {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ error: 'Unauthorized' }, 401);
  const {
    data: { user },
  } = await opsAdmin.auth.getUser(authHeader.replace('Bearer ', ''));
  if (!user) return json({ error: 'Invalid token' }, 401);
  return { user };
}

/**
 * The caller of a PUBLIC endpoint (loyalty-balance GET), or null. Never refuses: a missing or
 * bad header just means "no session", and the endpoint decides what that caller may see.
 * The bare anon key is not a user and comes back null too.
 */
export async function optionalCaller(req: Request): Promise<any | null> {
  const raw = (req.headers.get('Authorization') ?? '').replace('Bearer ', '').trim();
  if (!raw) return null;
  try {
    const { data: { user } } = await opsAdmin.auth.getUser(raw);
    return user ?? null;
  } catch {
    return null;
  }
}

// ── Caller authority facts (see loyalty-authority.ts for the decision) ────
// The secret loyalty-otp signs member session tokens with. Same fallback chain as loyalty-otp.
export const OTP_SECRET =
  Deno.env.get('OTP_HMAC_SECRET') ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? 'fallback-secret';

/** A signed in Back Office user (never anonymous) with access to this ops location, or super_admin. */
export async function callerHasStaffAccess(user: any, opsLocationId: string): Promise<boolean> {
  return callerIsStaffFor(user, opsLocationId, null);
}

/**
 * Is this signed in, NON anonymous user staff for the location (or, with no location, for the
 * company)? The SAME rule as the database's user_accessible_locations(), which is user_locations
 * ONLY since 20260918c (lockdown step 1: user_profiles.location_id was self writable, so it is
 * never access), plus super_admin and a Platform user_company_roles row for the location's
 * company. The decision is decideStaffAccess
 * (_shared/staffAccess.ts, pure, parity tested against the SQL); this only gathers the facts.
 * The location id may arrive as the Ops id or the Platform id. Never throws: a failed read is
 * "not staff".
 */
export async function callerIsStaffFor(user: any, locationId: string | null, companyId: string | null): Promise<boolean> {
  if (!user || user.is_anonymous || !user.id) return false;
  try {
    const [{ data: prof }, { data: uls }, { data: ucr }] = await Promise.all([
      opsAdmin.from('user_profiles').select('role').eq('id', user.id).maybeSingle(),
      opsAdmin.from('user_locations').select('location_id').eq('user_id', user.id).limit(1000),
      platformAdmin.from('user_company_roles').select('company_id').eq('user_id', user.id).limit(200),
    ]);
    const locationKeys: string[] = [];
    let company = companyId ? String(companyId) : null;
    let companyOpsLocationIds: string[] = [];
    if (locationId) {
      locationKeys.push(String(locationId));
      const { data: pl } = await platformAdmin.from('locations')
        .select('id, ops_location_id, company_id')
        .or(`id.eq.${uuidOr0(locationId)},ops_location_id.eq.${uuidOr0(locationId)}`)
        .limit(1).maybeSingle();
      if (pl?.ops_location_id && !locationKeys.includes(String(pl.ops_location_id))) locationKeys.push(String(pl.ops_location_id));
      // A company role only counts for the location's OWN company, never one named by the caller.
      company = pl?.company_id ? String(pl.company_id) : null;
    } else if (company) {
      const { data: locs } = await platformAdmin.from('locations').select('ops_location_id').eq('company_id', company).limit(500);
      companyOpsLocationIds = (locs || []).map((r: any) => r.ops_location_id).filter(Boolean).map(String);
    }
    return decideStaffAccess({
      user,
      role: prof?.role ?? null,
      userLocationIds: (uls || []).map((r: any) => r.location_id).filter(Boolean).map(String),
      companyRoleCompanyIds: (ucr || []).map((r: any) => r.company_id).filter(Boolean).map(String),
      locationKeys,
      companyId: company,
      companyOpsLocationIds,
    }).ok;
  } catch (e) {
    console.warn('[staff] access check failed:', (e as any)?.message || e);
    return false;
  }
}

const UUID_ONLY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A value safe to put in a PostgREST filter: the uuid itself, or the nil uuid (matches nothing). */
export function uuidOr0(v: unknown): string {
  return typeof v === 'string' && UUID_ONLY.test(v) ? v : '00000000-0000-0000-0000-000000000000';
}

/** Is this request made with the service role key (another edge function)? */
export function isServiceRoleRequest(req: Request): boolean {
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const raw = (req.headers.get('Authorization') ?? '').replace('Bearer ', '').trim();
  return !!key && raw === key;
}

/**
 * The device the client says it is (its rpos-device id or rpos-kiosk-id), for the log only.
 * Never trusted for anything: it lets the report name the till or kiosk to re-pair.
 */
export function deviceHintOf(body: any): string | null {
  const v = body && typeof body === 'object' ? body.device_hint : null;
  return typeof v === 'string' && UUID_ONLY.test(v) ? v : null;
}

/**
 * The company of the caller's OWN paired device, or null when this session holds none.
 * claim_device() stamps devices.device_uid from the JWT and nothing else writes it, so a session
 * cannot forge a link to a venue it never held the pairing code for (same fence as
 * challenge21-counter). The location comes from that row, never from the request body.
 */
export async function callerDeviceCompany(userId: string): Promise<string | null> {
  if (!userId) return null;
  const { data: dev } = await opsAdmin
    .from('devices')
    .select('location_id, last_seen')
    .eq('device_uid', userId)
    .neq('status', 'removed')
    .not('location_id', 'is', null)
    .order('last_seen', { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  if (!dev?.location_id) return null;
  let { data: loc } = await platformAdmin.from('locations').select('company_id').eq('ops_location_id', dev.location_id).maybeSingle();
  if (!loc) ({ data: loc } = await platformAdmin.from('locations').select('company_id').eq('id', dev.location_id).maybeSingle());
  return loc?.company_id ?? null;
}

/** LOYALTY_AUTHORITY_MODE, read per request. Default 'report'; only "enforce" enforces. */
export function currentLoyaltyAuthorityMode(): AuthorityMode {
  return loyaltyAuthorityMode(Deno.env.get('LOYALTY_AUTHORITY_MODE'));
}

// One limiter per function instance (authorityLogLimiter.ts): per caller, per venue for
// anonymous callers, and a global cap per minute.
const _logLimiter = createAuthorityLogLimiter();

/**
 * Write one caller_authority_log row (Ops). ROUND THREE (18 Sep 2026): NEVER awaited by the
 * caller's request path. It returns at once; the insert (and the venue name lookup that goes
 * with it) runs after the response under EdgeRuntime.waitUntil when the runtime offers it.
 * Rows past the rate limit are dropped and counted (detail.suppressed_before on the next row
 * for that key). Every admitted row is also printed to the function log, so nothing is lost
 * before the migration runs. Never throws.
 */
export function recordAuthority(row: Record<string, unknown>): void {
  try {
    const admit = _logLimiter.admit({
      fn: row.fn, reason: row.reason, callerId: row.caller_id, locationId: row.location_id,
      anonymous: row.caller_anonymous === true,
    });
    if (!admit.write) return;
    const full: Record<string, unknown> = { ...row };
    if (admit.suppressedBefore > 0) {
      full.detail = { ...((row.detail as Record<string, unknown>) ?? {}), suppressed_before: admit.suppressedBefore };
    }
    console.warn('[authority]', JSON.stringify(full));
    const job = (async () => {
      try {
        // One venue per row, whichever id the caller sent (Ops or Platform), so the report groups
        // a venue's rows together and can name it (Ops has no Platform ids to join on).
        const loc = typeof full.location_id === 'string' ? full.location_id : '';
        if (UUID_ONLY.test(loc)) {
          const { data: pl } = await platformAdmin.from('locations')
            .select('ops_location_id, name')
            .or(`id.eq.${loc},ops_location_id.eq.${loc}`)
            .limit(1).maybeSingle();
          if (pl) { full.ops_location_id = pl.ops_location_id ?? null; full.venue_name = pl.name ?? null; }
        }
        let { error } = await opsAdmin.from('caller_authority_log').insert(full);
        if (error && /ops_location_id|venue_name/.test(error.message || '')) {
          // An older copy of the table without the two venue columns: write the row without them.
          delete full.ops_location_id; delete full.venue_name;
          ({ error } = await opsAdmin.from('caller_authority_log').insert(full));
        }
        if (error) console.warn('[authority] log insert failed (is migration 20260918_OPS_caller_authority_log.sql run?):', error.message);
      } catch (e) {
        console.warn('[authority] log insert threw:', (e as any)?.message || e);
      }
    })();
    const rt = (globalThis as any).EdgeRuntime;
    if (rt && typeof rt.waitUntil === 'function') rt.waitUntil(job);
  } catch (e) {
    console.warn('[authority] record failed:', (e as any)?.message || e);
  }
}

/**
 * The member session for a token, or null. A token past its 24 hours still counts for ONE thing:
 * the order it was live for. When closedCheckId names a closed check at this location that was
 * closed while the token was live, the (expired) token is accepted for that call. That is what
 * lets a redemption parked by commitRedemptions replay days later (5a, 18 Sep 2026) without
 * letting an old token act for anything new.
 */
export async function memberSessionFor(
  token: unknown, opts: { closedCheckId?: unknown; locationId?: unknown } = {},
): Promise<{ customerId: string; companyId: string; phone: string | null; replay: boolean } | null> {
  const t = await inspectSessionToken(token, OTP_SECRET);
  if (!t) return null;
  if (!t.expired) return { customerId: t.customerId, companyId: t.companyId, phone: t.phone, replay: false };
  const checkId = typeof opts.closedCheckId === 'string' ? opts.closedCheckId : '';
  const locId = typeof opts.locationId === 'string' ? opts.locationId : '';
  if (!checkId || !locId) return null;
  try {
    const { data: chk } = await opsAdmin.from('closed_checks').select('closed_at').eq('id', checkId).eq('location_id', locId).maybeSingle();
    if (chk?.closed_at && memberTokenCoversCheck(t.issuedAt, Date.parse(chk.closed_at))) {
      return { customerId: t.customerId, companyId: t.companyId, phone: t.phone, replay: true };
    }
  } catch { /* treat as no session */ }
  return null;
}

/**
 * The whole fence for loyalty-earn, loyalty-redeem and loyalty-refund (and the full view of
 * loyalty-member-lookup and loyalty-balance): gather the facts, decide, apply the mode, record.
 *
 *   allow   true  -> carry on exactly as before (report mode ALWAYS allows)
 *   allow   false -> enforce mode refused; return `response`
 *   decision      -> what enforce would say, for callers that degrade instead of refusing
 */
export async function checkLoyaltyAuthority(p: {
  fn: string;
  caller: any;
  locationId: string | null;
  companyId: string;
  customerId: string;
  memberToken?: unknown;
  closedCheckId?: unknown;
  channel?: unknown;
  /** false: a member token never authorises this call (loyalty-refund). Default true. */
  memberAllowed?: boolean;
  /** Force a mode for this function whatever LOYALTY_AUTHORITY_MODE says (e.g. 'enforce' for an endpoint with no report period). */
  modeOverride?: AuthorityMode;
  /** The client's own device id from the body, for the log only (deviceHintOf). */
  deviceHint?: unknown;
}): Promise<{
  allow: boolean; mode: AuthorityMode; decision: LoyaltyAuthority; response: Response | null;
  memberSession: { customerId: string; companyId: string; phone: string | null; replay: boolean } | null;
}> {
  const mode = p.modeOverride ?? currentLoyaltyAuthorityMode();
  const memberAllowed = p.memberAllowed !== false;
  const memberTokenSent = typeof p.memberToken === 'string' && p.memberToken.length > 0;
  const memberSession = memberTokenSent && memberAllowed
    ? await memberSessionFor(p.memberToken, { closedCheckId: p.closedCheckId, locationId: p.locationId })
    : null;
  const memberGood = !!memberSession && memberSession.customerId === String(p.customerId) && memberSession.companyId === String(p.companyId);
  // Round three: a bad, expired or refused member token no longer short cuts the staff and device
  // arms (a claimed till or a manager must never be refused because a token rode along). The
  // facts are only gathered when the member arm did not already pass.
  const staffHasLocation = memberGood ? false : await callerIsStaffFor(p.caller, p.locationId, p.companyId);
  const deviceCompanyId = (memberGood || staffHasLocation || !p.caller) ? null : await callerDeviceCompany(p.caller.id);
  const decision = decideLoyaltyAuthority({
    user: p.caller,
    memberTokenSent,
    memberSession,
    staffHasLocation,
    deviceCompanyId,
    customerId: String(p.customerId),
    companyId: String(p.companyId),
    memberAllowed,
  });
  const applied = applyAuthorityMode(decision, mode);
  if (applied.record) {
    recordAuthority(authorityLogRow({
      fn: p.fn, mode, outcome: applied.outcome, decision, user: p.caller,
      companyId: p.companyId, locationId: p.locationId, customerId: p.customerId,
      closedCheckId: p.closedCheckId, channel: p.channel, deviceHint: p.deviceHint,
      detail: { device_company_differs: !!deviceCompanyId && deviceCompanyId !== p.companyId },
    }));
  }
  if (!applied.allow && !decision.ok) {
    return { allow: false, mode, decision, memberSession, response: json({ error: decision.error, code: 'loyalty_authority', reason: decision.reason }, decision.status) };
  }
  return { allow: true, mode, decision, memberSession, response: null };
}

/**
 * Staff only, enforced now (round three): gift-issue, gift-import, gift-bulk-create, gift-config,
 * gift-void, gift-resend, and the writes of loyalty-config and loyalty-rewards. Returns null when
 * the caller is staff for the location (or company), else the refusal Response, and records the
 * refusal in caller_authority_log (outcome 'refused', mode 'enforce').
 */
export async function requireStaff(p: {
  fn: string; caller: any; locationId: string | null; companyId: string | null; what: string; body?: any;
}): Promise<Response | null> {
  const staff = await callerIsStaffFor(p.caller, p.locationId, p.companyId);
  const d = decideGiftStaffOnly({ user: p.caller, staff }, p.what);
  if (d.ok) return null;
  recordAuthority(authorityLogRow({
    fn: p.fn, mode: 'enforce', outcome: 'refused',
    decision: { ok: false, reason: d.reason, callerKind: !p.caller ? 'none' : (p.caller.is_anonymous ? 'anonymous' : 'user_no_access') },
    user: p.caller, companyId: p.companyId, locationId: p.locationId,
    channel: p.body?.channel ?? null, deviceHint: deviceHintOf(p.body),
  }));
  return json({ error: d.error, code: 'staff_only', reason: d.reason }, d.status);
}

// ── Company resolution (location-based, same as gift-card-utils) ──────────
export async function resolveCompanyForLocation(
  userId: string,
  locationId?: string | null,
): Promise<string | Response> {
  if (locationId) {
    // Try as ops_location_id first
    const { data: locByOps } = await platformAdmin
      .from('locations')
      .select('company_id')
      .eq('ops_location_id', locationId)
      .maybeSingle();
    if (locByOps?.company_id) return locByOps.company_id;

    // Try as platform location ID
    const { data: locById } = await platformAdmin
      .from('locations')
      .select('company_id')
      .eq('id', locationId)
      .maybeSingle();
    if (locById?.company_id) return locById.company_id;

    // v5.5.320: location_id provided but unmatched → FAIL CLOSED (do not fall
    // through to the arbitrary user_company_roles fallback, which can resolve a
    // multi-company user to the WRONG tenant). All real locations are mirrored
    // by provision-location; an unmatched one is a provisioning gap.
    return json({
      error: 'Location not provisioned in the platform database. Re-provision it (Company Admin → the location).',
      code: 'location_not_provisioned',
    }, 409);
  }

  // No location_id supplied — fall back to user_company_roles (single-company).
  const { data } = await platformAdmin
    .from('user_company_roles')
    .select('company_id')
    .eq('user_id', userId)
    .limit(1)
    .maybeSingle();
  if (data?.company_id) return data.company_id;

  return json({ error: 'Could not resolve company. Ensure location is linked.' }, 403);
}

// ── Member code generation ─────────────────────────────────────────────────
// Format: "SRV-XXXXXX" — 6 chars from unambiguous alphabet.
// 32^6 = 1,073,741,824 possibilities — plenty for loyalty members.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;

export function generateMemberCode(): string {
  const bytes = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return `SRV-${code}`;
}

export function generateReferralCode(): string {
  const bytes = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return `REF-${code}`;
}

// ── Points calculation ─────────────────────────────────────────────────────
// Calculate points earned from a qualifying amount.
//
// @param qualifyingMinor - amount in minor currency units (pence/cents)
// @param pointsPerUnit   - points earned per 1 currency unit (e.g., 1.0)
// @param multiplier      - tier/rule multiplier (e.g., 2.0 for double points)
// @param rounding        - 'floor'|'ceil'|'round'
export function calculatePoints(
  qualifyingMinor: number,
  pointsPerUnit: number,
  multiplier: number = 1.0,
  rounding: string = 'floor',
): number {
  // Convert minor units to major (e.g., 1500 pence → £15.00)
  const majorAmount = qualifyingMinor / 100;
  const raw = majorAmount * pointsPerUnit * multiplier;

  switch (rounding) {
    case 'ceil': return Math.ceil(raw);
    case 'round': return Math.round(raw);
    default: return Math.floor(raw);
  }
}

// ── Calculate qualifying amount from line items ────────────────────────────
// Excludes items/categories per loyalty config.
export function calculateQualifyingAmount(
  items: Array<{
    id?: string;
    cat?: string;
    price?: number;
    qty?: number;
    isGiftCard?: boolean;
    isComp?: boolean;
    staffDiscount?: boolean;
  }>,
  config: {
    earn_on_gift_card_purchase?: boolean;
    earn_on_staff_discount?: boolean;
    earn_on_comps?: boolean;
    excluded_category_ids?: string[];
    excluded_item_ids?: string[];
  },
): number {
  let totalMinor = 0;
  const excludedCats = new Set(config.excluded_category_ids || []);
  const excludedItems = new Set(config.excluded_item_ids || []);

  for (const item of items) {
    // Skip excluded items
    if (item.id && excludedItems.has(item.id)) continue;

    // Skip excluded categories
    if (item.cat && excludedCats.has(item.cat)) continue;

    // Skip gift card purchases unless configured to earn
    if (item.isGiftCard && !config.earn_on_gift_card_purchase) continue;

    // Skip comps unless configured
    if (item.isComp && !config.earn_on_comps) continue;

    // Skip staff discount items unless configured
    if (item.staffDiscount && !config.earn_on_staff_discount) continue;

    const price = Math.round(Number(item.price || 0) * 100); // convert to minor
    const qty = Number(item.qty || 1);
    totalMinor += price * qty;
  }

  return Math.max(0, totalMinor);
}

// ── Get loyalty config, creating default if missing ────────────────────────
export async function getOrCreateConfig(companyId: string) {
  let { data: config } = await platformAdmin
    .from('loyalty_config')
    .select('*')
    .eq('company_id', companyId)
    .maybeSingle();

  if (!config) {
    const { data: newConfig, error } = await platformAdmin
      .from('loyalty_config')
      .insert({ company_id: companyId, enabled: false })
      .select()
      .single();
    if (error) return null;
    config = newConfig;
  }

  return config;
}

// ── Enroll customer in loyalty (create customer_loyalty row) ───────────────
// Idempotent — returns existing membership if already enrolled.
export async function ensureMembership(
  customerId: string,
  companyId: string,
  config?: any,
): Promise<{ membership: any; isNew: boolean } | Response> {
  // Check for existing membership
  const { data: existing } = await platformAdmin
    .from('customer_loyalty')
    .select('*')
    .eq('customer_id', customerId)
    .eq('company_id', companyId)
    .maybeSingle();

  if (existing) return { membership: existing, isNew: false };

  // Create new membership
  const memberCode = generateMemberCode();
  const referralCode = generateReferralCode();

  // Get config for registration bonus
  const loyaltyConfig = config || await getOrCreateConfig(companyId);
  const registrationBonus = loyaltyConfig?.registration_bonus || 0;

  const { data: membership, error } = await platformAdmin
    .from('customer_loyalty')
    .insert({
      customer_id: customerId,
      company_id: companyId,
      member_code: memberCode,
      referral_code: referralCode,
      points_balance: registrationBonus,
      points_earned_total: registrationBonus,
    })
    .select()
    .single();

  if (error) {
    // Could be duplicate member_code — retry once with new code
    if (error.code === '23505' && error.message?.includes('member_code')) {
      const retryCode = generateMemberCode();
      const { data: retry, error: retryErr } = await platformAdmin
        .from('customer_loyalty')
        .insert({
          customer_id: customerId,
          company_id: companyId,
          member_code: retryCode,
          referral_code: generateReferralCode(),
          points_balance: registrationBonus,
          points_earned_total: registrationBonus,
        })
        .select()
        .single();
      if (retryErr) return json({ error: `Failed to create membership: ${retryErr.message}` }, 500);
      return { membership: retry!, isNew: true };
    }
    // Check if it was created by a concurrent request
    const { data: raceCheck } = await platformAdmin
      .from('customer_loyalty')
      .select('*')
      .eq('customer_id', customerId)
      .eq('company_id', companyId)
      .maybeSingle();
    if (raceCheck) return { membership: raceCheck, isNew: false };
    return json({ error: `Failed to create membership: ${error.message}` }, 500);
  }

  return { membership: membership!, isNew: true };
}

// ── Atomic balance update ──────────────────────────────────────────────────
// Updates customer_loyalty.points_balance atomically using an RPC-like pattern.
// Returns the new balance, or null if nothing was applied (row gone, insufficient
// balance, or the optimistic compare-and-swap lost the race). Callers MUST treat
// null as "the balance did not move" — loyalty-redeem rolls its ledger guard row
// back on it.
export async function updateBalance(
  membershipId: string,
  pointsDelta: number,
): Promise<number | null> {
  // Read current balance
  const { data: current } = await platformAdmin
    .from('customer_loyalty')
    .select('points_balance')
    .eq('id', membershipId)
    .single();

  if (!current) return null;

  const newBalance = current.points_balance + pointsDelta;
  if (newBalance < 0) return null; // insufficient balance

  const updates: Record<string, any> = {
    points_balance: newBalance,
  };

  if (pointsDelta > 0) {
    updates.last_earn_at = new Date().toISOString();
  } else if (pointsDelta < 0) {
    updates.last_redeem_at = new Date().toISOString();
  }

  // .select() is load-bearing: without it PostgREST answers 204 and supabase-js reports
  // { error: null } whether the CAS matched one row or ZERO. The returned row is the only
  // proof the write landed — a lost race must surface as null, not as a fake new balance.
  const { data: applied, error } = await platformAdmin
    .from('customer_loyalty')
    .update(updates)
    .eq('id', membershipId)
    .eq('points_balance', current.points_balance) // optimistic concurrency
    .select('id');

  if (error || !applied?.length) return null;

  return newBalance;
}
