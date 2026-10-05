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
import { classifyShift } from './_filters';
import { toCsv, downloadCsv } from './_csv';
import { isSplit, sumFields } from '../../../lib/reportSplit.js';
import { useParts, exportSites } from './_siteSplit';
import { SplitHeader, Blocks, GroupChange, SiteChange, SiteMatrix } from './SiteSplit';

// The figures live in lib/salesStats.js (28 Sep 2026) so the till can print them too.
export { computeSalesStats } from '../../../lib/salesStats';
import { computeSalesStats } from '../../../lib/salesStats';

// 5 Oct 2026 (Peter: "make every report we have multi site when sites are connected
// together"): with more than one site on screen this is the site split below. One site is
// the report exactly as it was.
export default function SalesSummary(props) {
  return isSplit(props.sites) ? <SalesSummarySites {...props}/> : <SalesSummaryOne {...props}/>;
}

// compare = the range's compare (the one percent rule, src/lib/reportCompare.js): the chips' words.
function SalesSummaryOne({ checks, prevChecks, fmt, fmtN, locationConfig, compare }) {
  const cur  = useMemo(() => computeSalesStats(checks),     [checks]);
  const prev = useMemo(() => computeSalesStats(prevChecks), [prevChecks]);
  const avgCheck     = cur.count  ? cur.net  / cur.count  : 0;
  const prevAvgCheck = prev.count ? prev.net / prev.count : 0;
  const avgCover     = cur.covers  ? cur.net  / cur.covers  : 0;
  const prevAvgCover = prev.covers ? prev.net / prev.covers : 0;

  // v4.6.25: service-period breakdown when shifts are configured.
  // v5.10.3: which service a check belongs to is read on the venue's clock.
  const servicePeriods = useMemo(() => {
    const shifts = locationConfig?.shifts || [];
    const tz     = locationConfig?.timezone;
    if (!shifts.length) return null;
    const rows = shifts.map(s => ({ shift: s, net: 0, covers: 0, count: 0, tips: 0 }));
    const idx = {};
    rows.forEach((r, i) => { idx[r.shift.id || r.shift.name] = i; });
    let unclassified = { net: 0, covers: 0, count: 0 };
    (checks || []).filter(c => c.status !== 'voided' && c.closedAt).forEach(c => {
      const s = classifyShift(c.closedAt, shifts, tz);
      // v5.6.79 — subtract only the ITEMS portion of each refund from a
      // subtotal-based net, and show tips net of any tip that went back.
      const refItems = (c.refunds||[]).reduce((x,r)=>x+((Number(r.amount)||0)-(Number(r.tipAmount)||0)-(Number(r.serviceAmount)||0)),0);
      const refTip   = (c.refunds||[]).reduce((x,r)=>x+(Number(r.tipAmount)||0),0);
      const net = (c.subtotal || 0) - ((c.discounts||[]).reduce((x,d)=>x+(d.amount||d.value||0),0)) - refItems;
      const cov = c.covers || 1;
      const tip = Math.max(0, (c.tip || 0) - refTip);
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
        <StatTile label="Net sales"  value={fmt(cur.net)}      vs={compare} values={[cur.net, prev.net]} sub={`${cur.count} checks`} color="var(--acc)"/>
        <StatTile label="Covers"     value={fmtN(cur.covers)}  vs={compare} values={[cur.covers, prev.covers]} noun="covers" sub={`${fmt(avgCover)} / cover`}/>
        <StatTile label="Avg check"  value={fmt(avgCheck)}     vs={compare} values={[avgCheck, prevAvgCheck]}/>
        <StatTile label="Tips"       value={fmt(cur.tips)}     vs={compare} values={[cur.tips, prev.tips]} noun="tips" sub={cur.net > 0 ? `${((cur.tips/cur.net)*100).toFixed(1)}% of net` : null} color="var(--grn)"/>
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
          {/* v5.6.79 — the ITEMS portion only. The tip/service portions of a
              refund are netted off the "plus Service" / "plus Tips" lines below,
              so the ladder still adds up to what was actually collected. */}
          <LadderRow label="less Refunds"        value={fmt(-cur.refundsItems)} tone={cur.refundsItems > 0 ? 'bad'  : null}/>
          <LadderRow label="Net sales"           value={fmt(cur.net)}         prominence="sub" border/>
          <LadderRow label="plus Tax"            value={fmt(cur.tax)}/>
          <LadderRow label={cur.refundsService > 0 ? 'plus Service (net of refunds)' : 'plus Service'} value={fmt(cur.service)}/>
          {cur.deliveryFees > 0 && <LadderRow label="plus Delivery charges" value={fmt(cur.deliveryFees)}/>}
          <LadderRow label={cur.refundsTip > 0 ? 'plus Tips (net of refunds)' : 'plus Tips'} value={fmt(cur.tips)}/>
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

// ─────────────────────────────────────────────────────────────────────────────
// Several sites: the group's ladder on top, then a column per site.
// Each site's figures are computeSalesStats over its own rows (the same sums as one site),
// or the server day sums for a long period (stats is the same shape, added by the database).
// ─────────────────────────────────────────────────────────────────────────────
const STAT_FIELDS = ['gross', 'discounts', 'voids', 'refunds', 'refundsItems', 'refundsTip', 'refundsService', 'refundsTax',
  'service', 'tips', 'deliveryFees', 'tax', 'total', 'covers', 'count', 'net'];
const perCheck = (s) => (s.count ? s.net / s.count : 0);
const perCover = (s) => (s.covers ? s.net / s.covers : 0);
// The ladder, top to bottom. The CSV has the same lines.
const SITE_LINES = [
  { label:'Gross sales',      v: s => s.gross,         strong:true },
  { label:'less Discounts',   v: s => -s.discounts },
  { label:'less Voids',       v: s => -s.voids },
  { label:'less Refunds',     v: s => -s.refundsItems },
  { label:'Net sales',        v: s => s.net,           strong:true },
  { label:'plus Tax',         v: s => s.tax },
  { label:'plus Service',     v: s => s.service },
  { label:'plus Delivery charges', v: s => s.deliveryFees },
  { label:'plus Tips',        v: s => s.tips },
  { label:'Total collected',  v: s => s.total,         strong:true },
  { label:'Covers',           v: s => s.covers, kind:'count' },
  { label:'Checks',           v: s => s.count,  kind:'count' },
  { label:'Avg check (net)',  v: perCheck },
  { label:'Avg cover (net)',  v: perCover },
];

function SalesSummarySites(props) {
  const { fmtN } = props;
  const { parts, blocks, fromSums } = useParts(props);
  const stats = useMemo(() => new Map(parts.map(p => [p.id, {
    cur:  p.sums ? p.sums.totals.stats : computeSalesStats(p.rows),
    prev: p.sums ? (p.prevSums?.totals.stats || computeSalesStats([])) : computeSalesStats(p.prevRows),
  }])), [parts]);

  const onExport = () => {
    const rows = [];
    for (const p of parts) {
      const { cur, prev } = stats.get(p.id);
      for (const l of SITE_LINES) rows.push({ siteName: p.name, currency: p.currency || '', metric: l.label.replace(/^(less|plus) /, ''), current: Math.abs(l.v(cur)), previous: Math.abs(l.v(prev)), compared: !!p.compare && p.compare.loaded !== false });
    }
    exportSites('sales-summary', rows, [
      { label:'Currency', key:'currency' },
      { label:'Metric',   key:'metric' },
      { label:'Current',  key: r => (r.current || 0).toFixed(2) },
      { label:'Previous', key: r => (r.compared ? (r.previous || 0).toFixed(2) : '') },
      { label:'Change %', key: r => (r.compared && r.previous ? (((r.current - r.previous) / r.previous) * 100).toFixed(2) : '') },
    ]);
  };

  if (parts.every(p => { const c = stats.get(p.id).cur; return c.count === 0 && c.voids === 0; })) {
    return <EmptyState icon="📊" message="No sales at these sites in this period. Try widening the date range."/>;
  }

  return (
    <div>
      <SplitHeader parts={parts} fromSums={fromSums} onExport={onExport}/>
      <Blocks blocks={blocks}>{b => {
        const all = sumFields(b.parts.map(p => stats.get(p.id).cur), STAT_FIELDS);
        const rows = SITE_LINES.map(l => ({
          key: l.label, kind: l.kind, strong: l.strong, total: l.v(all),
          bySite: Object.fromEntries(b.parts.map(p => [p.id, l.v(stats.get(p.id).cur)])),
        }));
        rows.push({ key:'Net sales change', render: p => <SiteChange part={p} values={[stats.get(p.id).cur.net, stats.get(p.id).prev.net]}/> });
        return (
          <>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:10, marginBottom:14 }}>
              <StatTile label="Net sales" value={b.fmt(all.net)} color="var(--acc)"
                sub={<>{all.count} checks <GroupChange block={b} pairs={b.parts.map(p => ({ current: stats.get(p.id).cur.net, previous: stats.get(p.id).prev.net }))}/></>}/>
              <StatTile label="Covers"    value={fmtN(all.covers)} sub={`${b.fmt(perCover(all))} / cover`}/>
              <StatTile label="Avg check" value={b.fmt(perCheck(all))}/>
              <StatTile label="Tips"      value={b.fmt(all.tips)} sub={all.net > 0 ? `${((all.tips / all.net) * 100).toFixed(1)}% of net` : null} color="var(--grn)"/>
            </div>
            <SiteMatrix block={b} rows={rows} first="Revenue breakdown" fmtN={fmtN}/>
          </>
        );
      }}</Blocks>
    </div>
  );
}
