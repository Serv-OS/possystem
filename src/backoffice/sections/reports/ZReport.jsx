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

import { useRef, useMemo } from 'react';
import { useStore } from '../../../store';
import { computeOrderTaxUnified } from '../../../lib/taxCompute';
import { computeSalesStats } from './SalesSummary';
import { ExportBtn } from './_charts';

const ROW = { display:'flex', justifyContent:'space-between', padding:'3px 0', fontSize:11, lineHeight:1.5 };
const DIV = { borderTop:'1px dashed currentColor', margin:'8px 0' };
const BOLD = { fontWeight:700 };

function formatDate(ts) {
  return new Date(ts).toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' });
}
function formatTime(ts) {
  return new Date(ts).toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' });
}

export default function ZReport({ checks, periodLabelText, rangeFrom, rangeTo, fmt, fmtN }) {
  const { locationProfile, taxRates = [], shift } = useStore();
  const receiptRef = useRef(null);

  const stats = useMemo(() => computeSalesStats(checks), [checks]);

  // Payment method breakdown
  const byMethod = useMemo(() => {
    const m = {};
    checks.filter(c => c.status !== 'voided').forEach(c => {
      const key = (c.method || 'other').toLowerCase();
      if (!m[key]) m[key] = { method: key, count: 0, total: 0, tips: 0 };
      m[key].count++;
      m[key].total += c.total || 0;
      m[key].tips  += c.tip   || 0;
    });
    return Object.values(m).sort((a, b) => b.total - a.total);
  }, [checks]);

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
      try { res = computeOrderTaxUnified(c.items || [], taxCtx, c.orderType || 'dine-in'); } catch { return; }
      (res?.breakdown || []).forEach(b => {
        const key = b.rate?.id ?? 'per-unit';
        if (!m[key]) {
          const src = b.rate ? (taxRates.find(r => r.id === b.rate.id) || b.rate) : null;
          m[key] = {
            label: src ? (src.label || `${((Number(src.rate) || 0) * 100).toFixed(0)}%`) : 'Per-unit levy',
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

  const voidCount = checks.filter(c => c.status === 'voided').length;
  const refundCount = checks.reduce((s, c) => s + (c.refunds?.length || 0), 0);
  const discountCount = checks.reduce((s, c) => s + (c.discounts?.length || 0), 0);

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
        {rangeFrom && <div style={ROW}><span>From</span><span>{formatDate(rangeFrom)} {formatTime(rangeFrom)}</span></div>}
        {rangeTo   && <div style={ROW}><span>To</span><span>{formatDate(rangeTo)} {formatTime(rangeTo)}</span></div>}
        <div style={ROW}><span>Printed</span><span>{formatDate(printedAt)} {formatTime(printedAt)}</span></div>

        <div style={DIV}/>

        {/* Sales ladder */}
        <div style={{ fontSize:11, fontWeight:700, color:'var(--t2)', letterSpacing:'.06em', marginBottom:4 }}>SALES</div>
        <div style={ROW}><span>Checks closed</span><span>{fmtN(stats.count)}</span></div>
        <div style={ROW}><span>Covers</span><span>{fmtN(stats.covers)}</span></div>
        <div style={ROW}><span>Gross sales</span><span>{fmt(stats.gross)}</span></div>
        {stats.discounts > 0 && <div style={ROW}><span>less Discounts ({discountCount})</span><span style={{ color:'var(--acc)' }}>−{fmt(stats.discounts)}</span></div>}
        {stats.voids > 0     && <div style={ROW}><span>less Voids ({voidCount})</span><span style={{ color:'var(--red)' }}>−{fmt(stats.voids)}</span></div>}
        {stats.refunds > 0   && <div style={ROW}><span>less Refunds ({refundCount})</span><span style={{ color:'var(--red)' }}>−{fmt(stats.refunds)}</span></div>}
        <div style={{ ...ROW, ...BOLD }}><span>Net sales</span><span>{fmt(stats.net)}</span></div>

        <div style={DIV}/>

        {/* Tax */}
        <div style={{ fontSize:11, fontWeight:700, color:'var(--t2)', letterSpacing:'.06em', marginBottom:4 }}>TAX</div>
        {taxByRate.length === 0 && <div style={ROW}><span>Total tax</span><span>{fmt(stats.tax)}</span></div>}
        {taxByRate.map(r => (
          <div key={r.label} style={ROW}><span>{r.label} on {fmt(r.net)}</span><span>{fmt(r.tax)}</span></div>
        ))}
        {taxByRate.length > 0 && <div style={{ ...ROW, ...BOLD, marginTop:4 }}><span>Total tax</span><span>{fmt(stats.tax)}</span></div>}

        {(stats.service > 0 || stats.tips > 0) && (
          <>
            <div style={DIV}/>
            <div style={{ fontSize:11, fontWeight:700, color:'var(--t2)', letterSpacing:'.06em', marginBottom:4 }}>SERVICE &amp; TIPS</div>
            {stats.service > 0 && <div style={ROW}><span>Service charge</span><span>{fmt(stats.service)}</span></div>}
            {stats.tips    > 0 && <div style={ROW}><span>Tips</span><span>{fmt(stats.tips)}</span></div>}
          </>
        )}

        <div style={DIV}/>
        <div style={{ ...ROW, ...BOLD, fontSize:13 }}><span>GRAND TOTAL</span><span>{fmt(stats.total)}</span></div>
        <div style={DIV}/>

        {/* Payment methods */}
        <div style={{ fontSize:11, fontWeight:700, color:'var(--t2)', letterSpacing:'.06em', marginBottom:4 }}>PAYMENT METHODS</div>
        {byMethod.length === 0 ? (
          <div style={{ ...ROW, color:'var(--t4)' }}><span>No payments</span><span>—</span></div>
        ) : byMethod.map(m => (
          <div key={m.method} style={ROW}>
            <span>{m.method} ({m.count})</span>
            <span>{fmt(m.total)}</span>
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
          const cash = byMethod.find(m => m.method === 'cash');
          const cashTotal = cash?.total || 0;
          const cashTips  = cash?.tips  || 0;
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
