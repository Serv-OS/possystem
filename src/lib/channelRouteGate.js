// src/lib/channelRouteGate.js
//
// The pure rules around the channel auto route (12 Oct 2026, Preston). A QR, kiosk, online or
// delivery app order is sent to the kitchen by the master till with nobody watching, so three
// things are decided here, with no storage and no network:
//   1. does this page hold THIS venue's menu (venueHoldsMenu);
//   2. may the auto route go now, must it wait, or has the wait run out (routeGateDecision);
//   3. what the ticket records about who routed it (buildRouteStamp) and what staff are told when
//      a line had no kitchen screen or the till had no menu (fallbackNotice).
// LOCAL FIRST (Peter, 12 Oct 2026: "if it reads from the data base each time we are moving away
// from offline mode not towards"): nothing here, and nothing built on it, reads the network.

// How long the master till waits for its menu, counted ONCE per page from the moment its till
// session became valid, never per order. Far under the 3 minute catering cron
// (supabase/functions/catering-release GRACE_MIN), which would otherwise take a waiting catering
// order as one unsplit ticket.
export const MENU_WAIT_MS = 20_000;
// The catch up scan (the old boot backfill read) runs when the gate opens, and again on wake, on
// 'online' and when the order channel subscribes again, never more often than this.
export const CATCH_UP_MIN_GAP_MS = 30_000;
// 12 Oct 2026 (review): a catch up read that FAILED is tried again by the till itself, with no
// outside event: after 10 s, then 20 s, 40 s, then every 60 s until one read works. The master
// till is the only router, so a failed look must never be the last look. This is the same read,
// asked again only after it failed. Nothing is read per order (local first).
export const CATCH_UP_RETRY_MS = 10_000;
export function catchUpRetryDelay(failures, base = CATCH_UP_RETRY_MS) {
  const b = Number.isFinite(base) && base > 0 ? base : CATCH_UP_RETRY_MS;
  const n = Math.max(1, Math.floor(Number(failures) || 1));
  return Math.min(b * 6, b * 2 ** Math.min(n - 1, 8));
}

/**
 * Does this page hold this venue's menu? Ready when the store has a category of this venue, or
 * the boot's category read SUCCEEDED for this venue and found none (a brand new venue). A boot
 * that merely finished is not proof: its category read may have failed.
 * catsReadLocationId is set ONLY for a read that found no rows (12 Oct 2026, review): a read
 * that found rows says nothing until those rows are in the store, several awaited reads later,
 * and a gate that opened on the read alone let the master till route with an empty tree.
 * Returns { ready, why }.
 */
export function venueHoldsMenu({ venueId, categories, bootLocationId, catsReadLocationId } = {}) {
  if (!venueId) return { ready: false, why: 'no-venue' };
  const list = Array.isArray(categories) ? categories.filter(Boolean) : [];
  const venueOf = (c) => c.location_id ?? c.locationId ?? null;
  if (list.some((c) => venueOf(c) === venueId)) return { ready: true, why: 'categories' };
  // Rows that name no venue at all (a very old push): trusted only in a page that booted for this venue.
  if (list.length && list.every((c) => venueOf(c) == null) && bootLocationId === venueId) return { ready: true, why: 'untagged' };
  if (!list.length && catsReadLocationId === venueId) return { ready: true, why: 'none-on-file' };
  return { ready: false, why: list.length ? 'other-venue' : 'not-loaded' };
}

/**
 * May the AUTO route go? (Live order, catch up scan, catering sweep. Never a person's press.)
 *   'skip'        not this page's job: not the venue's master till
 *   'route'       master, and it holds the venue's menu
 *   'wait'        master, menu not here yet: claim nothing, the order stays in the queue
 *   'route-blind' master, the wait has run out: send with what it holds, say so, stamp it
 * A page whose sync never started for this venue (booted false) only ever waits: it can never
 * hold the menu, so it must never route blind.
 */
export function routeGateDecision({ master, booted, menuReady, now, deadlineAt } = {}) {
  if (!master) return 'skip';
  if (menuReady) return 'route';
  if (!booted) return 'wait';
  if (!Number.isFinite(deadlineAt) || !Number.isFinite(now)) return 'wait';
  return now >= deadlineAt ? 'route-blind' : 'wait';
}

/** The order routeKioskOrderPrints takes, from an order_queue row (the same shape realtime always built). */
export function queueRowToRouteOrder(row, now = Date.now()) {
  const r = row || {};
  return {
    ref: r.ref || '',
    source: r.source,
    type: r.type || null,
    tableLabel: r.customer?.tableLabel || null,
    items: r.items || [],
    customer: r.customer || null,
    collectionTime: r.collection_time || null,
    isASAP: !!r.is_asap,
    sentAt: r.sent_at ? new Date(r.sent_at).getTime() : now,
  };
}

/** A delivery app order on manual accept ('received') waits for staff. Everything else may auto route. */
export function autoRoutable(row) {
  return !(row?.source === 'hubrise' && row?.status !== 'prep');
}

// ── The stamp on the ticket (kds_tickets.meta.routedBy) ──────────────────────

export const ROUTE_TRIGGERS = Object.freeze(['live', 'backfill', 'manual', 'catering']);
const cut = (v, n) => { const s = v == null ? '' : String(v); return s.length > n ? s.slice(0, n) : s; };

/**
 * An item name as staff read it in a notice and as the stamp keeps it. 12 Oct 2026 (review): a
 * sized line is stored as product, long dash, size, and Coffee Boy sizes end in a space, so the
 * Preston toast read with a long dash and a double space. The long dash becomes a space, runs
 * of spaces become one, the ends are trimmed. Written with escapes so this file holds no long dash.
 */
export function tidyName(name) {
  return (name == null ? '' : String(name)).replace(/[\u2013\u2014]/g, ' ').replace(/\s+/g, ' ').trim();
}
const shortName = (n) => cut(tidyName(n), 40).trim();   // trimmed again: the cut can end on a space

export function countParentLinks(catParents) {
  return catParents && typeof catParents === 'object' ? Object.values(catParents).filter(Boolean).length : 0;
}

/**
 * Who routed this ticket and with what. Small, plain values only, no customer data, never the
 * device secret: it is built from named values, never by spreading a device object.
 */
export function buildRouteStamp({ deviceId, deviceName, mode, version, trigger, categoryCount, parentLinks, menuHeld, fallbackNames, at } = {}) {
  const names = (Array.isArray(fallbackNames) ? fallbackNames : []).map(shortName).filter(Boolean);
  return {
    v: 1,
    deviceId: deviceId ? cut(deviceId, 64) : null,
    deviceName: deviceName ? cut(deviceName, 40) : null,
    mode: mode ? cut(mode, 24) : null,
    version: version ? cut(version, 16) : null,
    trigger: ROUTE_TRIGGERS.includes(trigger) ? trigger : 'unknown',
    cats: Number.isFinite(categoryCount) ? categoryCount : 0,
    links: Number.isFinite(parentLinks) ? parentLinks : 0,
    menu: menuHeld === true,
    fallback: names.slice(0, 5),
    fallbackCount: names.length,
    at: Number.isFinite(at) ? new Date(at).toISOString() : null,
  };
}

// ── No silent fallback ───────────────────────────────────────────────────────

/**
 * The fallback lines the notice names: every line that had no kitchen screen, except the ones the
 * existing delivery app toast ("not in our menu") already names, so that toast is never doubled.
 */
export function noticeLines({ unrouted, source, menuItems } = {}) {
  const list = Array.isArray(unrouted) ? unrouted.filter(Boolean) : [];
  if (source !== 'hubrise') return list;
  const ids = new Set((Array.isArray(menuItems) ? menuItems : []).map((m) => m && m.id));
  return list.filter((it) => ids.has(it.itemId || it.id));
}

const listWords = (names) => {
  const shown = names.slice(0, 3).join(', ');
  return names.length > 3 ? `${shown} and ${names.length - 3} more` : shown;
};

/**
 * What staff are told. null when the till held its menu and every line had a screen.
 * Returns { toast, title, body }: the toast for the routing till, title and body for one
 * activity feed event.
 */
export function fallbackNotice({ ref, names, centreName, menuHeld } = {}) {
  const list = (Array.isArray(names) ? names : []).map(shortName).filter(Boolean);
  const order = ref ? String(ref) : 'An order';
  const screen = centreName ? String(centreName) : 'the first screen';
  if (!list.length && menuHeld !== false) return null;
  if (!list.length) {
    return {
      toast: `${order} went to the kitchen before this till had its menu. Check the kitchen screens.`,
      title: 'Order sent without the menu',
      body: `${order}: this till had no menu yet. Check it reached the right screen.`,
    };
  }
  const what = listWords(list);
  const it = list.length === 1 ? 'it' : 'them';
  if (menuHeld === false) {
    return {
      toast: `${order}: ${what} went to ${screen}. This till had no menu yet. Check the kitchen screens.`,
      title: 'Order sent without the menu',
      body: `${order}: this till had no menu yet. ${what} went to ${screen}.`,
    };
  }
  return {
    toast: `${order}: ${what} went to ${screen}. No kitchen screen is set for ${it}.`,
    title: 'No kitchen screen for an item',
    body: `${order}: ${what} went to ${screen}. Set a kitchen screen for ${it} in Back Office, Production printing. If this till shows Sync now, tap it.`,
  };
}
