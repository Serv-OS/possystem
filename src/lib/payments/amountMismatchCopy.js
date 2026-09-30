// src/lib/payments/amountMismatchCopy.js
//
// What the till says when the card machine took a different amount from the bill
// (terminal job approved + needs_human). Pure, so it is tested without a browser.
//
// v5.11.16 (R3618, 29 Sep 2026): the old text said the check was "held until a manager
// checks it". It was not: the reconciler books the sale at the bill amount (v5.5.866,
// paid money is never stranded). Staff reading "held" may take payment again. The text
// now says what really happens, and, on Adyen, that a tip is added by itself (the heal in
// supabase/functions/_shared/readerTipHeal.ts) while anything else alerts a manager.

const SYMBOLS = { GBP: '£', USD: '$', EUR: '€' };

/** Minor units as a person reads them, in the job's own currency. */
export function formatMinor(minor, currency = 'GBP') {
  const n = Math.round(Number(minor) || 0);
  const c = String(currency || 'GBP').toUpperCase();
  const abs = (Math.abs(n) / 100).toFixed(2);
  const sign = n < 0 ? '-' : '';
  return SYMBOLS[c] ? `${sign}${SYMBOLS[c]}${abs}` : `${sign}${abs} ${c}`;
}

export const MISMATCH_WHERE = 'Back Office, Card readers, Payments that need checking';

/**
 * @param {{ reportedMinor?: number|null, billMinor?: number|null, currency?: string, processor?: string|null }} p
 * @returns {{ title: string, body: string }}
 */
export function amountMismatchCopy({ reportedMinor = null, billMinor = null, currency = 'GBP', processor = null } = {}) {
  const title = 'Card amount differs from the bill';
  const figures = reportedMinor != null && billMinor != null && Number(reportedMinor) !== Number(billMinor);
  const first = figures
    ? `The card machine took ${formatMinor(reportedMinor, currency)} and the bill was ${formatMinor(billMinor, currency)}.`
    : 'The card machine took a different amount from the bill.';
  // v5.11.16 review: the card machine took LESS than the bill (a short PAX or Ryft
  // report). The sale is still booked at the bill amount, so "do not take payment
  // again" would leave the rest uncollected: say what is still owed instead.
  if (figures && Number(reportedMinor) < Number(billMinor)) {
    const owed = formatMinor(Number(billMinor) - Number(reportedMinor), currency);
    return {
      title,
      body: `${first} ${owed} is still owed. Take it another way and tell a manager: the sale is recorded at the bill amount `
        + `as if the card paid it all, and a manager corrects it in ${MISMATCH_WHERE}.`,
    };
  }
  const booked = 'The sale is recorded automatically at the bill amount, so do not take payment again.';
  const next = processor === 'adyen'
    ? `If the difference is a tip it is added to this sale by itself; otherwise a manager is alerted in ${MISMATCH_WHERE}.`
    : `A manager checks the difference in ${MISMATCH_WHERE}.`;
  return { title, body: `${first} ${booked} ${next}` };
}
