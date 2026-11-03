// src/components/CashTipsStep.jsx: "Cash tips this shift" before a US clock out (5.12.49).
// Shown by the Time Clock tablet and the staff app only when the venue asks (US venue, Workforce
// settings, Ask for cash tips at clock out). Card tips are recorded by the till already, so this asks
// only for CASH. "No cash tips" records 0; Back is "not now" and does not clock out.
import { useState } from 'react';
import { parseCashTips } from '../../supabase/functions/_shared/cashTips.js';

export default function CashTipsStep({ big = false, busy = false, error = '', onSubmit, onBack }) {
  const [amount, setAmount] = useState('');
  const [why, setWhy] = useState('');
  const size = big ? { title: 24, input: 34, btn: 17, pad: '16px 20px' } : { title: 16, input: 22, btn: 14, pad: '11px 14px' };
  const send = (raw) => {
    const r = parseCashTips(raw);
    if (r.error) { setWhy(r.error); return; }
    setWhy('');
    onSubmit?.(r.value ?? 0);
  };
  const btn = (bg, fg) => ({ padding: size.pad, borderRadius: 12, border: 'none', cursor: busy ? 'default' : 'pointer', fontFamily: 'inherit',
    fontSize: size.btn, fontWeight: 700, background: bg, color: fg, opacity: busy ? 0.6 : 1, flex: 1 });
  return (
    <div style={{ display: 'grid', gap: 12, textAlign: 'center' }}>
      <div style={{ fontSize: size.title, fontWeight: 700, color: 'var(--t1)' }}>Cash tips this shift</div>
      <div style={{ fontSize: big ? 14 : 12.5, color: 'var(--t3)', lineHeight: 1.5 }}>
        Type the cash tips you kept today. Card tips are already counted.
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
        <span style={{ fontSize: size.input, fontWeight: 700, color: 'var(--t2)' }}>$</span>
        <input inputMode="decimal" autoFocus aria-label="Cash tips in dollars" placeholder="0.00" value={amount}
          onChange={(e) => { setAmount(e.target.value.replace(/[^\d.]/g, '')); setWhy(''); }}
          onKeyDown={(e) => { if (e.key === 'Enter' && !busy) send(amount); }}
          style={{ width: big ? 200 : 140, fontSize: size.input, fontWeight: 700, textAlign: 'center', padding: '8px 10px', borderRadius: 12,
            border: '1.5px solid var(--bdr2, var(--bdr))', background: 'var(--bg2, transparent)', color: 'var(--t1)', fontFamily: 'var(--font-mono, inherit)' }} />
      </div>
      {(why || error) && <div style={{ color: 'var(--red)', fontSize: big ? 14 : 12.5, fontWeight: 600 }}>{why || error}</div>}
      <div style={{ display: 'flex', gap: 10 }}>
        <button type="button" disabled={busy} onClick={() => send(amount || '0')} style={btn('var(--acc, #15C26A)', '#fff')}>Clock out</button>
      </div>
      <div style={{ display: 'flex', gap: 10 }}>
        <button type="button" disabled={busy} onClick={() => send('0')} style={btn('var(--bg3, rgba(127,127,127,.12))', 'var(--t1)')}>No cash tips</button>
        <button type="button" disabled={busy} onClick={() => onBack?.()} style={btn('transparent', 'var(--t3)')}>Back</button>
      </div>
    </div>
  );
}
