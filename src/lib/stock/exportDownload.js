/**
 * stock/exportDownload.js: save a finished background export (v5.11.92, multi site stock Drop 4a,
 * contract 2.1 and 4). The report-export edge function streams the parts as one CSV; it checks the
 * caller's session and that the login still reaches every site of the job, so the browser fetches
 * the URL with the session JWT and saves the blob. Browser only: no node test (the pure pieces are
 * exportFileName in reportRules.js and exportDownloadUrl in reportsData.js).
 */

import { supabase } from '../supabase';

/** The words a failed download shows. */
export const DOWNLOAD_WORDS = Object.freeze({
  signIn: 'Sign in to Back Office to download exports.',
  gone: 'That export is no longer there. Files are kept for 7 days.',
  reach: 'This login no longer reaches every site in that export.',
  failed: 'The download did not finish. Try again.',
});

/**
 * Fetch the export with the session token and hand the browser a file. Answers { ok, error }.
 *   url       api.exportDownloadUrl(jobId)
 *   filename  exportFileName(report, from, to)
 */
export async function downloadExport(url, filename, { fetchImpl = null, client = supabase } = {}) {
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) return { ok: false, error: new Error(DOWNLOAD_WORDS.failed) };
  let token = null;
  try { token = (await client?.auth?.getSession?.())?.data?.session?.access_token || null; } catch { token = null; }
  if (!token) return { ok: false, error: new Error(DOWNLOAD_WORDS.signIn) };
  let res;
  try {
    res = await doFetch(url, { method: 'GET', headers: { Authorization: `Bearer ${token}` } });
  } catch (e) {
    return { ok: false, error: new Error(e?.message || DOWNLOAD_WORDS.failed) };
  }
  if (!res || !res.ok) {
    const status = res?.status;
    const words = status === 401 ? DOWNLOAD_WORDS.signIn : status === 403 ? DOWNLOAD_WORDS.reach : status === 404 || status === 410 ? DOWNLOAD_WORDS.gone : DOWNLOAD_WORDS.failed;
    return { ok: false, error: new Error(words) };
  }
  try {
    const blob = await res.blob();
    saveBlob(blob, filename);
    return { ok: true, error: null };
  } catch (e) {
    return { ok: false, error: new Error(e?.message || DOWNLOAD_WORDS.failed) };
  }
}

/** Hand a blob to the browser as a download. */
export function saveBlob(blob, filename) {
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = filename || 'export.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}
