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

/** Statuses that still need kitchen time. Verified against the live order_queue
 *  on 1 Sep 2026: the real values are received / prep / ready / cancelled.
 *  'ready' is food already made and waiting on the shelf, so it is NOT counted:
 *  it is not competing for kitchen time and counting it would inflate the quote
 *  all day. 'cancelled' is gone. */
export const LIVE_PREP_STATUSES = ['received', 'prep'];

/** Ceiling on ADDED minutes when the venue has not set its own. */
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
 * How many orders this venue is still cooking. Never throws and never blocks a
 * customer: if the count cannot be read we return null and the caller falls
 * back to the flat lead time, which is the behaviour that exists today.
 */
export async function liveOrderCount(supabase, opsLocationId) {
  if (!supabase || !opsLocationId) return null;
  try {
    const { count, error } = await supabase
      .from('order_queue')
      .select('id', { count: 'exact', head: true })
      .eq('location_id', opsLocationId)
      .in('status', LIVE_PREP_STATUSES);
    if (error) return null;
    return typeof count === 'number' ? count : null;
  } catch { return null; }
}
