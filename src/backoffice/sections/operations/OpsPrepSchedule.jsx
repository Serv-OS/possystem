// OpsPrepSchedule — Back Office editor for scheduled batch cooks ("prep schedule"). Defines what to
// prep, how much, by when and on which days. The Manager Kitchen tab shows today's items and lets a
// cook tap "Record" against each. (Back Office → Operations → Prep schedule.)
import { useEffect, useState, useCallback } from 'react';
import { useStore } from '../../../store';
import { getActiveLocationSync, getLocationId } from '../../../lib/supabase';
import { fetchPrepSchedule, savePrepItem, deletePrepItem } from '../../../lib/prep';
import { Icon } from '../../../components/ServOSIcons';

const field = { width: '100%', background: 'var(--bg2)', color: 'var(--t1)', border: '1px solid var(--bdr)', borderRadius: 8, padding: '8px 10px', fontSize: 13, outline: 'none', boxSizing: 'border-box', fontFamily: 'inherit' };
const lbl = { display: 'block', fontSize: 11, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 5 };
const th = { padding: '8px 10px', borderBottom: '1px solid var(--bdr)', fontWeight: 600, color: 'var(--t3)', textAlign: 'left', fontSize: 11, textTransform: 'uppercase', letterSpacing: '.04em' };
const td = { padding: '9px 10px', borderBottom: '1px solid var(--bg2)', fontSize: 13, color: 'var(--t1)' };
const DAYS = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [0, 'Sun']];
const UNITS = ['L', 'kg', 'g', 'ml', 'ea', 'portions', 'trays', 'batch'];
const blank = () => ({ id: null, name: '', qty: '', unit: 'L', dueTime: '', daysOfWeek: [], active: true });
const daysLabel = (a) => (!a || a.length === 0 ? 'Every day' : DAYS.filter(([n]) => a.includes(n)).map(([, l]) => l).join(' '));

export default function OpsPrepSchedule() {
  const showToast = useStore((s) => s.showToast);
  const [locId, setLocId] = useState(getActiveLocationSync());
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);   // item being edited, or blank() for new
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    const loc = locId || getActiveLocationSync() || await getLocationId().catch(() => null);
    if (loc && loc !== locId) setLocId(loc);
    const { data } = await fetchPrepSchedule(loc);
    setItems(data || []); setLoading(false);
  }, [locId]);
  useEffect(() => { reload(); /* eslint-disable-next-line */ }, []);

  const save = async () => {
    if (!editing.name.trim()) { showToast('Give the prep item a name', 'error'); return; }
    setBusy(true);
    const { error } = await savePrepItem({ ...editing, sortOrder: editing.sortOrder ?? items.length }, locId);
    setBusy(false);
    if (error) { showToast(error.message || 'Could not save', 'error'); return; }
    setEditing(null); showToast('Prep item saved', 'success'); reload();
  };
  const remove = async (id) => {
    const { error } = await deletePrepItem(id, locId);
    if (error) { showToast(error.message || 'Could not remove', 'error'); return; }
    showToast('Removed', 'info'); reload();
  };
  const toggleDay = (d) => setEditing((e) => ({ ...e, daysOfWeek: e.daysOfWeek.includes(d) ? e.daysOfWeek.filter((x) => x !== d) : [...e.daysOfWeek, d] }));

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 20, color: 'var(--t1)' }}>Prep schedule</h2>
          <div style={{ fontSize: 12.5, color: 'var(--t3)', marginTop: 3 }}>Scheduled batch cooks the kitchen ticks off each day in the Manager app.</div>
        </div>
        <button onClick={() => setEditing(blank())} style={{ ...field, width: 'auto', cursor: 'pointer', fontWeight: 700, color: 'var(--acc)', border: '1px solid var(--acc)', display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="plus" size={15} /> Add prep item</button>
      </div>

      {loading ? <div style={{ color: 'var(--t3)', padding: 16, fontSize: 13 }}>Loading…</div> : items.length === 0 ? (
        <div style={{ border: '1px dashed var(--bdr)', borderRadius: 10, padding: 28, textAlign: 'center', color: 'var(--t3)', fontSize: 13, marginTop: 10 }}>
          No prep items yet. Add things you batch-cook on a schedule (stocks, sauces, pickles…).
        </div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 10 }}>
          <thead><tr><th style={th}>Item</th><th style={th}>Qty</th><th style={th}>Due by</th><th style={th}>Days</th><th style={th}>Status</th><th style={{ ...th, textAlign: 'right' }}>—</th></tr></thead>
          <tbody>
            {items.map((it) => (
              <tr key={it.id}>
                <td style={{ ...td, fontWeight: 700 }}>{it.name}</td>
                <td style={td}>{it.qty != null ? `${it.qty}${it.unit || ''}` : '—'}</td>
                <td style={td}>{it.dueTime || '—'}</td>
                <td style={{ ...td, color: 'var(--t3)' }}>{daysLabel(it.daysOfWeek)}</td>
                <td style={td}>{it.active ? <span style={{ color: 'var(--grn, #22c55e)', fontWeight: 700 }}>Active</span> : <span style={{ color: 'var(--t4)' }}>Off</span>}</td>
                <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <button onClick={() => setEditing({ ...it })} style={{ ...field, width: 'auto', cursor: 'pointer', padding: '5px 10px', marginRight: 6 }}>Edit</button>
                  <button onClick={() => remove(it.id)} style={{ ...field, width: 'auto', cursor: 'pointer', padding: '5px 10px', color: 'var(--red, #ef4444)', border: '1px solid var(--red, #ef4444)' }}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {editing && (
        <div onClick={() => !busy && setEditing(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', display: 'grid', placeItems: 'center', zIndex: 1000, padding: 16 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: 'var(--bg)', border: '1px solid var(--bdr)', borderRadius: 14, padding: 22, width: 'min(460px,100%)', maxHeight: '90vh', overflowY: 'auto' }}>
            <h3 style={{ margin: '0 0 16px', fontSize: 17, color: 'var(--t1)' }}>{editing.id ? 'Edit prep item' : 'New prep item'}</h3>

            <label style={lbl}>Name</label>
            <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="e.g. Chicken stock" style={field} autoFocus />

            <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
              <div style={{ flex: 1 }}>
                <label style={lbl}>Batch size</label>
                <input value={editing.qty} onChange={(e) => setEditing({ ...editing, qty: e.target.value.replace(/[^0-9.]/g, '') })} inputMode="decimal" placeholder="8" style={field} />
              </div>
              <div style={{ flex: 1 }}>
                <label style={lbl}>Unit</label>
                <select value={editing.unit} onChange={(e) => setEditing({ ...editing, unit: e.target.value })} style={field}>
                  {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
                </select>
              </div>
              <div style={{ flex: 1 }}>
                <label style={lbl}>Due by</label>
                <input type="time" value={editing.dueTime} onChange={(e) => setEditing({ ...editing, dueTime: e.target.value })} style={field} />
              </div>
            </div>

            <label style={{ ...lbl, marginTop: 14 }}>Days</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {DAYS.map(([n, l]) => {
                const on = editing.daysOfWeek.includes(n);
                return <button key={n} onClick={() => toggleDay(n)} style={{ ...field, width: 'auto', cursor: 'pointer', padding: '7px 12px', fontWeight: 700, color: on ? '#06130C' : 'var(--t2)', background: on ? 'var(--acc)' : 'var(--bg2)', border: `1px solid ${on ? 'var(--acc)' : 'var(--bdr)'}` }}>{l}</button>;
              })}
            </div>
            <div style={{ fontSize: 11, color: 'var(--t4)', marginTop: 6 }}>No days selected = every day.</div>

            <label style={{ display: 'flex', alignItems: 'center', gap: 9, marginTop: 16, cursor: 'pointer', fontSize: 13, color: 'var(--t1)' }}>
              <input type="checkbox" checked={editing.active} onChange={(e) => setEditing({ ...editing, active: e.target.checked })} /> Active (show in the Manager app)
            </label>

            <div style={{ display: 'flex', gap: 10, marginTop: 22 }}>
              <button onClick={() => setEditing(null)} disabled={busy} style={{ ...field, cursor: 'pointer', fontWeight: 700, color: 'var(--t2)' }}>Cancel</button>
              <button onClick={save} disabled={busy} style={{ ...field, cursor: 'pointer', fontWeight: 800, color: '#06130C', background: 'var(--acc)', border: '1px solid var(--acc)' }}>{busy ? 'Saving…' : 'Save'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
