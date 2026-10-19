// src/lib/bookings/bookingCloseInfo.js
//
// 19 Oct 2026 (v5.11.78, channel parity): what a handheld (MPOS) close hands the store when a
// booked party's deposit or prepay paid part of the bill, so the record is the one the till's
// checkout writes (CheckoutModal): booked GROSS (the card money plus the booking money), method
// 'booking+card', the booking legs as tenders (accounting/tenders.js tendersFromPaymentInfo reads
// bookingPayment) and as payment intents beside the card leg. The card leg is named with what the
// card really took, so a refund can never be aimed at booking money (cardLegsOf only refunds legs
// with an id; booking legs carry none). Empty when no booking money was used: nothing changes.
// PURE.

import { withBookingIntents } from '../payments/terminalJobCloser.js';

/**
 * @param info          what the card flow approved ({ method, grand: the card's own amount, tip, ... })
 * @param bookingPayment bookingLegsForBill's answer, or null
 * @param appliedMajor  the booking money applied to the bill, in major units
 */
export function bookingCloseInfo(info, bookingPayment, appliedMajor) {
  const applied = Number(appliedMajor) || 0;
  if (!bookingPayment || !(applied > 0.004)) return {};
  const cardGrand = Number(info?.grand) || 0;
  const cardId = info?.stripePaymentIntentId || info?.paymentIntentId || null;
  const cardLeg = (cardId || cardGrand > 0) ? [{ id: cardId, amountMinor: Math.round(cardGrand * 100) }] : [];
  return {
    grand: +(cardGrand + applied).toFixed(2),
    method: `booking+${info?.method || 'card'}`,
    bookingPayment,
    paymentIntents: withBookingIntents(cardLeg, bookingPayment),
  };
}
