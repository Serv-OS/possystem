// v4.6.15: Sales Summary report (the Back Office "Business summary").
// Replaces the legacy "Overview" tab.
// Shows: 4 headline tiles with period-over-period compare chips, a revenue breakdown ladder and
// an exceptions snapshot for quick visibility.
//
// 16 Oct 2026: the ladder is read by the one sales rule (src/lib/salesBreakdown.js): item sales
// (including VAT) less voids, discounts, loyalty rewards and refunds = sales including VAT, of
// which VAT, net sales excluding VAT (the Owner app's and Daily trading's figure), plus service
// and tips = money collected, which the Card, Cash, Gift card line adds up to.
//
// v4.6.25: When locationConfig.shifts is defined, a service-period breakdown
// (Breakfast / Lunch / Dinner) sits between the headline tiles and the revenue
// ladder so Peter's service periods are visible at a glance.

import { useMemo } from 'react';
import { StatTile, ExportBtn, EmptyState } from './_charts';
import { classifyShift, applyFilters } from './_filters';
import { toCsv, downloadCsv } from './_csv';
import { isSplit, sumFields } from '../../../lib/reportSplit.js';
import { useParts, exportSites } from './_siteSplit';
import { SplitHeader, Blocks, GroupChange, SiteChange, SiteMatrix } from './SiteSplit';
import SalesMixStrip from './SalesMixStrip';
import { STRIP_NOTE, STRIP_NOTE_ADDED_TAX, STRIP_NOTE_INCL_TAX } from '../../../lib/salesMixView.js';

// The figures live in lib/salesStats.js (28 Sep 2026) so the till can print them too. The Z
// report still imports computeSalesStats from here.
export { computeSalesStats } from '../../../lib/salesStats';
import { vatMissingLine } from '../../../lib/salesStats';
// 16 Oct 2026 (Peter: "owner app net sales 1703, business summary net sales 2112 ... I can't get
// them to add up"): this report now reads every check by THE ONE SALES RULE the Owner app, Daily
// trading and Xero use (src/lib/salesBreakdown.js over _shared/tradingSales.js): Net sales
// exclude VAT, loyalty rewards are not sales, refunds come off on the day they were made, and the
// ladder ends in the money collected, which the tender line beneath it adds up to.
import {
  salesBreakdown, breakdownFromDaySums, breakdownLines, tenderLine, subtotalOffLine, discountOffLine, rewardsVatLine, giftSoldLine,
  checkNetSales, BREAKDOWN_FIELDS,
} from '../../../lib/salesBreakdown';
import { useRefundLookback, toMs } from './_refundLookback';

const NONE = Object.freeze([]);

// 5 Oct 2026 (Peter: "make every report we have multi site when sites are connected
// together"): with more than one site on screen this is the site split below. One site is
// the report exactly as it was.
export default function SalesSummary(props) {
  return isSplit(props.sites) ? <SalesSummarySites {...props}/> : <SalesSummaryOne {...props}/>;
}

// compare = the range's compare (the one percent rule, src/lib/reportCompare.js): the chips' words.
// rangeFrom / rangeTo / locationId: the range (refunds count on the day they were made) and the
// signed in site, whose checks closed before the range are read for refunds made inside it.
// filters = the report's server, order type and source filters (BOReports applies them to
// `checks`); the older sales read for refunds are filtered the same way.
function SalesSummaryOne({ checks, prevChecks, fmt, fmtN, locationConfig, compare, sites, scope, onOpenReport, rangeFrom, rangeTo, locationId, filters }) {
  const one = Array.isArray(sites) && sites.length === 1 ? sites[0] : null;
  const siteId = one && !one.isHome ? String(one.id) : (locationId ? String(locationId) : null);
  const from = rangeFrom ?? one?.range?.from ?? null;
  const to   = rangeTo   ?? one?.range?.to   ?? null;
  const lookback = useRefundLookback(siteId ? [siteId] : [], from);
  const refundRows = useMemo(() => applyFilters((siteId && lookback.rows[siteId]) || NONE, filters), [siteId, lookback.rows, filters]);
  // The comparison period reads its own older sales, so its refunds come off the same way
  // and the percent chips compare like with like.
  const prevLookback = useRefundLookback(siteId && compare?.from ? [siteId] : [], compare?.from ?? null);
  const prevRefundRows = useMemo(() => applyFilters((siteId && prevLookback.rows[siteId]) || NONE, filters), [siteId, prevLookback.rows, filters]);
  const currency = locationConfig?.currency || one?.currency || null;
  const range = useMemo(() => (from != null ? { fromMs: toMs(from), toMs: toMs(to) } : null), [from, to]);
  const prevRange = useMemo(() => (compare?.from ? { fromMs: toMs(compare.from), toMs: toMs(compare.to) } : null), [compare]);
  const cur  = useMemo(() => salesBreakdown(checks,     { range, refundRows, currency }), [checks, range, refundRows, currency]);
  const prev = useMemo(() => salesBreakdown(prevChecks, { range: prevRange, refundRows: prevRefundRows, currency }), [prevChecks, prevRange, prevRefundRows, currency]);
  const avgCheck     = cur.count  ? cur.net  / cur.count  : 0;
  const prevAvgCheck = prev.count ? prev.net / prev.count : 0;
  const avgCover     = cur.covers  ? cur.net  / cur.covers  : 0;
  const prevAvgCover = prev.covers ? prev.net / prev.covers : 0;
  const word = cur.taxWord;

  // v4.6.25: service-period breakdown when shifts are configured.
  // v5.10.3: which service a check belongs to is read on the venue's clock.
  // 16 Oct 2026: each check's net sales by the one rule (excluding VAT, after its own refunds).
  const servicePeriods = useMemo(() => {
    const shifts = locationConfig?.shifts || [];
    const tz     = locationConfig?.timezone;
    if (!shifts.length) return null;
    const rows = shifts.map(s => ({ shift: s, net: 0, covers: 0, count: 0 }));
    const idx = {};
    rows.forEach((r, i) => { idx[r.shift.id || r.shift.name] = i; });
    let unclassified = { net: 0, covers: 0, count: 0 };
    (checks || []).filter(c => c.status !== 'voided' && c.closedAt).forEach(c => {
      const s = classifyShift(c.closedAt, shifts, tz);
      const net = checkNetSales(c, range);
      const cov = c.covers || 1;
      if (s) {
        const i = idx[s.id || s.name];
        rows[i].net += net; rows[i].covers += cov; rows[i].count += 1;
      } else {
        unclassified.net += net; unclassified.covers += cov; unclassified.count += 1;
      }
    });
    const totalClassified = rows.reduce((s, r) => s + r.net, 0);
    return { rows, unclassified, total: totalClassified + unclassified.net };
  }, [checks, locationConfig, range]);

  const lines = useMemo(() => breakdownLines(cur), [cur]);

  const onExport = () => {
    const prevByKey = Object.fromEntries(breakdownLines(prev, { keepZero: true }).map(l => [l.key, l.value]));
    const rows = breakdownLines(cur, { keepZero: true }).map(l => ({ metric: l.label.replace(/^(less|plus) /, ''), current: Math.abs(l.value), previous: Math.abs(prevByKey[l.key] ?? 0) }));
    rows.push(
      { metric:'Card',              current: cur.tender_card,      previous: prev.tender_card },
      { metric:'Cash',              current: cur.tender_cash,      previous: prev.tender_cash },
      { metric:'Gift card',         current: cur.tender_gift_card, previous: prev.tender_gift_card },
      { metric:'Covers',            current: cur.covers,    previous: prev.covers    },
      { metric:'Checks',            current: cur.count,     previous: prev.count     },
      { metric:`Avg check (net excluding ${word})`, current: avgCheck, previous: prevAvgCheck },
      { metric:`Avg cover (net excluding ${word})`, current: avgCover, previous: prevAvgCover },
    );
    const csv = toCsv(rows, [
      { label:'Metric',   key:'metric' },
      { label:'Current',  key: r => (r.current  || 0).toFixed(2) },
      { label:'Previous', key: r => (r.previous || 0).toFixed(2) },
      { label:'Change %', key: r => r.previous ? (((r.current - r.previous)/r.previous)*100).toFixed(2) : '' },
    ]);
    downloadCsv(`sales-summary-${new Date().toISOString().slice(0,10)}.csv`, csv);
  };

  if (cur.count === 0 && cur.voidCount === 0 && cur.refundCount === 0) {
    return <EmptyState icon="📊" message="No sales in this period. Try widening the date range."/>;
  }

  const notes = [subtotalOffLine(cur, fmt), discountOffLine(cur, fmt)].filter(Boolean);
  return (
    <div>
      <div style={{ display:'flex', justifyContent:'flex-end', marginBottom:12 }}><ExportBtn onClick={onExport}/></div>

      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(160px, 1fr))', gap:10, marginBottom:14 }}>
        <StatTile label={`Net sales (excluding ${word})`} value={fmt(cur.net)} vs={compare} values={[cur.net, prev.net]} sub={`${cur.count} checks · ${fmt(cur.sales)} including ${word}`} color="var(--acc)"/>
        <StatTile label="Covers"     value={fmtN(cur.covers)}  vs={compare} values={[cur.covers, prev.covers]} noun="covers" sub={`${fmt(avgCover)} / cover`}/>
        <StatTile label="Avg check"  value={fmt(avgCheck)}     vs={compare} values={[avgCheck, prevAvgCheck]} sub={`net, excluding ${word}`}/>
        <StatTile label="Tips"       value={fmt(cur.tips)}     vs={compare} values={[cur.tips, prev.tips]} noun="tips" sub={cur.net > 0 ? `${((cur.tips/cur.net)*100).toFixed(1)}% of net` : null} color="var(--grn)"/>
      </div>
      <SalesMixStrip checks={checks} fmt={fmt} sites={sites} scope={scope} note={stripNoteFor(cur)} onOpen={onOpenReport ? () => onOpenReport('sales_mix') : null}/>

      {servicePeriods && servicePeriods.rows.length > 0 && (
        <div style={{ background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:12, padding:'14px 16px', marginBottom:12 }}>
          <div style={{ display:'flex', alignItems:'baseline', justifyContent:'space-between', marginBottom:10, gap:10, flexWrap:'wrap' }}>
            <div style={{ fontSize:11, fontWeight:700, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.08em' }}>By service period</div>
            <div style={{ fontSize:11, color:'var(--t4)' }}>Net sales excluding {word} · configured in Location settings</div>
          </div>
          <div style={{ display:'grid', gridTemplateColumns:`repeat(auto-fit, minmax(140px, 1fr))`, gap:10 }}>
            {servicePeriods.rows.map(r => {
              const share = servicePeriods.total > 0 ? (r.net / servicePeriods.total) * 100 : 0;
              const avg   = r.count > 0 ? r.net / r.count : 0;
              return (
                <div key={r.shift.id || r.shift.name} style={{ padding:'12px 14px', background:'var(--bg2)', border:'1px solid var(--bdr)', borderRadius:10 }}>
                  <div style={{ fontSize:10, fontWeight:700, color:'var(--t3)', textTransform:'uppercase', letterSpacing:'.08em', marginBottom:4 }}>{r.shift.name}</div>
                  <div style={{ fontSize:10, color:'var(--t4)', marginBottom:6, fontFamily:'var(--font-mono)' }}>{r.shift.start} to {r.shift.end}</div>
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

      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(280px, 1fr))', gap:12 }}>
        <div style={{ background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:12, padding:'14px 16px' }}>
          <div style={{ fontSize:11, fontWeight:700, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.08em', marginBottom:12 }}>Revenue breakdown</div>
          <Ladder lines={lines} fmt={fmt}/>
          <div style={{ fontSize:11.5, color:'var(--t3)', padding:'4px 0 2px', lineHeight:1.5 }}>{tenderLine(cur, fmt)}</div>
          <div style={{ fontSize:11, color:'var(--t4)', paddingTop:6, lineHeight:1.6 }}>
            Item sales are the lines on each check (price x qty), not the stored subtotal.
            {lookback.loading && siteId ? ' Checking older sales for refunds made in this period.' : ''}
            {lookback.failed.length ? ' Refunds on sales from before this period could not be read, so they are not taken off here.' : ''}
          </div>
          {/* 8 Oct 2026 (the VAT audit): a sale with goods and no VAT recorded is counted 0 and named, never hidden. */}
          {cur.vatMissing.length > 0 && <div style={{ fontSize:11, color:'var(--red)', fontWeight:700, paddingTop:6, lineHeight:1.5 }}>{vatMissingLine(cur)}</div>}
          {notes.map(n => <div key={n} style={{ fontSize:11, color:'var(--amber)', paddingTop:6, lineHeight:1.5 }}>{n}</div>)}
          {rewardsVatLine(cur, fmt) && <div style={{ fontSize:11, color:'var(--t4)', paddingTop:6, lineHeight:1.5 }}>{rewardsVatLine(cur, fmt)}</div>}
          {/* 29 Oct 2026 (Drop C): gift cards sold at the till are money in, not sales (their own ladder line). */}
          {giftSoldLine(cur, fmt) && <div style={{ fontSize:11, color:'var(--t4)', paddingTop:6, lineHeight:1.5 }}>{giftSoldLine(cur, fmt)}</div>}
        </div>
        <ExceptionsSnapshot cur={cur} fmt={fmt}/>
      </div>
    </div>
  );
}

// The Sales mix card's basis, worded for how the venue's prices hold tax.
function stripNoteFor(b) {
  return b.addedOn ? STRIP_NOTE_ADDED_TAX : b.taxWord === 'tax' ? STRIP_NOTE_INCL_TAX : STRIP_NOTE;
}

// The ladder: 'of' lines are a breakdown of the line above them (not added), drawn as a nested block.
function Ladder({ lines, fmt }) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.kind === 'of') {
      const group = [];
      while (i < lines.length && lines[i].kind === 'of') group.push(lines[i++]);
      i -= 1;
      out.push(
        <div key={`of-${l.key}`} style={{ margin:'0 0 4px 10px', padding:'2px 0 2px 10px', borderLeft:'2px solid var(--bdr2)' }}>
          {group.map(g => <LadderRow key={g.key} label={g.label} value={fmt(g.value)} prominence={g.key === 'net' ? 'sub' : null} tone={g.key === 'net' ? 'warn' : null}/>)}
        </div>
      );
      continue;
    }
    const head = l.kind === 'head' || l.kind === 'total';
    out.push(<LadderRow key={l.key} label={l.label} value={fmt(l.value)}
      prominence={head ? 'head' : l.kind === 'sub' ? 'sub' : null}
      tone={l.kind === 'total' ? 'good' : (l.key === 'voids' || l.key === 'refunds') && l.value < 0 ? 'bad' : (l.key === 'discounts' || l.key === 'rewards') && l.value < 0 ? 'warn' : null}
      border={l.kind === 'sub' || l.kind === 'total'}/>);
  }
  return <>{out}</>;
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
  const of = (v) => (cur.items ? (v / cur.items * 100) : 0);
  const items = [
    { label:'Discounts',       value: cur.discounts, color:'var(--acc)', bg:'var(--acc-d)' },
    { label:'Loyalty rewards', value: cur.rewards,   color:'var(--acc)', bg:'var(--acc-d)' },
    { label:'Voids',           value: cur.voids,     color:'var(--red)', bg:'var(--red-d)' },
    { label:'Refunds',         value: cur.refunds,   color:'var(--red)', bg:'var(--red-d)' },
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
            <div style={{ fontSize:11, color:'var(--t4)' }}>{of(i.value).toFixed(2)}% of item sales</div>
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
// Each site's figures are salesBreakdown over its own rows (the same rule as one site, its own
// range, its older refunds), or, for a long period, the nearest reading of the server day sums
// (breakdownFromDaySums, marked estimated: the database adds stored subtotals).
// ─────────────────────────────────────────────────────────────────────────────
const perCheck = (s) => (s.count ? s.net / s.count : 0);
const perCover = (s) => (s.covers ? s.net / s.covers : 0);
// Each ladder line's value from a breakdown, by the line's key (see breakdownLines).
const LINE_VALUE = {
  items: b => b.items, voids: b => -b.voids, delivery: b => b.deliveryFees, discounts: b => -b.discounts,
  rewards: b => -b.rewards, refunds: b => -b.refunds, shelf: b => b.shelfSales, added: b => b.addedTax,
  sales: b => b.sales, tax: b => b.tax, net: b => b.net, service: b => b.service, tips: b => b.tips, gift: b => b.giftSold || 0, collected: b => b.collected,
};
// The lines of a block: the block total's ladder with every line kept, less the optional lines
// (voids, delivery, gift cards sold) no site has; then the counts.
function siteLines(all) {
  const lines = breakdownLines(all, { keepZero: true })
    .filter(l => !((l.key === 'voids' || l.key === 'delivery' || l.key === 'gift') && Math.abs(l.value) < 0.005))
    .map(l => ({ label: l.label, v: LINE_VALUE[l.key], strong: l.kind === 'head' || l.kind === 'sub' || l.kind === 'total' || l.key === 'net' }));
  return [
    ...lines,
    { label:'Covers',           v: s => s.covers, kind:'count' },
    { label:'Checks',           v: s => s.count,  kind:'count' },
    { label:`Avg check (net excluding ${all.taxWord})`, v: perCheck },
    { label:`Avg cover (net excluding ${all.taxWord})`, v: perCover },
  ];
}
// Sites added together: the numeric fields summed; the words follow the sites (one currency a block).
function addBreakdowns(list) {
  const all = sumFields(list, BREAKDOWN_FIELDS);
  all.addedOn = list.some(b => b.addedOn);
  all.taxWord = list.some(b => b.taxWord === 'tax') ? 'tax' : 'VAT';
  all.estimated = list.some(b => b.estimated);
  return all;
}

// The earliest of some range starts (Dates, ISO strings or ms), or null when none is set.
function earliestStart(list) {
  let min = null;
  for (const v of list || []) { const ms = toMs(v); if (ms != null && (min == null || ms < min)) min = ms; }
  return min;
}

function SalesSummarySites(props) {
  const { fmtN } = props;
  const { parts, blocks, fromSums } = useParts(props);
  // Older sales are read from the EARLIEST start of any site's range (and of any site's
  // comparison), so a site whose business day starts later still has every older check; the id
  // dedupe in salesBreakdown stops a check being counted twice.
  const ids = fromSums ? [] : parts.map(p => p.id);
  const lookback = useRefundLookback(ids, earliestStart([props.rangeFrom, ...parts.map(p => p.site?.range?.from)]));
  const cmpFrom = earliestStart(parts.map(p => p.compare?.from));
  const prevLookback = useRefundLookback(cmpFrom != null ? ids : [], cmpFrom);
  const filters = props.filters;
  const stats = useMemo(() => new Map(parts.map(p => {
    const range = p.site?.range?.from ? { fromMs: toMs(p.site.range.from), toMs: toMs(p.site.range.to) } : null;
    const cmp = p.compare?.from ? { fromMs: toMs(p.compare.from), toMs: toMs(p.compare.to) } : null;
    const opts = { currency: p.currency };
    return [p.id, {
      // v5.11.99: the estimate takes refunds off on the day they were made (refundsMade), as the rows do.
      cur:  p.sums ? breakdownFromDaySums(p.sums.totals.stats, p.sums.totals.byTender, { ...opts, refundsMade: p.sums.totals.refundsMade })
                   : salesBreakdown(p.rows, { ...opts, range, refundRows: applyFilters(lookback.rows[String(p.id)] || NONE, filters) }),
      prev: p.sums ? (p.prevSums ? breakdownFromDaySums(p.prevSums.totals.stats, p.prevSums.totals.byTender, { ...opts, refundsMade: p.prevSums.totals.refundsMade }) : salesBreakdown([], opts))
                   : salesBreakdown(p.prevRows, { ...opts, range: cmp, refundRows: applyFilters(prevLookback.rows[String(p.id)] || NONE, filters) }),
    }];
  })), [parts, lookback.rows, prevLookback.rows, filters]);

  const onExport = () => {
    const rows = [];
    for (const p of parts) {
      const { cur, prev } = stats.get(p.id);
      for (const l of siteLines(cur)) rows.push({ siteName: p.name, currency: p.currency || '', metric: l.label.replace(/^(less|plus) /, ''), current: Math.abs(l.v(cur)), previous: Math.abs(l.v(prev)), compared: !!p.compare && p.compare.loaded !== false });
    }
    exportSites('sales-summary', rows, [
      { label:'Currency', key:'currency' },
      { label:'Metric',   key:'metric' },
      { label:'Current',  key: r => (r.current || 0).toFixed(2) },
      { label:'Previous', key: r => (r.compared ? (r.previous || 0).toFixed(2) : '') },
      { label:'Change %', key: r => (r.compared && r.previous ? (((r.current - r.previous) / r.previous) * 100).toFixed(2) : '') },
    ]);
  };

  if (parts.every(p => { const c = stats.get(p.id).cur; return c.count === 0 && c.voidCount === 0 && c.refundCount === 0; })) {
    return <EmptyState icon="📊" message="No sales at these sites in this period. Try widening the date range."/>;
  }

  return (
    <div>
      <SplitHeader parts={parts} fromSums={fromSums} onExport={onExport}/>
      <Blocks blocks={blocks}>{b => {
        const list = b.parts.map(p => stats.get(p.id).cur);
        const all = addBreakdowns(list);
        const rows = siteLines(all).map(l => ({
          key: l.label, kind: l.kind, strong: l.strong, total: l.v(all),
          bySite: Object.fromEntries(b.parts.map(p => [p.id, l.v(stats.get(p.id).cur)])),
        }));
        rows.push({ key:'Net sales change', render: p => <SiteChange part={p} values={[stats.get(p.id).cur.net, stats.get(p.id).prev.net]}/> });
        const notes = list.flatMap(x => [subtotalOffLine(x, b.fmt), discountOffLine(x, b.fmt)]).filter(Boolean);
        return (
          <>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(160px, 1fr))', gap:10, marginBottom:14 }}>
              <StatTile label={`Net sales (excluding ${all.taxWord})`} value={b.fmt(all.net)} color="var(--acc)"
                sub={<>{all.count} checks <GroupChange block={b} pairs={b.parts.map(p => ({ current: stats.get(p.id).cur.net, previous: stats.get(p.id).prev.net }))}/></>}/>
              <StatTile label="Covers"    value={fmtN(all.covers)} sub={`${b.fmt(perCover(all))} / cover`}/>
              <StatTile label="Avg check" value={b.fmt(perCheck(all))} sub={`net, excluding ${all.taxWord}`}/>
              <StatTile label="Tips"      value={b.fmt(all.tips)} sub={all.net > 0 ? `${((all.tips / all.net) * 100).toFixed(1)}% of net` : null} color="var(--grn)"/>
            </div>
            <SalesMixStrip block={b} fromSums={fromSums} note={stripNoteFor(all)} onOpen={props.onOpenReport ? () => props.onOpenReport('sales_mix') : null}/>
            <SiteMatrix block={b} rows={rows} first="Revenue breakdown" fmtN={fmtN}/>
            <div style={{ fontSize:11, color:'var(--t4)', marginTop:6, lineHeight:1.6 }}>
              {all.estimated
                ? `Estimated: long periods across sites are added up by the database from stored subtotals, so these lines are the nearest reading. Refunds come off on the day they were made, as in Daily trading. Pick 7 days or fewer for the exact figures.`
                : `Money collected: ${tenderLine(all, b.fmt)}. Item sales are the lines on each check (price x qty), not the stored subtotal.`}
            </div>
            {notes.map(n => <div key={n} style={{ fontSize:11, color:'var(--amber)', marginTop:4, lineHeight:1.5 }}>{n}</div>)}
          </>
        );
      }}</Blocks>
    </div>
  );
}
