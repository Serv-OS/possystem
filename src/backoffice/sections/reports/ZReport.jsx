// v4.6.21: Z-report (end-of-day printable snapshot).
//
// Single column receipt-style layout designed to print cleanly on:
//   - Sunmi 80mm thermal printer (via browser print dialog, paper size 80x297mm)
//   - Standard A4 when "Save as PDF" is chosen
//
// The @media print CSS in globals.css shows only #zreport-print-area and hides
// the rest of the app chrome. Everything on this report is visible pre-print
// so the user can review before hitting print.
//
// Integrates with the existing shift state — reads shift.zNumber for the
// sequence if available, otherwise shows "—" and the user can log it manually.
//
// v5.10.3: From, To and Printed are the VENUE's dates and times (range.timeZone), with
// the zone named on the slip. Until then they were the browser's, so from California a
// London day printed "From 26 Sep 22:30".
//
// 16 Oct 2026: the SALES block, the payments and Money collected are read by THE ONE SALES RULE
// (src/lib/salesBreakdown.js through lib/shiftReport.js summariseShift, the till's own X and Z
// slip), so Net sales excluding VAT is the Business summary's, Daily trading's and the Owner
// app's figure to the penny. Until today Net sales was the stored subtotal less discounts: VAT
// inside, free loyalty drinks counted (Huddersfield 16 Oct: 2,085.10 against 1,703.30), and the
// GRAND TOTAL counted a loyalty reward as money. Older sales' refunds made inside the range come
// off, as in the Business summary. The TAX block by rate is unchanged (the Tax summary's reading,
// which includes VAT on loyalty rewards until Peter decides that with his accountant); the slip
// says so with the amount.

import { useRef, useMemo } from 'react';
import { useStore } from '../../../store';
import { recordedCheckTax } from '../../../lib/taxCompute';
import { venueZone } from '../../../../supabase/functions/_shared/businessDay.js';
import { venueZoneLabel } from '../../../lib/payments/venueTime';
import { computeSalesStats } from './SalesSummary';
import { vatMissingLine } from '../../../lib/salesStats';
import { breakdownLines, rewardsVatLine } from '../../../lib/salesBreakdown';
import { summariseShift } from '../../../lib/shiftReport';
import { applyFilters } from './_filters';
import { useRefundLookback, toMs } from './_refundLookback';
import { ExportBtn } from './_charts';
import ZReportGroups from './ZReportGroups';

const ROW = { display:'flex', justifyContent:'space-between', padding:'3px 0', fontSize:11, lineHeight:1.5 };
const DIV = { borderTop:'1px dashed currentColor', margin:'8px 0' };
const BOLD = { fontWeight:700 };
const NONE = Object.freeze([]);

function formatDate(ts, timeZone) {
  return new Date(ts).toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric', timeZone });
}
function formatTime(ts, timeZone) {
  return new Date(ts).toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit', timeZone });
}

// timeZone = range.timeZone (the venue's; none = London, never the browser's).
// sites, locationId, filters, locationConfig: the site on screen, the signed in site, the report's
// filters and its config, so refunds made in the range on older sales come off as in the Business
// summary, read for the same site the same way (16 Oct 2026).
export default function ZReport({ checks, periodLabelText, rangeFrom, rangeTo, timeZone, fmt, fmtN, scope, sites, locationId, filters, locationConfig }) {
  const { locationProfile, taxRates = [], shift } = useStore();
  const tz = venueZone(timeZone);
  const receiptRef = useRef(null);

  // The TAX block's total and its no VAT warning (the Tax summary's reading, unchanged).
  const stats = useMemo(() => computeSalesStats(checks), [checks]);

  // 16 Oct 2026: sales, payments and Money collected by the one sales rule (the Business summary's).
  const one = Array.isArray(sites) && sites.length === 1 ? sites[0] : null;
  const siteId = one && !one.isHome ? String(one.id) : (locationId ? String(locationId) : null);
  const lookback = useRefundLookback(siteId ? [siteId] : [], rangeFrom ?? null);
  const refundRows = useMemo(() => applyFilters((siteId && lookback.rows[siteId]) || NONE, filters), [siteId, lookback.rows, filters]);
  const range = useMemo(() => (rangeFrom != null ? { fromMs: toMs(rangeFrom), toMs: toMs(rangeTo) } : null), [rangeFrom, rangeTo]);
  const currency = locationConfig?.currency || one?.currency || null;
  const { sales, payments } = useMemo(() => summariseShift(checks, { range, refundRows, currency }), [checks, range, refundRows, currency]);
  const lines = useMemo(() => breakdownLines(sales), [sales]);

  // Order type breakdown
  const byOrderType = useMemo(() => {
    const m = {};
    checks.filter(c => c.status !== 'voided').forEach(c => {
      const key = c.orderType || 'dine-in';
      if (!m[key]) m[key] = { type: key, count: 0, total: 0 };
      m[key].count++;
      m[key].total += c.total || 0;
    });
    return Object.values(m).sort((a, b) => b.total - a.total);
  }, [checks]);

  // Tax by rate — v5.7.34: derived through the UNIFIED SEAM per check (the same
  // engine every till charges with), replacing an inline per-item fork that had
  // NO default-rate fallback: items on "Use default" (taxRateId null) booked
  // zero here, so the Z report UNDERSTATED tax for default-rated items. The
  // seam resolves the venue default (and per-order-type overrides, and tax
  // profiles) exactly as the point of sale does. Read shape unchanged:
  // [{ label, rate, tax, net, gross }].
  const taxCtx = useStore(s => s.getTaxContext());
  const taxByRate = useMemo(() => {
    const m = {};
    checks.filter(c => c.status !== 'voided').forEach(c => {
      let res = null;
      // v5.9.12: the tax the check CHARGED when it stored one (US), else the seam.
      try { res = recordedCheckTax(c, taxCtx); } catch { return; }
      (res?.breakdown || []).forEach(b => {
        const key = b.rate?.id ?? 'per-unit';
        if (!m[key]) {
          const src = b.rate ? (taxRates.find(r => r.id === b.rate.id) || b.rate) : null;
          m[key] = {
            // 8 Oct 2026: a rate is named by its name (rows carry name, never label: every line read as a bare "20%").
            label: src ? (src.name || src.label || `${((Number(src.rate) || 0) * 100).toFixed(0)}%`) : 'Per-unit levy',
            rate: src ? Number(src.rate) || 0 : null,
            tax: 0, net: 0, gross: 0,
          };
        }
        m[key].tax   += b.tax   || 0;
        m[key].net   += b.net   || 0;
        m[key].gross += b.gross || 0;
      });
    });
    return Object.values(m).filter(r => r.gross > 0).sort((a, b) => b.gross - a.gross);
  }, [checks, taxCtx, taxRates]);

  const discountCount = checks.reduce((s, c) => s + (c.discounts?.length || 0), 0);
  const countFor = { voids: sales.voidCount, refunds: sales.refundCount, discounts: discountCount };
  const toneFor = { voids: 'var(--red)', refunds: 'var(--red)', discounts: 'var(--acc)', rewards: 'var(--acc)' };
  const rewardsNote = rewardsVatLine(sales, fmt);

  const printedAt = Date.now();
  const zNumber = shift?.zNumber || '—';
  const locName = locationProfile?.name || locationProfile?.label || 'POSUP';

  const handlePrint = () => {
    // Use native print dialog — user picks Sunmi thermal OR Save as PDF
    window.print();
  };

  return (
    <div>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:14, flexWrap:'wrap', gap:10 }}>
        <div style={{ fontSize:12, color:'var(--t3)' }}>Preview below. Click <strong style={{ color:'var(--t1)' }}>Print / Save PDF</strong> to send to the Sunmi thermal printer or save as a PDF.</div>
        <button onClick={handlePrint} className="z-no-print" style={{
          padding:'9px 18px', borderRadius:8, border:'1px solid var(--acc-b)',
          background:'var(--acc)', color:'var(--bg0)', fontSize:13, fontWeight:700, cursor:'pointer', fontFamily:'inherit',
          display:'inline-flex', alignItems:'center', gap:8,
        }}>
          <span>🖨</span>
          Print / Save PDF
        </button>
      </div>

      {/* Print area — centred, narrow, receipt-styled */}
      <div id="zreport-print-area" ref={receiptRef} style={{
        background:'var(--bg1)', color:'var(--t1)',
        maxWidth:360, margin:'0 auto', padding:'22px 20px',
        border:'1px solid var(--bdr)', borderRadius:8,
        fontFamily:'var(--font-mono)', lineHeight:1.45,
      }}>
        {/* Header */}
        <div style={{ textAlign:'center', marginBottom:8 }}>
          <div style={{ fontSize:14, fontWeight:800, letterSpacing:'.08em' }}>Z REPORT</div>
          <div style={{ fontSize:11, color:'var(--t3)', marginTop:2 }}>{locName}</div>
        </div>

        <div style={DIV}/>

        <div style={ROW}><span>Z number</span><span style={BOLD}>{zNumber}</span></div>
        <div style={ROW}><span>Period</span><span>{periodLabelText || 'today'}</span></div>
        {rangeFrom && <div style={ROW}><span>From</span><span>{formatDate(rangeFrom, tz)} {formatTime(rangeFrom, tz)}</span></div>}
        {rangeTo   && <div style={ROW}><span>To</span><span>{formatDate(rangeTo, tz)} {formatTime(rangeTo, tz)}</span></div>}
        <div style={ROW}><span>Printed</span><span>{formatDate(printedAt, tz)} {formatTime(printedAt, tz)}</span></div>
        <div style={ROW}><span>Times</span><span>{venueZoneLabel(tz)}</span></div>

        <div style={DIV}/>

        {/* Sales ladder */}
        <div style={{ fontSize:11, fontWeight:700, color:'var(--t2)', letterSpacing:'.06em', marginBottom:4 }}>SALES</div>
        <div style={ROW}><span>Checks closed</span><span>{fmtN(sales.count)}</span></div>
        <div style={ROW}><span>Covers</span><span>{fmtN(sales.covers)}</span></div>
        {/* The Business summary's ladder, line for line (lib/salesBreakdown.js breakdownLines). */}
        {lines.map(l => {
          const strong = l.kind === 'head' || l.kind === 'sub' || l.kind === 'total' || l.key === 'net';
          const n = countFor[l.key];
          const label = n != null && l.kind === 'less' ? `${l.label} (${n})` : l.label;
          return (
            <div key={l.key} style={{ ...ROW, ...(strong ? BOLD : null), ...(l.kind === 'of' ? { paddingLeft:10 } : null) }}>
              <span>{label}</span>
              <span style={l.value < 0 && toneFor[l.key] ? { color: toneFor[l.key] } : undefined}>{l.value < 0 ? `−${fmt(-l.value)}` : fmt(l.value)}</span>
            </div>
          );
        })}
        {lookback.failed.length > 0 && <div style={{ ...ROW, color:'var(--t4)' }}><span>Refunds on sales from before this period could not be read, so they are not taken off here.</span><span/></div>}
        {rewardsNote && <div style={{ ...ROW, color:'var(--t4)' }}><span>{rewardsNote}</span><span/></div>}
        <ZReportGroups checks={checks} fmt={fmt} siteId={scope?.homeId}/>

        <div style={DIV}/>

        {/* Tax */}
        <div style={{ fontSize:11, fontWeight:700, color:'var(--t2)', letterSpacing:'.06em', marginBottom:4 }}>TAX</div>
        {taxByRate.length === 0 && <div style={ROW}><span>Total tax</span><span>{fmt(stats.tax)}</span></div>}
        {taxByRate.map(r => (
          <div key={r.label} style={ROW}><span>{r.label} on {fmt(r.net)}</span><span>{fmt(r.tax)}</span></div>
        ))}
        {taxByRate.length > 0 && <div style={{ ...ROW, ...BOLD, marginTop:4 }}><span>Total tax</span><span>{fmt(stats.tax)}</span></div>}
        {/* 8 Oct 2026: a sale with no VAT recorded is counted 0 and named, never hidden. */}
        {stats.vatMissingCount > 0 && <div style={{ ...ROW, color:'var(--red)', fontWeight:700 }}><span>{vatMissingLine(stats)}</span><span/></div>}
        {/* 16 Oct 2026: this block includes the VAT on free loyalty rewards, the SALES VAT does not (Peter's open question, D1). */}
        {sales.rewardsTax >= 0.005 && <div style={{ ...ROW, paddingLeft:10 }}><span>of which on loyalty rewards</span><span>{fmt(sales.rewardsTax)}</span></div>}

        <div style={DIV}/>
        <div style={{ ...ROW, ...BOLD, fontSize:13 }}><span>MONEY COLLECTED</span><span>{fmt(sales.collected)}</span></div>
        <div style={DIV}/>

        {/* Payments: the money tenders, adding up to Money collected (a loyalty reward is never money). */}
        <div style={{ fontSize:11, fontWeight:700, color:'var(--t2)', letterSpacing:'.06em', marginBottom:4 }}>PAYMENTS</div>
        {payments.map(p => (
          <div key={p.kind}>
            <div style={ROW}><span>{p.label} ({p.count})</span><span>{fmt(p.amount)}</span></div>
            {Math.abs(p.tips) >= 0.005 && <div style={{ ...ROW, paddingLeft:10 }}><span>of which tips</span><span>{fmt(p.tips)}</span></div>}
          </div>
        ))}

        <div style={DIV}/>

        {/* Order types */}
        <div style={{ fontSize:11, fontWeight:700, color:'var(--t2)', letterSpacing:'.06em', marginBottom:4 }}>ORDER TYPES</div>
        {byOrderType.length === 0 ? (
          <div style={{ ...ROW, color:'var(--t4)' }}><span>No orders</span><span>—</span></div>
        ) : byOrderType.map(t => (
          <div key={t.type} style={ROW}>
            <span>{t.type} ({t.count})</span>
            <span>{fmt(t.total)}</span>
          </div>
        ))}

        <div style={DIV}/>

        {/* Cash reconciliation helper */}
        <div style={{ fontSize:11, fontWeight:700, color:'var(--t2)', letterSpacing:'.06em', marginBottom:4 }}>CASH DRAWER</div>
        {(() => {
          const cash = payments.find(p => p.kind === 'cash');
          const cashTotal = cash?.amount || 0;
          const cashTips  = cash?.tips   || 0;
          return (
            <>
              <div style={ROW}><span>Cash payments</span><span>{fmt(cashTotal)}</span></div>
              {cashTips > 0 && <div style={ROW}><span>of which cash tips</span><span>{fmt(cashTips)}</span></div>}
              <div style={{ ...ROW, ...BOLD }}><span>Expected in drawer</span><span>{fmt(cashTotal)}</span></div>
              <div style={ROW}><span>Counted</span><span style={{ color:'var(--t4)' }}>__________</span></div>
              <div style={ROW}><span>Variance</span><span style={{ color:'var(--t4)' }}>__________</span></div>
            </>
          );
        })()}

        <div style={DIV}/>

        {/* Sign-off */}
        <div style={{ fontSize:11, color:'var(--t3)', lineHeight:1.7, marginTop:8 }}>
          <div>Manager name: ____________________</div>
          <div style={{ marginTop:4 }}>Signature: ____________________</div>
        </div>

        <div style={{ textAlign:'center', marginTop:14, fontSize:10, color:'var(--t4)' }}>
          POSUP · End of day
        </div>
      </div>

      <div style={{ marginTop:14, padding:'10px 12px', background:'var(--bg3)', border:'1px dashed var(--bdr)', borderRadius:8, fontSize:11, color:'var(--t4)', lineHeight:1.7 }}>
        ⓘ Print dialog: pick your Sunmi printer for the thermal 80mm receipt, or "Save as PDF" for archival. Cash drawer variance is hand-written after counting. Future: Z number auto-increments once we add a z_reports audit table.
      </div>
    </div>
  );
}
