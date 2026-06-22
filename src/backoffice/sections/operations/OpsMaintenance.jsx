// OpsMaintenance — manage maintenance requests (raise → assign → in_progress → resolved).
// Auto-raised ones from temperature breaches land here too. (Back Office → Operations → Maintenance.)

import { useEffect, useState, useCallback } from 'react';
import { useStore } from '../../../store';
import { getActiveLocationSync, getLocationId } from '../../../lib/supabase';
import { fetchMaintenance, setMaintenanceStatus, addMaintenanceNote, createMaintenance } from '../../../lib/ops/data';

const STATUSES = ['open', 'assigned', 'in_progress', 'resolved', 'cancelled'];
const STATUS_COL = { open: 'var(--red)', assigned: 'var(--orn)', in_progress: 'var(--blu)', resolved: 'var(--grn)', cancelled: 'var(--t4)' };
const PRIO_COL = { urgent: 'var(--red)', high: 'var(--orn)', normal: 'var(--t2)', low: 'var(--t3)' };
const field = { background: 'var(--bg2)', color: 'var(--t1)', border: '1px solid var(--bdr)', borderRadius: 8, padding: '7px 10px', fontSize: 13, outline: 'none', fontFamily: 'inherit' };

export default function OpsMaintenance() {
  const showToast = useStore(s => s.showToast);
  const me = useStore(s => s.staff);
  const [locId, setLocId] = useState(getActiveLocationSync());
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('open-ish');
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ title: '', description: '', priority: 'normal' });
  const [noteFor, setNoteFor] = useState(null);
  const [noteText, setNoteText] = useState('');

  const reload = useCallback(async () => {
    const loc = locId || getActiveLocationSync() || await getLocationId().catch(() => null);
    if (loc && loc !== locId) setLocId(loc);
    const { data } = await fetchMaintenance(loc);
    setRows(data || []); setLoading(false);
  }, [locId]);
  useEffect(() => { reload(); /* eslint-disable-next-line */ }, []);

  const shown = rows.filter(r => filter === 'all' ? true : filter === 'open-ish' ? !['resolved', 'cancelled'].includes(r.status) : r.status === filter);
  const setStatus = async (r, status) => { await setMaintenanceStatus(r.id, status, me?.name, locId); reload(); };
  const create = async () => {
    if (!draft.title.trim()) { showToast?.('Title required', 'error'); return; }
    await createMaintenance({ ...draft, reporterName: me?.name, source: 'manual' }, locId);
    setDraft({ title: '', description: '', priority: 'normal' }); setAdding(false); reload(); showToast?.('Raised', 'success');
  };
  const saveNote = async (r) => { if (!noteText.trim()) return; await addMaintenanceNote(r.id, noteText.trim(), me?.name, locId); setNoteText(''); setNoteFor(null); showToast?.('Note added', 'success'); };

  return (
    <div style={{ height: '100%', overflowY: 'auto', background: 'var(--bg0)', padding: '22px 26px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 14 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0, color: 'var(--t1)', flex: 1 }}>Maintenance</h1>
        <select style={field} value={filter} onChange={e => setFilter(e.target.value)}>
          <option value="open-ish">Open</option><option value="all">All</option>
          {STATUSES.map(s => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
        </select>
        <button onClick={() => setAdding(a => !a)} className="btn btn-acc" style={{ padding: '9px 16px', borderRadius: 8, background: 'var(--acc)', color: '#fff', border: 0, fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>+ Raise</button>
      </div>

      {adding && (
        <div style={{ background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 12, padding: 16, marginBottom: 16, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <input style={{ ...field, flex: 1, minWidth: 200 }} placeholder="What's broken?" value={draft.title} onChange={e => setDraft(d => ({ ...d, title: e.target.value }))} />
          <select style={field} value={draft.priority} onChange={e => setDraft(d => ({ ...d, priority: e.target.value }))}>{['low', 'normal', 'high', 'urgent'].map(p => <option key={p} value={p}>{p}</option>)}</select>
          <button onClick={create} className="btn btn-acc" style={{ padding: '8px 16px', borderRadius: 8, background: 'var(--acc)', color: '#fff', border: 0, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>Raise</button>
        </div>
      )}

      {loading ? <div style={{ color: 'var(--t3)' }}>Loading…</div> : shown.length === 0 ? (
        <div style={{ background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 12, padding: 20, color: 'var(--t3)' }}>Nothing here.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {shown.map(r => (
            <div key={r.id} style={{ background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 12, padding: '12px 16px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span style={{ width: 9, height: 9, borderRadius: 999, background: STATUS_COL[r.status], flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--t1)' }}>{r.title} {r.source === 'temp_breach' && <span style={{ fontSize: 10.5, color: 'var(--uv)', fontWeight: 700 }}>· auto from temp breach</span>}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--t3)' }}>{r.reporterName || '—'} · {new Date(r.createdAt).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</div>
                </div>
                <span style={{ fontSize: 11, fontWeight: 700, color: PRIO_COL[r.priority] }}>{r.priority}</span>
                <select value={r.status} onChange={e => setStatus(r, e.target.value)} style={{ ...field, padding: '5px 8px' }}>{STATUSES.map(s => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}</select>
                <button onClick={() => { setNoteFor(noteFor === r.id ? null : r.id); setNoteText(''); }} style={{ background: 'var(--bg2)', border: '1px solid var(--bdr)', borderRadius: 7, padding: '5px 10px', fontSize: 12, color: 'var(--t2)', cursor: 'pointer', fontFamily: 'inherit' }}>Note</button>
              </div>
              {r.description && <div style={{ fontSize: 12.5, color: 'var(--t2)', marginTop: 6, paddingLeft: 21 }}>{r.description}</div>}
              {noteFor === r.id && (
                <div style={{ display: 'flex', gap: 8, marginTop: 10, paddingLeft: 21 }}>
                  <input style={{ ...field, flex: 1 }} placeholder="Add progress note…" value={noteText} onChange={e => setNoteText(e.target.value)} onKeyDown={e => e.key === 'Enter' && saveNote(r)} />
                  <button onClick={() => saveNote(r)} className="btn btn-acc" style={{ padding: '7px 14px', borderRadius: 8, background: 'var(--acc)', color: '#fff', border: 0, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>Add</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
