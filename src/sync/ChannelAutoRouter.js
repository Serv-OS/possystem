// src/sync/ChannelAutoRouter.js
//
// The gate in front of the channel auto route (12 Oct 2026, Preston). realtime.js used to call
// routeKioskOrderPrints straight from the order_queue INSERT event and from a one shot boot
// backfill, on any page whose storage said "master", menu or no menu. Now:
//   - a live order is routed at once ONLY when lib/masterTillDevice.js autoRouteGate says so
//     (the venue's master till, a valid till session, the venue's menu held, or the short wait
//     run out). When the menu is held this adds no await before the claim.
//   - an order that arrives while the gate is closed is NOT claimed and NOT dropped. It stays
//     unrouted in order_queue and the catch up scan (the old backfill read, same query) routes
//     it the moment the gate opens.
//   - the scan also runs again on wake, on 'online' and when the order channel subscribes
//     again, at most every CATCH_UP_MIN_GAP_MS, because this till is now the ONLY router and a
//     missed realtime event has no other second look. One read per scan, never one per order.
//   - "at most every" means LATER, never dropped (12 Oct 2026, review). On a wake the tab is
//     visible at once and scans, and the socket that died in sleep joins again some seconds
//     later: an order paid in between has no INSERT event and was in no scan. A request inside
//     the gap now arms ONE look for the moment the gap ends, and a read that FAILED is tried
//     again by a timer (10 s, then slower), with no outside event needed.
// A person's press (Send to kitchen again, Accept, catering opened early) never comes here.
import { autoRouteGate, pageMode, MASTER_TILL_EVENT, DEVICE_KEY, DEVICE_CONFIG_KEY } from '../lib/masterTillDevice.js';
import { isTillMode } from '../lib/masterTill.js';
import { queueRowToRouteOrder, autoRoutable, CATCH_UP_MIN_GAP_MS, CATCH_UP_RETRY_MS, catchUpRetryDelay } from '../lib/channelRouteGate.js';

let _run = null;

const isOpen = (d) => d === 'route' || d === 'route-blind';
const hasWindow = () => typeof window !== 'undefined' && typeof window.addEventListener === 'function';

function armWaitTimer(run) {
  if (run.timer) return;
  // The check compares the clock with the deadline, so a tablet that slept through it is late, never wrong.
  run.timer = setTimeout(() => { run.timer = null; evaluate('deadline'); }, 1000);
  run.timer.unref?.();
}

// ONE look armed for later: the end of the rate limit gap, or the retry after a failed read.
// Rate limited means delayed, never dropped. A look that is already due sooner is kept.
function armRescan(run, ms, reason) {
  const wait = Math.max(0, Number(ms) || 0);
  const at = Date.now() + wait;
  if (run.rescanTimer && run.rescanAt <= at) return;
  clearTimeout(run.rescanTimer);
  run.rescanAt = at;
  run.rescanTimer = setTimeout(() => {
    run.rescanTimer = null;
    if (_run === run) evaluate(reason, { rescan: true });   // the gate is asked again then: closed means no read
  }, wait);
  run.rescanTimer.unref?.();
}

// The read failed (null, or it threw): the next trigger looks again at once, and so does a timer.
function readFailed(run, reason) {
  run.lastScanAt = 0;
  run.failures += 1;
  const why = String(reason || 'asked');
  armRescan(run, catchUpRetryDelay(run.failures, run.retryMs), why.startsWith('retry, ') ? why : `retry, ${why}`);
}

async function scan(reason) {
  const run = _run;
  if (!run) return;
  if (run.scanning) { run.again = true; return; }
  run.scanning = true;
  run.lastScanAt = Date.now();
  try {
    const rows = await run.fetchUnrouted();
    if (_run !== run) return;                           // realtime stopped or moved venue while the read was out
    if (rows == null) readFailed(run, reason);
    else run.failures = 0;
    if (rows?.length) console.log(`[ChannelAutoRouter] catch up (${reason}): ${rows.length} unrouted order(s)`);
    for (const row of rows || []) {
      if (_run !== run) return;                         // realtime stopped or moved venue
      if (!autoRoutable(row)) continue;                 // delivery app order waiting for Accept
      // The WHOLE rule again for every order, at the moment it would go. False: leave without claiming.
      if (!isOpen(run.gate(run.store.getState(), run.venueId))) {
        // 12 Oct 2026 (review): the runner must not go on believing the gate is open, or the menu
        // landing (the store subscription returns early while open) would be ignored and the
        // rows left behind would wait for an outside event. Closed now; the 1 s check re opens
        // it and a re opened gate scans again.
        run.open = false;
        armWaitTimer(run);
        break;
      }
      const order = queueRowToRouteOrder(row);
      // A pre order due later: routeKioskOrderPrints arms one timer for it. Hand it over once per page.
      const dueLater = order.sentAt - Date.now() > 60_000;
      if (dueLater) {
        if (run.deferred.has(order.ref)) continue;
        run.deferred.add(order.ref);
      }
      // 12 Oct 2026 (review): one order that makes the route throw (a null line in its items)
      // must not block every order behind it, in this scan and in every scan after. Its own try.
      try {
        await run.store.getState().routeKioskOrderPrints?.(order, { trigger: 'backfill' });
      } catch (e) {
        if (dueLater) run.deferred.delete(order.ref);
        console.warn('[ChannelAutoRouter] catch up: one order failed, the rest go on', order.ref, e?.message || e);
      }
    }
  } catch (e) {
    if (_run === run) readFailed(run, reason);
    console.warn('[ChannelAutoRouter] catch up failed', e?.message || e);
  } finally {
    run.scanning = false;
    if (run.again && _run === run) {
      run.again = false;
      if (isOpen(run.gate(run.store.getState(), run.venueId))) scan('again');
    }
  }
}

function evaluate(reason, { rescan = false } = {}) {
  const run = _run;
  if (!run) return;
  const d = run.gate(run.store.getState(), run.venueId);
  if (d === 'wait') { run.open = false; armWaitTimer(run); return; }
  if (!isOpen(d)) { run.open = false; return; }
  const opened = !run.open;
  run.open = true;
  if (opened) { scan(`open, ${reason}`); return; }
  if (!rescan) return;
  // since < 0: the clock was set back. Look now rather than wait on a time that may never come.
  const since = Date.now() - run.lastScanAt;
  if (since < 0 || since >= run.minGapMs) scan(reason);
  else armRescan(run, run.minGapMs - since, reason);     // inside the gap: one look when it ends
}

/** A new channel order from the realtime INSERT event (already checked: master, not routed, not a delivery app order waiting for Accept). */
export function offerLiveOrder(order) {
  const run = _run;
  if (!run || !order?.ref) return;
  const d = run.gate(run.store.getState(), run.venueId);
  if (!isOpen(d)) {
    // Closed: nothing is claimed. The order stays unrouted in order_queue for the scan that runs when the gate opens.
    run.open = false;
    if (d === 'wait') armWaitTimer(run);
    return;
  }
  if (!run.open) evaluate('live');                      // the gate opened unseen: catch up on what waited
  run.store.getState().routeKioskOrderPrints?.(order, { trigger: 'live' });
}

/** Ask for a catch up scan (the order channel subscribed again). Rate limited (a request inside the gap is run when the gap ends), and only while the gate is open. */
export function requestCatchUp(reason = 'asked') {
  evaluate(reason, { rescan: true });
}

export function stopChannelAutoRouter() {
  const run = _run;
  _run = null;
  if (!run) return;
  clearTimeout(run.timer);
  clearTimeout(run.rescanTimer);
  try { run.unsub?.(); } catch { /* already gone */ }
  if (hasWindow()) {
    window.removeEventListener(MASTER_TILL_EVENT, run.onChange);
    window.removeEventListener('online', run.onOnline);
    window.removeEventListener('storage', run.onStorage);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', run.onVisible);
  }
}

/**
 * Start the gate for one venue. fetchUnrouted is realtime.js's own backfill read (returns the
 * unrouted rows, or null when the read failed). gate, mode, minGapMs and retryMs are for tests.
 */
export function startChannelAutoRouter({
  store, venueId, fetchUnrouted, gate = autoRouteGate, mode = pageMode(),
  minGapMs = CATCH_UP_MIN_GAP_MS, retryMs = CATCH_UP_RETRY_MS,
} = {}) {
  stopChannelAutoRouter();
  if (!store || !venueId || typeof fetchUnrouted !== 'function') return stopChannelAutoRouter;
  if (!isTillMode(mode)) return stopChannelAutoRouter;   // this page can never be a master till
  const run = {
    store, venueId, fetchUnrouted, gate, minGapMs, retryMs,
    open: false, scanning: false, again: false, lastScanAt: 0, timer: null, deferred: new Set(),
    rescanTimer: null, rescanAt: 0, failures: 0,
  };
  _run = run;
  // The menu landing is what a waiting master is waiting for.
  run.unsub = store.subscribe((s, p) => {
    if (_run !== run || run.open) return;
    if (s.menuCategories !== p.menuCategories || s.bootLocationId !== p.bootLocationId || s._catsReadLocationId !== p._catsReadLocationId) evaluate('menu');
  });
  run.onChange = () => evaluate('master');
  run.onOnline = () => evaluate('online', { rescan: true });
  run.onVisible = () => { if (document.visibilityState === 'visible') evaluate('visible', { rescan: true }); };
  run.onStorage = (e) => { if (e?.key === DEVICE_KEY || e?.key === DEVICE_CONFIG_KEY) evaluate('storage'); };
  if (hasWindow()) {
    window.addEventListener(MASTER_TILL_EVENT, run.onChange);
    window.addEventListener('online', run.onOnline);
    window.addEventListener('storage', run.onStorage);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', run.onVisible);
  }
  evaluate('start');
  return stopChannelAutoRouter;
}
