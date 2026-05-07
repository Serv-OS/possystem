// MTender — customer-facing tip pass. The server hands the phone to the
// customer at this point; the screen is designed for a one-tap interaction.
// Tip preset → big Confirm button → auto-runs the card payment (MCardFlow).
//
// "Pay at counter" was removed in this pass — the phone is always a card
// device (Tap to Pay or assigned reader); cash always happens at the counter
// where the drawer lives, so server staff route those at the till instead.

import { useMemo, useState } from 'react';
import { useStore } from '../../store';
import { calculateOrderTax } from '../../lib/tax';
import { Sx, money } from './MShellStyles';

const TIP_PRESETS = [10, 12.5, 15, 20];

export default function MTender({ onBack, onConfirm }) {
  const { activeTableId, tables, walkInOrder, taxRates = [], orderType, deviceConfig } = useStore();

  const order = useMemo(() => {
    if (activeTableId) {
      const t = tables.find(x => x.id === activeTableId);
      return {
        items: (t?.session?.items || []).filter(i => !i.voided),
        label:`Table ${t?.label || activeTableId}`,
      };
    }
    return {
      items: walkInOrder?.items || [],
      label: walkInOrder?.customer?.name || 'New order',
    };
  }, [activeTableId, tables, walkInOrder]);

  const subtotal = order.items.reduce((s, i) => {
    const base = (i.price || 0) * (i.qty || 0);
    return s + (i.discount?.value ? base * (1 - i.discount.value / 100) : base);
  }, 0);
  const taxResult = useMemo(() => {
    try { return calculateOrderTax(order.items, taxRates, orderType); }
    catch { return { totalTax: 0 }; }
  }, [order.items, taxRates, orderType]);
  const tax = Number(taxResult?.totalTax) || 0;

  // Tip in £ amount (computed from selected preset OR custom override).
  const [tipPct, setTipPct] = useState(12.5);
  const [customTip, setCustomTip] = useState(null); // null | number
  const tipAmount = customTip != null ? customTip : ((subtotal + tax) * tipPct) / 100;
  const grand = subtotal + tax + tipAmount;

  const paymentMode = deviceConfig?.paymentMode || 'tap_to_pay';
  const subtitle =
    paymentMode === 'assigned_reader'
      ? 'Hand the phone to your guest — they’ll pay on the reader after confirming.'
      : 'Hand the phone to your guest. They tap a tip and Confirm — card prompt follows.';

  const onPickPreset = (p) => { setTipPct(p); setCustomTip(null); };
  const onPickNoTip = () => { setTipPct(0); setCustomTip(0); };

  return (
    <div style={Sx.shell}>
      {/* Customer-facing header — minimal, no back arrow at the top because
          this view is for the customer; server-back lives at the bottom. */}
      <div style={{ ...Sx.header, justifyContent:'center', borderBottom:'none', padding:'14px 14px 0' }}>
        <div style={{ textAlign:'center' }}>
          <div style={{ fontSize:11, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.08em', fontWeight:800 }}>
            Customer payment
          </div>
          <div style={{ fontSize:13, color:'var(--t3)', marginTop:4, lineHeight:1.4, padding:'0 8px' }}>
            {subtitle}
          </div>
        </div>
      </div>

      <div style={Sx.scroller}>
        {/* Total panel — large, customer-readable */}
        <div style={{ padding:'24px 16px 12px', textAlign:'center' }}>
          <div style={{ fontSize:11, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.07em', fontWeight:700 }}>Subtotal</div>
          <div style={{ fontSize:32, fontWeight:800, color:'var(--t2)', fontFamily:'var(--font-mono)', letterSpacing:'-.02em', marginTop:2 }}>
            {money(subtotal + tax)}
          </div>
          {tax > 0 && (
            <div style={{ fontSize:11, color:'var(--t4)', marginTop:2 }}>{money(subtotal)} + {money(tax)} tax</div>
          )}
        </div>

        {/* Tip prompt */}
        <div style={{ padding:'4px 16px 8px' }}>
          <div style={{ fontSize:14, fontWeight:800, color:'var(--t1)', textAlign:'center', marginBottom:14 }}>
            Add a tip?
          </div>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(2, 1fr)', gap:10, marginBottom:10 }}>
            {TIP_PRESETS.map(p => {
              const active = customTip == null && tipPct === p;
              const amt = ((subtotal + tax) * p) / 100;
              return (
                <button key={p} onClick={() => onPickPreset(p)} style={{
                  padding:'18px 8px', borderRadius:14,
                  border:`2px solid ${active ? 'var(--acc)' : 'var(--bdr2)'}`,
                  background: active ? 'var(--acc-d)' : 'var(--bg2)',
                  color: active ? 'var(--acc)' : 'var(--t1)',
                  fontFamily:'inherit', cursor:'pointer',
                  display:'flex', flexDirection:'column', alignItems:'center', gap:4, minHeight:90,
                }}>
                  <div style={{ fontSize:24, fontWeight:800 }}>{p}%</div>
                  <div style={{ fontSize:13, color: active ? 'var(--acc)' : 'var(--t3)', fontFamily:'var(--font-mono)', fontWeight:700 }}>
                    {money(amt)}
                  </div>
                </button>
              );
            })}
          </div>
          <button onClick={onPickNoTip} style={{
            width:'100%', padding:'12px', borderRadius:12,
            border:`2px solid ${customTip === 0 || tipPct === 0 ? 'var(--bdr2)' : 'transparent'}`,
            background: customTip === 0 || tipPct === 0 ? 'var(--bg3)' : 'transparent',
            color:'var(--t3)', fontSize:13, fontWeight:700, fontFamily:'inherit', cursor:'pointer',
          }}>
            No tip thanks
          </button>
        </div>

        {/* Total summary */}
        <div style={{ padding:'12px 16px 24px', textAlign:'center' }}>
          <div style={{ fontSize:11, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.07em', fontWeight:800, marginBottom:4 }}>Total to pay</div>
          <div style={{ fontSize:46, fontWeight:800, color:'var(--t1)', fontFamily:'var(--font-mono)', letterSpacing:'-.02em' }}>
            {money(grand)}
          </div>
          {tipAmount > 0 && (
            <div style={{ fontSize:11, color:'var(--t4)', marginTop:4 }}>incl. {money(tipAmount)} tip</div>
          )}
        </div>
      </div>

      {/* Big customer Confirm — auto-triggers card flow */}
      <div style={Sx.bottom}>
        <button onClick={() => onConfirm?.({ method:'card', tip: tipAmount, grand, subtotal, tax })} style={{ ...Sx.btnPrim, fontSize:17, padding:'18px 16px', minHeight:60 }}>
          Confirm · {money(grand)}
        </button>
        <button onClick={onBack} style={{ ...Sx.btnGhost, marginTop:8 }}>
          ← Back to order
        </button>
      </div>
    </div>
  );
}
