// src/lib/customerAppWiring.test.js: the customer app gateway, the wiring (6 Nov 2026).
// Reads the source and pins the shape that keeps it safe: the function never trusts a customer
// id from the body (every member action derives it from a verified token or a refresh token's
// row), mints the access token with loyalty-otp's own module and secret, touches no existing
// function; the SQL is ASCII, has no begin or commit, grants only to the service role, and the
// rollback twins exist. loyalty-otp itself is byte for byte what it was on main.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const count = (s, needle) => s.split(needle).length - 1;
const between = (s, from, to) => { const a = s.indexOf(from); const b = s.indexOf(to, a); return a >= 0 && b > a ? s.slice(a, b) : ''; };

const FN = 'supabase/functions/customer-app/index.ts';
const OPS = 'supabase/migrations/20261126a_OPS_customer_app.sql';
const PLAT = 'supabase/migrations/20261126b_PLATFORM_customer_app.sql';
const SQL_FILES = [OPS, OPS.replace('.sql', '_ROLLBACK.sql'), PLAT, PLAT.replace('.sql', '_ROLLBACK.sql')];

test('the function never trusts a customer id from the body', () => {
  const fn = read(FN);
  const code = fn.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
  for (const bad of ['body.customer_id', 'body.customerId', "body['customer_id']", 'body.company_id', 'body.companyId', 'body.orgId', 'body.org_id']) {
    assert.equal(count(code, bad), 0, `never reads ${bad}`);
  }
  // every member action goes through the token or the refresh token's row
  assert.ok(fn.includes('const session = await verifySessionToken(token, OTP_SECRET);'));
  assert.ok(fn.includes(".eq('id', session.customerId)"), 'the customer is read by the token id');
  assert.ok(fn.includes('const customerId = member.session.customerId;'), 'delete uses the token id');
  assert.ok(fn.includes("await platformAdmin.rpc('customer_app_end_loyalty', { p_customer_id: customerId })"));
  assert.ok(fn.includes("await opsAdmin.rpc('customer_app_delete_account', { p_customer_id: customerId })"));
  assert.ok(fn.includes("customer_id: session.customerId,"), 'session_start stores the token id');
  assert.ok(fn.includes("customer_id: row.customer_id,"), 'session_refresh carries the row id');
  // the refresh token is looked up by its hash only, never stored or compared raw
  assert.ok(fn.includes(".eq('refresh_token_hash', hash)"));
  assert.equal(count(code, 'refresh_token_hash: fresh.hash'), 2, 'start and refresh both store the hash');
  assert.equal(count(code, 'refresh_token_hash: presented'), 0);
  assert.equal(count(code, 'refresh_token_hash: token'), 0);
  // the delete needs the word, before anything is read
  const del = between(fn, 'async function deleteAccount', 'async function tenantRow');
  assert.ok(del.indexOf('body.confirm !== DELETE_CONFIRM_WORD') < del.indexOf('await memberFromToken(body.token)'));
  // Platform first, Ops second
  assert.ok(del.indexOf("rpc('customer_app_end_loyalty'") < del.indexOf("rpc('customer_app_delete_account'"));
});

test('the access token IS a loyalty-otp session token: same module, same secret, same env names', () => {
  const fn = read(FN);
  const otp = read('supabase/functions/loyalty-otp/index.ts');
  assert.ok(fn.includes("import { createSessionToken, verifySessionToken } from '../_shared/loyalty-session.ts';"));
  const secretLine = "const OTP_SECRET = Deno.env.get('OTP_HMAC_SECRET') ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? 'fallback-secret';";
  assert.ok(fn.includes(secretLine), 'the same secret line as loyalty-otp');
  assert.ok(otp.includes(secretLine));
  assert.ok(otp.includes("from '../_shared/loyalty-session.ts';"), 'loyalty-otp mints with the shared module too');
  assert.ok(fn.includes('await createSessionToken(row.customer_id, row.company_id, cust.phone || null, OTP_SECRET)'));
  assert.ok(fn.includes("Deno.env.get('PLATFORM_SUPABASE_URL')") && fn.includes("Deno.env.get('PLATFORM_SUPABASE_SERVICE_ROLE_KEY')"));
  assert.ok(fn.includes('expiresIn: ACCESS_TTL_SECONDS'));
});

test('rotation: the old row is closed only while live, the family goes on reuse, one refresh per 5 seconds', () => {
  const fn = read(FN);
  const r = between(fn, 'async function sessionRefresh', 'async function sessionEnd');
  assert.ok(r.includes('const decision = refreshDecision(row, nowMs);'));
  assert.ok(r.includes('if (decision.revokeFamily && row?.family_id) {'));
  assert.ok(r.includes(".eq('id', row.id)\n    .is('revoked_at', null)\n    .select('id');"), 'the close is conditional on the row being live');
  assert.ok(r.includes('if (!closed || closed.length === 0) {\n    await revokeFamily(row.family_id);'), 'a race loser is a reuse');
  assert.ok(r.includes("family_id: row.family_id,"), 'the new row joins the family');
  assert.ok(r.includes(".update({ replaced_by: next.id }).eq('id', row.id)"), 'the old row points at the new one');
  // a deleted member ends the family before anything is minted
  assert.ok(r.indexOf('if (!cust || cust.deleted_at) {') < r.indexOf('const fresh = await newRefreshToken();'));
  const rules = read('supabase/functions/_shared/customerAppRules.js');
  assert.ok(rules.includes('export const REFRESH_MIN_GAP_MS = 5000;'));
  assert.ok(rules.includes('export const REFRESH_TTL_DAYS = 180;'));
});

test('public actions need a tenant id that matches the pattern and read with the service role; the theme is checked on the way out and cached a minute', () => {
  const fn = read(FN);
  assert.equal(count(fn, 'if (!isTenantId(tenantId)) return'), 2, 'tenantRow and theme both check it');
  assert.ok(fn.includes("import tenantSchema from '../_shared/tenantAppSchema.json' with { type: 'json' };"));
  assert.ok(fn.includes('const check = validateTenantPayload(tenantSchema, payload);'));
  assert.ok(fn.includes("return json({ error: 'No theme for this tenant yet.', code: 'no_theme' }, 404);"));
  assert.ok(fn.includes("{ 'Cache-Control': `public, max-age=${THEME_MAX_AGE_SECONDS}` }"));
  assert.ok(fn.includes("return json({ error: 'The theme for this tenant is not valid yet.', code: 'theme_invalid', errors: check.errors.slice(0, 10) }, 500);"));
  // venues: only live, non demo rows (the rule) and the Platform row by ops_location_id
  assert.ok(fn.includes("select('id, name, address, timezone, currency, status, is_demo, receipt_branding')"));
  assert.ok(fn.includes(".in('ops_location_id', ids)"));
  assert.ok(fn.includes('mapVenues(v.opsRows, v.platformRows, { root: CUSTOMER_ROOT, now: new Date() })'));
  assert.ok(fn.includes('companyId: pickCompanyId(v.platformRows),'));
  // no anon client anywhere: every read is the service role, every row fenced by the code above
  assert.equal(count(fn, 'SUPABASE_ANON_KEY'), 0);
  assert.equal(count(fn, 'createClient('), 2);
});

test('the shared schema copy is the app schema and the rules module is re-exported for the app', () => {
  const schema = JSON.parse(read('supabase/functions/_shared/tenantAppSchema.json'));
  assert.equal(schema.properties.tenantId.pattern, '^[a-z][a-z0-9-]{1,31}$');
  assert.deepEqual(schema.required, ['tenantId', 'displayName', 'logo', 'color', 'type', 'shape', 'currency', 'locale', 'modules']);
  assert.ok(read('src/lib/customerAppRules.js').includes("export * from '../../supabase/functions/_shared/customerAppRules.js';"));
});

test('the SQL: ASCII, no begin or commit, no dashes as punctuation, service role only, a visible check, rollback twins', () => {
  for (const rel of SQL_FILES) {
    const sql = read(rel);
    assert.ok([...sql].every((ch) => ch.charCodeAt(0) < 128), `${rel} is ASCII`);
    assert.equal(count(sql.toLowerCase(), '\nbegin;'), 0, `${rel} has no begin;`);
    assert.equal(count(sql.toLowerCase(), '\ncommit;'), 0, `${rel} has no commit;`);
    assert.ok(!/^\s*(begin|commit)\s*;/im.test(sql), `${rel} has no transaction lines`);
    assert.ok(sql.includes("notify pgrst, 'reload schema';"), `${rel} reloads the API schema`);
    assert.ok(/-- VISIBLE CHECK/.test(sql), `${rel} ends with a visible check`);
    assert.ok(sql.trimEnd().split('\n').slice(-40).join('\n').includes('select'), `${rel} ends with a select`);
    assert.equal(count(sql, ' - '), 0, `${rel} no dash punctuation`);
  }
  for (const rel of [OPS, PLAT]) {
    const sql = read(rel);
    assert.ok(/raise exception 'This is not the (Ops|Platform) database/.test(sql), `${rel} guards the project`);
    assert.ok(sql.includes('security definer'), `${rel} has the definer function`);
    assert.ok(sql.includes('set search_path = public, pg_temp'), `${rel} pins search_path`);
    assert.ok(!/grant .* to (anon|authenticated|public)\b/i.test(sql), `${rel} grants nothing to anon, authenticated or public`);
    assert.ok(/grant execute on function public\.customer_app_[a-z_]+\(uuid\) to service_role;/.test(sql), `${rel} grants execute to service_role only`);
  }
  const ops = read(OPS);
  for (const f of ['customer_app_delete_account(uuid)']) {
    assert.ok(ops.includes(`revoke all on function public.${f} from public, anon, authenticated;`));
    assert.ok(ops.includes(`grant execute on function public.${f} to service_role;`));
  }
  assert.ok(ops.includes('create table if not exists public.customer_app_sessions ('));
  assert.ok(ops.includes('create table if not exists public.tenant_app_config ('));
  for (const t of ['customer_app_sessions', 'tenant_app_config']) {
    assert.ok(ops.includes(`alter table public.${t} enable row level security;`), `${t} has RLS on`);
    assert.ok(ops.includes(`revoke all on table public.${t} from public, anon, authenticated;`), `${t} is revoked from the public key`);
    assert.equal(count(ops, `create policy`), 0, 'no policy: nothing reaches the public key');
  }
  assert.ok(ops.includes("constraint tenant_app_config_tenant_id_shape check (tenant_id ~ '^[a-z][a-z0-9-]{1,31}$')"));
  assert.ok(ops.includes("constraint customer_app_sessions_hash_shape check (refresh_token_hash ~ '^[0-9a-f]{64}$')"));
  assert.ok(ops.includes("expires_at timestamptz not null default (now() + interval '180 days')"));
  assert.ok(ops.includes('new.version := old.version + 1;'));
  assert.ok(ops.includes("set name = 'Deleted customer',"), 'the fixed placeholder, customers.name is NOT NULL');
  assert.ok(ops.includes('deleted_at = coalesce(deleted_at, now()),'));
  // the ledgers are never written
  const fnBody = between(ops, 'create or replace function public.customer_app_delete_account', '-- ===== Who may call');
  for (const t of ['closed_checks', 'customer_orders', 'loyalty_transactions', 'stamp_transactions', 'gift_cards']) {
    assert.ok(!new RegExp(`(update|delete from) public\\.${t}\\b`).test(fnBody), `${t} is never written`);
  }
  const plat = read(PLAT);
  const platBody = between(plat, 'create or replace function public.customer_app_end_loyalty', '-- ===== Who may call');
  assert.ok(platBody.includes('delete from public.customer_stamp_cards where customer_id = p_customer_id;'));
  assert.ok(platBody.includes('delete from public.customer_loyalty where customer_id = p_customer_id;'));
  assert.ok(!/gift_card/.test(platBody.replace(/'gift_cards', 'gift_card_transactions'/, '')), 'gift cards are never written');
  // the example insert is a comment, so the file seeds nothing
  const example = ops.slice(ops.indexOf('-- ===== EXAMPLE'));
  assert.ok(example.split('\n').every((l) => l.trim() === '' || l.startsWith('--')), 'every example line is a comment');
  assert.ok(example.includes("'mozz',"));
  // the rollback twins
  for (const rel of [OPS, PLAT]) assert.ok(fs.existsSync(path.join(ROOT, rel.replace('.sql', '_ROLLBACK.sql'))), `${rel} has a rollback`);
  assert.ok(read(OPS.replace('.sql', '_ROLLBACK.sql')).includes('drop table if exists public.customer_app_sessions;'));
  assert.ok(read(PLAT.replace('.sql', '_ROLLBACK.sql')).includes('drop function if exists public.customer_app_end_loyalty(uuid);'));
});

test('no em or en dash anywhere in the new files', () => {
  for (const rel of [FN, 'supabase/functions/_shared/customerAppRules.js', 'src/lib/customerAppRules.js', 'src/lib/customerAppRules.test.js', 'src/lib/customerAppWiring.test.js', 'docs/CUSTOMER_APP_GATEWAY.md', 'supabase/tests/customer_app/test_customer_app.py', ...SQL_FILES]) {
    const s = read(rel);
    assert.equal(count(s, String.fromCharCode(0x2014)) + count(s, String.fromCharCode(0x2013)), 0, `${rel} has no dashes`);
  }
});

test('the function is named in the deploy line and in the docs', () => {
  const fn = read(FN);
  assert.ok(fn.includes('npx supabase functions deploy customer-app --project-ref tbetcegmszzotrwdtqhi --no-verify-jwt'));
  const doc = read('docs/CUSTOMER_APP_GATEWAY.md');
  for (const a of ['session_start', 'session_refresh', 'session_end', 'delete_account', 'tenant', 'venues', 'theme']) assert.ok(doc.includes(`\`${a}\``), `docs name ${a}`);
  assert.ok(doc.includes('20261126a_OPS_customer_app.sql') && doc.includes('20261126b_PLATFORM_customer_app.sql'));
});
