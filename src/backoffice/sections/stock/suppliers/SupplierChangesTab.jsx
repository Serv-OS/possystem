/**
 * SupplierChangesTab: every change to this supplier, who, when, old and new (mockup scrSupplier
 * Changes, Drop 1 contract 3.4 and 4.3): stock_changes_page('supplier', id), 100 a page, newest
 * first, Show more. A site value (account number, order email, price here) names its site, and the
 * database shows a login only the site values of sites it reaches. Times are on the venue's clock.
 */

import { useEffect, useState } from 'react';
import { useStockScope } from '../../../StockScope';
import { stockApi } from '../../../../lib/stock/stockApi';
import { getLocationConfig } from '../../../../lib/locationTime';
import { fmtVenueDateTime } from '../../../../lib/venueDate';
import { changeWhat, changeValueText } from '../../../../lib/stock/supplierListRules';
import { ui, TableWrap, Th, Td, ShowMore, ErrorLine, EmptyLine } from '../stockUi';

export default function SupplierChangesTab({ supplierId }) {
  const sc = useStockScope();
  const [more, setMore] = useState(false);
  const [page, setPage] = useState({ key: null, rows: [], next: null, error: null });
  const loading = page.key !== supplierId;

  useEffect(() => {
    let on = true;
    stockApi.changesPage('supplier', supplierId, null).then((r) => {
      if (!on) return;
      setPage({ key: supplierId, rows: r.error ? [] : r.data?.rows || [], next: r.error ? null : r.data?.next || null, error: r.error || null });
    });
    return () => { on = false; };
  }, [supplierId]);

  const showMore = async () => {
    if (!page.next || more) return;
    setMore(true);
    const r = await stockApi.changesPage('supplier', supplierId, page.next);
    setMore(false);
    setPage((p) => (p.key !== supplierId ? p : r.error ? { ...p, error: r.error } : { ...p, rows: [...p.rows, ...(r.data?.rows || [])], next: r.data?.next || null }));
  };
  const rows = loading ? [] : page.rows;
  const next = loading ? null : page.next;
  const error = loading ? null : page.error;

  // Times on the venue's clock: a site change on that site's clock, a company change on the home
  // site's (each clock read once; getLocationConfig keeps it).
  const home = sc.homeSite || (sc.sites || [])[0]?.id || null;
  const [zones, setZones] = useState({});
  const need = [...new Set([home, ...rows.map((r) => r.location_id)].filter(Boolean))].filter((id) => !(id in zones)).join(',');
  useEffect(() => {
    if (!need) return undefined;
    let on = true;
    Promise.all(need.split(',').map((id) => getLocationConfig(id).then((c) => [id, c?.timezone || null]).catch(() => [id, null])))
      .then((pairs) => { if (on) setZones((z) => ({ ...z, ...Object.fromEntries(pairs) })); });
    return () => { on = false; };
  }, [need]);
  const when = (r) => fmtVenueDateTime(r.at, zones[r.location_id || home] || zones[home] || 'Europe/London', { year: false });

  return (
    <div>
      <div style={{ ...ui.sub, marginBottom: 10 }}>Every change to this supplier: who, when, old and new.</div>
      {error && !rows.length ? <div style={ui.card}><ErrorLine error={error} /></div>
      : loading ? <div style={ui.card}><EmptyLine>Loading…</EmptyLine></div>
      : !rows.length ? <div style={ui.card}><EmptyLine>No changes yet.</EmptyLine></div>
      : (
        <>
          <TableWrap minWidth={720}>
            <thead>
              <tr><Th>When</Th><Th>Who</Th><Th>What</Th><Th>Old</Th><Th>New</Th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <Td grey>{when(r)}</Td>
                  <Td>{r.who_name || ''}</Td>
                  <Td strong>{changeWhat(r, sc.siteName)}</Td>
                  <Td grey>{changeValueText(r.before, r.field)}</Td>
                  <Td>{changeValueText(r.after, r.field)}</Td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
          {error && <ErrorLine error={error} />}
          <ShowMore next={next} busy={more} onMore={showMore} />
        </>
      )}
      <div style={{ ...ui.sub, marginTop: 10 }}>No Undo button: you change it back like any other edit, and that is logged too.</div>
    </div>
  );
}
