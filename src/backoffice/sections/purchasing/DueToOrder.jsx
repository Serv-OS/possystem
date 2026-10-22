// purchasing/DueToOrder.jsx: Purchasing > Due to order (multi site stock Drop 3, v5.11.96, contract
// 3.2 and 4.2, mockup scrDue). One board for head office: every site and supplier, next delivery,
// order by time and whether it is done. Rows from stock_due_to_order, 100 a page by order by time;
// the picker decides the sites (All sites, a group or one site). Open order pad picks that site.

import { useCallback, useMemo } from 'react';
import { useStockScope } from '../../StockScope';
import { stockApi } from '../../../lib/stock/stockApi';
import { listSites } from '../../../lib/stock/supplierListRules';
import { dayWords } from '../../../lib/stock/purchasingRules';
import { duePill, atWords } from '../../../lib/stock/purchasingWords';
import { PageHead, TableWrap, Th, Td, Pill, Btn, ShowMore, ErrorLine, EmptyLine, ui } from '../stock/stockUi';
import { usePaged, useSiteZones } from './usePaged';

export default function DueToOrder({ orgCtx = null }) {
  const sc = useStockScope();
  const sites = useMemo(() => listSites({ isAll: sc.isAll, scopeSites: sc.scopeSites }), [sc.isAll, sc.scopeSites]);
  void orgCtx; // the contract's prop; this board needs only the scope
  const key = `${sc.orgId}|${sites ? sites.join(',') : 'all'}`;
  const fetchPage = useCallback((after) => stockApi.dueToOrder({ orgId: sc.orgId, sites, after }), [sc.orgId, sites]);
  const p = usePaged(fetchPage, key);
  const zones = useSiteZones(useMemo(() => [...new Set(p.rows.map((r) => r.location_id))], [p.rows]));
  const openPad = (siteId) => { sc.setChoice({ kind: 'site', id: siteId }); sc.go('order-pad'); };
  return (
    <div style={ui.page}>
      <PageHead title="Due to order" sub="One board for head office: every site and supplier, next delivery, order by time, and whether it is done." />
      <ErrorLine error={p.error} />
      {p.loading ? <EmptyLine>Loading…</EmptyLine> : !p.rows.length && !p.error ? <EmptyLine>No supplier with delivery days at these sites.</EmptyLine> : (
        <TableWrap minWidth={760}>
          <thead><tr><Th>Site</Th><Th>Supplier</Th><Th>Next delivery</Th><Th>Order by</Th><Th>Status</Th><Th> </Th></tr></thead>
          <tbody>
            {p.rows.map((r) => {
              const pill = duePill(r.status);
              return (
                <tr key={`${r.location_id}:${r.supplier_id}:${r.delivery_day}`}>
                  <Td strong>{r.site_name || sc.siteName(r.location_id)}</Td>
                  <Td>{r.supplier_name}</Td>
                  <Td>{dayWords(String(r.delivery_day || '').slice(0, 10))}</Td>
                  <Td num>{atWords(r.order_by_at, zones[r.location_id])}</Td>
                  <Td><Pill tone={pill.tone}>{pill.text}</Pill></Td>
                  <Td right><Btn small onClick={() => openPad(r.location_id)}>Open order pad</Btn></Td>
                </tr>
              );
            })}
          </tbody>
        </TableWrap>
      )}
      <ShowMore next={p.next} busy={p.more} onMore={p.showMore} />
    </div>
  );
}
