/**
 * Orders — unified order management screen
 *
 * Three clear sections, always visible:
 *   1. Tables        — occupied table sessions
 *   2. Bar tabs      — open bar tabs
 *   3. Queue         — walk-in named / takeaway / collection / delivery
 *
 * Filters: order type tabs + My orders quick filter + search
 * Each section keeps its own functionality (advance status, open order, etc.)
 */
import { useState, useMemo, useEffect } from 'react';
import { useStore } from '../store';

// ── Channel definitions ────────────────────────────────────────────────────────
const FILTER_TABS = [
  { id:'all',        label:'All orders',  icon:'⊞' },
  { id:'table',      label:'Tables',      icon:'⬚',  color:'#3b82f6' },
  { id:'bar',        label:'Bar tabs',    icon:'🍸',  color:'#a855f7' },
  { id:'dine-in',    label:'Counter',     icon:'🏷',  color:'#22d3ee' },
  { id:'takeaway',   label:'Takeaway',    icon:'🥡',  color:'#e8a020' },
  { id:'collection', label:'Collection',  icon:'📦',  color:'#22c55e' },
  { id:'delivery',   label:'Delivery',    icon:'🛵',  color:'#ef4444' },
];

const SECTION_COLORS = {
  table:      '#3b82f6',
  bar:        '#a855f7',
  'dine-in':  '#22d3ee',
  takeaway:   '#e8a020',
  collection: '#22c55e',
  delivery:   '#ef4444',
};

const Q_STATUS = {
  received:  { label:'Received',  color:'#3b82f6' },
  prep:      { label:'In prep',   color:'#e8a020' },
  ready:     { label:'Ready ✓',   color:'#22c55e' },
  collected: { label:'Collected', color:'#888780' },
  paid:      { label:'Paid',      color:'#888780' },
};

function elapsed(date) {
  if (!date) return '';
  const s = Math.floor((Date.now() - new Date(date)) / 1000);
  if (s < 60)   return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

const money = n => `£${(n || 0).toFixed(2)}`;

// ── Root ──────────────────────────────────────────────────────────────────────
export default function OrdersHub() {
  const {
    tables, tabs, orderQueue,
    updateQueueStatus, removeFromQueue,
    showToast, setSurface, setActiveTableId,
    staff,
    routeKioskOrderPrints,
  } = useStore();

  const [filter, setFilter]     = useState('all');
  const [search, setSearch]     = useState('');
  const [myOrders, setMyOrders] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const [tick, setTick]         = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 30000);
    return () => clearInterval(id);
  }, []);

  // ── Build unified order pool ──────────────────────────────────────────────
  const allOrders = useMemo(() => {
    const out = [];

    // Table sessions
    tables.filter(t => t.status !== 'available' && t.session).forEach(t => {
      const items = t.session?.items?.filter(i => !i.voided) || [];
      out.push({
        _kind: 'table', id: `tbl-${t.id}`,
        ref: `Table ${t.label}`, channel: 'table',
        displayName: `Table ${t.label}`,
        section: t.section, server: t.session?.server,
        covers: t.session?.covers,
        items, total: t.session?.total || 0,
        status: t.status === 'bill' ? 'bill_req' : t.session?.sentAt ? 'active' : 'ordering',
        createdAt: t.session?.createdAt || t.session?.sentAt,
        sentAt: t.session?.sentAt,
        tableId: t.id, isChild: !!t.parentId, parentId: t.parentId,
        _table: t,
      });
    });

    // Bar tabs
    tabs?.filter(tab => tab.status !== 'closed').forEach(tab => {
      const rounds = tab.rounds || [];
      const items  = rounds.flatMap(r => r.items || []).filter(i => !i.voided);
      out.push({
        _kind: 'tab', id: `tab-${tab.id}`,
        ref: tab.ref || tab.id, channel: 'bar',
        displayName: tab.name || 'Bar tab',
        server: tab.openedBy,
        items, total: tab.total || 0,
        status: 'active',
        createdAt: tab.openedAt,
        sentAt: tab.openedAt,
        _tab: tab,
      });
    });

    // Queue (named dine-in, takeaway, collection, delivery)
    orderQueue.forEach(o => {
      out.push({
        _kind: 'queue', id: `q-${o.ref}`,
        ref: o.ref, channel: o.type || 'dine-in',
        displayName: o.customer?.name || o.ref,
        server: o.staff, customer: o.customer,
        items: o.items || [], total: o.total || 0,
        status: o.status || 'received',
        createdAt: o.createdAt, sentAt: o.sentAt,
        collectionTime: o.collectionTime, isASAP: o.isASAP,
        source: o.source || 'pos',
        paid: !!o.paid,
        paymentMethod: o.paymentMethod || null,
        _raw: o,
      });
    });

    return out;
  }, [tables, tabs, orderQueue, tick]);

  // ── Apply filters ────────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    let list = allOrders;
    if (filter !== 'all') list = list.filter(o => o.channel === filter);
    if (!showDone) list = list.filter(o => !['collected', 'paid'].includes(o.status));
    if (myOrders && staff) {
      const me = staff.name?.toLowerCase();
      list = list.filter(o => o.server?.toLowerCase() === me);
    }
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(o =>
        (o.displayName || '').toLowerCase().includes(q) ||
        (o.ref || '').toLowerCase().includes(q) ||
        (o.server || '').toLowerCase().includes(q)
      );
    }
    return list.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  }, [allOrders, filter, search, myOrders, showDone, staff]);

  // Split into sections
  const tableOrders = filtered.filter(o => o.channel === 'table');
  const barOrders   = filtered.filter(o => o.channel === 'bar');
  const queueOrders = filtered.filter(o => !['table', 'bar'].includes(o.channel));

  // Counts for tab badges
  const counts = useMemo(() => {
    const active = allOrders.filter(o => !['collected', 'paid'].includes(o.status));
    return Object.fromEntries(FILTER_TABS.map(t => [
      t.id,
      t.id === 'all'
        ? active.length
        : active.filter(o => o.channel === t.id).length
    ]));
  }, [allOrders]);

  const totalActive = counts.all || 0;

  // Actions
  const advance = (o) => {
    if (o._kind !== 'queue') return;
    const flow  = ['received', 'prep', 'ready', 'collected'];
    const idx   = flow.indexOf(o.status);
    if (idx < 0 || idx >= flow.length - 1) return;
    const next  = flow[idx + 1];
    updateQueueStatus(o.ref, next);
    if (next === 'ready')     showToast(`${o.displayName} — ready!`, 'success');
    if (next === 'collected') { showToast(`${o.ref} collected`, 'info'); setTimeout(() => removeFromQueue(o.ref), 8000); }
  };

  // v5.5.135: manual re-route for online/kiosk/qr orders. Fires the same
  // routing function the realtime handler fires, so the on-screen toast
  // diagnostic surfaces immediately. Use this when auto-routing didn't
  // run (master device offline at INSERT, fresh deploy not yet on the
  // device, etc.) to push the order through without re-opening the cart.
  const resendToKitchen = (o) => {
    // v5.5.136: noisy diagnostic — click is registered, what's available, what
    // are we sending. alert() is impossible to miss; toast would be silent if
    // the store fn returned silently or the toast itself was suppressed.
    const dump = `Send to kitchen clicked
Ref: ${o.ref}
Source: ${o.source || '(none)'}
Items count: ${(o.items || []).length}
First item: ${JSON.stringify(o.items?.[0] || null)}
routeKioskOrderPrints in store? ${!!routeKioskOrderPrints}`;
    // eslint-disable-next-line no-alert
    alert(dump);
    if (!routeKioskOrderPrints) {
      showToast('Routing function not available on this device', 'error');
      return;
    }
    if (!o.items?.length) {
      // eslint-disable-next-line no-alert
      alert('Order has no items — routing would silently exit. Items field shape:\n' + JSON.stringify(o.items));
      return;
    }
    routeKioskOrderPrints({
      ref: o.ref,
      source: o.source || 'pos',
      tableLabel: o.customer?.tableLabel || null,
      items: o.items || [],
      customer: o.customer || null,
      sentAt: o.sentAt || Date.now(),
      force: true,                                              // v5.5.137: bypass atomic claim — operator forced re-send
    });
  };

  const openOrder = (o) => {
    if (o._kind === 'table') { setActiveTableId(o.tableId); setSurface('tables'); }
    else if (o._kind === 'tab') { setSurface('bar'); }
    else {
      // Walk-in / takeaway / delivery / counter order — load it back into the
      // walk-in slot so the POS actually shows the items. Previously this branch
      // only called setSurface('pos') which left walkInOrder null, so the POS
      // rendered an empty cart every time.
      useStore.setState({
        walkInOrder: {
          id: `ORD-${(o.ref||'').replace('#','')}`,
          ref: o.ref,
          items: o.items || [],
          sentAt: o.sentAt,
          total: o.total,
          isASAP: o.isASAP,
          collectionTime: o.collectionTime,
        },
        customer: o.customer || null,
        // v4.6.5 follow-up Bug 2 real root cause: the orderQueue-to-list transform at
        // OrdersHub line 113-125 doesn't include `type` on the outer object — the original
        // entry is stashed under _raw. Read from _raw.type first so reopened takeaways don't
        // fall through to the 'dine-in' default.
        orderType: o._raw?.type || o.type || 'dine-in',
        activeTableId: null,
      });
      setSurface('pos');
    }
  };

  const showingSections = filter === 'all' && !search && !myOrders;

  return (
    <div style={{ display:'flex', flexDirection:'column', height:'100%', width:'100%', flex:1, minWidth:0, overflow:'hidden', background:'var(--bg)' }}>

      {/* ── Top bar ────────────────────────────────────────────────── */}
      <div style={{ padding:'10px 16px 0', borderBottom:'1px solid var(--bdr)', background:'var(--bg1)', flexShrink:0 }}>
        <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:10 }}>
          {/* Title */}
          <div style={{ flex:1 }}>
            <div style={{ fontSize:15, fontWeight:800, color:'var(--t1)', display:'flex', alignItems:'center', gap:10 }}>
              Orders
              {totalActive > 0 && (
                <span style={{ fontSize:11, fontWeight:800, padding:'2px 8px', borderRadius:20, background:'var(--acc)', color:'#0b0c10' }}>
                  {totalActive}
                </span>
              )}
            </div>
          </div>
          {/* Controls */}
          <div style={{ display:'flex', gap:8, alignItems:'center' }}>
            {/* My orders */}
            {staff && (
              <button onClick={() => setMyOrders(m => !m)} style={{
                padding:'5px 11px', borderRadius:20, cursor:'pointer', fontFamily:'inherit', fontSize:11,
                fontWeight:myOrders ? 800 : 500,
                background:myOrders ? 'var(--acc-d)' : 'var(--bg3)',
                border:`1.5px solid ${myOrders ? 'var(--acc)' : 'var(--bdr)'}`,
                color:myOrders ? 'var(--acc)' : 'var(--t3)',
              }}>
                👤 My orders
              </button>
            )}
            {/* Show completed */}
            <label style={{ display:'flex', alignItems:'center', gap:5, cursor:'pointer', fontSize:12, color:'var(--t3)' }}>
              <input type="checkbox" checked={showDone} onChange={e => setShowDone(e.target.checked)} style={{ accentColor:'var(--acc)' }} />
              Completed
            </label>
            {/* Search */}
            <div style={{ position:'relative' }}>
              <span style={{ position:'absolute', left:8, top:'50%', transform:'translateY(-50%)', fontSize:12, color:'var(--t4)', pointerEvents:'none' }}>🔍</span>
              <input
                style={{ background:'var(--bg3)', border:'1px solid var(--bdr2)', borderRadius:9, padding:'6px 10px 6px 26px', color:'var(--t1)', fontSize:12, fontFamily:'inherit', outline:'none', width:180 }}
                placeholder="Search…"
                value={search} onChange={e => setSearch(e.target.value)}
              />
            </div>
          </div>
        </div>

        {/* Filter tabs */}
        <div style={{ display:'flex', gap:2, overflowX:'auto' }}>
          {FILTER_TABS.map(tab => {
            const n = counts[tab.id] || 0;
            const active = filter === tab.id;
            const color = tab.color || 'var(--acc)';
            return (
              <button key={tab.id} onClick={() => setFilter(tab.id)} style={{
                padding:'6px 12px', cursor:'pointer', fontFamily:'inherit', border:'none',
                borderBottom:`3px solid ${active ? color : 'transparent'}`,
                background: active ? `${color}18` : 'transparent',
                color: active ? color : 'var(--t3)',
                fontSize:12, fontWeight:active ? 800 : 500, whiteSpace:'nowrap',
                borderRadius:'8px 8px 0 0', transition:'all .1s',
              }}>
                {tab.icon} {tab.label}
                {n > 0 && (
                  <span style={{ marginLeft:5, fontSize:10, fontWeight:800, padding:'1px 5px', borderRadius:8, background:active?color:'var(--bg3)', color:active?'#0b0c10':'var(--t4)' }}>
                    {n}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Content ─────────────────────────────────────────────────── */}
      <div style={{ flex:1, overflowY:'auto', padding:'14px 16px' }}>

        {filtered.length === 0 ? (
          <EmptyState filter={filter} search={search} myOrders={myOrders} staff={staff} />
        ) : showingSections ? (
          // Sectioned view when showing all orders unfiltered
          <>
            {tableOrders.length > 0 && (
              <Section title="Tables" icon="⬚" color="#3b82f6" count={tableOrders.length}>
                <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(280px,1fr))', gap:10 }}>
                  {tableOrders.map(o => <OrderCard key={o.id} order={o} onAdvance={()=>advance(o)} onOpen={()=>openOrder(o)} onResend={()=>resendToKitchen(o)} />)}
                </div>
              </Section>
            )}
            {barOrders.length > 0 && (
              <Section title="Bar tabs" icon="🍸" color="#a855f7" count={barOrders.length}>
                <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(280px,1fr))', gap:10 }}>
                  {barOrders.map(o => <OrderCard key={o.id} order={o} onAdvance={()=>advance(o)} onOpen={()=>openOrder(o)} onResend={()=>resendToKitchen(o)} />)}
                </div>
              </Section>
            )}
            {queueOrders.length > 0 && (
              <Section title="Walk-in / Takeaway / Delivery" icon="🏷" color="#22d3ee" count={queueOrders.length}>
                <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(280px,1fr))', gap:10 }}>
                  {queueOrders.map(o => <OrderCard key={o.id} order={o} onAdvance={()=>advance(o)} onOpen={()=>openOrder(o)} onResend={()=>resendToKitchen(o)} />)}
                </div>
              </Section>
            )}
          </>
        ) : (
          // Flat filtered view
          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(280px,1fr))', gap:10 }}>
            {filtered.map(o => <OrderCard key={o.id} order={o} onAdvance={()=>advance(o)} onOpen={()=>openOrder(o)} onResend={()=>resendToKitchen(o)} />)}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Section header ────────────────────────────────────────────────────────────
function Section({ title, icon, color, count, children }) {
  const [open, setOpen] = useState(true);
  return (
    <div style={{ marginBottom:20 }}>
      <div
        onClick={() => setOpen(o => !o)}
        style={{ display:'flex', alignItems:'center', gap:10, marginBottom:10, cursor:'pointer', userSelect:'none' }}>
        <div style={{ height:2, flex:1, background:`${color}40`, borderRadius:1 }} />
        <div style={{ display:'flex', alignItems:'center', gap:7, padding:'4px 12px', borderRadius:20, background:`${color}18`, border:`1px solid ${color}44` }}>
          <span>{icon}</span>
          <span style={{ fontSize:12, fontWeight:800, color }}>{title}</span>
          <span style={{ fontSize:11, fontWeight:700, padding:'0 5px', borderRadius:8, background:color, color:'#0b0c10' }}>{count}</span>
        </div>
        <div style={{ height:2, flex:1, background:`${color}40`, borderRadius:1 }} />
        <span style={{ fontSize:10, color, opacity:.7, marginLeft:4 }}>{open ? '▲' : '▼'}</span>
      </div>
      {open && children}
    </div>
  );
}

// ── Order card ────────────────────────────────────────────────────────────────
function OrderCard({ order, onAdvance, onOpen, onResend }) {
  const tab    = FILTER_TABS.find(t => t.id === order.channel) || FILTER_TABS[0];
  const color  = SECTION_COLORS[order.channel] || 'var(--acc)';
  const qs     = Q_STATUS[order.status] || Q_STATUS.received;
  const el     = elapsed(order.sentAt || order.createdAt);
  const items  = order.items || [];

  let statusText  = qs.label;
  let statusColor = qs.color;
  if (order.status === 'bill_req')  { statusText = 'Bill req.';    statusColor = '#ef4444'; }
  if (order.status === 'ordering')  { statusText = 'Building…';    statusColor = '#888780'; }
  if (order.status === 'scheduled') {
    // v4.6.61: dedicated label + colour for orders parked awaiting their fire time
    const fireAt = order._raw?.scheduledFireAt;
    if (fireAt) {
      const t = new Date(fireAt);
      statusText = `Fires ${t.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
    } else {
      statusText = 'Scheduled';
    }
    statusColor = '#a855f7'; // violet — distinct from prep/ready
  }
  if (order.status === 'active' && order._kind === 'table') { statusText = 'In service';  statusColor = '#3b82f6'; }
  if (order.status === 'active' && order._kind === 'tab')   { statusText = 'Open tab';    statusColor = '#a855f7'; }

  const NEXT = { received:'Mark in prep →', prep:'Mark ready →', ready:'Mark collected →' };
  const canAdvance = order._kind === 'queue' && !!NEXT[order.status];

  return (
    <div style={{
      background:'var(--bg1)', borderRadius:13, overflow:'hidden',
      border:`1.5px solid ${color}28`,
      display:'flex', flexDirection:'column',
      transition:'border-color .12s',
    }}
    onMouseEnter={e => e.currentTarget.style.borderColor = `${color}66`}
    onMouseLeave={e => e.currentTarget.style.borderColor = `${color}28`}>
      {/* Colour strip */}
      <div style={{ height:3, background:`linear-gradient(90deg,${color},${color}88)` }}/>

      {/* Header */}
      <div style={{ padding:'10px 13px', display:'flex', gap:10, alignItems:'flex-start' }}>
        <span style={{ fontSize:20 }}>{tab.icon}</span>
        <div style={{ flex:1, minWidth:0 }}>
          <div style={{ display:'flex', gap:6, alignItems:'baseline', flexWrap:'wrap' }}>
            <span style={{ fontSize:13, fontWeight:800, color:'var(--t1)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', maxWidth:150 }}>
              {order.displayName}
            </span>
            <span style={{ fontSize:10, color:'var(--t4)', fontFamily:'var(--font-mono)', flexShrink:0 }}>{order.ref}</span>
            {order.isChild && <span style={{ fontSize:9, padding:'1px 5px', borderRadius:8, background:'var(--bg3)', border:'1px solid var(--bdr)', color:'var(--t4)' }}>split</span>}
            {order.source === 'kiosk' && <span style={{ fontSize:9, fontWeight:700, padding:'1px 6px', borderRadius:8, background:'#8b5cf618', border:'1px solid #8b5cf644', color:'#8b5cf6' }}>KIOSK</span>}
            {order.paid && <span style={{ fontSize:9, fontWeight:700, padding:'1px 6px', borderRadius:8, background:'#22c55e18', border:'1px solid #22c55e44', color:'#22c55e' }}>PAID</span>}
          </div>
          <div style={{ display:'flex', gap:8, marginTop:3, flexWrap:'wrap' }}>
            {order.server  && <span style={{ fontSize:10, color:'var(--t3)' }}>👤 {order.server}</span>}
            {order.covers  && <span style={{ fontSize:10, color:'var(--t3)' }}>🧑 {order.covers}</span>}
            {el            && <span style={{ fontSize:10, color:'var(--t4)' }}>⏱ {el}</span>}
            {order.collectionTime && <span style={{ fontSize:10, fontWeight:700, color:'var(--acc)' }}>{order.isASAP ? '⚡ ASAP' : `⏰ ${order.collectionTime}`}</span>}
          </div>
        </div>
        <span style={{ fontSize:10, fontWeight:700, padding:'3px 8px', borderRadius:12, background:`${statusColor}18`, color:statusColor, border:`1px solid ${statusColor}40`, whiteSpace:'nowrap', flexShrink:0 }}>
          {statusText}
        </span>
      </div>

      {/* Items */}
      <div style={{ padding:'0 13px 10px', flex:1 }}>
        {items.length === 0 ? (
          <div style={{ fontSize:11, color:'var(--t4)', fontStyle:'italic' }}>No items yet</div>
        ) : (
          <>
            {items.slice(0, 4).map((item, i) => (
              <div key={i} style={{ display:'flex', gap:6, marginBottom:2, alignItems:'baseline' }}>
                <span style={{ fontSize:11, fontWeight:800, color:'var(--t4)', fontFamily:'var(--font-mono)', minWidth:18, textAlign:'right', flexShrink:0 }}>{item.qty}×</span>
                <span style={{ fontSize:12, color:'var(--t1)', flex:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                  {item.kitchenName || item.receiptName || item.name}
                </span>
                <span style={{ fontSize:11, color:'var(--t3)', fontFamily:'var(--font-mono)', flexShrink:0 }}>{money(item.price * item.qty)}</span>
              </div>
            ))}
            {items.length > 4 && <div style={{ fontSize:10, color:'var(--t4)', marginTop:3 }}>+{items.length - 4} more…</div>}
          </>
        )}
      </div>

      {/* Footer */}
      <div style={{ padding:'8px 13px', borderTop:'1px solid var(--bdr)', background:'var(--bg2)', display:'flex', alignItems:'center', gap:8 }}>
        <span style={{ fontSize:14, fontWeight:800, color:'var(--acc)', fontFamily:'var(--font-mono)' }}>{money(order.total)}</span>
        <span style={{ fontSize:10, color:'var(--t4)' }}>{items.length} item{items.length !== 1 ? 's' : ''}</span>
        {/* v5.5.135: visible `source` pill — diagnostic so we can see whether
            the source column on this row is set correctly (online/kiosk/qr) or
            blank/'pos'. Cheap to render, useful when "didn't auto-route" surfaces. */}
        {order._kind === 'queue' && (
          <span style={{ fontSize:9, fontWeight:700, padding:'1px 6px', borderRadius:8, background:'var(--bg3)', border:'1px solid var(--bdr)', color:'var(--t4)', fontFamily:'var(--font-mono)' }}>
            src:{order.source || '?'}
          </span>
        )}
        <div style={{ marginLeft:'auto', display:'flex', gap:5 }}>
          {/* v5.5.135: manual fallback for queue orders that didn't auto-route.
              Fires routeKioskOrderPrints — the same path the realtime handler
              uses. On-screen toast tells operator exactly what happened
              (no DevTools needed for Sunmi). Hidden for tables/tabs because
              they have their own send-to-kitchen flow via the cart. */}
          {order._kind === 'queue' && onResend && (
            <button onClick={onResend} style={{ padding:'4px 10px', borderRadius:7, cursor:'pointer', fontFamily:'inherit', background:'#fbbf2418', border:'1px solid #f59e0b66', color:'#f59e0b', fontSize:11, fontWeight:700 }}>
              🖨 Send to kitchen
            </button>
          )}
          <button onClick={onOpen} style={{ padding:'4px 10px', borderRadius:7, cursor:'pointer', fontFamily:'inherit', background:'var(--bg3)', border:'1px solid var(--bdr2)', color:'var(--t2)', fontSize:11, fontWeight:600 }}>
            Open →
          </button>
          {canAdvance && (
            <button onClick={onAdvance} style={{ padding:'4px 12px', borderRadius:7, cursor:'pointer', fontFamily:'inherit', background:'var(--acc)', border:'none', color:'#0b0c10', fontSize:11, fontWeight:700 }}>
              {NEXT[order.status]}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Empty state ───────────────────────────────────────────────────────────────
function EmptyState({ filter, search, myOrders, staff }) {
  const tab = FILTER_TABS.find(t => t.id === filter);
  if (search)   return <Blank icon="🔍" title={`No results for "${search}"`} sub="Try a different name or order reference" />;
  if (myOrders) return <Blank icon="👤" title={`No active orders for ${staff?.name || 'you'}`} sub="Your orders will appear here once sent" />;
  if (filter !== 'all') return <Blank icon={tab?.icon || '⊞'} title={`No active ${tab?.label || ''} orders`} sub="Orders will appear here once sent" />;
  return <Blank icon="⊞" title="No active orders" sub="Orders from all terminals appear here once sent to kitchen" />;
}

function Blank({ icon, title, sub }) {
  return (
    <div style={{ textAlign:'center', padding:'64px 20px', color:'var(--t4)' }}>
      <div style={{ fontSize:40, marginBottom:14, opacity:.15 }}>{icon}</div>
      <div style={{ fontSize:14, fontWeight:700, color:'var(--t2)', marginBottom:6 }}>{title}</div>
      {sub && <div style={{ fontSize:12, lineHeight:1.6 }}>{sub}</div>}
    </div>
  );
}
