// v4.6.15: Payments report.
// Breaks down revenue by payment method (cash / card / Apple Pay / Google Pay / split / other)
// and gives a cash reconciliation helper for end-of-day close.

import { useMemo } from 'react';
import { StatTile, ExportBtn, EmptyState, BarRow } from './_charts';
import { toCsv, downloadCsv } from './_csv';

// Normalise the check.method string into a canonical bucket.
// The check writer currently uses 'cash', 'card', 'stripe' and may include
// 'apple-pay' / 'google-pay' / 'split' for future Stripe Terminal integration.
function bucket(method) {
  const m = (method || '').toLowerCase();
  if (m === 'cash') return 'cash';
  if (m.includes('apple'))  return 'apple-pay';
  if (m.includes('google')) return 'google-pay';
  if (m.includes('split'))  return 'split';
  if (m === 'card' || m.includes('stripe') || m.includes('terminal') || m.includes('contactless') || m.includes('chip')) return 'card';
  return m || 'other';
}

const METHOD_STYLE = {
  'cash':       { color:'var(--grn)', label:'Cash',          icon:'💵' },
  'card':       { color:'#3b82f6',    label:'Card',          icon:'💳' },
  'apple-pay':  { color:'#a1a1aa',    label:'Apple Pay',     icon:''       },
  'google-pay': { color:'#4ade80',    label:'Google Pay',    icon:'G'            },
  'split':      { color:'var(--acc)', label:'Split payment', icon:'⎘'       },
  'other':      { color:'var(--t3)',  label:'Other',         icon:'?'            },
};

export default function Payments({ checks, fmt, fmtN }) {
  const breakdown = useMemo(() => {
    const map = {};
    let total = 0;
    (checks || []).filter(c => c.status !== 'voided').forEach(c => {
      const b = bucket(c.method);
      if (!map[b]) map[b] = { method:b, revenue:0, count:0, tips:0 };
      map[b].revenue += c.total || 0;
      map[b].count   += 1;
      map[b].tips    += c.tip   || 0;
      total          += c.total || 0;
    });
    return { rows: Object.values(map).sort((a, b) => b.revenue - a.revenue), total };
  }, [checks]);

  const cashRow        = breakdown.rows.find(r => r.method === 'cash');
  const cashRevenue    = cashRow?.revenue || 0;
  const nonCashRevenue = breakdown.total - cashRevenue;
  const checkCount     = breakdown.rows.reduce((s, r) => s + r.count, 0);

  const onExport = () => {
    const csv = toCsv(breakdown.rows, [
      { label:'Method',  key: r => (METHOD_STYLE[r.method] || METHOD_STYLE.other).label },
      { label:'Checks',  key:'count' },
      { label:'Revenue', key: r => r.revenue.toFixed(2) },
      { label:'Tips',    key: r => r.tips.toFixed(2) },
      { label:'Share %', key: r => breakdown.total ? ((r.revenue / breakdown.total) * 100).toFixed(1) : '0.0' },
    ]);
    downloadCsv(`payments-${new Date().toISOString().slice(0,10)}.csv`, csv);
  };

  if (breakdown.total === 0) {
    return <EmptyState icon="💳" message="No payments recorded in this period."/>;
  }

  return (
    <div>
      <div style={{ display:'flex', justifyContent:'flex-end', marginBottom:12 }}><ExportBtn onClick={onExport}/></div>

      <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:10, marginBottom:18 }}>
        <StatTile label="Total collected" value={fmt(breakdown.total)}  sub={`${fmtN(checkCount)} checks`}                                                           color="var(--acc)"/>
        <StatTile label="Cash"            value={fmt(cashRevenue)}      sub={breakdown.total ? `${((cashRevenue/breakdown.total)*100).toFixed(1)}% of total` : null} color="var(--grn)"/>
        <StatTile label="Non-cash"        value={fmt(nonCashRevenue)}   sub={breakdown.total ? `${((nonCashRevenue/breakdown.total)*100).toFixed(1)}% of total` : null} color="#3b82f6"/>
      </div>

      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:14 }}>
        <div style={{ background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:12, padding:'14px 16px' }}>
          <div style={{ fontSize:11, fontWeight:700, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.08em', marginBottom:12 }}>Payment methods</div>
          {breakdown.rows.map(r => {
            const st  = METHOD_STYLE[r.method] || METHOD_STYLE.other;
            const pct = breakdown.total ? (r.revenue / breakdown.total * 100) : 0;
            return (
              <BarRow
                key={r.method}
                label={`${st.icon} ${st.label} · ${r.count} checks`}
                value={r.revenue}
                max={breakdown.total}
                color={st.color}
                format={v => `${fmt(v)} · ${pct.toFixed(0)}%`}
              />
            );
          })}
        </div>

        <div style={{ background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:12, padding:'14px 16px' }}>
          <div style={{ fontSize:11, fontWeight:700, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.08em', marginBottom:12 }}>Cash reconciliation</div>
          {cashRevenue === 0 ? (
            <div style={{ fontSize:13, color:'var(--t4)', padding:'10px 0' }}>No cash payments this period.</div>
          ) : (
            <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
              <Row label="Cash sales"           value={fmt(cashRevenue)}          color="var(--t1)"/>
              <Row label="Cash tips recorded"   value={fmt(cashRow?.tips || 0)}   color="var(--grn)"/>
              <Row label="Checks taking cash"   value={fmtN(cashRow?.count || 0)}/>
              <div style={{ marginTop:10, padding:'10px 12px', background:'var(--bg3)', border:'1px dashed var(--bdr)', borderRadius:8, fontSize:11, color:'var(--t4)', lineHeight:1.7 }}>
                <strong style={{ color:'var(--t2)' }}>End-of-day check:</strong><br/>
                Expected in drawer = <span style={{ color:'var(--t1)' }}>starting float + {fmt(cashRevenue)}</span><br/>
                Count the drawer at close and subtract starting float. The remainder should match cash sales above — any gap is variance.
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({ label, value, color = 'var(--t2)' }) {
  return (
    <div style={{ display:'flex', justifyContent:'space-between', fontSize:13, padding:'4px 0' }}>
      <span style={{ color:'var(--t3)' }}>{label}</span>
      <span style={{ color, fontFamily:'var(--font-mono)', fontWeight:700 }}>{value}</span>
    </div>
  );
}
