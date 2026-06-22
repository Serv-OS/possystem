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
import { UNITS, DIMENSIONS } from '../../lib/stock/units';
import { packBaseUnitCost } from '../../lib/stock/costing';
import { canConvert } from '../../lib/stock/conversion';
import {
  fetchInventoryItems, upsertInventoryItem, setInventoryItemArchived,
  fetchSuppliers, upsertSupplier,
  upsertSupplierProduct, deleteSupplierProduct,
  upsertItemConversion, deleteItemConversion,
  upsertPackagingFormat, deletePackagingFormat,
  setInventoryOnHand, fetchItemMovements, movementLabel,
} from '../../lib/stock/data';

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
const TABS = ['General', 'Stock', 'Dimension & Measure', 'Packaging', 'Suppliers'];

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
    if (error) { showToast?.('Save failed: ' + error.message, 'error'); return; }
    showToast?.('Saved', 'success');
    await reload(data?.id || selectedId);
  };

  const toggleArchive = async () => {
    if (!draft?.id) return;
    const next = !draft.archivedAt;
    const { error } = await setInventoryItemArchived(draft.id, next, locId);
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
                    <span>{it.category || (it.kind === 'MADE' ? 'Made' : 'Purchased')}</span>
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
                  <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--t1)' }}>{Number(draft.onHand || 0)}<span style={{ fontSize: 12, color: 'var(--t3)' }}> {draft.baseUnit}</span></div>
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
              {TABS.map(t => (
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
              {tab === 'Packaging' && <PackagingTab draft={draft} locId={locId} onChanged={() => reload(draft.id)} showToast={showToast} />}
              {tab === 'Suppliers' && <SuppliersTab draft={draft} suppliers={suppliers} locId={locId} onChanged={() => reload(draft.id)} onSupplierAdded={() => reload(draft.id)} showToast={showToast} />}
            </div>
          </>
        )}
      </main>
    </div>
  );
}

// ── General tab ───────────────────────────────────────────────────────────────
function GeneralTab({ draft, upd, onSave, saving }) {
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
      </div>

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

  const loadMoves = useCallback(async () => {
    if (!draft.id) return;
    const { data } = await fetchItemMovements(draft.id, locId);
    setMoves(data || []);
  }, [draft.id, locId]);
  useEffect(() => { loadMoves(); }, [loadMoves]);

  if (!draft.id) return <NeedSaveFirst />;

  const onHand = Number(draft.onHand || 0);
  const cost = draft.currentCost;

  const applyCount = async () => {
    if (count === '' || !(Number(count) >= 0)) { showToast?.('Enter a count (≥ 0)', 'error'); return; }
    setBusy(true);
    const { error } = await setInventoryOnHand(draft.id, Number(count), 'Set via Stock items', locId);
    setBusy(false);
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
        <Field label={`Set count (on hand, in ${draft.baseUnit})`}>
          <div style={{ display: 'flex', gap: 8 }}>
            <input type="number" min="0" step="any" value={count} onChange={e => setCount(e.target.value)} placeholder={String(onHand)} style={{ ...fieldStyle, width: 160 }} />
            <button onClick={applyCount} disabled={busy} style={{ padding: '8px 16px', borderRadius: 7, background: 'var(--acc)', color: '#fff', border: 0, cursor: 'pointer', fontSize: 13, fontWeight: 700, opacity: busy ? 0.6 : 1 }}>Update stock</button>
          </div>
        </Field>
        <div style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--t3)' }}>
          Stock value: <b style={{ color: 'var(--t1)', fontSize: 14 }}>{cost != null ? money(onHand * cost) : '—'}</b>
        </div>
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
    const { error } = await upsertItemConversion({ inventoryItemId: draft.id, ...row }, locId);
    if (error) { showToast?.(error.message, 'error'); return; }
    setRow({ fromQty: 1, fromUnit: draft.baseUnit, toQty: '', toUnit: 'g' });
    onChanged();
  };
  const remove = async (id) => { await deleteItemConversion(id, draft.id, locId); onChanged(); };

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
function PackagingTab({ draft, locId, onChanged, showToast }) {
  const [row, setRow] = useState({ name: '', qtyInBase: '' });
  if (!draft.id) return <NeedSaveFirst />;
  const add = async () => {
    if (!row.name.trim() || !(Number(row.qtyInBase) > 0)) { showToast?.('Name and quantity required', 'error'); return; }
    const { error } = await upsertPackagingFormat({ inventoryItemId: draft.id, ...row }, locId);
    if (error) { showToast?.(error.message, 'error'); return; }
    setRow({ name: '', qtyInBase: '' }); onChanged();
  };
  const remove = async (id) => { await deletePackagingFormat(id, locId); onChanged(); };
  return (
    <div style={{ maxWidth: 620 }}>
      <p style={{ fontSize: 13, color: 'var(--t2)', marginTop: 0 }}>
        Named packs and how many <b>base units ({draft.baseUnit})</b> each holds — e.g. <b>Box = 24</b>, <b>Sleeve = 6</b>.
        Used for counting and ordering in whole packs.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
        {(draft.packaging || []).length === 0 && <div style={{ fontSize: 12, color: 'var(--t3)' }}>No packaging formats yet.</div>}
        {(draft.packaging || []).map(p => (
          <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 7, padding: '8px 12px' }}>
            <span style={{ fontSize: 13, color: 'var(--t1)' }}>1 {p.name} = {p.qtyInBase} {draft.baseUnit}</span>
            <button onClick={() => remove(p.id)} style={{ marginLeft: 'auto', background: 'transparent', border: 0, color: 'var(--t3)', cursor: 'pointer', fontSize: 16 }}>×</button>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
        <input value={row.name} onChange={e => setRow(r => ({ ...r, name: e.target.value }))} placeholder="Format name (Box)" style={{ ...fieldStyle, width: 160 }} />
        <span style={{ color: 'var(--t3)' }}>=</span>
        <input type="number" min="0" step="any" value={row.qtyInBase} onChange={e => setRow(r => ({ ...r, qtyInBase: e.target.value }))} placeholder={`qty in ${draft.baseUnit}`} style={{ ...fieldStyle, width: 130 }} />
        <button onClick={add} style={{ padding: '8px 16px', borderRadius: 7, background: 'var(--acc)', color: '#fff', border: 0, cursor: 'pointer', fontSize: 13, fontWeight: 700 }}>Add format</button>
      </div>
    </div>
  );
}

// ── Suppliers tab (pack → unit cost) ──────────────────────────────────────────
function SuppliersTab({ draft, suppliers, locId, onChanged, showToast }) {
  const [adding, setAdding] = useState(false);
  const [row, setRow] = useState(null);
  const [newSupplier, setNewSupplier] = useState('');
  if (!draft.id) return <NeedSaveFirst />;

  const bridges = (draft.conversions || []).map(c => ({ fromQty: c.fromQty, fromUnit: c.fromUnit, toQty: c.toQty, toUnit: c.toUnit }));
  const preview = (r) => {
    try {
      const { baseUnitCost } = packBaseUnitCost({
        packPrice: Number(r.packPrice), packQty: Number(r.packQty), innerQty: Number(r.innerQty),
        innerUnit: r.innerUnit, baseUnit: draft.baseUnit, itemConversions: bridges,
      });
      return baseUnitCost;
    } catch { return null; }
  };
  const bridgeMissing = (r) => r.innerUnit && draft.baseUnit && r.innerUnit !== draft.baseUnit && !canConvert(r.innerUnit, draft.baseUnit, { itemConversions: bridges });

  const startAdd = () => {
    setRow({ inventoryItemId: draft.id, supplierId: suppliers[0]?.id || '', supplierSku: '', packDescription: '', packQty: 1, innerQty: '', innerUnit: draft.baseUnit, packPrice: '', isPreferred: (draft.supplierProducts || []).length === 0 });
    setAdding(true);
  };
  const saveRow = async () => {
    if (!row.supplierId) { showToast?.('Pick or add a supplier first', 'error'); return; }
    if (!(Number(row.packPrice) >= 0)) { showToast?.('Enter a pack price', 'error'); return; }
    const { error } = await upsertSupplierProduct(row, locId);
    if (error) { showToast?.(error.message, 'error'); return; }
    setAdding(false); setRow(null); onChanged();
  };
  const editRow = (sp) => { setRow({ ...sp, inventoryItemId: draft.id }); setAdding(true); };
  const removeRow = async (sp) => { await deleteSupplierProduct(sp.id, draft.id, locId); onChanged(); };
  const setPreferred = async (sp) => { await upsertSupplierProduct({ ...sp, inventoryItemId: draft.id, isPreferred: true }, locId); onChanged(); };
  const addSupplier = async () => {
    if (!newSupplier.trim()) return;
    const { data, error } = await upsertSupplier({ name: newSupplier.trim() }, locId);
    if (error) { showToast?.(error.message, 'error'); return; }
    setNewSupplier('');
    if (data) { setRow(r => ({ ...r, supplierId: data.id })); }
    onChanged();
  };
  const supName = (id) => suppliers.find(s => s.id === id)?.name || '—';

  return (
    <div style={{ maxWidth: 760 }}>
      <p style={{ fontSize: 13, color: 'var(--t2)', marginTop: 0 }}>
        Just enter <b>what you buy and what it costs</b> — e.g. a Heineken keg is <b>54 l for £152</b>. The cost
        per {draft.baseUnit} is worked out for you ({currencySymbol()}152 ÷ 54 = {currencySymbol()}2.81/l). The <b>preferred</b> line
        sets this item's cost. Buy it in the same unit you set as the stock unit and there's nothing else to think about.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
        {(draft.supplierProducts || []).length === 0 && <div style={{ fontSize: 12, color: 'var(--t3)' }}>No supplier packs yet.</div>}
        {(draft.supplierProducts || []).map(sp => (
          <div key={sp.id} style={{ display: 'flex', alignItems: 'center', gap: 12, background: 'var(--bg1)', border: '1px solid ' + (sp.isPreferred ? 'var(--acc)' : 'var(--bdr)'), borderRadius: 8, padding: '10px 14px' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, color: 'var(--t1)', fontWeight: 600 }}>{supName(sp.supplierId)} {sp.supplierSku ? <span style={{ color: 'var(--t3)', fontWeight: 400 }}>· {sp.supplierSku}</span> : null}</div>
              <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 2 }}>
{sp.innerQty} {sp.innerUnit} for {money(sp.packPrice)} → <b style={{ color: 'var(--t1)' }}>{fmtUnitCost(sp.baseUnitCost)}/{draft.baseUnit}</b>
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
              <span style={{ fontSize: 13, color: 'var(--t3)' }}>1 delivery unit =</span>
              <input type="number" min="0" step="any" value={row.innerQty} onChange={e => setRow(r => ({ ...r, innerQty: e.target.value }))} placeholder="54" style={{ ...fieldStyle, width: 90 }} />
              <UnitSelect value={row.innerUnit} onChange={v => setRow(r => ({ ...r, innerUnit: v }))} style={{ width: 140 }} />
              <span style={{ fontSize: 13, color: 'var(--t3)' }}>for</span>
              <span style={{ fontSize: 13, color: 'var(--t2)' }}>{currencySymbol()}</span>
              <input type="number" min="0" step="any" value={row.packPrice} onChange={e => setRow(r => ({ ...r, packPrice: e.target.value }))} placeholder="152" style={{ ...fieldStyle, width: 100 }} />
            </div>
            <div style={{ fontSize: 11, color: 'var(--t4)', marginTop: 6 }}>e.g. a keg = <b>54 l for £152</b>, or a case = <b>24 each for £40</b>. (Tip: an optional note &amp; SKU can be added later.)</div>
          </Field>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 4, flexWrap: 'wrap' }}>
            <div style={{ fontSize: 14, color: 'var(--t1)' }}>
              Derived unit cost: <b>{bridgeMissing(row) ? '—' : fmtUnitCost(preview(row))}</b> /{draft.baseUnit}
              {bridgeMissing(row) && <span style={{ color: 'var(--red, #ef4444)', fontSize: 12, marginLeft: 8 }}>Add a {row.innerUnit}→{draft.baseUnit} bridge in Dimension &amp; Measure</span>}
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

function NeedSaveFirst() {
  return <div style={{ fontSize: 13, color: 'var(--t3)', padding: '8px 0' }}>Save the item on the <b>General</b> tab first, then add details here.</div>;
}
