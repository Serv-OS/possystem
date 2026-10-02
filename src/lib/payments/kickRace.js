// src/lib/payments/kickRace.js
//
// THE TILL STOPS WAITING FOR THE WHOLE CARD PAYMENT BEFORE IT SHOWS THE CARD SCREEN (30 Sep 2026).
//
// Since v5.6.86 sendTerminalJob awaited its own 'start' call to adyen-terminal-charge. That call
// is the reader's whole /sync tender: it only answers once the customer has tapped, put in a PIN
// or given up. So the checkout sat on its first page showing "Sending…" for the entire payment,
// with the × and Cash buttons live and NOTHING watching the job. Coffee Boy Huddersfield, 30 Sep:
// staff closed the checkout 17 s in, the reader approved £11.65, the till's reconciler booked
// R5737 in the background (no kitchen ticket, cart still on screen), staff rang it again as a new
// check and the customer paid twice (R5739, refunded).
//
// The fix is to WAIT A LITTLE, NOT THE WHOLE TENDER. raceKick lets the kick answer for up to
// waitMs (a refusal the fn answers at once, such as 503 not configured or 409 not paired, still
// comes back the way it always did). Past that the send returns with the kick still running, the
// checkout mounts the card screen and the poll of terminal-job-status becomes the truth, exactly
// as it is when the server's own kick wins the claim.
//
// RULES
//  - The kick is NEVER aborted. Aborting the fetch would not stop the reader, it would only blind
//    the till to the answer. The promise settles on its own and the card screen reads it late.
//  - A late TRANSPORT failure (no HTTP status, the till lost the network) is ignored: the poll
//    already knows what happened to the job.
//  - A late REFUSAL the fn answered (an HTTP status) is still shown, because the server's own
//    kick hits the same wall 1.5 s later.
//
// Pure: no React, no network. The kick is any promise; timers are injectable for tests.

/** How long the send waits for the kick to answer before handing the wait to the card screen. */
export const KICK_WAIT_MS = 3000;

/**
 * Turn the settled 'start' call into what the till needs to know.
 *   null / undefined       the kick was accepted
 *   IN_FLIGHT / in_flight  another kick (the server's, another till's) won the claim: not an error
 *   anything else          kickError is the message; kickAnswered says whether the fn ANSWERED it
 *                          (an HTTP status) or the till never reached the fn at all
 */
export function classifyKickOutcome(err) {
  if (err == null) return { kickError: null, kickAnswered: false };
  if (err?.code === 'IN_FLIGHT' || err?.message === 'in_flight') return { kickError: null, kickAnswered: false };
  const kickError = err?.message || String(err);
  return { kickError, kickAnswered: !!err?.status, status: err?.status ?? null, detail: err?.detail ?? null };
}

/**
 * Race an already running kick against the wait. `kick` is a promise that settles to the kick's
 * outcome (see classifyKickOutcome) and never rejects.
 *
 * Resolves to
 *   { pending: false, ...outcome }   the kick answered inside waitMs
 *   { pending: true }                it did not. The kick keeps running, untouched.
 */
export function raceKick(kick, waitMs = KICK_WAIT_MS, { setTimeout: setT = globalThis.setTimeout, clearTimeout: clearT = globalThis.clearTimeout } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; clearT(timer); resolve(v); };
    const timer = setT(() => finish({ pending: true }), Math.max(0, Number(waitMs) || 0));
    Promise.resolve(kick).then(
      (outcome) => finish({ pending: false, ...(outcome || { kickError: null, kickAnswered: false }) }),
      // The kick promise is built never to reject; if something does, treat it as an unanswered
      // failure and let the poll decide. Never a throw out of a payments race.
      (e) => finish({ pending: false, ...classifyKickOutcome(e) }),
    );
  });
}

/**
 * Wrap the raw 'start' call: resolves to classifyKickOutcome(...) and never rejects. Kept apart from
 * raceKick so a caller can hand the same settled outcome promise to the card screen.
 */
export function settleKick(startCall) {
  return Promise.resolve(startCall).then(() => classifyKickOutcome(null), (e) => classifyKickOutcome(e));
}
