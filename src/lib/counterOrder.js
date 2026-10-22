// src/lib/counterOrder.js
//
// COUNTER COLLECT (22 Oct 2026, v5.11.95). PURE, tested in counterOrder.test.js.
//
// Peter, with a venue about to go live: "we need a collection option on the kiosk that can be
// renamed - this needs to work on the QR codes also but not online ordering ... need to be able
// to say collect at counter - this needs to trigger a message to say your order is ready to
// collect at the counter". Named "Counter collect".
//
// THE SETTINGS sit where each channel is set up (Peter, 22 Oct 2026: "it needs to be on the kiosk
// settings to turn on for kiosk"), each with its own words:
//   * Kiosk: per kiosk, Back Office Kiosk settings, Customer flow. device_profiles
//     .kiosk_counter_collect + .kiosk_label_counter_collect (migration 20261028a).
//   * QR: per venue, Back Office Online ordering, inside QR ordering, saved with the page.
//     platform locations.online_branding.collection { qr, label }, through location-admin
//     patch_branding (whitelisted there; the page's own Save sends it).
// 5.11.95 kept both in one box on the Online ordering page; that box is gone.
//
// THE ORDER books as DINE IN with no table, on the kiosk and on the counter link alike. Peter,
// 22 Oct 2026: "collect at counter should be treated as dine in also for all tax reasons":
//   Table ordering     dine in     (QR table link, the till's tables)
//   Counter collect    dine in     (this: 'dine-in', no table)
//   Collection         takeaway    (online ordering; the VAT key maps collection to takeaway,
//                                   _vat_order_type_key on the server, the same on the till)
//   Takeaway           takeaway
// So price and VAT are the dine in ones, exactly as a kiosk "eat in, sit anywhere" order today.
// On the kiosk that is also what keeps the card path guard (kioskCardPathGuard.test.js) byte for
// byte: submitOrder and the totals already write 'dine-in' for eat in with no table. Only the
// words on the screens change, and the ready text (supabase/functions/_shared/counterCollect.js)
// says "ready to collect at the counter". Online ordering's own Collection is untouched.
//   * Kiosk: a third tile next to Eat in and Take away, with the venue's name for it.
//   * QR: the counter link <slug>.serv-os.app/counter opens straight onto it. No table, paid
//     before it is sent, only while the venue is open. It is source 'online', so it never opens
//     a table on the floor. Table QR codes are unchanged.

export const COUNTER_PATH = '/counter';
export const COUNTER_TYPE = 'dine-in';
export const COUNTER_DEFAULT_LABEL = 'Counter collect';
export const COUNTER_LABEL_MAX = 40;

/** The name a guest sees: the venue's own, else "Counter collect". */
export function counterLabel(raw) {
  const s = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim().slice(0, COUNTER_LABEL_MAX) : '';
  return s || COUNTER_DEFAULT_LABEL;
}

/**
 * The venue's Counter collect QR from a platform locations row (or its online_branding).
 * Off unless switched on: a venue that never saved it sees nothing new.
 */
export function counterCollect(row) {
  const branding = row && typeof row === 'object' && 'online_branding' in row ? row.online_branding : row;
  const c = branding && typeof branding === 'object' ? branding.collection : null;
  const o = c && typeof c === 'object' ? c : {};
  return { qr: o.qr === true, label: counterLabel(o.label) };
}

/** A kiosk's own Counter collect tile, from its device_profiles row. Off before 20261028a runs. */
export function kioskCounterCollect(profile) {
  const p = profile && typeof profile === 'object' ? profile : {};
  return { on: p.kiosk_counter_collect === true, label: counterLabel(p.kiosk_label_counter_collect) };
}

/** The words as saved: tidied, at most 40 characters, blank as null (the default then shows). */
export function counterLabelToSave(label) {
  const s = typeof label === 'string' ? label.replace(/\s+/g, ' ').trim().slice(0, COUNTER_LABEL_MAX) : '';
  return s || null;
}

/** The patch Online ordering's Save sends to location-admin patch_branding. */
export function counterCollectPatch({ qr = false, label = '' } = {}) {
  return { collection: { qr: qr === true, label: counterLabelToSave(label) } };
}

/** The words and icon the online page shows for an order type. */
export function orderTypeChip(type, { counterLabel: name = null } = {}) {
  if (type === COUNTER_TYPE && name) return { icon: '🛎', label: name };
  if (type === 'delivery') return { icon: '🚴', label: 'Delivery' };
  if (type === 'dine-in') return { icon: '🍽', label: 'Dine-in' };
  if (type === 'takeaway') return { icon: '🥡', label: 'Take away' };
  return { icon: '🥡', label: 'Collection' };
}

/** The tipping rule a page reads: the counter link sits in Back Office's QR box, so it reads 'qr'. */
export function tipModuleFor({ counter = false } = {}) {
  return counter ? 'qr' : 'online';
}
