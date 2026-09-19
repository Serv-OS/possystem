// src/lib/secondStep/secondStepWiring.test.js
// Static checks that the second sign in step is wired where it must be, and nowhere it must
// not be (docs/SECOND_STEP.md): every edge function that lets a real login act, the shared
// auth helpers, the SQL file for Peter, and the app's login surfaces.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL(`../../../${p}`, import.meta.url), 'utf8');
// Source without // line comments and /* */ blocks, for "the code never does X" checks.
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
const exists = (p) => fs.existsSync(new URL(`../../../${p}`, import.meta.url));

// Every edge function that authorises a real login from its JWT (the 18 Sep authority map,
// plus customer-import, menu-translate, po-send and terminal-job-cancel found while wiring).
export const WIRED_AT_TOP = [
  'adyen-create-session', 'adyen-financial', 'adyen-modify', 'adyen-onboard', 'adyen-terminal-admin', 'adyen-terminal-charge',
  'challenge21-counter', 'create-user', 'customer-import', 'ezcater-connect', 'gift-fulfill',
  'hubrise-catalog-push', 'hubrise-connect', 'hubrise-inventory-push', 'hubrise-order-status',
  'location-admin', 'manager-approve', 'manager-snapshot',
  'marketing-admin', 'marketing-campaigns', 'marketing-compliance', 'marketing-domains', 'marketing-report',
  'marketing-segments', 'marketing-send', 'marketing-workflows',
  'menu-translate', 'owner-snapshot', 'payments-admin', 'payments-onboard', 'payments-processor', 'provision-location',
  'review-admin', 'review-google', 'review-reply', 'review-request', 'review-sync',
  'ryft-create-payment-session', 'ryft-disputes', 'ryft-refund', 'ryft-tab', 'ryft-terminal-cancel',
  'ryft-terminal-debug', 'ryft-terminal-payment', 'ryft-terminal-poll', 'ryft-terminals',
  'send-receipt', 'send-sms', 'send-welcome',
  'stripe-assign-reader-to-pos', 'stripe-cancel-reader-action', 'stripe-create-payment-intent', 'stripe-increment-authorization',
  'stripe-link-merchant', 'stripe-poll-reader-action', 'stripe-process-payment-on-reader', 'stripe-readers-status', 'stripe-refund',
  'stripe-register-network-reader', 'stripe-sync-location-reader-config', 'stripe-terminal-connection-token',
  'stripe-unregister-reader', 'stripe-update-reader-display', 'stripe-upload-reader-splashscreen',
  'terminal-job-cancel', 'terminal-job-charge', 'terminal-job-create', 'terminal-job-status',
  'trading-report', 'uber-direct', 'wifi-admin', 'workforce-clock', 'workforce-compute',
  'xero-bills', 'xero-config', 'xero-connect', 'xero-sales', 'po-send',
];

// Wired through a shared helper instead (authenticateCaller in gift-card-utils / loyalty-utils).
export const WIRED_VIA_AUTHENTICATE_CALLER = [
  'gift-issue', 'gift-bulk-create', 'gift-redeem', 'gift-import', 'gift-void', 'gift-lookup', 'gift-reverse-redeem',
  'gift-config', 'gift-list', 'gift-resend', 'message-templates',
  'loyalty-config', 'loyalty-earn', 'loyalty-member-lookup', 'loyalty-refund', 'loyalty-redeem', 'loyalty-rewards',
];

const CHECK = /const secondStepBlock = await secondStepRefusal\(req\); if \(secondStepBlock\) return secondStepBlock;/;

test('every function that lets a real login act calls the second step check straight after CORS', () => {
  for (const fn of WIRED_AT_TOP) {
    const src = read(`supabase/functions/${fn}/index.ts`);
    assert.match(src, /import \{ secondStepRefusal \} from '\.\.\/_shared\/second-step\.ts';/, `${fn}: import`);
    const lines = src.split('\n');
    const serve = lines.findIndex((l) => /Deno\.serve\(async \(req\) => \{/.test(l));
    assert.ok(serve >= 0, `${fn}: Deno.serve`);
    assert.match(lines[serve + 1], /req\.method === 'OPTIONS'/, `${fn}: preflight first (the browser must still get CORS)`);
    assert.match(lines[serve + 2], CHECK, `${fn}: the check is the very next line`);
  }
});

test('gift and loyalty functions get the check through authenticateCaller', () => {
  for (const file of ['gift-card-utils', 'loyalty-utils']) {
    const src = read(`supabase/functions/_shared/${file}.ts`);
    assert.match(src, /import \{ secondStepRefusal \} from '\.\/second-step\.ts';/, file);
    const fn = src.slice(src.indexOf('export async function authenticateCaller'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    assert.ok(body.indexOf('secondStepRefusal(authHeader)') > body.indexOf('getUser('), `${file}: after the token is proven`);
    assert.match(body, /if \(secondStepBlock\) return secondStepBlock;/, file);
  }
  for (const fn of WIRED_VIA_AUTHENTICATE_CALLER) {
    const src = read(`supabase/functions/${fn}/index.ts`);
    assert.match(src, /authenticateCaller\(req\)/, `${fn} calls authenticateCaller`);
  }
});

test('a password only login gets no venue sending authority (branded email) once enforced', () => {
  const src = read('supabase/functions/_shared/sending-domain.ts');
  assert.match(src, /import \{ passesSecondStep \} from '\.\/second-step\.ts';/);
  assert.match(src, /if \(!\(await passesSecondStep\(token, \{ serviceKeys: \[serviceRole\] \}\)\)\) return false;/);
});

test('staff-portal: Back Office actions are checked, the staff app itself is not', () => {
  const src = read('supabase/functions/staff-portal/index.ts');
  for (const action of ['invite', 'notify_training', 'offboard']) {
    const at = src.indexOf(`if (action === '${action}') {`);
    assert.ok(at > 0, action);
    const next = src.indexOf('\n', src.indexOf('\n', at) + 1);
    assert.match(src.slice(at, next), CHECK, `${action} starts with the check`);
  }
  const self = src.slice(src.indexOf('const staff = await staffFromJwt(req);'));
  assert.doesNotMatch(self, /secondStepRefusal/, 'snapshot, clock, details: the staff app is out of scope');
  assert.match(src, /password\.length < 12/, 'staff logins also need 12 characters');
});

test('the shared helper stays importable by node (no Deno or URL imports)', () => {
  for (const f of ['second-step.ts', 'second-step-reset-rules.ts']) {
    const src = code(read(`supabase/functions/_shared/${f}`));
    assert.doesNotMatch(src, /from 'https?:/, f);
    assert.doesNotMatch(src, /Deno\.(env|serve)/, `${f} reaches Deno only through globalThis`);
  }
});

test('the Ops SQL file: guarded, one transaction, restrictive fence, storage, pre-request, safe roll back', () => {
  const name = 'supabase/migrations/20260919s_OPS_second_step.sql';
  assert.ok(exists(name));
  const sql = read(name);
  const lower = sql.toLowerCase();
  const code = lower.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  assert.match(code, /set lock_timeout = '3s'/);
  assert.match(code, /this file is for the ops project/);
  assert.match(code, /to_regclass\('public\.billing_state'\) is not null/, 'refuses the Platform project');
  assert.doesNotMatch(code, /^\s*(begin|commit)\s*;/m, 'no transaction wrapper (the SQL editor runs it as one)');
  assert.match(code, /create table if not exists public\.second_step_settings/);
  assert.match(code, /enforce\s+boolean not null default false/, 'OFF by default');
  assert.match(code, /app_gate\s+boolean not null default true/);
  assert.match(code, /revoke all on table public\.second_step_settings from anon, authenticated/);
  assert.match(code, /create table if not exists public\.second_step_resets/);
  assert.match(code, /revoke all on table public\.second_step_resets from anon, authenticated/);
  for (const fn of ['second_step_ok', 'second_step_status', 'second_step_check_request']) {
    const at = code.indexOf(`create or replace function public.${fn}(`);
    assert.ok(at > 0, fn);
    const head = code.slice(at, code.indexOf('as $$', at));
    assert.match(head, /security definer/, `${fn} is security definer`);
    assert.match(head, /set search_path = ''/, `${fn} pins search_path`);
  }
  assert.match(code, /as restrictive for all to authenticated/, 'the fence only ever narrows');
  assert.match(code, /using \(\(select public\.second_step_ok\(\)\)\) with check \(\(select public\.second_step_ok\(\)\)\)/);
  assert.match(code, /create policy second_step_fence on storage\.objects/);
  assert.match(code, /alter role authenticator set pgrst\.db_pre_request = ''public\.second_step_check_request''/);
  assert.match(code, /pg_notify\('pgrst', 'reload config'\)/);
  // self test runs BEFORE the pre-request is switched on
  assert.ok(code.indexOf('$selftest$') < code.indexOf('alter role authenticator'), 'self test first');
  // break glass and roll back instructions are in the file for Peter
  assert.match(lower, /update public\.second_step_settings set enforce = false, updated_at = now\(\) where id;/);
  const rb = lower.slice(lower.indexOf('roll back (only if told to)'));
  assert.ok(rb.indexOf('reset pgrst.db_pre_request') >= 0 && rb.indexOf('reset pgrst.db_pre_request') < rb.indexOf('drop function'),
    'roll back switches the pre-request off BEFORE dropping the function it calls');
});

test('no Platform second step file: nobody ever signs in to Platform', () => {
  const dir = fs.readdirSync(new URL('../../../supabase/migrations/', import.meta.url));
  assert.equal(dir.filter((f) => /second_step/i.test(f) && /PLATFORM/.test(f)).length, 0);
  const ours = dir.filter((f) => f.startsWith('20260919s_'));
  assert.deepEqual(ours, ['20260919s_OPS_second_step.sql'], 'the name does not collide with 20260919a/b/c/d/m');
});

test('the app: every password login surface waits for the second step before loading anything', () => {
  const bo = read('src/backoffice/BackOfficeApp.jsx');
  assert.match(bo, /if \(!isMock && authUser && !secondStepOk\) \{[\s\S]{0,300}?return <SecondStepGate supabase=\{supabase\} mode="login"/);
  assert.match(bo, /if \(bootedPasswordOnly\.current\) window\.location\.reload\(\); else setSecondStepOk\(true\);/,
    'a page that booted on a password only sign in reloads once the gate passes (SyncBridge and realtime restart clean)');
  assert.match(bo, /if \(!authUser \|\| isMock \|\| !secondStepOk\) return;/, 'profile load waits for the gate');
  assert.match(bo, /mode="recovery"/, 'a reset link passes the second step first');
  assert.match(bo, /\['security','Sign in security'\]/, 'Settings, Sign in security');
  const admin = read('src/admin/CompanyAdminApp.jsx');
  assert.match(admin, /if \(!secondStepOk\) \{\s*return <SecondStepGate/);
  assert.doesNotMatch(admin, /localStorage\.getItem\('rpos-auth'\)/, 'no raw, never refreshed token reads left');
  assert.doesNotMatch(admin, /localStorage\.removeItem\('rpos-auth'\)/, 'sign out ends the server session');
  const owner = read('src/surfaces/OwnerSurface.jsx');
  assert.match(owner, /if \(!session \|\| !isRealLogin\(session\)\)/, 'an anonymous session is not an owner');
  assert.match(owner, /if \(!secondStepOk\) \{/);
  const importer = read('src/admin/sections/AdminCustomerImport.jsx');
  assert.doesNotMatch(importer, /localStorage\.getItem\('rpos-auth'\)/);
  const sm = read('src/backoffice/sections/StaffManager.jsx');
  assert.doesNotMatch(sm, /localStorage\.getItem\('rpos-auth'\)/);
});

test('person sign in surfaces never get an anonymous session at app start; tills heal after a sign out', () => {
  const sb = read('src/lib/supabase.js');
  assert.match(sb, /const LOGIN_SURFACE_MODES = new Set\(\['office', 'backoffice', 'admin', 'owner', 'staff'\]\);/);
  // ensureAuthToken keeps its Back Office only rule, so customer checkout pages are untouched
  assert.match(sb, /if \(isBackOfficeMode\(\)\) return null;\n\s*\/\/ No session \(POS device, expired, etc\.\)/);
  const init = read('src/lib/useSupabaseInit.js');
  assert.match(init, /if \(!isLoginSurfaceMode\(\)\) \{\s*try \{ await ensureAuthToken\(\); \}/);
  assert.match(init, /event !== 'SIGNED_OUT' \|\| isLoginSurfaceMode\(\)/);
  assert.match(init, /_healRegistered = true;/, 'one listener per page');
});

test('the Face ID client never uses auth-js register() (it can unenroll a VERIFIED factor)', () => {
  const src = code(read('src/lib/secondStep/client.js'));
  assert.doesNotMatch(src, /webauthn\.register\(/);
  assert.match(src, /authenticatorAttachment: 'platform'/, 'the device biometric, not a USB key');
  assert.match(src, /userVerification: 'required'/);
});

test('no em or en dashes in the new second step files', () => {
  const files = [
    'supabase/functions/_shared/second-step.ts', 'supabase/functions/_shared/second-step-reset-rules.ts',
    'supabase/functions/second-step-reset/index.ts', 'supabase/migrations/20260919s_OPS_second_step.sql',
    'src/lib/secondStep/rules.js', 'src/lib/secondStep/client.js', 'src/components/secondStep/AuthUi.jsx',
    'src/components/secondStep/authTokens.js',
    'src/components/secondStep/SecondStepGate.jsx', 'src/components/secondStep/AuthenticatorSetup.jsx',
    'src/backoffice/sections/SignInSecurity.jsx', 'src/admin/sections/AdminSecondSteps.jsx', 'src/backoffice/BOLogin.jsx',
    'docs/SECOND_STEP.md',
  ];
  for (const f of files) {
    const src = read(f);
    assert.doesNotMatch(src, /[–—]/, `${f} has an em or en dash`);
  }
});
