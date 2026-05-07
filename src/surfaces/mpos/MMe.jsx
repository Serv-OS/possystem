// MMe — staff profile, end shift, BO link, what's new, sign out.
// Phase 1A: minimal static info + actions. Future: shift summary, my sales today,
// my tip total, productivity stats.

import { useStore } from '../../store';
import { VERSION } from '../../lib/version';
import { Sx } from './MShellStyles';

export default function MMe() {
  const { staff, logout, deviceConfig, closedChecks = [] } = useStore();

  // Today's sales attributed to this server (rough — by name match)
  const myName = staff?.name?.toLowerCase();
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const myToday = closedChecks.filter(c =>
    c.closedAt && c.closedAt >= dayStart.getTime() &&
    (c.server || '').toLowerCase() === myName
  );
  const myCount = myToday.length;
  const myTotal = myToday.reduce((s, c) => s + (Number(c.total) || 0), 0);
  const myTips = myToday.reduce((s, c) => s + (Number(c.tip) || 0), 0);

  return (
    <div style={Sx.scroller}>
      {/* Profile card */}
      <div style={{ padding:'24px 16px 14px' }}>
        <div style={{ display:'flex', alignItems:'center', gap:14, marginBottom:18 }}>
          <div style={{
            width:64, height:64, borderRadius:'50%',
            background: staff?.color || 'var(--acc)', color:'#0b0c10',
            display:'flex', alignItems:'center', justifyContent:'center',
            fontSize:22, fontWeight:800, flexShrink:0,
          }}>{staff?.initials || '?'}</div>
          <div style={{ flex:1, minWidth:0 }}>
            <div style={{ fontSize:18, fontWeight:800, color:'var(--t1)' }}>{staff?.name || 'Unknown'}</div>
            <div style={{ fontSize:12, color:'var(--t3)', textTransform:'capitalize' }}>{staff?.role || 'Staff'}</div>
            {deviceConfig?.profileName && (
              <div style={{ fontSize:11, color:'var(--t4)', marginTop:2 }}>📱 {deviceConfig.profileName}{deviceConfig?.runnerMode ? ' · Runner' : ''}</div>
            )}
          </div>
        </div>

        {/* Today's stats */}
        <div style={{ display:'grid', gridTemplateColumns:'repeat(3, 1fr)', gap:8 }}>
          <Stat label="Orders" value={myCount}/>
          <Stat label="Sales" value={`£${myTotal.toFixed(0)}`}/>
          <Stat label="Tips" value={`£${myTips.toFixed(0)}`}/>
        </div>
      </div>

      {/* Actions */}
      <div style={{ padding:'8px 14px' }}>
        <Action
          icon="🏢" title="Back office"
          desc="Reports, menu, staff (opens in browser)"
          onClick={() => { window.location.href = '?mode=office'; }}
        />
        <Action
          icon="🔄" title="Switch device mode"
          desc="Use this device as a regular POS instead"
          onClick={() => {
            if (confirm('Switch this device out of MPOS mode? You\'ll need to pick a new mode.')) {
              localStorage.removeItem('rpos-device-mode');
              window.location.href = '/';
            }
          }}
        />
        <Action
          icon="⏻" title="End shift / sign out"
          desc="Hands the device back to the next server"
          dangerous
          onClick={() => { if (confirm('End your shift and sign out?')) logout(); }}
        />
      </div>

      {/* Footer */}
      <div style={{ padding:'24px 16px 32px', textAlign:'center', color:'var(--t4)', fontSize:11, fontFamily:'var(--font-mono)' }}>
        Restaurant OS · MPOS v{VERSION}
      </div>
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div style={{ background:'var(--bg2)', border:'1px solid var(--bdr)', borderRadius:12, padding:'12px 8px', textAlign:'center' }}>
      <div style={{ fontSize:18, fontWeight:800, color:'var(--t1)', fontFamily:'var(--font-mono)' }}>{value}</div>
      <div style={{ fontSize:10, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.06em', fontWeight:700, marginTop:2 }}>{label}</div>
    </div>
  );
}

function Action({ icon, title, desc, onClick, dangerous }) {
  return (
    <button onClick={onClick} style={{
      width:'100%', padding:'14px 12px', borderRadius:12,
      background:'var(--bg2)', border:`1px solid ${dangerous ? 'var(--red-b)' : 'var(--bdr)'}`,
      cursor:'pointer', fontFamily:'inherit', textAlign:'left',
      display:'flex', alignItems:'center', gap:12, marginBottom:8, minHeight:64,
    }}>
      <div style={{ fontSize:22, flexShrink:0 }}>{icon}</div>
      <div style={{ flex:1, minWidth:0 }}>
        <div style={{ fontSize:14, fontWeight:700, color: dangerous ? 'var(--red)' : 'var(--t1)' }}>{title}</div>
        <div style={{ fontSize:11, color:'var(--t3)', marginTop:2 }}>{desc}</div>
      </div>
      <div style={{ fontSize:18, color:'var(--t4)', flexShrink:0 }}>›</div>
    </button>
  );
}
