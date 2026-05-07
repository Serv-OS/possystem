// MOrderHistory — searchable history of closed checks. Lets the cashier
// reprint a receipt or kick off a refund. Reads from store.closedChecks
// (kept in sync with Supabase via realtime in lib/realtime.js).
//
// Filters: today / yesterday / 7 days / 30 days, plus a free-text search
// over ref / customer / server / table label.

import { useMemo, useState } from 'react';
import { useStore } from '../../store';
import { Sx, money, elapsed, STATUS_PILL } from './MShellStyles';

const RANGES = [
  { id:'today',     label:'Today',      ms: 24*60*60*1000 },
  { id:'yesterday', label:'Yesterday',  ms: 48*60*60*1000 },
  { id:'7d',        label:'7 days',     ms: 7*24*60*60*1000 },
  { id:'30d',       label:'30 days',    ms: 30*24*60*60*1000 },
  { id:'all',       label:'All',        ms: Infinity },
];

function startOfToday() {
  const d = new Date(); d.setHours(0,0,0,0); return d.getTime();
}
function startOfYesterday() {
  const d = new Date(); d.setHours(0,0,0,0); return d.getTime() - 24*60*60*1000;
}

export default function MOrderHistory({ onBack, onOpen }) {
  const { closedChecks = [] } = useStore();
  const [range, setRange] = useState('today');
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    let list = [...closedChecks].sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0));
    // Range filter
    const now = Date.now();
    if (range === 'today') {
      const since = startOfToday();
      list = list.filter(c => (c.closedAt || 0) >= since);
    } else if (range === 'yesterday') {
      const since = startOfYesterday();
      const until = startOfToday();
      list = list.filter(c => (c.closedAt || 0) >= since && (c.closedAt || 0) < until);
    } else if (range === '7d') {
      list = list.filter(c => (now - (c.closedAt || 0)) <= RANGES[2].ms);
    } else if (range === '30d') {
      list = list.filter(c => (now - (c.closedAt || 0)) <= RANGES[3].ms);
    }
    // Search filter
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(c =>
        String(c.ref || '').toLowerCase().includes(q) ||
        String(c.customer || c.customer?.name || '').toLowerCase().includes(q) ||
        String(c.server || '').toLowerCase().includes(q) ||
        String(c.tableLabel || '').toLowerCase().includes(q)
      );
    }
    return list;
  }, [closedChecks, range, search]);

  // Day rollup totals
  const stats = useMemo(() => {
    const count = filtered.length;
    const gross = filtered.reduce((s, c) => s + (Number(c.total) || 0), 0);
    const tips = filtered.reduce((s, c) => s + (Number(c.tip) || 0), 0);
    const refunded = filtered.reduce((s, c) => s + (c.refunds || []).reduce((a, r) => a + (Number(r.amount) || 0), 0), 0);
    return { count, gross, tips, refunded };
  }, [filtered]);

  return (
    <div style={Sx.shell}>
      <div style={Sx.header}>
        <button onClick={onBack} style={Sx.iconBtn} aria-label="Back">←</button>
        <div style={{ flex:1, minWidth:0 }}>
          <div style={Sx.hTitle}>Closed orders</div>
          <div style={Sx.hSub}>{stats.count} order{stats.count === 1 ? '' : 's'} · {money(stats.gross)} gross</div>
        </div>
      </div>

      {/* Stats row */}
      <div style={{ padding:'10px 14px 8px', display:'grid', gridTemplateColumns:'repeat(3, 1fr)', gap:8 }}>
        <Stat label="Sales" value={money(stats.gross)} />
        <Stat label="Tips" value={money(stats.tips)} />
        <Stat label="Refunded" value={money(stats.refunded)} red={stats.refunded > 0} />
      </div>

      {/* Range chips */}
      <div style={{ padding:'4px 12px 6px', display:'flex', gap:6, overflowX:'auto', flexShrink:0, WebkitOverflowScrolling:'touch' }}>
        {RANGES.map(r => {
          const active = range === r.id;
          return (
            <button key={r.id} onClick={() => setRange(r.id)} style={{
              padding:'7px 14px', borderRadius:99,
              border:`1.5px solid ${active ? 'var(--acc)' : 'var(--bdr2)'}`,
              background: active ? 'var(--acc-d)' : 'var(--bg2)',
              color: active ? 'var(--acc)' : 'var(--t3)',
              fontSize:12, fontWeight:700, whiteSpace:'nowrap', cursor:'pointer', fontFamily:'inherit', flexShrink:0,
            }}>{r.label}</button>
          );
        })}
      </div>

      {/* Search */}
      <div style={{ padding:'4px 12px 8px' }}>
        <input
          value={search} onChange={(e) => setSearch(e.target.value)}
          placeholder="Search ref, customer, server, table…"
          style={{
            width:'100%', padding:'10px 12px', borderRadius:10, border:'1px solid var(--bdr2)',
            background:'var(--bg2)', color:'var(--t1)', fontSize:13, fontFamily:'inherit', outline:'none', boxSizing:'border-box',
          }}/>
      </div>

      {/* List */}
      <div style={Sx.scroller}>
        {filtered.length === 0 ? (
          <div style={Sx.emptyBlock}>
            <div style={{ fontSize:36, marginBottom:8, opacity:.3 }}>🧾</div>
            <div style={{ fontSize:14, color:'var(--t3)', fontWeight:700, marginBottom:4 }}>No closed orders match</div>
            <div style={{ fontSize:12 }}>Try a wider date range or clear the search.</div>
          </div>
        ) : (
          <div style={{ padding:'4px 12px 32px' }}>
            {filtered.map(c => <Row key={c.id} check={c} onClick={() => onOpen?.(c)} />)}
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, red }) {
  return (
    <div style={{ background:'var(--bg2)', border:'1px solid var(--bdr)', borderRadius:11, padding:'10px 8px', textAlign:'center' }}>
      <div style={{ fontSize:14, fontWeight:800, color: red ? 'var(--red)' : 'var(--t1)', fontFamily:'var(--font-mono)' }}>{value}</div>
      <div style={{ fontSize:10, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.06em', fontWeight:700, marginTop:2 }}>{label}</div>
    </div>
  );
}

function Row({ check, onClick }) {
  const refundedAmount = (check.refunds || []).reduce((s, r) => s + (Number(r.amount) || 0), 0);
  const status = check.status || 'paid';
  const pill = STATUS_PILL[status] || STATUS_PILL.paid;
  const customerName = typeof check.customer === 'string' ? check.customer : (check.customer?.name || '');
  return (
    <button onClick={onClick} style={{
      width:'100%', padding:'12px 14px', background:'var(--bg2)', borderRadius:12,
      border:`1px solid ${refundedAmount > 0 ? 'var(--red-b)' : 'var(--bdr)'}`,
      marginBottom:8, display:'flex', gap:10, alignItems:'flex-start',
      cursor:'pointer', fontFamily:'inherit', textAlign:'left',
    }}>
      <div style={{ flex:1, minWidth:0 }}>
        <div style={{ display:'flex', alignItems:'baseline', gap:6, flexWrap:'wrap', marginBottom:2 }}>
          <span style={{ fontSize:13, fontWeight:800, color:'var(--t1)', fontFamily:'var(--font-mono)' }}>{check.ref || check.id?.slice(0,6)}</span>
          {check.tableLabel && (
            <span style={{ fontSize:11, color:'var(--t3)' }}>· {check.tableLabel}</span>
          )}
          <span style={{ ...Sx.pill, background: pill.bg, color: pill.fg, border:`1px solid ${pill.border}` }}>
            {status === 'refunded' ? 'Refunded' : status === 'partial_refund' ? 'Partial refund' : pill.label}
          </span>
        </div>
        <div style={{ fontSize:11, color:'var(--t3)', display:'flex', gap:10, flexWrap:'wrap' }}>
          {customerName && <span>👤 {customerName}</span>}
          {check.server && <span>🧑 {check.server}</span>}
          <span>{(check.items || []).length} item{(check.items || []).length === 1 ? '' : 's'}</span>
          <span>⏱ {elapsed(check.closedAt) || '—'} ago</span>
        </div>
        {refundedAmount > 0 && (
          <div style={{ fontSize:11, color:'var(--red)', fontWeight:700, marginTop:4 }}>
            {money(refundedAmount)} refunded
          </div>
        )}
      </div>
      <div style={{ textAlign:'right', flexShrink:0 }}>
        <div style={{ fontSize:14, fontWeight:800, color:'var(--acc)', fontFamily:'var(--font-mono)' }}>{money(check.total)}</div>
        {check.tip > 0 && (
          <div style={{ fontSize:10, color:'var(--t4)', fontFamily:'var(--font-mono)' }}>+ {money(check.tip)} tip</div>
        )}
      </div>
    </button>
  );
}
