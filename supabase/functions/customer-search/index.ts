// supabase/functions/customer-search
//
// GUEST SEARCH FOR THE DEVICES THAT ARE NOT A TILL.
//
// 24 Sep 2026, Peter, from the bookings iPad: "the customer search doesn't
// work, not searching". It was refused, silently. The customers table is read
// through customer_org_visible(org_id), which trusts a paired TILL
// (devices.device_uid = auth.uid()) and a Back Office user. The bookings host
// stand is a waitlist_devices row, so the rule said no and the search returned
// an empty list with no error to show.
//
//   POST { location_id, q }  →  { ok, rows: [{ id, name, phone, email, notes, allergens }] }
//
// The caller must be ONE of, for that venue: a signed-in user with access, a
// paired till (devices), or a paired host stand (waitlist_devices). The search
// is then made with the service role over the venue's organisation, scrubbed
// to the columns the screens show, eight rows at most. Read-only.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { isVenueWriter } from '../_shared/venueWriter.js';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const admin = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '', {
  auth: { autoRefreshToken: false, persistSession: false },
});

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ ok: false, error: 'POST only' }, 400);

  const token = (req.headers.get('Authorization') || '').replace('Bearer ', '').trim();
  if (!token) return json({ ok: false, error: 'Unauthorized' }, 401);
  const { data: { user } } = await admin.auth.getUser(token);
  if (!user) return json({ ok: false, error: 'Invalid token' }, 401);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { return json({ ok: false, error: 'invalid json' }, 400); }
  const locationId = String(body.location_id || '');
  const q = String(body.q || '').trim();
  if (!locationId) return json({ ok: false, error: 'location_id required' }, 400);
  if (q.length < 3) return json({ ok: true, rows: [] });

  // Who is asking, and for which venue?
  const [asUser, till, host] = await Promise.all([
    isVenueWriter(admin, user, locationId).catch(() => false),
    admin.from('devices').select('id').eq('device_uid', user.id).eq('location_id', locationId).in('status', ['active', 'online']).limit(1).maybeSingle(),
    admin.from('waitlist_devices').select('id').eq('device_uid', user.id).eq('location_id', locationId).eq('active', true).limit(1).maybeSingle(),
  ]);
  if (!asUser && !till.data && !host.data) return json({ ok: false, error: 'No access to this location' }, 403);

  const { data: loc } = await admin.from('locations').select('org_id').eq('id', locationId).maybeSingle();
  if (!loc?.org_id) return json({ ok: true, rows: [] });

  // Same shape as the store's own search, so the screens need no new code.
  const safe = q.replace(/[,%]/g, '');
  const { data, error } = await admin.from('customers')
    .select('id, name, phone, phone_raw, email, marketing_opt_in, notes, allergens')
    .eq('org_id', loc.org_id).is('deleted_at', null)
    .or(`name.ilike.%${safe}%,phone.ilike.%${safe}%,phone_raw.ilike.%${safe}%,email.ilike.%${safe}%`)
    .limit(8);
  if (error) return json({ ok: false, error: error.message }, 500);
  return json({ ok: true, rows: data || [] });
});
