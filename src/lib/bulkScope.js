// bulkScope.js — set the sharing of many products at once, safely.
//
// Peter, 23 Sep 2026: "we need a way to bulk set the sharing status's of
// products either local, shared or global and it changes them in bulk".
//
// Sharing is a PRODUCT level property (setMenuItemScope, lib/db.js): promoting
// a product copies it to every peer venue in the organisation, auto-promotes
// its category first, and copies its modifier groups. Two of those running at
// the same time on products in the same category would race to create the peer
// category twice. So a bulk run is SEQUENTIAL, one product after another, and
// it reports exactly what happened to each rather than a single thumbs up.
//
// Pure orchestration: the actual scope change is injected, so node:test can
// prove the rules without a database.

/**
 * Which items a bulk change touches: top-level products only (never a size
 * child or a sub-item, which inherit), never archived, and only those that are
 * not already at the target scope.
 */
export function bulkScopeTargets(items, scope, { includeSame = false } = {}) {
  return (items || []).filter((i) => i && !i.archived && !i.parentId && (i.type || 'simple') !== 'subitem'
    && (includeSame ? scope !== 'local' : (i.scope || 'local') !== scope));
}

/**
 * Re-sending: a product already Shared or Global is pushed to every venue
 * again. 23 Sep 2026: Location 2 held 7 copies pointing at a category that no
 * longer existed there, and one archived since July. Since the share now
 * upserts the whole product at every peer, re-applying the level repairs them.
 */
export function bulkScopeResendWords(count, scope) {
  return `Re-send ${count} product${count === 1 ? '' : 's'} already ${scope} to every venue in your organisation, refreshing every copy (name, price rules, modifiers, tax, category). Continue?`;
}

/**
 * Run the change one product at a time.
 *
 * @param {{ targets: object[], scope: string, setScope: (item, scope) => Promise<any>,
 *           onProgress?: (p: {done:number,total:number,item:object}) => void,
 *           shouldStop?: () => boolean }} f
 * @returns {Promise<{ total:number, done:number, ok:object[], failed:Array<{item:object,error:string}>,
 *           promoted:number, rescoped:number, demoted:number, copies:number, stopped:boolean }>}
 */
export async function runBulkScope({ targets, scope, setScope, onProgress, shouldStop } = {}) {
  const out = { total: (targets || []).length, done: 0, ok: [], failed: [], promoted: 0, rescoped: 0, demoted: 0, copies: 0, stopped: false };
  for (const item of targets || []) {
    if (shouldStop && shouldStop()) { out.stopped = true; break; }
    let r;
    try { r = await setScope(item, scope); }
    catch (e) { r = { ok: false, error: e }; }
    out.done++;
    if (r && r.ok) {
      out.ok.push(item);
      if (r.skippedPeers) out.notReached = (out.notReached || 0) + Number(r.skippedPeers);
      if (Array.isArray(r.unmapped)) out.unmapped = [...(out.unmapped || []), ...r.unmapped.map((u) => `${item.menuName || item.name}: ${String(u).replace('|', ': ')}`)];
      if (r.action === 'promoted') { out.promoted++; out.copies += Number(r.createdCount) || 0; }
      else if (r.action === 'rescoped') out.rescoped++;
      else if (r.action === 'demoted') out.demoted++;
    } else {
      const err = r && r.error;
      out.failed.push({ item, error: (err && (err.message || String(err))) || 'unknown error' });
    }
    if (onProgress) onProgress({ done: out.done, total: out.total, item });
  }
  return out;
}

/** The sentence the operator reads when it is over. */
export function bulkScopeWords(result, scope) {
  const n = (k, one, many) => `${k} ${k === 1 ? one : many}`;
  const bits = [];
  if (result.promoted) bits.push(`${n(result.promoted, 'product', 'products')} shared out to other venues (${n(result.copies, 'copy', 'copies')} made)`);
  if (result.rescoped) bits.push(`${n(result.rescoped, 'product', 'products')} rescoped to ${scope} everywhere`);
  if (result.demoted) bits.push(`${n(result.demoted, 'product', 'products')} set to local here`);
  let s = bits.length ? bits.join(', ') : 'nothing changed';
  if (result.failed.length) s += `. ${n(result.failed.length, 'product', 'products')} failed: ${result.failed.slice(0, 3).map((f) => `${f.item.menuName || f.item.name} (${f.error})`).join('; ')}${result.failed.length > 3 ? '…' : ''}`;
  if (result.notReached) s += `. NOT reached at ${result.notReached} venue(s), run it again`;
  if (result.unmapped && result.unmapped.length) s += `. No equivalent at: ${result.unmapped.slice(0, 3).join('; ')}${result.unmapped.length > 3 ? '…' : ''}`;
  if (result.stopped) s += '. Stopped early.';
  return s.charAt(0).toUpperCase() + s.slice(1) + '.';
}

/** What the confirm box says before anything moves. */
export function bulkScopeConfirmWords(count, scope, venues) {
  const what = scope === 'local'
    ? `set ${count} product${count === 1 ? '' : 's'} to Local at this venue only. Copies at other venues are left as they are`
    : scope === 'shared'
      ? `share ${count} product${count === 1 ? '' : 's'} with every venue in your organisation${venues ? ` (${venues} other venue${venues === 1 ? '' : 's'})` : ''}. Each venue can then override price, category and image`
      : `make ${count} product${count === 1 ? '' : 's'} Global: managed centrally, no overrides at any venue${venues ? ` (${venues} other venue${venues === 1 ? '' : 's'})` : ''}`;
  return `This will ${what}. It runs one product at a time and cannot be undone in one click. Continue?`;
}
