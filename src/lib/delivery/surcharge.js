/**
 * surcharge.js — pure delivery-surcharge policy engine.
 *
 * The authoritative delivery COST for an order is always the live Uber Direct quote
 * (uberFeeMinor, in pennies). This engine turns that true cost into the CUSTOMER-FACING
 * fee under a per-venue policy, and reports the margin so cost vs charge stay honest.
 *
 * Mirrors src/lib/serviceCharge.js in spirit: pure, deterministic, no I/O, integer
 * pennies throughout (money correctness is unit-tested). Modelled on the catering
 * flat-fee pattern (cfg.delivery_fee_minor) but generalised.
 *
 * Policy shape (stored on venue_uber_config.surcharge_policy jsonb):
 * {
 *   mode: 'pass_through' | 'markup' | 'subsidise' | 'flat',  // default pass_through
 *   markupPct:        number,       // markup: + % on the Uber fee
 *   markupFixedMinor: number,       // markup: + fixed pennies
 *   subsidiseMinor:   number,       // subsidise: merchant absorbs this many pennies
 *   subsidisePct:     number,       // subsidise: merchant absorbs this % of the Uber fee
 *   flatMinor:        number,       // flat: charge this regardless of the Uber fee
 *   capMinor:         number|null,  // never charge the customer more than this
 *   freeOverMinor:    number|null,  // free delivery when order subtotal >= this
 *   minOrderMinor:    number|null,  // minimum order value to allow delivery at all
 * }
 */

export const DEFAULT_SURCHARGE_POLICY = {
  mode: 'pass_through',
  markupPct: 0,
  markupFixedMinor: 0,
  subsidiseMinor: 0,
  subsidisePct: 0,
  flatMinor: 0,
  capMinor: null,
  freeOverMinor: null,
  minOrderMinor: null,
};

const int = (n) => {
  const v = Math.round(Number(n));
  return Number.isFinite(v) ? v : 0;
};
const nonNeg = (n) => Math.max(0, int(n));

/**
 * Compute the customer-facing delivery fee from the live Uber cost + the venue policy.
 *
 * @param {object} args
 * @param {number} args.uberFeeMinor        live Uber Direct cost in pennies (the true cost)
 * @param {object} [args.policy]            venue surcharge policy (see shape above)
 * @param {number} [args.orderSubtotalMinor] order subtotal in pennies (for free-over / min-order)
 * @param {boolean} [args.configured]       true when there is NO live courier cost (self-delivery
 *                                          or HubRise Bridge): uberFeeMinor is the merchant's own
 *                                          configured fee and IS the customer price — markup/
 *                                          subsidise/cap do not apply (they only make sense against
 *                                          a live Uber quote). free-over + min-order still apply.
 * @returns {{
 *   customerFeeMinor:number, trueCostMinor:number, marginMinor:number,
 *   policyApplied:string, freeDelivery:boolean, belowMinimum:boolean
 * }}
 */
export function computeSurcharge({ uberFeeMinor, policy, orderSubtotalMinor = 0, configured = false }) {
  const p = { ...DEFAULT_SURCHARGE_POLICY, ...(policy || {}) };
  const trueCostMinor = nonNeg(uberFeeMinor);
  const subtotal = int(orderSubtotalMinor);

  // Minimum order value gate — flagged for the caller (block / warn). We still return a
  // computed fee so the UI can show "spend £X more for delivery".
  const belowMinimum = p.minOrderMinor != null && subtotal < int(p.minOrderMinor);

  // Free delivery over a threshold — merchant absorbs the whole Uber cost.
  if (p.freeOverMinor != null && subtotal >= int(p.freeOverMinor)) {
    return {
      customerFeeMinor: 0,
      trueCostMinor,
      marginMinor: -trueCostMinor,
      policyApplied: 'free_over',
      freeDelivery: true,
      belowMinimum,
    };
  }

  // Configured-fee modes (self-delivery / HubRise Bridge) — no live courier cost exists, so
  // the merchant's configured fee IS the customer price. Marking it up by a percentage meant
  // for a live courier cost would silently overcharge, so we charge it as-is.
  if (configured) {
    const fee = nonNeg(uberFeeMinor);
    return {
      customerFeeMinor: fee,
      trueCostMinor: fee,
      marginMinor: 0,
      policyApplied: 'configured',
      freeDelivery: fee === 0,
      belowMinimum,
    };
  }

  let customerFeeMinor;
  let policyApplied;
  switch (p.mode) {
    case 'flat':
      customerFeeMinor = nonNeg(p.flatMinor);
      policyApplied = 'flat';
      break;
    case 'markup':
      customerFeeMinor = int(trueCostMinor * (1 + int(p.markupPct) / 100)) + int(p.markupFixedMinor);
      policyApplied = 'markup';
      break;
    case 'subsidise':
      customerFeeMinor = trueCostMinor - int(p.subsidiseMinor) - int(trueCostMinor * int(p.subsidisePct) / 100);
      policyApplied = 'subsidise';
      break;
    case 'pass_through':
    default:
      customerFeeMinor = trueCostMinor;
      policyApplied = 'pass_through';
      break;
  }

  customerFeeMinor = nonNeg(customerFeeMinor);

  // Cap the customer fee (merchant eats the rest).
  if (p.capMinor != null && customerFeeMinor > int(p.capMinor)) {
    customerFeeMinor = nonNeg(p.capMinor);
    policyApplied = `${policyApplied}+cap`;
  }

  return {
    customerFeeMinor,
    trueCostMinor,
    marginMinor: customerFeeMinor - trueCostMinor,
    policyApplied,
    freeDelivery: customerFeeMinor === 0,
    belowMinimum,
  };
}

/** Human label for a computed surcharge line on the bill / receipt. */
export function surchargeLabel({ freeDelivery, customerFeeMinor }) {
  if (freeDelivery || customerFeeMinor === 0) return 'Delivery (free)';
  return 'Delivery';
}
