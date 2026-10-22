// supabase/functions/_shared/counterCollect.js
//
// COUNTER COLLECT (22 Oct 2026, v5.11.97): which order the ready text sends to the counter.
// Pure, no Deno: imported by order-notify and tested from src/lib/counterOrder.test.js.
// The setting and the order are described in src/lib/counterOrder.js.
//
// A kiosk Counter collect order books as eat in with no table ('dine-in'), and the kiosk's order
// row carries nothing else (its submitOrder is held byte for byte by the card path guard). So a
// kiosk 'dine-in' order reads as Counter collect only at a venue that switched the kiosk tile on
// (online_branding.collection.kiosk): every other venue's kiosk text is exactly as before. A kiosk
// order only carries a phone for the ready text when it has no table (kioskTextAllowed).
// A web order is Counter collect only when the counter link marked it (customer.counter_collect),
// so online ordering's own Collection keeps its own text.

export function isCounterCollectOrder(order, { kioskTileOn = false } = {}) {
  if (!order) return false;
  const type = String(order.type || '');
  if (String(order.source || '') === 'kiosk') return kioskTileOn === true && type === 'dine-in';
  if (type === 'delivery' || type === 'drive-thru') return false;
  const c = order.customer && typeof order.customer === 'object' ? order.customer : {};
  return c.counter_collect === true;
}

/** The venue's kiosk tile switch from its platform locations row (src/lib/counterOrder.js). */
export function kioskTileOn(platformRow) {
  const c = platformRow && platformRow.online_branding && platformRow.online_branding.collection;
  return !!(c && typeof c === 'object' && c.kiosk === true);
}

/** The ready text's fallback wording when the company has no template of its own. */
export function counterReadyText({ firstName = '', ref = '', shortRef = null, venueName = '' } = {}) {
  const at = venueName ? ` at ${venueName}` : '';
  if (shortRef) return `Your order ${shortRef} is ready to collect at the counter${at}.`;
  const hi = firstName ? `Hi ${firstName}, your` : 'Your';
  return `${hi} order #${ref} is ready to collect at the counter${at}.`;
}
