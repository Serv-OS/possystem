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
 * PURE MODULE: imports only taxRule.js (itself import free), runs under `node --test`.
 * It is the engine behind taxCompute.computeOrderTaxUnified on every venue that
 * has tax profiles, and it synthesises the v2 named lines record for every venue.
 *
 * ROUNDING: raw amounts accumulate per tax line across the whole order, then
 * each tax line's ORDER-LEVEL total is rounded once, half-up at the currency
 * minor unit (profile rounding {"mode":"half_up","level":"invoice"}). Level
 * 'item' instead rounds each order-line's contribution and sums. This matches
 * the legacy engine's order-level `exclusiveTax` rounding (v5.7.31); since
 * 8 Oct 2026 both read the one rule, taxRule.roundHalfUpMinor.
 */

import { taxOverrideFor, taxOrderTypeKey, roundHalfUpMinor, TAX_FALLBACK_REASONS, NOT_IN_MENU } from './taxRule.js';

/** True when any ACTIVE line of the profile is tagged with this order type (mirrors costing.js recipeNamesOrderType). */
export function profileNamesOrderType(profileLines, orderType) {
  if (!Array.isArray(profileLines)) return false;
  return profileLines.some(pl => pl && pl.active !== false && Array.isArray(pl.orderTypes) && pl.orderTypes.includes(orderType));
}

/**
 * Does this profile line apply to the given order type?
 * A line tagged with the sale's own order type applies. So does a line tagged with the order
 * type's ALIAS (taxRule.taxOrderTypeKey: a 'takeaway' line applies to a drive-thru sale, 16 Sep
 * 2026, and to a collection sale, 8 Oct 2026; a 'bar' line applies to a bar tab) UNLESS an
 * active line on the same profile names the sale's order type itself, in which case the profile
 * has its own line for it and only lines tagged with it (or 'all') apply. Pass the profile's
 * lines as `profileLines` for that check; with no profile context (a single line asked on its
 * own) the alias line applies. Lines tagged 'all' apply as they always have. An alias tag never
 * reaches the other way: a 'drive-thru' tag never applies to a takeaway sale. Same shape of rule
 * as costing.js lineAppliesToOrderType for recipe lines (drive thru only, there).
 */
export function lineAppliesToOrderType(profileLine, orderType, profileLines = null) {
  const types = profileLine.orderTypes;
  if (!Array.isArray(types) || types.length === 0) return true;
  if (types.includes('all')) return true;
  if (types.includes(orderType)) return true;
  const alias = taxOrderTypeKey(orderType);
  return alias !== orderType && types.includes(alias) && !profileNamesOrderType(profileLines, orderType);
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
 * An ADDED-ON rate line: a percentage charged on top of the price (not an
 * inclusive extraction, not a flat per-unit amount). v5.9.12: the only kind of
 * line the check-level basis (discounts, service charge, delivery fee) touches.
 */
export function isAddedOnRateLine(profileLine) {
  return !!profileLine && profileLine.lineType !== 'per_unit' && profileLine.mode !== 'inclusive';
}

/**
 * v5.9.12: WHAT a tax line is charged on, with the US defaults applied ONCE here
 * (the row normaliser, the legacy adapter, the mirror check and the Back Office
 * builder all read this, never their own copy of the defaults).
 *
 *   taxBasis          'post_discount' (default for added-on rate lines): item
 *                     discounts, check discounts, auto discounts, promo codes and
 *                     loyalty rewards reduce the taxed amount, as store discounts do
 *                     in most US states. 'pre_discount' taxes the menu price.
 *   taxServiceCharge  default ON for added-on rate lines: the line also taxes its
 *                     share of a mandatory service charge (New York, California and
 *                     most states tax a mandatory service charge; a voluntary tip is
 *                     never taxed and never reaches the engine).
 *   taxDeliveryFee    default OFF: the line also taxes its share of the delivery
 *                     fee. State rules differ, so the operator switches it on.
 *
 * An explicit value always wins. INCLUSIVE and PER-UNIT lines never use any of
 * this: inclusive VAT is extracted from the shelf price exactly as before (the
 * UK lock), and a per-unit levy is a flat amount per item.
 */
export function lineBasisSettings(profileLine) {
  const addedOn = isAddedOnRateLine(profileLine);
  const b = profileLine?.taxBasis;
  return {
    taxBasis: (b === 'pre_discount' || b === 'post_discount') ? b : (addedOn ? 'post_discount' : 'pre_discount'),
    taxServiceCharge: typeof profileLine?.taxServiceCharge === 'boolean' ? profileLine.taxServiceCharge : addedOn,
    taxDeliveryFee: typeof profileLine?.taxDeliveryFee === 'boolean' ? profileLine.taxDeliveryFee : false,
  };
}

/**
 * Build the BINDING resolution cascade as a resolveProfileId function.
 * Order (first hit wins):
 *   1. item tax_profile_id
 *   2. item legacy taxRateId / taxOverrides - via the per-rate adapter profiles.
 *      8 Oct 2026 (D4): a SET rate id that maps to nothing (another venue's,
 *      deleted, switched off, or the __not_in_menu__ sentinel of a channel line)
 *      no longer stops the cascade at NO TAX. It falls through to the venue
 *      default like a line with no rate, and the fall is REPORTED through
 *      cfg.onFallback so the sale records it (tax.js resolveLineTaxRate is the
 *      same rule for the legacy engine; both read taxRule.js). Before this, 17
 *      HubRise sales booked £0 VAT on £692.71 because every line was "not in
 *      our menu".
 *   3. category tax_profile_id
 *   4. venue default profile
 *   5. legacy default rate (adapter profile for the is_default tax_rates row)
 *   6. no tax
 *
 * v5.7.34 MONEY FIX: when cfg.profilesById is supplied, a profile-id step
 * (1, 3, 4) whose id matches NO loaded profile FALLS THROUGH to the next step
 * instead of resolving. Without this, an assignment pointing at a deleted or
 * unloaded profile reached computeTax, hit `if (!profile) continue` and booked
 * ZERO tax - a dangling assignment must never create a tax-free sale.
 *
 * @param {Object} cfg
 * @param {Object} cfg.itemProfileIds       itemId -> tax_profile_id
 * @param {Object} cfg.categoryProfileIds   categoryId -> tax_profile_id
 * @param {string} cfg.venueDefaultProfileId
 * @param {Object} cfg.legacyRateToProfileId  legacy tax_rates.id -> adapter profile id
 * @param {string} cfg.legacyDefaultProfileId adapter profile id for the legacy default rate
 * @param {Object} [cfg.profilesById]       loaded profiles - enables the dangling-id
 *                                          fall-through above (omitted = old behaviour)
 * @param {Function} [cfg.onFallback]       (orderLine, { reason, rateId }, profileId) called
 *                                          once per line that did not follow its own rule
 *                                          (reason: taxRule.TAX_FALLBACK_REASONS)
 * @returns {Function} (orderLine, orderType) -> profileId | null
 */
export function makeCascadeResolver({
  itemProfileIds = {},
  categoryProfileIds = {},
  venueDefaultProfileId = null,
  legacyRateToProfileId = {},
  legacyDefaultProfileId = null,
  profilesById = null,
  onFallback = null,
} = {}) {
  // With no profilesById supplied every id counts as loaded (legacy call shape).
  const loaded = (pid) => !!pid && (!profilesById || !!profilesById[pid]);
  return function resolveProfileId(orderLine, orderType) {
    // 1. item profile (dangling id falls through - see MONEY FIX above)
    const itemProfile = orderLine.itemId != null ? itemProfileIds[orderLine.itemId] : null;
    if (loaded(itemProfile)) return itemProfile;

    // 2. item legacy rate: the same rule as tax.js resolveLineTaxRate, step by step.
    //    The override for this order type (its own key, else the alias: taxRule.taxOverrideFor)
    //    wins even when null (an explicit "Use default" falls through the cascade). A SET id
    //    that maps to nothing falls through too, noted; an unmatched override falls to the
    //    item's own rate first.
    const legacy = orderLine.legacy || {};
    let note = null;
    let rateId;
    const overrideId = taxOverrideFor(legacy, orderType);
    if (overrideId !== undefined) {
      if (overrideId) {
        const mapped = legacyRateToProfileId[overrideId];
        if (mapped) return mapped;
        note = { reason: TAX_FALLBACK_REASONS.OVERRIDE_RATE_NOT_FOUND, rateId: overrideId };
        rateId = legacy.taxRateId;
      } else {
        rateId = null;
      }
    } else {
      rateId = legacy.taxRateId;
    }
    const done = (pid) => {
      if (note && typeof onFallback === 'function') onFallback(orderLine, note, pid);
      return pid;
    };
    if (rateId) {
      const mapped = legacyRateToProfileId[rateId];
      if (mapped) return done(mapped);
      note = { reason: rateId === NOT_IN_MENU ? TAX_FALLBACK_REASONS.ITEM_NOT_ON_MENU : TAX_FALLBACK_REASONS.RATE_NOT_FOUND, rateId };
    } else if (!note) {
      const cleaned = legacy.taxFallback && typeof legacy.taxFallback === 'object' ? legacy.taxFallback : null;
      if (cleaned) note = { reason: cleaned.reason || TAX_FALLBACK_REASONS.RATE_NOT_FOUND, rateId: cleaned.rateId ?? null };
      else if (overrideId === undefined && orderLine.custom) note = { reason: TAX_FALLBACK_REASONS.CUSTOM_ITEM, rateId: null };
    }

    // 3. category profile (dangling id falls through)
    const catProfile = orderLine.categoryId != null ? categoryProfileIds[orderLine.categoryId] : null;
    if (loaded(catProfile)) return done(catProfile);

    // 4. venue default profile (dangling id falls through to the legacy default)
    if (loaded(venueDefaultProfileId)) return done(venueDefaultProfileId);

    // 5. legacy default rate
    if (legacyDefaultProfileId) return done(legacyDefaultProfileId);

    // 6. no tax. A venue with legacy rates but no default is told so (tax.js says the same);
    //    a venue with no tax set up at all is not a fallback, the close paths guard that.
    if (!note && Object.keys(legacyRateToProfileId).length) note = { reason: TAX_FALLBACK_REASONS.NO_DEFAULT_RATE, rateId: rateId || null };
    return done(null);
  };
}

/**
 * Compute tax for an order against tax profiles.
 *
 * @param {Object}   args
 * @param {Array}    args.lines  order lines:
 *   { price, qty, discountedPrice?, itemId, categoryId?, voided?,
 *     netValue?, serviceShare?, deliveryShare?,
 *     lineId?, name?, custom?,                      (8 Oct 2026: for the fallback note; custom =
 *                                                   an open price till item with no Back Office rule)
 *     legacy: { taxRateId, taxOverrides, taxFallback? } }   (taxFallback: stamped by the till when
 *                                                   it cleaned a rate id it does not hold)
 *   v5.9.12 check-level basis (taxBasis.js allocateCheckBasis fills these):
 *     netValue      the line's value after item AND check discounts (whole line,
 *                   not per unit) - taxed by post_discount added-on rate lines
 *     serviceShare  the line's share of the service charge
 *     deliveryShare the line's share of the delivery fee
 *   Absent = exactly the pre-v5.9.12 basis (price x qty).
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
 *   lineTaxes: [{ exclusive, inclusive }],  // RAW per input order line (same order as
 *                                           // `lines`, voided/untaxed = 0) - refunds use it
 *   checkBasisUsed,           // true when the check-level basis changed any added-on amount
 * }
 */
export function computeTax({
  lines = [],
  profilesById = {},
  resolveProfileId,
  orderType = 'dine-in',
  currencyMinorUnit = 2,
} = {}) {
  // Half-up at the minor unit, FP-safe: clamp the scaled value to 6dp first so
  // a decimal half boundary (3 x 0.99 inclusive extraction = 0.495 exactly)
  // cannot arrive as 0.49499999999999994 and round DOWN (review ADV6).
  // 8 Oct 2026: the one rule, shared with tax.js (taxRule.roundHalfUpMinor).
  const roundMinor = x => roundHalfUpMinor(x, currencyMinorUnit);

  // Accumulator per profile line id: raw order-level total + per-order-line-rounded total.
  const acc = new Map();
  // v5.9.12: raw tax per INPUT order line (refunds return the tax the refunded
  // line actually carried), and whether the check-level basis moved anything.
  // service / delivery = the part of `exclusive` charged on the line's share of
  // the service charge / delivery fee (a part refund returns those separately).
  const lineTaxes = lines.map(() => ({ exclusive: 0, inclusive: 0, service: 0, delivery: 0 }));
  let checkBasisUsed = false;

  for (let li = 0; li < lines.length; li++) {
    const ol = lines[li];
    if (!ol || ol.voided) continue;
    const profileId = resolveProfileId ? resolveProfileId(ol, orderType) : null;
    if (!profileId) continue;
    const profile = profilesById[profileId];
    if (!profile) continue;

    const rounding = profile.rounding || {};
    const level = rounding.level === 'item' ? 'item' : 'invoice';

    // Process this profile's lines in sort_order - compounding depends on it.
    const plines = [...(profile.lines || [])]
      .filter(pl => pl && pl.active !== false && lineAppliesToOrderType(pl, orderType, profile.lines))
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
      let basis = (Number(unit) || 0) * qty;

      // v5.9.12 CHECK-LEVEL BASIS, added-on rate lines ONLY. Until now every
      // surface taxed price x qty before any discount and never taxed the service
      // charge or delivery fee: US checks over-collected whenever a discount
      // applied and under-collected wherever a mandatory service charge is
      // taxable. Inclusive lines are deliberately untouched (UK VAT stays
      // byte-identical) and per-unit lines are a flat amount per item.
      let svcTaxed = 0;
      let delTaxed = 0;
      if (isAddedOnRateLine(pl)) {
        const s = lineBasisSettings(pl);
        const before = basis;
        if (s.taxBasis === 'post_discount' && ol.netValue != null) basis = Number(ol.netValue) || 0;
        if (s.taxServiceCharge) { svcTaxed = Number(ol.serviceShare) || 0; basis += svcTaxed; }
        if (s.taxDeliveryFee) { delTaxed = Number(ol.deliveryShare) || 0; basis += delTaxed; }
        // Only a change in the AMOUNT counts: a 0% added-on line (an exempt rate
        // typed exclusive) moving its basis changes nothing and must not knock a
        // venue off the byte-identical parity path.
        if (Math.abs((basis - before) * (Number(pl.rate) || 0)) > 1e-12) checkBasisUsed = true;
      }
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

      if (pl.lineType !== 'per_unit' && pl.mode === 'inclusive') lineTaxes[li].inclusive += amount;
      else {
        lineTaxes[li].exclusive += amount;
        // The service / delivery share of this amount, in proportion to the basis
        // (exact for a plain line; for a compound line the prior taxable lines are
        // taken to share the same mix, which they do when they share the basis).
        if (basis > 0 && (svcTaxed || delTaxed)) {
          lineTaxes[li].service += amount * svcTaxed / basis;
          lineTaxes[li].delivery += amount * delTaxed / basis;
        }
      }

      const accKey = `${profileId}:${pl.id}`;   // two profiles may reuse a line id (review ADV4)
      let a = acc.get(accKey);
      if (!a) {
        a = { pl, level, raw: 0, itemRoundedSum: 0, basisRaw: 0, count: 0, legacy: profileId.startsWith('legacy:') };
        acc.set(accKey, a);
      }
      a.raw += amount;
      a.itemRoundedSum += roundMinor(amount);   // used only when level === 'item'
      // v5.7.34: goods basis + line count per tax line, so legacyBreakdown can
      // carry the net/gross/items fields calculateOrderTax's breakdown entries
      // have (reports read them). Goods only - the compound add-on is excluded,
      // matching legacy's "net = the goods, tax on top/inside" bookkeeping.
      a.basisRaw += basis;
      a.count += 1;
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
    // v5.7.34: entries also carry net/gross/items so Tax/Z report rollups keep
    // their read shape when profile venues flow through the unified seam.
    legacyTotalTax += a.raw;
    const rateObj = isPerUnit
      ? null
      : (pl.legacyRate || { id: pl.id, name: pl.name, rate: Number(pl.rate) || 0, type: pl.mode || 'exclusive' });
    const key = rateObj ? (rateObj.id ?? pl.id) : `per_unit:${pl.id}`;
    // Per-unit entries (rate: null) carry the LINE NAME at top level so a
    // renderer can still print "Sugar Levy  0.75" - there is no rate object
    // to read a name off (v5.7.34 rate-null guard sweep).
    const entry = legacyMap.get(key) ||
      (rateObj
        ? { rate: rateObj, tax: 0, net: 0, gross: 0, items: 0 }
        : { rate: null, name: pl.name || 'Tax', tax: 0, net: 0, gross: 0, items: 0 });
    entry.tax += a.raw;
    entry.net += isInclusive ? (a.basisRaw - a.raw) : a.basisRaw;
    entry.gross += isInclusive ? a.basisRaw : (a.basisRaw + a.raw);
    entry.items += a.count;
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
    lineTaxes,
    checkBasisUsed,
  };
}
