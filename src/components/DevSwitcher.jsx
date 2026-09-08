import { useState } from 'react';
import { supabase } from '../lib/supabase';

// DEV ONLY — quick device switcher for testing
// Shows a floating button to switch between paired devices
// Remove this before production launch

export default function DevSwitcher() {
  const [open, setOpen] = useState(false);
  const [devices, setDevices] = useState(null);

  const loadDevices = async () => {
    const locationId = JSON.parse(localStorage.getItem('rpos-device') || '{}').locationId;
    if (!locationId) return;
    const { data } = await supabase.from('devices').select('id,name,type,profile_id,centre_id,status,pairing_code').eq('location_id', locationId);
    setDevices(data || []);
    setOpen(true);
  };

  const switchTo = async (device) => {
    // Clear session tokens so no kick conflicts
    sessionStorage.removeItem(`rpos-session-${device.id}`);
    
    // Build device config based on type
    if (device.type === 'kds') {
      localStorage.setItem('rpos-device', JSON.stringify({
        id: device.id, name: device.name, type: 'kds',
        locationId: JSON.parse(localStorage.getItem('rpos-device') || '{}').locationId,
        centreId: device.centre_id,
      }));
      localStorage.setItem('rpos-device-config', JSON.stringify({
        profileId: 'kds', profileName: 'Kitchen Display',
        defaultSurface: 'kds', centreId: device.centre_id,
        hiddenFeatures: [], enabledOrderTypes: [],
        tableServiceEnabled: false, quickScreenEnabled: false,
      }));
      localStorage.setItem('rpos-device-mode', 'pos');
    } else {
      // Fetch full profile settings
      const profiles = JSON.parse(localStorage.getItem('rpos-device-profiles') || 'null') || [
        { id:'prof-1', name:'Main counter', defaultSurface:'tables', enabledOrderTypes:['dine-in','takeaway','collection'], hiddenFeatures:[], tableServiceEnabled:true, quickScreenEnabled:true },
        { id:'prof-2', name:'Bar terminal', defaultSurface:'bar', enabledOrderTypes:['dine-in'], hiddenFeatures:['courses'], tableServiceEnabled:false, quickScreenEnabled:true },
        { id:'prof-3', name:'Server handheld', defaultSurface:'pos', enabledOrderTypes:['dine-in'], hiddenFeatures:[], tableServiceEnabled:true, quickScreenEnabled:true },
      ];
      const profile = profiles.find(p => p.id === device.profile_id) || profiles[0];
      localStorage.setItem('rpos-device', JSON.stringify({
        id: device.id, name: device.name, type: device.type || 'pos',
        locationId: JSON.parse(localStorage.getItem('rpos-device') || '{}').locationId,
        profileId: device.profile_id,
      }));
      localStorage.setItem('rpos-device-config', JSON.stringify({
        profileId: profile?.id, profileName: profile?.name || device.name,
        defaultSurface: profile?.defaultSurface || 'tables',
        enabledOrderTypes: profile?.enabledOrderTypes || ['dine-in'],
        hiddenFeatures: profile?.hiddenFeatures || [],
        tableServiceEnabled: profile?.tableServiceEnabled !== false,
        quickScreenEnabled: profile?.quickScreenEnabled !== false,
        autoPrintReceiptOnClose: profile?.autoPrintReceiptOnClose !== false,
        orderNotifications: profile?.orderNotifications !== false,
      }));
      localStorage.setItem('rpos-device-mode', 'pos');
    }
    window.location.href = '?mode=pos';
  };

  return (
    <div style={{ position:'fixed', bottom:16, left:16, zIndex:99999, fontFamily:'monospace' }}>
      {!open && (
        <button onClick={loadDevices} style={{
          padding:'6px 12px', borderRadius:8, background:'#1e2235', border:'1px solid #6366f1',
          color:'#818cf8', fontSize:11, fontWeight:700, cursor:'pointer',
        }}>
          🔧 Dev: Switch device
        </button>
      )}
      {open && devices && (
        <div style={{ background:'#1e2235', border:'1px solid #6366f1', borderRadius:10, padding:12, minWidth:220 }}>
          <div style={{ fontSize:10, color:'#6366f1', fontWeight:800, marginBottom:8, letterSpacing:'.08em' }}>SWITCH DEVICE</div>
          {devices.map(d => {
            const isCurrent = d.id === JSON.parse(localStorage.getItem('rpos-device') || '{}').id;
            return (
              <button key={d.id} onClick={() => switchTo(d)} style={{
                display:'block', width:'100%', padding:'7px 10px', marginBottom:4,
                borderRadius:7, border:`1px solid ${isCurrent ? '#6366f1' : '#334155'}`,
                background: isCurrent ? '#312e81' : 'transparent',
                color: isCurrent ? '#a5b4fc' : '#94a3b8', fontSize:12, fontWeight:600,
                cursor:'pointer', fontFamily:'monospace', textAlign:'left',
              }}>
                {d.type === 'kds' ? '📺' : '🖥'} {d.name} {isCurrent ? '← current' : ''}
              </button>
            );
          })}
          <button onClick={() => setOpen(false)} style={{
            marginTop:4, fontSize:10, color:'#475569', background:'none', border:'none', cursor:'pointer', padding:0
          }}>close</button>
        </div>
      )}
    </div>
  );
}
