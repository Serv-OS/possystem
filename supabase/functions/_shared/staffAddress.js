// supabase/functions/_shared/staffAddress.js (5.12.89)
//
// A team member's home address. One copy for the staff app (the Me tab), the Back Office (the staff
// form and the "no postcode" flag) and staff-portal (which refuses a changed UK address with no
// postcode). Pure, no imports: node --test (src/staff/staffAddress.test.js).
//
// WHY (HR feedback, 23 Nov 2026): the app asked for "Home address" in one free text box, so people
// typed a street and stopped. Payroll and HMRC need the postcode. The address stays ONE text column
// (wf_staff.address, so every export and report reads it as before) with the postcode as its last
// part; the screens ask for the postcode in its own box and these rules join and split the two.
//
// country: 'UK' | 'US' | 'IE' (the region pack's country). UK: the postcode is required and checked.
// US and Ireland: the ZIP code or Eircode is optional, and checked when typed.

const UK_ONE = '(?:GIR ?0AA|[A-PR-UWYZ][A-HK-Y]?[0-9][A-Z0-9]? ?[0-9][ABD-HJLNP-UW-Z]{2})';
const US_ONE = '(?:[0-9]{5}(?:-[0-9]{4})?)';
const IE_ONE = '(?:(?:[AC-FHKNPRTV-Y][0-9]{2}|D6W) ?[0-9AC-FHKNPRTV-Y]{4})';
const ONE = { UK: UK_ONE, US: US_ONE, IE: IE_ONE };
const oneOf = (country) => ONE[country] || UK_ONE;

/** What this country calls it. */
export function postcodeWord(country) {
  return country === 'US' ? 'ZIP code' : country === 'IE' ? 'Eircode' : 'Postcode';
}
/** An example in this country's shape, for the placeholder and the refusal. */
export function postcodeExample(country) {
  return country === 'US' ? '84101' : country === 'IE' ? 'D02 X285' : 'LS1 4AP';
}
/** Is a postcode required here? Only the UK (payroll needs it). */
export function postcodeRequired(country) {
  return country !== 'US' && country !== 'IE';
}

/** The postcode the tidy way ('ls14ap' reads 'LS1 4AP'), or '' when it is not one. */
export function normalisePostcode(raw, country = 'UK') {
  const s = String(raw || '').trim().toUpperCase().replace(/\s+/g, ' ');
  if (!s) return '';
  if (!new RegExp(`^${oneOf(country)}$`).test(s)) return '';
  if (country === 'US') return s;
  const tight = s.replace(/ /g, '');
  if (country === 'IE') return `${tight.slice(0, 3)} ${tight.slice(3)}`;
  return `${tight.slice(0, -3)} ${tight.slice(-3)}`;
}

/** The stored address as the two boxes: { street, postcode }. No postcode found: all of it is street. */
export function splitAddress(address, country = 'UK') {
  const text = String(address || '').trim();
  if (!text) return { street: '', postcode: '' };
  const m = text.match(new RegExp(`^(.*?)[\\s,]*\\b(${oneOf(country)})[\\s,.]*$`, 'i'));
  if (!m) return { street: text, postcode: '' };
  const postcode = normalisePostcode(m[2], country);
  if (!postcode) return { street: text, postcode: '' };
  return { street: m[1].replace(/[\s,]+$/, '').trim(), postcode };
}

/** The two boxes as the stored address ("12 High Street, Leeds, LS1 4AP"). */
export function joinAddress(street, postcode, country = 'UK') {
  const st = String(street || '').trim().replace(/[\s,]+$/, '');
  const pc = normalisePostcode(postcode, country);
  // Typed the postcode into the address box as well: keep one copy.
  const base = pc ? splitAddress(st, country) : null;
  const lines = base && base.postcode === pc ? base.street : st;
  return [lines, pc].filter(Boolean).join(', ');
}

/** Why the two boxes cannot be saved, in words, or null. Both blank is allowed (clears it). */
export function addressProblem(street, postcode, country = 'UK') {
  const st = String(street || '').trim();
  const pcRaw = String(postcode || '').trim();
  const word = postcodeWord(country);
  if (!st && !pcRaw) return null;
  if (!st) return 'Add your house number and street as well.';
  if (!pcRaw) return postcodeRequired(country) ? `Add your ${word.toLowerCase()}. Payroll needs your full address.` : null;
  if (!normalisePostcode(pcRaw, country)) return `That ${word} does not look right. It should look like ${postcodeExample(country)}.`;
  return null;
}

/** Back Office flag: an address is on file but has no postcode where one is required. */
export function addressIncomplete(address, country = 'UK') {
  const text = String(address || '').trim();
  if (!text || !postcodeRequired(country)) return false;
  return !splitAddress(text, country).postcode;
}

/**
 * The server's check on a changed address (staff-portal update_details). An unchanged address is
 * never refused: someone with an old address on file can still save their emergency contact.
 */
export function addressChangeProblem(next, prev, country = 'UK') {
  const n = String(next || '').trim();
  if (!n || n === String(prev || '').trim()) return null;
  if (!postcodeRequired(country)) return null;
  return splitAddress(n, country).postcode ? null : `Add your postcode to your address. It should end like ${postcodeExample(country)}.`;
}

/** An address the search found ({ line1, city, postcode, full }) as the two boxes. */
export function fromLookup(found, country = 'UK') {
  if (!found) return { street: '', postcode: '' };
  const postcode = normalisePostcode(found.postcode, country);
  const street = [found.line1, found.city].map((x) => String(x || '').trim()).filter(Boolean).join(', ')
    || splitAddress(found.full || found.label || '', country).street;
  return { street, postcode };
}
