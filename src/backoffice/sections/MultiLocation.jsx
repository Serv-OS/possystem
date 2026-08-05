/**
 * MultiLocation — manage locations within an organisation
 * 
 * Shows current location info, lets operators switch location context,
 * and provides an overview of all locations in the org.
 */
import { useState } from 'react';
import { useStore } from '../../store';
import { supabase, platformSupabase, isMock } from '../../lib/supabase';
import { reportSave } from '../../lib/saveHealth';

const TIMEZONES = [
  'Europe/London', 'Europe/Dublin', 'Europe/Paris', 'Europe/Berlin',
  'America/New_York', 'America/Chicago', 'America/Los_Angeles',
  'Asia/Dubai', 'Asia/Singapore', 'Australia/Sydney',
];

const PLAN_BADGES = {
  standard:   { label:'Standard',   color:'#3b82f6' },
  advanced:   { label:'Advanced',   color:'#a855f7' },
  enterprise: { label:'Enterprise', color:'#e8a020' },
};

export default function MultiLocation() {
  const { locations, currentLocationId, setCurrentLocation, addLocation, updateLocation, showToast } = useStore();
  const [view, setView] = useState('overview');   // overview | edit | add
  const [editId, setEditId] = useState(null);
  const [form, setForm] = useState({});

  const currentLocation = locations?.find(l => l.id === currentLocationId) || locations?.[0];

  const startEdit = (loc) => {
    setForm({ ...loc });
    setEditId(loc.id);
    setView('edit');
  };

  const startAdd = () => {
    setForm({ name:'', address:'', timezone:'Europe/London', plan:'standard', currency:'GBP', vat: 20 });
    setEditId(null);
    setView('add');
  };

  const save = async () => {
    if (!form.name?.trim()) { showToast('Location name required', 'error'); return; }
    if (editId) {
      const before = locations?.find(l => l.id === editId);
      updateLocation(editId, form);
      // Persist the venue name to BOTH databases: ops (tills, back office, receipts)
      // and platform (online ordering / gift / loyalty read the name from the platform
      // row, matched by ops_location_id) — otherwise a rename never reaches the
      // customer-facing ordering pages.
      if (!isMock && supabase) {
        const name = form.name.trim();
        const { data, error: oErr } = await supabase.from('locations').update({ name }).eq('id', editId).select('id');
        const opsFail = oErr || (!data || data.length === 0
          ? new Error(`Rename matched 0 rows for location ${editId} — RLS may have blocked it`)
          : null);
        reportSave('location', opsFail);
        if (opsFail) {
          // Revert: the tills and receipts still carry the old name, so this screen must too.
          if (before) updateLocation(editId, before);
          showToast(`Location NOT saved — ${opsFail.message}`, 'error');
          return;
        }
        try {
          const { error: pErr } = await platformSupabase.from('locations').update({ name })
            .or(`ops_location_id.eq.${editId},id.eq.${editId}`);
          if (pErr) throw pErr;
        } catch (e) {
          reportSave('location (online ordering name)', e);
          showToast('Saved, but the online-ordering name didn’t sync — try again', 'error');
          setView('overview');
          return;
        }
      }
      showToast('Location updated', 'success');
    } else {
      addLocation({ id:`loc-${Date.now()}`, ...form, isActive:true, createdAt:new Date() });
      showToast(`${form.name} added`, 'success');
    }
    setView('overview');
  };

  return (
    <div style={{ padding:28, maxWidth:860 }}>
      {/* Header */}
      <div style={{ display:'flex', alignItems:'center', gap:14, marginBottom:28 }}>
        <div style={{ flex:1 }}>
          <div style={{ fontSize:20, fontWeight:800, color:'var(--t1)', marginBottom:2 }}>Locations</div>
          <div style={{ fontSize:12, color:'var(--t3)' }}>Manage your organisation's sites. Each location has its own menus, floor plan, staff, and reporting.</div>
        </div>
        {view === 'overview' && (
          <button onClick={startAdd} style={{ padding:'8px 18px', borderRadius:10, cursor:'pointer', fontFamily:'inherit', background:'var(--acc)', border:'none', color:'#0b0c10', fontSize:13, fontWeight:700 }}>
            + Add location
          </button>
        )}
        {view !== 'overview' && (
          <button onClick={() => setView('overview')} style={{ padding:'7px 14px', borderRadius:9, cursor:'pointer', fontFamily:'inherit', background:'var(--bg3)', border:'1px solid var(--bdr2)', color:'var(--t2)', fontSize:12 }}>
            ← Back
          </button>
        )}
      </div>

      {/* Overview */}
      {view === 'overview' && (
        <>
          {/* Current location hero */}
          {currentLocation && (
            <div style={{ padding:'18px 20px', background:'var(--acc-d)', border:'1.5px solid var(--acc-b)', borderRadius:16, marginBottom:20 }}>
              <div style={{ fontSize:10, fontWeight:800, color:'var(--acc)', textTransform:'uppercase', letterSpacing:'.1em', marginBottom:8 }}>Current location</div>
              <div style={{ display:'flex', alignItems:'center', gap:14 }}>
                <div style={{ width:52, height:52, borderRadius:14, background:'var(--acc)', display:'flex', alignItems:'center', justifyContent:'center', fontSize:26, flexShrink:0 }}>📍</div>
                <div style={{ flex:1 }}>
                  <div style={{ fontSize:18, fontWeight:800, color:'var(--t1)' }}>{currentLocation.name}</div>
                  <div style={{ fontSize:12, color:'var(--t3)', marginTop:2 }}>{currentLocation.address}</div>
                  <div style={{ display:'flex', gap:10, marginTop:6, flexWrap:'wrap' }}>
                    <span style={{ fontSize:10, fontWeight:700, padding:'2px 8px', borderRadius:20, background:'var(--bg1)', color:'var(--t3)', border:'1px solid var(--bdr)' }}>
                      🕐 {currentLocation.timezone || 'Europe/London'}
                    </span>
                    <span style={{ fontSize:10, fontWeight:700, padding:'2px 8px', borderRadius:20, background:'var(--bg1)', color:'var(--t3)', border:'1px solid var(--bdr)' }}>
                      💰 {currentLocation.currency || 'GBP'} · {currentLocation.vat || 20}% VAT
                    </span>
                    {currentLocation.plan && (
                      <span style={{ fontSize:10, fontWeight:700, padding:'2px 8px', borderRadius:20, background:'var(--bg1)', border:`1px solid ${PLAN_BADGES[currentLocation.plan]?.color||'var(--bdr)'}44`, color:PLAN_BADGES[currentLocation.plan]?.color||'var(--t3)' }}>
                        {PLAN_BADGES[currentLocation.plan]?.label||currentLocation.plan}
                      </span>
                    )}
                  </div>
                </div>
                <button onClick={() => startEdit(currentLocation)} style={{ padding:'7px 14px', borderRadius:9, cursor:'pointer', fontFamily:'inherit', background:'var(--bg1)', border:'1px solid var(--bdr2)', color:'var(--t2)', fontSize:12 }}>
                  Edit
                </button>
              </div>
            </div>
          )}

          {/* All locations */}
          {(locations || []).filter(l => l.id !== currentLocationId).map(loc => (
            <div key={loc.id} style={{ padding:'14px 16px', background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:13, marginBottom:8, display:'flex', alignItems:'center', gap:12 }}>
              <div style={{ width:42, height:42, borderRadius:11, background:'var(--bg3)', display:'flex', alignItems:'center', justifyContent:'center', fontSize:20, flexShrink:0 }}>🏪</div>
              <div style={{ flex:1 }}>
                <div style={{ fontSize:14, fontWeight:700, color:'var(--t1)' }}>{loc.name}</div>
                <div style={{ fontSize:11, color:'var(--t4)', marginTop:2 }}>{loc.address}</div>
              </div>
              <div style={{ display:'flex', gap:6 }}>
                <button onClick={() => { setCurrentLocation(loc.id); showToast(`Switched to ${loc.name}`, 'success'); }} style={{ padding:'6px 12px', borderRadius:8, cursor:'pointer', fontFamily:'inherit', background:'var(--acc-d)', border:'1px solid var(--acc-b)', color:'var(--acc)', fontSize:11, fontWeight:700 }}>
                  Switch →
                </button>
                <button onClick={() => startEdit(loc)} style={{ padding:'6px 10px', borderRadius:8, cursor:'pointer', fontFamily:'inherit', background:'var(--bg3)', border:'1px solid var(--bdr)', color:'var(--t3)', fontSize:11 }}>
                  Edit
                </button>
              </div>
            </div>
          ))}

          {(!locations || locations.length === 0) && (
            <div style={{ textAlign:'center', padding:'48px', color:'var(--t4)' }}>
              <div style={{ fontSize:36, marginBottom:12, opacity:.2 }}>🏪</div>
              <div style={{ fontSize:14, fontWeight:600, color:'var(--t2)', marginBottom:4 }}>No locations configured</div>
              <div style={{ fontSize:12, marginBottom:16 }}>Add your first location to get started with multi-site management.</div>
              <button onClick={startAdd} style={{ padding:'8px 18px', borderRadius:9, cursor:'pointer', fontFamily:'inherit', background:'var(--acc)', border:'none', color:'#0b0c10', fontSize:13, fontWeight:700 }}>
                Add first location
              </button>
            </div>
          )}

          {/* Multi-site info box */}
          <div style={{ marginTop:24, padding:'14px 16px', background:'var(--bg3)', borderRadius:12, border:'1px solid var(--bdr)' }}>
            <div style={{ fontSize:12, fontWeight:700, color:'var(--t2)', marginBottom:8 }}>How multi-location works</div>
            <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
              {[
                '🏪 Each location has its own menus, floor plan, devices, and staff assignments',
                '🔗 Menu items can be marked as Shared (name shared, price per-location) or Global (everything shared)',
                '📊 Reports can be viewed per-location or rolled up across the whole organisation',
                '🔄 Push to POS propagates config changes to all terminals at the active location',
                '💳 Payment processing and receipts are configured independently per location',
              ].map((line, i) => (
                <div key={i} style={{ fontSize:11, color:'var(--t3)', lineHeight:1.5 }}>{line}</div>
              ))}
            </div>
          </div>
        </>
      )}

      {/* Add / Edit form */}
      {(view === 'edit' || view === 'add') && (
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16, maxWidth:680 }}>
          <FormField label="Location name *" span={2}>
            <input style={inp} value={form.name||''} onChange={e=>setForm(f=>({...f,name:e.target.value}))} placeholder="e.g. The Anchor — High Street" autoFocus/>
          </FormField>
          <FormField label="Address" span={2}>
            <textarea style={{ ...inp, resize:'none', height:60 }} value={form.address||''} onChange={e=>setForm(f=>({...f,address:e.target.value}))} placeholder="Full address"/>
          </FormField>
          <FormField label="Timezone">
            <select value={form.timezone||'Europe/London'} onChange={e=>setForm(f=>({...f,timezone:e.target.value}))} style={{ ...inp, cursor:'pointer' }}>
              {TIMEZONES.map(tz=><option key={tz} value={tz}>{tz}</option>)}
            </select>
          </FormField>
          <FormField label="Currency">
            <select value={form.currency||'GBP'} onChange={e=>setForm(f=>({...f,currency:e.target.value}))} style={{ ...inp, cursor:'pointer' }}>
              {[['GBP','£ GBP — British Pound'],['EUR','€ EUR — Euro'],['USD','$ USD — US Dollar'],['AED','AED — UAE Dirham']].map(([v,l])=><option key={v} value={v}>{l}</option>)}
            </select>
          </FormField>
          <FormField label="VAT / Tax rate (%)">
            <input type="number" min="0" max="100" step="0.5" style={inp} value={form.vat??20} onChange={e=>setForm(f=>({...f,vat:parseFloat(e.target.value)||0}))}/>
          </FormField>
          <FormField label="Service charge (%)">
            <input type="number" min="0" max="30" step="0.5" style={inp} value={form.serviceCharge??12.5} onChange={e=>setForm(f=>({...f,serviceCharge:parseFloat(e.target.value)||0}))}/>
          </FormField>
          <FormField label="Plan">
            <select value={form.plan||'standard'} onChange={e=>setForm(f=>({...f,plan:e.target.value}))} style={{ ...inp, cursor:'pointer' }}>
              {Object.entries(PLAN_BADGES).map(([id,{label}])=><option key={id} value={id}>{label}</option>)}
            </select>
          </FormField>
          <FormField label="Phone">
            <input style={inp} value={form.phone||''} onChange={e=>setForm(f=>({...f,phone:e.target.value}))} placeholder="+44 20 0000 0000"/>
          </FormField>
          <FormField label="Email">
            <input type="email" style={inp} value={form.email||''} onChange={e=>setForm(f=>({...f,email:e.target.value}))} placeholder="manager@venue.com"/>
          </FormField>
          <FormField label="Website">
            <input style={inp} value={form.website||''} onChange={e=>setForm(f=>({...f,website:e.target.value}))} placeholder="https://"/>
          </FormField>
          <FormField label="Receipt header" span={2}>
            <textarea style={{ ...inp, resize:'none', height:56 }} value={form.receiptHeader||''} onChange={e=>setForm(f=>({...f,receiptHeader:e.target.value}))} placeholder="Text printed at the top of receipts (e.g. Thank you for dining with us!)"/>
          </FormField>
          <FormField label="Receipt footer" span={2}>
            <textarea style={{ ...inp, resize:'none', height:56 }} value={form.receiptFooter||''} onChange={e=>setForm(f=>({...f,receiptFooter:e.target.value}))} placeholder="Text printed at the bottom of receipts"/>
          </FormField>

          <div style={{ gridColumn:'1/-1', display:'flex', gap:8, paddingTop:8 }}>
            <button onClick={() => setView('overview')} style={{ padding:'9px 18px', borderRadius:10, cursor:'pointer', fontFamily:'inherit', background:'var(--bg3)', border:'1px solid var(--bdr2)', color:'var(--t2)', fontSize:13, fontWeight:600 }}>
              Cancel
            </button>
            <button onClick={save} style={{ flex:1, padding:'9px 18px', borderRadius:10, cursor:'pointer', fontFamily:'inherit', background:'var(--acc)', border:'none', color:'#0b0c10', fontSize:14, fontWeight:800 }}>
              {editId ? 'Save changes' : 'Add location'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function FormField({ label, children, span }) {
  return (
    <div style={{ gridColumn: span === 2 ? '1/-1' : undefined }}>
      <div style={{ fontSize:10, fontWeight:800, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.1em', marginBottom:6 }}>{label}</div>
      {children}
    </div>
  );
}

const inp = {
  background:'var(--bg3)', border:'1.5px solid var(--bdr2)', borderRadius:10,
  padding:'9px 12px', color:'var(--t1)', fontSize:13, fontFamily:'inherit',
  outline:'none', width:'100%', boxSizing:'border-box',
};
