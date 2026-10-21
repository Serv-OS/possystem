/**
 * SupplierItemsTab: everything this supplier sells (mockup scrSupplier Items, Drop 1 contract 3.4
 * and 4.3), 100 a page through stock_prices_page (keyset, Show more).
 *
 *   Show prices for   Company, or one site (the price column then shows that site's price, or
 *                     "Off here").
 *   Change prices     ChangePricesModal: the ticked rows, or every item of this supplier.
 *   Import price list ImportModal for supplier items (an import is a company change in Inventory).
 *   Pause at sites    PauseModal for the items of the ticked rows (section Purchasing).
 *   Export            the rows, up to 1,000, as a CSV file.
 *
 * VAT is shown by its rate, so "VAT 20%" at one site and "Standard Rate 20%" at another are the same.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useStore } from '../../../../store';
import { useStockScope } from '../../../StockScope';
import { stockApi } from '../../../../lib/stock/stockApi';
import { packPrice, countPackOf } from '../../../../lib/stock/packPrice';
import {
  moneyText, nextPriceText, spreadText, vatText, unitPriceAt, siteRows, exportPriceRows, fileName,
} from '../../../../lib/stock/supplierListRules';
import { toCsv, downloadCsv } from '../../reports/_csv';
import { Btn, Pill, ui, TableWrap, Th, Td, ShowMore, ErrorLine, EmptyLine } from '../stockUi';
import ChangePricesModal from '../items/ChangePricesModal';
import ImportModal from '../items/ImportModal';
import PauseModal from '../items/PauseModal';
import SupplierItemSitesPopover from './SupplierItemSitesPopover';

const EXPORT_MAX = 1000;
const linkBtn = { background: 'none', border: 'none', padding: 0, color: 'var(--t1)', fontWeight: 700, cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit', fontSize: 13 };

export default function SupplierItemsTab({ detail, reload }) {
  const sc = useStockScope();
  const showToast = useStore((s) => s.showToast);
  const s = detail?.supplier || {};
  const [priceFor, setPriceFor] = useState('company');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [more, setMore] = useState(false);
  const [again, setAgain] = useState(0); // read the first page again (after a change)
  const [ticked, setTicked] = useState(() => new Set());
  const [modal, setModal] = useState(null); // 'prices' | 'import' | 'pause'
  const [exporting, setExporting] = useState(false);

  const editor = sc.canEditCompany('purchasing');
  const canImport = editor && sc.canEditCompany('inventory');
  // the sites of the login's list that can order from this supplier: the price choices and the Sites cell
  const orderSites = useMemo(() => siteRows(sc.sites || [], detail?.sites || []).filter((r) => r.on).map((r) => r.site), [sc.sites, detail]);
  const canPause = editor || orderSites.some((x) => sc.canEditSite(x.id, 'site_price'));
  const site = priceFor === 'company' ? null : orderSites.find((x) => x.id === priceFor) || null;

  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const pageKey = `${s.id}|${site ? site.id : 'company'}|${query}`;
  const [page, setPage] = useState({ key: null, rows: [], next: null, error: null });
  const loading = page.key !== pageKey;
  const fetchPage = useCallback((after) => stockApi.pricesPage({ supplierId: s.id, siteId: site ? site.id : null, search: query || null, after }), [s.id, site, query]);

  useEffect(() => {
    let on = true;
    fetchPage(null).then((r) => {
      if (!on) return;
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
  // a changed price or tick reads the first page again; the rows on screen stay until it answers
  const refresh = useCallback(() => setAgain((n) => n + 1), []);
  const rows = loading ? [] : page.rows;
  const next = loading ? null : page.next;
  const error = loading ? null : page.error;

  const flip = (id) => setTicked((t) => { const n = new Set(t); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const tickedRows = rows.filter((r) => ticked.has(r.supplier_item_id));
  const allTicked = rows.length > 0 && tickedRows.length === rows.length;

  const exportCsv = async () => {
    setExporting(true);
    let list = rows.slice();
    let after = next;
    while (after && list.length < EXPORT_MAX) {
      const r = await fetchPage(after);
      if (r.error) { setExporting(false); showToast?.(r.error.message, 'error'); return; }
      list = list.concat(r.data?.rows || []);
      after = r.data?.next || null;
    }
    setExporting(false);
    const out = exportPriceRows(list.slice(0, EXPORT_MAX), { priceFor, siteName: sc.siteName });
    downloadCsv(fileName(s.name), toCsv(out.rows, out.headers));
    if (after) showToast?.(`Exported the first ${EXPORT_MAX} items.`, 'info');
  };

  const emptyWords = query ? 'No item matches that search.'
    : 'No items from this supplier yet. Add one from a stock item\'s Suppliers tab, or import a price list.';

  const done = () => { setModal(null); setTicked(new Set()); refresh(); reload?.(); };
  const currencyOf = (row) => (site?.currency || row.currency || 'GBP');

  return (
    <div>
      <div style={{ ...ui.row, flexWrap: 'wrap', marginBottom: 12 }}>
        <label htmlFor={`spf-${s.id}`} style={{ ...ui.sub }}>Show prices for</label>
        <select id={`spf-${s.id}`} value={priceFor} onChange={(e) => setPriceFor(e.target.value)} style={{ ...ui.input, width: 200 }}>
          <option value="company">Company</option>
          {orderSites.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
        </select>
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search items…" aria-label="Search items" style={{ ...ui.input, width: 220 }} />
        <span style={{ flex: 1 }} />
        {editor && <Btn small onClick={() => setModal('prices')}>{tickedRows.length ? `Change prices (${tickedRows.length})` : 'Change prices'}</Btn>}
        {canImport && <Btn small onClick={() => setModal('import')}>Import price list</Btn>}
        {canPause && <Btn small onClick={() => setModal('pause')} disabled={!tickedRows.length} title={tickedRows.length ? undefined : 'Tick items first'}>Pause at sites</Btn>}
        <Btn small onClick={exportCsv} disabled={exporting || !rows.length}>{exporting ? 'Exporting…' : 'Export'}</Btn>
      </div>

      {error && !rows.length ? <div style={ui.card}><ErrorLine error={error} /></div>
      : loading ? <div style={ui.card}><EmptyLine>Loading…</EmptyLine></div>
      : !rows.length ? <div style={ui.card}><EmptyLine>{emptyWords}</EmptyLine></div>
      : (
        <>
          <TableWrap minWidth={1040}>
            <thead>
              <tr>
                {(editor || canPause) && (
                  <Th>
                    <input type="checkbox" checked={allTicked} aria-label="Tick every row shown"
                      onChange={() => setTicked(allTicked ? new Set() : new Set(rows.map((r) => r.supplier_item_id)))} />
                  </Th>
                )}
                <Th>Item</Th>
                <Th>Their name</Th>
                <Th>SKU</Th>
                <Th>Pack</Th>
                <Th right>{site ? `Price at ${site.name}` : 'Company price'}</Th>
                <Th>Next price</Th>
                <Th>VAT</Th>
                <Th>Sites</Th>
                <Th>Price spread</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const cur = currencyOf(row);
                const price = site ? row.site_price : row.company_price;
                const off = site && (row.site_price === null || row.site_price === undefined);
                const unit = off ? null : unitPriceAt(row, price);
                const perPack = row.count_pack && unit !== null ? packPrice(unit, countPackOf(row), cur) : '';
                const siteNext = site ? (row.sites || []).find((x) => x.location_id === site.id)?.next_price : null;
                return (
                  <tr key={row.supplier_item_id}>
                    {(editor || canPause) && (
                      <Td><input type="checkbox" checked={ticked.has(row.supplier_item_id)} aria-label={`Tick ${row.item_name}`} onChange={() => flip(row.supplier_item_id)} /></Td>
                    )}
                    <Td strong>
                      {sc.canOpen?.('stock-items') && row.item_id
                        ? <button type="button" style={linkBtn} title={`Open ${row.item_name} in Stock items`} onClick={() => sc.go('stock-items', { open: { itemId: row.item_id, tab: 'suppliers' } })}>{row.item_name}</button>
                        : row.item_name}
                      {row.paused && <Pill tone="warn" style={{ marginLeft: 6 }}>Paused</Pill>}
                    </Td>
                    <Td>{row.supplier_product_name || ''}</Td>
                    <Td>{row.sku || ''}</Td>
                    <Td>{row.pack_description || ''}</Td>
                    <Td right num grey={off}>
                      {off ? 'Off here' : (
                        <span style={{ display: 'inline-block', textAlign: 'right' }}>
                          <span>{moneyText(price, cur)}</span>
                          {perPack && <span style={{ display: 'block', fontSize: 11.5, color: 'var(--t4)' }}>{perPack}</span>}
                        </span>
                      )}
                    </Td>
                    <Td grey={!(siteNext || row.next_price)}>{nextPriceText(siteNext || row.next_price, cur)}</Td>
                    <Td>{vatText(row.purchase_vat_rate)}</Td>
                    <Td>
                      <SupplierItemSitesPopover row={row} sites={orderSites} onChanged={refresh} />
                    </Td>
                    <Td num>{spreadText(row.spread, row.currency || 'GBP')}</Td>
                  </tr>
                );
              })}
            </tbody>
          </TableWrap>
          {error && <ErrorLine error={error} />}
          <ShowMore next={next} busy={more} onMore={showMore} />
        </>
      )}
      <div style={{ ...ui.sub, marginTop: 10 }}>VAT is matched by its rate, so "VAT 20%" at one site and "Standard Rate 20%" at another are the same.</div>

      {modal === 'prices' && (
        <ChangePricesModal
          target={tickedRows.length ? { supplierItemIds: tickedRows.map((r) => r.supplier_item_id) } : { supplierId: s.id }}
          sites={orderSites} orgId={sc.orgId} section="purchasing" onDone={done} onClose={() => setModal(null)} />
      )}
      {modal === 'import' && (
        <ImportModal orgId={sc.orgId} sites={orderSites} kind="supplier_item" supplier={{ id: s.id, name: s.name }} onClose={() => { setModal(null); refresh(); }} />
      )}
      {modal === 'pause' && (
        <PauseModal
          items={tickedRows.map((r) => ({ id: r.item_id, name: r.item_name }))}
          sites={orderSites.filter((x) => editor || sc.canEditSite(x.id, 'site_price'))}
          groups={(sc.groups || []).map((g) => ({ id: g.id, name: g.name, location_ids: g.locationIds || g.location_ids || [] }))}
          section="purchasing" onDone={done} onClose={() => setModal(null)} />
      )}
    </div>
  );
}
