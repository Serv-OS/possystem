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
 *
 * 26 Sep 2026, Peter: "people still like to waste things and should be able to without
 * stock". A venue with no stock items and no recipes used to see only a message here.
 * Now the menu always lists and, at a venue with no stock, a product with no recipe records
 * as a product waste (qty, reason, note, lost sale; nothing comes off stock because there is
 * none). A failed stock read blocks the record rather than guessing.
 *
 * v5.11.79 (multi site stock plan, Phase 0, 4.7 and 11.5 item 8):
 *   - NEVER refused. A product with no recipe (or a recipe that takes nothing off) is recorded by
 *     product with the lost sale and tagged "No recipe: stock not taken off", at a venue with stock
 *     too, so the day a venue gets its first stock item till waste keeps working.
 *   - The till no longer reads the whole recipe book and item list to log one waste. It reads which
 *     products have a recipe (one paged read of the links) and asks the database for the one product
 *     picked (stock_record_waste, preview). Recording is one database call that explodes that product
 *     and writes the waste row (with the product id) and its stock movements together.
 *   - Before 20261019a is run those calls are missing: the screen falls back to the old reads.
 */

import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../store';
import { getActiveLocationSync } from '../lib/supabase';
import { money } from '../lib/currency';
import { logMenuItemWaste, fetchWasteLinks, previewMenuWaste, WASTE_REASONS } from '../lib/stock/waste';
import { listWasteProducts, wasteTag, countLiveStockItems, stockPresence } from '../lib/stock/menuWaste';
import { wasteTagText } from '../lib/stock/phase0Rules';
import { fetchInventoryItems } from '../lib/stock/data';
import { buildDepletionCtx } from '../lib/stock/recipes';
import { explodeBasket } from '../lib/stock/explode';
import { displayInUnits } from '../lib/stock/uom';

const field = { width: '100%', background: 'var(--bg2)', color: 'var(--t1)', border: '1.5px solid var(--bdr2)', borderRadius: 10, padding: '12px 12px', fontSize: 15, outline: 'none', boxSizing: 'border-box', fontFamily: 'inherit' };
const lbl = { fontSize: 11, fontWeight: 800, color: 'var(--t4)', textTransform: 'uppercase', letterSpacing: '.07em', display: 'block', marginBottom: 6 };
const DEFAULT_REASON = WASTE_REASONS.includes('Breakage / spill') ? 'Breakage / spill' : WASTE_REASONS[0];
const qtyWords = (q) => `${Math.round(Number(q) * 100) / 100}`;

export default function PosWasteModal({ open, onClose, locationId, showToast }) {
  const menuItems = useStore(s => s.menuItems) || [];
  const loc = getActiveLocationSync() || locationId || null;
  // v5.11.79: which products have a recipe (menu item id -> true), from the links only.
  const [links, setLinks] = useState(null);
  // 26 Sep 2026: stock items that are not archived: only live ones say "this venue runs stock".
  const [liveStockCount, setLiveStockCount] = useState(0);
  // v5.11.79: the old reads (recipe book + items), only when the database calls are missing.
  const [legacy, setLegacy] = useState(null);   // { ctx, invById } | null
  const [preview, setPreview] = useState(null); // { rows, totalCost, tag } for the picked product
  // 26 Sep 2026: a stock read failed. Said on screen and Record is disabled, not just a toast.
  const [loadFailed, setLoadFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [product, setProduct] = useState(null);  // { id, label, linked, price }
  const [qty, setQty] = useState(1);
  const [reason, setReason] = useState(DEFAULT_REASON);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  // Load which products have a recipe, and whether the venue runs stock, once when the modal opens.
  useEffect(() => {
    if (!open) return;
    let live = true;
    setLoading(true); setLoadFailed(false); setQ(''); setProduct(null); setQty(1); setReason(DEFAULT_REASON); setNote('');
    setLegacy(null); setPreview(null);
    // 26 Sep 2026 (waste without stock review): "not loaded" = links null, so hasStock stays false,
    // the header keeps the old copy, the failure line shows and Record is disabled.
    const failed = () => { setLinks(null); setLiveStockCount(0); setLoadFailed(true); setLoading(false); };
    fetchWasteLinks(loc).then((r) => {
      if (!live) return;
      if (r?.error) { failed(); return; }
      setLinks(r.links || {}); setLiveStockCount(Number(r.liveStockItems) || 0); setLoading(false);
    }).catch(() => { if (live) failed(); });
    return () => { live = false; };
  }, [open, loc]);

  // Every selling item with a parent-qualified name + whether it's recipe-linked
  // (pure, tested in lib/stock/menuWaste.test.js; the list never depends on stock existing).
  const products = useMemo(() => listWasteProducts(menuItems, links), [menuItems, links]);
  // Does this venue run stock at all? Only once the reads succeeded (rules in lib/stock/menuWaste.js).
  const { hasStock, recipesMissing } = stockPresence({ loaded: !!links, linkedRecipes: Object.keys(links || {}).length, liveStockItems: liveStockCount });

  // Filtered list (or the whole menu when the box is empty) so staff can browse, not just type.
  const matches = useMemo(() => {
    const s = q.trim().toLowerCase();
    const list = s ? products.filter(p => p.label.toLowerCase().includes(s)) : products;
    return list.slice(0, 100);
  }, [q, products]);

  // The stock the picked product takes off, worked out by the database for this ONE product
  // (v5.11.79). Missing call (20261019a not run): the old reads, once, and the old explosion.
  const previewKey = product ? `${product.id}|${qty}` : '';
  useEffect(() => {
    if (!open || !product || !links) return;
    const n = Number(qty);
    if (!(n > 0)) return;
    let live = true;
    const key = `${product.id}|${qty}`;
    const fromLegacy = (lg) => {
      const agg = explodeBasket([{ itemId: product.id, qty: n }], lg.ctx);
      const rows = Object.entries(agg).filter(([, base]) => base > 0).map(([invId, qtyBase]) => {
        const it = lg.invById[invId];
        const disp = it ? displayInUnits(qtyBase, { baseUnit: it.baseUnit, formats: it.formats }) : null;
        return { invId, qtyBase, name: it?.name || 'Stock item', qtyLabel: disp ? `${disp.qty} ${disp.label}` : qtyWords(qtyBase), cost: it && it.currentCost != null ? qtyBase * Number(it.currentCost) : null };
      });
      return { key, rows, totalCost: rows.reduce((t, r) => t + (r.cost || 0), 0), legacy: true };
    };
    (async () => {
      if (legacy) { if (live) setPreview(fromLegacy(legacy)); return; }
      const r = await previewMenuWaste({ menuItemId: product.id, qty: n }, loc);
      if (!live) return;
      if (r.missing) {
        const [c, inv] = await Promise.all([buildDepletionCtx(loc), fetchInventoryItems(loc)]);
        if (!live) return;
        if (inv?.error || c?.error) { setLoadFailed(true); return; }
        const invById = {};
        (inv?.data || []).forEach((it) => { invById[it.id] = { name: it.name, baseUnit: it.baseUnit, currentCost: it.currentCost, formats: it.packaging || [] }; });
        const lg = { ctx: c, invById };
        setLegacy(lg); setLiveStockCount(countLiveStockItems(inv?.data)); setPreview(fromLegacy(lg));
        return;
      }
      if (r.error || !r.data) { setLoadFailed(true); return; }
      const rows = (r.data.lines || []).map((l) => ({ invId: l.item_id, qtyBase: Number(l.qty_base), name: l.name || 'Stock item', qtyLabel: `${qtyWords(l.qty_base)} ${l.base_unit || ''}`.trim(), cost: l.cost == null ? null : Number(l.cost) }));
      setPreview({ key, rows, totalCost: Number(r.data.cost_value) || 0, tag: r.data.tag || null, legacy: false });
    })().catch(() => { if (live) setLoadFailed(true); });
    return () => { live = false; };
  }, [open, product, qty, links, legacy, loc]);

  // the preview of THIS product and quantity only (an older answer is never shown for a new pick)
  const shown = preview && preview.key === previewKey ? preview : null;
  const lostSale = product ? (Number(product.price) || 0) * (Number(qty) || 0) : 0;   // forgone revenue at the menu price
  // v5.11.79: why nothing comes off stock (never a refusal; rule in lib/stock/menuWaste.js).
  const tag = product && shown ? wasteTag({ hasStock, linked: product.linked, rows: shown.rows }) : null;

  const submit = async () => {
    if (!product) { showToast?.('Pick an item', 'error'); return; }
    const n = Number(qty);
    if (!(n > 0)) { showToast?.('Enter a quantity', 'error'); return; }
    // A failed stock read still stops a record: we cannot tell a no stock venue from a network
    // blip. Nothing else does (v5.11.79: waste is never refused).
    if (!links || loadFailed) { showToast?.('Stock data did not load, close and try again', 'error'); return; }
    setBusy(true);
    try {
      const { error, training, tag: savedTag } = await logMenuItemWaste({
        menuItemId: product.id, productName: product.label, qty: n, salePrice: product.price,
        ingredients: shown?.legacy ? shown.rows.map((r) => ({ inventoryItemId: r.invId, qtyBase: r.qtyBase })) : null,
        reason, note: note.trim() || null, source: 'pos',
      }, loc);
      setBusy(false);
      if (error) {
        // v5.5.928: never surface a raw RLS string to staff — it reads as gibberish and the
        // open modal gives no clue whether anything saved. (It has not: one call, all or nothing.)
        const msg = /row-level security|42501/i.test(`${error.code || ''} ${error.message || ''}`)
          ? 'This till is not allowed to record waste — re-pair the device or record it in Back Office → Wastage'
          : (error.message || 'Could not log waste');
        showToast?.(msg, 'error');
        return;
      }
      // 26 Sep 2026: a Training Mode till writes nothing (lib/stock/waste.js). Close as done so
      // the practice flow is the real one, but never say "Waste logged" for a row that is not there.
      if (training) { showToast?.('Training mode: waste not recorded', 'info'); onClose?.(); return; }
      const why = hasStock && (savedTag || tag) ? ` · ${savedTag === 'nothing_to_deduct' || tag === 'nothing_to_deduct' ? 'its recipe takes nothing off stock' : 'No recipe: stock not taken off'}` : '';
      showToast?.(`Waste logged — ${n}× ${product.label} · lost sale ${money(lostSale)}${why}`, 'success');
      onClose?.();
    } catch (e) { setBusy(false); showToast?.(e?.message || 'Could not log waste', 'error'); }
  };

  if (!open) return null;
  // 26 Sep 2026: the old "No recipes are linked yet" screen is gone. It hid the whole
  // menu from every venue without stock, which is exactly the venue Peter means.
  return (
    <div className="modal-back" style={{ zIndex: 99999 }} onClick={e => e.target === e.currentTarget && onClose?.()}>
      <div style={{ background: 'var(--bg1)', border: '1px solid var(--bdr2)', borderRadius: 20, width: '100%', maxWidth: 540, padding: '24px 26px', boxShadow: 'var(--sh3)', maxHeight: '92vh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
          <div style={{ fontSize: 17, fontWeight: 800, color: 'var(--t1)' }}>Record waste</div>
          <button onClick={() => onClose?.()} style={{ background: 'transparent', border: 'none', fontSize: 24, color: 'var(--t4)', cursor: 'pointer', padding: 4 }}>×</button>
        </div>
        {/* 26 Sep 2026: "No stock is set up here" is only said once every stock read succeeded
            and came back empty; while loading or after a failed load it is the old copy. */}
        <div style={{ fontSize: 12, color: 'var(--t3)', marginBottom: 18 }}>
          {loading || !links || hasStock
            ? 'Spilled, dropped or binned? Pick the menu item — the system works out the stock it uses and takes it off at cost.'
            : 'Spilled, dropped or binned? Pick the menu item, how many and why. No stock is set up here, so it is recorded by product with the lost sale.'}
        </div>
        {/* 26 Sep 2026: a failed stock read is said here, once, and Record below is disabled. */}
        {loadFailed && (
          <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--red,#cc5959)', marginTop: -10, marginBottom: 14 }}>Stock data did not load, close and try again</div>
        )}
        {/* Stock items but no recipe linked at all: say once that menu waste records with no stock taken off. */}
        {!loading && !loadFailed && recipesMissing && (
          <div style={{ fontSize: 12, color: 'var(--amb,#e8a020)', lineHeight: 1.45, marginTop: -10, marginBottom: 14 }}>{'Stock items exist but no recipes are linked yet, so menu waste is recorded with the lost sale and no stock taken off. Link recipes in Back Office > Recipes.'}</div>
        )}

        {!product ? (
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
                    {hasStock && !p.linked && <span style={{ fontSize: 10, color: 'var(--t4)', whiteSpace: 'nowrap' }}>no recipe</span>}
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
            {/* v5.11.79: never a refusal, a plain note why nothing comes off stock. */}
            {tag && <div style={{ fontSize: 11.5, color: 'var(--amb,#e8a020)', marginBottom: 12 }}>{wasteTagText(tag === 'nothing_to_deduct' ? 'nothing_to_deduct' : 'no_recipe')}</div>}
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

            {shown && shown.rows.length > 0 && (
              <div style={{ background: 'var(--bg2)', border: '1px solid var(--bdr)', borderRadius: 10, padding: '10px 12px', marginBottom: 14 }}>
                <div style={{ fontSize: 11, fontWeight: 800, color: 'var(--t4)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6 }}>Comes off stock</div>
                {shown.rows.map(r => (
                  <div key={r.invId} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 13, color: 'var(--t2)', padding: '2px 0' }}>
                    <span>{r.qtyLabel} · {r.name}</span>
                    <span style={{ color: 'var(--t1)', fontVariantNumeric: 'tabular-nums' }}>{r.cost == null ? '—' : money(r.cost)}</span>
                  </div>
                ))}
                <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid var(--bdr)', marginTop: 6, paddingTop: 6, fontSize: 13.5, fontWeight: 700, color: 'var(--t2)' }}>
                  <span>Stock cost</span><span style={{ fontVariantNumeric: 'tabular-nums' }}>{money(shown.totalCost)}</span>
                </div>
                {lostSale > 0 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4, fontSize: 14, fontWeight: 800, color: 'var(--red,#cc5959)' }}>
                    <span>Lost sale</span><span style={{ fontVariantNumeric: 'tabular-nums' }}>{money(lostSale)}</span>
                  </div>
                )}
              </div>
            )}
            {/* No stock lines: the lost sale is the one number worth confirming before saving. */}
            {shown && shown.rows.length === 0 && lostSale > 0 && (
              <div style={{ display: 'flex', justifyContent: 'space-between', background: 'var(--bg2)', border: '1px solid var(--bdr)', borderRadius: 10, padding: '10px 12px', marginBottom: 14, fontSize: 14, fontWeight: 800, color: 'var(--red,#cc5959)' }}>
                <span>Lost sale</span><span style={{ fontVariantNumeric: 'tabular-nums' }}>{money(lostSale)}</span>
              </div>
            )}

            <div style={{ marginBottom: 18 }}>
              <label style={lbl}>Note (optional)</label>
              <input value={note} onChange={e => setNote(e.target.value)} placeholder="anything useful" style={field} />
            </div>
            {/* 26 Sep 2026: disabled after a failed stock read (loadFailed), same as while saving. */}
            <button onClick={submit} disabled={busy || loadFailed} style={{ width: '100%', padding: '14px', borderRadius: 12, border: 'none', background: 'var(--red,#cc5959)', color: '#fff', fontFamily: 'inherit', fontWeight: 800, fontSize: 15, cursor: busy || loadFailed ? 'default' : 'pointer', opacity: busy || loadFailed ? 0.6 : 1 }}>
              {busy ? 'Logging…' : shown && shown.rows.length ? `Record waste — ${money(shown.totalCost)}` : 'Record waste'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
