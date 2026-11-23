// src/lib/hq/safeLedger.js
//
// The site's safe as a ledger (hq_safe_movements), fed by till events nobody retypes:
//   drawer_in   a closed till drawer's counted cash (drawer_sessions.declared_cash)
//   drop_in     a "Cash drop to safe" made on the till during service (cash_movements cash_drop)
//   float_out   the float a drawer opened with (drawer_sessions.opening_float), taken from the safe
//   petty_out   petty cash paid from the safe
//   bank_out    a bag made up for the bank (hq_bank_deposits)
//   adjustment  a count variance accepted, or a mistake reversed
// Money in is positive, money out negative, and the balance is the plain sum. A till event is
// posted once (unique ref), so "waiting" below is simply the events the ledger has not seen.
// Pure: no React, no Supabase, so node --test drives it (safeLedger.test.js).

export const SAFE_KINDS = Object.freeze({
  drawer_in: { label: 'Drawer cash up', dir: 1 },
  drop_in: { label: 'Drop from till', dir: 1 },
  other_in: { label: 'Other cash in', dir: 1 },
  float_out: { label: 'Float to drawer', dir: -1 },
  petty_out: { label: 'Petty cash', dir: -1 },
  bank_out: { label: 'To the bank', dir: -1 },
  adjustment: { label: 'Adjustment', dir: 0 },
});
export const kindLabel = (k) => SAFE_KINDS[k]?.label || k;

export const DEPOSIT_STATUSES = Object.freeze([
  ['prepared', 'Prepared'], ['banked', 'Banked'], ['confirmed', 'Confirmed'], ['cancelled', 'Cancelled'],
]);
export const depositStatusLabel = (s) => (DEPOSIT_STATUSES.find(([k]) => k === s) || [s, s])[1];
/** The next step a deposit can take, or null when it is finished. */
export function depositNextStatus(status) {
  if (status === 'prepared') return 'banked';
  if (status === 'banked') return 'confirmed';
  return null;
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const num = (v) => (v === null || v === undefined || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));

/** The balance: the signed sum of every movement, to the penny. */
export function safeBalance(movements = []) {
  return round2((movements || []).reduce((s, m) => s + (Number(m?.amount) || 0), 0));
}

/** The balance at the end of a business date (movements dated on or before it). */
export function balanceAt(movements = [], businessDate) {
  return safeBalance((movements || []).filter((m) => !businessDate || (m?.business_date || '') <= businessDate));
}

const refKey = (kind, id) => `${kind}:${id}`;
/** Every till event the ledger already holds, as "ref_kind:ref_id". */
export function postedRefs(movements = []) {
  const s = new Set();
  for (const m of movements || []) if (m?.ref_kind && m?.ref_id) s.add(refKey(m.ref_kind, m.ref_id));
  return s;
}

/**
 * waitingItems({ sessions, tillDrops, movements })
 *   sessions   drawer_sessions rows for the site (any status)
 *   tillDrops  cash_movements rows of type cash_drop or drop (amount stored positive on the till)
 *   movements  hq_safe_movements rows for the site
 * Returns the till events not yet in the safe, oldest first, each shaped to post:
 *   { kind, amount (signed), ref_kind, ref_id, drawer_id, at, label, detail }
 * A drawer that cashed up gives a drawer_in for its declared cash; a drawer that opened with a float
 * gives a float_out; a till drop gives a drop_in. A drop made during a session does not double
 * count: the till's declared cash at cash up is what was left in the drawer after the drop.
 */
export function waitingItems({ sessions = [], tillDrops = [], movements = [] } = {}) {
  const posted = postedRefs(movements);
  const out = [];
  for (const s of sessions || []) {
    if (!s?.id) continue;
    const float = num(s.opening_float);
    if (float !== null && float > 0 && s.cash_in_at && !posted.has(refKey('drawer_float', s.id))) {
      out.push({ kind: 'float_out', amount: -round2(float), ref_kind: 'drawer_float', ref_id: String(s.id), drawer_id: s.drawer_id || null,
        at: s.cash_in_at, label: 'Float to drawer', detail: s.drawer_name ? `Opened ${s.drawer_name}` : 'Opening float' });
    }
    const declared = num(s.declared_cash);
    if (s.status === 'closed' && declared !== null && declared > 0 && !posted.has(refKey('drawer_session', s.id))) {
      const variance = num(s.variance);
      out.push({ kind: 'drawer_in', amount: round2(declared), ref_kind: 'drawer_session', ref_id: String(s.id), drawer_id: s.drawer_id || null,
        at: s.cash_out_at || s.cash_in_at, label: 'Drawer cash up',
        detail: variance === null ? 'Counted at cash up' : (variance === 0 ? 'Counted, no variance' : `Counted, drawer ${variance > 0 ? 'over' : 'short'} ${Math.abs(variance).toFixed(2)}`) });
    }
  }
  for (const d of tillDrops || []) {
    if (!d?.id) continue;
    if (d.type && d.type !== 'cash_drop' && d.type !== 'drop') continue;
    const amt = Math.abs(num(d.amount) || 0);
    if (amt <= 0 || posted.has(refKey('cash_movement', d.id))) continue;
    out.push({ kind: 'drop_in', amount: round2(amt), ref_kind: 'cash_movement', ref_id: String(d.id), drawer_id: d.drawer_id || null,
      at: d.timestamp || d.created_at, label: 'Drop from till', detail: d.staff_name ? `By ${d.staff_name}` : (d.reason || 'Cash drop') });
  }
  return out.sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));
}

/** The sum of a set of waiting items, signed. */
export const waitingTotal = (items = []) => round2((items || []).reduce((s, i) => s + (Number(i?.amount) || 0), 0));

/** Rows ready for hq_safe_movements from waiting items. businessDateOf(item) names each one's business day. */
export function movementsFromItems(items, { orgId, locationId, businessDateOf, byName = null }) {
  return (items || []).map((i) => ({
    org_id: orgId, location_id: locationId, business_date: businessDateOf(i), kind: i.kind, amount: i.amount,
    ref_kind: i.ref_kind, ref_id: i.ref_id, drawer_id: i.drawer_id || null, note: i.detail || null, created_by_name: byName,
  }));
}

/**
 * countOutcome(counted, expected): the variance and, when there is one, the adjustment movement
 * that makes the ledger match what is in the safe. Nothing moves until the person accepts it.
 */
export function countOutcome(counted, expected) {
  const c = num(counted); const e = num(expected);
  if (c === null || e === null) return { variance: null, adjustment: null, words: 'Type the counted total.' };
  const variance = round2(c - e);
  if (variance === 0) return { variance, adjustment: null, words: 'Matches the ledger.' };
  return {
    variance,
    adjustment: { kind: 'adjustment', amount: variance, note: `Safe count ${variance > 0 ? 'over' : 'short'} ${Math.abs(variance).toFixed(2)}` },
    words: `${variance > 0 ? 'Over' : 'Short'} by ${Math.abs(variance).toFixed(2)}.`,
  };
}

/** A total from a denominations map { "20": 3, "0.05": 10 }: 60.50. */
export function denominationsTotal(denoms = {}) {
  return round2(Object.entries(denoms || {}).reduce((s, [note, qty]) => s + (Number(note) || 0) * (Number(qty) || 0), 0));
}

/** The suggested bag: the balance less what the site keeps back for floats, never under zero. */
export function suggestedDeposit(balance, keepBack = 0) {
  return Math.max(0, round2((num(balance) || 0) - (num(keepBack) || 0)));
}

/** Cash out of the safe but not yet confirmed by the bank. */
export function inTransit(deposits = []) {
  return round2((deposits || []).filter((d) => d?.status === 'prepared' || d?.status === 'banked').reduce((s, d) => s + (Number(d.amount) || 0), 0));
}

const dayDiff = (a, b) => Math.round((Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10)) - Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10))) / 86400000);

/**
 * Days since the site last banked (its newest deposit that was not cancelled). With no deposit,
 * days since the first cash went into the safe. Null when the safe has never been used.
 */
export function unbankedDays({ deposits = [], movements = [], today }) {
  if (!today) return null;
  const banked = (deposits || []).filter((d) => d?.status && d.status !== 'cancelled' && d.business_date).map((d) => d.business_date).sort();
  if (banked.length) return Math.max(0, dayDiff(banked[banked.length - 1], today));
  const ins = (movements || []).filter((m) => (Number(m?.amount) || 0) > 0 && m.business_date).map((m) => m.business_date).sort();
  if (ins.length) return Math.max(0, dayDiff(ins[0], today));
  return null;
}

/** The newest count, or null. */
export function lastCount(counts = []) {
  const rows = (counts || []).filter((c) => c?.created_at || c?.business_date);
  if (!rows.length) return null;
  return rows.slice().sort((a, b) => String(b.created_at || b.business_date).localeCompare(String(a.created_at || a.business_date)))[0];
}

/**
 * cashSummary({ movements, counts, deposits, today }): the figures the scorecard and the Finance
 * tiles show for one site. used = false when the safe has no movements, so the scorecard can fall
 * back to a typed cash figure.
 */
export function cashSummary({ movements = [], counts = [], deposits = [], today } = {}) {
  const used = (movements || []).length > 0;
  const lc = lastCount(counts);
  return {
    used,
    balance: used ? safeBalance(movements) : null,
    inTransit: inTransit(deposits),
    unbankedDays: used ? unbankedDays({ deposits, movements, today }) : null,
    lastVariance: lc ? num(lc.variance) : null,
    lastCountDate: lc ? (lc.business_date || null) : null,
    lastDeposit: (deposits || []).filter((d) => d?.status !== 'cancelled').sort((a, b) => String(b.business_date).localeCompare(String(a.business_date)))[0] || null,
  };
}
