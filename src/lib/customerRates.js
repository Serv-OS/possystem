// customerRates.js: a customer page (online, QR) never sells without the venue's tax rates.
//
// WHY (VAT audit of 8 Oct 2026, Preston QR-4OGI7, 4.85, booked with NO VAT). tax_rates could only
// be read by a signed in session, and OnlineSurface read it in the same breath as the menu,
// before the anonymous sign in had finished. A first time guest got the menu (public) and no
// rates (hidden by the policy, answered as an EMPTY list, not an error), the page worked out no
// VAT, sent tax_amount null, and the server booked what it was sent. The same page opened a second
// time (the session now in storage) got the rates and booked VAT, which is why it looked random.
//
// Peter's rule, 8 Oct 2026: "VAT despite the order type should follow the Tax rules set on the back
// office per menu item." A sale is never saved without VAT when the venue has rates. So:
//   1. the rates are read only AFTER the session exists (loadCustomerRates waits for it);
//   2. an error, and an empty list at a venue whose menu points at rates, both mean "not loaded",
//      the read is retried, and the page shows a plain state;
//   3. the checkouts refuse to open payment while the rates are not loaded (ratesGate), with the
//      words below, so a card is never charged for a sale the page cannot book right.
// The server books the VAT itself since 20261009a whatever the page sends; this is the page's half,
// and it keeps the customer's screen honest (the VAT line on the bill) as well.
//
// PURE: the IO is injected (readRates, waitForSession, sleep), so node --test covers it.

/** On screen words, short and plain. */
export const CUSTOMER_RATES_WORDS = Object.freeze({
  loading: 'Loading prices and VAT. One moment.',
  failed: 'Could not load VAT rates. Try again.',
});

/** The default pauses between tries (ms): quick first, then patient. */
export const CUSTOMER_RATES_DELAYS = Object.freeze([400, 1200, 3000]);

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Load the venue's tax rates for a customer page.
 *   waitForSession  async: resolves once the page has a session (ensureCustomerSession). It is
 *                   awaited BEFORE the first read, because the read policy answers an empty list
 *                   to a caller with no session. A throw or a null token is remembered: an empty
 *                   answer then counts as "error", never as "this venue has no rates".
 *   readRates       async: () => ({ data, error }) exactly as supabase-js answers a select.
 *   delays          the pauses between tries; one more try than pauses.
 * Resolves { status, rates, error, tries }:
 *   'ok'     rows came back (active ones only, inactive rates charge nothing: lib/tax.js);
 *   'empty'  every try answered an empty list with a session in hand: the venue may have no rates
 *            (a US venue set up as tax profiles; the retired venue of Fix 11). ratesGate decides
 *            whether that is believable from the menu itself;
 *   'error'  every try failed, or the session could not be started and nothing came back.
 * Never throws.
 */
export async function loadCustomerRates({ waitForSession, readRates, delays = CUSTOMER_RATES_DELAYS, sleep = defaultSleep } = {}) {
  let session = true;
  if (typeof waitForSession === 'function') {
    try { session = (await waitForSession()) != null; } catch { session = false; }
  }
  let lastError = null;
  let empties = 0;
  const pauses = Array.isArray(delays) ? delays : CUSTOMER_RATES_DELAYS;
  const tries = pauses.length + 1;
  for (let i = 0; i < tries; i++) {
    let res = null;
    try { res = await readRates(); } catch (e) { res = { data: null, error: e }; }
    const rows = Array.isArray(res?.data) ? res.data : null;
    if (res?.error || rows == null) {
      lastError = res?.error || new Error('no answer');
    } else if (rows.length) {
      return { status: 'ok', rates: activeRates(rows), error: null, tries: i + 1 };
    } else {
      empties += 1;
      // Two empty answers with a session in hand are believed (the first may have gone out before
      // the token was on the wire). With no session the policy hides every row, so an empty list
      // proves nothing: keep trying, the session may still arrive in storage.
      if (session && empties >= 2) return { status: 'empty', rates: [], error: null, tries: i + 1 };
    }
    if (i < pauses.length) await sleep(pauses[i]);
  }
  if (empties && !lastError) {
    return session
      ? { status: 'empty', rates: [], error: null, tries }
      : { status: 'error', rates: [], error: new Error('no session'), tries };
  }
  return { status: 'error', rates: [], error: lastError, tries };
}

/** Only active rates are kept, as every engine filters them (an inactive rate charges nothing). */
export function activeRates(rows) {
  return (Array.isArray(rows) ? rows : []).filter((r) => r && r.active !== false);
}

/**
 * Does this venue's menu point at tax rates? True when any menu row carries a tax_rate_id or a per
 * order type override. The menu is public, so the page can always answer this; it is how an EMPTY
 * rates list is told apart from "this venue has no rates": a menu that names rates the page did
 * not get is a failed load, whatever the read said.
 */
export function venueExpectsRates(menuItems) {
  return (Array.isArray(menuItems) ? menuItems : []).some((m) => {
    if (!m) return false;
    if (m.tax_rate_id || m.taxRateId) return true;
    const ov = m.tax_overrides ?? m.taxOverrides;
    return !!ov && typeof ov === 'object' && Object.values(ov).some((v) => v);
  });
}

/**
 * May payment open? null when it may; otherwise { code, message } with the plain words above.
 *   ratesState   'loading' | 'ok' | 'empty' | 'error' (loadCustomerRates.status, 'loading' before it answers)
 *   expectsRates venueExpectsRates(menu)
 *   hasTaxConfig taxCtxHasConfig(taxCtx): rates or profiles in the page's tax context
 * Rules: still loading blocks with 'loading'; an error blocks with 'failed'; an empty list blocks
 * with 'failed' when the menu names rates (they exist, the page did not get them) and when the
 * page ended with no tax config at all although the menu names rates. An empty list at a venue
 * whose menu names no rate (and has no profiles) is believed: that venue has no tax set up, and the
 * server books "not recorded" for it, exactly as before.
 */
export function ratesGate({ ratesState, expectsRates = false, hasTaxConfig = false } = {}) {
  if (ratesState === 'loading' || ratesState == null) return { code: 'loading', message: CUSTOMER_RATES_WORDS.loading };
  if (ratesState === 'error') return { code: 'failed', message: CUSTOMER_RATES_WORDS.failed };
  if (ratesState === 'empty' && expectsRates) return { code: 'failed', message: CUSTOMER_RATES_WORDS.failed };
  if (expectsRates && !hasTaxConfig) return { code: 'failed', message: CUSTOMER_RATES_WORDS.failed };
  return null;
}
