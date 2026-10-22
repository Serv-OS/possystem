// purchasing/SupplierPricesTab.jsx: Price changes > Supplier prices (multi site stock Drop 3, v5.11.96,
// contract 3.2 and 4.2, mockup INFO prices, map 4.15). Every price change at every site, from invoices,
// edits, dated prices and the company price; coming prices say when; a rise over 5% has the Price rose
// pill; head office can make one site's price the company price (every site that follows it moves).

import { useCallback, useMemo, useState } from 'react';
import { useStore } from '../../../store';
import { useStockScope } from '../../StockScope';
import { stockApi } from '../../../lib/stock/stockApi';
import { listSites } from '../../../lib/stock/supplierListRules';
import { dayWords, moneyWords } from '../../../lib/stock/purchasingRules';
import { pctWords, priceRose, comingWords, PILLS } from '../../../lib/stock/purchasingWords';
import { TableWrap, Th, Td, Pill, Btn, ShowMore, ErrorLine, EmptyLine, useConfirm, ui } from '../stock/stockUi';
import { usePaged } from './usePaged';
import { priceRowFocused } from '../../../lib/stock/stockAlertLinks';

const SOURCES = { invoice: 'Invoice', edit: 'Edit', dated: 'Dated price', company: 'Company price' };

export default function SupplierPricesTab({ orgCtx = null, focus = null }) {
  const sc = useStockScope();
  const showToast = useStore((s) => s.showToast);
  void orgCtx; // the contract's prop; the list needs only the scope
  const [risesOnly, setRisesOnly] = useState(false);
  const [source, setSource] = useState('');
  const [busy, setBusy] = useState(null);
  const [confirm, dialog] = useConfirm();
  const sites = useMemo(() => listSites({ isAll: sc.isAll, scopeSites: sc.scopeSites }), [sc.isAll, sc.scopeSites]);
  const filters = useMemo(() => { const f = {}; if (risesOnly) f.rise_over_pct = 5; if (source) f.source = source; return Object.keys(f).length ? f : null; }, [risesOnly, source]);
  const fetchPage = useCallback((after) => stockApi.priceChangesPage({ orgId: sc.orgId, sites, filters, after }), [sc.orgId, sites, filters]);
  const p = usePaged(fetchPage, `${sc.orgId}|${sites ? sites.join(',') : 'all'}|${JSON.stringify(filters)}`);
  const editor = sc.canEditCompany('purchasing');
  const makeCompany = async (r) => {
    if (!(await confirm({ title: 'Make this the company price?', words: `${r.item_name} from ${r.supplier_name} becomes ${moneyWords(r.new)} for every site that follows the company price.`, yes: 'Make it the company price' }))) return;
    setBusy(`${r.supplier_item_id}:${r.location_id}`);
    const res = await stockApi.makeCompanyPrice(r.supplier_item_id, r.location_id, r.row_version ?? r.supplier_item_version ?? null);
    setBusy(null);
    if (res.error) { showToast?.(res.error.message, 'error'); return; }
    showToast?.('Now the company price. Sites that follow it move too.', 'success');
    p.reload();
  };
  const isFocus = (r) => priceRowFocused(focus, r);
  return (
    <div>
      {dialog}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
        <label style={{ fontSize: 13, display: 'inline-flex', gap: 6, alignItems: 'center' }}><input type="checkbox" checked={risesOnly} onChange={(e) => setRisesOnly(e.target.checked)} /> Rises over 5% only</label>
        <select value={source} onChange={(e) => setSource(e.target.value)} style={{ ...ui.input, width: 170 }} aria-label="From">
          <option value="">From anywhere</option>
          {Object.entries(SOURCES).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </select>
      </div>
      <ErrorLine error={p.error} />
      {p.loading ? <EmptyLine>Loading…</EmptyLine> : !p.rows.length && !p.error ? <EmptyLine>No price changes here.</EmptyLine> : (
        <TableWrap minWidth={1040}>
          <thead><tr><Th>When</Th><Th>Site</Th><Th>Item</Th><Th>Supplier</Th><Th>Pack</Th><Th right>Old</Th><Th right>New</Th><Th right>%</Th><Th right>Cost effect (4 weeks)</Th><Th>From</Th><Th> </Th></tr></thead>
          <tbody>
            {p.rows.map((r) => {
              const k = `${r.supplier_item_id}:${r.location_id}:${r.at}`;
              return (
                <tr key={k} style={isFocus(r) ? { outline: '2px solid var(--acc)' } : undefined}>
                  <Td grey>{r.coming ? <Pill tone={PILLS.coming.tone}>{comingWords(String(r.from_day || '').slice(0, 10))}</Pill> : dayWords(String(r.at || '').slice(0, 10))}</Td>
                  <Td>{r.site_name || (r.location_id ? sc.siteName(r.location_id) : 'Company')}</Td>
                  <Td strong>{r.item_name}</Td>
                  <Td>{r.supplier_name}</Td>
                  <Td grey>{r.pack_label || ''}</Td>
                  <Td num grey>{r.old != null ? moneyWords(r.old) : ''}</Td>
                  <Td num>{r.new != null ? moneyWords(r.new) : ''}</Td>
                  <Td num>{pctWords(r.pct)}{priceRose(r.pct) && <> <Pill tone={PILLS.priceRose.tone}>{PILLS.priceRose.text}</Pill></>}</Td>
                  <Td num>{r.cost_effect_4w != null ? moneyWords(r.cost_effect_4w) : ''}</Td>
                  <Td grey>{SOURCES[r.source] || r.source || ''}</Td>
                  <Td right>{editor && r.location_id && !r.coming && r.source !== 'company' && <Btn small disabled={busy === `${r.supplier_item_id}:${r.location_id}`} onClick={() => makeCompany(r)}>Make this the company price</Btn>}</Td>
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
