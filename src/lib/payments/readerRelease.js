// src/lib/payments/readerRelease.js
//
// WHAT BACK OFFICE SAYS AFTER "RELEASE STUCK PAYMENT" (13 Oct 2026).
//
// Pure: no I/O, no React. AdyenTerminals.jsx does the reads and the calls; this file only turns
// what came back into the lines a manager reads, so `npm test` can pin every sentence.
//
// THE INCIDENT (Coffee Boy Huddersfield, Drive Thru, 13 Oct 2026). A manager pressed Release at
// 07:41:18 for a card machine held by a payment it never received. Release only called the
// database function release_terminal_jobs, which never touches a payment that was sent to the
// card machine, so it said "Nothing was stuck" and the till stayed locked until 07:43.
//
// THE ORDER NOW (in AdyenTerminals.jsx, pinned by readerLockWiring.test.js):
//   1. read the live payments on that card machine,
//   2. for each Adyen payment that was sent ('charging'): ask the server what happened
//      (adyen-terminal-charge 'result', with the manager's own sign in). The SERVER settles it
//      from the card machine's answer or cancels it when nothing was charged. This page never
//      writes terminal_jobs,
//   3. call release_terminal_jobs exactly as before,
//   4. read the live payments again,
//   5. say one line per payment, then one closing line (releaseLines below).
//
// THE TWO RULES OF THE WORDS. Never say the card machine can take payments again while a live
// payment remains. Give a reason for every payment that was not released.
//
// Plain English, no dashes as punctuation. Money by fmtMoney, times on the venue clock.

import { fmtMoney, fmtTime } from '../../../supabase/functions/_shared/repeatCharge.js';
import {
  TENDER_STALL_MS, BUSY_CLEARS_AFTER_MS, NEVER_RECEIVED_REASON, roundUpToMinute,
} from '../../../supabase/functions/_shared/readerLock.js';

/** Statuses that hold a card machine (the one live payment per card machine index). */
export const RELEASE_LIVE_STATUSES = Object.freeze(['claimed', 'tipping', 'charging_unsent', 'charging']);
/** The columns the page reads for each live payment. */
export const RELEASE_JOB_COLUMNS = 'id, status, processor, charge_minor, due_minor, currency, dispatched_at, created_at, check_draft';

const PAID = ['approved', 'reconciled'];
const NOT_CHARGED = ['cancelled', 'expired'];

function ms(v) {
  if (v == null) return NaN;
  if (typeof v === 'number') return v;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : NaN;
}

/** The payments Release asks the card machine about: Adyen payments that were really sent. */
export function jobsToAsk(liveJobs) {
  return (Array.isArray(liveJobs) ? liveJobs : [])
    .filter((j) => j && j.id && j.processor === 'adyen' && j.status === 'charging');
}

/**
 * What one ask came to.
 *   paid | declined | cancelled (reason)   the server settled it
 *   never_received_old                     an older server version: 409 with safe true
 *   waiting (why, retryAfter, clearsBy)    still open on the card machine, with the reason
 *   failed (reason)                        the ask itself did not work
 * @param {{ httpStatus?: number, body?: any, error?: string|null }} ask
 */
export function askOutcome(ask) {
  const status = Number(ask?.httpStatus) || 0;
  const body = ask?.body && typeof ask.body === 'object' ? ask.body : null;
  if (ask?.error) return { kind: 'failed', reason: String(ask.error) };
  if (status === 409 && body?.safe === true) return { kind: 'never_received_old' };
  if (status < 200 || status >= 300) return { kind: 'failed', reason: String(body?.error || `HTTP ${status}`) };
  const waiting = { kind: 'waiting', why: typeof body?.why === 'string' ? body.why : null, retryAfter: body?.retry_after ?? null, clearsBy: body?.clears_by ?? null };
  if (body?.state === 'processing') return waiting;
  if (body?.ok === true && typeof body.job_status === 'string') {
    if (PAID.includes(body.job_status)) return { kind: 'paid' };
    if (body.job_status === 'declined') return { kind: 'declined' };
    if (NOT_CHARGED.includes(body.job_status)) return { kind: 'cancelled', reason: body.decline_reason ? String(body.decline_reason) : null };
    return waiting;   // an answer about a payment that is still open
  }
  return { kind: 'failed', reason: 'the answer was not understood' };
}

const amountOf = (job) => fmtMoney(job?.charge_minor ?? job?.due_minor, job?.currency);
const sentAtOf = (job) => job?.dispatched_at ?? job?.created_at ?? null;
/** "£6.00 sent at 07:37" */
function whatOf(job, tz) {
  const when = fmtTime(sentAtOf(job), tz);
  return `${amountOf(job)}${when ? ` sent at ${when}` : ''}`;
}
const noFullStop = (s) => String(s ?? '').trim().replace(/[.\s]+$/, '');

/** A clock time for "after 07:40" or "by about 07:41": rounded up to the minute, '' when past or unknown. */
function futureTime(at, now, tz) {
  const t = roundUpToMinute(at);
  if (!Number.isFinite(t) || t <= now) return '';
  return fmtTime(t, tz);
}

function waitingLine(job, o, { tz, now }) {
  const what = whatOf(job, tz);
  const sent = ms(sentAtOf(job));
  const retry = futureTime(o.retryAfter ?? (Number.isFinite(sent) ? sent + TENDER_STALL_MS : null), now, tz);
  const clears = futureTime(o.clearsBy ?? (Number.isFinite(sent) ? sent + BUSY_CLEARS_AFTER_MS : null), now, tz);
  const clearsLine = clears ? ` It clears by itself by about ${clears}.` : '';
  if (o.why === 'in_progress') {
    return `${what} is on the card machine now and the card machine says the customer is paying. Finish or cancel it on the card machine. Not released.`;
  }
  if (o.why === 'no_answer_yet') {
    return `${what} has had no answer from the card machine yet. It may still be in progress, so it was not released. `
      + `Press Release again ${retry ? `after ${retry}` : 'in a minute'}.${clearsLine}`;
  }
  if (o.why === 'not_found_waiting') {
    return `The card machine says it has not started ${what}, but the request is still open with Adyen and could still appear on the card machine. Not released.${clearsLine}`;
  }
  if (o.why === 'ledger_unclear') {
    return `Adyen's record for ${what} could not be read or needs checking, so it was not released. Try again in a minute, or look in Payments that need checking.`;
  }
  return `${what} could not be confirmed yet, so it was not released. Try again in a minute, or look in Payments that need checking.`;
}

/** The line for a live payment nobody asked about (a PAX payment, or one that started meanwhile). */
function unaskedLine(job, tz) {
  const what = whatOf(job, tz);
  if (job?.status === 'charging_unsent') return `${what} has not gone to the card machine yet. Not released. Try again in a minute.`;
  if (job?.status === 'charging') return `${what} is on the card machine now. Finish or cancel it on the card machine. Not released.`;
  return `${what} is waiting on the card machine. Finish or cancel it on the card machine. Not released.`;
}

/**
 * The lines Back Office shows after Release: one per payment, then one closing line.
 *
 * @param {object} p
 * @param {string} p.label   the card machine's name
 * @param {Array<{ job: object, httpStatus?: number, body?: any, error?: string|null }>} p.asked
 *                           each sent Adyen payment with the server's answer to the ask
 * @param {{ expired?: number, released?: number }|null} p.rpc
 *                           release_terminal_jobs' answer (null when it failed)
 * @param {Array<object>|null} p.still
 *                           the live payments read AFTER the release (null when unreadable)
 * @param {string} p.tz      the venue's time zone
 * @param {number} [p.now]   epoch ms
 * @returns {{ lines: string[], free: boolean }} free is true only when nothing live remains
 */
export function releaseLines({ label, asked, rpc, still, tz, now = Date.now() } = {}) {
  const name = String(label ?? '').trim() || 'The card machine';
  const askedList = (Array.isArray(asked) ? asked : []).filter((a) => a && a.job && a.job.id);
  const known = Array.isArray(still);
  const liveIds = new Set((known ? still : []).map((j) => j?.id));
  const lines = [];

  for (const a of askedList) {
    const what = whatOf(a.job, tz);
    const o = askOutcome(a);
    const stillLive = liveIds.has(a.job.id);
    if (o.kind === 'paid') lines.push(`${what} was paid. It is recorded. Do not take it again.`);
    else if (o.kind === 'declined') lines.push(`${what} was declined. Nothing was charged.`);
    else if (o.kind === 'cancelled') {
      lines.push(o.reason ? `${what}: ${noFullStop(o.reason)}. Released.` : `${what} was cancelled. Nothing was charged. Released.`);
    } else if (o.kind === 'never_received_old') {
      lines.push(stillLive
        ? `The card machine never received ${what}. Nothing was charged. It is not released yet. Press Release again.`
        : `${what}: ${NEVER_RECEIVED_REASON}. Released.`);
    } else if (known && !stillLive) {
      // The ask did not settle it, but it is no longer live (the server's own timer, or the
      // release itself, cleared it between the ask and the second read).
      lines.push(`${what} is no longer holding the card machine.`);
    } else if (o.kind === 'waiting') lines.push(waitingLine(a.job, o, { tz, now }));
    else lines.push(`The card machine could not be asked about ${what} (${noFullStop(o.reason) || 'no answer'}). Not released. Try again.`);
  }

  // Live payments nobody asked about still need a reason.
  const askedIds = new Set(askedList.map((a) => a.job.id));
  for (const j of known ? still : []) {
    if (!j || !j.id || askedIds.has(j.id)) continue;
    lines.push(unaskedLine(j, tz));
  }

  const cleared = (Number(rpc?.expired) || 0) + (Number(rpc?.released) || 0);
  if (cleared > 0) lines.push(`Released ${cleared} stuck payment${cleared === 1 ? '' : 's'}.`);

  if (!known) {
    lines.push(`Could not check if ${name} is free now. Press Release again.`);
    return { lines, free: false };
  }
  if (still.length > 0) {
    lines.push(`${name} is still busy with the payment${still.length > 1 ? 's' : ''} above.`);
    return { lines, free: false };
  }
  lines.push(askedList.length === 0 && cleared === 0 ? `Nothing was stuck on ${name}.` : `${name} can take payments again.`);
  return { lines, free: true };
}
