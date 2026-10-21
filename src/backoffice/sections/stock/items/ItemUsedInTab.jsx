// src/backoffice/sections/stock/items/ItemUsedInTab.jsx
//
// MULTI SITE STOCK Drop 1 (mockup scrItem 'usedin'): every recipe and batch recipe that uses this
// item, with the sites where each is on. stock_item_used_in, 100 a page, keyset paged, 'Show more'
// (a staple at 3,000 recipes by 50 sites would pass the 1,000 row cap as plain rows). A recipe
// name opens Produce > Recipes with the picker on a site where that recipe is on.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useStockScope } from '../../../StockScope';
import { stockApi } from '../../../../lib/stock/stockApi';
import { sitesText } from '../../../../lib/stock/siteScope';
import { Pill, TableWrap, Th, Td, ShowMore, ErrorLine, EmptyLine, ui } from '../stockUi';

const KIND_WORDS = Object.freeze({ batch: 'Batch', prep: 'Prep' });
const trim = (v) => { const n = Number(v); return Number.isFinite(n) ? String(Math.round(n * 1000) / 1000) : ''; };
const linkBtn = { background: 'none', border: 'none', padding: 0, color: 'var(--t1)', fontWeight: 700, cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit', fontSize: 13 };

export default function ItemUsedInTab({ detail }) {
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
    take(await stockApi.itemUsedIn(itemId, after), after, mine);
  }, [itemId, take]);
  useEffect(() => {
    if (!itemId) return;
    const mine = ++seq.current;
    const after = null;
    stockApi.itemUsedIn(itemId, after).then((r) => take(r, after, mine));
  }, [itemId, take]);

  const scopeIds = (sc.sites || []).map((s) => s.id);
  const whereOn = (row) => {
    const on = (row.sites || []).filter((s) => s && s.on_here !== false).map((s) => s.location_id).filter((id) => scopeIds.includes(id));
    if (on.length <= 4) return on.map((id) => sc.siteName(id)).filter(Boolean).join(', ') || 'None here';
    return sitesText({ onIds: on, scopeIds, siteById: sc.siteById });
  };
  const openRecipe = (row) => {
    const on = (row.sites || []).filter((s) => s && s.on_here !== false).map((s) => s.location_id);
    const here = sc.oneSite?.id && on.includes(sc.oneSite.id) ? sc.oneSite.id : on.find((id) => scopeIds.includes(id));
    if (here) sc.setChoice({ kind: 'site', id: here });
    sc.go('recipes');
  };

  return (
    <div>
      <ErrorLine error={error} />
      {!error && !busy && rows.length === 0 ? <div style={ui.card}><EmptyLine>Not used in a recipe yet</EmptyLine></div> : (
        <TableWrap minWidth={640}>
          <thead>
            <tr><Th>Recipe</Th><Th>Amount</Th><Th>Sites where it is on</Th></tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.recipe_id}>
                <Td strong>
                  {sc.canOpen?.('recipes')
                    ? <button type="button" style={linkBtn} onClick={() => openRecipe(row)} title={`Open ${row.name} in Recipes`}>{row.name}</button>
                    : row.name}
                  {KIND_WORDS[row.kind] && <Pill tone="neutral" style={{ marginLeft: 6 }}>{KIND_WORDS[row.kind]}</Pill>}
                </Td>
                <Td num>{trim(row.qty)} {row.pack_name || row.unit || ''}</Td>
                <Td>{whereOn(row)}</Td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}
      {busy && rows.length === 0 && !error && <div style={{ ...ui.sub, marginTop: 8 }}>Loading…</div>}
      <ShowMore next={next} busy={busy} onMore={() => load(next)} />
    </div>
  );
}
