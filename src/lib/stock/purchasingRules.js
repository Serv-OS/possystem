/**
 * stock/purchasingRules.js — the PURE rules behind the Order pad and the Orders screen.
 * No I/O, no supabase import: Node's test runner loads this file directly.
 *
 * v5.11.64 (15 Oct 2026, demo venue hunt). Four small faults were living inside OrderPad.jsx
 * where nothing could test them: a pack's content ignored pack_qty (a case of 6 x 2 l counted
 * as 2 l, so the pad ordered six times too many cases), delivery days written as numbers never
 * matched the day names the pad compares, no order ever got an expected date, and the raw SDK
 * text "Edge Function returned a non-2xx status code" reached the toast. Each rule now lives
 * here with a test next to it.
 */

const DOW = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
export const DAY_LABEL = { sun: 'Sun', mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat' };

/**
 * One delivery day as the app spells it: 'mon'..'sun'. Accepts the day names the Suppliers
 * editor writes ('tue', 'Thursday'), ISO numbers (1 = Mon .. 7 = Sun) and JS numbers (0 = Sun).
 * Anything else → null.
 */
export function normDay(d) {
  if (d == null || d === '') return null;
  const s = String(d).trim().toLowerCase();
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    if (n === 0 || n === 7) return 'sun';
    return n >= 1 && n <= 6 ? DOW[n] : null;
  }
  const k = s.slice(0, 3);
  return DOW.includes(k) ? k : null;
}

/** A supplier's delivery_days as clean day names, in the order given, duplicates dropped. */
export function normDeliveryDays(deliveryDays) {
  if (!Array.isArray(deliveryDays)) return [];
  const out = [];
  for (const d of deliveryDays) { const k = normDay(d); if (k && !out.includes(k)) out.push(k); }
  return out;
}

/**
 * Days to cover from a supplier's weekly delivery schedule: reach the SECOND upcoming
 * delivery, so what arrives at the next delivery lasts until the one after it.
 * todayIdx is the venue's JS day of week (0 = Sun). Null when the supplier has no schedule.
 */
export function coverDaysFromSchedule(deliveryDays, todayIdx) {
  const days = normDeliveryDays(deliveryDays);
  if (!days.length) return null;
  const set = new Set(days);
  const hits = [];
  for (let off = 1; off <= 14 && hits.length < 2; off++) {
    if (set.has(DOW[(todayIdx + off) % 7])) hits.push(off);
  }
  return hits.length >= 2 ? hits[1] : (hits[0] || null);
}

const addDays = (ymd, n) => {
  const [y, m, d] = String(ymd).split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
};
const dowOfYmd = (ymd) => { const [y, m, d] = String(ymd).split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };

/**
 * The date an order placed today should arrive: the supplier's first delivery day from
 * tomorrow onwards (up to a week out). A supplier with no schedule delivers tomorrow.
 */
export function nextDeliveryYmd(deliveryDays, todayYmd) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(todayYmd || ''))) return null;
  const set = new Set(normDeliveryDays(deliveryDays));
  if (!set.size) return addDays(todayYmd, 1);
  for (let off = 1; off <= 7; off++) {
    const ymd = addDays(todayYmd, off);
    if (set.has(DOW[dowOfYmd(ymd)])) return ymd;
  }
  return addDays(todayYmd, 1);
}

/**
 * What one supplier pack puts on the shelf, in the pack's inner unit: pack_qty x inner_qty.
 * This is the SAME convention costing (packBaseUnitCost) and receiving use. A case of
 * 6 x 2 l is 12 l, never 2 l.
 */
export function packContent(sp) {
  if (!sp) return null;
  const packQty = Number(sp.packQty) || 1;
  const inner = Number(sp.innerQty);
  if (!(inner > 0)) return null;
  return packQty * inner;
}

/**
 * The Order pad suggestion for one item.
 *   expectedBase = usage over (coverDays + safetyDays) real calendar days, starting tomorrow,
 *                  from the weekday profile when it exists, else the flat daily average
 *   needBase     = expectedBase − onHand − onOrder (floored at 0); with no sales history at all,
 *                  top up to par instead
 *   suggestedPacks = needBase ÷ perPack, rounded UP to whole packs
 * Returns { expectedBase, needBase, suggestedPacks, covered } where covered is true when the
 * need is already met by stock on hand plus stock on order.
 */
export function suggestPacks({ onHand = 0, onOrder = 0, avgDaily = 0, profile = null, todayDow = 0, coverDays = 7, safetyDays = 0, par = null, perPack = null }) {
  const effCover = (Number(coverDays) || 0) + (Number(safetyDays) || 0);
  const hasShape = Array.isArray(profile) && profile.some(v => v > 0);
  let expectedBase = 0;
  if (hasShape) {
    for (let d = 1; d <= effCover; d++) expectedBase += Number(profile[(todayDow + d) % 7]) || 0;
  } else {
    expectedBase = (Number(avgDaily) || 0) * effCover;
  }
  const oh = Number(onHand) || 0, oo = Number(onOrder) || 0;
  const history = (Number(avgDaily) || 0) > 0 || hasShape;
  let needBase = history ? (expectedBase - oh - oo) : (par != null ? (Number(par) - oh - oo) : 0);
  const covered = history || par != null ? needBase <= 0 : false;
  if (!(needBase > 0)) needBase = 0;
  const suggestedPacks = (perPack > 0) ? Math.ceil(needBase / perPack) : 0;
  return { expectedBase, needBase, suggestedPacks, covered, effCover, hasShape };
}

/**
 * Turn whatever an edge function call left behind into one plain sentence for a toast.
 * The Supabase client reports every non-2xx answer as the fixed text "Edge Function returned
 * a non-2xx status code"; the real reason sits in the response body, which the caller passes
 * here. po-send wraps the mail provider's answer as 'email failed: {"error":"send failed: ..."}'
 * and this peels those layers off, so the venue reads "Invalid to field ..." not a JSON blob.
 */
export function cleanFnError(raw, fallback = 'send failed') {
  let s = raw == null ? '' : (typeof raw === 'string' ? raw : (raw.error || raw.message || ''));
  s = String(s).trim();
  if (!s) return fallback;
  for (let i = 0; i < 4; i++) {
    s = s.replace(/^(email failed|send failed|error)\s*:\s*/i, '').trim();
    if (s.startsWith('{')) {
      try { const j = JSON.parse(s); s = String(j.error || j.message || j.detail || s).trim(); continue; } catch { break; }
    }
    if (!/^(email failed|send failed|error)\s*:/i.test(s)) break;
  }
  s = s.replace(/`/g, '');
  if (/non-2xx status code/i.test(s)) return fallback;
  return s || fallback;
}

/** Plain English for the Order pad toast after the orders were created. */
export function createOrdersToast({ created = 0, emailed = 0, failed = [], fallback = 'send failed' }) {
  const n = created;
  const orders = `${n} order${n === 1 ? '' : 's'} created`;
  if (!failed.length) {
    return `${orders} and emailed to ${emailed === 1 ? 'the supplier' : 'the suppliers'}. See Orders for delivery.`;
  }
  const who = failed.map(f => f.supplier).filter(Boolean);
  const reason = cleanFnError(failed[failed.length - 1]?.reason, fallback).replace(/\.\s*$/, '');
  const names = who.length ? who.join(' and ') : `${failed.length} supplier${failed.length === 1 ? '' : 's'}`;
  return `${orders}. Email to ${names} did not send: ${reason}. The order is saved; open it in Orders and press Resend to supplier.`;
}
