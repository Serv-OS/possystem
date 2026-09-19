// supabase/functions/_shared/loyalty-utils.ts
//
// Shared utilities for loyalty edge functions.
// Follows the same patterns as gift-card-utils.ts:
//   - CORS headers, JSON helper, opsAdmin + platformAdmin clients
//   - Auth + company resolution
//   - CALLER AUTHORITY (database fence stage 1, 19 Sep 2026): who is calling, for the gift card,
//     loyalty, promo and refund functions. authenticateCaller only proves a JWT; anybody can get
//     one with the public anon key. Authority is: staff of the venue (staffAccess.ts), a device
//     BOUND to the venue (deviceAuthority.ts, the device arm of pos_can_access), the member's
//     own loyalty session token (loyalty-session.ts), or the service role.
//   - Member code generation
//   - Points calculation helpers

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { createCallerFacts, uuidOr0, deviceHintOf } from './callerFacts.ts';
import { secondStepRefusal } from './second-step.ts';

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
// Authentication only: any JWT passes (an anonymous one is free with the public anon key).
// Authority is decided below (checkLoyaltyAuthority, requireStaff, callerStaffOrDevice).
export async function authenticateCaller(
  req: Request,
): Promise<{ user: any } | Response> {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ error: 'Unauthorized' }, 401);
  const {
    data: { user },
  } = await opsAdmin.auth.getUser(authHeader.replace('Bearer ', ''));
  if (!user) return json({ error: 'Invalid token' }, 401);
  // Second sign in step (docs/SECOND_STEP.md): refuses a password only Back Office login
  // once enforcement is switched on. Anonymous tills, kiosks and customer pages pass.
  const secondStepBlock = await secondStepRefusal(authHeader);
  if (secondStepBlock) return secondStepBlock;
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

// ══ CALLER AUTHORITY (database fence stage 1) ══════════════════════════════
// The secret loyalty-otp signs member session tokens with. Same fallback chain as loyalty-otp.
export const OTP_SECRET =
  Deno.env.get('OTP_HMAC_SECRET') ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? 'fallback-secret';

export { uuidOr0, deviceHintOf };

/** Is this request made with the service role key (another edge function)? */
export function isServiceRoleRequest(req: Request): boolean {
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const raw = (req.headers.get('Authorization') ?? '').replace('Bearer ', '').trim();
  return !!key && raw === key;
}

// The facts and decisions live in callerFacts.ts (no remote imports, so node tests drive it with a
// fake client); this is the one instance the edge functions use, on the service role clients.
const facts = createCallerFacts({
  ops: opsAdmin,
  platform: platformAdmin,
  env: (name) => Deno.env.get(name),
  otpSecret: OTP_SECRET,
  json,
});

/** The venue a call acts for: its resolved Ops id and its company. */
export const resolveVenue = facts.resolveVenue;
/** 'fenced' once 20260919a has run (fence_state 'file_a'), 'legacy' before it. */
export const fenceState = facts.fenceState;
/** The device arm of pos_can_access for one venue (bound devices after 20260919a). */
export const callerDeviceFor = facts.callerDeviceFor;
/** Staff of the venue (or company): user_locations, a verified super admin, or a company role. */
export const callerIsStaffFor = facts.callerIsStaffFor;
/** Staff, or a device bound to the venue. */
export const callerStaffOrDevice = facts.callerStaffOrDevice;
/** LOYALTY_AUTHORITY_MODE and the fence: report before 20260919a, enforce after it. */
export const currentLoyaltyAuthorityMode = facts.loyaltyMode;
/** One rate limited `[authority]` log line. */
export const recordAuthority = facts.recordAuthority;
/** The member's own loyalty session, or null. */
export const memberSessionFor = facts.memberSessionFor;
/** The whole loyalty fence: facts, decision, mode, log. */
export const checkLoyaltyAuthority = facts.checkLoyaltyAuthority;
/** Staff only, enforced always. */
export const requireStaff = facts.requireStaff;

/** A signed in Back Office user (never anonymous) with access to this ops location, or super_admin. */
export async function callerHasStaffAccess(user: any, opsLocationId: string): Promise<boolean> {
  return callerIsStaffFor(user, opsLocationId, null);
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
