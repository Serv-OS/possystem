// supabase/functions/stripe-update-reader-display/index.ts
//
// Live cart display on the network reader. Called by the POS every time the
// cart changes (debounced client-side ~600ms). Pushes current line items +
// running total to the reader screen via set_reader_display so the customer
// sees their order forming in real time — same UX as a high-street POS.
//
// Safe to call repeatedly. Reader simply renders the latest cart state.
// While a PaymentIntent is in flight (reader.action.status === 'in_progress')
// we skip the update so we don't yank the customer back to the cart view
// mid-payment.
//
// Body: {
//   pos_device_id: string,            // ops devices.id of the calling POS
//   line_items: [{ description, amount, quantity }],  // minor units
//   total_minor: number,              // sum of line item totals
//   currency: string,                 // 'gbp' | 'usd'
// }
//
// Idle case: if line_items is empty / total is 0, we clear the reader to the
// idle screen (set type 'idle' / cancel any pending display).

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

  let body: {
    pos_device_id?: string;
    line_items?: Array<{ description: string; amount: number; quantity: number }>;
    total_minor?: number;
    currency?: string;
  };
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const { pos_device_id, line_items = [], total_minor = 0, currency = 'gbp' } = body ?? {};
  if (!pos_device_id) return json({ error: 'pos_device_id required' }, 400);

  // 1. Resolve POS device → location
  const { data: posDevice } = await opsAdmin.from('devices')
    .select('id, location_id').eq('id', pos_device_id).maybeSingle();
  if (!posDevice) return json({ error: 'POS device not found' }, 404);

  const { data: platformLoc } = await platformAdmin.from('locations')
    .select('id').or(`ops_location_id.eq.${posDevice.location_id},id.eq.${posDevice.location_id}`)
    .maybeSingle();
  if (!platformLoc) return json({ error: 'Platform location not found' }, 404);

  // 2. Find the reader assigned to THIS POS device (or fallback to any
  //    reader at the location if none is explicitly bound)
  let reader: { stripe_reader_id?: string; stripe_account_id?: string } | null = null;
  const { data: bound } = await platformAdmin.from('payment_devices')
    .select('stripe_reader_id, stripe_account_id')
    .eq('location_id', platformLoc.id)
    .eq('bound_pos_device_id', pos_device_id)
    .maybeSingle();
  if (bound?.stripe_reader_id) reader = bound;
  if (!reader) {
    // Fall back to any reader at the location — useful for venues with one
    // reader serving multiple POS terminals.
    const { data: anyAtLoc } = await platformAdmin.from('payment_devices')
      .select('stripe_reader_id, stripe_account_id')
      .eq('location_id', platformLoc.id)
      .limit(1).maybeSingle();
    if (anyAtLoc?.stripe_reader_id) reader = anyAtLoc;
  }
  if (!reader?.stripe_reader_id) {
    // No reader at this location — silent success (POS just doesn't have a
    // reader to push to; not an error condition).
    return json({ ok: true, skipped: 'no_reader_at_location' });
  }

  // 3. Check the reader's current action — only skip when an actual
  //    PAYMENT is in progress, not when our own set_reader_display is
  //    still resolving. v5.5.177: previous check skipped on ANY
  //    in_progress action which meant the 2nd/3rd/etc. cart pushes
  //    were dropped because the first push's set_reader_display action
  //    was still resolving.
  try {
    const live = await stripe.terminal.readers.retrieve(
      reader.stripe_reader_id,
      { stripeAccount: reader.stripe_account_id! },
    );
    const action = (live as Stripe.Terminal.Reader)?.action;
    const isPaymentInProgress = action?.status === 'in_progress'
      && (action?.type === 'process_payment_intent'
       || action?.type === 'process_setup_intent'
       || action?.type === 'collect_payment_method');
    if (isPaymentInProgress) {
      return json({ ok: true, skipped: 'payment_in_progress' });
    }
  } catch (e) {
    console.warn('[stripe-update-reader-display] retrieve failed:', (e as Error).message);
  }

  // 4. Push the cart, or clear to idle if empty
  try {
    if (!line_items.length || total_minor <= 0) {
      // v5.5.176: clear back to idle. Two-step approach because the
      // reader's cart view doesn't visibly repaint when total drops to 0
      // (it clings to the last visible subtotal). Step 1: try cancelAction
      // to force the reader off the cart view. Step 2: set a "ready"
      // placeholder so any subsequent live push has a fresh canvas.
      try {
        await stripe.terminal.readers.cancelAction(
          reader.stripe_reader_id,
          undefined,
          { stripeAccount: reader.stripe_account_id! },
        );
      } catch (e) {
        // "no action in progress" is fine — reader is already idle-ish.
        const msg = (e as Error).message;
        if (!/no action|not found|in_progress/i.test(msg)) {
          console.warn('[clear] cancelAction unexpected:', msg);
        }
      }
      const setRes = await stripe.terminal.readers.setReaderDisplay(reader.stripe_reader_id, {
        type: 'cart',
        cart: {
          line_items: [{ description: 'Ready for next order', amount: 0, quantity: 1 }],
          total: 0,
          currency: currency.toLowerCase(),
        },
      }, { stripeAccount: reader.stripe_account_id! });
      return json({ ok: true, cleared: true, reader_id: setRes.id, action: setRes.action?.status ?? null });
    }

    await stripe.terminal.readers.setReaderDisplay(reader.stripe_reader_id, {
      type: 'cart',
      cart: {
        line_items: line_items.slice(0, 100).map(li => ({
          description: String(li.description ?? '').slice(0, 60) || 'Item',
          amount: Math.max(0, Math.round(li.amount)),
          quantity: Math.max(1, Math.min(999, Math.round(li.quantity ?? 1))),
        })),
        total: Math.max(0, Math.round(total_minor)),
        currency: currency.toLowerCase(),
      },
    }, { stripeAccount: reader.stripe_account_id! });
    return json({ ok: true, items: line_items.length, total: total_minor });
  } catch (e) {
    const msg = (e as Error).message;
    console.error('[update-reader-display] failed:', msg);
    return json({ error: msg, code: 'set_display_failed' }, 400);
  }
});
