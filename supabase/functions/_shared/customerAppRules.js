// supabase/functions/_shared/customerAppRules.js
//
// THE CUSTOMER APP GATEWAY RULES (6 Nov 2026). Pure, no Deno, no network, no Supabase: the
// customer-app edge function imports this file and node:test drives every branch from
// src/lib/customerAppRules.test.js (src/lib/customerAppRules.js re-exports it).
//
// The native customer app (one Expo app themed per tenant) talks to the platform through ONE
// thin additive edge function, customer-app, which adds four things the web loyalty portal
// never needed and changes nothing that exists:
//   1. Sliding sessions: a refresh token good for 180 days, rotated on every use, that mints a
//      brand new loyalty-otp session token (24 hours) so every existing loyalty-otp action keeps
//      working with it.
//   2. Delete my account (Peter, 18 Sep 2026): wipe personal data, end the membership and the
//      stamps, keep the sales and gift ledgers.
//   3. Venues: the organisation's live, non demo venues, with the public ordering URL.
//   4. Theme: the tenant payload the app paints itself with, validated against the app's own
//      schema (tenantAppSchema.json) so a bad row never reaches a phone.
//
// Only Web Crypto is used (global in Deno and in Node), for the refresh token hash.

// ── Tenant id ────────────────────────────────────────────────────────────
// The same pattern as the app's schema (tenantId) and the tenant_app_config check constraint.
export const TENANT_ID_RE = /^[a-z][a-z0-9-]{1,31}$/;
export function isTenantId(v) {
  return typeof v === 'string' && TENANT_ID_RE.test(v);
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(v) {
  return typeof v === 'string' && UUID_RE.test(v);
}

// ── Refresh tokens ───────────────────────────────────────────────────────
// 32 random bytes, base64url (43 characters, no padding). Only the sha256 hex of the token is
// stored, so a copy of the table cannot sign anyone in.
export const REFRESH_TOKEN_BYTES = 32;
export const REFRESH_TTL_DAYS = 180;
export const REFRESH_MIN_GAP_MS = 5000;
// The access token is a loyalty-otp session token: 24 hours, the same TTL loyalty-session.ts has.
export const ACCESS_TTL_SECONDS = 24 * 60 * 60;
export const REFRESH_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
export const HASH_RE = /^[0-9a-f]{64}$/;

export function base64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A new refresh token from the given random bytes (crypto.getRandomValues in the function). */
export function refreshTokenFromBytes(bytes) {
  if (!bytes || bytes.length !== REFRESH_TOKEN_BYTES) throw new Error(`refresh token needs ${REFRESH_TOKEN_BYTES} random bytes`);
  return base64url(bytes);
}

export function refreshTokenLooksValid(v) {
  return typeof v === 'string' && REFRESH_TOKEN_RE.test(v);
}

/** sha256 hex of the refresh token: the only form the database ever holds. */
export async function hashRefreshToken(token) {
  const data = new TextEncoder().encode(String(token));
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * What to do with the row a refresh token hashed to. Pure: the function reads the row, asks
 * here, then writes. Codes:
 *   not_found  no row for that hash                               401
 *   reused     the row was rotated already: the OLD token is back  401, revoke the whole family
 *   revoked    ended by session_end, delete_account or a reuse     401
 *   expired    past its 180 days                                   401
 *   too_soon   used again within 5 seconds                         429
 *   ok         rotate it
 */
export function refreshDecision(row, nowMs = Date.now()) {
  if (!row) return { ok: false, code: 'not_found', status: 401, revokeFamily: false };
  if (row.revoked_at) {
    if (row.replaced_by) return { ok: false, code: 'reused', status: 401, revokeFamily: true };
    return { ok: false, code: 'revoked', status: 401, revokeFamily: false };
  }
  const exp = Date.parse(row.expires_at);
  if (!Number.isFinite(exp) || exp <= nowMs) return { ok: false, code: 'expired', status: 401, revokeFamily: false };
  const last = row.last_used_at ? Date.parse(row.last_used_at) : NaN;
  if (Number.isFinite(last) && nowMs - last < REFRESH_MIN_GAP_MS && nowMs - last >= 0) {
    return { ok: false, code: 'too_soon', status: 429, revokeFamily: false };
  }
  return { ok: true, code: 'ok', status: 200, revokeFamily: false };
}

export const REFRESH_WORDS = {
  not_found: 'Please sign in again.',
  reused: 'This sign in was used on another device. Please sign in again.',
  revoked: 'This sign in has ended. Please sign in again.',
  expired: 'This sign in has expired. Please sign in again.',
  too_soon: 'Please wait a moment and try again.',
  sign_in_again: 'Please sign in again.',
};

/** The device description stored with a session: a few short strings, nothing else. */
export const DEVICE_KEYS = ['platform', 'os', 'osVersion', 'model', 'appVersion', 'build', 'locale', 'installId'];
export function cleanDevice(input) {
  const out = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  for (const k of DEVICE_KEYS) {
    const v = input[k];
    if (typeof v === 'string' && v.trim()) out[k] = v.trim().slice(0, 80);
  }
  return out;
}

export function expiresAtFrom(nowMs, days = REFRESH_TTL_DAYS) {
  return new Date(nowMs + days * 24 * 60 * 60 * 1000).toISOString();
}

// ── Delete my account ────────────────────────────────────────────────────
// The two SQL functions (Ops customer_app_delete_account, Platform customer_app_end_loyalty)
// each answer a jsonb report; this joins them into the one shape the app shows.
export const DELETE_CONFIRM_WORD = 'DELETE';
export const DELETE_PLACEHOLDER_NAME = 'Deleted customer';
export const KEPT_RECORDS = ['closed_checks', 'customer_orders', 'loyalty_transactions', 'stamp_transactions', 'gift_cards', 'gift_card_transactions'];

export function deleteReport(ops, platform) {
  const o = ops && typeof ops === 'object' ? ops : {};
  const p = platform && typeof platform === 'object' ? platform : {};
  return {
    ok: o.ok === true && p.ok !== false,
    customerId: o.customer_id || p.customer_id || null,
    alreadyDeleted: o.already_deleted === true,
    personal: {
      customersUpdated: Number(o.customers_updated) || 0,
      columnsCleared: Array.isArray(o.personal_columns_cleared) ? o.personal_columns_cleared : [],
      venueNotesCleared: Number(o.notes_cleared) || 0,
    },
    sessionsRevoked: Number(o.sessions_revoked) || 0,
    loyalty: {
      membershipsEnded: Number(p.memberships_ended) || 0,
      pointsForfeited: Number(p.points_forfeited) || 0,
      stampCardsEnded: Number(p.stamp_cards_ended) || 0,
      stampsForfeited: Number(p.stamps_forfeited) || 0,
      referralsUnlinked: Number(p.referrals_unlinked) || 0,
    },
    kept: KEPT_RECORDS,
  };
}

/** A missing SQL function or table: the migration has not run yet. */
export function isNotReadyError(e) {
  const code = String(e?.code ?? '');
  const msg = String(e?.message ?? '');
  if (code === '42883' || code === '42P01' || code === 'PGRST202' || code === 'PGRST205') return true;
  return /does not exist|schema cache|could not find the (function|table)/i.test(msg);
}

// ── Venues ───────────────────────────────────────────────────────────────
export const DEFAULT_CUSTOMER_ROOT = 'serv-os.app';

/** Only a live, non demo venue of the organisation is shown to the app. */
export function isVenueShown(ops) {
  if (!ops || typeof ops !== 'object') return false;
  if (ops.is_demo === true) return false;
  return String(ops.status || 'active') === 'active';
}

/** The public web ordering URL for a venue, when it has a slug and ordering is on. */
export function orderingUrl(platform, root = DEFAULT_CUSTOMER_ROOT) {
  const slug = typeof platform?.online_slug === 'string' ? platform.online_slug.trim() : '';
  if (!slug || platform?.online_enabled !== true) return null;
  if (!/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(slug)) return null;
  return `https://${slug}.${root}/`;
}

/** Address lines: the receipt branding lines when set, else the address split on commas and new lines. */
export function addressLines(ops, platform) {
  const branded = ops?.receipt_branding?.header?.address_lines;
  if (Array.isArray(branded)) {
    const lines = branded.map((l) => String(l ?? '').trim()).filter(Boolean);
    if (lines.length) return lines;
  }
  const raw = String(ops?.address || platform?.address || '');
  return raw.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
}

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function hhmmToMinutes(s) {
  if (typeof s !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]); const mm = Number(m[2]);
  if (h > 24 || mm > 59) return null;
  return h * 60 + mm;
}

function partsInZone(date, timeZone) {
  try {
    const fmt = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit' });
    const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
    const hh = Number(parts.hour) % 24;
    return {
      weekday: String(parts.weekday || '').toLowerCase().slice(0, 3),
      minutes: hh * 60 + Number(parts.minute),
      isoDate: `${parts.year}-${parts.month}-${parts.day}`,
    };
  } catch {
    return null;
  }
}

/**
 * 'open', 'closed' or 'unknown' (no usable hours) for the venue's opening_hours jsonb
 * ({ weekly: { mon: [{ open, close }] }, closedDates: [] }, the shape src/lib/openingHours.js
 * keeps) at `now` on the venue's own clock. An overnight window (close at or before open) runs
 * into the next day, as the web surfaces read it.
 */
export function venueStatus(hours, timeZone = 'Europe/London', now = new Date()) {
  const weekly = hours && typeof hours === 'object' ? hours.weekly : null;
  if (!weekly || typeof weekly !== 'object') return 'unknown';
  const p = partsInZone(now, timeZone || 'Europe/London') || partsInZone(now, 'Europe/London');
  if (!p) return 'unknown';
  const closedDates = Array.isArray(hours.closedDates) ? hours.closedDates : [];
  if (closedDates.includes(p.isoDate)) return 'closed';
  const todayIdx = DAY_KEYS.indexOf(p.weekday);
  if (todayIdx < 0) return 'unknown';
  const windows = (day) => (Array.isArray(weekly[day]) ? weekly[day] : []);
  for (const w of windows(DAY_KEYS[todayIdx])) {
    const o = hhmmToMinutes(w?.open); const c = hhmmToMinutes(w?.close);
    if (o == null || c == null) continue;
    if (c > o) { if (p.minutes >= o && p.minutes < c) return 'open'; } else if (p.minutes >= o) return 'open';
  }
  // yesterday's overnight window still running
  for (const w of windows(DAY_KEYS[(todayIdx + 6) % 7])) {
    const o = hhmmToMinutes(w?.open); const c = hhmmToMinutes(w?.close);
    if (o == null || c == null) continue;
    if (c <= o && p.minutes < c) return 'open';
  }
  return 'closed';
}

/** One venue row for the app, from the Ops row and (when linked) the Platform row. */
export function mapVenue(ops, platform, { root = DEFAULT_CUSTOMER_ROOT, now = new Date() } = {}) {
  const timezone = String(ops?.timezone || platform?.timezone || 'Europe/London');
  const hours = platform?.opening_hours && typeof platform.opening_hours === 'object' ? platform.opening_hours : null;
  const phone = ops?.receipt_branding?.header?.phone;
  const lat = Number(platform?.latitude); const lng = Number(platform?.longitude);
  return {
    id: ops.id,
    name: String(ops.name || platform?.name || ''),
    addressLines: addressLines(ops, platform),
    phone: typeof phone === 'string' && phone.trim() ? phone.trim() : null,
    openingHours: hours,
    timezone,
    currency: String(ops?.currency || platform?.currency || 'GBP').toUpperCase(),
    status: venueStatus(hours, timezone, now),
    latitude: Number.isFinite(lat) ? lat : null,
    longitude: Number.isFinite(lng) ? lng : null,
    orderingUrl: orderingUrl(platform, root),
  };
}

/** The organisation's venues, in the order the app shows them (by name). */
export function mapVenues(opsRows, platformRows, opts) {
  const byOps = new Map();
  for (const p of platformRows || []) if (p?.ops_location_id) byOps.set(String(p.ops_location_id), p);
  return (opsRows || [])
    .filter(isVenueShown)
    .map((o) => mapVenue(o, byOps.get(String(o.id)) || null, opts))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The Platform company loyalty-otp wants as company_id: the company the organisation's venues
 * are linked to (loginOrg walks the other way: company, first Platform venue, Ops org). The
 * most common company_id wins; a lone org with no linked venue has none.
 */
export function pickCompanyId(platformRows) {
  const counts = new Map();
  for (const r of platformRows || []) {
    const id = r?.company_id;
    if (!isUuid(id)) continue;
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  let best = null; let n = 0;
  for (const [id, c] of counts) if (c > n) { best = id; n = c; }
  return best;
}

// ── Theme ────────────────────────────────────────────────────────────────
/** The payload as the app receives it: the row's tenant id and version always win. */
export function themePayload(row) {
  const base = row?.payload && typeof row.payload === 'object' && !Array.isArray(row.payload) ? row.payload : {};
  return { ...base, tenantId: row?.tenant_id, version: Number(row?.version) || 1 };
}

export const THEME_MAX_AGE_SECONDS = 60;

// A small JSON schema checker for the keywords tenant.schema.json uses: type, required,
// properties, additionalProperties false, pattern, enum, minLength, maxLength, minimum,
// maximum, format uri and $ref into $defs. Anything else in a schema is ignored.
function resolveRef(schema, root) {
  if (schema && typeof schema.$ref === 'string') {
    const m = /^#\/\$defs\/([A-Za-z0-9_-]+)$/.exec(schema.$ref);
    const target = m ? root?.$defs?.[m[1]] : null;
    return target || {};
  }
  return schema || {};
}

function typeOk(type, v) {
  switch (type) {
    case 'object': return v !== null && typeof v === 'object' && !Array.isArray(v);
    case 'array': return Array.isArray(v);
    case 'string': return typeof v === 'string';
    case 'integer': return Number.isInteger(v);
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'boolean': return typeof v === 'boolean';
    case 'null': return v === null;
    default: return true;
  }
}

function check(schema, v, at, root, errors) {
  const s = resolveRef(schema, root);
  if (s.type) {
    const types = Array.isArray(s.type) ? s.type : [s.type];
    if (!types.some((t) => typeOk(t, v))) { errors.push(`${at}: expected ${types.join(' or ')}`); return; }
  }
  if (Array.isArray(s.enum) && !s.enum.includes(v)) errors.push(`${at}: not one of ${s.enum.join(', ')}`);
  if (typeof v === 'string') {
    if (typeof s.pattern === 'string' && !new RegExp(s.pattern).test(v)) errors.push(`${at}: does not match ${s.pattern}`);
    if (Number.isInteger(s.minLength) && v.length < s.minLength) errors.push(`${at}: shorter than ${s.minLength}`);
    if (Number.isInteger(s.maxLength) && v.length > s.maxLength) errors.push(`${at}: longer than ${s.maxLength}`);
    if (s.format === 'uri' && !/^https?:\/\/[^\s]+$/i.test(v)) errors.push(`${at}: not a URL`);
  }
  if (typeof v === 'number') {
    if (typeof s.minimum === 'number' && v < s.minimum) errors.push(`${at}: below ${s.minimum}`);
    if (typeof s.maximum === 'number' && v > s.maximum) errors.push(`${at}: above ${s.maximum}`);
  }
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const props = s.properties || {};
    for (const key of s.required || []) if (!(key in v)) errors.push(`${at}.${key}: required`);
    for (const [key, val] of Object.entries(v)) {
      if (key in props) check(props[key], val, `${at}.${key}`, root, errors);
      else if (s.additionalProperties === false) errors.push(`${at}.${key}: not allowed`);
    }
  }
}

/** { ok, errors } for a payload against the tenant schema. */
export function validateTenantPayload(schema, payload) {
  const errors = [];
  check(schema, payload, 'payload', schema, errors);
  return { ok: errors.length === 0, errors };
}

/** The public actions (no token) and the member actions (a token or a refresh token). */
export const PUBLIC_ACTIONS = ['theme', 'tenant', 'venues'];
export const SESSION_ACTIONS = ['session_start', 'session_refresh', 'session_end', 'delete_account'];
export const ACTIONS = [...PUBLIC_ACTIONS, ...SESSION_ACTIONS];
