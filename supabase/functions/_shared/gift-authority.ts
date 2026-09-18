// supabase/functions/_shared/gift-authority.ts
//
// Who may list, search and spend gift cards (gift-list, gift-lookup, gift-redeem).
//
// WHY (18 Sep 2026 audit, round two). All three accepted ANY session, including an anonymous one
// that anybody can mint with the public anon key (OnlineCheckout and QrCheckout call
// signInAnonymously), and took the company from a public location_id in the body:
//   * gift-list returned code_plain plus recipient name, email and phone for EVERY card of the
//     company: a full dump of spendable codes.
//   * gift-lookup search matched recipient_name (ilike) and recipient_email and returned the
//     card_id, balance, name and email, and gift-redeem then spent a card by card_id alone.
//     So a card could be stolen knowing only the recipient's name.
//
// THE RULE, ENFORCED NOW (no report mode: the legitimate callers are staff or code holders):
//   * gift-list: staff only (a non anonymous user with access to the location, or super_admin).
//   * gift-lookup by the exact full 16 character code: open. Typing the code is proof of
//     possession; this is how a customer pays at the kiosk, online, by QR and at the till.
//     A code holder gets the balance and status, never the recipient's email or the history.
//   * gift-lookup by anything else (last 4, email, name, last 4 plus email): staff only.
//   * gift-redeem with a code that resolves: open (same proof of possession).
//   * gift-redeem by card_id alone (or with a code that does not resolve): staff, a claimed
//     device of the same company, or the member whose PROVEN phone (loyalty session token) the
//     card is addressed to. That last arm is the kiosk spending a card it listed after the
//     member's one time code, where the card may have no stored code.
//
// PURE. No imports, so node tests load it directly.

export const GIFT_CODE_LENGTH = 16;
const CODE_RE = /^[A-Z2-9]{16}$/;

/** Strip spaces and dashes, upper case. Same as gift-card-utils normalizeCode. */
export function cleanGiftCode(v: unknown): string {
  return typeof v === 'string' ? v.replace(/[\s-]/g, '').toUpperCase() : '';
}

/** A string that is exactly a full gift card code once separators are stripped. */
export function isFullGiftCode(v: unknown): boolean {
  return CODE_RE.test(cleanGiftCode(v));
}

export type GiftLookupKind = 'code' | 'staff_search' | 'invalid';

/**
 * What a gift-lookup body is asking for.
 *   'code'          { code } of 16 characters, or { search } that IS a full code. Open.
 *   'staff_search'  last 4, email, name, or { code_last4, email }. Staff only.
 *   'invalid'       nothing usable.
 * A { code } that is not 16 characters stays 'code' so the function answers its usual 400.
 */
export function classifyGiftLookup(body: any): GiftLookupKind {
  const b = body && typeof body === 'object' ? body : {};
  if (b.code) return 'code';
  if (b.code_last4 && b.email) return 'staff_search';
  if (typeof b.search === 'string' && b.search.trim()) return isFullGiftCode(b.search) ? 'code' : 'staff_search';
  return 'invalid';
}

/**
 * The reply for a code holder who is not staff. Balance, status, expiry and last 4 are what every
 * checkout needs; recipient_name is kept because the till shows it once the code is typed. The
 * recipient's email, the note and the transaction history are staff only.
 */
export function codeHolderView<T extends Record<string, unknown>>(full: T): Partial<T> {
  const out: Record<string, unknown> = { ...full };
  delete out.recipient_email;
  delete out.note;
  delete out.recent_transactions;
  return out as Partial<T>;
}

export type GiftCallerFacts = {
  user: { id: string; is_anonymous?: boolean } | null;
  /** Non anonymous user with access to the location (or to the company when no location), or super_admin. */
  staff: boolean;
};

export function decideGiftListAuthority(f: GiftCallerFacts): { ok: true } | { ok: false; status: number; error: string; reason: string } {
  if (!f.user) return { ok: false, status: 401, error: 'Unauthorized', reason: 'no_session' };
  if (!f.user.is_anonymous && f.staff) return { ok: true };
  return { ok: false, status: 403, error: 'Only staff can list gift cards.', reason: f.user.is_anonymous ? 'anonymous' : 'no_location_access' };
}

export function decideGiftLookupAuthority(kind: GiftLookupKind, f: GiftCallerFacts):
  { ok: true; view: 'full' | 'code_holder' } | { ok: false; status: number; error: string; reason: string } {
  if (!f.user) return { ok: false, status: 401, error: 'Unauthorized', reason: 'no_session' };
  const staff = !f.user.is_anonymous && f.staff;
  if (kind === 'code') return { ok: true, view: staff ? 'full' : 'code_holder' };
  if (kind === 'staff_search') {
    if (staff) return { ok: true, view: 'full' };
    return { ok: false, status: 403, error: 'Enter the full 16 character gift card code.', reason: f.user.is_anonymous ? 'anonymous_search' : 'no_location_access' };
  }
  return { ok: false, status: 400, error: 'Provide { code }, { code_last4, email }, or { search }', reason: 'invalid' };
}

/**
 * May this caller spend a card they did NOT prove with its code?
 * Only reached when no code was sent or the code did not resolve to a card.
 */
export function decideGiftCardIdAuthority(i: GiftCallerFacts & {
  /** Company of the caller's own claimed device, or null. */
  deviceCompanyId: string | null;
  companyId: string;
  /** A member_token was sent. */
  memberTokenSent: boolean;
  /** The verified member session (company + proven phone), or null. */
  memberSession: { companyId: string; phone: string | null } | null;
  /** cardBelongsToPhone(card, memberSession.phone), computed by the caller. */
  cardOnMemberPhone: boolean;
}): { ok: true; via: 'staff' | 'device' | 'member' } | { ok: false; status: number; error: string; reason: string } {
  if (!i.user) return { ok: false, status: 401, error: 'Unauthorized', reason: 'no_session' };
  if (!i.user.is_anonymous && i.staff) return { ok: true, via: 'staff' };
  if (i.deviceCompanyId && i.deviceCompanyId === i.companyId) return { ok: true, via: 'device' };
  if (i.memberTokenSent && i.memberSession && i.memberSession.companyId === i.companyId && i.cardOnMemberPhone) {
    return { ok: true, via: 'member' };
  }
  return {
    ok: false, status: 403,
    error: 'Enter the gift card code to use this card.',
    reason: i.memberTokenSent ? (i.memberSession ? 'member_not_card_owner' : 'member_token_invalid') : 'card_id_without_code',
  };
}
