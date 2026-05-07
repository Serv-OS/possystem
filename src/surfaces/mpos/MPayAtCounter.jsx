// MPayAtCounter — confirms that this order should be sent to the counter for
// payment (cash, gift card, or any other tender the phone can't take). Inserts
// into order_queue with status='pending_cash' so the counter POS sees it in
// its open-orders list.
//
// For walk-in orders this also fires sendToKitchen first so the kitchen still
// gets the ticket. For table orders, the kitchen has already had it (or will
// when the server hits Send) — we just route the payment to the counter.

import { useState, useMemo } from 'react';
import { useStore } from '../../store';
import { supabase, getActiveLocationSync } from '../../lib/supabase';
import { Sx, money } from './MShellStyles';

export default function MPayAtCounter({ payment, onBack, onSent }) {
  const { activeTableId, tables, walkInOrder, customer, staff, orderType, sendToKitchen } = useStore();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const order = useMemo(() => {
    if (activeTableId) {
      const t = tables.find(x => x.id === activeTableId);
      return {
        kind:'table',
        items: (t?.session?.items || []).filter(i => !i.voided),
        ref: t?.session?.id || `T-${t?.label || activeTableId}`,
        label:`Table ${t?.label || activeTableId}`,
      };
    }
    return {
      kind:'walkin',
      items: walkInOrder?.items || [],
      ref: walkInOrder?.ref || `W-${Date.now()}`,
      label: walkInOrder?.customer?.name || customer?.name || 'New order',
    };
  }, [activeTableId, tables, walkInOrder, customer]);

  const send = async () => {
    setBusy(true); setError(null);
    try {
      // Walk-in: fire to kitchen first so the order isn't lost when we send to counter
      if (order.kind === 'walkin' && order.items.some(i => i.status !== 'sent')) {
        try { sendToKitchen?.(); } catch (e) { console.warn('[mpos] kitchen send', e); }
      }

      const locationId = getActiveLocationSync();
      if (!locationId) throw new Error('Location not resolved');

      const itemsPayload = order.items.map(i => ({
        id: i.itemId, name: i.name, qty: i.qty, price: i.price,
        mods: Array.isArray(i.mods) ? i.mods : [], cat: i.cat,
      }));

      const { error: insertErr } = await supabase.from('order_queue').insert({
        ref: order.ref,
        location_id: locationId,
        type: order.kind === 'table' ? 'dine-in' : (orderType || 'takeaway'),
        customer: {
          name: order.label,
          phone: customer?.phone || walkInOrder?.customer?.phone || null,
          email: customer?.email || null,
        },
        items: itemsPayload,
        total: payment.grand,
        status: 'pending_cash',
        staff: staff?.name || null,
        created_at: new Date().toISOString(),
        sent_at: new Date().toISOString(),
        is_asap: true,
        source: 'mpos',
        paid: false,
        payment_method: null,
      });
      if (insertErr) throw insertErr;
      onSent?.();
    } catch (e) {
      setError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={Sx.shell}>
      <div style={Sx.header}>
        <button onClick={onBack} style={Sx.iconBtn} aria-label="Back">←</button>
        <div style={{ flex:1 }}>
          <div style={Sx.hTitle}>Pay at counter</div>
          <div style={Sx.hSub}>{order.label}</div>
        </div>
      </div>

      <div style={Sx.scroller}>
        <div style={{ padding:'32px 16px 16px', textAlign:'center' }}>
          <div style={{ fontSize:54, marginBottom:10 }}>💷</div>
          <div style={{ fontSize:20, fontWeight:800, color:'var(--t1)', marginBottom:6 }}>
            Send to counter for payment
          </div>
          <div style={{ fontSize:13, color:'var(--t3)', maxWidth:360, margin:'0 auto', lineHeight:1.5 }}>
            The counter POS will see this order in its open-orders queue. Direct the customer to the counter — staff will take cash (or any other tender), open the drawer, and print the receipt.
          </div>
        </div>

        <div style={{ margin:'16px 16px', padding:'16px 18px', borderRadius:14, background:'var(--bg2)', border:'1px solid var(--bdr)' }}>
          <div style={{ display:'flex', justifyContent:'space-between', marginBottom:8, fontSize:13, color:'var(--t3)' }}>
            <span>Subtotal</span><span style={{ fontFamily:'var(--font-mono)', color:'var(--t2)' }}>{money(payment.subtotal)}</span>
          </div>
          {payment.tax > 0 && (
            <div style={{ display:'flex', justifyContent:'space-between', marginBottom:8, fontSize:13, color:'var(--t3)' }}>
              <span>Tax</span><span style={{ fontFamily:'var(--font-mono)', color:'var(--t2)' }}>{money(payment.tax)}</span>
            </div>
          )}
          {payment.tip > 0 && (
            <div style={{ display:'flex', justifyContent:'space-between', marginBottom:8, fontSize:13, color:'var(--t3)' }}>
              <span>Tip (optional at counter)</span><span style={{ fontFamily:'var(--font-mono)', color:'var(--t2)' }}>{money(payment.tip)}</span>
            </div>
          )}
          <div style={{ display:'flex', justifyContent:'space-between', marginTop:10, paddingTop:10, borderTop:'1px solid var(--bdr)', fontSize:18, fontWeight:800 }}>
            <span>Total due</span><span style={{ fontFamily:'var(--font-mono)', color:'var(--t1)' }}>{money(payment.grand)}</span>
          </div>
        </div>

        {error && (
          <div style={{ margin:'0 16px 16px', padding:10, borderRadius:10, background:'var(--red-d)', color:'var(--red)', fontSize:12, border:'1px solid var(--red-b)' }}>
            {error}
          </div>
        )}
      </div>

      <div style={Sx.bottom}>
        <button onClick={send} disabled={busy} style={{ ...Sx.btnPrim, opacity: busy ? .6 : 1 }}>
          {busy ? 'Sending…' : 'Send to counter'}
        </button>
        <button onClick={onBack} style={{ ...Sx.btnGhost, marginTop:8 }}>← Pick a different method</button>
      </div>
    </div>
  );
}
