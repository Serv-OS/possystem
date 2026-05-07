// MNewOrder — bottom-sheet picker for the kind of order this is.
// On pick:
//   - dine-in → caller switches to the Tables tab and waits for a table tap.
//   - takeaway / collection / delivery / bar → caller starts a fresh walk-in
//     order and routes straight to MMenu.
//
// Profile-aware: only shows order types the device's profile has enabled
// (deviceConfig.enabledOrderTypes). If only one type is enabled, that's
// auto-picked and this screen is bypassed by the caller.

import { useStore } from '../../store';
import { Sx } from './MShellStyles';

const TYPES = [
  { id:'dine-in',    label:'Dine in',     icon:'🍽',  desc:'Seat guests at a table' },
  { id:'takeaway',   label:'Takeaway',    icon:'🥡',  desc:'Customer takes the order with them now' },
  { id:'collection', label:'Collection',  icon:'📦',  desc:'Customer collects later — capture name + time' },
  { id:'delivery',   label:'Delivery',    icon:'🛵',  desc:'Sent out for delivery — capture address' },
];

export default function MNewOrder({ onPick, onClose }) {
  const { deviceConfig } = useStore();
  const enabled = deviceConfig?.enabledOrderTypes || ['takeaway','collection','delivery','dine-in'];
  const visible = TYPES.filter(t => enabled.includes(t.id));

  return (
    <div onClick={(e) => { if (e.target === e.currentTarget) onClose?.(); }}
      style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.55)', zIndex:60, display:'flex', alignItems:'flex-end' }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        width:'100%', maxWidth:540, margin:'0 auto', background:'var(--bg1)', borderRadius:'18px 18px 0 0',
        padding:'14px 14px calc(18px + env(safe-area-inset-bottom)) 14px',
        boxShadow:'0 -10px 32px rgba(0,0,0,.45)', maxHeight:'92vh', overflowY:'auto',
      }}>
        {/* Drag handle */}
        <div style={{ width:36, height:4, borderRadius:2, background:'var(--bdr2)', margin:'0 auto 14px' }}/>
        <div style={{ fontSize:20, fontWeight:800, color:'var(--t1)', marginBottom:4 }}>Take a new order</div>
        <div style={{ fontSize:12, color:'var(--t3)', marginBottom:18 }}>What kind of order is this?</div>

        <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
          {visible.map(t => (
            <button key={t.id} onClick={() => onPick?.(t.id)} style={{
              padding:'14px 14px', borderRadius:14, border:'1px solid var(--bdr)',
              background:'var(--bg2)', cursor:'pointer', fontFamily:'inherit', textAlign:'left',
              display:'flex', alignItems:'center', gap:14, minHeight:72,
            }}>
              <div style={{ fontSize:30, flexShrink:0, width:48, textAlign:'center' }}>{t.icon}</div>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontSize:15, fontWeight:800, color:'var(--t1)' }}>{t.label}</div>
                <div style={{ fontSize:12, color:'var(--t3)', marginTop:2, lineHeight:1.4 }}>{t.desc}</div>
              </div>
              <div style={{ fontSize:20, color:'var(--t4)', flexShrink:0 }}>›</div>
            </button>
          ))}

          {visible.length === 0 && (
            <div style={{ ...Sx.emptyBlock, padding:'24px 8px' }}>
              <div style={{ fontSize:13, color:'var(--t3)' }}>No order types are enabled for this device.</div>
              <div style={{ fontSize:11, color:'var(--t4)', marginTop:6 }}>Update the profile in Back office → Devices → Profiles.</div>
            </div>
          )}
        </div>

        <button onClick={onClose} style={{ ...Sx.btnGhost, marginTop:12 }}>Cancel</button>
      </div>
    </div>
  );
}
