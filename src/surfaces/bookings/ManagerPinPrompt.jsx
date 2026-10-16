// src/surfaces/bookings/ManagerPinPrompt.jsx
//
// Manager PIN (16 Oct 2026, v5.11.70 host tools, plan item 11). Booking a
// party into a slot over the kitchen's pacing cap used to be one tap that
// wrote whoever was logged in as the approver. When the venue's rule "Pacing
// override needs a manager" is on, a manager now types their PIN: it is checked
// on the server (waitlist_pin_login) and only a manager's PIN approves. The
// booking records the manager's name.

import { useState } from 'react';
import { checkManagerPin } from '../../lib/bookings/hostData.js';

export default function ManagerPinPrompt({ title = 'Manager approval', sub = '', onApproved, onCancel }) {
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const submit = async () => {
    if (busy) return;
    if (!/^\d{3,8}$/.test(pin)) { setErr('Enter the manager PIN.'); return; }
    setBusy(true); setErr('');
    const res = await checkManagerPin(pin);
    setBusy(false);
    if (res.ok) { onApproved?.(res.name); return; }
    setPin('');
    setErr(res.error || 'PIN not recognised.');
  };
  const key = (d) => { setErr(''); setPin((p) => (p + d).slice(0, 8)); };
  const keyBtn = { height: 52, borderRadius: 11, border: '1px solid var(--bdr)', background: 'var(--bg3)', color: 'var(--t1)', fontSize: 20, fontWeight: 700, cursor: 'pointer', fontFamily: 'var(--font-mono)' };
  return (
    <div onClick={busy ? undefined : onCancel} style={{ position: 'fixed', inset: 0, zIndex: 100003, background: 'rgba(8,9,12,0.55)', display: 'grid', placeItems: 'center', padding: 16 }}>
      <div role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}
        style={{ width: '100%', maxWidth: 320, padding: '16px 18px', borderRadius: 14, background: 'var(--bg1)', color: 'var(--t1)', border: '1.5px solid var(--bdr2)', boxShadow: '0 14px 40px rgba(0,0,0,.45)' }}>
        <div style={{ fontSize: 16, fontWeight: 800 }}>{title}</div>
        {sub && <div style={{ fontSize: 13, color: 'var(--t3)', marginTop: 4, lineHeight: 1.45 }}>{sub}</div>}
        <div style={{ display: 'flex', justifyContent: 'center', gap: 10, margin: '14px 0 10px', minHeight: 14 }}>
          {Array.from({ length: Math.max(4, pin.length) }, (_, i) => (
            <span key={i} style={{ width: 13, height: 13, borderRadius: 999, background: i < pin.length ? 'var(--acc)' : 'var(--bg3)', border: '1px solid var(--bdr2)' }} />
          ))}
        </div>
        {err && <div role="alert" style={{ fontSize: 13, color: 'var(--red)', fontWeight: 700, textAlign: 'center', marginBottom: 8 }}>{err}</div>}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8 }}>
          {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => <button key={n} onClick={() => key(String(n))} style={keyBtn}>{n}</button>)}
          <button onClick={() => setPin((p) => p.slice(0, -1))} style={keyBtn} aria-label="Delete">⌫</button>
          <button onClick={() => key('0')} style={keyBtn}>0</button>
          <button onClick={submit} disabled={busy} style={{ ...keyBtn, background: 'var(--acc)', color: 'var(--bg)', fontSize: 14, fontWeight: 800, fontFamily: 'inherit' }}>{busy ? '…' : 'OK'}</button>
        </div>
        <button className="btn btn-ghost" onClick={onCancel} disabled={busy} style={{ width: '100%', height: 40, marginTop: 10 }}>Cancel</button>
      </div>
    </div>
  );
}
