/**
 * taxCompute.js - THE ONE TAX SEAM (v5.7.34, the profiles cutover).
 *
 * Every surface that computes tax calls computeOrderTaxUnified() here instead
 * of calculateOrderTax() directly. The seam decides which engine runs:
 *
 *   LEGACY-EQUIVALENT venue (every UK site today): no item/category profile
 *   assignments, and the venue default profile is either absent or a GENERATED
 *   verbatim mirror of the venue's legacy default rate (backfill migration
 *   20260825c stamps generated_from_rate_id). The legacy read shape is produced
 *   by calculateOrderTax itself - BYTE-IDENTICAL to v5.7.31 slice 0, not
 *   merely penny-identical - and the profiles engine runs alongside purely to
 *   synthesise the v2 named-lines record.
 *
 *   PROFILE venue (anything actually assigned - a Chicago stack on a category,
 *   an item-level profile, an edited generated profile as the venue default):
 *   the profiles engine (taxEngine.js) computes through the binding cascade
 *   and the seam synthesises the legacy read shape from its output, so every
 *   existing consumer keeps reading { subtotal, totalTax, total, exclusiveTax,
 *   breakdown, hasExclusiveTax } unchanged.
 *
 * GENERATED-MIRROR REMAP: an assignment that points at a generated profile
 * whose content is still a verbatim single-line copy of an ACTIVE legacy rate
 * is remapped onto that rate's adapter profile ('legacy:<rateId>'). Two things
 * fall out: (1) the venue-default backfill resolves EXACTLY like the legacy
 * default rate (cascade steps 4 and 5 coincide), which is what makes UK venues
 * legacy-equivalent at all; (2) mirror lines join the adapter's pooled
 * exclusive rounding (tax.js parity: pool raw, round ONCE). An EDITED generated
 * profile no longer mirrors its source rate and is honoured as a real profile.
 *
 * The result is a strict superset of calculateOrderTax's shape, plus:
 *   taxV2   - versioned named-lines record for closed_checks.tax_breakdown
 *             ({ version: 2, source, orderType, lines: [{lineId, name,
 *             jurisdiction, mode, rate, amount}], exclusiveTaxTotal,
 *             inclusiveExtractedTotal }) - rides ALONGSIDE the legacy keys in
 *             the same jsonb; old readers never see it. null if the engine
 *             refused the config (seam fails toward legacy, never a guess).
 *   source  - 'legacy' | 'profiles' | 'legacy-fallback' (engine threw).
 *
 * exclusiveTax remains the ONLY amount a surface may add to the payable;
 * inclusive stays extraction-only (display / records). Invariant unchanged.
 *
 * PURE MODULE apart from its two sibling imports - runs under `node --test`.
 */

import { computeTax, makeCascadeResolver } from './taxEngine.js';
import { buildLegacyProfiles, legacyProfileId } from './taxAdapter.js';
import { calculateOrderTax } from './tax.js';

/**
 * Build a tax context OUTSIDE the store - the customer surfaces (online, QR,
 * catering, kiosk) fetch raw rows themselves and cannot reach getTaxContext().
 * Mirrors store _buildTaxContext exactly: adapter profiles merged under DB
 * profiles, item/category assignment maps from either casing, venue default.
 * menuItems / menuCategories accept RAW snake rows or store camel rows.
 */
export function buildLocalTaxCtx({
  taxProfiles = [],
  menuItems = [],
  menuCategories = [],
  venueDefaultProfileId = null,
  taxRates = [],
} = {}) {
  const { profilesById: legacyProfiles, legacyRateToProfileId, legacyDefaultProfileId } =
    buildLegacyProfiles(taxRates || []);
  const profilesById = { ...legacyProfiles };
  for (const p of (taxProfiles || [])) {
    if (p && p.id && p.active !== false) profilesById[p.id] = p;
  }
  const itemProfileIds = {};
  for (const i of (menuItems || [])) {
    const pid = i?.taxProfileId ?? i?.tax_profile_id ?? null;
    if (pid && i.id != null) itemProfileIds[i.id] = pid;
  }
  const categoryProfileIds = {};
  for (const c of (menuCategories || [])) {
    const pid = c?.taxProfileId ?? c?.tax_profile_id ?? null;
    if (pid && c.id != null) categoryProfileIds[c.id] = pid;
  }
  const defaultProfileId = venueDefaultProfileId || null;
  return {
    profilesById,
    itemProfileIds,
    categoryProfileIds,
    defaultProfileId,
    venueDefaultProfileId: defaultProfileId,
    legacyRateToProfileId,
    legacyDefaultProfileId,
    taxRates: taxRates || [],
  };
}

/**
 * Is this DB profile still a verbatim single-line mirror of the ACTIVE legacy
 * rate it was generated from? (Backfill 20260825c copies the rate verbatim;
 * the builder lets operators edit generated profiles, which un-mirrors them.)
 */
function isLegacyMirror(profile, ratesById) {
  const srcId = profile?.generatedFromRateId ?? profile?.generated_from_rate_id ?? null;
  if (!srcId) return false;
  const r = ratesById[srcId];
  if (!r || r.active === false) return false;
  if ((profile.rounding?.level ?? 'invoice') === 'item') return false;   // legacy rounds at order level
  const active = (profile.lines || []).filter(l => l && l.active !== false);
  if (active.length !== 1) return false;
  const l = active[0];
  const mode = r.type === 'inclusive' ? 'inclusive' : 'exclusive';
  return (l.lineType ?? 'rate') === 'rate'
    && !l.compound && !l.taxable
    && (l.taxBasis ?? 'pre_discount') === 'pre_discount'
    && (!Array.isArray(l.orderTypes) || l.orderTypes.length === 0 || l.orderTypes.includes('all'))
    && (l.mode ?? 'exclusive') === mode
    && Math.abs((Number(l.rate) || 0) - (parseFloat(r.rate) || 0)) < 1e-9;
}

// Memoised per ctx object identity - getTaxContext() returns a stable object
// until an input slice changes, so this is free on every render.
const _prepCache = new WeakMap();

/**
 * Normalise + analyse a tax context once:
 *   - remap generated-mirror profile assignments onto their adapter profiles
 *   - decide legacy-equivalence (drives the byte-identical parity routing)
 * Accepts a full getTaxContext()/buildLocalTaxCtx() object OR a minimal
 * { taxRates } (channelMoney's default) - adapter profiles are synthesised
 * when absent.
 */
export function prepareTaxCtx(taxCtx) {
  const ctx = taxCtx && typeof taxCtx === 'object' ? taxCtx : { taxRates: [] };
  const hit = _prepCache.get(ctx);
  if (hit) return hit;

  let { profilesById, legacyRateToProfileId, legacyDefaultProfileId } = ctx;
  if (!profilesById) {
    const built = buildLegacyProfiles(ctx.taxRates || []);
    profilesById = built.profilesById;
    legacyRateToProfileId = built.legacyRateToProfileId;
    legacyDefaultProfileId = built.legacyDefaultProfileId;
  }

  const ratesById = {};
  for (const r of (ctx.taxRates || [])) if (r && r.id != null) ratesById[r.id] = r;

  // Generated-mirror remap: still-verbatim generated profiles resolve as their
  // source rate's adapter profile (identical maths + pooled legacy rounding).
  const remap = {};
  for (const pid of Object.keys(profilesById)) {
    if (pid.startsWith('legacy:')) continue;
    const p = profilesById[pid];
    if (isLegacyMirror(p, ratesById)) {
      const adapterId = legacyProfileId(p.generatedFromRateId ?? p.generated_from_rate_id);
      if (profilesById[adapterId]) remap[pid] = adapterId;
    }
  }

  // v5.7.34 MONEY FIX: an assignment pointing at a profile that is NOT loaded
  // (deleted, deactivated, or simply absent from this device's snapshot) is
  // DROPPED here, so the line falls through the cascade to the next binding
  // step and ultimately the legacy default rate - exactly as if the assignment
  // did not exist. Before this, a dangling id reached the engine, resolved a
  // profile that wasn't there, and the sale booked ZERO tax under source
  // 'profiles'. A venue whose only "assignments" are dangling ids is also
  // legacy-equivalent again, which restores the byte-identical parity path.
  const mapIds = (obj) => {
    const out = {};
    let n = 0;
    for (const k of Object.keys(obj || {})) {
      const pid = remap[obj[k]] || obj[k];
      if (!profilesById[pid]) continue;   // dangling assignment = no assignment
      out[k] = pid;
      n++;
    }
    return [out, n];
  };
  const [itemProfileIds, nItems] = mapIds(ctx.itemProfileIds);
  const [categoryProfileIds, nCats] = mapIds(ctx.categoryProfileIds);
  const rawDefault = ctx.venueDefaultProfileId ?? ctx.defaultProfileId ?? null;
  let venueDefaultProfileId = rawDefault ? (remap[rawDefault] || rawDefault) : null;
  if (venueDefaultProfileId && !profilesById[venueDefaultProfileId]) {
    venueDefaultProfileId = null;   // dangling venue default -> legacy default rate
  }

  // LEGACY-EQUIVALENT: nothing assigned at item/category level, and the venue
  // default either absent or remapped onto the SAME adapter profile the legacy
  // default rate already resolves - the cascade then reproduces resolveTaxRate
  // exactly, so calculateOrderTax IS the correct engine (byte-identical).
  const legacyEquivalent = nItems === 0 && nCats === 0 &&
    (!venueDefaultProfileId || venueDefaultProfileId === (legacyDefaultProfileId || null));

  const prep = {
    profilesById,
    itemProfileIds,
    categoryProfileIds,
    venueDefaultProfileId,
    legacyRateToProfileId: legacyRateToProfileId || {},
    legacyDefaultProfileId: legacyDefaultProfileId || null,
    taxRates: ctx.taxRates || [],
    remap,
    legacyEquivalent,
  };
  _prepCache.set(ctx, prep);
  return prep;
}

/** Any tax config at all (rates or profile assignments)? Callers use this to
 *  keep today's "no rates = no breakdown object" guards intact. */
export function taxCtxHasConfig(taxCtx) {
  if (!taxCtx) return false;
  if (Array.isArray(taxCtx.taxRates) && taxCtx.taxRates.length) return true;
  const p = prepareTaxCtx(taxCtx);
  return !p.legacyEquivalent || !!p.venueDefaultProfileId;
}

/** Map one consumer order line onto the engine's order-line contract.
 *  Accepts store lines (camel), raw cart lines (snake riding along), and the
 *  pre-mapped {price, qty, taxRateId, taxOverrides} shapes surfaces build. */
function toEngineLine(i, remap) {
  const rawProfile = i.taxProfileId ?? i.tax_profile_id ?? null;
  return {
    price: Number(i.price) || 0,
    qty: i.qty || 1,
    voided: !!i.voided,
    discountedPrice: i.discountedPrice,
    itemId: i.itemId ?? i.id ?? null,
    categoryId: i.categoryId ?? i.cat ?? (Array.isArray(i.cats) && i.cats.length ? i.cats[0] : null),
    // Line-level snapshot (order lines copy taxProfileId at add time, exactly
    // like they snapshot taxRateId) - remapped like every other assignment.
    taxProfileId: rawProfile ? (remap[rawProfile] || rawProfile) : null,
    legacy: {
      taxRateId: i.taxRateId ?? i.tax_rate_id ?? null,
      taxOverrides: i.taxOverrides ?? i.tax_overrides ?? undefined,
    },
  };
}

/** The v2 named-lines record for closed_checks.tax_breakdown. */
function v2Record(eng, source, orderType) {
  if (!eng) return null;
  return {
    version: 2,
    source,
    orderType,
    lines: eng.lines,
    exclusiveTaxTotal: eng.exclusiveTaxTotal,
    inclusiveExtractedTotal: eng.inclusiveExtractedTotal,
  };
}

/**
 * THE seam. Compute an order's tax through profiles-or-legacy and return the
 * engine result PLUS the synthesised legacy shape:
 *
 *   { subtotal, totalTax, total, exclusiveTax, breakdown, hasExclusiveTax,
 *     taxV2, source }
 *
 * On a legacy-equivalent venue the legacy keys are calculateOrderTax's OWN
 * output object spread - byte-identical numbers, guaranteed by construction.
 *
 * @param {Array}  items    order lines (any of the shapes surfaces build today)
 * @param {Object} taxCtx   getTaxContext() / buildLocalTaxCtx() / { taxRates }
 * @param {string} orderType
 */
export function computeOrderTaxUnified(items = [], taxCtx = null, orderType = 'dine-in') {
  const prep = prepareTaxCtx(taxCtx);
  const live = (items || []).filter(i => i && !i.voided);
  const engineLines = live.map(i => toEngineLine(i, prep.remap));
  // A line-level profile snapshot forces the engine path even when the current
  // menu maps are empty (the item was un-assigned after the line was added).
  // v5.7.34 MONEY FIX: only a snapshot that resolves a LOADED profile counts -
  // a dangling snapshot must fall through the cascade (see prepareTaxCtx),
  // never zero the line, and must not knock a legacy venue off the byte-
  // identical parity path.
  const anyLineProfile = engineLines.some(l => l.taxProfileId && prep.profilesById[l.taxProfileId]);

  const baseResolve = makeCascadeResolver({
    itemProfileIds: prep.itemProfileIds,
    categoryProfileIds: prep.categoryProfileIds,
    venueDefaultProfileId: prep.venueDefaultProfileId,
    legacyRateToProfileId: prep.legacyRateToProfileId,
    legacyDefaultProfileId: prep.legacyDefaultProfileId,
    profilesById: prep.profilesById,   // dangling ids fall through, never zero
  });
  const resolveProfileId = (ol, ot) =>
    (ol.taxProfileId && prep.profilesById[ol.taxProfileId]) ? ol.taxProfileId : baseResolve(ol, ot);

  let eng = null;
  let engErr = null;
  try {
    eng = computeTax({
      lines: engineLines,
      profilesById: prep.profilesById,
      resolveProfileId,
      orderType,
      currencyMinorUnit: 2,
    });
  } catch (e) {
    engErr = e;   // invalid profile config - fail toward legacy, never a guess
  }

  if (prep.legacyEquivalent && !anyLineProfile) {
    // PARITY PATH - calculateOrderTax is the engine of record: byte-identical
    // to v5.7.31 slice 0 on every venue configured purely through tax_rates
    // (every UK site). The profiles engine only contributes the v2 record.
    const leg = calculateOrderTax(items || [], prep.taxRates, orderType);
    return { ...leg, taxV2: v2Record(eng, 'legacy', orderType), source: 'legacy' };
  }

  if (!eng) {
    // Engine refused the profile config - conservative fallback to the legacy
    // engine over tax_rates (the pre-cutover behaviour), flagged honestly.
    if (typeof console !== 'undefined') console.warn('[taxCompute] profiles engine failed - legacy fallback:', engErr?.message || engErr);
    const leg = calculateOrderTax(items || [], prep.taxRates, orderType);
    return { ...leg, taxV2: null, source: 'legacy-fallback' };
  }

  // PROFILES PATH - synthesise the legacy read shape from the engine result.
  const grossGoods = live.reduce((s, i) => s + (Number(i.price) || 0) * (i.qty || 1), 0);
  const breakdown = eng.legacyBreakdown.breakdown;
  const totalTax = eng.legacyBreakdown.totalTax;
  let inclusiveRaw = 0;
  for (const b of breakdown) if (b.rate && b.rate.type === 'inclusive') inclusiveRaw += b.tax;
  const exclusiveRaw = totalTax - inclusiveRaw;
  return {
    subtotal: grossGoods - inclusiveRaw,           // net of extracted inclusive tax
    totalTax,                                      // RAW, like calculateOrderTax
    total: grossGoods + exclusiveRaw,              // goods + added-on share (raw)
    exclusiveTax: eng.exclusiveTaxTotal,           // ROUNDED - the only chargeable figure
    breakdown,                                     // [{rate, tax, net, gross, items}] rate-desc
    hasExclusiveTax: breakdown.some(b => !b.rate || b.rate.type === 'exclusive'),
    taxV2: v2Record(eng, 'profiles', orderType),
    source: 'profiles',
  };
}
