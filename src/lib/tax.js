import { money } from './currency.js';
/**
 * Tax calculation engine — handles UK VAT (inclusive) and US sales tax (exclusive)
 *
 * UK (inclusive): price already contains tax. Extract it.
 *   item_gross = price × qty
 *   item_tax   = gross - (gross / (1 + rate))
 *   item_net   = gross / (1 + rate)
 *
 * US (exclusive): tax is added on top.
 *   item_net   = price × qty
 *   item_tax   = net × rate
 *   item_gross = net + tax
 */

/**
 * Resolve which tax rate applies to an item for a given order type.
 * Checks per-order-type overrides first, then falls back to the item's default rate.
 */
export function resolveTaxRate(item, taxRates = [], orderType = 'dine-in') {
  if (!item || !taxRates.length) return null;
  // Check for order-type specific override (e.g. takeaway = zero-rated)
  const overrideId = item.taxOverrides?.[orderType];
  const rateId = overrideId !== undefined ? overrideId : item.taxRateId;
  // v5.5.857: no rate set = the item editor's "Use default" — which the engine NEVER
  // honoured: it returned null and the line booked £0 VAT (live repro: a £36 ribeye on
  // "Use default" booked zero on a real check). Now it resolves the venue's default
  // rate, as the UI has always promised. Deliberate zero-tax stays the explicit Zero
  // Rate. A rate id that matches nothing still returns null (that's how channel lines
  // whose ref isn't in our menu opt OUT of the default — never guess someone else's
  // tax), and a venue with no default rate configured behaves exactly as before.
  if (!rateId) return taxRates.find(r => (r.isDefault || r.is_default) && r.active !== false) || null;
  return taxRates.find(r => r.id === rateId && r.active !== false) || null;
}

/**
 * Calculate tax for a single line item.
 */
export function calculateLineTax(price, qty = 1, taxRate = null) {
  const grossBeforeTax = price * qty;
  if (!taxRate || taxRate.rate === 0) {
    return { gross: grossBeforeTax, net: grossBeforeTax, tax: 0, rateApplied: 0 };
  }
  const rate = parseFloat(taxRate.rate);
  if (taxRate.type === 'inclusive') {
    // Tax is baked into price — extract it
    const net = grossBeforeTax / (1 + rate);
    const tax = grossBeforeTax - net;
    return { gross: grossBeforeTax, net, tax, rateApplied: rate };
  } else {
    // Tax added on top
    const net = grossBeforeTax;
    const tax = net * rate;
    return { gross: net + tax, net, tax, rateApplied: rate };
  }
}

/**
 * Calculate tax breakdown for a full order.
 * Returns per-rate breakdown and totals.
 *
 * @param {Array} items — order items (each with price, qty, taxRateId, taxOverrides)
 * @param {Array} taxRates — all tax rates for this location
 * @param {string} orderType — 'dine-in' | 'takeaway' | 'delivery' | 'bar' etc.
 * @returns {Object} { subtotal, totalTax, total, breakdown: [{rate, tax, net, gross}] }
 */
export function calculateOrderTax(items = [], taxRates = [], orderType = 'dine-in') {
  const breakdownMap = {};
  let totalGross = 0;
  let totalTax = 0;
  let totalNet = 0;

  items
    .filter(i => !i.voided)
    .forEach(item => {
      const rate = resolveTaxRate(item, taxRates, orderType);
      const { gross, net, tax } = calculateLineTax(item.price, item.qty || 1, rate);

      totalGross += gross;
      totalTax += tax;
      totalNet += net;

      if (rate) {
        const key = rate.id;
        if (!breakdownMap[key]) {
          breakdownMap[key] = { rate, tax: 0, net: 0, gross: 0, items: 0 };
        }
        breakdownMap[key].tax   += tax;
        breakdownMap[key].net   += net;
        breakdownMap[key].gross += gross;
        breakdownMap[key].items += 1;
      }
    });

  return {
    subtotal:  totalNet,
    totalTax,
    total:     totalGross,
    breakdown: Object.values(breakdownMap).sort((a, b) => b.rate.rate - a.rate.rate),
    hasExclusiveTax: Object.values(breakdownMap).some(b => b.rate.type === 'exclusive'),
  };
}

/**
 * Net (ex-tax) value of a price, given the resolved tax rate.
 * UK inclusive VAT: the price contains the tax, so net = price ÷ (1 + rate).
 * US exclusive tax / no rate: the price already IS the net, so return it unchanged.
 * Used for gross-profit maths, which must always be on the ex-VAT selling price.
 */
export function netOf(grossPrice, taxRate) {
  if (grossPrice == null || grossPrice === '') return null;   // no price → no net (Number(null) is 0, guard it)
  const g = Number(grossPrice);
  if (!Number.isFinite(g)) return null;
  if (!taxRate || !taxRate.rate || taxRate.type !== 'inclusive') return g;
  return g / (1 + parseFloat(taxRate.rate));
}

/**
 * NET (ex-VAT) purchase price used for costing/COGS.
 * If the entered price already excludes VAT (the default) it IS the net cost.
 * If the operator flagged the price as VAT-inclusive (e.g. typed straight off a
 * gross invoice), strip the rate: net = price ÷ (1 + rate). A null/zero rate or a
 * non-numeric price returns the input unchanged (null for non-numeric).
 * `rateDecimal` is the bare fraction (0.2 for 20%), not a rate object.
 */
export function purchaseNet(price, includesTax, rateDecimal) {
  if (price == null || price === '') return null;
  const p = Number(price);
  if (!Number.isFinite(p)) return null;
  if (!includesTax) return p;
  const r = Number(rateDecimal) || 0;
  return r > 0 ? p / (1 + r) : p;
}

/**
 * Format a tax rate for display: "20% VAT" or "8.875% Sales Tax"
 */
export function formatRateLabel(rate) {
  if (!rate) return '';
  const pct = (parseFloat(rate.rate) * 100).toFixed(rate.rate % 0.01 === 0 ? 0 : 3).replace(/\.?0+$/, '');
  return `${pct}% ${rate.name}`;
}

/**
 * Format tax amount for display
 */
export const fmtTax = n => `${money(Math.abs(n || 0))}`;

/**
 * Seed rates for a new UK location
 */
export const UK_DEFAULT_RATES = [
  { name:'Standard Rate', code:'VAT20', rate:0.2000, type:'inclusive', applies_to:['all'], is_default:true },
  { name:'Reduced Rate',  code:'VAT5',  rate:0.0500, type:'inclusive', applies_to:['all'], is_default:false },
  { name:'Zero Rate',     code:'ZERO',  rate:0.0000, type:'inclusive', applies_to:['all'], is_default:false },
];

/**
 * Seed rates for a new US location (example: NYC)
 */
export const US_DEFAULT_RATES = [
  { name:'Sales Tax',  code:'US_SALES', rate:0.08875, type:'exclusive', applies_to:['all'], is_default:true },
  { name:'Tax Exempt', code:'EXEMPT',   rate:0.0000,  type:'exclusive', applies_to:['all'], is_default:false },
];
