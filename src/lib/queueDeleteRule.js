// src/lib/queueDeleteRule.js
//
// WHO may write the open orders list (order_queue) and bar tabs (bar_tabs), and WHY a row may be
// deleted (12 Oct 2026). Pure: plain values in, a plain answer out, no storage, no network, so
// node:test pins it (queueDeleteRule.test.js). The thin reader that gathers this page's values is
// lib/queueDevice.js.
//
// What was wrong. sync/QueueSync.js sent a DELETE for any row that was no longer open in this
// device's OWN list, on every device and whatever the cause:
//   - a kitchen screen that heard a till finish an order sent its own delete for it as well, and
//     again from its saved list after every restart (Coffee Boy Barnsley drinks tablet, 12 Oct
//     2026: 32 order_queue deletes in two minutes after its app restarted);
//   - a kitchen screen in kitchen mode holds no bar tabs on purpose (v5.9.72), which the same loop
//     read as "every tab was removed here", so it deleted each open tab it knew of;
//   - a row dropped because the SERVER said so (a delete heard from another till, a catering order
//     moved to a later day) was deleted again by its number, and order numbers are reused over
//     time, so a late delete can hit a newer order.
//
// The rule.
//   1. A page that only READS the list never writes it: no publish, no update, no delete.
//      That is a kitchen screen, a kiosk, a host stand, a display.
//   2. Back Office does not sync the list either. Staff can act there (a refund clears a paid
//      order that was kept on the Orders screen), and only that named action may delete.
//   3. A till (and a handset) deletes a row only with a reason:
//        'delete'          the row left this till's list by an action here (paid, rejected,
//                          voided, removed), or staff marked it collected here in this session.
//        'delete_if_done'  the SERVER already says the row is finished (another device marked it
//                          collected, or it was finished before this app started). It is deleted
//                          only while the server still says finished, so a newer order that
//                          carries the same number can never be removed by it.
//      A row that left because the server removed it needs no delete at all: the caller marks it
//      dropped and it never reaches this rule.

/** Modes whose page is Back Office: staff act there, the list is never synced from there. */
export const QUEUE_OFFICE_MODES = Object.freeze(['office', 'backoffice']);

/**
 * Modes whose page only reads the list (or never loads it). App.jsx returns for every one of them
 * BEFORE the till shell, so none can show a till. 'kds' is not here on purpose: the kitchen app
 * opens the till shell, and what that shell shows decides (queueDeviceRole below).
 */
export const QUEUE_READER_MODES = Object.freeze([
  'kiosk', 'waitlist', 'bookings', 'customer-display', 'owner', 'menuboard', 'orderscreen',
  'readerdemo', 'ops', 'staff', 'manager', 'clock', 'admin',
]);

/** The paired device type (Back Office, Devices) for which App.jsx always shows the kitchen screen. */
export const QUEUE_READER_TYPES = Object.freeze(['kds']);

const OFFICE = new Set(QUEUE_OFFICE_MODES);
const READER_MODE = new Set(QUEUE_READER_MODES);
const READER_TYPE = new Set(QUEUE_READER_TYPES);
const lower = (v) => (typeof v === 'string' ? v.toLowerCase() : '');

/**
 * A profile that boots straight to the kitchen screen. The same test App.jsx uses to show the
 * kitchen body (isKdsDevice): default surface kds, unless the profile is a counter, bar or server
 * till that merely opens on its kitchen view.
 */
export function isKitchenProfile({ defaultSurface, profileName } = {}) {
  if (defaultSurface !== 'kds') return false;
  const name = lower(profileName);
  return !name.includes('counter') && !name.includes('bar') && !name.includes('server');
}

/**
 * This page's part in the open orders list: 'till' | 'office' | 'reader'.
 *   mode            the page's mode word (?mode= or the stored one)
 *   deviceType      the paired device's type (pos, kds, kiosk, handheld, clock)
 *   defaultSurface  the device profile's default surface
 *   profileName     the device profile's name
 * Inside the till shell the answer follows what App.jsx SHOWS: the kitchen screen or the kiosk
 * (a reader), or the till (a till). A page that shows a till is never stopped from sending an
 * order, so anything unknown reads as a till. The other way round costs little: a kitchen screen
 * read as a till has no action of its own, so the reasons below still let it delete nothing live.
 */
export function queueDeviceRole({ mode, deviceType, defaultSurface, profileName } = {}) {
  const m = lower(mode);
  const t = lower(deviceType);
  if (OFFICE.has(m)) return 'office';
  if (READER_MODE.has(m)) return 'reader';
  if (m === 'mpos') return 'till';   // the handset page is a till whatever else storage holds
  if (READER_TYPE.has(t)) return 'reader';
  if (isKitchenProfile({ defaultSurface, profileName })) return 'reader';
  if (defaultSurface === 'kiosk') return 'reader';
  if (m === 'kds' && !t) return 'reader';   // the kitchen app with no pairing to say otherwise
  return 'till';
}

/** May this page's background sync write order_queue and bar_tabs at all? Only a till. */
export function maySyncQueue(role) {
  return role === 'till';
}

/** May a NAMED staff action on this page remove an order (store removeFromQueue)? A till or Back Office. */
export function mayRemoveQueueRow(role) {
  return role === 'till' || role === 'office';
}

/**
 * What the sync sends for an order this device no longer holds open: 'none' | 'delete' |
 * 'delete_if_done'.
 *   role        queueDeviceRole(...)
 *   present     the row is still in this device's list (then it is there as a finished row)
 *   done        that row's status is finished (collected)
 *   pending     that row has a change the server has not confirmed (staff changed it HERE)
 *   doneAtBoot  the row was already finished in the saved list when this app started
 */
export function queueDeleteDecision({ role, present = false, done = false, pending = false, doneAtBoot = false } = {}) {
  if (!maySyncQueue(role)) return 'none';
  if (!present) return 'delete';
  if (!done) return 'none';
  return pending && !doneAtBoot ? 'delete' : 'delete_if_done';
}

/**
 * What the sync sends for a bar tab this device no longer holds: 'none' | 'delete'. A tab id is
 * minted once and never reused, and a closed tab stays in the list as closed, so the only delete
 * is a tab removed on this till.
 */
export function tabDeleteDecision({ role } = {}) {
  return maySyncQueue(role) ? 'delete' : 'none';
}

/**
 * Should a buffered write (sync/OfflineQueue.js) be dropped instead of replayed from this page?
 * Only on a page that is not a till, and only a write the LIST SYNC made: an order_queue or
 * bar_tabs write with no `kind`. A kitchen tablet on an older build buffered a delete for every
 * order and tab it saw finish; one parked while the tablet was not linked would still be sent
 * when it is paired again. Named writes carry a kind (a Back Office refund's 'queue_delete') and
 * are kept. A till keeps everything: its buffered writes are its own orders.
 */
export function dropBufferedQueueWrite({ role, item } = {}) {
  if (maySyncQueue(role)) return false;
  if (!item || (item.table !== 'order_queue' && item.table !== 'bar_tabs')) return false;
  return !item.kind;
}
