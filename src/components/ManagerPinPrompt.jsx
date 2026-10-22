/**
 * ManagerPinPrompt: asks for a manager PIN when the database says a waste is over the company's
 * limit (v5.11.96, multi site stock Drop 3, contract 3.3 and 4.3). Shared by Back Office Wastage,
 * the end of day close down and the till's Waste screen. It only collects the PIN: the database
 * checks it (stock_record_waste, 5 tries in 15 minutes) and the caller sends the waste again with it.
 * Shown only on the database's answer, so a company with no limit never sees it.
 *
 * Props: words (the database's words, e.g. 'Over £25 needs a manager PIN.'), onPin(pin), onCancel,
 * busy (a send is in flight), error (the last refusal in words, shown under the box).
 */

import { useEffect, useRef, useState } from 'react';

const shade = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16 };
const card = { background: 'var(--bg1)', color: 'var(--t1)', border: '1px solid var(--bdr)', borderRadius: 14, padding: 20, width: '100%', maxWidth: 360, boxSizing: 'border-box', boxShadow: '0 20px 50px rgba(0,0,0,.35)' };
const input = { width: '100%', boxSizing: 'border-box', background: 'var(--bg2)', color: 'var(--t1)', border: '1px solid var(--bdr)', borderRadius: 8, padding: '12px 14px', fontSize: 20, letterSpacing: '.3em', textAlign: 'center', outline: 'none' };
const btn = (primary) => ({ flex: 1, padding: '11px 14px', borderRadius: 9, fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
  background: primary ? 'var(--acc)' : 'var(--bg2)', color: primary ? '#fff' : 'var(--t1)', border: primary ? 0 : '1px solid var(--bdr)' });

export default function ManagerPinPrompt({ words = '', onPin, onCancel, busy = false, error = null }) {
  const [pin, setPin] = useState('');
  const box = useRef(null);
  useEffect(() => { box.current?.focus(); }, []);
  useEffect(() => {
    const k = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onCancel?.(); } };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [onCancel]);
  const send = () => { if (pin.trim() && !busy) onPin?.(pin.trim()); };
  return (
    <div style={shade} role="dialog" aria-modal="true" aria-label="Manager PIN" onClick={(e) => { if (e.target === e.currentTarget) onCancel?.(); }}>
      <div style={card}>
        <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 6 }}>Manager PIN</div>
        {words && <div style={{ fontSize: 13.5, color: 'var(--t2, var(--t1))', lineHeight: 1.5, marginBottom: 14 }}>{words}</div>}
        <input ref={box} type="password" inputMode="numeric" autoComplete="off" value={pin} aria-label="Manager PIN"
          onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))}
          onKeyDown={(e) => { if (e.key === 'Enter') send(); }} style={input} />
        {error && <div style={{ fontSize: 12.5, color: 'var(--red, #ef4444)', marginTop: 8 }}>{error}</div>}
        <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
          <button type="button" onClick={() => onCancel?.()} style={btn(false)}>Cancel</button>
          <button type="button" onClick={send} disabled={busy || !pin.trim()} style={{ ...btn(true), opacity: busy || !pin.trim() ? 0.6 : 1 }}>{busy ? 'Checking...' : 'Approve'}</button>
        </div>
      </div>
    </div>
  );
}
