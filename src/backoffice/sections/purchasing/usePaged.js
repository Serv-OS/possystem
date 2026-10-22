// purchasing/usePaged.js: the keyset page reader every company Purchasing list shares (multi site
// stock Drop 3, v5.11.96). fetchPage(after) answers stockApi's { data: { rows, next }, error }; the
// first page is read again whenever `key` changes (picker, filters) or reload() is called; Show more
// adds the next page of 100. A newer key wins over a slower older answer. Also useSiteZones: each
// site's venue time zone (getLocationConfig), so times show on the venue's clock.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getLocationConfig } from '../../../lib/locationTime';

export function usePaged(fetchPage, key) {
  const [page, setPage] = useState({ key: null, rows: [], next: null, error: null, extra: null });
  const [more, setMore] = useState(false);
  const [again, setAgain] = useState(0);
  const latest = useRef(key);
  useEffect(() => { latest.current = key; }, [key]);
  useEffect(() => {
    let on = true;
    fetchPage(null).then((r) => {
      if (!on) return;
      setPage({ key, rows: r.error ? [] : (r.data?.rows || []), next: r.error ? null : (r.data?.next || null), error: r.error || null, extra: r.error ? null : (r.data || null) });
    });
    return () => { on = false; };
  }, [fetchPage, key, again]);
  const showMore = useCallback(async () => {
    if (!page.next || more) return;
    const k = page.key;
    setMore(true);
    const r = await fetchPage(page.next);
    setMore(false);
    if (latest.current !== k) return;
    if (r.error) { setPage((p) => ({ ...p, error: r.error })); return; }
    setPage((p) => ({ ...p, rows: [...p.rows, ...(r.data?.rows || [])], next: r.data?.next || null }));
  }, [page.next, page.key, more, fetchPage]);
  const reload = useCallback(() => setAgain((n) => n + 1), []);
  return { rows: page.rows, next: page.next, error: page.error, extra: page.extra, loading: page.key !== key, more, showMore, reload };
}

const zoneCache = new Map();
export function useSiteZones(siteIds) {
  // The zones are read from the cache; the state only says which list of sites has finished reading,
  // so every site of that list then has a zone (London when its read failed or it was past the 50th).
  const [doneKey, setDoneKey] = useState(null);
  const k = (siteIds || []).filter(Boolean).join(',');
  useEffect(() => {
    const ids = k ? k.split(',') : [];
    const todo = ids.filter((id) => !zoneCache.has(id)).slice(0, 50);
    if (!todo.length) return undefined;
    let on = true;
    Promise.all(todo.map((id) => getLocationConfig(id).then((c) => [id, c?.timezone || 'Europe/London']).catch(() => [id, 'Europe/London']))).then((pairs) => {
      pairs.forEach(([id, tz]) => zoneCache.set(id, tz));
      if (on) setDoneKey(k);
    });
    return () => { on = false; };
  }, [k]);
  return useMemo(() => {
    const ids = k ? k.split(',') : [];
    if (doneKey === k) return Object.fromEntries(ids.map((id) => [id, zoneCache.get(id) || 'Europe/London']));
    return Object.fromEntries(ids.filter((id) => zoneCache.has(id)).map((id) => [id, zoneCache.get(id)]));
  }, [k, doneKey]);
}
