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
//
// ROUND 2 (17 Oct 2026, the clarity pass): the toolbar's first row is Search, Category, Add product
// and Change prices, with the rest under More; a second row picks what the grid shows (which
// products, which price, prices or VAT or GP, which sites) beside a legend of every mark. Words:
// "Standard price" (never In store), "Off here", "+ Sell here", "Only at Leeds". A single cell action
// shows a note with Undo. A VAT view shows each product's VAT for an order type at every site.
// Every popover opens above the sticky header (msmUi Popover portal; Peter's UI issue 1).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ROW_H, NO_CATEGORY, SHOW_FILTERS, CHANNEL_LABELS, priceLabel, buildGridRows, cellFor, cellStaged, categoryTree,
  visibleRange, priceInput, parsePastedColumn, price2, moveFocus, defaultFor, priceEditable, showLabel, noPriceWords,
} from '../../../lib/msm/msmGrid';
import { sitePriceChange, siteActiveChange, defaultPriceChange, activeMany, copyPricesMany, moveMany, pasteColumn, hasSizes } from '../../../lib/msm/msmEdit';
import { marginFor, vatMaps } from '../../../lib/msm/msmMargin';
import { shownPriceTypes, shownTaxTypes, vatCell } from '../../../lib/msm/msmOrderTypes';
import { TAX_TYPE_WORDS, colWord } from '../../../lib/msm/msmWords';
import { whyReadOnly, cellNoteWords, bulkActiveWords, noCategoryHint } from '../../../lib/msm/msmStatus';
import { addGroupWithSites } from '../../../lib/msm/msmGroupView';
import * as groupEdit from '../../../lib/msm/msmGroupEdit';
import { riskChecks } from '../../../lib/msm/msmRisk';
import { PUBLISHED_CHANNELS as CHANNELS } from '../../../../supabase/functions/_shared/msmModel.js';
import { Btn, Pill, Switch, Segmented, Popover, SiteChecklist, MenuButton, Notice } from './msmUi';
import { ui, money } from './msmStyle';

// The product column: up to 300 px, narrower on an iPad so the site prices stay on screen.
const NAME_W = 300;
const NAME_MIN = 170;
const DEF_W = 116;
const SITE_W = 132;
const HEAD_H = 46;

export default function MsmGrid({ ix, live, eff, sites, staged, ctx, stage, editable, canEdit, working, costs, channel, setChannel, ratesByLoc = {}, setNote, onOpenProduct, onAddProduct, onChangePrices, onCsv }) {
  const [search, setSearch] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [show, setShow] = useState('all');
  const [mode, setMode] = useState('prices');       // prices | vat | gp
  const [taxKey, setTaxKey] = useState('takeaway');
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
  const [viewW, setViewW] = useState(1200);
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
    const measure = () => { setViewH(el.clientHeight || 600); setViewW(el.clientWidth || 1200); };
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
  const run = useCallback(async (keys, changes, done, undo = true, nothing = 'Nothing to change: it is already like that.') => {
    const list = (changes || []).filter(Boolean);
    // Never a silent nothing (Peter, UI issue 10): say so on screen.
    if (!list.length) { setNote?.({ tone: 'warn', text: nothing }); return; }
    setPending((p) => { const s = new Set(p); keys.forEach((k) => s.add(k)); return s; });
    try { await stage(list, { done, undo }); }
    finally { setPending((p) => { const s = new Set(p); keys.forEach((k) => s.delete(k)); return s; }); }
  }, [stage, setNote]);
  const siteNameOf = (loc) => sites.find((x) => x.id === loc)?.name || 'that site';

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
    if (r.change) {
      const nm = p.menu_name || p.name;
      const words = loc ? cellNoteWords({ product: nm, site: siteNameOf(loc), price: parsed.value, money }) : `${nm}: group ${priceLabel(channel).toLowerCase()} ${money(parsed.value)} (in the draft).`;
      await run([`${p.id}|${loc || 'default'}`], [r.change], words);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx, channel, rows, cols, run]);

  const toggle = useCallback((p, loc, on) => {
    if (!editable) return;
    const r = siteActiveChange(ctx, p.id, loc, on);
    if (r.words) { setNote?.({ tone: 'warn', text: r.words }); return; }
    const existed = !!ix.sites.get(`${p.id}|${loc}`);
    const nm = p.menu_name || p.name;
    // Sizes that go with it, and a product with no category yet, are said at the moment it is
    // flipped (17 Oct verification: UI items 8 and 10).
    const sizes = [r.change, ...(r.extra || [])].filter((c) => c && c.target === 'product_site' && c.entity_id !== p.id && ix.products.get(c.entity_id)?.parent_product_id === p.id).length;
    const sizeWords = sizes ? ` Its ${sizes === 1 ? 'size goes' : `${sizes} sizes go`} with it.` : '';
    const hint = on ? noCategoryHint(p) : '';
    const words = r.change?.dropCreate ? `${nm} at ${siteNameOf(loc)} is taken out of the draft again: nothing changes there.`
      : existed ? cellNoteWords({ product: nm, site: siteNameOf(loc), active: on }) : `${nm} will be sold at ${siteNameOf(loc)} (in the draft).`;
    run([`${p.id}|${loc}`], [r.change, ...(r.extra || [])], `${words}${sizeWords}${hint ? ` ${hint}` : ''}`, true,
      `${nm} is already ${on ? 'on' : 'off'} at ${siteNameOf(loc)}.`);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx, editable, run, setNote, ix, sites]);

  // The blue dot's "Use the group's settings": the site stops keeping its own values for this product
  // (its own price stays; VAT keys a site holds for other order types are only noted, never written).
  const giveBackChange = (p, loc) => {
    const ps = ix.sites.get(`${p.id}|${loc}`);
    if (!ps?.kept || !Object.keys(ps.kept).length) return null;
    const rest = Object.fromEntries(Object.entries(ps.kept.tax_overrides || {}).filter(([k]) => !['dine-in', 'takeaway', 'delivery', 'bar'].includes(k)));
    // "No price" is not one of the settings the dot lists: it stays until a price is set there.
    const kept = { ...(Object.keys(rest).length ? { tax_overrides: rest } : {}), ...(ps.kept.no_price === true ? { no_price: true } : {}) };
    return { target: 'product_site', entity_id: p.id, location_id: loc, op: 'update', after: { kept }, before: { kept: ps.kept } };
  };
  // What "Use the group's settings" does to VAT, in words, to tick before it is staged (design 5.4
  // and 6.5: VAT changes always need a tick; round 2 review).
  const siteNames = useMemo(() => new Map(sites.map((x) => [x.id, x.name])), [sites]);
  const keptVatWords = (p, loc) => {
    const c = giveBackChange(p, loc);
    return c ? riskChecks([c], eff, null, null, { siteNames, ratesByLoc }).filter((r) => r.code === 'vat').map((r) => r.words) : [];
  };
  const giveBackToGroup = (p, loc) => {
    const c = giveBackChange(p, loc);
    if (!c) return;
    const liveS = (live?.productSites || []).find((x) => x.product_id === p.id && x.location_id === loc);
    run([`${p.id}|${loc}`], [{ ...c, before: { kept: liveS?.kept ?? {} } }],
      `${siteNameOf(loc)} will use the group's settings for ${p.menu_name || p.name} once published (in the draft).`);
  };

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
    // Space turns a product on or off at a site, a product with sizes too (it has a switch there).
    if (e.key === ' ' && loc) {
      e.preventDefault();
      const c = cellFor(ix, p, loc, channel);
      toggle(p, loc, !(c.exists && c.active));
      return;
    }
    // A variants parent draws no price cell (its sizes are priced): no edit, no clear.
    if (!priceEditable(p, eff?.products)) {
      if (e.key === 'Enter' || e.key === 'F2' || /^[0-9.]$/.test(e.key) || e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); setNote?.({ tone: 'warn', text: 'This product is priced by its sizes. Change the price on each size.' }); }
      return;
    }
    // Never a silent nothing (UI item 10): a price on a product not sold there says so.
    const notSoldWords = () => `${p.menu_name || p.name} is not sold at ${siteNameOf(loc)}. Press Space or tap + Sell here first.`;
    if (e.key === 'Enter' || e.key === 'F2') {
      e.preventDefault();
      const c = loc ? cellFor(ix, p, loc, channel) : null;
      if (loc && !c.exists) { setNote?.({ tone: 'warn', text: notSoldWords() }); return; }
      setEditing({ ...focus, text: price2(loc ? (c.own ?? c.price) : defaultFor(p, channel)), select: true });
    } else if (/^[0-9.]$/.test(e.key)) {
      e.preventDefault();
      if (loc && !cellFor(ix, p, loc, channel).exists) { setNote?.({ tone: 'warn', text: notSoldWords() }); return; }
      setEditing({ ...focus, text: e.key });
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      if (!loc) { setNote?.({ tone: 'warn', text: 'The group price cannot be blank. Type 0.00 for free.' }); return; }
      const r = sitePriceChange(ctx, p.id, loc, null, channel);
      if (r.change) run([`${p.id}|${loc}`], [r.change], cellNoteWords({ product: p.menu_name || p.name, site: siteNameOf(loc), price: null }));
      else setNote?.({ tone: 'warn', text: r.words || r.note || `${p.menu_name || p.name} at ${siteNameOf(loc)} already follows the group price.` });
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
      `${res.changes.length} price${res.changes.length === 1 ? '' : 's'} pasted${bad ? `; ${bad} line${bad === 1 ? ' was' : 's were'} not a price and ${bad === 1 ? 'was' : 'were'} skipped` : ''}.${res.words.length ? ` ${res.words[0]}` : ''}`,
      true, res.words[0] || 'Nothing to change: it is already like that.');
  };

  // ── Selection ──────────────────────────────────────────────────────────
  const productRows = rows.filter((r) => r.kind === 'product');
  const allSelected = productRows.length > 0 && productRows.every((r) => selected.has(r.id));
  // Shift click selects the block from the last product ticked to this one (design 4b).
  const lastSel = useRef(null);
  const toggleSel = (id, shift = false) => {
    const ids = productRows.map((r) => r.id);
    const from = lastSel.current != null ? ids.indexOf(lastSel.current) : -1;
    const to = ids.indexOf(id);
    if (shift && from >= 0 && to >= 0) {
      const on = !selected.has(id);
      const [a, b] = from < to ? [from, to] : [to, from];
      setSelected((s) => { const n = new Set(s); for (const x of ids.slice(a, b + 1)) { if (on) n.add(x); else n.delete(x); } return n; });
    } else {
      setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
    }
    lastSel.current = id;
  };
  const selIds = [...selected].filter((id) => ix.products.has(id));

  const why = whyReadOnly({ canEdit, working });
  const orderTypes = useMemo(() => shownPriceTypes(eff || live), [eff, live]);
  const taxTypes = useMemo(() => shownTaxTypes(eff || live), [eff, live]);
  // Products on screen with their own order type price: a Standard price change does not reach it.
  const pinned = useMemo(() => {
    if (channel || mode !== 'prices') return null;
    const counts = new Map();
    for (const r of rows) {
      if (r.kind !== 'product') continue;
      const p = r.product;
      for (const ch of CHANNELS) {
        const set = (p.default_channels && p.default_channels[ch] != null) || cols.some((c) => { const ps = ix.sites.get(`${p.id}|${c.id}`); return ps?.channel_prices && ps.channel_prices[ch] != null; });
        if (set) counts.set(ch, (counts.get(ch) || 0) + 1);
      }
    }
    let best = null;
    for (const [ch, n] of counts) if (!best || n > best.n) best = { ch, n };
    return best;
  }, [channel, mode, rows, cols, ix]);
  const nameW = Math.max(NAME_MIN, Math.min(NAME_W, Math.round(viewW * 0.26)));
  const totalW = nameW + DEF_W + cols.length * SITE_W;
  const vat = useMemo(() => vatMaps(live, costs.ratesByLoc || {}), [live, costs.ratesByLoc]);
  const gpOn = mode === 'gp';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0, flex: 1 }}>
      {/* Toolbar, first row: find, add, change prices */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input aria-label="Search products" style={{ ...ui.input, width: 220 }} placeholder="Search products" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select aria-label="Category" style={{ ...ui.input, width: 190 }} value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
          <option value="">Every category</option>
          {tree.map((t) => <option key={t.id} value={t.id}>{'  '.repeat(t.depth)}{t.label}</option>)}
        </select>
        <div style={{ flex: 1 }} />
        {canEdit && (
          <>
            <Btn small kind="soft" disabled={!editable} title={why || 'A new product. Tick the sites it is sold at; untick to sell it at one or some.'} onClick={() => onAddProduct()} data-testid="msm-add-product">Add product</Btn>
            <Btn small kind="primary" disabled={!editable} title={why || 'Up or down by an amount or a percent'} onClick={() => onChangePrices({ all: true })}>Change prices</Btn>
          </>
        )}
        <MenuButton label="More" items={[
          { label: 'Export to Excel', hint: 'The grid as a spreadsheet, prices and on or off at each site.', onClick: () => onCsv?.('export') },
          canEdit && { label: 'Bring prices back from Excel', hint: 'Change prices in the spreadsheet, then bring it back. You see every change first.', disabled: !editable, why, onClick: () => onCsv?.('import') },
        ]} />
      </div>
      {why && canEdit && <div style={{ ...ui.sub, marginTop: -4 }}>{why}</div>}

      {/* Toolbar, second row: what the grid shows */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <select aria-label="Show" title="Which products the grid lists" style={{ ...ui.input, width: 'auto', minWidth: 170 }} value={show} onChange={(e) => setShow(e.target.value)}>
          {SHOW_FILTERS.map((f) => <option key={f.id} value={f.id}>Show: {f.label}</option>)}
        </select>
        <Segmented small value={mode} onChange={setMode} options={[
          { value: 'prices', label: 'Prices' },
          { value: 'vat', label: 'VAT', title: 'The VAT each product is charged for an order type, at each site' },
          { value: 'gp', label: 'GP', title: 'Cost and gross profit from each site\'s own recipes' },
        ]} />
        {mode !== 'vat' && (
          <select aria-label="Showing" title="Which price the grid shows" style={{ ...ui.input, width: 'auto', minWidth: 190 }} value={channel || ''} onChange={(e) => setChannel(e.target.value || null)}>
            <option value="">Showing: Standard price</option>
            {orderTypes.types.map((k) => <option key={k} value={k}>Showing: {CHANNEL_LABELS[k]} price</option>)}
            {orderTypes.hidden.length > 0 && (
              <optgroup label="Other order types (no prices set)">
                {orderTypes.hidden.map((k) => <option key={k} value={k}>Showing: {CHANNEL_LABELS[k]} price</option>)}
              </optgroup>
            )}
          </select>
        )}
        {mode === 'vat' && (
          <select aria-label="VAT for" style={{ ...ui.input, width: 'auto', minWidth: 160 }} value={taxKey} onChange={(e) => setTaxKey(e.target.value)}>
            {taxTypes.map((k) => <option key={k} value={k}>VAT for: {TAX_TYPE_WORDS[k]}</option>)}
          </select>
        )}
        <Popover label={`Sites (${cols.length} of ${sites.length})`} width={260} testId="msm-sites-filter">
          <SiteChecklist sites={sites} value={shownSites} groups={groups} onChange={(v) => setShownSites(v.length ? v : shownSites)} />
        </Popover>
      </div>
      <Key mode={mode} />

      {pinned && (
        <Notice tone="info" actions={[{ label: `Show ${CHANNEL_LABELS[pinned.ch]} prices`, onClick: () => setChannel(pinned.ch) }]}>
          {pinned.n} product{pinned.n === 1 ? ' has its' : 's have their'} own {CHANNEL_LABELS[pinned.ch]} price, so a Standard price change does not reach {CHANNEL_LABELS[pinned.ch]} for {pinned.n === 1 ? 'it' : 'them'}.
        </Notice>
      )}

      {/* Bulk bar */}
      {selIds.length > 0 && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', padding: '8px 12px', borderRadius: 12, background: 'var(--acc-d)', border: '1px solid var(--acc-b, var(--bdr))' }}>
          <strong style={{ fontSize: 13 }}>{selIds.length} selected</strong>
          {editable && (
            <>
              <Btn small kind="primary" onClick={() => onChangePrices({ productIds: selIds })}>Change prices</Btn>
              <SitesActionPopover label="Turn on at" sites={sites} groups={groups} button="Turn on" onApply={(locs) => {
                const r = activeMany(ctx, selIds, locs, true);
                const noCat = selIds.map((id) => ix.products.get(id)).filter((x) => noCategoryHint(x)).length;
                run([], r.changes, `${bulkActiveWords(r, true)}${noCat ? ` ${noCat} of them ${noCat === 1 ? 'has' : 'have'} no category yet: open ${noCat === 1 ? 'it' : 'them'} and pick one before you publish.` : ''}`, true, bulkActiveWords(r, true));
              }} />
              <SitesActionPopover label="Turn off at" sites={sites} groups={groups} button="Turn off" onApply={(locs) => { const r = activeMany(ctx, selIds, locs, false); run([], r.changes, bulkActiveWords(r, false), true, bulkActiveWords(r, false)); }} />
              <CopyPricesPopover sites={sites} groups={groups} onApply={(from, to) => { const r = copyPricesMany(ctx, selIds, from, to, channel); run([], r.changes, `${r.changes.length} price${r.changes.length === 1 ? '' : 's'} copied (in the draft).${r.words.length ? ` ${r.words[0]}` : ''}`, true, r.words[0] || 'Nothing to change: it is already like that.'); }} />
              <Popover label="Move to" width={260}>
                {(close) => (
                  <div style={{ maxHeight: 260, overflowY: 'auto' }}>
                    {tree.map((t) => (
                      <div key={t.id}><Btn small kind="link" style={{ paddingLeft: 6 + t.depth * 12 }} onClick={() => { close(); const r = moveMany(ctx, selIds, t.id); run([], r.changes, `${r.changes.length} moved to ${t.label} (in the draft).`); }}>{t.label}</Btn></div>
                    ))}
                  </div>
                )}
              </Popover>
              {(eff?.groups || []).some((g) => !g.archived) && (
                <Popover label="Add option group" width={280}>
                  {(close) => (
                    <div style={{ maxHeight: 280, overflowY: 'auto' }}>
                      <div style={{ ...ui.sub, marginBottom: 6 }}>Ask this question on the {selIds.length} product{selIds.length === 1 ? '' : 's'} ticked (a product with sizes means its sizes).</div>
                      {(eff?.groups || []).filter((g) => !g.archived).map((g) => (
                        <div key={g.id}><Btn small kind="link" onClick={() => { close(); const ch = addGroupWithSites(ctx, g.id, selIds, groupEdit); const n = ch.filter((c) => c.target === 'product').length; run([], ch, n ? `${g.name} added to ${n} product${n === 1 ? '' : 's'} (in the draft).` : `They all ask ${g.name} already.`); }}>{g.name}</Btn></div>
                      ))}
                    </div>
                  )}
                </Popover>
              )}
            </>
          )}
          <Btn small onClick={() => setSelected(new Set())}>Clear</Btn>
        </div>
      )}

      {/* The grid */}
      <div ref={scroller} tabIndex={0} role="grid" aria-label="Group menu prices" aria-rowcount={rows.length}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)} onKeyDown={onKeyDown} onPaste={onPaste}
        style={{ position: 'relative', overflow: 'auto', flex: 1, minHeight: 320, border: '1px solid var(--bdr)', borderRadius: 14, background: 'var(--bg1)', outline: 'none' }}>
        <div style={{ width: totalW, minWidth: '100%', position: 'relative' }}>
          {/* Header */}
          <div role="row" style={{ position: 'sticky', top: 0, zIndex: 4, display: 'flex', height: HEAD_H, background: 'var(--bg2)', borderBottom: '1px solid var(--bdr2)' }}>
            <div style={{ ...headCell, width: nameW, position: 'sticky', left: 0, zIndex: 5, background: 'var(--bg2)', flexDirection: 'row', justifyContent: 'flex-start', gap: 10, paddingLeft: 12 }}>
              <input type="checkbox" aria-label="Select every product shown" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(productRows.map((r) => r.id)))} />
              <span>Product <span style={{ color: 'var(--t4)', fontWeight: 600 }}>({products})</span></span>
            </div>
            <div style={{ ...headCell, width: DEF_W }} title={mode === 'vat' ? 'The group\'s VAT for this order type' : 'The price every site follows unless it has its own'}>
              {mode === 'vat' ? <>Group VAT<br /><span style={{ fontWeight: 500, color: 'var(--t4)' }}>{TAX_TYPE_WORDS[taxKey]}</span></>
                : <>Group price<br /><span style={{ fontWeight: 500, color: 'var(--t4)' }}>{channel ? `${CHANNEL_LABELS[channel]} (blank = ${channel === 'driveThru' ? 'takeaway' : 'standard'})` : 'Standard price'}</span></>}
            </div>
            {cols.map((s) => (
              <div key={s.id} role="columnheader" style={{ ...headCell, width: SITE_W }} title={s.name}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: SITE_W - 16 }}>{s.name}</span>
                {gpOn && costs.status[s.id] === 'loading' && <span style={{ fontWeight: 500, color: 'var(--t4)' }}>costing…</span>}
                {gpOn && costs.status[s.id] === 'failed' && <Btn small kind="link" style={{ color: 'var(--red)', fontWeight: 600, padding: 0 }} onClick={() => costs.retry([s.id])}>costs not read: retry</Btn>}
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
                  <div style={{ position: 'sticky', left: 0, zIndex: 2, display: 'flex', alignItems: 'center', gap: 8, padding: `0 12px 0 ${12 + r.depth * 18}px`, width: nameW + DEF_W, boxSizing: 'border-box', background: 'var(--bg2)' }}>
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
                <div style={{ position: 'sticky', left: 0, zIndex: 2, width: nameW, display: 'flex', alignItems: 'center', gap: 8, padding: `0 10px 0 ${12 + r.depth * 18 + (r.size ? 18 : 0)}px`, boxSizing: 'border-box', background: 'inherit', borderRight: '1px solid var(--bdr)' }}>
                  <input type="checkbox" aria-label={`Select ${p.name}`} checked={selected.has(p.id)} onChange={(e) => toggleSel(p.id, !!e.nativeEvent?.shiftKey)} />
                  <button type="button" onClick={() => onOpenProduct(p.id)} title="Open the product"
                    style={{ flex: 1, minWidth: 0, textAlign: 'left', background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit', color: p.archived ? 'var(--t4)' : 'var(--t1)', fontSize: 13, fontWeight: r.size ? 500 : 650, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textDecoration: p.archived ? 'line-through' : 'none' }}>
                    {r.size ? '↳ ' : ''}{p.menu_name || p.name}
                  </button>
                  {isNew && <Pill tone="warn">New</Pill>}
                  {!isNew && pStaged && pStaged.size > 0 && <Pill tone="warn" title="Changed in the draft">Edited</Pill>}
                  {p.type === 'subitem' && (ix.optionIn?.get(p.id)?.size || 0) > 0 && <Pill tone="neutral" title="A sub item: it is also picked as an option">{p.sold_alone === true ? `also an option in ${ix.optionIn.get(p.id).size} group${ix.optionIn.get(p.id).size === 1 ? '' : 's'}` : `option in ${ix.optionIn.get(p.id).size} group${ix.optionIn.get(p.id).size === 1 ? '' : 's'}`}</Pill>}
                </div>
                {mode === 'vat' ? (
                  <>
                    <VatCellView width={DEF_W} cell={vatCell(p, p.parent_product_id ? ix.products.get(p.parent_product_id) : null, null, taxKey)} group onOpen={() => onOpenProduct(p.id)} />
                    {cols.map((x) => {
                      const ps = ix.sites.get(`${p.id}|${x.id}`);
                      if (!ps) return <div key={x.id} role="gridcell" style={{ ...cellBase, width: SITE_W, justifyContent: 'center', color: 'var(--t4)', fontSize: 12 }}>Not sold</div>;
                      return <VatCellView key={x.id} width={SITE_W} off={ps.active === false} cell={vatCell(p, p.parent_product_id ? ix.products.get(p.parent_product_id) : null, ps, taxKey, ratesByLoc[x.id])} onOpen={() => onOpenProduct(p.id)} />;
                    })}
                  </>
                ) : !priceEditable(p, eff?.products) ? (
                  <>
                    <div role="gridcell" onClick={() => setFocus({ row: rowIndex, col: 0 })}
                      style={{ ...cellBase, width: DEF_W, justifyContent: 'flex-start', color: 'var(--t4)', fontSize: 11.5, lineHeight: 1.2, ...(focus && focus.row === rowIndex && focus.col === 0 ? focusRing : {}) }}>Priced by its sizes below</div>
                    {/* A product with sizes is turned on or off per site here, with its sizes (UI issue 11). */}
                    {cols.map((s, ci) => {
                      const c = cellFor(ix, p, s.id, channel);
                      const st = cellStaged(staged, p.id, s.id, channel);
                      const isF = focus && focus.row === rowIndex && focus.col === ci + 1;
                      return (
                        <div key={s.id} role="gridcell" aria-label={`${p.menu_name || p.name} at ${s.name}: ${c.exists && c.active ? 'on' : 'off'}`}
                          style={{ ...cellBase, width: SITE_W, justifyContent: 'center', ...(isF ? focusRing : {}), opacity: pending.has(`${p.id}|${s.id}`) ? 0.5 : 1 }}
                          onClick={() => setFocus({ row: rowIndex, col: ci + 1 })}>
                          {(st.active || st.kept) && <span style={stagedMark} />}
                          {!c.exists
                            ? (editable ? <button type="button" aria-label={`Sell ${p.menu_name || p.name} and its sizes at ${s.name}`} onClick={(e) => { e.stopPropagation(); toggle(p, s.id, true); }} title="Sell it and its sizes at this site"
                              style={{ background: 'none', border: '1px dashed var(--bdr2)', borderRadius: 7, color: 'var(--t3)', fontSize: 11.5, fontWeight: 700, padding: '3px 8px', cursor: 'pointer', fontFamily: 'inherit' }}>+ Sell here</button>
                              : <span style={{ color: 'var(--t4)', fontSize: 12 }}>Not sold</span>)
                            : <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                              <span style={{ fontSize: 12, color: c.active ? 'var(--t3)' : 'var(--t4)' }}>{c.active ? 'Sold here' : 'Off here'}</span>
                              <Switch small on={!!c.active} disabled={!editable} ariaLabel={`${p.menu_name || p.name} at ${s.name}: ${c.active ? 'on' : 'off'}`} title={c.active ? 'On here with its sizes: turn off' : 'Off here: turn on with its sizes'} onChange={(v) => toggle(p, s.id, v)} />
                            </div>}
                        </div>
                      );
                    })}
                  </>
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
                    gp = m ? marginFor({ price: c.price, vatPct: vat[s.id] ? vat[s.id](p) : Number(p.tax_rate_percent) || 0, cost: m.get(ps?.venue_item_id) ?? null })
                      : costs.status[s.id] === 'failed' ? { noCost: true, noRecipe: true } : null;
                  }
                  return (
                    <SiteCell key={s.id} width={SITE_W} rowIndex={rowIndex} col={ci + 1} cell={c} st={st} gp={gp} gpOn={gpOn} p={p} loc={s.id} siteName={s.name} withSizes={hasSizes(eff, p)}
                      focus={focus} editing={editing} setFocus={setFocus} setEditing={setEditing} commitEdit={commitEdit}
                      pending={pending.has(`${p.id}|${s.id}`) || pending.has(`${p.id}|x`)} editable={editable} onToggle={toggle} onUseGroup={giveBackToGroup} keptVat={keptVatWords} />
                  );
                })}
                </>}
              </div>
            );
          })}
          <div style={{ height: Math.max(0, rows.length - end) * ROW_H }} />
          {rows.length === 0 && (
            <div style={{ padding: 30, textAlign: 'center', ...ui.sub }}>
              {search || categoryId || show !== 'all'
                ? <>No products match{search ? ` "${search}"` : ''}{categoryId ? ` in ${tree.find((t) => t.id === categoryId)?.label || 'that category'}` : ''}{show !== 'all' ? ` (showing ${showLabel(show).toLowerCase()})` : ''}. <Btn small kind="link" onClick={() => { setSearch(''); setCategoryId(''); setShow('all'); }}>Clear filters</Btn></>
                : 'No products yet. Add one with Add product.'}
            </div>
          )}
        </div>
      </div>
      <div style={{ ...ui.sub, fontSize: 11.5 }}>
        {mode === 'vat' ? 'VAT is changed on each product (open it).' : 'Tap a price to change it. Blank puts a site back on the group price. Paste a column from a spreadsheet to fill prices down.'}
      </div>
    </div>
  );
}

const headCell = { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '0 8px', fontSize: 11.5, fontWeight: 700, color: 'var(--t2)', boxSizing: 'border-box', textAlign: 'center', lineHeight: 1.25, borderRight: '1px solid var(--bdr)' };
const cellBase = { position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 7, padding: '0 10px', boxSizing: 'border-box', borderRight: '1px solid var(--bdr)', fontVariantNumeric: 'tabular-nums' };
const stagedMark = { position: 'absolute', left: 0, top: 6, bottom: 6, width: 3, borderRadius: 2, background: 'var(--amber, #F5A623)' };
// GP under 60% is shown in coral, never amber (amber means a change waiting to go live).
const GP_LOW = 60;
const GP_LOW_COLOUR = 'var(--coral, var(--red))';
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

function SiteCell({ width, rowIndex, col, cell, st, gp, gpOn, p, loc, siteName = 'this site', withSizes = false, focus, editing, setFocus, setEditing, commitEdit, pending, editable, onToggle, onUseGroup, keptVat }) {
  const isFocus = focus && focus.row === rowIndex && focus.col === col;
  const isEdit = editing && editing.row === rowIndex && editing.col === col;
  const nm = p.menu_name || p.name;
  if (!cell.exists) {
    return (
      <div role="gridcell" aria-label={`${nm} at ${siteName}: not sold`} style={{ ...cellBase, width, justifyContent: 'center', ...(isFocus ? focusRing : {}), opacity: pending ? 0.5 : 1 }} onClick={() => setFocus({ row: rowIndex, col })}>
        {st.active && <span style={stagedMark} />}
        {editable ? <button type="button" aria-label={`Sell ${nm} at ${siteName}`} onClick={(e) => { e.stopPropagation(); onToggle(p, loc, true); }} title={withSizes ? 'Sell it and its sizes at this site' : 'Sell it at this site too'}
            style={{ background: 'none', border: '1px dashed var(--bdr2)', borderRadius: 7, color: 'var(--t3)', fontSize: 11.5, fontWeight: 700, padding: '3px 8px', cursor: 'pointer', fontFamily: 'inherit' }}>+ Sell here</button>
            : <span style={{ color: 'var(--t4)', fontSize: 12 }}>Not sold</span>}
      </div>
    );
  }
  const off = !cell.active;
  return (
    <div role="gridcell" aria-label={`${nm} at ${siteName}: ${off ? 'off' : 'on'}, ${cell.noPrice ? 'no price' : price2(cell.price)}`}
      style={{ ...cellBase, width, ...(isFocus && !isEdit ? focusRing : {}), opacity: pending ? 0.5 : 1, flexDirection: gpOn && !isEdit ? 'column' : 'row', alignItems: gpOn && !isEdit ? 'flex-end' : 'center', justifyContent: 'center', gap: gpOn ? 0 : 7 }}
      onClick={() => { setFocus({ row: rowIndex, col }); if (editable && !isEdit) setEditing({ row: rowIndex, col, text: price2(cell.own ?? cell.price), select: true }); }}>
      {(st.price || st.active || st.kept) && <span style={stagedMark} />}
      {isEdit ? <EditBox editing={editing} setEditing={setEditing} commitEdit={commitEdit} /> : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            {cell.keptCols.length > 0 && <KeptDot cols={cell.keptCols} editable={editable} vatWords={() => keptVat?.(p, loc) || []} onUseGroup={() => onUseGroup?.(p, loc)} />}
            {off
              ? <span style={{ fontSize: 12, color: 'var(--t4)' }} title={cell.noPrice ? `Turned off at this site (${noPriceWords(siteName).toLowerCase()})` : `Turned off at this site (${money(cell.price)} when on)`}>Off here</span>
              : cell.noPrice
                ? <span style={{ fontSize: 12, color: 'var(--t3)', fontStyle: 'italic' }} title={`${noPriceWords(siteName)}. Type a price to sell it here at that price.`}>No price</span>
                : <span style={{ fontSize: 13, fontWeight: cell.follows ? 500 : 750, color: cell.follows ? 'var(--t3)' : 'var(--t1)' }}
                  title={cell.follows ? 'Follows the group price' : 'This site\'s own price'}>{money(cell.price)}</span>}
            <Switch small on={!off} disabled={!editable} ariaLabel={`${nm} at ${siteName}: ${off ? 'off' : 'on'}`} title={off ? 'Off at this site: turn on' : 'On at this site: turn off'} onChange={(v) => onToggle(p, loc, v)} />
          </div>
          {gpOn && (
            <span style={{ fontSize: 10.5, fontWeight: 650, color: gp && !gp.noRecipe ? (gp.gpPct != null && gp.gpPct < GP_LOW ? GP_LOW_COLOUR : 'var(--grn, var(--acc))') : 'var(--t4)' }}>
              {gp ? (gp.noCost ? 'No cost' : gp.noRecipe ? 'No recipe' : `${gp.words} · cost ${money(gp.cost)}`) : '…'}
            </span>
          )}
        </>
      )}
    </div>
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
          <div style={{ ...ui.sub, marginBottom: 8 }}>Gives the ticked sites the same prices as the site you pick. They stop following the group price.</div>
          <span style={ui.label}>From</span>
          <select style={{ ...ui.input, marginBottom: 10 }} value={from} onChange={(e) => setFrom(e.target.value)}>
            {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <span style={ui.label}>To</span>
          <SiteChecklist sites={sites.filter((s) => s.id !== from)} groups={groups} value={to} onChange={setTo} />
          <Btn kind="primary" small style={{ marginTop: 10 }} disabled={!from || !to.length} onClick={() => { close(); onApply(from, to); }}>Copy the prices</Btn>
        </div>
      )}
    </Popover>
  );
}

// What every mark on the grid means, in words (Peter, 17 Oct 2026, UI issue 7: "what does this blue
// dot mean"; a hover title cannot be read on an iPad). Open on the first visit, folded to one line
// after that (remembered in this browser, in try and catch), and opened again with one tap.
const KEY_SEEN = 'msm-grid-key-seen';
const keySeen = () => { try { return localStorage.getItem(KEY_SEEN) === '1'; } catch { return false; } };
function Key({ mode }) {
  const [open, setOpen] = useState(() => !keySeen());
  useEffect(() => { try { localStorage.setItem(KEY_SEEN, '1'); } catch { /* private mode: it opens again next time */ } }, []);
  const dot = (c) => <span style={{ width: 7, height: 7, borderRadius: 4, background: c, display: 'inline-block', flexShrink: 0 }} />;
  const priceItems = [[<span key="g" style={{ color: 'var(--t3)', fontWeight: 500 }}>3.40</span>, 'Grey price: follows the group price.'],
    [<span key="o" style={{ color: 'var(--t1)', fontWeight: 750 }}>3.60</span>, 'Bold price: this site\'s own price.'],
    [<span key="a" style={{ width: 3, height: 14, borderRadius: 2, background: 'var(--amber, #F5A623)', display: 'inline-block' }} />, 'Amber bar: a change waiting to go live.'],
    [<span key="f" style={{ color: 'var(--t4)' }}>Off here</span>, 'Turned off at that site.'],
    [<span key="s" style={{ border: '1px dashed var(--bdr2)', borderRadius: 6, padding: '0 5px', color: 'var(--t3)', fontWeight: 700 }}>+ Sell here</span>, 'Not sold at that site yet: tap to sell it there.'],
    [dot('var(--blu)'), 'Blue dot: this site keeps its own settings for this product. Tap it to see which.'],
    [<span key="n" style={{ color: 'var(--t3)' }}>↳</span>, 'A size, under its product.']];
  // 17 Oct verification: the VAT sample carries its dot, the group column is named, and the GP
  // colours are explained (low GP is coral, never the amber of a change waiting).
  const items = mode === 'vat'
    ? [[<span key="g" style={{ color: 'var(--t3)', fontWeight: 500 }}>VAT 20%</span>, 'Grey: follows the group\'s VAT for this order type.'],
      [<span key="o" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>{dot('var(--blu)')}<span style={{ color: 'var(--t1)', fontWeight: 750 }}>Zero 0%</span></span>, 'Bold with a blue dot: this site keeps its own VAT for it.'],
      [<span key="c" style={{ color: 'var(--t1)', fontWeight: 750 }}>Group VAT</span>, 'The first column: what every site follows unless it keeps its own.']]
    : mode === 'gp'
      ? [...priceItems.slice(0, 4),
        [<span key="gg" style={{ color: 'var(--grn, var(--acc))', fontWeight: 650 }}>65% GP</span>, `Green: GP ${GP_LOW}% or more.`],
        [<span key="gl" style={{ color: GP_LOW_COLOUR, fontWeight: 650 }}>48% GP</span>, `Coral: GP under ${GP_LOW}%.`],
        [<span key="gn" style={{ color: 'var(--t4)' }}>No recipe</span>, 'No recipe or no cost at that site.']]
      : priceItems;
  if (!open) {
    return (
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', fontSize: 11.5, color: 'var(--t3)' }}>
        {items.map(([m], i) => <span key={i} style={{ display: 'inline-flex', alignItems: 'center' }}>{m}</span>)}
        <Btn small kind="link" onClick={() => setOpen(true)}>What do the marks mean?</Btn>
      </div>
    );
  }
  return (
    <div data-testid="msm-grid-key" style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap', padding: '8px 12px', borderRadius: 10, background: 'var(--bg2)', border: '1px solid var(--bdr)', fontSize: 12, color: 'var(--t2)' }}>
      {items.map(([m, w], i) => <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>{m}<span>{w}</span></span>)}
      <div style={{ flex: 1 }} />
      <Btn small kind="link" onClick={() => setOpen(false)}>Hide the key</Btn>
    </div>
  );
}

// The blue dot: tap it to see what this site keeps as its own, and give it back to the group.
function KeptDot({ cols, editable, vatWords, onUseGroup }) {
  return (
    <span onClick={(e) => e.stopPropagation()} style={{ display: 'inline-flex' }}>
      {/* A bigger tap target than the 9 px dot (17 Oct verification: 19 by 21 px on an iPad): the
          padding grows the button, the negative margin keeps the price and switch where they are. */}
      <Popover kind="link" small width={290} title="This site keeps its own settings: tap to see which" ariaLabel="This site keeps its own settings: tap to see which"
        btnStyle={{ padding: '14px 6px 14px 10px', margin: '-12px -2px -12px -8px' }}
        label={<span style={{ width: 9, height: 9, borderRadius: '50%', background: 'var(--blu)', display: 'inline-block' }} />}>
        {(close) => <KeptDotBody cols={cols} editable={editable} vatWords={vatWords} onUseGroup={() => { close(); onUseGroup(); }} />}
      </Popover>
    </span>
  );
}
// Inside the blue dot: what the site keeps, and "Use the group's" naming what goes back. A VAT by
// order type given back says what it becomes and needs a tick first (design 5.4 and 6.5).
function KeptDotBody({ cols, editable, vatWords, onUseGroup }) {
  const words = useMemo(() => vatWords?.() || [], [vatWords]);
  const [ok, setOk] = useState(false);
  const back = cols.filter((c) => c !== 'tax_overrides' || words.length).map(colWord);
  const list = back.length > 1 ? `${back.slice(0, -1).join(', ')} and ${back[back.length - 1]}` : back[0] || 'settings';
  return (
    <div style={{ fontSize: 12.5 }}>
      <div style={{ fontWeight: 750, marginBottom: 4 }}>This site keeps its own</div>
      <div style={{ ...ui.sub, marginBottom: 8 }}>{cols.map(colWord).join(', ')}. Publishing never changes these here.</div>
      {editable && words.length > 0 && (
        <label style={{ display: 'flex', gap: 6, alignItems: 'flex-start', marginBottom: 8, cursor: 'pointer' }}>
          <input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} style={{ marginTop: 2 }} />
          <span>{words.join(' ')}</span>
        </label>
      )}
      {editable && <Btn small kind="soft" style={{ whiteSpace: 'normal', textAlign: 'left', width: '100%' }} disabled={words.length > 0 && !ok} onClick={onUseGroup}>Use the group's {list}</Btn>}
    </div>
  );
}

// One VAT cell (the grid's VAT view): grey is the group's, bold a site that keeps its own.
function VatCellView({ width, cell, group = false, off = false, onOpen }) {
  return (
    <div role="gridcell" onClick={onOpen} title={group ? 'Open the product to change its VAT' : cell.own ? 'This site keeps its own VAT for this order type' : 'Follows the group'}
      style={{ ...cellBase, width, justifyContent: 'center', cursor: 'pointer', opacity: off ? 0.5 : 1, background: group ? 'color-mix(in srgb, var(--bg2) 55%, transparent)' : undefined }}>
      {cell.own && <span style={{ width: 6, height: 6, borderRadius: 3, background: 'var(--blu)', display: 'inline-block' }} />}
      <span style={{ fontSize: 11.5, lineHeight: 1.2, textAlign: 'center', fontWeight: group || cell.own ? 750 : 500, color: group || cell.own ? 'var(--t1)' : 'var(--t3)', overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>{cell.words}</span>
    </div>
  );
}
