// Marketing forms (5.12.37): the pure rules every writer shares (supabase/functions/_shared/formRules.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normaliseFormDef, validateSubmission, firstError, isHoneypotTripped, rateLimited, rateWindowStart, RATE_LIMIT,
  planCustomer, customerName, planFormEnrol, reachableChannels, roundStepKey, formTriggerId, isOwnHost, parseReturnTo,
  returnUrl, formStateFrom, submissionsCsv, embedSnippet, fieldsFromForm, newField, starterForm, cleanBirthday, ticked,
  HONEYPOT_FIELD, LIMITS, FIELD_KINDS,
} from './formRules.js';

const FORM = {
  id: '11111111-1111-4111-8111-111111111111',
  consent_enabled: true, consent_text: 'Yes, send me offers.',
  fields: [
    { id: 'first_name', kind: 'first_name', label: 'First name', required: true },
    { id: 'email', kind: 'email', label: 'Email', required: true },
    { id: 'phone', kind: 'phone', label: 'Phone', required: false },
    { id: 'birthday', kind: 'birthday', label: 'Birthday', required: false },
    { id: 'visit', kind: 'dropdown', label: 'How often', required: false, options: ['Weekly', 'Monthly'] },
    { id: 'note', kind: 'text', label: 'Anything else', long: true },
    { id: 'terms', kind: 'tickbox', label: 'I am over 18', required: true },
  ],
};
const NOW = new Date('2026-11-02T12:00:00Z');

test('the builder: a name, 1 to 12 fields, one of each contact kind, email or phone required', () => {
  assert.equal(normaliseFormDef(starterForm()).ok, false, 'the starter has no name yet');
  assert.equal(normaliseFormDef({ ...starterForm(), name: 'Join' }).ok, true);
  const noContact = normaliseFormDef({ name: 'x', fields: [newField('first_name')] });
  assert.equal(noContact.ok, false);
  assert.match(noContact.errors.join(' '), /Email or a Phone/);
  const thirteen = Array.from({ length: 13 }, (_, i) => newField('text', Array.from({ length: i }, (_, j) => (j ? `text_${j + 1}` : 'text'))));
  const big = normaliseFormDef({ name: 'x', fields: [newField('email'), ...thirteen] });
  assert.equal(big.ok, false);
  assert.equal(big.clean.fields.length, LIMITS.MAX_FIELDS, 'never more than 12 kept');
  const twice = normaliseFormDef({ name: 'x', fields: [newField('email'), { ...newField('email'), id: 'email2' }] });
  assert.match(twice.errors.join(' '), /Email twice/);
  const dd = normaliseFormDef({ name: 'x', fields: [newField('email'), { id: 'd', kind: 'dropdown', label: 'Pick', options: ['A', '', 'A'] }] });
  assert.match(dd.errors.join(' '), /at least two choices/);
  const junk = normaliseFormDef({ name: 'x', fields: [newField('email'), { kind: 'script' }] });
  assert.match(junk.errors.join(' '), /unknown kind/);
});

test('the builder cleans: ids safe and unique, never the honeypot or consent names, words defaulted', () => {
  const r = normaliseFormDef({ name: '  Win a pizza  ', fields: [{ id: 'Bad Id!', kind: 'email', label: '' }, { id: HONEYPOT_FIELD, kind: 'text' }, { id: 'consent', kind: 'tickbox' }], consent_text: '', submit_label: '', thanks_text: '' });
  assert.equal(r.ok, true, r.errors.join(' '));
  assert.equal(r.clean.name, 'Win a pizza');
  const ids = r.clean.fields.map((f) => f.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(!ids.includes(HONEYPOT_FIELD) && !ids.includes('consent'));
  for (const id of ids) assert.match(id, /^[a-z][a-z0-9_-]{0,39}$/);
  assert.equal(r.clean.fields[0].label, 'Email');
  assert.ok(r.clean.consent_text && r.clean.submit_label && r.clean.thanks_text);
  assert.equal(r.clean.status, 'active');
  assert.deepEqual(Object.keys(r.clean).sort(), ['consent_enabled', 'consent_text', 'fields', 'location_id', 'name', 'status', 'submit_label', 'thanks_text']);
});

test('a submission is checked against the form\'s own fields; unknown keys are dropped', () => {
  const ok = validateSubmission(FORM, { first_name: ' Ana ', email: 'Ana@Example.COM', phone: '07931 129015', birthday: '1990-05-04', visit: 'Weekly', note: 'hi', terms: 'on', consent: 'on', admin: 'yes', org_id: 'x' }, NOW);
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
  assert.deepEqual(ok.answers, { first_name: 'Ana', email: 'ana@example.com', phone: '07931 129015', birthday: '1990-05-04', visit: 'Weekly', note: 'hi', terms: true });
  assert.deepEqual(ok.contact, { first_name: 'Ana', last_name: null, email: 'ana@example.com', phone: '07931 129015', birthday: '1990-05-04' });
  assert.equal(ok.consent, true);
  const bad = validateSubmission(FORM, { email: 'not-an-email', phone: '123', birthday: '2030-01-01', visit: 'Daily' }, NOW);
  assert.equal(bad.ok, false);
  assert.deepEqual(Object.keys(bad.errors).sort(), ['birthday', 'email', 'first_name', 'phone', 'terms', 'visit']);
  assert.equal(firstError(FORM, bad.errors), 'Please fill in first name.');
  assert.equal(bad.consent, false, 'no tick, no consent');
});

test('the marketing tick: only "ticked" means yes, and a form without the tick never gives consent', () => {
  for (const v of [true, 'on', 'true', '1', 'yes', 'ON']) assert.equal(ticked(v), true, String(v));
  for (const v of [false, '', 'off', '0', 'no', undefined, null, {}]) assert.equal(ticked(v), false, String(v));
  const off = { ...FORM, consent_enabled: false };
  assert.equal(validateSubmission(off, { first_name: 'A', email: 'a@b.co', terms: 'on', consent: 'on' }, NOW).consent, false);
});

test('birthdays: real past dates only', () => {
  assert.equal(cleanBirthday('2000-02-29', NOW), '2000-02-29');
  for (const v of ['2001-02-29', '1899-12-31', '2026-11-03', '04/05/1990', '1990-13-01', '']) assert.equal(cleanBirthday(v, NOW), null, v);
});

test('free text is capped, a short box shorter than a long one', () => {
  const r = validateSubmission({ fields: [{ id: 'a', kind: 'text' }, { id: 'b', kind: 'text', long: true }] }, { a: 'x'.repeat(5000), b: 'y'.repeat(5000) }, NOW);
  assert.equal(r.answers.a.length, LIMITS.MAX_SHORT_ANSWER);
  assert.equal(r.answers.b.length, LIMITS.MAX_TEXT_ANSWER);
});

test('the honeypot: anything in the hidden box is a robot', () => {
  assert.equal(isHoneypotTripped({ [HONEYPOT_FIELD]: 'http://spam' }), true);
  assert.equal(isHoneypotTripped({ [HONEYPOT_FIELD]: '   ' }), false);
  assert.equal(isHoneypotTripped({}), false);
});

test('the rate limit rule: 5 per form per ip hash per 10 minutes, the 6th refused', () => {
  assert.deepEqual(RATE_LIMIT, { max: 5, windowMs: 600000 });
  for (const n of [0, 1, 4]) assert.equal(rateLimited(n), false, String(n));
  for (const n of [5, 6, 50]) assert.equal(rateLimited(n), true, String(n));
  assert.equal(rateLimited(null), false, 'a failed count never blocks a person');
  assert.equal(rateWindowStart(NOW), '2026-11-02T11:50:00.000Z');
});

test('customer match: a name is never null, blanks are filled, nothing the venue holds is overwritten', () => {
  assert.equal(customerName({ first_name: 'Ana', last_name: 'Silva' }), 'Ana Silva');
  assert.equal(customerName({ email: 'ana.s@example.com' }), 'ana.s');
  assert.equal(customerName({ phone: '+447931129015' }), '+447931129015');
  assert.equal(customerName({}), 'Form guest');
  const contact = { first_name: 'Ana', last_name: null, email: 'ana@example.com', phone: '+447931129015', birthday: '1990-05-04' };
  assert.deepEqual(planCustomer({ existing: null, contact: { email: null, phone: null }, nowIso: 'T', orgId: 'O' }), { mode: 'none' });
  const ins = planCustomer({ existing: null, contact, phoneRaw: '07931 129015', consent: true, nowIso: 'T', orgId: 'O' });
  assert.equal(ins.mode, 'insert');
  assert.equal(ins.row.name, 'Ana');
  assert.equal(ins.row.org_id, 'O');
  assert.equal(ins.row.marketing_opt_in, true);
  assert.deepEqual(ins.row.sources, ['form']);
  const emailOnly = planCustomer({ existing: null, contact: { email: 'x@y.co' }, nowIso: 'T', orgId: 'O' });
  assert.equal(typeof emailOnly.row.name, 'string');
  assert.ok(emailOnly.row.name.length > 0);
  assert.equal(emailOnly.row.marketing_opt_in, false, 'no tick, no opt in');
  const existing = { id: 'c1', name: 'Ana Real', email: 'old@example.com', phone: null, first_name: 'Ana', birthday: null, sources: ['pos'], source: 'pos', marketing_opt_in: true };
  const up = planCustomer({ existing, contact, phoneRaw: '07931 129015', consent: false, nowIso: 'T', orgId: 'O' });
  assert.equal(up.mode, 'update');
  assert.equal(up.patch.email, undefined, 'never overwrites an email');
  assert.equal(up.patch.name, undefined, 'never overwrites a name');
  assert.equal(up.patch.phone, '+447931129015');
  assert.equal(up.patch.birthday, '1990-05-04');
  assert.deepEqual(up.patch.sources, ['pos', 'form']);
  assert.equal(up.patch.marketing_opt_in, undefined, 'not ticking never withdraws an opt in');
  const blank = planCustomer({ existing: { id: 'c2', name: '', sources: [] }, contact, consent: false, nowIso: 'T', orgId: 'O' });
  assert.equal(blank.patch.name, 'Ana', "an unfinished '' name is filled");
});

test('the automation decision: tick, once per person per form, more only when the offer allows', () => {
  assert.deepEqual(planFormEnrol({ consent: false, enrollment: null }), { action: 'skip', reason: 'no_consent' });
  assert.deepEqual(planFormEnrol({ consent: true, enrollment: null }), { action: 'enrol', reason: 'first' });
  assert.deepEqual(planFormEnrol({ consent: true, enrollment: { status: 'active' } }), { action: 'skip', reason: 'in_progress' });
  assert.deepEqual(planFormEnrol({ consent: true, enrollment: { status: 'completed' }, codesFromForm: 1, perCustomer: 1 }), { action: 'skip', reason: 'already_sent' });
  assert.deepEqual(planFormEnrol({ consent: true, enrollment: { status: 'completed' }, codesFromForm: 1, perCustomer: 3 }), { action: 'rearm', reason: 'offer_allows_more' });
  assert.deepEqual(planFormEnrol({ consent: true, enrollment: { status: 'completed' }, codesFromForm: 3, perCustomer: 3 }), { action: 'skip', reason: 'already_sent' });
  assert.deepEqual(planFormEnrol({ consent: true, enrollment: { status: 'completed' }, codesFromForm: 0, perCustomer: 0 }), { action: 'rearm', reason: 'offer_allows_more' }, 'a finished round that sent no code (no channel then) may go again');
  assert.deepEqual(reachableChannels('email', { email: 'a@b.co' }), ['email']);
  assert.deepEqual(reachableChannels('sms', { email: 'a@b.co' }), []);
  assert.deepEqual(reachableChannels('both', { email: '', phone: '+44' }), ['sms']);
  assert.deepEqual(reachableChannels('both', null), []);
  assert.equal(roundStepKey('s0_ab', 0), 's0_ab', 'round 0 keeps every existing key');
  assert.equal(roundStepKey('s0_ab', 2), 's0_ab#r2');
  assert.equal(formTriggerId({ entry_trigger: { type: 'form_submitted', form_id: 'f1' } }), 'f1');
  assert.equal(formTriggerId({ entry_trigger: { type: 'signup', form_id: 'f1' } }), null);
});

test('a plain post goes back only to our hosts (never an open redirect), with the outcome in the address', () => {
  for (const h of ['app.serv-os.app', 'mozz.sites.serv-os.app', 'location1.serv-os.app', 'localhost', 'possystem-git-feat-serv-os.vercel.app']) assert.equal(isOwnHost(h), true, h);
  for (const h of ['evil.com', 'serv-os.app.evil.com', 'evil.vercel.app', '']) assert.equal(isOwnHost(h), false, h);
  assert.equal(parseReturnTo('javascript:alert(1)'), null);
  assert.equal(parseReturnTo('http://evil.com/'), null, 'plain http only for a local dev server');
  assert.ok(parseReturnTo('http://localhost:5210/x'));
  const u = parseReturnTo('https://mozz.sites.serv-os.app/join?form_sent=old&x=1#top');
  const sent = new URL(returnUrl(u, FORM.id, { sent: true }));
  assert.equal(sent.searchParams.get('form_sent'), FORM.id);
  assert.equal(sent.searchParams.get('x'), '1');
  assert.equal(sent.hash, `#form-${FORM.id}`);
  const failed = new URL(returnUrl(u, FORM.id, { error: 'Please enter a real email address.' }));
  assert.equal(failed.searchParams.get('form_sent'), null);
  assert.deepEqual(formStateFrom(failed.search), { sent: null, errorFor: FORM.id, error: 'Please enter a real email address.' });
  assert.deepEqual(formStateFrom(sent.search), { sent: FORM.id, errorFor: null, error: '' });
  assert.deepEqual(formStateFrom('?form_sent=<script>'), { sent: null, errorFor: null, error: '' });
});

test('a form post body becomes plain fields, capped', () => {
  const p = new URLSearchParams('form_id=abc&email=a%40b.co&consent=on');
  assert.deepEqual(fieldsFromForm(p), { form_id: 'abc', email: 'a@b.co', consent: 'on' });
  const many = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`k${i}`, 'v']));
  assert.equal(Object.keys(fieldsFromForm(many)).length, 60);
});

test('the CSV export: a column per field, spreadsheet formulas defused', () => {
  const csv = submissionsCsv(FORM, [{ answers: { first_name: '=HYPERLINK("x")', email: 'a@b.co', terms: true }, consent: true, customer_id: 'c1', created_at: '2026-11-02T10:00:00Z' }]);
  const [head, row] = csv.trim().split('\r\n');
  assert.equal(head, 'First name,Email,Phone,Birthday,How often,Anything else,I am over 18,Marketing tick,Customer,Sent at');
  assert.match(row, /^"'=HYPERLINK\(""x""\)",a@b\.co,,,,,Yes,Yes,c1,2026-11-02T10:00:00Z$/);
});

test('the embed snippet: a script that adds an iframe, and a noscript iframe for no JavaScript', () => {
  const s = embedSnippet(FORM.id, 'https://app.serv-os.app/');
  assert.match(s, new RegExp(`<div id="servos-form-${FORM.id}"></div>`));
  assert.match(s, new RegExp(`<script src="https://app\\.serv-os\\.app/api/form\\?script=1&id=${FORM.id}" async></script>`));
  assert.match(s, new RegExp(`<noscript><iframe src="https://app\\.serv-os\\.app/api/form\\?id=${FORM.id}"`));
  assert.doesNotMatch(embedSnippet('"><script>x</script>', 'https://a'), /<script>x/);
});

test('every field kind has a starter and a label; the starter form is valid once named', () => {
  for (const k of FIELD_KINDS) { const f = newField(k); assert.equal(f.kind, k); assert.ok(f.label); }
  assert.ok(normaliseFormDef({ ...starterForm(), name: 'Join' }).ok);
});
