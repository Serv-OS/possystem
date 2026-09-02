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

/** KDS ticket states that still need kitchen time. 'bumped' is served. */
export const LIVE_TICKET_STATUSES = ['pending', 'fired'];

/** How far back a ticket still counts as live. A ticket nobody ever bumped
 *  three days ago is data debris, not kitchen load, and counting it would
 *  inflate every quote for ever. */
const LIVE_WINDOW_HOURS = 4;

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
 * How many orders the kitchen is currently working on, across EVERY channel.
 *
 * This reads the kitchen board (kds_tickets), not the online order queue. That
 * matters: order_queue holds online, kiosk and counter orders but NOT table
 * service, and on 1 Sep this venue had 22 open tables against a handful of
 * online orders. Quoting from order_queue would have told a customer the
 * kitchen was quiet while it was buried in covers.
 *
 * Counting DISTINCT tickets-per-order, not tickets: one order routed to the
 * kitchen and the bar raises two tickets, and that is one order's worth of
 * food, not two. `table_label` is the per-order grouping the board itself uses
 * (a table number, or "Online OL-XXX" / "Kiosk K-XXX" for the other channels).
 *
 * Never throws and never blocks a customer: if it cannot be read we return null
 * and the caller falls back to the flat lead time.
 */
export async function liveOrderCount(supabase, opsLocationId) {
  if (!supabase || !opsLocationId) return null;
  try {
    const since = new Date(Date.now() - LIVE_WINDOW_HOURS * 3600_000).toISOString();
    const { data, error } = await supabase
      .from('kds_tickets')
      .select('table_label')
      .eq('location_id', opsLocationId)
      .in('status', LIVE_TICKET_STATUSES)
      .gt('sent_at', since)
      .limit(2000);
    if (error || !Array.isArray(data)) return null;
    // A ticket with no label cannot be grouped, so it counts as its own order
    // rather than silently collapsing every unlabelled ticket into one.
    let unlabelled = 0;
    const labels = new Set();
    for (const t of data) {
      if (t?.table_label) labels.add(String(t.table_label));
      else unlabelled += 1;
    }
    return labels.size + unlabelled;
  } catch { return null; }
}
