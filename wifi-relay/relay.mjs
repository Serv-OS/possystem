// ServOS WiFi relay — a fixed-IP forwarder for Ubiquiti cloud calls.
//
// Why this exists: Ubiquiti's cloud (unifi.ui.com, behind CloudFront) blocks requests from
// serverless/datacenter IPs like Supabase Edge Functions (403). So the ServOS edge function can't
// call it directly. This tiny service runs on ONE small box with a stable, allowed IP; the edge
// function POSTs the request it wants made, this relay replays it to unifi.ui.com from its own IP,
// and returns the response. One relay serves ALL venues. No per-venue hardware.
//
// It is a DUMB, locked-down forwarder: it only forwards to *.ui.com, requires a shared token, and
// holds NO secrets of its own. All UniFi login/2FA/authorize logic lives in the edge function.
//
// Run:  RELAY_TOKEN=<long-random-string> node relay.mjs       (needs Node 20+)
// Then set UNIFI_RELAY_URL + UNIFI_RELAY_TOKEN in Supabase. See README.md.

import { createServer } from 'node:http';

const TOKEN = process.env.RELAY_TOKEN || '';
const PORT = Number(process.env.PORT || 8080);
const ALLOWED_HOST = /(^|\.)ui\.com$/i;        // only Ubiquiti hosts may be forwarded to
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

if (!TOKEN) console.warn('⚠  RELAY_TOKEN is not set — the relay will accept unauthenticated requests. Set one.');

const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

const server = createServer(async (req, res) => {
  if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) return send(res, 200, { ok: true, service: 'servos-wifi-relay' });
  if (req.method !== 'POST' || req.url !== '/forward') return send(res, 404, { error: 'not found' });
  if (TOKEN && req.headers['x-relay-token'] !== TOKEN) return send(res, 401, { error: 'unauthorized' });

  let raw = '';
  try { for await (const c of req) { raw += c; if (raw.length > 1_000_000) throw new Error('payload too large'); } }
  catch (e) { return send(res, 400, { error: String(e.message || e) }); }

  let p;
  try { p = JSON.parse(raw); } catch { return send(res, 400, { error: 'invalid json' }); }

  let host;
  try { host = new URL(p.url).hostname; } catch { return send(res, 400, { error: 'invalid target url' }); }
  if (!ALLOWED_HOST.test(host)) return send(res, 403, { error: `host not allowed: ${host}` });

  try {
    const r = await fetch(p.url, {
      method: p.method || 'GET',
      headers: { 'User-Agent': UA, ...(p.headers || {}) },
      body: p.body ?? undefined,
      redirect: 'manual',                       // we want the real login response + cookies, not a follow
    });
    const body = await r.text();
    const setCookie = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
    const headers = {};
    r.headers.forEach((v, k) => { if (k.toLowerCase() !== 'set-cookie') headers[k] = v; });
    return send(res, 200, { status: r.status, headers, setCookie, body });
  } catch (e) {
    return send(res, 200, { status: 0, error: String(e.message || e), headers: {}, setCookie: [], body: '' });
  }
});

server.listen(PORT, () => console.log(`✓ ServOS WiFi relay listening on :${PORT} (forwards only to *.ui.com)`));
