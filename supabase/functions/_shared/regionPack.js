// supabase/functions/_shared/regionPack.js
//
// THE REGION PACK (v5.11.101). One source of truth for what changes when a venue is in the US
// rather than the UK: the money symbol, how dates read, the phone country code, which payroll
// fields a staff record carries, which documents a person needs to work, which pay periods are
// allowed, how holiday works and what the payroll export holds.
//
// It FOLLOWS THE VENUE, as the currency does (Peter, 24 Oct 2026: "we can have a US site and the
// currency changes, and local features should turn on the same way"). There is no switch for it:
// a venue whose currency is USD is a US venue, GBP is the UK, EUR is Ireland. A country column, if
// one is ever added to locations, wins over the currency (regionOf reads it first).
//
// PURE: no imports, so the Back Office, the staff app (through staff-portal), the edge functions
// and node:test all read the same rules (src/lib/regionPack.js re exports it with the browser's
// active venue; src/lib/regionPack.test.js tests every case).
//
// UK FIGURES NEVER MOVE: the UK pack is exactly what the app did before this file existed
// (12.07% holiday, BACS export with sort code and account number, NI number, Right to Work).

/** @typedef {'UK'|'US'|'IE'} Country */

const UK_DOCS = ['RTW', 'foodHygieneL2', 'allergenTraining', 'SIA', 'firstAid', 'other'];
const US_DOCS = ['I9', 'W4', 'foodHandler', 'allergenTraining', 'firstAid', 'other'];
const IE_DOCS = ['RTW', 'foodHygieneL2', 'allergenTraining', 'firstAid', 'other'];

/** Every document type any region uses, with its label and its group (compliance or training). */
export const DOC_INFO = {
  RTW: { label: 'Right to Work', group: 'compliance' },
  SIA: { label: 'SIA Licence', group: 'compliance' },
  I9: { label: 'Form I-9 (work eligibility)', group: 'compliance' },
  W4: { label: 'Form W-4 (tax withholding)', group: 'compliance' },
  foodHygieneL2: { label: 'Food Hygiene L2', group: 'training' },
  foodHandler: { label: 'Food handler permit', group: 'training' },
  allergenTraining: { label: 'Allergen Training', group: 'training' },
  firstAid: { label: 'First Aid', group: 'training' },
  other: { label: 'Other', group: 'other' },
};

const PACKS = {
  UK: {
    country: 'UK', countryName: 'United Kingdom', currency: 'GBP', currencySymbol: '£', locale: 'en-GB',
    dateFormat: 'DD/MM/YYYY',
    phoneDefaultCountryCode: '44', phoneFormat: '07700 900123',
    // The fields a staff record carries for payroll. bank: sort code + account number (BACS).
    payrollFields: ['bankSortCode', 'bankAccount', 'bankAccountName', 'niNumber', 'taxCode'],
    bankDetails: true,
    documentTypes: UK_DOCS,
    requiredDocs: ['RTW'],             // SIA joins when the position needs it (WfCompliance)
    workDocLabel: 'Right to Work',
    payPeriods: ['weekly', 'fortnightly', 'fourweekly', 'monthly'],
    holidayRules: 'uk',                // 12.07% accrual on hours for hourly staff
    overtimeWeeklyHours: null,         // UK has no statutory overtime premium
    payrollExport: 'bacs',
  },
  US: {
    country: 'US', countryName: 'United States', currency: 'USD', currencySymbol: '$', locale: 'en-US',
    dateFormat: 'MM/DD/YYYY',
    phoneDefaultCountryCode: '1', phoneFormat: '(801) 555-1234',
    // No bank fields: a US venue pays through its payroll provider, which holds them. SSN last 4
    // only (never the whole number), and the provider's own employee id for the export.
    payrollFields: ['ssnLast4', 'payrollEmployeeId'],
    bankDetails: false,
    documentTypes: US_DOCS,
    requiredDocs: ['I9', 'W4'],
    workDocLabel: 'Form I-9',
    payPeriods: ['weekly', 'fortnightly', 'semimonthly', 'monthly'],
    holidayRules: 'us',                // no statutory accrual: off for now
    overtimeWeeklyHours: 40,           // federal FLSA: over 40 hours in a work week is overtime
    payrollExport: 'us_payroll',
  },
  IE: {
    country: 'IE', countryName: 'Ireland', currency: 'EUR', currencySymbol: '€', locale: 'en-IE',
    dateFormat: 'DD/MM/YYYY',
    phoneDefaultCountryCode: '353', phoneFormat: '085 123 4567',
    payrollFields: ['bankAccount', 'bankAccountName'],
    bankDetails: true,
    documentTypes: IE_DOCS,
    requiredDocs: ['RTW'],
    workDocLabel: 'Right to Work',
    payPeriods: ['weekly', 'fortnightly', 'fourweekly', 'monthly'],
    holidayRules: 'uk',
    overtimeWeeklyHours: null,
    payrollExport: 'bacs',
  },
};

const COUNTRY_ALIASES = { GB: 'UK', UK: 'UK', 'UNITED KINGDOM': 'UK', US: 'US', USA: 'US', 'UNITED STATES': 'US', IE: 'IE', IRL: 'IE', IRELAND: 'IE' };
const BY_CURRENCY = { GBP: 'UK', USD: 'US', EUR: 'IE' };

/**
 * The venue's country. A country field wins when there is one; else the currency (USD is the US,
 * GBP the UK, EUR Ireland); else the UK, which is what every screen assumed before.
 * @param {{country?:string, currency?:string}|string|null|undefined} venue  a row, or a currency code
 * @returns {Country}
 */
export function regionOf(venue) {
  const v = typeof venue === 'string' ? { currency: venue } : (venue || {});
  const c = COUNTRY_ALIASES[String(v.country || '').trim().toUpperCase()];
  if (c) return c;
  return BY_CURRENCY[String(v.currency || '').trim().toUpperCase()] || 'UK';
}

/** The whole pack for a venue (a row with country/currency, or a currency code). A fresh copy. */
export function regionPack(venue) {
  const p = PACKS[regionOf(venue)];
  return { ...p, payrollFields: [...p.payrollFields], documentTypes: [...p.documentTypes], requiredDocs: [...p.requiredDocs], payPeriods: [...p.payPeriods] };
}

/** Is this pay period type allowed for the venue? */
export function payPeriodAllowed(venue, type) {
  return PACKS[regionOf(venue)].payPeriods.includes(String(type || ''));
}

/** A document type's label ('I9' reads "Form I-9 (work eligibility)"). Unknown types read as given. */
export function docLabel(type) {
  return DOC_INFO[type]?.label || String(type || '');
}

/**
 * A phone number in E.164 ('+18015551234'), read with the venue's country, or null.
 *   already +E.164           passes through (any country)
 *   00 then the country      '+' and the rest (0044 7700..., 001 801...)
 *   UK venue (44)            07700 900123 -> +447700900123; 447700900123 -> +447700900123
 *   US venue (1)             801 555 1234 / (801) 555-1234 / 801-555-1234 -> +18015551234;
 *                            1 801 555 1234 -> +18015551234
 *   Ireland (353)            085 123 4567 -> +353851234567
 * The old reader was UK only: a US local 801 555 1234 became +44801..., a number nobody has.
 * @param {string} raw
 * @param {string|object} [countryCodeOrVenue='44']  '44' | '1' | '353', or a venue row / currency
 */
export function toE164(raw, countryCodeOrVenue = '44') {
  if (raw == null || raw === '') return null;
  const cc = typeof countryCodeOrVenue === 'string' && /^\d{1,3}$/.test(countryCodeOrVenue)
    ? countryCodeOrVenue
    : PACKS[regionOf(countryCodeOrVenue)].phoneDefaultCountryCode;
  let s = String(raw).trim().replace(/[\s()\-.]/g, '');
  const valid = (x) => (/^\+[1-9]\d{6,14}$/.test(x) ? x : null);
  if (s.startsWith('+')) return valid(s);
  if (!/^\d+$/.test(s)) return null;
  if (s.startsWith('00')) return valid('+' + s.slice(2));
  if (cc === '1') {
    // North American numbers: ten digits (area code first, never 0 or 1), or eleven with the 1.
    if (/^[2-9]\d{9}$/.test(s)) return '+1' + s;
    if (/^1[2-9]\d{9}$/.test(s)) return '+' + s;
    return null;
  }
  if (s.startsWith('0')) return valid('+' + cc + s.slice(1));          // national 0 dropped
  if (s.startsWith(cc)) return valid('+' + s);                         // country code without the +
  if (/^[1-9]\d{6,14}$/.test(s)) return valid('+' + cc + s);           // bare national, no leading 0
  return null;
}

/**
 * A date the venue's way: 'DD/MM/YYYY' (UK, Ireland) or 'MM/DD/YYYY' (US), from 'YYYY-MM-DD'.
 * Anything that is not a date reads as an empty string.
 */
export function fmtDateNumeric(iso, venue) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  if (!m) return '';
  return PACKS[regionOf(venue)].dateFormat === 'MM/DD/YYYY' ? `${m[2]}/${m[3]}/${m[1]}` : `${m[3]}/${m[2]}/${m[1]}`;
}

/**
 * A money amount the Workforce way: symbol + grouped figure ("£1,234", "$1,234.50"). With a GBP
 * venue this is exactly the string the Workforce screens built before (en-GB grouping, the same
 * decimals), so UK figures read byte for byte as they did.
 */
export function wfMoneyText(n, dp = 0, venue = 'GBP') {
  const p = PACKS[regionOf(venue)];
  return p.currencySymbol + Number(n || 0).toLocaleString(p.locale, { minimumFractionDigits: dp, maximumFractionDigits: dp });
}
