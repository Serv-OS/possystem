// MManagerPin — bottom-sheet manager-PIN gate for actions that need
// supervisor approval (Comp 100%, voids of sent items, future refunds).
// Reads staffMembers from the store and finds a manager whose pin matches.
// On success: calls onApprove({ id, name, role }) — the caller decides what
// happens next. 90s grace window: a successful gate stashes the manager in
// store.lastManagerAuth so a follow-up gated action within the window
// proceeds without re-prompting.

import { useState, useEffect } from 'react';
import { useStore } from '../../store';
import { Sx } from './MShellStyles';

const GRACE_MS = 90 * 1000;

// Helper: returns a cached manager if the last auth is within the grace
// window, otherwise null. Callers can use this to decide whether to skip
// the prompt entirely.
export function getCachedManagerAuth() {
  try {
    const raw = sessionStorage.getItem('mpos-last-manager-auth');
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj?.at || Date.now() - obj.at > GRACE_MS) return null;
    return obj.manager || null;
  } catch { return null; }
}

function setCachedManagerAuth(manager) {
  try {
    sessionStorage.setItem('mpos-last-manager-auth', JSON.stringify({ at: Date.now(), manager }));
  } catch {}
}

/**
 * @param {object} props
 *   - reason: short description of what the manager is approving
 *   - onApprove: ({ id, name, role }) => void
 *   - onCancel: () => void
 */
export default function MManagerPin({ reason, onApprove, onCancel }) {
  const { staffMembers = [] } = useStore();
  // Managers are anyone whose role is "Manager" OR has manager in permissions.
  const managers = staffMembers.filter(s =>
    s.role?.toLowerCase() === 'manager' ||
    (Array.isArray(s.permissions) && s.permissions.includes('manager'))
  );
  const [picked, setPicked] = useState(null);
  const [pin, setPin] = useState('');
  const [shake, setShake] = useState(false);

  // Auto-grace check: if a manager auth is still warm, fast-approve.
  useEffect(() => {
    const cached = getCachedManagerAuth();
    if (cached) onApprove?.(cached);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const tap = (k) => {
    if (k === '⌫') { setPin(p => p.slice(0, -1)); return; }
    if (pin.length >= 8) return;
    const next = pin + k;
    setPin(next);
    if (picked && next.length >= (picked.pin || '').length) {
      // Auto-submit at expected length
      if (next === picked.pin) {
        setCachedManagerAuth({ id: picked.id, name: picked.name, role: picked.role });
        onApprove?.({ id: picked.id, name: picked.name, role: picked.role });
      } else {
        setShake(true);
        setTimeout(() => { setPin(''); setShake(false); }, 380);
      }
    }
  };

  return (
    <div onClick={(e) => { if (e.target === e.currentTarget) onCancel?.(); }}
      style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.65)', zIndex:70, display:'flex', alignItems:'flex-end' }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        width:'100%', maxWidth:540, margin:'0 auto', background:'var(--bg1)', borderRadius:'18px 18px 0 0',
        padding:'14px 14px calc(18px + env(safe-area-inset-bottom)) 14px',
        boxShadow:'0 -10px 32px rgba(0,0,0,.45)', maxHeight:'90svh', overflowY:'auto',
      }}>
        <div style={{ width:36, height:4, borderRadius:2, background:'var(--bdr2)', margin:'0 auto 14px' }}/>

        <div style={{ marginBottom:14, textAlign:'center' }}>
          <div style={{ fontSize:11, color:'var(--acc)', fontWeight:800, textTransform:'uppercase', letterSpacing:'.07em' }}>Manager required</div>
          <div style={{ fontSize:16, fontWeight:800, color:'var(--t1)', marginTop:4 }}>{reason || 'Approve this action'}</div>
          <div style={{ fontSize:11, color:'var(--t4)', marginTop:4 }}>Approval lasts 90 seconds for follow-up actions.</div>
        </div>

        {!picked ? (
          // Pick which manager is approving
          <div>
            <div style={{ fontSize:13, fontWeight:700, color:'var(--t3)', marginBottom:8, textAlign:'center' }}>
              Tap your name to enter PIN
            </div>
            {managers.length === 0 && (
              <div style={{ padding:'24px 16px', textAlign:'center', fontSize:12, color:'var(--t4)' }}>
                No managers configured at this location. Add one in Back office → Staff.
              </div>
            )}
            <div style={{ display:'grid', gridTemplateColumns:'repeat(2, 1fr)', gap:8 }}>
              {managers.map(m => (
                <button key={m.id} onClick={() => setPicked(m)} style={{
                  padding:'14px 12px', borderRadius:12,
                  border:'1px solid var(--bdr)', background:'var(--bg2)',
                  cursor:'pointer', fontFamily:'inherit', textAlign:'left',
                  display:'flex', alignItems:'center', gap:10, minHeight:64,
                }}>
                  <div style={{
                    width:38, height:38, borderRadius:'50%', background: m.color || 'var(--acc)',
                    color:'#0b0c10', display:'flex', alignItems:'center', justifyContent:'center',
                    fontWeight:800, fontSize:13, flexShrink:0,
                  }}>{m.initials}</div>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontSize:13, fontWeight:700, color:'var(--t1)' }}>{m.name}</div>
                    <div style={{ fontSize:10, color:'var(--t4)', textTransform:'capitalize' }}>{m.role}</div>
                  </div>
                </button>
              ))}
            </div>
            <button onClick={onCancel} style={{ ...Sx.btnGhost, marginTop:10 }}>Cancel</button>
          </div>
        ) : (
          // PIN entry
          <div>
            <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:14 }}>
              <button onClick={() => { setPicked(null); setPin(''); }} style={Sx.iconBtn} aria-label="Back">←</button>
              <div style={{
                width:38, height:38, borderRadius:'50%', background: picked.color || 'var(--acc)',
                color:'#0b0c10', display:'flex', alignItems:'center', justifyContent:'center',
                fontWeight:800, fontSize:13, flexShrink:0,
              }}>{picked.initials}</div>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontSize:14, fontWeight:800, color:'var(--t1)' }}>{picked.name}</div>
                <div style={{ fontSize:11, color:'var(--t4)' }}>Enter PIN</div>
              </div>
            </div>

            {/* Dots */}
            <div style={{
              padding:'14px 16px', borderRadius:12,
              border:`2px solid ${shake ? 'var(--red)' : 'var(--bdr2)'}`,
              background:'var(--bg2)', textAlign:'center', marginBottom:14,
              transition: shake ? 'transform .08s' : 'none',
              transform: shake ? 'translateX(-4px)' : 'none',
            }}>
              <div style={{ display:'flex', gap:10, justifyContent:'center' }}>
                {[0,1,2,3].map(i => (
                  <div key={i} style={{
                    width:14, height:14, borderRadius:'50%',
                    background: pin.length > i ? 'var(--acc)' : 'var(--bg3)',
                    border:`1.5px solid ${pin.length > i ? 'var(--acc)' : 'var(--bdr2)'}`,
                  }}/>
                ))}
              </div>
            </div>

            {/* Number pad */}
            <div style={{ display:'grid', gridTemplateColumns:'repeat(3, 1fr)', gap:6 }}>
              {['1','2','3','4','5','6','7','8','9','','0','⌫'].map((k, i) => (
                k ? (
                  <button key={i} onClick={() => tap(k)} style={{
                    padding:'18px 0', borderRadius:12,
                    border:'1px solid var(--bdr2)', background:'var(--bg2)',
                    color:'var(--t1)', fontSize:22, fontWeight:700,
                    fontFamily:'var(--font-mono)', cursor:'pointer', minHeight:54,
                  }}>{k}</button>
                ) : <div key={i}/>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
