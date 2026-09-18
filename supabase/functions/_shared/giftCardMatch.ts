// supabase/functions/_shared/giftCardMatch.ts
//
// Which gift cards belong to a loyalty member, and what of each card they may see.
//
// WHY THIS EXISTS (18 Sep 2026 audit). A gift card code is spendable money, and so is a gift
// card id (gift-redeem accepts card_id from any session). Three live endpoints handed both out
// to people who did not own the card:
//   * loyalty-balance, a PUBLIC GET, looked a member up by phone alone and returned every active
//     card addressed to that member's phone, email OR NAME, with the full code.
//   * loyalty-otp verify and refresh matched on email and name as well as phone. Name matching
//     gives a member every card addressed to anybody with the same name. Email is set by the
//     member through update_profile with no verification, so a member could type somebody
//     else's address and be shown that person's cards.
//
// THE RULE: a member's gift cards are matched on ONE thing, the phone number they proved with the
// one time code. Never by name, never by email. The only place allowed to show a full code is the
// signed in portal, for cards addressed to that proven phone.
//
// PURE. No imports, no Deno globals, so node tests can import this file directly.

const PHONE_RE = /^\+?\d{6,16}$/;

/**
 * The stored forms a proven phone may appear in on gift_cards.recipient_phone. UK numbers are
 * stored both ways (+447931... and 07931...). Anything that is not a plain phone number returns
 * no variants, so nothing can be smuggled into the PostgREST filter built from them.
 */
export function phoneMatchVariants(phone: unknown): string[] {
  const p = typeof phone === 'string' ? phone.trim() : '';
  if (!PHONE_RE.test(p)) return [];
  const out = [p];
  if (p.startsWith('+44')) out.push('0' + p.slice(3));
  else if (p.startsWith('0')) out.push('+44' + p.slice(1));
  return out;
}

/**
 * PostgREST `.or()` filter matching gift cards by the proven phone ONLY, or null when there is
 * no usable phone (the caller then returns no cards at all).
 */
export function giftCardRecipientFilter(verifiedPhone: unknown): string | null {
  const variants = phoneMatchVariants(verifiedPhone);
  if (!variants.length) return null;
  return variants.map((v) => `recipient_phone.eq.${v}`).join(',');
}

/**
 * The cards a signed in member may see, from rows already fetched with the filter above. The
 * phone is checked again here, row by row, so a row that arrived any other way (a name or email
 * match, a widened query) is dropped rather than shown.
 *
 * The full code is kept: the portal shows it so the member can spend their OWN card online,
 * where the only way to pay by gift card is typing the code. Every row reaching this point is
 * addressed to the phone the member proved.
 */
export function memberGiftCards(rows: any[] | null | undefined, verifiedPhone: unknown) {
  const variants = new Set(phoneMatchVariants(verifiedPhone));
  if (!variants.size) return [];
  return (rows || [])
    .filter((c: any) => c && typeof c.recipient_phone === 'string' && variants.has(c.recipient_phone.trim()))
    .map((c: any) => ({
      id: c.id,
      last4: c.code_last4 ?? null,
      code: c.code_plain || null,
      balance: c.balance_minor,
      initial: c.initial_amount_minor,
      expires_at: c.expires_at ?? null,
    }));
}

/** The columns memberGiftCards needs. recipient_phone is required for the row by row check. */
export const MEMBER_GIFT_CARD_COLUMNS =
  'id, code_last4, code_plain, balance_minor, status, expires_at, initial_amount_minor, recipient_phone';
