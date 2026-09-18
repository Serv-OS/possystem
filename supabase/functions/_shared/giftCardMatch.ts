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

// ── Round three (18 Sep 2026): match GB and US numbers on their digits ─────
// normaliseMemberPhone above is UK only and stays byte for byte the app's rule (customers.phone
// is written with it). Used as the MATCH it failed twice:
//   * a US card typed '(415) 555-0123' never matched the proven '+14155550123';
//   * '+44 (0) 7931 123456' became '+4407931123456' and never matched '+447931123456'.
// phoneShape reads a number into what it can honestly say: its country code when it has one
// (+CC, 00CC, a NANP number, or a bare 44 number the app already treats as +44), and its national
// significant number (NSN, the digits after the country code and any trunk 0). It never invents
// a country code: a national number written with a trunk 0 ('07931 123456') is "some country
// that uses a trunk 0", which rules out +1 (NANP has no trunk 0) and nothing else.

export type PhoneShape =
  | { kind: 'intl'; cc: string | null; digits: string; nsn: string | null }   // +CC..., cc known for 1 and 44
  | { kind: 'nanp'; nsn: string }                                            // a US / Canada number, no +
  | { kind: 'trunk'; nsn: string }                                           // national with a trunk 0
  | { kind: 'bare'; nsn: string };                                           // digits, no + and no trunk 0

const NANP_NSN = /^[2-9]\d{2}[2-9]\d{6}$/;

export function phoneShape(raw: unknown): PhoneShape | null {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).trim();
  if (!s) return null;
  // '+44 (0) 7931 ...' : a bracketed trunk 0 inside an international number is not dialled.
  s = s.replace(/\(\s*0\s*\)/g, '');
  const intl = s.startsWith('+') || /^00[1-9]/.test(s.replace(/[^\d+]/g, ''));
  let d = s.replace(/\D/g, '');
  if (intl && d.startsWith('00')) d = d.slice(2);
  if (d.length < 6 || d.length > 16) return null;
  if (intl) {
    if (d.startsWith('1') && NANP_NSN.test(d.slice(1))) return { kind: 'intl', cc: '1', digits: d, nsn: d.slice(1) };
    if (d.startsWith('44')) return { kind: 'intl', cc: '44', digits: d, nsn: d.slice(2).replace(/^0/, '') };
    return { kind: 'intl', cc: null, digits: d, nsn: null };
  }
  if (d.startsWith('0')) return { kind: 'trunk', nsn: d.slice(1) };
  if (d.length === 11 && d.startsWith('1') && NANP_NSN.test(d.slice(1))) return { kind: 'nanp', nsn: d.slice(1) };
  if (d.length === 10 && NANP_NSN.test(d)) return { kind: 'nanp', nsn: d };
  // The app's rule already reads a bare 44... as +44 (normaliseMemberPhone).
  if (d.startsWith('44') && d.length >= 11 && d.length <= 13) return { kind: 'intl', cc: '44', digits: d, nsn: d.slice(2).replace(/^0/, '') };
  return { kind: 'bare', nsn: d };
}

/** Does an international number end with this national number behind a 1 to 3 digit code other than 1? */
function intlCarriesNsn(a: Extract<PhoneShape, { kind: 'intl' }>, nsn: string): boolean {
  if (a.cc === '1') return false;
  if (a.nsn !== null) return a.nsn === nsn;
  if (!a.digits.endsWith(nsn)) return false;
  const ccLen = a.digits.length - nsn.length;
  return ccLen >= 1 && ccLen <= 3 && !a.digits.startsWith('1');
}

/**
 * Are these the same phone number? GB and US (and any +CC number written in full) are matched
 * on their digits without guessing a country:
 *   +447931123456 = 07931 123456 = +44 (0) 7931 123456 = 447931123456
 *   +14155550123  = (415) 555-0123 = 1 415 555 0123
 *   +17021234567 != 07021234567 (a trunk 0 is never NANP), != +447021234567 (country differs)
 * Seven significant digits at least, so short fragments never match anything.
 */
export function phonesMatch(a: unknown, b: unknown): boolean {
  const x = phoneShape(a);
  const y = phoneShape(b);
  if (!x || !y) return false;
  const sig = (p: PhoneShape) => (p.kind === 'intl' ? (p.nsn ?? p.digits) : p.nsn);
  if (sig(x).length < 7 || sig(y).length < 7) return false;
  const one = (p: PhoneShape, q: PhoneShape): boolean | null => {
    if (p.kind === 'intl' && q.kind === 'intl') {
      if (p.cc && q.cc) return p.cc === q.cc && p.nsn === q.nsn;
      return p.digits === q.digits;
    }
    if (p.kind === 'intl' && q.kind === 'nanp') return p.cc === '1' && p.nsn === q.nsn;
    if (p.kind === 'intl' && (q.kind === 'trunk' || q.kind === 'bare')) return intlCarriesNsn(p, q.nsn);
    if (p.kind === 'nanp' && q.kind === 'nanp') return p.nsn === q.nsn;
    if (p.kind === 'nanp' && (q.kind === 'trunk' || q.kind === 'bare')) return false;   // NANP never has a trunk 0
    if ((p.kind === 'trunk' || p.kind === 'bare') && (q.kind === 'trunk' || q.kind === 'bare')) return p.nsn === q.nsn;
    return null;
  };
  const r = one(x, y);
  if (r !== null) return r;
  return one(y, x) === true;
}

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
  // The national part: the NSN when the country is known (GB, NANP), else the last 9 digits
  // (enough to fetch '06 12 34 56 78' for '+33612345678'). phonesMatch then decides.
  const shape = phoneShape(key);
  let core = key.replace(/^\+/, '');
  if (shape && shape.kind === 'intl' && shape.nsn) core = shape.nsn;
  else if (shape && shape.kind !== 'intl') core = shape.nsn;
  else if (core.length > 9) core = core.slice(-9);
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

/**
 * Is this card addressed to the phone the member proved? Round three: phonesMatch (GB and US,
 * digits, no invented country code). Round two compared normaliseMemberPhone values, which is UK
 * only; that equality is kept as the first test so nothing it matched stops matching.
 */
export function cardBelongsToPhone(card: { recipient_phone?: unknown } | null | undefined, verifiedPhone: unknown): boolean {
  const key = provenKey(verifiedPhone);
  if (!key || !card || typeof card.recipient_phone !== 'string') return false;
  if (normaliseMemberPhone(card.recipient_phone.trim()) === key) return true;
  return phonesMatch(card.recipient_phone, key);
}

/** The columns memberGiftCards needs. recipient_phone is required for the row by row check. */
export const MEMBER_GIFT_CARD_COLUMNS =
  'id, code_last4, code_plain, balance_minor, status, expires_at, initial_amount_minor, recipient_phone';
