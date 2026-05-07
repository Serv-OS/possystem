// MTableView — active-order screen for a seated table. Shows session header,
// items grouped by sent/pending, bottom action bar (Add items · Send · Pay).
// Tapping a line opens the cart for editing (1B reuses MCartSheet for that).
//
// For walk-in flows (no activeTableId) the parent skips this screen and goes
// straight from MNewOrder to MMenu.

import { useMemo } from 'react';
import { useStore } from '../../store';
import { Sx, money, elapsed, STATUS_PILL } from './MShellStyles';

export default function MTableView({ tableId, onAddItems, onOpenCart, onPay, onClose, onSendToKitchen }) {
  const { tables, sendToKitchen } = useStore();
  const table = tables.find(t => t.id === tableId);
  const session = table?.session;

  const items = useMemo(() => (session?.items || []).filter(i => !i.voided), [session]);
  const sentItems = items.filter(i => i.status === 'sent');
  const pendingItems = items.filter(i => i.status !== 'sent');
  const subtotal = items.reduce((s, i) => s + (i.price || 0) * (i.qty || 0), 0);
  const pendingTotal = pendingItems.reduce((s, i) => s + (i.price || 0) * (i.qty || 0), 0);

  if (!session) {
    return (
      <div style={Sx.shell}>
        <div style={Sx.header}>
          <button onClick={onClose} style={Sx.iconBtn} aria-label="Back">←</button>
          <div style={Sx.hTitle}>Table not seated</div>
        </div>
        <div style={Sx.emptyBlock}>
          <div style={{ fontSize:36, marginBottom:8, opacity:.3 }}>🪑</div>
          <div style={{ fontSize:14, color:'var(--t3)', fontWeight:700 }}>This table has no open session.</div>
        </div>
      </div>
    );
  }

  const handleSend = () => {
    sendToKitchen?.();
    onSendToKitchen?.();
  };

  return (
    <div style={Sx.shell}>
      <div style={Sx.header}>
        <button onClick={onClose} style={Sx.iconBtn} aria-label="Back">←</button>
        <div style={{ flex:1, minWidth:0 }}>
          <div style={Sx.hTitle}>Table {table.label}</div>
          <div style={Sx.hSub}>
            {session.covers} cover{session.covers === 1 ? '' : 's'}
            {session.server ? ` · ${session.server}` : ''}
            {' · '}{elapsed(session.seatedAt) || 'just now'}
          </div>
        </div>
      </div>

      <div style={Sx.scroller}>
        {/* Total summary card */}
        <div style={{ margin:'14px 14px 6px', padding:'14px 16px', background:'var(--bg2)', borderRadius:14, border:'1px solid var(--bdr)' }}>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'baseline' }}>
            <div>
              <div style={{ fontSize:11, color:'var(--t4)', fontWeight:700, textTransform:'uppercase', letterSpacing:'.06em' }}>Total</div>
              <div style={{ fontSize:28, fontWeight:800, color:'var(--t1)', fontFamily:'var(--font-mono)' }}>{money(subtotal)}</div>
            </div>
            {pendingItems.length > 0 && (
              <div style={{ textAlign:'right' }}>
                <div style={{ fontSize:11, color:'var(--acc)', fontWeight:700, textTransform:'uppercase', letterSpacing:'.06em' }}>Pending send</div>
                <div style={{ fontSize:18, fontWeight:800, color:'var(--acc)', fontFamily:'var(--font-mono)' }}>{money(pendingTotal)}</div>
                <div style={{ fontSize:11, color:'var(--t4)' }}>{pendingItems.length} item{pendingItems.length === 1 ? '' : 's'}</div>
              </div>
            )}
          </div>
        </div>

        {/* Pending items */}
        {pendingItems.length > 0 && (
          <Section title="To send" accent="var(--acc)" count={pendingItems.length}>
            {pendingItems.map(it => <ItemLine key={it.uid} item={it} onClick={onOpenCart} />)}
          </Section>
        )}

        {/* Sent items */}
        {sentItems.length > 0 && (
          <Section title="Already sent" accent="var(--t4)" count={sentItems.length}>
            {sentItems.map(it => <ItemLine key={it.uid} item={it} onClick={onOpenCart} />)}
          </Section>
        )}

        {items.length === 0 && (
          <div style={Sx.emptyBlock}>
            <div style={{ fontSize:36, marginBottom:8, opacity:.3 }}>🍽</div>
            <div style={{ fontSize:14, color:'var(--t3)', fontWeight:700, marginBottom:4 }}>No items yet</div>
            <div style={{ fontSize:12 }}>Tap "Add items" to start the order.</div>
          </div>
        )}

        <div style={{ height:24 }}/>
      </div>

      {/* Bottom action bar */}
      <div style={Sx.bottom}>
        <div style={{ display:'flex', gap:8, marginBottom:8 }}>
          <button onClick={onAddItems} style={{ ...Sx.btnGhost, flex:1 }}>+ Add items</button>
          {items.length > 0 && (
            <button onClick={onOpenCart} style={{ ...Sx.btnGhost, flex:1 }}>View cart</button>
          )}
        </div>
        {pendingItems.length > 0 ? (
          <button onClick={handleSend} style={Sx.btnPrim}>
            Send {pendingItems.length} item{pendingItems.length === 1 ? '' : 's'} to kitchen
          </button>
        ) : items.length > 0 ? (
          <button onClick={onPay} style={Sx.btnPrim}>Take payment · {money(subtotal)}</button>
        ) : null}
      </div>
    </div>
  );
}

function Section({ title, accent, count, children }) {
  return (
    <div style={{ margin:'14px 14px 6px' }}>
      <div style={{ display:'flex', alignItems:'center', gap:8, padding:'8px 4px' }}>
        <span style={{ fontSize:11, fontWeight:800, color:accent, textTransform:'uppercase', letterSpacing:'.07em' }}>{title}</span>
        <span style={{ fontSize:11, padding:'2px 7px', borderRadius:99, background:`${accent}22`, color:accent, fontWeight:800 }}>{count}</span>
        <span style={{ flex:1, height:1, background:'var(--bdr)' }}/>
      </div>
      {children}
    </div>
  );
}

function ItemLine({ item, onClick }) {
  const sent = item.status === 'sent';
  const lineTotal = (item.price || 0) * (item.qty || 0);
  const modsList = (item.mods || []).map(m => m?.name || m?.label || m).filter(Boolean);
  return (
    <div onClick={onClick} style={{
      padding:'10px 12px', background:'var(--bg2)', borderRadius:11, border:'1px solid var(--bdr)',
      marginBottom:6, display:'flex', gap:10, alignItems:'flex-start', cursor:'pointer',
      opacity: sent ? .8 : 1,
    }}>
      <div style={{ fontSize:12, fontWeight:800, color:'var(--t4)', fontFamily:'var(--font-mono)', minWidth:24, paddingTop:1 }}>
        {item.qty}×
      </div>
      <div style={{ flex:1, minWidth:0 }}>
        <div style={{ fontSize:13, fontWeight:700, color:'var(--t1)' }}>{item.name}</div>
        {modsList.length > 0 && (
          <div style={{ fontSize:11, color:'var(--t3)', lineHeight:1.4, marginTop:1 }}>+ {modsList.join(' · ')}</div>
        )}
        {item.notes && (
          <div style={{ fontSize:11, color:'var(--acc)', lineHeight:1.4, marginTop:1 }}>📝 {item.notes}</div>
        )}
      </div>
      <div style={{ fontSize:13, fontWeight:800, color:'var(--t2)', fontFamily:'var(--font-mono)' }}>{money(lineTotal)}</div>
    </div>
  );
}
