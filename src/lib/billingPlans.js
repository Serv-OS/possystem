/**
 * billingPlans — the SaaS plan ladder, as pure functions. (v5.5.916)
 *
 * Per LOCATION. GTV = gross takings INCLUDING VAT, ALL tenders and channels.
 *
 *   Free    £0      GTV £0        – £8,000     2 devices
 *   Growth  £149    GTV £8,000.01 – £15,000    5 devices
 *   Scale   £299    GTV £15,000.01+           10 devices
 *
 * WHY PURE FUNCTIONS IN THEIR OWN FILE: this is the maths that decides what a customer is
 * charged. It must be testable without a database, a clock, or a network — so the simulation
 * can prove the ladder is right before any money moves. The same numbers live in
 * billing_plans (migration 20260727c) as the server's source of truth; these mirror it for the
 * UI and the dry run. If you change one, change both — plansMatch() below is the guard.
 */

// Pence, to avoid float money entirely.
export const PLANS = [
  { code: 'free',   name: 'Free',   fromMinor: 0,        toMinor: 800000,  priceMinor: 0,     devices: 2 },
  { code: 'growth', name: 'Growth', fromMinor: 800001,   toMinor: 1500000, priceMinor: 14900, devices: 5 },
  { code: 'scale',  name: 'Scale',  fromMinor: 1500001,  toMinor: null,    priceMinor: 29900, devices: 10 },
];

/** The plan a location lands on for a given GTV. Never returns null — 0 falls in Free. */
export function planForGtv(gtvMinor) {
  const g = Math.max(0, Math.round(Number(gtvMinor) || 0));
  return PLANS.find(p => g >= p.fromMinor && (p.toMinor === null || g <= p.toMinor)) || PLANS[0];
}

/**
 * What to charge for a period. Returns amount ex-VAT plus the VAT line.
 *
 * VAT IS DELIBERATELY EXPLICIT AND DEFAULTS TO 0. The owner has not yet said whether £149 is
 * inclusive or plus VAT, and quietly guessing either way is a 20% error on every invoice. Pass
 * vatRatePct when that is decided.
 */
export function chargeForPeriod(gtvMinor, { vatRatePct = 0 } = {}) {
  const plan = planForGtv(gtvMinor);
  const amountMinor = plan.priceMinor;
  const vatMinor = Math.round(amountMinor * (Number(vatRatePct) || 0) / 100);
  return {
    planCode: plan.code,
    planName: plan.name,
    deviceAllowance: plan.devices,
    amountMinor,
    vatMinor,
    totalMinor: amountMinor + vatMinor,
    billable: amountMinor > 0,
  };
}

/** Guard: the client ladder and the server ladder must agree. Used by the simulation. */
export function plansMatch(serverRows) {
  if (!Array.isArray(serverRows) || serverRows.length !== PLANS.length) return false;
  return PLANS.every(p => {
    const s = serverRows.find(r => r.code === p.code);
    return s
      && Number(s.gtv_from_minor) === p.fromMinor
      && (s.gtv_to_minor === null ? p.toMinor === null : Number(s.gtv_to_minor) === p.toMinor)
      && Number(s.price_minor) === p.priceMinor
      && Number(s.device_allowance) === p.devices;
  });
}

export const money = (minor, cur = '£') =>
  `${cur}${(Math.round(minor) / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
