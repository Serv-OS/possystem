// src/surfaces/RyftTestSurface.jsx
//
// Dev sandbox harness for the Ryft card-not-present flow (?mode=ryft-test).
// Renders the real RyftPaymentForm against the Ryft SANDBOX so we can prove the
// full client loop (create session → mount card fields → attemptPayment) end to
// end before wiring it into online / QR / kiosk. Not linked from anywhere.

import { useEffect, useState } from 'react';
import RyftPaymentForm from '../components/RyftPaymentForm';

export default function RyftTestSurface() {
  const [result, setResult] = useState(null);
  const [amount, setAmount] = useState(1000); // £10.00
  const [key, setKey] = useState(0);          // remount to start a fresh session

  useEffect(() => {
    const el = document.documentElement;
    el.setAttribute('data-skin', 'servos');
    el.setAttribute('data-theme', localStorage.getItem('rpos-theme') || 'light');
  }, []);

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div style={{ width: '100%', maxWidth: 460, background: 'var(--glass-bg)', backdropFilter: 'blur(22px) saturate(150%)', border: '1px solid var(--glass-border)', borderRadius: 20, padding: 28 }}>
        <div className="mono" style={{ fontSize: 10.5, letterSpacing: '.16em', textTransform: 'uppercase', color: 'var(--acc)' }}>Ryft · sandbox</div>
        <h1 style={{ fontSize: 22, fontWeight: 700, marginTop: 6 }}>Test card payment</h1>
        <div style={{ fontSize: 12.5, color: 'var(--t3)', marginTop: 6, lineHeight: 1.6 }}>
          Proves the Ryft embedded SDK end to end. Use a Ryft sandbox test card (e.g. <span className="mono">4242 4242 4242 4242</span>, any future expiry, any CVC). No real money moves.
        </div>

        {result ? (
          <div style={{ marginTop: 20, padding: 16, borderRadius: 12, background: 'var(--grn-d)', border: '1px solid var(--grn-b)' }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--grn)' }}>Payment {result.status} ✓</div>
            <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 6, fontFamily: 'var(--font-mono)', wordBreak: 'break-all' }}>{result.id}</div>
            <button className="btn btn-ghost" style={{ marginTop: 14 }} onClick={() => { setResult(null); setKey(k => k + 1); }}>New payment</button>
          </div>
        ) : (
          <div style={{ marginTop: 20 }}>
            <label className="mono" style={{ display: 'block', fontSize: 9.5, fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--t3)', marginBottom: 6 }}>Amount (pence)</label>
            <input value={amount} onChange={e => setAmount(parseInt(e.target.value, 10) || 0)} inputMode="numeric"
              style={{ width: '100%', background: 'var(--bg3)', border: '1.5px solid var(--bdr2)', borderRadius: 10, padding: '10px 12px', height: 44, fontSize: 15, color: 'var(--t1)', fontFamily: 'var(--font-mono)', outline: 'none', marginBottom: 16 }} />
            <RyftPaymentForm
              key={key}
              amountMinor={amount}
              currency="gbp"
              channel="online"
              merchantName="ServOS Test"
              onSuccess={(ps) => setResult({ status: ps.status, id: ps.id })}
              onError={() => {}}
            />
          </div>
        )}
      </div>
    </div>
  );
}
