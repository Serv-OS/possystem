// src/lib/hq/systemDay.js
//
// What ServOS already knows for one site and one business day, so Daily numbers shows the
// system's figure beside every box and only takes an override. Pure: no React, no Supabase,
// so node --test drives it (systemDay.test.js). The data layer (data.js fetchSystemDay) gathers
// the raw rows; this file turns them into figures with a source and words.
//
// Sources, per figure:
//   net_sales          the till, by the Daily trading rule (net ex VAT, after refunds)        'till'
//   labour             approved and paid timesheets, pay plus overtime premium                'workforce'
//   cogs               the stock ledger when the venue's basis is recipe, else its flat %     'stock' | 'estimate'
//   projected_*        the day's sales forecast (wf_sales_forecast) split into three dayparts  'forecast'
//                      by the hours saved against it, else by the site's own pattern over the
//                      last four same weekdays; with neither, the dayparts stay blank
//   reviews_count,
//   review_rating      public reviews synced from Google and the like (origin 'synced')         'reviews'
//   turnover_pct       Workforce leavers over the trailing 90 days against average headcount  'workforce'
//   morale_score,
//   hires_needed       nothing in the system holds these; typed only                           null
// A figure the system does not have is null and the words say why. Never a guessed zero.

const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const r2 = (v) => (v === null ? null : Math.round(v * 100) / 100);
const r1 = (v) => (v === null ? null : Math.round(v * 10) / 10);

export const SOURCE_WORDS = Object.freeze({
  till: 'Till', workforce: 'Workforce', stock: 'Stock', estimate: 'Estimate', forecast: 'Forecast', reviews: 'Reviews', typed: 'Typed', csv: 'CSV', system: 'System',
});
export const sourceWord = (s) => SOURCE_WORDS[s] || (s ? String(s) : null);

export const SYSTEM_KEYS = Object.freeze(['net_sales', 'cogs', 'labour', 'projected_lunch', 'projected_dinner', 'projected_late', 'reviews_count', 'review_rating', 'turnover_pct', 'morale_score', 'hires_needed']);

// ----------------------------------------------------------------------------
// Dayparts
// ----------------------------------------------------------------------------
export const DAYPART_DEFAULT = Object.freeze({ dinnerStart: 17 * 60, lateStart: 22 * 60, source: 'default' });

export function hhmmToMin(s) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(s || '').trim());
  if (!m) return null;
  const h = Number(m[1]); const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

/**
 * Where dinner and late night start, from the venue's own service periods (locations.shifts,
 * [{ name, start, end }]) when one is named dinner or evening and one late or night; else 17:00
 * and 22:00, the Reports rule. Lunch is everything from the business day start until dinner.
 */
export function daypartBounds(shifts) {
  const list = Array.isArray(shifts) ? shifts : [];
  const find = (re) => list.find((s) => re.test(String(s?.name || '')) && hhmmToMin(s.start) !== null);
  const dinner = find(/dinner|evening/i);
  const late = find(/late|night/i);
  if (!dinner) return { ...DAYPART_DEFAULT };
  const dinnerStart = hhmmToMin(dinner.start);
  let lateStart = late ? hhmmToMin(late.start) : null;
  if (lateStart === null || lateStart <= dinnerStart) lateStart = Math.max(dinnerStart + 60, DAYPART_DEFAULT.lateStart);
  return { dinnerStart, lateStart, source: 'venue' };
}

/** Which daypart a wall clock minute falls in. Before the business day start is late night (the night before's trade). */
export function daypartOf(minutes, bounds = DAYPART_DEFAULT, dayStartMin = 6 * 60) {
  const m = Number(minutes);
  if (!Number.isFinite(m)) return null;
  if (m < dayStartMin) return 'late';
  if (m >= bounds.lateStart) return 'late';
  if (m >= bounds.dinnerStart) return 'dinner';
  return 'lunch';
}

const emptyParts = () => ({ lunch: 0, dinner: 0, late: 0 });

function sharesOf(parts) {
  const total = parts.lunch + parts.dinner + parts.late;
  if (!(total > 0)) return null;
  return { lunch: parts.lunch / total, dinner: parts.dinner / total, late: parts.late / total };
}

/** Shares from hourly forecast rows [{ hour, amount }] saved against the day. */
export function patternFromHours(hours, bounds = DAYPART_DEFAULT, dayStartMin = 6 * 60) {
  const parts = emptyParts();
  for (const h of hours || []) {
    const amount = num(h?.amount); const hour = num(h?.hour);
    if (amount === null || hour === null || amount <= 0) continue;
    parts[daypartOf(hour * 60, bounds, dayStartMin)] += amount;
  }
  return sharesOf(parts);
}

/**
 * Shares from the site's own till pattern: checks [{ minutes, total, voided, status }] where
 * minutes is the venue wall clock minute of closing (stamped by the data layer). Voided checks
 * do not count. Null with no sales.
 */
export function patternFromChecks(checks, bounds = DAYPART_DEFAULT, dayStartMin = 6 * 60) {
  const parts = emptyParts();
  for (const c of checks || []) {
    if (!c || c.voided === true || /void/i.test(String(c.status || ''))) continue;
    const total = num(c.total); const minutes = num(c.minutes);
    if (total === null || minutes === null || total <= 0) continue;
    parts[daypartOf(minutes, bounds, dayStartMin)] += total;
  }
  return sharesOf(parts);
}

/** The day total split by shares, pennies kept: the last part takes the rounding. Nulls without a total or shares. */
export function splitForecast(total, shares) {
  const t = num(total);
  if (t === null || t < 0 || !shares) return { lunch: null, dinner: null, late: null };
  const lunch = r2(t * shares.lunch);
  const dinner = r2(t * shares.dinner);
  const late = Math.max(0, r2(t - lunch - dinner));
  return { lunch, dinner, late };
}

// ----------------------------------------------------------------------------
// Reviews and turnover
// ----------------------------------------------------------------------------
/** rows already cut to the day: { count, avg } with avg to two places, null with no ratings. */
export function reviewsForDay(rows) {
  let sum = 0; let count = 0;
  for (const r of rows || []) {
    const n = num(r?.rating);
    if (n === null) continue;
    sum += n; count += 1;
  }
  return { count, avg: count ? r2(sum / count) : null };
}

const ymdPlus = (ymd, n) => {
  const d = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10)) + n * 86400000);
  return d.toISOString().slice(0, 10);
};

/**
 * Trailing turnover % as of ymd from Workforce staff rows { status, start_date, leaver_date, created_at }:
 * leavers dated inside the window over the average of the headcount at the start and end of it.
 * Rows with no start date are left out (added by mistake and removed). Null with nobody on the books.
 */
export function turnoverPct(staff, ymd, days = 90) {
  if (!ymd) return null;
  const from = ymdPlus(ymd, -(days - 1));
  const before = ymdPlus(ymd, -days);
  const rows = (staff || []).filter((s) => s && s.start_date);
  const headAt = (t) => rows.filter((s) => s.status !== 'onboarding' && String(s.start_date).slice(0, 10) <= t && (!s.leaver_date || String(s.leaver_date).slice(0, 10) > t)).length;
  const leavers = rows.filter((s) => s.status === 'leaver' && s.leaver_date && String(s.leaver_date).slice(0, 10) >= from && String(s.leaver_date).slice(0, 10) <= ymd).length;
  const avg = (headAt(before) + headAt(ymd)) / 2;
  if (!(avg > 0)) return null;
  return r1((leavers / avg) * 100);
}

// ----------------------------------------------------------------------------
// The system's figures, one object per box
// ----------------------------------------------------------------------------
const fig = (value, source, words, extra = null) => ({ value, source: value === null ? null : source, words, ...(extra || {}) });
const moneyWords = (n, money) => (money ? money(n) : String(n));

/**
 * systemFields({ trading, settings, forecastHours, patternChecks, reviews, cardCount, staff, ymd, today, shifts, dayStartMin, money })
 *   trading        the Daily trading row for the day (actual_sales, labour_actual, labour_theo, cogs_actual,
 *                  cogs_recipe, forecast ...) or null when the function could not be reached
 *   settings       { cogs_basis, cogs_pct } from the same call
 *   forecastHours  [{ hour, amount }] saved against the day, may be empty
 *   patternChecks  [{ minutes, total, voided, status }] from the last four same weekdays
 *   reviews        public review rows for the day [{ rating }]; cardCount = internal feedback cards that day
 *   staff          Workforce rows for the site
 *   money          (n) => words for an amount in the site's currency
 * Returns { <key>: { value, source, words, hint? } } for every SYSTEM_KEYS entry.
 */
export function systemFields({ trading = null, settings = null, forecastHours = [], patternChecks = [], reviews = [], cardCount = 0, staff = [], ymd, today = null, shifts = [], dayStartMin = 6 * 60, money = null } = {}) {
  const out = {};
  const live = today && ymd === today;
  const future = today && ymd > today;

  // Till, labour and COGS from the Daily trading rule.
  if (!trading) {
    const why = future ? 'The day has not happened yet.' : 'The till figures could not be read.';
    out.net_sales = fig(null, null, why);
    out.labour = fig(null, null, why);
    out.cogs = fig(null, null, why);
  } else {
    const net = num(trading.actual_sales);
    out.net_sales = fig(net, 'till', net === null ? 'The till figures could not be read.' : net === 0 && !live ? 'No sales on the till that day.' : live ? `${moneyWords(net, money)} so far today, net of VAT and refunds.` : `${moneyWords(net, money)} net of VAT and refunds, the Daily trading figure.`);

    const la = num(trading.labour_actual) ?? 0; const lt = num(trading.labour_theo) ?? 0;
    if (la > 0) out.labour = fig(la, 'workforce', `${moneyWords(la, money)} from approved and paid timesheets.`, lt > 0 ? { hint: `Rota planned ${moneyWords(lt, money)}.` } : null);
    else if (lt > 0) out.labour = fig(null, null, `No approved timesheets yet. The rota planned ${moneyWords(lt, money)}; approve the timesheets in Workforce and it fills.`);
    else out.labour = fig(net === 0 && !live ? 0 : null, 'workforce', net === 0 && !live ? 'No shifts that day.' : 'No shifts or timesheets for that day in Workforce.');

    const basis = settings?.cogs_basis === 'recipe' ? 'recipe' : 'estimate';
    const pctSet = (num(settings?.cogs_pct) || 0) > 0;
    const ca = num(trading.cogs_actual); const cr = num(trading.cogs_recipe);
    if (basis === 'recipe') out.cogs = fig(ca, 'stock', ca === null ? 'The stock ledger could not be read.' : `${moneyWords(ca, money)} from the stock ledger (recipe cost of what sold).`);
    else if (pctSet) out.cogs = fig(ca, 'estimate', `${moneyWords(ca, money)}, the venue's ${num(settings.cogs_pct)}% estimate of sales.`, cr > 0 ? { hint: `The stock ledger says ${moneyWords(cr, money)}.` } : null);
    else out.cogs = fig(null, null, 'No COGS basis set for this site. Set a COGS % or the recipe basis under Reports, Daily trading, or type it.');
  }

  // Forecast split into dayparts.
  const bounds = daypartBounds(shifts);
  const forecast = num(trading?.forecast);
  const blankParts = { lunch: null, dinner: null, late: null };
  let parts = blankParts; let partWords; let partSource = null;
  if (forecast === null || forecast <= 0) partWords = trading ? 'No sales forecast saved for this day. Set one on the rota or under Purchasing, Forecast.' : 'The forecast could not be read.';
  else {
    const byHours = patternFromHours(forecastHours, bounds, dayStartMin);
    const byPattern = byHours ? null : patternFromChecks(patternChecks, bounds, dayStartMin);
    const shares = byHours || byPattern;
    if (shares) {
      parts = splitForecast(forecast, shares); partSource = 'forecast';
      partWords = `Day forecast ${moneyWords(forecast, money)}, split ${byHours ? 'by the hours saved against it' : 'by this site\'s pattern over the last four same weekdays'}${bounds.source === 'venue' ? ', on the venue\'s service periods' : ''}.`;
    } else partWords = `Day forecast ${moneyWords(forecast, money)}, but no sales pattern yet to split it into dayparts.`;
  }
  out.projected_lunch = fig(parts.lunch, partSource, partWords, { total: forecast });
  out.projected_dinner = fig(parts.dinner, partSource, partWords, { total: forecast });
  out.projected_late = fig(parts.late, partSource, partWords, { total: forecast });

  // Reviews.
  const rv = reviewsForDay(reviews);
  const cardWords = cardCount ? ` ${cardCount} feedback card${cardCount === 1 ? '' : 's'} came in too, not counted here.` : '';
  out.reviews_count = fig(rv.count, 'reviews', rv.count ? `${rv.count} public review${rv.count === 1 ? '' : 's'} that day.${cardWords}` : `No public reviews that day.${cardWords}`);
  out.review_rating = fig(rv.avg, 'reviews', rv.avg === null ? 'No public reviews to average.' : `Average of the day's public reviews.`);

  // Turnover.
  const t = turnoverPct(staff, ymd);
  out.turnover_pct = fig(t, 'workforce', t === null ? 'No staff records for this site in Workforce.' : 'Leavers over the last 90 days against average headcount, from Workforce.');

  // Typed only.
  out.morale_score = fig(null, null, 'Typed only: nothing in the system holds morale.');
  out.hires_needed = fig(null, null, 'Typed only: nothing in the system holds open roles.');
  return out;
}

// ----------------------------------------------------------------------------
// Boxes plus system figures to the row that is saved
// ----------------------------------------------------------------------------
const cleanTyped = (v) => {
  const s = String(v ?? '').trim().replace(/[$£€,\s]/g, '').replace(/%$/, '');
  return s === '' ? null : (Number.isNaN(Number(s)) ? null : Number(s));
};

/**
 * resolveDay(form, system, locationId, businessDate): the row to save. A typed box wins; a blank
 * box takes the system figure. `sources` names where each figure came from; `source` is 'typed'
 * when any box was typed, else 'system'. Notes are kept as typed.
 */
export function resolveDay(form, system, locationId, businessDate) {
  const row = { location_id: locationId, business_date: businessDate, notes: String(form?.notes || '').trim() || null };
  const sources = {};
  let anyTyped = false;
  for (const k of SYSTEM_KEYS) {
    const typed = cleanTyped(form?.[k]);
    if (typed !== null) { row[k] = typed; sources[k] = 'typed'; anyTyped = true; continue; }
    const sys = system?.[k];
    row[k] = sys && sys.value !== null && sys.value !== undefined ? sys.value : null;
    if (row[k] !== null) sources[k] = sys.source || 'system';
  }
  row.source = anyTyped ? 'typed' : 'system';
  row.sources = sources;
  return row;
}

/** The saved row's sources map, or null when it has none (older rows: the column is {} by default). */
export function sourcesMap(row) {
  const m = row?.sources;
  return m && typeof m === 'object' && !Array.isArray(m) && Object.keys(m).length ? m : null;
}

/** Which boxes in a saved row were typed: for the form to show the override again. */
export function typedBoxes(row) {
  // A row saved before slice 3 has no sources map (the column defaults to {}), and every figure it
  // holds was typed or pasted, so each one comes back as an override.
  const map = sourcesMap(row);
  const out = {};
  for (const k of SYSTEM_KEYS) out[k] = (map ? map[k] === 'typed' || map[k] === 'csv' : row?.source !== 'system') && row?.[k] !== null && row?.[k] !== undefined ? String(row[k]) : '';
  out.notes = row?.notes || '';
  return out;
}
