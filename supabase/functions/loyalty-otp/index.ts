// supabase/functions/loyalty-otp/index.ts
//
// Customer-facing OTP authentication for the loyalty portal.
// No auth required (public endpoint — customers are not Supabase users).
//
// POST action=send:
//   { action: 'send', phone: '+447931...', company_id: 'uuid' }
//   → generates 6-digit OTP, stores in loyalty_otp_codes, sends via SMS
//   → returns { sent: true }
//
// POST action=verify:
//   { action: 'verify', phone: '+447931...', company_id: 'uuid', code: '123456' }
//   → checks code, marks used, returns customer + loyalty data
//   → returns { verified: true, token: '<session_token>', customer: {...}, loyalty: {...} }
//
// OTP codes expire after 5 minutes. Max 3 active codes per phone.
// A "session token" is a signed HMAC of (customer_id + timestamp) — lightweight,
// no Supabase auth needed. The portal sends this token on subsequent requests.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), {
    status: s,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });

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

const OPS_URL = Deno.env.get('SUPABASE_URL') ?? '';
const OPS_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const OTP_SECRET = Deno.env.get('OTP_HMAC_SECRET') ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? 'fallback-secret';
const OTP_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes

// ── HMAC session token ──────────────────────────────────────────────────
async function createSessionToken(customerId: string, companyId: string): Promise<string> {
  const payload = `${customerId}:${companyId}:${Date.now()}`;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(OTP_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
  const hex = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
  // Token format: base64(payload):signature
  return btoa(payload) + '.' + hex;
}

async function verifySessionToken(token: string): Promise<{ customerId: string; companyId: string } | null> {
  try {
    const [payloadB64, sig] = token.split('.');
    if (!payloadB64 || !sig) return null;
    const payload = atob(payloadB64);
    const [customerId, companyId, timestampStr] = payload.split(':');
    if (!customerId || !companyId || !timestampStr) return null;
    // Check expiry (24 hours)
    const age = Date.now() - Number(timestampStr);
    if (age > 24 * 60 * 60 * 1000) return null;
    // Verify signature
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw', enc.encode(OTP_SECRET),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'],
    );
    const sigBytes = new Uint8Array(sig.match(/.{2}/g)!.map(h => parseInt(h, 16)));
    const valid = await crypto.subtle.verify('HMAC', key, sigBytes, enc.encode(payload));
    if (!valid) return null;
    return { customerId, companyId };
  } catch {
    return null;
  }
}

// ── Phone normalisation ──────────────────────────────────────────────────
function normalisePhone(raw: string): string | null {
  if (!raw) return null;
  const digits = String(raw).replace(/[^\d+]/g, '');
  if (!digits) return null;
  if (digits.startsWith('+')) return digits;
  if (digits.startsWith('07') && digits.length === 11) return '+44' + digits.slice(1);
  if (digits.startsWith('44')) return '+' + digits;
  return digits;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }

  const action = body.action as string;
  const rawPhone = body.phone as string;
  const companyId = body.company_id as string;

  if (!companyId) return json({ error: 'company_id required' }, 400);
  if (!rawPhone) return json({ error: 'phone required' }, 400);

  const phone = normalisePhone(rawPhone);
  if (!phone) return json({ error: 'Invalid phone number' }, 400);

  // ── ACTION: SEND OTP ────────────────────────────────────────────────
  if (action === 'send') {
    // Generate 6-digit code
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const expiresAt = new Date(Date.now() + OTP_EXPIRY_MS).toISOString();

    // Store in platform DB
    await platformAdmin.from('loyalty_otp_codes').insert({
      phone,
      company_id: companyId,
      code,
      expires_at: expiresAt,
    });

    // Clean up old codes for this phone (keep last 3)
    const { data: old } = await platformAdmin
      .from('loyalty_otp_codes')
      .select('id')
      .eq('phone', phone)
      .eq('company_id', companyId)
      .order('created_at', { ascending: false });
    if (old && old.length > 3) {
      const idsToDelete = old.slice(3).map((r: any) => r.id);
      await platformAdmin.from('loyalty_otp_codes').delete().in('id', idsToDelete);
    }

    // Resolve company name for the SMS
    let companyName = 'our venue';
    try {
      const { data: co } = await platformAdmin
        .from('companies')
        .select('name')
        .eq('id', companyId)
        .maybeSingle();
      if (co?.name) companyName = co.name;
    } catch {}

    // Resolve location_id for send-sms audit trail
    let locationId: string | null = null;
    try {
      const { data: loc } = await platformAdmin
        .from('locations')
        .select('ops_location_id')
        .eq('company_id', companyId)
        .limit(1)
        .maybeSingle();
      locationId = loc?.ops_location_id || null;
    } catch {}

    // Send SMS via send-sms edge function
    try {
      const smsRes = await fetch(`${OPS_URL}/functions/v1/send-sms`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OPS_SERVICE_KEY}`,
        },
        body: JSON.stringify({
          to: phone,
          message: `Your ${companyName} verification code is: ${code}. Valid for 5 minutes.`,
          location_id: locationId || companyId, // fallback to companyId if no ops location found
          type: 'otp',
          reference_id: companyId,
        }),
      });
      if (!smsRes.ok) {
        const smsErr = await smsRes.json().catch(() => ({}));
        console.error('[loyalty-otp] SMS send failed:', smsErr);
        return json({ error: `Failed to send verification code: ${(smsErr as any)?.error || 'SMS service error'}` }, 500);
      }
    } catch (e) {
      console.error('[loyalty-otp] SMS send threw:', e);
      return json({ error: 'Failed to send verification code' }, 500);
    }

    return json({ sent: true });
  }

  // ── ACTION: VERIFY OTP ──────────────────────────────────────────────
  if (action === 'verify') {
    const code = String(body.code || '').trim();
    if (!code || code.length !== 6) return json({ error: 'Invalid code' }, 400);

    // Look up the code
    const now = new Date().toISOString();
    const { data: otpRow } = await platformAdmin
      .from('loyalty_otp_codes')
      .select('id, code, expires_at, used')
      .eq('phone', phone)
      .eq('company_id', companyId)
      .eq('code', code)
      .eq('used', false)
      .gte('expires_at', now)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!otpRow) {
      return json({ error: 'Invalid or expired code' }, 401);
    }

    // Mark as used
    await platformAdmin.from('loyalty_otp_codes')
      .update({ used: true })
      .eq('id', otpRow.id);

    // ── Resolve org + find/create customer ────────────────────────────
    // org_id lives on the OPS locations table, not platform. Resolve via
    // platform → ops_location_id → ops locations.org_id.
    const { data: platLoc } = await platformAdmin
      .from('locations')
      .select('ops_location_id')
      .eq('company_id', companyId)
      .limit(1)
      .maybeSingle();

    if (!platLoc?.ops_location_id) {
      return json({ error: 'Company configuration error: no linked location' }, 500);
    }

    const { data: opsLoc } = await opsAdmin
      .from('locations')
      .select('org_id')
      .eq('id', platLoc.ops_location_id)
      .maybeSingle();

    const orgId = opsLoc?.org_id;
    if (!orgId) {
      return json({ error: 'Company configuration error: org not found' }, 500);
    }

    // Find customer by phone in ops DB
    let customer: any = null;
    const { data: existing } = await opsAdmin
      .from('customers')
      .select('id, name, email, phone, marketing_opt_in')
      .eq('org_id', orgId)
      .eq('phone', phone)
      .is('deleted_at', null)
      .maybeSingle();

    if (existing) {
      customer = existing;
    } else {
      // Create new customer record
      const { data: newCust } = await opsAdmin
        .from('customers')
        .insert({
          org_id: orgId,
          phone,
          name: null,
          email: null,
        })
        .select('id, name, email, phone, marketing_opt_in')
        .single();
      customer = newCust;
    }

    if (!customer) {
      return json({ error: 'Failed to resolve customer' }, 500);
    }

    // ── Get/create loyalty membership ────────────────────────────────
    let loyaltyData: any = null;
    let tier: any = null;
    let rewards: any[] = [];
    let allRewards: any[] = [];
    let recentTx: any[] = [];

    try {
      // Check if loyalty is enabled
      const { data: config } = await platformAdmin
        .from('loyalty_config')
        .select('*')
        .eq('company_id', companyId)
        .maybeSingle();

      if (config?.enabled) {
        // Get or create membership
        let { data: membership } = await platformAdmin
          .from('customer_loyalty')
          .select('*')
          .eq('customer_id', customer.id)
          .eq('company_id', companyId)
          .maybeSingle();

        if (!membership) {
          // Auto-enroll
          const memberCode = generateMemberCode();
          const { data: newMember } = await platformAdmin
            .from('customer_loyalty')
            .insert({
              customer_id: customer.id,
              company_id: companyId,
              member_code: memberCode,
              points_balance: config.registration_bonus || 0,
              points_earned_total: config.registration_bonus || 0,
              referral_code: generateReferralCode(),
            })
            .select('*')
            .single();
          membership = newMember;
        }

        if (membership) {
          loyaltyData = membership;

          // Get tier
          if (membership.tier_id) {
            const { data: t } = await platformAdmin
              .from('loyalty_tiers')
              .select('name, color, icon, points_multiplier')
              .eq('id', membership.tier_id)
              .maybeSingle();
            tier = t;
          }

          // Get rewards
          const { data: rw } = await platformAdmin
            .from('loyalty_rewards')
            .select('id, name, description, icon, points_cost, reward_type, reward_value')
            .eq('company_id', companyId)
            .eq('active', true)
            .order('sort_order');

          allRewards = rw || [];
          rewards = allRewards.filter(r => r.points_cost <= membership.points_balance);

          // Recent transactions
          const { data: tx } = await opsAdmin
            .from('loyalty_transactions')
            .select('type, points, created_at')
            .eq('customer_id', customer.id)
            .eq('company_id', companyId)
            .order('created_at', { ascending: false })
            .limit(20);
          recentTx = tx || [];
        }
      }
    } catch (e) {
      console.warn('[loyalty-otp] loyalty data fetch failed:', e);
    }

    // ── Get linked gift cards ────────────────────────────────────────
    let giftCards: any[] = [];
    try {
      const conditions: string[] = [];
      if (customer.email) conditions.push(`recipient_email.eq.${customer.email}`);
      if (customer.phone) conditions.push(`recipient_phone.eq.${customer.phone}`);
      if (conditions.length > 0) {
        const { data: cards } = await platformAdmin
          .from('gift_cards')
          .select('id, code_last4, balance_minor, status, expires_at, initial_amount_minor')
          .eq('company_id', companyId)
          .eq('status', 'active')
          .or(conditions.join(','));
        giftCards = (cards || []).map(c => ({
          id: c.id,
          last4: c.code_last4,
          balance: c.balance_minor,
          initial: c.initial_amount_minor,
          expires_at: c.expires_at,
        }));
      }
    } catch {}

    // ── Create session token ─────────────────────────────────────────
    const token = await createSessionToken(customer.id, companyId);

    return json({
      verified: true,
      token,
      customer: {
        id: customer.id,
        name: customer.name,
        email: customer.email,
        phone: customer.phone,
      },
      loyalty: loyaltyData ? {
        member_code: loyaltyData.member_code,
        points_balance: loyaltyData.points_balance,
        points_earned_total: loyaltyData.points_earned_total,
        points_redeemed_total: loyaltyData.points_redeemed_total,
        visit_count: loyaltyData.visit_count,
        enrolled_at: loyaltyData.enrolled_at,
        tier: tier ? {
          name: tier.name,
          color: tier.color,
          icon: tier.icon,
          multiplier: tier.points_multiplier,
        } : null,
        rewards_available: rewards.map(r => ({
          id: r.id, name: r.name, description: r.description,
          icon: r.icon, points_cost: r.points_cost,
          reward_type: r.reward_type,
        })),
        all_rewards: allRewards.map(r => ({
          id: r.id, name: r.name, description: r.description,
          icon: r.icon, points_cost: r.points_cost,
          reward_type: r.reward_type,
        })),
        recent_transactions: recentTx.map(tx => ({
          type: tx.type, points: tx.points, created_at: tx.created_at,
        })),
      } : null,
      gift_cards: giftCards,
    });
  }

  // ── ACTION: REFRESH (use session token to get updated data) ─────────
  if (action === 'refresh') {
    const token = body.token as string;
    if (!token) return json({ error: 'token required' }, 400);

    const session = await verifySessionToken(token);
    if (!session) return json({ error: 'Invalid or expired session' }, 401);

    // Fetch fresh loyalty data
    const balanceUrl = `${OPS_URL}/functions/v1/loyalty-balance`
      + `?customer_id=${encodeURIComponent(session.customerId)}&company_id=${encodeURIComponent(session.companyId)}`;
    const balRes = await fetch(balanceUrl);
    if (!balRes.ok) return json({ error: 'Failed to fetch loyalty data' }, 500);
    const loyaltyData = await balRes.json();

    // Fetch customer profile
    const { data: cust } = await opsAdmin
      .from('customers')
      .select('id, name, email, phone')
      .eq('id', session.customerId)
      .maybeSingle();

    // Fetch gift cards
    let giftCards: any[] = [];
    try {
      const conditions: string[] = [];
      if (cust?.email) conditions.push(`recipient_email.eq.${cust.email}`);
      if (cust?.phone) conditions.push(`recipient_phone.eq.${cust.phone}`);
      if (conditions.length > 0) {
        const { data: cards } = await platformAdmin
          .from('gift_cards')
          .select('id, code_last4, balance_minor, status, expires_at, initial_amount_minor')
          .eq('company_id', session.companyId)
          .eq('status', 'active')
          .or(conditions.join(','));
        giftCards = (cards || []).map(c => ({
          id: c.id, last4: c.code_last4, balance: c.balance_minor,
          initial: c.initial_amount_minor, expires_at: c.expires_at,
        }));
      }
    } catch {}

    return json({
      customer: cust ? {
        id: cust.id, name: cust.name, email: cust.email, phone: cust.phone,
      } : null,
      loyalty: loyaltyData,
      gift_cards: giftCards,
    });
  }

  // ── ACTION: UPDATE PROFILE ─────────────────────────────────────────
  if (action === 'update_profile') {
    const token = body.token as string;
    if (!token) return json({ error: 'token required' }, 400);

    const session = await verifySessionToken(token);
    if (!session) return json({ error: 'Invalid or expired session' }, 401);

    const updates: Record<string, unknown> = {};
    if (typeof body.name === 'string') updates.name = body.name.trim() || null;
    if (typeof body.email === 'string') updates.email = body.email.trim() || null;
    if (typeof body.marketing_opt_in === 'boolean') updates.marketing_opt_in = body.marketing_opt_in;

    if (Object.keys(updates).length === 0) return json({ error: 'No fields to update' }, 400);

    const { error: upErr } = await opsAdmin
      .from('customers')
      .update(updates)
      .eq('id', session.customerId);

    if (upErr) return json({ error: upErr.message }, 500);

    // Update birthday on loyalty membership if provided
    if (typeof body.birthday === 'string') {
      await platformAdmin
        .from('customer_loyalty')
        .update({ birthday: body.birthday || null })
        .eq('customer_id', session.customerId)
        .eq('company_id', session.companyId);
    }

    return json({ updated: true });
  }

  return json({ error: 'Unknown action. Use: send, verify, refresh, update_profile' }, 400);
});

// ── Code generators (same as loyalty-utils.ts) ───────────────────────────
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function generateMemberCode(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  let code = 'SRV-';
  for (let i = 0; i < 6; i++) code += ALPHABET[bytes[i] % ALPHABET.length];
  return code;
}
function generateReferralCode(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let code = '';
  for (let i = 0; i < 8; i++) code += ALPHABET[bytes[i] % ALPHABET.length];
  return code;
}
