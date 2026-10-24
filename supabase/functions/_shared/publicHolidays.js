// supabase/functions/_shared/publicHolidays.js
//
// v5.11.101: public holiday calendars, one copy for the Back Office (src/staff/wfWeek.js, the
// "paid on the last working day" rule) and the edge functions (the bank holiday pay premium in
// workforce-compute, _shared/payPremiums.js). PURE: no imports.
//
//   ukBankHolidays(year)      England and Wales (the set wfWeek has always used; Scotland and
//                             Northern Ireland differ, and the Settings screen says so)
//   usFederalHolidays(year)   the eleven US federal holidays, observed dates (a Saturday holiday
//                             is kept on the Friday before, a Sunday one on the Monday after)
//   publicHolidays(country, year)  'UK' | 'IE' -> ukBankHolidays, 'US' -> usFederalHolidays
// Every set holds local 'YYYY-MM-DD' strings.

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Easter Sunday for a Gregorian year (Anonymous Gregorian algorithm). */
export function easterSunday(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  return new Date(y, Math.floor((h + l - 7 * m + 114) / 31) - 1, ((h + l - 7 * m + 114) % 31) + 1);
}

/** Nth (or last, n = -1) weekday `dow` of a month. */
export function nthDow(y, month, dow, n) {
  if (n === -1) {
    const d = new Date(y, month + 1, 0);            // last day of the month
    d.setDate(d.getDate() - ((d.getDay() - dow + 7) % 7));
    return d;
  }
  const d = new Date(y, month, 1);
  d.setDate(1 + ((dow - d.getDay() + 7) % 7) + (n - 1) * 7);
  return d;
}

const _uk = new Map();
/** England and Wales bank holidays for a year, as a Set of YYYY-MM-DD. */
export function ukBankHolidays(year) {
  if (_uk.has(year)) return _uk.get(year);
  const easter = easterSunday(year);
  const rel = n => { const d = new Date(easter); d.setDate(easter.getDate() + n); return d; };
  const set = new Set([
    rel(-2),                          // Good Friday
    rel(1),                           // Easter Monday
    nthDow(year, 4, 1, 1),            // first Monday in May
    nthDow(year, 4, 1, -1),           // last Monday in May
    nthDow(year, 7, 1, -1),           // last Monday in August
  ].map(ymd));
  // Fixed dates get a substitute weekday when they land on a weekend; the
  // substitute is the next weekday not already taken (so 25/26 Dec on a
  // Sat/Sun become Mon 27 + Tue 28, which is the actual rule).
  [new Date(year, 0, 1), new Date(year, 11, 25), new Date(year, 11, 26)].forEach(d => {
    const s = new Date(d);
    while (s.getDay() === 0 || s.getDay() === 6 || set.has(ymd(s))) s.setDate(s.getDate() + 1);
    set.add(ymd(s));
  });
  _uk.set(year, set);
  return set;
}

const _us = new Map();
/** US federal holidays for a year (observed dates), as a Set of YYYY-MM-DD. */
export function usFederalHolidays(year) {
  if (_us.has(year)) return _us.get(year);
  const observed = (d) => {
    const o = new Date(d);
    if (o.getDay() === 6) o.setDate(o.getDate() - 1);   // Saturday: the Friday before
    else if (o.getDay() === 0) o.setDate(o.getDate() + 1); // Sunday: the Monday after
    return o;
  };
  const set = new Set([
    observed(new Date(year, 0, 1)),   // New Year's Day
    nthDow(year, 0, 1, 3),            // Martin Luther King Jr. Day, third Monday in January
    nthDow(year, 1, 1, 3),            // Washington's Birthday, third Monday in February
    nthDow(year, 4, 1, -1),           // Memorial Day, last Monday in May
    observed(new Date(year, 5, 19)),  // Juneteenth
    observed(new Date(year, 6, 4)),   // Independence Day
    nthDow(year, 8, 1, 1),            // Labor Day, first Monday in September
    nthDow(year, 9, 1, 2),            // Columbus Day, second Monday in October
    observed(new Date(year, 10, 11)), // Veterans Day
    nthDow(year, 10, 4, 4),           // Thanksgiving, fourth Thursday in November
    observed(new Date(year, 11, 25)), // Christmas Day
  ].map(ymd));
  _us.set(year, set);
  return set;
}

/** The public holidays of a country for a year. */
export function publicHolidays(country, year) {
  return String(country || '').toUpperCase() === 'US' ? usFederalHolidays(year) : ukBankHolidays(year);
}

/** Is this 'YYYY-MM-DD' a public holiday in the country? */
export function isPublicHoliday(country, iso) {
  const y = Number(String(iso || '').slice(0, 4));
  if (!y) return false;
  return publicHolidays(country, y).has(String(iso).slice(0, 10));
}
