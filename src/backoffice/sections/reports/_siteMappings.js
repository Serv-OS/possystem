// Each site's Xero mapping (its sales groups set in Xero site setup step 3) for the reports
// that resolve items into groups (Sales mix, the Business summary strip, the Z report block;
// 8 Oct 2026, D2). The cache and the rules are in src/lib/salesGroupsMapping.js; this file is
// the hook that joins them to a list of site ids, shaped like useSiteMenus in ./_siteMenus.js.
//
// A mapping is null until its read lands, and the callers resolve groups from the categories
// alone meanwhile: the mapping arriving only re renders, it never blocks a report.

import { useEffect, useMemo, useState } from 'react';
import { isMock } from '../../../lib/supabase';
import { xeroGetMapping } from '../../../lib/xero';
import { fetchSiteMapping } from '../../../lib/salesGroupsMapping.js';

const EMPTY = Object.freeze({});

/**
 * { mappings: { [id]: object | null }, loading, failed: [id] } for the given site ids. In the
 * demo build (no Supabase) every mapping is {} at once and nothing is read.
 */
export function useSiteMappings(ids) {
  const list = (Array.isArray(ids) ? ids : []).filter((id) => id != null && id !== '').map(String);
  const key = list.join(',');
  const [read, setRead] = useState({ key: '', mappings: {}, failed: [] });
  useEffect(() => {
    if (!list.length || isMock) {
      const mappings = {};
      for (const id of list) mappings[id] = EMPTY;
      setRead({ key, mappings, failed: [] });
      return undefined;
    }
    let alive = true;
    Promise.all(list.map((id) => fetchSiteMapping(id, xeroGetMapping))).then((results) => {
      if (!alive) return;
      const mappings = {}, failed = [];
      results.forEach((r, i) => { mappings[list[i]] = r?.mapping || EMPTY; if (r?.failed) failed.push(list[i]); });
      setRead({ key, mappings, failed });
    });
    return () => { alive = false; };
    // list follows key
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const loading = read.key !== key;
  const mappings = useMemo(() => {
    if (!loading) return read.mappings;
    const out = {};
    for (const id of key ? key.split(',') : []) out[id] = null;
    return out;
  }, [loading, read, key]);
  return { mappings, loading, failed: loading ? [] : read.failed };
}
