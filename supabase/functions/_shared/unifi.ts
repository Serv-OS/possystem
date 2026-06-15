// supabase/functions/_shared/unifi.ts
//
// Cloud → venue-console UniFi guest authorize. Runs server-side from a Supabase edge function;
// the venue's console must be reachable from the internet WITH A VALID TLS CERT — which is exactly
// what a cloud-adopted UniFi console gives you (Ubiquiti Remote Access / Site Manager proxy). No
// on-site agent, no port-forward. Deno cannot skip TLS verification, so a raw self-signed LAN IP
// will NOT work here — that's by design: use the console's cloud-adopted hostname as controller_url.
//
// Two methods, pick per venue:
//   • integration  — Network Integration API + X-API-KEY (Settings → Control Plane → Integrations).
//                    Cleanest where supported (UniFi OS 9.x+).
//   • legacy       — classic API + a local-admin account (login → cmd/stamgr authorize-guest).
//                    Most universal; works on older controllers; same call our old on-site agent made.
//
// Both authorize by client MAC (UniFi's redirect `id` param). All return a uniform Result so the
// caller can log last_error and surface a clean message.

export type UnifiResult = { ok: boolean; status?: number; error?: string; detail?: unknown };

const trim = (u: string) => String(u || '').replace(/\/+$/, '');
const macLc = (m: string) => String(m || '').trim().toLowerCase();

// ─────────────────────────── legacy: local-admin login → cmd/stamgr ───────────────────────────
// UniFi OS consoles (UDM/UX/Cloud Key Gen2+): login at /api/auth/login, authorize via
// /proxy/network/api/s/<site>/cmd/stamgr. Standalone software controllers use /api/login and
// /api/s/<site>/cmd/stamgr (no /proxy prefix). We try UniFi-OS first, fall back to standalone.
export async function authorizeLegacy(opts: {
  base: string; user: string; pass: string; site?: string; mac: string;
  minutes?: number; dataMb?: number; downKbps?: number; upKbps?: number; probeOnly?: boolean;
}): Promise<UnifiResult> {
  const base = trim(opts.base);
  const site = opts.site || 'default';
  const mac = macLc(opts.mac);
  if (!base) return { ok: false, error: 'controller_url not set' };
  if (!opts.user || !opts.pass) return { ok: false, error: 'admin credentials not set' };

  // login — try UniFi OS path, then standalone
  let cookie = '', csrf = '', unifiOs = true;
  for (const path of ['/api/auth/login', '/api/login']) {
    try {
      const r = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: opts.user, password: opts.pass, rememberMe: true }),
      });
      if (r.ok) {
        cookie = (r.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
        csrf = r.headers.get('x-csrf-token') || r.headers.get('x-updated-csrf-token') || '';
        unifiOs = path === '/api/auth/login';
        // drain body so the connection is reusable
        await r.text().catch(() => {});
        break;
      }
      if (r.status !== 404) return { ok: false, status: r.status, error: `login failed (${r.status})` };
    } catch (e) {
      return { ok: false, error: `cannot reach controller: ${(e as Error).message}` };
    }
  }
  if (!cookie) return { ok: false, error: 'login failed (no session cookie — check URL/creds and that the console is cloud-reachable with a valid cert)' };
  if (opts.probeOnly) return { ok: true, status: 200, detail: { loggedIn: true, unifiOs } };

  const cmdPath = unifiOs ? `/proxy/network/api/s/${site}/cmd/stamgr` : `/api/s/${site}/cmd/stamgr`;
  const body: Record<string, unknown> = { cmd: 'authorize-guest', mac, minutes: opts.minutes ?? 1440 };
  if (opts.dataMb) body.bytes = opts.dataMb * 1024 * 1024;     // quota in bytes
  if (opts.downKbps) body.down = opts.downKbps;
  if (opts.upKbps) body.up = opts.upKbps;
  try {
    const r = await fetch(`${base}${cmdPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cookie': cookie, ...(csrf ? { 'x-csrf-token': csrf } : {}) },
      body: JSON.stringify(body),
    });
    const txt = await r.text().catch(() => '');
    if (!r.ok) return { ok: false, status: r.status, error: `authorize failed (${r.status})`, detail: txt.slice(0, 300) };
    return { ok: true, status: r.status };
  } catch (e) {
    return { ok: false, error: `authorize request failed: ${(e as Error).message}` };
  }
}

// ─────────────────────────── integration: Network Integration API + X-API-KEY ───────────────────────────
export async function authorizeIntegration(opts: {
  base: string; apiKey: string; siteId?: string; mac: string;
  minutes?: number; dataMb?: number; downKbps?: number; upKbps?: number; probeOnly?: boolean;
}): Promise<UnifiResult> {
  const base = trim(opts.base);
  const mac = macLc(opts.mac);
  if (!base) return { ok: false, error: 'controller_url not set' };
  if (!opts.apiKey) return { ok: false, error: 'api key not set' };
  const root = `${base}/proxy/network/integration/v1`;
  const H = { 'X-API-KEY': opts.apiKey, 'Accept': 'application/json' };

  // resolve site id (cache-friendly: caller passes siteId when known)
  let siteId = opts.siteId || '';
  try {
    if (!siteId) {
      const sr = await fetch(`${root}/sites`, { headers: H });
      if (!sr.ok) return { ok: false, status: sr.status, error: `list sites failed (${sr.status}) — check API key + that the console is cloud-reachable` };
      const sj = await sr.json().catch(() => ({}));
      const sites = sj?.data ?? sj ?? [];
      siteId = Array.isArray(sites) && sites[0] ? (sites[0].id || sites[0].internalReference || '') : '';
      if (!siteId) return { ok: false, error: 'no sites returned for this API key' };
    }
  } catch (e) {
    return { ok: false, error: `cannot reach controller: ${(e as Error).message}` };
  }
  if (opts.probeOnly) return { ok: true, status: 200, detail: { siteId } };

  // resolve clientId from the client MAC (device must be associated — it is, in the captive flow)
  let clientId = '';
  try {
    const cr = await fetch(`${root}/sites/${siteId}/clients?filter=${encodeURIComponent(`macAddress.eq('${mac}')`)}`, { headers: H });
    if (cr.ok) {
      const cj = await cr.json().catch(() => ({}));
      const list = cj?.data ?? cj ?? [];
      if (Array.isArray(list) && list[0]) clientId = list[0].id || '';
    }
  } catch (_e) { /* fall through to error below */ }
  if (!clientId) return { ok: false, error: 'client not found on controller yet (device must be associated to the guest WLAN before authorize)' };

  try {
    const ar = await fetch(`${root}/sites/${siteId}/clients/${clientId}/actions`, {
      method: 'POST',
      headers: { ...H, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'AUTHORIZE_GUEST_ACCESS',
        timeLimitMinutes: opts.minutes ?? 1440,
        ...(opts.dataMb ? { dataUsageLimitMBytes: opts.dataMb } : {}),
        ...(opts.downKbps ? { rxRateLimitKbps: opts.downKbps } : {}),
        ...(opts.upKbps ? { txRateLimitKbps: opts.upKbps } : {}),
      }),
    });
    const txt = await ar.text().catch(() => '');
    if (!ar.ok) return { ok: false, status: ar.status, error: `authorize failed (${ar.status})`, detail: txt.slice(0, 300) };
    return { ok: true, status: ar.status, detail: { siteId, clientId } };
  } catch (e) {
    return { ok: false, error: `authorize request failed: ${(e as Error).message}` };
  }
}
