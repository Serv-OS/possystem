import { money } from './/currency';
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
  if (!rateId) return null;
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
