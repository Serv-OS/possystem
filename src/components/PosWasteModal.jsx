/**
 * PosWasteModal — staff-facing waste logging at the till, by MENU item.
 *
 * Staff search the menu they know ("Pint of Lager", "Cheeseburger"), pick what got
 * spilled / dropped / binned, and it comes off stock at cost. The chosen product is
 * exploded through its recipe (explodeBasket) and each ingredient posts a WASTE
 * movement + waste_events row via logWaste — so it shows in Wastage, The Gap and
 * theoretical COGS, exactly like the Back Office Wastage screen.
 *
 * Raw-ingredient waste (a dropped keg, a damaged case) is still done from
 * Back Office → Wastage; this till tool is deliberately menu-first.
 */

import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../store';
import { getActiveLocationSync } from '../lib/supabase';
import { logWaste, WASTE_REASONS } from '../lib/stock/waste';
import { buildDepletionCtx } from '../lib/stock/recipes';
import { explodeBasket } from '../lib/stock/explode';

const field = { width: '100%', background: 'var(--bg2)', color: 'var(--t1)', border: '1.5px solid var(--bdr2)', borderRadius: 10, padding: '12px 12px', fontSize: 15, outline: 'none', boxSizing: 'border-box', fontFamily: 'inherit' };
const lbl = { fontSize: 11, fontWeight: 800, color: 'var(--t4)', textTransform: 'uppercase', letterSpacing: '.07em', display: 'block', marginBottom: 6 };
const DEFAULT_REASON = WASTE_REASONS.includes('Breakage / spill') ? 'Breakage / spill' : WASTE_REASONS[0];

export default function PosWasteModal({ open, onClose, locationId, showToast }) {
  const menuItems = useStore(s => s.menuItems) || [];
  // Resolve the live POS (ops) location the same way the sale-depletion path does,
  // so recipes/stock are read against the right venue regardless of the device prop.
  const loc = getActiveLocationSync() || locationId || null;
  const [ctx, setCtx] = useState(null);
  const [ctxLoading, setCtxLoading] = useState(true);
  const [q, setQ] = useState('');
  const [product, setProduct] = useState(null);   // { id, label }
  const [qty, setQty] = useState(1);
  const [reason, setReason] = useState(DEFAULT_REASON);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  // Build the depletion context (menu→recipe→ingredients) once when the modal opens.
  useEffect(() => {
    if (!open) return;
    let live = true;
    setCtxLoading(true); setQ(''); setProduct(null); setQty(1); setReason(DEFAULT_REASON); setNote('');
    buildDepletionCtx(loc).then((c) => { if (live) { setCtx(c); setCtxLoading(false); } }).catch(() => { if (live) { setCtx(null); setCtxLoading(false); } });
    return () => { live = false; };
  }, [open, loc]);

  // Sellable products with parent-qualified names (hide variant containers + sub-items),
  // each tagged with whether it's recipe-linked (so we can show what will deduct from stock).
  const products = useMemo(() => {
    const byId = {}; menuItems.forEach(m => { byId[String(m.id)] = m; });
    const parents = new Set(menuItems.filter(m => m.parentId).map(m => String(m.parentId)));
    const label = (m) => { if (!m?.parentId) return m?.menuName || m?.name || ''; const p = byId[String(m.parentId)]; const n = (m.menuName || m.name || '').trim(); if (!p) return n; const pn = (p.menuName || p.name || ''); return n.toLowerCase().startsWith(pn.toLowerCase()) ? n : `${pn} ${n}`.trim(); };
    const linked = ctx?.menuRecipes || {};
    return menuItems
      .filter(m => !m.archived && m.type !== 'subitem' && !parents.has(String(m.id)))
      .map(m => ({ id: m.id, label: label(m), linked: !!linked[String(m.id)] }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [menuItems, ctx]);

  const matches = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return [];
    return products.filter(p => p.label.toLowerCase().includes(s)).slice(0, 8);
  }, [q, products]);

  const submit = async () => {
    if (!product) { showToast?.('Pick an item', 'error'); return; }
    const n = Number(qty);
    if (!(n > 0)) { showToast?.('Enter a quantity', 'error'); return; }
    setBusy(true);
    try {
      const c = ctx || await buildDepletionCtx(loc);
      const agg = explodeBasket([{ itemId: product.id, qty: n }], c);
      const entries = Object.entries(agg).filter(([, base]) => base > 0);
      if (!entries.length) {
        setBusy(false);
        showToast?.(`${product.label} isn’t linked to a recipe yet — link it in Back Office → Recipes to track its waste.`, 'error');
        return;
      }
      const fullNote = `Wasted ${n}× ${product.label}${note.trim() ? ` — ${note.trim()}` : ''}`;
      let failed = 0;
      for (const [invId, qtyBase] of entries) {
        const { error } = await logWaste({ inventoryItemId: invId, qty: qtyBase, unit: null, reason, note: fullNote, source: 'pos' }, loc);
        if (error) failed++;
      }
      setBusy(false);
      if (failed) showToast?.(`Logged, but ${failed} ingredient${failed === 1 ? '' : 's'} couldn’t be deducted`, 'error');
      else showToast?.(`Waste logged — ${n}× ${product.label}`, 'success');
      onClose?.();
    } catch (e) { setBusy(false); showToast?.(e?.message || 'Could not log waste', 'error'); }
  };

  if (!open) return null;
  const noRecipesAtAll = !ctxLoading && ctx && Object.keys(ctx.menuRecipes || {}).length === 0;
  return (
    <div className="modal-back" style={{ zIndex: 99999 }} onClick={e => e.target === e.currentTarget && onClose?.()}>
      <div style={{ background: 'var(--bg1)', border: '1px solid var(--bdr2)', borderRadius: 20, width: '100%', maxWidth: 440, padding: '22px 24px', boxShadow: 'var(--sh3)', maxHeight: '88vh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
          <div style={{ fontSize: 17, fontWeight: 800, color: 'var(--t1)' }}>Record waste</div>
          <button onClick={() => onClose?.()} style={{ background: 'transparent', border: 'none', fontSize: 24, color: 'var(--t4)', cursor: 'pointer', padding: 4 }}>×</button>
        </div>
        <div style={{ fontSize: 12, color: 'var(--t3)', marginBottom: 18 }}>Spilled, dropped or binned? Pick the menu item — its ingredients come off stock at cost.</div>

        {noRecipesAtAll ? (
          <div style={{ fontSize: 13, color: 'var(--t3)', lineHeight: 1.5 }}>No recipes are linked yet, so menu waste can’t deduct stock. Link recipes in <b>Back Office → Recipes</b>, then record waste here. Raw stock (a dropped keg, a damaged case) can be wasted from <b>Back Office → Wastage</b>.</div>
        ) : !product ? (
          <div style={{ position: 'relative' }}>
            <label style={lbl}>Menu item</label>
            <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder={ctxLoading ? 'Loading menu…' : 'Search the menu…'} style={field} />
            {matches.length > 0 && (
              <div style={{ position: 'absolute', zIndex: 5, left: 0, right: 0, background: 'var(--bg2)', border: '1px solid var(--bdr2)', borderRadius: 10, marginTop: 4, overflow: 'hidden', boxShadow: '0 12px 34px rgba(0,0,0,0.4)' }}>
                {matches.map(p => (
                  <div key={p.id} onClick={() => { setProduct(p); setQ(''); }} style={{ padding: '12px 14px', cursor: 'pointer', fontSize: 14, color: 'var(--t1)', borderBottom: '1px solid var(--bdr)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                    <span>{p.label}</span>
                    {!p.linked && <span style={{ fontSize: 10, color: 'var(--t4)', whiteSpace: 'nowrap' }}>no recipe</span>}
                  </div>
                ))}
              </div>
            )}
            {!ctxLoading && q.trim() && matches.length === 0 && <div style={{ fontSize: 12, color: 'var(--t4)', marginTop: 8 }}>No matching menu item.</div>}
          </div>
        ) : (
          <>
            <div style={{ ...field, display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
              <span style={{ fontWeight: 700 }}>{product.label}</span>
              <button onClick={() => setProduct(null)} style={{ background: 'transparent', border: 0, color: 'var(--acc)', cursor: 'pointer', fontWeight: 700, fontSize: 13 }}>change</button>
            </div>
            {!product.linked && <div style={{ fontSize: 11.5, color: 'var(--amb,#e8a020)', marginBottom: 12 }}>⚠ This item has no recipe linked, so nothing will come off stock. Link it in Back Office → Recipes.</div>}
            <div style={{ display: 'flex', gap: 10, marginTop: 10, marginBottom: 14 }}>
              <div style={{ flex: '0 0 110px' }}>
                <label style={lbl}>How many</label>
                <input type="number" min="1" step="1" value={qty} onChange={e => setQty(e.target.value)} style={{ ...field, fontWeight: 800, fontFamily: 'var(--font-mono)' }} />
              </div>
              <div style={{ flex: 1 }}>
                <label style={lbl}>Reason</label>
                <select value={reason} onChange={e => setReason(e.target.value)} style={field}>
                  {WASTE_REASONS.map(r => <option key={r} value={r}>{r}</option>)}
                </select>
              </div>
            </div>
            <div style={{ marginBottom: 18 }}>
              <label style={lbl}>Note (optional)</label>
              <input value={note} onChange={e => setNote(e.target.value)} placeholder="anything useful" style={field} />
            </div>
            <button onClick={submit} disabled={busy} style={{ width: '100%', padding: '14px', borderRadius: 12, border: 'none', background: 'var(--red,#cc5959)', color: '#fff', fontFamily: 'inherit', fontWeight: 800, fontSize: 15, cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1 }}>
              {busy ? 'Logging…' : 'Record waste'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
