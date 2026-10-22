// src/backoffice/sections/stock/SecondApprovalLine.jsx
//
// MULTI SITE STOCK (v5.11.96, Drop 3, contract 3.3 and 4.3, map I7): a count over the company's
// limit waits for a second approval. Everyone sees 'Waiting for a second approval. Over £500.'; head
// office or another login of this site (never the first approver) gets 'Give the second approval',
// which posts the count with the stored costs (stock_second_approve_count). The database decides who
// may; the button only hides where it would surely be refused.

import { useState } from 'react';
import { useStore } from '../../../store';
import { stockApi } from '../../../lib/stock/stockApi';
import { secondApprovalState, secondApprovalWords } from '../../../lib/stock/countPlanRules';
import { useStockScope } from '../../StockScope';
import { Notice } from './stockUi';

export default function SecondApprovalLine({ count, onApproved, limit = null }) {
  const sc = useStockScope();
  const showToast = useStore((s) => s.showToast);
  const [busy, setBusy] = useState(false);
  const companyEditor = !!sc.canEditCompany?.('inventory');
  const linkedHere = !!count?.locationId && (sc.sites || []).some((s) => s.id === count.locationId);
  const st = secondApprovalState(count, { userId: sc.userId, companyEditor, linkedHere });
  if (!st.waiting) return null;
  const give = async () => {
    setBusy(true);
    const r = await stockApi.secondApproveCount(count.id);
    setBusy(false);
    if (r.error) { showToast?.(r.error.message, 'error'); return; }
    showToast?.('Second approval given. The count is posted.', 'success');
    onApproved?.(r.data);
  };
  return (
    <Notice tone="warn" actions={st.canGive ? [{ label: busy ? 'Posting...' : 'Give the second approval', kind: 'primary', onClick: give, disabled: busy }] : null}>
      <b>{secondApprovalWords(limit)}</b>
      {count.firstApprovedByName && <span> First approval by {count.firstApprovedByName}.</span>}
      {!st.canGive && st.why && <span> {st.why}</span>}
    </Notice>
  );
}
