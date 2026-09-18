// supabase/functions/_shared/budget.js
//
// Run a list of slow jobs IN PARALLEL, a few at a time, inside ONE total time budget. Pure (no
// Deno, no I/O of its own), imported by catering-release and unit tested under node.
//
// WHY (review round 3, 18 Sep 2026): catering-release re-asked ezCater about each due order one
// after another, up to about 4 to 7 seconds each, inside a batch of 200. An ezCater outage could
// run the function past its wall clock, and every order behind the slow ones waited or was never
// reached. Now the checks run side by side, and when the budget is spent every job that has not
// answered comes back { ok: false, skipped: true } so the caller fires it unchecked (flagged),
// never late and never not at all.
//
// A job still running when the budget ends is NOT cancelled (it may be half way through a
// database write): it simply stops counting. Every write it can still make is guarded (the
// kitchen_routed_at and updated_at conditions in _shared/ezcaterIngest.ts), so a late answer
// can never silently change an order the kitchen already has.

/**
 * @param {Array<any>} items
 * @param {(item: any, index: number) => Promise<any>} worker
 * @param {{ concurrency?: number, budgetMs?: number }} [opts]
 * @returns {Promise<Array<{ ok: true, value: any } | { ok: false, error: string, skipped?: boolean }>>}
 *   one result per item, in the same order
 */
export async function runWithBudget(items, worker, { concurrency = 6, budgetMs = 20000 } = {}) {
  const list = Array.isArray(items) ? items : [];
  const results = new Array(list.length).fill(undefined);
  if (!list.length) return [];
  let next = 0;
  let expired = false;
  let timer = null;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => { expired = true; resolve(); }, Math.max(0, Number(budgetMs) || 0));
  });
  const lane = async () => {
    while (!expired && next < list.length) {
      const i = next++;
      try {
        const value = await worker(list[i], i);
        if (!expired) results[i] = { ok: true, value };
      } catch (e) {
        if (!expired) results[i] = { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }
  };
  const lanes = Array.from({ length: Math.max(1, Math.min(Number(concurrency) || 1, list.length)) }, lane);
  try {
    await Promise.race([Promise.all(lanes), deadline]);
  } finally {
    expired = true;
    if (timer) clearTimeout(timer);
  }
  return list.map((_, i) => results[i] ?? { ok: false, skipped: true, error: 'the time budget ran out before this one answered' });
}
