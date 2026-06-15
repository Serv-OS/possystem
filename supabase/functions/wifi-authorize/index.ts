// supabase/functions/wifi-authorize/index.ts
//
// Authorize a guest onto a location's UniFi WiFi after capture. Service-role only
// (called by wifi-capture, and by wifi-admin's "test" action). Strategy is per-location
// via wifi_unifi_bindings.auth_method:
//
//   none           → capture-only; not online yet (the launch default until a venue is set up).
//   unifi_voucher  → pop a pre-generated UniFi guest VOUCHER (a WiFi access pass) from the
//                    binding's pool, mark it consumed, hand the guest's browser to the gateway's
//                    guest-login endpoint with that voucher. Zero inbound connectivity to the
//                    venue — the multi-tenant default once a venue is live.
//   unifi_local_api / unifi_legacy / onprem_relay → built when testing against real hardware.
//
// NB a UniFi "voucher" is a WiFi access pass (time-limited code), NOT a discount code.
//
// Why voucher-first: Ubiquiti has NO turnkey cloud API to authorize a guest remotely
// (Site Manager API is read-only in 2026); the authorize action lives only on each console's
// LOCAL API. Vouchers sidestep that — the controller honours the voucher locally.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const opsAdmin = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '', { auth: { autoRefreshToken: false, persistSession: false } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const opsLocationId = String(body.ops_location_id ?? '').trim();
  if (!opsLocationId) return json({ error: 'ops_location_id required' }, 400);
  const dryRun = body.dry_run === true;   // wifi-admin "test" uses this (don't consume a voucher)

  const { data: b } = await opsAdmin.from('wifi_unifi_bindings').select('*').eq('location_id', opsLocationId).maybeSingle();
  const method = b?.auth_method ?? 'none';

  const stamp = async (patch: Record<string, unknown>) => {
    try { await opsAdmin.from('wifi_unifi_bindings').update({ ...patch, updated_at: new Date().toISOString() }).eq('location_id', opsLocationId); } catch (_e) {}
  };

  if (!b || method === 'none') {
    return json({ authorized: false, auth_method: 'none', message: 'WiFi access not configured for this venue yet — captured to CRM only.' });
  }

  // ── unifi_voucher (default live method): consume a pass + hand back to the gateway ──
  if (method === 'unifi_voucher') {
    const pool: Array<{ code: string; consumed_at?: string | null }> = Array.isArray(b.voucher_pool) ? b.voucher_pool : [];
    const idx = pool.findIndex((v) => v && v.code && !v.consumed_at);
    if (idx === -1) {
      await stamp({ last_error: 'voucher pool empty' });
      return json({ authorized: false, auth_method: 'unifi_voucher', message: 'No WiFi passes left — top up the voucher pool in Back Office.' });
    }
    const voucher = pool[idx].code;
    if (!dryRun) {
      pool[idx] = { code: voucher, consumed_at: new Date().toISOString() };
      await stamp({ voucher_pool: pool, last_authorize_at: new Date().toISOString(), last_error: null });
    }
    // Hand the guest's browser to the gateway's guest-login endpoint with the voucher.
    // The controller (local to the guest) redeems the voucher and lets the client online.
    // Exact endpoint/fields are validated against the live controller during hardware testing;
    // controller_url + site_id come from the binding. Fallback: return the code for manual entry.
    let redirect: string | null = null;
    if (b.controller_url && b.site_id) {
      const u = new URL(`${String(b.controller_url).replace(/\/$/, '')}/guest/s/${b.site_id}/`);
      if (body.client_mac) u.searchParams.set('id', body.client_mac);
      if (body.ap_mac) u.searchParams.set('ap', body.ap_mac);
      if (body.ssid) u.searchParams.set('ssid', body.ssid);
      u.searchParams.set('voucher', voucher);
      redirect = u.toString();
    }
    return json({ authorized: true, auth_method: 'unifi_voucher', voucher_code: voucher, voucher_redirect_url: redirect, dry_run: dryRun });
  }

  // ── methods built during hardware testing ──
  if (method === 'unifi_local_api' || method === 'unifi_legacy' || method === 'onprem_relay') {
    await stamp({ last_error: `auth_method '${method}' not yet implemented` });
    return json({ authorized: false, auth_method: method, message: `${method} is configured but not yet wired — coming in the get-online phase.` });
  }

  return json({ authorized: false, auth_method: method, message: 'unknown auth_method' });
});
