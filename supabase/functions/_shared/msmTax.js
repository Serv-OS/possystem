// supabase/functions/_shared/msmTax.js
//
// MULTI SITE MENU, ROUND 2 (17 Oct 2026, v5.11.75): VAT per order type. Pure, no imports beyond
// msmModel.js, shared by the planner (msmPlan.js), the import (msmImport.js), the health check and
// the screens. Tested in src/lib/msm/msmTax.test.js.
//
// Peter, 17 Oct 2026: price per order type and VAT per order type, "a bit more idiot proof".
//
// THE RULES (design 5.3 and the design review)
//   * The group menu holds msm_products.tax_by_type: { "takeaway": { name, percent }, ... }, only
//     the four ORDER_TYPE_TAX_KEYS. A missing key means "same as the product's VAT".
//   * Publish writes menu_items.tax_overrides as { key: <that site's own tax_rates.id> }, mapped by
//     name and percent, then the only rate at that percent, then (for 0%) the zero, exempt or
//     outside kind. No match blocks that site, in words. Never a foreign id.
//   * Only those four keys are ever written, one by one. Every other key a site holds (counter,
//     drive-thru, collection) and every explicit null stays exactly as it is (review blocker 2).
//   * A size inherits its product's overrides. A size that already has overrides of its own gets
//     the full set, never a part (sizes do not merge with their product on any engine).
//   * The tax profile trap: an item's tax_profile_id wins over its order type VAT on the till,
//     kiosk, online and QR. Publish clears it ONLY when it is still a generated copy of the item's
//     own rate (isMirrorProfile, the same conditions as src/lib/taxCompute.js isLegacyMirror and
//     public.msm__is_legacy_mirror; the three are pinned to one fixture list), and can put that same
//     copy back later (Undo). A real profile blocks order type VAT at that site, in words.

import { ORDER_TYPE_TAX_KEYS, has } from './msmModel.js';

const listOf = (v) => (Array.isArray(v) ? v : []);
const lower = (s) => String(s ?? '').trim().toLowerCase();

// The words for each key (the screens take theirs from msmWords; these are for the planner's
// lines and the health check, which run on the server too).
export const TAX_KEY_LABEL = Object.freeze({ 'dine-in': 'Eat in', takeaway: 'Takeaway', delivery: 'Delivery', bar: 'Bar tab' });

/** { name, percent } for a venue rate row (or null). */
export function rateDescriptor(rate) {
  if (!rate) return null;
  return { name: String(rate.name ?? '').trim(), percent: Number(rate.rate) };
}

// The kind of a 0% rate from its name: zero rated, exempt, or outside the scope of VAT.
export function zeroKind(name) {
  const n = lower(name);
  if (/exempt/.test(n)) return 'exempt';
  if (/outside|out of scope|no vat|non vat|not vat/.test(n)) return 'outside';
  if (/zero|0 ?%/.test(n)) return 'zero';
  return null;
}

/**
 * A rate descriptor { name, percent } mapped to one of a site's rates: by name and percent, then the
 * only rate at that percent, then for 0% the only rate of the same kind. { id, ok }.
 */
export function mapRateDescriptor(desc, taxRates) {
  if (!desc || typeof desc !== 'object') return { id: null, ok: false };
  const rates = listOf(taxRates).filter((r) => r && r.active !== false);
  const pct = desc.percent == null || desc.percent === '' ? null : Number(desc.percent);
  const same = (r) => pct == null || Math.abs(Number(r.rate) - pct) < 0.0001;
  const byName = rates.filter((r) => lower(r.name) === lower(desc.name) && same(r));
  if (byName.length === 1) return { id: byName[0].id, ok: true };
  if (pct == null) return { id: null, ok: false };
  const byPct = rates.filter(same);
  if (byPct.length === 1) return { id: byPct[0].id, ok: true };
  if (pct === 0 && byPct.length > 1) {
    const kind = zeroKind(desc.name);
    const byKind = kind ? byPct.filter((r) => zeroKind(r.name) === kind) : [];
    if (byKind.length === 1) return { id: byKind[0].id, ok: true };
  }
  return { id: null, ok: false };
}

/** Only the four keys, each { name, percent }. Anything else is dropped. null when empty. */
export function cleanTaxByType(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const out = {};
  for (const k of ORDER_TYPE_TAX_KEYS) {
    const v = obj[k];
    if (v && typeof v === 'object' && (v.name != null || v.percent != null)) out[k] = { name: String(v.name ?? '').trim(), percent: v.percent == null ? null : Number(v.percent) };
  }
  return Object.keys(out).length ? out : null;
}

/** The VAT by order type a product follows: a size follows its product's. */
export function effectiveTaxByType(product, productById) {
  if (!product) return {};
  const parent = product.parent_product_id && productById ? productById.get(product.parent_product_id) : null;
  return cleanTaxByType(parent ? parent.tax_by_type : product.tax_by_type) || {};
}

/** Does a site's row carry any of the four keys with a rate (an explicit null counts as a value too)? */
export const hasOwnTypeOverrides = (overrides) => !!overrides && typeof overrides === 'object' && Object.keys(overrides).length > 0;

/**
 * The words for a key's value at a site: a rate's name and percent, "the venue default" for an
 * explicit null, or "same as the product" when the key is not there.
 */
export function overrideWords(value, taxRates) {
  if (value === undefined || value === false) return 'same as the product';
  if (value === null) return "the site's default VAT";
  const r = listOf(taxRates).find((x) => x && x.id === value);
  return r ? `${r.name} (${Number(r.rate)}%)` : 'a VAT rate that is not at this site';
}

// ── The tax profile mirror check (raw database rows) ────────────────────────
//
// A profile is a generated copy of a rate when ALL of these hold (taxCompute.js isLegacyMirror):
//   generated_from_rate_id is set and its rate is active; rounding level is not 'item'; exactly one
//   active line; that line is a rate line, not compound, not taxable, has no order type limit,
//   the same inclusive or exclusive mode and the same rate as its source; and its basis settings
//   are the ones the adapter gives that rate (inclusive: pre discount, no service, no delivery;
//   exclusive: post discount, service on, delivery off).
// Plus, for publish (review blocker 3): the copy's source rate IS the item's own rate after the
// write, so clearing it can never change what the item is taxed at.

/**
 * profile  tax_profiles row; lines  its tax_profile_lines rows (any order); rate  the tax_rates row
 * of generated_from_rate_id (or null). Returns true or false.
 */
export function isMirrorProfile(profile, lines, rate) {
  const src = profile?.generated_from_rate_id ?? profile?.generatedFromRateId ?? null;
  if (!src || !rate || String(rate.id) !== String(src)) return false;
  if (rate.active === false) return false;
  const level = profile.rounding && typeof profile.rounding === 'object' ? (profile.rounding.level ?? 'invoice') : 'invoice';
  if (level === 'item') return false;
  const active = listOf(lines).filter((l) => l && l.active !== false && String(l.profile_id ?? l.profileId ?? profile.id) === String(profile.id));
  if (active.length !== 1) return false;
  const l = active[0];
  const rateMode = rate.type === 'inclusive' ? 'inclusive' : 'exclusive';
  const lineMode = l.mode === 'inclusive' ? 'inclusive' : 'exclusive';
  const addedOn = rateMode !== 'inclusive';
  const basis = l.tax_basis ?? l.taxBasis ?? 'pre_discount';
  const svc = l.tax_service_charge ?? l.taxServiceCharge;
  const del = l.tax_delivery_fee ?? l.taxDeliveryFee;
  const mineBasis = (basis === 'pre_discount' || basis === 'post_discount') ? basis : (addedOn ? 'post_discount' : 'pre_discount');
  const mineSvc = typeof svc === 'boolean' ? svc : addedOn;
  const mineDel = typeof del === 'boolean' ? del : false;
  const orderTypes = l.order_types ?? l.orderTypes;
  return (l.line_type ?? l.lineType ?? 'rate') === 'rate'
    && l.compound !== true && l.taxable !== true
    && mineBasis === (addedOn ? 'post_discount' : 'pre_discount')
    && mineSvc === addedOn
    && mineDel === false
    && (!Array.isArray(orderTypes) || orderTypes.length === 0 || orderTypes.includes('all'))
    && lineMode === rateMode
    && Math.abs((Number(l.rate) || 0) - (parseFloat(rate.rate) || 0)) < 1e-9;
}

/**
 * Is a venue's profile still a generated copy of `rateId` (the item's rate after the write)?
 *   venue  readVenueRaw shape (taxProfiles, taxProfileLines, taxRates; the rates read are the active
 *          ones, and a copy of a switched off rate is not a copy)
 * true / false, or null when the venue's profiles could not be read (the caller blocks in words).
 */
export function venueProfileIsMirror(venue, profileId, rateId) {
  if (!profileId) return false;
  if (!Array.isArray(venue?.taxProfiles) || !Array.isArray(venue?.taxProfileLines)) return null;
  const profile = venue.taxProfiles.find((p) => p && String(p.id) === String(profileId));
  if (!profile) return false;
  if (!rateId || String(profile.generated_from_rate_id ?? '') !== String(rateId)) return false;
  const rate = listOf(venue.taxRates).find((r) => r && String(r.id) === String(rateId)) || null;
  return isMirrorProfile(profile, venue.taxProfileLines.filter((l) => String(l.profile_id) === String(profile.id)), rate);
}

// ── Import: the group's VAT by order type and what each site keeps ──────────

// One site's value for a key, as a comparable token: 'none' (no key), 'null' (an explicit null),
// 'rate:<name>|<percent>' (a rate at that site), 'raw:<id>' (an id that is not a rate there).
function tokenOf(overrides, key, taxRates) {
  if (!overrides || typeof overrides !== 'object' || !has(overrides, key)) return 'none';
  const v = overrides[key];
  if (v === null) return 'null';
  const r = listOf(taxRates).find((x) => x && String(x.id) === String(v));
  return r ? `rate:${lower(r.name)}|${Number(r.rate)}` : `raw:${v}`;
}

/**
 * The group's VAT by order type for a product, from its rows at each site, and what each site keeps.
 *   members   [{ loc, row }]        the product's venue rows
 *   ratesOf   (loc) => tax rates at that site
 *   masterLoc the site whose value wins a tie
 *   base      the tax_by_type to compare with (a size compares with its product's), or undefined to
 *             work out the most common
 * Returns { taxByType, kept: Map(loc -> object of kept keys) }.
 *   A key's group value is the most common rate across sites (no key and an explicit null count as
 *   "same as the product"); a site that differs keeps its own value: a rate id, null, or false for
 *   "no key here". A site's other keys (counter, drive-thru, collection) are kept too, as they are.
 */
export function importTaxByType(members, ratesOf, masterLoc = null, base = undefined) {
  const M = listOf(members).filter((m) => m && m.row);
  let taxByType = base === undefined ? {} : (cleanTaxByType(base) || {});
  if (base === undefined) {
    for (const k of ORDER_TYPE_TAX_KEYS) {
      const counts = new Map();
      for (const m of M) {
        const t = tokenOf(m.row.tax_overrides, k, ratesOf(m.loc));
        const key = t.startsWith('rate:') ? t : 'none';
        counts.set(key, (counts.get(key) || 0) + 1);
      }
      const masterTok = (() => { const m = M.find((x) => x.loc === masterLoc) || M[0]; if (!m) return 'none'; const t = tokenOf(m.row.tax_overrides, k, ratesOf(m.loc)); return t.startsWith('rate:') ? t : 'none'; })();
      let best = 'none', bestN = -1;
      for (const [t, n] of counts) if (n > bestN || (n === bestN && t === masterTok)) { best = t; bestN = n; }
      if (best.startsWith('rate:')) {
        const [name, pct] = best.slice(5).split('|');
        // The name as a site writes it (first site holding that rate), for the screen.
        const m = M.find((x) => tokenOf(x.row.tax_overrides, k, ratesOf(x.loc)) === best);
        const r = m ? listOf(ratesOf(m.loc)).find((x) => String(x.id) === String(m.row.tax_overrides[k])) : null;
        taxByType[k] = { name: r ? String(r.name).trim() : name, percent: Number(pct) };
      }
    }
  }
  const kept = new Map();
  for (const m of M) {
    const ov = m.row.tax_overrides && typeof m.row.tax_overrides === 'object' ? m.row.tax_overrides : {};
    const rates = ratesOf(m.loc);
    const out = {};
    for (const k of ORDER_TYPE_TAX_KEYS) {
      const want = taxByType[k];
      const t = tokenOf(ov, k, rates);
      let same;
      if (!want) same = t === 'none';
      else {
        const mapped = mapRateDescriptor(want, rates);
        same = mapped.ok && has(ov, k) && String(ov[k]) === String(mapped.id);
      }
      if (!same) out[k] = has(ov, k) ? ov[k] : false;
    }
    for (const k of Object.keys(ov)) if (!ORDER_TYPE_TAX_KEYS.includes(k)) out[k] = ov[k];
    if (Object.keys(out).length) kept.set(m.loc, out);
  }
  return { taxByType: Object.keys(taxByType).length ? taxByType : null, kept };
}
