// supabase/functions/stripe-unregister-reader/index.ts
// Unregister a payment device (network or bluetooth).
//
// Body: { reader_id }       (the payment_devices.id, NOT the Stripe rdr_)
//
// For network readers: also deletes the reader on Stripe's side so we don't
// leave zombie registrations on the connected account.
// For bluetooth readers: just removes the DB row (the actual Bluetooth pairing
// lives in the POS terminal's localStorage and SDK state, not on Stripe).
//
// Why an edge function: anon RLS only permits BT deletes from BO. Network
// deletes need service_role and the Stripe call needs sk_test on the platform
// account.

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

  let body: { reader_id?: string };
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const { reader_id } = body ?? {};
  if (!reader_id) return json({ error: 'reader_id required' }, 400);

  const { data: rdr, error: lookupErr } = await platformAdmin.from('payment_devices')
    .select('id, stripe_reader_id, stripe_account_id, connection_kind, label, location_id')
    .eq('id', reader_id).maybeSingle();

  if (lookupErr || !rdr) return json({ error: 'reader not found' }, 404);

  let stripeDeleted = false;
  let idleScreenCleared = false;
  if (rdr.connection_kind === 'network'
      && rdr.stripe_reader_id?.startsWith('rdr_')
      && rdr.stripe_account_id
      && rdr.stripe_account_id !== 'unknown') {

    // v5.5.871 — LEAVE THE PHYSICAL READER CLEAN, not wedged on the venue's idle
    // splash (the "ServOS background"). Removal used to just delete the reader,
    // orphaning the device on its last-cached splashscreen with no handle left to
    // reset it — and a re-registered reader re-inherited the same splash because
    // it is pinned on the location-shared Terminal Configuration. Before deleting,
    // best-effort:
    //   (1) cancel any live action so the device isn't frozen mid-transaction;
    //   (2) if this is the LAST network reader at its terminal-location, strip the
    //       idle splashscreen off the shared Configuration so the device reverts to
    //       the factory idle screen. Guarded to the last reader because the config
    //       is shared — clearing it with siblings present would blank their idle
    //       screen too. Everything here is wrapped: cleanup must NEVER block removal.
    try {
      await stripe.terminal.readers.cancelAction(rdr.stripe_reader_id, undefined, {
        stripeAccount: rdr.stripe_account_id,
      });
    } catch { /* no live action to cancel — fine */ }

    try {
      let lastAtLocation = true;
      if (rdr.location_id) {
        const { data: siblings } = await platformAdmin.from('payment_devices')
          .select('id')
          .eq('location_id', rdr.location_id)
          .eq('connection_kind', 'network')
          .neq('id', reader_id);
        lastAtLocation = !(siblings && siblings.length);
      }
      if (lastAtLocation && rdr.location_id) {
        const { data: lrs } = await platformAdmin.from('location_reader_settings')
          .select('stripe_configuration_id').eq('location_id', rdr.location_id).maybeSingle();
        if (lrs?.stripe_configuration_id) {
          await stripe.terminal.configurations.update(
            lrs.stripe_configuration_id,
            // Empty string clears the splash — same lever stripe-sync-location-reader-config
            // uses when idle_screen_enabled is off. Tipping/other config untouched.
            { bbpos_wisepos_e: { splashscreen: '' }, stripe_s700: { splashscreen: '' } } as any,
            { stripeAccount: rdr.stripe_account_id },
          );
          idleScreenCleared = true;
        }
      }
    } catch (e) {
      console.warn('[unregister] idle-splash clear failed (continuing to delete):', (e as Error).message);
    }

    try {
      await stripe.terminal.readers.del(rdr.stripe_reader_id, {
        stripeAccount: rdr.stripe_account_id,
      });
      stripeDeleted = true;
    } catch (e) {
      const err = e as Stripe.errors.StripeError;
      if (err.code === 'resource_missing') {
        stripeDeleted = true;
      } else {
        return json({
          error: `Stripe deletion failed: ${err.message ?? String(e)}`,
          code: err.code,
          hint: 'The reader still exists on Stripe. Try again, or delete it manually from the Stripe dashboard.',
        }, 400);
      }
    }
  }

  const { error: delErr } = await platformAdmin.from('payment_devices').delete().eq('id', reader_id);
  if (delErr) {
    return json({
      error: `DB delete failed: ${delErr.message}`,
      stripe_deleted: stripeDeleted,
      hint: stripeDeleted
        ? 'Reader was removed from Stripe but the local row could not be cleared. Contact platform admin.'
        : 'Reader was not removed from Stripe. Try again.',
    }, 500);
  }

  return json({
    success: true,
    deleted_id: reader_id,
    connection_kind: rdr.connection_kind,
    stripe_deleted: stripeDeleted,
    idle_screen_cleared: idleScreenCleared,
  });
});
