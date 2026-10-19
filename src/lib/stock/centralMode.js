/**
 * centralMode.js: the till's side of central stock depletion (v5.11.77, migration 20261018c).
 *
 * Pure, no I/O. The database now takes stock off every booked check at a venue switched to
 * 'central' (or 'paused'), from the check itself, through an outbox the pg_cron drainer posts.
 * At such a venue the till must not post its own SALE_DEPLETION or RETURN: the door in
 * post_stock_movement would answer {skipped: 'central'} anyway, but skipping saves the recipe
 * reads and the round trips. deplete.js reads the venue mode once a minute through
 * stock_venue_mode and asks these helpers what to do.
 *
 * No row for a venue, a missing RPC (the migration not run yet), or any error = 'browser':
 * the till keeps depleting exactly as before. Nothing changes until Peter switches a venue on.
 */

export const STOCK_MODES = Object.freeze(['browser', 'central', 'paused']);

/** How long a till trusts the mode it last read (ms). The drainer lags a sale by up to a minute anyway. */
export const MODE_TTL_MS = 60_000;

/** What a stock_venue_mode answer means. Anything unexpected is 'browser' (the old path, safe). */
export function modeFromRpc({ data, error } = {}) {
  if (error) return 'browser';
  const m = typeof data === 'string' ? data.trim().toLowerCase() : '';
  return STOCK_MODES.includes(m) ? m : 'browser';
}

/** The database books this venue's sales: the till must not post sale or refund movements. */
export function isCentralMode(mode) {
  return mode === 'central' || mode === 'paused';
}

/** Should deplete.js run its own explosion and posts for this venue? */
export function tillShouldDeplete(mode) {
  return !isCentralMode(mode);
}

/**
 * Plain words for the Back Office stock screens, from stock_outbox_health's answer.
 * Short sentences, no jargon, the thing to do when something needs a person.
 */
export function healthWords(h) {
  if (!h || typeof h !== 'object') return null;
  const pending = Number(h.pending) || 0;
  const oldest = Number(h.oldest_pending_s) || 0;
  const held = Number(h.held) || 0;
  const dead = Number(h.dead) || 0;
  const done24 = Number(h.done_24h) || 0;
  const mode = STOCK_MODES.includes(h.mode) ? h.mode : 'browser';
  const needsPerson = Array.isArray(h.needs_person) ? h.needs_person : [];
  let title, sub, tone = 'ok';
  if (mode === 'browser') {
    title = 'Stock comes off at the till';
    sub = 'Each till takes stock off when it closes a check. Kiosk, online, QR and delivery sales do not move stock yet. ServOS switches a venue to central depletion.';
    tone = 'muted';
  } else {
    title = mode === 'paused' ? 'Central stock depletion is paused' : 'Stock comes off every booked check';
    const bits = [];
    bits.push(`${done24} check${done24 === 1 ? '' : 's'} booked in the last 24 hours`);
    if (pending > 0) bits.push(`${pending} waiting${oldest > 0 ? ` (oldest ${ageWords(oldest)})` : ''}`);
    if (held > 0) bits.push(`${held} need${held === 1 ? 's' : ''} a person`);
    if (dead > 0) bits.push(`${dead} failed 8 times`);
    sub = bits.join(' · ');
    if (dead > 0 || held > 0) tone = 'warn';
    if (oldest > 600) tone = 'alert';
    if (mode === 'paused') tone = 'warn';
  }
  return { mode, title, sub, tone, pending, oldest, held, dead, done24, needsPerson };
}

/** 90 -> "1 min 30 s", 7200 -> "2 h". */
export function ageWords(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (s < 60) return `${s} s`;
  if (s < 3600) { const m = Math.floor(s / 60), r = s % 60; return r ? `${m} min ${r} s` : `${m} min`; }
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** What a held row is, in words a manager reads. */
export function heldReason(row) {
  const flags = Array.isArray(row?.flags) ? row.flags : [];
  if (flags.includes('netted_refund_failed')) return 'This order was refunded before its event, so its stock was never taken; then the refund was refused. Take the stock off by hand (waste or a count); this cannot be released.';
  if (flags.includes('sale_not_booked')) return 'A refund or void waiting for the sale of the same check, which needs a person first. Release the sale; this follows it.';
  if (flags.includes('unproven')) return 'Written by a session that cannot open this venue and no payment proof was found. Release it if the sale is genuine.';
  if (flags.includes('proof_used')) return 'Another check already used the payment proof for this order reference. Likely a duplicate: check the two sales before releasing.';
  if (flags.includes('too_old')) return 'Closed more than 31 days ago (an old offline replay). Release it only if its stock was never counted since.';
  if (flags.includes('before_switch')) return 'Closed before this venue switched to central depletion. The till will have taken its stock off already.';
  if (flags.includes('items_changed')) return 'The items were changed after the sale closed. Adjust the stock by hand; this cannot be released.';
  if (flags.includes('moved')) return 'The check was moved to another venue after the sale. Adjust the stock by hand; this cannot be released.';
  if (flags.includes('swept')) return 'Found by the hourly sweep with no record of who wrote it. Release it if the sale is genuine.';
  if (row?.status === 'dead') return `Failed 8 times${row.last_error ? `: ${String(row.last_error).slice(0, 120)}` : ''}. Fix the cause, then release it.`;
  return row?.last_error ? String(row.last_error).slice(0, 160) : 'Needs a person.';
}
