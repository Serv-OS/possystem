// MTender — payment method picker. Reads the active order (table or walk-in)
// and offers Card · Pay at counter. Tip selector for card flows. Cash is
// intentionally absent — phones have no cash drawer (see docs/MPOS-SPEC.md).

import { useMemo, useState } from 'react';
import { useStore } from '../../store';
import { calculateOrderTax } from '../../lib/tax';
import { Sx, money } from './MShellStyles';

const TIP_PRESETS = [0, 10, 12.5, 15, 20];

export default function MTender({ onBack, onPay, onPayAtCounter }) {
  const { activeTableId, tables, walkInOrder, taxRates = [], orderType, deviceConfig } = useStore();

  const order = useMemo(() => {
    if (activeTableId) {
      const t = tables.find(x => x.id === activeTableId);
      return {
        kind:'table',
        items: (t?.session?.items || []).filter(i => !i.voided),
        label:`Table ${t?.label || activeTableId}`,
      };
    }
    return {
      kind:'walkin',
      items: walkInOrder?.items || [],
      label: walkInOrder?.customer?.name || 'New order',
    };
  }, [activeTableId, tables, walkInOrder]);

  const subtotal = order.items.reduce((s, i) => s + (i.price || 0) * (i.qty || 0), 0);
  const taxResult = useMemo(() => {
    try { return calculateOrderTax(order.items, taxRates, orderType); }
    catch { return { totalTax: 0, total: subtotal }; }
  }, [order.items, taxRates, orderType, subtotal]);
  const tax = Number(taxResult?.totalTax) || 0;

  const [tipPct, setTipPct] = useState(12.5);
  const [customTip, setCustomTip] = useState('');
  const tipAmount = customTip !== '' ? (parseFloat(customTip) || 0) : ((subtotal + tax) * tipPct) / 100;
  const grand = subtotal + tax + tipAmount;

  // Profile-driven payment-mode policy
  const paymentMode = deviceConfig?.paymentMode || 'tap_to_pay';
  const cardAllowed = paymentMode !== 'pay_at_counter_only';
  const counterAllowed = true; // always allowed as a fallback for cash

  const setPreset = (p) => { setTipPct(p); setCustomTip(''); };

  return (
    <div style={Sx.shell}>
      <div style={Sx.header}>
        <button onClick={onBack} style={Sx.iconBtn} aria-label="Back">←</button>
        <div style={{ flex:1, minWidth:0 }}>
          <div style={Sx.hTitle}>Take payment</div>
          <div style={Sx.hSub}>{order.label}</div>
        </div>
      </div>

      <div style={Sx.scroller}>
        {/* Total + breakdown */}
        <div style={{ padding:'18px 16px 8px', textAlign:'center' }}>
          <div style={{ fontSize:11, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.07em', fontWeight:700 }}>Total due</div>
          <div style={{ fontSize:46, fontWeight:800, color:'var(--t1)', fontFamily:'var(--font-mono)', letterSpacing:'-.02em', marginTop:4 }}>{money(grand)}</div>
          <div style={{ fontSize:11, color:'var(--t4)', marginTop:4 }}>
            {money(subtotal)} subtotal{tax > 0 ? ` · ${money(tax)} tax` : ''}{tipAmount > 0 ? ` · ${money(tipAmount)} tip` : ''}
          </div>
        </div>

        {/* Tip picker */}
        <div style={{ padding:'14px 16px 4px' }}>
          <div style={{ fontSize:11, fontWeight:700, color:'var(--t3)', textTransform:'uppercase', letterSpacing:'.06em', marginBottom:8 }}>
            Add a tip
          </div>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(5,1fr)', gap:6 }}>
            {TIP_PRESETS.map(p => {
              const active = customTip === '' && tipPct === p;
              const amt = ((subtotal + tax) * p) / 100;
              return (
                <button key={p} onClick={() => setPreset(p)} style={{
                  padding:'10px 4px', borderRadius:10,
                  border:`1.5px solid ${active ? 'var(--acc)' : 'var(--bdr2)'}`,
                  background: active ? 'var(--acc-d)' : 'var(--bg2)',
                  color: active ? 'var(--acc)' : 'var(--t2)',
                  fontFamily:'inherit', cursor:'pointer',
                  display:'flex', flexDirection:'column', alignItems:'center', gap:2,
                }}>
                  <div style={{ fontSize:13, fontWeight:800 }}>{p === 0 ? 'No tip' : `${p}%`}</div>
                  {p > 0 && <div style={{ fontSize:10, color:'var(--t4)', fontFamily:'var(--font-mono)' }}>{money(amt)}</div>}
                </button>
              );
            })}
          </div>
          <div style={{ marginTop:8 }}>
            <input
              value={customTip} onChange={(e) => setCustomTip(e.target.value.replace(/[^0-9.]/g, ''))}
              placeholder="Custom tip amount"
              inputMode="decimal"
              style={{
                width:'100%', padding:'10px 12px', borderRadius:10, border:'1px solid var(--bdr2)',
                background:'var(--bg2)', color:'var(--t1)', fontSize:13, fontFamily:'inherit', outline:'none', boxSizing:'border-box',
              }}/>
          </div>
        </div>

        {/* Method picker */}
        <div style={{ padding:'18px 16px 24px' }}>
          <div style={{ fontSize:11, fontWeight:700, color:'var(--t3)', textTransform:'uppercase', letterSpacing:'.06em', marginBottom:8 }}>
            Payment method
          </div>
          <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
            {cardAllowed && (
              <Method
                icon="📱" title="Card" desc={paymentMode === 'tap_to_pay' ? 'Tap, insert or swipe — Tap to Pay on this phone' : 'Customer pays on the assigned reader'}
                onClick={() => onPay?.({ method:'card', tip: tipAmount, grand, subtotal, tax })}
              />
            )}
            {counterAllowed && (
              <Method
                icon="💷" title="Pay at counter" desc="Send to counter for cash or card. The counter POS will see this order in the queue."
                onClick={() => onPayAtCounter?.({ tip: tipAmount, grand, subtotal, tax })}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Method({ icon, title, desc, onClick }) {
  return (
    <button onClick={onClick} style={{
      padding:'14px 14px', borderRadius:14, border:'1px solid var(--bdr)',
      background:'var(--bg2)', cursor:'pointer', fontFamily:'inherit', textAlign:'left',
      display:'flex', alignItems:'center', gap:14, minHeight:72,
    }}>
      <div style={{ fontSize:30, flexShrink:0, width:48, textAlign:'center' }}>{icon}</div>
      <div style={{ flex:1, minWidth:0 }}>
        <div style={{ fontSize:15, fontWeight:800, color:'var(--t1)' }}>{title}</div>
        <div style={{ fontSize:12, color:'var(--t3)', marginTop:2, lineHeight:1.4 }}>{desc}</div>
      </div>
      <div style={{ fontSize:20, color:'var(--t4)' }}>›</div>
    </button>
  );
}
