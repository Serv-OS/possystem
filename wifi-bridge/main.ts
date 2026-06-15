// ServOS WiFi Portal Bridge
//
// The ONE small always-on piece that makes UniFi's external captive portal work with our
// cloud-hosted branded page. UniFi's "External Portal Server" field takes an IP (not our
// domain) and 302s unauthenticated guests to:
//     http://<bridge>/guest/s/<site>/?id=<clientMAC>&ap=<apMAC>&t=<unix>&url=<orig>&ssid=<ssid>
// This bridge reads those params and 302s the guest on to the branded portal:
//     https://<slug>.serv-os.app/wifi?id=...&ap=...&ssid=...&site=...&orig=...
// The web portal captures into the CRM; the get-online step (voucher / local-API) is handled
// by the Supabase edge functions (wifi-capture → wifi-authorize).
//
// MULTI-TENANT with NO per-venue config here: the venue sets UniFi's "Redirect using Hostname"
// to <slug>.portal.serv-os.app (and *.portal.serv-os.app → this bridge's IP), so we read the
// slug straight off the Host header. Fallbacks: ?to=<slug>, then DEFAULT_SLUG. So ONE bridge
// instance + ONE IP serves every venue — exactly how Purple/IronWiFi/Spotipo operate.
//
// Deploy: a host with a STABLE public IPv4 (Fly.io dedicated IP is easiest — see README).
// Env: CUSTOMER_ROOT (e.g. "serv-os.app" prod, "dev.serv-os.app" dev), DEFAULT_SLUG (demo),
//      PORTAL_HOST_SUFFIX (default "portal.serv-os.app"), PORT (default 8080).

const CUSTOMER_ROOT = Deno.env.get('CUSTOMER_ROOT') || 'serv-os.app';
const DEFAULT_SLUG = Deno.env.get('DEFAULT_SLUG') || '';
const PORTAL_HOST_SUFFIX = Deno.env.get('PORTAL_HOST_SUFFIX') || 'portal.serv-os.app';
const PORT = Number(Deno.env.get('PORT') || '8080');

function slugFromHost(host: string | null): string | null {
  if (!host) return null;
  const h = host.split(':')[0].toLowerCase();
  if (h.endsWith('.' + PORTAL_HOST_SUFFIX)) {
    const sub = h.slice(0, -('.' + PORTAL_HOST_SUFFIX).length);
    if (sub && sub !== 'www') return sub;
  }
  return null;
}

Deno.serve({ port: PORT }, (req) => {
  const url = new URL(req.url);
  const path = url.pathname;

  // Health check / root
  if (path === '/' || path === '/health') {
    return new Response('ServOS WiFi bridge — ok', { status: 200, headers: { 'content-type': 'text/plain' } });
  }

  // UniFi hits /guest/s/<site>/...  — accept anything under /guest/ (and any path, defensively)
  const q = url.searchParams;
  const id = q.get('id') || q.get('mac') || '';        // client MAC (UniFi sends as `id`)
  const ap = q.get('ap') || '';
  const ssid = q.get('ssid') || '';
  const t = q.get('t') || '';
  const orig = q.get('url') || '';
  const siteMatch = path.match(/\/guest\/s\/([^/]+)/);
  const site = siteMatch ? decodeURIComponent(siteMatch[1]) : (q.get('site') || '');

  // Resolve which venue this is: Host header subdomain → ?to= → DEFAULT_SLUG
  const slug = slugFromHost(req.headers.get('host')) || q.get('to') || DEFAULT_SLUG;
  if (!slug) {
    return new Response(
      'WiFi portal not configured for this venue (no slug). Set UniFi "Redirect using Hostname" to <slug>.' + PORTAL_HOST_SUFFIX + '.',
      { status: 404, headers: { 'content-type': 'text/plain' } },
    );
  }

  // Build the branded portal URL, carrying UniFi's identity params through.
  const dest = new URL(`https://${slug}.${CUSTOMER_ROOT}/wifi`);
  if (id) dest.searchParams.set('id', id);
  if (ap) dest.searchParams.set('ap', ap);
  if (ssid) dest.searchParams.set('ssid', ssid);
  if (site) dest.searchParams.set('site', site);
  if (t) dest.searchParams.set('t', t);
  if (orig) dest.searchParams.set('orig', orig);

  return new Response(null, { status: 302, headers: { location: dest.toString(), 'cache-control': 'no-store' } });
});

console.log(`ServOS WiFi bridge listening on :${PORT} → https://<slug>.${CUSTOMER_ROOT}/wifi`);
