// v4.6.15: Exceptions report.
// Every void / discount / refund event flattened into one audit trail.
// Columns: type, time, ref+table, reason, staff, amount.
// Plus a by-staff summary so you can spot whose register is leaking.

import { useMemo, useState } from 'react';
import { StatTile, ExportBtn, EmptyState } from './_charts';
import { toCsv, downloadCsv } from './_csv';
import { plainText, checkCustomerText } from '../../../lib/reportText';
import { voidedValue } from '../../../lib/voidRules';
import { isSplit, sumFields, siteNameKey } from '../../../lib/reportSplit.js';
import { useParts, exportSites, titleSt } from './_siteSplit';
import { SplitHeader, Blocks, SiteRows, SiteCell } from './SiteSplit';

// Flatten closed checks into a single event list sorted by time (newest first).
// A single check can produce multiple events (one void + two discounts, for example).
// 28 Sep 2026: every name goes through plainText. A collection order's customer is an OBJECT
// ({ name, phone, collectionTime, ... }) and printing it crashed the whole report (React #31).
function flattenEvents(checks) {
  const events = [];
  (checks||[]).forEach(c => {
    const server = plainText(c.server) || '—';
    const tableLabel = plainText(c.tableLabel) || checkCustomerText(c.customer) || '—';
    const ref = plainText(c.ref) || plainText(c.id);
    if (c.status === 'voided') {
      // 30 Sep 2026: a void tombstone books total 0 on purpose (no report counts it as a sale),
      // so the voided value comes from its lines (lib/voidRules.js voidedValue).
      events.push({
        type:'void', amount: voidedValue(c), ts: c.closedAt, ref, server, tableLabel,
        reason: plainText(c.voidReason) || null, approvedBy: plainText(c.voidedBy) || null,
      });
    }
    (c.discounts||[]).forEach(d => {
      events.push({
        // v5.5.853: label first — POS manual/auto discounts and channel promos all carry
        // `label` (name was only ever set on channel entries), so the real discount name
        // shows instead of the generic 'Discount'.
        type:'discount', amount: d.amount || d.value || 0, ts: c.closedAt, ref, server, tableLabel,
        reason: plainText(d.label) || plainText(d.name) || plainText(d.reason) || 'Discount',
        approvedBy: plainText(d.appliedBy) || plainText(d.by) || plainText(d.manager) || null,
      });
    });
    (c.refunds||[]).forEach(r => {
      events.push({
        type:'refund', amount: r.amount || 0, ts: r.at || c.closedAt, ref, server, tableLabel,
        reason: plainText(r.reason) || 'Refund', approvedBy: plainText(r.by) || null,
      });
    });
  });
  return events.sort((a, b) => (b.ts || 0) - (a.ts || 0));
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

const TYPE_STYLE = {
  void:     { color:'var(--red)', bg:'var(--red-d)',                 label:'VOID' },
  discount: { color:'var(--acc)', bg:'var(--acc-d)',                 label:'DISC' },
  refund:   { color:'#a78bfa',    bg:'rgba(167,139,250,.1)',         label:'REF'  },
};

// 5 Oct 2026 (Peter: "make every report we have multi site when sites are connected
// together"): with more than one site on screen this is the site split at the foot of the
// file. One site is the report exactly as it was.
export default function Exceptions(props) {
  return isSplit(props.sites) ? <ExceptionsSites {...props}/> : <ExceptionsOne {...props}/>;
}

function ExceptionsOne({ checks, fmt }) {
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


// ─────────────────────────────────────────────────────────────────────────────
// Several sites: each site's voids, discounts and refunds on top (the owner's first
// question: which site is leaking), then one audit trail with a Site column. Times are
// each event's own site's wall clock. Staff are keyed by site plus name, so the same name
// at two sites is two people.
// ─────────────────────────────────────────────────────────────────────────────
const EX_FIELDS = ['voids', 'discounts', 'refunds', 'voidCount', 'discCount', 'refundCount'];
const exHead = { ...headerRow, gridTemplateColumns:'70px 110px 1fr 1fr 1.2fr 1.1fr 110px', minWidth:980 };
const exRow  = { ...dataRow,   gridTemplateColumns:'70px 110px 1fr 1fr 1.2fr 1.1fr 110px', minWidth:980 };
const whenAt = (ts, timeZone) => (ts ? new Date(ts).toLocaleString('en-GB', { day:'numeric', month:'short', hour:'2-digit', minute:'2-digit', timeZone }) : '—');

function ExceptionsSites(props) {
  const [filter, setFilter] = useState('all');
  const { parts, blocks } = useParts(props);
  const bySite = useMemo(() => new Map(parts.map(p => {
    const events = flattenEvents(p.rows).map(e => ({ ...e, part: p, siteName: p.name }));
    const cells = Object.fromEntries(EX_FIELDS.map(f => [f, 0]));
    const staff = {};
    for (const e of events) {
      const s = (staff[e.server] ||= { server: e.server, part: p, siteName: p.name, siteKey: siteNameKey(p.id, e.server), ...Object.fromEntries(EX_FIELDS.map(f => [f, 0])) });
      const [amt, n] = e.type === 'void' ? ['voids', 'voidCount'] : e.type === 'discount' ? ['discounts', 'discCount'] : ['refunds', 'refundCount'];
      cells[amt] += e.amount; cells[n] += 1; s[amt] += e.amount; s[n] += 1;
    }
    return [p.id, { events, staff: Object.values(staff), ...cells }];
  })), [parts]);
  const all = useMemo(() => parts.flatMap(p => bySite.get(p.id).events).sort((a, b) => (b.ts || 0) - (a.ts || 0)), [parts, bySite]);
  const displayed = all.filter(e => filter === 'all' || e.type === filter);

  const onExport = () => {
    exportSites('exceptions', displayed.map(e => ({ ...e, when: e.ts ? new Date(e.ts).toISOString() : '' })), [
      { label:'Currency',    key: e => e.part.currency || '' },
      { label:'Time',        key:'when' },
      { label:'Site time',   key: e => whenAt(e.ts, e.part.clock.timeZone) },
      { label:'Type',        key:'type' },
      { label:'Amount',      key: e => (e.amount || 0).toFixed(2) },
      { label:'Ref',         key:'ref' },
      { label:'Table',       key:'tableLabel' },
      { label:'Server',      key:'server' },
      { label:'Reason',      key:'reason' },
      { label:'Approved by', key:'approvedBy' },
    ]);
  };

  if (all.length === 0) return <EmptyState icon="🛡" message="No exceptions at these sites in this period. Clean shift."/>;

  const amount = (v, n, f) => <>{f(v)}<span style={{ color:'var(--t4)', marginLeft:6, fontSize:10 }}>×{n}</span></>;
  return (
    <div>
      <SplitHeader parts={parts} onExport={onExport}/>
      <Blocks blocks={blocks}>{b => {
        const site = b.parts.map(p => ({ part: p, cells: bySite.get(p.id) }));
        const total = sumFields(site.map(x => x.cells), EX_FIELDS);
        const staff = b.parts.flatMap(p => bySite.get(p.id).staff)
          .sort((x, y) => (y.voids + y.discounts + y.refunds) - (x.voids + x.discounts + x.refunds));
        return (
          <>
            <SiteRows block={b} rows={site} total={total} columns={[
              { label:'Voids',     cell: (c, f) => amount(c.voids, c.voidCount, f),     color:'var(--red)' },
              { label:'Discounts', cell: (c, f) => amount(c.discounts, c.discCount, f), color:'var(--acc)' },
              { label:'Refunds',   cell: (c, f) => amount(c.refunds, c.refundCount, f), color:'#a78bfa' },
              { label:'Total',     cell: (c, f) => f(c.voids + c.discounts + c.refunds), color:'var(--t1)' },
            ]}/>
            {staff.length > 0 && (
              <SiteRows block={{ ...b, parts: [] }} title="By staff member" total={null}
                rows={staff.map(s => ({ part: { id: s.siteKey, name: `${s.server} · ${s.siteName}` }, cells: s }))}
                columns={[
                  { label:'Voids',     cell: (c, f) => amount(c.voids, c.voidCount, f),     color:'var(--red)' },
                  { label:'Discounts', cell: (c, f) => amount(c.discounts, c.discCount, f), color:'var(--acc)' },
                  { label:'Refunds',   cell: (c, f) => amount(c.refunds, c.refundCount, f), color:'#a78bfa' },
                  { label:'Total',     cell: (c, f) => f(c.voids + c.discounts + c.refunds), color:'var(--t1)' },
                ]}/>
            )}
          </>
        );
      }}</Blocks>

      <div style={{ ...titleSt, marginTop:6 }}>Every event</div>
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
      <div style={{ background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:12, overflow:'auto' }}>
        <div style={exHead}>
          <span>Type</span><span>Time</span><span>Site</span><span>Ref · Table</span><span>Reason</span><span>Staff / Approved</span>
          <span style={{ textAlign:'right' }}>Amount</span>
        </div>
        {displayed.length === 0 ? (
          <div style={{ padding:32, textAlign:'center', color:'var(--t4)', fontSize:12 }}>No {filter}s in this period.</div>
        ) : displayed.slice(0, 200).map((e, i) => {
          const st = TYPE_STYLE[e.type];
          return (
            <div key={i} style={exRow}>
              <span style={{ padding:'3px 7px', background:st.bg, border:`1px solid ${st.color}55`, borderRadius:5, fontSize:10, fontWeight:800, color:st.color, fontFamily:'var(--font-mono)', textAlign:'center', alignSelf:'center' }}>{st.label}</span>
              <span style={{ color:'var(--t3)', fontFamily:'var(--font-mono)', fontSize:11 }}>{whenAt(e.ts, e.part.clock.timeZone)}</span>
              <SiteCell name={e.siteName}/>
              <span style={{ color:'var(--t2)' }}>{e.ref} · <span style={{ color:'var(--t3)' }}>{e.tableLabel}</span></span>
              <span style={{ color:'var(--t2)' }}>{e.reason || '—'}</span>
              <span style={{ color:'var(--t3)', fontSize:11 }}>{e.server}{e.approvedBy ? ` · by ${e.approvedBy}` : ''}</span>
              <span style={{ textAlign:'right', fontFamily:'var(--font-mono)', fontWeight:700, color:st.color }}>{e.part.fmt(e.amount)}</span>
            </div>
          );
        })}
        {displayed.length > 200 && (
          <div style={{ padding:'10px 16px', fontSize:11, color:'var(--t4)', textAlign:'center' }}>
            Showing first 200 of {displayed.length}. Export CSV for the full list.
          </div>
        )}
      </div>
    </div>
  );
}
