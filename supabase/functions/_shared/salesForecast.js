/**
 * _shared/salesForecast.js: the ONE sales forecast for staff and stock (multi site stock Drop 3,
 * v5.11.96, contract 2.3). Pure: no imports. Node's test runner loads it (src/lib/stock/
 * salesForecast.test.js), the browser imports it (src/staff/rotaRules.js re exports
 * suggestForecast, so the AI rota is unchanged; the Forecast screen and the Order pad import it
 * here) and an edge function may import it under Deno.
 *
 * suggestForecast moved here word for word from src/staff/rotaRules.js (v5.8.94), with the two
 * date helpers it uses.
 */

const ordinal = (iso) => { const [y, mo, d] = String(iso).split('-').map(Number); return Math.floor(Date.UTC(y, (mo || 1) - 1, d || 1) / 86400000); };
const dayIdx = (iso) => (new Date(iso + 'T00:00:00').getDay() + 6) % 7;            // Mon=0 … Sun=6 (wf_availability)

/**
 * Learned sales forecast: for each target date, the recency weighted average of the same
 * weekday over the history (days with no sales are closed days and are ignored), nudged by
 * the recent trend (last 4 weeks against the 4 before, clamped). Rounded to the nearest 10.
 * Returns { iso: { amount, samples } }; a date with no history is absent.
 */
export function suggestForecast(history = {}, targetIsos = [], { decay = 0.85 } = {}) {
  const days = Object.keys(history).filter(k => Number(history[k]) > 0).sort();
  if (!days.length) return {};
  const last = ordinal(days[days.length - 1]);
  const sumBetween = (from, to) => days.reduce((t, k) => { const o = ordinal(k); return o > from && o <= to ? t + Number(history[k]) : t; }, 0);
  const recent = sumBetween(last - 28, last), before = sumBetween(last - 56, last - 28);
  const trend = before > 0 && recent > 0 ? Math.min(1.15, Math.max(0.85, recent / before)) : 1;
  const out = {};
  for (const iso of targetIsos) {
    const wd = dayIdx(iso);
    const same = days.filter(k => dayIdx(k) === wd && ordinal(k) < ordinal(iso)).reverse();   // newest first
    if (!same.length) continue;
    let num = 0, den = 0;
    same.forEach((k, i) => { const w = Math.pow(decay, i); num += w * Number(history[k]); den += w; });
    out[iso] = { amount: Math.round((num / den) * trend / 10) * 10, samples: same.length };
  }
  return out;
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The history suggestForecast reads, from stock_sales_history rows: { 'YYYY-MM-DD': net }. Rows
 * for the same venue day add up; a row with no day or a net that is not a number is left out.
 */
export function historyFromRows(rows) {
  const out = {};
  for (const r of Array.isArray(rows) ? rows : []) {
    const day = String(r?.business_day ?? '').slice(0, 10);
    const net = Number(r?.net);
    if (!YMD.test(day) || !Number.isFinite(net)) continue;
    out[day] = Math.round(((out[day] || 0) + net) * 100) / 100;
  }
  return out;
}

/**
 * How much busier the forecast day is than usual: the forecast over the 4 week same weekday
 * baseline, kept between 0.25 and 4; 1 when either figure is 0 or missing. The Order pad
 * multiplies usage by it (suggestPacks forecastScale).
 */
export function forecastUseScale({ forecastDay, baselineDay } = {}) {
  const f = Number(forecastDay);
  const b = Number(baselineDay);
  if (!(f > 0) || !(b > 0)) return 1;
  return Math.min(4, Math.max(0.25, f / b));
}

/** The same weekday average of the last 4 weeks before a day, from a history map (0 when none). */
export function baselineFor(history, ymd) {
  if (!YMD.test(String(ymd || ''))) return 0;
  const [y, m, d] = String(ymd).split('-').map(Number);
  let sum = 0, n = 0;
  for (let w = 1; w <= 4; w++) {
    const t = new Date(Date.UTC(y, m - 1, d - 7 * w));
    const k = `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
    const v = Number(history?.[k]);
    if (v > 0) { sum += v; n++; }
  }
  return n ? Math.round((sum / n) * 100) / 100 : 0;
}
