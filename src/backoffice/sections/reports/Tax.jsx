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
import { computeOrderTaxUnified } from '../../../lib/taxCompute';
import { StatTile, ExportBtn, EmptyState } from './_charts';
import { toCsv, downloadCsv } from './_csv';

export default function Tax({ checks, fmt, fmtN }) {
  const { taxRates = [] } = useStore();
  // v5.7.34: recompute through the UNIFIED SEAM — identical numbers on
  // legacy-equivalent venues, profile-cascade numbers on profile venues.
  const taxCtx = useStore(s => s.getTaxContext());

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
      const result = computeOrderTaxUnified(c.items || [], taxCtx, c.orderType || 'dine-in');
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
  }, [checks, taxCtx]);

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

  if (checks.length === 0) return <EmptyState icon="💰" message="No checks in this period."/>;
  if (taxRates.length === 0) return <EmptyState icon="💰" message="No tax rates configured. Set them up under Settings → Tax to see breakdowns here."/>;

  return (
    <div>
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
