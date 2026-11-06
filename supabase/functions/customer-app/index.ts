// supabase/functions/customer-app/index.ts
//
// THE CUSTOMER APP GATEWAY (6 Nov 2026). One thin, additive edge function for the native
// customer app (one Expo app themed per tenant). It adds the four things the web loyalty portal
// never needed and changes nothing that exists: loyalty-otp, its token and every table it reads
// are untouched. The app still calls loyalty-otp itself for send, verify, refresh and
// update_profile, with the access token this function mints.
//
// Called like loyalty-otp: POST { action, ... } with the public (anon) key. Deploy with
// --no-verify-jwt. No customer id is ever read from the body: every member action derives the
// customer from a verified token (a loyalty-otp session token, or a refresh token's row).
//
// SESSIONS (table customer_app_sessions, Ops, 20261126a)
//   session_start   { token, device? }  token = a live loyalty-otp session token (just issued
//                   by verify). Makes a refresh token row (180 days; only the sha256 is stored).
//                   -> { refreshToken, refreshExpiresAt }
//   session_refresh { refreshToken }    Rotates it (old row revoked and linked by replaced_by,
//                   new row in the same family) and mints a brand new loyalty-otp session token.
//                   -> { accessToken, refreshToken, expiresIn: 86400, refreshExpiresAt }
//                   An old token that was rotated already (reuse) revokes the whole family: 401.
//                   One refresh per row per 5 seconds: 429.
//   session_end     { refreshToken }    Revokes the row. -> { ended: true } (always)
//
// DELETE MY ACCOUNT (Peter, 18 Sep 2026: wipe personal data, end the membership and stamps,
// keep sales and gift ledgers)
//   delete_account  { token, confirm: "DELETE" }
//                   Platform customer_app_end_loyalty (20261126b) ends the membership and the
//                   stamp cards, then Ops customer_app_delete_account (20261126a) clears the
//                   personal fields, sets deleted_at and revokes every app session. The old
//                   loyalty-otp token then finds no customer (refresh checks deleted_at).
//                   -> the report (deleteReport in _shared/customerAppRules.js)
//
// PUBLIC (no token; the tenant id is the app's own slug)
//   tenant  { tenantId } -> { tenantId, orgId, companyId, displayName }   companyId is what
//                           loyalty-otp wants as company_id (loginOrg walks company -> org)
//   venues  { tenantId } -> { venues: [ { id, name, addressLines, phone, openingHours, timezone,
//                           currency, status, latitude, longitude, orderingUrl } ] }
//                           live, non demo venues of the organisation only
//   theme   { tenantId } -> the tenant_app_config payload with tenantId and version from the
//                           row, checked against _shared/tenantAppSchema.json on the way out;
//                           404 { code: "no_theme" } when there is no row;
//                           Cache-Control: public, max-age=60
//
// Errors: { error, code? } with 400 (bad request), 401 (sign in again), 404 (no such tenant or
// theme), 409 not_ready (a database update has not run yet; the file is named), 429 (too soon),
// 500 (the theme row is not valid, or a database refusal).
//
// SQL: 20261126a_OPS_customer_app.sql (Ops), 20261126b_PLATFORM_customer_app.sql (Platform).
// Deploy: npx supabase functions deploy customer-app --project-ref tbetcegmszzotrwdtqhi --no-verify-jwt

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { createSessionToken, verifySessionToken } from '../_shared/loyalty-session.ts';
// @ts-ignore plain JS shared with node tests
import {
  isTenantId, isUuid, refreshTokenFromBytes, refreshTokenLooksValid, hashRefreshToken, refreshDecision,
  REFRESH_WORDS, REFRESH_TOKEN_BYTES, ACCESS_TTL_SECONDS, cleanDevice, expiresAtFrom,
  DELETE_CONFIRM_WORD, deleteReport, isNotReadyError, mapVenues, pickCompanyId, themePayload,
  validateTenantPayload, THEME_MAX_AGE_SECONDS, DEFAULT_CUSTOMER_ROOT,
} from '../_shared/customerAppRules.js';
import tenantSchema from '../_shared/tenantAppSchema.json' with { type: 'json' };

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json', ...extra } });

const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const opsAdmin = createClient(Deno.env.get('SUPABASE_URL') ?? '', SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } });

// The Platform project (loyalty, stamp cards, the Platform venues). Same env names as loyalty-otp and org-admin.
const PLATFORM_URL = Deno.env.get('PLATFORM_SUPABASE_URL') ?? '';
const PLATFORM_KEY = Deno.env.get('PLATFORM_SUPABASE_SERVICE_ROLE_KEY') ?? '';
const platformAdmin = PLATFORM_URL && PLATFORM_KEY
  ? createClient(PLATFORM_URL, PLATFORM_KEY, { auth: { autoRefreshToken: false, persistSession: false } })
  : null;

// The same secret loyalty-otp signs with, read the same way, so the access token minted here IS a
// loyalty-otp session token.
const OTP_SECRET = Deno.env.get('OTP_HMAC_SECRET') ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? 'fallback-secret';
const CUSTOMER_ROOT = Deno.env.get('CUSTOMER_ROOT') || DEFAULT_CUSTOMER_ROOT;

const OPS_NOT_READY = 'This needs the Ops database update 20261126a_OPS_customer_app.sql.';
const PLATFORM_NOT_READY = 'This needs the Platform database update 20261126b_PLATFORM_customer_app.sql.';

const SESSION_COLS = 'id, customer_id, company_id, family_id, device, created_at, last_used_at, expires_at, revoked_at, replaced_by';

const refusal = (e: any, where: 'ops' | 'platform') => {
  if (isNotReadyError(e)) return json({ error: where === 'ops' ? OPS_NOT_READY : PLATFORM_NOT_READY, code: 'not_ready', where }, 409);
  const msg = String(e?.message ?? e ?? '');
  console.error('[customer-app] database refused', where, msg);
  return json({ error: 'Something went wrong. Please try again.', code: 'db_refused', where }, 500);
};

// ── The member behind a loyalty-otp token ────────────────────────────────
// The customer id comes from the signed token and nowhere else. A profile that is gone (joined
// into another by staff, or deleted) means sign in again.
async function memberFromToken(token: unknown) {
  const session = await verifySessionToken(token, OTP_SECRET);
  if (!session || !isUuid(session.customerId) || !isUuid(session.companyId)) return { error: json({ error: REFRESH_WORDS.sign_in_again, code: 'sign_in_again' }, 401) };
  const { data: cust, error } = await opsAdmin
    .from('customers')
    .select('id, phone, deleted_at')
    .eq('id', session.customerId)
    .maybeSingle();
  if (error) return { error: refusal(error, 'ops') };
  if (!cust || cust.deleted_at) return { error: json({ error: REFRESH_WORDS.sign_in_again, code: 'sign_in_again' }, 401) };
  return { session, cust };
}

async function newRefreshToken(): Promise<{ token: string; hash: string }> {
  const bytes = new Uint8Array(REFRESH_TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  const token = refreshTokenFromBytes(bytes);
  return { token, hash: await hashRefreshToken(token) };
}

async function revokeFamily(familyId: string) {
  const { error } = await opsAdmin
    .from('customer_app_sessions')
    .update({ revoked_at: new Date().toISOString() })
    .eq('family_id', familyId)
    .is('revoked_at', null);
  if (error) console.error('[customer-app] revoke family failed', error.message);
}

// ── session_start ────────────────────────────────────────────────────────
async function sessionStart(body: Record<string, unknown>): Promise<Response> {
  const member = await memberFromToken(body.token);
  if ('error' in member) return member.error;
  const { session } = member;
  const fresh = await newRefreshToken();
  const now = Date.now();
  const row = {
    customer_id: session.customerId,
    company_id: session.companyId,
    refresh_token_hash: fresh.hash,
    device: cleanDevice(body.device),
    expires_at: expiresAtFrom(now),
    last_used_at: new Date(now).toISOString(),
  };
  const { data, error } = await opsAdmin.from('customer_app_sessions').insert(row).select('id, expires_at').single();
  if (error) return refusal(error, 'ops');
  return json({ refreshToken: fresh.token, refreshExpiresAt: data.expires_at });
}

// ── session_refresh ──────────────────────────────────────────────────────
async function sessionRefresh(body: Record<string, unknown>): Promise<Response> {
  const presented = body.refreshToken;
  if (!refreshTokenLooksValid(presented)) return json({ error: REFRESH_WORDS.not_found, code: 'not_found' }, 401);
  const hash = await hashRefreshToken(presented as string);
  const { data: row, error } = await opsAdmin.from('customer_app_sessions').select(SESSION_COLS).eq('refresh_token_hash', hash).maybeSingle();
  if (error) return refusal(error, 'ops');

  const nowMs = Date.now();
  const decision = refreshDecision(row, nowMs);
  if (!decision.ok) {
    if (decision.revokeFamily && row?.family_id) {
      console.warn('[customer-app] refresh token reused; family revoked', JSON.stringify({ family_id: row.family_id, customer_id: row.customer_id }));
      await revokeFamily(row.family_id);
    }
    return json({ error: (REFRESH_WORDS as Record<string, string>)[decision.code] || REFRESH_WORDS.sign_in_again, code: decision.code }, decision.status);
  }

  // The member must still exist: a deleted or joined profile ends the family.
  const { data: cust, error: custErr } = await opsAdmin.from('customers').select('id, phone, deleted_at').eq('id', row.customer_id).maybeSingle();
  if (custErr) return refusal(custErr, 'ops');
  if (!cust || cust.deleted_at) {
    await revokeFamily(row.family_id);
    return json({ error: REFRESH_WORDS.sign_in_again, code: 'sign_in_again' }, 401);
  }

  // Rotate. The old row is revoked only if it is still live: two refreshes racing for the same
  // token means the loser finds it revoked already, which is a reuse, and the family goes.
  const nowIso = new Date(nowMs).toISOString();
  const { data: closed, error: closeErr } = await opsAdmin
    .from('customer_app_sessions')
    .update({ revoked_at: nowIso, last_used_at: nowIso })
    .eq('id', row.id)
    .is('revoked_at', null)
    .select('id');
  if (closeErr) return refusal(closeErr, 'ops');
  if (!closed || closed.length === 0) {
    await revokeFamily(row.family_id);
    return json({ error: REFRESH_WORDS.reused, code: 'reused' }, 401);
  }

  const fresh = await newRefreshToken();
  const { data: next, error: insErr } = await opsAdmin
    .from('customer_app_sessions')
    .insert({
      customer_id: row.customer_id,
      company_id: row.company_id,
      family_id: row.family_id,
      refresh_token_hash: fresh.hash,
      device: row.device || {},
      expires_at: expiresAtFrom(nowMs),
      last_used_at: nowIso,
    })
    .select('id, expires_at')
    .single();
  if (insErr) return refusal(insErr, 'ops');
  const { error: linkErr } = await opsAdmin.from('customer_app_sessions').update({ replaced_by: next.id }).eq('id', row.id);
  if (linkErr) console.error('[customer-app] replaced_by link failed', linkErr.message);

  // A brand new loyalty-otp session token for this member: same secret, same format, carrying
  // the phone the row was found by at sign in (update_profile cannot change it), so gift cards
  // match exactly as after verify.
  const accessToken = await createSessionToken(row.customer_id, row.company_id, cust.phone || null, OTP_SECRET);
  return json({ accessToken, refreshToken: fresh.token, expiresIn: ACCESS_TTL_SECONDS, refreshExpiresAt: next.expires_at });
}

// ── session_end ──────────────────────────────────────────────────────────
async function sessionEnd(body: Record<string, unknown>): Promise<Response> {
  const presented = body.refreshToken;
  if (refreshTokenLooksValid(presented)) {
    const hash = await hashRefreshToken(presented as string);
    const { error } = await opsAdmin
      .from('customer_app_sessions')
      .update({ revoked_at: new Date().toISOString() })
      .eq('refresh_token_hash', hash)
      .is('revoked_at', null);
    if (error && isNotReadyError(error)) return refusal(error, 'ops');
    if (error) console.error('[customer-app] session_end failed', error.message);
  }
  return json({ ended: true });
}

// ── delete_account ───────────────────────────────────────────────────────
async function deleteAccount(body: Record<string, unknown>): Promise<Response> {
  if (body.confirm !== DELETE_CONFIRM_WORD) return json({ error: `Send confirm: "${DELETE_CONFIRM_WORD}" to delete the account.`, code: 'confirm_required' }, 400);
  const member = await memberFromToken(body.token);
  if ('error' in member) return member.error;
  const customerId = member.session.customerId;
  if (!platformAdmin) return json({ error: 'The Platform database is not configured for this function.', code: 'not_ready', where: 'platform' }, 409);

  // Platform first (membership and stamps), Ops second (personal fields and sessions): if the
  // Platform step fails nothing personal has changed and the app says so; both steps are no ops
  // on a second run, so pressing Delete again finishes the job.
  const { data: plat, error: platErr } = await platformAdmin.rpc('customer_app_end_loyalty', { p_customer_id: customerId });
  if (platErr) return refusal(platErr, 'platform');
  const { data: ops, error: opsErr } = await opsAdmin.rpc('customer_app_delete_account', { p_customer_id: customerId });
  if (opsErr) return refusal(opsErr, 'ops');
  const report = deleteReport(ops, plat);
  console.log('[customer-app] account deleted', JSON.stringify({ customer_id: customerId, sessions_revoked: report.sessionsRevoked, memberships_ended: report.loyalty.membershipsEnded }));
  return json(report);
}

// ── The tenant row and its organisation ──────────────────────────────────
async function tenantRow(body: Record<string, unknown>) {
  const tenantId = body.tenantId;
  if (!isTenantId(tenantId)) return { error: json({ error: 'tenantId required', code: 'bad_tenant' }, 400) };
  const { data, error } = await opsAdmin
    .from('tenant_app_config')
    .select('tenant_id, org_id, payload, version, updated_at')
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (error) return { error: refusal(error, 'ops') };
  if (!data) return { error: json({ error: 'No such tenant.', code: 'no_tenant' }, 404) };
  return { row: data };
}

async function orgVenues(orgId: string) {
  const { data: opsRows, error } = await opsAdmin
    .from('locations')
    .select('id, name, address, timezone, currency, status, is_demo, receipt_branding')
    .eq('org_id', orgId)
    .limit(200);
  if (error) return { error: refusal(error, 'ops') };
  const ids = (opsRows || []).map((r: any) => r.id);
  let platformRows: any[] = [];
  if (platformAdmin && ids.length) {
    const { data, error: pErr } = await platformAdmin
      .from('locations')
      .select('id, ops_location_id, company_id, name, address, timezone, currency, opening_hours, online_slug, online_enabled, latitude, longitude')
      .in('ops_location_id', ids)
      .limit(200);
    if (pErr) console.error('[customer-app] platform venues unread', pErr.message);
    platformRows = data || [];
  }
  return { opsRows: opsRows || [], platformRows };
}

async function tenant(body: Record<string, unknown>): Promise<Response> {
  const t = await tenantRow(body);
  if ('error' in t) return t.error;
  const v = await orgVenues(t.row.org_id);
  if ('error' in v) return v.error;
  const { data: org } = await opsAdmin.from('organisations').select('name').eq('id', t.row.org_id).maybeSingle();
  const payload = themePayload(t.row);
  return json({
    tenantId: t.row.tenant_id,
    orgId: t.row.org_id,
    companyId: pickCompanyId(v.platformRows),
    displayName: String((payload as any).displayName || org?.name || ''),
  }, 200, { 'Cache-Control': `public, max-age=${THEME_MAX_AGE_SECONDS}` });
}

async function venues(body: Record<string, unknown>): Promise<Response> {
  const t = await tenantRow(body);
  if ('error' in t) return t.error;
  const v = await orgVenues(t.row.org_id);
  if ('error' in v) return v.error;
  return json({ tenantId: t.row.tenant_id, venues: mapVenues(v.opsRows, v.platformRows, { root: CUSTOMER_ROOT, now: new Date() }) });
}

async function theme(body: Record<string, unknown>): Promise<Response> {
  const tenantId = body.tenantId;
  if (!isTenantId(tenantId)) return json({ error: 'tenantId required', code: 'bad_tenant' }, 400);
  const { data, error } = await opsAdmin
    .from('tenant_app_config')
    .select('tenant_id, org_id, payload, version, updated_at')
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (error) return refusal(error, 'ops');
  if (!data) return json({ error: 'No theme for this tenant yet.', code: 'no_theme' }, 404);
  const payload = themePayload(data);
  const check = validateTenantPayload(tenantSchema, payload);
  if (!check.ok) {
    console.error('[customer-app] theme row not valid', JSON.stringify({ tenant_id: data.tenant_id, version: data.version, errors: check.errors.slice(0, 10) }));
    return json({ error: 'The theme for this tenant is not valid yet.', code: 'theme_invalid', errors: check.errors.slice(0, 10) }, 500);
  }
  return json(payload, 200, { 'Cache-Control': `public, max-age=${THEME_MAX_AGE_SECONDS}` });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }
  if (!body || typeof body !== 'object') return json({ error: 'invalid json' }, 400);

  const action = String(body.action ?? '');
  try {
    switch (action) {
      case 'session_start': return await sessionStart(body);
      case 'session_refresh': return await sessionRefresh(body);
      case 'session_end': return await sessionEnd(body);
      case 'delete_account': return await deleteAccount(body);
      case 'tenant': return await tenant(body);
      case 'venues': return await venues(body);
      case 'theme': return await theme(body);
      default:
        return json({ error: 'Unknown action. Use: session_start, session_refresh, session_end, delete_account, tenant, venues, theme' }, 400);
    }
  } catch (e) {
    console.error('[customer-app] crashed', action, String((e as Error)?.message || e));
    return json({ error: 'Something went wrong. Please try again.' }, 500);
  }
});
