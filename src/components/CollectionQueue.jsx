import { useState } from 'react';
import { useStore } from '../store';
import { money } from '../lib/currency';

const STATUS_FLOW = ['received', 'prep', 'ready', 'collected'];
const STATUS_META = {
  received:  { label: 'Received',   color: '#3b82f6', bg: 'rgba(59,130,246,.1)',   next: 'Start prep',    icon: '📥' },
  prep:      { label: 'In prep',    color: '#f97316', bg: 'rgba(249,115,22,.1)',    next: 'Mark ready',    icon: '👨‍🍳' },
  ready:     { label: 'Ready',      color: '#22c55e', bg: 'rgba(34,197,94,.1)',     next: 'Collected',     icon: '✅' },
  collected: { label: 'Collected',  color: '#8a8890', bg: 'rgba(138,136,144,.1)',   next: null,            icon: '👋' },
};

export default function CollectionQueue({ onClose }) {
  const { orderQueue, updateQueueStatus, removeFromQueue, showToast } = useStore();
  const [filter, setFilter] = useState('active'); // active | all | collected

  const now = new Date();

  const filtered = orderQueue.filter(o => {
    if (filter === 'active')    return o.status !== 'collected';
    if (filter === 'collected') return o.status === 'collected';
    return true;
  }).sort((a, b) => {
    // Sort by collection time, ASAP first
    if (a.isASAP && !b.isASAP) return -1;
    if (!a.isASAP && b.isASAP) return 1;
    return new Date(a.collectionISO || a.createdAt) - new Date(b.collectionISO || b.createdAt);
  });

  const getUrgency = (order) => {
    if (order.status === 'collected') return 'none';
    if (!order.collectionISO) return 'normal';
    const diff = (new Date(order.collectionISO) - now) / 60000; // minutes
    if (diff < 0)  return 'overdue';
    if (diff < 10) return 'urgent';
    if (diff < 20) return 'soon';
    return 'normal';
  };

  const urgencyColor = {
    overdue: 'var(--red)',
    urgent:  'var(--acc)',
    soon:    '#f97316',
    normal:  'var(--t3)',
    none:    'var(--t4)',
  };

  const advanceStatus = (order) => {
    const idx = STATUS_FLOW.indexOf(order.status);
    if (idx < STATUS_FLOW.length - 1) {
      const next = STATUS_FLOW[idx + 1];
      updateQueueStatus(order.ref, next);
      if (next === 'ready') {
        showToast(`${order.ref} ready — notifying ${order.customer.name}`, 'success');
      } else if (next === 'collected') {
        showToast(`${order.ref} collected — ${order.customer.name}`, 'info');
        setTimeout(() => removeFromQueue(order.ref), 5000);
      } else {
        showToast(`${order.ref} moved to ${STATUS_META[next].label}`, 'info');
      }
    }
  };

  const counts = {
    received: orderQueue.filter(o => o.status === 'received').length,
    prep:     orderQueue.filter(o => o.status === 'prep').length,
    ready:    orderQueue.filter(o => o.status === 'ready').length,
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,.6)',
      display: 'flex', alignItems: 'flex-end',
      zIndex: 150,
    }}>
      <div style={{
        width: '100%', maxWidth: 680, marginLeft: 'auto', marginRight: 'auto',
        background: 'var(--bg2)', borderRadius: '20px 20px 0 0',
        border: '1px solid var(--bdr2)', borderBottom: 'none',
        maxHeight: '85vh', display: 'flex', flexDirection: 'column',
        boxShadow: 'var(--sh3)',
      }}>
        {/* Header */}
        <div style={{ padding: '18px 20px 14px', borderBottom: '1px solid var(--bdr)', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
            <div>
              <div style={{ fontSize: 17, fontWeight: 700 }}>Collection queue</div>
              <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 2 }}>{orderQueue.filter(o=>o.status!=='collected').length} active orders</div>
            </div>
            <button onClick={onClose} style={{ background:'none', border:'none', color:'var(--t3)', cursor:'pointer', fontSize:22 }}>×</button>
          </div>

          {/* Status summary pills */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
            {Object.entries(STATUS_META).filter(([k])=>k!=='collected').map(([s, m]) => (
              <div key={s} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 12px', borderRadius: 20, background: m.bg, border: `1px solid ${m.color}44` }}>
                <span style={{ fontSize: 14 }}>{m.icon}</span>
                <span style={{ fontSize: 12, fontWeight: 600, color: m.color }}>{m.label}</span>
                <span style={{ fontSize: 14, fontWeight: 800, color: m.color }}>{counts[s] || 0}</span>
              </div>
            ))}
          </div>

          {/* Filter tabs */}
          <div style={{ display: 'flex', gap: 4 }}>
            {[['active','Active'],['collected','Completed'],['all','All']].map(([f,l]) => (
              <button key={f} onClick={() => setFilter(f)} style={{
                padding: '5px 14px', borderRadius: 20, cursor: 'pointer', fontFamily: 'inherit',
                background: filter===f ? 'var(--acc-d)' : 'transparent',
                border: `1px solid ${filter===f ? 'var(--acc-b)' : 'var(--bdr)'}`,
                color: filter===f ? 'var(--acc)' : 'var(--t3)',
                fontSize: 12, fontWeight: 600,
              }}>{l}</button>
            ))}
          </div>
        </div>

        {/* Order list */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '12px 16px' }}>
          {filtered.length === 0 && (
            <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--t3)' }}>
              <div style={{ fontSize: 40, marginBottom: 12 }}>📦</div>
              <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--t2)', marginBottom: 6 }}>No orders here</div>
              <div style={{ fontSize: 12 }}>Takeaway and collection orders will appear here</div>
            </div>
          )}

          {filtered.map(order => {
            const sm = STATUS_META[order.status];
            const urgency = getUrgency(order);
            const uc = urgencyColor[urgency];
            const typeIcon = order.type === 'collection' ? '📦' : '🥡';
            const waitMins = order.collectionISO
              ? Math.round((new Date(order.collectionISO) - now) / 60000)
              : null;

            return (
              <div key={order.ref} style={{
                background: 'var(--bg3)', border: `1px solid ${urgency==='overdue'?'var(--red-b)':urgency==='urgent'?'var(--acc-b)':'var(--bdr)'}`,
                borderRadius: 14, marginBottom: 10, overflow: 'hidden',
                opacity: order.status === 'collected' ? .6 : 1,
              }}>
                {/* Order header */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderBottom: '1px solid var(--bdr)' }}>
                  <div style={{ fontSize: 22 }}>{typeIcon}</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
                      <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--t1)' }}>{order.ref}</span>
                      <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--t2)' }}>{order.customer.name}</span>
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 2, display: 'flex', gap: 10 }}>
                      <span>{order.customer.phone}</span>
                      {order.customer.email && <span>{order.customer.email}</span>}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--acc)', fontFamily: 'DM Mono, monospace' }}>
                      {money(order.total)}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 1 }}>
                      {order.type === 'collection' ? 'Collection' : 'Takeaway'}
                    </div>
                  </div>
                </div>

                {/* Collection time + status */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px' }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                      <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 20, background: sm.bg, color: sm.color }}>
                        {sm.icon} {sm.label}
                      </span>
                      {order.type === 'collection' && (
                        <span style={{ fontSize: 12, fontWeight: 700, color: uc }}>
                          {order.isASAP ? '⚡ ASAP' : `🕐 ${order.customer.collectionTime}`}
                          {waitMins !== null && order.status !== 'collected' && (
                            <span style={{ marginLeft: 6, fontSize: 11, color: uc }}>
                              {waitMins < 0 ? `${Math.abs(waitMins)}m overdue` : waitMins === 0 ? 'now' : `in ${waitMins}m`}
                            </span>
                          )}
                        </span>
                      )}
                    </div>
                    {/* Items summary */}
                    <div style={{ fontSize: 11, color: 'var(--t3)', lineHeight: 1.5 }}>
                      {order.items.slice(0, 3).map((item, i) => (
                        <span key={i}>{item.qty}× {item.name}{i < Math.min(order.items.length, 3)-1 ? ', ' : ''}</span>
                      ))}
                      {order.items.length > 3 && <span> +{order.items.length - 3} more</span>}
                    </div>
                    {order.customer.notes && (
                      <div style={{ fontSize: 11, color: '#f97316', marginTop: 4, fontStyle: 'italic' }}>
                        📝 {order.customer.notes}
                      </div>
                    )}
                  </div>

                  {/* Action button */}
                  {sm.next && (
                    <button onClick={() => advanceStatus(order)} style={{
                      padding: '8px 16px', borderRadius: 10, cursor: 'pointer', fontFamily: 'inherit',
                      background: order.status === 'prep' ? 'var(--grn-d)' : 'var(--bg4)',
                      border: `1px solid ${order.status === 'prep' ? 'var(--grn-b)' : 'var(--bdr2)'}`,
                      color: order.status === 'prep' ? 'var(--grn)' : 'var(--t2)',
                      fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap',
                    }}>
                      {sm.next} →
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
