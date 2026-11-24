// supabase/functions/_shared/docRequests.js (5.12.89)
//
// "Send it again": the documents a team member is asked to upload again, and the words for it.
// One copy for staff-portal (the staff app's list and the email) and the Back Office (the Resend
// button and what the row says). Pure, no imports: node --test (src/staff/docRequests.test.js).
//
// WHY (HR feedback, 23 Nov 2026): a manager who rejected a Right to Work upload had no way to ask
// for a new one. The staff app's step was ticked the moment the first file went up and never opened
// again, and the person was never told why it was refused. Now:
//   rejected            the staff app asks for it again, with the manager's reason
//   expired             the staff app asks for the new one by itself
//   asked again         a manager pressed Resend on any document (wf_documents.requested_at)
//   waiting for review  never asked (they have just sent it)
// The onboarding step itself is left alone: who may be put on the rota is decided by it in three
// places (the Back Office, staff-portal and the database), and none of that changes here.

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Why one document is asked for again ('rejected' | 'expired' | 'requested' | 'missing'), or null. */
export function requestReason(doc, today) {
  if (!doc) return null;
  const status = String(doc.status || '');
  if (status === 'pending') return null;
  if (status === 'rejected') return 'rejected';
  const expired = !!doc.expiry && String(doc.expiry).slice(0, 10) < String(today).slice(0, 10);
  if (expired) return 'expired';
  if (doc.requested_at || doc.requestedAt) return (doc.file_url || doc.fileUrl) ? 'requested' : 'missing';
  return null;
}

/** The staff app's list: [{ id, type, reason, note }], refused ones first. docs: wf_documents rows. */
export function docRequestsFor(docs, today) {
  const order = { rejected: 0, expired: 1, missing: 2, requested: 3 };
  return (docs || [])
    .map((d) => ({ id: d.id, type: d.type, reason: requestReason(d, today), note: String(d.review_note ?? d.reviewNote ?? '').trim() || null }))
    .filter((r) => r.reason)
    .sort((a, b) => order[a.reason] - order[b.reason] || String(a.type).localeCompare(String(b.type)));
}

/** The words on the staff app card and in the email: { title, body }. label: 'Right to Work'. */
export function requestWords(reason, label) {
  const doc = label || 'document';
  if (reason === 'rejected') return { title: `Your ${doc} was not accepted`, body: 'Please upload it again.' };
  if (reason === 'expired') return { title: `Your ${doc} has expired`, body: 'Please upload the new one.' };
  if (reason === 'missing') return { title: `Please upload your ${doc}`, body: 'Your manager has asked for it.' };
  return { title: `Please upload your ${doc} again`, body: 'Your manager has asked for a new copy.' };
}

/** The reason a manager types when rejecting: required, short, plain text. Returns words or null. */
export function rejectNoteProblem(note) {
  const n = String(note || '').trim();
  if (n.length < 3) return 'Say why it was rejected, so they know what to send instead.';
  if (n.length > 500) return 'Keep the reason under 500 characters.';
  return null;
}
export const cleanNote = (note) => String(note || '').trim().replace(/\s+/g, ' ').slice(0, 500);

/** The email to the team member: { subject, html, text }. Nothing typed by a manager reaches the HTML raw. */
export function requestEmail({ first, label, reason, note, url, venueName }) {
  const w = requestWords(reason, label);
  const hi = `Hi ${first || 'there'},`;
  const why = note ? `Your manager said: ${note}` : '';
  const from = venueName ? ` at ${venueName}` : '';
  const html = `<div style="font-family:system-ui,sans-serif;max-width:560px">
    <p>${esc(hi)}</p>
    <p><strong>${esc(w.title)}</strong>${esc(from)}. ${esc(w.body)}</p>
    ${why ? `<p style="background:#f6f7f8;border-radius:10px;padding:12px 14px">${esc(why)}</p>` : ''}
    <p>Open the staff app, go to Tasks and tap Upload. A photo or a PDF is fine.</p>
    <p style="margin:22px 0"><a href="${esc(url)}" style="background:#15C26A;color:#fff;padding:12px 22px;border-radius:10px;text-decoration:none;font-weight:700">Open my staff app</a></p>
  </div>`;
  const text = [hi, `${w.title}${from}. ${w.body}`, why, `Open your staff app, go to Tasks and tap Upload: ${url}`].filter(Boolean).join('\n\n');
  return { subject: w.title, html, text };
}

/** The stored file's name for a document type, so identity files keep their private rule (20261121a
 *  reads the name: RTW-, I9-, passport-, visa-, id-). */
export function docFileName(type, stamp, ext) {
  const safeType = String(type || 'doc').replace(/[^a-z0-9]/gi, '') || 'doc';
  const safeExt = String(ext || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5) || 'jpg';
  return `${safeType}-${stamp}.${safeExt}`;
}

/**
 * The Back Office toast after asking (or rejecting): what the person was told, honestly.
 * answer: staff-portal's { emailed, hasLogin, kept }. hasEmail: is an email on their record.
 */
export function askedWords({ name, rejected = false, answer = {}, hasEmail = true } = {}) {
  const who = String(name || 'They').split(' ')[0] || 'They';
  const lead = rejected ? 'Rejected. ' : '';
  const app = answer.hasLogin ? 'It is in their staff app, under Tasks.' : 'It will show in their staff app once they have a login.';
  const told = answer.emailed ? `${who} has been emailed. ${app}`
    : hasEmail ? `The email to ${who} did not send, so tell them yourself. ${app}`
    : `${who} has no email on file, so tell them yourself. ${app}`;
  const kept = answer.kept === false ? ' The reason could not be kept on the record yet: the 5.12.89 database update has not been run.' : '';
  return `${lead}${told}${kept}`;
}
