/**
 * reportKit — the shared report-detail design standard.
 *
 * Every report detail screen is the same shell; a report only supplies its
 * content (tabs, KPIs, chips, columns, cell renderers). Implemented once here so
 * the 28 reports can adopt it without each re-inventing a table.
 *
 * Deviations from the design handoff, and why:
 *   • Colours map to the existing theme tokens (var(--acc), --bg1, --t1…) rather
 *     than the handoff's hardcoded light hex, so every report still works in dark
 *     mode. The `servos` skin accent is already the same green.
 *   • Poppins is not imported — the Back Office keeps its own typeface, as the
 *     handoff allows ("only the weights and sizes matter").
 *
 * Cell renderer vocabulary: Money · Signed · Tag · BarCell · RankChip · GradedChip.
 */

import { useState, useMemo } from 'react';
import { money } from '../../../lib/currency';

/* ── Grading (GP% and similar rate metrics) ──────────────────────────────────
   ≥60 good · 40–59.9 mid · <40 bad. Amber for "thin", never red-vs-green alone. */
export const gradeOf = (pct) => (pct == null ? 'none' : pct >= 60 ? 'good' : pct >= 40 ? 'mid' : 'bad');
export const GRADE_TEXT = { good:'var(--grn)', mid:'var(--amber, #F5A623)', bad:'var(--red)', none:'var(--t4)' };
export const GRADE_BAR  = { good:'var(--grn)', mid:'var(--amber, #F5A623)', bad:'var(--red)', none:'var(--bdr2)' };

/* ── Cell renderers ─────────────────────────────────────────────────────────*/
const numSt = { fontVariantNumeric:'tabular-nums' };

export function Money({ v, bold, muted }) {
  if (v == null) return <span style={{ color:'var(--t4)' }}>—</span>;
  const neg = Number(v) < 0;
  return (
    <span style={{ ...numSt, fontWeight: bold ? 700 : 500,
      color: neg ? 'var(--red)' : muted ? 'var(--t3)' : 'var(--t1)' }}>
      {money(v)}
    </span>
  );
}

export function Signed({ v, unit }) {
  const n = Number(v) || 0;
  const c = n > 0 ? 'var(--grn)' : n < 0 ? 'var(--red)' : 'var(--t4)';
  return <span style={{ ...numSt, fontWeight:600, color:c }}>{n > 0 ? '+' : ''}{n.toLocaleString(undefined,{maximumFractionDigits:2})}{unit ? ` ${unit}` : ''}</span>;
}

export function Tag({ label, tone = 'neutral' }) {
  const tones = {
    neutral: { bg:'var(--bg3)',  fg:'var(--t3)' },
    good:    { bg:'var(--grn-d, var(--acc-d))', fg:'var(--grn)' },
    warn:    { bg:'color-mix(in srgb, var(--amber, #F5A623) 15%, transparent)', fg:'var(--amber, #F5A623)' },
    bad:     { bg:'var(--red-d)', fg:'var(--red)' },
  };
  const t = tones[tone] || tones.neutral;
  return (
    <span style={{ display:'inline-block', background:t.bg, color:t.fg, border:'1px solid var(--bdr)',
      borderRadius:7, padding:'2px 8px', fontSize:11, fontWeight:600, whiteSpace:'nowrap' }}>{label}</span>
  );
}

/** Value with a thin proportional bar beneath — magnitude (accent) or graded rate. */
export function BarCell({ v, max, text, grade, show = true }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (Math.abs(Number(v) || 0) / max) * 100)) : 0;
  const fill = grade ? GRADE_BAR[grade] : 'var(--acc)';
  return (
    <div style={{ display:'flex', flexDirection:'column', alignItems:'flex-end', gap:5 }}>
      <span style={{ ...numSt, fontWeight:600, color: grade ? GRADE_TEXT[grade] : 'var(--t1)' }}>{text}</span>
      {show && pct > 0 && (
        <span style={{ width:'100%', height:4, borderRadius:999, background:'var(--bg3)', overflow:'hidden' }}>
          <span style={{ display:'block', width:`${pct}%`, height:'100%', background:fill, borderRadius:999 }}/>
        </span>
      )}
    </div>
  );
}

export function RankChip({ n }) {
  if (n == null) return <span style={{ color:'var(--t4)' }}>–</span>;
  const top = n === 1;
  return (
    <span style={{ width:24, height:24, borderRadius:7, display:'inline-flex', alignItems:'center', justifyContent:'center',
      fontSize:11.5, fontWeight:800, background: top ? 'var(--acc)' : 'var(--bg3)', color: top ? '#0b0c10' : 'var(--t3)' }}>{n}</span>
  );
}

export function GradedChip({ pct }) {
  if (pct == null) return <span style={{ color:'var(--t4)' }}>—</span>;
  const g = gradeOf(pct);
  return (
    <span style={{ ...numSt, display:'inline-block', borderRadius:999, padding:'2px 9px', fontSize:11.5, fontWeight:700,
      color:GRADE_TEXT[g], background:`color-mix(in srgb, ${GRADE_TEXT[g]} 14%, transparent)` }}>{pct.toFixed(1)}%</span>
  );
}

/* ── Chrome ─────────────────────────────────────────────────────────────────*/
export function KpiBand({ items }) {
  if (!items?.length) return null;
  return (
    <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(212px, 1fr))', gap:12, marginBottom:16 }}>
      {items.map((k,i) => (
        <div key={i} style={{ background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:15, padding:'15px 17px' }}>
          <div style={{ fontSize:12, color:'var(--t3)', marginBottom:6 }}>{k.label}</div>
          <div style={{ fontSize:25, fontWeight:600, letterSpacing:'-.5px',
            color: k.tone === 'warn' ? 'var(--amber, #F5A623)' : k.tone === 'bad' ? 'var(--red)' : k.tone === 'good' ? 'var(--grn)' : 'var(--t1)' }}>
            {k.value}
          </div>
          {k.sub && <div style={{ fontSize:12, color:'var(--t4)', marginTop:3 }}>{k.sub}</div>}
        </div>
      ))}
    </div>
  );
}

export function Callout({ children }) {
  return (
    <div style={{ background:'var(--bg1)', border:'1px solid var(--bdr)', borderLeft:'3px solid var(--acc)',
      borderRadius:12, padding:'12px 15px', marginBottom:16, fontSize:13, lineHeight:1.5, color:'var(--t3)' }}>
      {children}
    </div>
  );
}

export function Chips({ value, onChange, options }) {
  return (
    <div style={{ display:'flex', gap:6, flexWrap:'wrap' }}>
      {options.map(o => {
        const on = value === o.id;
        return (
          <button key={o.id} onClick={()=>onChange(o.id)} style={{
            padding:'5px 11px', borderRadius:9, cursor:'pointer', fontFamily:'inherit', fontSize:12,
            fontWeight: on ? 600 : 500,
            border:`1px solid ${on ? 'transparent' : 'var(--bdr)'}`,
            background: on ? 'var(--acc-d)' : 'var(--bg1)',
            color: on ? 'var(--acc)' : 'var(--t3)',
          }}>{o.label}</button>
        );
      })}
    </div>
  );
}

export function SegToggle({ value, onChange, options }) {
  return (
    <div style={{ display:'flex', background:'var(--bg3)', borderRadius:10, padding:3, flexShrink:0 }}>
      {options.map(o => {
        const on = value === o.id;
        return (
          <button key={o.id} onClick={()=>onChange(o.id)} style={{
            border:'none', borderRadius:7, padding:'5px 12px', fontSize:12, cursor:'pointer', fontFamily:'inherit',
            background: on ? 'var(--bg1)' : 'transparent', color: on ? 'var(--acc)' : 'var(--t3)',
            fontWeight: on ? 700 : 500, boxShadow: on ? '0 1px 2px rgba(0,0,0,.18)' : 'none',
          }}>{o.label}</button>
        );
      })}
    </div>
  );
}

export function SearchField({ value, onChange, placeholder = 'Search…', width = 240 }) {
  return (
    <div style={{ position:'relative', width, flexShrink:0 }}>
      <span style={{ position:'absolute', left:11, top:'50%', transform:'translateY(-50%)', fontSize:12, color:'var(--t4)', pointerEvents:'none' }}>🔍</span>
      <input value={value} onChange={e=>onChange(e.target.value)} placeholder={placeholder} aria-label={placeholder}
        style={{ width:'100%', height:38, borderRadius:11, border:'1.5px solid var(--bdr2)', background:'var(--bg1)',
          color:'var(--t1)', fontFamily:'inherit', fontSize:13, padding:'0 12px 0 32px', outline:'none' }}
        onFocus={e=>{ e.target.style.borderColor='var(--acc)'; e.target.style.boxShadow='0 0 0 3px var(--acc-d)'; }}
        onBlur={e=>{ e.target.style.borderColor='var(--bdr2)'; e.target.style.boxShadow='none'; }}/>
    </div>
  );
}

/** From/To period pill. Only render it on tabs the period genuinely filters. */
export function PeriodControl({ from, to, setFrom, setTo }) {
  const d = { border:'none', background:'transparent', color:'var(--t1)', fontFamily:'inherit', fontSize:12.5, outline:'none', cursor:'pointer' };
  return (
    <div style={{ display:'inline-flex', alignItems:'center', gap:8, background:'var(--bg1)', border:'1px solid var(--bdr2)',
      borderRadius:12, padding:'7px 12px' }}>
      <span style={{ fontSize:11.5, color:'var(--t4)' }}>From</span>
      <input type="date" value={from} onChange={e=>setFrom(e.target.value)} style={d}/>
      <span style={{ width:1, height:16, background:'var(--bdr)' }}/>
      <span style={{ fontSize:11.5, color:'var(--t4)' }}>to</span>
      <input type="date" value={to} onChange={e=>setTo(e.target.value)} style={d}/>
    </div>
  );
}

/**
 * Standard page header: eyebrow (section) + title + subtitle, with room for a
 * toolbar on the right. Shared so every Back Office screen introduces itself the
 * same way instead of each inventing its own H1.
 */
export function PageHeader({ eyebrow, title, subtitle, children }) {
  return (
    <div style={{ display:'flex', alignItems:'flex-start', gap:16, flexWrap:'wrap', marginBottom:16 }}>
      <div style={{ flex:1, minWidth:240 }}>
        {eyebrow && <div style={{ fontSize:11, fontWeight:700, letterSpacing:'1.2px', color:'var(--t4)' }}>{eyebrow}</div>}
        <h1 style={{ fontSize:28, fontWeight:700, letterSpacing:'-.7px', margin:'5px 0 4px', color:'var(--t1)' }}>{title}</h1>
        {subtitle && <p style={{ margin:0, fontSize:13.5, color:'var(--t3)' }}>{subtitle}</p>}
      </div>
      {children && <div style={{ display:'flex', alignItems:'center', gap:10, flexWrap:'wrap' }}>{children}</div>}
    </div>
  );
}

/** Primary action button, matching the standard's weight and radius. */
export function PrimaryBtn({ onClick, children, disabled }) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      border:'none', borderRadius:12, padding:'9px 16px', background:'var(--acc)', color:'#0b0c10',
      fontFamily:'inherit', fontSize:13, fontWeight:700, cursor: disabled ? 'default' : 'pointer',
      opacity: disabled ? .5 : 1, flexShrink:0,
    }}>{children}</button>
  );
}

export function Tabs({ value, onChange, options }) {
  return (
    <div style={{ display:'flex', gap:4, borderBottom:'1px solid var(--bdr)', marginBottom:18, overflowX:'auto' }}>
      {options.map(o => {
        const on = value === o;
        return (
          <button key={o} onClick={()=>onChange(o)} style={{
            padding:'9px 14px', fontSize:14.5, cursor:'pointer', background:'transparent', border:'none',
            color: on ? 'var(--t1)' : 'var(--t3)', fontWeight: on ? 600 : 500, whiteSpace:'nowrap',
            borderBottom:`2.5px solid ${on ? 'var(--acc)' : 'transparent'}`, marginBottom:-1,
          }}>{o}</button>
        );
      })}
    </div>
  );
}

/* ── Table ──────────────────────────────────────────────────────────────────*/
/**
 * columns: [{ key, label, align?, sortable?, width?, render(row) }]
 * rows:    array of row objects (may include { _group:true, label, meta, value })
 * totals:  optional [{ colKey, node }] rendered as a totals row
 */
export function ReportTable({ columns, rows, sort, onSort, totals, empty = 'Nothing to show' }) {
  const th = { fontSize:11.5, fontWeight:600, color:'var(--t3)', padding:'12px 18px',
    borderBottom:'1px solid var(--bdr)', textAlign:'left', whiteSpace:'nowrap', background:'var(--bg2)' };
  const td = { padding:'14px 18px', fontSize:13, borderBottom:'1px solid var(--bdr)', color:'var(--t2)' };

  return (
    <div style={{ background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:16, overflow:'hidden' }}>
      <div style={{ overflowX:'auto' }}>
        <table style={{ width:'100%', borderCollapse:'collapse' }}>
          <thead>
            <tr>
              {columns.map(c => (
                <th key={c.key} onClick={c.sortable ? ()=>onSort(c.key) : undefined}
                  style={{ ...th, textAlign:c.align||'left', width:c.width,
                    cursor:c.sortable?'pointer':'default', userSelect:'none' }}>
                  {c.label}
                  {sort?.key === c.key && <span style={{ marginLeft:5, color:'var(--acc)' }}>{sort.dir === 'asc' ? '↑' : '↓'}</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={columns.length} style={{ ...td, textAlign:'center', color:'var(--t4)', padding:'40px 18px' }}>{empty}</td></tr>
            )}
            {rows.map((r, i) => r._group ? (
              <tr key={`g${i}`}>
                <td colSpan={columns.length} style={{ ...td, background:'var(--bg2)', fontWeight:700, color:'var(--t1)' }}>
                  <span style={{ display:'flex', alignItems:'center', gap:10 }}>
                    <span>{r.label}</span>
                    {r.meta && <span style={{ fontSize:11.5, fontWeight:500, color:'var(--t4)' }}>{r.meta}</span>}
                    {r.value != null && <span style={{ marginLeft:'auto', ...numSt }}>{r.value}</span>}
                  </span>
                </td>
              </tr>
            ) : (
              <tr key={r.id ?? i}
                onMouseEnter={e=>{ e.currentTarget.style.background='var(--bg2)'; }}
                onMouseLeave={e=>{ e.currentTarget.style.background='transparent'; }}
                style={{ transition:'background .1s' }}>
                {columns.map(c => (
                  <td key={c.key} style={{ ...td, textAlign:c.align||'left' }}>{c.render(r)}</td>
                ))}
              </tr>
            ))}
            {totals && (
              <tr style={{ background:'var(--bg2)' }}>
                {columns.map((c, ci) => (
                  <td key={c.key} style={{ ...td, borderBottom:'none', borderTop:'1px solid var(--bdr2)',
                    fontWeight:700, color:'var(--t1)', textAlign:c.align||'left' }}>
                    {totals[c.key] ?? (ci === 0 ? 'Total' : '')}
                  </td>
                ))}
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Shared sort state + comparator. Numbers default desc, text asc. */
export function useSort(initialKey, initialDir = 'desc') {
  const [sort, setSort] = useState({ key: initialKey, dir: initialDir });
  const onSort = (key) => setSort(s => s.key === key
    ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' }
    : { key, dir: typeof key === 'string' && key.startsWith('_t') ? 'asc' : 'desc' });
  return [sort, onSort, setSort];
}

export function sortRows(rows, sort, accessors) {
  if (!sort?.key) return rows;
  const get = accessors[sort.key];
  if (!get) return rows;
  const dir = sort.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = get(a), bv = get(b);
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === 'string' || typeof bv === 'string') return String(av).localeCompare(String(bv)) * dir;
    return (av - bv) * dir;
  });
}

/** Sub-toolbar: count · chips · (spacer) · toggle · search */
export function SubToolbar({ count, children }) {
  return (
    <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:12, flexWrap:'wrap' }}>
      {count != null && <span style={{ fontSize:12.5, color:'var(--t3)' }}>{count}</span>}
      {children}
    </div>
  );
}
