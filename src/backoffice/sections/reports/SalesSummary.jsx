// v4.6.15: Sales Summary report.
// Replaces the legacy "Overview" tab.
// Shows: 4 headline tiles with period-over-period compare chips,
// a revenue breakdown ladder (gross → discounts/voids/refunds → net → tax/service/tips → total),
// and an exceptions snapshot for quick visibility.
//
// v4.6.25: When locationConfig.shifts is defined, a service-period breakdown
// (Breakfast / Lunch / Dinner) sits between the headline tiles and the revenue
// ladder so Peter's service periods are visible at a glance.

import { useMemo } from 'react';
import { StatTile, ExportBtn, EmptyState } from './_charts';
import { pctDelta, classifyShift } from './_filters';
import { toCsv, downloadCsv } from './_csv';

// Compute the headline statistics from a list of closed checks.
// Tax prefers the stored tax_amount column (v4.6.19) when present, and falls back
// to the derived (total - subtotal - service - tip) formula for pre-migration rows
// or rows closed without taxRates configured.
export function computeSalesStats(checks) {
  let gross=0, discounts=0, refunds=0, voids=0, service=0, tips=0, taxTotal=0, total=0, covers=0, count=0;
  let taxStored=0, taxDerived=0;  // diagnostic split
  let deliveryFees=0;             // v5.5.853: customer-facing delivery charges (POS/online/catering + channel)
  (checks||[]).forEach(c => {
    const sub = c.subtotal || 0;
    const tip = c.tip || 0;
    const svc = c.service || 0;
    const tot = c.total || 0;
    let tax;
    if (c.taxAmount != null) { tax = c.taxAmount; taxStored += tax; }
    else                     { tax = Math.max(0, tot - sub - svc - tip); taxDerived += tax; }
    const dDiscounts = (c.discounts||[]).reduce((s,d) => s + (d.amount || d.value || 0), 0);
    const dRefunds   = (c.refunds  ||[]).reduce((s,r) => s + (r.amount || 0), 0);
    gross      += sub;
    discounts  += dDiscounts;
    refunds    += dRefunds;
    if (c.status === 'voided') voids += tot;
    service    += svc;
    tips       += tip;
    deliveryFees += Number(c.customer?.delivery_fee ?? c.deliveryFee) || 0;
    taxTotal   += tax;
    total      += tot;
    if (c.status !== 'voided') { covers += c.covers || 1; count += 1; }
  });
  const net = gross - discounts - voids - refunds;
  return { gross, discounts, voids, refunds, service, tips, deliveryFees, tax: taxTotal, taxStored, taxDerived, total, covers, count, net };
}

export default function SalesSummary({ checks, prevChecks, fmt, fmtN, locationConfig }) {
  const cur  = useMemo(() => computeSalesStats(checks),     [checks]);
  const prev = useMemo(() => computeSalesStats(prevChecks), [prevChecks]);
  const avgCheck     = cur.count  ? cur.net  / cur.count  : 0;
  const prevAvgCheck = prev.count ? prev.net / prev.count : 0;
  const avgCover     = cur.covers  ? cur.net  / cur.covers  : 0;
  const prevAvgCover = prev.covers ? prev.net / prev.covers : 0;

  // v4.6.25: service-period breakdown when shifts are configured.
  const servicePeriods = useMemo(() => {
    const shifts = locationConfig?.shifts || [];
    const bds    = locationConfig?.businessDayStart || '00:00';
    if (!shifts.length) return null;
    const rows = shifts.map(s => ({ shift: s, net: 0, covers: 0, count: 0, tips: 0 }));
    const idx = {};
    rows.forEach((r, i) => { idx[r.shift.id || r.shift.name] = i; });
    let unclassified = { net: 0, covers: 0, count: 0 };
    (checks || []).filter(c => c.status !== 'voided' && c.closedAt).forEach(c => {
      const s = classifyShift(c.closedAt, shifts, bds);
      const net = (c.subtotal || 0) - ((c.discounts||[]).reduce((x,d)=>x+(d.amount||d.value||0),0)) - ((c.refunds||[]).reduce((x,r)=>x+(r.amount||0),0));
      const cov = c.covers || 1;
      const tip = c.tip || 0;
      if (s) {
        const i = idx[s.id || s.name];
        rows[i].net += net; rows[i].covers += cov; rows[i].count += 1; rows[i].tips += tip;
      } else {
        unclassified.net += net; unclassified.covers += cov; unclassified.count += 1;
      }
    });
    const totalClassified = rows.reduce((s, r) => s + r.net, 0);
    return { rows, unclassified, total: totalClassified + unclassified.net };
  }, [checks, locationConfig]);

  const onExport = () => {
    const rows = [
      { metric:'Gross sales',       current: cur.gross,     previous: prev.gross     },
      { metric:'Discounts',         current: cur.discounts, previous: prev.discounts },
      { metric:'Voids',             current: cur.voids,     previous: prev.voids     },
      { metric:'Refunds',           current: cur.refunds,   previous: prev.refunds   },
      { metric:'Net sales',         current: cur.net,       previous: prev.net       },
      { metric:'Tax',                current: cur.tax,       previous: prev.tax       },
      { metric:'Service',           current: cur.service,   previous: prev.service   },
      { metric:'Delivery charges',  current: cur.deliveryFees, previous: prev.deliveryFees },
      { metric:'Tips',              current: cur.tips,      previous: prev.tips      },
      { metric:'Total collected',   current: cur.total,     previous: prev.total     },
      { metric:'Covers',            current: cur.covers,    previous: prev.covers    },
      { metric:'Checks',            current: cur.count,     previous: prev.count     },
      { metric:'Avg check (net)',   current: avgCheck,      previous: prevAvgCheck   },
      { metric:'Avg cover (net)',   current: avgCover,      previous: prevAvgCover   },
    ];
    const csv = toCsv(rows, [
      { label:'Metric',   key:'metric' },
      { label:'Current',  key: r => (r.current  || 0).toFixed(2) },
      { label:'Previous', key: r => (r.previous || 0).toFixed(2) },
      { label:'Change %', key: r => r.previous ? (((r.current - r.previous)/r.previous)*100).toFixed(2) : '' },
    ]);
    downloadCsv(`sales-summary-${new Date().toISOString().slice(0,10)}.csv`, csv);
  };

  if (cur.count === 0 && cur.voids === 0) {
    return <EmptyState icon="📊" message="No sales in this period. Try widening the date range."/>;
  }

  return (
    <div>
      <div style={{ display:'flex', justifyContent:'flex-end', marginBottom:12 }}><ExportBtn onClick={onExport}/></div>

      <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:10, marginBottom:14 }}>
        <StatTile label="Net sales"  value={fmt(cur.net)}      compare={pctDelta(cur.net, prev.net)}         sub={`${cur.count} checks`} color="var(--acc)"/>
        <StatTile label="Covers"     value={fmtN(cur.covers)}  compare={pctDelta(cur.covers, prev.covers)}   sub={`${fmt(avgCover)} / cover`}/>
        <StatTile label="Avg check"  value={fmt(avgCheck)}     compare={pctDelta(avgCheck, prevAvgCheck)}/>
        <StatTile label="Tips"       value={fmt(cur.tips)}     compare={pctDelta(cur.tips, prev.tips)}       sub={cur.net > 0 ? `${((cur.tips/cur.net)*100).toFixed(1)}% of net` : null} color="var(--grn)"/>
      </div>

      {servicePeriods && servicePeriods.rows.length > 0 && (
        <div style={{ background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:12, padding:'14px 16px', marginBottom:12 }}>
          <div style={{ display:'flex', alignItems:'baseline', justifyContent:'space-between', marginBottom:10 }}>
            <div style={{ fontSize:11, fontWeight:700, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.08em' }}>By service period</div>
            <div style={{ fontSize:11, color:'var(--t4)' }}>Configured in Location settings</div>
          </div>
          <div style={{ display:'grid', gridTemplateColumns:`repeat(${Math.min(servicePeriods.rows.length, 4)},1fr)`, gap:10 }}>
            {servicePeriods.rows.map(r => {
              const share = servicePeriods.total > 0 ? (r.net / servicePeriods.total) * 100 : 0;
              const avg   = r.count > 0 ? r.net / r.count : 0;
              return (
                <div key={r.shift.id || r.shift.name} style={{ padding:'12px 14px', background:'var(--bg2)', border:'1px solid var(--bdr)', borderRadius:10 }}>
                  <div style={{ fontSize:10, fontWeight:700, color:'var(--t3)', textTransform:'uppercase', letterSpacing:'.08em', marginBottom:4 }}>{r.shift.name}</div>
                  <div style={{ fontSize:10, color:'var(--t4)', marginBottom:6, fontFamily:'var(--font-mono)' }}>{r.shift.start}–{r.shift.end}</div>
                  <div style={{ fontSize:17, fontWeight:800, color:'var(--t1)', fontFamily:'var(--font-mono)' }}>{fmt(r.net)}</div>
                  <div style={{ fontSize:11, color:'var(--t3)', marginTop:3 }}>{r.count} checks · {r.covers} covers</div>
                  <div style={{ fontSize:11, color:'var(--t4)', marginTop:2 }}>avg {fmt(avg)} · {share.toFixed(0)}%</div>
                </div>
              );
            })}
          </div>
          {servicePeriods.unclassified.count > 0 && (
            <div style={{ fontSize:11, color:'var(--t4)', marginTop:10, paddingTop:8, borderTop:'1px solid var(--bdr)' }}>
              {servicePeriods.unclassified.count} checks ({fmt(servicePeriods.unclassified.net)}) closed outside configured service periods
            </div>
          )}
        </div>
      )}

      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
        <div style={{ background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:12, padding:'14px 16px' }}>
          <div style={{ fontSize:11, fontWeight:700, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.08em', marginBottom:12 }}>Revenue breakdown</div>
          <LadderRow label="Gross sales"         value={fmt(cur.gross)}       prominence="head"/>
          <LadderRow label="less Discounts"      value={fmt(-cur.discounts)}  tone={cur.discounts > 0 ? 'warn' : null}/>
          <LadderRow label="less Voids"          value={fmt(-cur.voids)}      tone={cur.voids     > 0 ? 'bad'  : null}/>
          <LadderRow label="less Refunds"        value={fmt(-cur.refunds)}    tone={cur.refunds   > 0 ? 'bad'  : null}/>
          <LadderRow label="Net sales"           value={fmt(cur.net)}         prominence="sub" border/>
          <LadderRow label="plus Tax"            value={fmt(cur.tax)}/>
          <LadderRow label="plus Service"        value={fmt(cur.service)}/>
          {cur.deliveryFees > 0 && <LadderRow label="plus Delivery charges" value={fmt(cur.deliveryFees)}/>}
          <LadderRow label="plus Tips"           value={fmt(cur.tips)}/>
          <LadderRow label="Total collected"     value={fmt(cur.total)}       prominence="head" tone="good" border/>
        </div>
        <ExceptionsSnapshot cur={cur} fmt={fmt}/>
      </div>
    </div>
  );
}

function LadderRow({ label, value, prominence, tone, border }) {
  const toneColor = { good:'var(--grn)', warn:'var(--acc)', bad:'var(--red)' }[tone] || null;
  const valColor   = toneColor || (prominence === 'head' ? 'var(--t1)' : 'var(--t2)');
  const labelColor = prominence === 'head' ? 'var(--t1)' : 'var(--t3)';
  const weight     = prominence === 'head' ? 800 : prominence === 'sub' ? 700 : 500;
  const indent     = (label.startsWith('less ') || label.startsWith('plus ')) ? 10 : 0;
  return (
    <div style={{
      display:'flex', justifyContent:'space-between', fontSize:13,
      padding: border ? '10px 0 6px' : '6px 0',
      borderTop: border ? '1px solid var(--bdr)' : 'none',
      marginTop: border ? 4 : 0,
    }}>
      <span style={{ color: labelColor, fontWeight: weight, paddingLeft: indent }}>{label}</span>
      <span style={{ color: valColor, fontFamily:'var(--font-mono)', fontWeight: weight }}>{value}</span>
    </div>
  );
}

function ExceptionsSnapshot({ cur, fmt }) {
  const items = [
    { label:'Discounts applied', value: cur.discounts, pct: cur.gross ? (cur.discounts/cur.gross*100) : 0, color:'var(--acc)', bg:'var(--acc-d)' },
    { label:'Voids',             value: cur.voids,     pct: cur.gross ? (cur.voids/cur.gross*100)     : 0, color:'var(--red)', bg:'var(--red-d)' },
    { label:'Refunds',           value: cur.refunds,   pct: cur.gross ? (cur.refunds/cur.gross*100)   : 0, color:'var(--red)', bg:'var(--red-d)' },
  ];
  return (
    <div style={{ background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:12, padding:'14px 16px' }}>
      <div style={{ fontSize:11, fontWeight:700, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.08em', marginBottom:12 }}>Exceptions snapshot</div>
      {items.map(i => (
        <div key={i.label} style={{ display:'flex', alignItems:'center', gap:10, padding:'8px 0' }}>
          <div style={{
            minWidth:72, padding:'5px 8px', background:i.bg, border:`1px solid ${i.color}55`,
            borderRadius:6, textAlign:'center', fontSize:12, fontWeight:800, color:i.color, fontFamily:'var(--font-mono)',
          }}>{fmt(i.value)}</div>
          <div style={{ flex:1, minWidth:0 }}>
            <div style={{ fontSize:13, color:'var(--t1)', fontWeight:500 }}>{i.label}</div>
            <div style={{ fontSize:11, color:'var(--t4)' }}>{i.pct.toFixed(2)}% of gross</div>
          </div>
        </div>
      ))}
      <div style={{ marginTop:10, padding:'9px 12px', background:'var(--bg3)', borderRadius:8, fontSize:11, color:'var(--t4)', lineHeight:1.6 }}>
        ⓘ Open the <strong style={{ color:'var(--t2)' }}>Exceptions</strong> tab to audit every event by server, time and approval.
      </div>
    </div>
  );
}
