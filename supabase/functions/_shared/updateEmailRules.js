// supabase/functions/_shared/updateEmailRules.js
//
// EMAIL AN UPDATE TO BACK OFFICE LOGINS: the rules, with no database, no browser and no mail
// provider in them.
//
// WHY (Peter, 8 Oct 2026): he writes a what's new email for clients each week. "Do we have a way
// to email it to people that are registered in the back office? Right now it's only a few and I
// can manually send, but would be good to be able to send it out."
//
// His calls (8 Oct 2026): a panel on Company Admin, Messages to venues. Subject plus a body in
// simple Markdown with a live preview; pick companies (all or some), every owner or manager
// login with Back Office access and an email, one email per person; a test to himself first,
// and Send only opens once a test of the CURRENT text has gone; the server re derives the list
// and refuses if the count differs; one row per recipient per send in public.update_emails.
//
// This file is shared by the update-emails-admin edge function (it renders the email and picks
// the recipients again on the server) and by the app (src/lib/updateEmailRules.js re-exports
// it), so the preview on screen and the email that is sent can never differ.
//
// PURE. No imports, so node tests load it directly.

export const SUBJECT_MAX = 120;
export const BODY_MAX = 15000;
export const NAME_MAX = 80;
export const MAX_RECIPIENTS_PER_SEND = 100;
export const SENDER_NAME = 'ServOS';
export const DEFAULT_FROM = 'hello@posup.co.uk';
export const TEST_PREFIX = '[TEST] ';
export const STATUSES = Object.freeze(['queued', 'sent', 'failed']);
// Sending pace (8 Oct 2026, review): Resend allows about 2 requests a second. One request at a
// time with this gap between them stays under it; a 429 is still retried, honouring Retry-After.
export const SEND_GAP_MS = 550;
// A provider call that has not answered by now is that row's failure, never a stalled run.
export const PROVIDER_TIMEOUT_MS = 15000;
// A row left 'queued' this long belongs to a run that died (or is still going: the edge function
// wall clock is shorter than this). Only after this may a second try claim it and send again.
export const STALE_QUEUED_MS = 10 * 60 * 1000;
export const RETRY_429_MAX = 5;     // tries on "too many requests": the pace is ours to fix
export const RETRY_OTHER_MAX = 3;   // tries on a 5xx or a network failure
// ServOS staff: the role on the profile, or an email on one of these domains.
export const STAFF_DOMAINS = Object.freeze(['serv-os.app', 'posup.co.uk']);
export const LOGIN_ROLES = Object.freeze(['owner', 'manager']);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);

// A plain check that something looks like an address. The provider does the real check.
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
export const isEmail = (v) => typeof v === 'string' && EMAIL_RE.test(v.trim());

// Control characters other than a line break have no place in a subject or a body.
const stripControl = (s, keepNewlines) => {
  let out = '';
  for (const ch of String(s == null ? '' : s)) {
    const c = ch.codePointAt(0);
    if (c === 10 && keepNewlines) { out += ch; continue; }
    if (c === 9) { out += '  '; continue; }
    if (c < 32 || c === 127) continue;
    out += ch;
  }
  return out;
};

/** A subject or a name on one line: no control characters, single spaces, trimmed. */
export function oneLine(text) {
  return stripControl(String(text == null ? '' : text).replace(/\r\n?|\n/g, ' '), false).replace(/\s+/g, ' ').trim();
}

/**
 * The body as it is stored and rendered: line breaks kept (Windows ones made plain), tabs made
 * spaces, no other control characters, no trailing spaces on a line, never more than one blank
 * line in a row, nothing blank at either end.
 */
export function cleanBodyMd(text) {
  const lines = stripControl(String(text == null ? '' : text).replace(/\r\n?/g, '\n'), true)
    .split('\n').map((l) => l.replace(/\s+$/, ''));
  const out = [];
  for (const l of lines) {
    if (l === '' && (out.length === 0 || out[out.length - 1] === '')) continue;
    out.push(l);
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  return out.join('\n');
}

/**
 * Check a draft. Too long is REFUSED, never cut: an email that lost its last paragraph without
 * the sender knowing is worse than one that was not sent.
 * @returns {{ok:true,subject:string,bodyMd:string}|{ok:false,error:string}}
 */
export function cleanDraft(draft) {
  const d = draft || {};
  const subject = oneLine(d.subject);
  const bodyMd = cleanBodyMd(d.body_md != null ? d.body_md : d.bodyMd);
  if (!subject) return { ok: false, error: 'Write a subject first.' };
  if ([...subject].length > SUBJECT_MAX) return { ok: false, error: `The subject is too long. Keep it to ${SUBJECT_MAX} characters.` };
  if (!bodyMd) return { ok: false, error: 'Write the email first.' };
  if ([...bodyMd].length > BODY_MAX) return { ok: false, error: `The email is too long. Keep it to ${BODY_MAX} characters.` };
  return { ok: true, subject, bodyMd };
}

/**
 * One short code for one text (subject and body, cleaned). The screen keeps the code of the
 * text it last sent as a test: Send opens only while the text still has that code, so a word
 * changed after the test closes it again. Not a secret, just a fingerprint (cyrb53).
 */
export function textHash(subject, bodyMd) {
  const str = `${oneLine(subject)}\n${cleanBodyMd(bodyMd)}`;
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507); h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507); h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

/**
 * Are these the same email (subject and body)? A send that is tried again under the same
 * broadcast id must carry the same words: one id is one text, always. Rows from the table have
 * body_md; a draft has bodyMd. Both are accepted.
 */
export function sameText(a, b) {
  if (!a || !b) return false;
  const body = (x) => cleanBodyMd(x.body_md != null ? x.body_md : x.bodyMd);
  return oneLine(a.subject) === oneLine(b.subject) && body(a) === body(b);
}

// ── Markdown, the small safe subset ─────────────────────────────────────────
// Exactly: # ## ### headings, paragraphs, **bold**, *italic*, bullet lists (- or * or the dot a
// document paste leaves), numbered lists (1. or 1)), links [text](url) to http, https or mailto,
// and plain line breaks inside a paragraph. Everything else is text, and every character the
// writer typed is escaped: nothing in the body ever reaches the email as HTML.

export function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const URL_OK = /^(https?:\/\/|mailto:)/i;
const LINK_RE = /\[([^[\]\n]+)\]\(([^()\s]+)\)/g;
// Bold may hold italics ("**b *i* b**"): single stars are allowed inside, double ones end it.
const BOLD_RE = /\*\*((?:[^*\n]|\*(?!\*))+?)\*\*/g;
// A single star pair not glued to a word on the outside: "2*3*4" stays as it is.
const ITALIC_RE = /(^|[^*\w])\*([^*\n]+?)\*(?![*\w])/g;

const A_STYLE = 'color:#0A8F4F;text-decoration:underline;';

const marksHtml = (s) => escapeHtml(s).replace(BOLD_RE, '<strong>$1</strong>').replace(ITALIC_RE, '$1<em>$2</em>');
const marksText = (s) => String(s).replace(BOLD_RE, '$1').replace(ITALIC_RE, '$1$2');

/** One line of text, with its links and marks, as HTML. */
export function inlineHtml(text) {
  const src = String(text == null ? '' : text);
  let out = '';
  let last = 0;
  for (const m of src.matchAll(LINK_RE)) {
    out += marksHtml(src.slice(last, m.index));
    const [whole, label, url] = m;
    // Only a web or mail link is a link. Anything else (javascript:, a bare word) is shown as
    // written, so it can be seen and fixed in the preview.
    if (URL_OK.test(url)) out += `<a href="${escapeHtml(url)}" style="${A_STYLE}">${marksHtml(label)}</a>`;
    else out += marksHtml(whole);
    last = m.index + whole.length;
  }
  return out + marksHtml(src.slice(last));
}

/** The same line as plain text: marks dropped, a link as "label (url)". */
export function inlineText(text) {
  const src = String(text == null ? '' : text);
  let out = '';
  let last = 0;
  for (const m of src.matchAll(LINK_RE)) {
    out += marksText(src.slice(last, m.index));
    const [whole, label, url] = m;
    out += URL_OK.test(url) ? `${marksText(label)} (${url})` : marksText(whole);
    last = m.index + whole.length;
  }
  return out + marksText(src.slice(last));
}

const HEADING_RE = /^(#{1,6})\s+(.+)$/;
const BULLET_RE = /^\s*[-*•]\s+(.+)$/;
const NUMBER_RE = /^\s*(\d{1,3})[.)]\s+(.+)$/;

/**
 * The body as blocks. A blank line ends a block. A plain line straight after a list ends the
 * list and starts a paragraph (the forgiving reading of a pasted document: a list is over when
 * the bullets stop). Nested bullets are flattened, never lost. Four or more hashes count as a
 * level 3 heading, never as a line of hashes in the email.
 * @returns {Array<{type:'h',level:number,text:string}|{type:'p',lines:string[]}|{type:'ul',items:string[]}|{type:'ol',start:number,items:string[]}>}
 */
export function parseBlocks(md) {
  const body = cleanBodyMd(md);
  if (!body) return [];
  const blocks = [];
  let cur = null;
  const close = () => { if (cur) { blocks.push(cur); cur = null; } };
  for (const line of body.split('\n')) {
    if (line.trim() === '') { close(); continue; }
    let m;
    if ((m = HEADING_RE.exec(line))) { close(); blocks.push({ type: 'h', level: Math.min(3, m[1].length), text: m[2].trim() }); continue; }
    if ((m = BULLET_RE.exec(line))) {
      if (!cur || cur.type !== 'ul') { close(); cur = { type: 'ul', items: [] }; }
      cur.items.push(m[1].trim());
      continue;
    }
    if ((m = NUMBER_RE.exec(line))) {
      if (!cur || cur.type !== 'ol') { close(); cur = { type: 'ol', start: Number(m[1]), items: [] }; }
      cur.items.push(m[2].trim());
      continue;
    }
    if (!cur || cur.type !== 'p') { close(); cur = { type: 'p', lines: [] }; }
    cur.lines.push(line.trim());
  }
  close();
  return blocks;
}

const TEXT = 'color:#2B302D;font-size:15px;line-height:1.6;';
const H_STYLE = {
  1: 'color:#0F1211;font-size:22px;line-height:1.3;font-weight:800;margin:0 0 12px;',
  2: 'color:#0F1211;font-size:18px;line-height:1.35;font-weight:800;margin:22px 0 8px;',
  3: 'color:#0F1211;font-size:16px;line-height:1.4;font-weight:700;margin:18px 0 6px;',
};

/** The body blocks as email HTML (inline styles only: email clients ignore stylesheets). */
export function blocksToHtml(blocks) {
  return (blocks || []).map((b) => {
    if (b.type === 'h') return `<h${b.level} style="${H_STYLE[b.level] || H_STYLE[3]}">${inlineHtml(b.text)}</h${b.level}>`;
    if (b.type === 'ul') return `<ul style="margin:0 0 14px;padding:0 0 0 22px;${TEXT}">${b.items.map((i) => `<li style="margin:4px 0;">${inlineHtml(i)}</li>`).join('')}</ul>`;
    if (b.type === 'ol') return `<ol start="${b.start || 1}" style="margin:0 0 14px;padding:0 0 0 22px;${TEXT}">${b.items.map((i) => `<li style="margin:4px 0;">${inlineHtml(i)}</li>`).join('')}</ol>`;
    return `<p style="margin:0 0 14px;${TEXT}">${b.lines.map(inlineHtml).join('<br>')}</p>`;
  }).join('\n');
}

/** The body blocks as the plain text alternative. */
export function blocksToText(blocks) {
  return (blocks || []).map((b) => {
    if (b.type === 'h') return inlineText(b.text);
    if (b.type === 'ul') return b.items.map((i) => `- ${inlineText(i)}`).join('\n');
    if (b.type === 'ol') return b.items.map((i, k) => `${(b.start || 1) + k}. ${inlineText(i)}`).join('\n');
    return b.lines.map(inlineText).join('\n');
  }).join('\n\n');
}

/** Markdown in, { html, text } out. The body only; buildEmail adds the frame and the footer. */
export function renderMarkdown(md) {
  const blocks = parseBlocks(md);
  return { html: blocksToHtml(blocks), text: blocksToText(blocks) };
}

// ── The email ───────────────────────────────────────────────────────────────

/** The one line footer. Service notice to an account holder, so there is no unsubscribe. */
export function emailFooter(companyName) {
  const c = oneLine(companyName);
  return c ? `You get this because you have a ServOS Back Office login for ${c}.` : 'You get this because you have a ServOS Back Office login.';
}

export const TEST_NOTE = 'This is a test. It went only to you.';

/**
 * The whole email for one recipient: subject, HTML and plain text. `test` puts [TEST] on the
 * subject and a note at the top, and nothing else changes, so the test shows the real thing.
 */
export function buildEmail({ subject, bodyMd, companyName, test = false } = {}) {
  const subj = `${test ? TEST_PREFIX : ''}${oneLine(subject)}`;
  const body = renderMarkdown(bodyMd);
  const footer = emailFooter(companyName);
  const font = "font-family:'Space Grotesk',system-ui,-apple-system,'Segoe UI',sans-serif;";
  // Its own row only on a test, so the real email has no empty line where the note was.
  const note = test
    ? `\n  <tr><td style="padding:0 24px;"><div style="margin:20px 0 0;padding:10px 14px;border-radius:8px;background:#E6F8EE;border:1px solid #B9EBD0;color:#0A5A33;font-size:13px;font-weight:700;">${escapeHtml(TEST_NOTE)}</div></td></tr>`
    : '';
  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(subj)}</title></head>
<body style="margin:0;padding:0;background:#F5F7F4;${font}">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#F5F7F4;padding:32px 16px;">
<tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid rgba(15,18,17,0.08);">
  <tr><td style="background:#0F1211;padding:18px 24px;">
    <span style="color:#15C26A;font-size:16px;font-weight:800;letter-spacing:-0.02em;">ServOS</span>
    <span style="color:#9AA39A;font-size:12px;margin-left:10px;">Update</span>
  </td></tr>${note}
  <tr><td style="padding:24px 24px 10px;${font}">
${body.html}
  </td></tr>
  <tr><td style="padding:14px 24px 18px;border-top:1px solid rgba(15,18,17,0.08);${font}">
    <div style="color:#5E665E;font-size:12.5px;line-height:1.5;">${escapeHtml(footer)}</div>
    <div style="margin-top:8px;font-family:'JetBrains Mono',ui-monospace,monospace;font-size:10px;text-transform:uppercase;letter-spacing:0.16em;color:#9AA39A;">Powered by ServOS &middot; serv-os.app</div>
  </td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
  const text = `${test ? `${TEST_NOTE}\n\n` : ''}${body.text}\n\n--\n${footer}`;
  return { subject: subj, html, text };
}

/**
 * Who the email is from: the ServOS address send-welcome uses (RECEIPT_EMAIL_FROM, falling back
 * to hello@posup.co.uk), shown as "ServOS", replies to the same address. A value that already
 * carries a display name ("Name <a@b>") keeps only the address: it is ServOS writing.
 */
export function servosSender(fromEnv) {
  const raw = oneLine(fromEnv);
  const inAngle = /<([^<>\s]+)>/.exec(raw);
  const email = (inAngle ? inAngle[1] : raw).toLowerCase();
  const addr = isEmail(email) ? email : DEFAULT_FROM;
  return { from: `${SENDER_NAME} <${addr}>`, email: addr, replyTo: addr };
}

/**
 * The provider request for one email, in the shape send-welcome and send-receipt use
 * (provider: resend or postmark; anything else, or no key, sends nothing and returns null).
 */
export function providerRequest({ provider, resendKey, postmarkKey, sender, to, subject, html, text, idempotencyKey = null }) {
  const p = String(provider || '').toLowerCase();
  if (!isEmail(to) || !sender || !sender.from) return null;
  if (p === 'resend' && resendKey) {
    return {
      url: 'https://api.resend.com/emails',
      // Idempotency-Key (8 Oct 2026, review): the same key within 24 hours is the same email to
      // Resend, so even a request repeated after a lost reply cannot produce a second copy.
      headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json', ...(idempotencyKey ? { 'Idempotency-Key': String(idempotencyKey) } : {}) },
      body: { from: sender.from, to: [to], subject, html, text, ...(sender.replyTo ? { reply_to: sender.replyTo } : {}) },
    };
  }
  if (p === 'postmark' && postmarkKey) {
    return {
      url: 'https://api.postmarkapp.com/email',
      headers: { 'X-Postmark-Server-Token': postmarkKey, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: { From: sender.from, To: to, Subject: subject, HtmlBody: html, TextBody: text, ...(sender.replyTo ? { ReplyTo: sender.replyTo } : {}) },
    };
  }
  return null;
}

/**
 * One key per person per send for the provider: broadcast id and address. Resend keeps it for
 * 24 hours and refuses to send the same key twice. Resend caps a key at 256 characters.
 */
export function idempotencyKey(broadcastId, email) {
  return `${String(broadcastId || '')}/${String(email || '').trim().toLowerCase()}`.slice(0, 256);
}

/**
 * Seconds or an HTTP date from a Retry-After header, as milliseconds from now; null when there
 * is none or it cannot be read.
 */
export function parseRetryAfter(value, nowMs = Date.now()) {
  const v = String(value == null ? '' : value).trim();
  if (!v) return null;
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.max(0, t - nowMs) : null;
}

/**
 * How long to wait before trying one email again, or null to stop and record the failure.
 *   429            up to RETRY_429_MAX tries, waiting what Retry-After says (1.1 to 10 seconds,
 *                  1.1 when it says nothing): the provider's pace, not a fixed guess;
 *   5xx or no answer (status null: a network failure or the timeout)
 *                  up to RETRY_OTHER_MAX tries, 0.7 s then 1.4 s;
 *   any other 4xx  final: the request itself was refused and will be refused again.
 */
export function retryDelayMs({ status, attempt, retryAfter, nowMs = Date.now() } = {}) {
  const a = Math.max(1, Number(attempt) || 1);
  const s = status == null ? null : Number(status);
  if (s === 429) {
    if (a >= RETRY_429_MAX) return null;
    const asked = parseRetryAfter(retryAfter, nowMs);
    return Math.min(10000, Math.max(1100, asked == null ? 1100 : asked));
  }
  if (s == null || s === 0 || s >= 500) {
    if (a >= RETRY_OTHER_MAX) return null;
    return 700 * a;
  }
  return null;
}

/** The provider's id for a sent email, whichever provider answered. */
export function providerMessageId(provider, reply) {
  const r = reply || {};
  return String(provider || '').toLowerCase() === 'postmark' ? (r.MessageID || null) : (r.id || null);
}

/** Is email sending set up at all? Shown plainly instead of a failed send. */
export function providerReady({ provider, resendKey, postmarkKey } = {}) {
  const p = String(provider || '').toLowerCase();
  return (p === 'resend' && !!resendKey) || (p === 'postmark' && !!postmarkKey);
}

export const NO_PROVIDER_LINE = 'Email sending is not set up on the server (RECEIPT_EMAIL_PROVIDER and its key). Nothing was sent.';

// ── Who gets it ─────────────────────────────────────────────────────────────

/** An email on a ServOS domain (exact domain, any case, +tags allowed). */
export function isStaffEmail(email) {
  const at = String(email || '').trim().toLowerCase().lastIndexOf('@');
  if (at < 0) return false;
  const domain = String(email).trim().toLowerCase().slice(at + 1);
  return STAFF_DOMAINS.includes(domain);
}

const ROLE_RANK = { owner: 0, manager: 1, super_admin: 2 };

/**
 * The recipients, from the Back Office logins.
 *   * a login is a user_profiles row with role owner or manager and bo_access not false;
 *   * its email is the sign in email (authEmails, by user id) else the one on the profile;
 *   * ServOS staff (role super_admin, or an email on a ServOS domain) are left out unless
 *     includeStaff; a super_admin with no company is reached only when every company is picked;
 *   * ownersOnly drops managers;
 *   * companyIds null means every company; a list means only those (an empty list, nobody);
 *   * each email once: owner before manager before staff, then by name.
 * Runs the same on the screen and on the server (the server's lists are its own reads).
 * @param {{profiles:Array<object>, authEmails?:Map|Record<string,string>, orgs:Array<{id:string,name:string}>,
 *   companyIds?:string[]|null, ownersOnly?:boolean, includeStaff?:boolean}} input
 * @returns {{recipients:Array<{userId:string,email:string,name:string,role:string,orgId:string|null,company:string}>,
 *   left:{notLogin:number,noAccess:number,noEmail:number,staff:number,managers:number,otherCompany:number,duplicate:number}}}
 */
export function pickRecipients(input) {
  const { profiles = [], authEmails = null, orgs = [], companyIds = null, ownersOnly = false, includeStaff = false } = input || {};
  const orgName = new Map((orgs || []).filter((o) => o && o.id).map((o) => [String(o.id), oneLine(o.name) || 'Unnamed company']));
  const wanted = Array.isArray(companyIds) ? new Set(companyIds.filter(Boolean).map(String)) : null;
  const emailOf = (id) => {
    if (!authEmails) return null;
    const v = authEmails instanceof Map ? authEmails.get(String(id)) : authEmails[String(id)];
    return v == null ? null : String(v);
  };
  const left = { notLogin: 0, noAccess: 0, noEmail: 0, staff: 0, managers: 0, otherCompany: 0, duplicate: 0 };
  const picked = [];
  for (const p of profiles || []) {
    if (!p || !p.id) continue;
    const role = String(p.role || '');
    const isStaffRole = role === 'super_admin';
    if (!LOGIN_ROLES.includes(role) && !isStaffRole) { left.notLogin += 1; continue; }
    if (p.bo_access === false) { left.noAccess += 1; continue; }
    const email = String(emailOf(p.id) || p.email || '').trim().toLowerCase();
    if (!isEmail(email)) { left.noEmail += 1; continue; }
    if ((isStaffRole || isStaffEmail(email)) && !includeStaff) { left.staff += 1; continue; }
    if (ownersOnly && role === 'manager') { left.managers += 1; continue; }
    const orgId = p.org_id ? String(p.org_id) : null;
    if (wanted && (!orgId || !wanted.has(orgId))) { left.otherCompany += 1; continue; }
    picked.push({
      userId: String(p.id), email, name: oneLine(p.full_name).slice(0, NAME_MAX) || '', role, orgId,
      company: orgId ? (orgName.get(orgId) || 'Company removed') : (isStaffRole ? 'ServOS' : 'No company'),
    });
  }
  picked.sort((a, b) => a.company.localeCompare(b.company) || (ROLE_RANK[a.role] ?? 9) - (ROLE_RANK[b.role] ?? 9)
    || a.name.localeCompare(b.name) || a.email.localeCompare(b.email));
  const seen = new Set();
  const recipients = [];
  for (const r of picked) {
    if (seen.has(r.email)) { left.duplicate += 1; continue; }
    seen.add(r.email);
    recipients.push(r);
  }
  recipients.sort((a, b) => a.company.localeCompare(b.company) || a.name.localeCompare(b.name) || a.email.localeCompare(b.email));
  return { recipients, left };
}

/** How many logins each company has in a recipient list, for the tick list. */
export function countByCompany(recipients) {
  const out = new Map();
  for (const r of recipients || []) {
    const key = r.orgId || 'none';
    out.set(key, (out.get(key) || 0) + 1);
  }
  return out;
}

export const peopleWord = (n) => (Number(n) === 1 ? '1 person' : `${Number(n) || 0} people`);

/** The one confirm question: "Email 7 people now?" */
export function sendQuestion(count) {
  return `Email ${peopleWord(count)} now?`;
}

/**
 * What the screen says after a send. `sent` and `failed` are this call's own results; `skipped`
 * is how many already had it from an earlier try of the same send (a second try after a lost
 * reply). Never claims a send that sent nothing.
 */
export function sendResultLine({ sent = 0, failed = 0, skipped = 0, waiting = 0 } = {}) {
  const s = Number(sent) || 0, f = Number(failed) || 0, k = Number(skipped) || 0, w = Number(waiting) || 0;
  const parts = [];
  if (s > 0) parts.push(`Sent to ${peopleWord(s)}.`);
  if (f > 0) parts.push(`${f === 1 ? '1 email' : `${f} emails`} failed. See Sent below for who, then Send again: only the failed ones go.`);
  if (k > 0) parts.push(`${k === 1 ? '1 person' : `${k} people`} already had it. Nothing was sent twice.`);
  // Rows another run of the same send still holds (queued less than STALE_QUEUED_MS ago).
  if (w > 0) parts.push(`${w === 1 ? '1 is' : `${w} are`} still going from an earlier try. Check Sent below in 10 minutes.`);
  return parts.join(' ') || 'Nothing was sent.';
}

/**
 * Is the list the screen showed (its emails) the list the server derived? The server refuses a
 * send whose people differ, not only whose number differs: nobody the admin never saw gets it.
 * An older screen that sent no list leaves the count check on its own.
 */
export function sameRecipientSet(shownEmails, recipients) {
  if (!Array.isArray(shownEmails)) return true;
  const shown = new Set(shownEmails.map((e) => String(e == null ? '' : e).trim().toLowerCase()).filter(Boolean));
  const mine = new Set((recipients || []).map((r) => String(r.email || '').toLowerCase()));
  if (shown.size !== mine.size) return false;
  for (const e of mine) if (!shown.has(e)) return false;
  return true;
}

// ── Sending ─────────────────────────────────────────────────────────────────

const timeOf = (iso) => { const t = Date.parse(iso || ''); return Number.isFinite(t) ? t : 0; };

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Send to every recipient, a few at a time, and never stop for one failure. `sendOne(recipient)`
 * is the ONE place an email leaves (the edge function gives the real one; tests give a stub) and
 * answers { ok, id?, error? } or throws. Results come back in the recipients' order.
 * `minGapMs` is the pause a worker takes after each email before its next one (the provider's
 * rate limit, SEND_GAP_MS); `sleep` is only ever replaced by a test.
 */
export async function deliverAll(recipients, sendOne, { concurrency = 4, minGapMs = 0, sleep = defaultSleep } = {}) {
  const list = recipients || [];
  const results = new Array(list.length);
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const i = next++;
      const r = list[i];
      try {
        const out = (await sendOne(r)) || {};
        results[i] = out.ok ? { recipient: r, ok: true, id: out.id || null, error: null } : { recipient: r, ok: false, id: null, error: String(out.error || 'The email provider refused it.').slice(0, 500) };
      } catch (e) {
        results[i] = { recipient: r, ok: false, id: null, error: String(e && e.message ? e.message : e).slice(0, 500) };
      }
      if (minGapMs > 0 && next < list.length) await sleep(minGapMs);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, list.length || 1)) }, worker));
  return results;
}

/**
 * Which recipients still need the email on a second try of the same send: everyone whose row is
 * not already `sent` (never sent, queued when the first try stopped, or failed).
 */
export function stillToSend(recipients, priorRows) {
  const sentTo = new Set((priorRows || []).filter((r) => r && r.status === 'sent').map((r) => String(r.to_email || '').toLowerCase()));
  const todo = [];
  let skipped = 0;
  for (const r of recipients || []) {
    if (sentTo.has(String(r.email).toLowerCase())) skipped += 1;
    else todo.push(r);
  }
  return { todo, skipped };
}

/**
 * The people still to send (stillToSend's todo) sorted by what their earlier row says, so a
 * second try only ever emails people this run OWNS (8 Oct 2026, review: a second Send while the
 * first was still going emailed everyone twice, because a queued row looked like work to do):
 *   fresh    no row yet: the upsert makes one, and the rows it really inserted are this run's;
 *   retry    a failed row, or a queued row older than staleMs (its run died): claimed with one
 *            atomic update before sending, so two runs can never both take it;
 *   waiting  a queued row younger than staleMs: another run has it right now. Left alone.
 */
export function sortPriorRows(todo, priorRows, nowMs = Date.now(), staleMs = STALE_QUEUED_MS) {
  const byEmail = new Map((priorRows || []).filter((r) => r && r.to_email).map((r) => [String(r.to_email).toLowerCase(), r]));
  const fresh = [], retry = [], waiting = [];
  for (const r of todo || []) {
    const prior = byEmail.get(String(r.email).toLowerCase());
    if (!prior) { fresh.push(r); continue; }
    if (prior.status === 'failed') { retry.push(r); continue; }
    if (prior.status === 'queued') {
      const t = timeOf(prior.sent_at);
      if (!t || nowMs - t >= staleMs) retry.push(r); else waiting.push(r);
      continue;
    }
    waiting.push(r);   // 'sent' or unknown: never ours to send
  }
  return { fresh, retry, waiting };
}

/**
 * After the database answered: the people whose rows this run inserted or claimed are its own to
 * email; everyone else in todo is another run's and waits. Emails compared in lower case.
 */
export function splitOwned(todo, insertedEmails, claimedEmails) {
  const mine = new Set([...(insertedEmails || []), ...(claimedEmails || [])].map((e) => String(e || '').toLowerCase()));
  const owned = [], waiting = [];
  for (const r of todo || []) (mine.has(String(r.email).toLowerCase()) ? owned : waiting).push(r);
  return { owned, waiting };
}

// ── The Sent list ───────────────────────────────────────────────────────────

/**
 * update_emails rows grouped into sends, newest first, each with its counts and its people.
 * A test to the sender is its own group (isTest), shown small.
 */
export function rollupSends(rows, orgs = []) {
  const orgName = new Map((orgs || []).filter((o) => o && o.id).map((o) => [String(o.id), oneLine(o.name) || 'Unnamed company']));
  const groups = new Map();
  for (const r of rows || []) {
    if (!r || !r.broadcast_id) continue;
    const key = String(r.broadcast_id);
    let g = groups.get(key);
    if (!g) {
      g = {
        broadcastId: key, subject: r.subject || '', bodyMd: r.body_md || '', sentAt: r.sent_at || null, sentByName: r.sent_by_name || null,
        isTest: r.is_test === true, total: 0, sent: 0, failed: 0, queued: 0, recipients: [],
      };
      groups.set(key, g);
    }
    if (timeOf(r.sent_at) && (!g.sentAt || timeOf(r.sent_at) < timeOf(g.sentAt))) g.sentAt = r.sent_at;
    g.total += 1;
    if (r.status === 'sent') g.sent += 1;
    else if (r.status === 'failed') g.failed += 1;
    else g.queued += 1;
    g.recipients.push({
      id: r.id, email: r.to_email || '', name: r.to_name || '', role: r.role || '',
      company: r.org_id ? (orgName.get(String(r.org_id)) || 'Company removed') : (r.role === 'super_admin' ? 'ServOS' : ''),
      status: r.status || 'queued', error: r.error || null, sentAt: r.sent_at || null, providerId: r.provider_id || null,
    });
  }
  const out = [...groups.values()];
  for (const g of out) g.recipients.sort((a, b) => a.company.localeCompare(b.company) || a.name.localeCompare(b.name) || a.email.localeCompare(b.email));
  out.sort((a, b) => timeOf(b.sentAt) - timeOf(a.sentAt));
  return out;
}

/** "7 sent", "6 sent, 1 failed", "2 still queued". */
export function countsLine(g) {
  if (!g) return '';
  const parts = [`${g.sent} sent`];
  if (g.failed > 0) parts.push(`${g.failed} failed`);
  if (g.queued > 0) parts.push(`${g.queued} still queued`);
  return parts.join(', ');
}

/** Owner, Manager, ServOS staff: the word on screen for a role. */
export const ROLE_LABEL = Object.freeze({ owner: 'Owner', manager: 'Manager', super_admin: 'ServOS staff' });

/** "8 Oct, 14:32" in the viewer's own time zone. */
export function formatWhen(iso, timezone, { locale = 'en-GB' } = {}) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return '';
  const opts = { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false };
  try {
    return new Intl.DateTimeFormat(locale, { ...opts, ...(timezone ? { timeZone: timezone } : {}) }).format(new Date(t));
  } catch {
    return new Intl.DateTimeFormat(locale, opts).format(new Date(t));
  }
}
