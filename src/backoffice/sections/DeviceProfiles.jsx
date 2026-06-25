import { useState, useEffect } from 'react';
import { useStore } from '../../store';
import { supabase, isMock, getLocationId } from '../../lib/supabase';

const SURFACES = [
  { id:'tables', label:'Floor plan', icon:'⬚', desc:'Opens to the table layout view' },
  { id:'pos',    label:'POS ordering', icon:'⊞', desc:'Opens straight to the menu/ordering screen' },
  { id:'bar',    label:'Bar tabs', icon:'🍸', desc:'Opens to the bar tab management screen' },
  { id:'kds',    label:'Kitchen display', icon:'▣', desc:'Opens to the KDS screen (for kitchen units)' },
  { id:'mpos',   label:'MPOS (mobile)', icon:'📱', desc:'Phone or Sunmi handheld for servers and runners. Card-only — Stripe Tap to Pay or assigned reader.' },
];

// MPOS payment mode — only relevant when defaultSurface === 'mpos'
const MPOS_PAYMENT_MODES = [
  { id:'tap_to_pay',          label:'Tap to Pay on this device', desc:'Use the phone’s built-in NFC. Requires native shell (Phase 1B).' },
  { id:'assigned_reader',     label:'Assigned network reader',   desc:'Pair to a fixed BBPOS WisePOS E or S700.' },
  { id:'pay_at_counter_only', label:'Pay at counter only',       desc:'Server takes orders only — cash/card all routed to the counter POS.' },
];

// Customer-facing display destination (per terminal — matches the hardware it has)
const CUSTOMER_DISPLAY_MODES = [
  { id:'auto',   label:'Auto (recommended)', desc:'Use a dedicated screen if present, otherwise the card reader.' },
  { id:'screen', label:'Dedicated screen',   desc:'Customer-facing second screen, e.g. Sunmi D3 Pro rear / external monitor.' },
  { id:'reader', label:'Card reader screen', desc:'Show the order on the WisePOS E reader screen.' },
  { id:'off',    label:'Off',                desc:'No customer-facing display.' },
];

const ORDER_TYPES = [
  { id:'dine-in',    label:'Dine in',    icon:'🍽' },
  { id:'takeaway',   label:'Takeaway',   icon:'🥡' },
  { id:'collection', label:'Collection', icon:'📦' },
];

// v4.5.1: trimmed to only the features actually wired in the codebase.
// Removed (Apr 26): kds (KDS is now a standalone product), kiosk (own surface, not a flag),
// reports (cosmetic-only — Back Office is web-accessible anyway), discounts/voids/splitCheck/
// tableTransfer (all pure stubs — never wired to anything).
const FEATURES = [
  { id:'barTabs', label:'Bar tabs',          desc:'Hide bar tab surface from POS sidebar' },
  { id:'courses', label:'Course management', desc:'Hide per-course headers + Fire course buttons. Items still carry course assignment internally.' },
];

const DEFAULT_PROFILES = [
  {
    id:'prof-1', name:'Main counter', color:'#3b82f6',
    defaultSurface:'tables', enabledOrderTypes:['dine-in','takeaway','collection'],
    assignedSection:null, hiddenFeatures:[], tableServiceEnabled:true,
    quickScreenEnabled:true, receiptPrinterId:'pr1', deviceCount:1,
    autoPrintReceiptOnClose:true, orderNotifications:true,
  },
  {
    id:'prof-2', name:'Bar terminal', color:'#e8a020',
    defaultSurface:'bar', enabledOrderTypes:['dine-in'],
    assignedSection:'bar', hiddenFeatures:['courses','kiosk','reports'],
    tableServiceEnabled:false, quickScreenEnabled:true,
    receiptPrinterId:'pr3', deviceCount:1,
    autoPrintReceiptOnClose:true, orderNotifications:true,
  },
  {
    id:'prof-3', name:'Server handheld', color:'#22c55e',
    defaultSurface:'pos', enabledOrderTypes:['dine-in'],
    assignedSection:null, hiddenFeatures:['kiosk','reports','discounts','voids'],
    tableServiceEnabled:true, quickScreenEnabled:true,
    receiptPrinterId:'pr1', deviceCount:1,
    autoPrintReceiptOnClose:true, orderNotifications:true,
  },
];

export default function DeviceProfiles() {
  const { showToast, devices, setDeviceConfig, markBOChange } = useStore();
  const [profiles, setProfiles] = useState(() => {
    try { return JSON.parse(localStorage.getItem('rpos-device-profiles') || '[]'); } catch { return []; }
  });
  const [editing, setEditing] = useState(null);
  const [showNew, setShowNew] = useState(false);
  const [locationId, setLocationId] = useState(null);

  // Load from Supabase on mount — replaces localStorage cache with fresh data
  useEffect(() => {
    if (isMock) { setProfiles(DEFAULT_PROFILES); return; }
    const loadFromDB = async () => {
      const locId = await getLocationId().catch(() => null);
      if (!locId) return;
      setLocationId(locId);

      // Fetch profiles AND devices in parallel to get real device counts
      const [{ data: profileData }, { data: deviceData }] = await Promise.all([
        supabase.from('device_profiles').select('*').eq('location_id', locId).order('sort_order'),
        supabase.from('devices').select('id, profile_id').eq('location_id', locId),
      ]);

      // Count devices per profile
      const countMap = {};
      (deviceData || []).forEach(d => {
        if (d.profile_id) countMap[d.profile_id] = (countMap[d.profile_id] || 0) + 1;
      });

      const mapped = (profileData || []).map(p => ({
        id: p.id, name: p.name, color: p.color || '#3b82f6',
        defaultSurface: p.default_surface || 'tables',
        enabledOrderTypes: p.enabled_order_types || ['dine-in'],
        assignedSection: p.assigned_section, hiddenFeatures: p.hidden_features || [],
        tableServiceEnabled: p.table_service_enabled !== false,
        quickScreenEnabled: p.quick_screen_enabled !== false,
        autoPrintReceiptOnClose: p.auto_print_receipt_on_close !== false,
        orderNotifications: p.order_notifications !== false,
        menuId: p.menu_id,
        deviceCount: countMap[p.id] || 0,
        serviceCharge: p.service_charge || null,
        isMaster: p.is_master || false,
        trainingMode: p.training_mode === true,   // v5.5.645: per-device training

        // v5.5.60 MPOS-only fields
        runnerMode: p.runner_mode === true,
        paymentMode: p.payment_mode || 'tap_to_pay',
        customerDisplayMode: p.customer_display_mode || 'auto',
        customerDisplayImages: Array.isArray(p.customer_display_images) ? p.customer_display_images : [],
        assignedReaderId: p.assigned_reader_id || null,
      }));
      setProfiles(mapped);
      try { localStorage.setItem('rpos-device-profiles', JSON.stringify(mapped)); } catch {}
    };
    loadFromDB();
  }, []);

  const toDbRow = (p, locId) => ({
    id: p.id,
    location_id: locId || locationId,
    name: p.name,
    color: p.color || '#3b82f6',
    default_surface: p.defaultSurface,
    enabled_order_types: p.enabledOrderTypes,
    assigned_section: p.assignedSection || null,
    hidden_features: p.hiddenFeatures || [],
    table_service_enabled: p.tableServiceEnabled !== false,
    quick_screen_enabled: p.quickScreenEnabled !== false,
    auto_print_receipt_on_close: p.autoPrintReceiptOnClose !== false,
    order_notifications: p.orderNotifications !== false,
    menu_id: p.menuId || null,
    sort_order: p.sortOrder || 0,
    service_charge: p.serviceCharge || null,
    is_master: p.isMaster || false,
    training_mode: p.trainingMode === true,   // v5.5.645: per-device training

    // v5.5.60 MPOS-only fields
    runner_mode: p.runnerMode === true,
    payment_mode: p.paymentMode || 'tap_to_pay',
    customer_display_mode: p.customerDisplayMode || 'auto',
    customer_display_images: p.customerDisplayImages || [],
    assigned_reader_id: p.assignedReaderId || null,
  });

  // Always resolve a real locationId — never save with null
  const resolveLocId = async () => {
    if (locationId) return locationId;
    
    const id = await getLocationId().catch(() => null);
    if (id) setLocationId(id);
    return id;
  };

  const save = async (updated) => {
    // Close panel immediately so it feels instant
    setEditing(null);
    setShowNew(false);

    // Update local state and localStorage immediately
    setProfiles(ps => ps.map(p => p.id === updated.id ? updated : p));
    try {
      const cur = JSON.parse(localStorage.getItem('rpos-device-profiles') || '[]');
      const exists = cur.find(p => p.id === updated.id);
      const next = exists
        ? cur.map(p => p.id === updated.id ? updated : p)
        : [...cur, updated];
      localStorage.setItem('rpos-device-profiles', JSON.stringify(next));
    } catch {}

    markBOChange();

    if (!isMock) {
      try {
        const locId = await resolveLocId();
        if (!locId) throw new Error('Could not resolve location ID');

        const row = toDbRow(updated, locId);
        // Use update for existing profiles, insert for new ones
        let error;
        const existing = await supabase.from('device_profiles').select('id').eq('id', row.id).single();
        if (existing.data) {
          // Update all fields explicitly
          const { error: e, data: dataUp } = await supabase.from('device_profiles').update(row).eq('id', row.id).select('id');
          if (!dataUp || dataUp.length === 0) throw new Error(`Profile update matched 0 rows for id=${p.id}. Column may be missing (run migration) or RLS blocked it.`);
          error = e;
        } else {
          const { error: e } = await supabase.from('device_profiles').insert(row);
          error = e;
        }
        if (error) throw error;
        showToast(`"${updated.name}" saved`, 'success');
      } catch (err) {
        console.error('Profile save failed:', err);
        showToast('Save failed — check connection', 'error');
      }
    } else {
      showToast(`"${updated.name}" saved`, 'success');
    }
  };

  const addProfile = async (profile) => {
    const nextId = `prof-${Date.now()}`;
    const newProfile = { ...profile, id: nextId, deviceCount: 0 };

    // Close panel immediately
    setShowNew(false);

    // Update local state and localStorage immediately
    setProfiles(ps => [...ps, newProfile]);
    try {
      const cur = JSON.parse(localStorage.getItem('rpos-device-profiles') || '[]');
      localStorage.setItem('rpos-device-profiles', JSON.stringify([...cur, newProfile]));
    } catch {}

    markBOChange();
    showToast(`"${profile.name}" profile created`, 'success');

    if (!isMock) {
      try {
        const locId = await resolveLocId();
        if (!locId) throw new Error('No location ID');
        const row = toDbRow(newProfile, locId);
        const { error } = await supabase.from('device_profiles').insert(row);
        if (error) throw error;
      } catch (err) {
        console.error('Profile insert failed:', err);
        showToast('Could not save to cloud — check connection', 'error');
      }
    }
  };

  const deleteProfile = async (id) => {
    setProfiles(ps => ps.filter(p => p.id !== id));
    if (!isMock) await supabase.from('device_profiles').delete().eq('id', id);
    try {
      const cur = JSON.parse(localStorage.getItem('rpos-device-profiles') || '[]');
      localStorage.setItem('rpos-device-profiles', JSON.stringify(cur.filter(p => p.id !== id)));
    } catch {}
    markBOChange();
    showToast('Profile deleted', 'info');
  };

  return (
    <div style={{ flex:1, overflowY:'auto', padding:28 }}>
      <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', marginBottom:24 }}>
        <div>
          <div style={{ fontSize:14, color:'var(--t3)', marginTop:4, maxWidth:560 }}>
            Profiles control what each terminal shows and can do. Assign a profile to a device and it immediately adapts — the bar terminal never shows takeaway, the counter shows everything.
          </div>
        </div>
        <button onClick={() => setShowNew(true)} style={{
          padding:'8px 18px', borderRadius:10, cursor:'pointer', fontFamily:'inherit',
          background:'var(--acc)', border:'none', color:'#0b0c10', fontSize:13, fontWeight:700, flexShrink:0,
        }}>+ New profile</button>
      </div>

      {/* Profile cards */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(320px, 1fr))', gap:14 }}>
        {profiles.map(prof => {
          const devCount = (devices || []).filter(d => d.profileId === prof.id).length || prof.deviceCount || 0;
          const orderTypes = prof.enabledOrderTypes || [];
          const hiddenFeats = prof.hiddenFeatures || [];
          return (
            <div key={prof.id} style={{
              background:'var(--bg1)', border:'1px solid var(--bdr)',
              borderRadius:16, overflow:'hidden',
              borderTop:`3px solid ${prof.color}`,
            }}>
              {/* Header */}
              <div style={{ padding:'16px 18px 14px' }}>
                <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', marginBottom:10 }}>
                  <div>
                    <div style={{ fontSize:16, fontWeight:800, color:'var(--t1)' }}>{prof.name}</div>
                    <div style={{ fontSize:11, color:'var(--t3)', marginTop:3 }}>
                      {devCount} device{devCount !== 1 ? 's' : ''} using this profile
                    </div>
                  </div>
                  <div style={{
                    padding:'4px 10px', borderRadius:20, fontSize:10, fontWeight:700,
                    background:`${prof.color}22`, color:prof.color,
                    border:`1px solid ${prof.color}44`,
                  }}>
                    {SURFACES.find(s => s.id === prof.defaultSurface)?.label || prof.defaultSurface}
                  </div>
                </div>

                {/* Config summary */}
                <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
                  {prof.trainingMode && <ConfigRow label="Training mode" value="🎓 ON — nothing committed" valueColor="#B45309"/>}
                  <ConfigRow label="Default screen" value={SURFACES.find(s => s.id === prof.defaultSurface)?.label}/>
                  <ConfigRow label="Order types" value={orderTypes.map(t => ORDER_TYPES.find(o => o.id === t)?.icon + ' ' + ORDER_TYPES.find(o => o.id === t)?.label).join(' · ') || 'None'}/>
                  <ConfigRow label="Table service" value={prof.tableServiceEnabled ? '✓ Enabled' : '✕ Disabled'} valueColor={prof.tableServiceEnabled ? 'var(--grn)' : 'var(--red)'}/>
                  <ConfigRow label="Auto-print receipt" value={prof.autoPrintReceiptOnClose !== false ? '✓ Enabled' : '✕ Disabled'} valueColor={prof.autoPrintReceiptOnClose !== false ? 'var(--grn)' : 'var(--red)'}/>
                  <ConfigRow label="Section" value={prof.assignedSection || 'All sections'}/>
                  {hiddenFeats.length > 0 && (
                    <ConfigRow label="Hidden features" value={hiddenFeats.join(', ')} truncate/>
                  )}
                </div>
              </div>

              {/* Actions */}
              <div style={{ padding:'10px 18px', borderTop:'1px solid var(--bdr)', display:'flex', gap:8, background:'var(--bg2)' }}>
                <button onClick={() => setEditing({ ...prof })} style={{
                  flex:1, height:34, borderRadius:8, cursor:'pointer', fontFamily:'inherit',
                  background:'var(--bg3)', border:'1px solid var(--bdr2)', color:'var(--t2)', fontSize:12, fontWeight:600,
                }}>Edit profile</button>
                <button onClick={() => {
                  setDeviceConfig({
                    profileId: prof.id,
                    profileName: prof.name,
                    defaultSurface: prof.defaultSurface,
                    enabledOrderTypes: orderTypes,
                    assignedSection: prof.assignedSection,
                    hiddenFeatures: hiddenFeats,
                    tableServiceEnabled: prof.tableServiceEnabled,
                    quickScreenEnabled: prof.quickScreenEnabled,
                    autoPrintReceiptOnClose: prof.autoPrintReceiptOnClose !== false,
                    menuId: prof.menuId,
                    receiptPrinterId: prof.receiptPrinterId,
                  });
                  showToast(`"${prof.name}" applied to this terminal`, 'success');
                }} style={{
                  flex:1, height:34, borderRadius:8, cursor:'pointer', fontFamily:'inherit',
                  background:`${prof.color}22`, border:`1px solid ${prof.color}44`, color:prof.color, fontSize:12, fontWeight:700,
                }}>Apply to this terminal</button>
              </div>
            </div>
          );
        })}
      </div>

      {editing && <ProfileEditor profile={editing} onSave={save} onDelete={() => { deleteProfile(editing.id); setEditing(null); }} onClose={() => setEditing(null)}/>}
      {showNew  && <ProfileEditor profile={null} onSave={addProfile} onClose={() => setShowNew(false)}/>}
    </div>
  );
}

function ConfigRow({ label, value, valueColor, truncate }) {
  return (
    <div style={{ display:'flex', justifyContent:'space-between', gap:10, fontSize:12 }}>
      <span style={{ color:'var(--t4)', flexShrink:0 }}>{label}</span>
      <span style={{ color: valueColor || 'var(--t2)', fontWeight:500, textAlign:'right', overflow: truncate ? 'hidden' : 'visible', textOverflow: truncate ? 'ellipsis' : 'clip', whiteSpace: truncate ? 'nowrap' : 'normal' }}>{value}</span>
    </div>
  );
}

// ── Profile editor modal ───────────────────────────────────────────────────────
function ProfileEditor({ profile, onSave, onDelete, onClose }) {
  const { menus } = useStore();
  const isNew = !profile;
  const [form, setForm] = useState(profile || {
    name:'', color:'#3b82f6',
    defaultSurface:'tables', enabledOrderTypes:['dine-in'],
    assignedSection:null, hiddenFeatures:[],
    tableServiceEnabled:true, quickScreenEnabled:true, receiptPrinterId:'pr1', menuId:null,
    autoPrintReceiptOnClose:true, orderNotifications:true,
    runnerMode:false, paymentMode:'tap_to_pay', assignedReaderId:null, customerDisplayMode:'auto',
    trainingMode:false,
  });

  const upd = (key, val) => setForm(f => ({ ...f, [key]: val }));

  // Customer-display slideshow image upload (kiosk-assets public bucket).
  const [uploadingImg, setUploadingImg] = useState(false);
  const uploadDisplayImage = async (file) => {
    if (!file || isMock || !supabase) return;
    setUploadingImg(true);
    try {
      const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      const path = `customer-display/${Date.now()}-${safe}`;
      const { error } = await supabase.storage.from('kiosk-assets').upload(path, file, { cacheControl: '3600', upsert: true, contentType: file.type });
      if (error) throw error;
      const { data } = supabase.storage.from('kiosk-assets').getPublicUrl(path);
      if (data?.publicUrl) setForm(f => ({ ...f, customerDisplayImages: [ ...(f.customerDisplayImages || []), data.publicUrl ] }));
    } catch (e) {
      alert('Image upload failed: ' + (e.message || e) + '\n(Check the kiosk-assets storage bucket exists and is public.)');
    } finally {
      setUploadingImg(false);
    }
  };
  const toggleOrderType = id => { const arr = form.enabledOrderTypes || []; upd('enabledOrderTypes', arr.includes(id) ? arr.filter(x => x !== id) : [...arr, id]); };
  const toggleFeature = id => { const arr = form.hiddenFeatures || []; upd('hiddenFeatures', arr.includes(id) ? arr.filter(x => x !== id) : [...arr, id]); };

  const COLORS = ['#3b82f6','#e8a020','#22c55e','#a855f7','#ef4444','#22d3ee','#f97316'];
  const SECTIONS = [null, 'main', 'bar', 'patio'];

  return (
    <div className="modal-back" onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{
        background:'var(--bg1)', border:'1px solid var(--bdr2)', borderRadius:22,
        width:'100%', maxWidth:540, maxHeight:'90vh',
        display:'flex', flexDirection:'column', boxShadow:'var(--sh3)', overflow:'hidden',
      }}>
        <div style={{ padding:'16px 20px', borderBottom:'1px solid var(--bdr)', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
          <div style={{ fontSize:16, fontWeight:800 }}>{isNew ? 'New device profile' : `Edit — ${profile.name}`}</div>
          <button onClick={onClose} style={{ background:'none', border:'none', color:'var(--t3)', cursor:'pointer', fontSize:20 }}>×</button>
        </div>

        <div style={{ flex:1, overflowY:'auto', padding:'18px 20px' }}>
          {/* Name + colour */}
          <div style={{ marginBottom:16 }}>
            <label style={{ display:'block', fontSize:11, fontWeight:700, color:'var(--t3)', textTransform:'uppercase', letterSpacing:'.07em', marginBottom:6 }}>Profile name</label>
            <input style={{ width:'100%', background:'var(--bg3)', border:'1.5px solid var(--bdr2)', borderRadius:10, padding:'9px 12px', color:'var(--t1)', fontSize:13, fontFamily:'inherit', outline:'none', boxSizing:'border-box' }} value={form.name} onChange={e => upd('name', e.target.value)} placeholder="e.g. Bar terminal, Server handheld"/>
          </div>

          <div style={{ marginBottom:18 }}>
            <label style={{ display:'block', fontSize:11, fontWeight:700, color:'var(--t3)', textTransform:'uppercase', letterSpacing:'.07em', marginBottom:8 }}>Profile colour</label>
            <div style={{ display:'flex', gap:8 }}>
              {COLORS.map(c => (
                <button key={c} onClick={() => upd('color', c)} style={{
                  width:28, height:28, borderRadius:'50%', background:c, border:'none', cursor:'pointer',
                  outline: form.color === c ? `3px solid var(--t1)` : '3px solid transparent',
                  outlineOffset:2, transition:'outline .1s',
                }}/>
              ))}
            </div>
          </div>

          {/* Default surface */}
          <div style={{ marginBottom:18 }}>
            <label style={{ display:'block', fontSize:11, fontWeight:700, color:'var(--t3)', textTransform:'uppercase', letterSpacing:'.07em', marginBottom:8 }}>Default screen on startup</label>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
              {SURFACES.map(s => (
                <button key={s.id} onClick={() => upd('defaultSurface', s.id)} style={{
                  padding:'10px 12px', borderRadius:10, cursor:'pointer', fontFamily:'inherit',
                  textAlign:'left', transition:'all .1s',
                  background: form.defaultSurface === s.id ? 'var(--acc-d)' : 'var(--bg3)',
                  border:`1.5px solid ${form.defaultSurface === s.id ? 'var(--acc)' : 'var(--bdr)'}`,
                }}>
                  <div style={{ fontSize:13, fontWeight:700, color: form.defaultSurface === s.id ? 'var(--acc)' : 'var(--t1)', marginBottom:2 }}>{s.icon} {s.label}</div>
                  <div style={{ fontSize:10, color:'var(--t4)' }}>{s.desc}</div>
                </button>
              ))}
            </div>
          </div>

          {/* MPOS-only options — only shown when default surface is MPOS */}
          {form.defaultSurface === 'mpos' && (
            <div style={{ marginBottom:18, padding:14, borderRadius:12, background:'var(--acc-d)', border:'1px solid var(--acc-b)' }}>
              <div style={{ fontSize:11, fontWeight:800, color:'var(--acc)', textTransform:'uppercase', letterSpacing:'.07em', marginBottom:10 }}>📱 MPOS settings</div>

              {/* Runner mode */}
              <label style={{ display:'flex', alignItems:'center', gap:10, cursor:'pointer', marginBottom:14 }}>
                <div onClick={() => upd('runnerMode', !form.runnerMode)} style={{
                  width:42, height:24, borderRadius:14, position:'relative', flexShrink:0,
                  background: form.runnerMode ? 'var(--grn)' : 'var(--bg4)', transition:'all .2s',
                }}>
                  <div style={{ width:18, height:18, borderRadius:'50%', background:'#fff', position:'absolute', top:3, left: form.runnerMode ? 21 : 3, transition:'left .2s' }}/>
                </div>
                <div>
                  <div style={{ fontSize:13, fontWeight:700, color:'var(--t1)' }}>Runner mode</div>
                  <div style={{ fontSize:11, color:'var(--t3)', marginTop:2 }}>Restricts UI to delivery handoff (no order taking).</div>
                </div>
              </label>

              {/* Payment mode */}
              <div style={{ marginTop:6 }}>
                <div style={{ fontSize:11, fontWeight:700, color:'var(--t3)', textTransform:'uppercase', letterSpacing:'.07em', marginBottom:8 }}>Payment mode</div>
                <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
                  {MPOS_PAYMENT_MODES.map(m => (
                    <button key={m.id} onClick={() => upd('paymentMode', m.id)} style={{
                      textAlign:'left', padding:'10px 12px', borderRadius:10, cursor:'pointer', fontFamily:'inherit',
                      background: form.paymentMode === m.id ? 'var(--bg2)' : 'transparent',
                      border:`1.5px solid ${form.paymentMode === m.id ? 'var(--acc)' : 'var(--bdr2)'}`,
                    }}>
                      <div style={{ fontSize:13, fontWeight:700, color: form.paymentMode === m.id ? 'var(--acc)' : 'var(--t1)' }}>{m.label}</div>
                      <div style={{ fontSize:11, color:'var(--t4)', marginTop:2 }}>{m.desc}</div>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Order types */}
          <div style={{ marginBottom:18 }}>
            <label style={{ display:'block', fontSize:11, fontWeight:700, color:'var(--t3)', textTransform:'uppercase', letterSpacing:'.07em', marginBottom:8 }}>Enabled order types</label>
            <div style={{ display:'flex', gap:8 }}>
              {ORDER_TYPES.map(t => {
                const on = (form.enabledOrderTypes || []).includes(t.id);
                return (
                  <button key={t.id} onClick={() => toggleOrderType(t.id)} style={{
                    flex:1, padding:'10px', borderRadius:10, cursor:'pointer', fontFamily:'inherit', textAlign:'center',
                    background: on ? 'var(--acc-d)' : 'var(--bg3)',
                    border:`1.5px solid ${on ? 'var(--acc)' : 'var(--bdr)'}`,
                    color: on ? 'var(--acc)' : 'var(--t3)', transition:'all .1s',
                  }}>
                    <div style={{ fontSize:18, marginBottom:2 }}>{t.icon}</div>
                    <div style={{ fontSize:11, fontWeight:700 }}>{t.label}</div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Customer-facing display */}
          <div style={{ marginBottom:18 }}>
            <label style={{ display:'block', fontSize:11, fontWeight:700, color:'var(--t3)', textTransform:'uppercase', letterSpacing:'.07em', marginBottom:8 }}>Customer-facing display</label>
            <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
              {CUSTOMER_DISPLAY_MODES.map(m => {
                const on = (form.customerDisplayMode || 'auto') === m.id;
                return (
                  <button key={m.id} onClick={() => upd('customerDisplayMode', m.id)} style={{
                    textAlign:'left', padding:'10px 12px', borderRadius:10, cursor:'pointer', fontFamily:'inherit',
                    background: on ? 'var(--bg2)' : 'transparent',
                    border:`1.5px solid ${on ? 'var(--acc)' : 'var(--bdr2)'}`,
                  }}>
                    <div style={{ fontSize:13, fontWeight:700, color: on ? 'var(--acc)' : 'var(--t1)' }}>{m.label}</div>
                    <div style={{ fontSize:11, color:'var(--t4)', marginTop:2 }}>{m.desc}</div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Customer display — idle slideshow images */}
          <div style={{ marginBottom:18 }}>
            <label style={{ display:'block', fontSize:11, fontWeight:700, color:'var(--t3)', textTransform:'uppercase', letterSpacing:'.07em', marginBottom:8 }}>Customer display — slideshow images</label>
            <div style={{ display:'flex', flexWrap:'wrap', gap:8, marginBottom:8 }}>
              {(form.customerDisplayImages || []).map((url, i) => (
                <div key={i} style={{ position:'relative', width:88, height:58, borderRadius:8, overflow:'hidden', border:'1px solid var(--bdr2)' }}>
                  <img src={url} alt="" style={{ width:'100%', height:'100%', objectFit:'cover' }}/>
                  <button onClick={() => upd('customerDisplayImages', (form.customerDisplayImages || []).filter((_, j) => j !== i))}
                    style={{ position:'absolute', top:2, right:2, width:18, height:18, borderRadius:'50%', border:'none', background:'rgba(0,0,0,.7)', color:'#fff', cursor:'pointer', fontSize:11, lineHeight:'18px', padding:0 }}>✕</button>
                </div>
              ))}
              {(form.customerDisplayImages || []).length === 0 && (
                <div style={{ fontSize:12, color:'var(--t4)', alignSelf:'center' }}>No images — falls back to venue branding.</div>
              )}
            </div>
            <label style={{ display:'inline-block', padding:'8px 12px', borderRadius:8, border:'1px dashed var(--bdr2)', cursor:'pointer', fontSize:12, color:'var(--t2)', fontWeight:600 }}>
              {uploadingImg ? 'Uploading…' : '+ Add image'}
              <input type="file" accept="image/*" style={{ display:'none' }} disabled={uploadingImg}
                onChange={e => { const f = e.target.files?.[0]; if (f) uploadDisplayImage(f); e.target.value = ''; }}/>
            </label>
            <div style={{ fontSize:11, color:'var(--t4)', marginTop:6 }}>Cycled as a slideshow when idle, and shown on the left half while an order is rung up.</div>
          </div>

          {/* Section */}
          <div style={{ marginBottom:18 }}>
            <label style={{ display:'block', fontSize:11, fontWeight:700, color:'var(--t3)', textTransform:'uppercase', letterSpacing:'.07em', marginBottom:8 }}>Default floor section</label>
            <div style={{ display:'flex', gap:6 }}>
              {SECTIONS.map(s => (
                <button key={String(s)} onClick={() => upd('assignedSection', s)} style={{
                  padding:'7px 14px', borderRadius:9, cursor:'pointer', fontFamily:'inherit',
                  background: form.assignedSection === s ? 'var(--acc-d)' : 'var(--bg3)',
                  border:`1px solid ${form.assignedSection === s ? 'var(--acc)' : 'var(--bdr)'}`,
                  color: form.assignedSection === s ? 'var(--acc)' : 'var(--t3)',
                  fontSize:12, fontWeight:700, textTransform:'capitalize',
                }}>{s || 'All'}</button>
              ))}
            </div>
          </div>

          {/* Table service toggle */}
          <div style={{ marginBottom:18, display:'flex', justifyContent:'space-between', alignItems:'center', padding:'12px 14px', background:'var(--bg3)', borderRadius:10, border:'1px solid var(--bdr)' }}>
            <div>
              <div style={{ fontSize:13, fontWeight:600, color:'var(--t1)' }}>Table service</div>
              <div style={{ fontSize:11, color:'var(--t3)', marginTop:2 }}>Show floor plan, seat guests, manage covers</div>
            </div>
            <button onClick={() => upd('tableServiceEnabled', !form.tableServiceEnabled)} style={{
              width:44, height:24, borderRadius:12, border:'none', cursor:'pointer',
              background: form.tableServiceEnabled ? 'var(--grn)' : 'var(--bg4)', transition:'all .2s', flexShrink:0, position:'relative',
            }}>
              <div style={{ width:18, height:18, borderRadius:'50%', background:'#fff', position:'absolute', top:3, left: form.tableServiceEnabled ? 22 : 3, transition:'left .2s', boxShadow:'0 1px 3px rgba(0,0,0,.3)' }}/>
            </button>
          </div>

          {/* Auto-print receipt on close toggle */}
          <div style={{ marginBottom:18, display:'flex', justifyContent:'space-between', alignItems:'center', padding:'12px 14px', background:'var(--bg3)', borderRadius:10, border:'1px solid var(--bdr)' }}>
            <div>
              <div style={{ fontSize:13, fontWeight:600, color:'var(--t1)' }}>Auto-print receipt on close</div>
              <div style={{ fontSize:11, color:'var(--t3)', marginTop:2 }}>Print customer receipt automatically when payment completes. Staff can still untick per-transaction on the pay screen.</div>
            </div>
            <button onClick={() => upd('autoPrintReceiptOnClose', form.autoPrintReceiptOnClose === false)} style={{
              width:44, height:24, borderRadius:12, border:'none', cursor:'pointer',
              background: form.autoPrintReceiptOnClose !== false ? 'var(--grn)' : 'var(--bg4)', transition:'all .2s', flexShrink:0, position:'relative',
            }}>
              <div style={{ width:18, height:18, borderRadius:'50%', background:'#fff', position:'absolute', top:3, left: form.autoPrintReceiptOnClose !== false ? 22 : 3, transition:'left .2s', boxShadow:'0 1px 3px rgba(0,0,0,.3)' }}/>
            </button>
          </div>

          {/* Order notifications toggle */}
          <div style={{ marginBottom:18, display:'flex', justifyContent:'space-between', alignItems:'center', padding:'12px 14px', background:'var(--bg3)', borderRadius:10, border:'1px solid var(--bdr)' }}>
            <div>
              <div style={{ fontSize:13, fontWeight:600, color:'var(--t1)' }}>Order notifications</div>
              <div style={{ fontSize:11, color:'var(--t3)', marginTop:2 }}>Show the new-order popup &amp; play the chime on this terminal when online, kiosk, QR or delivery orders arrive. Untick for terminals that shouldn't be alerted (the order still prints &amp; routes as normal).</div>
            </div>
            <button onClick={() => upd('orderNotifications', form.orderNotifications === false)} style={{
              width:44, height:24, borderRadius:12, border:'none', cursor:'pointer',
              background: form.orderNotifications !== false ? 'var(--grn)' : 'var(--bg4)', transition:'all .2s', flexShrink:0, position:'relative',
            }}>
              <div style={{ width:18, height:18, borderRadius:'50%', background:'#fff', position:'absolute', top:3, left: form.orderNotifications !== false ? 22 : 3, transition:'left .2s', boxShadow:'0 1px 3px rgba(0,0,0,.3)' }}/>
            </button>
          </div>

          {/* Service charge */}
          {(() => {
            const sc = form.serviceCharge || { enabled: false, rate: 12.5, applyTo: 'all', minCovers: 8 };
            const updSC = (k, v) => upd('serviceCharge', { ...sc, [k]: v });
            return (
              <div style={{ marginBottom:18, padding:'14px', background:'var(--bg3)', borderRadius:10, border:'1px solid var(--bdr)' }}>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom: sc.enabled ? 14 : 0 }}>
                  <div>
                    <div style={{ fontSize:13, fontWeight:600, color:'var(--t1)' }}>Service charge</div>
                    <div style={{ fontSize:11, color:'var(--t3)', marginTop:2 }}>Applies to dine-in table orders only</div>
                  </div>
                  <button onClick={() => updSC('enabled', !sc.enabled)} style={{
                    width:44, height:24, borderRadius:12, border:'none', cursor:'pointer',
                    background: sc.enabled ? 'var(--grn)' : 'var(--bg4)', transition:'all .2s', flexShrink:0, position:'relative',
                  }}>
                    <div style={{ width:18, height:18, borderRadius:'50%', background:'#fff', position:'absolute', top:3, left: sc.enabled ? 22 : 3, transition:'left .2s', boxShadow:'0 1px 3px rgba(0,0,0,.3)' }}/>
                  </button>
                </div>
                {sc.enabled && (
                  <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
                    <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                      <label style={{ fontSize:12, color:'var(--t3)', flexShrink:0 }}>Rate</label>
                      <div style={{ display:'flex', alignItems:'center', gap:6, background:'var(--bg)', border:'1px solid var(--bdr)', borderRadius:8, padding:'6px 10px' }}>
                        <input type="number" min="0" max="100" step="0.5" value={sc.rate} onChange={e => updSC('rate', parseFloat(e.target.value)||0)}
                          style={{ width:50, border:'none', background:'transparent', color:'var(--t1)', fontSize:13, fontFamily:'inherit', outline:'none', textAlign:'right' }}/>
                        <span style={{ fontSize:12, color:'var(--t3)' }}>%</span>
                      </div>
                    </div>
                    <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
                      <label style={{ fontSize:12, color:'var(--t3)' }}>Apply to</label>
                      {[
                        { id:'all',       label:'All dine-in orders', desc:'Every table order' },
                        { id:'minCovers', label:'Minimum covers',     desc:`Only when covers ≥ threshold` },
                      ].map(opt => (
                        <button key={opt.id} onClick={() => updSC('applyTo', opt.id)} style={{
                          padding:'8px 12px', borderRadius:8, cursor:'pointer', fontFamily:'inherit', textAlign:'left',
                          background: sc.applyTo === opt.id ? 'var(--acc-d)' : 'var(--bg)',
                          border:`1.5px solid ${sc.applyTo === opt.id ? 'var(--acc)' : 'var(--bdr)'}`,
                        }}>
                          <div style={{ fontSize:12, fontWeight:600, color:sc.applyTo===opt.id?'var(--acc)':'var(--t1)' }}>{opt.label}</div>
                          <div style={{ fontSize:10, color:'var(--t4)', marginTop:1 }}>{opt.desc}</div>
                        </button>
                      ))}
                    </div>
                    {sc.applyTo === 'minCovers' && (
                      <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                        <label style={{ fontSize:12, color:'var(--t3)', flexShrink:0 }}>Minimum covers</label>
                        <div style={{ display:'flex', alignItems:'center', gap:6, background:'var(--bg)', border:'1px solid var(--bdr)', borderRadius:8, padding:'6px 10px' }}>
                          <input type="number" min="1" max="50" step="1" value={sc.minCovers} onChange={e => updSC('minCovers', parseInt(e.target.value)||1)}
                            style={{ width:40, border:'none', background:'transparent', color:'var(--t1)', fontSize:13, fontFamily:'inherit', outline:'none', textAlign:'right' }}/>
                          <span style={{ fontSize:12, color:'var(--t3)' }}>+</span>
                        </div>
                        <span style={{ fontSize:11, color:'var(--t4)' }}>covers to trigger service charge</span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })()}

          {/* Menu assignment */}
          <div style={{ marginBottom:18 }}>
            <label style={{ display:'block', fontSize:11, fontWeight:700, color:'var(--t3)', textTransform:'uppercase', letterSpacing:'.07em', marginBottom:8 }}>Menu</label>
            <div style={{ fontSize:11, color:'var(--t4)', marginBottom:8 }}>Which menu this terminal shows. Create and manage menus in Menu Manager → Menus tab.</div>
            <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
              {[{ id:null, name:'All menus (default)', description:'Shows all categories from all menus' }, ...(menus||[])].map(m => (
                <button key={String(m.id)} onClick={()=>upd('menuId', m.id)}
                  style={{ padding:'9px 12px', borderRadius:9, cursor:'pointer', fontFamily:'inherit', textAlign:'left', transition:'all .1s',
                    background: form.menuId === m.id ? 'var(--acc-d)' : 'var(--bg3)',
                    border:`1.5px solid ${form.menuId === m.id ? 'var(--acc)' : 'var(--bdr)'}` }}>
                  <div style={{ fontSize:12, fontWeight:700, color:form.menuId===m.id?'var(--acc)':'var(--t1)' }}>📋 {m.name}</div>
                  {m.description && <div style={{ fontSize:10, color:'var(--t4)', marginTop:2 }}>{m.description}</div>}
                </button>
              ))}
            </div>
          </div>

          {/* Hidden features */}
          <div style={{ marginBottom:4 }}>
            <label style={{ display:'block', fontSize:11, fontWeight:700, color:'var(--t3)', textTransform:'uppercase', letterSpacing:'.07em', marginBottom:8 }}>Hide features from this terminal</label>
            <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
              {FEATURES.map(f => {
                const hidden = (form.hiddenFeatures || []).includes(f.id);
                return (
                  <div key={f.id} onClick={() => toggleFeature(f.id)} style={{
                    display:'flex', justifyContent:'space-between', alignItems:'center',
                    padding:'9px 12px', borderRadius:9, cursor:'pointer',
                    background: hidden ? 'var(--red-d)' : 'var(--bg3)',
                    border:`1px solid ${hidden ? 'var(--red-b)' : 'var(--bdr)'}`,
                    transition:'all .1s',
                  }}>
                    <div>
                      <div style={{ fontSize:12, fontWeight:600, color: hidden ? 'var(--red)' : 'var(--t1)' }}>{f.label}</div>
                      <div style={{ fontSize:11, color:'var(--t4)', marginTop:1 }}>{f.desc}</div>
                    </div>
                    <div style={{ fontSize:10, fontWeight:700, padding:'2px 8px', borderRadius:20, background: hidden ? 'var(--red)' : 'var(--bg4)', color: hidden ? '#fff' : 'var(--t4)', flexShrink:0 }}>
                      {hidden ? 'Hidden' : 'Visible'}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Master POS toggle */}
        <div style={{ margin:'0 20px 16px', padding:'14px 16px', borderRadius:12,
          background: form.isMaster ? 'rgba(234,179,8,0.1)' : 'var(--bg3)',
          border: `1.5px solid ${form.isMaster ? '#ca8a04' : 'var(--bdr)'}`,
          cursor:'pointer', transition:'all .2s' }}
          onClick={() => upd('isMaster', !form.isMaster)}>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
            <div>
              <div style={{ fontSize:13, fontWeight:700, color: form.isMaster ? '#ca8a04' : 'var(--t1)' }}>👑 Master POS</div>
              <div style={{ fontSize:11, color:'var(--t4)', marginTop:2 }}>Designate this terminal as the network master. Other devices monitor its heartbeat.</div>
            </div>
            <div style={{ width:36, height:20, borderRadius:10, background: form.isMaster ? '#ca8a04' : 'var(--bdr2)', position:'relative', flexShrink:0, transition:'background .2s' }}>
              <div style={{ position:'absolute', top:2, left: form.isMaster ? 18 : 2, width:16, height:16, borderRadius:'50%', background:'#fff', transition:'left .2s' }}/>
            </div>
          </div>
        </div>

        {/* Training Mode toggle — terminals on this profile commit NOTHING (no orders,
            payments, stock, receipts or kitchen tickets). For staff onboarding. */}
        <div style={{ margin:'0 20px 16px', padding:'14px 16px', borderRadius:12,
          background: form.trainingMode ? 'rgba(180,83,9,0.12)' : 'var(--bg3)',
          border: `1.5px solid ${form.trainingMode ? '#B45309' : 'var(--bdr)'}`,
          cursor:'pointer', transition:'all .2s' }}
          onClick={() => upd('trainingMode', !form.trainingMode)}>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
            <div>
              <div style={{ fontSize:13, fontWeight:700, color: form.trainingMode ? '#B45309' : 'var(--t1)' }}>🎓 Training mode</div>
              <div style={{ fontSize:11, color:'var(--t4)', marginTop:2 }}>Terminals on this profile work normally but commit NOTHING — no orders, card charges, stock changes, receipts or kitchen tickets. A banner shows on screen. For staff training.</div>
            </div>
            <div style={{ width:36, height:20, borderRadius:10, background: form.trainingMode ? '#B45309' : 'var(--bdr2)', position:'relative', flexShrink:0, transition:'background .2s' }}>
              <div style={{ position:'absolute', top:2, left: form.trainingMode ? 18 : 2, width:16, height:16, borderRadius:'50%', background:'#fff', transition:'left .2s' }}/>
            </div>
          </div>
        </div>

        <div style={{ padding:'12px 20px', borderTop:'1px solid var(--bdr)', display:'flex', gap:8, flexShrink:0 }}>
          {!isNew && onDelete && <button onClick={onDelete} style={{ padding:'8px 14px', borderRadius:9, cursor:'pointer', fontFamily:'inherit', background:'var(--red-d)', border:'1px solid var(--red-b)', color:'var(--red)', fontSize:12, fontWeight:700 }}>Delete</button>}
          <button className="btn btn-ghost" style={{ flex:1 }} onClick={onClose}>Cancel</button>
          <button className="btn btn-acc" style={{ flex:2, height:42 }} disabled={!form.name.trim() || (form.enabledOrderTypes || []).length === 0} onClick={() => onSave(form)}>
            {isNew ? 'Create profile' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  );
}
