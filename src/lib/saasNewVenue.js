// src/lib/saasNewVenue.js (27 Oct 2026): the plan a NEW venue starts on, and
// the plan names per currency for screens that have no catalog to hand.
// Starter, priced in the venue's own currency: 99 for a GBP venue, 149 for a
// USD venue (monthly_fee is stored in that currency's major units). USD is
// priced in dollars, anything else in pounds, the same rule as saasCurrency in
// supabase/functions/payments-admin/index.ts. These numbers mirror the
// starter.monthly of SAAS_CATALOGS there; saasStarterPlan.test.js pins the two.
export const STARTER_MONTHLY = Object.freeze({ GBP: 99, USD: 149 });

export function saasCurrency(currency) {
  return String(currency ?? '').trim().toUpperCase() === 'USD' ? 'USD' : 'GBP';
}

export function newVenueSubscription(currency) {
  return { plan: 'starter', monthly_fee: STARTER_MONTHLY[saasCurrency(currency)] };
}

// Plan names for a list badge, per currency: the top plan is Scale in the UK
// and Full in the US (same stored key, scale). Mirrors the catalog labels.
const PLAN_NAMES = {
  GBP: { starter: 'Starter', growth: 'Growth', scale: 'Scale', free: 'Free (old plan)' },
  USD: { starter: 'Starter', growth: 'Growth', scale: 'Full', free: 'Free (old plan)' },
};
export function saasPlanName(plan, currency) {
  return PLAN_NAMES[saasCurrency(currency)][plan] ?? plan;
}
