/**
 * PosWasteModal — staff-facing waste logging at the till.
 *
 * Records spoilage / breakage / etc. straight to the stock ledger (same path as
 * the Back Office Wastage screen: logWaste → WASTE movement + waste_events row).
 * Staff work in friendly units (the item's count-default pack, e.g. "Bottle"),
 * resolved to the base unit by uom.toBase. Source is stamped 'pos'.
 */

import { useEffect, useMemo, useState } from 'react';
import { fetchInventoryItems } from '../lib/stock/data';
import { logWaste, WASTE_REASONS } from '../lib/stock/waste';
import { unitOptions, preferredDisplayToken } from '../lib/stock/uom';
import { UNITS } from '../lib/stock/units';

// shape an inventory item (from fetchInventoryItems) into the ctx uom expects.
const toCtx = (it) => ({
  baseUnit: it.baseUnit,
  formats: it.packaging || [],
  itemConversions: (it.conversions || []).map(c => ({ fromQty: c.fromQty, fromUnit: c.fromUnit, toQty: c.toQty, toUnit: c.toUnit })),
});
const sameDimGlobals = (baseUnit) => {
  const dim = UNITS[baseUnit]?.dimension;
  if (!dim) return [];
  return Object.keys(UNITS).filter(c => UNITS[c].dimension === dim && c !== baseUnit);
};

const field = { width: '100%', background: 'var(--bg2)', color: 'var(--t1)', border: '1.5px solid var(--bdr2)', borderRadius: 10, padding: '12px 12px', fontSize: 15, outline: 'none', boxSizing: 'border-box', fontFamily: 'inherit' };
const lbl = { fontSize: 11, fontWeight: 800, color: 'var(--t4)', textTransform: 'uppercase', letterSpacing: '.07em', display: 'block', marginBottom: 6 };

export default function PosWasteModal({ open, onClose, locationId, showToast }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [item, setItem] = useState(null);     // the picked inventory item (raw, from fetch)
  const [qty, setQty] = useState('');
  const [unit, setUnit] = useState('');       // unit token (@<formatId> or global code)
  const [reason, setReason] = useState(WASTE_REASONS[0]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setLoading(true); setQ(''); setItem(null); setQty(''); setReason(WASTE_REASONS[0]); setNote('');
    fetchInventoryItems(locationId).then(({ data }) => { if (live) { setItems(data || []); setLoading(false); } });
    return () => { live = false; };
  }, [open, locationId]);

  const matches = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return [];
    return items.filter(i => !i.archivedAt && i.name.toLowerCase().includes(s)).slice(0, 8);
  }, [q, items]);

  const ctx = item ? toCtx(item) : null;
  const unitOpts = ctx ? unitOptions(ctx, sameDimGlobals(ctx.baseUnit)) : [];

  const pick = (it) => { setItem(it); setUnit(preferredDisplayToken(toCtx(it))); setQ(''); };

  const submit = async () => {
    if (!item) { showToast?.('Pick an item', 'error'); return; }
    if (!(Number(qty) > 0)) { showToast?.('Enter a quantity', 'error'); return; }
    setBusy(true);
    const { error } = await logWaste({ inventoryItemId: item.id, qty, unit, reason, note, source: 'pos' }, locationId);
    setBusy(false);
    if (error) { showToast?.(error.message || 'Could not log waste', 'error'); return; }
    showToast?.(`Waste logged — ${item.name}`, 'success');
    onClose?.();
  };

  if (!open) return null;
  return (
    <div className="modal-back" style={{ zIndex: 99999 }} onClick={e => e.target === e.currentTarget && onClose?.()}>
      <div style={{ background: 'var(--bg1)', border: '1px solid var(--bdr2)', borderRadius: 20, width: '100%', maxWidth: 440, padding: '22px 24px', boxShadow: 'var(--sh3)', maxHeight: '88vh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
          <div style={{ fontSize: 17, fontWeight: 800, color: 'var(--t1)' }}>Log waste</div>
          <button onClick={() => onClose?.()} style={{ background: 'transparent', border: 'none', fontSize: 24, color: 'var(--t4)', cursor: 'pointer', padding: 4 }}>×</button>
        </div>
        <div style={{ fontSize: 12, color: 'var(--t3)', marginBottom: 18 }}>Spoilage, breakage, spillage etc. Comes off stock at cost — counts as explained loss.</div>

        {!item ? (
          <div style={{ position: 'relative' }}>
            <label style={lbl}>Item</label>
            <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder={loading ? 'Loading items…' : 'Search a stock item…'} style={field} disabled={loading} />
            {matches.length > 0 && (
              <div style={{ position: 'absolute', zIndex: 5, left: 0, right: 0, background: 'var(--bg2)', border: '1px solid var(--bdr2)', borderRadius: 10, marginTop: 4, overflow: 'hidden', boxShadow: '0 12px 34px rgba(0,0,0,0.4)' }}>
                {matches.map(i => <div key={i.id} onClick={() => pick(i)} style={{ padding: '12px 14px', cursor: 'pointer', fontSize: 14, color: 'var(--t1)', borderBottom: '1px solid var(--bdr)' }}>{i.name}</div>)}
              </div>
            )}
            {!loading && q.trim() && matches.length === 0 && <div style={{ fontSize: 12, color: 'var(--t4)', marginTop: 8 }}>No matching stock item.</div>}
          </div>
        ) : (
          <>
            <div style={{ ...field, display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
              <span style={{ fontWeight: 700 }}>{item.name}</span>
              <button onClick={() => setItem(null)} style={{ background: 'transparent', border: 0, color: 'var(--acc)', cursor: 'pointer', fontWeight: 700, fontSize: 13 }}>change</button>
            </div>
            <div style={{ display: 'flex', gap: 10, marginBottom: 14 }}>
              <div style={{ flex: '0 0 110px' }}>
                <label style={lbl}>Quantity</label>
                <input type="number" min="0" step="any" autoFocus value={qty} onChange={e => setQty(e.target.value)} placeholder="0" style={{ ...field, fontWeight: 800, fontFamily: 'var(--font-mono)' }} />
              </div>
              <div style={{ flex: 1 }}>
                <label style={lbl}>Unit</label>
                <select value={unit} onChange={e => setUnit(e.target.value)} style={field}>
                  {unitOpts.map(o => <option key={o.token} value={o.token}>{o.label}</option>)}
                </select>
              </div>
            </div>
            <div style={{ marginBottom: 14 }}>
              <label style={lbl}>Reason</label>
              <select value={reason} onChange={e => setReason(e.target.value)} style={field}>
                {WASTE_REASONS.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
            <div style={{ marginBottom: 18 }}>
              <label style={lbl}>Note (optional)</label>
              <input value={note} onChange={e => setNote(e.target.value)} placeholder="anything useful" style={field} />
            </div>
            <button onClick={submit} disabled={busy} style={{ width: '100%', padding: '14px', borderRadius: 12, border: 'none', background: 'var(--red,#cc5959)', color: '#fff', fontFamily: 'inherit', fontWeight: 800, fontSize: 15, cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1 }}>
              {busy ? 'Logging…' : 'Log waste'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
