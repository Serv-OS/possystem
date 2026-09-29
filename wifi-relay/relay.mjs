// ServOS WiFi relay — one small box with a FIXED public IPv4 (Fly app servos-wifi-relay,
// 37.16.1.154). It has two jobs:
//
// 1. FORWARDER (since Aug 2026). Ubiquiti's cloud (unifi.ui.com, behind CloudFront) blocks requests
//    from serverless/datacenter IPs like Supabase Edge Functions (403). The wifi-authorize edge
//    function POSTs the request it wants made to /forward, this relay replays it to *.ui.com from
//    its own IP and returns the response. A DUMB, locked-down forwarder: only *.ui.com, shared
//    token, NO secrets of its own. All UniFi login/2FA/authorize logic lives in the edge function.
//
// 2. WIFI FRONT DOOR (29 Sep 2026, Coffee Boy Huddersfield). UniFi's hotspot "External Portal
//    Server" takes one IPv4 and its pre-auth allow-list matches IPs, but <slug>.serv-os.app
//    (Vercel) resolves to rotating anycast addresses, so guests' phones hit addresses UniFi
//    blocked. Guests now land on <slug>.wifi.serv-os.app (DNS: *.wifi.serv-os.app → this box),
//    and this relay serves the venue's page and both Supabase projects from that ONE address:
//      /guest/...    → 302 /wifi?... (UniFi's redirect, its parameters kept)
//      /_sb/ops/*    → https://tbetcegmszzotrwdtqhi.supabase.co/*
//      /_sb/plat/*   → https://yhzjgyrkyjabvhblqxzu.supabase.co/*
//      everything    → https://<slug>.serv-os.app   (dev tier: <slug>.wifi.dev.serv-os.app →
//                      https://<slug>.dev.serv-os.app)
//    The routing decisions are PURE and tested (portal.mjs, src/lib/wifiRelayPortal.test.js).
//    Only those upstreams can ever be reached; nothing in a request can name another host.
//
// Run:  RELAY_TOKEN=<long-random-string> node relay.mjs       (needs Node 20+)
// Deploy: fly deploy (from wifi-relay/). See README.md.

import { createServer } from 'node:http';
import { request as httpsRequest, Agent } from 'node:https';
import {
  decideRequest, upstreamRequestHeaders, downstreamResponseHeaders, portalOrigin, supabaseUpstreams,
} from './portal.mjs';

const TOKEN = process.env.RELAY_TOKEN || '';
const PORT = Number(process.env.PORT || 8080);
const ALLOWED_HOST = /(^|\.)ui\.com$/i;        // only Ubiquiti hosts may be forwarded to
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const SUPABASE = supabaseUpstreams(process.env);
const UPSTREAM_TIMEOUT_MS = 60_000;            // edge functions (wifi-capture → UniFi) can take a while

// Reuse TLS connections to Vercel and Supabase: a page load is a dozen requests.
const agent = new Agent({ keepAlive: true, maxSockets: 128, timeout: UPSTREAM_TIMEOUT_MS });

if (!TOKEN) console.warn('⚠  RELAY_TOKEN is not set — the relay will accept unauthenticated requests. Set one.');

const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

// ── 1. The forwarder (unchanged) ──────────────────────────────────────────────────────────────
async function forward(req, res) {
  if (req.method !== 'POST') return send(res, 404, { error: 'not found' });
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
}

// ── 2. The WiFi front door ────────────────────────────────────────────────────────────────────
function withCookie(headers, cookie) {
  if (!cookie) return headers;
  const prev = headers['set-cookie'];
  headers['set-cookie'] = [...(Array.isArray(prev) ? prev : prev ? [prev] : []), cookie];
  return headers;
}

function redirect(res, d) {
  res.writeHead(d.status || 302, withCookie({ Location: d.location, 'Cache-Control': 'no-store', 'Content-Length': '0' }, d.setCookie));
  res.end();
}

// Stream the request to the upstream and its answer back. No caching, no redirect following;
// status, headers (hop-by-hop removed, Location mapped back to the portal host) and body pass through.
function proxy(req, res, d) {
  const origin = portalOrigin(req.headers.host, req.headers['x-forwarded-proto']);
  const up = httpsRequest({
    host: d.upstreamHost, servername: d.upstreamHost, port: 443,
    method: req.method, path: d.path,
    headers: upstreamRequestHeaders(req.headers, d.upstreamHost),
    agent,
  });
  up.setTimeout(UPSTREAM_TIMEOUT_MS, () => up.destroy(new Error('upstream timed out')));
  up.on('response', (ur) => {
    const headers = downstreamResponseHeaders(ur.headers, { upstreamOrigin: d.upstreamOrigin, portalOrigin: origin, prefix: d.prefix });
    res.writeHead(ur.statusCode || 502, withCookie(headers, d.setCookie));
    ur.pipe(res);
    ur.on('error', () => res.destroy());
  });
  up.on('error', (e) => {
    console.warn(`[portal] ${d.upstreamHost}${d.path.split('?')[0]}: ${e.message}`);
    if (!res.headersSent) send(res, 502, { error: 'upstream unavailable' });
    else res.destroy();
  });
  // The guest went away: stop the upstream request too.
  res.on('close', () => { if (!res.writableFinished) up.destroy(); });
  req.pipe(up);
}

const server = createServer((req, res) => {
  const d = decideRequest({ method: req.method, host: req.headers.host, url: req.url, cookie: req.headers.cookie, supabase: SUPABASE });
  // Visit log (29 Sep 2026, Huddersfield "portal does not pop up"): which host and page a guest's
  // phone reached, so a failed setup shows how far it got. Page only: no query string (UniFi puts
  // the phone's MAC there), no IP, no headers. Page files and /_sb calls are not logged.
  const path = String(req.url || '/').split('?')[0];
  if (d.kind !== 'health' && d.kind !== 'forward' && !/^\/(_sb|assets)\//.test(path)) {
    console.log(`[visit] ${req.method} ${String(req.headers.host || '-').toLowerCase()} ${path.slice(0, 80)} -> ${d.kind}${d.hint ? ' ' + d.hint : ''}`);
  }
  switch (d.kind) {
    case 'health': return send(res, 200, { ok: true, service: 'servos-wifi-relay' });
    case 'forward': return forward(req, res);
    case 'redirect': return redirect(res, d);
    case 'proxy': return proxy(req, res, d);
    default:
      if (d.hint === 'no_venue') {
        return send(res, 404, { error: 'not found', hint: 'Set Domain in UniFi to <venue>.wifi.serv-os.app so the WiFi page knows which venue this is.' });
      }
      return send(res, 404, { error: 'not found' });
  }
});

// WebSockets (Supabase Realtime) through /_sb/ops and /_sb/plat only. The WiFi page does not need
// Realtime, but the Supabase client may open it, and a half-working /_sb would be a trap later.
server.on('upgrade', (req, socket, head) => {
  const d = decideRequest({ method: req.method, host: req.headers.host, url: req.url, cookie: req.headers.cookie, supabase: SUPABASE });
  if (d.kind !== 'proxy' || !d.prefix) { socket.destroy(); return; }
  const headers = upstreamRequestHeaders(req.headers, d.upstreamHost);
  headers.connection = 'Upgrade';
  headers.upgrade = req.headers.upgrade;
  const up = httpsRequest({ host: d.upstreamHost, servername: d.upstreamHost, port: 443, method: req.method, path: d.path, headers, agent: false });
  const writeHead = (code, message, h) => {
    let out = `HTTP/1.1 ${code} ${message || ''}\r\n`;
    for (const [k, v] of Object.entries(h)) for (const one of Array.isArray(v) ? v : [v]) out += `${k}: ${one}\r\n`;
    socket.write(`${out}\r\n`);
  };
  up.on('upgrade', (ur, upSocket, upHead) => {
    writeHead(101, 'Switching Protocols', ur.headers);
    if (upHead?.length) socket.write(upHead);
    if (head?.length) upSocket.write(head);
    upSocket.on('error', () => socket.destroy());
    socket.on('error', () => upSocket.destroy());
    upSocket.pipe(socket).pipe(upSocket);
  });
  up.on('response', (ur) => {                 // the upstream said no (401, 404 …): pass that on
    writeHead(ur.statusCode || 502, ur.statusMessage, { ...downstreamResponseHeaders(ur.headers, {}), connection: 'close' });
    ur.pipe(socket);
  });
  up.on('error', () => socket.destroy());
  socket.on('error', () => up.destroy());
  up.end();
});

// Fly's proxy keeps connections to the app open; outlive its idle timeout so it never reuses a
// socket we are closing.
server.keepAliveTimeout = 75_000;
server.headersTimeout = 76_000;

server.listen(PORT, () => console.log(`✓ ServOS WiFi relay listening on :${PORT} (forwards only to *.ui.com; WiFi front door for *.wifi.serv-os.app)`));
