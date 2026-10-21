// src/backoffice/sections/stock/items/ItemChangesTab.jsx
//
// MULTI SITE STOCK Drop 1 (mockup scrItem 'changes'): who changed what and when, old and new, and
// the cost history at each site (prices set by invoices included). stock_changes_page('item'), 100
// a page, newest first, 'Show more'. Times on the venue's clock. No Undo button: you change it back
// like any other edit, and that is logged too.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStockScope } from '../../../StockScope';
import { stockApi } from '../../../../lib/stock/stockApi';
import { countPackOf } from '../../../../lib/stock/packPrice';
import { changeWords, whenWords } from '../../../../lib/stock/itemPageRules';
import { TableWrap, Th, Td, ShowMore, ErrorLine, EmptyLine, ui } from '../stockUi';

// The free text category is logged beside its id in the same save; the name says it, the id is noise.
const HIDDEN_FIELDS = new Set(['category_id', 'updated_by', 'row_version', 'updated_at']);

export default function ItemChangesTab({ detail, tz = null }) {
  const sc = useStockScope();
  const itemId = detail?.item?.id || null;
  const [rows, setRows] = useState([]);
  const [next, setNext] = useState(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState(null);
  const seq = useRef(0);

  // the newest read wins: an older answer that lands late is dropped
  const take = useCallback((r, after, mine) => {
    if (mine !== seq.current) return;
    setBusy(false);
    if (r.error) { setError(r.error); return; }
    setError(null);
    const got = r.data?.rows || [];
    setRows((old) => (after ? [...old, ...got] : got));
    setNext(r.data?.next || null);
  }, []);
  const load = useCallback(async (after = null) => {
    if (!itemId) return;
    const mine = ++seq.current;
    setBusy(true);
    take(await stockApi.changesPage('item', itemId, after), after, mine);
  }, [itemId, take]);
  useEffect(() => {
    if (!itemId) return;
    const mine = ++seq.current;
    const after = null;
    stockApi.changesPage('item', itemId, after).then((r) => take(r, after, mine));
  }, [itemId, take]);

  const opts = useMemo(() => {
    const names = {};
    for (const si of detail?.supplier_items || []) if (si?.id) names[si.id] = si.supplier_name || '';
    for (const s of detail?.sites || []) if (s?.area_id && s.area_name) names[s.area_id] = s.area_name;
    for (const s of [...(sc.sites || []), ...(sc.closedSites || [])]) if (s?.id) names[s.id] = s.name;
    const homeCurrency = (sc.sites || [])[0]?.currency || null;
    return { countPack: countPackOf(detail), baseUnit: detail?.item?.base_unit, currency: homeCurrency, tz, names };
  }, [detail, sc.sites, sc.closedSites, tz]);

  const shown = rows.filter((r) => !HIDDEN_FIELDS.has(r.field));
  return (
    <div>
      <ErrorLine error={error} />
      {!error && !busy && shown.length === 0 ? <div style={ui.card}><EmptyLine>No changes yet.</EmptyLine></div> : (
        <TableWrap minWidth={760}>
          <thead>
            <tr><Th>When</Th><Th>Who</Th><Th>What</Th><Th>Old</Th><Th>New</Th></tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const w = changeWords(r, sc.siteById, { ...opts, currency: (r.location_id && sc.siteById?.get?.(r.location_id)?.currency) || opts.currency });
              return (
                <tr key={r.key}>
                  <Td grey>{whenWords(r.at, tz)}</Td>
                  <Td>{w.who}</Td>
                  <Td>{w.what}</Td>
                  <Td grey>{w.old}</Td>
                  <Td strong>{w.new}</Td>
                </tr>
              );
            })}
          </tbody>
        </TableWrap>
      )}
      {busy && rows.length === 0 && !error && <div style={{ ...ui.sub, marginTop: 8 }}>Loading…</div>}
      <ShowMore next={next} busy={busy} onMore={() => load(next)} />
      <div style={{ ...ui.sub, marginTop: 10 }}>No Undo button: you change it back like any other edit, and that is logged too.</div>
    </div>
  );
}
