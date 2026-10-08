// src/lib/updateEmailWiring.test.js: email an update to Back Office logins, the wiring (8 Oct 2026).
// Reads the source and checks the shape that keeps a send safe: the screen only asks and never
// writes the table; the server fences the caller, picks the people again, compares the count it
// was shown, keeps one id to one text, demands a test of the exact text, queues rows before
// anything leaves, and sends through ONE function; the migration opens no door to the API; the
// panel sits on the Messages screen.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const count = (s, needle) => s.split(needle).length - 1;
const between = (s, from, to) => { const a = s.indexOf(from); const b = s.indexOf(to, a); return a >= 0 && b > a ? s.slice(a, b) : ''; };

test('Company Admin renders the panel in the Messages section, and the panel only asks the function', () => {
  const app = read('src/admin/CompanyAdminApp.jsx');
  assert.ok(app.includes("import AdminUpdateEmails from './sections/AdminUpdateEmails';"));
  assert.ok(app.includes("{section === 'venue-messages' && <AdminUpdateEmails />}"));
  const sec = read('src/admin/sections/AdminUpdateEmails.jsx');
  assert.equal(count(sec, ".from('update_emails')"), 0, 'the screen never touches the table itself');
  assert.equal(count(sec, 'api.resend.com'), 0, 'the screen never talks to the mail provider');
  assert.ok(sec.includes('if (!window.confirm(sendQuestion(count))) return;'));
  assert.ok(sec.includes('expect_count: count, broadcast_id: draftId.current,'));
  // Send waits for a test of the current text, and a changed text closes it again.
  assert.ok(sec.includes('const tested = testedHash != null && testedHash === currentHash;'));
  assert.ok(sec.includes("if (!tested) { setErr('Send yourself a test of this text first.'); return; }"));
  assert.ok(sec.includes('setTestedHash(currentHash);'), 'only a sent test marks the text as tested');
  // The preview is the real email, rendered by the shared renderer, in a sandboxed frame.
  assert.ok(sec.includes('buildEmail({'));
  assert.ok(sec.includes('<iframe title="Email preview" sandbox="" srcDoc={preview.html}'));
  // The note is built from what the server SENT, and a refused retry starts a new draft id.
  assert.ok(sec.includes('setNote(sendResultLine({ sent: res.sent, failed: res.failed, skipped: res.skipped }));'));
  const refused = between(sec, "if (e.code === 'already_sent')", '} finally {');
  assert.ok(refused.includes('draftId.current = newBroadcastId();'));
  const lib = read('src/lib/updateEmails.js');
  assert.ok(lib.includes('`${FUNCTIONS_URL}/update-emails-admin`'));
});

test('update-emails-admin: the fence is the venue-messages one, in the same order', () => {
  const fn = read('supabase/functions/update-emails-admin/index.ts');
  const aal2 = fn.indexOf('requireAal2(req, [SERVICE_ROLE])');
  const getUser = fn.indexOf('admin.auth.getUser(token)');
  const anon = fn.indexOf('if (user.is_anonymous)');
  const role = fn.indexOf("profile?.role !== 'super_admin'");
  const body = fn.indexOf('await req.json()');
  assert.ok(aal2 > 0 && getUser > aal2 && anon > getUser && role > anon && body > role, 'second step, real user, not anonymous, super admin, then the body');
  assert.ok(fn.includes("from '../_shared/updateEmailRules.js'"), 'the same rules the screen previews with');
});

test('update-emails-admin send: count, one id one text, test first, queue, then ONE sender', () => {
  const fn = read('supabase/functions/update-emails-admin/index.ts');
  const send = between(fn, "if (action === 'send') {", "return json({ error: 'unknown action' }, 400);");
  const countCheck = send.indexOf('Number(body.expect_count) !== recipients.length');
  const prior = send.indexOf(".eq('broadcast_id', broadcastId).eq('is_test', false)");
  const sameTextCheck = send.indexOf('!sameText(priorRows[0], draft)');
  const testFirst = send.indexOf(".eq('sent_by', user.id).eq('is_test', true).eq('status', 'sent').eq('subject', draft.subject).eq('body_md', draft.bodyMd)");
  const skip = send.indexOf('stillToSend(recipients, priorRows)');
  const queue = send.indexOf(".upsert(rows, { onConflict: 'broadcast_id,to_email', ignoreDuplicates: true })");
  const deliver = send.indexOf('await deliverAll(todo, makeSendOne(');
  assert.ok(countCheck > 0 && prior > countCheck && sameTextCheck > prior && testFirst > sameTextCheck && skip > testFirst && queue > skip && deliver > queue,
    'count, prior text, test first, who is left, queue the rows, then send');
  assert.ok(send.includes("code: 'count_changed', count: recipients.length }, 409)"));
  assert.ok(send.includes("code: 'already_sent' }, 409)"));
  assert.ok(send.includes("code: 'test_first' }, 409)"));
  assert.ok(send.includes("code: 'too_many', count: recipients.length }, 400)"));
  // Every email leaves through makeSendOne and nowhere else; a 4xx other than 429 is final.
  assert.equal(count(fn, 'await fetch('), 1, 'one fetch to the provider in the whole function');
  assert.ok(between(fn, 'function makeSendOne(', 'Deno.serve(').includes('await fetch(spec.url'));
  assert.ok(fn.includes('if (res.status !== 429 && res.status < 500) return { ok: false, error: lastError };'));
  // A test goes to the caller only, and is recorded before it is sent.
  const testAct = between(fn, "if (action === 'test') {", "if (action === 'send') {");
  assert.ok(testAct.includes('const to = String(user.email ?? profile.email ??'));
  assert.ok(testAct.indexOf(".insert({") < testAct.indexOf('await deliverAll([me]'), 'the row first, then the email');
  assert.ok(testAct.includes('makeSendOne(draft.subject, draft.bodyMd, true)'));
  // The sender is ServOS, never a venue's branded domain.
  assert.ok(fn.includes("servosSender(Deno.env.get('RECEIPT_EMAIL_FROM') || '')"));
  assert.equal(count(fn, 'resolveSenderForOrg'), 0);
  assert.equal(count(fn, 'resolveSenderFrom'), 0);
});

test('the migration opens no door to the API and its rollback drops only the table', () => {
  const mig = read('supabase/migrations/20261008b_OPS_update_emails.sql');
  assert.ok(mig.includes('create table if not exists public.update_emails ('));
  assert.ok(mig.includes('alter table public.update_emails enable row level security;'));
  assert.ok(mig.includes('revoke all on table public.update_emails from public, anon, authenticated;'));
  assert.ok(mig.includes('grant all on table public.update_emails to service_role;'));
  assert.equal(count(mig, 'create policy'), 0, 'no policy at all: nothing for anon or authenticated');
  assert.equal(count(mig, 'to authenticated'), 0);
  assert.ok(mig.includes('constraint update_emails_once_per_person unique (broadcast_id, to_email)'));
  assert.ok(mig.includes("constraint update_emails_status_ok check (status in ('queued', 'sent', 'failed'))"));
  assert.ok(mig.includes('is_test       boolean not null default false'));
  for (const col of ['broadcast_id', 'subject', 'body_md', 'to_email', 'to_user_id', 'to_name', 'org_id', 'role', 'sent_by', 'sent_by_name', 'sent_at', 'provider', 'provider_id', 'status', 'error']) {
    assert.ok(new RegExp(`^  ${col}\\s`, 'm').test(mig), `column ${col}`);
  }
  assert.ok(mig.includes("raise exception 'This is not the Ops database"));
  assert.ok(mig.includes("notify pgrst, 'reload schema';"));
  const back = read('supabase/migrations/20261008b_OPS_update_emails_ROLLBACK.sql');
  assert.ok(back.includes('drop table if exists public.update_emails;'));
  assert.equal(count(back, 'drop table'), 1);
  assert.equal(count(back, 'drop function'), 0);
});
