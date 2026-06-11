// supabase/functions/payments-onboard/index.ts
//
// MERCHANT self-serve payments onboarding from the back office (Location
// Settings). Location-scoped: the caller must be a signed-in Ops user who has
// access to the location (user_locations) — NOT super_admin. Ryft only; Stripe
// stays admin-linked.
//
//   ryft_start   { ops_location_id, redirect_url, email? }
//     → ensures a Ryft sub-account for the location, mints a Hosted onboarding
//       link, and returns it. Creates the sub-account on first call.
//   ryft_status  { ops_location_id }
//     → refreshes + returns the account's verification/charges status.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { createSubAccount, getAccount, createAccountLink, ryftConfigured } from '../_shared/ryft.ts';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const opsAdmin = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '', { auth: { autoRefreshToken: false, persistSession: false } });
const platformAdmin = createClient(Deno.env.get('PLATFORM_SUPABASE_URL') ?? '', Deno.env.get('PLATFORM_SUPABASE_SERVICE_ROLE_KEY') ?? '', { auth: { autoRefreshToken: false, persistSession: false } });

function deriveStatus(account: any) {
  const v = account?.verification ?? {};
  const caps = account?.capabilities ?? {};
  const anyEnabled = ['visaPayments', 'mastercardPayments', 'amexPayments', 'inPersonPayments'].some((k) => caps?.[k]?.status === 'Enabled');
  const charges_enabled = anyEnabled || v?.status === 'Verified';
  const details_submitted = !!v?.status && v.status !== 'Required';
  const country = account?.business?.registeredAddress?.country ?? account?.individual?.address?.country ?? null;
  return { charges_enabled, details_submitted, verification_status: v?.status ?? null, country, verification: v };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  // ── Auth: signed-in Ops user WITH access to this location ───────────────
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ error: 'Unauthorized' }, 401);
  const { data: { user: caller } } = await opsAdmin.auth.getUser(authHeader.replace('Bearer ', ''));
  if (!caller) return json({ error: 'Invalid token' }, 401);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const action = body?.action as string;
  const opsLocationId = body?.ops_location_id as string;
  if (!action) return json({ error: 'action required' }, 400);
  if (!opsLocationId) return json({ error: 'ops_location_id required' }, 400);

  // Location access: a user_locations row, or super_admin.
  const [{ data: ul }, { data: prof }] = await Promise.all([
    opsAdmin.from('user_locations').select('location_id').eq('user_id', caller.id).eq('location_id', opsLocationId).maybeSingle(),
    opsAdmin.from('user_profiles').select('role').eq('id', caller.id).maybeSingle(),
  ]);
  if (!ul && prof?.role !== 'super_admin') return json({ error: 'No access to this location' }, 403);

  // Ops location → Platform location.
  const { data: loc } = await platformAdmin.from('locations')
    .select('id, company_id, name, payment_processor').eq('ops_location_id', opsLocationId).maybeSingle();
  if (!loc) return json({ error: 'location not found in platform DB' }, 404);
  if (loc.payment_processor !== 'ryft') return json({ error: 'This location is not set to Ryft. Card payments are arranged by your account manager.' }, 400);
  if (!ryftConfigured()) return json({ error: 'Ryft not configured' }, 500);

  const { data: existing } = await platformAdmin.from('merchant_ryft_accounts')
    .select('ryft_account_id, charges_enabled').eq('location_id', loc.id).maybeSingle();

  // ── ryft_status ─────────────────────────────────────────────────────────
  if (action === 'ryft_status') {
    if (!existing?.ryft_account_id) return json({ success: true, linked: false });
    const got = await getAccount(existing.ryft_account_id);
    if (!got.ok) return json({ success: true, linked: true, charges_enabled: existing.charges_enabled });
    const d = deriveStatus(got.data);
    await platformAdmin.from('merchant_ryft_accounts').update({ charges_enabled: d.charges_enabled, details_submitted: d.details_submitted, requirements: d.verification ?? null, country: d.country }).eq('location_id', loc.id);
    return json({ success: true, linked: true, charges_enabled: d.charges_enabled, verification_status: d.verification_status });
  }

  // ── ryft_start: ensure sub-account, mint hosted onboarding link ─────────
  if (action === 'ryft_start') {
    if (!body.redirect_url) return json({ error: 'redirect_url required' }, 400);
    let accountId = existing?.ryft_account_id as string | undefined;

    if (!accountId) {
      const email = body.email || caller.email;
      if (!email) return json({ error: 'email required to create the account' }, 400);
      const created = await createSubAccount({
        onboardingFlow: 'Hosted', email,
        metadata: { location_id: loc.id, location_name: String(loc.name ?? '').slice(0, 60), self_serve: 'true' },
      });
      if (!created.ok || !created.data?.id) return json({ error: created.data?.message || `Ryft account create failed (${created.status})`, ryft: created.data }, 502);
      accountId = created.data.id;
      const d = deriveStatus(created.data);
      const { error: upErr } = await platformAdmin.from('merchant_ryft_accounts').upsert({
        location_id: loc.id, company_id: loc.company_id, ryft_account_id: accountId, link_method: 'hosted',
        charges_enabled: d.charges_enabled, details_submitted: d.details_submitted, country: d.country,
        requirements: d.verification ?? null, linked_by_user_id: caller.id,
      }, { onConflict: 'location_id' });
      if (upErr) return json({ error: `merchant_ryft_accounts upsert failed: ${upErr.message}` }, 500);
    }

    const link = await createAccountLink({ accountId: accountId!, redirectUrl: body.redirect_url });
    if (!link.ok || !link.data?.url) return json({ error: link.data?.message || `account-link failed (${link.status})`, ryft: link.data }, 502);
    return json({ success: true, account_id: accountId, onboarding_url: link.data.url, expires_at: link.data.expiresTimestamp ?? null });
  }

  return json({ error: `unknown action: ${action}` }, 400);
});
