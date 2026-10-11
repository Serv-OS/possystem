import { money } from './currency.js';
import { taxOverrideFor, taxOrderTypeKey, roundHalfUpMinor, taxFallbackNote, TAX_FALLBACK_REASONS, NOT_IN_MENU } from './taxRule.js';
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

// 8 Oct 2026: which override key a sale reads (collection and drive thru read Takeaway, a bar
// tab reads Bar) lives in taxRule.js, shared with taxEngine.js so the two engines cannot drift.
export { taxOverrideFor, taxOrderTypeKey };

/**
 * THE rule for one line (8 Oct 2026, Peter: "VAT despite the order type should follow the Tax
 * rules set on the back office per menu item"). Returns { rate, fallback }:
 *   rate      the tax_rates row that applies, or null (no rates at this venue, or no default)
 *   fallback  null when the line followed its own Back Office rule; otherwise a taxFallbackNote
 *             saying why the venue default (or the item's own rate) was used instead, which the
 *             sale records in tax_breakdown.fallbacks so a report can flag it.
 * In order:
 *   1. the item's override for this order type (its own key, else the alias: collection and
 *      drive thru read Takeaway, bar tab reads Bar). An override naming a rate this venue does
 *      not have falls to the item's own rate and is flagged. An explicit null override is the
 *      item editor's "Use default": the venue default, by the item's own rule.
 *   2. the item's own rate. A rate id this venue does not have (another venue's, deleted,
 *      switched off, or the channel sentinel for a line not on our menu) falls to the venue
 *      default and is flagged. Before 8 Oct 2026 such a line resolved NO rate and booked 0,
 *      which is how 17 HubRise sales booked £0 VAT on £692.71 (D4: never silently 0).
 *   3. no rate set: the item editor's "Use default" (v5.5.857), the venue default, unflagged;
 *      except an open price item typed at the till (itemId 'custom', no Back Office rule) and a
 *      line the till already cleaned (taxFallback stamped by venueTaxRates.lineTaxRefs), which
 *      take the default flagged.
 *   4. a venue with rates but none flagged default resolves nothing, flagged 'no-default-rate'.
 * A venue with no rates at all resolves nothing, unflagged: that is "no tax set up", which the
 * close paths guard separately.
 */
export function resolveLineTaxRate(item, taxRates = [], orderType = 'dine-in') {
  const none = { rate: null, fallback: null };
  if (!item || !Array.isArray(taxRates) || !taxRates.length) return none;
  const byId = (id) => taxRates.find(r => r && r.id === id && r.active !== false) || null;
  const def = taxRates.find(r => r && (r.isDefault || r.is_default) && r.active !== false) || null;
  let note = null;
  let rateId;
  const overrideId = taxOverrideFor(item, orderType);
  if (overrideId !== undefined) {
    if (overrideId) {
      const r = byId(overrideId);
      if (r) return { rate: r, fallback: null };
      note = [TAX_FALLBACK_REASONS.OVERRIDE_RATE_NOT_FOUND, overrideId];
      rateId = item.taxRateId;   // the override cannot be matched: the item's own rate
    } else {
      rateId = null;             // an explicit "Use default" override
    }
  } else {
    rateId = item.taxRateId;
  }
  if (rateId) {
    const r = byId(rateId);
    if (r) return { rate: r, fallback: note ? taxFallbackNote(note[0], item, note[1]) : null };
    note = [rateId === NOT_IN_MENU ? TAX_FALLBACK_REASONS.ITEM_NOT_ON_MENU : TAX_FALLBACK_REASONS.RATE_NOT_FOUND, rateId];
  } else if (!note) {
    const cleaned = item.taxFallback && typeof item.taxFallback === 'object' ? item.taxFallback : null;
    if (cleaned) note = [cleaned.reason || TAX_FALLBACK_REASONS.RATE_NOT_FOUND, cleaned.rateId ?? null];
    else if (overrideId === undefined && (item.itemId ?? item.id) === 'custom') note = [TAX_FALLBACK_REASONS.CUSTOM_ITEM, null];
  }
  if (def) return { rate: def, fallback: note ? taxFallbackNote(note[0], item, note[1]) : null };
  return { rate: null, fallback: taxFallbackNote(TAX_FALLBACK_REASONS.NO_DEFAULT_RATE, item, rateId || null) };
}

/**
 * Resolve which tax rate applies to an item for a given order type (the rate alone, for the
 * Back Office GP maths and anything else that only needs the row). The rule is resolveLineTaxRate.
 */
export function resolveTaxRate(item, taxRates = [], orderType = 'dine-in') {
  return resolveLineTaxRate(item, taxRates, orderType).rate;
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
 *   plus, ONLY when a line fell to the venue default instead of its own rule (8 Oct 2026),
 *   fallbacks: [taxFallbackNote]. The key is left out otherwise, so the record of an ordinary
 *   sale is byte for byte what it always was.
 */
export function calculateOrderTax(items = [], taxRates = [], orderType = 'dine-in') {
  const breakdownMap = {};
  let totalGross = 0;
  let totalTax = 0;
  let totalNet = 0;
  let exclusiveTaxRaw = 0;
  const fallbacks = [];

  items
    .filter(i => !i.voided)
    .forEach(item => {
      const { rate, fallback } = resolveLineTaxRate(item, taxRates, orderType);
      if (fallback) fallbacks.push(fallback);
      const { gross, net, tax } = calculateLineTax(item.price, item.qty || 1, rate);

      totalGross += gross;
      totalTax += tax;
      totalNet += net;
      // v5.7.31: the ADDED-ON portion of the bill. Only EXCLUSIVE-mode lines
      // contribute — inclusive VAT is already inside the shelf price, so a check
      // mixing both modes must charge only the exclusive share on top. An
      // inclusive-only check yields exactly 0 here (never a rounding artefact).
      if (rate && rate.type === 'exclusive') exclusiveTaxRaw += tax;

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
    // v5.7.31: what a surface must ADD to the payable. Rounded half-up to cents
    // at ORDER level (8.875% on 47.20 → 4.189 → 4.19) so every channel charges
    // the same penny. Inclusive-only checks: 0 exactly. Never use totalTax for
    // the charge — on a mixed check that would re-charge the inclusive VAT.
    // 8 Oct 2026: the one rounding rule (taxRule.roundHalfUpMinor), as the profiles engine.
    exclusiveTax: roundHalfUpMinor(exclusiveTaxRaw, 2),
    breakdown: Object.values(breakdownMap).sort((a, b) => b.rate.rate - a.rate.rate),
    hasExclusiveTax: Object.values(breakdownMap).some(b => b.rate.type === 'exclusive'),
    ...(fallbacks.length ? { fallbacks } : {}),
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
