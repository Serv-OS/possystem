// src/lib/waitlist/waitlist.js
//
// Tables Ready — pure logic for the walk-in waitlist / live table-queue.
// NO store / Supabase / React imports here so it is fully unit-testable (node --test).
// The store adapter feeds normalised inputs in; this file owns the estimation maths,
// the status lifecycle, and the camelCase<->snake_case row mappers.

// ── Config defaults (cold-start; overridden by the Config table per venue) ─────
// Per-band seed turn time (minutes). Learned values replace `turn` over time once
// closed_checks.seated_at seeds turn_time_stats.
export const DEFAULT_BANDS = [
  { label: '1-2', min: 1, max: 2, turn: 45 },
  { label: '3-4', min: 3, max: 4, turn: 60 },
  { label: '5-6', min: 5, max: 6, turn: 75 },
  { label: '7+',  min: 7, max: 999, turn: 90 },
];
export const DEFAULT_QUOTE_RULES = { buffer: 5, roundTo: 5, maxQuote: 120, defaultTurn: 60 };

// ── Status lifecycle ──────────────────────────────────────────────────────────
export const STATUS = {
  WAITING: 'waiting', NOTIFIED: 'notified', READY: 'ready', SEATED: 'seated',
  COMPLETED: 'completed', NO_SHOW: 'no_show', WALKED_AWAY: 'walked_away',
  CANCELLED: 'cancelled', REMOVED: 'removed',
};
// Parties still "in the queue" — counted by the estimator and shown on the board.
export const ACTIVE_STATUSES = [STATUS.WAITING, STATUS.NOTIFIED, STATUS.READY];
export const isActive = (s) => ACTIVE_STATUSES.includes(s);

// Allowed transitions (the lifecycle the spec defines). A re-add path lets a
// no-show/walked-away/cancelled party rejoin the queue.
export const TRANSITIONS = {
  waiting:     ['notified', 'ready', 'seated', 'no_show', 'walked_away', 'cancelled', 'removed'],
  notified:    ['ready', 'seated', 'waiting', 'no_show', 'walked_away', 'cancelled', 'removed'],
  ready:       ['seated', 'notified', 'no_show', 'walked_away', 'cancelled', 'removed'],
  seated:      ['completed', 'removed'],
  completed:   [],
  no_show:     ['waiting'],
  walked_away: ['waiting'],
  cancelled:   ['waiting'],
  removed:     [],
};
export const canTransition = (from, to) => from === to || !!(TRANSITIONS[from] && TRANSITIONS[from].includes(to));

// ── small maths helpers ───────────────────────────────────────────────────────
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const roundUpTo = (v, step) => (step > 0 ? Math.ceil(v / step) * step : Math.round(v));

export function bandFor(size, bands = DEFAULT_BANDS) {
  const n = Math.max(1, Math.round(Number(size) || 1));
  return bands.find((b) => n >= b.min && n <= b.max) || bands[bands.length - 1];
}

// ── estimate(size) — the spec algorithm, mapped onto real floor data ──────────
// tables:  [{ cap, status, section? }]  status one of 'open' | 'seated' | 'clearing'
//          (the store adapter maps a ServOS 'available' table -> status 'open').
// waiting: [{ size, status }]           parties already in the queue.
// Returns minutes — never negative, never NaN, never above maxQuote.
export function estimate({ size, sectionPref = null, tables = [], waiting = [], bands = DEFAULT_BANDS, rules = DEFAULT_QUOTE_RULES }) {
  const n = Math.max(1, Math.round(Number(size) || 1));
  const band = bandFor(n, bands);
  const turn = Number(band.turn) || Number(rules.defaultTurn) || 60;
  const buffer = Math.max(0, Number(rules.buffer) || 0);
  const roundTo = Number(rules.roundTo) || 1;
  const maxQuote = Number(rules.maxQuote) || 120;

  // Suitable tables: capacity in [size, size+2] (don't waste a big table on a small
  // party); fall back to any table that simply fits if none sit in that window.
  const sectionOk = (t) => !sectionPref || t.section === sectionPref;
  const inWindow = (t) => t.cap >= n && t.cap <= n + 2 && sectionOk(t);
  const capOk = (t) => t.cap >= n && sectionOk(t);
  let suit = tables.filter(inWindow);
  if (!suit.length) suit = tables.filter(capOk);

  const total = suit.length;                                   // suitable tables (any status)
  const open = suit.filter((t) => t.status === 'open').length; // suitable tables free now
  const ahead = waiting.filter((w) => isActive(w.status) && bandFor(w.size, bands).label === band.label).length;

  // No table in the building fits this party at all → honest "very long, see host".
  if (total <= 0) return clamp(maxQuote, roundTo, maxQuote);

  let mins;
  if (ahead < open) {
    mins = buffer;                                             // a suitable table is essentially free
  } else {
    const waves = Math.ceil((ahead - open + 1) / total);
    mins = waves * turn * 0.6 + (open <= 0 ? turn * 0.4 : 0) + buffer;
  }
  return clamp(roundUpTo(mins, roundTo), roundTo, maxQuote);
}

// Average current quote across active parties (for the header "avg wait now").
export function currentAverageWait(waiting = []) {
  const active = waiting.filter((w) => isActive(w.status) && Number.isFinite(w.quoted));
  if (!active.length) return 0;
  return Math.round(active.reduce((s, w) => s + w.quoted, 0) / active.length);
}

// Per-band strip for the board: representative quote + how many suitable tables are open.
export function perBandStrip({ tables = [], waiting = [], bands = DEFAULT_BANDS, rules = DEFAULT_QUOTE_RULES }) {
  return bands.map((b) => {
    const repSize = b.min;                                     // quote the smallest size in the band
    const suit = tables.filter((t) => t.cap >= repSize && t.cap <= repSize + 2);
    const openTables = suit.filter((t) => t.status === 'open').length;
    return { label: b.label, quote: estimate({ size: repSize, tables, waiting, bands, rules }), openTables };
  });
}

// ── row mappers (camelCase store <-> snake_case DB) ────────────────────────────
export function rowToWaitlist(r) {
  if (!r) return null;
  return {
    id: r.id,
    locationId: r.location_id,
    customerId: r.customer_id || null,
    customer: r.customer || null,
    name: r.party_name,
    phone: r.phone || null,
    size: r.party_size,
    quoted: r.quoted_wait_min ?? null,
    firstQuote: r.first_quote_min ?? r.quoted_wait_min ?? null,
    status: r.status || STATUS.WAITING,
    sectionPref: r.section_pref || null,
    notes: r.notes || '',
    seatedTableId: r.seated_table_id || null,
    source: r.source || 'host',
    returning: !!r.customer_id,
    addedAt: r.added_at ? new Date(r.added_at).getTime() : null,
    quotedAt: r.quoted_at ? new Date(r.quoted_at).getTime() : null,
    notifiedAt: r.notified_at ? new Date(r.notified_at).getTime() : null,
    readyAt: r.ready_at ? new Date(r.ready_at).getTime() : null,
    seatedAt: r.seated_at ? new Date(r.seated_at).getTime() : null,
  };
}

const iso = (ms) => (ms ? new Date(ms).toISOString() : null);

export function waitlistToRow(e, locationId, orgId) {
  return {
    id: e.id,
    location_id: locationId,
    org_id: orgId || null,
    customer_id: e.customerId || null,
    customer: e.customer || null,
    party_name: e.name || 'Guest',
    phone: e.phone || null,
    party_size: e.size || 1,
    quoted_wait_min: e.quoted ?? null,
    first_quote_min: e.firstQuote ?? e.quoted ?? null,
    status: e.status || STATUS.WAITING,
    section_pref: e.sectionPref || null,
    notes: e.notes || null,
    seated_table_id: e.seatedTableId || null,
    source: e.source || 'host',
    added_at: iso(e.addedAt),
    quoted_at: iso(e.quotedAt),
    notified_at: iso(e.notifiedAt),
    ready_at: iso(e.readyAt),
    seated_at: iso(e.seatedAt),
  };
}

// Actual wait achieved (minutes) once seated — drives quote_accuracy + learning.
export function actualWaitMin(entry) {
  if (!entry?.addedAt || !entry?.seatedAt) return null;
  return Math.max(0, Math.round((entry.seatedAt - entry.addedAt) / 60000));
}
