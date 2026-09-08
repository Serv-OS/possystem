// src/sync/staleness.js
//
// Boot-time staleness guards. A device that has been OFFLINE for a long while will, on
// boot, rehydrate a backlog of orders/scheduled-fires/buffered writes whose moment has
// long passed. Without a floor, every drain path (scheduled tick, catering release, master
// backfill, offline replay) dumps that whole backlog into the LIVE kitchen at once.
//
// Policy: NEVER auto-fire / auto-replay anything whose moment passed more than the floor
// below. Stale orders are NOT deleted — they keep kitchen_routed_at NULL (stay 'scheduled'),
// so they remain visible in the Orders Hub for staff to release manually. The safe failure
// direction is "hold, don't flood."

// An order whose kitchen-fire moment (sent_at / scheduledFireAt) passed more than this long
// ago is considered stale and is NOT auto-fired on boot. 2h is conservative enough to still
// auto-fire genuinely-recent due orders (incl. same-morning catering) while blocking a
// long-offline dump. Tunable per-venue later if needed.
export const STALE_ORDER_FLOOR_MS = 2 * 60 * 60 * 1000;

// A buffered offline write older than this is quarantined to the failure UI instead of being
// replayed — so a long-dormant device never resurrects stale orders / sessions / tabs.
export const REPLAY_MAX_AGE_MS = 12 * 60 * 60 * 1000;
