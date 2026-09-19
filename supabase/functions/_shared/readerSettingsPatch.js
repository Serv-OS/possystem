// supabase/functions/_shared/readerSettingsPatch.js
//
// Database fence stage 1, contract P2: the ONLY columns of Platform location_reader_settings a
// Back Office screen may write, and how each is checked. The Stripe configuration fields
// (stripe_configuration_id, idle_screen_file_id and the rest) are server only.
//
// Pure: no Deno, no Supabase. Imported by location-admin (save_reader_settings) and by the
// browser (src/lib/readerSettingsClient.js), and tested from src/lib/readerSettingsPatch.test.js.

export const READER_SETTINGS_FIELDS = Object.freeze([
  'tipping_enabled', 'tip_percentages', 'allow_custom_tip',
  'smart_tip_threshold_minor', 'idle_screen_enabled', 'idle_screen_image_url',
]);

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const boolOf = (v) => (v === true || v === 'true' ? true : v === false || v === 'false' ? false : null);

/**
 * Check a patch. Unknown keys are REFUSED (never silently dropped: a silent drop is how an
 * operator ends up believing a setting saved when it did not).
 * Returns { ok: true, row } or { ok: false, error, field }.
 */
export function cleanReaderSettingsPatch(patch) {
  if (!isObj(patch)) return { ok: false, error: 'patch must be an object' };
  const keys = Object.keys(patch);
  if (!keys.length) return { ok: false, error: 'patch is empty' };
  const row = {};
  for (const k of keys) {
    const v = patch[k];
    if (!READER_SETTINGS_FIELDS.includes(k)) return { ok: false, error: 'unknown_field', field: k };
    if (k === 'tipping_enabled' || k === 'allow_custom_tip' || k === 'idle_screen_enabled') {
      const b = boolOf(v);
      if (b === null) return { ok: false, error: 'invalid_value', field: k };
      row[k] = b;
    } else if (k === 'tip_percentages') {
      if (!Array.isArray(v) || v.length < 1 || v.length > 5) return { ok: false, error: 'invalid_value', field: k };
      const out = [];
      for (const p of v) {
        const n = Number(p);
        if (!Number.isInteger(n) || n < 1 || n > 99) return { ok: false, error: 'invalid_value', field: k };
        out.push(n);
      }
      row[k] = out;
    } else if (k === 'smart_tip_threshold_minor') {
      if (v === null || v === '') { row[k] = null; continue; }
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0 || n > 10_000_000) return { ok: false, error: 'invalid_value', field: k };
      row[k] = n;
    } else if (k === 'idle_screen_image_url') {
      if (v === null || v === '') { row[k] = null; continue; }
      const s = String(v).trim();
      if (s.length > 2048 || !/^https:\/\//i.test(s)) return { ok: false, error: 'invalid_value', field: k };
      row[k] = s;
    }
  }
  return { ok: true, row };
}
