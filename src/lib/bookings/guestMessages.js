// src/lib/bookings/guestMessages.js
//
// The web app's side of the guest messages (16 Oct 2026).
//
//   nudgeConfirmation   right after the host stand, the till or Back Office makes a booking with
//                       a phone or an email, ask booking-reminders to send the confirmation now.
//                       Fire and forget: the function's ledger sends each channel once, and the
//                       5 minute sweep sends it anyway if this call is lost.
//   loadGuestMessages   the ledger rows for one booking, for the Inspector's Messages list
//   loadManageToken     the guest's change and cancel code (migration 20261016c)
//   messageLine, failureWords   the words the Inspector shows for each row (pure, tested)

import { supabase, isMock } from '../supabase';
import { shouldNudge } from './guestMessageWords.js';

export { shouldNudge, KIND_WORDS, failureWords, messageLine } from './guestMessageWords.js';

export function nudgeConfirmation(b) {
  if (isMock || !supabase || !shouldNudge(b)) return;
  try {
    supabase.functions.invoke('booking-reminders', { body: { action: 'confirm', booking_id: b.id } })
      .catch(() => { /* the sweep sends it within 5 minutes */ });
  } catch { /* never let a message get in the way of a booking */ }
}

const missingColumn = (e) => {
  const m = `${e?.code || ''} ${e?.message || ''}`;
  return /42703|PGRST204|does not exist|schema cache/i.test(m);
};

// The ledger rows for one booking, oldest first. null = could not read (say so, never "none").
export async function loadGuestMessages(bookingId) {
  if (isMock || !supabase || !bookingId) return [];
  const read = (cols) => supabase.from('booking_reminders').select(cols).eq('booking_id', bookingId).order('sent_at', { ascending: true });
  try {
    let { data, error } = await read('kind, channel, status, attempts, last_error, next_try_at, sent_at');
    if (error && missingColumn(error)) ({ data, error } = await read('kind, channel, sent_at'));
    if (error) return null;
    return data || [];
  } catch { return null; }
}

// The guest's change and cancel code, or null (before migration 20261016c, or not readable).
export async function loadManageToken(bookingId) {
  if (isMock || !supabase || !bookingId) return null;
  try {
    const { data, error } = await supabase.from('bookings').select('manage_token').eq('id', bookingId).maybeSingle();
    if (error) return null;
    return data?.manage_token || null;
  } catch { return null; }
}
