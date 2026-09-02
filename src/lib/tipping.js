// src/lib/tipping.js
//
// One shape for "how do we ask this customer for a tip", used by online
// ordering, QR and catering. Kiosk keeps device_profiles.kiosk_tip_presets and
// the card reader keeps location_reader_settings; both pre-date this and the
// reader one is pushed to hardware, so neither is re-pointed here.
//
//   { on: bool, pct: number[], default: number|null, custom: bool }
//
// `default` is the pre-selected chip. null means "No tip" is pre-selected.
// That is deliberate: a pre-ticked gratuity the operator cannot switch off is
// a Tipping Act 2023 problem, and QR shipped exactly that for months.

export const TIP_MODULES = ['online', 'qr'];

export const TIP_DEFAULTS = Object.freeze({
  online: Object.freeze({ on: false, pct: [5, 10, 12.5, 15], default: null, custom: true }),
  qr:     Object.freeze({ on: true,  pct: [5, 10, 12.5, 15], default: null, custom: true }),
});

const clampPct = (n) => {
  const x = Number(n);
  return Number.isFinite(x) && x > 0 && x <= 100 ? Math.round(x * 100) / 100 : null;
};

/** Normalise one module's rule. Tolerates partial or garbage input. */
export function normaliseTipRule(raw, fallback = TIP_DEFAULTS.qr) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const pct = Array.isArray(r.pct)
    ? [...new Set(r.pct.map(clampPct).filter(v => v !== null))].sort((a, b) => a - b)
    : [...fallback.pct];
  const def = clampPct(r.default);
  return {
    on: typeof r.on === 'boolean' ? r.on : fallback.on,
    pct: pct.length ? pct : [...fallback.pct],
    // The default must be one of the chips, or it silently vanishes in the UI.
    default: def !== null && pct.includes(def) ? def : null,
    custom: typeof r.custom === 'boolean' ? r.custom : fallback.custom,
  };
}

/** The rule for a module from a location row (platform.locations.tipping_config). */
export function tipRuleFor(location, module) {
  const fallback = TIP_DEFAULTS[module] || TIP_DEFAULTS.qr;
  const cfg = location?.tipping_config;
  return normaliseTipRule(cfg && typeof cfg === 'object' ? cfg[module] : null, fallback);
}

/** Catering stores its rule as columns, not jsonb. Same shape out. */
export function tipRuleFromCatering(cfg) {
  return normaliseTipRule({
    on: !!cfg?.tips_enabled,
    pct: Array.isArray(cfg?.tip_percentages) ? cfg.tip_percentages : [5, 10, 15, 20],
    default: cfg?.tip_default_pct,
    custom: cfg?.tip_allow_custom !== false,
  }, { on: false, pct: [5, 10, 15, 20], default: null, custom: true });
}

/**
 * Chip list for the UI. Always starts with "No tip"; ends with custom if allowed.
 * @returns {{ key:string, label:string }[]}
 */
export function tipChips(rule) {
  const out = [{ key: '0', label: 'No tip' }];
  rule.pct.forEach(p => out.push({ key: String(p), label: `${p}%` }));
  if (rule.custom) out.push({ key: 'custom', label: '✏️' });
  return out;
}

/** The chip key to pre-select. */
export function tipInitialKey(rule) {
  return rule.default !== null ? String(rule.default) : '0';
}

/** Money. Tips are on the discounted subtotal and are never VAT-rated. */
export function tipAmount(subtotal, key, customValue) {
  if (!key || key === '0') return 0;
  if (key === 'custom') return Math.max(0, Math.round((Number(customValue) || 0) * 100) / 100);
  const p = Number(key);
  if (!Number.isFinite(p) || p <= 0) return 0;
  return Math.round(Math.max(0, Number(subtotal) || 0) * p) / 100;
}

/** For Back Office: parse "5, 10, 12.5" into a clean list. */
export function parsePctList(text) {
  return [...new Set(String(text || '').split(/[,\s]+/).map(clampPct).filter(v => v !== null))].sort((a, b) => a - b);
}

// ── The tip BASIS: one rule, every surface, both countries ──────────────────
//
// A tip percentage applies to the FOOD AND DRINK AFTER DISCOUNTS, and to
// nothing else. Not added-on sales tax, not a service charge, not a delivery
// fee. In the UK prices are VAT-inclusive so this is the price as printed; in
// the US it is the pre-tax subtotal. Verified 2 Sep 2026 against:
//   - Emily Post (US): sit-down service "15-20%, pre-tax".
//   - IRS Rev. Rul. 2012-18 Example B: suggested tips "of 15%, 18% and 20% of
//     the price of food and beverages" count as tips; a tip must be "free from
//     compulsion" with "the unrestricted right to determine the amount".
//   - Debrett's (UK): 10-15% "of the bill" when service is not included.
//   - Which? (UK, 2025): a service charge and a tip are alternatives; one in
//     six people tipped on top of a service charge without realising.
//
// Before this, seven surfaces multiplied seven different amounts (the card
// reader included service charge AND tax; the kiosk ignored discounts; MPOS
// added sales tax; the Adyen terminal used whatever the card took).
export function tipBasis({ goods = 0, discounts = 0 } = {}) {
  return Math.max(0, +((Number(goods) || 0) - (Number(discounts) || 0)).toFixed(2));
}
export function tipBasisMinor({ goodsMinor = 0, discountsMinor = 0 } = {}) {
  return Math.max(0, Math.round((Number(goodsMinor) || 0) - (Number(discountsMinor) || 0)));
}

// When an automatic service charge is already on the bill, nothing is
// pre-selected, whatever the venue's default: the "tipping twice" trap that
// Which? measured. The chips stay available; the guest chooses.
export function tipInitialKeyFor(rule, { serviceCharge = 0 } = {}) {
  if (Number(serviceCharge) > 0) return '0';
  return tipInitialKey(rule);
}
