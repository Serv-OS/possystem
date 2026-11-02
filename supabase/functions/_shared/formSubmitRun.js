// supabase/functions/_shared/formSubmitRun.js
//
// MARKETING FORMS (5.12.37): one form submission, start to end, with the database handed in.
// The form-submit edge function wires HTTP around it; node tests drive it with an in-memory
// database (src/lib/forms/formSubmitRun.test.js), so every rule is proven without a deploy.
//
// The order, and why:
//   1. The form: active, by id (service role read). Not found → "This form is not available".
//   2. Honeypot filled → answer "thanks" and store NOTHING (a robot learns nothing).
//   3. The answers against the form's own fields (formRules.validateSubmission).
//   4. The rate limit: 5 per form per ip hash per 10 minutes, counted before anything is written.
//   5. The customer: by phone (the one phone key), else by email, in the company CRM; made when
//      new, with a name that is never null. Blanks filled, nothing the venue holds overwritten.
//   6. Consent: a ledger row ONLY when the tick was ticked. Not ticking is not a withdrawal of an
//      opt in given somewhere else, so nothing is written for it.
//   7. The submission row (the proof: answers, the words ticked, the ip hash, when).
//   8. The automations run AFTER the answer (afterResponse): a failed email or text never fails
//      the submission. Customer facing never fails.
// Every write checks its error. A failed customer write still stores the submission (customer_id
// null) so the venue never loses a person who filled in the form.

import {
  validateSubmission, firstError, isHoneypotTripped, rateLimited, rateWindowStart, planCustomer,
  RATE_LIMIT_WORDS, LIMITS,
} from './formRules.js';
import { phoneMatchKey, phoneRegionFromCurrency, phoneRawText } from './phoneKey.js';
import { readCustomerByPhone } from './customerPhoneRead.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOURCES = ['website', 'embed', 'hosted'];
const escapeLike = (s) => String(s).replace(/[\\%_*]/g, (ch) => `\\${ch}`);

/**
 * deps: { db (service role client), ipHash (string or null), userAgent, now (Date),
 *         afterResponse(fn) (schedules work after the answer), runAutomations({ form, customerId,
 *         consent }) }
 * raw: the posted fields. → { status, body } where body is { ok, thanks? , error?, errors?, form_id }
 */
export async function runFormSubmit(raw, deps) {
  const { db, ipHash = null, userAgent = '', now = new Date(), afterResponse = null, runAutomations = null } = deps || {};
  const formId = String((raw && raw.form_id) || '').trim();
  if (!UUID_RE.test(formId)) return { status: 404, body: { ok: false, error: 'This form is not available.' } };

  const { data: form, error: formErr } = await db.from('marketing_forms').select('*').eq('id', formId).eq('status', 'active').maybeSingle();
  if (formErr) return { status: 503, body: { ok: false, error: 'The form could not be sent just now. Please try again in a minute.', form_id: formId } };
  if (!form) return { status: 404, body: { ok: false, error: 'This form is not available.', form_id: formId } };
  const thanks = form.thanks_text || 'Thank you.';

  if (isHoneypotTripped(raw)) return { status: 200, body: { ok: true, thanks, form_id: formId } };

  const v = validateSubmission(form, raw, now);
  if (!v.ok) return { status: 400, body: { ok: false, error: firstError(form, v.errors), errors: v.errors, form_id: formId } };

  if (ipHash) {
    const { count, error: countErr } = await db.from('marketing_form_submissions').select('id', { count: 'exact', head: true })
      .eq('form_id', formId).eq('ip_hash', ipHash).gte('created_at', rateWindowStart(now));
    if (!countErr && rateLimited(count)) return { status: 429, body: { ok: false, error: RATE_LIMIT_WORDS, form_id: formId } };
  }

  // The venue: the form's own, else the company's first (its currency reads the phone; the consent
  // ledger needs a venue id).
  let venue = null;
  {
    const q = form.location_id
      ? db.from('locations').select('id, currency').eq('id', form.location_id).maybeSingle()
      : db.from('locations').select('id, currency').eq('org_id', form.org_id).order('created_at', { ascending: true }).limit(1).maybeSingle();
    const { data } = await q;
    venue = data || null;
  }
  const region = phoneRegionFromCurrency(venue && venue.currency);
  const contact = { ...v.contact, phone: v.contact.phone ? phoneMatchKey(v.contact.phone, region) : null };
  const nowIso = now.toISOString();

  let customerId = null;
  if (contact.email || contact.phone) {
    try { customerId = await findOrMakeCustomer(db, form.org_id, contact, v.contact.phone, v.consent, nowIso, region); }
    catch { customerId = null; }
  }

  if (customerId && v.consent) {
    const { error } = await db.from('customer_consents').insert({
      customer_id: customerId, org_id: form.org_id, location_id: String((venue && venue.id) || form.location_id || form.org_id),
      channel: 'both', purpose: 'marketing', consented: true, source: 'form', method: 'explicit_optin',
      consent_text: String(form.consent_text || '').slice(0, 1000), user_agent: String(userAgent || '').slice(0, 300) || null,
    });
    void error; // the submission row below keeps the words ticked either way
  }

  const source = SOURCES.includes(raw.source) ? raw.source : 'website';
  const pageUrl = typeof raw.return_to === 'string' ? raw.return_to.slice(0, 500) : null;
  const { data: sub, error: subErr } = await db.from('marketing_form_submissions').insert({
    form_id: formId, org_id: form.org_id, location_id: form.location_id || null,
    answers: v.answers, consent: v.consent, consent_text: v.consent ? String(form.consent_text || '').slice(0, LIMITS.MAX_CONSENT_TEXT) : null,
    customer_id: customerId, ip_hash: ipHash, user_agent: String(userAgent || '').slice(0, 300) || null,
    source, page_url: pageUrl,
  }).select('id').maybeSingle();
  if (subErr || !sub) return { status: 503, body: { ok: false, error: 'The form could not be sent just now. Please try again in a minute.', form_id: formId } };

  if (customerId && v.consent && typeof runAutomations === 'function') {
    const job = () => Promise.resolve().then(() => runAutomations({ form, customerId, consent: v.consent, submissionId: sub.id })).catch(() => {});
    if (typeof afterResponse === 'function') afterResponse(job); else await job();
  }
  return { status: 200, body: { ok: true, thanks, form_id: formId, submission_id: sub.id } };
}

/** By phone, then email; made when new. Returns the id, or null when the write was refused. */
export async function findOrMakeCustomer(db, orgId, contact, phoneTyped, consent, nowIso, region) {
  const find = async () => {
    if (contact.phone) {
      const { data } = await readCustomerByPhone(db, { orgId, phone: contact.phone, typed: phoneTyped || '', region, cols: '*' });
      if (data) return data;
    }
    if (contact.email) {
      const { data } = await db.from('customers').select('*').eq('org_id', orgId).ilike('email', escapeLike(contact.email)).is('deleted_at', null).order('created_at', { ascending: true }).limit(1).maybeSingle();
      if (data) return data;
    }
    return null;
  };
  const existing = await find();
  const plan = planCustomer({ existing, contact, phoneRaw: phoneTyped ? phoneRawText(phoneTyped) : null, consent, nowIso, orgId });
  if (plan.mode === 'none') return null;
  if (plan.mode === 'update') {
    const { error } = await db.from('customers').update(plan.patch).eq('id', plan.id).eq('org_id', orgId);
    void error; // a refused fill-in still matches the person
    return plan.id;
  }
  const { data: ins, error } = await db.from('customers').insert(plan.row).select('id').maybeSingle();
  if (!error && ins) return ins.id;
  // Two sends at once for a new person: the unique (org, phone) / (org, email) index refused the
  // second insert. Read the row the first one made.
  const again = await find();
  return again ? again.id : null;
}
