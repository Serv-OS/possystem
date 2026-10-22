// src/backoffice/sections/produce/RecipeList.jsx
//
// MULTI SITE STOCK Drop 2 (mockup scrRecipes, contract 3.2): the company recipe list. Only a multi
// site company ever sees it (sections/Recipes.jsx returns today's RecipesSite first for a one site
// company). Company view (the picker on All sites or a group): Name, Type, Sold as, Sites, Cost
// (avg), Price, GP %, Target, Allergens. One site view: Cost here, Price here (filters.on_at).
// Tabs All recipes | Recipe missing <n>. Pages of 100 from stock_recipes_page (keyset), 'Show more'.
// Cost, price and GP come from recipe_cost_daily (last night and every save since), never
// computed here; a recipe page costs live.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../../store';
import { money } from '../../../lib/currency';
import { getVenueClock, ymdInTz } from '../../../lib/locationTime';
import { stockApi } from '../../../lib/stock/stockApi';
import { siteList, sortSites, pageSites, MAX_ROWS } from '../../../lib/stock/itemListRules';
import {
  BLANK_FILTERS, FILTER_CHIPS, KIND_CHOICES, FOOD_KIND_CHOICES, listColumns, filtersActive, filtersToServer, sitesCell,
  costAvgWords, priceWords, gpWords, pctWords, belowTarget, allergenWords, typeCell, soldAsWords, siteFiguresOf,
  exportRows, exportFileName,
} from '../../../lib/stock/recipeRules';
import { toCsv, downloadCsv } from '../reports/_csv';
import { useStockScope } from '../../StockScope';
import { Btn, Pill, PageHead, TabBar, TableWrap, Th, Td, ShowMore, ErrorLine, EmptyLine, ui } from '../stock/stockUi';
import RecipeMissing from './RecipeMissing';
import SwapIngredientModal from './SwapIngredientModal';

const PAGE = 100;
const linkBtn = { background: 'none', border: 'none', padding: 0, color: 'var(--t1)', fontWeight: 700, cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit', fontSize: 13 };
const pickStyle = { ...ui.input, width: 'auto', minWidth: 132, padding: '7px 10px' };
const grey = { color: 'var(--t4)' };
const card = { ...ui.card, padding: '4px 16px' };

export default function RecipeList({ orgCtx, onOpen }) {
  const sc = useStockScope();
  const showToast = useStore((s) => s.showToast);
  const toast = useCallback((words, type = 'success') => { try { showToast?.(words, type); } catch { /* a toast never breaks a read */ } }, [showToast]);

  const orgId = sc.orgId;
  const oneId = sc.oneSite?.id || null;
  const oneName = oneId ? sc.siteName(oneId) : '';
  const editor = !!sc.canEditCompany('produce');
  const sites = useMemo(() => sortSites(siteList(sc.scopeSites, sc.siteName)), [sc.scopeSites, sc.siteName]);
  const siteIds = useMemo(() => sites.map((s) => s.id), [sites]);
  const scope = useMemo(() => ({ sites, siteById: sc.siteById }), [sites, sc.siteById]);
  const cur = (oneId ? sites.find((s) => s.id === oneId)?.currency : sites[0]?.currency) || undefined;
  const columns = listColumns({ oneSite: oneId });

  const [tab, setTab] = useState('all');
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [filt, setFilt] = useState(BLANK_FILTERS);
  const [page, setPage] = useState({ key: null, rows: [], next: null, total: null, error: null });
  const [moreBusy, setMoreBusy] = useState(false);
  const [missingTotal, setMissingTotal] = useState(null);
  const [modal, setModal] = useState(null);

  useEffect(() => { const h = setTimeout(() => setQ(search.trim()), 300); return () => clearTimeout(h); }, [search]);

  // the venue's own day names the export file, read once
  const clockSite = oneId || sites[0]?.id || null;
  const [tz, setTz] = useState(null);
  useEffect(() => {
    if (!clockSite) return undefined;
    let live = true;
    getVenueClock(clockSite).then((c) => { if (live) setTz(c?.timezone || null); }).catch(() => { /* London below */ });
    return () => { live = false; };
  }, [clockSite]);

  const filters = useMemo(() => filtersToServer(filt, oneId), [filt, oneId]);
  const sitesArg = useMemo(() => pageSites({ isAll: !!sc.isAll && !oneId, showClosed: !!sc.showClosed, scopeIds: siteIds }), [sc.isAll, sc.showClosed, oneId, siteIds]);
  const key = JSON.stringify([orgId, sitesArg, q, filters]);
  const keyRef = useRef(key);
  useEffect(() => { keyRef.current = key; }, [key]);

  // the first page for this scope, search and filters (state is set only when the answer lands)
  useEffect(() => {
    if (!orgId) return undefined;
    let live = true;
    stockApi.recipesPage({ orgId, sites: sitesArg, search: q || null, filters, after: null, limit: PAGE }).then((r) => {
      if (!live) return;
      setPage({ key, rows: r.data?.rows || [], next: r.data?.next || null, total: r.data?.total ?? null, error: r.error || null });
    });
    return () => { live = false; };
  }, [orgId, sitesArg, q, filters, key]);

  // the Recipe missing count: the first page's total (read again when the tab comes back to All recipes)
  const missingKey = JSON.stringify([orgId, sitesArg, tab === 'all']);
  useEffect(() => {
    if (!orgId || tab !== 'all') return undefined;
    let live = true;
    stockApi.recipeMissing({ orgId, sites: sitesArg, after: null }).then((r) => {
      if (!live) return;
      setMissingTotal(r.error ? null : (r.data?.total ?? (r.data?.rows || []).length));
    });
    return () => { live = false; };
  }, [orgId, sitesArg, tab, missingKey]);

  const loading = page.key !== key;
  const rows = useMemo(() => (loading ? [] : page.rows), [loading, page.rows]);

  const more = async () => {
    if (!page.next || moreBusy) return;
    const at = key;
    setMoreBusy(true);
    const r = await stockApi.recipesPage({ orgId, sites: sitesArg, search: q || null, filters, after: page.next, limit: PAGE });
    setMoreBusy(false);
    if (r.error) { toast(r.error.message, 'error'); return; }
    setPage((p) => {
      if (p.key !== at) return p;
      const have = new Set(p.rows.map((x) => x.id));
      return { ...p, rows: [...p.rows, ...(r.data?.rows || []).filter((x) => !have.has(x.id))], next: r.data?.next || null };
    });
  };

  const exportCsv = async () => {
    const list = [...page.rows];
    let after = page.next;
    while (after && list.length < MAX_ROWS) {
      const r = await stockApi.recipesPage({ orgId, sites: sitesArg, search: q || null, filters, after, limit: PAGE });
      if (r.error) { toast(r.error.message, 'error'); return; }
      list.push(...(r.data?.rows || []));
      after = r.data?.next || null;
    }
    if (after || list.length > MAX_ROWS) toast(`Exported the first ${MAX_ROWS.toLocaleString('en-GB')} recipes. Narrow the list to export the rest.`, 'info');
    const { headers, rows: out } = exportRows(list.slice(0, MAX_ROWS), scope);
    downloadCsv(exportFileName(ymdInTz(new Date(), tz || 'Europe/London')), toCsv(out, headers));
  };

  const setF = (k, v) => setFilt((f) => ({ ...f, [k]: v }));
  const searching = !!q || filtersActive(filt);
  const emptyWords = searching ? 'No recipes match. Clear the search or a filter to see more.' : 'No recipes here yet. Press + New recipe to add one.';
  const sub = oneId
    ? `What ${oneName} sells through a recipe, with its own cost and GP.`
    : 'Company recipes. Each one says which sites use it, with the sale price, cost and GP at each.';

  const pills = (row) => (
    <>
      {row.local_location_id && <Pill tone="blue" style={{ marginLeft: 6 }} title={`Local to ${sc.siteName(row.local_location_id) || 'one site'}`}>Local</Pill>}
      {row.archived_at && <Pill style={{ marginLeft: 6 }}>Archived</Pill>}
    </>
  );
  const nameCell = (row) => (
    <Td strong>
      <button type="button" style={linkBtn} onClick={() => onOpen?.(row.id, { tab: 'sites', siteId: oneId })}>{row.name}</button>
      {pills(row)}
    </Td>
  );
  const gpCell = (low, high, row) => (
    <Td right num>
      {gpWords(low, high)}
      {belowTarget(row) && <Pill tone="warn" style={{ marginLeft: 6 }}>Below target</Pill>}
    </Td>
  );
  const companyCells = (row) => {
    const onIds = (row.sites || []).filter((s) => s.on).map((s) => s.location_id);
    return (
      <>
        <Td>{typeCell(row) || <span style={grey}>Not set</span>}</Td>
        <Td>{soldAsWords(row) || <span style={grey}>Not linked yet</span>}</Td>
        <Td>{sitesCell({ onIds, scopeIds: siteIds, siteById: sc.siteById, localId: row.local_location_id })}</Td>
        <Td right num>{costAvgWords(row.cost_avg, cur)}</Td>
        <Td right num>{priceWords(row.price_low, row.price_high, cur)}</Td>
        {gpCell(row.gp_low, row.gp_high, row)}
        <Td right num>{pctWords(row.gp_target_pct) || <span style={grey}>None</span>}</Td>
        <Td>{allergenWords(row.allergens) || <span style={grey}>None</span>}</Td>
      </>
    );
  };
  const oneSiteCells = (row) => {
    const f = siteFiguresOf(row, oneId);
    return (
      <>
        <Td>{typeCell(row) || <span style={grey}>Not set</span>}</Td>
        <Td>{f?.menu_item_name || soldAsWords(row) || <span style={grey}>Not linked yet</span>}</Td>
        <Td right num>{costAvgWords(f?.cost ?? row.cost_avg, cur, { oneSite: true })}</Td>
        <Td right num>{f?.sale_price != null ? money(f.sale_price, cur) : ''}</Td>
        {gpCell(f?.gp_pct, f?.gp_pct, { below_target: f?.gp_pct != null && row.gp_target_pct != null && Number(f.gp_pct) < Number(row.gp_target_pct) })}
        <Td right num>{pctWords(row.gp_target_pct) || <span style={grey}>None</span>}</Td>
        <Td>{allergenWords(f?.allergens?.length ? f.allergens : row.allergens) || <span style={grey}>None</span>}</Td>
      </>
    );
  };

  return (
    <div style={ui.page}>
      <PageHead title="Recipes" sub={sub}>
        {editor && <Btn onClick={() => setModal('swap')}>Swap an ingredient</Btn>}
        {editor && <Btn onClick={exportCsv}>Export</Btn>}
        {editor && <Btn kind="primary" onClick={() => onOpen?.('new', { tab: 'details', siteId: oneId })}>+ New recipe</Btn>}
      </PageHead>

      <TabBar tabs={[{ id: 'all', label: 'All recipes' }, { id: 'missing', label: 'Recipe missing', count: missingTotal || 0 }]} value={tab} onChange={setTab} />

      {tab === 'missing' ? <RecipeMissing orgCtx={orgCtx} onOpen={onOpen} /> : (
        <>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', margin: '0 0 12px' }}>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search recipes and till products" aria-label="Search recipes and till products"
              style={{ ...ui.input, width: 260, maxWidth: '100%' }} />
            <select value={filt.kind} onChange={(e) => setF('kind', e.target.value)} aria-label="Kind" style={pickStyle}>
              <option value="">Kind: any</option>
              {KIND_CHOICES.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
            </select>
            <select value={filt.foodKind} onChange={(e) => setF('foodKind', e.target.value)} aria-label="Type" style={pickStyle}>
              <option value="">Type: any</option>
              {FOOD_KIND_CHOICES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
            {!oneId && (
              <select value={filt.site} onChange={(e) => setF('site', e.target.value)} aria-label="Site" style={pickStyle}>
                <option value="">Site: any</option>
                <optgroup label="On at">
                  {sites.map((s) => <option key={`on:${s.id}`} value={`on:${s.id}`}>On at {s.name}</option>)}
                </optgroup>
                <optgroup label="Not at">
                  {sites.map((s) => <option key={`not:${s.id}`} value={`not:${s.id}`}>Not at {s.name}</option>)}
                </optgroup>
              </select>
            )}
            {FILTER_CHIPS.map((c) => (
              <Btn key={c.key} small kind={filt[c.key] ? 'soft' : 'ghost'} aria-pressed={!!filt[c.key]} onClick={() => setF(c.key, !filt[c.key])}
                style={filt[c.key] ? { borderColor: 'var(--acc)', color: 'var(--t1)' } : undefined}>{c.label}</Btn>
            ))}
            {!loading && page.total != null && <span style={{ ...ui.sub, marginLeft: 'auto' }}>{page.total.toLocaleString('en-GB')} {page.total === 1 ? 'recipe' : 'recipes'}</span>}
          </div>

          {page.error && !loading && <div style={{ marginBottom: 12 }}><ErrorLine error={page.error} /></div>}

          {loading ? <div style={card}><EmptyLine>Loading…</EmptyLine></div> : !rows.length ? <div style={card}><EmptyLine>{emptyWords}</EmptyLine></div> : (
            <TableWrap minWidth={oneId ? 900 : 1040}>
              <thead>
                <tr>{columns.map((c) => <Th key={c.key} right={c.right}>{c.label}</Th>)}</tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    {nameCell(row)}
                    {oneId ? oneSiteCells(row) : companyCells(row)}
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          )}
          {!loading && <div style={{ marginTop: 10 }}><ShowMore next={page.next} busy={moreBusy} onMore={more} /></div>}
          <div style={{ ...ui.sub, marginTop: 10 }}>Cost, price and GP are from last night and every save since. Open a recipe to see it costed now.</div>
        </>
      )}

      {modal === 'swap' && <SwapIngredientModal orgId={orgId} onDone={() => { setModal(null); setPage((p) => ({ ...p, key: null })); }} onClose={() => setModal(null)} />}
    </div>
  );
}
