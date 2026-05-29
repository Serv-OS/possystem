import { useState } from 'react';
import { useStore } from '../store';
import { money } from '../lib/currency';

const VOID_REASONS = [
  'Customer changed mind',
  'Wrong item ordered',
  'Kitchen error',
  'Allergy / dietary concern',
  'Item unavailable',
  'Duplicate order',
  'Manager discretion',
  'Training / test order',
  'Other',
];

const managerPinsFrom = (staffMembers) =>
  (staffMembers || [])
    .filter(s => s.role === 'Manager' && s.active !== false)
    .map(s => ({ pin: s.pin, name: s.name, id: s.id }));

export default function VoidModal({ type, items, totalValue, onConfirm, onCancel }) {
  const { staffMembers, staff: currentUser } = useStore();
  const managerPins = managerPinsFrom(staffMembers);
  const managerLoggedIn = currentUser?.role === 'Manager';

  const [step, setStep]       = useState(managerLoggedIn ? 'reason' : 'pin');
  const [pin, setPin]         = useState('');
  const [pinError, setPinError] = useState('');
  const [manager, setManager]   = useState(managerLoggedIn ? currentUser : null);
  const [reason, setReason]     = useState('');
  const [freeText, setFreeText] = useState('');

  const isCheck = type === 'check';

  const handleDigit = (d) => {
    if (pin.length >= 4) return;
    const next = pin + d;
    setPin(next);
    if (next.length === 4) checkPin(next);
  };

  const checkPin = (p) => {
    const match = managerPins.find(m => m.pin === p);
    if (match) {
      setManager(match);
      setPinError('');
      setTimeout(() => setStep('reason'), 200);
    } else {
      setPinError('Incorrect manager PIN');
      setTimeout(() => setPin(''), 600);
    }
  };

  const handleConfirm = () => {
    const finalReason = reason === 'Other' ? (freeText.trim() || 'Other') : reason;
    onConfirm({ manager, reason: finalReason });
  };

  return (
    <div className="modal-back">
      <div style={{ background:'var(--bg2)', border:'1px solid var(--bdr2)', borderRadius:20, width:'100%', maxWidth:400, boxShadow:'var(--sh3)', overflow:'hidden' }}>

        {/* Header */}
        <div style={{ padding:'18px 22px 14px', borderBottom:'1px solid var(--bdr)', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
          <div>
            <div style={{ fontSize:16, fontWeight:700, color:'var(--red)' }}>
              {isCheck ? 'Void entire check' : 'Void item'}
            </div>
            <div style={{ fontSize:12, color:'var(--t3)', marginTop:2 }}>
              {isCheck
                ? `${items.length} item${items.length!==1?'s':''} · ${money(totalValue)} total`
                : items.map(i => `${i.qty}× ${i.name}`).join(', ')}
            </div>
          </div>
          <button onClick={onCancel} style={{ background:'none', border:'none', color:'var(--t3)', cursor:'pointer', fontSize:22 }}>×</button>
        </div>

        <div style={{ padding:'20px 22px' }}>

          {/* ── Step 1: Manager PIN ── */}
          {step === 'pin' && (
            <>
              <div style={{ fontSize:13, color:'var(--t2)', marginBottom:16, lineHeight:1.5 }}>
                Voiding a committed item requires manager authorisation. Enter a manager PIN to continue.
              </div>

              {/* PIN dots */}
              <div style={{ display:'flex', justifyContent:'center', gap:12, marginBottom:pinError?8:20 }}>
                {[0,1,2,3].map(i => (
                  <div key={i} style={{
                    width:14, height:14, borderRadius:'50%',
                    background: i < pin.length ? 'var(--red)' : 'var(--bg4)',
                    border: `2px solid ${i < pin.length ? 'var(--red)' : 'var(--bdr2)'}`,
                    transition: 'all .15s',
                  }}/>
                ))}
              </div>
              {pinError && (
                <div style={{ textAlign:'center', fontSize:12, color:'var(--red)', marginBottom:16, fontWeight:600 }}>{pinError}</div>
              )}

              {/* Numpad */}
              <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:8, maxWidth:240, margin:'0 auto' }}>
                {[1,2,3,4,5,6,7,8,9,'',0,'⌫'].map((d,i) => (
                  <button key={i} onClick={() => d === '⌫' ? setPin(p=>p.slice(0,-1)) : d !== '' ? handleDigit(String(d)) : null} style={{
                    height:52, borderRadius:12, cursor: d===''?'default':'pointer',
                    background: d===''?'transparent':'var(--bg3)',
                    border: d===''?'none':'1px solid var(--bdr2)',
                    color: d==='⌫'?'var(--t3)':'var(--t1)',
                    fontSize: d==='⌫'?18:20, fontWeight:700, fontFamily:'inherit',
                    opacity: d===''?0:1,
                  }}>{d}</button>
                ))}
              </div>

              <button className="btn btn-ghost btn-full" style={{ marginTop:20 }} onClick={onCancel}>Cancel</button>
            </>
          )}

          {/* ── Step 2: Reason ── */}
          {step === 'reason' && (
            <>
              <div style={{ display:'flex', alignItems:'center', gap:8, padding:'8px 12px', borderRadius:10, background:'var(--grn-d)', border:'1px solid var(--grn-b)', marginBottom:16 }}>
                <span style={{ fontSize:16 }}>✓</span>
                <span style={{ fontSize:13, fontWeight:600, color:'var(--grn)' }}>Authorised by {manager.name}</span>
              </div>

              <div style={{ fontSize:12, fontWeight:700, color:'var(--t2)', textTransform:'uppercase', letterSpacing:'.06em', marginBottom:10 }}>
                Reason for void
              </div>

              <div style={{ display:'flex', flexDirection:'column', gap:6, marginBottom:14 }}>
                {VOID_REASONS.map(r => (
                  <button key={r} onClick={() => setReason(r)} style={{
                    padding:'10px 14px', borderRadius:10, cursor:'pointer', textAlign:'left', fontFamily:'inherit',
                    border:`1.5px solid ${reason===r?'var(--red-b)':'var(--bdr)'}`,
                    background:reason===r?'var(--red-d)':'var(--bg3)',
                    color:reason===r?'var(--red)':'var(--t2)', fontSize:13, fontWeight:500,
                  }}>{r}</button>
                ))}
              </div>

              {reason === 'Other' && (
                <input
                  className="input" placeholder="Describe the reason…"
                  value={freeText} onChange={e=>setFreeText(e.target.value)}
                  style={{ marginBottom:14 }} autoFocus
                />
              )}

              <div style={{ display:'flex', gap:8 }}>
                <button className="btn btn-ghost" style={{ flex:1 }} onClick={onCancel}>Cancel</button>
                <button
                  className="btn btn-red" style={{ flex:2, height:46 }}
                  disabled={!reason || (reason==='Other'&&!freeText.trim())}
                  onClick={handleConfirm}
                >
                  Confirm void
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
