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

/** Order-queue states the Orders Hub treats as finished. Everything else on the
 *  queue is still open work. Kept identical to DONE_STATUSES in OrdersHub.jsx:
 *  the number quoted to a customer has to be the number staff can see. */
export const DONE_STATUSES = ['collected', 'paid', 'cancelled'];

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
  const head = (q) => q.then(r => (r?.error ? null : (typeof r?.count === 'number' ? r.count : null)));
  try {
    const [tables, tabs, queue] = await Promise.all([
      head(supabase.from('active_sessions').select('table_id', { count: 'exact', head: true })
        .eq('location_id', opsLocationId)),
      head(supabase.from('bar_tabs').select('id', { count: 'exact', head: true })
        .eq('location_id', opsLocationId).neq('status', 'closed')),
      head(supabase.from('order_queue').select('ref', { count: 'exact', head: true })
        .eq('location_id', opsLocationId).not('status', 'in', `(${DONE_STATUSES.join(',')})`)),
    ]);
    if (tables === null && tabs === null && queue === null) return null;
    return (tables || 0) + (tabs || 0) + (queue || 0);
  } catch { return null; }
}
