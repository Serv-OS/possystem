// src/backoffice/sections/stock/CountDueStrip.jsx
//
// MULTI SITE STOCK (v5.11.96, Drop 3, contract 3.3 and 4.3): the strip above the Stock counts list:
// 'Count due today: Full count by 10:00', 'Count missed: Full count on 21 Oct' (stock_count_due for
// this site and the venue's day). Says nothing when nothing is due, while it loads, or on a database
// without Drop 3. Read only: a plan never starts or posts a count by itself.

import { useEffect, useState } from 'react';
import { stockApi } from '../../../lib/stock/stockApi';
import { dueStripRows } from '../../../lib/stock/countPlanRules';
import { useStockScope } from '../../StockScope';
import { Pill } from './stockUi';

export default function CountDueStrip({ siteId }) {
  const sc = useStockScope();
  const [rows, setRows] = useState([]);
  useEffect(() => {
    let live = true;
    if (!sc.orgId || !siteId) return () => { live = false; };
    stockApi.countDue(sc.orgId, [siteId]).then((r) => {
      if (!live || r.error) return;
      setRows(dueStripRows(Array.isArray(r.data) ? r.data : r.data?.rows, siteId));
    });
    return () => { live = false; };
  }, [sc.orgId, siteId]);
  if (!rows.length) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 }}>
      {rows.map((r) => (
        <div key={`${r.plan_id}:${r.due_day || ''}`} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 14px', borderRadius: 10, background: 'var(--bg1)', border: '1px solid var(--bdr)', fontSize: 13, color: 'var(--t1)' }}>
          <Pill tone={r.tone}>{r.pill}</Pill>
          <span>{r.text}</span>
        </div>
      ))}
    </div>
  );
}
