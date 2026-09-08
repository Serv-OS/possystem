/**
* KioskRegistry — v5.0.1
*
* Back-office page for managing kiosks at this location.
* Mirrors DeviceRegistry but scoped to type='kiosk'.
*
* Flow:
*   - Lists all kiosks at the active location (paired or awaiting pairing)
*   - + New kiosk: name -> insert devices row with type='kiosk' + pairing code
*   - Display pairing code prominently for the operator to type into the kiosk app
*   - Settings cog (->) opens per-kiosk configuration page (v5.0.2)
*
* Pairing code format: ABCDE-1234 (5 letters + 4 digits). Stored in devices.pairing_code.
* When a kiosk pairs, devices.paired_at gets set and pairing_code is cleared.
*/

import { useState, useEffect, useCallback } from 'react';
import { supabase, getLocationId } from '../../lib/supabase';
import KioskSettings from './KioskSettings';

// Word list for human-friendly pairing codes (matches DeviceRegistry style)
const PAIRING_WORDS = [
  'BAKER','PIZZA','SUSHI','GRILL','BURGER','PASTA','TACO','CURRY',
  'NOODLE','BAGEL','KEBAB','RAMEN','GYROS','SALAD','STEAK','WAFFLE',
  'CHILI','SCONE','HONEY','LEMON','MANGO','BERRY','TOAST','CREPE',
];
const generatePairingCode = () => {
  const word = PAIRING_WORDS[Math.floor(Math.random() * PAIRING_WORDS.length)];
  const num = Math.floor(1000 + Math.random() * 9000);
  return word + '-' + num;
};

export default function KioskRegistry() {
  const [kiosks, setKiosks] = useState([]);
  const [profiles, setProfiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showNewModal, setShowNewModal] = useState(false);
  const [newName, setNewName] = useState('');
  const [newProfileId, setNewProfileId] = useState('');
  const [working, setWorking] = useState(false);
  const [activeCode, setActiveCode] = useState(null); // { id, name, code }
  const [editingKioskId, setEditingKioskId] = useState(null); // when set, render KioskSettings instead of the list

  const load = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const locId = await getLocationId();
      if (!locId) {
        setError('Location not resolved. Sign in again.');
        return;
      }
      const [devRes, profRes] = await Promise.all([
        supabase.from('devices').select('*').eq('location_id', locId).eq('type', 'kiosk').order('created_at', { ascending: false }),
        supabase.from('device_profiles').select('id, name').eq('location_id', locId).order('name'),
      ]);
      if (devRes.error) throw devRes.error;
      if (profRes.error) throw profRes.error;
      setKiosks(devRes.data || []);
      setProfiles(profRes.data || []);
      // Pre-select the first profile in the new-kiosk modal
      if (!newProfileId && profRes.data && profRes.data.length > 0) {
        setNewProfileId(profRes.data[0].id);
      }
    } catch (e) {
      console.error('[KioskRegistry] load failed', e);
      setError(e?.message || 'Failed to load kiosks');
    } finally {
      setLoading(false);
    }
  }, [newProfileId]);

  useEffect(() => { load(); }, [load]);

  const startPairing = async () => {
    if (!newName.trim()) { setError('Kiosk name required'); return; }
    if (!newProfileId) { setError('Pick a device profile (or create one in Device Profiles first)'); return; }
    setWorking(true);
    setError(null);
    try {
      const locId = await getLocationId();
      const code = generatePairingCode();
      const { data, error } = await supabase.from('devices').insert({
        location_id: locId,
        name: newName.trim(),
        type: 'kiosk',
        profile_id: newProfileId,
        pairing_code: code,
        status: 'awaiting_pairing',
      }).select().single();
      if (error) throw error;
      setActiveCode({ id: data.id, name: data.name, code: data.pairing_code });
      setShowNewModal(false);
      setNewName('');
      await load();
    } catch (e) {
      console.error('[KioskRegistry] pairing failed', e);
      setError(e?.message || 'Failed to start pairing');
    } finally {
      setWorking(false);
    }
  };

  const regenerateCode = async (kiosk) => {
    if (!confirm('Generate a new pairing code for ' + kiosk.name + '? The old code stops working.')) return;
    const code = generatePairingCode();
    const { error } = await supabase.from('devices').update({
      pairing_code: code,
      paired_at: null,
      session_token: null,
      status: 'awaiting_pairing',
    }).eq('id', kiosk.id);
    if (error) { setError(error.message); return; }
    setActiveCode({ id: kiosk.id, name: kiosk.name, code: code });
    await load();
  };

  const removeKiosk = async (kiosk) => {
    if (!confirm('Remove ' + kiosk.name + '? It will sign out and stop working.')) return;
    const { error } = await supabase.from('devices').delete().eq('id', kiosk.id);
    if (error) { setError(error.message); return; }
    await load();
  };

  const fmtLastSeen = (iso) => {
    if (!iso) return '—';
    const ms = Date.now() - new Date(iso).getTime();
    if (ms < 60000) return 'just now';
    if (ms < 3600000) return Math.floor(ms / 60000) + ' min ago';
    if (ms < 86400000) return Math.floor(ms / 3600000) + ' hr ago';
    return Math.floor(ms / 86400000) + ' days ago';
  };

  // Settings view takes over when a kiosk is being edited
  if (editingKioskId) {
    return <KioskSettings kioskId={editingKioskId} onBack={() => { setEditingKioskId(null); load(); }} />;
  }

  return (
    <div style={{ padding: 24, maxWidth: 980, margin: '0 auto', fontFamily: 'inherit', color: 'var(--t1)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 6 }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 700, letterSpacing: '-0.02em', marginBottom: 4 }}>Kiosks</h1>
          <p style={{ fontSize: 13, color: 'var(--t3)' }}>Self-ordering touchscreens at this location</p>
        </div>
        <button onClick={() => { setError(null); setShowNewModal(true); }}
          style={{ background: 'var(--acc)', color: '#fff', border: 0, padding: '9px 16px', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
          + New kiosk
        </button>
      </div>

      {error && (
        <div style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', color: '#fca5a5', padding: '10px 14px', borderRadius: 8, fontSize: 13, marginTop: 14, marginBottom: 4 }}>
          {error}
        </div>
      )}

      <div style={{ marginTop: 22 }}>
        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--t3)' }}>Loading…</div>
        ) : kiosks.length === 0 ? (
          <div style={{ padding: 50, textAlign: 'center', background: 'var(--bg2)', border: '1px dashed var(--bdr)', borderRadius: 12 }}>
            <div style={{ fontSize: 38, marginBottom: 10 }}>🖥️</div>
            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>No kiosks yet</div>
            <div style={{ fontSize: 12.5, color: 'var(--t3)' }}>Add your first self-ordering screen.</div>
          </div>
        ) : (
          <div style={{ background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 10, overflow: 'hidden' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1.6fr 1fr 1fr 1.2fr 130px', gap: 10, padding: '10px 16px', background: 'var(--bg2)', fontSize: 10.5, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              <div>Name</div>
              <div>Status</div>
              <div>Profile</div>
              <div>Last seen</div>
              <div></div>
            </div>
            {kiosks.map(k => {
              const profile = profiles.find(p => p.id === k.profile_id);
              const isPaired = !!k.paired_at;
              return (
                <div key={k.id} style={{ display: 'grid', gridTemplateColumns: '1.6fr 1fr 1fr 1.2fr 130px', gap: 10, padding: '14px 16px', borderTop: '1px solid var(--bdr)', alignItems: 'center', fontSize: 13 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ fontSize: 18 }}>🖥️</span>
                    <span style={{ fontWeight: 600 }}>{k.name}</span>
                  </div>
                  <div>
                    {isPaired ? (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 9px', background: 'rgba(34,197,94,0.12)', color: '#86efac', borderRadius: 100, fontSize: 11, fontWeight: 700 }}>● Paired</span>
                    ) : (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 9px', background: 'rgba(234,179,8,0.12)', color: '#fde047', borderRadius: 100, fontSize: 11, fontWeight: 700 }}>● Awaiting</span>
                    )}
                  </div>
                  <div style={{ color: 'var(--t2)', fontSize: 12.5 }}>{profile ? profile.name : '—'}</div>
                  <div style={{ color: 'var(--t3)', fontSize: 12 }}>{fmtLastSeen(k.last_seen)}</div>
                  <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                    {!isPaired && (
                      <button onClick={() => setActiveCode({ id: k.id, name: k.name, code: k.pairing_code })}
                        title="Show pairing code"
                        style={{ background: 'var(--bg3)', border: '1px solid var(--bdr)', borderRadius: 6, padding: '4px 8px', fontSize: 11, color: 'var(--t2)', cursor: 'pointer', fontFamily: 'inherit' }}>Code</button>
                    )}
                    <button onClick={() => regenerateCode(k)}
                      title="New pairing code"
                      style={{ background: 'var(--bg3)', border: '1px solid var(--bdr)', borderRadius: 6, padding: '4px 8px', fontSize: 11, color: 'var(--t2)', cursor: 'pointer', fontFamily: 'inherit' }}>↻</button>
                    <button onClick={() => setEditingKioskId(k.id)}
                      title="Settings"
                      style={{ background: 'var(--bg3)', border: '1px solid var(--bdr)', borderRadius: 6, padding: '4px 10px', fontSize: 11, color: 'var(--t2)', cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600 }}>Settings</button>
                    <button onClick={() => removeKiosk(k)}
                      title="Remove kiosk"
                      style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 6, padding: '4px 8px', fontSize: 11, color: '#fca5a5', cursor: 'pointer', fontFamily: 'inherit' }}>×</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* + New kiosk modal */}
      {showNewModal && (
        <div onClick={() => setShowNewModal(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'grid', placeItems: 'center', zIndex: 100, padding: 24 }}>
          <div onClick={e => e.stopPropagation()} style={{ background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 14, padding: 22, width: 420, maxWidth: '100%' }}>
            <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 4, letterSpacing: '-0.01em' }}>New kiosk</h2>
            <p style={{ fontSize: 12.5, color: 'var(--t3)', marginBottom: 18 }}>Add a kiosk and we will generate a pairing code for the screen.</p>

            <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 5 }}>Kiosk name</label>
            <input value={newName} onChange={e => setNewName(e.target.value)}
              placeholder="e.g. Front entrance kiosk" autoFocus
              style={{ width: '100%', background: 'var(--bg2)', border: '1px solid var(--bdr)', borderRadius: 8, padding: '10px 12px', color: 'var(--t1)', fontFamily: 'inherit', fontSize: 13.5, outline: 'none', marginBottom: 14 }} />

            <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 5 }}>Device profile</label>
            {profiles.length === 0 ? (
              <div style={{ padding: 12, background: 'rgba(234,179,8,0.08)', border: '1px solid rgba(234,179,8,0.3)', borderRadius: 8, fontSize: 12, color: '#fde047' }}>
                No device profiles yet. Create one in Device Profiles first.
              </div>
            ) : (
              <select value={newProfileId} onChange={e => setNewProfileId(e.target.value)}
                style={{ width: '100%', background: 'var(--bg2)', border: '1px solid var(--bdr)', borderRadius: 8, padding: '10px 12px', color: 'var(--t1)', fontFamily: 'inherit', fontSize: 13.5, outline: 'none' }}>
                {profiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 22 }}>
              <button onClick={() => setShowNewModal(false)}
                style={{ background: 'transparent', border: '1px solid var(--bdr)', color: 'var(--t2)', padding: '9px 16px', borderRadius: 8, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' }}>Cancel</button>
              <button onClick={startPairing} disabled={working || profiles.length === 0}
                style={{ background: 'var(--acc)', color: '#fff', border: 0, padding: '9px 16px', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: working ? 'wait' : 'pointer', opacity: working || profiles.length === 0 ? 0.5 : 1, fontFamily: 'inherit' }}>
                {working ? 'Generating…' : 'Generate code'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Pairing code display */}
      {activeCode && (
        <div onClick={() => setActiveCode(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'grid', placeItems: 'center', zIndex: 100, padding: 24 }}>
          <div onClick={e => e.stopPropagation()} style={{ background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 14, padding: 32, width: 480, maxWidth: '100%', textAlign: 'center' }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 6 }}>Pairing code for</div>
            <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 24 }}>{activeCode.name}</div>
            <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 56, fontWeight: 800, letterSpacing: '0.05em', color: 'var(--acc)', padding: '24px 16px', background: 'var(--bg2)', border: '2px solid var(--bdr)', borderRadius: 12, marginBottom: 20 }}>
              {activeCode.code || '—'}
            </div>
            <p style={{ fontSize: 13, color: 'var(--t2)', lineHeight: 1.6, marginBottom: 4 }}>
              On the kiosk screen, tap <b>Pair this kiosk</b> and enter this code.
            </p>
            <p style={{ fontSize: 11.5, color: 'var(--t3)', marginBottom: 22 }}>This code stays valid until you regenerate it.</p>
            <button onClick={() => setActiveCode(null)}
              style={{ background: 'var(--acc)', color: '#fff', border: 0, padding: '10px 22px', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
