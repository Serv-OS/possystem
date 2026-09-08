// v4.6.15: Shared report UI primitives. Pure SVG/HTML, no dependencies.
// Used by SalesSummary, Exceptions, Payments, Daypart and anything downstream.

import { Fragment } from 'react';
import { currencySymbol } from '../../../lib/currency';

// Period-over-period delta chip. Inverted=true when a decrease is the good outcome
// (e.g. void rate, discount leakage) — the chip flips red/green accordingly.
export function CompareChip({ pct, inverted = false }) {
  if (pct === null || pct === undefined || !isFinite(pct)) {
    return <span style={{ fontSize:10, color:'var(--t4)', fontFamily:'var(--font-mono)' }}>no prior data</span>;
  }
  const good  = inverted ? pct < 0 : pct > 0;
  const bad   = inverted ? pct > 0 : pct < 0;
  const color = good ? 'var(--grn)' : bad ? 'var(--red)' : 'var(--t4)';
  const bg    = good ? 'var(--grn-d)' : bad ? 'var(--red-d)' : 'var(--bg3)';
  const sign  = pct > 0 ? '+' : '';
  return (
    <span style={{ display:'inline-block', padding:'2px 7px', background:bg, border:`1px solid ${color}55`, borderRadius:6, fontSize:11, color, fontFamily:'var(--font-mono)', fontWeight:600, lineHeight:1.3 }}>
      {sign}{pct.toFixed(1)}%
    </span>
  );
}

// Single metric tile with optional compare chip and sub-label.
export function StatTile({ label, value, sub, compare, inverted, color = 'var(--t1)' }) {
  return (
    <div style={{ padding:'14px 16px', background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:12 }}>
      <div style={{ fontSize:10, fontWeight:700, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.08em', marginBottom:6 }}>{label}</div>
      <div style={{ fontSize:22, fontWeight:800, color, fontFamily:'var(--font-mono)', letterSpacing:'-.02em', lineHeight:1.1 }}>{value}</div>
      {(compare !== undefined || sub) && (
        <div style={{ marginTop:6, display:'flex', alignItems:'center', gap:6, flexWrap:'wrap' }}>
          {compare !== undefined && <CompareChip pct={compare} inverted={inverted}/>}
          {sub && <span style={{ fontSize:11, color:'var(--t4)', fontFamily:'var(--font-mono)' }}>{sub}</span>}
        </div>
      )}
    </div>
  );
}

// Horizontal bar row with label + value + progress.
export function BarRow({ label, value, max, format, color = 'var(--acc)' }) {
  const pct = max > 0 ? (value / max) * 100 : 0;
  return (
    <div style={{ marginBottom:10 }}>
      <div style={{ display:'flex', justifyContent:'space-between', marginBottom:4, alignItems:'baseline', gap:8 }}>
        <span style={{ fontSize:12, color:'var(--t2)', flex:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{label}</span>
        <span style={{ fontSize:12, fontWeight:700, color, fontFamily:'var(--font-mono)' }}>{format ? format(value) : value}</span>
      </div>
      <div style={{ height:5, background:'var(--bg3)', borderRadius:3, overflow:'hidden' }}>
        <div style={{ height:'100%', width:`${Math.min(pct, 100)}%`, background:color, borderRadius:3, transition:'width .4s' }}/>
      </div>
    </div>
  );
}

// Standard CSV export button, right-aligned in report headers.
export function ExportBtn({ onClick, label = 'Export CSV' }) {
  return (
    <button onClick={onClick} style={{
      padding:'6px 14px', borderRadius:8, border:'1px solid var(--bdr)', background:'var(--bg3)',
      color:'var(--t2)', fontSize:12, fontWeight:700, cursor:'pointer', fontFamily:'inherit',
    }}>⬇ {label}</button>
  );
}

export function EmptyState({ icon = '📊', message }) {
  return (
    <div style={{ textAlign:'center', padding:'48px 0', color:'var(--t4)', fontSize:13 }}>
      <div style={{ fontSize:36, marginBottom:10 }}>{icon}</div>
      {message}
    </div>
  );
}

// Heatmap: 7 rows (Mon–Sun) × 24 cols (hours). grid[dowIdx][hourIdx] = numeric value.
export function Heatmap({ grid, formatCell }) {
  const dow = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  const max = Math.max(1, ...grid.flat());
  return (
    <div style={{ fontSize:10, fontFamily:'var(--font-mono)', overflowX:'auto' }}>
      <div style={{ display:'grid', gridTemplateColumns:'40px repeat(24, minmax(20px, 1fr))', gap:2, minWidth:680 }}>
        <div/>
        {Array.from({ length:24 }, (_, h) => (
          <div key={h} style={{ textAlign:'center', color:'var(--t4)', fontSize:9, lineHeight:1.2 }}>{h}</div>
        ))}
        {dow.map((dl, dIdx) => (
          <Fragment key={dl}>
            <div style={{ color:'var(--t3)', fontWeight:600, alignSelf:'center', fontSize:10 }}>{dl}</div>
            {Array.from({ length:24 }, (_, h) => {
              const v = grid[dIdx][h];
              const intensity = v / max;
              const bg = v === 0 ? 'var(--bg3)' : `rgba(232, 160, 32, ${0.15 + intensity * 0.75})`;
              return (
                <div
                  key={`${dl}-${h}`}
                  title={`${dl} ${h}:00 — ${formatCell ? formatCell(v) : v}`}
                  style={{ height:20, borderRadius:3, background:bg }}
                />
              );
            })}
          </Fragment>
        ))}
      </div>
      <div style={{ marginTop:14, display:'flex', alignItems:'center', gap:8, fontSize:10, color:'var(--t4)' }}>
        <span>Less</span>
        {[0.15, 0.35, 0.55, 0.75, 0.9].map(a => (
          <div key={a} style={{ width:14, height:14, borderRadius:3, background:`rgba(232,160,32, ${a})` }}/>
        ))}
        <span>More</span>
      </div>
    </div>
  );
}

// 24-bucket vertical bar chart (used for hourly breakdowns).
export function HourBar({ values, maxLabel, nowHour, currency = true }) {
  const max = Math.max(1, ...values);
  return (
    <div style={{ display:'flex', alignItems:'flex-end', gap:3, height:140 }}>
      {values.map((val, h) => {
        const pct = (val / max) * 100;
        const isNow = nowHour === h;
        return (
          <div key={h} style={{ flex:1, display:'flex', flexDirection:'column', alignItems:'center', gap:3 }}>
            <div style={{ fontSize:9, color:'var(--t4)', fontFamily:'var(--font-mono)' }}>
              {val > 0 ? (maxLabel ? maxLabel(val) : (currency ? `${currencySymbol()}${Math.round(val)}` : Math.round(val))) : ''}
            </div>
            <div style={{
              width:'100%',
              background: isNow ? 'var(--acc)' : val > 0 ? 'var(--acc-d)' : 'var(--bg3)',
              borderRadius:'3px 3px 0 0',
              transition:'height .3s',
              height:`${Math.max(pct, val > 0 ? 4 : 0)}%`,
              border: isNow ? '1px solid var(--acc-b)' : '1px solid var(--bdr)',
            }}/>
            <div style={{ fontSize:8, color: isNow ? 'var(--acc)' : 'var(--t4)', fontWeight: isNow ? 700 : 400 }}>{h}</div>
          </div>
        );
      })}
    </div>
  );
}
