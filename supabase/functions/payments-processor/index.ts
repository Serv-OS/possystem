// supabase/functions/payments-processor
//
// Returns which payment processor a location uses ('stripe' | 'ryft') so the
// client can dispatch checkout to the right path. Defaults to 'stripe' for any
// location not explicitly switched. Auth: service-role or signed-in user.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const opsAdmin = createClient(Deno.env.get('SUPABASE_URL') ?? '', SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } });
const platformAdmin = createClient(Deno.env.get('PLATFORM_SUPABASE_URL') ?? '', Deno.env.get('PLATFORM_SUPABASE_SERVICE_ROLE_KEY') ?? '', { auth: { autoRefreshToken: false, persistSession: false } });

async function authorize(req: Request): Promise<boolean> {
  const token = (req.headers.get('Authorization') ?? '').replace('Bearer ', '').trim();
  if (!token) return false;
  if (token === SERVICE_ROLE) return true;
  try { const { data: { user } } = await opsAdmin.auth.getUser(token); return !!user; } catch { return false; }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  if (!(await authorize(req))) return json({ error: 'unauthorized' }, 401);

  let body: { location_id?: string };
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }
  if (!body.location_id) return json({ error: 'location_id required' }, 400);

  // Accept EITHER id space: POS sends the Ops location id, while online/QR/
  // catering send the PLATFORM location id (and the two genuinely diverge —
  // e.g. platform a1b2c3d4-0002… ↔ ops 7218c716…, and provision-location mints
  // a fresh platform uuid). Try ops_location_id first, fall back to id —
  // the same dual-resolution idiom as ryft-terminal-payment / ryft-tab.
  let { data: loc } = await platformAdmin.from('locations')
    .select('id, payment_processor').eq('ops_location_id', body.location_id).maybeSingle();
  if (!loc) {
    const fb = await platformAdmin.from('locations')
      .select('id, payment_processor').eq('id', body.location_id).maybeSingle();
    loc = fb.data ?? null;
  }
  // Definitive error when the location can't be found — never a silent 'stripe'
  // the client would cache. Default to 'stripe' ONLY when the row exists and
  // has no processor set (backward-compatible contract).
  if (!loc) return json({ error: 'location not found' }, 404);
  const processor = loc.payment_processor === 'ryft' ? 'ryft' : 'stripe';
  return json({ processor });
});
