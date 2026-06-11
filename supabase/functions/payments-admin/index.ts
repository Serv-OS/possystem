// supabase/functions/payments-admin/index.ts
//
// Admin-portal payments mutations (super_admin only). One function, several
// actions, all writing the Platform DB with the service role so merchant_ryft_*
// stays service-role-write (tighter than the legacy client-side Stripe writes):
//
//   set_processor        { location_id, processor }                 → locations.payment_processor
//   ryft_create          { location_id, entity_type?, email?, business?, individual?, redirect_url? }
//   ryft_link            { location_id, ryft_account_id, redirect_url? }
//   ryft_sync            { location_id }
//   ryft_onboarding_link { location_id, redirect_url, email? }
//   ryft_pricing         { location_id, markup_percent, markup_fixed_pence, pricing_notes }
//
// Auth: Ops DB user_profiles.role = 'super_admin' (matches stripe-link-merchant).
// Ryft account API is the marketplace platform model — create a Sub-Account with
// the platform secret key, then mint a Hosted onboarding link. Verified against
// the Ryft OpenAPI spec.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { createSubAccount, getAccount, createAccountLink, authorizeAccount, ryftConfigured } from '../_shared/ryft.ts';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

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

// Ryft doesn't expose a single charges_enabled flag like Stripe — derive a
// usable status from the verification block + card capabilities, and keep the
// raw verification object for the UI to show what's still outstanding.
function deriveStatus(account: any) {
  const v = account?.verification ?? {};
  const caps = account?.capabilities ?? {};
  const cardKeys = ['visaPayments', 'mastercardPayments', 'amexPayments', 'inPersonPayments'];
  const anyEnabled = cardKeys.some((k) => caps?.[k]?.status === 'Enabled');
  const charges_enabled = anyEnabled || v?.status === 'Verified';
  const details_submitted = !!v?.status && v.status !== 'Required';
  const country = account?.business?.registeredAddress?.country ?? account?.individual?.address?.country ?? null;
  return { charges_enabled, details_submitted, verification_status: v?.status ?? null, country, verification: v };
}

async function resolveLocation(location_id: string) {
  const { data, error } = await platformAdmin.from('locations')
    .select('id, company_id, name').eq('id', location_id).single();
  if (error || !data) return null;
  return data;
}

async function upsertRyftAccount(loc: any, accountId: string, account: any, userId: string | null) {
  const d = deriveStatus(account);
  const { error } = await platformAdmin.from('merchant_ryft_accounts').upsert({
    location_id: loc.id,
    company_id: loc.company_id,
    ryft_account_id: accountId,
    link_method: 'hosted',
    charges_enabled: d.charges_enabled,
    details_submitted: d.details_submitted,
    country: d.country,
    requirements: d.verification ?? null,
    linked_by_user_id: userId,
    last_webhook_at: null,
  }, { onConflict: 'location_id' });
  return { error, derived: d };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  // ── Auth: super_admin (Ops DB) ──────────────────────────────────────────
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ error: 'Unauthorized' }, 401);
  const { data: { user: caller } } = await opsAdmin.auth.getUser(authHeader.replace('Bearer ', ''));
  if (!caller) return json({ error: 'Invalid token' }, 401);
  const { data: profile } = await opsAdmin.from('user_profiles').select('role').eq('id', caller.id).single();
  if (profile?.role !== 'super_admin') return json({ error: 'Requires super_admin' }, 403);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const action = body?.action as string;
  const location_id = body?.location_id as string;
  if (!action) return json({ error: 'action required' }, 400);
  if (!location_id) return json({ error: 'location_id required' }, 400);

  const loc = await resolveLocation(location_id);
  if (!loc) return json({ error: 'location not found in platform DB' }, 404);

  // ── set_processor (works for both processors; no Ryft needed) ───────────
  if (action === 'set_processor') {
    const processor = body?.processor;
    if (processor !== 'stripe' && processor !== 'ryft') return json({ error: "processor must be 'stripe' or 'ryft'" }, 400);
    const { error } = await platformAdmin.from('locations').update({ payment_processor: processor }).eq('id', loc.id);
    if (error) return json({ error: `processor update failed: ${error.message}` }, 500);
    return json({ success: true, processor });
  }

  // ── ryft_pricing (single markup = the platform fee: % + fixed pence) ─────
  if (action === 'ryft_pricing') {
    const numOrNull = (v: unknown) => (v === '' || v === null || v === undefined ? null : Number(v));
    const intOrNull = (v: unknown) => (v === '' || v === null || v === undefined ? null : Math.round(Number(v)));
    const patch: Record<string, unknown> = {
      markup_percent: numOrNull(body.markup_percent),
      markup_fixed_pence: intOrNull(body.markup_fixed_pence),
      pricing_notes: body.pricing_notes || null,
    };
    const { error } = await platformAdmin.from('merchant_ryft_accounts').update(patch).eq('location_id', loc.id);
    if (error) return json({ error: `pricing update failed: ${error.message}` }, 500);
    return json({ success: true });
  }

  // ── ryft_unlink: detach the account row (does NOT delete it at Ryft) ─────
  if (action === 'ryft_unlink') {
    const { error } = await platformAdmin.from('merchant_ryft_accounts').delete().eq('location_id', loc.id);
    if (error) return json({ error: `unlink failed: ${error.message}` }, 500);
    return json({ success: true });
  }

  // Everything below talks to Ryft.
  if (!ryftConfigured()) return json({ error: 'Ryft not configured (RYFT_SECRET_KEY missing)' }, 500);

  // ── ryft_create: new Sub-Account + Hosted onboarding link ───────────────
  if (action === 'ryft_create') {
    // Don't silently orphan an existing merchant account.
    const { data: existing } = await platformAdmin.from('merchant_ryft_accounts')
      .select('ryft_account_id').eq('location_id', loc.id).maybeSingle();
    if (existing?.ryft_account_id) {
      return json({ error: `This location already has Ryft account ${existing.ryft_account_id}. Use "Continue onboarding" or "Sync", or unlink first.` }, 409);
    }
    if (!body.email) return json({ error: 'email is required to create a Hosted merchant' }, 400);
    const input: Record<string, unknown> = { onboardingFlow: 'Hosted', email: body.email };
    // Ryft REJECTS entityType unless its matching block is also present, so only
    // pre-fill when a COMPLETE block is supplied. For Hosted onboarding the
    // merchant fills entity type + KYC/KYB in Ryft's portal regardless.
    if (body.entity_type === 'Business' && body.business) { input.entityType = 'Business'; input.business = body.business; }
    else if (body.entity_type === 'Individual' && body.individual) { input.entityType = 'Individual'; input.individual = body.individual; }
    const meta: Record<string, string> = { location_id: loc.id, location_name: String(loc.name ?? '').slice(0, 60) };
    if (body.trading_name) meta.trading_name = String(body.trading_name).slice(0, 60);
    input.metadata = meta;

    const created = await createSubAccount(input);
    if (!created.ok || !created.data?.id) {
      return json({ error: created.data?.message || `Ryft account create failed (${created.status})`, ryft: created.data }, 502);
    }
    const accountId = created.data.id as string;

    const { error: upErr, derived } = await upsertRyftAccount(loc, accountId, created.data, caller.id);
    if (upErr) return json({ error: `merchant_ryft_accounts upsert failed: ${upErr.message}` }, 500);

    // Mint the hosted onboarding link (best-effort — the account exists either way).
    let onboarding_url: string | null = null, expires_at: number | null = null, link_error: string | null = null;
    if (body.redirect_url) {
      const link = await createAccountLink({ accountId, redirectUrl: body.redirect_url });
      if (link.ok && link.data?.url) { onboarding_url = link.data.url; expires_at = link.data.expiresTimestamp ?? null; }
      else link_error = link.data?.message || `account-link failed (${link.status})`;
    }
    return json({ success: true, account_id: accountId, verification_status: derived.verification_status, charges_enabled: derived.charges_enabled, onboarding_url, expires_at, link_error });
  }

  // ── ryft_link: attach an existing ac_… account ──────────────────────────
  if (action === 'ryft_link') {
    const accountId = String(body.ryft_account_id ?? '').trim();
    if (!accountId.startsWith('ac_')) return json({ error: "ryft_account_id must start with 'ac_'" }, 400);
    const got = await getAccount(accountId);
    if (!got.ok || !got.data?.id) return json({ error: got.data?.message || `Ryft account not found (${got.status})`, ryft: got.data }, 400);
    const { error: upErr, derived } = await upsertRyftAccount(loc, accountId, got.data, caller.id);
    if (upErr) return json({ error: `merchant_ryft_accounts upsert failed: ${upErr.message}` }, 500);
    return json({ success: true, account_id: accountId, verification_status: derived.verification_status, charges_enabled: derived.charges_enabled });
  }

  // ── ryft_sync: refresh status from Ryft ─────────────────────────────────
  if (action === 'ryft_sync') {
    const { data: row } = await platformAdmin.from('merchant_ryft_accounts')
      .select('ryft_account_id').eq('location_id', loc.id).maybeSingle();
    if (!row?.ryft_account_id) return json({ error: 'No Ryft account linked to this location' }, 404);
    const got = await getAccount(row.ryft_account_id);
    if (!got.ok || !got.data?.id) return json({ error: got.data?.message || `Ryft fetch failed (${got.status})`, ryft: got.data }, 502);
    const { error: upErr, derived } = await upsertRyftAccount(loc, row.ryft_account_id, got.data, caller.id);
    if (upErr) return json({ error: `merchant_ryft_accounts update failed: ${upErr.message}` }, 500);
    return json({ success: true, account_id: row.ryft_account_id, verification_status: derived.verification_status, charges_enabled: derived.charges_enabled });
  }

  // ── ryft_onboarding_link: fresh hosted link to continue/finish KYC ──────
  if (action === 'ryft_onboarding_link') {
    if (!body.redirect_url) return json({ error: 'redirect_url required' }, 400);
    const { data: row } = await platformAdmin.from('merchant_ryft_accounts')
      .select('ryft_account_id').eq('location_id', loc.id).maybeSingle();
    if (!row?.ryft_account_id) return json({ error: 'No Ryft account linked to this location' }, 404);
    const link = await createAccountLink({ accountId: row.ryft_account_id, redirectUrl: body.redirect_url });
    if (link.ok && link.data?.url) return json({ success: true, onboarding_url: link.data.url, expires_at: link.data.expiresTimestamp ?? null });
    // Fall back to an authorize (sign-in) link for a returning merchant.
    if (body.email) {
      const auth = await authorizeAccount({ email: body.email, redirectUrl: body.redirect_url });
      if (auth.ok && auth.data?.url) return json({ success: true, onboarding_url: auth.data.url, expires_at: auth.data.expiresTimestamp ?? null, mode: 'authorize' });
    }
    return json({ error: link.data?.message || `account-link failed (${link.status})`, ryft: link.data }, 502);
  }

  return json({ error: `unknown action: ${action}` }, 400);
});
