// supabase/functions/stripe-register-network-reader/index.ts
// Admin-only: register a network/WiFi Stripe Terminal reader (S700, WisePOS E)
// to a location's connected account using Stripe's registration code flow.
//
// Body: { location_id, registration_code, label? }
// 1. Verify the location has a charges-enabled connected account.
// 2. Call POST /v1/terminal/readers on the connected account with the code.
// 3. Insert a row into payment_devices.

import Stripe from 'https://esm.sh/stripe@14.21.0?target=denonext';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', { apiVersion: '2024-06-20' });

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

/**
 * Ensure the calling Ops-DB-Auth user exists as a row in Platform DB
 * platform_users. Idempotent (upsert by id). Best-effort: callers should not
 * fail if this throws — the audit FKs that referenced platform_users have
 * been dropped on purpose.
 *
 * Without this helper, a brand-new admin (e.g. Duncan Scott from DX Test
 * Location) who has never been touched on Platform DB cannot perform actions
 * like registering a card reader, because the audit field would point at a
 * non-existent platform_users row. This is a known consequence of the
 * Ops/Platform DB split — we plan to switch to JWT sharing or shared auth
 * eventually, but for now we plug the gap by lazy-creating Platform users on
 * first write.
 */
async function ensurePlatformUser(caller: { id: string; email?: string | null; user_metadata?: Record<string, unknown> }) {
  if (!caller?.id) return;
  const fullName =
    (caller.user_metadata?.full_name as string | undefined) ??
    (caller.user_metadata?.name as string | undefined) ??
    null;
  await platformAdmin.from('platform_users').upsert(
    { id: caller.id, email: caller.email ?? `${caller.id}@unknown`, full_name: fullName },
    { onConflict: 'id', ignoreDuplicates: false },
  );
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ error: 'Unauthorized' }, 401);
  const { data: { user: caller } } = await opsAdmin.auth.getUser(authHeader.replace('Bearer ', ''));
  if (!caller) return json({ error: 'Invalid token' }, 401);

  // Ensure the caller exists in platform_users before any Platform DB write that
  // references their UUID. This is best-effort — we don't fail the request if
  // the upsert fails, since the audit FKs have been dropped.
  await ensurePlatformUser(caller).catch((e) =>
    console.warn('platform_users upsert failed (non-fatal):', e?.message ?? e),
  );

  let body: { location_id?: string; registration_code?: string; label?: string; bound_pos_device_id?: string };
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const { location_id, registration_code, label, bound_pos_device_id } = body ?? {};
  if (!location_id || !registration_code) return json({ error: 'location_id and registration_code required' }, 400);

  // 1. Find the connected account for this location
  const { data: msa, error: msaErr } = await platformAdmin.from('merchant_stripe_accounts')
    .select('stripe_account_id, charges_enabled').eq('location_id', location_id).single();
  if (msaErr || !msa) return json({ error: 'location has no connected Stripe account' }, 400);
  if (!msa.charges_enabled) return json({ error: 'connected account is not charges-enabled yet' }, 400);

  // 2. Find or create the Stripe Terminal Location for this Platform location
  // (Network readers must be associated with a Stripe Terminal Location object.)
  let stripeTerminalLocationId: string | null = null;
  try {
    const { data: locRow } = await platformAdmin.from('locations')
      .select('name, stripe_terminal_location_id').eq('id', location_id).single();
    stripeTerminalLocationId = (locRow as any)?.stripe_terminal_location_id ?? null;
    if (!stripeTerminalLocationId) {
      // Create one — default address (can be edited later in Stripe dashboard)
      const created = await stripe.terminal.locations.create({
        display_name: locRow?.name ?? 'POSUP Location',
        address: { line1: 'Address pending', city: 'London', country: 'GB', postal_code: 'W1A 1AA' },
      }, { stripeAccount: msa.stripe_account_id });
      stripeTerminalLocationId = created.id;
      // Persist on locations for future reuse — best effort
      await platformAdmin.from('locations')
        .update({ stripe_terminal_location_id: stripeTerminalLocationId })
        .eq('id', location_id);
    }
  } catch (e) {
    return json({ error: `terminal location setup failed: ${(e as Error).message}` }, 400);
  }

  // 3. Register the reader on the connected account
  let reader: Stripe.Terminal.Reader;
  try {
    reader = await stripe.terminal.readers.create({
      registration_code,
      label: label ?? `POSUP reader · ${new Date().toISOString().slice(0, 10)}`,
      location: stripeTerminalLocationId,
    }, { stripeAccount: msa.stripe_account_id });
  } catch (e) {
    const err = e as Stripe.errors.StripeError;
    return json({ error: err.message, code: err.code }, 400);
  }

  // 4. Insert into payment_devices
  const { data: inserted, error: insErr } = await platformAdmin.from('payment_devices').insert({
    location_id,
    stripe_reader_id: reader.id,
    stripe_account_id: msa.stripe_account_id,
    device_type: reader.device_type ?? 'unknown',
    connection_kind: 'network',
    serial_number: reader.serial_number ?? null,
    label: reader.label ?? label ?? null,
    registration_code,
    status: reader.status ?? 'unknown',
    last_seen_at: new Date().toISOString(),
    registered_by_user_id: caller.id,
    bound_pos_device_id: bound_pos_device_id || null,
  }).select().single();
  if (insErr) {
    // Best effort: try to roll back the Stripe registration
    try { await stripe.terminal.readers.del(reader.id, { stripeAccount: msa.stripe_account_id }); } catch {}
    return json({ error: `db insert failed: ${insErr.message}` }, 500);
  }

  return json({ success: true, reader: inserted });
});
