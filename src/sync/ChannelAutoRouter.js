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
// A person's press (Send to kitchen again, Accept, catering opened early) never comes here.
import { autoRouteGate, pageMode, MASTER_TILL_EVENT, DEVICE_KEY, DEVICE_CONFIG_KEY } from '../lib/masterTillDevice.js';
import { isTillMode } from '../lib/masterTill.js';
import { queueRowToRouteOrder, autoRoutable, CATCH_UP_MIN_GAP_MS } from '../lib/channelRouteGate.js';

let _run = null;

const isOpen = (d) => d === 'route' || d === 'route-blind';
const hasWindow = () => typeof window !== 'undefined' && typeof window.addEventListener === 'function';

function armWaitTimer(run) {
  if (run.timer) return;
  // The check compares the clock with the deadline, so a tablet that slept through it is late, never wrong.
  run.timer = setTimeout(() => { run.timer = null; evaluate('deadline'); }, 1000);
  run.timer.unref?.();
}

async function scan(reason) {
  const run = _run;
  if (!run) return;
  if (run.scanning) { run.again = true; return; }
  run.scanning = true;
  run.lastScanAt = Date.now();
  try {
    const rows = await run.fetchUnrouted();
    if (rows == null) run.lastScanAt = 0;               // the read failed: the next trigger looks again at once
    if (rows?.length) console.log(`[ChannelAutoRouter] catch up (${reason}): ${rows.length} unrouted order(s)`);
    for (const row of rows || []) {
      if (_run !== run) return;                         // realtime stopped or moved venue
      if (!autoRoutable(row)) continue;                 // delivery app order waiting for Accept
      // The WHOLE rule again for every order, at the moment it would go. False: leave without claiming.
      if (!isOpen(run.gate(run.store.getState(), run.venueId))) break;
      const order = queueRowToRouteOrder(row);
      // A pre order due later: routeKioskOrderPrints arms one timer for it. Hand it over once per page.
      if (order.sentAt - Date.now() > 60_000) {
        if (run.deferred.has(order.ref)) continue;
        run.deferred.add(order.ref);
      }
      await run.store.getState().routeKioskOrderPrints?.(order, { trigger: 'backfill' });
    }
  } catch (e) {
    run.lastScanAt = 0;
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
  if (opened || (rescan && Date.now() - run.lastScanAt >= CATCH_UP_MIN_GAP_MS)) scan(opened ? `open, ${reason}` : reason);
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

/** Ask for a catch up scan (the order channel subscribed again). Rate limited, and only while the gate is open. */
export function requestCatchUp(reason = 'asked') {
  evaluate(reason, { rescan: true });
}

export function stopChannelAutoRouter() {
  const run = _run;
  _run = null;
  if (!run) return;
  clearTimeout(run.timer);
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
 * unrouted rows, or null when the read failed). gate and mode are for tests.
 */
export function startChannelAutoRouter({ store, venueId, fetchUnrouted, gate = autoRouteGate, mode = pageMode() } = {}) {
  stopChannelAutoRouter();
  if (!store || !venueId || typeof fetchUnrouted !== 'function') return stopChannelAutoRouter;
  if (!isTillMode(mode)) return stopChannelAutoRouter;   // this page can never be a master till
  const run = {
    store, venueId, fetchUnrouted, gate,
    open: false, scanning: false, again: false, lastScanAt: 0, timer: null, deferred: new Set(),
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
