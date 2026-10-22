// demoHistory.js: THE ONE DEMO RULE for every report (5.11.99, Reports align, 22 Oct 2026).
//
// Peter, 22 Oct 2026: "build it, leave demo days out, that's fine". The demo files of 15 Oct 2026
// (~/.claude/servos-release/demo) filled the test company's two venues (Provo and Location 2) with
// made up sales and stock history for a product video. Until now only Stock and GP left that history
// out; Daily trading, the Business summary, the Owner and Manager apps, the Wastage log, All sites
// overview, Daily trend, menu engineering and Xero added it in. Every one of them now leaves it out
// by this file, and the database by the same rule in SQL (20261029a: public._sales_is_demo for a
// check id, public.stock_rp__is_demo for a stock movement key), so a figure is the same everywhere.
//
// What is demo:
//   a check      closed_checks.id starting 'demo-' (the demo files wrote 'demo-s-...'). Real checks
//                are 'chk-...', 'QR-...', a uuid and so on: never 'demo-'.
//   a movement   stock_movements.idempotency_key starting 'demo-v1:', 'demo71:' or 'seed:' (the same
//                three the 4a reports leave out, stock_rp__is_demo).
//   a waste row  a waste_events row whose stock movements are all demo keyed (its value comes from the
//                ledger, so a waste row with no movement adds nothing anyway).
// Nothing else is demo: a real venue has no such id or key, so every one of its figures is byte for
// byte what it was.
//
// Each report that left something out says so in the same small grey words: DEMO_NOTE.
//
// PURE: no imports; runs under node --test, in Deno and in the browser.

/** The words every report shows when it left demo history out. */
export const DEMO_NOTE = 'Demo history left out';

/** True for a check id the demo files wrote ('demo-...'). The SQL twin is public._sales_is_demo(text). */
export function isDemoCheckId(id) {
  return typeof id === 'string' && id.startsWith('demo-');
}

/** True for a closed check (a closed_checks row or the Back Office's camelCase check) the demo files wrote. */
export function isDemoCheck(row) {
  return !!row && isDemoCheckId(row.id);
}

/** True for a stock movement key the demo files wrote. The SQL twin is public.stock_rp__is_demo(text). */
export function isDemoStockKey(key) {
  return typeof key === 'string' && (key.startsWith('demo-v1:') || key.startsWith('demo71:') || key.startsWith('seed:'));
}

/**
 * The checks with the demo ones left out: { rows, left } where left is how many were left out.
 * The same array comes back when there was nothing to leave out, so a screen that memoises on it
 * does no extra work at a real venue.
 */
export function leaveOutDemo(rows) {
  const list = Array.isArray(rows) ? rows : [];
  let left = 0;
  for (const r of list) if (isDemoCheck(r)) left += 1;
  if (!left) return { rows: list, left: 0 };
  return { rows: list.filter((r) => !isDemoCheck(r)), left };
}

/**
 * A page callback with the demo checks left out, for reads that add rows up as they arrive
 * (pagedEach). `mark` is called once per page that held a demo check, so the caller can say so.
 */
export function withoutDemoRows(onRows, mark = null) {
  return (rows) => {
    const r = leaveOutDemo(rows);
    if (r.left && mark) mark(r.left);
    return onRows(r.rows);
  };
}
