// supabase/functions/_shared/counterCollect.js
//
// COUNTER COLLECT (22 Oct 2026, v5.11.97): which order the ready text sends to the counter.
// Pure, no Deno: imported by order-notify and tested from src/lib/counterOrder.test.js.
// The setting and the order are described in src/lib/counterOrder.js.
//
// Every kiosk order the customer collects is picked up at the counter: take away, the Counter
// collect tile (which books as take away) and eat in with no table. Eat in at a table never gets
// a text (lib/kioskCheckout.js kioskTextAllowed), so the counter wording is true for every kiosk
// text. A web order is Counter collect only when the counter link marked it
// (customer.counter_collect), so online ordering's own Collection keeps its own text.

export function isCounterCollectOrder(order) {
  if (!order) return false;
  const type = String(order.type || '');
  if (type === 'delivery' || type === 'drive-thru') return false;
  if (String(order.source || '') === 'kiosk') {
    const c = order.customer && typeof order.customer === 'object' ? order.customer : {};
    return !(type === 'dine-in' && String(c.tableNumber || c.table || order.table_label || '').trim());
  }
  const c = order.customer && typeof order.customer === 'object' ? order.customer : {};
  return c.counter_collect === true;
}

/** The ready text's fallback wording when the company has no template of its own. */
export function counterReadyText({ firstName = '', ref = '', shortRef = null, venueName = '' } = {}) {
  const at = venueName ? ` at ${venueName}` : '';
  if (shortRef) return `Your order ${shortRef} is ready to collect at the counter${at}.`;
  const hi = firstName ? `Hi ${firstName}, your` : 'Your';
  return `${hi} order #${ref} is ready to collect at the counter${at}.`;
}
