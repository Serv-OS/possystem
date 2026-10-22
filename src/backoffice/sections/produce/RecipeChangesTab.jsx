// src/backoffice/sections/produce/RecipeChangesTab.jsx
//
// MULTI SITE STOCK Drop 2 (mockup scrRecipe 'changes', contract 3.2): who changed what and when on
// this recipe: line changes, site ticks, till links, option rules and the price changes that moved
// the cost. stock_changes_page('recipe'), 100 a page, newest first, 'Show more'. Times on the
// venue's clock. No Undo button: you change it back like any other edit, and that is logged too.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStockScope } from '../../StockScope';
import { stockApi } from '../../../lib/stock/stockApi';
import { getLocationConfig } from '../../../lib/locationTime';
import { whenWords } from '../../../lib/stock/itemPageRules';
import { recipeChangeWords } from '../../../lib/stock/recipeRules';
import { TableWrap, Th, Td, ShowMore, ErrorLine, EmptyLine, ui } from '../stock/stockUi';

const NOTE = 'Who changed what and when. Line changes, site ticks, and price changes that moved the cost.';
// the ids logged beside their names in the same save are noise on screen
const HIDDEN_FIELDS = new Set(['updated_by', 'row_version', 'updated_at', 'company_ref']);

export default function RecipeChangesTab({ recipeId }) {
  const sc = useStockScope();
  const [rows, setRows] = useState([]);
  const [next, setNext] = useState(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState(null);
  const [tz, setTz] = useState(null);
  const seq = useRef(0);

  useEffect(() => {
    const home = sc.homeSite || (sc.sites || [])[0]?.id || null;
    if (!home) return undefined;
    let live = true;
    getLocationConfig(home).then((c) => { if (live) setTz(c?.timezone || null); }).catch(() => {});
    return () => { live = false; };
  }, [sc.homeSite, sc.sites]);

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
    if (!recipeId) return;
    const mine = ++seq.current;
    setBusy(true);
    take(await stockApi.changesPage('recipe', recipeId, after), after, mine);
  }, [recipeId, take]);
  useEffect(() => {
    if (!recipeId) return;
    const mine = ++seq.current;
    const after = null;
    stockApi.changesPage('recipe', recipeId, after).then((r) => take(r, after, mine));
  }, [recipeId, take]);

  const opts = useMemo(() => {
    const names = {};
    for (const s of [...(sc.sites || []), ...(sc.closedSites || [])]) if (s?.id) names[s.id] = s.name;
    return { tz, names, currency: (sc.sites || [])[0]?.currency || null };
  }, [sc.sites, sc.closedSites, tz]);

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
              const w = recipeChangeWords(r, sc.siteById, { ...opts, currency: (r.location_id && sc.siteById?.get?.(r.location_id)?.currency) || opts.currency });
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
      <div style={{ ...ui.sub, marginTop: 10 }}>{NOTE}</div>
    </div>
  );
}
