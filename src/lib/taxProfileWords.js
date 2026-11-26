/**
 * taxProfileWords.js: the words the Menu screens use for tax, so every picker shows the RATE and
 * says which rule a product really charges through.
 *
 * Peter, Mozz Sandy, 25 Nov 2026: "none of the tools we built show the tax rates in the new
 * version of taxes which means I cant do whats needed". The venue had a real tax profile as its
 * default (Prepared food: Sales tax 7.45% + Restaurant tax 1%), and the Menu screen:
 *   - warned that 14 products "have no tax rate" (they charged 8.45% through the profile),
 *   - offered only the old style rates (7.45% Sales tax, Tax Exempt), where one click would have
 *     put 7.45% on every pizza, because a product's old rate comes BEFORE the venue profile,
 *   - listed profiles by name alone ("Prepared food", no figure),
 *   - showed 7.45% as "7.4%" and 0% as "%".
 *
 * The order here is the tax engine's own (taxEngine.makeCascadeResolver), first hit wins:
 *   1. the product's tax profile
 *   2. the product's old style rate
 *   3. the category's tax profile
 *   4. the venue default profile
 *   5. the venue's old style default rate
 *   6. nothing
 * Order type overrides (step 2, old style rates only) are not read here: these words describe the
 * product's base rule, the same for every order type.
 *
 * Pure, import free, so node:test can load it (taxProfileWords.test.js).
 */

/** 0.0745 gives "7.45", 0.01 gives "1", 0 gives "0", 0.08875 gives "8.875". Never blank. */
export function pctText(rate) {
  const n = Number(rate);
  if (!Number.isFinite(n)) return '0';
  const s = (Math.round(n * 100 * 1000) / 1000).toFixed(3).replace(/\.?0+$/, '');
  return s === '' || s === '-0' ? '0' : s;
}

const liveLines = (profile) => (Array.isArray(profile?.lines) ? profile.lines.filter(l => l && l.active !== false) : []);
// Either spelling: the store's camel rows, or raw tax_profile_lines rows (the multi site menu reads those).
const forAllOrderTypes = (line) => { const t = line.orderTypes ?? line.order_types; return !Array.isArray(t) || t.length === 0 || t.includes('all'); };
const isPerUnit = (line) => (line.lineType ?? line.line_type ?? 'rate') === 'per_unit';

/**
 * The rate a profile charges, in a few words:
 *   "8.45%"                    its lines added up (Sales tax 7.45% + Restaurant tax 1%)
 *   "20% incl."                every line is inside the price
 *   "7.25% + 2.125% compound"  a compound line cannot be added up, so the parts are named
 *   "8.45% + 0.10 each"        a per unit line beside the rate lines
 *   "varies by order type"     a line that only applies to some order types
 *   "no lines"                 a profile with nothing on it
 */
export function profileRateWords(profile) {
  const lines = liveLines(profile);
  if (!lines.length) return 'no lines';
  if (lines.some(l => !forAllOrderTypes(l))) return 'varies by order type';
  const rateLines = lines.filter(l => !isPerUnit(l));
  const unitLines = lines.filter(isPerUnit);
  const parts = [];
  if (rateLines.length) {
    if (rateLines.some(l => l.compound)) {
      parts.push(rateLines.map(l => `${pctText(l.rate)}%${l.compound ? ' compound' : ''}`).join(' + '));
    } else {
      // Whole thousandths of a percent, so 0.0745 + 0.01 is 8.45 and never 8.450000000000001.
      const total = rateLines.reduce((sum, l) => sum + Math.round((Number(l.rate) || 0) * 100000), 0) / 100000;
      parts.push(`${pctText(total)}%`);
    }
  }
  for (const l of unitLines) {
    const each = Number(l.flatAmount ?? l.flat_amount) || 0;
    parts.push(`${each.toFixed(2)} each`);
  }
  const allInside = rateLines.length > 0 && rateLines.every(l => l.mode === 'inclusive');
  return parts.join(' + ') + (allInside ? ' incl.' : '');
}

/** "Prepared food (8.45%)". */
export function profileLabel(profile) {
  if (!profile) return '';
  return `${profile.name || 'Tax profile'} (${profileRateWords(profile)})`;
}

/** "Sales tax (7.45% excl.)": an old style rate with its full figure. */
export function rateLabel(rate) {
  if (!rate) return '';
  return `${rate.name || 'Rate'} (${pctText(rate.rate)}% ${rate.type === 'inclusive' ? 'incl.' : 'excl.'})`;
}

const activeById = (list, id) => (id ? (list || []).find(x => x && x.id === id && x.active !== false) || null : null);

/**
 * The rule a product charges through, by the engine's order.
 *   from: 'product' | 'category' | 'venue' | 'none'
 *   kind: 'profile' | 'rate' | 'none'
 * `skipOwn` leaves out the product's own profile and own rate: what it would follow without them
 * (the words of the "follow" option in a picker).
 */
export function taxRuleFor({ item, category = null, taxRates = [], taxProfiles = [], venueDefaultProfileId = null, skipOwn = false } = {}) {
  if (!skipOwn) {
    const own = activeById(taxProfiles, item?.taxProfileId ?? item?.tax_profile_id);
    if (own) return { from: 'product', kind: 'profile', profile: own, label: profileLabel(own) };
    const ownRate = activeById(taxRates, item?.taxRateId ?? item?.tax_rate_id);
    if (ownRate) return { from: 'product', kind: 'rate', rate: ownRate, label: rateLabel(ownRate) };
  }
  const catProfile = activeById(taxProfiles, category?.taxProfileId ?? category?.tax_profile_id);
  if (catProfile) return { from: 'category', kind: 'profile', profile: catProfile, label: profileLabel(catProfile), categoryName: category?.label || category?.name || '' };
  const venueProfile = activeById(taxProfiles, venueDefaultProfileId);
  if (venueProfile) return { from: 'venue', kind: 'profile', profile: venueProfile, label: profileLabel(venueProfile) };
  const venueRate = (taxRates || []).find(r => r && (r.isDefault || r.is_default) && r.active !== false) || null;
  if (venueRate) return { from: 'venue', kind: 'rate', rate: venueRate, label: rateLabel(venueRate) };
  return { from: 'none', kind: 'none', label: '' };
}

/** One sentence for the product's Tax tab: what it charges and where that comes from. */
export function taxRuleWords(rule) {
  if (!rule || rule.kind === 'none') return 'No tax: nothing is set on this product, its category or the venue.';
  const what = rule.label;
  if (rule.from === 'product') return rule.kind === 'profile' ? `${what}, set on this product.` : `${what}, an old style rate set on this product.`;
  if (rule.from === 'category') return `${what}, from its category${rule.categoryName ? ` (${rule.categoryName})` : ''}.`;
  return rule.kind === 'profile' ? `${what}, the venue default.` : `${what}, the venue's default rate.`;
}

/**
 * Does this venue run on a real tax profile? True when its default profile is live and is not
 * a generated copy of an old style rate (a UK venue's default is such a copy, and it keeps
 * working through its rates exactly as before). `isMirror` is taxCompute.isLegacyMirror, passed
 * in so this file stays import free.
 */
export function venueRunsOnProfiles({ taxProfiles = [], taxRates = [], venueDefaultProfileId = null, isMirror = null } = {}) {
  const def = activeById(taxProfiles, venueDefaultProfileId);
  if (!def) return false;
  if (typeof isMirror !== 'function') return !(def.generatedFromRateId ?? def.generated_from_rate_id);
  const ratesById = {};
  for (const r of (taxRates || [])) if (r && r.id) ratesById[r.id] = r;
  return !isMirror(def, ratesById);
}

/** The products that hold an old style rate of this venue's (which comes before the profiles). */
export function productsOnOldRate(items, taxRates) {
  const live = new Set((taxRates || []).filter(r => r && r.active !== false).map(r => r.id));
  return (items || []).filter(i => i && !i.archived && !(i.taxProfileId ?? i.tax_profile_id) && live.has(i.taxRateId ?? i.tax_rate_id));
}

/**
 * The old style rate a NEW product is born with, or null.
 *
 * Since v5.5.961 a new product is stamped with the venue's default rate, so a product priced before
 * tax was set up is never left untaxed. At a venue that charges through a real tax profile that
 * stamp is wrong: the old rate comes BEFORE the profile, so the product charges the old rate alone.
 * Mozz Sandy, 25 Nov 2026: four salad sizes were born on "Sales tax 7.45%" while the venue profile
 * was 8.45% (Sales tax + Restaurant tax). There, nothing is stamped and the product follows its
 * category and the venue profile like every other.
 */
export function rateForNewProduct({ taxRates = [], taxProfiles = [], venueDefaultProfileId = null, isMirror = null } = {}) {
  if (venueRunsOnProfiles({ taxProfiles, taxRates, venueDefaultProfileId, isMirror })) return null;
  const def = (taxRates || []).find(r => r && (r.isDefault || r.is_default) && r.active !== false);
  return def ? def.id : null;
}
