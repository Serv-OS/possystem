/**
 * taxEngine.js - the tax PROFILES engine (v5.7.32, slice 1: lands dark).
 *
 * A tax profile is a named stack of tax lines attached to a location. Each line
 * is either a percentage ('rate') or a per-unit flat amount ('per_unit'), is
 * inclusive (already inside the shelf price, extract it) or exclusive (added on
 * top of the shelf price), may compound on earlier lines, and may itself be
 * taxable by later compounding lines. This models real jurisdictions the single
 * legacy tax_rates row cannot:
 *
 *   - Omaha NE: 2.5% restaurant occupation tax which is itself part of the
 *     sales-tax base - occupation line taxable=true, then the 7.5% sales line
 *     compound=true taxes (base + occupation). 100.00 food: occupation 2.50,
 *     sales on 102.50 = 7.69, customer pays 110.19.
 *   - Chicago IL: four stacked exclusive lines (state 6.25 + county 1.75 +
 *     city 1.25 + RTA 0.5) that do NOT compound - 9.75 on 100.00.
 *   - UK sugar levy: VAT 20% inclusive (extracted, never added) alongside an
 *     exclusive per_unit levy line (flat_amount x qty added on top). The VAT
 *     line has taxable=false, so the levy's base is untouched by it - inclusive
 *     lines join later compounding bases ONLY when taxable=true.
 *
 * PURE MODULE: no imports, runs under `node --test`. Nothing calls it in
 * production yet - no consumer is switched in this slice.
 *
 * ROUNDING: raw amounts accumulate per tax line across the whole order, then
 * each tax line's ORDER-LEVEL total is rounded once, half-up at the currency
 * minor unit (profile rounding {"mode":"half_up","level":"invoice"}). Level
 * 'item' instead rounds each order-line's contribution and sums. This matches
 * the legacy engine's order-level `exclusiveTax` rounding (v5.7.31).
 */

/** Does this profile line apply to the given order type? */
export function lineAppliesToOrderType(profileLine, orderType) {
  const types = profileLine.orderTypes;
  if (!Array.isArray(types) || types.length === 0) return true;
  if (types.includes('all')) return true;
  return types.includes(orderType);
}

/**
 * Validate a profile line. Returns an array of error strings (empty = valid).
 * The one hard rule in v1: per_unit lines must be exclusive - a flat amount
 * cannot be "already inside" a price, there is nothing to extract it from.
 */
export function validateProfileLine(profileLine) {
  const errors = [];
  if (profileLine.lineType === 'per_unit' && profileLine.mode === 'inclusive') {
    errors.push(`per_unit line "${profileLine.name || profileLine.id}" cannot be inclusive - per-unit amounts are exclusive-only`);
  }
  return errors;
}

/** Validate a whole profile. Returns an array of error strings. */
export function validateProfile(profile) {
  return (profile?.lines || []).flatMap(validateProfileLine);
}

/**
 * Build the BINDING resolution cascade as a resolveProfileId function.
 * Order (first hit wins):
 *   1. item tax_profile_id
 *   2. item legacy taxRateId / taxOverrides - via the per-rate adapter profiles
 *      (a SET rate id that maps to nothing resolves NO TAX and stops the
 *      cascade: that is how channel lines whose ref is not in our menu - the
 *      __not_in_menu__ sentinel - opt out; never guess someone else's tax)
 *   3. category tax_profile_id
 *   4. venue default profile
 *   5. legacy default rate (adapter profile for the is_default tax_rates row)
 *   6. no tax
 *
 * @param {Object} cfg
 * @param {Object} cfg.itemProfileIds       itemId -> tax_profile_id
 * @param {Object} cfg.categoryProfileIds   categoryId -> tax_profile_id
 * @param {string} cfg.venueDefaultProfileId
 * @param {Object} cfg.legacyRateToProfileId  legacy tax_rates.id -> adapter profile id
 * @param {string} cfg.legacyDefaultProfileId adapter profile id for the legacy default rate
 * @returns {Function} (orderLine, orderType) -> profileId | null
 */
export function makeCascadeResolver({
  itemProfileIds = {},
  categoryProfileIds = {},
  venueDefaultProfileId = null,
  legacyRateToProfileId = {},
  legacyDefaultProfileId = null,
} = {}) {
  return function resolveProfileId(orderLine, orderType) {
    // 1. item profile
    const itemProfile = orderLine.itemId != null ? itemProfileIds[orderLine.itemId] : null;
    if (itemProfile) return itemProfile;

    // 2. item legacy rate (same override semantics as resolveTaxRate in tax.js:
    //    an override present for this order type wins even when null/falsy -
    //    falsy falls through the cascade, truthy must map or the line is untaxed)
    const legacy = orderLine.legacy || {};
    const overrideId = legacy.taxOverrides?.[orderType];
    const rateId = overrideId !== undefined ? overrideId : legacy.taxRateId;
    if (rateId) {
      return legacyRateToProfileId[rateId] || null;   // unmapped SET id = NO tax, cascade stops
    }

    // 3. category profile
    const catProfile = orderLine.categoryId != null ? categoryProfileIds[orderLine.categoryId] : null;
    if (catProfile) return catProfile;

    // 4. venue default profile
    if (venueDefaultProfileId) return venueDefaultProfileId;

    // 5. legacy default rate
    if (legacyDefaultProfileId) return legacyDefaultProfileId;

    // 6. no tax
    return null;
  };
}

/**
 * Compute tax for an order against tax profiles.
 *
 * @param {Object}   args
 * @param {Array}    args.lines  order lines:
 *   { price, qty, discountedPrice?, itemId, categoryId?, voided?,
 *     legacy: { taxRateId, taxOverrides } }
 * @param {Object}   args.profilesById  profileId -> profile:
 *   { id, name, rounding: {mode,level}, lines: [profileLine] } where profileLine =
 *   { id, name, jurisdiction?, lineType: 'rate'|'per_unit', rate, flatAmount,
 *     mode: 'inclusive'|'exclusive', compound, taxable,
 *     taxBasis: 'pre_discount'|'post_discount', orderTypes, sortOrder, active,
 *     legacyRate? (the source tax_rates row when adapter-synthesised) }
 * @param {Function} args.resolveProfileId  (orderLine, orderType) -> profileId|null
 * @param {string}   args.orderType
 * @param {number}   args.currencyMinorUnit  decimal places of the currency (2 = pence/cents)
 * @returns {Object} {
 *   exclusiveTaxTotal,        // rounded - what a surface ADDS to the payable
 *   inclusiveExtractedTotal,  // rounded - VAT etc. already inside prices (display/records)
 *   lines: [{ lineId, name, jurisdiction, mode, rate, amount }],  // rounded per line
 *   legacyBreakdown: { totalTax, breakdown: [{ rate, tax }] }     // RAW, mirrors calculateOrderTax
 * }
 */
export function computeTax({
  lines = [],
  profilesById = {},
  resolveProfileId,
  orderType = 'dine-in',
  currencyMinorUnit = 2,
} = {}) {
  const factor = Math.pow(10, currencyMinorUnit);
  // Half-up at the minor unit, FP-safe: clamp the scaled value to 6dp first so
  // a decimal half boundary (3 x 0.99 inclusive extraction = 0.495 exactly)
  // cannot arrive as 0.49499999999999994 and round DOWN (review ADV6).
  const roundMinor = x => Math.round(Number((x * factor).toFixed(6))) / factor;

  // Accumulator per profile line id: raw order-level total + per-order-line-rounded total.
  const acc = new Map();

  for (const ol of lines) {
    if (!ol || ol.voided) continue;
    const profileId = resolveProfileId ? resolveProfileId(ol, orderType) : null;
    if (!profileId) continue;
    const profile = profilesById[profileId];
    if (!profile) continue;

    const rounding = profile.rounding || {};
    const level = rounding.level === 'item' ? 'item' : 'invoice';

    // Process this profile's lines in sort_order - compounding depends on it.
    const plines = [...(profile.lines || [])]
      .filter(pl => pl && pl.active !== false && lineAppliesToOrderType(pl, orderType))
      .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));

    const qty = ol.qty || 1;
    // Running total of PRIOR taxable line amounts for this order line -
    // what a compound=true line taxes on top of its own basis.
    let taxableAccum = 0;

    for (const pl of plines) {
      const errors = validateProfileLine(pl);
      if (errors.length) throw new Error(`taxEngine: ${errors.join('; ')}`);

      // BASIS per the line's tax_basis.
      const unit = (pl.taxBasis === 'post_discount' && ol.discountedPrice != null)
        ? ol.discountedPrice
        : ol.price;
      const basis = (Number(unit) || 0) * qty;
      const base = basis + (pl.compound ? taxableAccum : 0);

      let amount;
      if (pl.lineType === 'per_unit') {
        // Flat amount per unit, always exclusive (validated above).
        amount = (Number(pl.flatAmount) || 0) * qty;
      } else if (pl.mode === 'inclusive') {
        // Price already contains this tax - EXTRACT it; it never adds to the payable.
        const r = Number(pl.rate) || 0;
        amount = r ? base - base / (1 + r) : 0;
      } else {
        // Exclusive rate - added on top of the base.
        amount = base * (Number(pl.rate) || 0);
      }

      // A taxable line's amount joins later compounding bases. This is the ONLY
      // way an inclusive line ever influences another line (UK VAT taxable=false
      // stays invisible to the sugar levy; Omaha occupation taxable=true feeds
      // the sales line).
      if (pl.taxable) taxableAccum += amount;

      const accKey = `${profileId}:${pl.id}`;   // two profiles may reuse a line id (review ADV4)
      let a = acc.get(accKey);
      if (!a) {
        a = { pl, level, raw: 0, itemRoundedSum: 0, legacy: profileId.startsWith('legacy:') };
        acc.set(accKey, a);
      }
      a.raw += amount;
      a.itemRoundedSum += roundMinor(amount);   // used only when level === 'item'
    }
  }

  // Round each tax line ONCE at order level (or sum the per-order-line roundings
  // for item-level profiles) and build the outputs.
  let exclusiveTaxTotal = 0;
  let inclusiveExtractedTotal = 0;
  // EXACT legacy parity (review ADV1): tax.js rounds the SUMMED exclusive raw
  // once at order level, so all legacy-adapter exclusive lines pool their raw
  // amounts and round together. New-style profiles round per tax line.
  let legacyExclusiveRaw = 0;
  const outLines = [];
  const legacyMap = new Map();
  let legacyTotalTax = 0;

  for (const a of acc.values()) {
    const pl = a.pl;
    const isPerUnit = pl.lineType === 'per_unit';
    const isInclusive = !isPerUnit && pl.mode === 'inclusive';
    const amount = a.level === 'item' ? roundMinor(a.itemRoundedSum) : roundMinor(a.raw);

    if (isInclusive) inclusiveExtractedTotal += amount;
    else if (a.legacy) legacyExclusiveRaw += a.raw;
    else exclusiveTaxTotal += amount;

    outLines.push({
      lineId: pl.id,
      name: pl.name,
      jurisdiction: pl.jurisdiction || null,
      mode: isPerUnit ? 'exclusive' : (pl.mode || 'exclusive'),
      rate: isPerUnit ? null : (Number(pl.rate) || 0),
      amount,
    });

    // Legacy-shaped breakdown, RAW like calculateOrderTax (it never rounds
    // totalTax or the per-rate figures). rate is null for per_unit lines.
    legacyTotalTax += a.raw;
    const rateObj = isPerUnit
      ? null
      : (pl.legacyRate || { id: pl.id, name: pl.name, rate: Number(pl.rate) || 0, type: pl.mode || 'exclusive' });
    const key = rateObj ? (rateObj.id ?? pl.id) : `per_unit:${pl.id}`;
    const entry = legacyMap.get(key) || { rate: rateObj, tax: 0 };
    entry.tax += a.raw;
    legacyMap.set(key, entry);
  }

  const breakdown = [...legacyMap.values()].sort((a, b) => {
    const ra = a.rate ? Number(a.rate.rate) || 0 : -1;   // per_unit (null rate) sorts last
    const rb = b.rate ? Number(b.rate.rate) || 0 : -1;
    return rb - ra;
  });

  return {
    // Legacy pool: rounded ONCE over its summed raw, exactly as tax.js:109
    // rounds calculateOrderTax's exclusiveTax (review ADV1 parity fix).
    exclusiveTaxTotal: roundMinor(exclusiveTaxTotal + roundMinor(legacyExclusiveRaw)),
    inclusiveExtractedTotal: roundMinor(inclusiveExtractedTotal),
    lines: outLines,
    legacyBreakdown: { totalTax: legacyTotalTax, breakdown },
  };
}
