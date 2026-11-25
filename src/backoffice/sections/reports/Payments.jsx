// v4.6.15: Payments report.
// Money collected by what paid it (card, cash, gift card), and a cash reconciliation helper for
// end of day close.
// 25 Nov 2026 (Coffee Boy Castleford): the rows come from the one sales rule, split by tender
// (lib/paymentMethodRows.js). A check paid part by card and part with a free loyalty drink used
// to be a row called "? Other", with its card money missing from Card.

import { useMemo } from 'react';
import { StatTile, ExportBtn, EmptyState, BarRow } from './_charts';
import { toCsv, downloadCsv } from './_csv';
import { isSplit, keyedMatrix } from '../../../lib/reportSplit.js';
import { salesBreakdown, breakdownFromDaySums } from '../../../lib/salesBreakdown.js';
import { paymentRows, paymentLabel } from '../../../lib/paymentMethodRows.js';
import { applyFilters } from './_filters';
import { useRefundLookback, toMs } from './_refundLookback';
import { useParts, exportSites } from './_siteSplit';
import { SplitHeader, Blocks, SiteMatrix } from './SiteSplit';
import { Icon, hasIcon } from '../../../components/ServOSIcons';

const METHOD_STYLE = {
  'cash':        { color:'var(--grn)', icon:'money' },
  'card':        { color:'#3b82f6',    icon:'card' },
  'gift_card':   { color:'#a855f7',    icon:'gift' },
  'deposit':     { color:'var(--acc)', icon:'calendar' },
  'other':       { color:'var(--t3)',  icon:'?' },
  'unallocated': { color:'var(--t3)',  icon:'?' },
};
const NONE = Object.freeze([]);
const styleOf = (m) => METHOD_STYLE[m] || METHOD_STYLE.other;
// Free loyalty items are named under the rows: they are not money and are not in the total.
const rewardsNote = (fmt, rewards) => `Loyalty rewards given: ${fmt(rewards)} of free items. No money was taken for these, so they are not in the total above.`;

// 5 Oct 2026 (Peter: "make every report we have multi site when sites are connected
// together"): with more than one site on screen this is the site split at the foot of the
// file. One site is the report exactly as it was.
export default function Payments(props) {
  return isSplit(props.sites) ? <PaymentsSites {...props}/> : <PaymentsOne {...props}/>;
}

// rangeFrom / rangeTo / locationId / filters: as the Business summary takes them, so a refund
// comes off on the day it was made and Total collected here is its Money collected.
function PaymentsOne({ checks, fmt, fmtN, sites, locationConfig, rangeFrom, rangeTo, locationId, filters }) {
  const one = Array.isArray(sites) && sites.length === 1 ? sites[0] : null;
  const siteId = one && !one.isHome ? String(one.id) : (locationId ? String(locationId) : null);
  const from = rangeFrom ?? one?.range?.from ?? null;
  const to   = rangeTo   ?? one?.range?.to   ?? null;
  const lookback = useRefundLookback(siteId ? [siteId] : [], from);
  const refundRows = useMemo(() => applyFilters((siteId && lookback.rows[siteId]) || NONE, filters), [siteId, lookback.rows, filters]);
  const currency = locationConfig?.currency || one?.currency || null;
  const range = useMemo(() => (from != null ? { fromMs: toMs(from), toMs: toMs(to) } : null), [from, to]);
  const breakdown = useMemo(() => paymentRows(salesBreakdown(checks, { range, refundRows, currency })), [checks, range, refundRows, currency]);

  const cashRow        = breakdown.rows.find(r => r.method === 'cash');
  const cashRevenue    = cashRow?.revenue || 0;
  const nonCashRevenue = breakdown.total - cashRevenue;
  const checkCount     = breakdown.checks;

  const onExport = () => {
    const csv = toCsv(breakdown.rows, [
      { label:'Method',  key: r => paymentLabel(r.method) },
      { label:'Checks',  key:'count' },
      { label:'Revenue', key: r => r.revenue.toFixed(2) },
      { label:'Tips',    key: r => r.tips.toFixed(2) },
      { label:'Share %', key: r => breakdown.total ? ((r.revenue / breakdown.total) * 100).toFixed(1) : '0.0' },
    ]);
    downloadCsv(`payments-${new Date().toISOString().slice(0,10)}.csv`, csv);
  };

  if (breakdown.total === 0 && breakdown.rewards === 0) {
    return <EmptyState icon="card" message="No payments recorded in this period."/>;
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
            const st  = styleOf(r.method);
            const pct = breakdown.total ? (r.revenue / breakdown.total * 100) : 0;
            return (
              <BarRow
                key={r.method}
                label={<span style={{ display:'inline-flex', alignItems:'center', gap:6 }}>{hasIcon(st.icon) ? <Icon name={st.icon} size={14}/> : st.icon} {paymentLabel(r.method)} · {r.count} checks</span>}
                value={r.revenue}
                max={breakdown.total}
                color={st.color}
                format={v => `${fmt(v)} · ${pct.toFixed(0)}%`}
              />
            );
          })}
          {breakdown.rewards > 0 && (
            <div style={{ marginTop:10, fontSize:11, color:'var(--t4)', lineHeight:1.6 }}>{rewardsNote(fmt, breakdown.rewards)}</div>
          )}
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
                <strong style={{ color:'var(--t2)' }}>End of day check:</strong><br/>
                Expected in drawer = <span style={{ color:'var(--t1)' }}>starting float + {fmt(cashRevenue)}</span><br/>
                Count the drawer at close and subtract starting float. The remainder should match cash sales above. Any gap is variance.
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

// Several sites: the group's methods on top, then a column per site. The same rows as one
// site, from the same rule: a short period reads the checks (split by tender), a long period
// the server day sums (their by tender figures, which hold no check count per kind of money).
// Cash is never added across sites into one drawer figure: each site's cash is its own column.
function PaymentsSites(props) {
  const { fmtN } = props;
  const { parts, blocks, fromSums } = useParts(props);
  const ids = fromSums ? [] : parts.map(p => p.id);
  const starts = [props.rangeFrom, ...parts.map(p => p.site?.range?.from)].map(toMs).filter(v => v != null);
  const lookback = useRefundLookback(ids, starts.length ? Math.min(...starts) : null);
  const filters = props.filters;
  const read = useMemo(() => new Map(parts.map(p => {
    const range = p.site?.range?.from ? { fromMs: toMs(p.site.range.from), toMs: toMs(p.site.range.to) } : null;
    const b = p.sums
      ? breakdownFromDaySums(p.sums.totals.stats, p.sums.totals.byTender, { currency: p.currency, refundsMade: p.sums.totals.refundsMade })
      : salesBreakdown(p.rows, { currency: p.currency, range, refundRows: applyFilters(lookback.rows[String(p.id)] || NONE, filters) });
    const r = paymentRows(b);
    return [p.id, { ...r, map: Object.fromEntries(r.rows.map(x => [x.method, x])), tips: Number(b.tips) || 0 }];
  })), [parts, lookback.rows, filters]);
  const bySite = { get: (id) => read.get(id).map };
  const sum = (map, f) => Object.values(map).reduce((s, r) => s + r[f], 0);
  const label = (m) => paymentLabel(m);

  const onExport = () => {
    const rows = [];
    for (const p of parts) {
      const map = bySite.get(p.id), total = sum(map, 'revenue');
      for (const r of Object.values(map).sort((a, b) => b.revenue - a.revenue)) rows.push({ ...r, siteName: p.name, currency: p.currency || '', share: total ? (r.revenue / total) * 100 : 0 });
    }
    exportSites('payments', rows, [
      { label:'Currency', key:'currency' },
      { label:'Method',   key: r => label(r.method) },
      { label:'Checks',   key:'count' },
      { label:'Revenue',  key: r => r.revenue.toFixed(2) },
      { label:'Tips',     key: r => r.tips.toFixed(2) },
      { label:'Share %',  key: r => r.share.toFixed(1) },
    ]);
  };

  if (parts.every(p => sum(bySite.get(p.id), 'revenue') === 0)) return <EmptyState icon="card" message="No payments recorded at these sites in this period."/>;

  return (
    <div>
      <SplitHeader parts={parts} fromSums={fromSums} chips={false} onExport={onExport}/>
      <Blocks blocks={blocks}>{b => {
        const m = keyedMatrix(b.parts, p => Object.fromEntries(Object.values(bySite.get(p.id)).map(r => [r.method, r.revenue])));
        const checks = b.parts.reduce((s, p) => s + read.get(p.id).checks, 0);
        const rewards = b.parts.reduce((s, p) => s + read.get(p.id).rewards, 0);
        const cash = m.rows.find(r => r.key === 'cash')?.total || 0;
        const share = (v) => (m.total ? `${((v / m.total) * 100).toFixed(1)}% of total` : null);
        const rows = [
          { key:'__total', label:'Total collected', strong:true, total: m.total, bySite: m.bySite },
          ...m.rows.map(r => ({ ...r, label: label(r.key) })),
          { key:'__checks', label:'Checks', kind:'count', total: checks, bySite: Object.fromEntries(b.parts.map(p => [p.id, read.get(p.id).checks])) },
          { key:'__tips', label:'Tips recorded', total: b.parts.reduce((s, p) => s + read.get(p.id).tips, 0), bySite: Object.fromEntries(b.parts.map(p => [p.id, read.get(p.id).tips])) },
          // The server day sums do not hold tips per kind of money, so this row is left off a long period.
          ...(fromSums ? [] : [{ key:'__cashtips', label:'Cash tips recorded', total: b.parts.reduce((s, p) => s + (bySite.get(p.id).cash?.tips || 0), 0), bySite: Object.fromEntries(b.parts.map(p => [p.id, bySite.get(p.id).cash?.tips || 0])) }]),
        ];
        return (
          <>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:10, marginBottom:18 }}>
              <StatTile label="Total collected" value={b.fmt(m.total)}        sub={`${fmtN(checks)} checks`} color="var(--acc)"/>
              <StatTile label="Cash"            value={b.fmt(cash)}           sub={share(cash)} color="var(--grn)"/>
              <StatTile label="Non-cash"        value={b.fmt(m.total - cash)} sub={share(m.total - cash)} color="#3b82f6"/>
            </div>
            <SiteMatrix block={b} rows={rows} first="Payment method" fmtN={fmtN}/>
            {rewards > 0 && <div style={{ margin:'0 0 10px', fontSize:11, color:'var(--t4)', lineHeight:1.6 }}>{rewardsNote(b.fmt, rewards)}</div>}
            <div style={{ marginBottom:14, padding:'10px 12px', background:'var(--bg3)', border:'1px dashed var(--bdr)', borderRadius:8, fontSize:11, color:'var(--t4)', lineHeight:1.7 }}>
              Each site has its own drawer. Expected in a drawer = that site's starting float + its cash sales above. Count each drawer by itself.
            </div>
          </>
        );
      }}</Blocks>
    </div>
  );
}
