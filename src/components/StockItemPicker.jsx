// StockItemPicker: pick stock items from a list that may hold 1,000 of them (16 Oct 2026).
//
// Peter: "it should show all the items from the supplier with filters and a search, what if we
// have 1,000 items". One picker for Spot check, Bulk assign and (builder B) transfer lines: a
// search box (name, SKU, supplier code), filter chips (area, category, supplier), a tick per row,
// "Select all 143 shown". Rows render 50 at a time: a sentinel at the bottom of the list adds
// the next 50 as it scrolls into view (IntersectionObserver), so 1,000 items is never 1,000
// rows in the DOM at once. The filter itself is pure (lib/stock/areaRules.js filterItems).
import { useEffect, useMemo, useRef, useState } from 'react';
import { filterItems, categoriesOf, visibleRows, RENDER_STEP } from '../lib/stock/areaRules';
import { displayInUnits } from '../lib/stock/uom';

const fieldStyle = { width: '100%', background: 'var(--bg2)', color: 'var(--t1)', border: '1px solid var(--bdr)', borderRadius: 6, padding: '8px 10px', fontSize: 13, outline: 'none', boxSizing: 'border-box' };
const chip = (on) => ({ fontSize: 11, padding: '4px 9px', borderRadius: 5, cursor: 'pointer', background: on ? 'var(--bg3)' : 'transparent', color: on ? 'var(--t1)' : 'var(--t3)', border: '1px solid ' + (on ? 'var(--bg3)' : 'var(--bdr2, var(--bdr))') });

/**
 * @param items      stock items (fetchInventoryItems shape: id, name, sku, category, areaId, supplierProducts, onHand, baseUnit, packaging)
 * @param areas      live areas [{ id, name }] (area chips; none = no area chips)
 * @param suppliers  [{ id, name }] (supplier chips; none = no supplier chips)
 * @param itemAreas  optional { itemId: areaId } (wins over item.areaId)
 * @param selected   array of item ids
 * @param onChange   (ids) => void
 * @param fixed      filters the caller fixes (e.g. { supplierId }) and the picker never shows chips for
 * @param rowRight   optional (item) => node, drawn at the right of each row
 * @param height     list height in px (default 360)
 */
export default function StockItemPicker({ items = [], areas = [], suppliers = [], itemAreas = null, selected = [], onChange, fixed = {}, rowRight = null, height = 360, emptyText = 'No stock items match.' }) {
  const [q, setQ] = useState('');
  const [areaId, setAreaId] = useState('any');
  const [category, setCategory] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const [chunks, setChunks] = useState(1);
  const sentinel = useRef(null);
  const listRef = useRef(null);

  const filters = useMemo(() => ({ q, areaId, category, supplierId: fixed.supplierId || supplierId, noAreaOnly: !!fixed.noAreaOnly, includeArchived: !!fixed.includeArchived }), [q, areaId, category, supplierId, fixed.supplierId, fixed.noAreaOnly, fixed.includeArchived]);
  const shown = useMemo(() => filterItems(items, filters, { itemAreas: itemAreas || {} }), [items, filters, itemAreas]);
  const categories = useMemo(() => categoriesOf(items), [items]);
  const sel = useMemo(() => new Set(selected || []), [selected]);
  const visible = visibleRows(shown.length, chunks, RENDER_STEP);

  // a new search or filter starts the list at the top again
  const restart = (setter) => (v) => { setter(v); setChunks(1); if (listRef.current) listRef.current.scrollTop = 0; };
  const changeQ = restart(setQ), changeArea = restart(setAreaId), changeCategory = restart(setCategory), changeSupplier = restart(setSupplierId);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || typeof IntersectionObserver !== 'function') return undefined;
    const io = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) setChunks((c) => (visibleRows(shown.length, c, RENDER_STEP) < shown.length ? c + 1 : c)); }, { root: listRef.current });
    io.observe(el);
    return () => io.disconnect();
  }, [shown.length, visible]);

  const toggle = (id) => { const n = new Set(sel); if (n.has(id)) n.delete(id); else n.add(id); onChange?.([...n]); };
  const selectShown = () => { const n = new Set(sel); shown.forEach((i) => n.add(i.id)); onChange?.([...n]); };
  const clearShown = () => { const n = new Set(sel); shown.forEach((i) => n.delete(i.id)); onChange?.([...n]); };
  const allShownOn = shown.length > 0 && shown.every((i) => sel.has(i.id));
  const areaNameOf = (item) => { const id = (itemAreas ? itemAreas[item.id] : item.areaId) || null; return id ? (areas.find((a) => a.id === id)?.name || '') : ''; };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
      <input value={q} onChange={(e) => changeQ(e.target.value)} placeholder="Search by name, SKU or supplier code" style={fieldStyle} />
      <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', alignItems: 'center' }}>
        {areas.length > 0 && !fixed.noAreaOnly && (
          <>
            <button onClick={() => changeArea('any')} style={chip(areaId === 'any')}>Any area</button>
            {areas.map((a) => <button key={a.id} onClick={() => changeArea(a.id)} style={chip(areaId === a.id)}>{a.name}</button>)}
            <button onClick={() => changeArea('none')} style={chip(areaId === 'none')}>No area</button>
          </>
        )}
        {categories.length > 0 && (
          <select value={category} onChange={(e) => changeCategory(e.target.value)} style={{ ...fieldStyle, width: 'auto', padding: '4px 8px', fontSize: 11 }}>
            <option value="">Any category</option>
            {categories.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        )}
        {suppliers.length > 0 && !fixed.supplierId && (
          <select value={supplierId} onChange={(e) => changeSupplier(e.target.value)} style={{ ...fieldStyle, width: 'auto', padding: '4px 8px', fontSize: 11 }}>
            <option value="">Any supplier</option>
            {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        )}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, color: 'var(--t3)' }}>
        <span>{shown.length.toLocaleString('en-GB')} shown · {sel.size.toLocaleString('en-GB')} ticked</span>
        {shown.length > 0 && (allShownOn
          ? <button onClick={clearShown} style={chip(false)}>Untick all {shown.length.toLocaleString('en-GB')} shown</button>
          : <button onClick={selectShown} style={chip(false)}>Select all {shown.length.toLocaleString('en-GB')} shown</button>)}
      </div>
      <div ref={listRef} style={{ height, overflowY: 'auto', border: '1px solid var(--bdr)', borderRadius: 8, background: 'var(--bg1)' }}>
        {shown.length === 0 && <div style={{ padding: 14, fontSize: 12.5, color: 'var(--t3)' }}>{emptyText}</div>}
        {shown.slice(0, visible).map((it) => {
          const on = sel.has(it.id);
          const oh = displayInUnits(Number(it.onHand || 0), { baseUnit: it.baseUnit, formats: it.packaging || [] });
          const area = areaNameOf(it);
          return (
            <label key={it.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderBottom: '1px solid var(--bg2)', cursor: 'pointer', background: on ? 'var(--bg2)' : 'transparent' }}>
              <input type="checkbox" checked={on} onChange={() => toggle(it.id)} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, color: 'var(--t1)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{it.name}</div>
                <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 1 }}>
                  {[it.sku, it.category, area || (areas.length ? 'No area' : null)].filter(Boolean).join(' · ')}
                </div>
              </div>
              <div style={{ fontSize: 12, color: 'var(--t2)', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>{oh.qty} {oh.label}</div>
              {rowRight ? <div style={{ flexShrink: 0 }}>{rowRight(it)}</div> : null}
            </label>
          );
        })}
        {visible < shown.length && (
          <div ref={sentinel} style={{ padding: 10, textAlign: 'center', fontSize: 11, color: 'var(--t4)' }}>
            Showing {visible.toLocaleString('en-GB')} of {shown.length.toLocaleString('en-GB')} ...
            <button onClick={() => setChunks((c) => c + 1)} style={{ ...chip(false), marginLeft: 8 }}>Show more</button>
          </div>
        )}
      </div>
    </div>
  );
}
