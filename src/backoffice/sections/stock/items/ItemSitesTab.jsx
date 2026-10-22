// src/backoffice/sections/stock/items/ItemSitesTab.jsx
//
// MULTI SITE STOCK Drop 1 (mockup sitesTab, "the heart of it"): one row per site in this login's
// list. Where the item is stocked, who supplies it there, the price and cost there, the par. Type in
// a cell and it saves when you leave it, with a small tick. No publish.
//
//   On            stock_set_item_sites (add; untick asks the two choices first: UntickChoiceModal)
//   Supplier here stock_save_item_site { supplier_here }        (site_price)
//   Price here    stock_save_item_site { price_here } / null     (site_price; Reset = follow again)
//   Par, Reorder at, Min  stock_save_item_site, all three each time, in base units (site_facts)
//   Area          stock_save_item_site { area_id, move_holding } (site_facts; the holding moves too)
//   Counted here  stock_save_item_site { counted_here }          (site_facts)
//   Purchased or made, Sold directly  stock_save_item { site: { kind } } / { site: { is_sellable } } at that
//                 site, with the item's version (company: map 4.2 moves them here from Details)
//   Paused        stock_save_item_site { paused, paused_from, paused_until } (site_price)
//   On hand       opens today's Stock tab for that site in a side panel (StockTab.jsx)
//
// The levels: a 'Their sites' login changes par, reorder, min, area and counted here at its own
// sites; 'Their sites, full control' also the supplier here, the price here, the ticks and pause;
// company editors everything, plus the top buttons. The screen only greys what the database would
// refuse (stock_co__guard decides). A cell refused or saved first by someone else says the server's
// words under the row, and the row is read again.

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../../../store';
import { useStockScope } from '../../../StockScope';
import { stockApi } from '../../../../lib/stock/stockApi';
import { fetchItemAreaHoldings } from '../../../../lib/stock/areas';
import { packPrice, packQtyWords, packWordFor, moneyText } from '../../../../lib/stock/packPrice';
import { pauseWords } from '../../../../lib/stock/pauseRules';
import {
  siteRowModel, parPatchFor, pricePatchFor, packPriceWords, untickState, queuedNote,
  lastPaidWords, siteDraftOf, toPackQty, KIND_CHOICES,
} from '../../../../lib/stock/itemPageRules';
import { Btn, Pill, Modal, Sheet, Popover, SiteChecklist, Field, Notice, TableWrap, Th, CellInput, SavedTick, ui } from '../stockUi';
import LockLine from '../LockLine';
import UntickChoiceModal from './UntickChoiceModal';
import StockTab from './StockTab';
import ParByWeekdayPopover from './ParByWeekdayPopover';

const HINTS = Object.freeze({
  price: 'What this site is charged for the pack. Grey means it follows the company price.',
  cost: "What one pack on this site's shelf is worth in the stock value.",
  last: 'The price on the last invoice posted here.',
  par: 'What the site wants on the shelf after a delivery.',
});
const COLS = 14;

const tdStyle = { padding: '9px 10px', borderBottom: '1px solid var(--bdr)', fontSize: 13, verticalAlign: 'top' };
const grey = { color: 'var(--t4)' };
const small = { fontSize: 11.5, color: 'var(--t4)', marginTop: 3, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' };
const selectStyle = { ...ui.input, width: 'auto', padding: '5px 8px', fontSize: 12.5 };
const unitWord = { fontSize: 11.5, color: 'var(--t4)', marginLeft: 4 };

/** At most four calls at a time (bulk par and copy from a site), every answer kept in order. */
async function runFour(tasks) {
  const out = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++;
      try { out[i] = await tasks[i](); } catch (e) { out[i] = { error: e }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, tasks.length) }, worker));
  return out;
}

// on hand in the pack people count in, the same pack as par, reorder and min: '31 bottles'
const onHandWords = (m, baseUnit) => packQtyWords(toPackQty(Number(m.onHand) || 0, m.countPack) ?? 0, m.countPack, baseUnit);

export default function ItemSitesTab({ detail, reload, focusSiteId = null, orgCtx = null, tz = null }) {
  const sc = useStockScope();
  const showToast = useStore((s) => s.showToast);
  const item = detail?.item || {};
  const companyEditor = !!sc.canEditCompany('inventory');
  const sites = useMemo(() => [...(sc.sites || []), ...(sc.showClosed ? (sc.closedSites || []) : [])], [sc.sites, sc.closedSites, sc.showClosed]);
  const models = useMemo(() => sites.map((s) => siteRowModel(s, detail, sc)), [sites, detail, sc]);
  const [busy, setBusy] = useState(null);
  const [savedKey, setSavedKey] = useState(null);
  const [errors, setErrors] = useState({});
  const [untick, setUntick] = useState(null);
  const [stockFor, setStockFor] = useState(null);
  const [areasBySite, setAreasBySite] = useState({});
  const [bulk, setBulk] = useState(null);
  const rowRefs = useRef({});
  const savedTimer = useRef(null);

  useEffect(() => () => { if (savedTimer.current) clearTimeout(savedTimer.current); }, []);
  useEffect(() => {
    if (!focusSiteId) return;
    const el = rowRefs.current[focusSiteId];
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [focusSiteId]);

  const flash = (key) => {
    setSavedKey(key);
    if (savedTimer.current) clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setSavedKey(null), 2000);
  };
  const say = (words, tone = 'success') => { try { showToast?.(words, tone); } catch { /* no toast, no harm */ } };
  const withQueue = (words, r) => { const note = queuedNote(r?.queued); return note ? `${words} ${note}` : words; };
  const setRowError = (siteId, words) => setErrors((e) => ({ ...e, [siteId]: words || null }));

  /**
   * One cell of one site: the server decides, the screen says what it answered. Answers true when
   * saved, or { error } (never a bare false, so CellInput shows the words, never the saved tick).
   * A typed cell (cell: true) shows the words under itself; a select or tick shows them under the row.
   */
  const [byDay, setByDay] = useState(null); // v5.11.96 (Drop 3): the By day popover's site
  const saveSite = async (m, patch, okWords, key, { cell = false } = {}) => {
    setBusy(key);
    setRowError(m.siteId, null);
    const r = await stockApi.saveItemSite(item.id, m.siteId, patch, m.rowVersion);
    setBusy(null);
    if (r.error) {
      if (!cell) setRowError(m.siteId, r.error.message);
      if (!r.conflict) say(r.error.message, 'error');
      await reload?.();
      return { error: r.error };
    }
    flash(key);
    if (okWords) say(withQueue(typeof okWords === 'function' ? okWords(r.data) : okWords, r));
    await reload?.();
    return true;
  };

  const loadAreas = useCallback(async (siteId) => {
    if (!siteId || areasBySite[siteId]) return areasBySite[siteId] || null;
    setAreasBySite((a) => ({ ...a, [siteId]: 'loading' }));
    const r = await stockApi.siteAreas(siteId);
    const rows = r.error ? [] : (r.data || []);
    setAreasBySite((a) => ({ ...a, [siteId]: rows }));
    return rows;
  }, [areasBySite]);

  // ── the On tick ──
  const tickOn = async (m) => {
    setBusy(`${m.siteId}|on`);
    setRowError(m.siteId, null);
    const r = await stockApi.setItemSites({ items: [item.id], add: [m.siteId] });
    setBusy(null);
    if (r.error) { say(r.error.message, 'error'); setRowError(m.siteId, r.error.message); await reload?.(); return; }
    const refused = (r.data?.refused || []).find((x) => x.location_id === m.siteId) || (r.data?.refused || [])[0];
    if (refused) { say(refused.error, 'error'); setRowError(m.siteId, refused.error); await reload?.(); return; }
    say(withQueue(`${item.name} is now stocked at ${m.name}: on its count sheet and Order pad at once.`, r));
    await reload?.();
  };
  const untickRun = async (mode) => {
    const m = untick?.model;
    if (!m) return;
    setBusy(`${m.siteId}|on`);
    const r = await stockApi.setItemSites({ items: [item.id], remove: [{ location_id: m.siteId, mode }] });
    setBusy(null);
    setUntick(null);
    if (r.error) { say(r.error.message, 'error'); setRowError(m.siteId, r.error.message); await reload?.(); return; }
    const refused = (r.data?.refused || []).find((x) => x.location_id === m.siteId) || (r.data?.refused || [])[0];
    if (refused) { say(refused.error, 'error'); setRowError(m.siteId, refused.error); await reload?.(); return; }
    say(withQueue(mode === 'runout'
      ? `Stop ordering, run out at ${m.name}. It stays on the count until it reaches zero.`
      : `Removed from ${m.name}. The row is archived, never deleted.`, r));
    await reload?.();
  };
  const askUntick = (m) => {
    const q = toPackQty(Number(m.onHand) || 0, m.countPack) ?? 0;
    const state = untickState({ onHand: q, unit: packWordFor(q, m.countPack, item.base_unit), recipeNames: m.recipeNamesHere, recipeCount: m.recipesHere, siteName: m.name });
    const usedBy = [...state.usedBy];
    if (m.recipesHere > usedBy.length) usedBy.push(`${m.recipesHere - usedBy.length} other recipe${m.recipesHere - usedBy.length === 1 ? '' : 's'}`);
    setUntick({ model: m, holds: state.holds, usedBy });
  };

  // ── the price here ──
  const commitPrice = async (m, typed) => {
    const p = pricePatchFor(typed, m);
    if (p.skip) return true;
    if (p.error) return { error: p.error };
    if (p.reset) return saveSite(m, { price_here: null }, `Back to the company price at ${m.name}.`, `${m.siteId}|price`, { cell: true });
    const shown = packPriceWords(p.patch.price_here, m) || moneyText(p.patch.price_here, m.currency);
    return saveSite(m, p.patch, `Price here at ${m.name}: ${shown}. Only ${m.name}'s cost moved.`, `${m.siteId}|price`, { cell: true });
  };
  const resetPrice = (m) => saveSite(m, { price_here: null }, `Back to the company price at ${m.name}.`, `${m.siteId}|price`);

  // ── par, reorder, min (all three sent each time) ──
  const commitPar = async (m, which, typed) => {
    const patch = parPatchFor(m, { [which]: typed });
    if (patch === undefined) return { error: `Type a number of ${packWordFor(2, m.countPack, item.base_unit)}, or leave it empty.` };
    const before = m.parBase || {};
    if (['par_level', 'reorder_point', 'min_level'].every((k) => (before[k] ?? null) === (patch[k] ?? null))) return true;
    return saveSite(m, patch, `Par saved for ${m.name}.`, `${m.siteId}|${which}`, { cell: true });
  };

  // ── supplier here, area, counted here, paused ──
  const commitSupplier = (m, siId) => {
    if (!siId || siId === m.supplierUsedId) return;
    const name = m.supplierChoices.find((c) => c.id === siId)?.name || '';
    saveSite(m, { supplier_here: siId }, `Supplier here at ${m.name}: ${name}.`, `${m.siteId}|supplier`);
  };
  const commitArea = (m, areaId) => {
    const next = areaId || null;
    if (next === (m.areaId || null)) return;
    const list = Array.isArray(areasBySite[m.siteId]) ? areasBySite[m.siteId] : [];
    const name = list.find((a) => a.id === next)?.name || 'No area';
    saveSite(m, { area_id: next, move_holding: true, by_name: orgCtx?.userName || null }, (data) => {
      const moved = Number(data?.moved_qty) || 0;
      if (moved > 0) {
        return `Area at ${m.name}: ${name}. ${packQtyWords(toPackQty(moved, m.countPack), m.countPack, item.base_unit)} moved with it.`;
      }
      return `Area at ${m.name}: ${name}.`;
    }, `${m.siteId}|area`);
  };
  const commitCounted = (m, on) => saveSite(m, { counted_here: !!on }, `Counted here at ${m.name}: ${on ? 'yes' : 'no'}.`, `${m.siteId}|counted`);

  // ── purchased or made, sold directly (company: stock_save_item with the item's version) ──
  const saveHow = async (m, site, okWords, key) => {
    setBusy(key);
    setRowError(m.siteId, null);
    const r = await stockApi.saveItem({ item: { id: item.id, location_id: m.siteId, site }, version: detail?.row_version ?? item.row_version ?? null });
    setBusy(null);
    if (r.error) { setRowError(m.siteId, r.error.message); if (!r.conflict) say(r.error.message, 'error'); await reload?.(); return; }
    flash(key);
    say(withQueue(okWords, r));
    await reload?.();
  };
  const commitKind = (m, kind) => {
    if ((kind === 'MADE') === m.made) return;
    saveHow(m, { kind }, kind === 'MADE' ? `${item.name} is made here at ${m.name} now.` : `${item.name} is purchased at ${m.name} now.`, `${m.siteId}|kind`);
  };
  const commitSellable = (m, on) => saveHow(m, { is_sellable: !!on }, `Sold directly at ${m.name}: ${on ? 'yes' : 'no'}.`, `${m.siteId}|sellable`);
  const commitPause = (m, { paused, from = null, until = null }) => saveSite(m,
    paused ? { paused: true, paused_from: from || null, paused_until: until || null } : { paused: false, paused_from: null, paused_until: null },
    paused ? `${pauseWords({ siteName: m.name, until })}.` : `No longer paused at ${m.name}.`, `${m.siteId}|paused`);

  // ── the top buttons (company editors) ──
  const addToAll = async () => {
    const add = models.filter((m) => !m.on && m.canPrice).map((m) => m.siteId);
    if (!add.length) { say(`${item.name} is already at every site.`, 'info'); return; }
    setBusy('all');
    const r = await stockApi.setItemSites({ items: [item.id], add });
    setBusy(null);
    if (r.error) { say(r.error.message, 'error'); await reload?.(); return; }
    const refused = r.data?.refused || [];
    if (refused.length) say(refused.map((x) => x.error).join(' '), 'error');
    else say(withQueue(`${item.name} is now at every site.`, r));
    await reload?.();
  };

  const onSites = models.filter((m) => m.on);
  const lockKind = sc.level === 'sites_full' ? 'sites_full' : 'sites';
  const areaOptions = (m) => {
    const list = areasBySite[m.siteId];
    if (Array.isArray(list)) return list;
    return m.areaId ? [{ id: m.areaId, name: m.areaName || 'This area' }] : [];
  };

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 12 }}>
      {companyEditor ? (
        <div style={{ ...ui.row, flexWrap: 'wrap' }}>
          <Btn small kind="soft" disabled={!onSites.length || !!busy} onClick={() => setBulk('par')}>Set par for all ticked sites</Btn>
          <Btn small kind="soft" disabled={!!busy || !!item.archived_at} onClick={addToAll}>{busy === 'all' ? 'Adding…' : 'Add to all sites'}</Btn>
          <Btn small kind="soft" disabled={onSites.length < 2 || !!busy} onClick={() => setBulk('copy')}>Copy from a site</Btn>
        </div>
      ) : (
        <LockLine kind={lockKind} entity="item" id={item.id} recordName={item.name} />
      )}

      <TableWrap minWidth={1600}>
        <thead>
          <tr>
            <Th>On</Th>
            <Th>Site</Th>
            <Th>Supplier here</Th>
            <Th hint={HINTS.price}>Price here</Th>
            <Th hint={HINTS.cost}>Cost here</Th>
            <Th hint={HINTS.last}>Last paid</Th>
            <Th hint={HINTS.par}>Par</Th>
            <Th>Reorder at</Th>
            <Th>Min</Th>
            <Th right>On hand</Th>
            <Th>Area</Th>
            <Th>Counted here</Th>
            <Th hint="Purchased from a supplier, or made here from other items. Sold directly: also sold as it is.">Purchased or made</Th>
            <Th>Paused</Th>
          </tr>
        </thead>
        <tbody>
          {models.map((m) => {
            const focus = focusSiteId && focusSiteId === m.siteId;
            const rowStyle = focus ? { background: 'var(--bg2)', boxShadow: 'inset 3px 0 0 var(--acc)' } : undefined;
            const canTick = m.canPrice && !item.archived_at;
            const err = errors[m.siteId];
            const tick = (
              <input type="checkbox" checked={m.on} disabled={!canTick || busy === `${m.siteId}|on`}
                aria-label={m.on ? `Stocked at ${m.name}` : `Stock at ${m.name}`}
                onChange={(e) => { if (e.target.checked) tickOn(m); else askUntick(m); }} />
            );
            if (!m.on) {
              return (
                <Fragment key={m.siteId}>
                <tr ref={(el) => { rowRefs.current[m.siteId] = el; }} style={rowStyle}>
                  <td style={tdStyle}>{tick}</td>
                  <td style={{ ...tdStyle, ...grey }}>{m.name}</td>
                  <td style={{ ...tdStyle, ...grey }} colSpan={COLS - 2}>
                    {busy === `${m.siteId}|on` ? 'Adding…' : "Not stocked here. Tick to add it: the site's row is made at once with on hand 0."}
                  </td>
                </tr>
                {err && <tr><td colSpan={COLS} style={{ ...tdStyle, ...ui.err, paddingTop: 0 }}>{err}</td></tr>}
                </Fragment>
              );
            }
            const priceKey = `${m.siteId}|price`;
            return (
              <Fragment key={m.siteId}>
              <tr ref={(el) => { rowRefs.current[m.siteId] = el; }} style={rowStyle}>
                <td style={tdStyle}>{tick}</td>
                <td style={{ ...tdStyle, minWidth: 150 }}>
                  <div style={{ fontWeight: 700, color: 'var(--t1)' }}>{m.name}</div>
                  {m.why && <div style={{ fontSize: 11.5, color: 'var(--blu, var(--t3))', marginTop: 2 }}>{m.why}</div>}
                  {(m.runningOut || m.paused) && (
                    <div style={{ ...ui.row, gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
                      {m.runningOut && <Pill tone="neutral">Running out</Pill>}
                      {m.runningOut && canTick && <Btn small kind="link" disabled={!!busy} onClick={() => tickOn(m)}>Order it again</Btn>}
                      {m.paused && <Pill tone="warn" title={pauseWords({ siteName: m.name, until: m.pausedUntil })}>Paused</Pill>}
                    </div>
                  )}
                </td>
                <td style={tdStyle}>
                  {m.supplierChoices.length ? (
                    <select aria-label={`Supplier here at ${m.name}`} value={m.supplierUsedId || ''} disabled={!m.canPrice || !!busy}
                      onChange={(e) => commitSupplier(m, e.target.value)} style={{ ...selectStyle, opacity: m.canPrice ? 1 : 0.55 }}>
                      {!m.supplierUsedId && <option value="">Pick a supplier</option>}
                      {m.supplierChoices.map((c) => (
                        <option key={c.id} value={c.id}>{c.name}{c.id === m.mainId ? ' (main)' : ''}{c.cannotOrder ? ' (cannot deliver here)' : ''}</option>
                      ))}
                    </select>
                  ) : <span style={grey}>No supplier yet</span>}
                  {savedKey === `${m.siteId}|supplier` && <SavedTick />}
                </td>
                <td style={tdStyle}>
                  {m.hasSupplier ? (
                    <>
                      <div style={{ ...ui.row, gap: 6 }}>
                        <CellInput value={m.packNow} follow={m.follows} width={84} places={2} ariaLabel={`Price here at ${m.name}`}
                          disabled={!m.canPrice || busy === priceKey} onCommit={(v) => commitPrice(m, v)} />
                        {!m.follows && m.canPrice && <Btn small kind="ghost" disabled={busy === priceKey} onClick={() => resetPrice(m)}>Reset</Btn>}
                      </div>
                      <div style={small}>{busy === priceKey ? 'Saving…' : (packPrice(m.unitPrice, m.countPack, m.currency) || (m.packDescription ? `for ${m.packDescription}` : ''))}</div>
                    </>
                  ) : <span style={grey}>No price</span>}
                </td>
                <td style={{ ...tdStyle, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                  {m.costUnit != null ? packPrice(m.costUnit, m.countPack, m.currency) : <span style={grey}>None</span>}
                </td>
                <td style={{ ...tdStyle, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                  {m.lastPaid ? lastPaidWords(m.lastPaid, m.currency, tz) : <span style={grey}>None</span>}
                </td>
                {['par', 'reorder', 'min'].map((k) => (
                  <td key={k} style={{ ...tdStyle, whiteSpace: 'nowrap' }}>
                    <CellInput value={m[k]} width={60} ariaLabel={`${k === 'par' ? 'Par' : k === 'reorder' ? 'Reorder at' : 'Min'} at ${m.name}`}
                      disabled={!m.canFacts || busy === `${m.siteId}|${k}`} onCommit={(v) => commitPar(m, k, v)} />
                    <span style={unitWord}>{packWordFor(m[k] ?? 2, m.countPack, item.base_unit)}</span>
                    {k === 'par' && m.canFacts && <Btn small kind="link" onClick={() => setByDay(m)} title={`Par by day of the week, or days of cover, at ${m.name}`}>By day</Btn>}
                    {k === 'par' && byDay?.siteId === m.siteId && (() => { const row = (detail?.sites || []).find((x) => x.location_id === m.siteId) || {}; return <ParByWeekdayPopover item={item} site={{ siteId: m.siteId, name: m.name, parByWeekday: row.par_by_weekday || null, coverDays: row.cover_days ?? null, unit: item.base_unit }} onSave={(patch) => saveSite(m, patch, `Par by day saved for ${m.name}.`, `${m.siteId}|par`)} onClose={() => setByDay(null)} />; })()}
                  </td>
                ))}
                <td style={{ ...tdStyle, textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <Btn small kind="link" onClick={() => setStockFor(m)} title={`Open the stock of ${item.name} at ${m.name}`}>{onHandWords(m, item.base_unit)}</Btn>
                </td>
                <td style={tdStyle}>
                  <select aria-label={`Area at ${m.name}`} value={m.areaId || ''} disabled={!m.canFacts || !!busy}
                    onFocus={() => loadAreas(m.siteId)} onMouseDown={() => loadAreas(m.siteId)}
                    onChange={(e) => commitArea(m, e.target.value)} style={{ ...selectStyle, maxWidth: 150, opacity: m.canFacts ? 1 : 0.55 }}>
                    <option value="">No area</option>
                    {areaOptions(m).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                    {areasBySite[m.siteId] === 'loading' && <option value="" disabled>Loading…</option>}
                  </select>
                  {savedKey === `${m.siteId}|area` && <SavedTick />}
                </td>
                <td style={tdStyle}>
                  <input type="checkbox" checked={m.countedHere} disabled={!m.canFacts || !!busy} aria-label={`Counted here at ${m.name}`}
                    onChange={(e) => commitCounted(m, e.target.checked)} />
                  {savedKey === `${m.siteId}|counted` && <SavedTick />}
                </td>
                <td style={{ ...tdStyle, whiteSpace: 'nowrap' }}>
                  <select aria-label={`Purchased or made at ${m.name}`} value={m.made ? 'MADE' : 'PURCHASED'} disabled={!companyEditor || !!item.archived_at || !!busy}
                    onChange={(e) => commitKind(m, e.target.value)} style={{ ...selectStyle, opacity: companyEditor ? 1 : 0.55 }}>
                    {KIND_CHOICES.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
                  </select>
                  {savedKey === `${m.siteId}|kind` && <SavedTick />}
                  <label style={{ ...ui.row, gap: 5, marginTop: 5, fontSize: 12, color: 'var(--t3)', opacity: companyEditor ? 1 : 0.55 }}>
                    <input type="checkbox" checked={m.sellable} disabled={!companyEditor || !!item.archived_at || !!busy} aria-label={`Sold directly at ${m.name}`}
                      onChange={(e) => commitSellable(m, e.target.checked)} />
                    Sold directly
                    {savedKey === `${m.siteId}|sellable` && <SavedTick />}
                  </label>
                </td>
                <td style={{ ...tdStyle, whiteSpace: 'nowrap' }}>
                  <div style={{ ...ui.row, gap: 6 }}>
                    <input type="checkbox" checked={m.paused} disabled={!m.canPrice || !!busy} aria-label={`Paused at ${m.name}`}
                      onChange={(e) => commitPause(m, { paused: e.target.checked })} />
                    <Popover label={m.paused && m.pausedUntil ? pauseWords({ until: m.pausedUntil }).replace(/^Paused /, '') : 'Dates'} disabled={!m.canPrice || !!busy} width={260} ariaLabel={`Pause dates at ${m.name}`}>
                      {(close) => <PauseDates model={m} onSave={async (v) => { const r = await commitPause(m, v); if (r === true) close(); }} />}
                    </Popover>
                    {savedKey === `${m.siteId}|paused` && <SavedTick />}
                  </div>
                </td>
              </tr>
              {err && <tr><td colSpan={COLS} style={{ ...tdStyle, ...ui.err, paddingTop: 0 }}>{err}</td></tr>}
              </Fragment>
            );
          })}
        </tbody>
      </TableWrap>

      {companyEditor && <div style={ui.sub}>Untick a site to see the two choices. Set a price at one site and only that site's cost moves.</div>}

      {untick && (
        <UntickChoiceModal itemName={item.name} siteName={untick.model.name} holds={untick.holds} usedBy={untick.usedBy}
          busy={busy === `${untick.model.siteId}|on`} onRunOut={() => untickRun('runout')} onRemoveNow={() => untickRun('remove')}
          onClose={() => setUntick(null)} />
      )}

      {stockFor && (
        <StockPanel detail={detail} model={stockFor} loadAreas={loadAreas} onClose={() => setStockFor(null)} onChanged={() => reload?.()} showToast={showToast} />
      )}

      {bulk === 'par' && (
        <SetParAll item={item} models={onSites.filter((m) => m.canFacts)} groups={sc.groups} onClose={() => setBulk(null)}
          onDone={async (words, tone) => { setBulk(null); say(words, tone); await reload?.(); }} />
      )}
      {bulk === 'copy' && (
        <CopyFromSite item={item} models={onSites.filter((m) => m.canFacts)} groups={sc.groups} byName={orgCtx?.userName || null}
          onClose={() => setBulk(null)} onDone={async (words, tone) => { setBulk(null); say(words, tone); await reload?.(); }} />
      )}
    </div>
  );
}

/** The paused dates of one site, in a small pop up: From, Until (empty = until you unpause). */
function PauseDates({ model, onSave }) {
  const [from, setFrom] = useState(model.pausedFrom || '');
  const [until, setUntil] = useState(model.pausedUntil || '');
  const [busy, setBusy] = useState(false);
  const bad = from && until && until < from;
  const save = async (paused) => { setBusy(true); await onSave(paused ? { paused: true, from: from || null, until: until || null } : { paused: false }); setBusy(false); };
  return (
    <div>
      <div style={{ fontSize: 13.5, fontWeight: 800, marginBottom: 8 }}>Pause at {model.name}</div>
      <Field label="From"><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={ui.input} /></Field>
      <Field label="Until" hint="Empty = until you unpause."><input type="date" value={until} onChange={(e) => setUntil(e.target.value)} style={ui.input} /></Field>
      {bad && <div style={{ ...ui.err, marginBottom: 8 }}>Until must be on or after From.</div>}
      <div style={{ ...ui.row, justifyContent: 'flex-end' }}>
        {model.paused && <Btn small onClick={() => save(false)} disabled={busy}>Unpause</Btn>}
        <Btn small kind="primary" onClick={() => save(true)} disabled={busy || !!bad}>{busy ? 'Saving…' : 'Pause'}</Btn>
      </div>
    </div>
  );
}

/** Today's Stock tab for one site, in a side panel: set a count, the holdings by area, every movement. */
function StockPanel({ detail, model, loadAreas, onClose, onChanged, showToast }) {
  const [areas, setAreas] = useState(null);
  const [holdings, setHoldings] = useState({});
  const draft = useMemo(() => siteDraftOf(detail, model.siteId), [detail, model.siteId]);
  useEffect(() => {
    let live = true;
    (async () => {
      const [list, hold] = await Promise.all([
        loadAreas(model.siteId),
        draft?.id ? fetchItemAreaHoldings(draft.id, model.siteId) : Promise.resolve({ data: {} }),
      ]);
      if (!live) return;
      setAreas(Array.isArray(list) ? list : []);
      setHoldings(hold?.data || {});
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model.siteId, draft?.id, draft?.onHand]);
  return (
    <Sheet title={`${detail?.item?.name || 'Item'} at ${model.name}`} sub="Set a count, see where it sits and every movement." onClose={onClose} width={860}>
      {draft
        ? <StockTab draft={draft} locId={model.siteId} onChanged={onChanged} showToast={showToast} areas={areas} holdings={holdings} currency={model.currency} />
        : <div style={ui.sub}>This site has no row for the item yet.</div>}
    </Sheet>
  );
}

/** Set par for all ticked sites: one par, reorder and min for every site it is on (empty = keep). */
function SetParAll({ item, models, groups, onClose, onDone }) {
  const [ids, setIds] = useState(models.map((m) => m.siteId));
  const [vals, setVals] = useState({ par: '', reorder: '', min: '' });
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState([]);
  const unit = models[0] ? packWordFor(2, models[0].countPack, item.base_unit) : '';
  const typed = Object.fromEntries(Object.entries(vals).filter(([, v]) => String(v).trim() !== ''));
  const picked = models.filter((m) => ids.includes(m.siteId));
  const run = async () => {
    const plans = picked.map((m) => ({ m, patch: parPatchFor(m, typed) }));
    if (plans.some((p) => p.patch === undefined)) { setProblems([`Type a number of ${unit}, or leave a box empty to keep each site's own.`]); return; }
    setBusy(true);
    const answers = await runFour(plans.map(({ m, patch }) => () => stockApi.saveItemSite(item.id, m.siteId, patch, m.rowVersion)));
    setBusy(false);
    const bad = answers.map((r, i) => (r?.error ? `${plans[i].m.name}: ${r.error.message}` : null)).filter(Boolean);
    const ok = answers.length - bad.length;
    if (bad.length) { setProblems(bad); if (ok) onDone(`Par saved for ${ok} site${ok === 1 ? '' : 's'}. ${bad.length} did not save.`, 'warning'); return; }
    onDone(ok === 1 ? `Par saved for ${plans[0].m.name}.` : `Par saved for ${ok} sites.`, 'success');
  };
  return (
    <Modal title="Set par for all ticked sites" sub={`Type one par, reorder and min in ${unit}. An empty box keeps each site's own.`} onClose={busy ? () => {} : onClose} width={560}
      dirty={Object.keys(typed).length > 0 && !busy}
      footer={<><span style={{ flex: 1 }} /><Btn onClick={onClose} disabled={busy}>Cancel</Btn><Btn kind="primary" onClick={run} disabled={busy || !picked.length || !Object.keys(typed).length}>{busy ? 'Saving…' : 'Save'}</Btn></>}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12 }}>
        {[['par', 'Par'], ['reorder', 'Reorder at'], ['min', 'Min']].map(([k, label]) => (
          <Field key={k} label={label}><input type="number" min="0" step="any" value={vals[k]} onChange={(e) => setVals((v) => ({ ...v, [k]: e.target.value }))} style={ui.input} /></Field>
        ))}
      </div>
      <Field label="Sites">
        <SiteChecklist sites={models.map((m) => ({ id: m.siteId, name: m.name }))} value={ids} onChange={setIds}
          groups={(groups || []).map((g) => ({ id: g.id, name: g.name, location_ids: g.locationIds || g.location_ids || [] }))} />
      </Field>
      {problems.length > 0 && <Notice tone="bad">{problems.map((p) => <div key={p}>{p}</div>)}</Notice>}
    </Modal>
  );
}

/** Copy from a site: its par, reorder at, min and area to the other sites (an area matched by name). */
function CopyFromSite({ item, models, groups, byName, onClose, onDone }) {
  const [fromId, setFromId] = useState(models[0]?.siteId || '');
  const others = models.filter((m) => m.siteId !== fromId);
  const [ids, setIds] = useState(others.map((m) => m.siteId));
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState([]);
  const source = models.find((m) => m.siteId === fromId) || null;
  const targets = others.filter((m) => ids.includes(m.siteId));
  const run = async () => {
    if (!source || !targets.length) return;
    setBusy(true);
    let sourceArea = null;
    if (source.areaId) {
      const r = await stockApi.siteAreas(source.siteId);
      sourceArea = (r.data || []).find((a) => a.id === source.areaId) || null;
    }
    const answers = await runFour(targets.map((m) => async () => {
      const patch = { ...source.parBase };
      if (sourceArea) {
        const r = await stockApi.siteAreas(m.siteId);
        const match = (r.data || []).find((a) => String(a.name || '').trim().toLowerCase() === String(sourceArea.name || '').trim().toLowerCase());
        if (match && match.id !== m.areaId) Object.assign(patch, { area_id: match.id, move_holding: true, by_name: byName });
      }
      return stockApi.saveItemSite(item.id, m.siteId, patch, m.rowVersion);
    }));
    setBusy(false);
    const bad = answers.map((r, i) => (r?.error ? `${targets[i].name}: ${r.error.message}` : null)).filter(Boolean);
    const ok = answers.length - bad.length;
    if (bad.length) { setProblems(bad); if (ok) onDone(`Copied from ${source.name} to ${ok} site${ok === 1 ? '' : 's'}. ${bad.length} did not save.`, 'warning'); return; }
    onDone(`Copied from ${source.name} to ${ok} site${ok === 1 ? '' : 's'}.`, 'success');
  };
  return (
    <Modal title="Copy from a site" sub="Copies par, reorder at, min and area from the site you pick. An area is matched by its name at each site." onClose={busy ? () => {} : onClose} width={560}
      footer={<><span style={{ flex: 1 }} /><Btn onClick={onClose} disabled={busy}>Cancel</Btn><Btn kind="primary" onClick={run} disabled={busy || !source || !targets.length}>{busy ? 'Copying…' : 'Copy'}</Btn></>}>
      <Field label="Copy from">
        <select value={fromId} onChange={(e) => { const v = e.target.value; setFromId(v); setIds(models.filter((m) => m.siteId !== v).map((m) => m.siteId)); }} style={ui.input}>
          {models.map((m) => <option key={m.siteId} value={m.siteId}>{m.name}</option>)}
        </select>
      </Field>
      <Field label="To">
        <SiteChecklist sites={others.map((m) => ({ id: m.siteId, name: m.name }))} value={ids} onChange={setIds}
          groups={(groups || []).map((g) => ({ id: g.id, name: g.name, location_ids: g.locationIds || g.location_ids || [] }))} />
      </Field>
      {problems.length > 0 && <Notice tone="bad">{problems.map((p) => <div key={p}>{p}</div>)}</Notice>}
    </Modal>
  );
}

