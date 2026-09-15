import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseTipRule, tipRuleFor, tipRuleFromCatering, tipChips, tipInitialKey, tipAmount, parsePctList, TIP_DEFAULTS, tipBasis, tipBasisMinor, tipInitialKeyFor } from './tipping.js';

test('defaults: online off, qr on, nothing pre-selected', () => {
  assert.equal(TIP_DEFAULTS.online.on, false);
  assert.equal(TIP_DEFAULTS.qr.on, true);
  assert.equal(TIP_DEFAULTS.qr.default, null);
  assert.equal(tipInitialKey(tipRuleFor({}, 'qr')), '0');           // "No tip" pre-selected
  assert.equal(tipInitialKey(tipRuleFor(null, 'online')), '0');
});

test('a pre-selected default must be one of the chips or it is cleared', () => {
  const r = normaliseTipRule({ on: true, pct: [5, 10], default: 12.5 });
  assert.equal(r.default, null);
  const ok = normaliseTipRule({ on: true, pct: [5, 10], default: 10 });
  assert.equal(ok.default, 10);
  assert.equal(tipInitialKey(ok), '10');
});

test('pct list is cleaned, deduped, sorted and bounded to (0,100]', () => {
  const r = normaliseTipRule({ on: true, pct: ['15', 5, 5, 0, -3, 150, 'x', 12.5] });
  assert.deepEqual(r.pct, [5, 12.5, 15]);
  assert.deepEqual(parsePctList('10, 5,, 12.5 abc 200'), [5, 10, 12.5]);
});

test('garbage config falls back to module defaults rather than throwing', () => {
  assert.deepEqual(tipRuleFor({ tipping_config: 'nope' }, 'qr'), { ...TIP_DEFAULTS.qr, pct: [...TIP_DEFAULTS.qr.pct] });
  assert.deepEqual(tipRuleFor({ tipping_config: { qr: 42 } }, 'qr').pct, [...TIP_DEFAULTS.qr.pct]);
});

test('chips always start with No tip and end with custom when allowed', () => {
  const on = tipChips(normaliseTipRule({ on: true, pct: [5, 10], custom: true }));
  assert.deepEqual(on.map(c => c.key), ['0', '5', '10', 'custom']);
  const noCustom = tipChips(normaliseTipRule({ on: true, pct: [5, 10], custom: false }));
  assert.deepEqual(noCustom.map(c => c.key), ['0', '5', '10']);
});

test('tip maths: percentage of subtotal, rounded to the penny, never negative', () => {
  assert.equal(tipAmount(16, '10'), 1.6);
  assert.equal(tipAmount(16, '12.5'), 2);
  assert.equal(tipAmount(33.33, '15'), 5);        // 4.9995 -> 5.00
  assert.equal(tipAmount(16, '0'), 0);
  assert.equal(tipAmount(16, 'custom', '2.505'), 2.51);
  assert.equal(tipAmount(16, 'custom', '-4'), 0);
  assert.equal(tipAmount(16, 'custom', 'abc'), 0);
  assert.equal(tipAmount(-5, '10'), 0);
});

test('catering columns map onto the same shape', () => {
  const r = tipRuleFromCatering({ tips_enabled: true, tip_percentages: [5, 10, 15, 20], tip_default_pct: 10, tip_allow_custom: false });
  assert.equal(r.on, true); assert.equal(r.default, 10); assert.equal(r.custom, false);
  const off = tipRuleFromCatering({ tips_enabled: false });
  assert.equal(off.on, false);
  const legacy = tipRuleFromCatering({ tips_enabled: true, tip_default_pct: 10 });   // pre-migration row
  assert.deepEqual(legacy.pct, [5, 10, 15, 20]); assert.equal(legacy.default, 10);
});

// ── v5.8.19: the tip BASIS rule ─────────────────────────────────────────────
test('tip basis is goods after discounts, nothing else', () => {
  assert.equal(tipBasis({ goods: 50, discounts: 5 }), 45);
  assert.equal(tipBasis({ goods: 50 }), 50);
  assert.equal(tipBasis({ goods: 5, discounts: 9 }), 0);
  assert.equal(tipBasisMinor({ goodsMinor: 5000, discountsMinor: 500 }), 4500);
});

test('the same order tips the same everywhere: £50 meal, £5 off, 12.5% service, £2.70 tax', () => {
  const basis = tipBasis({ goods: 50, discounts: 5 });           // 45, service + tax excluded
  assert.equal(tipAmount(basis, '15', null), 6.75);
});

test('a service charge on the bill means No tip is pre-selected', () => {
  const rule = { on: true, pct: [5, 10, 15], default: 10, custom: true };
  assert.equal(tipInitialKeyFor(rule, { serviceCharge: 4.5 }), '0');
  assert.equal(tipInitialKeyFor(rule, { serviceCharge: 0 }), '10');
});

// ── The new kiosk design: tipping_config.kiosk ──────────────────────────────
import fs from 'node:fs';
import {
  TIP_MODULES, KIOSK_TIP_MAX_PCT, normaliseKioskTipRule, kioskTipRule, mergeTippingConfig, buildKioskTipPatch, sameKioskTipRule,
} from './tipping.js';

test('kiosk is a tipping module with No tip pre-selected and no custom amount', () => {
  assert.ok(TIP_MODULES.includes('kiosk'));
  assert.deepEqual(TIP_DEFAULTS.kiosk, { on: true, pct: [10, 12.5, 15], default: null, custom: false });
  assert.equal(KIOSK_TIP_MAX_PCT, 3);
});

test('kiosk rule: three lowest percentages, custom forced off, default must be a chip', () => {
  const r = normaliseKioskTipRule({ on: true, pct: [20, 5, 10, 15], default: 20, custom: true });
  assert.deepEqual(r, { on: true, pct: [5, 10, 15], default: null, custom: false });
  assert.equal(normaliseKioskTipRule({ on: true, pct: [5, 10], default: 10 }).default, 10);
  assert.equal(normaliseKioskTipRule({ on: false }).on, false);
  assert.deepEqual(normaliseKioskTipRule(null).pct, [10, 12.5, 15]);
});

test('kiosk rule reads the venue rule, else the profile presets', () => {
  const venue = { tipping_config: { kiosk: { on: false, pct: [5, 10], default: null, custom: false } } };
  assert.deepEqual(kioskTipRule(venue, { kiosk_tip_presets: [18, 20, 25] }), { on: false, pct: [5, 10], default: null, custom: false });
  assert.deepEqual(kioskTipRule({ tipping_config: { online: {} } }, { kiosk_tip_presets: [0, 12, 15, 18] }), { on: true, pct: [12, 15, 18], default: null, custom: false });
  assert.deepEqual(kioskTipRule(null, null), { on: true, pct: [10, 12.5, 15], default: null, custom: false });
  assert.deepEqual(kioskTipRule({ tipping_config: 'x' }, { kiosk_tip_presets: [0, 0, 0] }).pct, [10, 12.5, 15]);
});

test('saving one module keeps the others', () => {
  const cur = { online: { on: true }, qr: { on: false } };
  assert.deepEqual(mergeTippingConfig(cur, { kiosk: { on: true } }), { online: { on: true }, qr: { on: false }, kiosk: { on: true } });
  assert.deepEqual(mergeTippingConfig(cur, { online: { on: false } }), { online: { on: false }, qr: { on: false } });
  assert.equal(mergeTippingConfig(cur, null), null);
  assert.deepEqual(mergeTippingConfig(null, { qr: { on: true } }), { qr: { on: true } });
});

test('the kiosk tipping patch always carries the stored online and qr rules', () => {
  const stored = { online: { on: true, pct: [5], default: null, custom: true }, qr: { on: true, pct: [10], default: 10, custom: false }, kiosk: { on: true } };
  const patch = buildKioskTipPatch(stored, { on: true, pct: [10, 15], default: 15 });
  assert.deepEqual(patch, {
    tipping_config: {
      online: stored.online,
      qr: stored.qr,
      kiosk: { on: true, pct: [10, 15], default: 15, custom: false },
    },
  });
  assert.deepEqual(Object.keys(buildKioskTipPatch(null, { on: false }).tipping_config), ['kiosk']);
});

test('the save check compares normalised rules', () => {
  assert.equal(sameKioskTipRule({ on: true, pct: [15, 10], default: null }, { on: true, pct: [10, 15], default: null, custom: false }), true);
  assert.equal(sameKioskTipRule({ on: true, pct: [10] }, { on: false, pct: [10] }), false);
  assert.equal(sameKioskTipRule(undefined, { on: true }), false);
});

test('location-admin keeps the kiosk module and merges tipping_config', () => {
  const src = fs.readFileSync(new URL('../../supabase/functions/location-admin/index.ts', import.meta.url), 'utf8');
  assert.ok(src.includes("for (const mod of ['online', 'qr', 'kiosk'])"), 'module list');
  assert.ok(src.includes('row.tipping_config = {'), 'merge before update');
});
