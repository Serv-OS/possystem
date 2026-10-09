// src/lib/salesGroupsMapping.js
//
// EACH SITE'S XERO MAPPING FOR THE SALES MIX (8 Oct 2026, D2). A site's sales groups come from
// its menu categories AND, when the site has a xero_config row, from that row's mapping
// (categoryGroups, itemGroups, groups names, set in Xero site setup step 3). The Back Office
// cannot read xero_config itself (its only policy is the restrictive second_step_fence, no
// permissive read), so the mapping comes through the xero-config edge function's 'get'
// action, one call per site. This file is the cache in front of that call.
//
// RULES
//   · A success is kept MAPPING_LIFE_MS (10 minutes), a failure MAPPING_RETRY_MS (60 seconds):
//     the report must never hammer a refusing function, and must never wait a long time to
//     try again after a blip.
//   · Two callers inside the life share ONE promise, so the Business summary strip and the
//     Z report block opening together make one request.
//   · A failure resolves { mapping: {}, failed: true }; it never throws and never blocks a
//     report. The caller then resolves groups from the categories alone (D6) and says so.
//   · A site with no xero_config row answers mapping null: that is { mapping: {}, failed: false }.
//
// PURE: no Supabase import here. src/lib/xero.js pulls in the Supabase client, which cannot
// load under node --test, so the function that makes the call is HANDED IN: the hook in
// src/backoffice/sections/reports/_siteMappings.js passes xeroGetMapping; the tests pass a
// fake through _setMappingFetcher.

export const MAPPING_LIFE_MS = 10 * 60 * 1000;
export const MAPPING_RETRY_MS = 60 * 1000;

const _cache = new Map();   // siteId -> { at, promise, failed }
let _defaultFetcher = null;

/** The call that reads one site's mapping (xeroGetMapping in the app, a fake in tests). */
export function _setMappingFetcher(fn) {
  _defaultFetcher = typeof fn === 'function' ? fn : null;
}

export function _resetMappingCache() {
  _cache.clear();
}

/**
 * { mapping, failed } for one site. `fetcher(siteId)` must resolve to the xero-config 'get'
 * answer ({ mapping, ... }); it defaults to the function given to _setMappingFetcher. Memoised
 * per site; see the rules above.
 */
export async function fetchSiteMapping(siteId, fetcher = _defaultFetcher) {
  const id = siteId != null && siteId !== '' ? String(siteId) : null;
  if (!id) return { mapping: {}, failed: false };
  const now = Date.now();
  const hit = _cache.get(id);
  if (hit && now - hit.at < (hit.failed ? MAPPING_RETRY_MS : MAPPING_LIFE_MS)) return hit.promise;
  const entry = { at: now, failed: false, promise: null };
  entry.promise = (async () => {
    try {
      if (typeof fetcher !== 'function') throw new Error('no mapping reader');
      const r = await fetcher(id);
      const mapping = r && r.mapping && typeof r.mapping === 'object' ? r.mapping : {};
      return { mapping, failed: false };
    } catch {
      entry.failed = true;
      return { mapping: {}, failed: true };
    }
  })();
  _cache.set(id, entry);
  return entry.promise;
}
