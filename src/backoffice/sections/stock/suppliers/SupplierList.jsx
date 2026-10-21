/**
 * SupplierList: Purchasing > Suppliers for a multi site company (mockup scrSuppliers, Drop 1
 * contract 3.4 and 4.3). One company list, 100 a page through stock_suppliers_page (keyset, Show
 * more). The picker decides the sites in view: All sites, a group, or one site; the Can order
 * column counts only those sites.
 *
 * A one site company never sees this screen: Suppliers.jsx sends it to SuppliersSplit.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useStore } from '../../../../store';
import { useStockScope } from '../../../StockScope';
import { stockApi } from '../../../../lib/stock/stockApi';
import { canOrderText, pricesText, howOrdersText, spendText, listSites } from '../../../../lib/stock/supplierListRules';
import { Btn, Pill, ui, PageHead, TableWrap, Th, Td, ShowMore, ErrorLine, EmptyLine } from '../stockUi';
import AddSupplierModal from './AddSupplierModal';

const ids = (list) => (Array.isArray(list) ? list : []).map((s) => (typeof s === 'string' ? s : s?.id)).filter(Boolean);

export default function SupplierList({ onOpen }) {
  const sc = useStockScope();
  const showToast = useStore((s) => s.showToast);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [more, setMore] = useState(false);
  const [again, setAgain] = useState(0); // read the first page again (after a save)
  const [adding, setAdding] = useState(null); // { local, presetSites }
  const [archived, setArchived] = useState(false); // the Archived chip: archived suppliers only

  const scopeIds = useMemo(() => ids(sc.scopeSites), [sc.scopeSites]);
  const scopeKey = scopeIds.join(',');
  const sites = useMemo(() => listSites({ isAll: sc.isAll, scopeSites: sc.scopeSites }), [sc.isAll, sc.scopeSites]);
  const editor = sc.canEditCompany('purchasing');
  const currency = (sc.scopeSites || [])[0]?.currency || 'GBP';
  const pageKey = `${sc.isAll ? 'all' : scopeKey}|${query}|${archived ? 'archived' : 'live'}`;
  // the page on screen and the picker and search it answers; a newer key means it is loading
  const [page, setPage] = useState({ key: null, rows: [], next: null, error: null });
  const loading = page.key !== pageKey;

  // The search box waits a moment after typing before it asks the server.
  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const fetchPage = useCallback((after) => stockApi.suppliersPage({ orgId: sc.orgId, sites, search: query || null, filters: archived ? { archived: true } : null, after }), [sc.orgId, sites, query, archived]);

  useEffect(() => {
    let on = true;
    fetchPage(null).then((r) => {
      if (!on) return; // a newer search or picker change asked again
      setPage({ key: pageKey, rows: r.error ? [] : r.data?.rows || [], next: r.error ? null : r.data?.next || null, error: r.error || null });
    });
    return () => { on = false; };
  }, [fetchPage, pageKey, again]);

  const showMore = async () => {
    if (!page.next || more) return;
    const key = page.key;
    setMore(true);
    const r = await fetchPage(page.next);
    setMore(false);
    setPage((p) => (p.key !== key ? p : r.error ? { ...p, error: r.error } : { ...p, rows: [...p.rows, ...(r.data?.rows || [])], next: r.data?.next || null }));
  };
  // a new picker or search shows Loading, never the rows of the last one
  const rows = loading ? [] : page.rows;
  const next = loading ? null : page.next;
  const error = loading ? null : page.error;

  const add = async () => {
    if (editor) { setAdding({ local: false, presetSites: scopeIds }); return; }
    // A local supplier belongs to one site: the picker's site, or the one chosen now.
    const siteId = await sc.askWhichSite('Add a local supplier');
    if (siteId) setAdding({ local: true, presetSites: [siteId] });
  };

  const saved = (id, name) => {
    setAdding(null);
    showToast?.(`${name} saved.`, 'success');
    setAgain((n) => n + 1);
    if (id) onOpen?.(id, { tab: 'sites' });
  };

  const emptyWords = query ? 'No supplier matches that search.'
    : archived ? 'No archived suppliers here.'
      : `No suppliers here yet. Press ${editor ? '+ Add supplier' : '+ Add a local supplier'} to add one.`;

  return (
    <div style={ui.page}>
      <PageHead title="Suppliers" sub="One company list. Each supplier says which sites may order from it, with each site's account number and delivery days.">
        <Btn kind="primary" onClick={add}>{editor ? '+ Add supplier' : '+ Add a local supplier'}</Btn>
      </PageHead>

      <div style={{ ...ui.row, margin: '14px 0 12px', flexWrap: 'wrap' }}>
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search suppliers…" aria-label="Search suppliers"
          style={{ ...ui.input, width: 280, maxWidth: '100%' }} />
        <Btn small kind={archived ? 'soft' : 'ghost'} aria-pressed={archived} onClick={() => setArchived((a) => !a)}
          style={archived ? { borderColor: 'var(--acc)', color: 'var(--t1)' } : undefined}>Archived</Btn>
      </div>

      {error && !rows.length ? <div style={ui.card}><ErrorLine error={error} /></div>
      : loading ? <div style={ui.card}><EmptyLine>Loading…</EmptyLine></div>
      : !rows.length ? <div style={ui.card}><EmptyLine>{emptyWords}</EmptyLine></div>
      : (
        <>
          <TableWrap minWidth={760}>
            <thead>
              <tr>
                <Th>Supplier</Th>
                <Th>Can order</Th>
                <Th right>Items</Th>
                <Th>Prices</Th>
                <Th>How orders reach them</Th>
                <Th right>Spend this month</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const prices = pricesText(row);
                return (
                  <tr key={row.id}>
                    <Td strong>
                      <Btn kind="link" small onClick={() => onOpen?.(row.id, { tab: 'sites' })} style={{ padding: 0, fontSize: 13 }}>{row.name}</Btn>
                      {row.archived_at && <Pill style={{ marginLeft: 6 }}>Archived</Pill>}
                    </Td>
                    <Td>{canOrderText(row, scopeIds, sc.siteName)}</Td>
                    <Td right num>{row.items ?? 0}</Td>
                    <Td>{prices.pill ? <Pill>{prices.words}</Pill> : prices.words}</Td>
                    <Td>{howOrdersText(row)}</Td>
                    <Td right num>{spendText(row.spend_month, currency)}</Td>
                  </tr>
                );
              })}
            </tbody>
          </TableWrap>
          {error && <ErrorLine error={error} />}
          <ShowMore next={next} busy={more} onMore={showMore} />
        </>
      )}

      {adding && (
        <AddSupplierModal local={adding.local} presetSites={adding.presetSites} onSaved={saved} onClose={() => setAdding(null)} />
      )}
    </div>
  );
}
