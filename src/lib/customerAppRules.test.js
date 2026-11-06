// src/lib/customerAppRules.test.js: the customer app gateway rules (6 Nov 2026).
// The pure half of supabase/functions/customer-app: refresh token shape and hash, the rotation
// decision, the delete report, the venue row, the tenant id pattern and the theme check.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TENANT_ID_RE, isTenantId, isUuid, base64url, refreshTokenFromBytes, refreshTokenLooksValid, hashRefreshToken,
  refreshDecision, REFRESH_WORDS, REFRESH_MIN_GAP_MS, REFRESH_TTL_DAYS, ACCESS_TTL_SECONDS, cleanDevice, expiresAtFrom,
  DELETE_CONFIRM_WORD, DELETE_PLACEHOLDER_NAME, deleteReport, KEPT_RECORDS, isNotReadyError,
  isVenueShown, orderingUrl, addressLines, venueStatus, mapVenue, mapVenues, pickCompanyId,
  themePayload, validateTenantPayload, THEME_MAX_AGE_SECONDS, ACTIONS, PUBLIC_ACTIONS, SESSION_ACTIONS,
} from './customerAppRules.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'supabase/functions/_shared/tenantAppSchema.json'), 'utf8'));

const mozz = {
  tenantId: 'mozz', displayName: 'MOZZ', version: 1, bundleId: 'uk.co.servos.mozz',
  logo: { light: 'https://cdn.servos.example/mozz/mark-dark.svg', dark: 'https://cdn.servos.example/mozz/mark-light.svg' },
  icon: 'https://cdn.servos.example/mozz/icon-1024.png',
  color: { accent: '#A6412F', onAccent: '#FFFFFF', ink: '#14110F', inkMuted: '#6B625C', surface: '#FFFFFF', sunken: '#F5F2F0', line: '#E2DBD6' },
  type: { display: 'Instrument Serif', body: 'Schibsted Grotesk' },
  shape: { radius: 26 }, currency: 'GBP', locale: 'en-GB',
  modules: { ordering: true, stamps: true, giftCards: true },
  support: { privacyUrl: 'https://example.com/privacy', supportUrl: 'https://example.com/support', termsUrl: 'https://example.com/terms' },
};

// ── Tenant id ────────────────────────────────────────────────────────────
test('tenant id: the schema pattern, two to 32 characters, lower case, starts with a letter', () => {
  assert.equal(TENANT_ID_RE.source, schema.properties.tenantId.pattern, 'the same pattern as the app schema');
  for (const ok of ['mozz', 'coffee-boy', 'a1', 'x'.repeat(32)]) assert.ok(isTenantId(ok), ok);
  for (const bad of ['', 'M', 'Mozz', '1abc', 'a', 'x'.repeat(33), 'mozz app', 'mozz_1', null, 7, 'mozz;drop']) assert.ok(!isTenantId(bad), String(bad));
});

test('uuid check', () => {
  assert.ok(isUuid('aaaaaaaa-0000-4000-8000-00000000000a'));
  assert.ok(!isUuid('not-a-uuid') && !isUuid(null) && !isUuid(''));
});

// ── Refresh tokens ───────────────────────────────────────────────────────
test('refresh token: 32 bytes become 43 base64url characters, nothing else is accepted', () => {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = (i * 37 + 251) % 256;
  const token = refreshTokenFromBytes(bytes);
  assert.equal(token.length, 43);
  assert.ok(refreshTokenLooksValid(token));
  assert.ok(!/[+/=]/.test(token), 'url safe, no padding');
  assert.throws(() => refreshTokenFromBytes(new Uint8Array(16)));
  for (const bad of ['', 'a'.repeat(42), 'a'.repeat(44), 'a'.repeat(42) + '+', null, 42, token + '=']) assert.ok(!refreshTokenLooksValid(bad), String(bad));
  assert.equal(base64url(new Uint8Array([251, 255, 254])), '-__-');
});

test('refresh token hash: sha256 hex, the same every time, different tokens different hashes', async () => {
  const h1 = await hashRefreshToken('abc');
  assert.equal(h1, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(await hashRefreshToken('abc'), h1);
  assert.notEqual(await hashRefreshToken('abd'), h1);
  assert.match(h1, /^[0-9a-f]{64}$/);
});

test('rotation decision: live row rotates; reuse revokes the family; ended, expired and too soon are refused', () => {
  const now = Date.parse('2026-11-06T12:00:00Z');
  const live = { id: 'r1', family_id: 'f1', expires_at: '2027-05-01T00:00:00Z', last_used_at: '2026-11-06T11:00:00Z', revoked_at: null, replaced_by: null };
  assert.deepEqual(refreshDecision(live, now), { ok: true, code: 'ok', status: 200, revokeFamily: false });
  assert.deepEqual(refreshDecision(null, now), { ok: false, code: 'not_found', status: 401, revokeFamily: false });
  assert.deepEqual(refreshDecision(undefined, now).code, 'not_found');
  // rotated already and presented again: the attacker (or a stale copy) has the old token
  assert.deepEqual(refreshDecision({ ...live, revoked_at: '2026-11-06T11:30:00Z', replaced_by: 'r2' }, now), { ok: false, code: 'reused', status: 401, revokeFamily: true });
  // ended by sign out or delete: no family revoke needed, nothing else is live
  assert.deepEqual(refreshDecision({ ...live, revoked_at: '2026-11-06T11:30:00Z' }, now), { ok: false, code: 'revoked', status: 401, revokeFamily: false });
  assert.equal(refreshDecision({ ...live, expires_at: '2026-11-06T11:59:59Z' }, now).code, 'expired');
  assert.equal(refreshDecision({ ...live, expires_at: 'garbage' }, now).code, 'expired');
  // one refresh per row per 5 seconds
  const soon = refreshDecision({ ...live, last_used_at: new Date(now - REFRESH_MIN_GAP_MS + 1).toISOString() }, now);
  assert.deepEqual(soon, { ok: false, code: 'too_soon', status: 429, revokeFamily: false });
  assert.ok(refreshDecision({ ...live, last_used_at: new Date(now - REFRESH_MIN_GAP_MS).toISOString() }, now).ok, 'exactly 5 seconds is fine');
  assert.ok(refreshDecision({ ...live, last_used_at: null }, now).ok, 'never used is fine');
  // a last_used_at in the future (clock drift) does not lock the row
  assert.ok(refreshDecision({ ...live, last_used_at: new Date(now + 60000).toISOString() }, now).ok);
  // the order matters: a reused token is reuse even when it is also expired
  assert.equal(refreshDecision({ ...live, revoked_at: 'x', replaced_by: 'r2', expires_at: '2020-01-01T00:00:00Z' }, now).code, 'reused');
  for (const code of ['not_found', 'reused', 'revoked', 'expired', 'too_soon', 'sign_in_again']) assert.ok(REFRESH_WORDS[code], code);
});

test('the numbers the app relies on', () => {
  assert.equal(REFRESH_TTL_DAYS, 180);
  assert.equal(REFRESH_MIN_GAP_MS, 5000);
  assert.equal(ACCESS_TTL_SECONDS, 86400, 'a loyalty-otp token lives 24 hours');
  assert.equal(THEME_MAX_AGE_SECONDS, 60);
  const at = expiresAtFrom(Date.parse('2026-11-06T00:00:00Z'));
  assert.equal(at, '2027-05-05T00:00:00.000Z');
});

test('device: a few short strings, nothing else', () => {
  assert.deepEqual(cleanDevice(null), {});
  assert.deepEqual(cleanDevice('ios'), {});
  assert.deepEqual(cleanDevice([1]), {});
  const d = cleanDevice({ platform: ' ios ', os: 'iOS', osVersion: '18.1', model: 'iPhone16,1', appVersion: '1.0.0', build: 7, locale: 'en-GB', installId: 'x'.repeat(200), evil: { a: 1 }, token: 'secret' });
  assert.deepEqual(Object.keys(d).sort(), ['appVersion', 'installId', 'locale', 'model', 'os', 'osVersion', 'platform']);
  assert.equal(d.platform, 'ios');
  assert.equal(d.installId.length, 80);
  assert.ok(!('token' in d) && !('evil' in d) && !('build' in d));
});

// ── Delete my account ────────────────────────────────────────────────────
test('delete report: both halves joined, numbers never missing, ledgers listed as kept', () => {
  assert.equal(DELETE_CONFIRM_WORD, 'DELETE');
  assert.equal(DELETE_PLACEHOLDER_NAME, 'Deleted customer');
  const ops = { ok: true, customer_id: 'c1', already_deleted: false, customers_updated: 1, personal_columns_cleared: ['name', 'email'], notes_cleared: 2, sessions_revoked: 3 };
  const plat = { ok: true, customer_id: 'c1', memberships_ended: 1, points_forfeited: 450, stamp_cards_ended: 2, stamps_forfeited: 7, referrals_unlinked: 0 };
  const r = deleteReport(ops, plat);
  assert.equal(r.ok, true);
  assert.equal(r.customerId, 'c1');
  assert.equal(r.alreadyDeleted, false);
  assert.deepEqual(r.personal, { customersUpdated: 1, columnsCleared: ['name', 'email'], venueNotesCleared: 2 });
  assert.equal(r.sessionsRevoked, 3);
  assert.deepEqual(r.loyalty, { membershipsEnded: 1, pointsForfeited: 450, stampCardsEnded: 2, stampsForfeited: 7, referralsUnlinked: 0 });
  assert.deepEqual(r.kept, KEPT_RECORDS);
  for (const k of ['closed_checks', 'customer_orders', 'loyalty_transactions', 'stamp_transactions', 'gift_cards']) assert.ok(KEPT_RECORDS.includes(k), k);
  // a second press: nothing left to change, still ok
  const again = deleteReport({ ok: true, customer_id: 'c1', already_deleted: true, customers_updated: 1, personal_columns_cleared: [], notes_cleared: 0, sessions_revoked: 0 }, { ok: true, memberships_ended: 0, points_forfeited: 0, stamp_cards_ended: 0, stamps_forfeited: 0 });
  assert.equal(again.ok, true);
  assert.equal(again.alreadyDeleted, true);
  // the Ops side said not found
  assert.equal(deleteReport({ ok: false, code: 'not_found' }, plat).ok, false);
  assert.equal(deleteReport(null, null).ok, false);
  assert.equal(deleteReport(null, null).sessionsRevoked, 0);
});

test('not ready: a missing function or table is the migration not run, anything else is not', () => {
  assert.ok(isNotReadyError({ code: '42883', message: 'function public.customer_app_delete_account(uuid) does not exist' }));
  assert.ok(isNotReadyError({ code: 'PGRST202', message: 'Could not find the function public.customer_app_end_loyalty(p_customer_id) in the schema cache' }));
  assert.ok(isNotReadyError({ code: 'PGRST205', message: "Could not find the table 'public.customer_app_sessions' in the schema cache" }));
  assert.ok(isNotReadyError({ code: '42P01', message: 'relation "public.tenant_app_config" does not exist' }));
  assert.ok(!isNotReadyError({ code: '23505', message: 'duplicate key value violates unique constraint' }));
  assert.ok(!isNotReadyError(null));
  assert.ok(!isNotReadyError({ message: 'customer id required' }));
});

// ── Venues ───────────────────────────────────────────────────────────────
const opsA = { id: 'l1', name: 'Alpha One', address: '12 High St, Leeds, LS1 1AA', timezone: 'Europe/London', currency: 'gbp', status: 'active', is_demo: false, receipt_branding: { header: { phone: '+44 113 000 0000', address_lines: ['12 High Street', 'Leeds LS1 1AA'] } } };
const platA = { id: 'p1', ops_location_id: 'l1', company_id: 'cccccccc-0000-4000-8000-000000000001', name: 'Alpha One', address: null, timezone: 'Europe/London', currency: 'GBP', opening_hours: { weekly: { mon: [{ open: '09:00', close: '17:00' }], tue: [], wed: [], thu: [], fri: [{ open: '18:00', close: '02:00' }], sat: [{ open: '09:00', close: '17:00' }], sun: [] }, closedDates: ['2026-12-25'] }, online_slug: 'alpha-one', online_enabled: true, latitude: 53.8, longitude: -1.55 };

test('only a live, non demo venue is shown', () => {
  assert.ok(isVenueShown(opsA));
  assert.ok(isVenueShown({ id: 'x', status: null }), 'no status means active (the column default)');
  assert.ok(!isVenueShown({ ...opsA, is_demo: true }));
  assert.ok(!isVenueShown({ ...opsA, status: 'inactive' }));
  assert.ok(!isVenueShown({ ...opsA, status: 'archived' }));
  assert.ok(!isVenueShown(null));
});

test('ordering URL: the public slug host when ordering is on, else none', () => {
  assert.equal(orderingUrl(platA), 'https://alpha-one.serv-os.app/');
  assert.equal(orderingUrl(platA, 'dev.serv-os.app'), 'https://alpha-one.dev.serv-os.app/');
  assert.equal(orderingUrl({ ...platA, online_enabled: false }), null);
  assert.equal(orderingUrl({ ...platA, online_slug: null }), null);
  assert.equal(orderingUrl({ ...platA, online_slug: 'Bad Slug' }), null, 'a slug that is not a host label is never built into a URL');
  assert.equal(orderingUrl(null), null);
});

test('address lines: the receipt branding lines first, else the address split', () => {
  assert.deepEqual(addressLines(opsA, platA), ['12 High Street', 'Leeds LS1 1AA']);
  assert.deepEqual(addressLines({ ...opsA, receipt_branding: null }, platA), ['12 High St', 'Leeds', 'LS1 1AA']);
  assert.deepEqual(addressLines({ ...opsA, receipt_branding: { header: { address_lines: [] } }, address: '1 Road\nTown' }, null), ['1 Road', 'Town']);
  assert.deepEqual(addressLines({ id: 'x' }, { address: '5 Lane, Town' }), ['5 Lane', 'Town']);
  assert.deepEqual(addressLines({ id: 'x' }, null), []);
});

test('venue status on the venue clock: open, closed, overnight, closed date, unknown', () => {
  const h = platA.opening_hours;
  // Monday 2 Nov 2026 10:00 London (GMT) = 10:00Z: open
  assert.equal(venueStatus(h, 'Europe/London', new Date('2026-11-02T10:00:00Z')), 'open');
  assert.equal(venueStatus(h, 'Europe/London', new Date('2026-11-02T17:00:00Z')), 'closed', 'close is exclusive');
  assert.equal(venueStatus(h, 'Europe/London', new Date('2026-11-03T10:00:00Z')), 'closed', 'Tuesday has no window');
  // Friday overnight 18:00 to 02:00: Friday 23:30 open, Saturday 01:30 open, Saturday 02:30 closed (Saturday opens at 09:00)
  assert.equal(venueStatus(h, 'Europe/London', new Date('2026-11-06T23:30:00Z')), 'open');
  assert.equal(venueStatus(h, 'Europe/London', new Date('2026-11-07T01:30:00Z')), 'open');
  assert.equal(venueStatus(h, 'Europe/London', new Date('2026-11-07T02:30:00Z')), 'closed');
  // the venue clock, not UTC: Monday 09:30 in Los Angeles is 17:30Z
  assert.equal(venueStatus(h, 'America/Los_Angeles', new Date('2026-11-02T17:30:00Z')), 'open');
  assert.equal(venueStatus(h, 'Europe/London', new Date('2026-11-02T17:30:00Z')), 'closed');
  // a closed date wins
  assert.equal(venueStatus({ ...h, weekly: { ...h.weekly, fri: [{ open: '09:00', close: '17:00' }] } }, 'Europe/London', new Date('2026-12-25T10:00:00Z')), 'closed');
  assert.equal(venueStatus(null, 'Europe/London'), 'unknown');
  assert.equal(venueStatus({}, 'Europe/London'), 'unknown');
  assert.equal(venueStatus({ weekly: { mon: [{ open: 'x', close: 'y' }] } }, 'Europe/London', new Date('2026-11-02T10:00:00Z')), 'closed', 'a broken window is not open');
  assert.equal(venueStatus(h, 'Not/AZone', new Date('2026-11-02T10:00:00Z')), 'open', 'an unreadable zone falls back to London');
});

test('venue row: the fields the app shows, nothing it should not see', () => {
  const v = mapVenue(opsA, platA, { now: new Date('2026-11-02T10:00:00Z') });
  assert.deepEqual(v, {
    id: 'l1', name: 'Alpha One', addressLines: ['12 High Street', 'Leeds LS1 1AA'], phone: '+44 113 000 0000',
    openingHours: platA.opening_hours, timezone: 'Europe/London', currency: 'GBP', status: 'open',
    latitude: 53.8, longitude: -1.55, orderingUrl: 'https://alpha-one.serv-os.app/',
  });
  assert.ok(!('receipt_branding' in v) && !('company_id' in v) && !('org_id' in v));
  // no Platform row: still a venue, with what Ops knows
  const bare = mapVenue({ id: 'l2', name: 'Beta', address: 'Somewhere', timezone: null, currency: null, status: 'active' }, null);
  assert.deepEqual(bare, { id: 'l2', name: 'Beta', addressLines: ['Somewhere'], phone: null, openingHours: null, timezone: 'Europe/London', currency: 'GBP', status: 'unknown', latitude: null, longitude: null, orderingUrl: null });
});

test('venues: demo and inactive left out, matched to the Platform row by ops_location_id, sorted by name', () => {
  const ops = [
    { ...opsA, id: 'l1', name: 'Zed' },
    { ...opsA, id: 'l2', name: 'Alpha', is_demo: true },
    { ...opsA, id: 'l3', name: 'Mid', status: 'inactive' },
    { ...opsA, id: 'l4', name: 'Beta', receipt_branding: null },
  ];
  const plat = [{ ...platA, ops_location_id: 'l4', online_slug: 'beta' }, { ...platA, ops_location_id: 'l9', online_slug: 'other' }];
  const out = mapVenues(ops, plat, { now: new Date('2026-11-02T10:00:00Z') });
  assert.deepEqual(out.map((v) => v.name), ['Beta', 'Zed']);
  assert.equal(out[0].orderingUrl, 'https://beta.serv-os.app/');
  assert.equal(out[0].phone, null);
  assert.equal(out[1].orderingUrl, null, 'no Platform row for l1 in this set');
  assert.deepEqual(mapVenues([], []), []);
});

test('the company loyalty-otp wants: the most common company_id of the linked venues', () => {
  const c1 = 'cccccccc-0000-4000-8000-000000000001';
  const c2 = 'cccccccc-0000-4000-8000-000000000002';
  assert.equal(pickCompanyId([{ company_id: c1 }, { company_id: c2 }, { company_id: c1 }]), c1);
  assert.equal(pickCompanyId([{ company_id: c2 }]), c2);
  assert.equal(pickCompanyId([{ company_id: 'junk' }, {}]), null);
  assert.equal(pickCompanyId([]), null);
  assert.equal(pickCompanyId(null), null);
});

// ── Theme ────────────────────────────────────────────────────────────────
test('theme payload: the row tenant id and version always win over the json', () => {
  const p = themePayload({ tenant_id: 'mozz', version: 4, payload: { ...mozz, tenantId: 'other', version: 99 } });
  assert.equal(p.tenantId, 'mozz');
  assert.equal(p.version, 4);
  assert.equal(p.displayName, 'MOZZ');
  assert.deepEqual(themePayload({ tenant_id: 't', version: null, payload: null }), { tenantId: 't', version: 1 });
  assert.deepEqual(themePayload({ tenant_id: 't', version: 2, payload: [1] }), { tenantId: 't', version: 2 });
});

test('theme check: the example tenant passes, every kind of bad row is refused', () => {
  assert.deepEqual(validateTenantPayload(schema, mozz), { ok: true, errors: [] });
  // the app repo copy, when it is on this machine, is the same schema
  const appCopy = path.join(os.homedir(), 'Desktop/servos-customer-app/schemas/tenant.schema.json');
  if (fs.existsSync(appCopy)) assert.deepEqual(JSON.parse(fs.readFileSync(appCopy, 'utf8')), schema, 'the _shared copy matches the app repo');
  const bad = (patch) => validateTenantPayload(schema, { ...mozz, ...patch });
  assert.ok(!bad({ color: { ...mozz.color, accent: 'red' } }).ok, 'a colour must be a hex');
  assert.ok(!bad({ type: { display: 'Comic Sans', body: 'Figtree' } }).ok, 'a font outside the list');
  assert.ok(!bad({ shape: { radius: 40 } }).ok, 'radius above the maximum');
  assert.ok(!bad({ shape: { radius: 20.5 } }).ok, 'radius must be an integer');
  assert.ok(!bad({ currency: 'gbp' }).ok);
  assert.ok(!bad({ locale: 'en' }).ok);
  assert.ok(!bad({ displayName: '' }).ok, 'a name is required');
  assert.ok(!bad({ displayName: 'x'.repeat(31) }).ok, 'a name over 30 characters');
  assert.ok(!bad({ logo: { light: 'not a url', dark: mozz.logo.dark } }).ok);
  assert.ok(!bad({ modules: { ordering: true, stamps: 'yes', giftCards: true } }).ok);
  assert.ok(!bad({ modules: { ordering: true, stamps: true } }).ok, 'giftCards is required');
  assert.ok(!bad({ extra: 1 }).ok, 'no extra keys at the top');
  assert.ok(!bad({ support: { privacyUrl: 'https://x.y', other: 'z' } }).ok, 'no extra keys inside');
  assert.ok(!bad({ tenantId: 'Bad' }).ok);
  assert.ok(!bad({ version: 0 }).ok);
  assert.ok(!bad({ bundleId: 'UK.co' }).ok);
  const omit = (obj, keys) => Object.fromEntries(Object.entries(obj).filter(([k]) => !keys.includes(k)));
  assert.ok(!validateTenantPayload(schema, omit(mozz, ['logo'])).ok, 'logo is required');
  assert.ok(!validateTenantPayload(schema, null).ok);
  assert.ok(!validateTenantPayload(schema, 'mozz').ok);
  // support is optional, version and bundleId too
  assert.ok(validateTenantPayload(schema, omit(mozz, ['support', 'version', 'bundleId'])).ok);
  // errors say where
  const e = bad({ color: { ...mozz.color, accent: 'red' } }).errors;
  assert.ok(e.some((m) => m.startsWith('payload.color.accent')), e.join('; '));
});

test('the action lists', () => {
  assert.deepEqual(PUBLIC_ACTIONS, ['theme', 'tenant', 'venues']);
  assert.deepEqual(SESSION_ACTIONS, ['session_start', 'session_refresh', 'session_end', 'delete_account']);
  assert.equal(ACTIONS.length, 7);
});
