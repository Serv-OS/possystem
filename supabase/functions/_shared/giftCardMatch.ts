// supabase/functions/_shared/giftCardMatch.ts
//
// Which gift cards belong to a loyalty member, and what of each card they may see.
//
// WHY THIS EXISTS (18 Sep 2026 audit). A gift card code is spendable money, and so was a gift
// card id (gift-redeem accepted card_id from any session until round two). Three live endpoints
// handed both out to people who did not own the card:
//   * loyalty-balance, a PUBLIC GET, looked a member up by phone alone and returned every active
//     card addressed to that member's phone, email OR NAME, with the full code.
//   * loyalty-otp verify and refresh matched on email and name as well as phone. Name matching
//     gives a member every card addressed to anybody with the same name. Email is set by the
//     member through update_profile with no verification, so a member could type somebody
//     else's address and be shown that person's cards.
//
// THE RULE: a member's gift cards are matched on ONE thing, the phone number they proved with the
// one time code. Never by name, never by email. The only place allowed to show a full code is the
// signed in portal (and the member's own kiosk session), for cards addressed to that proven phone.
//
// ROUND TWO (18 Sep 2026): Back Office Issue, Bulk and Import store recipient_phone exactly as
// typed ('07931 123 456'), so an exact match dropped those cards. Both sides are now normalised
// with the app's own phone rule and compared as normalised values.
//
// PURE. No imports, no Deno globals, so node tests can import this file directly.

// ── The app's own phone rule ─────────────────────────────────────────────
// Byte for byte the rule in src/lib/customerLookup.js normalisePhone (and store._normalisePhone,
// loyalty-otp, loyalty-balance): keep digits and '+', UK mobile 07xxxxxxxxx becomes +447xxxxxxxxx,
// 44... becomes +44... . A node test pins that the two copies agree.
export function normaliseMemberPhone(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const digits = String(raw).replace(/[^\d+]/g, '');
  if (!digits) return null;
  if (digits.startsWith('+')) return digits;
  if (digits.startsWith('07') && digits.length === 11) return '+44' + digits.slice(1);
  if (digits.startsWith('44')) return '+' + digits;
  return digits;
}

const NORMALISED_RE = /^\+?\d{6,16}$/;

/**
 * The proven phone, normalised, or null when it is not a usable phone number. Anything that is
 * not a plain phone number after normalising is refused, so nothing can be smuggled into the
 * PostgREST filter built from it.
 */
function provenKey(phone: unknown): string | null {
  const n = normaliseMemberPhone(typeof phone === 'string' ? phone.trim() : phone);
  return n && NORMALISED_RE.test(n) ? n : null;
}

/**
 * The exact stored forms a proven phone may appear in. Kept for callers that want exact values;
 * the MATCH is done on normalised values (memberGiftCards, cardBelongsToPhone).
 */
export function phoneMatchVariants(phone: unknown): string[] {
  const p = typeof phone === 'string' ? phone.trim() : '';
  if (!NORMALISED_RE.test(p)) return [];
  const out = [p];
  if (p.startsWith('+44')) out.push('0' + p.slice(3));
  else if (p.startsWith('0')) out.push('+44' + p.slice(1));
  return out;
}

/**
 * PostgREST `.or()` filter that FETCHES every card whose recipient_phone could be the proven
 * phone however it was typed, or null when there is no usable phone (the caller then returns no
 * cards at all). It is a wide net on purpose: the subscriber digits with a wildcard between each,
 * so '07931 123 456', '+44 7931 123456' and '+447931123456' are all fetched. It is NOT the match:
 * memberGiftCards then keeps only rows whose normalised phone equals the normalised proven phone.
 * Only digits ever reach the filter, so nothing can be injected through it.
 */
export function giftCardRecipientFilter(verifiedPhone: unknown): string | null {
  const key = provenKey(verifiedPhone);
  if (!key) return null;
  // The subscriber part: drop '+', and the 44 of a UK number (stored as 0... or +44...).
  let core = key.replace(/^\+/, '');
  if (key.startsWith('+44')) core = core.slice(2);
  if (!/^\d{6,16}$/.test(core)) return null;
  return `recipient_phone.ilike.%${core.split('').join('%')}%`;
}

/**
 * The cards a signed in member may see, from rows already fetched with the filter above. The
 * phone is checked again here, row by row, on NORMALISED values, so a row that arrived any other
 * way (a name or email match, a widened query, the wide net above catching a different number)
 * is dropped rather than shown.
 *
 * Cards that carry only an email (no recipient_phone) are never matched to a member: email is
 * set by the member with no verification. Their owner still has the code (it was emailed to
 * them), can type it at any checkout, and staff see and resend the card in Back Office.
 *
 * The full code is kept: the portal shows it so the member can spend their OWN card online,
 * where the only way to pay by gift card is typing the code. Every row reaching this point is
 * addressed to the phone the member proved.
 */
export function memberGiftCards(rows: any[] | null | undefined, verifiedPhone: unknown) {
  const key = provenKey(verifiedPhone);
  if (!key) return [];
  return (rows || [])
    .filter((c: any) => cardBelongsToPhone(c, key))
    .map((c: any) => ({
      id: c.id,
      last4: c.code_last4 ?? null,
      code: c.code_plain || null,
      balance: c.balance_minor,
      initial: c.initial_amount_minor,
      expires_at: c.expires_at ?? null,
    }));
}

/** Is this card addressed to the phone the member proved? Normalised on both sides. */
export function cardBelongsToPhone(card: { recipient_phone?: unknown } | null | undefined, verifiedPhone: unknown): boolean {
  const key = provenKey(verifiedPhone);
  if (!key || !card || typeof card.recipient_phone !== 'string') return false;
  return normaliseMemberPhone(card.recipient_phone.trim()) === key;
}

/** The columns memberGiftCards needs. recipient_phone is required for the row by row check. */
export const MEMBER_GIFT_CARD_COLUMNS =
  'id, code_last4, code_plain, balance_minor, status, expires_at, initial_amount_minor, recipient_phone';
