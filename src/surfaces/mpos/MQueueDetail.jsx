// MQueueDetail — full view of a live queue order (kiosk / walk-in / takeaway /
// collection / delivery). Lets the server progress the status through the
// lifecycle: received → prep → ready → collected. Mutations call
// store.updateQueueStatus which auto-syncs to Supabase via the SyncBridge
// subscribe pattern (lib/sync/SyncBridge.jsx:534) so other POS / MPOS see
// the change within ~1s via the order_queue realtime channel.

import { useMemo } from 'react';
import { useStore } from '../../store';
import { Sx, money, elapsed, STATUS_PILL } from './MShellStyles';

const FLOW = ['received', 'prep', 'ready', 'collected'];

function nextStatus(current) {
  const idx = FLOW.indexOf(current);
  if (idx < 0 || idx >= FLOW.length - 1) return null;
  return FLOW[idx + 1];
}

function nextLabel(current) {
  const next = nextStatus(current);
  if (!next) return null;
  return next === 'prep'      ? '⏱ Mark in prep'
       : next === 'ready'     ? '✅ Mark ready'
       : next === 'collected' ? '🎯 Mark collected'
       : `Mark ${next}`;
}

export default function MQueueDetail({ order, onBack }) {
  const { orderQueue = [], updateQueueStatus, removeFromQueue, showToast } = useStore();
  // Read the live entry by ref so status changes from other devices reflect here
  const live = useMemo(() => orderQueue.find(o => o.ref === order?.ref) || order, [orderQueue, order]);
  if (!live) return null;

  const items = live.items || [];
  const subtotal = items.reduce((s, i) => s + (Number(i.price) || 0) * (Number(i.qty) || 0), 0);
  const status = live.status || 'received';
  const pill = STATUS_PILL[status] || STATUS_PILL.received;

  const advance = () => {
    const next = nextStatus(status);
    if (!next) return;
    updateQueueStatus(live.ref, next);
    if (next === 'ready') showToast?.(`${live.customer?.name || live.ref} ready for handoff`, 'success');
    if (next === 'collected') {
      showToast?.(`${live.ref} collected`, 'info');
      // Drop after 8s — give the realtime sync time to propagate before
      // removing from the queue locally.
      setTimeout(() => removeFromQueue(live.ref), 8000);
    }
  };

  const advanceLabel = nextLabel(status);
  const isFinal = !advanceLabel;

  return (
    <div style={Sx.shell}>
      <div style={Sx.header}>
        <button onClick={onBack} style={Sx.iconBtn} aria-label="Back">←</button>
        <div style={{ flex:1, minWidth:0 }}>
          <div style={Sx.hTitle}>{live.customer?.name || live.ref}</div>
          <div style={Sx.hSub}>
            <span style={{ textTransform:'uppercase' }}>{(live.type || 'takeaway')}</span>
            {live.source === 'kiosk' && ' · KIOSK'}
            {live.staff ? ` · ${live.staff}` : ''}
          </div>
        </div>
        <span style={{ ...Sx.pill, background: pill.bg, color: pill.fg, border:`1px solid ${pill.border}` }}>
          {pill.label}
        </span>
      </div>

      <div style={Sx.scroller}>
        {/* Status timeline — visual progress through the flow */}
        <div style={{ padding:'14px 16px 8px' }}>
          <Timeline current={status} />
        </div>

        {/* Customer + collection time */}
        {(live.customer?.phone || live.collectionTime || live.isASAP) && (
          <div style={{ margin:'0 14px 12px', padding:'12px 14px', borderRadius:12, background:'var(--bg2)', border:'1px solid var(--bdr)' }}>
            {live.customer?.name && (
              <Row label="Name">{live.customer.name}</Row>
            )}
            {live.customer?.phone && (
              <Row label="Phone"><a href={`tel:${live.customer.phone}`} style={{ color:'var(--acc)', textDecoration:'none', fontWeight:700 }}>{live.customer.phone}</a></Row>
            )}
            {live.customer?.address && (
              <Row label="Address">{live.customer.address}</Row>
            )}
            {(live.collectionTime || live.isASAP) && (
              <Row label="Collection">{live.isASAP ? '⚡ ASAP' : `⏰ ${live.collectionTime}`}</Row>
            )}
            <Row label="Placed">{elapsed(live.createdAt) || '—'} ago</Row>
          </div>
        )}

        {/* Items */}
        <div style={{ padding:'4px 14px' }}>
          <div style={{ fontSize:11, fontWeight:800, color:'var(--t3)', textTransform:'uppercase', letterSpacing:'.06em', marginBottom:8 }}>
            {items.length} item{items.length === 1 ? '' : 's'}
          </div>
          {items.map((it, i) => {
            const lineTotal = (Number(it.price) || 0) * (Number(it.qty) || 0);
            const modsList = (it.mods || [])
              .filter(m => !m?._instruction)
              .map(m => m?.name || m?.label || m).filter(Boolean);
            const instructions = (it.mods || [])
              .filter(m => m?._instruction)
              .map(m => m?.label || m?.name || m).filter(Boolean);
            return (
              <div key={i} style={{ padding:'10px 12px', background:'var(--bg2)', borderRadius:11, border:'1px solid var(--bdr)', marginBottom:6, display:'flex', gap:10 }}>
                <div style={{ fontSize:12, fontWeight:800, color:'var(--t4)', fontFamily:'var(--font-mono)', minWidth:24, paddingTop:1 }}>
                  {it.qty}×
                </div>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ fontSize:13, fontWeight:700, color:'var(--t1)' }}>{it.name}</div>
                  {modsList.length > 0 && (
                    <div style={{ fontSize:11, color:'var(--t3)', marginTop:1 }}>+ {modsList.join(' · ')}</div>
                  )}
                  {instructions.length > 0 && (
                    <div style={{ fontSize:11, color:'var(--acc)', marginTop:1 }}>{instructions.join(' · ')}</div>
                  )}
                  {it.notes && (
                    <div style={{ fontSize:11, color:'var(--acc)', marginTop:1 }}>📝 {it.notes}</div>
                  )}
                </div>
                <div style={{ fontSize:13, fontWeight:800, color:'var(--t2)', fontFamily:'var(--font-mono)' }}>
                  {money(lineTotal)}
                </div>
              </div>
            );
          })}
        </div>

        {/* Total */}
        <div style={{ padding:'12px 14px 24px' }}>
          <div style={{ display:'flex', justifyContent:'space-between', padding:'10px 0', borderTop:'1px solid var(--bdr)' }}>
            <span style={{ fontSize:13, color:'var(--t3)', fontWeight:700 }}>Total</span>
            <span style={{ fontSize:18, fontWeight:800, color:'var(--t1)', fontFamily:'var(--font-mono)' }}>{money(live.total || subtotal)}</span>
          </div>
          {live.paid && (
            <div style={{ marginTop:6, fontSize:11, fontWeight:700, color:'var(--grn)', textAlign:'right' }}>
              ✓ Already paid · {(live.paymentMethod || 'card').toUpperCase()}
            </div>
          )}
        </div>
      </div>

      {/* Bottom action bar */}
      <div style={Sx.bottom}>
        {advanceLabel ? (
          <button onClick={advance} style={Sx.btnPrim}>{advanceLabel}</button>
        ) : (
          <div style={{ padding:10, borderRadius:10, background:'var(--bg3)', color:'var(--t3)', fontSize:12, textAlign:'center', fontWeight:700 }}>
            Order complete · removing from queue shortly
          </div>
        )}
        {!isFinal && (
          <button
            onClick={() => { if (confirm('Cancel this order?')) { removeFromQueue(live.ref); onBack?.(); } }}
            style={{ ...Sx.btnGhost, color:'var(--red)', borderColor:'var(--red-b)', marginTop:8 }}>
            Cancel order
          </button>
        )}
      </div>
    </div>
  );
}

function Row({ label, children }) {
  return (
    <div style={{ display:'flex', alignItems:'baseline', gap:10, marginBottom:4 }}>
      <span style={{ fontSize:11, fontWeight:700, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.06em', minWidth:70 }}>{label}</span>
      <span style={{ flex:1, fontSize:13, color:'var(--t1)' }}>{children}</span>
    </div>
  );
}

function Timeline({ current }) {
  const steps = [
    { id:'received',  label:'Received',  icon:'📥' },
    { id:'prep',      label:'In prep',   icon:'⏱' },
    { id:'ready',     label:'Ready',     icon:'✅' },
    { id:'collected', label:'Collected', icon:'🎯' },
  ];
  const currentIdx = steps.findIndex(s => s.id === current);
  return (
    <div style={{ display:'flex', alignItems:'flex-start', gap:0 }}>
      {steps.map((s, i) => {
        const done = i < currentIdx;
        const active = i === currentIdx;
        return (
          <div key={s.id} style={{ flex:1, textAlign:'center', position:'relative' }}>
            <div style={{
              width:36, height:36, borderRadius:'50%', margin:'0 auto',
              background: done ? 'var(--grn)' : active ? 'var(--acc)' : 'var(--bg3)',
              color: done || active ? '#0b0c10' : 'var(--t4)',
              border: `2px solid ${done ? 'var(--grn)' : active ? 'var(--acc)' : 'var(--bdr)'}`,
              display:'flex', alignItems:'center', justifyContent:'center', fontSize:16, fontWeight:800,
            }}>{done ? '✓' : s.icon}</div>
            <div style={{ fontSize:10, fontWeight:700, color: active ? 'var(--acc)' : 'var(--t4)', marginTop:6, textTransform:'uppercase', letterSpacing:'.06em' }}>
              {s.label}
            </div>
            {/* Connector line to next step */}
            {i < steps.length - 1 && (
              <div style={{
                position:'absolute', top:18, right:-50, width:'100%', height:2,
                background: i < currentIdx ? 'var(--grn)' : 'var(--bdr)',
                zIndex:-1,
              }}/>
            )}
          </div>
        );
      })}
    </div>
  );
}
