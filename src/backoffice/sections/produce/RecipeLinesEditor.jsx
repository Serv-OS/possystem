// src/backoffice/sections/produce/RecipeLinesEditor.jsx
//
// MULTI SITE STOCK Drop 2 (contract 3.2): the recipe lines editor in the COMPANY form, lifted from
// today's Recipes.jsx (the lines list with qty, unit select, '=' cost and remove; Applies to; the
// order type cards; the ingredient search). RecipesSite keeps its own inline copy (the one site
// identity proof pins it byte for byte); this file is used by RecipePage only.
//
// A line is { key, component_item_id, name, base_unit, qty, unit ('@' plus the company pack id, or a
// unit code), pack_id, packs, usable_pct, order_types, note }. Unit choices = the item's packs plus
// the units of the same dimension (recipeRules.lineUnitOptions). itemPicker is { search(text) ->
// rows of itemsPage, detail(itemId) -> itemDetail } so a new line gets its packs with one read.
// lineCosts: { [key]: { cost, words } } from stock_recipe_cost, drawn after the '='. Nothing here
// saves: the tab sends the lines through stockApi.saveRecipe.

import { useEffect, useMemo, useRef, useState } from 'react';
import { RECIPE_ORDER_TYPES, ORDER_TYPE_LABELS, lineAppliesToOrderType } from '../../../lib/stock/costing';
import { lineUnitOptions, newEditorLine } from '../../../lib/stock/recipeRules';
import { stockApi } from '../../../lib/stock/stockApi';
import { money } from '../../../lib/currency';
import { Btn, Pill, ui } from '../stock/stockUi';

const field = { ...ui.input };
const off = (locked) => (locked ? { opacity: 0.55, cursor: 'not-allowed' } : null);
const otCard = (active) => ({ textAlign: 'left', minWidth: 116, padding: '7px 12px', borderRadius: 9, cursor: 'pointer', fontFamily: 'inherit', background: active ? 'var(--bg2)' : 'var(--bg1)', border: '1px solid ' + (active ? 'var(--acc)' : 'var(--bdr)'), boxShadow: active ? '0 0 0 1px var(--acc) inset' : 'none' });
const otCardTop = { fontSize: 12, fontWeight: 700, color: 'var(--t1)' };
const otCardSub = { fontSize: 11, marginTop: 2, color: 'var(--t3)' };

// costing.js reads camelCase lines; the company form holds order_types
const asCostingLine = (l) => ({ orderTypes: l?.order_types || null });

const EMPTY = Object.freeze([]);

export default function RecipeLinesEditor({ lines, onChange, disabled = false, recipeType = 'MENU', orderTypeView = 'all', onOrderTypeView, lineCosts = {}, itemPicker }) {
  const list = useMemo(() => (Array.isArray(lines) ? lines : EMPTY), [lines]);
  const isDish = recipeType === 'MENU';
  const view = isDish ? (orderTypeView || 'all') : 'all';
  const costingLines = useMemo(() => list.map(asCostingLine), [list]);
  const upd = (key, patch) => onChange?.(list.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const remove = (key) => onChange?.(list.filter((l) => l.key !== key));
  const add = async (item) => {
    if (!item?.id || disabled) return;
    let packs = [];
    if (itemPicker && typeof itemPicker.detail === 'function') {
      const r = await itemPicker.detail(item.id);
      packs = r?.data?.packs || r?.packs || [];
    }
    onChange?.([...list, newEditorLine(item, packs, { orderTypes: isDish && view !== 'all' ? [view] : null })]);
  };

  const visible = list.filter((l) => !isDish || view === 'all' || lineAppliesToOrderType(asCostingLine(l), view, costingLines));
  const extraFor = (ot) => list.filter((l) => Array.isArray(l.order_types) && l.order_types.includes(ot)).length;

  return (
    <div>
      {isDish && (
        <div style={{ marginBottom: 16 }}>
          <span style={ui.label}>Order type</span>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" onClick={() => onOrderTypeView?.('all')} style={otCard(view === 'all')}>
              <div style={otCardTop}>All order types</div>
              <div style={otCardSub}>Edit the base recipe</div>
            </button>
            {RECIPE_ORDER_TYPES.map((ot) => {
              const extra = extraFor(ot);
              const c = lineCosts?.byType?.[ot];
              return (
                <button key={ot} type="button" onClick={() => onOrderTypeView?.(ot)} style={otCard(view === ot)}>
                  <div style={otCardTop}>{ORDER_TYPE_LABELS[ot]}{extra ? ` · +${extra}` : ''}</div>
                  <div style={otCardSub}>{c != null ? money(c) : (extra ? `${extra} of its own` : 'Shared lines only')}</div>
                </button>
              );
            })}
          </div>
          <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 7 }}>
            {view === 'all'
              ? 'Editing the base recipe: these lines apply to every order type. Pick an order type above to add lines just for it (a disposable cup for takeaway).'
              : view === 'drive-thru'
                ? 'Showing Drive thru: the shared lines, plus the Takeaway lines (drive thru uses them until a line is tagged Drive thru), plus any added just for Drive thru. New lines you add here apply to Drive thru only.'
                : `Showing ${ORDER_TYPE_LABELS[view]}: the shared lines plus any added just for ${ORDER_TYPE_LABELS[view]}. New lines you add here apply to ${ORDER_TYPE_LABELS[view]} only. Widen them with Applies to.`}
          </div>
        </div>
      )}

      <span style={ui.label}>Ingredients{isDish && view !== 'all' ? ` · ${ORDER_TYPE_LABELS[view]}` : ''}</span>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
        {visible.length === 0 && (
          <div style={{ fontSize: 12.5, color: 'var(--t3)' }}>
            {list.length === 0 ? 'No ingredients yet. Add stock items below.' : `No lines for ${ORDER_TYPE_LABELS[view] || 'this order type'} yet. Add one below.`}
          </div>
        )}
        {visible.map((l) => {
          const lc = lineCosts?.[l.key] || null;
          const scoped = isDish && Array.isArray(l.order_types) && l.order_types.length;
          return (
            <div key={l.key} style={{ background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 9, padding: '8px 10px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <div style={{ flex: '1 1 160px', minWidth: 0 }}>
                  <div style={{ fontSize: 13, color: 'var(--t1)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{l.name || 'Stock item'}</div>
                  <div style={{ fontSize: 11, color: lc?.words ? 'var(--red)' : 'var(--t3)', marginTop: 1 }}>
                    {lc?.words ? lc.words : (l.kind_at_site === 'MADE' ? 'made item' : `base unit ${l.base_unit || 'each'}`)}
                  </div>
                </div>
                <span style={{ fontSize: 12, color: 'var(--t3)' }}>uses</span>
                <input type="number" min="0" step="any" value={l.qty ?? ''} disabled={disabled} aria-label={`Amount of ${l.name || 'the item'}`}
                  onChange={(e) => upd(l.key, { qty: e.target.value })} style={{ ...field, width: 76, ...off(disabled) }} />
                <select value={l.unit || l.base_unit || 'each'} disabled={disabled} aria-label={`Unit of ${l.name || 'the item'}`}
                  onChange={(e) => upd(l.key, { unit: e.target.value, pack_id: e.target.value.startsWith('@') ? e.target.value.slice(1) : null })}
                  style={{ ...field, width: 150, ...off(disabled) }}>
                  {lineUnitOptions(l).map((o) => <option key={o.token} value={o.token}>{o.label}</option>)}
                </select>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11.5, color: 'var(--t3)' }}>
                  usable
                  <input type="number" min="1" max="100" step="any" value={l.usable_pct ?? 100} disabled={disabled} aria-label={`Usable % of ${l.name || 'the item'}`}
                    onChange={(e) => upd(l.key, { usable_pct: e.target.value })} style={{ ...field, width: 60, ...off(disabled) }} />%
                </label>
                <span style={{ fontSize: 13, color: 'var(--t3)' }}>=</span>
                <span style={{ width: 74, textAlign: 'right', fontSize: 13, fontWeight: 600, color: lc?.words ? 'var(--red)' : 'var(--t1)', fontVariantNumeric: 'tabular-nums' }}>
                  {lc && lc.cost != null ? money(lc.cost) : (lc?.words ? 'none' : '')}
                </span>
                <button type="button" onClick={() => remove(l.key)} disabled={disabled} aria-label={`Remove ${l.name || 'the line'}`}
                  style={{ background: 'transparent', border: 0, color: 'var(--t3)', cursor: disabled ? 'default' : 'pointer', fontSize: 16, ...off(disabled) }}>x</button>
              </div>
              {isDish && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 7, paddingTop: 7, borderTop: '1px dashed var(--bdr)', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 11, color: 'var(--t3)' }}>Applies to</span>
                  <AppliesTo value={l.order_types} onChange={(v) => upd(l.key, { order_types: v })} disabled={disabled} />
                  {!scoped && <span style={{ fontSize: 11, color: 'var(--t4)' }}>shared across every order type</span>}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <ItemSearch search={itemPicker?.search} onPick={add} disabled={disabled} placeholder="Add an ingredient (search the company stock items)" />
    </div>
  );
}

/**
 * Applies to: which order types a line counts toward. No selection (or every type) = the shared
 * base recipe (stored as null), so the line applies to every order type.
 */
export function AppliesTo({ value, onChange, disabled = false }) {
  const [open, setOpen] = useState(false);
  const sel = Array.isArray(value) && value.length ? value : null;
  const summary = !sel ? 'All order types' : sel.map((t) => ORDER_TYPE_LABELS[t] || t).join(', ');
  const toggle = (t) => {
    const cur = new Set(sel || []);
    if (cur.has(t)) cur.delete(t); else cur.add(t);
    const arr = RECIPE_ORDER_TYPES.filter((x) => cur.has(x));
    onChange(arr.length === 0 || arr.length === RECIPE_ORDER_TYPES.length ? null : arr);
  };
  const row = (active, onClick, label) => (
    <button type="button" key={label} onClick={onClick} style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 12px', fontSize: 12, fontFamily: 'inherit', background: active ? 'var(--bg3)' : 'transparent', color: 'var(--t1)', border: 0, borderTop: '1px solid var(--bdr)', cursor: 'pointer' }}>{active ? 'Yes  ' : '      '}{label}</button>
  );
  return (
    <div style={{ position: 'relative' }}>
      <Btn small kind={sel ? 'soft' : 'ghost'} disabled={disabled} aria-expanded={open} onClick={() => { if (!disabled) setOpen((o) => !o); }} title="Choose which order types this ingredient applies to"
        style={sel ? { borderColor: 'var(--acc)' } : undefined}>{summary}</Btn>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 9 }} />
          <div style={{ position: 'absolute', zIndex: 10, top: '100%', left: 0, marginTop: 4, background: 'var(--bg2)', border: '1px solid var(--bdr)', borderRadius: 8, boxShadow: 'var(--sh3, 0 10px 30px rgba(0,0,0,0.3))', overflow: 'hidden', minWidth: 180 }}>
            <button type="button" onClick={() => { onChange(null); setOpen(false); }} style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 12px', fontSize: 12, fontWeight: 600, fontFamily: 'inherit', background: !sel ? 'var(--bg3)' : 'transparent', color: 'var(--t1)', border: 0, cursor: 'pointer' }}>{!sel ? 'Yes  ' : '      '}All order types</button>
            {RECIPE_ORDER_TYPES.map((t) => row(!!sel?.includes(t), () => toggle(t), ORDER_TYPE_LABELS[t]))}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * A search box with a list of matches under it. search(text) answers rows ({ id, name, hint }) or
 * a stockApi answer ({ data: { rows } }); onPick(row) is called with the row picked. `label` is
 * what the box shows when nothing is being typed (the current choice); `allowClear` adds a
 * 'None' row that picks null.
 */
export function SearchPick({ label = '', placeholder = 'Search', search, onPick, disabled = false, width = '100%', allowClear = false, clearWords = 'None', minChars = 0, style }) {
  const [q, setQ] = useState('');
  const [typing, setTyping] = useState(false);
  const [rows, setRows] = useState([]);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);
  const tooShort = q.trim().length < minChars;
  useEffect(() => {
    if (!typing || typeof search !== 'function' || tooShort) return undefined;
    const mine = ++seq.current;
    const t = setTimeout(async () => {
      setBusy(true);
      let r;
      try { r = await search(q.trim()); } catch { r = []; }
      if (mine !== seq.current) return;
      const list = Array.isArray(r) ? r : (r?.data?.rows || r?.rows || []);
      setRows(list.slice(0, 20));
      setBusy(false);
    }, 250);
    return () => clearTimeout(t);
  }, [q, typing, search, tooShort]);
  const shown = tooShort ? EMPTY : rows;
  const pick = (row) => { onPick?.(row); setQ(''); setTyping(false); };
  return (
    <div style={{ position: 'relative', width, ...style }}>
      <input value={typing ? q : (label || '')} placeholder={placeholder} disabled={disabled} aria-label={placeholder}
        onFocus={() => { setTyping(true); setQ(''); }}
        onBlur={() => setTimeout(() => setTyping(false), 180)}
        onChange={(e) => setQ(e.target.value)}
        style={{ ...field, ...off(disabled) }} />
      {typing && (busy || shown.length > 0 || allowClear) && (
        <div role="listbox" style={{ position: 'absolute', zIndex: 20, left: 0, right: 0, background: 'var(--bg2)', border: '1px solid var(--bdr)', borderRadius: 8, marginTop: 4, overflow: 'hidden', boxShadow: 'var(--sh3, 0 10px 30px rgba(0,0,0,0.3))', maxHeight: 280, overflowY: 'auto' }}>
          {allowClear && (
            <div role="option" aria-selected={false} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(null)} style={{ padding: '9px 12px', cursor: 'pointer', fontSize: 13, color: 'var(--t3)' }}>{clearWords}</div>
          )}
          {busy && <div style={{ padding: '9px 12px', fontSize: 12.5, color: 'var(--t3)' }}>Searching…</div>}
          {!busy && shown.map((r) => (
            <div key={r.id} role="option" aria-selected={false} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(r)}
              style={{ padding: '9px 12px', cursor: 'pointer', fontSize: 13, color: 'var(--t1)', display: 'flex', justifyContent: 'space-between', gap: 10 }}>
              <span>{r.name}</span>{r.hint && <span style={{ color: 'var(--t3)', fontSize: 11.5 }}>{r.hint}</span>}
            </div>
          ))}
          {!busy && !shown.length && !tooShort && q.trim() && <div style={{ padding: '9px 12px', fontSize: 12.5, color: 'var(--t3)' }}>Nothing matches.</div>}
        </div>
      )}
    </div>
  );
}

/** The company stock items search (stock_items_page), one row per item: name and its base unit. */
export function ItemSearch({ orgId = null, search = null, onPick, disabled = false, label = '', placeholder = 'Search the company stock items', allowClear = false, style }) {
  const run = useMemo(() => {
    if (typeof search === 'function') return search;
    return async (text) => {
      const r = await stockApi.itemsPage({ orgId, sites: null, search: text || null, filters: null, after: null, limit: 20 });
      return (r.data?.rows || []).map((row) => ({ id: row.id, name: row.name + (row.name_suffix ? ` ${row.name_suffix}` : ''), hint: row.base_unit || '', row }));
    };
  }, [orgId, search]);
  return <SearchPick label={label} placeholder={placeholder} search={run} onPick={(r) => onPick?.(r ? (r.row || r) : null)} disabled={disabled} allowClear={allowClear} style={style} />;
}

/** The tag of a line's order types, for read only tables. */
export function OrderTypeTag({ orderTypes }) {
  if (!Array.isArray(orderTypes) || !orderTypes.length) return null;
  return <Pill tone="neutral">{orderTypes.map((t) => ORDER_TYPE_LABELS[t] || t).join(', ')}</Pill>;
}
