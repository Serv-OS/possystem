/**
 * kioskPay.js: pure rules for the new kiosk design's card screen (README 7).
 *
 * Pure: NO imports, so node:test can load it (kioskPay.test.js).
 *
 * CARD PATH RULE (owner, non negotiable). The card screen is KioskApp's ScreenPay, unchanged:
 * the same reader start, polling, cancel and submitOrder. These rules only decide what the
 * customer SEES for ScreenPay's own state, and which of ScreenPay's own handlers each button
 * calls. The one behaviour rule here: once a charge might exist (an error after the reader
 * was reached, or a charge that went through but the order did not save) the customer is
 * never offered Try again or Back. They get "Please ask a member of staff" with a reference,
 * so a second charge can never start from this screen (F12).
 */

/**
 * The phase the card screen shows.
 *   cardState     ScreenPay's state: idle | processing | collecting | success | error | declined
 *   total         the amount ScreenPay charges (0 or less: nothing to charge)
 *   submitting    submitOrder is running
 *   submitError   submitOrder's error text (engine.submitError), or null
 *   reachedReader the charge reached the reader in this attempt (cardState was 'collecting')
 * Returns { phase, cause }. phase: connecting | waiting | saving | declined | covered | askStaff.
 * cause for askStaff: notSaved | unconfirmed | unreachable. cause for saving: 'covered' when
 * nothing was charged (so the screen never says "Payment approved"), else null.
 *
 * Covered only while no charge was started (cardState 'idle', which is where ScreenPay stays
 * for a total of 0: it never starts the reader). Once a charge exists (getting ready, waiting
 * for a tap, approved, declined or failed) a total that reads 0 never turns the screen into
 * "covered" with Place order and Back: that would place a second, card free order while the
 * reader can still take the money.
 */
export function kioskCardPhase({ cardState, total = 0, submitting = false, submitError = null, reachedReader = false } = {}) {
  const amount = Number(total);
  const nothingToCharge = !(Number.isFinite(amount) && amount > 0);
  const covered = nothingToCharge && (cardState === 'idle' || cardState == null);
  if (submitError && (cardState === 'success' || covered)) return { phase: 'askStaff', cause: 'notSaved' };
  if (covered) return submitting ? { phase: 'saving', cause: 'covered' } : { phase: 'covered', cause: null };
  if (cardState === 'success') return { phase: 'saving', cause: null };
  if (cardState === 'declined') return { phase: 'declined', cause: null };
  if (cardState === 'error') return { phase: 'askStaff', cause: reachedReader ? 'unconfirmed' : 'unreachable' };
  if (cardState === 'collecting') return { phase: 'waiting', cause: null };
  return { phase: 'connecting', cause: null };
}

/**
 * The amount the card screen is given, fixed when it opens (the freeze rule, belt and braces).
 *   prev    the amount fixed so far, or null
 *   onPay   the card screen is showing
 *   live    kioskChargeTotal(grandTotal) now
 * Returns the fixed amount while the card screen shows (the first live amount it saw), and null
 * once it closes, so the next visit fixes the amount again. Nothing on the card screen can then
 * move the amount ScreenPay shows, charges on Try again or reads as covered.
 */
export function kioskPayTotal(prev, onPay, live) {
  if (!onPay) return null;
  if (prev !== null && prev !== undefined) return prev;
  const n = Number(live);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Whether the charge has reached the reader in this attempt, given the previous answer and
 * ScreenPay's current state. A new attempt ('processing') starts again from false, so a
 * settled decline followed by a reader that cannot be reached says "couldn't reach".
 */
export function nextReachedReader(prev, cardState) {
  if (cardState === 'collecting') return true;
  if (cardState === 'processing') return false;
  return prev === true;
}

/**
 * What each phase shows: i18n keys and which buttons appear.
 *   { titleKey, subKey, visual, showBack, showCancel, actions }
 * visual: 'reader' | 'readerPulse' | 'tick' | 'warning' | 'covered'
 * actions: ordered [{ id, labelKey, kind }] where id is one of
 *   retry (ScreenPay's Try again), back (ScreenPay's back), placeOrder (onPaid),
 *   newOrder (resetSession('staff')). kind: 'primary' | 'secondary'.
 */
export function kioskCardCopy(phase, cause = null) {
  switch (phase) {
    case 'connecting':
      // No Cancel until the reader (or Ryft job) is known ('collecting'). While the start call
      // is in flight there is nothing for ScreenPay's cancel to cancel: the charge would land on
      // the reader after the screen had gone, and a tap would charge with no order. A start that
      // fails lands on "ask a member of staff", so the customer is never stuck here.
      return { titleKey: 'k2.card.connecting', subKey: 'k2.card.connectingSub', visual: 'reader', showBack: false, showCancel: false, actions: [] };
    case 'waiting':
      return { titleKey: 'k2.card.tap', subKey: 'k2.card.tapSub', visual: 'readerPulse', showBack: false, showCancel: true, actions: [] };
    case 'saving':
      // Nothing was charged when codes cover the order, so no "Payment approved".
      return cause === 'covered'
        ? { titleKey: 'k2.card.saving', subKey: 'k2.card.connectingSub', visual: 'covered', showBack: false, showCancel: false, actions: [] }
        : { titleKey: 'k2.card.approved', subKey: 'k2.card.saving', visual: 'tick', showBack: false, showCancel: false, actions: [] };
    case 'declined':
      return {
        titleKey: 'k2.card.declined', subKey: 'k2.card.declinedSub', visual: 'warning', showBack: true, showCancel: true,
        actions: [
          { id: 'retry', labelKey: 'k2.card.tryAgain', kind: 'primary' },
          { id: 'back', labelKey: 'k2.card.backToReview', kind: 'secondary' },
        ],
      };
    case 'covered':
      return {
        titleKey: 'k2.card.covered', subKey: 'k2.card.coveredSub', visual: 'covered', showBack: true, showCancel: true,
        actions: [
          { id: 'placeOrder', labelKey: 'k2.pay.placeOrder', kind: 'primary' },
          { id: 'back', labelKey: 'k2.card.backToReview', kind: 'secondary' },
        ],
      };
    case 'askStaff': {
      const subKey = cause === 'notSaved' ? 'k2.card.notSaved'
        : cause === 'unconfirmed' ? 'k2.card.unconfirmed'
          : 'k2.card.unreachable';
      // No Back and no Try again: either could start a second charge.
      return {
        titleKey: 'k2.card.askStaff', subKey, visual: 'warning', showBack: false, showCancel: false,
        actions: [{ id: 'newOrder', labelKey: 'k2.card.newOrder', kind: 'primary' }],
      };
    }
    default:
      return kioskCardCopy('connecting');
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-/i;

/**
 * The reference the customer reads out to staff, for example K3F9A2C.
 * From the order's check id when submitOrder made one (a uuid gives its first 6 hex
 * characters, anything else its last 6 letters or digits), otherwise from the time the
 * problem happened (6 base 36 characters), so every incident still has a reference.
 */
export function kioskStaffReference({ checkId = null, now = 0 } = {}) {
  if (typeof checkId === 'string' && checkId) {
    if (UUID_RE.test(checkId)) return 'K' + checkId.slice(0, 6).toUpperCase();
    const tail = checkId.replace(/[^A-Za-z0-9]/g, '').slice(-6).toUpperCase();
    if (tail) return 'K' + tail;
  }
  const n = Math.floor(Math.abs(Number(now) || 0) / 1000);
  return 'K' + n.toString(36).toUpperCase().slice(-6).padStart(6, '0');
}

/**
 * The staff only activity event for a card screen that needs staff (the README's
 * staff only diagnostic). Tills keep a kiosk_payment event on screen until staff tap OK
 * (components/KioskStaffAlert.jsx). The till reads this body back (lib/kioskStaffAlertView.js
 * parseKioskAlertBody, with a round trip test), so keep the format in step with it.
 * amountText is already formatted (money()). raw is the technical message.
 */
export function kioskStaffAlert({ deviceName = '', amountText = '', reference = '', cause = '', raw = '' } = {}) {
  const who = String(deviceName || '').trim() || 'Kiosk';
  const detail = String(raw || '').trim() || 'no details';
  return {
    kind: 'ops',
    severity: 'urgent',
    title: 'Kiosk payment needs staff',
    body: `${who} · ${amountText} · Ref ${reference} · ${cause}: ${detail}`.slice(0, 500),
    refType: 'kiosk_payment',
    refId: reference,
  };
}

/**
 * The incident behind an "ask a member of staff" card screen, worked out from the phase the
 * card screen reports. One incident per card screen visit: the reference, the time and the
 * amount are fixed when staff are first needed, so the reference the customer reads out
 * never changes while they wait.
 *   prev    the current incident, or null
 *   report  { phase, cause, raw, total } from the card screen, or null when it closes
 *   now     the time in ms, checkId the order's check id when submitOrder made one
 * Returns the incident ({ at, cause, reference, raw, total }) or null. Returns prev itself
 * when nothing changed, so a caller can tell a new incident (next !== prev && !prev).
 */
export function nextCardIncident(prev, report, { now = 0, checkId = null } = {}) {
  if (!report || report.phase !== 'askStaff') return null;
  const cause = report.cause || 'unreachable';
  if (prev) return prev.cause === cause ? prev : { ...prev, cause };
  return {
    at: Number(now) || 0,
    cause,
    reference: kioskStaffReference({ checkId, now }),
    raw: String(report.raw || ''),
    total: Number(report.total) || 0,
  };
}

/**
 * The local time of an incident for the staff card, 24 hour (for example 14:05), in the
 * venue's time zone when it is known. An unknown zone falls back to the device clock.
 */
export function kioskIncidentTime(at, timeZone = null) {
  const ms = Number(at);
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const opts = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
  try {
    return new Intl.DateTimeFormat('en-GB', timeZone ? { ...opts, timeZone } : opts).format(new Date(ms));
  } catch {
    return new Intl.DateTimeFormat('en-GB', opts).format(new Date(ms));
  }
}

