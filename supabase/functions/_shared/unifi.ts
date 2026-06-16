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

// Normalise a controller address: strip trailing slash, and accept a scheme-less host:port
// (e.g. "unifi-pos-up.example.io:8443") by defaulting to https — exactly how the vendor
// "Server address" field works. Deno requires a scheme + a valid TLS cert.
const trim = (u: string) => {
  let s = String(u || '').trim().replace(/\/+$/, '');
  if (s && !/^https?:\/\//i.test(s)) s = `https://${s}`;
  return s;
};
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
  // Build the Integration API root, tolerant of whatever the operator pasted:
  //   • full root already ending /integration/v1            → use as-is
  //   • remote proxy base …/consoles/<id>/network           → + /integration/v1
  //   • remote proxy base …/proxy/consoles/<id>             → + /network/integration/v1
  //   • direct console host (https://192.168.1.1, https://…ui.com) → + /proxy/network/integration/v1
  const root = /\/integration\/v1$/.test(base) ? base
    : /\/network$/.test(base) ? `${base}/integration/v1`
    : /\/proxy\/consoles\/[^/]+$/.test(base) ? `${base}/network/integration/v1`
    : `${base}/proxy/network/integration/v1`;
  const H = { 'X-API-KEY': opts.apiKey, 'Accept': 'application/json' };

  // ALWAYS resolve the site via /sites — this is the real reachability + auth check, and the
  // Integration API needs the site's UUID (the classic name 'default' is NOT a valid id here).
  let siteId = '';
  try {
    const sr = await fetch(`${root}/sites`, { headers: H });
    const body = await sr.text().catch(() => '');
    if (!sr.ok) {
      const hint = sr.status === 401 || sr.status === 403 ? ' — API key rejected'
        : sr.status === 404 ? ' — wrong controller URL (the console isn’t at this address/path)'
        : body.trim().startsWith('<') ? ' — got an HTML login page, not the API (wrong URL — needs the per-console remote path)'
        : '';
      return { ok: false, status: sr.status, error: `list sites failed (${sr.status})${hint}`, detail: body.slice(0, 200) };
    }
    let sj: any = {}; try { sj = JSON.parse(body); } catch { return { ok: false, error: 'controller returned non-JSON for /sites (wrong URL — likely a login page, not the API)', detail: body.slice(0, 200) }; }
    const sites = sj?.data ?? sj ?? [];
    if (!Array.isArray(sites) || !sites.length) return { ok: false, error: 'no sites returned for this API key' };
    const want = String(opts.siteId || '').toLowerCase();
    const match = want ? sites.find((s: any) => [s.id, s.name, s.internalReference].filter(Boolean).some((x: any) => String(x).toLowerCase() === want)) : null;
    siteId = (match || sites[0]).id;
    if (!siteId) return { ok: false, error: 'site has no id field' };
  } catch (e) {
    return { ok: false, error: `cannot reach controller: ${(e as Error).message} (check the URL is internet-reachable with a valid cert)` };
  }
  if (opts.probeOnly) return { ok: true, status: 200, detail: { siteId, reached: true } };

  // resolve clientId from the client MAC — try server-side filter, then fall back to scanning the
  // client list (filter syntax varies by version). Surface the real HTTP status if it errors.
  let clientId = '';
  let clientStatus = 0;
  for (const q of [`?filter=${encodeURIComponent(`macAddress.eq('${mac}')`)}&limit=200`, `?limit=200`]) {
    try {
      const cr = await fetch(`${root}/sites/${siteId}/clients${q}`, { headers: H });
      clientStatus = cr.status;
      if (!cr.ok) continue;
      const cj = await cr.json().catch(() => ({}));
      const list = cj?.data ?? cj ?? [];
      const hit = (Array.isArray(list) ? list : []).find((c: any) => String(c.macAddress || c.mac || '').toLowerCase() === mac);
      if (hit?.id) { clientId = hit.id; break; }
      if (Array.isArray(list) && list.length === 1 && list[0]?.id && q.includes('filter')) { clientId = list[0].id; break; }
    } catch (_e) { /* try next */ }
  }
  if (!clientId) {
    if (clientStatus >= 400) return { ok: false, status: clientStatus, error: `client lookup failed (${clientStatus}) — reached the console + site OK, but couldn’t query clients` };
    return { ok: false, error: 'reached the console OK, but this device isn’t in the client list yet (it must be associated to the guest WLAN at authorize time)' };
  }

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

// ─────────────────────────── cloud (Ubiquiti account SSO) — the Stampede method ───────────────────────────
// Log into the user's Ubiquiti CLOUD account at https://unifi.ui.com (account email + password,
// + a TOTP 2FA code we generate from a stored secret), then drive the console's CLASSIC Network API
// THROUGH the cloud proxy with the session cookie + x-csrf-token. Works cloud-only — Ubiquiti's
// cloud relays to the (cloud-adopted) console. consoleId scopes the proxy to the right console.
//
// 2FA: since Jul-2024 Ubiquiti forces MFA. First login → 499 / "Ubic2faTokenRequired"; we resubmit
// with field `token` = current TOTP. Use a DEDICATED account (not the owner's personal login).

function b32decode(s: string): Uint8Array {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = String(s || '').replace(/=+$/, '').replace(/\s/g, '').toUpperCase();
  let bits = 0, value = 0; const out: number[] = [];
  for (const c of clean) {
    const idx = A.indexOf(c);
    if (idx === -1) continue;
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return new Uint8Array(out);
}

async function totp(secret: string): Promise<string> {
  const key = b32decode(secret);
  if (!key.length) return '';
  const counter = Math.floor(Date.now() / 1000 / 30);
  const buf = new ArrayBuffer(8); const dv = new DataView(buf);
  dv.setUint32(4, counter >>> 0);        // high word stays 0 well past year 2100
  const ck = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', ck, buf));
  const o = sig[19] & 0xf;
  const code = ((sig[o] & 0x7f) << 24 | sig[o + 1] << 16 | sig[o + 2] << 8 | sig[o + 3]) % 1_000_000;
  return code.toString().padStart(6, '0');
}

export async function authorizeCloud(opts: {
  base?: string; email: string; pass: string; totpSecret?: string; consoleId?: string; site?: string;
  mac: string; minutes?: number; dataMb?: number; downKbps?: number; upKbps?: number; probeOnly?: boolean;
}): Promise<UnifiResult> {
  const base = trim(opts.base || 'https://unifi.ui.com');
  const site = opts.site || 'default';
  const mac = macLc(opts.mac);
  if (!opts.email || !opts.pass) return { ok: false, error: 'account email + password not set' };

  const doLogin = (extra: Record<string, unknown> = {}) => fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Referer': `${base}/login` },
    body: JSON.stringify({ username: opts.email, password: opts.pass, rememberMe: true, ...extra }),
  });

  let r: Response;
  try { r = await doLogin(); }
  catch (e) { return { ok: false, error: `cannot reach ${base}: ${(e as Error).message}` }; }
  let body = await r.text().catch(() => '');

  // 2FA required → resubmit with a generated TOTP code
  if (!r.ok && (r.status === 499 || /2fa|Ubic2fa|TokenRequired/i.test(body))) {
    if (!opts.totpSecret) return { ok: false, status: r.status, error: '2-factor is on for this Ubiquiti account — add the account’s 2FA secret (or use a dedicated account)' };
    const code = await totp(opts.totpSecret);
    if (!code) return { ok: false, error: '2FA secret looks invalid (could not generate a code)' };
    try { r = await doLogin({ token: code }); } catch (e) { return { ok: false, error: `2FA login failed: ${(e as Error).message}` }; }
    body = await r.text().catch(() => '');
  }
  if (!r.ok) {
    const hint = /invalid|credential|password|authentic/i.test(body) ? ' — wrong email/password'
      : /2fa|token/i.test(body) ? ' — 2FA code rejected (check the secret)' : '';
    return { ok: false, status: r.status, error: `account login failed (${r.status})${hint}`, detail: body.slice(0, 200) };
  }

  const cookie = (r.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
  if (!cookie) return { ok: false, error: 'logged in but no session cookie was returned' };
  let csrf = r.headers.get('x-csrf-token') || '';
  if (!csrf && /(^|; )TOKEN=/.test(cookie)) {
    try { const jwt = cookie.split('TOKEN=')[1].split(';')[0]; csrf = JSON.parse(atob(jwt.split('.')[1])).csrfToken || ''; } catch { /* ignore */ }
  }
  if (opts.probeOnly) return { ok: true, status: 200, detail: { loggedIn: true, hasCsrf: !!csrf, consoleId: opts.consoleId || null } };

  // authorize via the cloud proxy → the specific console's classic Network API
  const netBase = opts.consoleId ? `${base}/proxy/consoles/${opts.consoleId}/network` : `${base}/proxy/network`;
  const cmdBody: Record<string, unknown> = { cmd: 'authorize-guest', mac, minutes: opts.minutes ?? 1440 };
  if (opts.dataMb) cmdBody.bytes = opts.dataMb * 1024 * 1024;
  if (opts.downKbps) cmdBody.down = opts.downKbps;
  if (opts.upKbps) cmdBody.up = opts.upKbps;
  try {
    const ar = await fetch(`${netBase}/api/s/${site}/cmd/stamgr`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cookie': cookie, ...(csrf ? { 'x-csrf-token': csrf } : {}) },
      body: JSON.stringify(cmdBody),
    });
    const t = await ar.text().catch(() => '');
    if (!ar.ok) return { ok: false, status: ar.status, error: `authorize failed (${ar.status})${t.trim().startsWith('<') ? ' — proxy returned HTML (check console id)' : ''}`, detail: t.slice(0, 200) };
    return { ok: true, status: ar.status };
  } catch (e) {
    return { ok: false, error: `authorize request failed: ${(e as Error).message}` };
  }
}
