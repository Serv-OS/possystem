// supabase/functions/review-admin/index.ts
//
// Back-office config for Review Manager. The review_settings + review_platform_links
// tables are service-role-WRITE (read-only RLS for clients), so the Settings
// screen reads/writes through here. Auth: a staff user with access to the
// location (user_locations) or super_admin.
//   get_config       { ops_location_id } → { settings, platforms }
//   save_settings    { ops_location_id, settings:{...} }
//   upsert_platform  { ops_location_id, platform, enabled?, url?, external_place_id? }

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { PLATFORM_CAPS, PLATFORM_NOTES } from '../_shared/review-platforms.ts';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const opsAdmin = createClient(Deno.env.get('SUPABASE_URL') ?? '', SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } });
const platformAdmin = createClient(Deno.env.get('PLATFORM_SUPABASE_URL') ?? '', Deno.env.get('PLATFORM_SUPABASE_SERVICE_ROLE_KEY') ?? '', { auth: { autoRefreshToken: false, persistSession: false } });

// Fields the Settings screen may write to review_settings (whitelist).
const SETTINGS_FIELDS = ['enabled', 'threshold', 'page_title', 'intro_copy', 'thanks_public_copy', 'thanks_private_copy', 'hero_image_url', 'card_button_style', 'ai_auto_draft', 'ai_auto_send_hours', 'brand_voice', 'custom_copy', 'ask_enabled', 'ask_channel', 'ask_delay_minutes', 'ask_delay_collection_minutes', 'ask_window_start', 'ask_window_end', 'ask_frequency_days', 'ask_message'];

async function authed(req: Request, opsLocationId: string): Promise<boolean> {
  const token = (req.headers.get('Authorization') ?? '').replace('Bearer ', '').trim();
  if (!token) return false;
  if (token === SERVICE_ROLE) return true;
  const { data: { user } } = await opsAdmin.auth.getUser(token);
  if (!user) return false;
  const { data: ul } = await opsAdmin.from('user_locations').select('location_id').eq('user_id', user.id).eq('location_id', opsLocationId).maybeSingle();
  if (ul) return true;
  const { data: prof } = await opsAdmin.from('user_profiles').select('role').eq('id', user.id).maybeSingle();
  return prof?.role === 'super_admin';
}

async function companyFor(opsLocationId: string): Promise<string | null> {
  const { data } = await platformAdmin.from('locations').select('company_id').or(`ops_location_id.eq.${opsLocationId},id.eq.${opsLocationId}`).maybeSingle();
  return (data?.company_id ?? null) as string | null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const action = String(body?.action ?? '').trim();
  const ops = String(body?.ops_location_id ?? '').trim();
  if (!action || !ops) return json({ error: 'action and ops_location_id required' }, 400);
  if (!(await authed(req, ops))) return json({ error: 'no access to this location' }, 403);

  if (action === 'get_config') {
    const [{ data: settings }, { data: platforms }] = await Promise.all([
      opsAdmin.from('review_settings').select('*').eq('location_id', ops).maybeSingle(),
      opsAdmin.from('review_platform_links').select('*').eq('location_id', ops),
    ]);
    return json({ settings: settings ?? null, platforms: platforms ?? [], caps: PLATFORM_CAPS, notes: PLATFORM_NOTES });
  }

  if (action === 'save_settings') {
    const incoming = body.settings || {};
    const row: Record<string, unknown> = { location_id: ops, company_id: await companyFor(ops), updated_at: new Date().toISOString() };
    for (const k of SETTINGS_FIELDS) if (k in incoming) row[k] = incoming[k];
    const { error } = await opsAdmin.from('review_settings').upsert(row, { onConflict: 'location_id' });
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  if (action === 'upsert_platform') {
    const platform = String(body.platform ?? '').trim();
    if (!(platform in PLATFORM_CAPS)) return json({ error: 'unknown platform' }, 400);
    const row: Record<string, unknown> = { location_id: ops, company_id: await companyFor(ops), platform, updated_at: new Date().toISOString() };
    if ('enabled' in body) row.enabled = !!body.enabled;
    if ('url' in body) row.url = body.url || null;
    if ('external_place_id' in body) row.external_place_id = body.external_place_id || null;
    const { error } = await opsAdmin.from('review_platform_links').upsert(row, { onConflict: 'location_id,platform' });
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  return json({ error: `unknown action: ${action}` }, 400);
});
