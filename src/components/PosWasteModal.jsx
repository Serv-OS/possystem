/**
 * PosWasteModal — staff-facing waste logging at the till, by MENU item.
 *
 * Staff search EVERY selling item they know ("Pint of Lager", "Cheeseburger",
 * sold-alone extras), pick what got spilled / dropped / binned, and the system
 * works out the stock it uses from the recipe and takes it off at cost. Each
 * ingredient posts a WASTE movement + waste_events row via logWaste — so it shows
 * in Wastage, The Gap and theoretical COGS, exactly like the Back Office screen.
 *
 * Raw-ingredient waste (a dropped keg, a damaged case) is still done from
 * Back Office → Wastage; this till tool is deliberately menu-first.
 */

import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../store';
import { getActiveLocationSync } from '../lib/supabase';
import { money } from '../lib/currency';
import { logMenuItemWaste, WASTE_REASONS } from '../lib/stock/waste';
import { fetchInventoryItems } from '../lib/stock/data';
import { buildDepletionCtx } from '../lib/stock/recipes';
import { explodeBasket } from '../lib/stock/explode';
import { displayInUnits } from '../lib/stock/uom';

const field = { width: '100%', background: 'var(--bg2)', color: 'var(--t1)', border: '1.5px solid var(--bdr2)', borderRadius: 10, padding: '12px 12px', fontSize: 15, outline: 'none', boxSizing: 'border-box', fontFamily: 'inherit' };
const lbl = { fontSize: 11, fontWeight: 800, color: 'var(--t4)', textTransform: 'uppercase', letterSpacing: '.07em', display: 'block', marginBottom: 6 };
const DEFAULT_REASON = WASTE_REASONS.includes('Breakage / spill') ? 'Breakage / spill' : WASTE_REASONS[0];
// A "selling item" is anything the POS itself shows: normal products + sold-alone
// sub-items, minus variant containers (you waste the variant) and archived items.
const isSellingItem = (m, parents) => !m.archived && !(m.type === 'subitem' && !m.soldAlone) && !parents.has(String(m.id));

export default function PosWasteModal({ open, onClose, locationId, showToast }) {
  const menuItems = useStore(s => s.menuItems) || [];
  const loc = getActiveLocationSync() || locationId || null;
  const [ctx, setCtx] = useState(null);
  const [invById, setInvById] = useState({});   // inventory item id → { name, baseUnit, currentCost, formats }
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [product, setProduct] = useState(null);  // { id, label, linked }
  const [qty, setQty] = useState(1);
  const [reason, setReason] = useState(DEFAULT_REASON);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  // Load the recipe/depletion context + inventory costs once when the modal opens.
  useEffect(() => {
    if (!open) return;
    let live = true;
    setLoading(true); setQ(''); setProduct(null); setQty(1); setReason(DEFAULT_REASON); setNote('');
    Promise.all([buildDepletionCtx(loc), fetchInventoryItems(loc)]).then(([c, inv]) => {
      if (!live) return;
      const map = {};
      (inv?.data || []).forEach((it) => { map[it.id] = { name: it.name, baseUnit: it.baseUnit, currentCost: it.currentCost, formats: it.packaging || [] }; });
      setCtx(c); setInvById(map); setLoading(false);
    }).catch(() => { if (live) { setCtx(null); setLoading(false); } });
    return () => { live = false; };
  }, [open, loc]);

  // Every selling item with a parent-qualified name + whether it's recipe-linked.
  const products = useMemo(() => {
    const byId = {}; menuItems.forEach(m => { byId[String(m.id)] = m; });
    const parents = new Set(menuItems.filter(m => m.parentId).map(m => String(m.parentId)));
    const label = (m) => { if (!m?.parentId) return m?.menuName || m?.name || ''; const p = byId[String(m.parentId)]; const n = (m.menuName || m.name || '').trim(); if (!p) return n; const pn = (p.menuName || p.name || ''); return n.toLowerCase().startsWith(pn.toLowerCase()) ? n : `${pn} ${n}`.trim(); };
    const linked = ctx?.menuRecipes || {};
    const priceOf = (m) => Number(m.pricing?.base ?? m.price ?? 0);
    return menuItems
      .filter(m => isSellingItem(m, parents))
      .map(m => ({ id: m.id, label: label(m), linked: !!linked[String(m.id)], price: priceOf(m) }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [menuItems, ctx]);

  // Filtered list (or the whole menu when the box is empty) so staff can browse, not just type.
  const matches = useMemo(() => {
    const s = q.trim().toLowerCase();
    const list = s ? products.filter(p => p.label.toLowerCase().includes(s)) : products;
    return list.slice(0, 100);
  }, [q, products]);

  // Live stock impact of the selection: explode the product × qty through its recipe,
  // value each ingredient at its current (net) cost — the same numbers logWaste posts.
  const impact = useMemo(() => {
    if (!product || !ctx) return null;
    const n = Number(qty);
    if (!(n > 0)) return null;
    const agg = explodeBasket([{ itemId: product.id, qty: n }], ctx);
    const ingredients = Object.entries(agg).filter(([, base]) => base > 0).map(([invId, qtyBase]) => ({ inventoryItemId: invId, qtyBase }));
    const rows = ingredients.map(({ inventoryItemId: invId, qtyBase }) => {
      const it = invById[invId];
      const disp = it ? displayInUnits(qtyBase, { baseUnit: it.baseUnit, formats: it.formats }) : null;
      const cost = it && it.currentCost != null ? qtyBase * Number(it.currentCost) : null;
      return { invId, name: it?.name || 'Stock item', qtyLabel: disp ? `${disp.qty} ${disp.label}` : `${Math.round(qtyBase * 100) / 100}`, cost };
    });
    const totalCost = rows.reduce((s, r) => s + (r.cost || 0), 0);
    const lostSale = (Number(product.price) || 0) * n;   // forgone revenue at the menu price
    return { rows, ingredients, totalCost, lostSale };
  }, [product, qty, ctx, invById]);

  const submit = async () => {
    if (!product) { showToast?.('Pick an item', 'error'); return; }
    const n = Number(qty);
    if (!(n > 0)) { showToast?.('Enter a quantity', 'error'); return; }
    if (!impact || !impact.rows.length) {
      showToast?.(`${product.label} isn’t linked to a recipe yet — link it in Back Office → Recipes to track its waste.`, 'error');
      return;
    }
    setBusy(true);
    try {
      const { error } = await logMenuItemWaste({
        productName: product.label, qty: n, salePrice: product.price,
        ingredients: impact.ingredients, reason, note: note.trim() || null, source: 'pos',
      }, loc);
      setBusy(false);
      if (error) {
        // v5.5.928: never surface a raw RLS string to staff — it reads as gibberish and the
        // open modal gives no clue whether anything saved. (It has not: the event insert is
        // first, so a refusal here means NOTHING recorded.)
        const msg = /row-level security/i.test(error.message || '')
          ? 'This till is not allowed to record waste — re-pair the device or record it in Back Office → Wastage'
          : (error.message || 'Could not log waste');
        showToast?.(msg, 'error');
        return;
      }
      showToast?.(`Waste logged — ${n}× ${product.label} · lost sale ${money(impact.lostSale)}`, 'success');
      onClose?.();
    } catch (e) { setBusy(false); showToast?.(e?.message || 'Could not log waste', 'error'); }
  };

  if (!open) return null;
  const noRecipesAtAll = !loading && ctx && Object.keys(ctx.menuRecipes || {}).length === 0;
  return (
    <div className="modal-back" style={{ zIndex: 99999 }} onClick={e => e.target === e.currentTarget && onClose?.()}>
      <div style={{ background: 'var(--bg1)', border: '1px solid var(--bdr2)', borderRadius: 20, width: '100%', maxWidth: 540, padding: '24px 26px', boxShadow: 'var(--sh3)', maxHeight: '92vh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
          <div style={{ fontSize: 17, fontWeight: 800, color: 'var(--t1)' }}>Record waste</div>
          <button onClick={() => onClose?.()} style={{ background: 'transparent', border: 'none', fontSize: 24, color: 'var(--t4)', cursor: 'pointer', padding: 4 }}>×</button>
        </div>
        <div style={{ fontSize: 12, color: 'var(--t3)', marginBottom: 18 }}>Spilled, dropped or binned? Pick the menu item — the system works out the stock it uses and takes it off at cost.</div>

        {noRecipesAtAll ? (
          <div style={{ fontSize: 13, color: 'var(--t3)', lineHeight: 1.5 }}>No recipes are linked yet, so menu waste can’t deduct stock. Link recipes in <b>Back Office → Recipes</b>, then record waste here. Raw stock (a dropped keg, a damaged case) can be wasted from <b>Back Office → Wastage</b>.</div>
        ) : !product ? (
          <div>
            <label style={lbl}>Menu item</label>
            <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder={loading ? 'Loading menu…' : 'Search or browse the menu…'} style={field} />
            <div style={{ marginTop: 8, maxHeight: '48vh', overflowY: 'auto', border: '1px solid var(--bdr)', borderRadius: 10 }}>
              {loading ? (
                <div style={{ padding: '16px', fontSize: 13, color: 'var(--t4)' }}>Loading menu…</div>
              ) : matches.length === 0 ? (
                <div style={{ padding: '16px', fontSize: 13, color: 'var(--t4)' }}>{q.trim() ? 'No matching menu item.' : 'No menu items found.'}</div>
              ) : matches.map(p => (
                <div key={p.id} onClick={() => { setProduct(p); setQ(''); }} style={{ padding: '12px 14px', cursor: 'pointer', fontSize: 14, color: 'var(--t1)', borderBottom: '1px solid var(--bdr)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                  <span>{p.label}</span>
                  <span style={{ display: 'flex', gap: 10, alignItems: 'center', flexShrink: 0 }}>
                    {p.price > 0 && <span style={{ fontSize: 12.5, color: 'var(--t3)', fontVariantNumeric: 'tabular-nums' }}>{money(p.price)}</span>}
                    {!p.linked && <span style={{ fontSize: 10, color: 'var(--t4)', whiteSpace: 'nowrap' }}>no recipe</span>}
                  </span>
                </div>
              ))}
            </div>
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

            {impact && impact.rows.length > 0 && (
              <div style={{ background: 'var(--bg2)', border: '1px solid var(--bdr)', borderRadius: 10, padding: '10px 12px', marginBottom: 14 }}>
                <div style={{ fontSize: 11, fontWeight: 800, color: 'var(--t4)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6 }}>Comes off stock</div>
                {impact.rows.map(r => (
                  <div key={r.invId} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 13, color: 'var(--t2)', padding: '2px 0' }}>
                    <span>{r.qtyLabel} · {r.name}</span>
                    <span style={{ color: 'var(--t1)', fontVariantNumeric: 'tabular-nums' }}>{r.cost == null ? '—' : money(r.cost)}</span>
                  </div>
                ))}
                <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid var(--bdr)', marginTop: 6, paddingTop: 6, fontSize: 13.5, fontWeight: 700, color: 'var(--t2)' }}>
                  <span>Stock cost</span><span style={{ fontVariantNumeric: 'tabular-nums' }}>{money(impact.totalCost)}</span>
                </div>
                {impact.lostSale > 0 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4, fontSize: 14, fontWeight: 800, color: 'var(--red,#cc5959)' }}>
                    <span>Lost sale</span><span style={{ fontVariantNumeric: 'tabular-nums' }}>{money(impact.lostSale)}</span>
                  </div>
                )}
              </div>
            )}

            <div style={{ marginBottom: 18 }}>
              <label style={lbl}>Note (optional)</label>
              <input value={note} onChange={e => setNote(e.target.value)} placeholder="anything useful" style={field} />
            </div>
            <button onClick={submit} disabled={busy} style={{ width: '100%', padding: '14px', borderRadius: 12, border: 'none', background: 'var(--red,#cc5959)', color: '#fff', fontFamily: 'inherit', fontWeight: 800, fontSize: 15, cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1 }}>
              {busy ? 'Logging…' : impact && impact.rows.length ? `Record waste — ${money(impact.totalCost)}` : 'Record waste'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
