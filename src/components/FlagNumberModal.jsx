// FlagNumberModal (30 Sep 2026, Peter, Coffee Boy): "For coffee shops, a setting we can turn on
// so that on dine in orders it prompts for a table flag: they have several numbered signs, no
// fixed tables, so staff must be prompted to type that number, and then the KDS and production
// tickets say Table and the number typed."
//
// POS only. Shown by POSSurface before a dine in walk in order is sent or paid, whichever comes
// first, when the device profile's "Ask for a flag number on dine in orders" switch is on
// (lib/tillOrderType.js needsFlagPrompt). Staff must enter a number: there is no skip, only Back
// to the order. Same keypad as the kiosk's flag screen (KioskApp ScreenTableNumber): 1 to 4 digits.

import { useState } from 'react';
import { cleanFlagNumber, flagTableLabel, FLAG_MAX_DIGITS } from '../lib/tillOrderType';

const KEYS = ['1','2','3','4','5','6','7','8','9','','0','⌫'];

export default function FlagNumberModal({ action = 'send', onConfirm, onClose }) {
  const [val, setVal] = useState('');
  const flag = cleanFlagNumber(val);
  const press = (k) => setVal(v => k === '⌫' ? v.slice(0, -1) : (v.length < FLAG_MAX_DIGITS ? v + k : v));
  const submit = () => { if (flag) onConfirm(flag); };
  const verb = action === 'pay' ? 'Pay' : 'Send';

  return (
    <div className="modal-back" onClick={e => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-label="Flag number" style={{
        background:'var(--bg2)', border:'1px solid var(--bdr2)', borderRadius:22,
        width:'100%', maxWidth:380, display:'flex', flexDirection:'column',
        boxShadow:'var(--sh3)', overflow:'hidden', animation:'slideUp .18s cubic-bezier(.2,.8,.3,1)',
      }}>
        <div style={{ padding:'18px 20px 4px' }}>
          <div style={{ fontSize:18, fontWeight:800, color:'var(--t1)' }}>Which flag number?</div>
          <div style={{ fontSize:12, color:'var(--t3)', marginTop:4 }}>Type the number on the customer&apos;s flag. The kitchen ticket will say Table and that number.</div>
        </div>

        <div style={{ padding:'12px 20px 0' }}>
          <div aria-live="polite" style={{
            background:'var(--bg3)', border:'1.5px solid var(--bdr2)', borderRadius:14, padding:'16px',
            textAlign:'center', fontSize:30, fontWeight:800, letterSpacing:'.04em',
            color: flag ? 'var(--acc)' : 'var(--t4)', fontFamily: flag ? 'var(--font-mono), ui-monospace, monospace' : 'inherit',
          }}>{flag ? flagTableLabel(flag) : 'Table'}</div>
        </div>

        <div style={{ display:'grid', gridTemplateColumns:'repeat(3, 1fr)', gap:8, padding:'12px 20px 0' }}>
          {KEYS.map((k, i) => k === ''
            ? <div key={i} aria-hidden="true"/>
            : (
              <button key={i} type="button" onClick={() => press(k)} disabled={k === '⌫' && !val}
                aria-label={k === '⌫' ? 'Delete' : k} style={{
                  height:56, borderRadius:12, cursor:'pointer', fontFamily:'inherit',
                  background:'var(--bg3)', border:'1px solid var(--bdr2)', color:'var(--t1)',
                  fontSize: k === '⌫' ? 20 : 24, fontWeight:700,
                  opacity: k === '⌫' && !val ? .4 : 1,
                }}>{k}</button>
            ))}
        </div>

        <div style={{ padding:'14px 20px 18px', display:'flex', gap:8 }}>
          <button type="button" className="btn btn-ghost" style={{ flex:1, height:44 }} onClick={onClose}>Back to order</button>
          <button type="button" className="btn btn-acc" style={{ flex:2, height:44, fontWeight:800 }} disabled={!flag} onClick={submit}>
            {flag ? `${verb} · ${flagTableLabel(flag)}` : `Enter the flag to ${verb.toLowerCase()}`}
          </button>
        </div>
      </div>
    </div>
  );
}
