/**
 * courierTimes.js — ONE pure source of truth for the courier time flow (expected vs actual
 * pickup/delivery + lateness), so the POS card, the Deliveries board and the customer tracker
 * tell the same story. Accepts a courier_deliveries row (snake_case) OR the track_order response
 * (camelCase). Pure + unit-tested.
 *
 * Truth rules:
 *  - an EXPECTED time is never styled as a fact (kind:'expected', render muted/~); an ACTUAL time
 *    is kind:'actual' (render solid/✓); no time yet = kind:'pending' (render a STATE, not a clock).
 *  - lateness is only meaningful once a dropoff ETA exists, is clamped >= 0 (an early courier is
 *    on time, never negative-late), and only flags red past a small grace.
 */

const LATE_GRACE_MIN = 5;
const TERMINAL_BAD = new Set(['canceled', 'returned', 'failed']);

const pick = (d, snake, camel) => (d == null ? null : (d[snake] != null ? d[snake] : (d[camel] != null ? d[camel] : null)));

export function fmtTime(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

/** Lifecycle phase derived from the COLUMNS (not just status): so the UI never shows a fake clock. */
export function courierPhase(d) {
  if (!d) return 'none';
  const st = d.status;
  if (TERMINAL_BAD.has(st)) return 'terminal_bad';
  if (pick(d, 'delivered_at', 'deliveredAt') || st === 'delivered') return 'done';
  if (st === 'scheduled') return 'scheduled';   // booked for a future pickup — not "finding now"
  if (pick(d, 'picked_at', 'pickedAt')) return 'collected';
  if (pick(d, 'eta', 'eta') || pick(d, 'pickup_eta', 'pickupEta') || st === 'pickup' || st === 'dropoff') return 'assigned';
  return 'awaiting_courier';
}

/** Two legs for the expected→actual ladder. kind ∈ pending | expected | actual. */
export function courierLegs(d) {
  const leg = (actual, expected) =>
    actual ? { time: fmtTime(actual), iso: actual, kind: 'actual' }
    : (expected ? { time: fmtTime(expected), iso: expected, kind: 'expected' } : { time: null, iso: null, kind: 'pending' });
  return {
    pickup: { label: 'Pickup', ...leg(pick(d, 'picked_at', 'pickedAt'), pick(d, 'pickup_eta', 'pickupEta')) },
    dropoff: { label: 'Delivery', ...leg(pick(d, 'delivered_at', 'deliveredAt'), pick(d, 'eta', 'eta')) },
  };
}

/** Lateness vs the dropoff ETA. known=false when no ETA yet. Clamped >= 0; onTime within grace. */
export function courierLateness(d, nowMs) {
  const now = nowMs == null ? Date.now() : nowMs;
  const dropEta = pick(d, 'eta', 'eta');
  if (!dropEta) return { lateMins: 0, onTime: true, known: false, delivered: false };
  const etaMs = new Date(dropEta).getTime();
  if (isNaN(etaMs)) return { lateMins: 0, onTime: true, known: false, delivered: false };
  const deliveredAt = pick(d, 'delivered_at', 'deliveredAt');
  const refMs = deliveredAt ? new Date(deliveredAt).getTime() : now;
  const lateMins = Math.max(0, Math.round((refMs - etaMs) / 60000));
  return { lateMins, onTime: lateMins <= LATE_GRACE_MIN, known: true, delivered: !!deliveredAt };
}

export { LATE_GRACE_MIN };
