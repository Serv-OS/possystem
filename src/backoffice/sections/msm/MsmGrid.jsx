// src/backoffice/sections/msm/MsmGrid.jsx
//
// MULTI SITE MENU (v5.11.75): the grid, the main screen. Products down the side grouped by
// category, sites across the top, the group price first. Each cell is the price at that site and
// its on or off switch. Grey = follows the group price; full colour = that site's own price; an
// amber mark = changed in the draft (not live until published).
//
// Spreadsheet keys: arrows (or Tab) move, Enter or typing edits, Enter saves and moves down, Esc
// cancels, Space turns a product on or off at that site, Delete puts the site back on the group
// price, and pasting a column from a spreadsheet fills the prices down from the cell.
// Only the rows on screen are drawn (lib/msm/msmGrid.js visibleRange), so 1,000 products by 20
// sites scrolls smoothly.
//
// Every edit is staged through `stage` (MultiSiteMenu.jsx): nothing shows as changed before the
// database has it.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ROW_H, NO_CATEGORY, SHOW_FILTERS, CHANNEL_LABELS, channelLabel, buildGridRows, cellFor, cellStaged, categoryTree,
  visibleRange, priceInput, parsePastedColumn, price2, moveFocus, defaultFor,
} from '../../../lib/msm/msmGrid';
import { sitePriceChange, siteActiveChange, defaultPriceChange, activeMany, priceMany, copyPricesMany, moveMany, pasteColumn } from '../../../lib/msm/msmEdit';
import { marginFor } from '../../../lib/msm/msmMargin';
import { Btn, Pill, Switch, Segmented, Popover, SiteChecklist } from './msmUi';
import { ui, money } from './msmStyle';

const NAME_W = 300;
const DEF_W = 116;
const SITE_W = 132;
const HEAD_H = 46;

export default function MsmGrid({ ix, live, sites, staged, ctx, stage, editable, canEdit, costs, channel, setChannel, setNote, onOpenProduct, onAddProduct, onChangePrices, extraTools = null }) {
  const [search, setSearch] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [show, setShow] = useState('all');
  const [mode, setMode] = useState('prices');
  const [shownSites, setShownSites] = useState(() => sites.map((s) => s.id));
  const [collapsed, setCollapsed] = useState(() => new Set());
  const [selected, setSelected] = useState(() => new Set());
  const [focus, setFocus] = useState(null);       // { row, col } col 0 = group price, 1.. = sites
  const [editing, setEditingState] = useState(null);   // { row, col, text, words }
  // The edit as it is right now, for keys typed before the edit box has appeared (a fast typist
  // starting on the grid: "3", ".", "6" can all land before React draws the box).
  const editingRef = useRef(null);
  const setEditing = useCallback((v) => {
    const next = typeof v === 'function' ? v(editingRef.current) : v;
    editingRef.current = next;
    setEditingState(next);
  }, []);
  const [pending, setPending] = useState(() => new Set());
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(600);
  const scroller = useRef(null);
  const groups = live?.siteGroups || [];

  useEffect(() => { setShownSites((cur) => { const known = new Set(sites.map((s) => s.id)); const kept = cur.filter((id) => known.has(id)); return kept.length ? kept : sites.map((s) => s.id); }); }, [sites]);
  const cols = useMemo(() => sites.filter((s) => shownSites.includes(s.id)), [sites, shownSites]);
  const tree = useMemo(() => categoryTree(ix), [ix]);

  const { rows, products } = useMemo(() => buildGridRows(ix, {
    search, categoryId: categoryId || null, show, siteIds: cols.map((c) => c.id), staged, collapsed, channel,
  }), [ix, search, categoryId, show, cols, staged, collapsed, channel]);

  useEffect(() => { if (mode === 'gp') costs.load(cols.map((c) => c.id)); }, [mode, cols, costs]);

  // Viewport height for the windowed rows.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return undefined;
    const measure = () => setViewH(el.clientHeight || 600);
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const { start, end } = visibleRange(scrollTop, viewH - HEAD_H, rows.length, ROW_H);

  // Keep the focused cell on screen.
  useEffect(() => {
    if (!focus || !scroller.current) return;
    const el = scroller.current;
    const top = focus.row * ROW_H;
    const bottom = top + ROW_H;
    const viewTop = el.scrollTop;
    const viewBottom = el.scrollTop + el.clientHeight - HEAD_H;
    if (top < viewTop) el.scrollTop = top;
    else if (bottom > viewBottom) el.scrollTop = bottom - (el.clientHeight - HEAD_H);
  }, [focus]);

  // ── Writes ─────────────────────────────────────────────────────────────
  const run = useCallback(async (keys, changes, done) => {
    const list = (changes || []).filter(Boolean);
    if (!list.length) return;
    setPending((p) => { const s = new Set(p); keys.forEach((k) => s.add(k)); return s; });
    try { await stage(list, { done }); }
    finally { setPending((p) => { const s = new Set(p); keys.forEach((k) => s.delete(k)); return s; }); }
  }, [stage]);

  const colLoc = (col) => (col === 0 ? null : cols[col - 1]?.id || null);
  const productAt = (row) => (rows[row] && rows[row].kind === 'product' ? rows[row].product : null);

  // One commit per edit: Enter or Tab commits, and the blur that follows when the box goes away
  // must not commit the same edit again.
  const committed = useRef(null);
  const commitEdit = useCallback(async (ed, nextKey) => {
    if (committed.current === ed) return;
    committed.current = ed;
    if (nextKey === 'Cancel') { setEditing(null); scroller.current?.focus({ preventScroll: true }); return; }
    const p = productAt(ed.row);
    if (!p) { setEditing(null); return; }
    const parsed = priceInput(ed.text);
    if (!parsed.ok) { committed.current = null; setEditing({ ...ed, words: parsed.words }); return; }
    const loc = colLoc(ed.col);
    const r = loc ? sitePriceChange(ctx, p.id, loc, parsed.value, channel) : defaultPriceChange(ctx, p.id, parsed.value, channel);
    if (r.words) { committed.current = null; setEditing({ ...ed, words: r.words }); return; }
    setEditing(null);
    if (nextKey) { setFocus((f) => moveFocus(rows, cols.length + 1, f || ed, nextKey)); scroller.current?.focus({ preventScroll: true }); }
    if (r.change) await run([`${p.id}|${loc || 'default'}`], [r.change]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx, channel, rows, cols, run]);

  const toggle = useCallback((p, loc, on) => {
    if (!editable) return;
    const r = siteActiveChange(ctx, p.id, loc, on);
    if (r.words) { setNote?.({ tone: 'warn', text: r.words }); return; }
    run([`${p.id}|${loc}`], [r.change]);
  }, [ctx, editable, run, setNote]);

  const onKeyDown = (e) => {
    if (editingRef.current && e.target === e.currentTarget) {
      // An edit has just started and its box is not on screen yet: these keys belong to it.
      const ed = editingRef.current;
      if (e.key.length === 1 && /^[0-9.£$€,]$/.test(e.key)) { e.preventDefault(); setEditing({ ...ed, text: ed.text + e.key }); }
      else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); commitEdit(ed, e.key === 'Tab' && e.shiftKey ? 'ShiftTab' : e.key); }
      else if (e.key === 'Escape') { e.preventDefault(); commitEdit(ed, 'Cancel'); }
      else if (e.key === 'Backspace') { e.preventDefault(); setEditing({ ...ed, text: ed.text.slice(0, -1) }); }
      return;
    }
    if (editing || !focus) return;
    const p = productAt(focus.row);
    const loc = colLoc(focus.col);
    if (['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(e.key) || e.key === 'Tab') {
      e.preventDefault();
      setFocus(moveFocus(rows, cols.length + 1, focus, e.key === 'Tab' && e.shiftKey ? 'ShiftTab' : e.key));
      return;
    }
    if (!p || !editable) return;
    if (e.key === 'Enter' || e.key === 'F2') {
      e.preventDefault();
      const c = loc ? cellFor(ix, p, loc, channel) : null;
      if (loc && !c.exists) return;
      setEditing({ ...focus, text: price2(loc ? (c.own ?? c.price) : defaultFor(p, channel)), select: true });
    } else if (/^[0-9.]$/.test(e.key)) {
      e.preventDefault();
      if (loc && !cellFor(ix, p, loc, channel).exists) return;
      setEditing({ ...focus, text: e.key });
    } else if (e.key === ' ' && loc) {
      e.preventDefault();
      const c = cellFor(ix, p, loc, channel);
      toggle(p, loc, !(c.exists && c.active));
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && loc) {
      e.preventDefault();
      const r = sitePriceChange(ctx, p.id, loc, null, channel);
      if (r.change) run([`${p.id}|${loc}`], [r.change]);
    } else if (e.key === 'Escape') setFocus(null);
  };

  const onPaste = (e) => {
    if (!focus || !editable) return;
    const text = e.clipboardData?.getData('text') || '';
    if (!text.includes('\n') && editing) return;      // one value into the open cell: the input takes it
    e.preventDefault();
    const values = parsePastedColumn(text);
    const loc = colLoc(focus.col);
    const cells = [];
    let r = focus.row;
    for (const v of values) {
      while (r < rows.length && rows[r].kind !== 'product') r++;
      if (r >= rows.length) break;
      if (v.value != null) cells.push({ productId: rows[r].product.id, value: v.value });
      r++;
    }
    const bad = values.filter((v) => v.invalid).length;
    const res = pasteColumn(ctx, cells, loc, channel);
    setEditing(null);
    run(cells.map((c) => `${c.productId}|${loc || 'default'}`), res.changes,
      `${res.changes.length} price${res.changes.length === 1 ? '' : 's'} pasted${bad ? `; ${bad} line${bad === 1 ? ' was' : 's were'} not a price and ${bad === 1 ? 'was' : 'were'} skipped` : ''}.`);
  };

  // ── Selection ──────────────────────────────────────────────────────────
  const productRows = rows.filter((r) => r.kind === 'product');
  const allSelected = productRows.length > 0 && productRows.every((r) => selected.has(r.id));
  const toggleSel = (id) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const selIds = [...selected].filter((id) => ix.products.has(id));

  const totalW = NAME_W + DEF_W + cols.length * SITE_W;
  const gpOn = mode === 'gp';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0 }}>
      {/* Toolbar */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input aria-label="Search products" style={{ ...ui.input, width: 220 }} placeholder="Search products" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select aria-label="Category" style={{ ...ui.input, width: 190 }} value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
          <option value="">Every category</option>
          {tree.map((t) => <option key={t.id} value={t.id}>{'  '.repeat(t.depth)}{t.label}</option>)}
        </select>
        <select aria-label="Show" style={{ ...ui.input, width: 190 }} value={show} onChange={(e) => setShow(e.target.value)}>
          {SHOW_FILTERS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
        </select>
        <select aria-label="Prices for" title="Which price the grid shows" style={{ ...ui.input, width: 160 }} value={channel || ''} onChange={(e) => setChannel(e.target.value || null)}>
          <option value="">Prices: In store</option>
          {Object.entries(CHANNEL_LABELS).map(([k, l]) => <option key={k} value={k}>Prices: {l}</option>)}
        </select>
        <Segmented small value={mode} onChange={setMode} options={[{ value: 'prices', label: 'Prices' }, { value: 'gp', label: 'Show GP', title: 'Cost and gross profit from each site\'s own recipes' }]} />
        <Popover label={`Sites (${cols.length}/${sites.length})`} width={260}>
          <SiteChecklist sites={sites} value={shownSites} groups={groups} onChange={(v) => setShownSites(v.length ? v : shownSites)} />
        </Popover>
        <div style={{ flex: 1 }} />
        {extraTools}
        {canEdit && (
          <>
            <Btn small kind="soft" disabled={!editable} onClick={() => onAddProduct(null)}>Add product</Btn>
            <Popover label="Add site only extra" align="right" disabled={!editable} width={240}>
              {(close) => (
                <div>
                  <div style={{ ...ui.sub, marginBottom: 8 }}>A product sold at one site only. Which site?</div>
                  {sites.map((s) => <div key={s.id}><Btn small kind="link" onClick={() => { close(); onAddProduct(s.id); }}>{s.name}</Btn></div>)}
                </div>
              )}
            </Popover>
            <Btn small kind="primary" disabled={!editable} onClick={() => onChangePrices({ all: true })}>Change prices</Btn>
          </>
        )}
      </div>

      {/* Bulk bar */}
      {selIds.length > 0 && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', padding: '8px 12px', borderRadius: 12, background: 'var(--acc-d)', border: '1px solid var(--acc-b, var(--bdr))' }}>
          <strong style={{ fontSize: 13 }}>{selIds.length} selected</strong>
          {editable && (
            <>
              <Btn small kind="primary" onClick={() => onChangePrices({ productIds: selIds })}>Change prices</Btn>
              <SetPricePopover sites={sites} groups={groups} channel={channel} onApply={(value, locs) => { const r = priceMany(ctx, selIds, locs, value, channel); run(selIds.map((id) => `${id}|x`), r.changes, `${r.changes.length} price${r.changes.length === 1 ? '' : 's'} set.`); }} />
              <SitesActionPopover label="Turn on at" sites={sites} groups={groups} button="Turn on" onApply={(locs) => { const r = activeMany(ctx, selIds, locs, true); run([], r.changes, `${r.changes.length} turned on.${r.words.length ? ` ${r.words[0]}` : ''}`); }} />
              <SitesActionPopover label="Turn off at" sites={sites} groups={groups} button="Turn off" onApply={(locs) => { const r = activeMany(ctx, selIds, locs, false); run([], r.changes, `${r.changes.length} turned off.`); }} />
              <CopyPricesPopover sites={sites} groups={groups} onApply={(from, to) => { const r = copyPricesMany(ctx, selIds, from, to, channel); run([], r.changes, `${r.changes.length} price${r.changes.length === 1 ? '' : 's'} copied.`); }} />
              <Popover label="Move to" width={260}>
                {(close) => (
                  <div style={{ maxHeight: 260, overflowY: 'auto' }}>
                    {tree.map((t) => (
                      <div key={t.id}><Btn small kind="link" style={{ paddingLeft: 6 + t.depth * 12 }} onClick={() => { close(); const r = moveMany(ctx, selIds, t.id); run([], r.changes, `${r.changes.length} moved to ${t.label}.`); }}>{t.label}</Btn></div>
                    ))}
                  </div>
                )}
              </Popover>
            </>
          )}
          <Btn small onClick={() => setSelected(new Set())}>Clear</Btn>
        </div>
      )}

      {/* The grid */}
      <div ref={scroller} tabIndex={0} role="grid" aria-label="Group menu prices" aria-rowcount={rows.length}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)} onKeyDown={onKeyDown} onPaste={onPaste}
        style={{ position: 'relative', overflow: 'auto', height: 'calc(100vh - 300px)', minHeight: 380, border: '1px solid var(--bdr)', borderRadius: 14, background: 'var(--bg1)', outline: 'none' }}>
        <div style={{ width: totalW, minWidth: '100%', position: 'relative' }}>
          {/* Header */}
          <div role="row" style={{ position: 'sticky', top: 0, zIndex: 4, display: 'flex', height: HEAD_H, background: 'var(--bg2)', borderBottom: '1px solid var(--bdr2)' }}>
            <div style={{ ...headCell, width: NAME_W, position: 'sticky', left: 0, zIndex: 5, background: 'var(--bg2)', flexDirection: 'row', justifyContent: 'flex-start', gap: 10, paddingLeft: 12 }}>
              <input type="checkbox" aria-label="Select every product shown" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(productRows.map((r) => r.id)))} />
              <span>Product <span style={{ color: 'var(--t4)', fontWeight: 600 }}>({products})</span></span>
            </div>
            <div style={{ ...headCell, width: DEF_W }} title="The price every site follows unless it has its own">Group price<br /><span style={{ fontWeight: 500, color: 'var(--t4)' }}>{channelLabel(channel)}</span></div>
            {cols.map((s) => (
              <div key={s.id} style={{ ...headCell, width: SITE_W }} title={s.name}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: SITE_W - 16 }}>{s.name}</span>
                {gpOn && costs.status[s.id] === 'loading' && <span style={{ fontWeight: 500, color: 'var(--t4)' }}>costing…</span>}
                {gpOn && costs.status[s.id] === 'failed' && <span style={{ fontWeight: 500, color: 'var(--red)' }}>costs not read</span>}
              </div>
            ))}
          </div>
          {/* Rows: only those on screen */}
          <div style={{ height: start * ROW_H }} />
          {rows.slice(start, end).map((r, i) => {
            const rowIndex = start + i;
            if (r.kind === 'cat') {
              return (
                <div key={`c:${r.id}`} role="row" style={{ display: 'flex', height: ROW_H, background: 'var(--bg2)', borderBottom: '1px solid var(--bdr)' }}>
                  <div style={{ position: 'sticky', left: 0, zIndex: 2, display: 'flex', alignItems: 'center', gap: 8, padding: `0 12px 0 ${12 + r.depth * 18}px`, width: NAME_W + DEF_W, boxSizing: 'border-box', background: 'var(--bg2)' }}>
                    <button type="button" aria-label={r.collapsed ? 'Open' : 'Close'} onClick={() => setCollapsed((c) => { const n = new Set(c); if (n.has(r.id)) n.delete(r.id); else n.add(r.id); return n; })}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--t3)', fontSize: 12, width: 18, padding: 0 }}>{r.collapsed ? '▸' : '▾'}</button>
                    <span style={{ fontSize: 13, fontWeight: 800, color: r.id === NO_CATEGORY ? 'var(--red)' : 'var(--t1)' }}>{r.label}</span>
                    <span style={{ fontSize: 11.5, color: 'var(--t4)' }}>{r.count}</span>
                    {editable && r.id !== NO_CATEGORY && <Btn small kind="link" onClick={() => onChangePrices({ categoryIds: [r.id] })}>Change prices</Btn>}
                  </div>
                </div>
              );
            }
            const p = r.product;
            const isNew = staged.created.has(p.id);
            const pStaged = staged.products.get(p.id);
            return (
              <div key={p.id} role="row" style={{ display: 'flex', height: ROW_H, borderBottom: '1px solid var(--bdr)', background: selected.has(p.id) ? 'color-mix(in srgb, var(--acc) 7%, var(--bg1))' : 'var(--bg1)' }}>
                <div style={{ position: 'sticky', left: 0, zIndex: 2, width: NAME_W, display: 'flex', alignItems: 'center', gap: 8, padding: `0 10px 0 ${12 + r.depth * 18 + (r.size ? 18 : 0)}px`, boxSizing: 'border-box', background: 'inherit', borderRight: '1px solid var(--bdr)' }}>
                  <input type="checkbox" aria-label={`Select ${p.name}`} checked={selected.has(p.id)} onChange={() => toggleSel(p.id)} />
                  <button type="button" onClick={() => onOpenProduct(p.id)} title="Open the product"
                    style={{ flex: 1, minWidth: 0, textAlign: 'left', background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit', color: p.archived ? 'var(--t4)' : 'var(--t1)', fontSize: 13, fontWeight: r.size ? 500 : 650, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textDecoration: p.archived ? 'line-through' : 'none' }}>
                    {r.size ? '↳ ' : ''}{p.menu_name || p.name}
                  </button>
                  {isNew && <Pill tone="warn">New</Pill>}
                  {!isNew && pStaged && pStaged.size > 0 && <Pill tone="warn" title={[...pStaged].join(', ')}>Edited</Pill>}
                  {p.site_only_location_id && <Pill tone="blue" title="Sold at one site only">{(sites.find((s) => s.id === p.site_only_location_id)?.name || 'One site')} only</Pill>}
                </div>
                {p.type === 'variants' ? (
                  <div role="gridcell" style={{ ...cellBase, width: DEF_W + cols.length * SITE_W, justifyContent: 'flex-start', color: 'var(--t4)', fontSize: 12 }}>Priced by its sizes below</div>
                ) : <>
                <PriceCell width={DEF_W} rowIndex={rowIndex} col={0} focus={focus} editing={editing} setFocus={setFocus} setEditing={setEditing} commitEdit={commitEdit}
                  value={defaultFor(p, channel)} own staged={!!(pStaged && (channel ? pStaged.has('default_channels') : pStaged.has('default_price')))} pending={pending.has(`${p.id}|default`)} editable={editable} />
                {cols.map((s, ci) => {
                  const c = cellFor(ix, p, s.id, channel);
                  const st = cellStaged(staged, p.id, s.id, channel);
                  const ps = ix.sites.get(`${p.id}|${s.id}`);
                  let gp = null;
                  if (gpOn && c.exists) {
                    const m = costs.byLoc[s.id];
                    gp = m ? marginFor({ price: c.price, vatPct: Number(p.tax_rate_percent) || 0, cost: m.get(ps?.venue_item_id) ?? null }) : null;
                  }
                  return (
                    <SiteCell key={s.id} width={SITE_W} rowIndex={rowIndex} col={ci + 1} cell={c} st={st} gp={gp} gpOn={gpOn} p={p} loc={s.id}
                      focus={focus} editing={editing} setFocus={setFocus} setEditing={setEditing} commitEdit={commitEdit}
                      pending={pending.has(`${p.id}|${s.id}`) || pending.has(`${p.id}|x`)} editable={editable} onToggle={toggle} />
                  );
                })}
                </>}
              </div>
            );
          })}
          <div style={{ height: Math.max(0, rows.length - end) * ROW_H }} />
          {rows.length === 0 && <div style={{ padding: 30, textAlign: 'center', ...ui.sub }}>No products match.</div>}
        </div>
      </div>
      <div style={{ ...ui.sub, fontSize: 11.5 }}>
        Grey prices follow the group price. Amber marks are in the draft and reach the tills only when it is published. Click a price to change it; paste a column from a spreadsheet to fill prices down.
      </div>
    </div>
  );
}

const headCell = { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '0 8px', fontSize: 11.5, fontWeight: 700, color: 'var(--t2)', boxSizing: 'border-box', textAlign: 'center', lineHeight: 1.25, borderRight: '1px solid var(--bdr)' };
const cellBase = { position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 7, padding: '0 10px', boxSizing: 'border-box', borderRight: '1px solid var(--bdr)', fontVariantNumeric: 'tabular-nums' };
const stagedMark = { position: 'absolute', left: 0, top: 6, bottom: 6, width: 3, borderRadius: 2, background: 'var(--amber, #F5A623)' };
const focusRing = { boxShadow: 'inset 0 0 0 2px var(--acc)' };

function EditBox({ editing, setEditing, commitEdit }) {
  return (
    <div style={{ position: 'relative', width: '100%' }}>
      <input autoFocus aria-label="Price" value={editing.text} inputMode="decimal"
        onFocus={(e) => { if (editing.select) e.target.select(); else { const n = e.target.value.length; e.target.setSelectionRange(n, n); } }}
        onChange={(e) => setEditing({ ...editing, text: e.target.value, words: '', select: false })}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') { e.preventDefault(); commitEdit(editing, 'Enter'); }
          else if (e.key === 'Tab') { e.preventDefault(); commitEdit(editing, e.shiftKey ? 'ShiftTab' : 'Tab'); }
          else if (e.key === 'Escape') { e.preventDefault(); commitEdit(editing, 'Cancel'); }
        }}
        onBlur={() => commitEdit(editing, null)}
        style={{ width: '100%', padding: '5px 7px', borderRadius: 7, border: `1px solid ${editing.words ? 'var(--red)' : 'var(--acc)'}`, background: 'var(--bg2)', color: 'var(--t1)', fontSize: 13, textAlign: 'right', fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' }} />
      {editing.words && <div role="alert" style={{ position: 'absolute', top: '100%', right: 0, zIndex: 6, marginTop: 4, width: 200, background: 'var(--bg1)', border: '1px solid var(--red-b)', color: 'var(--red)', borderRadius: 8, padding: '6px 8px', fontSize: 11.5 }}>{editing.words}</div>}
    </div>
  );
}

function PriceCell({ width, rowIndex, col, focus, editing, setFocus, setEditing, commitEdit, value, staged, pending, editable }) {
  const isFocus = focus && focus.row === rowIndex && focus.col === col;
  const isEdit = editing && editing.row === rowIndex && editing.col === col;
  return (
    <div role="gridcell" style={{ ...cellBase, width, ...(isFocus && !isEdit ? focusRing : {}), opacity: pending ? 0.5 : 1, background: 'color-mix(in srgb, var(--bg2) 55%, transparent)' }}
      onClick={() => { setFocus({ row: rowIndex, col }); if (editable && !isEdit) setEditing({ row: rowIndex, col, text: price2(value), select: true }); }}>
      {staged && <span style={stagedMark} />}
      {isEdit ? <EditBox editing={editing} setEditing={setEditing} commitEdit={commitEdit} />
        : <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)' }}>{money(value)}</span>}
    </div>
  );
}

function SiteCell({ width, rowIndex, col, cell, st, gp, gpOn, p, loc, focus, editing, setFocus, setEditing, commitEdit, pending, editable, onToggle }) {
  const isFocus = focus && focus.row === rowIndex && focus.col === col;
  const isEdit = editing && editing.row === rowIndex && editing.col === col;
  if (!cell.exists) {
    return (
      <div role="gridcell" style={{ ...cellBase, width, justifyContent: 'center', ...(isFocus ? focusRing : {}), opacity: pending ? 0.5 : 1 }} onClick={() => setFocus({ row: rowIndex, col })}>
        {st.active && <span style={stagedMark} />}
        {cell.siteOnlyElsewhere
          ? <span style={{ color: 'var(--t4)', fontSize: 12 }} title="Another site's own extra">·</span>
          : editable ? <button type="button" onClick={(e) => { e.stopPropagation(); onToggle(p, loc, true); }} title="Sell it at this site too"
            style={{ background: 'none', border: '1px dashed var(--bdr2)', borderRadius: 7, color: 'var(--t3)', fontSize: 11.5, fontWeight: 700, padding: '3px 8px', cursor: 'pointer', fontFamily: 'inherit' }}>+ Add</button>
            : <span style={{ color: 'var(--t4)', fontSize: 12 }}>Not sold</span>}
      </div>
    );
  }
  const off = !cell.active;
  return (
    <div role="gridcell" aria-label={`${p.name} at this site: ${off ? 'off' : 'on'}, ${price2(cell.price)}`}
      style={{ ...cellBase, width, ...(isFocus && !isEdit ? focusRing : {}), opacity: pending ? 0.5 : 1, flexDirection: gpOn && !isEdit ? 'column' : 'row', alignItems: gpOn && !isEdit ? 'flex-end' : 'center', justifyContent: 'center', gap: gpOn ? 0 : 7 }}
      onClick={() => { setFocus({ row: rowIndex, col }); if (editable && !isEdit) setEditing({ row: rowIndex, col, text: price2(cell.own ?? cell.price), select: true }); }}>
      {(st.price || st.active) && <span style={stagedMark} />}
      {isEdit ? <EditBox editing={editing} setEditing={setEditing} commitEdit={commitEdit} /> : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            {cell.keptCols.length > 0 && <span title={`This site keeps its own: ${cell.keptCols.join(', ').replace(/_/g, ' ')}`} style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--blu)', display: 'inline-block' }} />}
            <span style={{ fontSize: 13, fontWeight: cell.follows ? 500 : 750, color: off ? 'var(--t4)' : cell.follows ? 'var(--t3)' : 'var(--t1)', textDecoration: off ? 'line-through' : 'none' }}
              title={cell.follows ? 'Follows the group price' : 'This site\'s own price'}>{money(cell.price)}</span>
            <Switch small on={!off} disabled={!editable} title={off ? 'Off at this site: turn on' : 'On at this site: turn off'} onChange={(v) => onToggle(p, loc, v)} />
          </div>
          {gpOn && (
            <span style={{ fontSize: 10.5, fontWeight: 650, color: gp && !gp.noRecipe ? (gp.gpPct != null && gp.gpPct < 60 ? 'var(--amber, #F5A623)' : 'var(--grn, var(--acc))') : 'var(--t4)' }}>
              {gp ? (gp.noRecipe ? 'No recipe' : `${gp.words} · cost ${money(gp.cost)}`) : '…'}
            </span>
          )}
        </>
      )}
    </div>
  );
}

function SetPricePopover({ sites, groups, channel, onApply }) {
  const [text, setText] = useState('');
  const [locs, setLocs] = useState(() => sites.map((s) => s.id));
  const parsed = priceInput(text);
  return (
    <Popover label="Set price" width={280}>
      {(close) => (
        <div>
          <div style={{ ...ui.sub, marginBottom: 6 }}>{channel ? `${channelLabel(channel)} price` : 'Price'} at the sites ticked. Blank puts them back on the group price.</div>
          <input autoFocus style={{ ...ui.input, marginBottom: 10 }} placeholder="3.20" value={text} onChange={(e) => setText(e.target.value)} />
          <SiteChecklist sites={sites} groups={groups} value={locs} onChange={setLocs} />
          {!parsed.ok && <div style={{ ...ui.err, marginTop: 6 }}>{parsed.words}</div>}
          <Btn kind="primary" small style={{ marginTop: 10 }} disabled={!parsed.ok || !locs.length} onClick={() => { close(); onApply(parsed.value, locs); }}>Set price</Btn>
        </div>
      )}
    </Popover>
  );
}

function SitesActionPopover({ label, button, sites, groups, onApply }) {
  const [locs, setLocs] = useState(() => sites.map((s) => s.id));
  return (
    <Popover label={label} width={260}>
      {(close) => (
        <div>
          <SiteChecklist sites={sites} groups={groups} value={locs} onChange={setLocs} />
          <Btn kind="primary" small style={{ marginTop: 10 }} disabled={!locs.length} onClick={() => { close(); onApply(locs); }}>{button}</Btn>
        </div>
      )}
    </Popover>
  );
}

function CopyPricesPopover({ sites, groups, onApply }) {
  const [from, setFrom] = useState(sites[0]?.id || '');
  const [to, setTo] = useState([]);
  return (
    <Popover label="Copy prices" width={280}>
      {(close) => (
        <div>
          <span style={ui.label}>From</span>
          <select style={{ ...ui.input, marginBottom: 10 }} value={from} onChange={(e) => setFrom(e.target.value)}>
            {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <span style={ui.label}>To</span>
          <SiteChecklist sites={sites.filter((s) => s.id !== from)} groups={groups} value={to} onChange={setTo} />
          <Btn kind="primary" small style={{ marginTop: 10 }} disabled={!from || !to.length} onClick={() => { close(); onApply(from, to); }}>Copy</Btn>
        </div>
      )}
    </Popover>
  );
}
