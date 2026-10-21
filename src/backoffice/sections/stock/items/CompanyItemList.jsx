/**
 * Inventory > Stock items for a MULTI SITE company (multi site stock Drop 1, mockup scrItems).
 *
 *  - Company view (the picker on All sites or a group): one company list with a Sites column
 *    ('All 7', '5 of 7', 'Leeds', 'Local to Leeds'); click it to tick sites. List or Sites grid.
 *  - One site view (the picker on one site): what that site stocks, at its own price, cost and par.
 *
 * Pages of 100 from the server (stock_items_page, keyset), 'Show more' for the next page. Every
 * change goes through a save function (stockApi) and shows only after the database answers. A
 * one site company never sees this screen (stock/items/StockItemsSplit.jsx is theirs).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../../../store';
import { money } from '../../../../lib/currency';
import { getVenueClock, ymdInTz } from '../../../../lib/locationTime';
import { stockApi } from '../../../../lib/stock/stockApi';
import { pauseWords } from '../../../../lib/stock/pauseRules';
import { packPrice, countPackOf } from '../../../../lib/stock/packPrice';
import {
  BLANK_FILTERS, FILTER_CHIPS, ITEM_TYPES, MAX_ROWS, bulkOutcome, checklistGroups, exportFileName,
  exportRows, filtersActive, filtersToServer, isLow, itemsWords, jobIdsOf, linkAt, listColumns,
  onHandText, pageSites, priceInput, queuedWords, replaceRows, rowPause, runLimited, runningOut, siteList,
  sortSites, typeLabel,
} from '../../../../lib/stock/itemListRules';
import { toCsv, downloadCsv } from '../../reports/_csv';
import { useStockScope } from '../../../StockScope';
import NewSiteBanner from '../NewSiteBanner';
import {
  Btn, Pill, Segmented, MenuButton, PageHead, TableWrap, Th, Td, ShowMore, ErrorLine, EmptyLine,
  useConfirm, ui,
} from '../stockUi';
import SitesGrid from './SitesGrid';
import SitesPopover from './SitesPopover';
import BulkBar from './BulkBar';
import AddToSitesModal from './AddToSitesModal';
import RemoveFromSitesModal from './RemoveFromSitesModal';
import RunOutModal from './RunOutModal';
import SetParModal from './SetParModal';
import ChangeCategoryModal from './ChangeCategoryModal';
import PauseModal from './PauseModal';
import ChangePricesModal from './ChangePricesModal';
import CategoriesModal from './CategoriesModal';
import AddItemModal from './AddItemModal';
import ImportModal from './ImportModal';
import CopySiteModal from './CopySiteModal';

const PAGE = 100;

const linkBtn = { background: 'none', border: 'none', padding: 0, color: 'var(--t1)', fontWeight: 700, cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit', fontSize: 13 };
const pickStyle = { ...ui.input, width: 'auto', minWidth: 132, padding: '7px 10px' };
const grey = { color: 'var(--t4)' };
const card = { ...ui.card, padding: '4px 16px' };

/** The company price of the main supplier, in the pack people use ('£1.38 a bottle'). */
function companyPrice(row) {
  const m = row?.main;
  if (!m) return '';
  const each = packPrice(m.unit_price, countPackOf(row), m.currency);
  if (each) return each;
  return m.pack_price != null ? `${money(m.pack_price, m.currency)} for ${m.pack_description || 'the pack'}` : '';
}

export default function CompanyItemList({ orgCtx, onOpen }) {
  const sc = useStockScope();
  const showToast = useStore((s) => s.showToast);
  const toast = useCallback((words, type = 'success') => { try { showToast?.(words, type); } catch { /* a toast never breaks a save */ } }, [showToast]);
  const [confirm, confirmDialog] = useConfirm();

  const orgId = sc.orgId;
  const oneId = sc.oneSite?.id || null;
  const oneName = oneId ? sc.siteName(oneId) : '';
  const editor = !!sc.canEditCompany('inventory');
  const sites = useMemo(() => sortSites(siteList(sc.scopeSites, sc.siteName)), [sc.scopeSites, sc.siteName]);
  const siteIds = useMemo(() => sites.map((s) => s.id), [sites]);
  const scope = useMemo(() => ({ sites, siteName: sc.siteName }), [sites, sc.siteName]);
  const groups = useMemo(() => checklistGroups(sc.groups, siteIds), [sc.groups, siteIds]);
  const allSites = useMemo(
    () => sortSites(siteList(sc.showClosed ? [...(sc.sites || []), ...(sc.closedSites || [])] : sc.sites, sc.siteName)),
    [sc.sites, sc.closedSites, sc.showClosed, sc.siteName],
  );
  // Add to sites offers every open site in reach whatever the picker shows (mockup addtosites): in the
  // one site view every listed item is already at that site, so the picker's scope alone adds nothing.
  const openSites = useMemo(() => sortSites(siteList(sc.sites, sc.siteName)), [sc.sites, sc.siteName]);
  const openGroups = useMemo(() => checklistGroups(sc.groups, openSites.map((s) => s.id)), [sc.groups, openSites]);
  const cur = (oneId ? sites.find((s) => s.id === oneId)?.currency : sites[0]?.currency) || undefined;
  const columns = listColumns({ oneSite: oneId, multi: true });

  const [mode, setMode] = useState('list');
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [filt, setFilt] = useState(BLANK_FILTERS);
  const [page, setPage] = useState({ key: null, rows: [], next: null, total: null, error: null });
  const [moreBusy, setMoreBusy] = useState(false);
  const [ticked, setTicked] = useState(() => new Set());
  const [modal, setModal] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [retry, setRetry] = useState(null);
  const [retryRows, setRetryRows] = useState([]);
  const [savingKey, setSavingKey] = useState(null);
  const [cats, setCats] = useState([]);
  const [catsTick, setCatsTick] = useState(0);
  const [sups, setSups] = useState([]);

  useEffect(() => { const h = setTimeout(() => setQ(search.trim()), 300); return () => clearTimeout(h); }, [search]);

  // The venue's own day names the export file (never the device's date: Back Office is often
  // opened in another time zone). Read once, so pressing Export never waits for it.
  const clockSite = oneId || sites[0]?.id || null;
  const [tz, setTz] = useState(null);
  useEffect(() => {
    if (!clockSite) return undefined;
    let live = true;
    getVenueClock(clockSite).then((c) => { if (live) setTz(c?.timezone || null); }).catch(() => { /* London below */ });
    return () => { live = false; };
  }, [clockSite]);

  const filters = useMemo(() => filtersToServer({ ...filt, notAt: oneId ? '' : filt.notAt, onAt: oneId }), [filt, oneId]);
  const sitesArg = useMemo(() => pageSites({ isAll: !!sc.isAll && !oneId, showClosed: !!sc.showClosed, scopeIds: siteIds }), [sc.isAll, sc.showClosed, oneId, siteIds]);
  const key = JSON.stringify([orgId, sitesArg, q, filters]);
  const keyRef = useRef(key);
  useEffect(() => { keyRef.current = key; }, [key]);

  // The first page for this scope, search and filters (state is set only when the answer lands).
  useEffect(() => {
    if (!orgId) return undefined;
    let live = true;
    stockApi.itemsPage({ orgId, sites: sitesArg, search: q || null, filters, after: null, limit: PAGE }).then((r) => {
      if (!live) return;
      setPage({ key, rows: r.data?.rows || [], next: r.data?.next || null, total: r.data?.total ?? null, error: r.error || null });
    });
    return () => { live = false; };
  }, [orgId, sitesArg, q, filters, key]);

  // Categories and suppliers for the filter boxes.
  useEffect(() => {
    if (!orgId) return undefined;
    let live = true;
    stockApi.categories(orgId).then((r) => { if (live && !r.error) setCats(r.data || []); });
    return () => { live = false; };
  }, [orgId, catsTick]);
  useEffect(() => {
    if (!orgId) return undefined;
    let live = true;
    (async () => {
      const all = [];
      let after = null;
      for (let i = 0; i < MAX_ROWS / PAGE; i++) {
        const r = await stockApi.suppliersPage({ orgId, sites: sitesArg, search: null, filters: null, after });
        if (!live || r.error) break;
        all.push(...(r.data?.rows || []));
        after = r.data?.next || null;
        if (!after) break;
      }
      if (live) setSups(all.filter((s) => !s.archived_at).map((s) => ({ id: s.id, name: s.name })));
    })();
    return () => { live = false; };
  }, [orgId, sitesArg]);

  const loading = page.key !== key;
  const rows = useMemo(() => (loading ? [] : page.rows), [loading, page.rows]);
  const tickedRows = useMemo(() => rows.filter((r) => ticked.has(r.id)), [rows, ticked]);

  /**
   * Read again only these rows (a cell saved, a bulk box closed): stock_items_page with the same scope,
   * search and filters plus { ids }, 100 ids a call. Each row is put back in its place; a row that no
   * longer fits the list goes, as a full read would do. The other loaded pages are left alone, so one
   * tick at 50 sites never reads every page again.
   */
  const refreshRows = useCallback(async (ids) => {
    const want = [...new Set((ids || []).filter(Boolean))];
    if (!want.length) return;
    const at = key;
    const got = [];
    for (let i = 0; i < want.length && i < MAX_ROWS; i += PAGE) {
      const r = await stockApi.itemsPage({ orgId, sites: sitesArg, search: q || null, filters: { ...(filters || {}), ids: want.slice(i, i + PAGE) }, after: null, limit: PAGE });
      if (r.error) { if (keyRef.current === at) setPage((p) => ({ ...p, error: r.error })); return; }
      got.push(...(r.data?.rows || []));
    }
    if (keyRef.current === at) setPage((p) => (p.key === at ? { ...p, ...replaceRows(p, want, got), error: null } : p));
  }, [key, orgId, sitesArg, q, filters]);

  /** Read again every row on screen (the pages already loaded, at most 1,000), keeping the place. */
  const refresh = useCallback(async () => {
    const want = Math.min(Math.max(page.rows.length, PAGE), MAX_ROWS);
    const at = key;
    const got = [];
    let after = null;
    let next = null;
    let total = null;
    for (let i = 0; i < MAX_ROWS / PAGE; i++) {
      const r = await stockApi.itemsPage({ orgId, sites: sitesArg, search: q || null, filters, after, limit: PAGE });
      if (r.error) { if (keyRef.current === at) setPage((p) => ({ ...p, error: r.error })); return; }
      if (i === 0) total = r.data?.total ?? null;
      got.push(...(r.data?.rows || []));
      next = r.data?.next || null;
      after = next;
      if (!next || got.length >= want) break;
    }
    if (keyRef.current === at) setPage({ key: at, rows: got, next, total, error: null });
  }, [page.rows.length, key, orgId, sitesArg, q, filters]);

  const more = async () => {
    if (!page.next || moreBusy) return;
    const at = key;
    setMoreBusy(true);
    const r = await stockApi.itemsPage({ orgId, sites: sitesArg, search: q || null, filters, after: page.next, limit: PAGE });
    setMoreBusy(false);
    if (r.error) { toast(r.error.message, 'error'); return; }
    setPage((p) => {
      if (p.key !== at) return p;
      const have = new Set(p.rows.map((x) => x.id));
      return { ...p, rows: [...p.rows, ...(r.data?.rows || []).filter((x) => !have.has(x.id))], next: r.data?.next || null };
    });
  };

  const afterQueued = (queued, again = null, rowIds = []) => {
    const ids = jobIdsOf(queued);
    if (ids.length) { setJobs(ids); setRetry(() => again); setRetryRows(rowIds); toast(queuedWords(queued), 'info'); }
  };

  // ── one cell at a time (Sites column and Sites grid) ──
  const tickSite = async (row, siteId, on, how = 'runout') => {
    const site = sc.siteName(siteId);
    setSavingKey(`${row.id}|${siteId}`);
    const call = () => (on
      ? stockApi.setItemSites({ items: [row.id], add: [siteId] })
      : stockApi.setItemSites({ items: [row.id], remove: [{ location_id: siteId, mode: how }] }));
    const r = await call();
    setSavingKey(null);
    if (r.error) { toast(r.error.message, 'error'); return r; }
    const refused = r.data?.refused || [];
    if (refused.length) toast(refused[0].error, 'error');
    else if (on) toast(`${row.name} is now stocked at ${site}: on its count sheet and Order pad at once.`);
    else if (how === 'remove') toast(`Removed from ${site}. The row is archived, never deleted.`);
    else toast(`Stop ordering, run out at ${site}. It stays on the count until it reaches zero.`);
    afterQueued(r.queued, call, [row.id]);
    await refreshRows([row.id]);
    return r;
  };

  // A price box answers the cell itself: the database's words go under the box (CellInput).
  const setPriceHere = async (row, siteId, typed) => {
    const site = sc.siteName(siteId);
    const link = linkAt(row, siteId);
    if (!link?.on) return null;
    let v = priceInput(typed);
    if (Number.isNaN(v)) return { error: 'Type a price of 0 or more, or leave it empty to follow the company price.' };
    const sameSupplier = !link.supplier_here || link.supplier_here.supplier_item_id === row.main?.supplier_item_id;
    const company = sameSupplier && row.main?.pack_price != null ? Number(row.main.pack_price) : null;
    // Typing the company price back in means "follow the company price" again (mockup).
    if (v != null && company != null && Math.abs(v - company) < 0.00005) v = null;
    if ((link.price_here ?? null) === v) return null;
    setSavingKey(`${row.id}|${siteId}`);
    const r = await stockApi.saveItemSite(row.id, siteId, { price_here: v }, link.row_version ?? null);
    setSavingKey(null);
    if (r.error) { if (r.conflict) await refreshRows([row.id]); return { error: r.error.message }; }
    toast(v == null ? `Back to the company price at ${site}.` : `Price here at ${site}: ${money(v, sites.find((s) => s.id === siteId)?.currency)}. Only ${site}'s cost moved.`);
    afterQueued(r.queued);
    await refreshRows([row.id]);
    return null;
  };

  // ── header buttons ──
  const startCount = async () => {
    const id = await sc.askWhichSite('Start a count');
    if (id) sc.go('stock-counts', { openNew: true });
  };
  const addItem = async () => {
    if (editor) { setModal({ kind: 'add_item', local: false, presetSites: siteIds }); return; }
    const id = oneId || await sc.askWhichSite('Add a local item');
    if (id) setModal({ kind: 'add_item', local: true, presetSites: [id] });
  };
  const exportCsv = async (only = null) => {
    let list = only;
    if (!list) {
      list = [...page.rows];
      let after = page.next;
      while (after && list.length < MAX_ROWS) {
        const r = await stockApi.itemsPage({ orgId, sites: sitesArg, search: q || null, filters, after, limit: PAGE });
        if (r.error) { toast(r.error.message, 'error'); return; }
        list.push(...(r.data?.rows || []));
        after = r.data?.next || null;
      }
      if (after || list.length > MAX_ROWS) toast(`Exported the first ${MAX_ROWS.toLocaleString('en-GB')} items. Narrow the list to export the rest.`, 'info');
    }
    const { headers, rows: out } = exportRows(list, scope);
    downloadCsv(exportFileName(ymdInTz(new Date(), tz || 'Europe/London')), toCsv(out, headers));
  };

  // ── bulk bar ──
  const bulkDone = async (res) => {
    const ids = tickedRows.map((r) => r.id);
    setModal(null);
    setTicked(new Set());
    afterQueued(res?.queued, null, ids);
    await refreshRows(ids);
  };
  const archiveTicked = async (items) => {
    const ok = await confirm({
      title: items.length === 1 ? `Archive ${items[0].name}?` : `Archive ${items.length} items?`,
      words: 'Only when no site holds it. Archived items keep their history.',
      yes: 'Archive', danger: true,
    });
    if (!ok) return;
    const out = bulkOutcome(await runLimited(items.map((it) => () => stockApi.archiveItem(it.id, it.row_version ?? null, true)), 4));
    if (out.failed) toast(out.ok ? `${out.ok} archived. ${out.failed} did not archive: ${out.first}` : out.first, 'error');
    else toast(`Archived ${itemsWords(items)}.`, 'info');
    setTicked(new Set());
    await refreshRows(items.map((it) => it.id));
  };
  const onAction = (kind) => {
    if (kind === 'export') { exportCsv(tickedRows); return; }
    if (kind === 'archive') { archiveTicked(tickedRows); return; }
    setModal({ kind });
  };
  const flip = (id) => setTicked((t) => { const n = new Set(t); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const allTicked = rows.length > 0 && rows.every((r) => ticked.has(r.id));
  const flipAll = () => setTicked(allTicked ? new Set() : new Set(rows.map((r) => r.id)));
  const setF = (k, v) => { setFilt((f) => ({ ...f, [k]: v })); setTicked(new Set()); };

  const closeModal = () => setModal(null);
  const sub = oneId
    ? `What ${oneName} stocks, at its own price, cost and par.`
    : 'One company list. The Sites column shows where each item is stocked. Click it to change.';

  const pills = (row) => {
    const p = rowPause(row, scope);
    return (
      <>
        {row.local_location_id && <Pill tone="blue" style={{ marginLeft: 6 }}>Local</Pill>}
        {row.archived_at && <Pill style={{ marginLeft: 6 }}>Archived</Pill>}
        {!oneId && runningOut(row, scope) && <Pill style={{ marginLeft: 6 }}>Running out</Pill>}
        {p && <Pill tone="warn" style={{ marginLeft: 6 }}>{pauseWords(p)}</Pill>}
      </>
    );
  };
  const nameCell = (row) => (
    <Td strong>
      <button type="button" style={linkBtn} onClick={() => onOpen(row.id, { tab: 'sites', siteId: oneId })}>{row.name}</button>
      {row.name_suffix && <span style={grey}> {row.name_suffix}</span>}
      {pills(row)}
    </Td>
  );
  const companyCells = (row) => (
    <>
      <Td>{row.category || <span style={grey}>None</span>}</Td>
      <Td>{typeLabel(row.type)}</Td>
      <Td>{row.main?.supplier_name || <span style={grey}>None</span>}</Td>
      <Td num>{companyPrice(row)}</Td>
      <Td>
        <SitesPopover row={row} sites={sites}
          onTick={(siteId, on, how) => tickSite(row, siteId, on, how)}
          onOpenSitesTab={() => onOpen(row.id, { tab: 'sites' })}
          canTick={(siteId) => !row.archived_at && !!sc.canEditSite(siteId, 'site_price')} />
      </Td>
      <Td right num>{row.stock_value != null ? money(row.stock_value, cur) : ''}</Td>
    </>
  );
  const oneSiteCells = (row) => {
    const link = linkAt(row, oneId);
    const pack = countPackOf(row);
    const c = row.main?.currency || cur;
    return (
      <>
        <Td>{row.category || <span style={grey}>None</span>}</Td>
        <Td>{link?.supplier_here?.supplier_name || row.main?.supplier_name || <span style={grey}>None</span>}</Td>
        <Td right num grey={link?.price_here == null} strong={link?.price_here != null}>{packPrice(link?.unit_price, pack, c)}</Td>
        <Td right num>{packPrice(link?.unit_cost, pack, c)}</Td>
        <Td right num>
          {onHandText(link?.on_hand, pack)}
          {isLow(link) && <Pill tone="warn" style={{ marginLeft: 6 }}>Low</Pill>}
          {link?.stop_ordering_at && <Pill style={{ marginLeft: 6 }}>Running out</Pill>}
        </Td>
        <Td right num>{onHandText(link?.par_level, pack)}</Td>
        <Td right num>{row.stock_value != null ? money(row.stock_value, cur) : ''}</Td>
      </>
    );
  };

  const searching = !!q || filtersActive(filt);
  const emptyWords = searching
    ? 'No stock items match. Clear the search or a filter to see more.'
    : `No stock items here yet. Press ${editor ? '+ Add item' : '+ Add a local item'} to add one.`;
  const importItems = [
    { label: 'Import CSV', hint: 'Items, suppliers, prices or pars from a spreadsheet.', onClick: () => setModal({ kind: 'import', source: 'csv' }) },
    { label: 'Import from Nory or MarketMan', hint: 'The export file from either system.', onClick: () => setModal({ kind: 'import', source: 'nory_marketman' }) },
  ];

  return (
    <div style={ui.page}>
      {confirmDialog}
      {!oneId && <div style={{ marginBottom: 14 }}><NewSiteBanner /></div>}
      <PageHead title="Stock items" sub={sub}>
        {!oneId && <Segmented value={mode} onChange={setMode} options={[{ value: 'list', label: 'List' }, { value: 'grid', label: 'Sites grid' }]} />}
        {sc.canOpen('stock-counts') && <Btn onClick={startCount}>Start a count</Btn>}
        {editor && <Btn onClick={() => setModal({ kind: 'categories' })}>Categories</Btn>}
        {editor && <MenuButton label="Import" items={importItems} small={false} />}
        {editor && <Btn onClick={() => exportCsv()}>Export</Btn>}
        {editor && <Btn onClick={() => setModal({ kind: 'copy_site' })}>Copy a site</Btn>}
        <Btn kind="primary" onClick={addItem}>{editor ? '+ Add item' : '+ Add a local item'}</Btn>
      </PageHead>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', margin: '14px 0 12px' }}>
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, SKU or barcode" aria-label="Search name, SKU or barcode"
          style={{ ...ui.input, width: 260, maxWidth: '100%' }} />
        <select value={filt.category} onChange={(e) => setF('category', e.target.value)} aria-label="Category" style={pickStyle}>
          <option value="">Category: any</option>
          {cats.filter((c) => !c.archived_at).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          <option value="none">No category</option>
        </select>
        <select value={filt.type} onChange={(e) => setF('type', e.target.value)} aria-label="Type" style={pickStyle}>
          <option value="">Type: any</option>
          {ITEM_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
        <select value={filt.supplier} onChange={(e) => setF('supplier', e.target.value)} aria-label="Supplier" style={pickStyle}>
          <option value="">Supplier: any</option>
          {sups.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        {!oneId && (
          <select value={filt.notAt} onChange={(e) => setF('notAt', e.target.value)} aria-label="Not at" style={pickStyle}>
            <option value="">Not at: any site</option>
            {sites.map((s) => <option key={s.id} value={s.id}>Not at {s.name}</option>)}
          </select>
        )}
        {FILTER_CHIPS.map((c) => (
          <Btn key={c.key} small kind={filt[c.key] ? 'soft' : 'ghost'} aria-pressed={!!filt[c.key]} onClick={() => setF(c.key, !filt[c.key])}
            style={filt[c.key] ? { borderColor: 'var(--acc)', color: 'var(--t1)' } : undefined}>{c.label}</Btn>
        ))}
        {!loading && page.total != null && <span style={{ ...ui.sub, marginLeft: 'auto' }}>{page.total.toLocaleString('en-GB')} {page.total === 1 ? 'item' : 'items'}</span>}
      </div>

      {editor && (ticked.size > 0 || jobs.length > 0) && (
        <div style={{ marginBottom: 12 }}>
          <BulkBar count={ticked.size} multi onAction={onAction}
            onClear={() => { setTicked(new Set()); setJobs([]); setRetry(null); setRetryRows([]); }}
            jobs={jobs} onRetry={retry ? async () => { const r = await retry(); afterQueued(r?.queued, retry, retryRows); await refreshRows(retryRows); } : null} />
        </div>
      )}

      {page.error && !loading && <div style={{ marginBottom: 12 }}><ErrorLine error={page.error} /></div>}

      {mode === 'grid' && !oneId ? (
        <>
          <div style={{ ...ui.sub, marginBottom: 8 }}>Grey price = follows the company price. Type a price to set the price here.</div>
          {loading ? <div style={card}><EmptyLine>Loading…</EmptyLine></div> : !rows.length ? <div style={card}><EmptyLine>{emptyWords}</EmptyLine></div> : (
            <SitesGrid rows={rows} sites={sites} onOpen={(id) => onOpen(id, { tab: 'sites' })}
              onTick={(row, siteId, on, how) => tickSite(row, siteId, on, how)}
              onPrice={setPriceHere}
              canPrice={(siteId) => !!sc.canEditSite(siteId, 'site_price')}
              savingKey={savingKey} />
          )}
        </>
      ) : (
        loading ? <div style={card}><EmptyLine>Loading…</EmptyLine></div> : !rows.length ? <div style={card}><EmptyLine>{emptyWords}</EmptyLine></div> : (
          <TableWrap minWidth={oneId ? 980 : 940}>
            <thead>
              <tr>
                {editor && <Th><input type="checkbox" checked={allTicked} onChange={flipAll} aria-label="Tick every item on screen" /></Th>}
                {columns.map((c) => <Th key={c.key} right={c.right}>{c.label}</Th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  {editor && <Td><input type="checkbox" checked={ticked.has(row.id)} onChange={() => flip(row.id)} aria-label={`Tick ${row.name}`} /></Td>}
                  {nameCell(row)}
                  {oneId ? oneSiteCells(row) : companyCells(row)}
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )
      )}
      {!loading && <div style={{ marginTop: 10 }}><ShowMore next={page.next} busy={moreBusy} onMore={more} /></div>}

      {modal?.kind === 'add_sites' && <AddToSitesModal items={tickedRows} sites={openSites} groups={openGroups} onDone={bulkDone} onClose={closeModal} />}
      {modal?.kind === 'remove_sites' && <RemoveFromSitesModal items={tickedRows} sites={sites} groups={groups} onDone={bulkDone} onClose={closeModal} />}
      {modal?.kind === 'run_out' && <RunOutModal items={tickedRows} sites={sites} groups={groups} onDone={bulkDone} onClose={closeModal} />}
      {modal?.kind === 'set_par' && <SetParModal items={tickedRows} sites={sites} groups={groups} onDone={bulkDone} onClose={closeModal} />}
      {modal?.kind === 'category' && <ChangeCategoryModal items={tickedRows} orgId={orgId} onDone={bulkDone} onClose={closeModal} />}
      {modal?.kind === 'pause' && <PauseModal items={tickedRows} sites={sites} groups={groups} onDone={bulkDone} onClose={closeModal} />}
      {modal?.kind === 'prices' && <ChangePricesModal target={{ itemIds: tickedRows.map((r) => r.id) }} sites={sites} orgId={orgId} onDone={bulkDone} onClose={closeModal} />}
      {modal?.kind === 'categories' && <CategoriesModal orgId={orgId} onClose={() => { closeModal(); setCatsTick((t) => t + 1); refresh(); }} />}
      {modal?.kind === 'add_item' && <AddItemModal orgCtx={orgCtx} local={!!modal.local} presetSites={modal.presetSites} onSaved={() => { closeModal(); refresh(); }} onClose={closeModal} />}
      {modal?.kind === 'import' && <ImportModal orgId={orgId} sites={sites} source={modal.source} onClose={() => { closeModal(); refresh(); }} />}
      {modal?.kind === 'copy_site' && <CopySiteModal sites={allSites} onClose={() => { closeModal(); refresh(); }} />}
    </div>
  );
}
