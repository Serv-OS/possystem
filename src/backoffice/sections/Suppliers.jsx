/**
 * Suppliers — manage vendors (Purchasing → Suppliers). Slice 7.
 * CRUD over the suppliers table (contact, terms, delivery days, MOQ, cut-off).
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useStore } from '../../store';
import { getActiveLocationSync, getLocationId } from '../../lib/supabase';
import { money } from '../../lib/currency';
import { fetchSuppliers, upsertSupplier, setSupplierArchived } from '../../lib/stock/data';
import { reportSave } from '../../lib/saveHealth';
import { PageHeader, SearchField } from './reports/reportKit';

const DAYS = [['mon', 'Mon'], ['tue', 'Tue'], ['wed', 'Wed'], ['thu', 'Thu'], ['fri', 'Fri'], ['sat', 'Sat'], ['sun', 'Sun']];
const field = { width: '100%', background: 'var(--bg2)', color: 'var(--t1)', border: '1px solid var(--bdr)', borderRadius: 6, padding: '8px 10px', fontSize: 13, outline: 'none', boxSizing: 'border-box' };
const lbl = { display: 'block', fontSize: 11, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 5 };
const blank = () => ({ name: '', contactName: '', email: '', phone: '', accountNumber: '', paymentTermsDays: '', minOrderValue: '', deliveryDays: [], cutoffTime: '', notes: '' });

export default function Suppliers() {
  const showToast = useStore(s => s.showToast);
  const [locId, setLocId] = useState(getActiveLocationSync());
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState(null);
  const [selId, setSelId] = useState(null);
  const [saving, setSaving] = useState(false);

  const reload = useCallback(async (keepId) => {
    const loc = locId || getActiveLocationSync() || await getLocationId().catch(() => null);
    if (loc && loc !== locId) setLocId(loc);
    const { data } = await fetchSuppliers(loc);
    setList(data || []); setLoading(false);
    if (keepId) { const f = (data || []).find(s => s.id === keepId); if (f) { setDraft({ ...f }); setSelId(keepId); } }
  }, [locId]);
  useEffect(() => { reload(); /* eslint-disable-next-line */ }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return list.filter(s => !q || s.name.toLowerCase().includes(q));
  }, [list, search]);

  const upd = (k, v) => setDraft(d => ({ ...d, [k]: v }));
  const toggleDay = (d) => setDraft(x => ({ ...x, deliveryDays: x.deliveryDays.includes(d) ? x.deliveryDays.filter(y => y !== d) : [...x.deliveryDays, d] }));
  const save = async () => {
    if (!draft.name.trim()) { showToast?.('Name required', 'error'); return; }
    setSaving(true);
    const { data, error } = await upsertSupplier(draft, locId);
    setSaving(false);
    reportSave('supplier', error);
    if (error) { showToast?.(error.message, 'error'); return; }
    showToast?.('Saved', 'success');
    await reload(data?.id || selId);
  };
  const archive = async () => {
    if (!draft?.id) return;
    const { error } = await setSupplierArchived(draft.id, true, locId);
    reportSave('supplier archive', error);
    // Don't clear the pane on a refused archive — the supplier is still orderable.
    if (error) { showToast?.(`"${draft.name}" was NOT archived`, 'error'); return; }
    showToast?.('Archived', 'info'); setDraft(null); setSelId(null); await reload();
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, background: 'var(--bg)' }}>
      <div style={{ flexShrink: 0, padding: '20px 26px 0' }}>
        <PageHeader eyebrow="PURCHASING" title="Suppliers" subtitle="Vendors you buy from — contact details, payment terms, delivery days and order cut-offs." />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '300px 1fr', flex: 1, minHeight: 0, borderTop: '1px solid var(--bdr)' }}>
      <aside style={{ borderRight: '1px solid var(--bdr)', background: 'var(--bg1)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div style={{ padding: 14, display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <SearchField value={search} onChange={setSearch} placeholder="Search suppliers…" width="100%" />
          </div>
          <button onClick={() => { setDraft(blank()); setSelId(null); }} title="Add supplier" aria-label="Add supplier" style={{ flexShrink: 0, width: 38, height: 38, borderRadius: 11, background: 'var(--acc)', color: '#0b0c10', border: 0, fontSize: 20, fontWeight: 700, lineHeight: 1, cursor: 'pointer' }}>+</button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {loading && <div style={{ padding: 16, color: 'var(--t3)', fontSize: 13 }}>Loading…</div>}
          {!loading && filtered.length === 0 && <div style={{ padding: 16, color: 'var(--t3)', fontSize: 13 }}>No suppliers yet. Press + to add one.</div>}
          {filtered.map(s => (
            <div key={s.id} onClick={() => { setDraft({ ...s }); setSelId(s.id); }} style={{ padding: '11px 16px', cursor: 'pointer', borderLeft: '3px solid ' + (s.id === selId ? 'var(--acc)' : 'transparent'), background: s.id === selId ? 'var(--bg2)' : 'transparent' }}>
              <div style={{ fontSize: 13, color: 'var(--t1)' }}>{s.name}</div>
              <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 2 }}>{s.contactName || s.email || s.phone || '—'}</div>
            </div>
          ))}
        </div>
      </aside>

      <main style={{ overflowY: 'auto', minHeight: 0 }}>
        {!draft && <div style={{ display: 'grid', placeItems: 'center', height: '100%', color: 'var(--t3)' }}>Select a supplier, or press + to add one.</div>}
        {draft && (
          <div style={{ padding: '22px 26px', maxWidth: 640 }}>
            <h2 style={{ fontSize: 19, fontWeight: 700, letterSpacing: '-.3px', margin: '0 0 18px', color: 'var(--t1)' }}>{draft.name || 'New supplier'}</h2>
            <div style={{ marginBottom: 14 }}><label style={lbl}>Name</label><input value={draft.name} onChange={e => upd('name', e.target.value)} style={field} /></div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              <div><label style={lbl}>Contact name</label><input value={draft.contactName || ''} onChange={e => upd('contactName', e.target.value)} style={field} /></div>
              <div><label style={lbl}>Account number</label><input value={draft.accountNumber || ''} onChange={e => upd('accountNumber', e.target.value)} style={field} /></div>
              <div><label style={lbl}>Email</label><input value={draft.email || ''} onChange={e => upd('email', e.target.value)} style={field} placeholder="orders@supplier.co.uk" /></div>
              <div><label style={lbl}>Phone</label><input value={draft.phone || ''} onChange={e => upd('phone', e.target.value)} style={field} /></div>
              <div><label style={lbl}>Payment terms (days)</label><input type="number" min="0" value={draft.paymentTermsDays ?? ''} onChange={e => upd('paymentTermsDays', e.target.value)} style={field} /></div>
              <div><label style={lbl}>Min order value</label><input type="number" min="0" step="any" value={draft.minOrderValue ?? ''} onChange={e => upd('minOrderValue', e.target.value)} style={field} placeholder="£" /></div>
              <div><label style={lbl}>Cut-off time</label><input value={draft.cutoffTime || ''} onChange={e => upd('cutoffTime', e.target.value)} style={field} placeholder="e.g. 16:00" /></div>
            </div>
            <div style={{ marginTop: 14 }}>
              <label style={lbl}>Delivery days</label>
              <div style={{ display: 'flex', gap: 6 }}>
                {DAYS.map(([d, l]) => {
                  const on = draft.deliveryDays?.includes(d);
                  return <button key={d} onClick={() => toggleDay(d)} style={{ flex: 1, padding: '7px 0', fontSize: 12, borderRadius: 6, cursor: 'pointer', background: on ? 'var(--acc-d)' : 'var(--bg2)', color: on ? 'var(--acc)' : 'var(--t3)', border: '1px solid ' + (on ? 'var(--acc-b)' : 'var(--bdr)') }}>{l}</button>;
                })}
              </div>
            </div>
            <div style={{ marginTop: 14 }}><label style={lbl}>Notes</label><textarea value={draft.notes || ''} onChange={e => upd('notes', e.target.value)} style={{ ...field, minHeight: 56, resize: 'vertical' }} /></div>
            <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
              <button onClick={save} disabled={saving} style={{ padding: '10px 22px', borderRadius: 12, background: 'var(--acc)', color: '#0b0c10', border: 0, fontSize: 13, fontWeight: 700, cursor: 'pointer', opacity: saving ? 0.6 : 1 }}>{saving ? 'Saving…' : draft.id ? 'Save changes' : 'Create supplier'}</button>
              {draft.id && <button onClick={archive} style={{ padding: '10px 16px', borderRadius: 12, background: 'var(--bg2)', border: '1px solid var(--bdr2)', color: 'var(--t2)', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>Archive</button>}
            </div>
          </div>
        )}
      </main>
      </div>
    </div>
  );
}
