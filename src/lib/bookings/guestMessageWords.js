// src/lib/bookings/guestMessageWords.js
//
// The guest message rules the web app shows and acts on, pure (16 Oct 2026): no imports, so
// node:test covers them (guestMessageWords.test.js). guestMessages.js does the reads and calls.

const LIVE = ['confirmed', 'prepaid'];

// A guest's CRM record id (customers.id is a uuid). A booking linked to one can be reached through
// the record's phone or email even when the booking itself has neither: booking-reminders reads
// them from the record (withCrmContact) and says per channel what it sent.
const CRM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const hasCrmRecord = (b) => CRM_ID.test(String(b?.customerId || b?.customer_id || ''));

// Can this booking's guest be reached at all: a phone or email on the booking, or a guest record.
export function hasGuestContact(b) {
  const c = b?.customer || {};
  return !!(String(c.phone || '').trim() || String(c.email || '').trim() || hasCrmRecord(b));
}

// Is this new booking one the guest should hear about? A party seated at the door is not.
// 17 Oct 2026 (v5.11.72, PR 295 follow up): a booking whose phone or email lives only on the
// guest's CRM record counts too. It used to be skipped here, so the stand's Send confirmation
// button showed, said "Asked to send", and sent nothing.
export function shouldNudge(b) {
  if (!b || !b.id) return false;
  if ((b.source || 'host') === 'walk_in') return false;
  if (!LIVE.includes(b.status || 'confirmed')) return false;
  return hasGuestContact(b);
}

const CHANNEL_WORDS = { sms: 'text', email: 'email' };

// What a Send confirmation tap did, in words, from booking-reminders' confirm answer:
//   { ok: true, sent: ['sms', 'email'], results: { sms: { sent, reason }, email: { sent, reason } } }
//   { ok: false, error }   (the booking is closed, waiting for payment, a walk in, or the call failed)
// Returns { tone: 'success' | 'info' | 'error', text }.
export function confirmResultWords(res) {
  if (!res || res.ok !== true) {
    const e = String(res?.error || '');
    if (/pending_payment/.test(e)) return { tone: 'info', text: 'Not sent: this booking is waiting for payment. The confirmation goes when it is paid.' };
    if (/walk_in/.test(e)) return { tone: 'info', text: 'Not sent: a walk in is not sent a booking confirmation.' };
    if (/unknown_or_closed/.test(e)) return { tone: 'info', text: 'Not sent: this booking is closed.' };
    return { tone: 'error', text: `Confirmation NOT sent${e ? ` (${e})` : ''}. Try again.` };
  }
  const results = res.results || {};
  const sent = (Array.isArray(res.sent) ? res.sent : []).filter((ch) => CHANNEL_WORDS[ch]);
  const already = Object.keys(CHANNEL_WORDS).filter((ch) => /already_sent|already_sending/.test(String(results[ch]?.reason || '')));
  const failed = Object.keys(CHANNEL_WORDS).filter((ch) => results[ch] && !results[ch].sent
    && !/already_sent|already_sending|no_phone_on_booking|no_email_on_booking/.test(String(results[ch].reason || '')));
  const list = (chs) => chs.map((ch) => CHANNEL_WORDS[ch]).join(' and ');
  const parts = [];
  if (sent.length) parts.push(`Confirmation sent by ${list(sent)}.`);
  if (already.length) parts.push(`Already sent by ${list(already)}, not sent twice.`);
  for (const ch of failed) parts.push(`The ${CHANNEL_WORDS[ch]} did not go: ${failureWords(results[ch].reason)}.`);
  if (!parts.length) return { tone: 'info', text: 'Not sent: no phone or email on the booking or the guest record.' };
  return { tone: failed.length && !sent.length ? 'error' : sent.length ? 'success' : 'info', text: parts.join(' ') };
}

export const KIND_WORDS = {
  confirmation: 'Confirmation',
  reminder_day: 'Reminder, the day before',
  reminder_2h: 'Reminder, 2 hours before',
  changed: 'Change',
  cancelled: 'Cancellation',
  preorder: 'Pre-order link',
};

// A provider's reason in words a host can act on.
export function failureWords(reason) {
  const r = String(reason || '');
  if (/21211|not a valid phone|invalid phone|http_400/i.test(r)) return 'the number is not a valid mobile';
  if (/21614/.test(r)) return 'the number is not a mobile';
  if (/21610|unsubscribed/i.test(r)) return 'the guest replied STOP';
  if (/resend_http_422|invalid email|validation_error/i.test(r)) return 'the email address is not valid';
  if (/email_provider_not_configured/i.test(r)) return 'email sending is not set up';
  if (/venue_turned_booking_messages_off/.test(r)) return 'booking messages are switched off for this venue';
  if (/turned_off_in_message_templates/.test(r)) return 'this message is switched off in Message templates';
  if (/no longer needed/i.test(r)) return 'no longer needed';
  if (/unreachable|http_5\d\d/i.test(r)) return 'the message service did not answer';
  return r ? r.replace(/^not sent: /, '').replace(/_/g, ' ') : 'unknown reason';
}

// One ledger row as { title, tone, text }. tone: 'ok' | 'bad' | 'wait'.
//   fmtTime(date) gives 'HH:MM' on the venue clock (the caller passes it, never the device clock).
export function messageLine(row, fmtTime = (d) => d.toISOString().slice(11, 16)) {
  const kind = KIND_WORDS[row?.kind] || 'Message';
  const how = row?.channel === 'sms' ? 'text' : row?.channel === 'email' ? 'email' : 'message';
  const title = `${kind} by ${how}`;
  const at = row?.sent_at ? new Date(row.sent_at) : null;
  const when = at && !Number.isNaN(at.getTime()) ? fmtTime(at) : '';
  const status = row?.status || 'sent';   // rows from before migration 20261016c were only ever sent ones
  if (status === 'sent') return { title, tone: 'ok', text: when ? `Sent ${when}` : 'Sent' };
  if (status === 'sending') return { title, tone: 'wait', text: 'Sending now' };
  const attempts = Number(row?.attempts) || 1;
  const why = failureWords(row?.last_error);
  const next = row?.next_try_at ? new Date(row.next_try_at) : null;
  if (next && !Number.isNaN(next.getTime()) && attempts < 3) {
    return { title, tone: 'wait', text: `Not sent (${why}). Trying again at ${fmtTime(next)}` };
  }
  return { title, tone: 'bad', text: `Not sent: ${why}${attempts > 1 ? ` (tried ${attempts} times)` : ''}` };
}

