// supabase/functions/stripe-assign-reader-to-pos/index.ts
// Reassign a network payment reader to a specific POS or kiosk device (or
// clear the assignment by passing pos_device_id=null).
//
// Body: { reader_id, pos_device_id }
//   reader_id        — payment_devices.id (UUID)
//   pos_device_id    — devices.id (UUID, Ops DB) OR null to unassign
//
// Anon RLS only permits BT updates; this edge function uses service_role to
// update network rows. Bluetooth assignment happens automatically when the POS
// pairs the reader; this function is the back-office side for network readers.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ error: 'Unauthorized' }, 401);
  const { data: { user: caller } } = await opsAdmin.auth.getUser(authHeader.replace('Bearer ', ''));
  if (!caller) return json({ error: 'Invalid token' }, 401);

  let body: { reader_id?: string; pos_device_id?: string | null };
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const { reader_id, pos_device_id } = body ?? {};
  if (!reader_id) return json({ error: 'reader_id required' }, 400);

  // Validate the reader exists and is a network reader
  const { data: rdr, error: lookupErr } = await platformAdmin.from('payment_devices')
    .select('id, connection_kind, location_id').eq('id', reader_id).maybeSingle();
  if (lookupErr || !rdr) return json({ error: 'reader not found' }, 404);
  if (rdr.connection_kind !== 'network') {
    return json({ error: 'only network readers can be reassigned via this endpoint; bluetooth readers are bound automatically when paired from the POS' }, 400);
  }

  // If a target POS is given, validate it exists in Ops DB and belongs to the
  // same location (cross-DB id check using the locations.ops_location_id column).
  if (pos_device_id) {
    const { data: opsDevice } = await opsAdmin.from('devices')
      .select('id, location_id, type, name').eq('id', pos_device_id).maybeSingle();
    if (!opsDevice) return json({ error: 'POS device not found' }, 404);
    if (!['pos', 'kiosk'].includes(opsDevice.type ?? '')) {
      return json({ error: `device type "${opsDevice.type}" cannot accept payments — must be 'pos' or 'kiosk'` }, 400);
    }
    // Ensure POS device's location matches the reader's location.
    // The reader is keyed by Platform DB location_id; the device by Ops DB location_id.
    // Map via locations.ops_location_id (or direct id match for new locations).
    const { data: platformLoc } = await platformAdmin.from('locations')
      .select('id, ops_location_id').eq('id', rdr.location_id).maybeSingle();
    const platformOpsId = platformLoc?.ops_location_id ?? platformLoc?.id;
    if (platformOpsId && opsDevice.location_id !== platformOpsId) {
      return json({ error: 'POS device is at a different location than the reader' }, 400);
    }
  }

  const { error: updErr } = await platformAdmin.from('payment_devices')
    .update({ bound_pos_device_id: pos_device_id || null })
    .eq('id', reader_id);
  if (updErr) return json({ error: `update failed: ${updErr.message}` }, 500);

  return json({ success: true, reader_id, bound_pos_device_id: pos_device_id || null });
});
