// src/lib/bookings/guestMessageWords.js
//
// The guest message rules the web app shows and acts on, pure (16 Oct 2026): no imports, so
// node:test covers them (guestMessageWords.test.js). guestMessages.js does the reads and calls.

const LIVE = ['confirmed', 'prepaid'];

// Is this new booking one the guest should hear about? A party seated at the door is not.
export function shouldNudge(b) {
  if (!b || !b.id) return false;
  if ((b.source || 'host') === 'walk_in') return false;
  if (!LIVE.includes(b.status || 'confirmed')) return false;
  const c = b.customer || {};
  return !!(String(c.phone || '').trim() || String(c.email || '').trim());
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

