// readerSettingsPatch.test.js: database fence stage 1, contract P2. Only six columns of Platform
// location_reader_settings may be written from Back Office, each checked, through location-admin;
// the old direct write runs only while the deployed function does not know the action.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { cleanReaderSettingsPatch, READER_SETTINGS_FIELDS } from '../../supabase/functions/_shared/readerSettingsPatch.js';
import { saveReaderSettingsWithFallback } from './readerSettingsClient.js';

const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

test('exactly the six columns, each checked, unknown keys refused', () => {
  assert.deepEqual([...READER_SETTINGS_FIELDS], ['tipping_enabled', 'tip_percentages', 'allow_custom_tip', 'smart_tip_threshold_minor', 'idle_screen_enabled', 'idle_screen_image_url']);
  const ok = cleanReaderSettingsPatch({ tipping_enabled: true, tip_percentages: [10, 15, 20], allow_custom_tip: 'false', smart_tip_threshold_minor: 1000, idle_screen_enabled: false, idle_screen_image_url: 'https://x.supabase.co/a.png' });
  assert.deepEqual(ok, { ok: true, row: { tipping_enabled: true, tip_percentages: [10, 15, 20], allow_custom_tip: false, smart_tip_threshold_minor: 1000, idle_screen_enabled: false, idle_screen_image_url: 'https://x.supabase.co/a.png' } });
  assert.equal(cleanReaderSettingsPatch({ stripe_configuration_id: 'tmc_1' }).field, 'stripe_configuration_id', 'Stripe fields are server only');
  assert.equal(cleanReaderSettingsPatch({ idle_screen_file_id: 'file_1' }).error, 'unknown_field');
  assert.equal(cleanReaderSettingsPatch({ tip_percentages: [0] }).error, 'invalid_value');
  assert.equal(cleanReaderSettingsPatch({ tip_percentages: [1, 2, 3, 4, 5, 6] }).error, 'invalid_value');
  assert.equal(cleanReaderSettingsPatch({ tip_percentages: [12.5] }).error, 'invalid_value');
  assert.equal(cleanReaderSettingsPatch({ idle_screen_image_url: 'javascript:alert(1)' }).error, 'invalid_value');
  assert.deepEqual(cleanReaderSettingsPatch({ smart_tip_threshold_minor: null, idle_screen_image_url: '' }).row, { smart_tip_threshold_minor: null, idle_screen_image_url: null });
  assert.equal(cleanReaderSettingsPatch({}).error, 'patch is empty');
  assert.equal(cleanReaderSettingsPatch(null).ok, false);
});

test('saves through location-admin; FENCE STAGE 1 FALLBACK only on "unknown action"', async () => {
  const bodies = [];
  const viaFn = await saveReaderSettingsWithFallback({
    opsLocationId: 'L1', patch: { tipping_enabled: true },
    callFunction: async (b) => { bodies.push(b); return { status: 200, data: { ok: true, settings: { tipping_enabled: true } } }; },
    legacyWrite: async () => { throw new Error('must not run'); },
  });
  assert.deepEqual(viaFn, { ok: true, path: 'function', settings: { tipping_enabled: true } });
  assert.deepEqual(bodies, [{ action: 'save_reader_settings', ops_location_id: 'L1', patch: { tipping_enabled: true } }]);

  const rows = [];
  const legacy = await saveReaderSettingsWithFallback({
    opsLocationId: 'L1', patch: { idle_screen_image_url: 'https://a/b.png' },
    callFunction: async () => ({ status: 400, data: { error: 'unknown action: save_reader_settings' } }),
    legacyWrite: async (row) => { rows.push(row); return { error: null }; },
  });
  assert.deepEqual(legacy, { ok: true, path: 'legacy' });
  assert.deepEqual(rows, [{ idle_screen_image_url: 'https://a/b.png' }], 'the fallback writes only the checked columns');

  const refused = await saveReaderSettingsWithFallback({
    opsLocationId: 'L1', patch: { tipping_enabled: true },
    callFunction: async () => ({ status: 403, data: { error: 'no access to this location' } }),
    legacyWrite: async () => { throw new Error('must not run on a refusal'); },
  });
  assert.equal(refused.ok, false); assert.equal(refused.error, 'no access to this location');

  const bad = await saveReaderSettingsWithFallback({ opsLocationId: 'L1', patch: { stripe_configuration_id: 'x' }, callFunction: async () => { throw new Error('never'); } });
  assert.equal(bad.ok, false); assert.equal(bad.path, 'check');
});

test('location-admin and both Back Office writers use the one rule', () => {
  const fn = read('../../supabase/functions/location-admin/index.ts');
  assert.ok(fn.includes("import { cleanReaderSettingsPatch } from '../_shared/readerSettingsPatch.js';"));
  assert.ok(fn.includes("if (action === 'save_reader_settings') {") && fn.includes(".upsert({ location_id: loc.id, ...got.row }, { onConflict: 'location_id' })"));
  const i = fn.indexOf("if (action === 'save_reader_settings') {");
  assert.ok(i > fn.indexOf('if (!(await authed(req, ops)))'), 'behind the same fence as save_location');
  assert.ok(read('../backoffice/sections/CardReaders.jsx').includes('await saveReaderSettingsWithFallback({'));
  assert.ok(read('../backoffice/sections/PaxTerminals.jsx').includes("patch: { idle_screen_image_url: url },"));
});
