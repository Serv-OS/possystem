// v4.6.15: Exceptions report.
// Every void / discount / refund event flattened into one audit trail.
// Columns: type, time, ref+table, reason, staff, amount.
// Plus a by-staff summary so you can spot whose register is leaking.

import { useMemo, useState } from 'react';
import { StatTile, ExportBtn, EmptyState } from './_charts';
import { toCsv, downloadCsv } from './_csv';

// Flatten closed checks into a single event list sorted by time (newest first).
// A single check can produce multiple events (one void + two discounts, for example).
function flattenEvents(checks) {
  const events = [];
  (checks||[]).forEach(c => {
    if (c.status === 'voided') {
      events.push({
        type:'void', amount: c.total || 0, ts: c.closedAt, ref: c.ref || c.id,
        server: c.server || '—', tableLabel: c.tableLabel || c.customer || '—',
        reason: c.voidReason || null, approvedBy: c.voidedBy || null,
      });
    }
    (c.discounts||[]).forEach(d => {
      events.push({
        // v5.5.853: label first — POS manual/auto discounts and channel promos all carry
        // `label` (name was only ever set on channel entries), so the real discount name
        // shows instead of the generic 'Discount'.
        type:'discount', amount: d.amount || d.value || 0, ts: c.closedAt, ref: c.ref || c.id,
        server: c.server || '—', tableLabel: c.tableLabel || c.customer || '—',
        reason: d.label || d.name || d.reason || 'Discount', approvedBy: d.appliedBy || d.by || null,
      });
    });
    (c.refunds||[]).forEach(r => {
      events.push({
        type:'refund', amount: r.amount || 0, ts: r.at || c.closedAt, ref: c.ref || c.id,
        server: c.server || '—', tableLabel: c.tableLabel || c.customer || '—',
        reason: r.reason || 'Refund', approvedBy: r.by || null,
      });
    });
  });
  return events.sort((a, b) => (b.ts || 0) - (a.ts || 0));
}

const TYPE_STYLE = {
  void:     { color:'var(--red)', bg:'var(--red-d)',                 label:'VOID' },
  discount: { color:'var(--acc)', bg:'var(--acc-d)',                 label:'DISC' },
  refund:   { color:'#a78bfa',    bg:'rgba(167,139,250,.1)',         label:'REF'  },
};

export default function Exceptions({ checks, fmt }) {
  const [filter, setFilter] = useState('all');

  const events    = useMemo(() => flattenEvents(checks), [checks]);
  const displayed = events.filter(e => filter === 'all' || e.type === filter);

  const totals = useMemo(() => {
    const sum   = (t) => events.filter(e => e.type === t).reduce((s, e) => s + e.amount, 0);
    const count = (t) => events.filter(e => e.type === t).length;
    return {
      voidAmt:   sum('void'),     voidCount:   count('void'),
      discAmt:   sum('discount'), discCount:   count('discount'),
      refundAmt: sum('refund'),   refundCount: count('refund'),
    };
  }, [events]);

  // Per-server rollup of exception amounts + counts.
  const byServer = useMemo(() => {
    const map = {};
    events.forEach(e => {
      const s = e.server;
      if (!map[s]) map[s] = { server:s, voids:0, discounts:0, refunds:0, voidCount:0, discCount:0, refundCount:0 };
      if (e.type === 'void')     { map[s].voids     += e.amount; map[s].voidCount++;   }
      if (e.type === 'discount') { map[s].discounts += e.amount; map[s].discCount++;   }
      if (e.type === 'refund')   { map[s].refunds   += e.amount; map[s].refundCount++; }
    });
    return Object.values(map).sort((a, b) => (b.voids + b.discounts + b.refunds) - (a.voids + a.discounts + a.refunds));
  }, [events]);

  const onExport = () => {
    const csv = toCsv(
      displayed.map(e => ({ ...e, when: e.ts ? new Date(e.ts).toISOString() : '' })),
      [
        { label:'Time',        key:'when' },
        { label:'Type',        key:'type' },
        { label:'Amount',      key: e => (e.amount || 0).toFixed(2) },
        { label:'Ref',         key:'ref' },
        { label:'Table',       key:'tableLabel' },
        { label:'Server',      key:'server' },
        { label:'Reason',      key:'reason' },
        { label:'Approved by', key:'approvedBy' },
      ]
    );
    downloadCsv(`exceptions-${new Date().toISOString().slice(0,10)}.csv`, csv);
  };

  if (events.length === 0) {
    return <EmptyState icon="🛡" message="No exceptions in this period. Clean shift."/>;
  }

  return (
    <div>
      <div style={{ display:'flex', justifyContent:'flex-end', marginBottom:12 }}><ExportBtn onClick={onExport}/></div>

      <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:10, marginBottom:18 }}>
        <StatTile label={`Voids (${totals.voidCount})`}     value={fmt(totals.voidAmt)}   color="var(--red)"/>
        <StatTile label={`Discounts (${totals.discCount})`} value={fmt(totals.discAmt)}   color="var(--acc)"/>
        <StatTile label={`Refunds (${totals.refundCount})`} value={fmt(totals.refundAmt)} color="#a78bfa"/>
      </div>

      <div style={{ display:'flex', gap:6, marginBottom:14, flexWrap:'wrap' }}>
        {['all','void','discount','refund'].map(f => (
          <button key={f} onClick={() => setFilter(f)} style={{
            padding:'6px 14px', borderRadius:8,
            border:`1px solid ${filter === f ? 'var(--acc-b)' : 'var(--bdr)'}`,
            background: filter === f ? 'var(--acc-d)' : 'var(--bg3)',
            color: filter === f ? 'var(--acc)' : 'var(--t3)',
            fontSize:12, fontWeight:600, cursor:'pointer', fontFamily:'inherit', textTransform:'capitalize',
          }}>{f === 'all' ? 'All' : f + 's'}</button>
        ))}
      </div>

      <div style={{ background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:12, overflow:'hidden', marginBottom:18 }}>
        <div style={{ ...headerRow }}>
          <span>Type</span><span>Time</span><span>Ref · Table</span><span>Reason</span><span>Staff / Approved</span>
          <span style={{ textAlign:'right' }}>Amount</span>
        </div>
        {displayed.length === 0 ? (
          <div style={{ padding:32, textAlign:'center', color:'var(--t4)', fontSize:12 }}>No {filter}s in this period.</div>
        ) : displayed.slice(0, 200).map((e, i) => {
          const st = TYPE_STYLE[e.type];
          return (
            <div key={i} style={{ ...dataRow }}>
              <span style={{ padding:'3px 7px', background:st.bg, border:`1px solid ${st.color}55`, borderRadius:5, fontSize:10, fontWeight:800, color:st.color, fontFamily:'var(--font-mono)', textAlign:'center', alignSelf:'center' }}>{st.label}</span>
              <span style={{ color:'var(--t3)', fontFamily:'var(--font-mono)', fontSize:11 }}>{e.ts ? new Date(e.ts).toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' }) : '—'}</span>
              <span style={{ color:'var(--t2)' }}>{e.ref} · <span style={{ color:'var(--t3)' }}>{e.tableLabel}</span></span>
              <span style={{ color:'var(--t2)' }}>{e.reason || '—'}</span>
              <span style={{ color:'var(--t3)', fontSize:11 }}>{e.server}{e.approvedBy ? ` · by ${e.approvedBy}` : ''}</span>
              <span style={{ textAlign:'right', fontFamily:'var(--font-mono)', fontWeight:700, color:st.color }}>{fmt(e.amount)}</span>
            </div>
          );
        })}
        {displayed.length > 200 && (
          <div style={{ padding:'10px 16px', fontSize:11, color:'var(--t4)', textAlign:'center' }}>
            Showing first 200 of {displayed.length} — export CSV for the full list.
          </div>
        )}
      </div>

      {byServer.length > 0 && (
        <div style={{ background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:12, overflow:'hidden' }}>
          <div style={{ padding:'10px 16px', background:'var(--bg3)', borderBottom:'1px solid var(--bdr)', fontSize:11, fontWeight:700, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.06em' }}>By staff member</div>
          <div style={{ display:'grid', gridTemplateColumns:'1.3fr 1fr 1fr 1fr 1fr', padding:'8px 16px', borderBottom:'1px solid var(--bdr)', fontSize:10, fontWeight:700, color:'var(--t4)', letterSpacing:'.05em', textTransform:'uppercase' }}>
            <span>Staff</span>
            <span style={{ textAlign:'right' }}>Voids</span>
            <span style={{ textAlign:'right' }}>Discounts</span>
            <span style={{ textAlign:'right' }}>Refunds</span>
            <span style={{ textAlign:'right' }}>Total</span>
          </div>
          {byServer.map(s => (
            <div key={s.server} style={{ display:'grid', gridTemplateColumns:'1.3fr 1fr 1fr 1fr 1fr', padding:'10px 16px', borderBottom:'1px solid var(--bdr)', fontSize:12, alignItems:'center' }}>
              <span style={{ color:'var(--t1)', fontWeight:600 }}>{s.server}</span>
              <span style={{ textAlign:'right', color:'var(--red)', fontFamily:'var(--font-mono)', fontWeight:600 }}>{fmt(s.voids)}<span style={{ color:'var(--t4)', marginLeft:6, fontSize:10 }}>×{s.voidCount}</span></span>
              <span style={{ textAlign:'right', color:'var(--acc)', fontFamily:'var(--font-mono)', fontWeight:600 }}>{fmt(s.discounts)}<span style={{ color:'var(--t4)', marginLeft:6, fontSize:10 }}>×{s.discCount}</span></span>
              <span style={{ textAlign:'right', color:'#a78bfa', fontFamily:'var(--font-mono)', fontWeight:600 }}>{fmt(s.refunds)}<span style={{ color:'var(--t4)', marginLeft:6, fontSize:10 }}>×{s.refundCount}</span></span>
              <span style={{ textAlign:'right', color:'var(--t1)', fontFamily:'var(--font-mono)', fontWeight:800 }}>{fmt(s.voids + s.discounts + s.refunds)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const headerRow = {
  display:'grid', gridTemplateColumns:'70px 80px 1fr 1.4fr 1.2fr 120px', padding:'10px 16px', gap:10,
  background:'var(--bg3)', borderBottom:'1px solid var(--bdr)',
  fontSize:10, fontWeight:700, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.06em',
};
const dataRow = {
  display:'grid', gridTemplateColumns:'70px 80px 1fr 1.4fr 1.2fr 120px', padding:'10px 16px', gap:10,
  borderBottom:'1px solid var(--bdr)', fontSize:12, alignItems:'center',
};
