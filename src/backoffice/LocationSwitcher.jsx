import { useState, useEffect } from 'react';
import { supabase, isMock, platformSupabase, setResolvedLocationId, enforceTenantFence } from '../lib/supabase';
import { fetchAccessibleLocations } from '../lib/db';

export default function LocationSwitcher({ onClose }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [switching, setSwitching] = useState(null);
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);

  const currentLocationId = (() => {
    try { return JSON.parse(localStorage.getItem('rpos-bo-location') || 'null') || null; } catch { return null; }
  })();

  useEffect(() => { load(); }, []);

  const load = async () => {
    setLoading(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { setLoading(false); return; }

      const { data: profile } = await supabase
        .from('user_profiles')
        .select('role, location_id')
        .eq('id', user.id)
        .single();

      const superAdmin = profile?.role === 'super_admin';
      setIsSuperAdmin(superAdmin);

      if (superAdmin && platformSupabase) {
        // v5.5.207: super_admin scoped to their company via current location.
        // Previously loaded ALL companies + ALL locations — caused cross-org
        // data bleed when switching to unrelated organisations. Now we resolve
        // the user's company from their current location and only show that
        // company's locations. Prevents accidental data cross-contamination.
        let companyId = null;
        const currentLoc = profile?.location_id;
        if (currentLoc) {
          // Try ops_location_id first, then id
          let { data: locRow } = await platformSupabase
            .from('locations').select('company_id')
            .eq('ops_location_id', currentLoc).maybeSingle();
          if (!locRow) {
            ({ data: locRow } = await platformSupabase
              .from('locations').select('company_id')
              .eq('id', currentLoc).maybeSingle());
          }
          companyId = locRow?.company_id;
        }

        if (companyId) {
          // Show only this company's locations
          const [{ data: company }, { data: locations }] = await Promise.all([
            platformSupabase.from('companies').select('id, name, slug, plan').eq('id', companyId).maybeSingle(),
            platformSupabase.from('locations').select('id, company_id, name, ops_location_id').eq('company_id', companyId).order('name'),
          ]);
          if (company) {
            setItems([{ company, locations: locations || [] }]);
          }
        } else {
          // Fallback: no location set, show all (rare edge case)
          const [{ data: companies }, { data: locations }] = await Promise.all([
            platformSupabase.from('companies').select('id, name, slug, plan').order('name'),
            platformSupabase.from('locations').select('id, company_id, name, ops_location_id').order('name'),
          ]);
          const grouped = (companies || []).map(c => ({
            company: c,
            locations: (locations || []).filter(l => l.company_id === c.id),
          }));
          setItems(grouped);
        }
      } else {
        // Regular user (v4.6.23): prefer the user_locations junction so a user
        // linked to multiple sites sees all of them. Falls back internally to
        // user_profiles.location_id for pre-v4.6.22 environments.
        const accessible = await fetchAccessibleLocations();
        const locs = (accessible.data || []).map(l => ({
          id: l.id,
          name: l.name || 'Location',
          ops_location_id: l.id,
          role: l.role,
        }));
        if (locs.length > 0) {
          setItems([{
            company: { id: 'mine', name: locs.length > 1 ? 'Your locations' : 'Your location' },
            locations: locs,
          }]);
        }
      }
    } catch(e) { console.error('[LocationSwitcher]', e); }
    setLoading(false);
  };

  const switchTo = async (loc) => {
    setSwitching(loc.id);
    const opsLocId = loc.ops_location_id || loc.id;
    // v5.5.3: explicit tenant fence BEFORE we write the new location override.
    // The wipe also happens inside setResolvedLocationId, but routing through
    // enforceTenantFence directly keeps boot/pair/switch on the same code path
    // and writes the rpos-active-location tag in one place.
    enforceTenantFence(opsLocId);
    localStorage.setItem('rpos-bo-location', JSON.stringify(opsLocId));
    setResolvedLocationId(opsLocId);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) await supabase.from('user_profiles').update({ location_id: opsLocId }).eq('id', user.id);
    } catch {}
    window.location.reload();
  };

  const allLocs = items.flatMap(i => i.locations);
  const activeId = currentLocationId || allLocs[0]?.ops_location_id;

  return (
    <>
      <div onClick={onClose} style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.6)', backdropFilter:'blur(4px)', zIndex:9998 }}/>
      <div style={{ position:'fixed', top:'50%', left:'50%', transform:'translate(-50%,-50%)', zIndex:9999, width:480, maxWidth:'92vw', maxHeight:'80vh', display:'flex', flexDirection:'column', background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:16, boxShadow:'0 24px 80px rgba(0,0,0,0.5)', overflow:'hidden' }}>

        <div style={{ padding:'20px 24px 16px', borderBottom:'1px solid var(--bdr)', display:'flex', alignItems:'center', justifyContent:'space-between', flexShrink:0 }}>
          <div>
            <div style={{ fontSize:11, fontWeight:700, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.08em', marginBottom:3 }}>
              {isSuperAdmin ? 'Super admin — all organisations' : 'Switch location'}
            </div>
            <div style={{ fontSize:17, fontWeight:800, color:'var(--t1)' }}>
              {loading ? '…' : isSuperAdmin ? 'Select any location' : 'Your locations'}
            </div>
          </div>
          <button onClick={onClose} style={{ background:'var(--bg3)', border:'1px solid var(--bdr)', borderRadius:8, width:32, height:32, cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', fontSize:16, color:'var(--t3)', fontFamily:'inherit' }}>✕</button>
        </div>

        <div style={{ flex:1, overflowY:'auto', padding:'12px 16px 20px' }}>
          {loading ? (
            <div style={{ textAlign:'center', padding:'32px 0', color:'var(--t4)', fontSize:13 }}>Loading…</div>
          ) : items.length === 0 ? (
            <div style={{ textAlign:'center', padding:'32px 0', color:'var(--t4)', fontSize:13 }}>No locations found for your account</div>
          ) : items.map(({ company, locations }) => (
            <div key={company.id} style={{ marginBottom:16 }}>
              {(isSuperAdmin || items.length > 1) && (
                <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:8 }}>
                  <div style={{ fontSize:10, fontWeight:800, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.08em' }}>{company.name}</div>
                  {company.plan && <span style={{ fontSize:9, fontWeight:700, padding:'1px 6px', borderRadius:20, background:'var(--acc-d)', color:'var(--acc)', border:'1px solid var(--acc-b)' }}>{company.plan}</span>}
                  <div style={{ flex:1, height:1, background:'var(--bdr)' }}/>
                  <span style={{ fontSize:10, color:'var(--t4)' }}>{locations.length} location{locations.length !== 1 ? 's' : ''}</span>
                </div>
              )}
              {locations.length === 0 ? (
                <div style={{ fontSize:12, color:'var(--t4)', padding:'8px 12px', fontStyle:'italic' }}>No locations</div>
              ) : locations.map(loc => {
                const opsId = loc.ops_location_id || loc.id;
                const isCurrent = opsId === activeId;
                const isLoading = switching === loc.id;
                return (
                  <button key={loc.id} onClick={() => !isCurrent && switchTo(loc)}
                    disabled={isCurrent || !!switching}
                    style={{ width:'100%', textAlign:'left', padding:'13px 16px', marginBottom:6, borderRadius:12, border:`1.5px solid ${isCurrent ? 'var(--acc-b)' : 'var(--bdr)'}`, background:isCurrent ? 'var(--acc-d)' : 'var(--bg3)', cursor:isCurrent ? 'default' : 'pointer', fontFamily:'inherit', display:'flex', alignItems:'center', gap:12, opacity:switching && !isLoading ? 0.5 : 1 }}
                    onMouseEnter={e => { if (!isCurrent) e.currentTarget.style.borderColor = 'var(--acc-b)'; }}
                    onMouseLeave={e => { if (!isCurrent) e.currentTarget.style.borderColor = 'var(--bdr)'; }}>
                    <div style={{ width:34, height:34, borderRadius:9, flexShrink:0, background:isCurrent ? 'var(--acc)' : 'var(--bg)', border:`1px solid ${isCurrent ? 'var(--acc-b)' : 'var(--bdr)'}`, display:'flex', alignItems:'center', justifyContent:'center', fontSize:16 }}>📍</div>
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ fontSize:14, fontWeight:700, color:isCurrent ? 'var(--acc)' : 'var(--t1)', marginBottom:2, display:'flex', alignItems:'center', gap:8 }}>
                        <span>{loc.name}</span>
                        {loc.role && !isSuperAdmin && (
                          <span style={{ fontSize:9, fontWeight:700, padding:'1px 6px', borderRadius:4, background:'var(--bg2)', color:'var(--t4)', border:'1px solid var(--bdr)', letterSpacing:'.05em', textTransform:'uppercase' }}>{loc.role}</span>
                        )}
                      </div>
                      {isSuperAdmin && <div style={{ fontSize:10, color:'var(--t4)', fontFamily:'var(--font-mono)' }}>{opsId?.slice(0,16)}…</div>}
                    </div>
                    {isCurrent && <span style={{ fontSize:11, fontWeight:700, padding:'3px 8px', borderRadius:20, background:'var(--acc)', color:'#fff', flexShrink:0 }}>Active</span>}
                    {isLoading && <span style={{ fontSize:12, color:'var(--t4)', flexShrink:0 }}>Switching…</span>}
                    {!isCurrent && !isLoading && <span style={{ fontSize:16, color:'var(--t4)', flexShrink:0 }}>→</span>}
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        {isSuperAdmin && (
          <div style={{ padding:'10px 24px 14px', borderTop:'1px solid var(--bdr)', fontSize:11, color:'var(--t4)', textAlign:'center' }}>
            Super admin — showing all organisations and locations
          </div>
        )}
      </div>
    </>
  );
}
