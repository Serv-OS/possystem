// ServOS WiFi on-site authoriser (the "get them online" piece for UniFi).
//
// UniFi only lets a guest onto the internet when something calls the console's API to
// AUTHORIZE their device — and that call must happen locally (the console isn't internet-
// reachable and uses a self-signed cert). This little agent runs on a machine ON the venue
// network: every few seconds it asks ServOS "who just signed up here and isn't online yet?",
// then calls the local UniFi console to authorize each device. That's the whole job.
//
// It's the software version of Stampede's on-site box. For a venue it runs on a tiny always-on
// device (a £30 mini-PC / Raspberry Pi); for your demo, run it on your Mac while testing.
//
// Run (Mac/PC with Node 18+), pointing at your console + ServOS:
//   NODE_TLS_REJECT_UNAUTHORIZED=0 \
//   UNIFI_URL=https://192.168.1.1 UNIFI_USER=servos UNIFI_PASS=•••• UNIFI_SITE=default \
//   SUPA_URL=https://tbetcegmszzotrwdtqhi.supabase.co SUPA_KEY=<service_role key> \
//   LOCATION_ID=7218c716-eeb4-4f96-b284-f3500823595c MINUTES=1440 \
//   node agent.mjs
//
// NODE_TLS_REJECT_UNAUTHORIZED=0 is needed because the UniFi console uses a self-signed cert on
// the LAN. The agent only talks to your LAN console + Supabase (valid cert), so this is safe here.

const {
  UNIFI_URL, UNIFI_USER, UNIFI_PASS, UNIFI_SITE = 'default',
  SUPA_URL, SUPA_KEY, LOCATION_ID, MINUTES = '1440',
  POLL_MS = '3000',
} = process.env;

for (const [k, v] of Object.entries({ UNIFI_URL, UNIFI_USER, UNIFI_PASS, SUPA_URL, SUPA_KEY, LOCATION_ID })) {
  if (!v) { console.error(`Missing env ${k}`); process.exit(1); }
}
const base = UNIFI_URL.replace(/\/$/, '');
const minutes = Number(MINUTES) || 1440;
let session = null;            // { cookie, csrf }

// ── UniFi OS login → cookie + CSRF token ──
async function login() {
  const r = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: UNIFI_USER, password: UNIFI_PASS, rememberMe: true }),
  });
  if (!r.ok) throw new Error(`UniFi login failed: ${r.status}`);
  const cookie = (r.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
  const csrf = r.headers.get('x-csrf-token') || r.headers.get('x-updated-csrf-token') || '';
  session = { cookie, csrf };
  console.log('✓ logged in to UniFi console');
}

// ── authorize one MAC on the console ──
async function authorize(mac) {
  if (!session) await login();
  const doPost = () => fetch(`${base}/proxy/network/api/s/${UNIFI_SITE}/cmd/stamgr`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cookie': session.cookie, 'x-csrf-token': session.csrf },
    body: JSON.stringify({ cmd: 'authorize-guest', mac: mac.toLowerCase(), minutes }),
  });
  let r = await doPost();
  if (r.status === 401 || r.status === 403) { await login(); r = await doPost(); }   // session expired → relogin
  return r.ok;
}

// ── ServOS: pending sign-ups not yet online ──
const rest = (path) => fetch(`${SUPA_URL}/rest/v1/${path}`, { headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` } });
async function pending() {
  const since = new Date(Date.now() - 15 * 60_000).toISOString();   // only recent sign-ups
  const r = await rest(`wifi_captures?location_id=eq.${LOCATION_ID}&authorized=is.false&client_mac=not.is.null&created_at=gt.${since}&select=id,client_mac&order=created_at.desc&limit=25`);
  return r.ok ? await r.json() : [];
}
async function markDone(id) {
  await fetch(`${SUPA_URL}/rest/v1/wifi_captures?id=eq.${id}`, {
    method: 'PATCH',
    headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ authorized: true, auth_method: 'onprem_agent' }),
  });
}

console.log(`ServOS WiFi agent → console ${base} (site ${UNIFI_SITE}), location ${LOCATION_ID}, every ${POLL_MS}ms`);
let busy = false;
setInterval(async () => {
  if (busy) return; busy = true;
  try {
    const rows = await pending();
    for (const row of rows) {
      try {
        const ok = await authorize(row.client_mac);
        if (ok) { await markDone(row.id); console.log(`✓ online: ${row.client_mac}`); }
        else console.warn(`✗ authorize failed: ${row.client_mac}`);
      } catch (e) { console.warn(`! ${row.client_mac}: ${e.message}`); }
    }
  } catch (e) { console.warn(`poll error: ${e.message}`); }
  finally { busy = false; }
}, Number(POLL_MS) || 3000);
