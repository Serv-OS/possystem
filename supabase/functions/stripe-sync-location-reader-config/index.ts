// supabase/functions/stripe-sync-location-reader-config/index.ts
//
// Reads location_reader_settings → creates or updates a Stripe Terminal
// Configuration object on the merchant's connected account → assigns that
// configuration to every reader at the location.
//
// This drives the customer-facing UX on the reader:
//   • Tipping prompt (percentages, smart-tip threshold, custom tip)
//   • Splashscreen image (idle screen when no transaction)
//
// Body: { location_id }
// Returns the resulting configuration id and the count of readers updated.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import Stripe from 'https://esm.sh/stripe@14.21.0?target=denonext';

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

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', {
  apiVersion: '2024-06-20',
});

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

  // Settings + merchant Stripe account
  const { data: settings } = await platformAdmin.from('location_reader_settings')
    .select('*').eq('location_id', location_id).maybeSingle();
  if (!settings) return json({ error: 'settings row not found — does this location exist?' }, 404);

  const { data: msa } = await platformAdmin.from('merchant_stripe_accounts')
    .select('stripe_account_id').eq('location_id', location_id).maybeSingle();
  if (!msa?.stripe_account_id) return json({ error: 'Merchant Stripe account not linked' }, 400);

  // Build Configuration params from settings
  const tipping = settings.tipping_enabled ? buildTippingConfig(settings) : null;

  const configParams: Stripe.Terminal.ConfigurationCreateParams | Stripe.Terminal.ConfigurationUpdateParams = {
    name: `POSUP location ${location_id.slice(0, 8)}`,
    tipping: tipping ?? '' as unknown as Stripe.Terminal.ConfigurationCreateParams.Tipping,
    bbpos_wisepos_e: settings.idle_screen_enabled && settings.idle_screen_file_id
      ? { splashscreen: settings.idle_screen_file_id }
      : { splashscreen: '' as unknown as string },                    // empty string clears it
  };

  // Create or update
  let configId = settings.stripe_configuration_id as string | null;
  let config: Stripe.Terminal.Configuration;
  try {
    if (configId) {
      // Update existing
      config = await stripe.terminal.configurations.update(
        configId,
        configParams as Stripe.Terminal.ConfigurationUpdateParams,
        { stripeAccount: msa.stripe_account_id },
      );
    } else {
      // Create new
      config = await stripe.terminal.configurations.create(
        configParams as Stripe.Terminal.ConfigurationCreateParams,
        { stripeAccount: msa.stripe_account_id },
      );
      configId = config.id;
    }
  } catch (e) {
    return json({ error: `Stripe configuration sync failed: ${(e as Error).message}` }, 500);
  }

  // Persist the config id back to our settings table
  await platformAdmin.from('location_reader_settings')
    .update({
      stripe_configuration_id: configId,
      stripe_configuration_synced_at: new Date().toISOString(),
    })
    .eq('location_id', location_id);

  // Assign this configuration to every reader at the location
  const { data: readers } = await platformAdmin.from('payment_devices')
    .select('id, stripe_reader_id, label')
    .eq('location_id', location_id);

  let updated = 0;
  const readerErrors: Array<{ reader: string; error: string }> = [];
  for (const r of readers ?? []) {
    try {
      // The Stripe Reader has a `configuration_overrides` field that accepts a
      // configuration id. This is the documented way to assign a config to a
      // specific reader.
      await stripe.terminal.readers.update(
        r.stripe_reader_id,
        // @ts-ignore — configuration_overrides is in the API but not yet typed in stripe-node 14
        { configuration_overrides: configId },
        { stripeAccount: msa.stripe_account_id },
      );
      updated += 1;
    } catch (e) {
      readerErrors.push({ reader: r.label || r.stripe_reader_id, error: (e as Error).message });
    }
  }

  return json({
    success: true,
    configuration_id: configId,
    tipping_enabled: settings.tipping_enabled,
    tip_percentages: settings.tip_percentages,
    splashscreen_set: !!(settings.idle_screen_enabled && settings.idle_screen_file_id),
    readers_updated: updated,
    readers_total: readers?.length ?? 0,
    reader_errors: readerErrors,
  });
});

function buildTippingConfig(settings: {
  tip_percentages: number[];
  smart_tip_threshold_minor: number | null;
}): Stripe.Terminal.ConfigurationCreateParams.Tipping {
  // Stripe's Tipping config is keyed by ISO currency. We configure the same
  // percentages for the major currencies POSUP supports. Each location uses
  // exactly one currency in practice but configuring multiple is harmless.
  const baseRule = {
    percentages: (settings.tip_percentages ?? [15, 18, 20]).slice(0, 5),
    smart_tip_threshold: settings.smart_tip_threshold_minor ?? undefined,
  };
  return {
    gbp: baseRule,
    usd: baseRule,
    eur: baseRule,
  } as Stripe.Terminal.ConfigurationCreateParams.Tipping;
}
