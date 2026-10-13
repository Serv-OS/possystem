// supabase/functions/_shared/readerLock.js
//
// A CARD MACHINE IS NEVER LEFT LOCKED BY A PAYMENT IT NEVER HAD (13 Oct 2026).
//
// Pure decisions only. No I/O, no Deno, no Supabase: imported by adyen-terminal-charge
// ('start', 'result', the riders inside 'sweep_unsent'), by _shared/repeatCharge.js (the busy
// words) and by the Back Office release helper (src/lib/payments/readerRelease.js), and unit
// tested from src/lib/payments/readerLock.test.js under plain node. Keep it that way.
//
// THE INCIDENT (Coffee Boy Huddersfield, Drive Thru, 13 Oct 2026, job df9c6528). 07:37:49 a
// 6.00 payment was sent. The reader never received it. Two status asks ran into our own 30 s
// limit and ended as HTTP 500, deciding nothing. At 07:41:39 the reader answered "not found" and
// the job was put BACK to "not sent yet", which still locks the reader and which nothing re
// sends after 100 s. It sat until the 5 minute lease ran out: 310 s with every Pay press on
// that till refused, four till restarts and one reader restart, none of which could help
// because the lock is the job row on the server. No money moved. Nobody was told.
//
// WHY "NOT FOUND" IS NOT PROOF BY ITSELF (15 Aug 2026, jobs 7908d1ab and a742204b). The reader
// answered "not found" 25 s and 28 s after the send, and Adyen APPROVED each payment 5 s later:
// the request was still on its way to the reader. So while the send is still open with Adyen,
// "not found" decides nothing, and nothing may ever send the payment again because of it.
//
// THE RULE (neverReceivedVerdict). A job is cancelled as "never received" only when ALL hold:
//   a) the reader answered NotFound for THIS attempt's service id,
//   b) Adyen's ledger was read with no error and has no row for the job,
//   c) EITHER Adyen has already answered this attempt's send with a 2xx that is not a payment
//      answer (the "send ended" marker 'start' writes), OR 155 s have passed since the send.
// Anything less leaves the job as it is and the reader is asked again. Every failure (a marker
// that cannot be read, a ledger that cannot be read) falls to the slower, safer path.
//
// WHO ASKS. A till, a person and pay at table ask as before. New: a timer (the every minute
// cron inside 'sweep_unsent') asks about every sent job from 45 s after the send, every 20 s.
// A timer ask is CONSERVATIVE: it never sends an abort and it never cancels a silent reader
// before the send is dead (timerMustWait).
//
// NOTE ON IMPORTS. repeatCharge.js imports the two numbers its busy words need from this file,
// and this file imports the money, time and card formatters from repeatCharge.js. Neither file
// uses the other while it loads (only inside functions), so the pair loads in either order.

import { fmtMoney, fmtTime, fmtCard } from './repeatCharge.js';
import { isLocalBridgeJob } from './terminalKick.js';

/**
 * Our own limit on one status ask to the reader. The number is not new (adyenFetch's default);
 * it is named so the catch around the ask is explicit: a throw here is "could not be reached",
 * never an HTTP 500 and never a decision.
 */
export const STATUS_ASK_TIMEOUT_MS = 30_000;
/**
 * The line for an ask a till or a person makes: a tender is treated as stalled 120 s after the
 * send (Adyen's cardholder window). Unchanged. adyen-terminal-charge keeps its own literal
 * 120_000 on the pinned line; a test holds the two together.
 */
export const TENDER_STALL_MS = 120_000;
/**
 * After this long since the send, no payment for this attempt can still start. Adyen ends a
 * cloud payment request at 150 s; 5 s covers the gap between our dispatched_at stamp and Adyen
 * getting the request. The slowest real approval in 14 days (13,480 reader payments to 13 Oct
 * 2026) was 132.2 s after the send.
 */
export const SEND_DEAD_AFTER_MS = 155_000;
/**
 * The timer's first ask. 99% of real payments finish in under 41.3 s, so the timer never asks
 * about them. The 25 s one shot in terminal-job-create (a lost kick race) stays as it is.
 */
export const READER_ASK_FIRST_MS = 45_000;
/** Then every 20 s: a proof is acted on within 20 s. Three asks per cron minute per stuck job. */
export const READER_ASK_EVERY_MS = 20_000;
/** One cron tick plans the asks for its own minute only; the next tick plans the next minute. */
export const READER_ASK_HORIZON_MS = 60_000;
/** Past the 5 minute lease the database sweep owns the job. Stop asking. */
export const READER_ASK_MAX_SINCE_SEND_MS = 320_000;
/** Jobs asked about per run. */
export const READER_ASK_LIMIT = 20;
/** When a send ends with no payment answer, ask the reader once, this long after. */
export const SEND_ENDED_ASK_AFTER_MS = 3_000;
/**
 * What staff are told: a payment the reader never had clears by itself within this long of the
 * send. The 155 s line plus one 20 s ask gap, rounded up.
 */
export const BUSY_CLEARS_AFTER_MS = 180_000;
/** The late money watch looks at jobs that ended cancelled or expired this recently... */
export const LATE_MONEY_WINDOW_MS = 24 * 60 * 60 * 1000;
/** ...and at most this many a run, newest first. */
export const LATE_MONEY_LIMIT = 50;
/** terminal_jobs.decline_reason on a proven never received cancel (the till shows it). */
export const NEVER_RECEIVED_REASON = 'The card machine never received this payment, so nothing was charged';
/** terminal_jobs.last_error on the same cancel: the text used since v5.7.37, kept so old searches still work. */
export const NEVER_RECEIVED_ERROR = 'terminal never received the payment (Adyen: not found)';

function ms(v) {
  if (v == null) return NaN;
  if (typeof v === 'number') return v;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : NaN;
}

// ── The "send ended" marker ──────────────────────────────────────────────────
// 'start' is one long call to Adyen. When it ends WITHOUT a payment answer, 'start' writes one
// row in platform adyen_webhook_events under this key (the key is the table's primary key, so
// it is written once per attempt). It also keeps Adyen's raw answer, which is how the question
// "how did the send end" is answered next time.

/** The marker's key: one per job AND attempt, so an old attempt's marker never speaks for a new one. */
export function sendEndedKey(jobId, serviceId) {
  return `send-ended:${jobId}:${serviceId}`;
}

/**
 * The marker row.
 *   'answered_no_payment'  Adyen answered 2xx with no payment answer: Adyen has finished with
 *                          this send. The ONLY kind that counts as proof (answered true).
 *   'adyen_error'          any other HTTP answer on the "unknown outcome" exit: not proof.
 *   'no_answer'            our own call threw (timeout, network): not proof.
 * Adyen's answer is kept as JSON text cut to 2000 characters. No key or token is ever in it.
 */
export function sendEndedRecord({ how, httpStatus = null, body = null, error = null, now = Date.now() } = {}) {
  let adyen = null;
  if (body != null) {
    try { adyen = String(JSON.stringify(body) ?? '').slice(0, 2000); } catch { adyen = null; }
  }
  return {
    at: new Date(Number.isFinite(ms(now)) ? ms(now) : Date.now()).toISOString(),
    how: String(how ?? ''),
    answered: how === 'answered_no_payment',
    http_status: Number.isFinite(Number(httpStatus)) && httpStatus != null ? Number(httpStatus) : null,
    adyen,
    error: error == null ? null : String(error).slice(0, 300),
  };
}

/**
 * Does a marker row say Adyen has finished with the send? A missing, unreadable or odd marker
 * is "no": the caller then waits for SEND_DEAD_AFTER_MS instead.
 */
export function sendAnswered(markerRaw) {
  return !!markerRaw && typeof markerRaw === 'object'
    && markerRaw.answered === true && markerRaw.how === 'answered_no_payment';
}

/**
 * The reader said NotFound for this attempt. Is that PROOF the payment never reached it?
 *   ledger not read OK, or any row for the job   { proven: false, why: 'ledger_unclear' }
 *   Adyen has answered the send (marker)         { proven: true,  by: 'send_answered' }
 *   155 s or more since the send                 { proven: true,  by: 'send_dead' }
 *   else                                         { proven: false, why: 'not_found_waiting' }
 * @param {object} p
 * @param {boolean} p.ledgerReadOk     the ledger read returned with no error
 * @param {number}  p.ledgerRowCount   rows Adyen's ledger holds for tj-<job>
 * @param {boolean} p.sendAnswered     sendAnswered(marker for THIS service id)
 * @param {number|null} p.sinceSendMs  ms since dispatched_at (null or NaN = not known = not dead)
 */
export function neverReceivedVerdict({ ledgerReadOk, ledgerRowCount, sendAnswered: answered, sinceSendMs } = {}) {
  if (ledgerReadOk !== true || ledgerRowCount !== 0) return { proven: false, why: 'ledger_unclear' };
  if (answered === true) return { proven: true, by: 'send_answered' };
  if (typeof sinceSendMs === 'number' && sinceSendMs >= SEND_DEAD_AFTER_MS) return { proven: true, by: 'send_dead' };
  return { proven: false, why: 'not_found_waiting' };
}

/**
 * A reader that gives no usable answer with an empty ledger is cancelled by a till or a person
 * from 120 s (today's rule). A TIMER (conservative) ask must wait until the send is dead. An
 * unknown time since the send is "not dead yet".
 */
export function timerMustWait({ conservative, sinceSendMs } = {}) {
  if (conservative !== true) return false;
  return !(typeof sinceSendMs === 'number' && sinceSendMs >= SEND_DEAD_AFTER_MS);
}

/**
 * The asks one cron tick plans for one job: delays in ms from now, for the ask times
 * READER_ASK_FIRST_MS + k * READER_ASK_EVERY_MS (measured since the send) that fall inside the
 * next READER_ASK_HORIZON_MS and not past READER_ASK_MAX_SINCE_SEND_MS. Ticks are a minute
 * apart, so each ask time is planned by one tick; a doubled or a missed ask is harmless.
 * @param {{ sinceSendMs: number }} p
 * @returns {number[]}
 */
export function planReaderAsks({ sinceSendMs } = {}) {
  if (typeof sinceSendMs !== 'number' || !Number.isFinite(sinceSendMs)) return [];
  const out = [];
  for (let at = READER_ASK_FIRST_MS; at <= READER_ASK_MAX_SINCE_SEND_MS; at += READER_ASK_EVERY_MS) {
    const delay = at - sinceSendMs;
    if (delay < 0) continue;
    if (delay >= READER_ASK_HORIZON_MS) break;
    out.push(delay);
  }
  return out;
}

/**
 * Which jobs the timer asks the reader about, and when. Only an Adyen job that was really sent
 * (status 'charging' with a service id and a dispatched_at), never simulated or training, and
 * NEVER a job the device drives itself over the local nexo bridge (isLocalBridgeJob, the same
 * signals the unsent sweep uses). Oldest send first, bounded by limit.
 *
 * @param {Array<object>} jobs            terminal_jobs rows (re checked here)
 * @param {object} opts
 * @param {number} [opts.now]             epoch ms
 * @param {Map|Record} [opts.terminalsById] terminal_devices rows keyed by id: { id, device_uid }
 * @param {Map|Record} [opts.devicesById]   devices rows keyed by id: { id, device_uid }
 * @param {number} [opts.limit]           default READER_ASK_LIMIT
 * @returns {Array<{ id: string, delays: number[] }>}
 */
export function selectReaderAskJobs(jobs, { now = Date.now(), terminalsById, devicesById, limit = READER_ASK_LIMIT } = {}) {
  const pick = (map, id) => (id == null ? null : (map instanceof Map ? map.get(id) : map?.[id]) ?? null);
  const eligible = [];
  for (const job of Array.isArray(jobs) ? jobs : []) {
    if (!job || typeof job !== 'object' || !job.id) continue;
    if (job.processor !== 'adyen') continue;
    if (job.status !== 'charging') continue;
    if (typeof job.nexo_service_id !== 'string' || !job.nexo_service_id) continue;
    if (job.simulated === true || job.training === true) continue;
    const sent = ms(job.dispatched_at);
    if (!Number.isFinite(sent)) continue;
    if (isLocalBridgeJob({
      checkDraft: job.check_draft,
      terminalDeviceUid: pick(terminalsById, job.target_terminal_id)?.device_uid ?? null,
      posDeviceUid: pick(devicesById, job.pos_device_id)?.device_uid ?? null,
    })) continue;
    const delays = planReaderAsks({ sinceSendMs: now - sent });
    if (!delays.length) continue;
    eligible.push({ id: job.id, sent, delays });
  }
  eligible.sort((a, b) => a.sent - b.sent);
  const max = Number.isFinite(Number(limit)) ? Math.max(0, Math.floor(Number(limit))) : READER_ASK_LIMIT;
  return eligible.slice(0, max).map(({ id, delays }) => ({ id, delays }));
}

// ── Words (plain English, no dashes as punctuation; money by fmtMoney, times on the venue clock) ──

/** A time rounded UP to the whole minute (epoch ms), or NaN. "By about 07:41" must not be early. */
export function roundUpToMinute(v) {
  const t = ms(v);
  return Number.isFinite(t) ? Math.ceil(t / 60_000) * 60_000 : NaN;
}

/** When a payment the reader never had clears by itself: the send plus BUSY_CLEARS_AFTER_MS, rounded up to the minute (epoch ms, or NaN). */
export function busyClearsAtMs(sentAt) {
  const t = ms(sentAt);
  return Number.isFinite(t) ? roundUpToMinute(t + BUSY_CLEARS_AFTER_MS) : NaN;
}

/** "2 minutes 36 seconds", "36 seconds", "1 hour 2 minutes". '' when the time is not known. */
export function heldWords(heldMs) {
  if (heldMs == null || !Number.isFinite(Number(heldMs)) || Number(heldMs) < 0) return '';
  const total = Math.round(Number(heldMs) / 1000);
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return [plural(h, 'hour'), m ? plural(m, 'minute') : ''].filter(Boolean).join(' ');
  if (m > 0) return [plural(m, 'minute'), s ? plural(s, 'second') : ''].filter(Boolean).join(' ');
  return plural(s, 'second');
}

/** "the Drive Thru card machine"; a label that already says what it is ("Reader 1") stands alone. */
function readerWords(label) {
  const name = String(label ?? '').replace(/\s+/g, ' ').trim();
  if (!name) return 'the card machine';
  if (/reader|card machine|terminal/i.test(name)) return name;
  return `the ${name} card machine`;
}

/** The key of the one activity note a job gets when the server cancels it as not taken. */
export const noPaymentNoteKey = (jobId) => `reader-no-payment:${jobId}`;

/**
 * The activity note for a payment the server cancelled because the card machine never took it.
 * Severity 'action' pops a toast with a chime on every till at the venue (src/lib/realtime.js),
 * which is how staff learn the card machine is free again.
 * @param {object} p
 * @param {'never_received'|'no_answer'} p.kind
 * @returns {{ title: string, body: string, severity: 'action' }}
 */
export function noPaymentNote({ kind, amountMinor, currency, sentAt, tz, ref, tableLabel, readerLabel, heldMs } = {}) {
  const amt = fmtMoney(amountMinor, currency);
  const forWhat = tableLabel ? `for ${tableLabel}` : 'for the order';
  const when = fmtTime(sentAt, tz);
  const sent = `${amt} ${forWhat} was sent to ${readerWords(readerLabel)}${when ? ` at ${when}` : ''}.`;
  const held = heldWords(heldMs);
  const cancelled = `The payment was cancelled${held ? ` after ${held}` : ''} and the card machine is free.`;
  const body = kind === 'never_received'
    ? `${sent} The card machine never received it. Nothing was charged. ${cancelled} Take the payment again.`
    : `${sent} The card machine did not answer and Adyen has no record of a payment. Nothing was charged. ${cancelled} `
      + 'Check the card machine is on and online, then take the payment again.';
  return { title: `Card machine did not take ${amt}${ref ? ` (${ref})` : ''}`, body, severity: 'action' };
}

/** The key of the one urgent note a job gets when Adyen shows money for a payment we cancelled. */
export const lateMoneyAlertKey = (jobId) => `late-money:${jobId}`;

/**
 * The urgent note for a job that ended cancelled or expired and that Adyen shows as PAID. The
 * watch never changes the job and never books a sale: a person is told, once, and decides.
 * @returns {{ title: string, body: string, severity: 'urgent' }}
 */
export function lateMoneyAlert({ amountMinor, currency, card, paidAt, tz, ref } = {}) {
  const amt = fmtMoney(amountMinor, currency);
  const cardText = fmtCard(card);
  const when = fmtTime(paidAt, tz);
  return {
    title: `Card payment taken after it was cancelled: ${amt}`,
    body: `Adyen shows the card machine took ${amt}${cardText ? ` (${cardText})` : ''} ${ref ? `for order ${ref}` : 'for an order'}${when ? ` at ${when}` : ''}. `
      + 'The till had already cancelled that payment as not charged, so no sale was recorded. '
      + 'If the customer also paid another way, refund this card payment in Adyen. If they did not, record the sale by hand.',
    severity: 'urgent',
  };
}
