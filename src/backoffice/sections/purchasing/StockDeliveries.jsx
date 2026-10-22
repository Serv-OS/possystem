// purchasing/StockDeliveries.jsx: Purchasing > Deliveries (multi site stock Drop 3, v5.11.96,
// contract 3.2 and 4.2). Today, Coming and Overdue from every site's sent orders on its own venue day
// (stock_deliveries_board), held standing orders, and the group From the central kitchen: a kitchen
// order arrives as a transfer and is received in Transfers, never here. Receive opens ReceivePanel.
// Receive with no order and Shop buy post an invoice with a local supplier (Invoices, Scan or upload).

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useStockScope } from '../../StockScope';
import { stockApi } from '../../../lib/stock/stockApi';
import { listSites } from '../../../lib/stock/supplierListRules';
import { dayWords } from '../../../lib/stock/purchasingRules';
import { PILLS, DUE_PILLS } from '../../../lib/stock/purchasingWords';
import { PageHead, TabBar, TableWrap, Th, Td, Pill, Btn, ShowMore, ErrorLine, EmptyLine, ui } from '../stock/stockUi';
import ReceivePanel from './ReceivePanel';

const GROUPS = ['today', 'coming', 'overdue', 'kitchen'];
const empty = () => ({ today: [], coming: [], overdue: [], kitchen: [] });

export default function StockDeliveries({ orgCtx = null }) {
  const sc = useStockScope();
  void orgCtx; // the contract's prop; the board needs only the scope
  const sites = useMemo(() => listSites({ isAll: sc.isAll, scopeSites: sc.scopeSites }), [sc.isAll, sc.scopeSites]);
  const key = `${sc.orgId}|${sites ? sites.join(',') : 'all'}`;
  const [tab, setTab] = useState('today');
  const [board, setBoard] = useState({ key: null, rows: empty(), next: null, error: null });
  const [more, setMore] = useState(false);
  const [again, setAgain] = useState(0);
  const [receiving, setReceiving] = useState(null);
  const fetchPage = useCallback((after) => stockApi.deliveriesBoard({ orgId: sc.orgId, sites, after }), [sc.orgId, sites]);
  useEffect(() => {
    let on = true;
    fetchPage(null).then((r) => {
      if (!on) return;
      const rows = empty();
      if (!r.error) GROUPS.forEach((g) => { rows[g] = r.data?.[g] || []; });
      setBoard({ key, rows, next: r.error ? null : (r.data?.next || null), error: r.error || null });
    });
    return () => { on = false; };
  }, [fetchPage, key, again]);
  const showMore = async () => {
    if (!board.next || more) return;
    setMore(true);
    const r = await fetchPage(board.next);
    setMore(false);
    if (r.error) { setBoard((b) => ({ ...b, error: r.error })); return; }
    setBoard((b) => ({ ...b, next: r.data?.next || null, rows: Object.fromEntries(GROUPS.map((g) => [g, [...b.rows[g], ...(r.data?.[g] || [])]])) }));
  };
  const loading = board.key !== key;
  const list = board.rows[tab] || [];
  const receiveNoOrder = () => sc.go('invoices', { open: { tab: 'scan' } });
  const row = (r, kitchen = false) => (
    <tr key={`${r.po_id}:${r.held ? 'h' : ''}`}>
      <Td strong>{r.site_name || sc.siteName(r.location_id)}</Td>
      <Td>{r.supplier_name}{kitchen && <> <Pill tone={PILLS.ourKitchen.tone}>{PILLS.ourKitchen.text}</Pill></>}</Td>
      <Td grey>{r.reference || ''}</Td>
      <Td>{dayWords(String(r.expected_date || '').slice(0, 10))}</Td>
      <Td num>{r.lines ?? ''}</Td>
      <Td>{r.part_saved && <Pill tone={PILLS.partReceived.tone}>{PILLS.partReceived.text}</Pill>}{r.held && <Pill tone={DUE_PILLS.held.tone}>{DUE_PILLS.held.text}</Pill>}{kitchen && r.transfer_status ? <span style={ui.sub}>{r.transfer_status === 'SENT' ? 'In transit' : r.transfer_status}</span> : null}</Td>
      <Td right>
        {kitchen
          ? (r.transfer_id ? <Btn small onClick={() => sc.go('stock-transfers', { open: { transferId: r.transfer_id } })}>Receive</Btn> : <span style={ui.sub}>Not picked yet</span>)
          : <Btn small kind="primary" onClick={() => setReceiving(r)}>Receive</Btn>}
      </Td>
    </tr>
  );
  const head = <thead><tr><Th>Site</Th><Th>Supplier</Th><Th>Reference</Th><Th>Expected</Th><Th right>Lines</Th><Th> </Th><Th> </Th></tr></thead>;
  return (
    <div style={ui.page}>
      <PageHead title="Deliveries" sub="What is due at every site today, what is coming and what is late.">
        <Btn onClick={receiveNoOrder}>Receive with no order</Btn>
        <Btn onClick={receiveNoOrder}>Shop buy</Btn>
      </PageHead>
      <TabBar tabs={[{ id: 'today', label: 'Today', count: board.rows.today.length }, { id: 'coming', label: 'Coming', count: board.rows.coming.length }, { id: 'overdue', label: 'Overdue', count: board.rows.overdue.length }]} value={tab} onChange={setTab} />
      <ErrorLine error={board.error} />
      {loading ? <EmptyLine>Loading…</EmptyLine> : !list.length ? <EmptyLine>Nothing here.</EmptyLine> : <TableWrap minWidth={820}>{head}<tbody>{list.map((r) => row(r))}</tbody></TableWrap>}
      {!loading && board.rows.kitchen.length > 0 && (
        <div style={{ marginTop: 20 }}>
          <div style={{ fontSize: 13, fontWeight: 700 }}>From the central kitchen</div>
          <div style={{ ...ui.sub, marginBottom: 8 }}>Arrives as a transfer. Receive it in Transfers.</div>
          <TableWrap minWidth={820}>{head}<tbody>{board.rows.kitchen.map((r) => row(r, true))}</tbody></TableWrap>
        </div>
      )}
      <ShowMore next={board.next} busy={more} onMore={showMore} />
      {receiving && <ReceivePanel po={receiving} onDone={() => { setReceiving(null); setAgain((n) => n + 1); }} onClose={() => setReceiving(null)} />}
    </div>
  );
}
