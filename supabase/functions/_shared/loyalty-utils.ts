// supabase/functions/_shared/loyalty-utils.ts
//
// Shared utilities for loyalty edge functions.
// Follows the same patterns as gift-card-utils.ts:
//   - CORS headers, JSON helper, opsAdmin + platformAdmin clients
//   - Auth + company resolution
//   - Member code generation
//   - Points calculation helpers

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ── CORS + JSON helpers ────────────────────────────────────────────────────
export const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
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
  }

  // Fallback: user_company_roles
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
// Returns the new balance, or null on failure.
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

  const { error } = await platformAdmin
    .from('customer_loyalty')
    .update(updates)
    .eq('id', membershipId)
    .eq('points_balance', current.points_balance); // optimistic concurrency

  if (error) return null;

  return newBalance;
}
