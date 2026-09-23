// ezcaterVisibility.js — should this venue see ezCater at all?
//
// Peter, 23 Sep 2026: "hide it on any UK customers as its not a thing there".
// ezCater is a US marketplace. A UK venue being offered "Connect ezCater" is
// clutter at best and a support ticket at worst.
//
// THE OBVIOUS GATE IS WRONG ON ITS OWN. Venue currency is how the rest of the
// app tells US from UK (kioskPhoneRegion), but on 23 Sep Provo, San Mateo 1 and
// Location 2, all US venues, were stored as GBP / Europe/London. Provo is the
// one venue actually connected to ezCater. Hiding by currency alone would have
// hidden it from the only customer using it.
//
// So: a venue sees ezCater if it is a USD venue, OR if its company is already
// connected. A connected panel is never hidden by a wrong currency, and a UK
// venue with nothing connected never sees it.
//
// Pure, so node:test can load it.

/**
 * @param {{ currency?: string|null, connected?: boolean|null }} f
 * @returns {boolean}
 */
export function ezcaterVisible({ currency, connected } = {}) {
  if (connected === true) return true;
  return String(currency || '').toUpperCase() === 'USD';
}
