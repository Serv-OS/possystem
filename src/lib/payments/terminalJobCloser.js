// src/lib/payments/terminalJobCloser.js
//
// WHICH DEVICE BOOKS A SALE THE CARD MACHINE APPROVED, AND WITH WHICH REF (28 Sep 2026).
//
// TerminalJobReconciler books an approved terminal job on whichever device gets there first:
// closed_checks' primary key (the job's pre-minted closed_check_id) elects one writer. Until
// this release every device that mounts SyncBridge polled every ~8 s and booked at once: the
// till, both kitchen screens at Coffee Boy Leeds, any Back Office tab. The till's own checkout
// screen books the same sale about a second after approval, and it lost that race on 204 of
// Leeds' 318 reader sales (25 to 27 Sep): 161 to a device that was not the till at all. The
// record that lost was the till's, so the database kept a ref from another device's order ref
// lease (R6577 in History, 53 on the kitchen ticket and the receipt) and none of the till's
// loyalty or promo tenders.
//
// Two rules fix it, both here so they are tested without a browser:
//
//  1. WHO BOOKS (closeWaitMs). The till that sent the job (terminal_jobs.pos_device_id) books it
//     at once, except while its own checkout screen is watching the job: that screen books the
//     full record, so the reconciler waits WATCHED_LIMIT_MS for it and then books anyway. Any
//     other till waits OTHER_TILL_WAIT_MS; a kitchen screen or a Back Office tab waits
//     FALLBACK_WAIT_MS. A job no till sent (Pay at table on the reader) books at once on any
//     till. A host stand never books (it cannot write the money tables). Every wait counts from
//     when THIS device first saw the job approved, on its own clock; no device's clock is ever
//     compared with another's. So a paid job is still never stranded (v5.5.862): while any
//     device at the venue is running, one of them books it.
//
//  2. WHICH REF (checkoutOrderRef, usableOrderRef). The checkout freezes the order ref into the
//     job when it sends it (check_draft.orderRef), and every writer books that ref: the checkout
//     screen, and the reconciler on any device. A walk in that already went to the kitchen keeps
//     the ref its ticket shows. A draft from an older till has no ref and the writer mints one,
//     exactly as before.

export const WATCHED_LIMIT_MS = 30_000;
export const OTHER_TILL_WAIT_MS = 30_000;
export const FALLBACK_WAIT_MS = 90_000;

const HOST_MODES = new Set(['waitlist', 'bookings']);
const OFFICE_MODES = new Set(['backoffice', 'office']);

/**
 * Is this device a kitchen screen? The URL mode, the paired device's type, or the App.jsx rule
 * for a till whose profile opens on the KDS (a profile named counter, bar or server is a till).
 */
export function isKitchenScreen({ mode, pairedType, deviceConfig } = {}) {
  if (mode === 'kds' || pairedType === 'kds') return true;
  if (deviceConfig?.defaultSurface !== 'kds') return false;
  const name = String(deviceConfig?.profileName || '').toLowerCase();
  return !name.includes('counter') && !name.includes('bar') && !name.includes('server');
}

/** 'till' | 'kitchen' | 'office' | 'host' for the device running the reconciler. */
export function closerRole({ mode, pairedType, deviceConfig } = {}) {
  if (HOST_MODES.has(mode)) return 'host';
  if (OFFICE_MODES.has(mode)) return 'office';
  if (isKitchenScreen({ mode, pairedType, deviceConfig })) return 'kitchen';
  return 'till';
}

/**
 * How long this device waits, from its own first sight of the approved job, before booking it.
 * 0 = now, Infinity = never.
 */
export function closeWaitMs(job, { role = 'till', myDeviceId = null, watchedHere = false } = {}) {
  if (role === 'host') return Infinity;
  const sender = job?.pos_device_id ? String(job.pos_device_id) : null;
  let wait;
  if (sender && myDeviceId && sender === String(myDeviceId)) wait = 0;
  else if (role === 'kitchen' || role === 'office') wait = FALLBACK_WAIT_MS;
  else wait = sender ? OTHER_TILL_WAIT_MS : 0;
  // This device's checkout screen is watching the job: it books the full record itself.
  return watchedHere ? Math.max(wait, WATCHED_LIMIT_MS) : wait;
}

/** Has this device waited long enough? Both times come from this device's own clock. */
export function isDue(waitMs, firstSeenAt, now) {
  if (!Number.isFinite(waitMs)) return false;
  if (waitMs <= 0) return true;
  return Number.isFinite(firstSeenAt) && Number.isFinite(now) && now - firstSeenAt >= waitMs;
}

/** When this device first saw each approved job. Jobs no longer approved are forgotten. */
export function createSightings() {
  const seen = new Map();
  return {
    see(id, now) {
      if (!seen.has(id)) seen.set(id, now);
      return seen.get(id);
    },
    keepOnly(ids) {
      const keep = new Set(ids);
      for (const id of [...seen.keys()]) if (!keep.has(id)) seen.delete(id);
    },
    size() { return seen.size; },
  };
}

// ── The checkout screen's watch ─────────────────────────────────────────────
// PaxTerminal (the till's view of a job it sent) marks the job watched while it is on screen,
// so this device's own reconciler leaves the booking to it. A count, not a flag: a remount of
// the same job must not clear the mark the other mount still holds.
const _watched = new Map();

/** Mark a job watched by this device's checkout screen. Returns the function that unmarks it. */
export function watchTerminalJob(jobId) {
  if (!jobId) return () => {};
  const id = String(jobId);
  _watched.set(id, (_watched.get(id) || 0) + 1);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const n = (_watched.get(id) || 0) - 1;
    if (n > 0) _watched.set(id, n); else _watched.delete(id);
  };
}

// 30 Sep 2026: THE CHECKOUT WATCHES ITS CHECK BEFORE ANY JOB EXISTS. PaxTerminal's mark above only
// goes on when the card screen mounts, and until kickRace.js that was after the whole tender. In the
// gap this till's own reconciler booked the sale in the background 0.1 s after approval (48 sales,
// 25 to 30 Sep, and the R5737/R5739 double charge at Huddersfield). CheckoutModal now marks its check
// id watched at the START of startTerminalJob, before the gift commit and the create call, and
// releases it on unmount. Same counted mark, keyed on closed_check_id, which the job row carries.
const _watchedChecks = new Map();

/** Mark a check watched by this device's checkout. Returns the function that unmarks it. */
export function watchCheckout(closedCheckId) {
  if (!closedCheckId) return () => {};
  const id = String(closedCheckId);
  _watchedChecks.set(id, (_watchedChecks.get(id) || 0) + 1);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const n = (_watchedChecks.get(id) || 0) - 1;
    if (n > 0) _watchedChecks.set(id, n); else _watchedChecks.delete(id);
  };
}

/** Is this device's checkout watching the job (by job id, or by the check it belongs to)? */
export function isWatchedHere(jobId, closedCheckId = null) {
  if (jobId && _watched.has(String(jobId))) return true;
  return !!closedCheckId && _watchedChecks.has(String(closedCheckId));
}

// ── Adopting a sale booked after the checkout closed ────────────────────────
// 30 Sep 2026, Huddersfield: staff closed the checkout during a slow tender, the reader approved,
// this till's reconciler booked R5737 in the background, and the cart stayed on screen with no
// kitchen ticket, so it was rung again. When THIS till books ITS OWN unwatched send to terminal
// job, and the walk in on screen is the very order the job was sent for (the checkout freezes the
// order ref into the draft and stamps it on the walk in), the cart is cleared and a sticky banner
// says so. A cart that does not match is never cleared: a different order is a different sale.

/** The sticky banner's words. Peter's wording, no dashes. */
export function adoptedSaleBanner({ ref, amount }) {
  return `Card approved after the checkout closed: ${ref} ${amount} is booked. Do not take payment again.`;
}

/**
 * @param {object} p
 * @param {object} p.job          the terminal_jobs row that was booked
 * @param {object|null} p.booked  what closeApprovedTerminalJob returned ({ booked, created, ref, ... })
 * @param {string|null} p.myDeviceId
 * @param {boolean} p.watchedHere the checkout was watching this job when it booked (then it finishes it)
 * @param {string|null} p.walkInRef  the ref of the walk in order on this till's screen, if any
 * @param {(minor:number, currency:string) => string} p.fmt  money formatter
 * @returns {{ clearWalkIn: boolean, banner: string|null }}
 */
export function adoptBookedSale({ job, booked, myDeviceId = null, watchedHere = false, walkInRef = null, fmt } = {}) {
  const none = { clearWalkIn: false, banner: null };
  if (!booked?.booked || !job) return none;
  if (watchedHere) return none;                                       // the checkout books and clears it
  const d = job.check_draft || {};
  if (d.source !== 'pos_send_to_terminal') return none;               // Pay at table clears its table itself
  const sender = job.pos_device_id ? String(job.pos_device_id) : null;
  if (!sender || !myDeviceId || sender !== String(myDeviceId)) return none;   // only the till that sent it
  const ref = booked.ref || usableOrderRef(d.orderRef) || null;
  const amount = typeof fmt === 'function'
    ? fmt(Number(job.charge_minor) || 0, job.currency || 'GBP')
    : `${((Number(job.charge_minor) || 0) / 100).toFixed(2)}`;
  const banner = adoptedSaleBanner({ ref: ref || 'The sale', amount });
  const draftRef = usableOrderRef(d.orderRef);
  const clearWalkIn = !d.tableId && !!draftRef && !!walkInRef && String(walkInRef) === String(draftRef);
  return { clearWalkIn, banner };
}

// ── The ref ─────────────────────────────────────────────────────────────────

/**
 * The order ref a checkout freezes into the card machine job it sends. A walk in that already
 * went to the kitchen keeps its ref (the ticket shows it); a bar tab uses the TAB- form its own
 * close books; anything else takes the next number from this till's lease (`mint`).
 */
export function checkoutOrderRef({ isBarTab = false, walkInRef = null, mint } = {}) {
  if (!isBarTab && usableOrderRef(walkInRef)) return walkInRef;
  const fresh = String(mint());
  return isBarTab ? 'TAB-' + fresh.replace(/^R/, '') : fresh;
}

/** The ref as a writer may book it, or null (absent, blank, or not a plausible ref). */
export function usableOrderRef(ref) {
  return typeof ref === 'string' && ref.trim() !== '' && ref.length <= 40 ? ref : null;
}
