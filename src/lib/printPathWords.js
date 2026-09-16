/**
 * printPathWords.js: what to tell the operator when a print does not come out.
 *
 * PURE. Until v5.8.84 the status drawer said "Agent not responding" for every failure,
 * which pointed at a LAN print agent no real venue runs. The words now say what is
 * actually wrong for the device the operator is holding:
 *
 *   native   window.RposPrinter is present (Android till, iPad app build 5 or later):
 *            the app talked to the printer itself and got no answer.
 *   ios-old  window.RposIOS without window.RposPrinter: an iPad app build before 5,
 *            which cannot print at all.
 *   browser  neither: a laptop browser, which has no way to reach a printer.
 */

export function printEnvironment(w = (typeof window !== 'undefined' ? window : null)) {
  if (w && w.RposPrinter) return 'native';
  if (w && w.RposIOS) return 'ios-old';
  return 'browser';
}

export function printFailureWords(env = printEnvironment()) {
  switch (env) {
    case 'native': return 'Printer did not answer. Check it is on and on the same Wi-Fi as this device.';
    case 'ios-old': return 'This app build cannot print. Update ServOS POS in TestFlight (build 5 or later) and reopen it.';
    default: return 'No printer connection from a browser. Print from the till app on this device.';
  }
}

export function printPathIndicator(env = printEnvironment()) {
  switch (env) {
    case 'native': return 'Printing: direct from this device';
    case 'ios-old': return 'Printing: not available in this app build';
    default: return 'Printing: not available from a browser';
  }
}

/** Where a test page was sent from, for the page itself. */
export function printSentFromWords(env = printEnvironment(), w = (typeof window !== 'undefined' ? window : null)) {
  if (env === 'native') return w?.RposIOS ? 'iPad app (direct)' : 'Android till (direct)';
  if (env === 'ios-old') return 'iPad app, old build (queued)';
  return 'browser (queued)';
}
