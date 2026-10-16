// src/lib/bookings/noShowChargeApi.js
//
// The host stand's (and Back Office's) door to the booking-charge edge function: the no show
// and late cancel charge on the card the guest saved when they booked (16 Oct 2026).
// The rules are in noShowCharge.js; the function decides and charges, this file only asks.
//
// Every answer is { ok, ... , message } with message in plain words. Before the function is
// deployed the answer is { ok:false, missing:true }, so the screen can stay quiet (or say so)
// instead of showing a button that cannot work.

import { supabase, isMock } from '../supabase';
import { isMissingFunctionReply } from './noShowCharge.js';

const FN = 'booking-charge';

async function call(body) {
  if (isMock || !supabase) return { ok: false, missing: true, message: 'Not connected.' };
  try {
    const { data, error } = await supabase.functions.invoke(FN, { body });
    if (!error) return data && typeof data === 'object' ? data : { ok: false, message: 'No answer from the server.' };
    let parsed = null;
    try { parsed = await error.context?.json?.(); } catch { /* not json */ }
    const status = error.context?.status ?? null;
    const message = parsed?.message || parsed?.error || error.message || 'The server did not answer.';
    if (isMissingFunctionReply({ status, message: `${parsed?.error || ''} ${parsed?.message || ''} ${error.message || ''}` }) && !parsed?.ok) {
      return { ok: false, missing: true, message: 'Charging a saved card is not switched on here yet.' };
    }
    return { ...(parsed && typeof parsed === 'object' ? parsed : {}), ok: false, status, message };
  } catch (e) {
    return { ok: false, offline: true, message: `Could not reach the server: ${e?.message || 'no connection'}. Nothing was taken.` };
  }
}

/** What may be charged on this booking, and what already was. */
export const quoteNoShowCharge = (locationId, bookingId) =>
  call({ action: 'quote', location_id: locationId, booking_id: bookingId });

/** Charge the saved card. expectedMinor is the amount the host was shown: a different fee is refused. */
export const chargeNoShow = (locationId, bookingId, { expectedMinor, staffName = null } = {}) =>
  call({ action: 'charge', location_id: locationId, booking_id: bookingId, expected_minor: expectedMinor, staff_name: staffName });
