// src/lib/payments/paxAutoCheck.js
//
// WHEN THE CARD SCREEN MAY ASK THE READER WHAT HAPPENED (30 Sep 2026).
//
// PaxTerminal's 'wedged' rescue (v5.7.37) sends adyen-terminal-charge 'result', a nexo
// TransactionStatusRequest, 8 s into any Adyen job still 'charging' or 'unknown', and then every
// 10 s. That was written for a screen that only ever mounted AFTER the tender, when 'charging'
// really did mean the sync call had died. With kickRace.js the screen now mounts while the
// customer is still paying, so on about half of all sales that timer would fire mid PIN entry,
// and its 'unknown' or unreachable branches can cancel a live tender.
//
// So the rescue is gated here, in one pure rule the tests can pin:
//   - not an Adyen job, or not charging/unknown        never
//   - the till's own kick has settled (answered or failed)   yes: 'charging' now means wedged
//   - the kick is still running                         only 130 s or more after dispatched_at,
//                                                       past Adyen's own 120 s cardholder window
//                                                       with margin, when a tender cannot be live
//
// Peter's bar (9 Sep): never abort a live tender. The poll of terminal-job-status is the truth.

export const KICK_SETTLE_LIMIT_MS = 130_000;

/**
 * @param {object} p
 * @param {string} p.status        the job's current status
 * @param {string} p.processor     'adyen' | 'ryft' | ...
 * @param {boolean} p.kickPending  the till's own 'start' call has not answered yet
 * @param {number|string|Date|null} p.dispatchedAt  when the job went to the reader (dispatched_at,
 *                                 or created_at / the screen's mount time when that is not known)
 * @param {number} p.now           the till's clock (same source as dispatchedAt)
 */
export function shouldAutoCheckReader({ status, processor, kickPending, dispatchedAt, now } = {}) {
  if (processor !== 'adyen') return false;
  if (status !== 'charging' && status !== 'unknown') return false;
  if (!kickPending) return true;
  const t = toMs(dispatchedAt);
  const n = toMs(now);
  if (!Number.isFinite(t) || !Number.isFinite(n)) return false;
  return n - t >= KICK_SETTLE_LIMIT_MS;
}

function toMs(v) {
  if (v == null) return NaN;
  if (typeof v === 'number') return v;
  if (v instanceof Date) return v.getTime();
  const n = new Date(v).getTime();
  return Number.isFinite(n) ? n : NaN;
}
