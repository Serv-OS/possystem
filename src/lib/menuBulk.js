// src/lib/menuBulk.js: one change to many products, and the one line that says what saved.
//
// 27 Sep 2026, Peter: "I archived choc babychino but its still on the menu board". The Back
// Office "Apply to all" strips (tax rate, tax profile, sharing) fired one whole row save per
// product without waiting, and said "set on 430" whatever happened. At Coffee Boy Leeds the tax
// strip wrote another venue's rate into 430 products, and a second window put them all back a
// minute later; nobody could tell. Now each product's change goes through the compare and set
// writer (only the changed column), a few at a time, awaited, and the strip ends with the truth:
// "Standard 20% set on 428, 3 skipped: changed elsewhere".
// Pure: the caller passes how to read a row and how to save one.

/**
 * entries: [{ id, patch, onlyIf?(row) }]. `onlyIf` is judged on the row as it is when its turn
 * comes (a gap filled since the list was made is left alone).
 * deps: { getRow(id), update(id, patch) => Promise<{ ok, outcome }>, concurrency, onProgress }
 * Resolves { saved, skipped, gone, failed, unchanged, total }:
 *   saved      the database has the change (written, or already held it)
 *   skipped    changed in another window since this page loaded: not written
 *   gone       no longer at this venue
 *   failed     refused or not saved
 *   unchanged  nothing to do (no such row, or `onlyIf` said no)
 */
export async function runBulkEdits(entries, { getRow, update, concurrency = 6, onProgress = null } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const out = { saved: 0, skipped: 0, gone: 0, failed: 0, unchanged: 0, total: list.length };
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < list.length) {
      const e = list[next++];
      const row = getRow ? getRow(e.id) : null;
      if (!row || (e.onlyIf && !e.onlyIf(row))) {
        out.unchanged += 1;
      } else {
        let r;
        try { r = await update(e.id, e.patch); }
        catch (err) { r = { ok: false, outcome: 'error', error: err }; }
        const o = r?.outcome;
        if (r?.ok) out.saved += 1;
        else if (o === 'conflict' || o === 'dropped') out.skipped += 1;
        else if (o === 'gone') out.gone += 1;
        else out.failed += 1;
      }
      done += 1;
      try { onProgress?.(done, list.length); } catch { /* only a progress label */ }
    }
  };
  const n = Math.max(1, Math.min(concurrency || 1, list.length || 1));
  await Promise.all(Array.from({ length: n }, worker));
  return out;
}

/** The one line a bulk action ends with: "Standard 20% set on 428, 3 skipped: changed elsewhere". */
export function bulkSummaryWords(out, what) {
  const parts = [`${what} set on ${out.saved}`];
  if (out.skipped) parts.push(`${out.skipped} skipped: changed elsewhere`);
  if (out.gone) parts.push(`${out.gone} skipped: no longer at this venue`);
  if (out.failed) parts.push(`${out.failed} NOT saved`);
  if (out.unchanged) parts.push(`${out.unchanged} already done`);
  return parts.join(', ');
}
