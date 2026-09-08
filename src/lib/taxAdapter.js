/**
 * taxAdapter.js - legacy tax_rates -> tax profile adapter (v5.7.32, lands dark).
 *
 * Synthesises one single-line profile per legacy tax_rates row so the profiles
 * engine (taxEngine.js) reproduces calculateOrderTax (tax.js) EXACTLY for
 * every configuration that exists today. This is the bridge that lets consumers
 * switch to the engine later with zero behaviour change on legacy venues:
 * the golden parity tests in taxEngine.test.js pin engine-through-adapter
 * output to calculateOrderTax to the penny.
 *
 * PURE MODULE: no imports, runs under `node --test`.
 */

/** Adapter profile id for a legacy rate id. */
export const legacyProfileId = rateId => `legacy:${rateId}`;

/**
 * Build adapter profiles from the venue's legacy tax_rates rows.
 * Accepts both camelCase and snake_case rate rows (isDefault / is_default).
 * Inactive rates get NO profile: a line still pointing at an inactive rate id
 * resolves nothing through the cascade, exactly like resolveTaxRate today.
 *
 * @param {Array} taxRates  legacy tax_rates rows:
 *   { id, name, rate, type: 'inclusive'|'exclusive', active?, is_default?/isDefault? }
 * @returns {Object} {
 *   profilesById,           // adapter profiles keyed by profile id
 *   legacyRateToProfileId,  // tax_rates.id -> adapter profile id
 *   legacyDefaultProfileId, // adapter profile id of the is_default rate (or null)
 * }
 */
export function buildLegacyProfiles(taxRates = []) {
  const profilesById = {};
  const legacyRateToProfileId = {};
  let legacyDefaultProfileId = null;

  for (const r of taxRates) {
    if (!r || r.active === false) continue;   // inactive = unresolvable, like resolveTaxRate
    const pid = legacyProfileId(r.id);
    const mode = r.type === 'inclusive' ? 'inclusive' : 'exclusive';
    profilesById[pid] = {
      id: pid,
      name: r.name || 'Tax',
      rounding: { mode: 'half_up', level: 'invoice' },   // legacy rounds at order level
      generatedFromRateId: r.id,
      lines: [{
        id: `legacy-line:${r.id}`,
        name: r.name || 'Tax',
        jurisdiction: null,
        lineType: 'rate',
        rate: parseFloat(r.rate) || 0,
        flatAmount: 0,
        mode,
        compound: false,
        taxable: false,
        taxBasis: 'pre_discount',   // legacy engine never saw discounts
        orderTypes: ['all'],        // order-type routing is done by taxOverrides in the cascade
        sortOrder: 0,
        active: true,
        legacyRate: r,              // the engine's legacyBreakdown carries the ORIGINAL rate object
      }],
    };
    legacyRateToProfileId[r.id] = pid;
    if ((r.isDefault || r.is_default) && !legacyDefaultProfileId) {
      legacyDefaultProfileId = pid;   // the "Use default" fallback
    }
  }

  return { profilesById, legacyRateToProfileId, legacyDefaultProfileId };
}
