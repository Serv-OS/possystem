/**
 * StockItems — back-office master for STOCK items (the things you hold/buy/make),
 * distinct from menu_items. Slice 1 of the Stock & Production system.
 *
 *  • Left pane: searchable, filterable item list (Purchased / Made / archived).
 *  • Right pane: tabbed editor —
 *      General           — name, type, base unit, category, allergens, storage…
 *      Dimension & Measure — base unit + cross-dimension conversion bridges
 *      Packaging         — pack-of-packs formats
 *      Suppliers         — per-supplier packs with LIVE pack→unit cost (the
 *                          crate-of-24 → £1.6667 maths) + preferred selection.
 *
 * Costing maths comes from src/lib/stock/costing.js; persistence from
 * src/lib/stock/data.js. Child collections (suppliers/conversions/packaging) save
 * immediately to the DB once the item exists and re-derive current_cost.
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useStore } from '../../store';
import { ALLERGENS } from '../../data/seed';
import { getActiveLocationSync, getLocationId } from '../../lib/supabase';
import { money, currencySymbol } from '../../lib/currency';
import { formatRateLabel, purchaseNet } from '../../lib/tax';
import { UNITS, DIMENSIONS } from '../../lib/stock/units';
import {
  fetchInventoryItems, upsertInventoryItem, setInventoryItemArchived,
  fetchSuppliers, upsertSupplier,
  upsertSupplierProduct, deleteSupplierProduct,
  upsertItemConversion, deleteItemConversion,
  upsertPackagingFormat, deletePackagingFormat, setUnitDefault,
  setInventoryOnHand, fetchItemMovements, movementLabel,
} from '../../lib/stock/data';
import { fetchParLevels, upsertParLevel } from '../../lib/stock/counts';
import { reportSave } from '../../lib/saveHealth';
import { fetchRecipes, upsertRecipe, replaceRecipeLines, recomputeMadeItemCost } from '../../lib/stock/recipes';
import { toBase, fromBase, unitOptions, formatToken, unitLabel, displayInUnits } from '../../lib/stock/uom';

const KINDS = [
  { id: 'PURCHASED', label: 'Purchased', desc: 'Bought from a supplier — cost comes from invoices/packs.' },
  { id: 'MADE', label: 'Made here', desc: 'Produced from other items — cost rolls up from its recipe.' },
];
const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'PURCHASED', label: 'Purchased' },
  { id: 'MADE', label: 'Made' },
  { id: 'archived', label: 'Archived' },
];
const TABS = ['General', 'Units', 'Stock', 'Suppliers', 'Dimension & Measure'];

const UNIT_OPTS = Object.entries(UNITS).map(([code, u]) => ({ code, ...u }));
const DIM_ORDER = [DIMENSIONS.COUNT, DIMENSIONS.WEIGHT, DIMENSIONS.VOLUME];

const blankItem = () => ({
  name: '', kind: 'PURCHASED', baseUnit: 'each', category: '', accountingGroup: '',
  isTracked: true, isSellable: false, allergens: [], storageLocation: '', shelfLifeDays: '',
  sku: '', barcode: '', notes: '', currentCost: null, conversions: [], supplierProducts: [], packaging: [],
});

/** Format a per-unit cost with up to 4dp (unit costs are often fractions of a penny). */
function fmtUnitCost(v) {
  if (v == null || !Number.isFinite(Number(v))) return '—';
  return currencySymbol() + Number(v).toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}

function UnitSelect({ value, onChange, style }) {
  return (
    <select value={value || ''} onChange={e => onChange(e.target.value)}
      style={{ background: 'var(--bg2)', color: 'var(--t1)', border: '1px solid var(--bdr)', borderRadius: 6, padding: '7px 8px', fontSize: 13, ...style }}>
      {DIM_ORDER.map(dim => (
        <optgroup key={dim} label={dim[0] + dim.slice(1).toLowerCase()}>
          {UNIT_OPTS.filter(u => u.dimension === dim).map(u => (
            <option key={u.code} value={u.code}>{u.label} ({u.code})</option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

const fieldStyle = { width: '100%', background: 'var(--bg2)', color: 'var(--t1)', border: '1px solid var(--bdr)', borderRadius: 6, padding: '8px 10px', fontSize: 13, outline: 'none', boxSizing: 'border-box' };
const labelStyle = { display: 'block', fontSize: 11, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 5 };

function Field({ label, children }) {
  return <div style={{ marginBottom: 14 }}><label style={labelStyle}>{label}</label>{children}</div>;
}

export default function StockItems() {
  const showToast = useStore(s => s.showToast);
  const [locId, setLocId] = useState(getActiveLocationSync());
  const [items, setItems] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [selectedId, setSelectedId] = useState(null);
  const [draft, setDraft] = useState(null);
  const [tab, setTab] = useState('General');
  const [saving, setSaving] = useState(false);

  const reload = useCallback(async (keepId) => {
    const loc = locId || getActiveLocationSync() || await getLocationId().catch(() => null);
    if (loc && loc !== locId) setLocId(loc);
    const [{ data: its }, { data: sups }] = await Promise.all([fetchInventoryItems(loc), fetchSuppliers(loc)]);
    setItems(its || []);
    setSuppliers(sups || []);
    setLoading(false);
    if (keepId) {
      const found = (its || []).find(i => i.id === keepId);
      if (found) { setDraft(structuredClone(found)); setSelectedId(keepId); }
    }
  }, [locId]);

  useEffect(() => { reload(); /* eslint-disable-next-line */ }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter(i => {
      if (filter === 'archived') { if (!i.archivedAt) return false; }
      else if (i.archivedAt) return false;
      if (filter === 'PURCHASED' && i.kind !== 'PURCHASED') return false;
      if (filter === 'MADE' && i.kind !== 'MADE') return false;
      if (q && !(`${i.name} ${i.category || ''} ${i.sku || ''}`.toLowerCase().includes(q))) return false;
      return true;
    });
  }, [items, search, filter]);

  const select = (it) => { setDraft(structuredClone(it)); setSelectedId(it.id); setTab('General'); };
  const startNew = () => { setDraft(blankItem()); setSelectedId(null); setTab('General'); };
  const upd = (k, v) => setDraft(d => ({ ...d, [k]: v }));

  const saveGeneral = async () => {
    if (!draft?.name?.trim()) { showToast?.('Name is required', 'error'); return; }
    setSaving(true);
    const { data, error } = await upsertInventoryItem(draft, locId);
    setSaving(false);
    reportSave('stock item', error);
    if (error) { showToast?.('Save failed: ' + error.message, 'error'); return; }
    showToast?.('Saved', 'success');
    await reload(data?.id || selectedId);
  };

  const toggleArchive = async () => {
    if (!draft?.id) return;
    const next = !draft.archivedAt;
    const { error } = await setInventoryItemArchived(draft.id, next, locId);
    reportSave('stock item archive', error);
    if (error) { showToast?.(error.message, 'error'); return; }
    showToast?.(next ? 'Archived' : 'Restored', 'info');
    setSelectedId(null); setDraft(null);
    await reload();
  };

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', height: '100%', minHeight: 0, background: 'var(--bg0)' }}>
      {/* ── Left list ── */}
      <aside style={{ borderRight: '1px solid var(--bdr)', background: 'var(--bg1)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div style={{ padding: 14, position: 'relative' }}>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search stock items…"
            style={{ ...fieldStyle, paddingRight: 40 }} />
          <button onClick={startNew} title="New stock item"
            style={{ position: 'absolute', top: 14, right: 16, width: 28, height: 28, borderRadius: 6, background: 'var(--acc)', color: '#fff', border: 0, fontSize: 18, lineHeight: 1, cursor: 'pointer' }}>+</button>
          <div style={{ display: 'flex', gap: 5, marginTop: 10, flexWrap: 'wrap' }}>
            {FILTERS.map(f => (
              <button key={f.id} onClick={() => setFilter(f.id)} style={{
                fontSize: 11, padding: '4px 9px', borderRadius: 5, cursor: 'pointer',
                background: filter === f.id ? 'var(--bg3)' : 'transparent', color: filter === f.id ? 'var(--t1)' : 'var(--t3)',
                border: '1px solid ' + (filter === f.id ? 'var(--bg3)' : 'var(--bdr2, var(--bdr))'),
              }}>{f.label}</button>
            ))}
          </div>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
          {loading && <div style={{ padding: 16, color: 'var(--t3)', fontSize: 13 }}>Loading…</div>}
          {!loading && filtered.length === 0 && (
            <div style={{ padding: 16, color: 'var(--t3)', fontSize: 13 }}>
              No stock items yet. Press <b>+</b> to add one (e.g. a crate of cans, a bag of flour, a prep batch).
            </div>
          )}
          {filtered.map(it => {
            const sel = it.id === selectedId;
            return (
              <div key={it.id} onClick={() => select(it)} style={{
                display: 'flex', alignItems: 'center', padding: '10px 16px', gap: 11, cursor: 'pointer',
                borderLeft: '3px solid ' + (sel ? 'var(--acc)' : 'transparent'),
                background: sel ? 'var(--bg2)' : 'transparent',
              }}>
                <div style={{ width: 34, height: 34, borderRadius: 7, background: 'var(--bg3)', flexShrink: 0, display: 'grid', placeItems: 'center', fontSize: 15 }}>
                  {it.kind === 'MADE' ? '🍲' : '📦'}
                </div>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 13, color: 'var(--t1)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{it.name}</div>
                  <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 2, display: 'flex', gap: 8 }}>
                    {(() => { const oh = displayInUnits(Number(it.onHand || 0), { baseUnit: it.baseUnit, formats: it.packaging || [] }); return <span style={{ color: 'var(--t2)' }}>{oh.qty} {oh.label}</span>; })()}
                    <span>· {fmtUnitCost(it.currentCost)}/{it.baseUnit}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </aside>

      {/* ── Right editor ── */}
      <main style={{ display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
        {!draft && (
          <div style={{ display: 'grid', placeItems: 'center', height: '100%', color: 'var(--t3)', textAlign: 'center', padding: 24 }}>
            <div>
              <div style={{ fontSize: 40, marginBottom: 10 }}>📦</div>
              <div style={{ fontSize: 15, color: 'var(--t2)' }}>Select a stock item, or press + to add one.</div>
              <div style={{ fontSize: 12, marginTop: 6, maxWidth: 360 }}>
                Stock items are what you hold and buy or make — separate from menu products. Link them to dishes with recipes (coming next).
              </div>
            </div>
          </div>
        )}

        {draft && (
          <>
            {/* header */}
            <div style={{ padding: '16px 22px', borderBottom: '1px solid var(--bdr)', display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 200 }}>
                <h1 style={{ fontSize: 21, fontWeight: 600, margin: 0, color: 'var(--t1)' }}>{draft.name || 'New stock item'}</h1>
                <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 3 }}>
                  {draft.kind === 'MADE' ? 'Made here' : 'Purchased'} · base unit {draft.baseUnit}
                  {draft.archivedAt && <span style={{ color: 'var(--red, #ef4444)' }}> · archived</span>}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 22, textAlign: 'right' }}>
                <div>
                  <div style={{ fontSize: 11, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.05em' }}>On hand</div>
                  {(() => { const oh = displayInUnits(Number(draft.onHand || 0), { baseUnit: draft.baseUnit, formats: draft.packaging || [] }); return <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--t1)' }}>{oh.qty}<span style={{ fontSize: 12, color: 'var(--t3)' }}> {oh.label}</span></div>; })()}
                </div>
                <div>
                  <div style={{ fontSize: 11, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.05em' }}>Current cost</div>
                  <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--t1)' }}>{fmtUnitCost(draft.currentCost)}<span style={{ fontSize: 12, color: 'var(--t3)' }}> /{draft.baseUnit}</span></div>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.05em' }}>Value</div>
                  <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--t1)' }}>{draft.currentCost != null ? money(Number(draft.onHand || 0) * Number(draft.currentCost)) : '—'}</div>
                </div>
              </div>
              {draft.id && (
                <button onClick={toggleArchive} style={{ padding: '8px 14px', borderRadius: 8, cursor: 'pointer', background: 'var(--bg2)', border: '1px solid var(--bdr)', color: 'var(--t2)', fontSize: 13 }}>
                  {draft.archivedAt ? 'Restore' : 'Archive'}
                </button>
              )}
            </div>

            {/* tabs */}
            <div style={{ display: 'flex', gap: 4, padding: '10px 22px 0', borderBottom: '1px solid var(--bdr)' }}>
              {/* v5.5.925 — the tabs follow what the item IS. A made-here item has no
                  supplier: asking for one was the model leaking through the screen. It has a
                  RECIPE instead, edited right here — not on a separate screen someone has to
                  know exists. */}
              {(draft.kind === 'MADE' ? ['General', 'Units', 'Stock', 'Recipe', 'Dimension & Measure'] : TABS).map(t => (
                <button key={t} onClick={() => setTab(t)} style={{
                  padding: '8px 14px', fontSize: 13, cursor: 'pointer', background: 'transparent', border: 0,
                  color: tab === t ? 'var(--t1)' : 'var(--t3)', fontWeight: tab === t ? 700 : 400,
                  borderBottom: '2px solid ' + (tab === t ? 'var(--acc)' : 'transparent'), marginBottom: -1,
                }}>{t}</button>
              ))}
            </div>

            <div style={{ flex: 1, overflowY: 'auto', padding: '20px 22px', minHeight: 0 }}>
              {tab === 'General' && <GeneralTab draft={draft} upd={upd} onSave={saveGeneral} saving={saving} />}
              {tab === 'Stock' && <StockTab draft={draft} locId={locId} onChanged={() => reload(draft.id)} showToast={showToast} />}
              {tab === 'Dimension & Measure' && <DimensionTab draft={draft} locId={locId} onChanged={() => reload(draft.id)} showToast={showToast} />}
              {tab === 'Units' && <UnitsTab draft={draft} locId={locId} onChanged={() => reload(draft.id)} showToast={showToast} />}
              {tab === 'Suppliers' && draft.kind !== 'MADE' && <SuppliersTab draft={draft} suppliers={suppliers} locId={locId} onChanged={() => reload(draft.id)} onSupplierAdded={() => reload(draft.id)} showToast={showToast} />}
              {tab === 'Recipe' && draft.kind === 'MADE' && <RecipeTab draft={draft} items={items} locId={locId} showToast={showToast} onChanged={() => reload(draft.id)} />}
            </div>
          </>
        )}
      </main>
    </div>
  );
}

// ── General tab ───────────────────────────────────────────────────────────────
function GeneralTab({ draft, upd, onSave, saving }) {
  const taxRates = useStore(s => s.taxRates) || [];
  return (
    <div style={{ maxWidth: 640 }}>
      <Field label="Name"><input value={draft.name} onChange={e => upd('name', e.target.value)} style={fieldStyle} placeholder="e.g. Coca-Cola 330ml can" /></Field>

      <Field label="Type">
        <div style={{ display: 'flex', gap: 8 }}>
          {KINDS.map(k => (
            <button key={k.id} onClick={() => upd('kind', k.id)} style={{
              flex: 1, textAlign: 'left', padding: '10px 12px', borderRadius: 8, cursor: 'pointer',
              background: draft.kind === k.id ? 'var(--acc-d, rgba(249,115,22,0.10))' : 'var(--bg2)',
              border: '1.5px solid ' + (draft.kind === k.id ? 'var(--acc)' : 'var(--bdr)'),
            }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: draft.kind === k.id ? 'var(--acc)' : 'var(--t1)' }}>{k.label}</div>
              <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 2 }}>{k.desc}</div>
            </button>
          ))}
        </div>
      </Field>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <Field label="Base (stocking/costing) unit"><UnitSelect value={draft.baseUnit} onChange={v => upd('baseUnit', v)} style={{ width: '100%' }} /></Field>
        <Field label="Category"><input value={draft.category || ''} onChange={e => upd('category', e.target.value)} style={fieldStyle} placeholder="e.g. Soft drinks" /></Field>
        <Field label="Accounting group"><input value={draft.accountingGroup || ''} onChange={e => upd('accountingGroup', e.target.value)} style={fieldStyle} placeholder="e.g. Beverages" /></Field>
        <Field label="Storage location"><input value={draft.storageLocation || ''} onChange={e => upd('storageLocation', e.target.value)} style={fieldStyle} placeholder="e.g. Dry store" /></Field>
        <Field label="Shelf life (days)"><input type="number" min="0" value={draft.shelfLifeDays ?? ''} onChange={e => upd('shelfLifeDays', e.target.value)} style={fieldStyle} /></Field>
        <Field label="SKU / code"><input value={draft.sku || ''} onChange={e => upd('sku', e.target.value)} style={fieldStyle} /></Field>
        <Field label="Purchase VAT (input tax)">
          <select value={draft.purchaseTaxRateId || ''} onChange={e => upd('purchaseTaxRateId', e.target.value || null)} style={fieldStyle}>
            <option value="">No VAT / zero-rated</option>
            {taxRates.filter(r => r.active !== false).map(r => <option key={r.id} value={r.id}>{formatRateLabel(r)}</option>)}
          </select>
        </Field>
      </div>
      <div style={{ fontSize: 11, color: 'var(--t4)', margin: '-6px 0 14px' }}>The VAT you pay on this item when you buy it (e.g. 20% on alcohol). Cost &amp; GP always use the ex-VAT price; this drives VAT on POs/invoices and your input-VAT reclaim.</div>

      <Field label="Tracking">
        <div style={{ display: 'flex', gap: 18 }}>
          <label style={{ display: 'flex', gap: 7, alignItems: 'center', fontSize: 13, color: 'var(--t2)', cursor: 'pointer' }}>
            <input type="checkbox" checked={draft.isTracked !== false} onChange={e => upd('isTracked', e.target.checked)} /> Track stock & deplete on use
          </label>
          <label style={{ display: 'flex', gap: 7, alignItems: 'center', fontSize: 13, color: 'var(--t2)', cursor: 'pointer' }}>
            <input type="checkbox" checked={draft.isSellable === true} onChange={e => upd('isSellable', e.target.checked)} /> Sold directly (also a menu item)
          </label>
        </div>
      </Field>

      <Field label="Allergens">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {(ALLERGENS || []).map(a => {
            const id = a.id || a;
            const lbl = a.label || a.name || a;
            const on = (draft.allergens || []).includes(id);
            return (
              <button key={id} onClick={() => upd('allergens', on ? draft.allergens.filter(x => x !== id) : [...(draft.allergens || []), id])}
                style={{ fontSize: 12, padding: '5px 10px', borderRadius: 6, cursor: 'pointer', background: on ? 'var(--bg3)' : 'var(--bg2)', color: on ? 'var(--t1)' : 'var(--t3)', border: '1px solid ' + (on ? 'var(--acc)' : 'var(--bdr)') }}>
                {lbl}
              </button>
            );
          })}
        </div>
      </Field>

      <Field label="Notes"><textarea value={draft.notes || ''} onChange={e => upd('notes', e.target.value)} style={{ ...fieldStyle, minHeight: 60, resize: 'vertical' }} /></Field>

      <button onClick={onSave} disabled={saving} className="btn btn-acc" style={{ padding: '10px 22px', borderRadius: 8, background: 'var(--acc)', color: '#fff', border: 0, fontSize: 14, fontWeight: 700, cursor: 'pointer', opacity: saving ? 0.6 : 1 }}>
        {saving ? 'Saving…' : draft.id ? 'Save changes' : 'Create item'}
      </button>
    </div>
  );
}

// ── Stock tab (on-hand + set count + movement ledger / reconciliation) ────────
function StockTab({ draft, locId, onChanged, showToast }) {
  const [moves, setMoves] = useState(null);
  const [count, setCount] = useState('');
  const [busy, setBusy] = useState(false);
  // v5.5.919 — par/reorder are STORED in base units (the order-pad maths and the low-stock
  // alert depend on that contract) but EDITED in the unit the operator actually thinks in.
  // parBase mirrors the server; parEdit holds what is in the inputs, in `countUnit`.
  const [parBase, setParBase] = useState({ parLevel: '', reorderPoint: '' });
  const [parEdit, setParEdit] = useState({ parLevel: '', reorderPoint: '' });
  const [countUnit, setCountUnit] = useState(() => { const fmts = draft.packaging || []; const cd = fmts.find(f => f.isCountDefault) || fmts[0]; return cd ? formatToken(cd.id) : draft.baseUnit; });

  const loadMoves = useCallback(async () => {
    if (!draft.id) return;
    const { data } = await fetchItemMovements(draft.id, locId);
    setMoves(data || []);
  }, [draft.id, locId]);
  const loadPar = useCallback(async () => {
    if (!draft.id) return;
    const { data } = await fetchParLevels(locId);
    const p = data?.[draft.id];
    setParBase({ parLevel: p?.parLevel ?? '', reorderPoint: p?.reorderPoint ?? '' });
  }, [draft.id, locId]);
  useEffect(() => { loadMoves(); loadPar(); }, [loadMoves, loadPar]);

  // Count in whatever unit the operator picks (Keg / Case / base) — convert to base.
  const uomItem = {
    baseUnit: draft.baseUnit,
    itemConversions: (draft.conversions || []).map(c => ({ fromQty: c.fromQty, fromUnit: c.fromUnit, toQty: c.toQty, toUnit: c.toUnit })),
    formats: (draft.packaging || []).map(f => ({ id: f.id, name: f.name, qtyInBase: f.qtyInBase })),
  };
  // Par shown in the same unit the operator counts in (Bottle, Case…), never raw ml/g.
  // fromBase/toBase are exact multiply/divide against the pack size, so round-tripping a
  // whole number of bottles is lossless. Stored values remain BASE UNITS — see above.
  const parToEdit = (base) => {
    if (base === '' || base == null) return '';
    const v = fromBase(Number(base), countUnit, uomItem);
    return v == null ? String(base) : String(Math.round(v * 1000) / 1000);
  };
  // Every hook must sit above the `!draft.id` early return below, or the hook order
  // changes the first time an unsaved item gets an id.
  useEffect(() => {
    setParEdit({ parLevel: parToEdit(parBase.parLevel), reorderPoint: parToEdit(parBase.reorderPoint) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parBase.parLevel, parBase.reorderPoint, countUnit]);

  if (!draft.id) return <NeedSaveFirst />;

  const onHand = Number(draft.onHand || 0);
  const cost = draft.currentCost;
  const belowReorder = parBase.reorderPoint !== '' && onHand <= Number(parBase.reorderPoint);

  // Count only in the item's named units when it has them; ml/base stays hidden.
  const countOpts = uomItem.formats.length
    ? [...uomItem.formats].sort((a, b) => b.qtyInBase - a.qtyInBase).map(f => ({ token: formatToken(f.id), label: f.name }))
    : [{ token: uomItem.baseUnit, label: uomItem.baseUnit }];
  let countBase = null;
  if (count !== '' && Number(count) >= 0) { try { countBase = toBase(Number(count), countUnit, uomItem); } catch { countBase = null; } }
  const savePar = async (edit) => {
    const conv = (v) => {
      if (v === '' || v == null) return '';
      try { const b = toBase(Number(v), countUnit, uomItem); return Number.isFinite(b) ? b : ''; } catch { return ''; }
    };
    const nextBase = { parLevel: conv(edit.parLevel), reorderPoint: conv(edit.reorderPoint) };
    const prevBase = parBase;
    setParBase(nextBase);
    const { error } = await upsertParLevel(draft.id, nextBase, locId);
    reportSave('par level', error);
    // Par/reorder drive suggested ordering and the low-stock alert — a rejected value
    // left in the box would have staff ordering to a number the system doesn't hold.
    if (error) { setParBase(prevBase); showToast?.('Par / reorder point NOT saved', 'error'); }
  };
  const parUnitLabel = (countOpts.find(o => o.token === countUnit)?.label) || draft.baseUnit;

  const applyCount = async () => {
    if (countBase == null || !(countBase >= 0)) { showToast?.('Enter a count', 'error'); return; }
    setBusy(true);
    const { error } = await setInventoryOnHand(draft.id, countBase, 'Set via Stock items', locId);
    setBusy(false);
    reportSave('stock on-hand', error);
    if (error) { showToast?.(error.message, 'error'); return; }
    setCount(''); showToast?.('Stock updated', 'success');
    onChanged(); await loadMoves();
  };

  // Running balance, computed from newest → oldest (balance after newest = on-hand).
  let running = onHand;
  const rows = (moves || []).map((m) => { const r = { ...m, balanceAfter: running }; running -= m.qtyBase; return r; });

  return (
    <div style={{ maxWidth: 820 }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, marginBottom: 18, flexWrap: 'wrap' }}>
        <Field label="Set count (how much you have now)">
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="number" min="0" step="any" value={count} onChange={e => setCount(e.target.value)} placeholder="0" style={{ ...fieldStyle, width: 100 }} />
            <select value={countUnit} onChange={e => setCountUnit(e.target.value)} style={{ ...fieldStyle, width: 150 }}>
              {countOpts.map(o => <option key={o.token} value={o.token}>{o.label}</option>)}
            </select>
            <button onClick={applyCount} disabled={busy} style={{ padding: '8px 16px', borderRadius: 7, background: 'var(--acc)', color: '#fff', border: 0, cursor: 'pointer', fontSize: 13, fontWeight: 700, opacity: busy ? 0.6 : 1 }}>Update stock</button>
            {countBase != null && countUnit !== draft.baseUnit && <span style={{ fontSize: 11, color: 'var(--t4)' }}>= {Math.round(countBase * 1000) / 1000} {draft.baseUnit}</span>}
          </div>
        </Field>
        <div style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--t3)' }}>
          Stock value: <b style={{ color: 'var(--t1)', fontSize: 14 }}>{cost != null ? money(onHand * cost) : '—'}</b>
        </div>
      </div>

      {/* Par & reorder (drives low-stock + future suggested ordering) */}
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, marginBottom: 18, flexWrap: 'wrap' }}>
        <Field label={`Par level (${parUnitLabel})`}>
          <input type="number" min="0" step="any" value={parEdit.parLevel} onChange={e => setParEdit(p => ({ ...p, parLevel: e.target.value }))} onBlur={() => savePar(parEdit)} placeholder="target" style={{ ...fieldStyle, width: 120 }} />
        </Field>
        <Field label={draft.kind === 'MADE' ? `Make more when below (${parUnitLabel})` : `Reorder at (${parUnitLabel})`}>
          <input type="number" min="0" step="any" value={parEdit.reorderPoint} onChange={e => setParEdit(p => ({ ...p, reorderPoint: e.target.value }))} onBlur={() => savePar(parEdit)} placeholder="min before reorder" style={{ ...fieldStyle, width: 140 }} />
        </Field>
        {countUnit !== draft.baseUnit && parBase.parLevel !== '' && (
          <div style={{ fontSize: 11, color: 'var(--t4)', paddingBottom: 10 }}>
            = {Math.round(Number(parBase.parLevel) * 1000) / 1000} {draft.baseUnit} par
            {parBase.reorderPoint !== '' && <> · reorder at {Math.round(Number(parBase.reorderPoint) * 1000) / 1000} {draft.baseUnit}</>}
          </div>
        )}
        {belowReorder && <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--red, #ef4444)', paddingBottom: 8 }}>{draft.kind === 'MADE' ? '⚠ below the make-more level — batch needed' : '⚠ at/below reorder point — time to order'}</div>}
      </div>

      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 8 }}>
        Movement history
      </div>
      {moves == null && <div style={{ fontSize: 12, color: 'var(--t3)' }}>Loading…</div>}
      {moves && moves.length === 0 && <div style={{ fontSize: 12, color: 'var(--t3)' }}>No movements yet. Set a count above to start the ledger. Deliveries, production, waste and sales will appear here.</div>}
      {moves && moves.length > 0 && (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
          <thead>
            <tr style={{ color: 'var(--t3)', textAlign: 'left' }}>
              {['Date', 'Type', 'Qty', 'Unit cost', 'Value', 'Balance', 'Note'].map((h, i) => (
                <th key={h} style={{ padding: '6px 8px', borderBottom: '1px solid var(--bdr)', textAlign: i >= 2 && i <= 5 ? 'right' : 'left', fontWeight: 600 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(m => {
              const pos = m.qtyBase >= 0;
              return (
                <tr key={m.id} style={{ color: 'var(--t1)' }}>
                  <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--bg2)', color: 'var(--t3)' }}>{new Date(m.occurredAt).toLocaleString()}</td>
                  <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--bg2)' }}>{movementLabel(m.movementType)}</td>
                  <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--bg2)', textAlign: 'right', color: pos ? 'var(--grn, #16a34a)' : 'var(--red, #ef4444)' }}>{pos ? '+' : ''}{m.qtyBase}</td>
                  <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--bg2)', textAlign: 'right', color: 'var(--t3)' }}>{fmtUnitCost(m.unitCost)}</td>
                  <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--bg2)', textAlign: 'right' }}>{m.valueDelta == null ? '—' : money(m.valueDelta)}</td>
                  <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--bg2)', textAlign: 'right', color: 'var(--t2)' }}>{m.balanceAfter}</td>
                  <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--bg2)', color: 'var(--t3)' }}>{m.notes || ''}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ── Dimension & Measure tab (cross-dimension conversion bridges) ──────────────
function DimensionTab({ draft, locId, onChanged, showToast }) {
  const [row, setRow] = useState({ fromQty: 1, fromUnit: draft.baseUnit, toQty: '', toUnit: 'g' });
  if (!draft.id) return <NeedSaveFirst />;
  const dim = UNITS[draft.baseUnit]?.dimension;

  const add = async () => {
    if (!(Number(row.fromQty) > 0) || !(Number(row.toQty) > 0)) { showToast?.('Enter both quantities', 'error'); return; }
    const { error, partial } = await upsertItemConversion({ inventoryItemId: draft.id, ...row }, locId);
    reportSave('unit conversion', error);
    if (error) { showToast?.(error.message, 'error'); return; }
    // `partial` means the bridge saved but its cost recompute did not. Clear the form and
    // reload anyway — treating it as a failure would leave the operator re-saving a row
    // that already exists.
    if (partial) showToast?.(partial, 'warning');
    setRow({ fromQty: 1, fromUnit: draft.baseUnit, toQty: '', toUnit: 'g' });
    onChanged();
  };
  const remove = async (id) => {
    const { error } = await deleteItemConversion(id, draft.id, locId);
    reportSave('unit conversion delete', error);
    if (error) { showToast?.('Bridge NOT removed — recipe conversions still use it', 'error'); return; }
    onChanged();
  };

  return (
    <div style={{ maxWidth: 680 }}>
      <p style={{ fontSize: 13, color: 'var(--t2)', marginTop: 0 }}>
        Base unit is <b>{draft.baseUnit}</b> ({dim?.toLowerCase()}). Add a bridge whenever you buy or recipe in a
        <i> different dimension</i> — e.g. buy onions by the each but recipe in grams: <b>1 each = 110 g</b>.
        Same-dimension conversions (kg↔g, L↔ml) are automatic.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
        {(draft.conversions || []).length === 0 && <div style={{ fontSize: 12, color: 'var(--t3)' }}>No bridges yet.</div>}
        {(draft.conversions || []).map(c => (
          <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 7, padding: '8px 12px' }}>
            <span style={{ fontSize: 13, color: 'var(--t1)' }}>{c.fromQty} {c.fromUnit} = {c.toQty} {c.toUnit}</span>
            <button onClick={() => remove(c.id)} style={{ marginLeft: 'auto', background: 'transparent', border: 0, color: 'var(--t3)', cursor: 'pointer', fontSize: 16 }}>×</button>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
        <input type="number" min="0" step="any" value={row.fromQty} onChange={e => setRow(r => ({ ...r, fromQty: e.target.value }))} style={{ ...fieldStyle, width: 70 }} />
        <UnitSelect value={row.fromUnit} onChange={v => setRow(r => ({ ...r, fromUnit: v }))} />
        <span style={{ color: 'var(--t3)' }}>=</span>
        <input type="number" min="0" step="any" value={row.toQty} onChange={e => setRow(r => ({ ...r, toQty: e.target.value }))} style={{ ...fieldStyle, width: 70 }} placeholder="qty" />
        <UnitSelect value={row.toUnit} onChange={v => setRow(r => ({ ...r, toUnit: v }))} />
        <button onClick={add} style={{ padding: '8px 16px', borderRadius: 7, background: 'var(--acc)', color: '#fff', border: 0, cursor: 'pointer', fontSize: 13, fontWeight: 700 }}>Add bridge</button>
      </div>
    </div>
  );
}

// ── Packaging tab (pack-of-packs) ─────────────────────────────────────────────
function UnitsTab({ draft, locId, onChanged, showToast }) {
  // Both useStates must sit above the `!draft.id` early return below, or the hook
  // order changes the first time an unsaved item gets an id.
  const [row, setRow] = useState({ name: '', qty: '', of: draft.baseUnit });
  const [adding, setAdding] = useState(false);
  if (!draft.id) return <NeedSaveFirst />;
  const formats = draft.packaging || [];
  const ofOptions = [{ value: draft.baseUnit, label: draft.baseUnit, qtyInBase: 1 }, ...formats.map(f => ({ value: String(f.id), label: f.name, qtyInBase: f.qtyInBase }))];
  const previewBase = (() => { const o = ofOptions.find(o => String(o.value) === String(row.of)); return (Number(row.qty) || 0) * (o?.qtyInBase || 0); })();

  const add = async () => {
    if (!row.name.trim()) { showToast?.('Give the unit a name (e.g. Keg)', 'error'); return; }
    if (!(Number(row.qty) > 0)) { showToast?.('Enter a size (e.g. 50)', 'error'); return; }
    const o = ofOptions.find(x => String(x.value) === String(row.of));
    const qtyInBase = Number(row.qty) * (o?.qtyInBase || 0);
    if (!(qtyInBase > 0)) { showToast?.('Invalid size', 'error'); return; }
    const parentFormatId = (o && String(o.value) !== String(draft.baseUnit)) ? o.value : null;
    const isFirst = formats.length === 0;
    setAdding(true);
    try {
      const { error } = await upsertPackagingFormat({ inventoryItemId: draft.id, name: row.name.trim(), qtyInBase, parentFormatId, isCountDefault: isFirst, isPurchaseDefault: isFirst }, locId);
      reportSave('packaging unit', error);
      if (error) { showToast?.('Could not add unit: ' + (error.message || error), 'error'); return; }
      showToast?.(`Unit added: ${row.name.trim()}`, 'success');
      setRow({ name: '', qty: '', of: draft.baseUnit });
      onChanged();
    } catch (e) {
      reportSave('packaging unit', e);
      showToast?.('Could not add unit: ' + (e?.message || e), 'error');
    } finally { setAdding(false); }
  };
  const remove = async (id) => {
    const { error } = await deletePackagingFormat(id, locId);
    reportSave('packaging unit delete', error);
    if (error) { showToast?.('Unit NOT removed', 'error'); return; }
    onChanged();
  };
  const makeDefault = async (id, kind) => {
    const { error } = await setUnitDefault(id, draft.id, kind, locId);
    reportSave('default unit', error);
    // The buy default decides the quantities and prices that go onto purchase orders,
    // so a badge that moved without the row moving would misprice every future PO.
    if (error) { showToast?.(`Could not set the ${kind === 'purchase' ? 'buy' : 'count'} unit`, 'error'); return; }
    onChanged();
  };

  const sizeLabel = (p) => {
    if (p.parentFormatId) {
      const parent = formats.find(f => String(f.id) === String(p.parentFormatId));
      if (parent && parent.qtyInBase > 0) return `${Math.round((p.qtyInBase / parent.qtyInBase) * 1000) / 1000} × ${parent.name}  (${p.qtyInBase} ${draft.baseUnit})`;
    }
    return `${p.qtyInBase} ${draft.baseUnit}`;
  };

  return (
    <div style={{ maxWidth: 680 }}>
      <p style={{ fontSize: 13, color: 'var(--t2)', marginTop: 0 }}>
        Define the units your staff actually use — <b>Keg</b>, <b>Case</b>, <b>Bottle</b>, <b>175ml glass</b>. You then
        <b> buy, count and sell</b> in these; the maths happens in the background in {draft.baseUnit} (which staff never see).
        A unit can be made of another (e.g. <b>Case = 6 × Bottle</b>).
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
        {formats.length === 0 && <div style={{ fontSize: 12, color: 'var(--t3)' }}>No units yet — add one below (e.g. Keg = 50 l).</div>}
        {formats.map(p => (
          <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 8, padding: '9px 14px' }}>
            <span style={{ fontSize: 13, color: 'var(--t1)', fontWeight: 600, minWidth: 90 }}>1 {p.name}</span>
            <span style={{ fontSize: 12, color: 'var(--t3)' }}>= {sizeLabel(p)}</span>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
              {p.isCountDefault ? <span style={badge('count')}>📋 count</span> : <button onClick={() => makeDefault(p.id, 'count')} style={ghostBtn}>set count</button>}
              {p.isPurchaseDefault ? <span style={badge('buy')}>🛒 buy</span> : <button onClick={() => makeDefault(p.id, 'purchase')} style={ghostBtn}>set buy</button>}
              <button onClick={() => remove(p.id)} style={{ background: 'transparent', border: 0, color: 'var(--t3)', cursor: 'pointer', fontSize: 16 }}>×</button>
            </div>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, flexWrap: 'wrap', background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 10, padding: 14 }}>
        <span style={{ fontSize: 13, color: 'var(--t3)', paddingBottom: 8 }}>1</span>
        <input value={row.name} onChange={e => setRow(r => ({ ...r, name: e.target.value }))} placeholder="Keg / Case / Bottle / 175ml glass" style={{ ...fieldStyle, width: 200 }} />
        <span style={{ fontSize: 13, color: 'var(--t3)', paddingBottom: 8 }}>=</span>
        <input type="number" min="0" step="any" value={row.qty} onChange={e => setRow(r => ({ ...r, qty: e.target.value }))} placeholder="50" style={{ ...fieldStyle, width: 80 }} />
        <select value={row.of} onChange={e => setRow(r => ({ ...r, of: e.target.value }))} style={{ ...fieldStyle, width: 150 }}>
          {ofOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <button onClick={add} disabled={adding} style={{ padding: '8px 16px', borderRadius: 7, background: 'var(--acc)', color: '#fff', border: 0, cursor: 'pointer', fontSize: 13, fontWeight: 700, opacity: adding ? 0.6 : 1 }}>{adding ? 'Adding…' : 'Add unit'}</button>
        {previewBase > 0 && <div style={{ fontSize: 11, color: 'var(--t4)', width: '100%', marginTop: 4 }}>= {previewBase} {draft.baseUnit}</div>}
      </div>
    </div>
  );
}
const badge = () => ({ fontSize: 10, fontWeight: 700, color: 'var(--acc)', padding: '3px 7px', borderRadius: 20, background: 'var(--acc-d, rgba(249,115,22,0.12))' });
const ghostBtn = { fontSize: 10, padding: '3px 7px', borderRadius: 6, background: 'var(--bg2)', border: '1px solid var(--bdr)', color: 'var(--t3)', cursor: 'pointer' };

// ── Suppliers tab (pack → unit cost) ──────────────────────────────────────────
function SuppliersTab({ draft, suppliers, locId, onChanged, showToast }) {
  const [adding, setAdding] = useState(false);
  const [row, setRow] = useState(null);
  const [newSupplier, setNewSupplier] = useState('');
  const taxRates = useStore(s => s.taxRates) || [];
  const ratesById = useMemo(() => { const m = {}; taxRates.forEach(r => { m[r.id] = r; }); return m; }, [taxRates]);
  if (!draft.id) return <NeedSaveFirst />;
  // Effective purchase VAT for a row: its override → the item default → none.
  const rateObjFor = (r) => ratesById[(r && r.purchaseTaxRateId) || draft.purchaseTaxRateId] || null;
  const rateDecFor = (r) => Number(rateObjFor(r)?.rate || 0);

  const uomItem = {
    baseUnit: draft.baseUnit,
    itemConversions: (draft.conversions || []).map(c => ({ fromQty: c.fromQty, fromUnit: c.fromUnit, toQty: c.toQty, toUnit: c.toUnit })),
    formats: (draft.packaging || []).map(f => ({ id: f.id, name: f.name, qtyInBase: f.qtyInBase })),
  };
  const buyOpts = unitOptions(uomItem);
  const defaultBuyToken = (() => { const pd = (draft.packaging || []).find(f => f.isPurchaseDefault) || (draft.packaging || [])[0]; return pd ? formatToken(pd.id) : draft.baseUnit; })();
  const contentBase = (r) => { try { return toBase(Number(r.buyQty) || 0, r.buyUnit, uomItem); } catch { return null; } };
  // preview is the NET cost per base unit (strip VAT only when the price is inc-VAT).
  const netPackOf = (r) => purchaseNet(Number(r.packPrice), r.priceIncludesTax, rateDecFor(r));
  const preview = (r) => { const c = contentBase(r); const net = netPackOf(r); return (c && c > 0 && net != null) ? net / c : null; };
  const unitBad = (r) => contentBase(r) == null;

  const startAdd = () => {
    setRow({ inventoryItemId: draft.id, supplierId: suppliers[0]?.id || '', supplierSku: '', buyQty: 1, buyUnit: defaultBuyToken, packPrice: '', priceIncludesTax: false, purchaseTaxRateId: '', isPreferred: (draft.supplierProducts || []).length === 0 });
    setAdding(true);
  };
  const saveRow = async () => {
    if (!row.supplierId) { showToast?.('Pick or add a supplier first', 'error'); return; }
    if (!(Number(row.packPrice) >= 0)) { showToast?.('Enter a price', 'error'); return; }
    const content = contentBase(row);
    if (!(content > 0)) { showToast?.('Pick a valid buy unit', 'error'); return; }
    const sp = {
      id: row.id, inventoryItemId: draft.id, supplierId: row.supplierId, supplierSku: row.supplierSku || '',
      packQty: 1, innerQty: content, innerUnit: draft.baseUnit, packPrice: Number(row.packPrice),
      packDescription: `${Number(row.buyQty) > 1 ? Number(row.buyQty) + ' ' : ''}${unitLabel(row.buyUnit, uomItem)}`,
      purchaseTaxRateId: row.purchaseTaxRateId || null, priceIncludesTax: row.priceIncludesTax === true,
      isPreferred: row.isPreferred,
    };
    const { error, partial } = await upsertSupplierProduct(sp, locId);
    reportSave('supplier pack', error);
    if (error) { showToast?.(error.message, 'error'); return; }
    // The pack saved; only its cost recompute didn't. Close the form regardless — leaving
    // it open invites a re-save, and a new pack carries no id, so that inserts a duplicate.
    if (partial) showToast?.(partial, 'warning');
    setAdding(false); setRow(null); onChanged();
  };
  const editRow = (sp) => {
    // Show it back in a friendly unit: a pack whose size divides the stored content evenly, else the base unit.
    let buyUnit = draft.baseUnit, buyQty = sp.innerQty;
    for (const f of [...(draft.packaging || [])].sort((a, b) => b.qtyInBase - a.qtyInBase)) {
      if (f.qtyInBase > 0 && Math.abs((sp.innerQty / f.qtyInBase) - Math.round(sp.innerQty / f.qtyInBase)) < 1e-9) {
        buyUnit = formatToken(f.id); buyQty = Math.round((sp.innerQty / f.qtyInBase) * 1000) / 1000; break;
      }
    }
    setRow({ id: sp.id, inventoryItemId: draft.id, supplierId: sp.supplierId, supplierSku: sp.supplierSku || '', buyQty, buyUnit, packPrice: sp.packPrice, priceIncludesTax: sp.priceIncludesTax === true, purchaseTaxRateId: sp.purchaseTaxRateId || '', isPreferred: sp.isPreferred });
    setAdding(true);
  };
  const removeRow = async (sp) => {
    const { error } = await deleteSupplierProduct(sp.id, draft.id, locId);
    reportSave('supplier pack delete', error);
    if (error) { showToast?.('Supplier pack NOT removed — it still sets this cost', 'error'); return; }
    onChanged();
  };
  const setPreferred = async (sp) => {
    const { error, partial } = await upsertSupplierProduct({ ...sp, inventoryItemId: draft.id, isPreferred: true }, locId);
    reportSave('preferred supplier pack', error);
    // The preferred pack IS this item's cost — a badge that moved on screen only
    // would leave every recipe costed off the old pack.
    if (error) { showToast?.('Preferred pack NOT changed — cost is unchanged', 'error'); return; }
    // The preference DID move; only the recompute failed. Saying "NOT changed" here would
    // be the opposite of what happened.
    if (partial) showToast?.(`Preferred pack changed, but the cost was NOT recalculated: ${partial}`, 'warning');
    onChanged();
  };
  const addSupplier = async () => {
    if (!newSupplier.trim()) return;
    const { data, error } = await upsertSupplier({ name: newSupplier.trim() }, locId);
    reportSave('supplier', error);
    if (error) { showToast?.(error.message, 'error'); return; }
    setNewSupplier('');
    if (data) { setRow(r => ({ ...r, supplierId: data.id })); }
    onChanged();
  };
  const supName = (id) => suppliers.find(s => s.id === id)?.name || '—';

  return (
    <div style={{ maxWidth: 760 }}>
      <p style={{ fontSize: 13, color: 'var(--t2)', marginTop: 0 }}>
        Enter what you buy it in (a unit from the <b>Units</b> tab) and what it costs — e.g. <b>1 Keg for £152</b> or
        <b> 1 Case for £40</b>. The cost per {draft.baseUnit} is worked out for you and the <b>preferred</b> line sets this
        item's cost. {(draft.packaging || []).length === 0 && <span style={{ color: 'var(--red, #ef4444)' }}>Tip: add your buy units on the Units tab first.</span>}
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
        {(draft.supplierProducts || []).length === 0 && <div style={{ fontSize: 12, color: 'var(--t3)' }}>No supplier packs yet.</div>}
        {(draft.supplierProducts || []).map(sp => (
          <div key={sp.id} style={{ display: 'flex', alignItems: 'center', gap: 12, background: 'var(--bg1)', border: '1px solid ' + (sp.isPreferred ? 'var(--acc)' : 'var(--bdr)'), borderRadius: 8, padding: '10px 14px' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, color: 'var(--t1)', fontWeight: 600 }}>{supName(sp.supplierId)} {sp.supplierSku ? <span style={{ color: 'var(--t3)', fontWeight: 400 }}>· {sp.supplierSku}</span> : null}</div>
              <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 2 }}>
{sp.packDescription || `${sp.innerQty} ${sp.innerUnit}`} for {money(sp.packPrice)}{sp.priceIncludesTax ? ' inc VAT' : ''} → <b style={{ color: 'var(--t1)' }}>{fmtUnitCost(sp.baseUnitCost)}/{draft.baseUnit}</b>{sp.vatRate > 0 ? <span style={{ color: 'var(--t4)' }}> ex VAT</span> : null}
              </div>
            </div>
            {sp.isPreferred
              ? <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--acc)', padding: '3px 8px', borderRadius: 20, background: 'var(--acc-d, rgba(249,115,22,0.12))' }}>Preferred</span>
              : <button onClick={() => setPreferred(sp)} style={{ fontSize: 11, padding: '4px 9px', borderRadius: 6, background: 'var(--bg2)', border: '1px solid var(--bdr)', color: 'var(--t2)', cursor: 'pointer' }}>Make preferred</button>}
            <button onClick={() => editRow(sp)} style={{ background: 'transparent', border: 0, color: 'var(--t3)', cursor: 'pointer', fontSize: 13 }}>Edit</button>
            <button onClick={() => removeRow(sp)} style={{ background: 'transparent', border: 0, color: 'var(--t3)', cursor: 'pointer', fontSize: 16 }}>×</button>
          </div>
        ))}
      </div>

      {!adding && <button onClick={startAdd} style={{ padding: '8px 16px', borderRadius: 7, background: 'var(--bg2)', border: '1px solid var(--bdr)', color: 'var(--t1)', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>+ Add supplier pack</button>}

      {adding && row && (
        <div style={{ background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 10, padding: 16, marginTop: 8 }}>
          <Field label="Supplier">
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <select value={row.supplierId} onChange={e => setRow(r => ({ ...r, supplierId: e.target.value }))} style={{ ...fieldStyle, width: 'auto', flex: 1, minWidth: 160 }}>
                <option value="">Select supplier…</option>
                {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              <input value={newSupplier} onChange={e => setNewSupplier(e.target.value)} placeholder="…or new supplier name" style={{ ...fieldStyle, width: 200 }} />
              <button onClick={addSupplier} style={{ padding: '8px 12px', borderRadius: 7, background: 'var(--bg2)', border: '1px solid var(--bdr)', color: 'var(--t1)', cursor: 'pointer', fontSize: 13 }}>Add</button>
            </div>
          </Field>
          <Field label="How you buy it">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13, color: 'var(--t3) ' }}>Buy</span>
              <input type="number" min="0" step="any" value={row.buyQty} onChange={e => setRow(r => ({ ...r, buyQty: e.target.value }))} placeholder="1" style={{ ...fieldStyle, width: 70 }} />
              <select value={row.buyUnit} onChange={e => setRow(r => ({ ...r, buyUnit: e.target.value }))} style={{ ...fieldStyle, width: 170 }}>
                {buyOpts.map(o => <option key={o.token} value={o.token}>{o.label}</option>)}
              </select>
              <span style={{ fontSize: 13, color: 'var(--t3)' }}>for</span>
              <span style={{ fontSize: 13, color: 'var(--t2)' }}>{currencySymbol()}</span>
              <input type="number" min="0" step="any" value={row.packPrice} onChange={e => setRow(r => ({ ...r, packPrice: e.target.value }))} placeholder="152" style={{ ...fieldStyle, width: 100 }} />
            </div>
            <div style={{ fontSize: 11, color: 'var(--t4)', marginTop: 6 }}>e.g. <b>1 Keg for £152</b>, or <b>1 Case for £40</b>. Add units on the <b>Units</b> tab.</div>
            {rateDecFor(row) > 0 ? (
              <label style={{ display: 'flex', gap: 7, alignItems: 'center', fontSize: 13, color: 'var(--t2)', cursor: 'pointer', marginTop: 8 }}>
                <input type="checkbox" checked={row.priceIncludesTax === true} onChange={e => setRow(r => ({ ...r, priceIncludesTax: e.target.checked }))} />
                This price <b>includes {formatRateLabel(rateObjFor(row))}</b> — strip it to get the net cost
              </label>
            ) : (
              <div style={{ fontSize: 11, color: 'var(--t4)', marginTop: 8 }}>No purchase VAT set for this item — set it on the <b>General</b> tab to handle inc-VAT prices.</div>
            )}
          </Field>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 4, flexWrap: 'wrap' }}>
            <div style={{ fontSize: 14, color: 'var(--t1)' }}>
              Works out at: <b>{unitBad(row) ? '—' : fmtUnitCost(preview(row))}</b> /{draft.baseUnit} <span style={{ color: 'var(--t4)', fontSize: 12 }}>ex VAT</span>
              {!unitBad(row) && rateDecFor(row) > 0 && (
                <span style={{ color: 'var(--t3)', fontSize: 12, marginLeft: 8 }}>
                  {row.priceIncludesTax
                    ? `· ${money(Number(row.packPrice) || 0)} inc VAT → ${money(netPackOf(row))} net`
                    : `· pay ${money((Number(row.packPrice) || 0) * (1 + rateDecFor(row)))} inc ${Math.round(rateDecFor(row) * 100)}% VAT`}
                </span>
              )}
              {unitBad(row) && <span style={{ color: 'var(--red, #ef4444)', fontSize: 12, marginLeft: 8 }}>can't resolve that unit — check the Units tab</span>}
            </div>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, color: 'var(--t2)', cursor: 'pointer', marginLeft: 'auto' }}>
              <input type="checkbox" checked={row.isPreferred} onChange={e => setRow(r => ({ ...r, isPreferred: e.target.checked }))} /> Preferred
            </label>
            <button onClick={() => { setAdding(false); setRow(null); }} style={{ padding: '8px 14px', borderRadius: 7, background: 'transparent', border: '1px solid var(--bdr)', color: 'var(--t2)', cursor: 'pointer', fontSize: 13 }}>Cancel</button>
            <button onClick={saveRow} style={{ padding: '8px 18px', borderRadius: 7, background: 'var(--acc)', color: '#fff', border: 0, cursor: 'pointer', fontSize: 13, fontWeight: 700 }}>Save pack</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Recipe tab (v5.5.925) — a made-here item's recipe lives ON the item ─────────
// The whole point of "Made here": what goes into it and what a batch yields. Editing
// that on a separate Recipes screen forced people to know the model; here you pick the
// kind and the recipe editor is simply the next tab. Saving recomputes the item's cost
// from its components, so the made item's stock value stays honest.
function RecipeTab({ draft, items, locId, showToast, onChanged }) {
  const [recipe, setRecipe] = useState(null);   // null = loading, {} = none yet
  const [lines, setLines] = useState([]);
  const [yieldQty, setYieldQty] = useState('1');
  const [yieldUnit, setYieldUnit] = useState(draft.baseUnit || 'each');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    fetchRecipes(locId).then(({ data }) => {
      if (!live) return;
      const r = (data || []).find(x => x.outputItemId === draft.id && !x.archivedAt);
      setRecipe(r || {});
      if (r) {
        setYieldQty(String(r.yieldQty ?? 1)); setYieldUnit(r.yieldUnit || draft.baseUnit || 'each');
        setLines((r.lines || []).map(l => ({ componentItemId: l.componentItemId, qty: String(l.qty), unit: l.unit })));
      }
    });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.id]);

  const components = (items || []).filter(i => !i.archivedAt && i.id !== draft.id);
  const addLine = () => setLines(ls => [...ls, { componentItemId: '', qty: '', unit: '' }]);
  const updLine = (i, k, v) => setLines(ls => ls.map((l, j) => {
    if (j !== i) return l;
    const next = { ...l, [k]: v };
    // Picking a component defaults the unit to that item's base unit — the common case.
    if (k === 'componentItemId') { const c = components.find(x => x.id === v); if (c && !l.unit) next.unit = c.baseUnit; }
    return next;
  }));
  const rmLine = (i) => setLines(ls => ls.filter((_, j) => j !== i));

  const save = async () => {
    const keep = lines.filter(l => l.componentItemId && Number(l.qty) > 0);
    if (!keep.length) { showToast?.('Add at least one ingredient', 'error'); return; }
    setSaving(true);
    const { data: saved, error } = await upsertRecipe({
      ...(recipe?.id ? { id: recipe.id } : {}),
      name: `${draft.name} (batch)`, recipeType: 'BATCH', outputItemId: draft.id,
      yieldQty: Number(yieldQty) || 1, yieldUnit: yieldUnit || draft.baseUnit || 'each',
    }, locId);
    reportSave('recipe', error);
    if (error || !saved) { setSaving(false); showToast?.(error?.message || 'Recipe save failed', 'error'); return; }
    const { error: e2 } = await replaceRecipeLines(saved.id, keep.map((l, i) => ({
      componentItemId: l.componentItemId, qty: Number(l.qty), unit: l.unit || 'each', sortOrder: i,
    })), locId);
    reportSave('recipe ingredients', e2);
    if (e2) { setSaving(false); showToast?.(e2.message, 'error'); return; }
    // Roll the component costs up into this item so its valuation is real.
    try { await recomputeMadeItemCost(draft.id, locId); } catch { /* cost roll-up is best-effort */ }
    setSaving(false);
    showToast?.('Recipe saved — cost updated from ingredients', 'success');
    onChanged?.();
  };

  if (recipe === null) return <div style={{ color: 'var(--t3)', fontSize: 13 }}>Loading…</div>;
  return (
    <div style={{ maxWidth: 620 }}>
      <div style={{ fontSize: 12.5, color: 'var(--t3)', marginBottom: 14 }}>
        What goes into a batch of <b style={{ color: 'var(--t1)' }}>{draft.name}</b>, and how much a batch makes.
        Saving updates this item's cost from its ingredients.
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', marginBottom: 16 }}>
        <Field label="A batch makes"><input type="number" min="0" step="any" value={yieldQty} onChange={e => setYieldQty(e.target.value)} style={{ ...fieldStyle, width: 100 }} /></Field>
        <Field label="Unit"><input value={yieldUnit} onChange={e => setYieldUnit(e.target.value)} style={{ ...fieldStyle, width: 100 }} /></Field>
      </div>
      <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.06em', color: 'var(--t4)', marginBottom: 8 }}>INGREDIENTS</div>
      {lines.map((l, i) => (
        <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
          <select value={l.componentItemId} onChange={e => updLine(i, 'componentItemId', e.target.value)} style={{ ...fieldStyle, flex: 1 }}>
            <option value="">— pick an ingredient —</option>
            {components.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <input type="number" min="0" step="any" placeholder="qty" value={l.qty} onChange={e => updLine(i, 'qty', e.target.value)} style={{ ...fieldStyle, width: 80 }} />
          <input placeholder="unit" value={l.unit} onChange={e => updLine(i, 'unit', e.target.value)} style={{ ...fieldStyle, width: 74 }} />
          <button onClick={() => rmLine(i)} style={{ background: 'transparent', border: 0, color: 'var(--t3)', cursor: 'pointer', fontSize: 16 }}>×</button>
        </div>
      ))}
      <button onClick={addLine} style={{ padding: '7px 12px', borderRadius: 8, background: 'var(--bg2)', border: '1px dashed var(--bdr)', color: 'var(--t2)', fontSize: 12.5, cursor: 'pointer', marginBottom: 16 }}>+ Add ingredient</button>
      <div>
        <button onClick={save} disabled={saving} style={{ padding: '9px 18px', borderRadius: 8, background: 'var(--acc)', border: 0, color: '#0b0c10', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>{saving ? 'Saving…' : 'Save recipe'}</button>
      </div>
    </div>
  );
}

function NeedSaveFirst() {
  return <div style={{ fontSize: 13, color: 'var(--t3)', padding: '8px 0' }}>Save the item on the <b>General</b> tab first, then add details here.</div>;
}
