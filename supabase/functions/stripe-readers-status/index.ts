// supabase/functions/stripe-readers-status/index.ts
// Fetch live reader status from Stripe for one or more readers at a location,
// then persist diagnostic fields back into payment_devices.
//
// Body: { location_id }
// Returns: { readers: [{ id, ip_address, firmware_version, status, last_seen_at, ... }] }
//
// Used by the BO Card readers page when admins click "Refresh status" or load
// the page. For network readers Stripe gives us ip_address, device_sw_version,
// status, last_seen_at, livemode, location. For Bluetooth readers most of
// these fields are null on Stripe's side (the BT connection is between the SDK
// and the reader, not Stripe → reader), but we still surface what we have.

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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ error: 'Unauthorized' }, 401);
  const { data: { user: caller } } = await opsAdmin.auth.getUser(authHeader.replace('Bearer ', ''));
  if (!caller) return json({ error: 'Invalid token' }, 401);

  let body: { location_id?: string };
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const { location_id } = body ?? {};
  if (!location_id) return json({ error: 'location_id required' }, 400);

  // Look up the connected account + readers for this location
  const [{ data: msa }, { data: readers }] = await Promise.all([
    platformAdmin.from('merchant_stripe_accounts')
      .select('stripe_account_id').eq('location_id', location_id).maybeSingle(),
    platformAdmin.from('payment_devices')
      .select('id, stripe_reader_id, connection_kind').eq('location_id', location_id),
  ]);

  if (!msa) return json({ error: 'no connected Stripe account for this location' }, 400);
  if (!readers?.length) return json({ readers: [] });

  // Network readers have real Stripe rdr_… ids — fetch each.
  // Bluetooth rows store the device serial as stripe_reader_id (no rdr_ id from
  // the SDK side), so we only call Stripe for network readers.
  const results: Array<Record<string, unknown>> = [];
  for (const r of readers) {
    if (r.connection_kind !== 'network') {
      results.push({
        id: r.id,
        stripe_reader_id: r.stripe_reader_id,
        connection_kind: r.connection_kind,
        note: 'Bluetooth readers — diagnostic fields are surfaced from the POS terminal that paired them, not from Stripe.',
      });
      continue;
    }

    try {
      const sr = await stripe.terminal.readers.retrieve(
        r.stripe_reader_id,
        { stripeAccount: msa.stripe_account_id },
      );

      const update = {
        ip_address: sr.ip_address ?? null,
        firmware_version: (sr as any).device_sw_version ?? null,
        status: sr.status ?? null,
        serial_number: sr.serial_number ?? null,
        label: sr.label ?? null,
        device_type: sr.device_type ?? null,
        last_seen_at: (sr as any).last_seen_at
          ? new Date((sr as any).last_seen_at * 1000).toISOString()
          : null,
        last_status_check_at: new Date().toISOString(),
      };

      await platformAdmin.from('payment_devices').update(update).eq('id', r.id);

      results.push({
        id: r.id,
        stripe_reader_id: r.stripe_reader_id,
        connection_kind: r.connection_kind,
        ...update,
        livemode: sr.livemode,
      });
    } catch (e) {
      const err = e as Stripe.errors.StripeError;
      results.push({
        id: r.id,
        stripe_reader_id: r.stripe_reader_id,
        connection_kind: r.connection_kind,
        error: err.message ?? String(e),
        code: err.code,
      });
    }
  }

  return json({ readers: results });
});
