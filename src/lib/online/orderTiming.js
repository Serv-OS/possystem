// src/lib/online/orderTiming.js
//
// ONLINE ORDER TIMING (5.12.34, Peter: "we should steal this" of Toast's ordering header). PURE,
// tested in orderTiming.test.js.
//
// The menu page now owns the customer's timing choice (ASAP or Schedule for later, with the slot)
// and hands it to OnlineCheckout, which reads and writes it through props. Before this the choice
// lived only in checkout step 1. One state, one slot rule (collectionSlots.js), one set of words.
//
//   timing = { mode: 'asap' | 'scheduled', slot: { iso, day, label } | null }

/** The venue's flat lead time. A missing column is 30, as the checkout has always read it;
 *  an explicit 0 stays 0 (the venue said "no wait"). */
export function leadMinutesFor(location) {
  const raw = location?.online_collection_lead_min;
  return Number.isFinite(Number(raw)) ? Number(raw) : 30;   // the checkout's own expression, unchanged
}

/** How far ahead the venue takes orders. 0 = today only, blank = 7 (v5.8.18 rule). */
export function advanceDaysFor(location) {
  const raw = location?.online_advance_days;
  if (raw === null || raw === undefined || raw === '' || !Number.isFinite(Number(raw))) return 7;
  return Math.max(0, Number(raw));
}

/** The timing the page starts on. A closed venue taking orders ahead starts on Schedule. */
export function initialTiming({ orderAheadOnly = false } = {}) {
  return { mode: orderAheadOnly ? 'scheduled' : 'asap', slot: null };
}

/**
 * Settle a timing against the slot list it must come from.
 *   - orderAheadOnly forces 'scheduled' (ASAP is never offered while closed).
 *   - 'scheduled' with no slot takes the first; a slot the list no longer offers moves to the
 *     first, with moved: true so the checkout can say so.
 *   - 'asap' keeps its slot untouched (the picker remembers it if they switch back).
 * Returns the SAME object when nothing changes, so React state only moves when it must.
 */
export function settleTiming(timing, slots, { orderAheadOnly = false } = {}) {
  const t = timing && typeof timing === 'object' ? timing : initialTiming({ orderAheadOnly });
  const list = Array.isArray(slots) ? slots : [];
  let next = t;
  if (orderAheadOnly && next.mode !== 'scheduled') next = { ...next, mode: 'scheduled' };
  if (next.mode === 'scheduled' && list.length) {
    const stillThere = next.slot && list.some((s) => s.iso === next.slot.iso);
    if (!next.slot) next = { ...next, slot: list[0] };
    else if (!stillThere) next = { ...next, slot: list[0], moved: true };
  }
  return next;
}

/** "30 to 35 min": the quoted minutes to five more. The busy figure comes in already uplifted. */
export function prepRangeWords(minutes) {
  const m = Math.max(0, Math.round(Number(minutes) || 0));
  return `${m} to ${m + 5} min`;
}

/** The pickup word: UK English for a sterling venue, Pickup everywhere else. */
export function pickupWord(location) {
  return String(location?.currency || 'GBP').toUpperCase() === 'GBP' ? 'Collection' : 'Pickup';
}

/**
 * The timing row on the header block.
 *   ASAP:       "ASAP, ready in 30 to 35 min" (", busy" when the kitchen uplift is on)
 *   Scheduled:  "Scheduled, Today 18:15"; with no slot yet "Schedule for later"
 *   Closed, order ahead, nothing picked: "Order ahead, pick a time"
 */
export function timingRowWords(timing, { minutes = 0, busy = false, orderAheadOnly = false, delivery = false } = {}) {
  const mode = timing?.mode === 'scheduled' ? 'scheduled' : 'asap';
  if (mode === 'scheduled') {
    const s = timing?.slot;
    if (s && s.day && s.label) return `Scheduled, ${s.day} ${s.label}`;
    return orderAheadOnly ? 'Order ahead, pick a time' : 'Schedule for later';
  }
  const verb = delivery ? 'delivered' : 'ready';
  return `ASAP, ${verb} in ${prepRangeWords(minutes)}${busy ? ', busy' : ''}`;
}

/** The order type pill's words. One type on offer reads "<word> only"; the counter keeps its name. */
export function orderTypePillWords(orderType, { types = [], counterLabel = null, location = null } = {}) {
  if (counterLabel) return counterLabel;
  const pickup = pickupWord(location);
  const word = orderType === 'delivery' ? 'Delivery' : pickup;
  const count = Array.isArray(types) ? types.length : 0;
  return count <= 1 ? `${word} only` : word;
}

/** The order type choices for the in place sheet, in the venue's words. */
export function orderTypeChoices(types, location) {
  const pickup = pickupWord(location);
  return (Array.isArray(types) ? types : []).map((t) => ({
    id: t.id,
    label: t.id === 'delivery' ? 'Delivery' : pickup,
    desc: t.id === 'delivery' ? 'Brought to your door' : 'Collect at the venue',
  }));
}

/** The location row in two parts: the lead ("Collection from ") and the bold part (the address,
 *  the delivery address once entered, else the venue's name). Never blank. */
export function locationRowParts({ orderType, address = '', deliveryAddress = '', location = null } = {}) {
  if (orderType === 'delivery') {
    const a = String(deliveryAddress || '').trim();
    return a ? { lead: 'Delivery to ', bold: a } : { lead: 'Delivery to ', bold: 'your address' };
  }
  const a = String(address || '').trim();
  const word = pickupWord(location);
  return { lead: `${word} from `, bold: a || String(location?.name || 'the venue').trim() };
}

/** The location row as one line: "Collection from <address>" or "Delivery to <address>". */
export function locationRowWords(args) {
  const p = locationRowParts(args);
  return `${p.lead}${p.bold}`;
}
