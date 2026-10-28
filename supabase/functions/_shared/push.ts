// supabase/functions/_shared/push.ts
// MARKER 5.11.102 push
//
// App push for ServOS (5.11.102). NO FIREBASE, EVER:
//   * iOS (the ServOS Staff and ServOS Manager apps): straight to Apple (APNs, HTTP/2) with our own
//     provider token, signed with the .p8 key. Secrets APNS_KEY_ID, APNS_TEAM_ID, APNS_KEY_P8. Topic
//     by app: co.posup.rpos.staff, co.posup.rpos.manager. Each phone says whether it is a production
//     build (TestFlight, App Store: api.push.apple.com) or an Xcode build (the sandbox host).
//   * Android and browsers (the home screen staff app): the standard Web Push protocol, messages
//     encrypted for the phone (RFC 8291), our own VAPID keys. Secrets VAPID_PUBLIC_KEY,
//     VAPID_PRIVATE_KEY, VAPID_SUBJECT.
// A missing secret means that kind of push is skipped, never an error: the code runs before the keys
// are set. A phone Apple or the push service says is gone (uninstalled, expired) is forgotten.
// The cryptography is in pushCrypto.js (tested from node).
//
// MARKER 5.11.109 push log: every phone a push was tried on gets a row in push_log (company,
// person, kind, sent or not, the push service's status and reason), written after the batch, as
// the service role, never awaited past TIMEOUT_MS and never an error (20261105a; before it runs
// the insert is refused and nothing else changes). Team chat, Settings, Notifications reads it.

import { apnsJwt, importP8, importVapidPrivate, vapidAuthHeader, encryptWebPush, apnsHost, apnsPayload } from './pushCrypto.js';

export type PushDevice = { id: string; platform: 'apns' | 'webpush'; token: string; subscription?: any; environment?: string; app?: string; org_id?: string; member_id?: string };
export type PushMessage = { title: string; body: string; threadId?: string | null; data?: Record<string, unknown>; urgent?: boolean };
export type PushResult = { ok: boolean; gone: boolean; status?: number; skipped?: string };

const env = (k: string) => (Deno.env.get(k) ?? '').trim();
const SUPABASE_URL = env('SUPABASE_URL');
const SERVICE_ROLE = env('SUPABASE_SERVICE_ROLE_KEY');
const TOPICS: Record<string, string> = { staff: 'co.posup.rpos.staff', manager: 'co.posup.rpos.manager' };
const TIMEOUT_MS = 8000;

// ── APNs ─────────────────────────────────────────────────────────────────────
let apnsKey: CryptoKey | null = null;
let apnsToken: { jwt: string; at: number } | null = null;

async function apnsBearer(fresh = false): Promise<string | null> {
  const keyId = env('APNS_KEY_ID'), teamId = env('APNS_TEAM_ID'), p8 = env('APNS_KEY_P8');
  if (!keyId || !teamId || !p8) return null;
  // Apple wants the same token reused, refreshed between 20 and 60 minutes.
  if (!fresh && apnsToken && Date.now() - apnsToken.at < 40 * 60 * 1000) return apnsToken.jwt;
  if (!apnsKey) apnsKey = await importP8(p8);
  const jwt = await apnsJwt({ keyId, teamId, key: apnsKey });
  apnsToken = { jwt, at: Date.now() };
  return jwt;
}

async function sendApns(d: PushDevice, m: PushMessage, retried = false): Promise<PushResult> {
  const bearer = await apnsBearer(retried);
  if (!bearer) return { ok: false, gone: false, skipped: 'apns_not_set_up' };
  const res = await fetch(`https://${apnsHost(d.environment)}/3/device/${encodeURIComponent(d.token)}`, {
    method: 'POST',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: {
      authorization: `bearer ${bearer}`,
      'apns-topic': TOPICS[d.app || 'staff'] || TOPICS.staff,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'apns-expiration': String(Math.floor(Date.now() / 1000) + 86400),
      'content-type': 'application/json',
    },
    body: JSON.stringify(apnsPayload({ title: m.title, body: m.body, threadId: m.threadId, data: m.data, urgent: m.urgent })),
  });
  if (res.status === 200) return { ok: true, gone: false, status: 200 };
  const reason = String((await res.json().catch(() => ({})))?.reason || '');
  if (res.status === 403 && reason === 'ExpiredProviderToken' && !retried) return sendApns(d, m, true);
  const gone = res.status === 410 || ['BadDeviceToken', 'DeviceTokenNotForTopic', 'Unregistered'].includes(reason);
  return { ok: false, gone, status: res.status, skipped: reason || undefined };
}

// ── Web Push ─────────────────────────────────────────────────────────────────
let vapidKey: CryptoKey | null = null;

async function sendWebPush(d: PushDevice, m: PushMessage): Promise<PushResult> {
  const pub = env('VAPID_PUBLIC_KEY'), priv = env('VAPID_PRIVATE_KEY');
  if (!pub || !priv) return { ok: false, gone: false, skipped: 'webpush_not_set_up' };
  const sub = d.subscription || {};
  const endpoint = String(sub.endpoint || d.token || '');
  if (!/^https:\/\//.test(endpoint) || !sub.keys?.p256dh || !sub.keys?.auth) return { ok: false, gone: true, skipped: 'bad_subscription' };
  if (!vapidKey) vapidKey = await importVapidPrivate(pub, priv);
  const auth = await vapidAuthHeader({ endpoint, subject: env('VAPID_SUBJECT') || 'https://serv-os.app', publicKey: pub, privateKey: vapidKey });
  const body = await encryptWebPush({ p256dh: sub.keys.p256dh, auth: sub.keys.auth,
    payload: JSON.stringify({ title: m.title, body: m.body, tag: m.threadId || undefined, data: m.data || {} }) });
  const res = await fetch(endpoint, {
    method: 'POST',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { authorization: auth, 'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream', ttl: '86400', urgency: m.urgent ? 'high' : 'normal' },
    body,
  });
  if (res.status >= 200 && res.status < 300) return { ok: true, gone: false, status: res.status };
  return { ok: false, gone: res.status === 404 || res.status === 410, status: res.status };
}

/** One phone. Never throws. */
export async function sendPush(d: PushDevice, m: PushMessage): Promise<PushResult> {
  try {
    if (d.platform === 'apns') return await sendApns(d, m);
    if (d.platform === 'webpush') return await sendWebPush(d, m);
    return { ok: false, gone: false, skipped: 'unknown_platform' };
  } catch (e) {
    return { ok: false, gone: false, skipped: (e as Error)?.message || 'error' };
  }
}

/** Many phones, 20 at a time. Returns which phones landed and which are gone (forgotten here). */
export async function sendPushMany(devices: PushDevice[], m: PushMessage): Promise<{ landed: Set<string>; gone: string[]; skipped: number }> {
  const landed = new Set<string>();
  const gone: string[] = [];
  let skipped = 0;
  const log: PushLogRow[] = [];
  for (let i = 0; i < devices.length; i += 20) {
    const batch = devices.slice(i, i + 20);
    const results = await Promise.all(batch.map((d) => sendPush(d, m)));
    results.forEach((r, j) => {
      if (r.ok) landed.add(batch[j].id);
      else if (r.gone) gone.push(batch[j].id);
      else if (r.skipped) skipped++;
      const row = pushLogRow(batch[j], m, r);
      if (row) log.push(row);
    });
  }
  if (gone.length) await forgetDevices(gone);
  if (log.length) await writePushLog(log);
  return { landed, gone, skipped };
}

// ── The push log (5.11.109) ──────────────────────────────────────────────────
export type PushLogRow = { org_id: string; member_id: string | null; kind: string; ok: boolean; status: number | null; reason: string | null };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One log row for one phone, or null when the phone does not say its company (an older database). */
export function pushLogRow(d: PushDevice, m: PushMessage, r: PushResult): PushLogRow | null {
  if (!d || !UUID_RE.test(String(d.org_id || ''))) return null;
  const kind = String((m?.data as any)?.type || 'push').replace(/[^\w.-]/g, '').slice(0, 40) || 'push';
  const reason = r.ok ? null : String(r.skipped || (r.gone ? 'gone' : '') || '').slice(0, 200) || null;
  return { org_id: String(d.org_id), member_id: UUID_RE.test(String(d.member_id || '')) ? String(d.member_id) : null, kind, ok: !!r.ok,
    status: Number.isFinite(r.status) ? Number(r.status) : null, reason };
}

async function writePushLog(rows: PushLogRow[]) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/push_log`, {
      method: 'POST',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { apikey: SERVICE_ROLE, authorization: `Bearer ${SERVICE_ROLE}`, 'content-type': 'application/json', prefer: 'return=minimal' },
      body: JSON.stringify(rows.slice(0, 1000)),
    });
  } catch { /* only a record: the push itself has gone */ }
}

// ── The database, through the REST API as the service role (no client import needed) ──
export async function restRpc(name: string, args: Record<string, unknown>): Promise<any> {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
      method: 'POST',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { apikey: SERVICE_ROLE, authorization: `Bearer ${SERVICE_ROLE}`, 'content-type': 'application/json' },
      body: JSON.stringify(args),
    });
    if (!res.ok) return null;   // not installed yet (the migration), or a failure: no push, nothing breaks
    return await res.json();
  } catch {
    return null;
  }
}

async function forgetDevices(ids: string[]) {
  try {
    const list = ids.filter((x) => /^[0-9a-f-]{36}$/i.test(x)).join(',');
    if (!list) return;
    await fetch(`${SUPABASE_URL}/rest/v1/push_devices?id=in.(${list})`, {
      method: 'DELETE',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { apikey: SERVICE_ROLE, authorization: `Bearer ${SERVICE_ROLE}` },
    });
  } catch { /* the next send tries again */ }
}
