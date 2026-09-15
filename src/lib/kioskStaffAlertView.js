/**
 * kioskStaffAlertView.js: what the tills show for a kiosk card problem (the stay on screen
 * staff alert, components/KioskStaffAlert.jsx).
 *
 * Pure: NO imports, so node:test can load it (kioskStaffAlertView.test.js). Nothing here throws.
 *
 * The kiosk writes one urgent activity event when its card screen asks the customer to fetch
 * staff (lib/kioskPay.js kioskStaffAlert):
 *   ref_type 'kiosk_payment', ref_id <reference>,
 *   body '<device> · <amount> · Ref <reference> · <cause>: <raw detail>' sliced to 500 characters.
 * Causes: unreachable (never reached the reader), unconfirmed (reached the reader, result
 * unknown), notSaved (card paid, order did not save). The staff words below must agree with
 * what the kiosk told the customer (i18n k2.card.unreachable / unconfirmed / notSaved).
 */

export const KIOSK_ALERT_REF_TYPE = 'kiosk_payment';
/** A till that starts (or reconnects) shows unacknowledged kiosk alerts from this long ago. */
export const KIOSK_ALERT_RESTORE_MS = 15 * 60 * 1000;
/** Most alerts kept waiting on a till. The oldest go first when there are more. */
export const KIOSK_ALERT_QUEUE_MAX = 20;

const SEP = ' · ';
const BODY_MAX = 500;
const DEVICE_MAX = 60;

const str = (v) => (typeof v === 'string' ? v : (v === null || v === undefined ? '' : String(v)));

/**
 * One activity event in a single shape, from a database row (ref_type, created_at, ...) or a
 * lib/activity.js event (refType, createdAt, ...). Returns null for anything that is not an object.
 * key is the id, or a stand in when a row has no id, so a queue can always tell alerts apart.
 */
export function kioskAlertEvent(input) {
  try {
    if (!input || typeof input !== 'object') return null;
    const id = str(input.id).trim() || null;
    const refType = str(input.ref_type ?? input.refType).trim() || null;
    const refId = str(input.ref_id ?? input.refId).trim() || null;
    const createdAt = str(input.created_at ?? input.createdAt).trim() || null;
    const ackedAt = str(input.acked_at ?? input.ackedAt).trim() || null;
    return {
      id,
      key: id || `kiosk:${refId || ''}:${createdAt || ''}`,
      refType,
      refId,
      title: str(input.title),
      body: str(input.body),
      severity: str(input.severity) || null,
      createdAt,
      ackedAt,
    };
  } catch {
    return null;
  }
}

/** Whether an event (row or event shape) is a kiosk card problem alert. */
export function isKioskStaffAlert(input) {
  const ev = kioskAlertEvent(input);
  return !!ev && ev.refType === KIOSK_ALERT_REF_TYPE;
}

// An amount as money() writes it (£16.00, $1.50, €0.00), allowing other ways of writing money.
function looksLikeMoney(text) {
  const s = str(text).trim();
  if (!s || !/\d/.test(s)) return false;
  const bare = s.replace(/[£$€¥₹]/g, '').replace(/\b[A-Z]{3}\b/g, '').trim();
  return /^[-\u2212]?\d[\d.,\s\u00a0\u202f']*$/.test(bare);
}

// '<cause>: <raw>' -> { cause, raw }. A cause is one plain word starting lower case, so a raw
// message such as 'TypeError: Failed to fetch' is never read as a cause.
function splitCause(tail) {
  const t = str(tail);
  const m = t.match(/^([a-z][A-Za-z]*)?:\s?([\s\S]*)$/);
  if (m) return { cause: m[1] || '', raw: m[2] };
  return { cause: '', raw: t };
}

/**
 * The parts of a kiosk alert body. Never throws; a part it cannot find comes back ''.
 * A device name may contain ' · ' (the amount is the part just before ' · Ref '), the raw
 * detail may contain anything, and the body may have been cut at 500 characters (truncated).
 */
export function parseKioskAlertBody(body) {
  const out = { deviceName: '', amountText: '', reference: '', cause: '', raw: '', truncated: false };
  try {
    const text = str(body);
    if (!text.trim()) return out;
    out.truncated = text.length >= BODY_MAX;

    let head = '';
    let tail = '';
    let refAt = text.indexOf(`${SEP}Ref `);
    let refStart = refAt + SEP.length + 4;
    if (refAt < 0 && text.startsWith('Ref ')) { refAt = 0; refStart = 4; }

    if (refAt >= 0) {
      head = text.slice(0, refAt);
      const afterRef = text.slice(refStart);
      const cut = afterRef.indexOf(SEP);
      out.reference = (cut >= 0 ? afterRef.slice(0, cut) : afterRef).trim();
      tail = cut >= 0 ? afterRef.slice(cut + SEP.length) : '';
      const parts = head.split(SEP);
      const last = parts.length > 1 ? parts[parts.length - 1] : null;
      if (last !== null && (!last.trim() || looksLikeMoney(last))) {
        out.amountText = last.trim();
        out.deviceName = parts.slice(0, -1).join(SEP).trim();
      } else if (parts.length === 1 && looksLikeMoney(head)) {
        out.amountText = head.trim();
      } else {
        out.deviceName = head.trim();
      }
    } else {
      // No reference in the text (cut short, or written some other way): device first, then
      // the amount when the next part is money, and whatever is left is the cause and detail.
      const parts = text.split(SEP);
      out.deviceName = (parts.shift() || '').trim();
      if (parts.length && (looksLikeMoney(parts[0]) || !parts[0].trim())) out.amountText = parts.shift().trim();
      tail = parts.join(SEP);
      if (!tail && splitCause(out.deviceName).cause && /:/.test(out.deviceName)) {
        // A body that is only '<cause>: <detail>'.
        tail = out.deviceName;
        out.deviceName = '';
      }
    }

    const { cause, raw } = splitCause(tail);
    out.cause = cause.trim();
    out.raw = raw.trim();
    return out;
  } catch {
    return out;
  }
}

// Known technical messages, in plain words for staff. First match wins.
// notCharged: true ONLY for a setup refusal the payment server returns BEFORE it asks any
// processor or reader for money (no reader set up, no merchant account, kiosk not paired). Only
// then can staff be told the card was not charged. A network error, a timeout, an offline reader
// or a sign in failure can happen after the reader was already asked, so those never say it
// (review finding, 15 Sep 2026: "unreachable" alone does not prove the reader was never asked).
const KNOWN_DETAIL = [
  { re: /no network reader is assigned/i, text: 'No card reader set up for this kiosk. Set one up in Back Office, Card readers.', notCharged: true },
  { re: /no card terminal is available/i, text: 'No card reader set up for this kiosk. Set one up in Back Office, Kiosks, Settings.', notCharged: true },
  { re: /(is set to another till|none is set to this till)/i, text: 'No card reader is set to this kiosk. Choose one in Back Office, Card readers.', notCharged: true },
  { re: /(reader rejected|confirm the reader is online|reader is offline|reader.{0,20}not online)/i, text: 'The card reader did not answer. Check it is switched on and online.' },
  { re: /(merchant (stripe )?account not linked|cannot accept charges yet|no adyen account|onboarding incomplete)/i, text: 'Card payments are not set up for this venue yet.', notCharged: true },
  { re: /(device id missing|re-?pair this kiosk|pos device not found)/i, text: 'This kiosk needs to be paired again.', notCharged: true },
  { re: /(could not obtain auth token|unauthori[sz]ed|invalid token)/i, text: 'The kiosk could not sign in to take card payments.' },
  { re: /(failed to fetch|networkerror|network request failed|load failed|internet connection appears to be offline)/i, text: 'The kiosk could not connect to the internet.' },
  { re: /timed? ?out/i, text: 'The card reader took too long to answer.' },
];

function knownDetail(raw) {
  try {
    const text = str(raw);
    if (!text.trim()) return null;
    return KNOWN_DETAIL.find(k => k.re.test(text)) || null;
  } catch {
    return null;
  }
}

/** Plain words for a known technical message, or '' when it is not one we know. */
export function explainKioskAlertDetail(raw) {
  const hit = knownDetail(raw);
  return hit ? hit.text : '';
}

/** True only when the message is a setup refusal made before any card was asked for money. */
export function kioskAlertDetailProvesNotCharged(raw) {
  const hit = knownDetail(raw);
  return !!(hit && hit.notCharged);
}

// True when an amount written as money() writes it is zero (£0.00). '' is not zero.
function isZeroAmount(text) {
  const digits = str(text).replace(/[^\d.,]/g, '');
  if (!/\d/.test(digits)) return false;
  return !/[1-9]/.test(digits);
}

const CAUSES = { unreachable: 'unreachable', unconfirmed: 'unconfirmed', notsaved: 'notSaved' };

/** 'unreachable' | 'unconfirmed' | 'notSaved' | 'unknown' */
export function normaliseKioskAlertCause(cause) {
  return CAUSES[str(cause).trim().toLowerCase()] || 'unknown';
}

// Staff words for each cause. They agree with the customer's card screen (i18n k2.card.*).
const CHECK_FIRST = 'Check the card reader or the payments list before you take payment again.';
const COPY = {
  // Customer saw: "We couldn't reach the card reader." The order was never placed. Whether the
  // card was charged is only certain for a setup refusal (NOT_CHARGED_ACTION below).
  unreachable: { headline: "Kiosk can't take cards", reason: "It couldn't reach the card reader.", action: `The order was not placed. ${CHECK_FIRST}` },
  // Customer saw: "We couldn't confirm your payment. Please don't pay again until a member of staff has checked."
  unconfirmed: { headline: 'Kiosk payment not confirmed', reason: 'The card may or may not have been charged.', action: CHECK_FIRST },
  // Customer saw: "Your payment went through but we couldn't save your order."
  notSaved: { headline: 'Kiosk order not saved', reason: 'The card was paid but the order did not save.', action: 'Put the order through on a till. Do not charge the card again.' },
  // A cause this version does not know: the safe rule, check before any second charge.
  unknown: { headline: 'Kiosk payment needs staff', reason: 'A customer at the kiosk needs help to pay.', action: CHECK_FIRST },
};
// unreachable with a setup refusal: the payment server refused before asking for any money.
const NOT_CHARGED_ACTION = 'The card was not charged and the order was not placed. Put it through on a till.';
// notSaved with nothing to pay by card (codes covered it): no card payment exists.
const NOT_SAVED_NOTHING_CHARGED = { reason: 'The order did not save. Nothing was charged on a card.', action: 'Put the order through on a till.' };

/** How long ago, in plain words: 'just now', '4 min ago', '2 hr ago'. '' when unknown. */
export function kioskAlertAge(createdAt, now = Date.now()) {
  try {
    const t = new Date(str(createdAt)).getTime();
    const n = Number(now);
    if (!str(createdAt) || !Number.isFinite(t) || !Number.isFinite(n)) return '';
    const s = Math.max(0, (n - t) / 1000);
    if (s < 60) return 'just now';
    const m = Math.floor(s / 60);
    if (m < 60) return `${m} min ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h} hr ago`;
    const d = Math.floor(h / 24);
    return d === 1 ? '1 day ago' : `${d} days ago`;
  } catch {
    return '';
  }
}

// Technical detail for the small details line: dashes and arrows used as punctuation read as
// commas, and a detail cut at 500 characters ends with an ellipsis.
function tidyDetail(raw, truncated) {
  let d = str(raw).replace(/\s+/g, ' ').trim();
  if (!d || d === 'no details') return '';
  d = d.replace(/\s*[\u2192]\s*/g, ', ').replace(/\s+[-\u2013\u2014]\s+/g, ', ').replace(/[\u2013\u2014]/g, ', ').replace(/,\s*,/g, ',');
  return truncated ? `${d.replace(/[.\s]+$/, '')}…` : d;
}

function clip(text, max) {
  const t = str(text).trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/**
 * The alert a till shows for one kiosk alert event (row or event shape).
 * Returns {
 *   id, key, cause, headline, lines: [reason, action], amountText, reference, deviceName,
 *   detail, createdAt, age, summary
 * }
 * deviceName is '' when the kiosk has no name of its own ('Kiosk'). detail is the technical
 * message for the small details line ('' when there is none). Never throws.
 */
export function kioskStaffAlertView(input, { now = Date.now() } = {}) {
  const base = COPY.unknown;
  const fallback = {
    id: null, key: 'kiosk:', cause: 'unknown', headline: base.headline, lines: [base.reason, base.action],
    amountText: '', reference: '', deviceName: '', detail: '', createdAt: null, age: '',
    summary: `${base.headline}. ${base.reason} ${base.action}`,
  };
  try {
    const ev = kioskAlertEvent(input);
    if (!ev) return fallback;
    const parsed = parseKioskAlertBody(ev.body);
    const cause = normaliseKioskAlertCause(parsed.cause);
    const copy = COPY[cause];
    const known = explainKioskAlertDetail(parsed.raw);
    // A known setup problem replaces the general reason only when the reader was never reached
    // (or the cause is unknown). For unconfirmed and notSaved the money rule is what matters.
    let reason = (cause === 'unreachable' || cause === 'unknown') && known ? known : copy.reason;
    let action = copy.action;
    if (cause === 'unreachable' && kioskAlertDetailProvesNotCharged(parsed.raw)) action = NOT_CHARGED_ACTION;
    if (cause === 'notSaved' && isZeroAmount(parsed.amountText)) {
      reason = NOT_SAVED_NOTHING_CHARGED.reason;
      action = NOT_SAVED_NOTHING_CHARGED.action;
    }
    const lines = [reason, action];
    const reference = clip(ev.refId || parsed.reference, 24);
    const device = clip(parsed.deviceName, DEVICE_MAX);
    const deviceName = device.toLowerCase() === 'kiosk' ? '' : device;
    const amountText = clip(parsed.amountText, 20);
    const facts = [amountText ? `Order ${amountText}` : '', reference ? `ref ${reference}` : ''].filter(Boolean).join(', ');
    return {
      id: ev.id,
      key: ev.key,
      cause,
      headline: copy.headline,
      lines,
      amountText,
      reference,
      deviceName,
      detail: tidyDetail(parsed.raw, parsed.truncated),
      createdAt: ev.createdAt,
      age: kioskAlertAge(ev.createdAt, now),
      summary: `${copy.headline}. ${lines.join(' ')}${facts ? ` ${facts.charAt(0).toUpperCase()}${facts.slice(1)}.` : ''}`,
    };
  } catch {
    return fallback;
  }
}

const timeOf = (ev) => {
  const t = new Date(str(ev && ev.createdAt)).getTime();
  return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
};

/**
 * The waiting alerts after one event arrives (a live insert, an update, or a restored row).
 *   queue      the current list of events (kioskAlertEvent shape), oldest first
 *   input      the row or event
 *   now        ms, for the restore window
 *   dismissed  a Set of keys this till already closed with OK (never shown again here)
 * An acknowledged event leaves the queue (an OK on any till clears every till). A known event
 * is updated where it is. A new one joins in time order when it is unacknowledged, a kiosk
 * alert and no older than the restore window. Returns the same array when nothing changed.
 */
export function kioskAlertQueueAdd(queue, input, { now = Date.now(), dismissed = null, windowMs = KIOSK_ALERT_RESTORE_MS, max = KIOSK_ALERT_QUEUE_MAX } = {}) {
  const list = Array.isArray(queue) ? queue : [];
  try {
    const ev = kioskAlertEvent(input);
    if (!ev || ev.refType !== KIOSK_ALERT_REF_TYPE) return list;
    if (ev.ackedAt) return kioskAlertQueueRemove(list, ev.key);
    const idx = list.findIndex(q => q && q.key === ev.key);
    if (idx >= 0) {
      const cur = list[idx];
      const same = ['title', 'body', 'refId', 'createdAt', 'severity'].every(k => cur[k] === ev[k]);
      if (same) return list;
      const next = list.slice();
      next[idx] = ev;
      return next;
    }
    if (dismissed && typeof dismissed.has === 'function' && dismissed.has(ev.key)) return list;
    const t = timeOf(ev);
    if (Number.isFinite(t) && Number.isFinite(Number(now)) && Number(now) - t > windowMs) return list;
    const next = [...list, ev].sort((a, b) => {
      const ta = timeOf(a);
      const tb = timeOf(b);
      return ta === tb ? 0 : (ta < tb ? -1 : 1);
    });
    return next.length > max ? next.slice(next.length - max) : next;
  } catch {
    return list;
  }
}

/** The waiting alerts without the one with this key. Returns the same array when absent. */
export function kioskAlertQueueRemove(queue, key) {
  const list = Array.isArray(queue) ? queue : [];
  if (!key) return list;
  return list.some(q => q && q.key === key) ? list.filter(q => q && q.key !== key) : list;
}
