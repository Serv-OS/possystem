/**
 * Produce > Batch and prep for a MULTI SITE company on All sites or a group (multi site stock
 * Drop 2, v5.11.93, mockup scrBatch, design 2.7, map 4.6).
 *
 * Batch and prep recipes down, the sites in scope across. Each cell is how that site gets the
 * batch: Bought in (from the central kitchen or a supplier), Made here (the kitchen logs each
 * batch) or Made to order (no logging, the sale takes the raw ingredients off). A company editor
 * changes it (stock_batch_set_how); everyone else reads it. A site that still holds the made item
 * cannot switch to Made to order: the database refuses and the Not yet modal says why. Nothing
 * else moves: the drainer reads the choice on the next sale.
 *
 * Pages of 100 from stock_batch_how (keyset), Show more for the next page. One site companies
 * never see this screen (produce/BatchesSite.jsx is theirs).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useStore } from '../../../store';
import { stockApi } from '../../../lib/stock/stockApi';
import { pageSites, siteList, sortSites } from '../../../lib/stock/itemListRules';
import {
  BATCH_STRIP, BATCH_SUB, BATCH_TITLE, HOW_OPTIONS, NOT_USED, NOT_YET_NOTE, NOT_YET_TITLE,
  appendRows, applyHow, gridMinWidth, holdsWords, howLabel, howSavedWords, isHoldingRefusal, siteCell,
} from '../../../lib/stock/prepList';
import { useStockScope } from '../../StockScope';
import LockLine from '../stock/LockLine';
import { Btn, Modal, Notice, PageHead, TableWrap, Th, Td, ShowMore, ErrorLine, EmptyLine, ui } from '../stock/stockUi';

const linkBtn = { background: 'none', border: 'none', padding: 0, color: 'var(--t1)', fontWeight: 700, cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit', fontSize: 13 };
const small = { fontSize: 11.5, color: 'var(--t4)', marginTop: 3, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' };
const selectStyle = { ...ui.input, width: 'auto', minWidth: 126, padding: '6px 9px' };
const EMPTY = 'No batch or prep recipes here yet. Make one under Recipes with the kind Batch or Prep.';

export default function BatchHowGrid({ orgCtx }) {
  const sc = useStockScope();
  const showToast = useStore((s) => s.showToast);
  const toast = useCallback((words, type = 'success') => { try { showToast?.(words, type); } catch { /* a toast never breaks a save */ } }, [showToast]);

  const orgId = sc.orgId || orgCtx?.venueOrgId || null;
  const editor = !!sc.canEditCompany('produce');
  const sites = useMemo(() => sortSites(siteList(sc.scopeSites, sc.siteName)), [sc.scopeSites, sc.siteName]);
  const siteIds = useMemo(() => sites.map((s) => s.id), [sites]);
  const sitesArg = useMemo(() => pageSites({ isAll: !!sc.isAll, showClosed: !!sc.showClosed, scopeIds: siteIds }), [sc.isAll, sc.showClosed, siteIds]);

  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState({ key: null, rows: [], next: null, error: null, loading: true });
  const [moreBusy, setMoreBusy] = useState(false);
  const [savingKey, setSavingKey] = useState(null);
  const [warn, setWarn] = useState(null);

  useEffect(() => { const h = setTimeout(() => setQ(search.trim()), 300); return () => clearTimeout(h); }, [search]);

  const key = JSON.stringify([orgId, sitesArg, q]);
  useEffect(() => {
    if (!orgId) return undefined;
    let live = true;
    stockApi.batchHow({ orgId, sites: sitesArg, search: q || null }).then((r) => {
      if (!live) return;
      setPage({ key, rows: Array.isArray(r.data?.rows) ? r.data.rows : [], next: r.data?.next || null, error: r.error, loading: false });
    });
    return () => { live = false; };
  }, [key, orgId, sitesArg, q]);

  const more = async () => {
    if (!page.next || moreBusy) return;
    setMoreBusy(true);
    const r = await stockApi.batchHow({ orgId, sites: sitesArg, search: q || null, after: page.next });
    setMoreBusy(false);
    if (r.error) { setPage((p) => ({ ...p, error: r.error })); return; }
    setPage((p) => ({ ...p, rows: appendRows(p.rows, r.data?.rows), next: r.data?.next || null, error: null }));
  };

  const setHow = async (row, site, how) => {
    const cellKey = `${row.recipe_id}|${site.id}`;
    setSavingKey(cellKey);
    const r = await stockApi.batchSetHow(row.recipe_id, site.id, how, row.row_version);
    setSavingKey(null);
    if (r.error) {
      if (isHoldingRefusal(r.error)) { setWarn(r.error.message); return; }
      toast(r.error.message || String(r.error), 'error');
      return;
    }
    setPage((p) => ({ ...p, rows: applyHow(p.rows, row.recipe_id, site.id, r.data) }));
    toast(howSavedWords(site.name, row.name, r.data?.how || how));
  };

  // Make a batch and the Prep list belong to one site: the picker moves there and the one site
  // view (BatchSiteTools over BatchesSite) opens. For the Prep list the open record is left first,
  // so the one site view finds it however fast the picker re-renders; a cancelled ask takes it back.
  const makeBatch = () => { sc.askWhichSite('Make a batch'); };
  const prepList = async () => {
    sc.go('batches', { open: { prepList: true } });
    const id = await sc.askWhichSite('Prep list');
    if (!id) sc.takeOpen?.('batches');
  };
  const openRecipe = (row) => sc.go('recipes', { open: { recipeId: row.recipe_id, tab: 'sites' } });

  const loading = page.loading || page.key !== key;

  return (
    <div style={ui.page}>
      <PageHead title={BATCH_TITLE} sub={BATCH_SUB}>
        <Btn kind="soft" onClick={makeBatch}>Make a batch</Btn>
        <Btn kind="soft" onClick={prepList}>Prep list</Btn>
      </PageHead>

      <div style={{ marginBottom: 12 }}>
        <Notice tone="info">
          {BATCH_STRIP.map(([b, words], i) => <span key={b}>{i > 0 ? ' ' : ''}<b>{b}</b>: {words}</span>)}
        </Notice>
      </div>

      {!editor && <div style={{ marginBottom: 12 }}><LockLine kind="company" /></div>}

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search batch recipes" aria-label="Search batch recipes"
          style={{ ...ui.input, width: 260 }} />
        {!loading && <span style={{ fontSize: 12.5, color: 'var(--t3)' }}>{page.rows.length} {page.rows.length === 1 ? 'recipe' : 'recipes'}{page.next ? ' shown' : ''}</span>}
      </div>

      <ErrorLine error={page.error} />

      {loading && !page.error && <EmptyLine>Loading…</EmptyLine>}
      {!loading && !page.error && page.rows.length === 0 && <EmptyLine>{q ? 'No batch recipe matches that.' : EMPTY}</EmptyLine>}

      {!loading && page.rows.length > 0 && (
        <TableWrap minWidth={gridMinWidth(sites.length)}>
          <thead>
            <tr>
              <Th sticky>Batch recipe</Th>
              <Th>Yield</Th>
              {sites.map((s) => <Th key={s.id}>{s.name}</Th>)}
            </tr>
          </thead>
          <tbody>
            {page.rows.map((row) => (
              <tr key={row.recipe_id}>
                <Td sticky strong>
                  <button type="button" style={linkBtn} title={`Open ${row.name}`} onClick={() => openRecipe(row)}>{row.name}</button>
                  {row.output_item_name && <div style={small}>makes {row.output_item_name}</div>}
                </Td>
                <Td>{row.yield_words || ''}</Td>
                {sites.map((s) => {
                  const cell = siteCell(row, s.id);
                  if (!cell) return <Td key={s.id} grey>{NOT_USED}</Td>;
                  const saving = savingKey === `${row.recipe_id}|${s.id}`;
                  const holds = holdsWords(cell);
                  return (
                    <Td key={s.id}>
                      {editor ? (
                        <select value={cell.how} disabled={saving} aria-label={`How ${s.name} gets ${row.name}`} style={selectStyle}
                          onChange={(e) => setHow(row, s, e.target.value)}>
                          {HOW_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>
                      ) : <span>{howLabel(cell.how)}</span>}
                      {(saving || holds) && <div style={small}>{saving ? 'Saving…' : holds}</div>}
                    </Td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}

      <ShowMore next={page.next} busy={moreBusy} onMore={more} />

      {warn && (
        <Modal title={NOT_YET_TITLE} onClose={() => setWarn(null)} width={520}
          footer={<><span style={{ flex: 1 }} /><Btn kind="primary" onClick={() => setWarn(null)}>OK</Btn></>}>
          <p style={{ margin: 0, fontSize: 14, color: 'var(--t1)', lineHeight: 1.5 }}>{warn}</p>
          <p style={{ ...ui.sub, margin: '8px 0 0' }}>{NOT_YET_NOTE}</p>
        </Modal>
      )}
    </div>
  );
}
