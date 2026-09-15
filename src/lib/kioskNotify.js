/**
 * kioskNotify.js: the order text rules for the new kiosk design, mirrored from the
 * order-notify edge function (supabase/functions/order-notify/index.ts) so they are tested.
 *
 * Decision 9: "Text me when it's ready" sends the READY text only. So for an order from a
 * kiosk on the new design, order-notify skips the 'confirmed' event and sends only 'ready',
 * with a short order number and no name (decision 8). Every other order (old design kiosks,
 * online, QR, POS) is unchanged.
 *
 * The edge function cannot import this file (Deno), so kioskNotify.test.js reads the
 * function's source and checks the same skip text and ready wording are in it.
 *
 * Pure: no imports.
 */

/** The skip reason order-notify returns for a new design kiosk's 'confirmed' event. */
export const KIOSK_READY_ONLY = 'kiosk new design sends the ready text only';

/**
 * The short number customers read, a mirror of db.js shortOrderRef:
 * "R1247" becomes "47", "R7" stays "7", anything that is not R and digits is unchanged.
 */
export function shortRef(ref) {
  if (typeof ref !== 'string') return ref;
  const m = /^R(\d+)$/.exec(ref);
  if (!m) return ref;
  return m[1].length > 2 ? m[1].slice(-2) : m[1];
}

/**
 * What order-notify does for one event.
 *   { skip: string|null, shortNumber: boolean }
 * shortNumber: the text uses the short order number and the kiosk ready wording.
 */
export function kioskNotifyPlan({ event, source, kioskNewDesign } = {}) {
  const v2 = source === 'kiosk' && kioskNewDesign === true;
  if (v2 && event === 'confirmed') return { skip: KIOSK_READY_ONLY, shortNumber: false };
  return { skip: null, shortNumber: v2 && event === 'ready' };
}

/** The default ready text for a new design kiosk order. */
export function kioskReadySms(short, venueName) {
  return `Your order ${short} is ready to collect at ${venueName}.`;
}
