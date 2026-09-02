// MTender — customer-facing tip pass. The server hands the phone to the
// customer at this point; the screen is designed for a one-tap interaction.
// Tip preset → big Confirm button → auto-runs the card payment (MCardFlow).
//
// "Pay at counter" was removed in this pass — the phone is always a card
// device (Tap to Pay or assigned reader); cash always happens at the counter
// where the drawer lives, so server staff route those at the till instead.

import { useMemo, useState } from 'react';
import { useStore } from '../../store';
import { computeOrderTaxUnified } from '../../lib/taxCompute';
import { Sx, money } from './MShellStyles';
import { adyenLocalBridgeAvailable } from '../../lib/payments/adyenLocalTerminal';

const TIP_PRESETS = [10, 12.5, 15, 20];

export default function MTender({ onBack, onConfirm }) {
  const { activeTableId, tables, walkInOrder, orderType, deviceConfig } = useStore();

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
  // v5.7.34: unified seam — same read shape (totalTax / exclusiveTax /
  // hasExclusiveTax); legacy-equivalent venues byte-identical.
  const taxCtx = useStore(s => s.getTaxContext());
  const taxResult = useMemo(() => {
    try { return computeOrderTaxUnified(order.items, taxCtx, orderType); }
    catch { return { totalTax: 0 }; }
  }, [order.items, taxCtx, orderType]);
  const tax = Number(taxResult?.totalTax) || 0;
  // v5.5.341: VAT-inclusive (UK) prices already CONTAIN the tax, so the bill is
  // just the gross subtotal — adding tax on top double-counted it. Only add when
  // the rate is exclusive (US sales tax).
  // v5.7.31: add exclusiveTax (the exclusive-mode lines' share only), never
  // totalTax — a check mixing inclusive and exclusive rates was re-charging the
  // inclusive VAT on top. Pure-exclusive and pure-inclusive checks unchanged.
  const exclusive = !!taxResult?.hasExclusiveTax;
  const preTip = subtotal + (Number(taxResult?.exclusiveTax) || 0);

  // Tip in £ amount (computed from selected preset OR custom override).
  const [tipPct, setTipPct] = useState(12.5);
  const [customTip, setCustomTip] = useState(null); // null | number
  // v5.8.19: the tip % applies to the goods, not to goods + sales tax (preTip
  // is what the card takes before the tip; it stays the charge basis).
  const tipAmount = customTip != null ? customTip : (subtotal * tipPct) / 100;
  const grand = preTip + tipAmount;

  const paymentMode = deviceConfig?.paymentMode || 'tap_to_pay';
  // v5.6.81 — on an Adyen payment terminal this app IS the card machine, so "hand
  // the phone to your guest… card prompt follows" would send staff looking for a
  // second device that does not exist.
  const subtitle =
    adyenLocalBridgeAvailable()
      ? 'Hand the terminal to your guest. They pick a tip, confirm, then present their card here.'
      : paymentMode === 'assigned_reader'
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
          <div style={{ fontSize:11, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.07em', fontWeight:700 }}>Order total</div>
          <div style={{ fontSize:32, fontWeight:800, color:'var(--t2)', fontFamily:'var(--font-mono)', letterSpacing:'-.02em', marginTop:2 }}>
            {money(preTip)}
          </div>
          {tax > 0 && (
            <div style={{ fontSize:11, color:'var(--t4)', marginTop:2 }}>
              {/* v5.7.31: the "+" figure is the exclusive share actually charged, never totalTax */}
              {exclusive ? `${money(subtotal)} + ${money(Number(taxResult?.exclusiveTax) || 0)} tax` : `incl. VAT ${money(tax)}`}
            </div>
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
              const amt = (subtotal * p) / 100;
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
