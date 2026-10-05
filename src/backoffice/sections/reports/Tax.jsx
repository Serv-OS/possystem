// v4.6.21: Tax report (replaces LegacyTax).
//
// Uses the authoritative unified tax seam (computeOrderTaxUnified) on each check's items so the
// report matches what's charged at the till. Per-rate breakdown shows net,
// tax, gross and line count. Per-order-type breakdown reveals how much tax is
// coming from each channel (useful when takeaway/delivery have zero-rated
// overrides). If closed_checks.taxAmount is populated (post v4.6.19) the
// totals line prefers stored values over re-derived ones and shows any
// variance as a diagnostic.

import { useMemo } from 'react';
import { useStore } from '../../../store';
import { recordedCheckTax } from '../../../lib/taxCompute';
import { StatTile, ExportBtn, EmptyState } from './_charts';
import { toCsv, downloadCsv } from './_csv';
import { isSplit, sumFields } from '../../../lib/reportSplit.js';
import { siteTaxAnalysis, taxSourceNote, siteCheckTax } from '../../../lib/reportSiteMenu.js';
import { useParts, exportSites } from './_siteSplit';
import { useSiteMenus, useOtherSiteMenu } from './_siteMenus';
import { SplitHeader, Blocks, SiteRows, SiteMatrix } from './SiteSplit';

// One empty list, so a view with nothing to show does not rebuild its tables every render.
const NONE = Object.freeze([]);

// 5 Oct 2026 (Peter: "make every report we have multi site when sites are connected
// together"): with more than one site on screen this is the site split at the foot of the
// file, each site's checks taxed on ITS OWN record or rates, never the signed in site's
// (src/lib/reportSiteMenu.js). One site is the report exactly as it was.
export default function Tax(props) {
  return isSplit(props.sites) ? <TaxSites {...props}/> : <TaxOne {...props}/>;
}

function TaxOne({ checks, fmt, fmtN, sites }) {
  const store = useStore();
  // v5.7.34: recompute through the UNIFIED SEAM — identical numbers on
  // legacy-equivalent venues, profile-cascade numbers on profile venues.
  const homeCtx = useStore(s => s.getTaxContext());
  // 5 Oct 2026: one OTHER site ticked. Its checks are taxed on THEIR site's rates and profiles
  // (read fresh), never the signed in site's; when those could not be read, on the tax each
  // check stored. The signed in site reads the store as it always has.
  const other = useOtherSiteMenu(sites);
  const taxRates = other.other ? (other.menu?.taxRates || NONE) : (store.taxRates || NONE);
  const taxCtx = other.other ? (other.menu?.taxCtx || null) : homeCtx;
  const taxOf = other.other ? (c) => siteCheckTax(c, other.menu) : (c) => recordedCheckTax(c, taxCtx);

  const analysis = useMemo(() => {
    // Per-rate rollup (via the unified seam for correctness on inclusive/exclusive + overrides + profiles)
    const byRate = {};
    const byOrderType = {};

    let totalStoredTax = 0;  // sum of c.taxAmount when available
    let totalDerivedTax = 0; // sum via computeOrderTaxUnified
    let hasStoredCount = 0;
    let derivedOnlyCount = 0;
    let totalNet = 0;
    let totalGross = 0;

    checks.filter(c => c.status !== 'voided').forEach(c => {
      // v5.9.12: the tax the check CHARGED when it stored one (US), else the seam.
      const result = taxOf(c);
      totalDerivedTax += result.totalTax || 0;
      totalNet        += result.subtotal || result.totalNet || 0;

      if (c.taxAmount != null) { totalStoredTax += c.taxAmount; hasStoredCount++; }
      else                     { derivedOnlyCount++; }

      totalGross += c.total || 0;

      (result.breakdown || []).forEach(b => {
        const id = b.rate?.id || '__unrated';
        if (!byRate[id]) byRate[id] = {
          rateId: id,
          label: b.rate?.label || 'Unrated',
          rate:  b.rate?.rate  || 0,
          type:  b.rate?.type  || '',
          tax:   0, net: 0, gross: 0, items: 0,
        };
        byRate[id].tax   += b.tax   || 0;
        byRate[id].net   += b.net   || 0;
        byRate[id].gross += b.gross || 0;
        byRate[id].items += b.items || 0;
      });

      const ot = c.orderType || 'dine-in';
      if (!byOrderType[ot]) byOrderType[ot] = { orderType: ot, tax: 0, net: 0, gross: 0, checks: 0 };
      byOrderType[ot].tax   += result.totalTax || 0;
      byOrderType[ot].net   += result.subtotal || result.totalNet || 0;
      byOrderType[ot].gross += c.total || 0;
      byOrderType[ot].checks += 1;
    });

    return {
      rateRows: Object.values(byRate).sort((a, b) => b.tax - a.tax),
      orderTypeRows: Object.values(byOrderType).sort((a, b) => b.tax - a.tax),
      totalStoredTax, totalDerivedTax,
      hasStoredCount, derivedOnlyCount,
      totalNet, totalGross,
      effectiveTaxRate: totalNet > 0 ? (totalDerivedTax / totalNet) * 100 : 0,
      variance: totalStoredTax > 0 ? totalStoredTax - totalDerivedTax : 0,
    };
    // taxOf follows taxCtx and other.menu
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checks, taxCtx, other.menu]);

  const displayTax = analysis.hasStoredCount > analysis.derivedOnlyCount
    ? analysis.totalStoredTax
    : analysis.totalDerivedTax;

  const onExportRates = () => {
    const csv = toCsv(analysis.rateRows, [
      { label:'Rate',      key:'label' },
      { label:'Type',      key: r => r.type === 'inclusive' ? 'Inclusive' : 'Exclusive' },
      { label:'Rate %',    key: r => (r.rate * 100).toFixed(2) },
      { label:'Net',       key: r => r.net.toFixed(2) },
      { label:'Tax',       key: r => r.tax.toFixed(2) },
      { label:'Gross',     key: r => r.gross.toFixed(2) },
      { label:'Line items',key:'items' },
    ]);
    downloadCsv(`tax-by-rate-${new Date().toISOString().slice(0,10)}.csv`, csv);
  };

  const onExportTypes = () => {
    const csv = toCsv(analysis.orderTypeRows, [
      { label:'Order type', key:'orderType' },
      { label:'Checks',     key:'checks' },
      { label:'Net',        key: r => r.net.toFixed(2) },
      { label:'Tax',        key: r => r.tax.toFixed(2) },
      { label:'Gross',      key: r => r.gross.toFixed(2) },
    ]);
    downloadCsv(`tax-by-order-type-${new Date().toISOString().slice(0,10)}.csv`, csv);
  };

  if (other.loading) return <div style={{ textAlign:'center', padding:'48px 0', color:'var(--t4)', fontSize:13 }}>Loading this site's tax rates…</div>;
  if (checks.length === 0) return <EmptyState icon="💰" message="No checks in this period."/>;
  if (taxRates.length === 0 && !(other.other && (other.failed || !other.menu?.taxLoaded))) return <EmptyState icon="💰" message="No tax rates configured. Set them up under Settings → Tax to see breakdowns here."/>;

  return (
    <div>
      {other.other && (other.failed || !other.menu?.taxLoaded) && (
        <div style={{ marginBottom:10, fontSize:11, color:'var(--amber)' }}>{other.site.name}: the tax rates could not be read, so each check shows the tax stored on it with no rate breakdown.</div>
      )}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:10, marginBottom:18 }}>
        <StatTile label="Total tax"        value={fmt(displayTax)} color="var(--acc)" sub={analysis.hasStoredCount > 0 ? `${analysis.hasStoredCount} stored · ${analysis.derivedOnlyCount} derived` : 'all derived'}/>
        <StatTile label="Net of tax"       value={fmt(analysis.totalNet)}/>
        <StatTile label="Effective rate"   value={`${analysis.effectiveTaxRate.toFixed(2)}%`} sub="tax ÷ net"/>
        <StatTile label="Variance"         value={fmt(Math.abs(analysis.variance))} color={Math.abs(analysis.variance) > 0.5 ? 'var(--red)' : 'var(--t1)'} sub="stored vs re-derived"/>
      </div>

      {/* Per rate */}
      <div style={{ background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:12, overflow:'hidden', marginBottom:14 }}>
        <div style={{ padding:'10px 14px', background:'var(--bg3)', borderBottom:'1px solid var(--bdr)', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
          <span style={{ fontSize:11, fontWeight:700, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.06em' }}>Tax by rate</span>
          <ExportBtn onClick={onExportRates}/>
        </div>
        <div style={{ display:'grid', gridTemplateColumns:'1.5fr 100px 80px 100px 110px 100px 70px', padding:'8px 14px', borderBottom:'1px solid var(--bdr)', fontSize:10, fontWeight:700, color:'var(--t4)', letterSpacing:'.05em', textTransform:'uppercase', gap:8 }}>
          <span>Rate</span>
          <span>Type</span>
          <span style={{ textAlign:'right' }}>Rate</span>
          <span style={{ textAlign:'right' }}>Net</span>
          <span style={{ textAlign:'right' }}>Tax</span>
          <span style={{ textAlign:'right' }}>Gross</span>
          <span style={{ textAlign:'right' }}>Lines</span>
        </div>
        {analysis.rateRows.length === 0 ? (
          <div style={{ padding:'18px 14px', fontSize:12, color:'var(--t4)', textAlign:'center' }}>No taxed line items in this period.</div>
        ) : analysis.rateRows.map((r, i) => (
          <div key={r.rateId} style={{ display:'grid', gridTemplateColumns:'1.5fr 100px 80px 100px 110px 100px 70px', padding:'10px 14px', borderBottom: i === analysis.rateRows.length - 1 ? 'none' : '1px solid var(--bdr)', fontSize:12, alignItems:'center', gap:8 }}>
            <span style={{ color:'var(--t1)', fontWeight:600 }}>{r.label}</span>
            <span style={{ color:'var(--t3)', fontSize:11 }}>{r.type === 'inclusive' ? 'Inclusive' : 'Exclusive'}</span>
            <span style={{ textAlign:'right', color:'var(--t2)', fontFamily:'var(--font-mono)' }}>{(r.rate * 100).toFixed(2)}%</span>
            <span style={{ textAlign:'right', color:'var(--t2)', fontFamily:'var(--font-mono)' }}>{fmt(r.net)}</span>
            <span style={{ textAlign:'right', color:'var(--acc)', fontFamily:'var(--font-mono)', fontWeight:700 }}>{fmt(r.tax)}</span>
            <span style={{ textAlign:'right', color:'var(--t2)', fontFamily:'var(--font-mono)' }}>{fmt(r.gross)}</span>
            <span style={{ textAlign:'right', color:'var(--t3)', fontFamily:'var(--font-mono)' }}>{r.items}</span>
          </div>
        ))}
      </div>

      {/* Per order type */}
      <div style={{ background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:12, overflow:'hidden' }}>
        <div style={{ padding:'10px 14px', background:'var(--bg3)', borderBottom:'1px solid var(--bdr)', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
          <span style={{ fontSize:11, fontWeight:700, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.06em' }}>Tax by order type</span>
          <ExportBtn onClick={onExportTypes}/>
        </div>
        <div style={{ display:'grid', gridTemplateColumns:'1.4fr 80px 110px 110px 110px', padding:'8px 14px', borderBottom:'1px solid var(--bdr)', fontSize:10, fontWeight:700, color:'var(--t4)', letterSpacing:'.05em', textTransform:'uppercase', gap:8 }}>
          <span>Order type</span>
          <span style={{ textAlign:'right' }}>Checks</span>
          <span style={{ textAlign:'right' }}>Net</span>
          <span style={{ textAlign:'right' }}>Tax</span>
          <span style={{ textAlign:'right' }}>Gross</span>
        </div>
        {analysis.orderTypeRows.map((r, i) => (
          <div key={r.orderType} style={{ display:'grid', gridTemplateColumns:'1.4fr 80px 110px 110px 110px', padding:'10px 14px', borderBottom: i === analysis.orderTypeRows.length - 1 ? 'none' : '1px solid var(--bdr)', fontSize:12, alignItems:'center', gap:8 }}>
            <span style={{ color:'var(--t1)', fontWeight:600 }}>{r.orderType}</span>
            <span style={{ textAlign:'right', color:'var(--t2)', fontFamily:'var(--font-mono)' }}>{r.checks}</span>
            <span style={{ textAlign:'right', color:'var(--t2)', fontFamily:'var(--font-mono)' }}>{fmt(r.net)}</span>
            <span style={{ textAlign:'right', color:'var(--acc)', fontFamily:'var(--font-mono)', fontWeight:700 }}>{fmt(r.tax)}</span>
            <span style={{ textAlign:'right', color:'var(--t2)', fontFamily:'var(--font-mono)' }}>{fmt(r.gross)}</span>
          </div>
        ))}
      </div>

      <div style={{ marginTop:14, padding:'10px 12px', background:'var(--bg3)', border:'1px dashed var(--bdr)', borderRadius:8, fontSize:11, color:'var(--t4)', lineHeight:1.7 }}>
        ⓘ Recomputes each check through the same tax engine used at point of sale (tax profiles and legacy rates alike) so breakdowns match what customers were charged. Variance shows the delta between stored tax_amount and the re-derived total. Values above 0.50 are red-flagged as a diagnostic. Usually harmless rounding on inclusive-tax menus, investigate if significant.
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Several sites. The tax of a check is, in order: what the check booked (US added-on tax, a
// scaled UK record), the check's OWN site's rates and profiles through the same seam the till
// ran, and when those could not be read, the tax_amount stored on the check (a total with no
// rate breakdown, and the site's line says so). The signed in site's rates are never used for
// another site's rows. A rate is matched across sites on its label, percentage and kind, so
// Leeds' and Preston's "Standard Rate 20% inclusive" are one line.
// ─────────────────────────────────────────────────────────────────────────────
function TaxSites(props) {
  const { fmtN } = props;
  const { parts, blocks } = useParts(props);
  const { menus, loading, failed } = useSiteMenus(parts);
  const bySite = useMemo(() => new Map(parts.map(p => [p.id, siteTaxAnalysis(p.rows, menus[p.id] || null)])), [parts, menus]);

  const onExport = () => {
    const rows = parts.flatMap(p => bySite.get(p.id).rateRows.map(r => ({ ...r, siteName: p.name, currency: p.currency || '' })));
    exportSites('tax-by-rate', rows, [
      { label:'Currency',  key:'currency' },
      { label:'Rate',      key:'label' },
      { label:'Type',      key: r => r.type === 'inclusive' ? 'Inclusive' : 'Exclusive' },
      { label:'Rate %',    key: r => (r.rate * 100).toFixed(2) },
      { label:'Net',       key: r => r.net.toFixed(2) },
      { label:'Tax',       key: r => r.tax.toFixed(2) },
      { label:'Gross',     key: r => r.gross.toFixed(2) },
      { label:'Line items',key:'items' },
    ]);
  };

  if (loading) return <div style={{ textAlign:'center', padding:'48px 0', color:'var(--t4)', fontSize:13 }}>Loading each site's tax rates…</div>;
  if (parts.every(p => p.rows.length === 0)) return <EmptyState icon="💰" message="No checks at these sites in this period."/>;

  const notes = parts.map(p => {
    const menu = menus[p.id];
    if (failed.includes(p.id)) return `${p.name}: the tax rates could not be read, so its checks show the tax stored on each check with no rate breakdown.`;
    if (menu && menu.taxLoaded && !menu.hasRates && p.rows.length) return `${p.name}: no tax rates are set up, so its checks show the tax stored on each check.`;
    return taxSourceNote(p.name, menu, bySite.get(p.id));
  }).filter(Boolean);

  return (
    <div>
      <SplitHeader parts={parts} chips={false} onExport={onExport}>
        {notes.map(n => <div key={n} style={{ color:'var(--amber)' }}>{n}</div>)}
      </SplitHeader>
      <Blocks blocks={blocks}>{b => {
        const site = b.parts.map(p => ({ part: p, cells: bySite.get(p.id) }));
        const all = sumFields(site.map(x => x.cells), ['displayTax', 'totalDerivedTax', 'totalNet', 'totalGross', 'variance']);
        const eff = all.totalNet > 0 ? (all.totalDerivedTax / all.totalNet) * 100 : 0;
        const rateRows = rateMatrix(b.parts, p => bySite.get(p.id).rateRows);
        const typeRows = rateMatrix(b.parts, p => bySite.get(p.id).orderTypeRows.map(r => ({ ...r, key: r.orderType, label: r.orderType })));
        return (
          <>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:10, marginBottom:18 }}>
              <StatTile label="Total tax"      value={b.fmt(all.displayTax)} color="var(--acc)" sub={`${b.parts.length} site${b.parts.length === 1 ? '' : 's'}`}/>
              <StatTile label="Net of tax"     value={b.fmt(all.totalNet)}/>
              <StatTile label="Effective rate" value={`${eff.toFixed(2)}%`} sub="tax ÷ net"/>
              <StatTile label="Variance"       value={b.fmt(Math.abs(all.variance))} color={Math.abs(all.variance) > 0.5 ? 'var(--red)' : 'var(--t1)'} sub="stored vs re-derived"/>
            </div>
            <SiteRows block={b} rows={site} total={all} columns={[
              { label:'Net',       cell: (c, f) => f(c.totalNet) },
              { label:'Tax',       cell: (c, f) => f(c.displayTax), color:'var(--acc)' },
              { label:'Gross',     cell: (c, f) => f(c.totalGross) },
              { label:'Eff. rate', cell: c => `${(c.totalNet > 0 ? (c.totalDerivedTax / c.totalNet) * 100 : 0).toFixed(2)}%` },
              { label:'Variance',  cell: (c, f) => <span style={{ color: Math.abs(c.variance) > 0.5 ? 'var(--red)' : undefined }}>{f(Math.abs(c.variance))}</span> },
            ]}/>
            <SiteMatrix block={b} first="Tax by rate" fmtN={fmtN} rows={rateRows.map(r => ({
              key: r.key, kind: 'money', total: r.tax, bySite: r.bySite,
              label: (
                <span>
                  <span style={{ color:'var(--t1)', fontWeight:600 }}>{r.label}</span>
                  <span style={{ color:'var(--t4)', fontSize:10, marginLeft:6 }}>{(r.rate * 100).toFixed(2)}% · {r.type === 'inclusive' ? 'Inclusive' : 'Exclusive'} · net {b.fmt(r.net)}</span>
                </span>
              ),
            }))}/>
            <SiteMatrix block={b} first="Tax by order type" fmtN={fmtN} rows={typeRows.map(r => ({
              key: r.key, kind: 'money', total: r.tax, bySite: r.bySite,
              label: (
                <span>
                  <span style={{ color:'var(--t1)', fontWeight:600 }}>{r.label}</span>
                  <span style={{ color:'var(--t4)', fontSize:10, marginLeft:6 }}>{fmtN(r.checks)} check{r.checks === 1 ? '' : 's'} · net {b.fmt(r.net)}</span>
                </span>
              ),
            }))}/>
          </>
        );
      }}</Blocks>
      <div style={{ padding:'10px 12px', background:'var(--bg3)', border:'1px dashed var(--bdr)', borderRadius:8, fontSize:11, color:'var(--t4)', lineHeight:1.7 }}>
        ⓘ Each site's checks are taxed on their own record or their own site's rates, through the same tax engine the till used; the signed in site's rates are never applied to another site. A rate with the same name, percentage and kind at two sites is one line. Variance is stored tax against re-derived tax, per site.
      </div>
    </div>
  );
}

// Rows keyed across sites with the tax of each site in bySite and the block's totals.
function rateMatrix(blockParts, rowsOf) {
  const map = new Map();
  for (const p of blockParts) {
    for (const r of rowsOf(p)) {
      const g = map.get(r.key) || map.set(r.key, { key: r.key, label: r.label, rate: r.rate || 0, type: r.type || '', tax: 0, net: 0, gross: 0, items: 0, checks: 0, bySite: {} }).get(r.key);
      g.tax += r.tax || 0; g.net += r.net || 0; g.gross += r.gross || 0; g.items += r.items || 0; g.checks += r.checks || 0;
      g.bySite[p.id] = (g.bySite[p.id] || 0) + (r.tax || 0);
    }
  }
  for (const g of map.values()) for (const p of blockParts) if (g.bySite[p.id] == null) g.bySite[p.id] = 0;
  return [...map.values()].sort((a, b) => b.tax - a.tax);
}
