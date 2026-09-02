// src/lib/collectionLabel.js
//
// One way to say WHEN an order is for, everywhere a customer or a cook reads it.
//
// order_queue.collection_time is a bare "HH:MM" and always was, so a pre-order
// for tomorrow read "Ready around 12:45" on the SMS, "Collection at 12:45" on
// the tracker and "12:45" on the kitchen ticket, and nobody could tell it was
// not today. Since v5.8.16 the online checkout also stores the full instant on
// customer.collection_at. This helper prefers that and falls back to the label.
//
//   today        -> "12:45"
//   tomorrow     -> "Tomorrow 12:45"
//   later        -> "Thu 4 Sep, 12:45"
//   HH:MM only   -> "12:45"           (no day known, assume today)
//
// Dates are compared in the VENUE timezone, never the device clock.

function ymd(d, tz) { return d.toLocaleDateString('en-CA', { timeZone: tz }); }

export function collectionInstant(source) {
  if (!source) return null;
  if (source instanceof Date) return Number.isNaN(source.getTime()) ? null : source;
  if (typeof source === 'number') { const d = new Date(source); return Number.isNaN(d.getTime()) ? null : d; }
  const s = String(source).trim();
  if (/^\d{1,2}:\d{2}$/.test(s)) return null;           // bare HH:MM: no day
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function collectionLabel(source, tz = 'Europe/London', now = new Date()) {
  const inst = collectionInstant(source);
  if (!inst) {
    const s = String(source || '').trim();
    return /^\d{1,2}:\d{2}$/.test(s) ? s : (s || '');
  }
  const time = inst.toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });
  const today = ymd(now, tz);
  const that = ymd(inst, tz);
  if (that === today) return time;
  const tomorrow = ymd(new Date(now.getTime() + 24 * 3600 * 1000), tz);
  if (that === tomorrow) return `Tomorrow ${time}`;
  const day = inst.toLocaleDateString('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' });
  return `${day}, ${time}`;
}

/** Prefer the stored instant on the order, else the HH:MM label. */
export function orderCollectionLabel(order, tz, now) {
  const c = order?.customer || {};
  return collectionLabel(c.collection_at || order?.collection_at || order?.collectionTime || order?.collection_time, tz, now);
}
