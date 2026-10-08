// src/lib/orderNextStep.js
//
// WHAT DOES THE BUTTON ON AN ORDER CARD DO?
//
// 2 Oct 2026 (Peter): "in orders hub some orders are just saying advance rather than mark as
// ready, collected etc". The pay now QR card on the Orders screen had the fixed words
// "Advance →" since v5.5.159, whatever its order's status, and showed them on a finished order
// too, where the press did nothing. Every other card already said "Mark ready →" and so on.
//
// One rule, used for BOTH the words on the button and the row the press acts on, so the two can
// never disagree. It mirrors advance() in surfaces/OrdersHub.jsx step for step.
//
// Pure helpers only (no Supabase, no store).

import { isOrderPaid, isPaymentChecking } from './orderPayment.js';

// The words every card on the Orders screen uses for the next kitchen step.
export const NEXT_STEP_LABEL = Object.freeze({
  received: 'Mark in prep →',
  prep: 'Mark ready →',
  ready: 'Mark collected →',
});

/** The words for the step after `status`, or null when there is none (collected, paid, cancelled, anything else). */
export function nextStepLabel(status) {
  const label = typeof status === 'string' ? NEXT_STEP_LABEL[status] : null;
  return typeof label === 'string' ? label : null;
}

/**
 * What a press on one queue order's button does: { row, kind, label }, or null when the press
 * would do nothing (the card then shows no button).
 *   kind 'advance': the status moves on one step
 *   kind 'check'  : ready, but the payment is being checked. The press opens Check payment.
 *   kind 'charge' : ready, but money is still owed. The press opens the till pay flow.
 * isPaid and isChecking are the caller's own tests (the Orders screen also counts prepaid
 * channels); formatMoney writes the amount in the venue's currency (lib/currency money).
 */
export function orderNextStep(row, { isPaid = isOrderPaid, isChecking = isPaymentChecking, formatMoney = (n) => n.toFixed(2) } = {}) {
  if (!row || typeof row !== 'object' || row._kind !== 'queue') return null;
  const label = nextStepLabel(row.status);
  if (!label) return null;
  if (row.status === 'ready' && isChecking(row)) return { row, kind: 'check', label: 'Check payment →' };
  if (row.status === 'ready' && !isPaid(row)) return { row, kind: 'charge', label: `Charge ${formatMoney(Number(row.total) || 0)} →` };
  return { row, kind: 'advance', label };
}

/**
 * The step for a QR card on the Orders screen. An open tab has none (its buttons are Close and
 * charge, Release hold). A pay now card is ONE order (keyed by its ref), so its first row is the
 * whole card: the words and the press both come from that row.
 */
export function qrCardNextStep(tab, opts) {
  if (!tab || typeof tab !== 'object' || tab.isOpenTab) return null;
  return orderNextStep(tab.firstRow || (Array.isArray(tab.rows) ? tab.rows[0] : null), opts);
}
