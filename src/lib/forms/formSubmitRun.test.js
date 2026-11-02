// Marketing forms (5.12.37): one submission end to end through the REAL shared code the form-submit
// function runs (supabase/functions/_shared/formSubmitRun.js), and the "Form submitted" automation
// through the REAL workflow engine (workflow-engine.ts, Node strips its types), on an in-memory
// database. marketing-send is stubbed at fetch: what it is asked to send is what is checked.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { memDb } from './memDb.js';
import { runFormSubmit } from '../../../supabase/functions/_shared/formSubmitRun.js';
import { enrollFromForm, runWorkflow } from '../../../supabase/functions/_shared/workflow-engine.ts';
import { HONEYPOT_FIELD } from './formRules.js';

const ORG = 'aaaaaaaa-0000-4000-8000-000000000001';
const OTHER_ORG = 'aaaaaaaa-0000-4000-8000-000000000002';
const LOC = '7218c716-eeb4-4f96-b284-f3500823595c';
const FORM_ID = '11111111-1111-4111-8111-111111111111';
const OFFER_ID = '22222222-2222-4222-8222-222222222222';
const WF_ID = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-11-02T12:00:00Z');

const FORM = {
  id: FORM_ID, org_id: ORG, location_id: LOC, name: 'Win a pizza', status: 'active',
  consent_enabled: true, consent_text: 'Yes, send me offers by email and text.', submit_label: 'Send', thanks_text: 'Thanks! Check your inbox.',
  fields: [
    { id: 'first_name', kind: 'first_name', label: 'First name', required: true },
    { id: 'email', kind: 'email', label: 'Email', required: false },
    { id: 'phone', kind: 'phone', label: 'Phone', required: false },
  ],
};
const seed = (extra = {}) => ({
  marketing_forms: [FORM, { ...FORM, id: '44444444-4444-4444-8444-444444444444', status: 'archived' }],
  locations: [{ id: LOC, org_id: ORG, currency: 'GBP', created_at: '2026-01-01' }],
  customers: [], customer_consents: [], marketing_form_submissions: [],
  offers: [{ id: OFFER_ID, org_id: ORG, name: 'Free pizza', reward_label: 'Free pizza', code_prefix: 'PIZZA', code_length: 5, per_customer_limit: 1, issued_count: 0, valid_to: null }],
  workflows: [{ id: WF_ID, org_id: ORG, name: 'Pizza code', status: 'active', entry_trigger: { type: 'form_submitted', form_id: FORM_ID }, segment_id: null,
    steps: [{ key: 's0_x', after_days: 0, channel: 'email', subject: 'Your code: {{promo_code}}', email_html: '<p>{{promo_code}}</p>', sms_body: null, offer_id: OFFER_ID }] }],
  workflow_enrollments: [], workflow_step_sends: [], promo_codes: [],
  ...extra,
});
const post = (over = {}) => ({ form_id: FORM_ID, first_name: 'Ana', email: 'ana@example.com', phone: '07931 129015', consent: 'on', source: 'embed', return_to: 'https://mozz.sites.serv-os.app/join', ...over });

// marketing-send, stubbed: records every send, answers like sandbox mode.
let sends = [];
const realFetch = globalThis.fetch;
beforeEach(() => {
  sends = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    sends.push({ url: String(url), ...body });
    return { ok: true, json: async () => ({ ok: true, status: 'sandbox', message_id: `m${sends.length}` }) };
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

const OPTS = { today: '2026-11-02', supabaseUrl: 'https://ops.example', serviceRole: 'service', now: NOW.toISOString() };
// The automations exactly as the form-submit function runs them (index.ts runAutomations).
function automationsFor(db) {
  return async ({ form, customerId, consent }) => {
    const { data: wfs } = await db.from('workflows').select('*').eq('org_id', form.org_id).eq('status', 'active');
    for (const wf of wfs.filter((w) => w.entry_trigger?.type === 'form_submitted' && w.entry_trigger?.form_id === form.id)) {
      const en = await enrollFromForm(db, wf, customerId, consent, OPTS);
      if (en.enrollmentId) await runWorkflow(db, wf, { ...OPTS, enrollmentId: en.enrollmentId });
    }
  };
}
const submit = (db, raw, over = {}) => runFormSubmit(raw, { db, ipHash: 'iphash-1', userAgent: 'test', now: NOW, runAutomations: automationsFor(db), ...over });

test('a new person: customer made (named), consent recorded, submission stored, code sent and attributed', async () => {
  const db = memDb(seed());
  const r = await submit(db, post());
  assert.equal(r.status, 200);
  assert.deepEqual({ ok: r.body.ok, thanks: r.body.thanks }, { ok: true, thanks: 'Thanks! Check your inbox.' });
  const [c] = db.rows('customers');
  assert.equal(db.rows('customers').length, 1);
  assert.equal(c.org_id, ORG);
  assert.equal(c.name, 'Ana');
  assert.equal(c.phone, '+447931129015', 'the one phone key, in the venue region (GBP)');
  assert.equal(c.email, 'ana@example.com');
  assert.equal(c.marketing_opt_in, true);
  const [consent] = db.rows('customer_consents');
  assert.deepEqual({ customer_id: consent.customer_id, consented: consent.consented, source: consent.source, purpose: consent.purpose, location_id: consent.location_id, consent_text: consent.consent_text },
    { customer_id: c.id, consented: true, source: 'form', purpose: 'marketing', location_id: LOC, consent_text: FORM.consent_text });
  const [sub] = db.rows('marketing_form_submissions');
  assert.equal(sub.customer_id, c.id);
  assert.equal(sub.consent, true);
  assert.equal(sub.ip_hash, 'iphash-1');
  assert.equal(sub.source, 'embed');
  assert.equal(sub.consent_text, FORM.consent_text);
  assert.deepEqual(sub.answers, { first_name: 'Ana', email: 'ana@example.com', phone: '07931 129015' });
  // the automation
  const [code] = db.rows('promo_codes');
  assert.match(code.code, /^PIZZA-[A-Z2-9]{5}$/);
  assert.deepEqual({ customer: code.customer_id, offer: code.offer_id, form: code.form_id, wf: code.workflow_id }, { customer: c.id, offer: OFFER_ID, form: FORM_ID, wf: WF_ID });
  assert.equal(sends.length, 1);
  assert.equal(sends[0].url, 'https://ops.example/functions/v1/marketing-send');
  assert.deepEqual({ ch: sends[0].channel, to: sends[0].to, wf: sends[0].workflow_id, code: sends[0].promo_code, merge: sends[0].merge.promo_code }, { ch: 'email', to: { customer_id: c.id }, wf: WF_ID, code: code.code, merge: code.code });
  const [step] = db.rows('workflow_step_sends');
  assert.equal(step.status, 'sent');
  assert.equal(step.promo_code, code.code, 'the Marketing report attributes the send and the redemption through this row');
  assert.equal(db.rows('workflow_enrollments')[0].status, 'completed');
  assert.equal(db.rows('offers')[0].issued_count, 1);
});

test('no tick: the person is still stored, nothing marketing is recorded or sent', async () => {
  const db = memDb(seed());
  const r = await submit(db, post({ consent: undefined }));
  assert.equal(r.status, 200);
  assert.equal(db.rows('customers').length, 1);
  assert.equal(db.rows('customers')[0].marketing_opt_in, false);
  assert.equal(db.rows('customer_consents').length, 0, 'not ticking writes no refusal over an opt in given elsewhere');
  assert.equal(db.rows('marketing_form_submissions')[0].consent, false);
  assert.equal(db.rows('workflow_enrollments').length, 0);
  assert.equal(db.rows('promo_codes').length, 0);
  assert.equal(sends.length, 0);
});

test('one code per person per form: the same person again gets no second code', async () => {
  const db = memDb(seed());
  await submit(db, post());
  await submit(db, post({ first_name: 'Ana again', phone: '+44 7931 129015' }));
  assert.equal(db.rows('customers').length, 1, 'found again by phone, never made twice');
  assert.equal(db.rows('marketing_form_submissions').length, 2, 'both submissions kept');
  assert.equal(db.rows('promo_codes').length, 1);
  assert.equal(sends.length, 1);
});

test('the offer allows 2 each: a second submission gets a second code (round 1), a third gets none', async () => {
  const s = seed();
  s.offers[0].per_customer_limit = 2;
  const db = memDb(s);
  await submit(db, post());
  await submit(db, post());
  await submit(db, post());
  assert.equal(db.rows('promo_codes').length, 2);
  assert.deepEqual(db.rows('workflow_step_sends').map((x) => x.step_key).sort(), ['s0_x', 's0_x#r1']);
  assert.equal(db.rows('workflow_enrollments')[0].round, 1);
  assert.equal(sends.length, 2);
});

test('the person already used the offer (any code): no code is sent (found proving it live, 2 Nov)', async () => {
  const s = seed();
  s.customers = [{ id: 'cust-used', org_id: ORG, name: 'Ana', email: 'ana@example.com', phone: null, sources: [], deleted_at: null, created_at: '2026-01-01' }];
  s.promo_redemptions = [{ id: 'r1', offer_id: OFFER_ID, customer_id: 'cust-used', released_at: null }];
  const db = memDb(s);
  const r = await submit(db, post({ phone: '' }));
  assert.equal(r.status, 200);
  assert.equal(db.rows('promo_codes').length, 0);
  assert.equal(sends.length, 0);
  assert.equal(db.rows('workflow_enrollments').length, 0);
  // a use given back by a refund does not count
  const s2 = seed();
  s2.customers = s.customers;
  s2.promo_redemptions = [{ id: 'r1', offer_id: OFFER_ID, customer_id: 'cust-used', released_at: '2026-10-01' }];
  const db2 = memDb(s2);
  await submit(db2, post({ phone: '' }));
  assert.equal(db2.rows('promo_codes').length, 1);
});

test('the person has no address for the step: no code is wasted, the step is skipped', async () => {
  const s = seed();
  s.workflows[0].steps[0].channel = 'sms';
  const db = memDb(s);
  await submit(db, post({ phone: '' }));
  assert.equal(db.rows('promo_codes').length, 0);
  assert.equal(sends.length, 0);
  assert.deepEqual([db.rows('workflow_step_sends')[0].status, db.rows('workflow_step_sends')[0].error], ['skipped', 'no_channel']);
});

test('email and text step, person has only a phone: sent by text only', async () => {
  const s = seed();
  s.workflows[0].steps[0].channel = 'both';
  const db = memDb(s);
  await submit(db, post({ email: '' }));
  assert.deepEqual(sends.map((x) => x.channel), ['sms']);
});

test('before the forms SQL adds promo_codes.form_id, the code is still issued (without attribution)', async () => {
  const db = memDb(seed(), { missingColumns: { promo_codes: ['form_id', 'workflow_id'] } });
  await submit(db, post());
  assert.equal(db.rows('promo_codes').length, 1);
  assert.equal(db.rows('promo_codes')[0].form_id, undefined);
  assert.equal(sends.length, 1);
});

test('a failed send never fails the submission', async () => {
  const db = memDb(seed());
  globalThis.fetch = async () => { throw new Error('network down'); };
  const r = await submit(db, post());
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(db.rows('marketing_form_submissions').length, 1);
  assert.equal(db.rows('workflow_step_sends')[0].status, 'failed', 'left for the daily run to retry');
});

test('afterResponse: the automations run after the answer is ready', async () => {
  const db = memDb(seed());
  const later = [];
  const r = await submit(db, post(), { afterResponse: (fn) => later.push(fn) });
  assert.equal(r.status, 200);
  assert.equal(sends.length, 0, 'nothing sent before the answer');
  assert.equal(later.length, 1);
  await later[0]();
  assert.equal(sends.length, 1);
});

test('the honeypot: "thanks", and nothing at all is stored', async () => {
  const db = memDb(seed());
  const r = await submit(db, post({ [HONEYPOT_FIELD]: 'http://spam.example' }));
  assert.deepEqual([r.status, r.body.ok], [200, true]);
  assert.equal(db.rows('customers').length, 0);
  assert.equal(db.rows('marketing_form_submissions').length, 0);
  assert.equal(sends.length, 0);
});

test('the rate limit: 5 from one ip hash in 10 minutes, the 6th refused; another ip is fine', async () => {
  const db = memDb(seed());
  for (let i = 0; i < 5; i++) assert.equal((await submit(db, post({ email: `p${i}@example.com`, phone: '' }))).status, 200, `send ${i + 1}`);
  const sixth = await submit(db, post({ email: 'p6@example.com', phone: '' }));
  assert.equal(sixth.status, 429);
  assert.match(sixth.body.error, /10 minutes/);
  assert.equal(db.rows('marketing_form_submissions').length, 5);
  assert.equal((await submit(db, post({ email: 'p7@example.com', phone: '' }), { ipHash: 'iphash-2' })).status, 200);
  // an old submission outside the window does not count
  const db2 = memDb(seed({ marketing_form_submissions: Array.from({ length: 5 }, (_, i) => ({ id: `old${i}`, form_id: FORM_ID, ip_hash: 'iphash-1', created_at: '2026-11-02T11:40:00.000Z' })) }));
  assert.equal((await submit(db2, post())).status, 200);
});

test('refused before anything is written: unknown, archived or malformed form; bad answers', async () => {
  const db = memDb(seed());
  assert.equal((await submit(db, post({ form_id: 'nope' }))).status, 404);
  assert.equal((await submit(db, post({ form_id: '55555555-5555-4555-8555-555555555555' }))).status, 404);
  assert.equal((await submit(db, post({ form_id: '44444444-4444-4444-8444-444444444444' }))).status, 404, 'archived');
  const bad = await submit(db, post({ first_name: '', email: 'not-email' }));
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'Please fill in first name.');
  assert.deepEqual(Object.keys(bad.body.errors).sort(), ['email', 'first_name']);
  assert.equal(db.rows('marketing_form_submissions').length, 0);
  assert.equal(db.rows('customers').length, 0);
});

test('an existing customer is matched in the company CRM only, never another company\'s', async () => {
  const mine = { id: 'cust-mine', org_id: ORG, name: 'Ana Real', email: 'ANA@example.com', phone: null, sources: ['pos'], deleted_at: null, created_at: '2026-01-01' };
  const theirs = { id: 'cust-theirs', org_id: OTHER_ORG, name: 'Other', email: 'ana@example.com', phone: '+447931129015', sources: [], deleted_at: null, created_at: '2026-01-01' };
  const db = memDb(seed({ customers: [theirs, mine] }));
  await submit(db, post());
  assert.equal(db.rows('customers').length, 2, 'no new customer');
  const sub = db.rows('marketing_form_submissions')[0];
  assert.equal(sub.customer_id, 'cust-mine');
  const me = db.rows('customers').find((c) => c.id === 'cust-mine');
  assert.equal(me.name, 'Ana Real', 'the venue\'s name is kept');
  assert.equal(me.phone, '+447931129015', 'the blank phone is filled');
  assert.equal(db.rows('customers').find((c) => c.id === 'cust-theirs').name, 'Other', 'the other company is untouched');
});

test('an email with an underscore matches only itself (no LIKE wildcard)', async () => {
  const lookalike = { id: 'cust-x', org_id: ORG, name: 'X', email: 'anaxb@example.com', phone: null, sources: [], deleted_at: null, created_at: '2026-01-01' };
  const db = memDb(seed({ customers: [lookalike] }));
  await submit(db, post({ email: 'ana_b@example.com', phone: '' }));
  assert.equal(db.rows('customers').length, 2);
  assert.notEqual(db.rows('marketing_form_submissions')[0].customer_id, 'cust-x');
});

test('the customer write is refused: the submission is still stored, nothing is sent', async () => {
  const db = memDb(seed(), { failInsert: { customers: true } });
  const r = await submit(db, post());
  assert.equal(r.status, 200);
  assert.equal(db.rows('marketing_form_submissions').length, 1);
  assert.equal(db.rows('marketing_form_submissions')[0].customer_id, null);
  assert.equal(sends.length, 0);
});

test('a paused automation, or one for another form, sends nothing', async () => {
  const s = seed();
  s.workflows[0].status = 'paused';
  s.workflows.push({ ...s.workflows[0], id: 'wf-other', status: 'active', entry_trigger: { type: 'form_submitted', form_id: '44444444-4444-4444-8444-444444444444' } });
  const db = memDb(s);
  await submit(db, post());
  assert.equal(sends.length, 0);
  assert.equal(db.rows('workflow_enrollments').length, 0);
});

test('the daily run never enrols anybody into a form automation by itself', async () => {
  const db = memDb(seed({ customers: [{ id: 'c1', org_id: ORG, name: 'A', email: 'a@b.co', created_at: NOW.toISOString(), deleted_at: null }] }));
  const sum = await runWorkflow(db, db.rows('workflows')[0], OPTS);
  assert.equal(sum.enrolled, 0);
  assert.equal(sends.length, 0);
});
