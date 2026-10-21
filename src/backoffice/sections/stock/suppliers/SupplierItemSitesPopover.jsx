/**
 * SupplierItemSitesPopover: the Sites cell of a supplier's Items tab (mockup scrSupplier Items,
 * Drop 1 contract 3.4 and 4.3). The button says where the item is on ("All 7", "5 of 7"); the
 * panel has, per site that orders from this supplier, Price here (grey when it follows the company
 * price, with Reset), On and Paused, each saved on its own through stock_save_supplier_item_site
 * (Their sites, full control or company editors, at their own sites).
 */

import { useMemo, useState } from 'react';
import { useStore } from '../../../../store';
import { useStockScope } from '../../../StockScope';
import { stockApi } from '../../../../lib/stock/stockApi';
import { countText, moneyText, parseMoneyInput } from '../../../../lib/stock/supplierListRules';
import { Btn, Popover, CellInput, ui, ErrorLine } from '../stockUi';

export default function SupplierItemSitesPopover({ row, sites, onChanged }) {
  const sc = useStockScope();
  const showToast = useStore((s) => s.showToast);
  // the versions saved here, so a second change in the same panel carries the new one
  const [versions, setVersions] = useState({});
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null); // { siteId, words }
  const list = useMemo(() => (Array.isArray(sites) ? sites : []), [sites]);
  const bySite = useMemo(() => new Map((row?.sites || []).map((x) => [x.location_id, x])), [row]);
  const onIds = (row?.sites || []).filter((x) => x.on).map((x) => x.location_id);
  const label = countText(onIds, list.map((s) => s.id), sc.siteName);

  const save = async (site, patch, okWords) => {
    const here = bySite.get(site.id);
    if (!here) return false;
    setBusy(site.id); setError(null);
    // the newer of the version this panel saved and the one read again since
    const known = [versions[site.id], here.row_version].filter((v) => v !== null && v !== undefined).map(Number);
    const version = known.length ? Math.max(...known) : null;
    const r = await stockApi.saveSupplierItemSite(row.supplier_item_id, site.id, patch, version, 'purchasing');
    setBusy(null);
    if (r.error) { setError({ siteId: site.id, words: r.error.message }); onChanged?.(); return { error: r.error.message }; }
    if (r.data?.row_version != null) setVersions((v) => ({ ...v, [site.id]: r.data.row_version }));
    if (okWords) showToast?.(okWords, 'success');
    onChanged?.();
    return true;
  };

  return (
    <Popover label={label} width={420} ariaLabel={`Sites for ${row?.item_name || 'this item'}`}>
      {(close) => (
        <div style={{ display: 'grid', gap: 8 }}>
          <div style={{ fontSize: 14, fontWeight: 800 }}>{`Sites for ${row?.item_name || 'this item'}`}</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto auto auto', gap: '6px 10px', alignItems: 'center', fontSize: 12.5 }}>
            <span style={ui.label}>Site</span><span style={ui.label}>Price here</span><span style={ui.label}>On</span><span style={ui.label}>Paused</span>
            {list.map((site) => {
              const here = bySite.get(site.id);
              const can = sc.canEditSite(site.id, 'site_price') || sc.canEditCompany('purchasing');
              const off = !here;
              const follow = here ? here.price_here === null || here.price_here === undefined : false;
              const shown = here ? (follow ? here.price ?? row.company_price : here.price_here) : null;
              const cur = site.currency || row.currency || 'GBP';
              return [
                <span key={`${site.id}:n`} style={{ fontWeight: 700, color: off ? 'var(--t4)' : 'var(--t1)' }}>{site.name}</span>,
                <span key={`${site.id}:p`} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  {off ? <span style={{ color: 'var(--t4)' }}>Not here</span> : can ? (
                    <>
                      <CellInput value={shown ?? null} follow={follow} width={84} places={2} ariaLabel={`Price here at ${site.name}`} disabled={busy === site.id}
                        onCommit={async (v) => {
                          const m = parseMoneyInput(v, 'Price here');
                          if (!m.ok) return { error: m.error };
                          if (m.value === null) return follow ? true : save(site, { price_here: null }, `Back to the company price at ${site.name}.`);
                          if (follow && m.value === Number(shown)) return true; // typed the company price: it keeps following
                          return save(site, { price_here: m.value }, `Price here at ${site.name}: ${moneyText(m.value, cur)}. Only ${site.name}'s cost moved.`);
                        }} />
                      {!follow && <Btn kind="link" small disabled={busy === site.id} onClick={() => save(site, { price_here: null }, `Back to the company price at ${site.name}.`)}>Reset</Btn>}
                    </>
                  ) : <span style={{ color: follow ? 'var(--t4)' : 'var(--t1)' }}>{moneyText(shown, cur)}</span>}
                </span>,
                <span key={`${site.id}:o`}>
                  {off ? null : (
                    <input type="checkbox" checked={!!here.on} disabled={!can || busy === site.id} aria-label={`On at ${site.name}`}
                      onChange={(e) => save(site, { off_here: !e.target.checked }, e.target.checked ? `${row.item_name} can be ordered at ${site.name} again.` : `${row.item_name} is off at ${site.name}.`)} />
                  )}
                </span>,
                <span key={`${site.id}:z`}>
                  {off ? null : (
                    <input type="checkbox" checked={!!here.paused} disabled={!can || busy === site.id} aria-label={`Paused at ${site.name}`}
                      onChange={(e) => save(site, { paused: e.target.checked }, e.target.checked ? `${row.item_name} paused at ${site.name}.` : `${row.item_name} unpaused at ${site.name}.`)} />
                  )}
                </span>,
              ];
            })}
          </div>
          {error && <ErrorLine error={new Error(`${sc.siteName(error.siteId) ? `${sc.siteName(error.siteId)}: ` : ''}${error.words}`)} />}
          <div style={{ ...ui.sub, fontSize: 11.5 }}>Grey price = follows the company price. Type a price to set the price here.</div>
          <div style={{ ...ui.row, justifyContent: 'flex-end' }}><Btn small onClick={close}>Done</Btn></div>
        </div>
      )}
    </Popover>
  );
}
