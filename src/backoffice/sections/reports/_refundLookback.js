// The checks of each site closed BEFORE a report's range that carry a refund (lib/db.js
// fetchRefundChecksBefore, 400 days back as Daily trading and Xero reach). A report is handed
// the checks CLOSED in its range, so a refund made inside the range on an older sale is in none
// of them; Daily trading, the Owner app and Xero take it off on the refund's day.
// 16 Oct 2026: the Business summary reads them too (the same hook the Tax summary keeps in
// Tax.jsx, which its tests pin), so its refunds and net sales match Daily trading.
// { rows: { [siteId]: checks[] }, failed: siteId[], loading } for the ids given.

import { useEffect, useState } from 'react';
import { fetchRefundChecksBefore } from '../../../lib/db';

export const toMs = (v) => (v == null ? null : typeof v === 'number' ? v : v instanceof Date ? v.getTime() : Number.isFinite(Date.parse(v)) ? Date.parse(v) : null);

export function useRefundLookback(siteIds, rangeFrom) {
  const key = (siteIds || []).filter(Boolean).map(String).join(',');
  const fromMs = toMs(rangeFrom);
  const [read, setRead] = useState({ key: '', fromMs: null, rows: {}, failed: [] });
  useEffect(() => {
    if (!key || fromMs == null) return undefined;   // nothing to read (answered below, no state)
    let alive = true;
    const ids = key.split(',');
    Promise.all(ids.map((id) => fetchRefundChecksBefore(id, new Date(fromMs), { stop: () => !alive }).catch((e) => ({ data: null, error: e })))).then((results) => {
      if (!alive) return;
      const rows = {}, failed = [];
      results.forEach((r, i) => { if (r && Array.isArray(r.data) && !r.error) rows[ids[i]] = r.data; else failed.push(ids[i]); });
      setRead({ key, fromMs, rows, failed });
    });
    return () => { alive = false; };
  }, [key, fromMs]);
  if (!key || fromMs == null) return { rows: {}, failed: [], loading: false };
  const ready = read.key === key && read.fromMs === fromMs;
  return { rows: ready ? read.rows : {}, failed: ready ? read.failed : [], loading: !ready };
}
