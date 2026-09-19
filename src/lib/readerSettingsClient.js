// src/lib/readerSettingsClient.js: database fence stage 1, contract P2.
//
// Back Office writes the card reader tipping and idle screen settings through location-admin
// (action save_reader_settings) instead of the Platform table from the browser, which is
// always the raw public key there. FENCE STAGE 1 FALLBACK: while the deployed location-admin
// does not know the action yet (it answers "unknown action"), today's direct write runs. After
// 20260919d (browser writes removed) only the function path works: remove the fallback then.
import { cleanReaderSettingsPatch } from '../../supabase/functions/_shared/readerSettingsPatch.js';

/**
 * @param {Function} o.callFunction  (body) => Promise<{status, data}>
 * @param {Function} o.legacyWrite   (row) => Promise<{error}>, today's direct write
 * Resolves { ok, path: 'function'|'legacy', settings?, error? }.
 */
export async function saveReaderSettingsWithFallback({ callFunction, legacyWrite, opsLocationId, patch }) {
  const clean = cleanReaderSettingsPatch(patch);
  if (!clean.ok) return { ok: false, path: 'check', error: clean.field ? `${clean.error}: ${clean.field}` : clean.error };
  let res;
  try { res = await callFunction({ action: 'save_reader_settings', ops_location_id: opsLocationId, patch: clean.row }); }
  catch (e) { res = { status: 0, data: { error: e?.message || 'network' } }; }
  const status = Number(res?.status || 0);
  const data = res?.data || {};
  if (status >= 200 && status < 300 && data.ok) return { ok: true, path: 'function', settings: data.settings || null };
  const notDeployed = status === 404 || /unknown action/i.test(String(data.error || ''));
  if (notDeployed && legacyWrite) {
    const { error } = (await legacyWrite(clean.row)) || {};
    return error ? { ok: false, path: 'legacy', error: error.message || String(error) } : { ok: true, path: 'legacy' };
  }
  return { ok: false, path: 'function', error: data.error || `HTTP ${status}` };
}
