// demoExempt.test.js: the reviewer's way past the second step.
//
// 29 Oct 2026: App Review could not open the ServOS Owner app. The review account signs in,
// and the second step then asks for a six digit code from an authenticator app only we hold.
// A TOTP code rotates every thirty seconds, so there is no fixed code to send them. Migration
// 20261106a lets a login that can ONLY ever reach demo venues skip the step.
//
// What must stay true, or a password alone becomes a way into a real venue:
//   - no account is named in the SQL: the rule is a property of the links, so it lapses by
//     itself the moment that login is given a trading venue;
//   - a login with no venues at all does not qualify;
//   - one trading venue anywhere on the login disqualifies it;
//   - a super admin never qualifies;
//   - the screen asks the database, and only a literal true opens the gate.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (p) => fs.readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const SQL = read('../../../supabase/migrations/20261106a_OPS_second_step_demo_exempt.sql');
const noComments = SQL.replace(/--.*$/gm, '');

test('the migration opens demo only logins and nothing else', () => {
  // It must not name a person. An email or a bare uuid in the body would be a back door that
  // outlives the venue it was meant for.
  assert.ok(!/@/.test(noComments), 'no email address in the SQL body');
  assert.ok(!/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i.test(noComments),
    'no user or venue id hard coded in the SQL body');

  // Having a venue is required, and every one of them must be a demo venue.
  assert.match(noComments, /and exists \(\s*select 1 from public\.user_locations ul where ul\.user_id = p_user\s*\)/,
    'a login with no venues does not qualify');
  assert.match(noComments, /and not exists \(/, 'one trading venue disqualifies the login');
  assert.match(noComments, /coalesce\(l\.is_demo, false\) is not true/,
    'a missing venue row counts as trading, never as demo');

  // A super admin reaches every venue whatever the links say.
  assert.match(noComments, /coalesce\(p\.role, ''\) = 'super_admin'/, 'super admins are excluded');
  // The venue on the profile itself is checked too.
  assert.match(noComments, /p\.location_id is not null/, "the profile's own venue is checked");

  // The rule is not callable from outside; the fences that use it are security definer.
  assert.match(noComments, /revoke all on function public\.second_step_demo_only\(uuid\) from public/);
  assert.match(noComments, /security definer/i);
  assert.match(noComments, /set search_path = ''/);
});

test('the fence and the screens read the same rule', () => {
  // The row rules go through second_step_ok, and the demo allowance is the LAST thing tried,
  // so an ordinary login never pays for the extra reads.
  const ok = noComments.slice(noComments.indexOf('function public.second_step_ok()'));
  assert.match(ok, /if public\.second_step_demo_only\(v_user\) then\s*return true;/);
  assert.ok(ok.indexOf('second_step_decide(v_claims, v_enforce, v_passkey)') < ok.indexOf('second_step_demo_only(v_user)'),
    'aal2 and passkey logins are answered before any demo lookup');
  assert.ok(ok.includes("second_step_reach(v_user) = 'staff_app'"), 'the staff app allowance is still there');

  // The sign in screen asks the same question through second_step_status().demo.
  const status = noComments.slice(noComments.indexOf('function public.second_step_status()'));
  assert.match(status, /'demo', public\.second_step_demo_only\(nullif\(auth\.jwt\(\)->>'sub', ''\)::uuid\)/);
  assert.match(status, /'app_gate', s\.app_gate/, 'the break glass answer is still returned');

  const client = read('./client.js');
  assert.match(client, /demo: d\?\.demo === true/, 'only a literal true from the server counts');
  assert.match(client, /catch \{ return \{ appGate: true, demo: false \}; \}/,
    'a call that fails asks as normal, it never lets anyone in');

  const gate = read('../../components/secondStep/SecondStepGate.jsx');
  assert.match(gate, /const gate = await client\.gateAnswer\(\);/);
  assert.match(gate, /demoAccount: gate\.demo/, 'the screen passes the answer to the pure rule');
});

test('the rollback puts the old fence back and drops the rule', () => {
  const back = read('../../../supabase/migrations/20261106a_OPS_second_step_demo_exempt_ROLLBACK.sql')
    .replace(/--.*$/gm, '');
  assert.ok(!back.includes('second_step_demo_only(v_user)'), 'the allowance is gone from second_step_ok');
  assert.match(back, /drop function if exists public\.second_step_demo_only\(uuid\)/);
  assert.ok(!back.includes("'demo',"), 'second_step_status stops answering demo');
});
