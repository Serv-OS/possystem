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
//   projected_parts    the day's sales forecast (wf_sales_forecast) split across the venue's   'forecast'
//                      own service periods (Location settings, locations.shifts) by the hours
//                      saved against it, else by the site's pattern over the last four same
//                      weekdays; a venue with no service periods gets the day as one part
//   reviews_count,
//   review_rating      public reviews synced from Google and the like (origin 'synced')         'reviews'
//   turnover_pct       Workforce leavers over the trailing 90 days against average headcount  'workforce'
//   morale_score,
//   hires_needed       nothing in the system holds these; typed only                           null
// A figure the system does not have is null and the words say why. Never a guessed zero.
// The three older columns projected_lunch, projected_dinner and projected_late are still filled
// from the parts whose period is named lunch, dinner or late, for the CSV import and older rows.

const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const r2 = (v) => (v === null ? null : Math.round(v * 100) / 100);
const r1 = (v) => (v === null ? null : Math.round(v * 10) / 10);

export const SOURCE_WORDS = Object.freeze({
  till: 'Till', workforce: 'Workforce', stock: 'Stock', estimate: 'Estimate', forecast: 'Forecast', reviews: 'Reviews', typed: 'Typed', csv: 'CSV', system: 'System',
});
export const sourceWord = (s) => SOURCE_WORDS[s] || (s ? String(s) : null);

/** The plain boxes. The service period boxes are keyed `part:<period key>` (PART_PREFIX). */
export const SYSTEM_KEYS = Object.freeze(['net_sales', 'cogs', 'labour', 'reviews_count', 'review_rating', 'turnover_pct', 'morale_score', 'hires_needed']);
export const PART_PREFIX = 'part:';
export const WHOLE_DAY_KEY = 'day';

// ----------------------------------------------------------------------------
// Service periods (the venue's own, from Location settings)
// ----------------------------------------------------------------------------
export function hhmmToMin(s) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(s || '').trim());
  if (!m) return null;
  const h = Number(m[1]); const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'period';

/**
 * The venue's service periods as the settings hold them, [{ id, name, start, end }], in day order.
 * Returns [{ key, name, start, end, startMin, endMin }]; a period with no readable times is left out.
 * The key is the period's id, so a rename keeps a saved day's parts.
 */
export function servicePeriods(shifts) {
  const out = [];
  const seen = new Set();
  for (const s of Array.isArray(shifts) ? shifts : []) {
    const startMin = hhmmToMin(s?.start); const endMin = hhmmToMin(s?.end);
    if (startMin === null || endMin === null) continue;
    let key = String(s.id || slug(s.name));
    while (seen.has(key)) key = `${key}-2`;
    seen.add(key);
    out.push({ key, name: String(s.name || 'Period').trim() || 'Period', start: String(s.start).slice(0, 5), end: String(s.end).slice(0, 5), startMin, endMin });
  }
  return out;
}

/** Which period a wall clock minute falls in (end exclusive, a period may wrap midnight). Null outside every period. */
export function periodOf(minutes, periods) {
  const m = Number(minutes);
  if (!Number.isFinite(m)) return null;
  for (const p of periods || []) {
    const inside = p.endMin > p.startMin ? (m >= p.startMin && m < p.endMin) : (m >= p.startMin || m < p.endMin);
    if (inside) return p.key;
  }
  return null;
}

const emptyParts = (periods) => Object.fromEntries((periods || []).map((p) => [p.key, 0]));

function sharesOf(parts) {
  const total = Object.values(parts).reduce((a, b) => a + b, 0);
  if (!(total > 0)) return null;
  return Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, v / total]));
}

/** Shares by period from hourly forecast rows [{ hour, amount }] saved against the day. */
export function patternFromHours(hours, periods) {
  if (!periods?.length) return null;
  const parts = emptyParts(periods);
  for (const h of hours || []) {
    const amount = num(h?.amount); const hour = num(h?.hour);
    if (amount === null || hour === null || amount <= 0) continue;
    const k = periodOf(hour * 60, periods);
    if (k) parts[k] += amount;
  }
  return sharesOf(parts);
}

/**
 * Shares by period from the site's own till pattern: checks [{ minutes, total, voided, status }]
 * where minutes is the venue wall clock minute of closing (stamped by the data layer). Voided
 * checks and sales outside every period do not count. Null with no sales inside a period.
 */
export function patternFromChecks(checks, periods) {
  if (!periods?.length) return null;
  const parts = emptyParts(periods);
  for (const c of checks || []) {
    if (!c || c.voided === true || /void/i.test(String(c.status || ''))) continue;
    const total = num(c.total); const minutes = num(c.minutes);
    if (total === null || minutes === null || total <= 0) continue;
    const k = periodOf(minutes, periods);
    if (k) parts[k] += total;
  }
  return sharesOf(parts);
}

/** The day total split by shares across the periods, pennies kept: the last period takes the rounding. Null without a total or shares. */
export function splitForecast(total, shares, periods) {
  const t = num(total);
  if (t === null || t < 0 || !shares || !periods?.length) return null;
  const out = {};
  let used = 0;
  periods.forEach((p, i) => {
    if (i === periods.length - 1) { out[p.key] = Math.max(0, r2(t - used)); return; }
    const v = r2(t * (shares[p.key] || 0));
    out[p.key] = v; used += v;
  });
  return out;
}

const LEGACY = { lunch: /lunch/i, dinner: /dinner|evening/i, late: /late|night/i };
/** The three older columns from named parts: { lunch, dinner, late }, null where no period carries that name. parts = { key: { name, amount } }. */
export function legacyParts(parts) {
  const out = { lunch: null, dinner: null, late: null };
  for (const [col, re] of Object.entries(LEGACY)) {
    for (const p of Object.values(parts || {})) {
      if (p && re.test(String(p.name || '')) && num(p.amount) !== null) { out[col] = r2((out[col] || 0) + num(p.amount)); }
    }
  }
  return out;
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
 * systemFields({ trading, settings, forecastHours, patternChecks, reviews, cardCount, staff, ymd, today, shifts, money })
 *   trading        the Daily trading row for the day (actual_sales, labour_actual, labour_theo, cogs_actual,
 *                  cogs_recipe, forecast ...) or null when the function could not be reached
 *   settings       { cogs_basis, cogs_pct } from the same call
 *   forecastHours  [{ hour, amount }] saved against the day, may be empty
 *   patternChecks  [{ minutes, total, voided, status }] from the last four same weekdays
 *   reviews        public review rows for the day [{ rating }]; cardCount = internal feedback cards that day
 *   staff          Workforce rows for the site
 *   shifts         the venue's service periods from Location settings
 *   money          (n) => words for an amount in the site's currency
 * Returns { <key>: { value, source, words, hint? } } for every SYSTEM_KEYS entry, plus
 * projected_parts: { value: { key: { name, amount } } | null, source, words, total, periods }.
 */
export function systemFields({ trading = null, settings = null, forecastHours = [], patternChecks = [], reviews = [], cardCount = 0, staff = [], ymd, today = null, shifts = [], money = null } = {}) {
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

  // The forecast across the venue's service periods.
  const periods = servicePeriods(shifts);
  const forecast = num(trading?.forecast);
  let parts = null; let partWords; let partSource = null;
  if (forecast === null || forecast <= 0) partWords = trading ? 'No sales forecast saved for this day. Set one on the rota or under Purchasing, Forecast.' : 'The forecast could not be read.';
  else if (!periods.length) {
    parts = { [WHOLE_DAY_KEY]: { name: 'Whole day', amount: r2(forecast) } }; partSource = 'forecast';
    partWords = `Day forecast ${moneyWords(forecast, money)}. This site has no service periods, so it is one part: set them under Location settings, Service periods, and the forecast splits by them.`;
  } else {
    const byHours = patternFromHours(forecastHours, periods);
    const byPattern = byHours ? null : patternFromChecks(patternChecks, periods);
    const shares = byHours || byPattern;
    const split = splitForecast(forecast, shares, periods);
    if (split) {
      parts = Object.fromEntries(periods.map((p) => [p.key, { name: p.name, amount: split[p.key] }])); partSource = 'forecast';
      partWords = `Day forecast ${moneyWords(forecast, money)}, split across this site's service periods ${byHours ? 'by the hours saved against it' : 'by its own pattern over the last four same weekdays'}.`;
    } else partWords = `Day forecast ${moneyWords(forecast, money)}, but no sales pattern yet to split it across the service periods.`;
  }
  out.projected_parts = fig(parts, partSource, partWords, { total: forecast, periods });

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
 * box takes the system figure. Service period boxes are `part:<key>` in the form; the row keeps
 * them as projected_parts { key: { name, amount } } and fills the three older columns from the
 * parts named lunch, dinner and late. `sources` names where each figure came from (parts under
 * sources.parts); `source` is 'typed' when any box was typed, else 'system'. Notes are kept as typed.
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

  // Service periods: every period the site has, plus any system part (the whole day when it has none).
  const sysParts = system?.projected_parts;
  const periods = sysParts?.periods?.length ? sysParts.periods : Object.entries(sysParts?.value || {}).map(([key, p]) => ({ key, name: p.name }));
  const parts = {}; const partSources = {};
  for (const p of periods) {
    const typed = cleanTyped(form?.[`${PART_PREFIX}${p.key}`]);
    if (typed !== null) { parts[p.key] = { name: p.name, amount: typed }; partSources[p.key] = 'typed'; anyTyped = true; continue; }
    const amount = num(sysParts?.value?.[p.key]?.amount);
    if (amount !== null) { parts[p.key] = { name: p.name, amount }; partSources[p.key] = sysParts.source || 'forecast'; }
  }
  row.projected_parts = parts;
  if (Object.keys(partSources).length) sources.parts = partSources;
  const legacy = legacyParts(parts);
  row.projected_lunch = legacy.lunch; row.projected_dinner = legacy.dinner; row.projected_late = legacy.late;
  const legacySource = Object.values(partSources).includes('typed') ? 'typed' : (Object.values(partSources)[0] || null);
  for (const [col, v] of Object.entries({ projected_lunch: legacy.lunch, projected_dinner: legacy.dinner, projected_late: legacy.late })) if (v !== null && legacySource) sources[col] = legacySource;

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
  for (const [key, src] of Object.entries(map?.parts || {})) {
    const amount = num(row?.projected_parts?.[key]?.amount);
    if (src === 'typed' && amount !== null) out[`${PART_PREFIX}${key}`] = String(amount);
  }
  out.notes = row?.notes || '';
  return out;
}

/** A saved row's parts as a list for the scorecard: [{ key, name, amount }], from projected_parts, else the three older columns. */
export function partsOf(row) {
  const parts = row?.projected_parts;
  if (parts && typeof parts === 'object' && Object.keys(parts).length) {
    return Object.entries(parts).map(([key, p]) => ({ key, name: p?.name || key, amount: num(p?.amount) })).filter((p) => p.amount !== null);
  }
  const legacy = [['lunch', 'Lunch', row?.projected_lunch], ['dinner', 'Dinner', row?.projected_dinner], ['late', 'Late night', row?.projected_late]];
  return legacy.filter(([, , v]) => num(v) !== null).map(([key, name, v]) => ({ key, name, amount: num(v) }));
}
