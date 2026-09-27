// customerDisplayIdle.js: how long the customer facing display holds a state with no word from
// the till (v5.9.79). Peter, 26 Sep 2026: "the customer display times out in the middle of an
// order, it needs to stay there so the customers can do their loyalty". The display used to drop
// back to the ad slideshow 45 s after the till's last change, even with a basket on screen and a
// customer half way through typing their phone number. The till publishes on every cart change
// and sends idle itself when the order clears or is paid, so an open order holds for as long as
// it is open; the safety net below only catches a till that died mid order.
export const TERMINAL_HOLD_MS = 6500;                 // approved / declined: a thank you, then the slideshow
export const OPEN_ORDER_SAFETY_MS = 20 * 60 * 1000;   // an open basket with a silent till for 20 minutes

/** ms to hold `state` before the display returns to idle on its own; 0 = never (idle already). */
export function displayHoldMs(state) {
  if (state === 'approved' || state === 'declined') return TERMINAL_HOLD_MS;
  if (state === 'active' || state === 'paying') return OPEN_ORDER_SAFETY_MS;
  return 0;
}

// ── The member's loyalty panel (v5.9.91) ──────────────────────────────────────────────────────
// Peter, 27 Sep 2026: "the stamp cards do display on the customer display but only last 15 seconds
// then logs out, it needs to stay on until the end of transaction". The panel cleared after 9 s
// (25 s with a reward). It now stays until the order ends (the till sends idle when the basket is
// cleared or paid, and the display's own safety net above turns an abandoned order idle); only the
// "please try again" message clears itself.
export const LOYALTY_ERROR_HOLD_MS = 8000;

/** ms before the loyalty panel clears on its own; 0 = hold until the order ends. */
export function loyaltyResultHoldMs(result) {
  return result && result.error ? LOYALTY_ERROR_HOLD_MS : 0;
}
