// src/lib/ownerDetail.js: the Owner app's venue screen, the part that is not drawing.
//
// 5 Oct 2026: a venue card did nothing when tapped. Tap one now and the venue's seven reports
// open; tap the group card for the same seven across all sites. The numbers are the function's
// (owner-snapshot's detail call, supabase/functions/_shared/ownerSnapshot.js buildOwnerDetail).
// This file is what the screen needs around them:
//   * what to ask for, and whether the answer is really for the venue and period on screen
//     (readDetail). An answer for anything else is never drawn.
//   * AN OLD FUNCTION. The app ships before the function is deployed. A function from before
//     the detail call ignores `detail` and answers the plain snapshot, so an answer with no
//     `detail` in it means "More reports need a ServOS update". Never a blank, never the
//     snapshot's numbers under a report's label.
//   * bar lengths, shares and plain words for the kinds, types and channels.
//
// PURE: node:test loads it.

import { ownerPeriod } from '../../supabase/functions/_shared/ownerPeriod.js';
import { hasFeature, thenWords } from './ownerCompare.js';

export const DETAIL_NEEDS_UPDATE = 'More reports need a ServOS update';

/** The group, in one currency. Currencies are never added together. */
export const groupTarget = (currency, venues) => ({ kind: 'group', id: 'group', currency: currency || null, name: 'All venues', venues: Number(venues) || 0 });
export const venueTarget = (l) => ({ kind: 'venue', id: l.ops_location_id, currency: l.currency || null, name: l.name || 'Venue', venues: 1 });

/** What the function is sent. */
export function detailRequest(target, period) {
  const body = { period: ownerPeriod(period), detail: target.kind === 'group' ? 'group' : target.id };
  if (target.kind === 'group' && target.currency) body.currency = target.currency;
  return body;
}

/** One word for "this venue (or group), this period": an answer is kept under the key it was asked with. */
export function detailKey(target, period) {
  return `${target?.kind}|${target?.id}|${target?.currency || ''}|${ownerPeriod(period)}`;
}

/** True when the snapshot's own function says it has the detail call. */
export const canDetail = (snapshot) => hasFeature(snapshot, 'detail');
/** True when the function sends the Sales mix (8 Oct 2026): the bars on the cards and the Sales mix card draw only then. */
export const canMix = (snapshot) => hasFeature(snapshot, 'mix');

/**
 * What an answer to a detail request holds.
 *   needs_update  no `detail` in it: the function is from before the detail call
 *   mismatch      a detail for another period, venue or currency than was asked for
 *   ok            the seven reports for exactly what is on screen
 * @returns {{ state: 'ok'|'needs_update'|'mismatch', detail: any }}
 */
export function readDetail(answer, target, period) {
  const d = answer?.detail;
  if (!d || typeof d !== 'object' || !d.scope) return { state: 'needs_update', detail: null };
  const s = d.scope;
  const right = answer.period === ownerPeriod(period)
    && s.kind === target.kind
    && (target.kind === 'group'
      ? (!target.currency || s.currency === target.currency)
      : (s.locations?.length === 1 && s.locations[0]?.ops_location_id === target.id));
  return right ? { state: 'ok', detail: d } : { state: 'mismatch', detail: null };
}

/** The dates and the cut the comparison line reads: the scope's shared ones, or the one venue's. */
export function detailRange(detail) {
  if (detail?.range) return detail.range;
  const list = detail?.scope?.locations || [];
  return list.length === 1 ? list[0]?.range ?? null : null;
}

/** '6am', '12pm', '12am'. */
export function hourLabel(h) {
  const n = ((Number(h) % 24) + 24) % 24;
  return `${n % 12 === 0 ? 12 : n % 12}${n < 12 ? 'am' : 'pm'}`;
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const frac = (v, max) => (max > 0 ? Math.max(0, Math.min(1, num(v) / max)) : 0);

/**
 * Sales by hour: each hour's bar and the comparison's point on ONE scale, and the busiest hour.
 * @returns {{ rows: { hour, label, net, orders, cmp, h, ch }[], max: number, peak: object|null, hasCmp: boolean }}
 */
export function hourChart(hours) {
  const list = Array.isArray(hours) ? hours : [];
  const max = list.reduce((m, r) => Math.max(m, num(r?.net), num(r?.cmp_net)), 0);
  const rows = list.map((r) => ({
    hour: r.hour, label: hourLabel(r.hour), net: num(r.net), orders: num(r.orders), cmp: num(r.cmp_net),
    h: frac(r.net, max), ch: frac(r.cmp_net, max),
  }));
  const peak = rows.reduce((best, r) => (r.net > 0 && (!best || r.net > best.net) ? r : best), null);
  return { rows, max, peak, hasCmp: rows.some((r) => r.cmp > 0) };
}

/**
 * What the faint line in Sales by hour is. It is the comparison's WHOLE days (not cut at now),
 * so the rest of the day can be seen coming.
 */
export function hoursLineWords(period, range) {
  const p = ownerPeriod(period);
  return p === 'today' ? `${thenWords(p, range, { withTime: false })}, whole day` : thenWords(p, range);
}

/**
 * Week by day: this week against last week on one scale. A day that has not come yet has
 * `net: null` from the function and stays null here: it is drawn as a dash, not as £0.
 */
export function weekChart(week) {
  const list = Array.isArray(week) ? week : [];
  const max = list.reduce((m, r) => Math.max(m, num(r?.net), num(r?.last_net)), 0);
  return {
    max,
    rows: list.map((r) => ({
      dow: r.dow, date: r.date ?? null, net: r.net == null ? null : num(r.net), last: num(r.last_net),
      w: r.net == null ? 0 : frac(r.net, max), lw: frac(r.last_net, max),
    })),
  };
}

/**
 * Rows with each one's share of the total, as a whole percent, and a bar length against the
 * biggest. Rows worth nothing are dropped.
 */
export function shareRows(list, valueKey) {
  const rows = (Array.isArray(list) ? list : []).filter((r) => num(r?.[valueKey]) > 0);
  const total = rows.reduce((s, r) => s + num(r[valueKey]), 0);
  const max = rows.reduce((m, r) => Math.max(m, num(r[valueKey])), 0);
  return rows.map((r) => ({ ...r, value: num(r[valueKey]), share: total > 0 ? Math.round(num(r[valueKey]) / total * 100) : 0, w: frac(r[valueKey], max) }));
}

const words = (key) => {
  const s = String(key ?? '').replace(/[-_]+/g, ' ').trim();
  return s ? s[0].toUpperCase() + s.slice(1) : 'Other';
};

const PAYMENT_LABELS = { card: 'Card', cash: 'Cash', gift_card: 'Gift card', deposit: 'Deposit', unallocated: 'Split, kind not recorded', other: 'Other', loyalty: 'Loyalty', promo: 'Promo credit' };
const TYPE_LABELS = { 'dine-in': 'Eat in', takeaway: 'Takeaway', 'drive-thru': 'Drive thru', collection: 'Collection', delivery: 'Delivery', 'bar-tab': 'Bar tab', catering: 'Catering' };
const CHANNEL_LABELS = { pos: 'Till', kiosk: 'Kiosk', qr: 'QR', online: 'Online', catering: 'Catering', mobile: 'App', delivery: 'Delivery apps' };

export const paymentLabel = (kind) => PAYMENT_LABELS[kind] || words(kind);
export const orderTypeLabel = (type) => TYPE_LABELS[type] || words(type);
export const channelLabel = (channel) => CHANNEL_LABELS[channel] || words(channel);

/**
 * Payment mix in two lists: money taken (adds up to gross sales) and credits. Loyalty and
 * promo credit are discounts, never takings, so they are never in the money list or its shares.
 */
export function paymentMix(payments) {
  const list = Array.isArray(payments) ? payments : [];
  const named = (r) => ({ ...r, label: paymentLabel(r.kind) });
  return {
    money: shareRows(list.filter((p) => p?.money !== false), 'amount').map(named),
    credits: list.filter((p) => p?.money === false && num(p.amount) > 0).map(named),
  };
}

/**
 * Labour against sales. `over` only when the venue has a target and is above it; a group has
 * no single target, so it is never marked over.
 */
export function labourView(labour) {
  if (!labour) return null;
  const pct = labour.pct == null ? null : num(labour.pct);
  const target = labour.target_pct == null ? null : num(labour.target_pct);
  const top = Math.max(pct ?? 0, target ?? 0);
  return {
    cost: num(labour.cost), hours: num(labour.hours), shifts: num(labour.shifts), pct, target,
    over: pct != null && target != null && pct > target,
    w: frac(pct ?? 0, top), tw: target == null ? null : frac(target, top),
  };
}

/** True when the period has nothing in it at all: one line instead of seven empty cards. */
export function nothingSold(detail) {
  const ex = detail?.exceptions || {};
  return !(num(detail?.totals?.orders) > 0)
    && !(detail?.hours || []).some((h) => num(h.cmp_net) > 0)
    && !(detail?.week || []).some((w) => num(w.net) > 0 || num(w.last_net) > 0)
    && !['discounts', 'voids', 'refunds'].some((k) => num(ex[k]?.count) > 0)
    && !detail?.labour;
}
