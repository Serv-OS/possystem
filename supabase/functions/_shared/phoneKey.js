// supabase/functions/_shared/phoneKey.js
//
// THE ONE PHONE MATCH KEY. Every place that finds or creates a customer by phone keys the number
// with phoneMatchKey, and every new customers.phone is that key. PURE: no imports, no database,
// no clock, so node tests drive every rule (src/lib/phoneKey.test.js) and the till (src imports
// ../../supabase/functions/_shared/phoneKey.js) and the edge functions (../_shared/phoneKey.js)
// run the same code. The database has the same rule as public.phone_match_key
// (supabase/migrations/20260929a_OPS_customer_phone_match.sql); both are checked against the same
// fixtures (phoneKey.fixtures.json), in node and in the migration's own self test.
//
// WHY (29 Sep 2026, Peter: "I just placed an order online and its registered me again as a
// customer"). The online and QR orders matched customers on the DIGITS of the phone. The member
// was imported as '+447931129015' (digits 447931129015) and the order sent '07931129015' (digits
// 07931129015), so they never met and a second customer was made. Coffee Boy has about 6,700
// imported members stored as +44, and every one would have been made twice on a first online or
// QR order. Now '07931 129015', '07931129015', '+447931129015', '0044 7931 129015' and
// '+44 (0) 7931 129015' are all '+447931129015', and in a US venue '+1 650 555 1234',
// '6505551234' and '(650) 555-1234' are all '+16505551234'.
//
// THE RULES (phoneMatchKey), in order:
//   1. Fewer than 7 digits in all is no number (null), as the database always said.
//   2. A number written with + (or 00, or 011 in a US venue) is read the same in every venue:
//      +44 with a whole UK number (a stray 0 after 44, or a '(0)', dropped), +1 with a whole North
//      American number, any other country code with 7 to 15 digits. A + straight before a 0 is no
//      country code ('+07931 129015'): the number is read as if the + were not there.
//   3. A number written without a country code is read in the country of the VENUE it was typed
//      at (phoneRegionFromCurrency: GBP is GB, USD is US): a UK venue reads 0 and a whole UK
//      number ('(0)7931 129015' too), a US venue reads a whole 10 digit number (with or without
//      the 1).
//   4. Anything else is its digits, exactly as the database matched before this file (a number
//      written with + or 00 that we cannot read keeps its + or 00, as the till stored it). A number
//      we cannot read is never guessed at, so two different numbers are never made one.
// Not read on purpose (they stay digits, or keep the + or 00 they were typed with): a UK number
// with no 0 ('7931129015'), a UK number one digit short, '44 0...', extensions, and +44 or +1
// numbers of the wrong length.
// The key of a key is itself (src/lib/phoneKey.test.js checks it), so a number keyed twice, or
// keyed by the till and again by the database, is the same key.
//
// FINDING A STORED NUMBER (phoneLookupValues, 29 Sep 2026 review). A customers.phone written as the
// key (a + number) is found by the key. One written by an older build WITHOUT its country code
// ('07931129015', an import's '01172273489', an old online order's '447931129015') is read only as
// storedPhoneRegion says: the UK reading in a UK venue (no North American number is written with a
// leading 0, or as 44 and a whole UK number), never the US reading (a UK number stored without its
// 0, '2014812891', looks exactly like a New Jersey one, and a venue cannot tell which venue of its
// organisation wrote the row), and a number written with 00 everywhere. The database does the
// same (public.phone_match_key(c.phone, <that region>) in 20260929a).

const UK_NSN = '(?:[1235789][0-9]{9}|[18][0-9]{8})';
const NANP = '[2-9][0-9]{2}[2-9][0-9]{6}';
const RE_PLUS_44 = new RegExp('^440?(' + UK_NSN + ')$');
const RE_PLUS_1 = new RegExp('^1' + NANP + '$');
const RE_PLUS_OTHER = /^[1-9][0-9]{6,14}$/;
const RE_GB_NATIONAL = new RegExp('^0(' + UK_NSN + ')$');
const RE_GB_44 = new RegExp('^44' + UK_NSN + '$');
const RE_US_NATIONAL = new RegExp('^1?(' + NANP + ')$');
const RE_KEY_44 = new RegExp('^\\+44(' + UK_NSN + ')$');
/** A key we read: +44 and a UK number, +1 and a North American one, or any other code and 7 to 15 digits. */
const RE_READABLE = new RegExp('^\\+(?:44' + UK_NSN + '|1' + NANP + '|(?!44|1)[1-9][0-9]{6,14})$');
/** '(0)' as in '+44 (0) 7931 ...', with any spaces or tabs inside the brackets. */
const RE_ZERO_GROUP = /\([ \t]*0[ \t]*\)/g;
/** Written with a + first (anything but a digit or + may come before it). */
const RE_LEAD_PLUS = /^[^0-9+]*\+/;
/** A value safe inside a PostgREST or() / in() filter: + and digits only (any length). */
const RE_SAFE = /^\+?[0-9]{7,}$/;

/** The phone region of a venue from its currency: GBP is 'GB', USD is 'US', anything else ''. */
export function phoneRegionFromCurrency(currency) {
  const c = String(currency ?? '').trim().toUpperCase();
  return c === 'GBP' ? 'GB' : c === 'USD' ? 'US' : '';
}

/**
 * The phone region of an ORGANISATION from its venues' currencies: the one region they all give,
 * '' when they differ, when one is not GBP or USD, or when there is no venue. For a reading that
 * has no venue of its own (the loyalty login), so it never depends on which venue a request names.
 */
export function orgPhoneRegion(currencies) {
  const regions = new Set((Array.isArray(currencies) ? currencies : []).map(phoneRegionFromCurrency));
  return regions.size === 1 ? [...regions][0] : '';
}

const regionOf = (region) => {
  const r = String(region ?? '').trim().toUpperCase();
  return r === 'GB' || r === 'US' ? r : '';
};

/**
 * The key a customer is found and stored under: E.164 ('+447931129015') when the number can be
 * read, its digits otherwise, null when it has fewer than 7 digits. `region` is the venue's
 * ('GB', 'US' or '' when unknown; see phoneRegionFromCurrency).
 */
export function phoneMatchKey(raw, region = '') {
  if (raw === null || raw === undefined) return null;
  const text = String(raw);
  const all = text.replace(/[^0-9]/g, '');
  if (all.length < 7) return null;
  const r = regionOf(region);
  // '+44 (0) 7931 ...', '+33 (0)1 ...': a (0) written after a country code is not part of the
  // number. Only then: '(0)7931 129015' is a UK number written with its own 0.
  const unbracketed = text.replace(RE_ZERO_GROUP, '');
  const lead = RE_LEAD_PLUS.test(unbracketed);
  const digits = unbracketed.replace(/[^0-9]/g, '');
  const intl = lead || digits.startsWith('00') || (r === 'US' && digits.startsWith('011'));
  let d = intl ? digits : all;
  // a + straight before a 0 is no country code: read the rest as if the + were not there
  let plus = lead && !d.startsWith('0');
  const typedPlus = plus;
  if (!plus && d.startsWith('00')) { plus = true; d = d.slice(2); }
  else if (!plus && r === 'US' && d.startsWith('011')) { plus = true; d = d.slice(3); }
  let m;
  if (plus) {
    if (d.startsWith('44')) {
      if ((m = RE_PLUS_44.exec(d))) return '+44' + m[1];
    } else if (d.startsWith('1')) {
      if (RE_PLUS_1.test(d)) return '+' + d;
    } else if (RE_PLUS_OTHER.test(d)) {
      return '+' + d;
    }
    // Written with a country code we cannot read ('+44 3887 9681', one digit short): kept WITH
    // its + (or 00), as the till stored it before 29 Sep 2026, so it is never read again as a
    // number of the venue's own country (4438879681 is a Maryland number). Not a whole number:
    // phoneKeyReadable says no, and the database still matches it on its digits.
    if (d.length >= 7) return (typedPlus ? '+' : '00') + d;
  } else if (r === 'GB') {
    if ((m = RE_GB_NATIONAL.exec(d))) return '+44' + m[1];
    if (RE_GB_44.test(d)) return '+' + d;
  } else if (r === 'US') {
    if ((m = RE_US_NATIONAL.exec(d))) return '+1' + m[1];
  }
  // Not read: its digits. When a '(0)' was taken out and the rest still could not be read, the
  // digits are read once more as written, so the key of the key is always the key.
  return intl && digits !== all ? phoneMatchKey(all, region) : all;
}

/**
 * The key is a whole international number (E.164) we read: +44 and a whole UK number, +1 and a
 * whole North American one, or another country code and 7 to 15 digits. Only such a key can be
 * texted (the loyalty login) or found under the shapes older builds wrote (phoneLookupValues).
 * A key we could not read (digits, 00 and digits, or a + number of the wrong length) is matched
 * on its digits only, as before 29 Sep 2026.
 */
export function phoneKeyReadable(key) {
  return RE_READABLE.test(String(key ?? ''));
}

/**
 * The rule every till, kiosk and loyalty login used before 29 Sep 2026 (UK only, no region).
 * Kept ONLY for the loyalty login's second reading of a number its region cannot read
 * (smsPhoneKey, where the code texted to it proves the reading). Never write with it, and never
 * look a customer up with it: it reads '07...' as British in every venue, which the database
 * does not (29 Sep 2026 review).
 */
export function legacyAppPhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/[^0-9+]/g, '');
  if (!digits) return null;
  if (digits.startsWith('+')) return digits;
  if (digits.startsWith('07') && digits.length === 11) return '+44' + digits.slice(1);
  if (digits.startsWith('44')) return '+' + digits;
  return digits;
}

/**
 * The region a STORED customers.phone without its country code is read in, in a venue of this
 * region: 'GB' in a UK venue, '' anywhere else. Never 'US': a UK number stored without its 0
 * ('2014812891', typed at a UK venue of the same organisation) looks exactly like a US number,
 * and nothing says which venue wrote the row. The UK reading is safe in a UK venue whatever the
 * organisation's other venues are: no North American number is written with a leading 0, or as
 * 44 and a whole UK number. A number written with 00 is read in every region.
 * The database uses the same rule (20260929a, v_read).
 */
export function storedPhoneRegion(region) {
  return regionOf(region) === 'GB' ? 'GB' : '';
}

/**
 * Every value customers.phone may hold for this number, for ONE direct read
 * (.in('phone', values)), and exactly the rows the database finds for it (20260929a):
 *   - the key, always first, whatever its length (only + and digits, so filter safe);
 *   - for a key we can read (+...), every shape WITHOUT a + that reads back to it as a stored
 *     number (storedPhoneRegion): written with 00 (in every venue), and in a UK venue a UK
 *     number as 0 and the rest ('07931129015', how an import kept a landline) or as 44 and the
 *     rest (how an older online order stored it);
 *   - for a number we cannot read, only the key: its digits, or its + or 00 and digits when it
 *     was typed so (what the till stored before 29 Sep 2026; the database also matches its
 *     digits, as before).
 * Nothing else. Not the digits of a +32 key ('3235550147' may be a US number typed without its
 * +1 in a UK venue), not a US 10 digit number (a UK number stored without its 0 looks the same),
 * and not the old UK only app rule ('07931129015' is not British in a US venue). A number we
 * cannot read is found only by its key, exactly as the till found it before.
 * [] when the number has fewer than 7 digits. The row whose phone IS the key is the one to use
 * (pickPhoneRow).
 */
export function phoneLookupValues(raw, region = '') {
  const key = phoneMatchKey(raw, region);
  if (!key) return [];
  const out = [key];
  if (!phoneKeyReadable(key)) return out;
  const add = (v) => { if (RE_SAFE.test(v) && !out.includes(v)) out.push(v); };
  const digits = key.slice(1);
  add('00' + digits);
  const m = RE_KEY_44.exec(key);
  if (m) {
    add('00440' + m[1]);
    if (storedPhoneRegion(region) === 'GB') { add('0' + m[1]); add(digits); }
  }
  return out;
}

/**
 * The number a text message goes to (the loyalty login's one time code): the key, which must be
 * a whole international number (E.164). A number the venue's region cannot read gets one more
 * reading by the old app rule ('07931129015' is +44 wherever it is typed), so nobody who signed
 * in before 29 Sep 2026 is refused now; the code sent to it proves the reading. null under 7
 * digits; a value phoneKeyReadable refuses is not a whole number (ask for the country code).
 */
export function smsPhoneKey(raw, region = '') {
  const key = phoneMatchKey(raw, region);
  if (!key || phoneKeyReadable(key)) return key;
  const old = phoneMatchKey(legacyAppPhone(raw), region);
  return old && phoneKeyReadable(old) ? old : key;
}

/** Two numbers TYPED in this venue are the same number (the same key, not null). */
export function samePhoneKey(a, b, region = '') {
  const x = phoneMatchKey(a, region);
  return x !== null && x === phoneMatchKey(b, region);
}

/**
 * A STORED number (customers.phone, or phone_raw as typed wherever it was typed) is the number
 * typed here: the typed one keyed in this venue's region, the stored one read only as a stored
 * number is (storedPhoneRegion). The same test the one read and the database make.
 */
export function storedPhoneIs(stored, typed, region = '') {
  const key = phoneMatchKey(typed, region);
  return key !== null && phoneMatchKey(stored, storedPhoneRegion(region)) === key;
}

/**
 * Of the rows a phoneLookupValues read found, the one to use: the row whose phone IS the key,
 * else the oldest (created_at, then id). Two rows for one number exist only where an older build
 * made a second one; the canonical, oldest row is the member.
 */
export function pickPhoneRow(rows, key) {
  const list = (Array.isArray(rows) ? rows : []).filter((r) => r && r.id);
  if (!list.length) return null;
  const exact = list.filter((r) => key && String(r.phone ?? '') === key);
  const pool = exact.length ? exact : list;
  return pool.slice().sort((a, b) => {
    const ta = String(a.created_at ?? ''), tb = String(b.created_at ?? '');
    if (ta !== tb) return ta < tb ? -1 : 1;
    return String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0;
  })[0];
}

/** What customers.phone_raw keeps: the number as typed, trimmed, at most 40 characters. */
export function phoneRawText(raw) {
  const s = raw == null ? '' : String(raw).trim().slice(0, 40);
  return s || null;
}
