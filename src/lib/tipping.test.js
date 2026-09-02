import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseTipRule, tipRuleFor, tipRuleFromCatering, tipChips, tipInitialKey, tipAmount, parsePctList, TIP_DEFAULTS } from './tipping.js';

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
