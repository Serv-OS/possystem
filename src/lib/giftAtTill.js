// giftAtTill.js: the till's side of a gift card SALE (Drop C, v5.11.118, 29 Oct 2026).
//
// After the check that holds gift card lines is paid, each line becomes a card in one of two ways:
//   load   a blank (or active) physical card the venue already printed: gift-load with the card's
//          code, the line's amount, the closed check id. Blank -> active with the amount; active ->
//          topped up. Idempotent server side on closed_check_id + card.
//   issue  a NEW card: gift-issue (channel pos) hands back the plain code, which prints on the gift
//          slip (printDoc.buildGiftCardSlipDoc) and shows on screen.
// History asks gift-load `status` for what a closed check already recorded, so a sale left for
// "Later" can be finished and a retry never issues a card twice without saying so.
//
// Calls go the way giftCommit.js calls gift-redeem: fetch to `${functionsUrl}/<fn>` with the paired
// device session's bearer token. Every function here returns a plain object and never throws: the
// modal shows `error` as plain text. `fetchImpl` is injectable so the rules run under node --test.

import { normaliseGiftCode, giftLineAmountMinor, giftLinesOf } from './giftCardLine.js';

/** The functions base the till calls (same as CheckoutModal's GIFT_FUNCTIONS_URL). */
export function giftFunctionsUrl() {
  const base = (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_SUPABASE_URL) || '';
  return base ? `${base}/functions/v1` : '';
}

async function postGift(fn, body, { functionsUrl, token, fetchImpl = (typeof fetch === 'function' ? fetch : null) } = {}) {
  if (!functionsUrl) return { ok: false, status: 0, error: 'Gift card service address is not set on this device' };
  if (!token) return { ok: false, status: 0, error: 'This till is not signed in; pair the device and try again' };
  if (!fetchImpl) return { ok: false, status: 0, error: 'No network on this device' };
  let res;
  try {
    res = await fetchImpl(`${functionsUrl}/${fn}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { ok: false, status: 0, error: `Could not reach the gift card service (${e?.message || 'network error'})` };
  }
  let j = {};
  try { j = await res.json(); } catch { j = {}; }
  if (!res.ok || j?.error || j?.ok === false) {
    return { ...j, ok: false, status: res.status, error: plainError(j, res.status) };
  }
  return { ...j, ok: true, status: res.status };
}

/** The plain words a function's refusal comes back with (never a raw status code on screen). */
export function plainError(j, status) {
  const e = j?.error ?? j?.message;
  if (typeof e === 'string' && e.trim()) return e.trim();
  if (e && typeof e === 'object' && typeof e.message === 'string') return e.message;
  if (status === 404) return 'Card not found';
  if (status === 409) return 'This card cannot take the load';
  if (status === 401 || status === 403) return 'This till is not allowed to issue gift cards';
  return `Gift card service error${status ? ` (${status})` : ''}`;
}

/** The gift-issue body for one line (channel pos). */
export function giftIssueBody({ amountMinor, locationId, closedCheckId, staffId = null }) {
  const body = { amount: Math.round(Number(amountMinor) || 0), location_id: locationId, channel: 'pos', closed_check_id: closedCheckId };
  if (staffId) body.staff_id = staffId;
  return body;
}

/** The gift-load body for one line and one card code (dashes optional on the way in). */
export function giftLoadBody({ code, amountMinor, locationId, closedCheckId, staffId = null }) {
  const clean = normaliseGiftCode(code);
  if (!clean) return null;
  const body = { action: 'load', code: clean, amount_minor: Math.round(Number(amountMinor) || 0), location_id: locationId, closed_check_id: closedCheckId };
  if (staffId) body.staff_id = staffId;
  return body;
}

/** Issue a NEW card for one gift line: { ok, card_id, code, code_last4, balance_minor, balance_url } or { ok:false, error }. */
export async function issueGiftCardAtTill(args, transport) {
  return postGift('gift-issue', giftIssueBody(args), transport);
}

/** Load a printed card for one gift line: { ok, card_id, code_last4, balance_minor, loaded_minor, topped_up, already? } or { ok:false, error }. */
export async function loadGiftCardAtTill(args, transport) {
  const body = giftLoadBody(args);
  if (!body) return { ok: false, status: 0, error: 'A card code is 16 letters and digits' };
  return postGift('gift-load', body, transport);
}

/** What a closed check already recorded: { ok, cards: [{ card_id, code_last4, type, amount_minor, balance_minor }] }. */
export async function giftCardsOnCheck({ locationId, closedCheckId }, transport) {
  const r = await postGift('gift-load', { action: 'status', location_id: locationId, closed_check_id: closedCheckId }, transport);
  if (!r.ok) return r;
  return { ...r, cards: Array.isArray(r.cards) ? r.cards : [] };
}

/**
 * Match a check's gift lines to the cards the server recorded for it, in order, by amount: the
 * first £20 line takes the first £20 card. Returns one slot per live gift line:
 *   { line, amountMinor, card: null | { card_id, code_last4, type, amount_minor, balance_minor } }
 * so the modal knows which lines still need a card and History can say what each line became.
 */
export function giftLineSlots(items, cards) {
  // The server lists newest first; lines were sold in order, so match oldest first.
  const left = (Array.isArray(cards) ? cards.slice() : []).sort((a, b) => String(a?.created_at || '').localeCompare(String(b?.created_at || '')));
  return giftLinesOf(items).map((line) => {
    const amountMinor = giftLineAmountMinor(line);
    const at = left.findIndex((c) => Math.round(Number(c?.amount_minor) || 0) === amountMinor);
    const card = at >= 0 ? left.splice(at, 1)[0] : null;
    return { line, amountMinor, card };
  });
}

/**
 * The plain words for what a gift line became.
 *   load  "Card ending WXYZ loaded with £20.00" (a blank card) or "Card ending WXYZ topped up to £45.00"
 *   issue "New card ending WXYZ printed, £20.00"
 *   none  "Gift card not yet issued"
 * `result` is a gift-load / gift-issue reply or a status card; fmtMinor formats minor units.
 */
export function giftActivationWords(result, fmtMinor = (m) => (Number(m || 0) / 100).toFixed(2)) {
  if (!result) return 'Gift card not yet issued';
  const last4 = String(result.code_last4 || '').toUpperCase() || '????';
  const type = result.type || (result.code ? 'issue' : 'load');
  if (type === 'issue') return `New card ending ${last4} printed, ${fmtMinor(result.amount_minor ?? result.balance_minor)}`;
  const loaded = result.loaded_minor ?? result.amount_minor;
  if (result.topped_up || (Number(result.balance_minor) > Number(loaded) && Number(loaded) > 0)) {
    return `Card ending ${last4} topped up to ${fmtMinor(result.balance_minor)}`;
  }
  return `Card ending ${last4} loaded with ${fmtMinor(loaded ?? result.balance_minor)}`;
}

/** The warning "Later" shows: the sale is booked, the card is not. */
export const GIFT_LATER_WARNING = 'The gift card is not issued yet. The sale is booked, so finish it from History (open the check, Gift card) before the customer leaves.';
