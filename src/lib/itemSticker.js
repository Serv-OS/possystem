/**
 * itemSticker.js: the words and the counting for "One ticket per item" (sticker mode), 18 Nov 2026.
 *
 * Peter, from a Day Break pizza box label: one sticker per item so the order can be gathered from
 * the stickers alone. Across the top the channel and the order type with "2 of 3"; the customer's
 * name big; the item and its changes; then the time, the date and the order number.
 *
 * PURE. The store counts the run across the WHOLE order here (stickerRuns), so "2 of 3" still
 * gathers one order when its items print at two centres; printDoc.js builds the paper from these
 * words; itemSticker.test.js drives every line.
 */

export const CHANNEL_WORDS = {
  till: 'Till', table: 'Table', bar: 'Bar tab', kiosk: 'Kiosk', online: 'Online ordering', qr: 'QR ordering',
  hubrise: 'Delivery app', catering: 'Catering', ezcater: 'ezCater',
};
export const ORDER_TYPE_WORDS = { 'dine-in': 'Eat in', takeaway: 'Take away', collection: 'Collection', delivery: 'Delivery', 'drive-thru': 'Drive thru' };

const clean = (v) => (v == null ? '' : String(v).trim());
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '');

/** How many stickers a list of lines needs: one per unit, so a qty of 3 is three. Lines the kitchen never sees count nothing. */
export function stickerUnits(items) {
  return (Array.isArray(items) ? items : [])
    .filter(i => i && !i.noKitchen)
    .reduce((n, i) => n + Math.max(1, Math.round(Number(i.qty) || 1)), 0);
}

/** The run for each centre of one order, in order: [{ offset, total }]. The total is the whole order's. */
export function stickerRuns(groups) {
  const counts = (Array.isArray(groups) ? groups : []).map(stickerUnits);
  const total = counts.reduce((a, b) => a + b, 0);
  let offset = 0;
  return counts.map(n => { const run = { offset, total }; offset += n; return run; });
}

/** "Online ordering · Take away", "Deliveroo · Delivery", "Till · Eat in"; the channel alone when the type is unknown. */
export function stickerHeader(meta, delivery = null) {
  const ch = clean(meta?.channel).toLowerCase();
  const appName = clean(delivery?.channel);
  const channel = ch === 'hubrise' && appName ? appName : (CHANNEL_WORDS[ch] || cap(ch));
  const type = ORDER_TYPE_WORDS[clean(meta?.orderType).toLowerCase()] || '';
  return [channel, type].filter(Boolean).join(' · ') || 'Order';
}

/**
 * The big line: the customer's name, else the table as the kitchen ticket says it, else WALK-IN.
 * A kiosk order keeps the kitchen screen's rule (decision 8, lib/kioskStaffFlags.js): its short number,
 * never a name in place of it, so the headline is its label ("Kiosk #47", "Table 12 · #47").
 */
export function stickerHeadline(meta, table) {
  const name = clean(meta?.customerName);
  if (name && clean(meta?.channel).toLowerCase() !== 'kiosk') return name;
  const t = clean(table);
  if (!t) return 'WALK-IN';
  const selfDescribing = / · /.test(t)
    || /^(takeaway|collection|delivery|counter|drive-thru|walk-in)$/i.test(t)
    || /^(online|kiosk|qr|table|hubrise|catering)\s/i.test(t);
  return selfDescribing ? t : `TABLE ${t}`;
}

/** "#26" from the ticket meta's short order number; nothing for a table or a bar tab. */
export function stickerOrderNo(meta) {
  const n = clean(meta?.orderNo);
  if (!n) return '';
  return n.startsWith('#') ? n : `#${n}`;
}

/** "2 of 3" */
export function stickerCount(index, total) {
  const t = Math.max(1, Math.round(Number(total)) || 1);
  const i = Math.min(t, Math.max(1, Math.round(Number(index)) || 1));
  return `${i} of ${t}`;
}

/** Words at the left and more words at the right on one line exactly `cols` wide; the left is cut first. */
export function sideBySide(left, right, cols = 42) {
  const r = clean(right);
  if (!r) return clean(left).slice(0, cols);
  const room = Math.max(0, cols - r.length - 1);
  const l = clean(left).slice(0, room);
  return l + ' '.repeat(Math.max(1, cols - l.length - r.length)) + r;
}
