// purchasing/OrdersCompany.jsx: Purchasing > Orders for a multi site company (multi site stock Drop
// 3, v5.11.96, contract 3.2 and 4.2). The Site column, the orders waiting for approval on top with
// Approve and Send back (and Send anyway for head office from 30 minutes before the order by time),
// status and value; 100 a page (stock_orders_page). A row opens OrderDetailPane at its own site.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useStore } from '../../../store';
import { useStockScope } from '../../StockScope';
import { stockApi } from '../../../lib/stock/stockApi';
import { listSites } from '../../../lib/stock/supplierListRules';
import { dayWords, moneyWords } from '../../../lib/stock/purchasingRules';
import { orderStatusPill, approvalPill, sendBackToast, atWords, PILLS } from '../../../lib/stock/purchasingWords';
import { PageHead, TableWrap, Th, Td, Pill, Btn, Segmented, ShowMore, ErrorLine, EmptyLine, ui } from '../stock/stockUi';
import { usePaged, useSiteZones } from './usePaged';
import { sendOrderEmail } from './orderActions';
import OrderDetailPane from './OrderDetailPane';

const STATUSES = [{ value: 'all', label: 'All' }, { value: 'DRAFT', label: 'Draft' }, { value: 'SENT', label: 'Sent' }, { value: 'PARTIAL', label: 'Part received' }, { value: 'RECEIVED', label: 'Received' }, { value: 'CANCELLED', label: 'Cancelled' }];

export default function OrdersCompany({ orgCtx = null }) {
  const sc = useStockScope();
  const showToast = useStore((s) => s.showToast);
  void orgCtx; // the contract's prop; the list needs only the scope
  const [status, setStatus] = useState('all');
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(null);
  const [busy, setBusy] = useState(null);
  const sites = useMemo(() => listSites({ isAll: sc.isAll, scopeSites: sc.scopeSites }), [sc.isAll, sc.scopeSites]);
  const [term, setTerm] = useState('');
  useEffect(() => { const t = setTimeout(() => setTerm(search.trim()), 300); return () => clearTimeout(t); }, [search]);
  const key = `${sc.orgId}|${sites ? sites.join(',') : 'all'}|${status}|${term}`;
  const fetchPage = useCallback((after) => stockApi.ordersPage({ orgId: sc.orgId, sites, status: status === 'all' ? null : status, filters: term ? { search: term } : null, after }), [sc.orgId, sites, status, term]);
  const p = usePaged(fetchPage, key);
  const zones = useSiteZones(useMemo(() => [...new Set(p.rows.map((r) => r.location_id))], [p.rows]));
  const editor = sc.canEditCompany('purchasing');
  const waiting = p.rows.filter((r) => r.approval?.status === 'waiting');
  const others = p.rows.filter((r) => r.approval?.status !== 'waiting');

  const decide = async (row, decision) => {
    setBusy(row.id);
    const r = await stockApi.decideOrder(row.id, decision);
    if (r.error) { setBusy(null); showToast?.(r.error.message, 'error'); return; }
    if (r.data?.send) {
      const s = await sendOrderEmail(row.id, row.location_id);
      showToast?.(s.error ? `Approved. The email did not send: ${s.error.message}. It is tried again in 2 minutes, or open the order and press Send to supplier.` : 'Approved and sent to the supplier.', s.error ? 'error' : 'success');
    } else if (decision === 'send_back') showToast?.(sendBackToast(row.approval?.raised_by_name), 'success');
    setBusy(null);
    p.reload();
  };

  const row = (r) => {
    const st = orderStatusPill(r.status);
    const ap = r.approval?.status ? approvalPill(r.approval.status) : null;
    const wait = r.approval?.status === 'waiting';
    return (
      <tr key={r.id} onClick={() => setOpen(r)} style={{ cursor: 'pointer' }}>
        <Td strong>{r.site_name || sc.siteName(r.location_id)}</Td>
        <Td>{r.supplier_name}{r.internal && <> <Pill tone={PILLS.ourKitchen.tone}>{PILLS.ourKitchen.text}</Pill></>}</Td>
        <Td grey>{r.reference || ''}</Td>
        <Td><Pill tone={st.tone}>{st.text}</Pill>{ap && <> <Pill tone={ap.tone}>{ap.text}</Pill></>}</Td>
        <Td grey>{wait && r.approval.order_by_at ? `Order by ${atWords(r.approval.order_by_at, zones[r.location_id])}` : r.expected_date ? dayWords(String(r.expected_date).slice(0, 10)) : ''}</Td>
        <Td num>{moneyWords((Number(r.subtotal) || 0) + (Number(r.delivery_fee) || 0))}</Td>
        <Td right>
          {wait && (
            <span style={{ display: 'inline-flex', gap: 6 }} onClick={(e) => e.stopPropagation()}>
              {r.approval.can_decide && <Btn small kind="primary" disabled={busy === r.id} onClick={() => decide(r, 'approve')}>Approve</Btn>}
              {r.approval.can_decide && <Btn small disabled={busy === r.id} onClick={() => decide(r, 'send_back')}>Send back</Btn>}
              {editor && Number(r.approval.step) >= 2 && <Btn small disabled={busy === r.id} onClick={() => decide(r, 'send_anyway')}>Send anyway</Btn>}
            </span>
          )}
        </Td>
      </tr>
    );
  };
  const head = <thead><tr><Th>Site</Th><Th>Supplier</Th><Th>Reference</Th><Th>Status</Th><Th>Delivery</Th><Th right>Value</Th><Th> </Th></tr></thead>;
  return (
    <div style={ui.page}>
      <PageHead title="Orders" sub="Every site's orders. Orders waiting for approval are on top." />
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
        <Segmented value={status} options={STATUSES} onChange={setStatus} small />
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search reference or supplier" style={{ ...ui.input, width: 240 }} aria-label="Search orders" />
      </div>
      <ErrorLine error={p.error} />
      {p.loading ? <EmptyLine>Loading…</EmptyLine> : !p.rows.length && !p.error ? <EmptyLine>No orders here yet.</EmptyLine> : (
        <>
          {waiting.length > 0 && (
            <>
              <div style={{ fontSize: 13, fontWeight: 700, margin: '4px 0 8px' }}>Waiting approval</div>
              <TableWrap minWidth={860}>{head}<tbody>{waiting.map(row)}</tbody></TableWrap>
              <div style={{ height: 16 }} />
            </>
          )}
          {others.length > 0 && <TableWrap minWidth={860}>{head}<tbody>{others.map(row)}</tbody></TableWrap>}
        </>
      )}
      <ShowMore next={p.next} busy={p.more} onMore={p.showMore} />
      {open && <OrderDetailPane order={open} tz={zones[open.location_id]} onChanged={(changed = true) => { setOpen(null); if (changed) p.reload(); }} onClose={() => setOpen(null)} />}
    </div>
  );
}
