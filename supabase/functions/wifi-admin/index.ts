// supabase/functions/wifi-admin/index.ts
//
// Back-office config for WiFi data capture. wifi_portal_settings is service-role-WRITE
// (read-only RLS for the BO client) and wifi_unifi_bindings has NO read policy (secrets),
// so the editor reads/writes through here. Auth: a staff user with access to the location
// (user_locations) or super_admin. Mirrors review-admin.
//
//   get_config   { ops_location_id } → { settings, binding_status (masked, no secrets) }
//   save_settings{ ops_location_id, settings:{...} }            → upsert wifi_portal_settings
//   save_binding { ops_location_id, binding:{...} }             → upsert wifi_unifi_bindings
//                  (voucher_pool from pasted codes; secrets never returned)
//   test         { ops_location_id }                            → dry-run wifi-authorize
//   stats        { ops_location_id }                            → capture counts (wifi_captures)
//   segments     { ops_location_id }                            → CRM segment counts
//   export       { ops_location_id, segment }                   → contact rows for CSV

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const SUPA_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const opsAdmin = createClient(SUPA_URL, SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } });
const platformAdmin = createClient(Deno.env.get('PLATFORM_SUPABASE_URL') ?? '', Deno.env.get('PLATFORM_SUPABASE_SERVICE_ROLE_KEY') ?? '', { auth: { autoRefreshToken: false, persistSession: false } });

const SETTINGS_FIELDS = ['enabled', 'headline', 'subtext', 'bg_image_url', 'logo_url', 'accent_color', 'button_style', 'fields', 'age_gate', 'marketing_copy', 'success_copy', 'redirect_url', 'terms_url', 'privacy_url', 'privacy_version'];
// Non-secret binding fields the BO may set directly. Secrets (api_key/admin creds) are
// handled in the seamless-auth (local_api) phase with proper encryption; not exposed here.
const BINDING_FIELDS = ['auth_method', 'controller_url', 'site_id', 'ssid', 'auth_minutes', 'data_limit_mb', 'down_kbps', 'up_kbps'];

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
async function orgFor(opsLocationId: string): Promise<string | null> {
  const { data } = await opsAdmin.from('locations').select('org_id').eq('id', opsLocationId).maybeSingle();
  return data?.org_id ?? null;
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
    const [{ data: settings }, { data: b }] = await Promise.all([
      opsAdmin.from('wifi_portal_settings').select('*').eq('location_id', ops).maybeSingle(),
      opsAdmin.from('wifi_unifi_bindings').select('*').eq('location_id', ops).maybeSingle(),
    ]);
    const pool: any[] = Array.isArray(b?.voucher_pool) ? b!.voucher_pool : [];
    const binding_status = b ? {
      auth_method: b.auth_method, controller_url: b.controller_url, site_id: b.site_id, ssid: b.ssid,
      auth_minutes: b.auth_minutes, data_limit_mb: b.data_limit_mb,
      voucher_total: pool.length, voucher_remaining: pool.filter((v) => v && !v.consumed_at).length,
      has_api_key: !!b.api_key_enc, last_authorize_at: b.last_authorize_at, last_error: b.last_error,
    } : { auth_method: 'none', voucher_total: 0, voucher_remaining: 0 };
    return json({ settings: settings ?? null, binding_status });
  }

  if (action === 'save_settings') {
    const incoming = body.settings || {};
    const row: Record<string, unknown> = { location_id: ops, company_id: await companyFor(ops), updated_at: new Date().toISOString() };
    for (const k of SETTINGS_FIELDS) if (k in incoming) row[k] = incoming[k];
    const { error } = await opsAdmin.from('wifi_portal_settings').upsert(row, { onConflict: 'location_id' });
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  if (action === 'save_binding') {
    const incoming = body.binding || {};
    const row: Record<string, unknown> = { location_id: ops, company_id: await companyFor(ops), updated_at: new Date().toISOString() };
    for (const k of BINDING_FIELDS) if (k in incoming) row[k] = incoming[k];
    // Voucher pool: accept pasted codes (newline/comma/space separated). Merge with existing
    // unconsumed codes; never wipe already-consumed history. Codes aren't secret (single-use
    // passes) and the table is service-role-only, so stored as-is.
    if (typeof incoming.voucher_codes === 'string') {
      const codes = incoming.voucher_codes.split(/[\s,]+/).map((c: string) => c.trim()).filter(Boolean);
      const { data: existing } = await opsAdmin.from('wifi_unifi_bindings').select('voucher_pool').eq('location_id', ops).maybeSingle();
      const prev: any[] = Array.isArray(existing?.voucher_pool) ? existing!.voucher_pool : [];
      const have = new Set(prev.map((v) => v.code));
      const merged = [...prev, ...codes.filter((c: string) => !have.has(c)).map((c: string) => ({ code: c, consumed_at: null }))];
      row.voucher_pool = merged;
    }
    const { error } = await opsAdmin.from('wifi_unifi_bindings').upsert(row, { onConflict: 'location_id' });
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  if (action === 'test') {
    const r = await fetch(`${SUPA_URL}/functions/v1/wifi-authorize`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SERVICE_ROLE}` },
      body: JSON.stringify({ ops_location_id: ops, client_mac: 'aa:bb:cc:00:00:01', dry_run: true }),
    });
    const j = await r.json().catch(() => ({}));
    return json({ ok: true, result: j });
  }

  if (action === 'stats') {
    const since = new Date(Date.now() - 7 * 86400000).toISOString();
    const head = (q: any) => q.then((r: any) => r.count ?? 0);
    const [total, opted, returns, last7] = await Promise.all([
      head(opsAdmin.from('wifi_captures').select('id', { count: 'exact', head: true }).eq('location_id', ops)),
      head(opsAdmin.from('wifi_captures').select('id', { count: 'exact', head: true }).eq('location_id', ops).eq('marketing_opt_in', true)),
      head(opsAdmin.from('wifi_captures').select('id', { count: 'exact', head: true }).eq('location_id', ops).eq('is_return', true)),
      head(opsAdmin.from('wifi_captures').select('id', { count: 'exact', head: true }).eq('location_id', ops).gte('created_at', since)),
    ]);
    return json({ total, opted_in: opted, returns, last_7d: last7 });
  }

  if (action === 'segments' || action === 'export') {
    const orgId = await orgFor(ops);
    // Customers seen at this location, with their CRM fields. Capped for safety.
    const { data: cls } = await opsAdmin.from('customer_locations')
      .select('customer_id, visit_count, last_visit_at').eq('location_id', ops).limit(10000);
    const ids = (cls ?? []).map((r) => r.customer_id);
    const visById = new Map((cls ?? []).map((r) => [r.customer_id, r]));
    let customers: any[] = [];
    for (let i = 0; i < ids.length; i += 500) {
      const { data } = await opsAdmin.from('customers')
        .select('id, first_name, last_name, name, email, phone, birthday, is_local, marketing_opt_in')
        .in('id', ids.slice(i, i + 500)).is('deleted_at', null);
      if (data) customers = customers.concat(data);
    }
    const now = new Date(); const in7 = new Date(now.getTime() + 7 * 86400000);
    const lapsedBefore = new Date(now.getTime() - 60 * 86400000);
    const md = (d: Date) => (d.getMonth() + 1) * 100 + d.getDate();
    const bdayThisWeek = (b: string) => { if (!b) return false; const d = new Date(b); const a = md(now), z = md(in7), x = (d.getMonth() + 1) * 100 + d.getDate(); return a <= z ? (x >= a && x <= z) : (x >= a || x <= z); };
    const tag = (c: any) => {
      const v = visById.get(c.id) || {}; const vc = v.visit_count ?? 0; const last = v.last_visit_at ? new Date(v.last_visit_at) : null;
      return {
        local: c.is_local === true, optedIn: c.marketing_opt_in === true, birthday: bdayThisWeek(c.birthday),
        isNew: vc <= 1, returning: vc >= 2, lapsed: last ? last < lapsedBefore : false,
      };
    };
    if (action === 'segments') {
      const s = { total: customers.length, locals: 0, birthdays: 0, new: 0, returning: 0, lapsed: 0, opted_in: 0 };
      for (const c of customers) { const t = tag(c); if (t.local) s.locals++; if (t.birthday) s.birthdays++; if (t.isNew) s.new++; if (t.returning) s.returning++; if (t.lapsed) s.lapsed++; if (t.optedIn) s.opted_in++; }
      return json(s);
    }
    // export: rows for a named segment
    const seg = String(body.segment ?? 'all');
    const rows = customers.filter((c) => {
      const t = tag(c);
      switch (seg) { case 'locals': return t.local; case 'birthdays': return t.birthday; case 'new': return t.isNew; case 'returning': return t.returning; case 'lapsed': return t.lapsed; case 'opted_in': return t.optedIn; default: return true; }
    }).map((c) => ({ first_name: c.first_name || '', last_name: c.last_name || '', name: c.name || '', email: c.email || '', phone: c.phone || '', birthday: c.birthday || '', is_local: c.is_local ? 'yes' : '', marketing_opt_in: c.marketing_opt_in ? 'yes' : '' }));
    return json({ rows, count: rows.length });
  }

  return json({ error: `unknown action: ${action}` }, 400);
});
