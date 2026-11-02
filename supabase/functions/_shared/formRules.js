// supabase/functions/_shared/formRules.js
//
// MARKETING FORMS (5.12.36): every rule a form lives by, with no database, no clock and no
// network in it. Plain JS so the same file runs in the Deno functions (form-submit,
// marketing-forms, marketing-run), in the browser (src/lib/forms/formRules.js re-exports it),
// in the Vercel functions (api/site.js, api/form.js) and in node tests.
//
// Peter (2 Nov 2026): "we need a way to have forms that you can create and embed on a website or
// on the website builder that then you can attach to an automation to trigger the code to be
// sent out automatically to the customer filling in the form".
//
// The rules, in one place so the builder, the public page and the server refuse the same things:
//   * A form has 1 to 12 fields of 8 kinds. At most one of each contact kind (first name, last
//     name, email, phone, birthday). At least one of email or phone, or nobody can be matched
//     to the CRM and nothing can ever be sent.
//   * A submission is checked against the form's OWN fields: unknown keys are dropped, required
//     fields must be filled, an email must look like one, a phone needs 7 digits, a birthday is a
//     real past date, a dropdown answer must be one of its options, free text is capped.
//   * The marketing tick is never required to submit. Marketing is sent only when it was ticked.
//   * A hidden honeypot field filled in = a robot: answer "thanks", store nothing.
//   * 5 submissions per form per ip hash per 10 minutes. The 6th is refused with plain words.
//   * The customer is found by phone, then email, in the company CRM, or made with a name that is
//     never null (customers.name is NOT NULL and a null insert is silently refused).
//   * An automation sends a code only with the tick, only on a channel the person has, and once
//     per person per form unless the offer allows more (offers.per_customer_limit).

export const FIELD_KINDS = Object.freeze(['first_name', 'last_name', 'email', 'phone', 'birthday', 'text', 'dropdown', 'tickbox']);
export const CONTACT_KINDS = Object.freeze(['first_name', 'last_name', 'email', 'phone', 'birthday']);
export const KIND_LABELS = Object.freeze({
  first_name: 'First name', last_name: 'Last name', email: 'Email', phone: 'Phone', birthday: 'Birthday',
  text: 'Free text', dropdown: 'Dropdown', tickbox: 'Tick box',
});

export const LIMITS = Object.freeze({
  MAX_FIELDS: 12,
  MAX_OPTIONS: 30,
  MAX_LABEL: 120,
  MAX_OPTION: 80,
  MAX_TEXT_ANSWER: 1000,
  MAX_SHORT_ANSWER: 120,
  MAX_EMAIL: 200,
  MAX_NAME: 120,
  MAX_CONSENT_TEXT: 600,
  MAX_SUBMIT_LABEL: 40,
  MAX_THANKS: 600,
  MAX_PAYLOAD_BYTES: 16 * 1024,
});

export const RATE_LIMIT = Object.freeze({ max: 5, windowMs: 10 * 60 * 1000 });

// The hidden field a person never sees. A robot fills every box it finds.
export const HONEYPOT_FIELD = 'company_website';

export const DEFAULT_CONSENT_TEXT = 'Yes, send me news and offers by email and text. I can unsubscribe at any time.';
export const DEFAULT_SUBMIT_LABEL = 'Send';
export const DEFAULT_THANKS = 'Thank you. We have got your details.';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const clip = (v, n) => str(v).trim().slice(0, n);

/** A field id the HTML can use as a name: letters, digits, _ and -, 1 to 40, starting with a letter. */
export const FIELD_ID_RE = /^[a-z][a-z0-9_-]{0,39}$/;

/** A fresh, readable field id for a kind ('email', 'text_2' ...), unique in `taken`. */
export function fieldIdFor(kind, taken = []) {
  const base = FIELD_KINDS.includes(kind) ? kind : 'field';
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let i = 2; i < 100; i++) if (!used.has(`${base}_${i}`)) return `${base}_${i}`;
  return `${base}_${taken.length + 1}`;
}

/** A new field of a kind with its plain label, for the builder's Add field button. */
export function newField(kind, taken = []) {
  const k = FIELD_KINDS.includes(kind) ? kind : 'text';
  const f = { id: fieldIdFor(k, taken), kind: k, label: KIND_LABELS[k], required: k === 'email' };
  if (k === 'dropdown') f.options = ['Option 1', 'Option 2'];
  return f;
}

/** The form a new owner starts with: first name, email, the tick. */
export function starterForm() {
  return {
    name: '', location_id: null,
    fields: [newField('first_name'), { ...newField('email', ['first_name']), required: true }],
    consent_enabled: true, consent_text: DEFAULT_CONSENT_TEXT,
    submit_label: DEFAULT_SUBMIT_LABEL, thanks_text: DEFAULT_THANKS, status: 'active',
  };
}

/**
 * Check and clean a form definition from the builder. Never throws.
 * → { ok, errors: [plain words], clean } where clean has only the keys the table stores.
 */
export function normaliseFormDef(def) {
  const errors = [];
  const d = isObj(def) ? def : {};
  const name = clip(d.name, LIMITS.MAX_LABEL);
  if (!name) errors.push('Give the form a name.');
  const raw = Array.isArray(d.fields) ? d.fields : [];
  if (!raw.length) errors.push('Add at least one field.');
  if (raw.length > LIMITS.MAX_FIELDS) errors.push(`A form can have ${LIMITS.MAX_FIELDS} fields at most.`);
  const fields = [];
  const ids = new Set();
  const seenContact = new Set();
  raw.slice(0, LIMITS.MAX_FIELDS).forEach((f, i) => {
    const n = i + 1;
    if (!isObj(f)) { errors.push(`Field ${n} is empty.`); return; }
    const kind = str(f.kind);
    if (!FIELD_KINDS.includes(kind)) { errors.push(`Field ${n} has an unknown kind.`); return; }
    if (CONTACT_KINDS.includes(kind)) {
      if (seenContact.has(kind)) errors.push(`The form has ${KIND_LABELS[kind]} twice. Keep one.`);
      seenContact.add(kind);
    }
    let id = str(f.id).trim().toLowerCase();
    if (!FIELD_ID_RE.test(id) || ids.has(id) || id === HONEYPOT_FIELD || id === 'consent') id = fieldIdFor(kind, [...ids, HONEYPOT_FIELD, 'consent']);
    ids.add(id);
    const label = clip(f.label, LIMITS.MAX_LABEL) || KIND_LABELS[kind];
    const out = { id, kind, label, required: f.required === true };
    if (kind === 'dropdown') {
      const opts = (Array.isArray(f.options) ? f.options : []).map((o) => clip(o, LIMITS.MAX_OPTION)).filter(Boolean);
      const uniq = [...new Set(opts)].slice(0, LIMITS.MAX_OPTIONS);
      if (uniq.length < 2) errors.push(`"${label}" needs at least two choices.`);
      out.options = uniq;
    }
    if (kind === 'text') out.long = f.long === true;
    fields.push(out);
  });
  if (raw.length && !seenContact.has('email') && !seenContact.has('phone')) {
    errors.push('Add an Email or a Phone field, so the person can be found in your customers and sent a code.');
  }
  const consentEnabled = d.consent_enabled !== false;
  const clean = {
    name,
    location_id: typeof d.location_id === 'string' && d.location_id ? d.location_id : null,
    fields,
    consent_enabled: consentEnabled,
    consent_text: clip(d.consent_text, LIMITS.MAX_CONSENT_TEXT) || DEFAULT_CONSENT_TEXT,
    submit_label: clip(d.submit_label, LIMITS.MAX_SUBMIT_LABEL) || DEFAULT_SUBMIT_LABEL,
    thanks_text: clip(d.thanks_text, LIMITS.MAX_THANKS) || DEFAULT_THANKS,
    status: d.status === 'archived' ? 'archived' : 'active',
  };
  return { ok: errors.length === 0, errors, clean };
}

// ── submissions ───────────────────────────────────────────────────────────────

export const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]{1,64}@[^\s@<>()[\]\\,;:"]{1,190}\.[a-z]{2,}$/i;

/** Truthy tick values a form post or a fetch can carry ('on' from a plain checkbox). */
export function ticked(v) {
  if (v === true) return true;
  const s = str(v).trim().toLowerCase();
  return s === 'on' || s === 'true' || s === '1' || s === 'yes';
}

/** True when the hidden honeypot box has anything in it. */
export function isHoneypotTripped(raw) {
  return isObj(raw) && str(raw[HONEYPOT_FIELD]).trim() !== '';
}

/** A YYYY-MM-DD birthday that is a real date, not in the future, and after 1900. null otherwise. */
export function cleanBirthday(v, now = new Date()) {
  const s = str(v).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  if (y < 1900 || dt.getTime() > now.getTime()) return null;
  return s;
}

/** Digits in a phone answer. */
const phoneDigits = (v) => str(v).replace(/\D/g, '');

/**
 * Check a submission against the form's own fields. Never throws.
 * raw: the posted fields ({ [field id]: value, consent }), from JSON or a form post.
 * → { ok, errors: { [field id]: words }, answers: { [field id]: value }, contact: { first_name,
 *     last_name, email, phone, birthday }, consent: bool }
 * Unknown keys are dropped. The phone is kept as typed; the server keys it (phoneKey.js).
 */
export function validateSubmission(form, raw, now = new Date()) {
  const errors = {};
  const answers = {};
  const contact = { first_name: null, last_name: null, email: null, phone: null, birthday: null };
  const r = isObj(raw) ? raw : {};
  const fields = form && Array.isArray(form.fields) ? form.fields : [];
  for (const f of fields) {
    if (!f || !FIELD_KINDS.includes(f.kind)) continue;
    const v = r[f.id];
    const label = f.label || KIND_LABELS[f.kind];
    if (f.kind === 'tickbox') {
      const on = ticked(v);
      if (f.required && !on) errors[f.id] = `Please tick "${label}".`;
      answers[f.id] = on;
      continue;
    }
    const s = str(v).trim();
    if (!s) { if (f.required) errors[f.id] = `Please fill in ${label.toLowerCase()}.`; continue; }
    switch (f.kind) {
      case 'first_name': case 'last_name': {
        const name = s.slice(0, LIMITS.MAX_NAME);
        answers[f.id] = name; contact[f.kind] = name; break;
      }
      case 'email': {
        const e = s.toLowerCase();
        if (e.length > LIMITS.MAX_EMAIL || !EMAIL_RE.test(e)) { errors[f.id] = 'Please enter a real email address.'; break; }
        answers[f.id] = e; contact.email = e; break;
      }
      case 'phone': {
        const digits = phoneDigits(s);
        if (digits.length < 7 || digits.length > 15) { errors[f.id] = 'Please enter a real phone number.'; break; }
        const p = s.slice(0, 40);
        answers[f.id] = p; contact.phone = p; break;
      }
      case 'birthday': {
        const b = cleanBirthday(s, now);
        if (!b) { errors[f.id] = 'Please enter a real date.'; break; }
        answers[f.id] = b; contact.birthday = b; break;
      }
      case 'dropdown': {
        const opts = Array.isArray(f.options) ? f.options : [];
        if (!opts.includes(s)) { errors[f.id] = `Please pick one of the choices for ${label.toLowerCase()}.`; break; }
        answers[f.id] = s; break;
      }
      case 'text':
        answers[f.id] = s.slice(0, f.long ? LIMITS.MAX_TEXT_ANSWER : LIMITS.MAX_SHORT_ANSWER); break;
      default: break;
    }
  }
  const consent = !!(form && form.consent_enabled !== false) && ticked(r.consent);
  return { ok: Object.keys(errors).length === 0, errors, answers, contact, consent };
}

/** The first error in field order, for the one line a no JavaScript page can show. */
export function firstError(form, errors) {
  const fields = form && Array.isArray(form.fields) ? form.fields : [];
  for (const f of fields) if (errors && errors[f.id]) return errors[f.id];
  const any = errors ? Object.values(errors)[0] : '';
  return any || '';
}

/** Turn a form post body (URLSearchParams or a plain object) into the raw fields object. */
export function fieldsFromForm(params) {
  const out = {};
  if (!params) return out;
  const entries = typeof params.entries === 'function' ? [...params.entries()] : Object.entries(params);
  for (const [k, v] of entries) {
    if (typeof k !== 'string' || k.length > 60) continue;
    if (Object.keys(out).length >= 60) break;
    out[k] = typeof v === 'string' ? v.slice(0, 2000) : v;
  }
  return out;
}

// ── rate limit ────────────────────────────────────────────────────────────────

/** The start of the window to count recent submissions from (ISO). */
export function rateWindowStart(now = new Date()) {
  return new Date(now.getTime() - RATE_LIMIT.windowMs).toISOString();
}

/** True when this submission would be over the limit, given how many the same form and ip hash already have in the window. */
export function rateLimited(recentCount) {
  const n = Number(recentCount);
  return Number.isFinite(n) && n >= RATE_LIMIT.max;
}

export const RATE_LIMIT_WORDS = 'You have sent this form a few times already. Please try again in 10 minutes.';

// ── customer match ────────────────────────────────────────────────────────────

/** A name for customers.name, never null or empty: the person's name, else their email or phone. */
export function customerName(contact) {
  const c = contact || {};
  const full = [c.first_name, c.last_name].map((x) => str(x).trim()).filter(Boolean).join(' ');
  if (full) return full.slice(0, LIMITS.MAX_NAME);
  if (c.email) return str(c.email).split('@')[0].slice(0, LIMITS.MAX_NAME) || 'Form guest';
  if (c.phone) return str(c.phone).slice(0, 40);
  return 'Form guest';
}

/**
 * Find or make the customer. existing: the company's customer row found by phone, else by email
 * (or null). contact: validateSubmission's contact, with phone already keyed. Fills blanks,
 * never overwrites what the venue already holds, never clears a name.
 * → { mode: 'none' } when there is no email and no phone,
 *   { mode: 'update', id, patch } or { mode: 'insert', row }.
 */
export function planCustomer({ existing, contact, phoneRaw = null, consent = false, nowIso, orgId, source = 'form' }) {
  const c = contact || {};
  if (!c.email && !c.phone) return { mode: 'none' };
  const name = customerName(c);
  if (existing && existing.id) {
    const patch = { updated_at: nowIso };
    if (c.email && !existing.email) patch.email = c.email;
    if (c.phone && !existing.phone) { patch.phone = c.phone; if (phoneRaw) patch.phone_raw = phoneRaw; }
    if (c.first_name && !existing.first_name) patch.first_name = c.first_name;
    if (c.last_name && !existing.last_name) patch.last_name = c.last_name;
    // '' is a loyalty sign up that never finished its profile: a real name now fills it.
    if (!str(existing.name).trim() && (c.first_name || c.last_name)) patch.name = name;
    if (c.birthday && !existing.birthday) patch.birthday = c.birthday;
    const sources = Array.isArray(existing.sources) ? existing.sources : [];
    if (!sources.includes(source)) patch.sources = [...sources, source];
    if (!existing.source) patch.source = source;
    if (consent && !existing.marketing_opt_in) { patch.marketing_opt_in = true; patch.marketing_opt_in_at = nowIso; }
    return { mode: 'update', id: existing.id, patch };
  }
  return {
    mode: 'insert',
    row: {
      org_id: orgId, name, first_name: c.first_name || null, last_name: c.last_name || null,
      email: c.email || null, phone: c.phone || null, phone_raw: c.phone ? phoneRaw : null,
      birthday: c.birthday || null, source, sources: [source],
      marketing_opt_in: !!consent, marketing_opt_in_at: consent ? nowIso : null,
    },
  };
}

// ── automation decision ───────────────────────────────────────────────────────

/** Which of a step's channels ('email' | 'sms' | 'both') this person can be reached on. */
export function reachableChannels(channel, customer) {
  const c = customer || {};
  const want = channel === 'both' ? ['email', 'sms'] : channel === 'sms' ? ['sms'] : ['email'];
  return want.filter((ch) => (ch === 'email' ? !!str(c.email).trim() : !!str(c.phone).trim()));
}

/**
 * Should a "Form submitted" automation take this person in? One code per person per form
 * unless the offer allows more.
 *   consent         the tick on this submission
 *   enrollment      their existing enrollment in this automation, or null
 *   codesFromForm   promo codes this form's automation already gave them
 *   perCustomer     offers.per_customer_limit of the step's offer (1 when there is no offer)
 * → { action: 'enrol' | 'rearm' | 'skip', reason }
 *   enrol  = first time: a new enrollment at step 1
 *   rearm  = they finished and the offer allows another code: start again (next round)
 *   skip   = no tick, still going through it, or already had their codes
 */
export function planFormEnrol({ consent, enrollment, codesFromForm = 0, perCustomer = 1 }) {
  if (!consent) return { action: 'skip', reason: 'no_consent' };
  const limit = Math.max(1, Number(perCustomer) || 1);
  if (!enrollment) return { action: 'enrol', reason: 'first' };
  if (enrollment.status === 'active') return { action: 'skip', reason: 'in_progress' };
  if ((Number(codesFromForm) || 0) < limit) return { action: 'rearm', reason: 'offer_allows_more' };
  return { action: 'skip', reason: 'already_sent' };
}

/** The step key a round uses: round 0 is the plain key (every enrollment before forms), later rounds add #r<n>. */
export function roundStepKey(key, round) {
  const n = Number(round) || 0;
  return n > 0 ? `${key}#r${n}` : key;
}

/** The entry trigger of a "Form submitted" automation, or null. */
export function formTriggerId(workflow) {
  const tr = workflow && isObj(workflow.entry_trigger) ? workflow.entry_trigger : null;
  return tr && tr.type === 'form_submitted' && typeof tr.form_id === 'string' && tr.form_id ? tr.form_id : null;
}

// ── where a no JavaScript post goes back to ───────────────────────────────────

/**
 * True when a host may be sent back to after a plain form post: our own app and customer hosts,
 * the website builder's free hosts, a local dev server, our own Vercel previews. A venue's own
 * domain is checked against the live websites by the caller (web_resolve_host).
 */
export function isOwnHost(host, root = 'serv-os.app') {
  const h = str(host).toLowerCase().replace(/:\d+$/, '');
  if (!h) return false;
  if (h === 'localhost' || h === '127.0.0.1') return true;
  const r = str(root).toLowerCase() || 'serv-os.app';
  if (h === r || h.endsWith(`.${r}`)) return true;
  if (h === 'serv-os.app' || h.endsWith('.serv-os.app')) return true;
  return /^possystem[a-z0-9-]*\.vercel\.app$/.test(h);
}

/** A return URL as a URL object when it is http(s), else null. */
export function parseReturnTo(v) {
  const s = str(v).trim();
  if (!s || s.length > 2000) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (u.protocol === 'http:' && !/^(localhost|127\.0\.0\.1)$/.test(u.hostname)) return null;
    return u;
  } catch { return null; }
}

export const RETURN_PARAMS = Object.freeze(['form_sent', 'form_failed', 'form_error']);

/**
 * Where to send the browser after a plain post: the page it came from with ?form_sent=<form id>
 * (or ?form_failed=<form id>&form_error=<words>), and #form-<form id> so it lands on the form.
 * Old form_* params are dropped first.
 */
export function returnUrl(u, formId, { sent = false, error = '' } = {}) {
  const out = new URL(u.toString());
  for (const k of RETURN_PARAMS) out.searchParams.delete(k);
  if (sent) out.searchParams.set('form_sent', formId);
  else {
    out.searchParams.set('form_failed', formId);
    out.searchParams.set('form_error', str(error).slice(0, 200) || 'Something went wrong. Please try again.');
  }
  out.hash = `form-${formId}`;
  return out.toString();
}

/** The outcome a page reads back from its address: { sent, errorFor, error } (ids, words), never throws. */
export function formStateFrom(search) {
  let q;
  try { q = new URLSearchParams(typeof search === 'string' ? search : ''); } catch { q = new URLSearchParams(''); }
  const id = (v) => (/^[0-9a-f-]{36}$/i.test(str(v)) ? str(v).toLowerCase() : null);
  return { sent: id(q.get('form_sent')), errorFor: id(q.get('form_failed')), error: str(q.get('form_error')).slice(0, 200) };
}

// ── Back Office ───────────────────────────────────────────────────────────────

/** CSV text for a form's submissions: one column per field, then consent, customer and date. */
export function submissionsCsv(form, rows) {
  const fields = form && Array.isArray(form.fields) ? form.fields : [];
  const q = (v) => {
    const s = v === true ? 'Yes' : v === false ? 'No' : str(v);
    // A cell starting with = + - @ is read as a formula by spreadsheets: lead with a quote.
    const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const head = [...fields.map((f) => f.label || f.id), 'Marketing tick', 'Customer', 'Sent at'];
  const lines = [head.map(q).join(',')];
  for (const r of Array.isArray(rows) ? rows : []) {
    const a = isObj(r.answers) ? r.answers : {};
    lines.push([...fields.map((f) => a[f.id] ?? ''), !!r.consent, r.customer_id || '', r.created_at || ''].map(q).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

/**
 * The embed snippet for any website: a small script that drops in an iframe which grows to fit,
 * and a <noscript> iframe for a browser with JavaScript off. origin = the app (https://app.serv-os.app).
 */
export function embedSnippet(formId, origin) {
  const o = str(origin).replace(/\/$/, '');
  const id = str(formId).replace(/[^a-f0-9-]/gi, '');
  const page = `${o}/api/form?id=${id}`;
  return [
    `<div id="servos-form-${id}"></div>`,
    `<script src="${o}/api/form?script=1&id=${id}" async></script>`,
    `<noscript><iframe src="${page}" title="Form" style="width:100%;max-width:560px;height:720px;border:0"></iframe></noscript>`,
  ].join('\n');
}
