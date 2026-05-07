// MOrdersList — every order this server can see, grouped by lifecycle stage.
// Pull-to-refresh hooks come in 1D; for now realtime keeps the lists current.

import { useState, useMemo } from 'react';
import { useStore } from '../../store';
import { Sx, money, elapsed, STATUS_PILL } from './MShellStyles';

const FILTERS = [
  { id:'all',       label:'All' },
  { id:'mine',      label:'Mine' },
  { id:'takeaway',  label:'Takeaway' },
  { id:'collection',label:'Collection' },
  { id:'delivery',  label:'Delivery' },
  { id:'kiosk',     label:'Kiosk' },
];

export default function MOrdersList({ onOpenOrder }) {
  const { staff, tables = [], orderQueue = [], closedChecks = [] } = useStore();
  const myName = staff?.name?.toLowerCase();
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');

  const matchesFilter = (o) => {
    if (filter === 'all') return true;
    if (filter === 'mine') {
      const owner = (o.server || o.staff || '').toLowerCase();
      return owner && owner === myName;
    }
    if (filter === 'kiosk') return o.source === 'kiosk' || o._source === 'kiosk';
    return o.type === filter || o.channel === filter || o.orderType === filter;
  };

  const matchesSearch = (o) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return [o.ref, o.displayName, o.customer?.name, o.server, o.staff, o.tableLabel]
      .filter(Boolean).some(s => String(s).toLowerCase().includes(q));
  };

  // ── Section: open table sessions ─────────────────────────────────────────
  const openTables = useMemo(() => tables
    .filter(t => t.status !== 'available' && t.session)
    .map(t => ({
      _kind:'table', id:`tbl-${t.id}`,
      ref:`Table ${t.label}`, displayName:`Table ${t.label}`,
      tableLabel:t.label, server:t.session?.server, customer:null,
      status:t.status === 'bill' ? 'bill_req' : 'open',
      items:t.session?.items?.filter(i => !i.voided) || [],
      total:t.session?.total || 0,
      createdAt:t.session?.seatedAt || t.session?.createdAt,
      _table:t,
    }))
    .filter(matchesFilter).filter(matchesSearch), [tables, filter, search, myName]);

  // ── Section: live queue (received → prep → ready) ─────────────────────────
  const queueOpen = useMemo(() => orderQueue
    .filter(o => !['collected', 'paid'].includes(o.status))
    .map(o => ({
      _kind:'queue', id:`q-${o.ref}`,
      ref:o.ref, displayName:o.customer?.name || o.ref, server:o.staff,
      customer:o.customer, status:o.status || 'received',
      items:o.items || [], total:o.total || 0,
      createdAt:o.createdAt, sentAt:o.sentAt,
      type:o.type, source:o.source, paid:o.paid,
      _raw:o,
    }))
    .filter(matchesFilter).filter(matchesSearch), [orderQueue, filter, search, myName]);

  // ── Section: ready for collection / delivery (ready status) ───────────────
  const ready = queueOpen.filter(o => o.status === 'ready');
  const inFlight = queueOpen.filter(o => o.status !== 'ready');

  // ── Section: recently closed ──────────────────────────────────────────────
  const closed = useMemo(() => [...closedChecks]
    .sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0))
    .slice(0, 30)
    .map(c => ({
      _kind:'closed', id:`c-${c.id}`,
      ref:c.ref || c.id?.slice(0, 6), displayName:c.customer || c.ref,
      server:c.server, customer:{ name:c.customer, phone:c.customerPhone },
      status:c.status || 'paid', items:c.items || [], total:c.total || 0,
      createdAt:c.closedAt, _source:c.source,
    }))
    .filter(matchesFilter).filter(matchesSearch), [closedChecks, filter, search, myName]);

  return (
    <div style={{ ...Sx.scroller, display:'flex', flexDirection:'column' }}>
      {/* Title + search */}
      <div style={{ padding:'14px 14px 8px', flexShrink:0 }}>
        <div style={{ fontSize:18, fontWeight:800, color:'var(--t1)', marginBottom:10 }}>Orders</div>
        <input
          value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search ref, name, server…"
          style={{
            width:'100%', padding:'10px 12px', borderRadius:10, border:'1px solid var(--bdr2)',
            background:'var(--bg2)', color:'var(--t1)', fontSize:13, fontFamily:'inherit', outline:'none', boxSizing:'border-box',
          }}/>
      </div>

      {/* Filter chips */}
      <div style={{ padding:'4px 14px 8px', display:'flex', gap:6, overflowX:'auto', flexShrink:0, WebkitOverflowScrolling:'touch' }}>
        {FILTERS.map(f => {
          const active = filter === f.id;
          return (
            <button key={f.id} onClick={() => setFilter(f.id)} style={{
              padding:'7px 14px', borderRadius:99, border:`1.5px solid ${active ? 'var(--acc)' : 'var(--bdr2)'}`,
              background: active ? 'var(--acc-d)' : 'var(--bg2)', color: active ? 'var(--acc)' : 'var(--t3)',
              fontSize:12, fontWeight:700, whiteSpace:'nowrap', cursor:'pointer', fontFamily:'inherit', flexShrink:0,
            }}>{f.label}</button>
          );
        })}
      </div>

      {/* Sections */}
      <div style={{ padding:'0 14px 32px' }}>
        <Section title="Ready for handoff" count={ready.length} accent="var(--grn)">
          {ready.map(o => <OrderCard key={o.id} order={o} onClick={() => onOpenOrder?.(o)} />)}
        </Section>

        <Section title="My open tables" count={openTables.length} accent="#3b82f6">
          {openTables.map(o => <OrderCard key={o.id} order={o} onClick={() => onOpenOrder?.(o)} />)}
        </Section>

        <Section title="In flight" count={inFlight.length} accent="var(--acc)">
          {inFlight.map(o => <OrderCard key={o.id} order={o} onClick={() => onOpenOrder?.(o)} />)}
        </Section>

        <Section title="Recently closed" count={closed.length} accent="var(--t4)" collapsedByDefault>
          {closed.map(o => <OrderCard key={o.id} order={o} onClick={() => onOpenOrder?.(o)} />)}
        </Section>

        {ready.length + openTables.length + inFlight.length + closed.length === 0 && (
          <div style={Sx.emptyBlock}>
            <div style={{ fontSize:36, marginBottom:8, opacity:.3 }}>📋</div>
            <div style={{ fontSize:14, color:'var(--t3)', fontWeight:700, marginBottom:4 }}>Nothing to show yet</div>
            <div style={{ fontSize:12 }}>Orders you take or that arrive at this location will appear here.</div>
          </div>
        )}
      </div>
    </div>
  );
}

function Section({ title, count, accent, children, collapsedByDefault = false }) {
  const [open, setOpen] = useState(!collapsedByDefault);
  if (count === 0 && collapsedByDefault) return null;
  return (
    <div style={{ marginBottom:14 }}>
      <button onClick={() => setOpen(o => !o)} style={{
        width:'100%', display:'flex', alignItems:'center', gap:8, padding:'12px 6px', cursor:'pointer',
        background:'transparent', border:'none', fontFamily:'inherit', color:'var(--t1)',
      }}>
        <span style={{ fontSize:11, fontWeight:800, color:accent, textTransform:'uppercase', letterSpacing:'.07em' }}>{title}</span>
        <span style={{ fontSize:11, padding:'2px 7px', borderRadius:99, background:`${accent}22`, color:accent, fontWeight:800 }}>{count}</span>
        <span style={{ flex:1, height:1, background:'var(--bdr)', margin:'0 4px' }}/>
        <span style={{ fontSize:11, color:'var(--t4)' }}>{open ? '▼' : '▶'}</span>
      </button>
      {open && children}
    </div>
  );
}

function OrderCard({ order, onClick }) {
  const pill = STATUS_PILL[order.status] || STATUS_PILL.open;
  return (
    <div onClick={onClick} style={Sx.cardRow}>
      <div style={{ flex:1, minWidth:0 }}>
        <div style={{ display:'flex', gap:6, alignItems:'baseline', marginBottom:2, flexWrap:'wrap' }}>
          <span style={{ fontSize:13, fontWeight:800, color:'var(--t1)', overflow:'hidden', textOverflow:'ellipsis' }}>
            {order.displayName}
          </span>
          {order.ref && order.ref !== order.displayName && (
            <span style={{ fontSize:11, color:'var(--t4)', fontFamily:'var(--font-mono)' }}>{order.ref}</span>
          )}
          <span style={{ ...Sx.pill, background:pill.bg, color:pill.fg, border:`1px solid ${pill.border}` }}>{pill.label}</span>
          {order.source === 'kiosk' && <span style={{ ...Sx.pill, background:'#8b5cf618', color:'#8b5cf6', border:'1px solid #8b5cf644' }}>KIOSK</span>}
          {order.paid && <span style={{ ...Sx.pill, background:'var(--grn-d)', color:'var(--grn)', border:'1px solid var(--grn-b)' }}>PAID</span>}
        </div>
        <div style={{ fontSize:11, color:'var(--t3)', display:'flex', gap:10 }}>
          {order.server && <span>👤 {order.server}</span>}
          <span>{(order.items || []).length} item{(order.items || []).length === 1 ? '' : 's'}</span>
          <span>⏱ {elapsed(order.createdAt) || '—'}</span>
        </div>
      </div>
      <div style={{ textAlign:'right', flexShrink:0 }}>
        <div style={{ fontSize:14, fontWeight:800, color:'var(--acc)', fontFamily:'var(--font-mono)' }}>{money(order.total)}</div>
      </div>
    </div>
  );
}
