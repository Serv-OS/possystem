// v5.5.716 — QR "join an open tab" gate.
//
// When a phone scans a table that ALREADY has an open QR tab and this device is NOT the one that
// opened it (no matching localStorage stash), it must enter the 4-digit table code before it can add
// to / settle that tab. The opener sees the code on their own tab screen and shares it with the table.
// This stops a passer-by scanning the printed QR and ordering against (or closing) someone else's tab.
//
// The code is validated against order_queue.customer.tab_join_code (read in OnlineSurface). A short
// attempt limit blunts brute-forcing a 4-digit code through the UI.
import { useState } from 'react';

const MAX_ATTEMPTS = 5;

export default function JoinTabScreen({ theme, tableLabel, hasCode, onJoin }) {
  const muted   = theme.isLight ? '#6b6b70' : '#a0a0a8';
  const cardBdr = theme.isLight ? '#ececef' : '#2a2a30';
  const inputBg = theme.isLight ? '#f5f5f7' : '#1f1f24';
  const [code, setCode]       = useState('');
  const [error, setError]     = useState('');
  const [attempts, setAttempts] = useState(0);
  const locked = attempts >= MAX_ATTEMPTS;

  const submit = () => {
    if (locked) return;
    const ok = onJoin(code.trim());
    if (!ok) {
      const n = attempts + 1;
      setAttempts(n);
      setError(n >= MAX_ATTEMPTS
        ? 'Too many tries. Please ask a member of staff to help.'
        : 'That code didn’t match. Check the code on the phone that opened the tab.');
      setCode('');
    }
  };

  return (
    <div style={{ maxWidth: 420, margin: '0 auto', padding: '40px 22px', textAlign: 'center' }}>
      <div style={{ fontSize: 44, marginBottom: 14 }}>🔒</div>
      <div style={{ fontSize: 22, fontWeight: 800, color: theme.text, marginBottom: 8 }}>
        {tableLabel ? `Table ${tableLabel} has an open tab` : 'This table has an open tab'}
      </div>
      <div style={{ fontSize: 14.5, color: muted, lineHeight: 1.6, marginBottom: 24 }}>
        {hasCode
          ? 'Enter the table code shown on the phone that opened the tab to add your order to it.'
          : 'This tab was opened on another device. Please ask a member of staff to help you join it.'}
      </div>

      {hasCode && (
        <>
          <input
            value={code}
            onChange={(e) => { setError(''); setCode(e.target.value.replace(/\D/g, '').slice(0, 6)); }}
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
            disabled={locked}
            inputMode="numeric"
            autoFocus
            placeholder="Table code"
            style={{
              width: '100%', textAlign: 'center', fontSize: 30, fontWeight: 800,
              letterSpacing: '0.4em', padding: '16px 12px', borderRadius: 14,
              border: `1.5px solid ${error ? '#ef4444' : cardBdr}`, background: inputBg,
              color: theme.text, fontFamily: 'var(--font-mono, monospace)', outline: 'none',
              opacity: locked ? 0.5 : 1,
            }}
          />
          {error && <div style={{ color: '#ef4444', fontSize: 13, marginTop: 12 }}>{error}</div>}
          <button
            onClick={submit}
            disabled={locked || code.length < 4}
            style={{
              width: '100%', marginTop: 18, padding: '16px', borderRadius: 14, border: 'none',
              background: (locked || code.length < 4) ? cardBdr : theme.accent,
              color: (locked || code.length < 4) ? muted : '#fff',
              fontSize: 16, fontWeight: 800, cursor: (locked || code.length < 4) ? 'default' : 'pointer',
            }}>
            Join tab
          </button>
        </>
      )}

      <div style={{ fontSize: 12.5, color: muted, marginTop: 22, lineHeight: 1.6 }}>
        Don’t have the code? Ask a member of staff — they can add your order or share the tab.
      </div>
    </div>
  );
}
