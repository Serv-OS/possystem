// OpsDevices — pair & manage the mobile Operations tablets (Back Office → Operations →
// Devices). A tablet opens the floor app at ?mode=ops, shows a 6-digit code; an admin
// enters it here to claim the device to this venue. Mirrors the Menu-Board screen pairing.

import { useEffect, useState, useCallback } from 'react';
import { useStore } from '../../../store';
import { getActiveLocationSync, getLocationId } from '../../../lib/supabase';
import { fetchOpsDevices, opsClaimDevice, renameOpsDevice, removeOpsDevice } from '../../../lib/ops/data';
import { Icon } from '../../../components/ServOSIcons';

const field = { background: 'var(--bg2)', color: 'var(--t1)', border: '1px solid var(--bdr)', borderRadius: 8, padding: '9px 12px', fontSize: 14, outline: 'none', fontFamily: 'inherit' };
const relTime = (iso) => {
  if (!iso) return 'never';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 0 || isNaN(diff)) return 'just now';
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24); return `${d}d ago`;
};
const isOnline = (iso) => iso && (Date.now() - new Date(iso).getTime()) < 150000; // ~2.5 min

export default function OpsDevices() {
  const showToast = useStore(s => s.showToast);
  const [locId, setLocId] = useState(getActiveLocationSync());
  const [devices, setDevices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [code, setCode] = useState('');
  const [claiming, setClaiming] = useState(false);
  const [renaming, setRenaming] = useState(null);   // {id, name}

  const reload = useCallback(async () => {
    const loc = locId || getActiveLocationSync() || await getLocationId().catch(() => null);
    if (loc && loc !== locId) setLocId(loc);
    const { data } = await fetchOpsDevices(loc);
    setDevices(data || []); setLoading(false);
  }, [locId]);
  useEffect(() => { reload(); /* eslint-disable-next-line */ }, []);

  const claim = async () => {
    const c = code.trim().toUpperCase();
    if (c.length < 4) { showToast?.('Enter the code shown on the tablet', 'error'); return; }
    const loc = locId || getActiveLocationSync() || await getLocationId().catch(() => null);
    setClaiming(true);
    const { error } = await opsClaimDevice(c, loc);
    setClaiming(false);
    if (error) { showToast?.(error.message === 'code not found' ? 'That code wasn’t found — check the tablet' : (error.message || 'Could not pair'), 'error'); return; }
    setCode(''); showToast?.('Tablet paired', 'success'); reload();
  };
  const saveName = async () => {
    if (!renaming) return;
    await renameOpsDevice(renaming.id, renaming.name.trim() || 'Ops tablet', locId);
    setRenaming(null); showToast?.('Renamed', 'success'); reload();
  };
  const remove = async (d) => {
    if (!window.confirm(`Unpair “${d.name || 'this tablet'}”? It will return to the pairing screen next time it opens.`)) return;
    await removeOpsDevice(d.id, locId); showToast?.('Tablet unpaired', 'success'); reload();
  };

  const opsUrl = `${typeof window !== 'undefined' ? window.location.origin : ''}/?mode=manager`;

  return (
    <div style={{ height: '100%', overflowY: 'auto', background: 'var(--bg0)', padding: '22px 26px' }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, margin: '0 0 4px', color: 'var(--t1)' }}>Devices</h1>
      <div style={{ fontSize: 13, color: 'var(--t3)', marginBottom: 18, maxWidth: 640 }}>
        Pair the tablets that run the mobile Operations app (temperature rounds, checklists, deliveries, maintenance).
      </div>

      {/* how-to + pair-by-code */}
      <div style={{ background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 14, padding: 18, marginBottom: 18, maxWidth: 760 }}>
        <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--t1)', marginBottom: 10 }}>Pair a tablet</div>
        <ol style={{ margin: '0 0 14px', paddingLeft: 18, color: 'var(--t2)', fontSize: 13, lineHeight: 1.7 }}>
          <li>On the tablet, open <code style={{ background: 'var(--bg2)', padding: '1px 6px', borderRadius: 5, color: 'var(--t1)' }}>{opsUrl}</code> (or tap <b>Manager</b> on the mode-selector screen). Operations lives inside the Manager app.</li>
          <li>It shows a <b>6-character pairing code</b>. Type that code below and pair.</li>
          <li>The tablet then asks for a staff PIN — and you’re into the floor app.</li>
        </ol>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            value={code}
            onChange={e => setCode(e.target.value.toUpperCase().slice(0, 8))}
            onKeyDown={e => e.key === 'Enter' && claim()}
            placeholder="Pairing code"
            style={{ ...field, width: 180, letterSpacing: '.18em', fontWeight: 700, fontFamily: 'var(--font-mono, ui-monospace), monospace', textTransform: 'uppercase' }}
          />
          <button onClick={claim} disabled={claiming} className="btn btn-acc" style={{ padding: '10px 20px', borderRadius: 8, background: 'var(--acc)', color: '#fff', border: 0, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', opacity: claiming ? 0.6 : 1 }}>{claiming ? 'Pairing…' : 'Pair tablet'}</button>
        </div>
      </div>

      {/* paired list */}
      <div style={{ fontSize: 11, fontWeight: 800, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 10, fontFamily: 'var(--font-mono, ui-monospace), monospace' }}>Paired tablets</div>
      {loading ? <div style={{ color: 'var(--t3)' }}>Loading…</div> : devices.length === 0 ? (
        <div style={{ background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 12, padding: 20, color: 'var(--t3)', fontSize: 13, maxWidth: 760 }}>No tablets paired yet. Follow the steps above to pair your first one.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 760 }}>
          {devices.map(d => {
            const online = isOnline(d.lastSeenAt);
            return (
              <div key={d.id} style={{ background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 12, padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 14 }}>
                <span title={online ? 'Online' : 'Offline'} style={{ width: 10, height: 10, borderRadius: 999, flexShrink: 0, background: online ? 'var(--grn)' : 'var(--t4)', boxShadow: online ? '0 0 7px var(--grn)' : 'none' }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  {renaming?.id === d.id ? (
                    <input autoFocus value={renaming.name} onChange={e => setRenaming(r => ({ ...r, name: e.target.value }))}
                      onKeyDown={e => { if (e.key === 'Enter') saveName(); if (e.key === 'Escape') setRenaming(null); }} onBlur={saveName}
                      style={{ ...field, padding: '4px 8px', fontSize: 14 }} />
                  ) : (
                    <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--t1)' }}>{d.name || 'Ops tablet'}</div>
                  )}
                  <div style={{ fontSize: 11.5, color: 'var(--t3)', marginTop: 2 }}>{online ? 'Online now' : `Last seen ${relTime(d.lastSeenAt)}`}{d.active ? '' : ' · inactive'}</div>
                </div>
                <button onClick={() => setRenaming({ id: d.id, name: d.name || '' })} title="Rename" style={iconBtn}><Icon name="edit" size={15} /></button>
                <button onClick={() => remove(d)} title="Unpair" style={{ ...iconBtn, color: 'var(--red)' }}><Icon name="close" size={15} /></button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const iconBtn = { background: 'var(--bg2)', border: '1px solid var(--bdr)', borderRadius: 8, padding: 7, color: 'var(--t2)', cursor: 'pointer', display: 'grid', placeItems: 'center' };
