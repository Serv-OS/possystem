// supabase/functions/stripe-upload-reader-splashscreen/index.ts
//
// Receives a base64-encoded image from the back office, uploads it to the
// Stripe Files API with purpose 'terminal_reader_splashscreen', and stores
// the resulting file_xxx ID on location_reader_settings. The caller should
// then call stripe-sync-location-reader-config to push the configuration
// (with the new splashscreen) to all readers at this location.
//
// Body: { location_id, image_base64, mime_type, action }
//   action: 'upload' (default) — upload image and enable
//           'remove' — clear the image and disable

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import Stripe from 'https://esm.sh/stripe@14.21.0?target=denonext';

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

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', {
  apiVersion: '2024-06-20',
});

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  // Auth
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ error: 'Unauthorized' }, 401);
  const {
    data: { user: caller },
  } = await opsAdmin.auth.getUser(authHeader.replace('Bearer ', ''));
  if (!caller) return json({ error: 'Invalid token' }, 401);

  let body: {
    location_id?: string;
    image_base64?: string;
    mime_type?: string;
    action?: string;
  };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid json' }, 400);
  }
  const { location_id, action = 'upload' } = body ?? {};
  if (!location_id) return json({ error: 'location_id required' }, 400);

  // Merchant Stripe account
  const { data: msa } = await platformAdmin
    .from('merchant_stripe_accounts')
    .select('stripe_account_id')
    .eq('location_id', location_id)
    .maybeSingle();
  if (!msa?.stripe_account_id)
    return json({ error: 'Merchant Stripe account not linked' }, 400);

  // ── REMOVE action ──────────────────────────────────────────────────────
  if (action === 'remove') {
    await platformAdmin
      .from('location_reader_settings')
      .update({
        idle_screen_enabled: false,
        idle_screen_file_id: null,
        idle_screen_mime: null,
        idle_screen_uploaded_at: null,
        idle_screen_uploaded_by: null,
      })
      .eq('location_id', location_id);

    return json({ success: true, action: 'removed' });
  }

  // ── UPLOAD action ──────────────────────────────────────────────────────
  const { image_base64, mime_type } = body ?? {};
  if (!image_base64) return json({ error: 'image_base64 required' }, 400);

  const allowedMimes = ['image/png', 'image/jpeg', 'image/jpg'];
  const mimeNorm = (mime_type || 'image/png').toLowerCase();
  if (!allowedMimes.includes(mimeNorm))
    return json({ error: `Unsupported image type: ${mimeNorm}. Use PNG or JPEG.` }, 400);

  // Decode base64 to binary
  const binaryStr = atob(image_base64);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);

  // Size guard — Stripe limits file size (max ~512 KB for splashscreen)
  const MAX_SIZE = 512 * 1024;
  if (bytes.length > MAX_SIZE)
    return json(
      { error: `Image too large (${(bytes.length / 1024).toFixed(0)} KB). Max 512 KB.` },
      400,
    );

  // Upload to Stripe Files API on the connected account
  let fileId: string;
  try {
    const blob = new Blob([bytes], { type: mimeNorm });
    const formData = new FormData();
    formData.append('purpose', 'terminal_reader_splashscreen');
    const ext = mimeNorm === 'image/png' ? 'png' : 'jpg';
    formData.append('file', blob, `splashscreen.${ext}`);

    // Use Stripe API directly since the SDK's files.create doesn't easily
    // accept FormData in Deno. Call the REST endpoint.
    const stripeRes = await fetch('https://files.stripe.com/v1/files', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${Deno.env.get('STRIPE_SECRET_KEY')}`,
        'Stripe-Account': msa.stripe_account_id,
      },
      body: formData,
    });
    const stripeBody = await stripeRes.json();
    if (!stripeRes.ok || stripeBody.error) {
      const msg = stripeBody.error?.message || `HTTP ${stripeRes.status}`;
      return json({ error: `Stripe Files upload failed: ${msg}` }, 500);
    }
    fileId = stripeBody.id; // e.g. 'file_xxx'
  } catch (e) {
    return json({ error: `Stripe Files upload error: ${(e as Error).message}` }, 500);
  }

  // Update location_reader_settings
  await platformAdmin
    .from('location_reader_settings')
    .update({
      idle_screen_enabled: true,
      idle_screen_file_id: fileId,
      idle_screen_mime: mimeNorm,
      idle_screen_uploaded_at: new Date().toISOString(),
      idle_screen_uploaded_by: caller.id,
    })
    .eq('location_id', location_id);

  return json({
    success: true,
    action: 'uploaded',
    file_id: fileId,
    mime: mimeNorm,
    size_kb: Math.round(bytes.length / 1024),
  });
});
