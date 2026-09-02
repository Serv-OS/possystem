// src/lib/prepTime.js
//
// How long to tell a customer their collection order will take.
//
// A flat lead time is right when the kitchen is quiet and wrong the moment it
// is not. Set 30 minutes and a Saturday with forty tickets on the pass still
// promises 30, so the venue takes an order it cannot make and the customer
// arrives to wait. This adds time as the queue grows.
//
// The rule is deliberately something an operator can hold in their head:
//   every <stepOrders> live orders adds <stepMinutes>, capped at <maxMinutes>.
//
// A "live" order is one the venue has accepted but not yet finished. Orders
// already waiting on the shelf are NOT counted: the food is made, so it is not
// competing for kitchen time, and counting it would inflate the quote all day.

/** Order-queue states the Orders Hub treats as finished. Kept identical to
 *  DONE_STATUSES in OrdersHub.jsx: the number quoted to a customer has to be
 *  the number staff can see. */
export const DONE_STATUSES = ['collected', 'paid', 'cancelled'];

/** States that are NOT work in the kitchen yet.
 *
 *  A 'scheduled' order is a pre-order for later, often another day. It is
 *  deliberately held out of the kitchen until shortly before its collection
 *  time (store/index.js fireScheduledOrder), at which point it becomes a normal
 *  queue order and starts counting. Counting it while it waits would let a
 *  healthy pre-order book quote an hour's wait to somebody standing there now. */
export const NOT_YET_WORKING = ['scheduled'];

/** Everything the busy count treats as "not open work right now". */
export const EXCLUDED_STATUSES = [...DONE_STATUSES, ...NOT_YET_WORKING];

const DEFAULT_MAX_ADDED = 45;

/**
 * @param {number} baseMin     the venue's flat lead time
 * @param {number} liveOrders  orders accepted but not yet ready
 * @param {object} rule        { stepOrders, stepMinutes, maxMinutes }
 * @returns {{ minutes:number, added:number, busy:boolean }}
 */
export function prepMinutes(baseMin, liveOrders, rule = {}) {
  const base = Math.max(0, Number(baseMin) || 0);
  const stepOrders = Math.max(0, parseInt(rule.stepOrders, 10) || 0);
  const stepMinutes = Math.max(0, parseInt(rule.stepMinutes, 10) || 0);
  // No rule set is the normal case and must behave exactly as before.
  if (!stepOrders || !stepMinutes) return { minutes: base, added: 0, busy: false };

  const live = Math.max(0, Number(liveOrders) || 0);
  // FLOOR, not ceil: the first order of the day must not instantly add time.
  // With a step of 10, the bump arrives at the 10th live order, not the 1st.
  const steps = Math.floor(live / stepOrders);
  const cap = Number.isFinite(Number(rule.maxMinutes)) && Number(rule.maxMinutes) > 0
    ? Number(rule.maxMinutes) : DEFAULT_MAX_ADDED;
  const added = Math.min(steps * stepMinutes, cap);
  return { minutes: base + added, added, busy: added > 0 };
}

/** The rule as stored on the location row. */
export function prepRuleFromLocation(location) {
  return {
    stepOrders: location?.online_busy_step_orders,
    stepMinutes: location?.online_busy_step_minutes,
    maxMinutes: location?.online_busy_max_minutes,
  };
}

/**
 * How many orders are open right now, counted exactly as the Orders Hub counts
 * them, so the busy time can never disagree with the screen staff are looking
 * at.
 *
 * Three sources, because that is what an order is in this system:
 *   - open table sessions   (active_sessions)
 *   - open bar tabs         (bar_tabs, not closed)
 *   - the order queue       (order_queue, not collected / paid / cancelled)
 *     which carries online, kiosk, counter, delivery and third party.
 *
 * TWO EARLIER ATTEMPTS WERE WRONG, and both would have hurt service:
 *   1. order_queue alone left OUT table service entirely, so a venue with 22
 *      tables on read as quiet.
 *   2. kitchen tickets inside a 4 hour window read 0 at a venue with ~27 open
 *      orders, because the tickets were sent earlier than the window even
 *      though the orders were still open.
 * Matching the Hub is the only definition that cannot drift from what staff see.
 *
 * Never throws and never blocks a customer: any source that fails is skipped,
 * and if they all fail we return null and the flat lead time applies.
 */
export async function liveOrderCount(supabase, opsLocationId) {
  if (!supabase || !opsLocationId) return null;
  const rows = (q) => q.then(r => (r?.error ? null : (Array.isArray(r?.data) ? r.data : null)));
  const head = (q) => q.then(r => (r?.error ? null : (typeof r?.count === 'number' ? r.count : null)));
  try {
    const [floor, sessions, tabs, queue] = await Promise.all([
      rows(supabase.from('floor_tables').select('id').eq('location_id', opsLocationId).limit(1000)),
      rows(supabase.from('active_sessions').select('table_id').eq('location_id', opsLocationId).limit(1000)),
      head(supabase.from('bar_tabs').select('id', { count: 'exact', head: true })
        .eq('location_id', opsLocationId).neq('status', 'closed')),
      head(supabase.from('order_queue').select('ref', { count: 'exact', head: true })
        .eq('location_id', opsLocationId).not('status', 'in', `(${EXCLUDED_STATUSES.join(',')})`)),
    ]);

    // Only sessions whose table is actually ON the floor plan count, because
    // that is what the Orders Hub shows. Provo carries five session rows but
    // only two live tables: the other three are orphans left by table splits
    // and one from June that nothing has ever cleared. Counting those would
    // have quoted customers a busier kitchen than exists, for ever.
    let tables = null;
    if (floor && sessions) {
      const onFloor = new Set(floor.map(f => String(f.id)));
      tables = sessions.filter(s2 => onFloor.has(String(s2.table_id))).length;
    }

    if (tables === null && tabs === null && queue === null) return null;
    return (tables || 0) + (tabs || 0) + (queue || 0);
  } catch { return null; }
}
