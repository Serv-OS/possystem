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
// The count that drives this is kitchen WORK, not the Orders Hub headline.
// An order already made and waiting on the pass is still live on the Hub, but
// the kitchen has finished it, so it must not add time to the next customer.

/** Order-queue states the Orders Hub treats as finished. Kept identical to
 *  DONE_STATUSES in OrdersHub.jsx, so the Hub-parity number below can never
 *  drift from the screen staff are looking at. */
export const DONE_STATUSES = ['collected', 'paid', 'cancelled'];

/** States that are NOT work in the kitchen yet.
 *
 *  A 'scheduled' order is a pre-order for later, often another day. It is
 *  deliberately held out of the kitchen until shortly before its collection
 *  time (store/index.js fireScheduledOrder), at which point it becomes a normal
 *  queue order and starts counting. Counting it while it waits would let a
 *  healthy pre-order book quote an hour's wait to somebody standing there now. */
export const NOT_YET_WORKING = ['scheduled'];

/** States where the kitchen has ALREADY finished the food.
 *
 *  'ready' means it is made and sitting on the pass waiting to be handed over.
 *  It is still a live order on the Orders Hub, correctly, because somebody has
 *  to give it to a customer. But it is no longer competing for kitchen time, so
 *  it must not push the quoted wait up. A shelf of six uncollected orders would
 *  otherwise add half an hour to everybody behind them for nothing. */
export const KITCHEN_FINISHED = ['ready'];

/** Not shown on the Orders Hub at all. */
export const EXCLUDED_STATUSES = [...DONE_STATUSES, ...NOT_YET_WORKING];

const DEFAULT_MAX_ADDED = 45;

/**
 * @param {number} baseMin     the venue's flat lead time
 * @param {number} liveOrders  open work in the kitchen (the `load` figure)
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
 * Two counts, from one read, because they answer two different questions.
 *
 *   live  what the Orders Hub shows. Everything the venue has accepted and not
 *         finished with: open tables, open bar tabs, and every queue order that
 *         is not collected, paid or cancelled. This is the operational number.
 *
 *   load  what the KITCHEN still has to make. The same set minus anything
 *         already 'ready' on the pass. This is the number that drives the
 *         quoted wait, and it is the one prepMinutes should be given.
 *
 * They are deliberately allowed to disagree. Provo today is live 27, load 25:
 * two collection orders have been made and are waiting to be picked up. Adding
 * kitchen time for those would punish the next customer for somebody else being
 * slow to turn up.
 *
 * Three sources, because that is what an order is in this system:
 *   - open table sessions   (active_sessions, joined to floor_tables)
 *   - open bar tabs         (bar_tabs, not closed)
 *   - the order queue       (order_queue)  online, kiosk, counter, delivery, 3rd party
 *
 * THREE EARLIER ATTEMPTS WERE WRONG, and all three would have hurt service:
 *   1. order_queue alone left OUT table service entirely, so a venue with 22
 *      tables on read as quiet.
 *   2. kitchen tickets inside a 4 hour window read 0 at a venue with ~27 open
 *      orders, because the tickets were sent before the window opened.
 *   3. raw active_sessions counted five tables at Provo where the floor plan
 *      has two. The other three are orphans left by table splits, one of them
 *      from June. Hence the join to floor_tables: a session on a table that no
 *      longer exists is not a table anyone can serve.
 *
 * Never throws and never blocks a customer: any source that fails is skipped,
 * and if they all fail we return null and the flat lead time applies.
 *
 * @returns {Promise<{live:number, load:number}|null>}
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
      // Statuses rather than a head count, so one read gives both figures.
      rows(supabase.from('order_queue').select('status').eq('location_id', opsLocationId)
        .not('status', 'in', `(${EXCLUDED_STATUSES.join(',')})`).limit(2000)),
    ]);

    // Only sessions whose table is actually ON the floor plan count, because
    // that is what the Orders Hub shows.
    let tables = null;
    if (floor && sessions) {
      const onFloor = new Set(floor.map(f => String(f.id)));
      tables = sessions.filter(s2 => onFloor.has(String(s2.table_id))).length;
    }

    let qLive = null, qLoad = null;
    if (queue) {
      qLive = queue.length;
      qLoad = queue.filter(q2 => !KITCHEN_FINISHED.includes(q2?.status)).length;
    }

    if (tables === null && tabs === null && qLive === null) return null;
    const base = (tables || 0) + (tabs || 0);
    return { live: base + (qLive || 0), load: base + (qLoad || 0) };
  } catch { return null; }
}
