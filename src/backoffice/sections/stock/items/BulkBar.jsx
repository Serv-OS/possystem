/**
 * The bulk bar on the company Stock items list (multi site stock Drop 1, mockup .bulk): shown to
 * company editors while rows are ticked. '<n> ticked', then one button per bulk tool, then Clear.
 *
 * A big change (over 200 rows or 5 sites) is done by the save queue: `jobs` are its job ids, and
 * the bar shows '<done> of <total> sites done' (read every 3 s, no realtime) until 'Done.'. A job
 * that failed says '<site> did not finish: <words>.' with Try again (the same call again).
 */

import { useEffect, useMemo, useState } from 'react';
import { stockApi } from '../../../../lib/stock/stockApi';
import { pollJobs } from '../../../../lib/stock/companyData';
import { bulkActions, jobsProgress } from '../../../../lib/stock/itemListRules';
import { useStockScope } from '../../../StockScope';
import { Btn } from '../stockUi';

const onDark = { background: 'transparent', color: 'var(--bg1)', border: '1px solid color-mix(in srgb, var(--bg1) 35%, transparent)' };

export default function BulkBar({ count, multi, onAction, onClear, jobs = [], onRetry = null }) {
  const sc = useStockScope();
  const [seen, setSeen] = useState([]);
  const jobKey = (jobs || []).join(',');

  useEffect(() => {
    if (!jobKey) return undefined;
    const ids = jobKey.split(',');
    const stop = pollJobs(stockApi, ids, (rows) => setSeen(rows || []));
    return () => { if (typeof stop === 'function') stop(); };
  }, [jobKey]);

  const progress = useMemo(() => jobsProgress(seen, jobs, (id) => sc.siteName(id)), [seen, jobs, sc]);

  return (
    <div role="region" aria-label="Ticked items"
      style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', background: 'var(--t1)', color: 'var(--bg1)', borderRadius: 10, padding: '8px 12px' }}>
      {count > 0 && <span style={{ fontSize: 13, fontWeight: 700, marginRight: 4 }}>{count} ticked</span>}
      {count > 0 && bulkActions(multi).map((a) => (
        <Btn key={a.kind} small style={onDark} onClick={() => onAction(a.kind)}>{a.label}</Btn>
      ))}
      {jobs.length > 0 && progress.line && <span role="status" style={{ fontSize: 12.5, opacity: 0.9 }}>{progress.line}</span>}
      {progress.failed.map((f) => (
        <span key={f.id} role="alert" style={{ fontSize: 12.5, display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          {f.words}
          {onRetry && <Btn small style={onDark} onClick={onRetry}>Try again</Btn>}
        </span>
      ))}
      <span style={{ flex: 1 }} />
      <Btn small style={onDark} onClick={onClear}>Clear</Btn>
    </div>
  );
}
