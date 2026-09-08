// src/lib/waitlist/learning.js
//
// Tables Ready — the learning loop. PURE logic (no store / Supabase / React imports)
// so it is fully unit-testable (node --test). The data layer (waitlistData.js) feeds
// normalised closed-check + accuracy rows in; this file owns the dwell-time maths.
//
// The estimator (waitlist.js) seeds each band's `turn` with a cold-start constant.
// Once closed_checks.seated_at flows we can measure the real dwell time (seat -> close)
// per party-band and REPLACE those seeds with learned averages — making every future
// quote venue-specific. quoteAccuracy then grades how close the quotes actually landed.
//
// Contract (shared with Agent C — do NOT change signatures without updating the consumer):
//   turnMinutes(check)                       -> minutes | null   (drop <5 / >360 outliers)
//   computeTurnStats(checks, {bands,minSamples=5}) -> { '1-2': {avgTurn, n}, ... }
//   mergeLearnedBands(bands, stats)          -> bands w/ learned turn + {learned, sample}
//   quoteAccuracy(rows, {toleranceMin=5})    -> { withinPct, mae, n }

import { DEFAULT_BANDS, bandFor } from './waitlist.js';

// Dwell-time sanity window (minutes). A "turn" shorter than this is almost certainly a
// mis-fire / voided check; longer is a table left open / forgotten at close. Either way
// it is noise that would poison the learned average, so we drop it before it counts.
export const MIN_TURN_MIN = 5;
export const MAX_TURN_MIN = 360;

// ── turnMinutes(check) ──────────────────────────────────────────────────────────
// One closed check -> the minutes it occupied a table (seatedAt -> closedAt), or null
// when the timestamps are missing/invalid or the result is an outlier we won't learn from.
// check = { seatedAt(ms), closedAt(ms), covers }.
export function turnMinutes(check) {
  if (!check) return null;
  const seated = Number(check.seatedAt);
  const closed = Number(check.closedAt);
  if (!Number.isFinite(seated) || !Number.isFinite(closed)) return null;
  const mins = (closed - seated) / 60000;
  if (!Number.isFinite(mins)) return null;
  // Outlier filter: keep only [MIN_TURN_MIN, MAX_TURN_MIN] inclusive.
  if (mins < MIN_TURN_MIN || mins > MAX_TURN_MIN) return null;
  return mins;
}

// ── computeTurnStats(checks, opts) ──────────────────────────────────────────────
// Bucket closed checks by party-band (via covers) and average the dwell time per band.
// Outliers are dropped (turnMinutes). A band is ONLY returned once it has >= minSamples
// clean samples — a thin sample would over-fit and is worse than the cold-start seed.
// Returns { '<bandLabel>': { avgTurn:number(rounded), n:int }, ... }.
export function computeTurnStats(checks, { bands = DEFAULT_BANDS, minSamples = 5 } = {}) {
  const buckets = {}; // label -> { sum, n }
  for (const c of checks || []) {
    const mins = turnMinutes(c);
    if (mins == null) continue;
    const band = bandFor(c?.covers, bands);
    if (!band) continue;
    const b = (buckets[band.label] ||= { sum: 0, n: 0 });
    b.sum += mins;
    b.n += 1;
  }
  const out = {};
  for (const [label, { sum, n }] of Object.entries(buckets)) {
    if (n < minSamples) continue; // gate: not enough evidence yet
    out[label] = { avgTurn: Math.round(sum / n), n };
  }
  return out;
}

// ── mergeLearnedBands(bands, stats) ─────────────────────────────────────────────
// Overlay learned per-band averages onto the config bands. Where a learned avgTurn
// exists for a band it REPLACES `turn` (and tags the band {learned:true, sample:n}) so
// the estimator transparently uses the venue's real dwell time; otherwise the band is
// returned unchanged with learned:false. Never mutates the inputs.
export function mergeLearnedBands(bands = DEFAULT_BANDS, stats = null) {
  const src = Array.isArray(bands) && bands.length ? bands : DEFAULT_BANDS;
  if (!stats || typeof stats !== 'object') {
    return src.map((b) => ({ ...b, learned: false }));
  }
  return src.map((b) => {
    const s = stats[b.label];
    if (s && Number.isFinite(Number(s.avgTurn)) && Number(s.avgTurn) > 0) {
      return { ...b, turn: Number(s.avgTurn), learned: true, sample: s.n ?? null };
    }
    return { ...b, learned: false };
  });
}

// ── quoteAccuracy(rows, opts) ───────────────────────────────────────────────────
// Grade quoted vs actual. rows = [{ quoted, actual }].
//   withinPct — % of rows where |quoted-actual| <= toleranceMin (0..100, rounded)
//   mae       — mean absolute error in minutes (rounded to 1 dp)
//   n         — count of rows with both numbers present
// Rows missing either number are skipped. Empty input -> zeros (never NaN).
export function quoteAccuracy(rows, { toleranceMin = 5 } = {}) {
  let n = 0;
  let within = 0;
  let absSum = 0;
  for (const r of rows || []) {
    // Treat null/undefined (the data layer's "missing") as absent — NOT as 0
    // (Number(null) === 0 would silently count an unrecorded value).
    if (r?.quoted == null || r?.actual == null) continue;
    const q = Number(r.quoted);
    const a = Number(r.actual);
    if (!Number.isFinite(q) || !Number.isFinite(a)) continue;
    n += 1;
    const err = Math.abs(q - a);
    absSum += err;
    if (err <= toleranceMin) within += 1;
  }
  if (!n) return { withinPct: 0, mae: 0, n: 0 };
  return {
    withinPct: Math.round((within / n) * 100),
    mae: Math.round((absSum / n) * 10) / 10,
    n,
  };
}

export default { turnMinutes, computeTurnStats, mergeLearnedBands, quoteAccuracy, MIN_TURN_MIN, MAX_TURN_MIN };
