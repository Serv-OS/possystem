// v4.6.21: Tax report (replaces LegacyTax).
//
// 8 Oct 2026 (the VAT audit, Peter: "VAT despite the order type should follow the Tax rules set
// on the back office per menu item"): the report reads a sale's VAT by the ONE rule every report
// shares (supabase/functions/_shared/saleVat.js):
//   - VAT on sales is what each sale BOOKED (tax_amount), never a recompute;
//   - refunds take their VAT off on the day the refund was made (the app's refund VAT rule),
//     so this screen, Daily trading, the Owner app and Xero agree; a refund made in the range on
//     a sale closed before it is read too (useRefundLookback, 8 Oct 2026 review);
//   - a sale with no VAT recorded counts 0 AND is named in red, never a silent 0;
//   - a sale whose VAT did not come straight from its item rule (a line that took the venue
//     default, a record the save guard repaired, a figure the server booked) is named;
//   - the split by rate is read from the record each sale stored (what was booked), and only
//     recomputed through the till's engine for an older sale with no record;
//   - each rate is named by its name (every rate used to read "Unrated").
// Until the owner decides the loyalty question with his accountant (D1), the figures include the
// VAT booked on goods given as loyalty rewards, and the screen says so with the amount.

import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../../store';
import { fetchRefundChecksBefore } from '../../../lib/db';
import { recordedCheckTax } from '../../../lib/taxCompute';
import { StatTile, ExportBtn, EmptyState } from './_charts';
import { toCsv, downloadCsv } from './_csv';
import { isSplit, sumFields } from '../../../lib/reportSplit.js';
import { siteTaxAnalysis, taxSourceNote, siteCheckTax, taxAnalysisOf } from '../../../lib/reportSiteMenu.js';
import { noVatLine, noRecordLine, flaggedLines, LOYALTY_VAT_LINE, toAccountingRow } from '../../../../supabase/functions/_shared/saleVat.js';
import { creditTaxMinor } from '../../../../supabase/functions/_shared/accountingDay.js';
import { useParts, exportSites } from './_siteSplit';
import { useSiteMenus, useOtherSiteMenu } from './_siteMenus';
import { SplitHeader, Blocks, SiteRows, SiteMatrix } from './SiteSplit';

// One empty list, so a view with nothing to show does not rebuild its tables every render.
const NONE = Object.freeze([]);
// The report range as ms (BOReports hands Dates), so a refund is placed on the day it was made.
const toMs = (v) => (v == null ? null : typeof v === 'number' ? v : v instanceof Date ? v.getTime() : Number.isFinite(Date.parse(v)) ? Date.parse(v) : null);

/**
 * 8 Oct 2026 (review): the checks of each site closed BEFORE the range that carry a refund
 * (lib/db.js fetchRefundChecksBefore, 400 days back as Daily trading and Xero reach). The rows
 * BOReports hands this report are the checks CLOSED in the range, so a refund made inside the
 * range on an older sale was in none of them and was never taken off here, while Daily trading,
 * the Owner app and Xero took it off on the refund's day. Only their refunds are read (the shared
 * ledger's refundRows); their sales are not the range's. { rows: { [siteId]: checks[] }, failed:
 * siteId[] } for the ids given; an empty id list reads nothing.
 */
function useRefundLookback(siteIds, rangeFrom) {
  const key = (siteIds || []).filter(Boolean).map(String).join(',');
  const fromMs = toMs(rangeFrom);
  const [read, setRead] = useState({ key: '', fromMs: null, rows: {}, failed: [] });
  useEffect(() => {
    if (!key || fromMs == null) { setRead({ key, fromMs, rows: {}, failed: [] }); return undefined; }
    let alive = true;
    const ids = key.split(',');
    Promise.all(ids.map((id) => fetchRefundChecksBefore(id, new Date(fromMs), { stop: () => !alive }).catch((e) => ({ data: null, error: e })))).then((results) => {
      if (!alive) return;
      const rows = {}, failed = [];
      results.forEach((r, i) => { if (r && Array.isArray(r.data) && !r.error) rows[ids[i]] = r.data; else failed.push(ids[i]); });
      setRead({ key, fromMs, rows, failed });
    });
    return () => { alive = false; };
  }, [key, fromMs]);
  const ready = read.key === key && read.fromMs === fromMs;
  return { rows: ready ? read.rows : {}, failed: ready ? read.failed : [], loading: !ready };
}

// 5 Oct 2026 (Peter: "make every report we have multi site when sites are connected
// together"): with more than one site on screen this is the site split at the foot of the
// file, each site's checks taxed on ITS OWN record or rates, never the signed in site's
// (src/lib/reportSiteMenu.js). One site is the report exactly as it was.
export default function Tax(props) {
  return isSplit(props.sites) ? <TaxSites {...props}/> : <TaxOne {...props}/>;
}

/** The VAT booked on goods paid with loyalty or promo credit (the accounting layer's discount parts), major units. */
function loyaltyVatOf(checks) {
  let minor = 0;
  for (const c of checks) {
    if (!c || c.status === 'voided') continue;
    try { minor += creditTaxMinor(toAccountingRow(c)); } catch { /* an odd row: nothing to add */ }
  }
  return minor / 100;
}

/** The red and amber lines under the tiles: what the figures leave out or had to fill in. */
function VatNotes({ ledger, loyaltyVat, fmt, hasRates }) {
  const red = [noVatLine(ledger), noRecordLine(ledger)].filter(Boolean);
  const amber = flaggedLines(ledger);
  const mismatch = (ledger.mismatched || []).map((m) => `${m.ref || m.id}: ${m.reason}`);
  return (
    <div style={{ marginBottom: 14, fontSize: 12, lineHeight: 1.7 }}>
      {hasRates && red.map((l) => <div key={l} style={{ color: 'var(--red)', fontWeight: 700 }}>{l}</div>)}
      {amber.map((l) => <div key={l} style={{ color: 'var(--amber)' }}>{l}</div>)}
      {mismatch.map((l) => <div key={l} style={{ color: 'var(--amber)' }}>{l}</div>)}
      {ledger.refundsEstimated > 0 && (
        <div style={{ color: 'var(--t4)' }}>{ledger.refundsEstimated === 1 ? '1 refund saved no VAT figure; its share of the sale\'s VAT is used.' : `${ledger.refundsEstimated} refunds saved no VAT figure; their share of each sale's VAT is used.`}</div>
      )}
      <div style={{ color: 'var(--t4)' }}>{LOYALTY_VAT_LINE}{loyaltyVat > 0 ? ` ${fmt(loyaltyVat)} of the VAT on sales is on goods paid with rewards.` : ''}</div>
    </div>
  );
}

function TaxOne({ checks, fmt, sites, rangeFrom, rangeTo, locationId = null }) {
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
  const range = useMemo(() => ({ fromMs: toMs(rangeFrom), toMs: toMs(rangeTo) }), [rangeFrom, rangeTo]);
  // The site these rows belong to: the one other site ticked, else the signed in site (BOReports
  // hands its id). Its older refund bearing checks feed the refund side of the ledger.
  const siteId = other.other ? String(other.site.id) : (locationId ? String(locationId) : null);
  const lookback = useRefundLookback(siteId ? [siteId] : [], rangeFrom);
  const refundRows = (siteId && lookback.rows[siteId]) || NONE;

  const analysis = useMemo(() => {
    const a = taxAnalysisOf(checks, taxOf, { range, hasRates: taxRates.length > 0, refundRows });
    return { ...a, loyaltyVat: loyaltyVatOf(checks) };
    // taxOf follows taxCtx and other.menu
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checks, taxCtx, other.menu, range, taxRates.length, refundRows]);

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

  const { ledger } = analysis;
  const varianceNames = analysis.varianceSales.map((v) => `${v.ref || v.id} ${v.diff > 0 ? '+' : ''}${v.diff.toFixed(2)}`).join(', ');

  return (
    <div>
      {other.other && (other.failed || !other.menu?.taxLoaded) && (
        <div style={{ marginBottom:10, fontSize:11, color:'var(--amber)' }}>{other.site.name}: the tax rates could not be read, so each check shows the tax stored on it with no rate breakdown.</div>
      )}
      {siteId && lookback.failed.includes(siteId) && (
        <div style={{ marginBottom:10, fontSize:11, color:'var(--amber)' }}>Refunds made in this period on sales closed before it could not be read, so VAT refunded may be short.</div>
      )}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:10, marginBottom:12 }}>
        <StatTile label="VAT on sales"     value={fmt(ledger.salesVat)} color="var(--acc)" sub={`${ledger.count} sales${ledger.noVatCount ? ` · ${ledger.noVatCount} with no VAT` : ''}`}/>
        <StatTile label="VAT refunded"     value={fmt(ledger.refundVat)} color={ledger.refundVat > 0 ? 'var(--red)' : 'var(--t1)'} sub="refunds made in this period"/>
        <StatTile label="VAT due"          value={fmt(ledger.vatDue)} color="var(--acc)" sub="sales less refunds"/>
        <StatTile label="Variance"         value={fmt(Math.abs(analysis.variance))} color={Math.abs(analysis.variance) > 0.5 ? 'var(--red)' : 'var(--t1)'} sub={varianceNames ? `booked vs item rules: ${varianceNames}` : 'booked vs item rules'}/>
      </div>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:10, marginBottom:14 }}>
        <StatTile label="Net of tax"       value={fmt(analysis.totalNet)}/>
        <StatTile label="Effective rate"   value={`${analysis.effectiveTaxRate.toFixed(2)}%`} sub="tax ÷ net"/>
        <StatTile label="Gross"            value={fmt(analysis.totalGross)}/>
        <StatTile label="Rate records"     value={`${analysis.sources.booked}`} sub={`of ${ledger.count} sales stored their split by rate`}/>
      </div>

      <VatNotes ledger={ledger} loyaltyVat={analysis.loyaltyVat} fmt={fmt} hasRates={taxRates.length > 0}/>

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
        ⓘ VAT on sales is what each sale booked when it was saved (the Back Office item rules, per order type). Refunds come off on the day the refund was made, the same as Daily trading, the Owner app and Xero. The split by rate is the record each sale stored; an older sale with no record is worked out again through the till's engine. Variance is the VAT booked against the item rules as they are today, and names the sales behind it. A sale with no VAT recorded is shown in red and counted as 0, never hidden.
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Several sites. The tax of a check is, in order: what the check booked (its stored record, a
// US added-on record, a scaled UK record), the check's OWN site's rates and profiles through
// the same seam the till ran, and when those could not be read, the tax_amount stored on the
// check (a total with no rate breakdown, and the site's line says so). The signed in site's
// rates are never used for another site's rows. A rate is matched across sites on its name,
// percentage and kind, so Leeds' and Preston's "Standard Rate 20% inclusive" are one line.
// ─────────────────────────────────────────────────────────────────────────────
function TaxSites(props) {
  const { fmtN, rangeFrom, rangeTo } = props;
  const { parts, blocks } = useParts(props);
  const { menus, loading, failed } = useSiteMenus(parts);
  const range = useMemo(() => ({ fromMs: toMs(rangeFrom), toMs: toMs(rangeTo) }), [rangeFrom, rangeTo]);
  // Each site's older refund bearing checks (8 Oct 2026 review), for the refund side only.
  const lookback = useRefundLookback(parts.map(p => p.id), rangeFrom);
  const bySite = useMemo(() => new Map(parts.map(p => [p.id, { ...siteTaxAnalysis(p.rows, menus[p.id] || null, { range, refundRows: lookback.rows[String(p.id)] || NONE }), loyaltyVat: loyaltyVatOf(p.rows) }])), [parts, menus, range, lookback.rows]);

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
  // 8 Oct 2026: a sale with no VAT recorded is named per site, in red, never a silent 0.
  const redNotes = parts.flatMap(p => {
    const l = bySite.get(p.id).ledger;
    return [noVatLine(l), noRecordLine(l)].filter(Boolean).map((line) => `${p.name}: ${line}`);
  });
  const amberNotes = parts.flatMap(p => flaggedLines(bySite.get(p.id).ledger).map((line) => `${p.name}: ${line}`));
  const lookbackNotes = parts.filter(p => lookback.failed.includes(String(p.id))).map(p => `${p.name}: refunds made in this period on sales closed before it could not be read, so VAT refunded may be short.`);

  return (
    <div>
      <SplitHeader parts={parts} chips={false} onExport={onExport}>
        {notes.map(n => <div key={n} style={{ color:'var(--amber)' }}>{n}</div>)}
        {redNotes.map(n => <div key={n} style={{ color:'var(--red)', fontWeight:700 }}>{n}</div>)}
        {amberNotes.map(n => <div key={n} style={{ color:'var(--amber)' }}>{n}</div>)}
        {lookbackNotes.map(n => <div key={n} style={{ color:'var(--amber)' }}>{n}</div>)}
        <div style={{ color:'var(--t4)' }}>{LOYALTY_VAT_LINE}</div>
      </SplitHeader>
      <Blocks blocks={blocks}>{b => {
        const site = b.parts.map(p => ({ part: p, cells: bySite.get(p.id) }));
        const all = sumFields(site.map(x => x.cells), ['salesVat', 'refundVat', 'vatDue', 'totalDerivedTax', 'totalNet', 'totalGross', 'variance', 'loyaltyVat']);
        const eff = all.totalNet > 0 ? (all.totalDerivedTax / all.totalNet) * 100 : 0;
        const rateRows = rateMatrix(b.parts, p => bySite.get(p.id).rateRows);
        const typeRows = rateMatrix(b.parts, p => bySite.get(p.id).orderTypeRows.map(r => ({ ...r, key: r.orderType, label: r.orderType })));
        return (
          <>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:10, marginBottom:18 }}>
              <StatTile label="VAT on sales"   value={b.fmt(all.salesVat)} color="var(--acc)" sub={`${b.parts.length} site${b.parts.length === 1 ? '' : 's'}`}/>
              <StatTile label="VAT refunded"   value={b.fmt(all.refundVat)} color={all.refundVat > 0 ? 'var(--red)' : 'var(--t1)'} sub="refunds made in this period"/>
              <StatTile label="VAT due"        value={b.fmt(all.vatDue)} color="var(--acc)" sub={all.loyaltyVat > 0 ? `includes ${b.fmt(all.loyaltyVat)} on loyalty rewards` : 'sales less refunds'}/>
              <StatTile label="Variance"       value={b.fmt(Math.abs(all.variance))} color={Math.abs(all.variance) > 0.5 ? 'var(--red)' : 'var(--t1)'} sub={`booked vs item rules · eff. rate ${eff.toFixed(2)}%`}/>
            </div>
            <SiteRows block={b} rows={site} total={all} columns={[
              { label:'Net',         cell: (c, f) => f(c.totalNet) },
              { label:'VAT on sales', cell: (c, f) => f(c.salesVat), color:'var(--acc)' },
              { label:'Refunded',    cell: (c, f) => <span style={{ color: c.refundVat > 0 ? 'var(--red)' : undefined }}>{f(c.refundVat)}</span> },
              { label:'VAT due',     cell: (c, f) => f(c.vatDue), color:'var(--acc)' },
              { label:'No VAT',      cell: c => <span style={{ color: c.ledger?.noVatCount ? 'var(--red)' : undefined }}>{c.ledger?.noVatCount || 0}</span> },
              { label:'Variance',    cell: (c, f) => <span style={{ color: Math.abs(c.variance) > 0.5 ? 'var(--red)' : undefined }}>{f(Math.abs(c.variance))}</span> },
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
        ⓘ Each site's checks are read on their own record or their own site's rates, through the same tax engine the till used; the signed in site's rates are never applied to another site. A rate with the same name, percentage and kind at two sites is one line. VAT on sales is what each sale booked; refunds come off on the day they were made; a sale with no VAT recorded is named in red. Variance is VAT booked against the item rules, per site.
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

