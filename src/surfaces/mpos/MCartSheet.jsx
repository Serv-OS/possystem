// MCartSheet — full-screen cart review for the active order. Reads items
// from either the active table's session or walkInOrder via the existing
// store helpers. Edit qty / remove pending items, or send to kitchen.
//
// Phase 1B-aware buttons:
//   • "Send to kitchen"  — for any open order, fires sendToKitchen()
//   • "Send & take payment" — for walk-in flows, lands at MTender (1C)
//   • "Done" — for table service after sending, returns to MTableView
//
// Sent items show as locked (status:'sent') — qty/remove blocked. Pending
// items are editable. Manager-PIN-gated voids land in 1D.

import { useMemo } from 'react';
import { useStore } from '../../store';
import { Sx, money, STATUS_PILL } from './MShellStyles';

export default function MCartSheet({ onClose, onSend, onSendAndPay, onAddMore }) {
  const {
    activeTableId, tables, walkInOrder,
    removeItem, updateItemQty, orderType, setOrderNote,
  } = useStore();
  // Live order note from whichever store branch holds the active order
  const liveNote = activeTableId
    ? (tables.find(t => t.id === activeTableId)?.session?.orderNote || '')
    : (walkInOrder?.orderNote || '');

  // Read live order data — table session or walk-in
  const sourceData = useMemo(() => {
    if (activeTableId) {
      const t = tables.find(x => x.id === activeTableId);
      return {
        kind:'table', label:`Table ${t?.label || activeTableId}`, sub:`${t?.session?.covers || 0} cover${t?.session?.covers === 1 ? '' : 's'}`,
        items: t?.session?.items || [], total: t?.session?.total || 0,
      };
    }
    const labelMap = {
      'takeaway':'Takeaway', 'collection':'Collection', 'delivery':'Delivery', 'dine-in':'Counter',
    };
    return {
      kind:'walkin', label: labelMap[orderType] || 'New order', sub: walkInOrder?.customer?.name || '',
      items: walkInOrder?.items || [], total: walkInOrder?.total || walkInOrder?.subtotal || 0,
    };
  }, [activeTableId, tables, walkInOrder, orderType]);

  const items = sourceData.items.filter(i => !i.voided);
  const subtotal = items.reduce((s, i) => s + (i.price || 0) * (i.qty || 0), 0);
  const cartCount = items.reduce((s, i) => s + (i.qty || 0), 0);
  const sentCount = items.filter(i => i.status === 'sent').length;
  const pendingCount = items.length - sentCount;

  const isWalkIn = sourceData.kind === 'walkin';
  const sendLabel = pendingCount > 0
    ? (isWalkIn ? `Send & take payment · ${money(subtotal)}` : `Send ${pendingCount} item${pendingCount === 1 ? '' : 's'} to kitchen`)
    : 'Take payment';

  const handlePrimary = () => {
    if (pendingCount === 0 && !isWalkIn) {
      // Nothing pending to send; this is the "go to tender" CTA on a fully-sent table
      onSendAndPay?.();
      return;
    }
    if (isWalkIn) {
      onSendAndPay?.();
    } else {
      onSend?.();
    }
  };

  return (
    <div style={Sx.shell}>
      {/* Header */}
      <div style={Sx.header}>
        <button onClick={onClose} style={Sx.iconBtn} aria-label="Back">←</button>
        <div style={{ flex:1, minWidth:0 }}>
          <div style={Sx.hTitle}>{sourceData.label}</div>
          <div style={Sx.hSub}>{sourceData.sub} · {cartCount} item{cartCount === 1 ? '' : 's'}</div>
        </div>
      </div>

      {/* Items */}
      <div style={Sx.scroller}>
        {items.length === 0 ? (
          <div style={Sx.emptyBlock}>
            <div style={{ fontSize:36, marginBottom:8, opacity:.3 }}>🧾</div>
            <div style={{ fontSize:14, color:'var(--t3)', fontWeight:700, marginBottom:4 }}>This order is empty</div>
            <div style={{ fontSize:12 }}>Tap Add items to start.</div>
          </div>
        ) : (
          <div style={{ padding:'8px 12px' }}>
            {items.map(it => <CartLine key={it.uid} item={it} onRemove={() => removeItem(it.uid)} onInc={() => updateItemQty(it.uid, +1)} onDec={() => updateItemQty(it.uid, -1)} />)}
          </div>
        )}

        {/* Order note */}
        {items.length > 0 && (
          <div style={{ padding:'8px 12px 4px' }}>
            <div style={{ fontSize:11, fontWeight:700, color:'var(--t3)', textTransform:'uppercase', letterSpacing:'.06em', marginBottom:6 }}>
              Order note
            </div>
            <textarea
              value={liveNote}
              onChange={(e) => setOrderNote(e.target.value.slice(0, 240))}
              placeholder="e.g. Allergy in party, table near window, ASAP…"
              style={{
                width:'100%', padding:'10px 12px', borderRadius:10, border:'1px solid var(--bdr2)',
                background:'var(--bg2)', color:'var(--t1)', fontSize:13, fontFamily:'inherit', outline:'none', boxSizing:'border-box',
                minHeight:56, resize:'vertical',
              }}/>
            <div style={{ fontSize:10, color:'var(--t4)', textAlign:'right', marginTop:2 }}>{liveNote.length}/240</div>
          </div>
        )}

        {items.length > 0 && (
          <div style={{ padding:'12px 16px 24px' }}>
            <div style={{ display:'flex', justifyContent:'space-between', padding:'10px 0', borderTop:'1px solid var(--bdr)' }}>
              <span style={{ fontSize:13, color:'var(--t3)', fontWeight:700 }}>Subtotal</span>
              <span style={{ fontSize:18, fontWeight:800, color:'var(--t1)', fontFamily:'var(--font-mono)' }}>{money(subtotal)}</span>
            </div>
            {sentCount > 0 && (
              <div style={{ marginTop:6, fontSize:11, color:'var(--t4)', textAlign:'center' }}>
                {sentCount} item{sentCount === 1 ? '' : 's'} already sent · only pending items can be edited
              </div>
            )}
          </div>
        )}
      </div>

      {/* Bottom actions */}
      <div style={Sx.bottom}>
        {items.length > 0 && pendingCount === 0 && !isWalkIn && (
          <div style={{ padding:'8px 0', textAlign:'center', fontSize:12, color:'var(--t3)' }}>
            All items sent — ready to take payment
          </div>
        )}
        <button onClick={handlePrimary} disabled={items.length === 0} style={{ ...Sx.btnPrim, opacity: items.length === 0 ? .4 : 1 }}>
          {sendLabel}
        </button>
        <button onClick={onAddMore} style={{ ...Sx.btnGhost, marginTop:8 }}>+ Add more items</button>
      </div>
    </div>
  );
}

function CartLine({ item, onRemove, onInc, onDec }) {
  const sent = item.status === 'sent';
  const lineTotal = (item.price || 0) * (item.qty || 0);
  const modsList = (item.mods || []).map(m => m?.name || m?.label || m).filter(Boolean);
  return (
    <div style={{
      padding:'12px 14px', background:'var(--bg2)', borderRadius:12,
      border:`1px solid ${sent ? 'var(--bdr)' : 'var(--bdr)'}`,
      marginBottom:8, display:'flex', flexDirection:'column', gap:8,
      opacity: sent ? .7 : 1,
    }}>
      <div style={{ display:'flex', alignItems:'flex-start', gap:10 }}>
        <div style={{ flex:1, minWidth:0 }}>
          <div style={{ display:'flex', alignItems:'baseline', gap:8, marginBottom:2 }}>
            <span style={{ fontSize:14, fontWeight:700, color:'var(--t1)' }}>{item.name}</span>
            {sent && <span style={{ ...Sx.pill, background:'var(--bg3)', color:'var(--t4)', border:'1px solid var(--bdr)' }}>Sent</span>}
            {item.course != null && item.course > 0 && (
              <span style={{ ...Sx.pill, background:'var(--acc-d)', color:'var(--acc)', border:'1px solid var(--acc-b)' }}>C{item.course}</span>
            )}
          </div>
          {modsList.length > 0 && (
            <div style={{ fontSize:11, color:'var(--t3)', lineHeight:1.4 }}>+ {modsList.join(' · ')}</div>
          )}
          {item.notes && (
            <div style={{ fontSize:11, color:'var(--acc)', marginTop:2, lineHeight:1.4 }}>📝 {item.notes}</div>
          )}
        </div>
        <div style={{ textAlign:'right', flexShrink:0 }}>
          <div style={{ fontSize:14, fontWeight:800, color:'var(--t1)', fontFamily:'var(--font-mono)' }}>{money(lineTotal)}</div>
          <div style={{ fontSize:10, color:'var(--t4)', fontFamily:'var(--font-mono)' }}>{money(item.price)} ea</div>
        </div>
      </div>

      {/* Qty stepper / remove — only on pending items */}
      {!sent && (
        <div style={{ display:'flex', alignItems:'center', gap:8 }}>
          <button onClick={onDec} style={{ ...Sx.iconBtn, width:34, height:34, fontSize:16 }}>−</button>
          <div style={{ fontSize:14, fontWeight:800, color:'var(--t1)', minWidth:24, textAlign:'center', fontFamily:'var(--font-mono)' }}>{item.qty}</div>
          <button onClick={onInc} style={{ ...Sx.iconBtn, width:34, height:34, fontSize:16, background:'var(--acc-d)', color:'var(--acc)', borderColor:'var(--acc-b)' }}>+</button>
          <div style={{ flex:1 }}/>
          <button onClick={onRemove} style={{
            padding:'7px 10px', borderRadius:8, border:'1px solid var(--red-b)',
            background:'transparent', color:'var(--red)', fontSize:12, fontWeight:700, fontFamily:'inherit', cursor:'pointer',
          }}>Remove</button>
        </div>
      )}
    </div>
  );
}
