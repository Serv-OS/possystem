// supabase/functions/wifi-authorize/index.ts
//
// Authorize a guest onto a location's UniFi WiFi after capture. Service-role only
// (called by wifi-capture, and by wifi-admin's "test" action). Strategy is per-location
// via wifi_unifi_bindings.auth_method:
//
//   none           → capture-only; not online yet (the launch default until a venue is set up).
//   unifi_local_api → Network Integration API + X-API-KEY: cloud edge fn calls the venue's
//                    cloud-adopted console directly and authorizes the client by MAC. No on-site
//                    software, no port-forward — Ubiquiti's Remote Access/Site Manager makes the
//                    console reachable (valid cert). The seamless, scalable default once supported.
//   unifi_legacy   → classic API + a local-admin account (login → cmd/stamgr authorize-guest),
//                    same call our old on-site agent made but now FROM THE CLOUD. Most universal.
//   unifi_voucher  → pop a pre-generated UniFi guest VOUCHER (a WiFi access pass) from the pool and
//                    hand the browser to the gateway. Fallback for venues that won't expose the API.
//   onprem_relay   → reserved (kept for completeness; not the recommended path).
//
// NB a UniFi "voucher" is a WiFi access pass (time-limited code), NOT a discount code.
//
// KEY FACT (corrected): authorize is a server-side credentialed call to the PER-CONSOLE Network
// Integration API (`AUTHORIZE_GUEST_ACCESS`) or classic API (`cmd/stamgr authorize-guest`). The
// Site Manager CLOUD API (api.ui.com) is read-only and CANNOT authorize — but a cloud-adopted
// console is reachable from the cloud at a valid-cert hostname, so the edge fn calls it directly.
// That is how Stampede et al do it cloud-only. controller_url = the console's cloud-reachable URL.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { decryptSecret } from '../_shared/wifi-crypto.ts';
import { authorizeLegacy, authorizeIntegration } from '../_shared/unifi.ts';

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

  // ── unifi_local_api / unifi_legacy: authorize the client by MAC, FROM THE CLOUD, against the
  //    venue's cloud-adopted console. No on-site agent, no port-forward. ──
  if (method === 'unifi_local_api' || method === 'unifi_legacy') {
    const mac = String(body.client_mac ?? '').trim();
    // probe mode (wifi-admin "test"): verify we can reach + auth the console without a real MAC
    if (!mac && !dryRun) {
      return json({ authorized: false, auth_method: method, message: 'No device MAC in the captive-portal redirect (id param) — cannot authorize.' });
    }
    const limits = {
      minutes: b.auth_minutes ?? 1440,
      dataMb: b.data_limit_mb ?? undefined,
      downKbps: b.down_kbps ?? undefined,
      upKbps: b.up_kbps ?? undefined,
    };

    let res;
    if (method === 'unifi_local_api') {
      const apiKey = await decryptSecret(b.api_key_enc);
      res = await authorizeIntegration({ base: b.controller_url, apiKey, siteId: b.site_id || undefined, mac, probeOnly: dryRun, ...limits });
    } else {
      const user = await decryptSecret(b.admin_user_enc);
      const pass = await decryptSecret(b.admin_pass_enc);
      res = await authorizeLegacy({ base: b.controller_url, user, pass, site: b.site_id || 'default', mac, probeOnly: dryRun, ...limits });
    }

    if (res.ok) {
      if (!dryRun) await stamp({ last_authorize_at: new Date().toISOString(), last_error: null });
      return json({ authorized: true, auth_method: method, dry_run: dryRun, detail: res.detail });
    }
    await stamp({ last_error: res.error || `authorize failed (${res.status ?? '?'})` });
    return json({ authorized: false, auth_method: method, status: res.status, message: res.error || 'authorize failed', detail: res.detail });
  }

  if (method === 'onprem_relay') {
    await stamp({ last_error: 'onprem_relay is deprecated — use unifi_local_api or unifi_legacy (cloud-direct)' });
    return json({ authorized: false, auth_method: method, message: 'onprem_relay is deprecated; use unifi_local_api or unifi_legacy.' });
  }

  return json({ authorized: false, auth_method: method, message: 'unknown auth_method' });
});
