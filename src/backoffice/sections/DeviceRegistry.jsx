import { useState, useEffect } from 'react';
import { useStore } from '../../store';
import { supabase, isMock, getLocationId } from '../../lib/supabase';
import { reportSave } from '../../lib/saveHealth';

const DEFAULT_PRODUCTION_CENTRES = [
  { id:'pc1', name:'Hot kitchen',  icon:'🔥' },
  { id:'pc2', name:'Cold section', icon:'❄️'  },
  { id:'pc3', name:'Pizza oven',   icon:'🍕' },
  { id:'pc4', name:'Bar',          icon:'🍸' },
  { id:'pc5', name:'Expo / pass',  icon:'📋' },
];

function getProductionCentres() {
  try {
    const stored = JSON.parse(localStorage.getItem('rpos-print-routing') || 'null');
    // Use user-created centres if they exist, otherwise fall back to defaults
    return stored?.centres?.length ? stored.centres : DEFAULT_PRODUCTION_CENTRES;
  } catch { return DEFAULT_PRODUCTION_CENTRES; }
}

const ADJECTIVES = ['APPLE','BAKER','CEDAR','DONUT','EMBER','FROST','GROVE','HONEY','IVORY','JAZZY'];
const genCode = () => `${ADJECTIVES[Math.floor(Math.random()*10)]}-${Math.floor(1000+Math.random()*9000)}`;

const DEVICE_TYPES = [
  { id:'pos',      label:'POS Terminal',     icon:'🖥' },
  { id:'kds',      label:'Kitchen Display',  icon:'📺' },
  { id:'kiosk',    label:'Self-service Kiosk',icon:'⬜' },
  { id:'handheld', label:'Handheld',         icon:'📱' },
];

const DEFAULT_PROFILES = [
  { id:'prof-1', name:'Main counter' },
  { id:'prof-2', name:'Bar terminal' },
  { id:'prof-3', name:'Server handheld' },
];
// getProfiles reads from localStorage which is kept in sync with Supabase device_profiles by SyncBridge

const S = {
  page: { padding:'32px 40px', maxWidth:860 },
  h1: { fontSize:22, fontWeight:800, marginBottom:4, color:'var(--t1)' },
  sub: { fontSize:13, color:'var(--t3)', marginBottom:32 },
  card: { background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:12, padding:24, marginBottom:20 },
  btn: { padding:'9px 18px', borderRadius:8, border:'none', cursor:'pointer', fontSize:13, fontWeight:700, fontFamily:'inherit' },
  btnPrimary: { background:'var(--acc)', color:'#fff' },
  btnGhost: { background:'var(--bg3)', color:'var(--t2)', border:'1px solid var(--bdr)' },
  btnDanger: { background:'#fef2f2', color:'#dc2626', border:'1px solid #fecaca' },
  input: { width:'100%', padding:'9px 12px', borderRadius:8, border:'1px solid var(--bdr)', background:'var(--bg)', color:'var(--t1)', fontSize:13, fontFamily:'inherit', outline:'none', boxSizing:'border-box' },
  label: { fontSize:12, fontWeight:600, color:'var(--t3)', marginBottom:4, display:'block' },
};

function getProfiles() {
  try { return JSON.parse(localStorage.getItem('rpos-device-profiles') || 'null') || DEFAULT_PROFILES; }
  catch { return DEFAULT_PROFILES; }
}

function getPrinters() {
  try { return JSON.parse(localStorage.getItem('rpos-printers') || '[]'); } catch { return []; }
}

function PrinterSelect({ value, onChange, placeholder = 'No receipt printer' }) {
  const [printers, setPrinters] = useState(getPrinters);
  useEffect(() => {
    const handler = () => setPrinters(getPrinters());
    window.addEventListener('rpos-printers-updated', handler);
    return () => window.removeEventListener('rpos-printers-updated', handler);
  }, []);
  return (
    <select style={S.input} value={value || ''} onChange={e => onChange(e.target.value)}>
      <option value="">{placeholder}</option>
      {printers.map(p => <option key={p.id} value={p.id}>🖨 {p.name}{p.location ? ` (${p.location})` : ''}</option>)}
    </select>
  );
}

function ProfileSelect({ value, onChange }) {
  const [profiles, setProfiles] = useState(() => {
    try {
      const stored = JSON.parse(localStorage.getItem('rpos-device-profiles') || 'null');
      return stored?.length ? stored : DEFAULT_PROFILES;
    } catch { return DEFAULT_PROFILES; }
  });

  // Re-read when localStorage is updated (e.g. after DeviceProfiles section saves)
  useEffect(() => {
    const refresh = () => {
      try {
        const stored = JSON.parse(localStorage.getItem('rpos-device-profiles') || 'null');
        if (stored?.length) setProfiles(stored);
      } catch {}
    };
    window.addEventListener('storage', refresh);
    // Also fetch fresh from Supabase
    (async () => {
      try {
        const locId = await getLocationId();
        if (!locId || !supabase) return;
        const { data } = await supabase
          .from('device_profiles')
          .select('id, name')
          .eq('location_id', locId)
          .order('sort_order');
        if (data?.length) {
          setProfiles(data);
          localStorage.setItem('rpos-device-profiles',
            JSON.stringify(data.map(p => ({ ...p }))));
        }
      } catch {}
    })();
    return () => window.removeEventListener('storage', refresh);
  }, []);

  return (
    <select style={S.input} value={value||''} onChange={e=>onChange(e.target.value)}>
      <option value="">No profile</option>
      {profiles.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}
    </select>
  );
}

export default function DeviceRegistry() {
  const showToast = useStore(s => s.showToast);
  const [devices, setDevices] = useState([]);
  const [locationId, setLocationId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [pairStep, setPairStep] = useState(1);
  const [newDevice, setNewDevice] = useState({ name:'', type:'pos', profileId:'', centreId:'', receiptPrinterId:'' });
  const [pairingCode, setPairingCode] = useState('');
  const [pairedDeviceId, setPairedDeviceId] = useState(null);
  const [editId, setEditId] = useState(null);
  const [editForm, setEditForm] = useState({});
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [showCodeFor, setShowCodeFor] = useState(null); // device id to show code for

  useEffect(() => { init(); }, []);

  const init = async () => {
    setLoading(true);
    if (isMock) { setLoading(false); return; }
    const { data:{ user } } = await supabase.auth.getUser();
    if (!user) { setLoading(false); return; }
    const { data:profile } = await supabase.from('user_profiles').select('location_id').eq('id', user.id).single();
    if (profile?.location_id) {
      setLocationId(profile.location_id);
      await loadDevices(profile.location_id);
    }
    setLoading(false);
  };

  const loadDevices = async (locId) => {
    const { data } = await supabase.from('devices').select('*').eq('location_id', locId).order('created_at');
    setDevices(data || []);
  };

  const startPairing = async () => {
    if (!newDevice.name.trim()) return setError('Terminal name required');
    setWorking(true); setError('');
    const code = genCode();
    const { data, error:err } = await supabase.from('devices').insert({
      location_id: locationId,
      name: newDevice.name.trim(),
      type: newDevice.type,
      pairing_code: code,
      profile_id: newDevice.type !== 'kds' ? (newDevice.profileId || null) : null,
      centre_id: newDevice.type === 'kds' ? (newDevice.centreId || null) : null,
      // v5.5.835: receipts route to the printer set on the device — so a device created
      // without one cannot print at all. Set it here at creation rather than making the
      // operator go back into Edit afterwards.
      receipt_printer_id: newDevice.type !== 'kds' ? (newDevice.receiptPrinterId || null) : null,
      status: 'unpaired',
    }).select().single();
    setWorking(false);
    reportSave('device', err);
    if (err) return setError(err.message);
    setPairingCode(code);
    setPairedDeviceId(data.id);
    await loadDevices(locationId);
    setPairStep(2);
  };

  const cancelPairing = async () => {
    if (pairedDeviceId) {
      const { data, error } = await supabase.from('devices').delete().eq('id', pairedDeviceId).select('id');
      const failure = error || (!data || data.length === 0
        ? new Error(`Delete matched 0 rows for id=${pairedDeviceId} — RLS may have blocked it`)
        : null);
      reportSave('device delete', failure);
      // The half-created terminal is still registered (and still pairable) — the list
      // below reloads and shows it, so say so rather than implying it's gone.
      if (failure) showToast('Could not cancel — the terminal is still registered. Remove it from the list below.', 'error');
    }
    setShowAdd(false); setPairStep(1); setPairingCode(''); setPairedDeviceId(null);
    setNewDevice({ name:'', type:'pos', profileId:'', centreId:'', receiptPrinterId:'' });
    if (locationId) await loadDevices(locationId);
  };

  const regenerateCode = async (deviceId) => {
    const code = genCode();
    const { data, error } = await supabase.from('devices')
      .update({ pairing_code:code, status:'unpaired', paired_at:null })
      .eq('id', deviceId).select('id');
    const failure = error || (!data || data.length === 0
      ? new Error(`Pairing-code update matched 0 rows for id=${deviceId} — RLS may have blocked it`)
      : null);
    reportSave('device pairing code', failure);
    if (failure) {
      // Never reveal a code the DB didn't accept — the OLD code is still the live one.
      showToast('Could not issue a new code — the previous code is still the valid one', 'error');
      return;
    }
    setShowCodeFor(deviceId);
    if (locationId) await loadDevices(locationId);
  };

  const removeDevice = async (id) => {
    if (!confirm('Remove this device? The terminal will be locked out immediately.')) return;
    const { data, error } = await supabase.from('devices').delete().eq('id', id).select('id');
    const failure = error || (!data || data.length === 0
      ? new Error(`Delete matched 0 rows for id=${id} — RLS may have blocked it`)
      : null);
    reportSave('device delete', failure);
    if (failure) {
      showToast('Remove failed — this terminal is still paired and can still take orders', 'error');
      return;
    }
    if (locationId) await loadDevices(locationId);
  };

  const startEdit = (d) => {
    setEditId(d.id);
    setEditForm({ name: d.name, type: d.type, profileId: d.profile_id || '', centreId: d.centre_id || '', receiptPrinterId: d.receipt_printer_id || '' });
  };

  const saveEdit = async () => {
    if (!editForm.name?.trim()) return;
    setWorking(true);
    const { data, error } = await supabase.from('devices').update({
      name: editForm.name.trim(),
      type: editForm.type,
      profile_id: editForm.type !== 'kds' ? (editForm.profileId || null) : null,
      centre_id: editForm.type === 'kds' ? (editForm.centreId || null) : null,
      receipt_printer_id: editForm.receiptPrinterId || null,
    }).eq('id', editId).select('id');
    const failure = error || (!data || data.length === 0
      ? new Error(`Device update matched 0 rows for id=${editId} — RLS may have blocked it`)
      : null);
    reportSave('device', failure);
    setWorking(false);
    if (failure) {
      // Leave the edit row open so the operator keeps their changes and can retry.
      showToast(`"${editForm.name.trim()}" NOT saved — the server rejected the change`, 'error');
      return;
    }
    setEditId(null);
    if (locationId) await loadDevices(locationId);
  };

  const statusBadge = (s) => ({
    active:   { bg:'#dcfce7', color:'#166534', label:'Active' },
    unpaired: { bg:'#fef9c3', color:'#854d0e', label:'Waiting for pairing' },
    offline:  { bg:'#f1f5f9', color:'#64748b', label:'Offline' },
  }[s] || { bg:'#f1f5f9', color:'#64748b', label:s });

  return (
    <div style={S.page}>
      <div style={S.h1}>📱 Devices</div>
      <div style={S.sub}>Manage POS terminals, KDS screens and kiosks at this location</div>

      {!showAdd && (
        <button onClick={()=>{ setShowAdd(true); setPairStep(1); setError(''); }}
          style={{ ...S.btn, ...S.btnPrimary, marginBottom:24 }}>
          + Add terminal
        </button>
      )}

      {/* ── Add terminal flow ── */}
      {showAdd && (
        <div style={{ ...S.card, borderColor:'var(--acc)', borderWidth:2, marginBottom:24 }}>
          {pairStep === 1 && (
            <>
              <div style={{ fontSize:15, fontWeight:700, color:'var(--t1)', marginBottom:20 }}>
                Step 1 — Configure the terminal
              </div>
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:12, marginBottom:16 }}>
                <div>
                  <label style={S.label}>Terminal name *</label>
                  <input style={S.input} placeholder="Counter 1, Bar terminal…" value={newDevice.name}
                    onChange={e=>setNewDevice(d=>({...d,name:e.target.value}))} />
                </div>
                <div>
                  <label style={S.label}>Device type</label>
                  <select style={S.input} value={newDevice.type} onChange={e=>setNewDevice(d=>({...d,type:e.target.value}))}>
                    {DEVICE_TYPES.map(t=><option key={t.id} value={t.id}>{t.icon} {t.label}</option>)}
                  </select>
                </div>
                <div>
                  {newDevice.type === 'kds' ? (
                    <>
                      <label style={S.label}>Production center</label>
                      <select style={S.input} value={newDevice.centreId||''} onChange={e=>setNewDevice(d=>({...d,centreId:e.target.value}))}>
                        <option value="">Select production center…</option>
                        {getProductionCentres().map(pc=><option key={pc.id} value={pc.id}>{pc.icon} {pc.name}</option>)}
                      </select>
                    </>
                  ) : (
                    <>
                      <label style={S.label}>Device profile</label>
                      <ProfileSelect value={newDevice.profileId} onChange={v=>setNewDevice(d=>({...d,profileId:v}))} />
                    </>
                  )}
                </div>
              </div>
              {/* v5.5.835: receipt printer at creation time. KDS never prints receipts,
                  so the field is hidden for it — same rule as the edit form. */}
              {newDevice.type !== 'kds' && (
                <div style={{ marginBottom:16, maxWidth:360 }}>
                  <label style={S.label}>Receipt printer</label>
                  <PrinterSelect value={newDevice.receiptPrinterId} onChange={v=>setNewDevice(d=>({...d,receiptPrinterId:v}))} />
                  <div style={{ fontSize:11, color: newDevice.receiptPrinterId ? 'var(--t3)' : 'var(--red)', marginTop:5, lineHeight:1.5 }}>
                    {newDevice.receiptPrinterId
                      ? 'Customer receipts taken on this terminal print here.'
                      : 'Without a printer this terminal cannot print customer receipts — it will show "No printer set" instead of printing to another till.'}
                  </div>
                </div>
              )}
              {error && <div style={{ padding:'8px 12px', borderRadius:8, background:'#fef2f2', color:'#dc2626', fontSize:13, marginBottom:12 }}>{error}</div>}
              <div style={{ display:'flex', gap:8 }}>
                <button onClick={startPairing} disabled={working} style={{ ...S.btn, ...S.btnPrimary }}>
                  {working ? 'Generating code…' : 'Generate pairing code →'}
                </button>
                <button onClick={()=>setShowAdd(false)} style={{ ...S.btn, ...S.btnGhost }}>Cancel</button>
              </div>
            </>
          )}

          {pairStep === 2 && (
            <>
              <div style={{ fontSize:15, fontWeight:700, color:'var(--t1)', marginBottom:8 }}>
                Step 2 — Enter this code on the device
              </div>
              <div style={{ fontSize:13, color:'var(--t3)', marginBottom:24 }}>
                Open the POS app on the device. On the pairing screen, enter this code:
              </div>
              <div style={{ background:'var(--bg)', border:'2px dashed var(--acc)', borderRadius:16, padding:'32px', textAlign:'center', marginBottom:24 }}>
                <div style={{ fontSize:11, fontWeight:700, color:'var(--t3)', letterSpacing:'.1em', textTransform:'uppercase', marginBottom:8 }}>Pairing code</div>
                <div style={{ fontSize:48, fontWeight:800, letterSpacing:'.15em', color:'var(--acc)', fontFamily:'monospace' }}>{pairingCode}</div>
                <div style={{ fontSize:12, color:'var(--t3)', marginTop:8 }}>
                  {newDevice.name} · {DEVICE_TYPES.find(t=>t.id===newDevice.type)?.label}
                </div>
              </div>
              <div style={{ display:'flex', gap:8 }}>
                <button onClick={()=>{ setShowAdd(false); setPairStep(1); setPairingCode(''); setNewDevice({name:'',type:'pos',profileId:'',centreId:'',receiptPrinterId:''}); }}
                  style={{ ...S.btn, ...S.btnPrimary }}>Done</button>
                <button onClick={cancelPairing} style={{ ...S.btn, ...S.btnGhost }}>Cancel pairing</button>
              </div>
            </>
          )}
        </div>
      )}

      {/* ── Device list ── */}
      <div style={S.card}>
        <div style={{ fontSize:13, fontWeight:700, color:'var(--t2)', marginBottom:16 }}>
          Registered devices ({devices.length})
        </div>

        {loading && <div style={{ color:'var(--t3)', fontSize:13 }}>Loading…</div>}

        {!loading && !locationId && !isMock && (
          <div style={{ textAlign:'center', padding:'40px 0', color:'var(--t3)', fontSize:13 }}>
            No location assigned — create one in Company Admin first
          </div>
        )}

        {!loading && devices.length === 0 && locationId && (
          <div style={{ textAlign:'center', padding:'40px 0', color:'var(--t3)', fontSize:13 }}>
            No terminals paired yet — click "Add terminal" above
          </div>
        )}

        {devices.map(d => {
          const dtype = DEVICE_TYPES.find(t=>t.id===d.type)||DEVICE_TYPES[0];
          const sb = statusBadge(d.status);
          const profileName = getProfiles().find(p=>p.id===d.profile_id)?.name || '—';
          const isEditing = editId === d.id;
          const showCode = showCodeFor === d.id;

          return (
            <div key={d.id} style={{ padding:'16px 0', borderBottom:'1px solid var(--bdr)' }}>
              {isEditing ? (
                /* Edit mode */
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr 1fr auto', gap:10, alignItems:'end' }}>
                  <div>
                    <label style={S.label}>Name</label>
                    <input style={S.input} value={editForm.name} onChange={e=>setEditForm(f=>({...f,name:e.target.value}))} />
                  </div>
                  <div>
                    <label style={S.label}>Type</label>
                    <select style={S.input} value={editForm.type} onChange={e=>setEditForm(f=>({...f,type:e.target.value}))}>
                      {DEVICE_TYPES.map(t=><option key={t.id} value={t.id}>{t.icon} {t.label}</option>)}
                    </select>
                  </div>
                  <div>
                    {editForm.type === 'kds' ? (
                      <>
                        <label style={S.label}>Production center</label>
                        <select style={S.input} value={editForm.centreId||''} onChange={e=>setEditForm(f=>({...f,centreId:e.target.value}))}>
                          <option value="">Select center…</option>
                          {getProductionCentres().map(pc=><option key={pc.id} value={pc.id}>{pc.icon} {pc.name}</option>)}
                        </select>
                      </>
                    ) : (
                      <>
                        <label style={S.label}>Profile</label>
                        <ProfileSelect value={editForm.profileId} onChange={v=>setEditForm(f=>({...f,profileId:v}))} />
                      </>
                    )}
                  </div>
                  {editForm.type !== 'kds' && (
                    <div>
                      <label style={S.label}>Receipt printer</label>
                      <PrinterSelect value={editForm.receiptPrinterId} onChange={v=>setEditForm(f=>({...f,receiptPrinterId:v}))} />
                    </div>
                  )}
                  <div style={{ display:'flex', gap:6 }}>
                    <button onClick={saveEdit} disabled={working} style={{ ...S.btn, ...S.btnPrimary, padding:'9px 12px' }}>Save</button>
                    <button onClick={()=>setEditId(null)} style={{ ...S.btn, ...S.btnGhost, padding:'9px 12px' }}>✕</button>
                  </div>
                </div>
              ) : (
                /* View mode */
                <div style={{ display:'flex', alignItems:'center', gap:16 }}>
                  <div style={{ fontSize:28, width:40, textAlign:'center' }}>{dtype.icon}</div>
                  <div style={{ flex:1 }}>
                    <div style={{ fontWeight:700, color:'var(--t1)', fontSize:14 }}>{d.name}</div>
                    <div style={{ fontSize:12, color:'var(--t3)' }}>
                      {dtype.label} · {d.type === 'kds' ? 'Center' : 'Profile'}: {profileName}
                      {d.receipt_printer_id && (() => { const p = getPrinters().find(x=>x.id===d.receipt_printer_id); return p ? <span> · 🖨 {p.name}</span> : null; })()}
                      {d.last_seen && <span> · Last seen {new Date(d.last_seen).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})}</span>}
                    </div>

                    {/* Show pairing code inline */}
                    {(d.status==='unpaired'||showCode) && d.pairing_code && (
                      <div style={{ marginTop:8, display:'inline-flex', alignItems:'center', gap:10, background:'var(--acc-d)', border:'1px solid var(--acc-b)', borderRadius:8, padding:'6px 12px' }}>
                        <span style={{ fontSize:11, color:'var(--t3)', textTransform:'uppercase', letterSpacing:'.06em' }}>Pairing code:</span>
                        <span style={{ fontFamily:'monospace', fontSize:18, fontWeight:800, color:'var(--acc)', letterSpacing:'.1em' }}>{d.pairing_code}</span>
                      </div>
                    )}
                  </div>

                  <span style={{ padding:'4px 10px', borderRadius:20, fontSize:11, fontWeight:700, background:sb.bg, color:sb.color }}>
                    {sb.label}
                  </span>

                  <div style={{ display:'flex', gap:6 }}>
                    <button onClick={()=>startEdit(d)} style={{ ...S.btn, ...S.btnGhost, padding:'6px 12px', fontSize:12 }}>Edit</button>
                    {d.status !== 'unpaired' && (
                      <>
                        <button onClick={()=>setShowCodeFor(showCode?null:d.id)}
                          style={{ ...S.btn, ...S.btnGhost, padding:'6px 12px', fontSize:12 }}>
                          {showCode?'Hide code':'Show code'}
                        </button>
                        {showCode && (
                          <button onClick={()=>regenerateCode(d.id)}
                            style={{ ...S.btn, ...S.btnDanger, padding:'6px 12px', fontSize:12 }}>
                            New code
                          </button>
                        )}
                      </>
                    )}
                    <button onClick={()=>removeDevice(d.id)} style={{ ...S.btn, ...S.btnDanger, padding:'6px 12px', fontSize:12 }}>Remove</button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
