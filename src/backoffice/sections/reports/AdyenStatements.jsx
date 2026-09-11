// src/backoffice/sections/reports/AdyenStatements.jsx
// ServOS Payments — Documents tab (v5.6.99). Pick a month; render a clean
// statement and a Print button (the browser's print-to-PDF is the delivery
// mechanism for now). Data via adyen-financial action 'statement'.
//
// VENUE FEES (11 Sep 2026). The fees line is the venue's card rate fee on each
// payment, stamped when the payment is authorised and reduced by any refund.
// It never shows Adyen's own cost to the platform, so a statement no longer
// waits for settlement reports: any month with card payments has one. You
// receive shows a dash while any payment has no fee on record, the same rule
// as the Payments and Payouts tabs.
// TIMES: the month runs on the venue clock. The server picks the opening month
// (the venue's current month, never the viewer's or London's) and says what
// the current month is; the picker lists the 24 months back from it. A
// <select>, not <input type="month">, which Safari on Mac shows as a text box.

import { useEffect, useRef, useState } from 'react';
import { supabase, isMock, getLocationId } from '../../../lib/supabase';
import { EmptyState } from './_charts';
import { money } from '../../../lib/currency';
import { formatMonthLabel, formatVenueLongDate, recentMonths, venueZoneLabel } from '../../../lib/payments/venueTime';

const FEE_NOTE = 'Some payments have no fee on record yet, so the total is not ready.';
const BAD_MONTH = 'Pick a month from the list.';

export default function AdyenStatements() {
  const [tz, setTz] = useState('Europe/London');
  // '' until the first answer: the server opens on the venue's current month.
  const [month, setMonth] = useState('');
  const [maxMonth, setMaxMonth] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // The month the last answer was for, so adopting the server's month does
  // not fetch it a second time.
  const loadedRef = useRef('');

  const load = async (ym) => {
    setLoading(true); setError('');
    try {
      if (isMock) { setData({ mock: true }); return; }
      const locId = await getLocationId().catch(() => null);
      const { data: session } = await supabase.auth.getSession();
      const token = session?.session?.access_token;
      if (!token) throw new Error('Please sign in again.');
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/adyen-financial`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: 'statement', ops_location_id: locId, month: ym || undefined }),
      });
      const j = await res.json();
      if (j.current_month) setMaxMonth(j.current_month);
      if (!res.ok || j.error) {
        throw new Error(/month must be/i.test(String(j.error || '')) ? BAD_MONTH : (j.error || `HTTP ${res.status}`));
      }
      if (j.timezone) setTz(j.timezone);
      if (j.month) {
        loadedRef.current = j.month;
        if (!ym) setMonth(j.month);
      }
      setData(j);
    } catch (e) { setError(e.message || 'Failed to load'); setData(null); }
    finally { setLoading(false); }
  };
  useEffect(() => {
    if (month && month === loadedRef.current) return;
    load(month);
  }, [month]);

  const cur = data?.currency || 'GBP';
  const m = (minor) => (minor == null ? '—' : money((Number(minor) || 0) / 100, cur));
  const shownMonth = data?.month || month;
  const hasPayments = (Number(data?.payments_count) || 0) > 0;
  const partial = !!data?.fee_coverage && data.fee_coverage.with_fees < data.fee_coverage.payments;
  const zoneNote = `The month runs on ${venueZoneLabel(tz)} time.`;

  const monthOptions = recentMonths(maxMonth, 24);
  if (month && !monthOptions.includes(month)) monthOptions.unshift(month);

  const rows = data && hasPayments ? [
    ['Card payments taken', String(data.payments_count ?? 0)],
    ['Gross card takings', m(data.gross_minor)],
    ['Refunds', data.refunds_minor ? `- ${m(data.refunds_minor)}` : m(0)],
    ...(data.gratuity_minor ? [['Of which tips', m(data.gratuity_minor)]] : []),
    ['Fees on your card rates', data.fees_minor != null ? `- ${m(data.fees_minor)}` : '—'],
  ] : [];

  // Print window: a self-contained page, so print-to-PDF captures ONLY the
  // statement, never the Back Office chrome around it.
  const printStatement = () => {
    if (!data) return;
    const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const line = (label, value, strong = false) => `
      <tr${strong ? ' class="strong"' : ''}><td>${esc(label)}</td><td class="num">${esc(value)}</td></tr>`;
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>ServOS Payments statement, ${esc(formatMonthLabel(shownMonth))}</title>
      <style>
        body { font-family: -apple-system, 'Segoe UI', Roboto, sans-serif; color: #111; margin: 48px; }
        h1 { font-size: 20px; margin: 0 0 2px; }
        .sub { color: #555; font-size: 13px; margin-bottom: 28px; }
        table { width: 100%; max-width: 560px; border-collapse: collapse; font-size: 14px; }
        td { padding: 9px 4px; border-bottom: 1px solid #e3e3e3; }
        td.num { text-align: right; font-variant-numeric: tabular-nums; }
        tr.strong td { font-weight: 700; border-top: 2px solid #111; border-bottom: none; }
        .note { color: #666; font-size: 11.5px; margin-top: 26px; max-width: 560px; line-height: 1.5; }
      </style></head><body>
      <h1>${esc(data.venue || 'Venue')}</h1>
      <div class="sub">ServOS Payments statement · ${esc(formatMonthLabel(shownMonth))}</div>
      <table>
        ${rows.map(([label, value]) => line(label, value)).join('')}
        ${line('You receive', m(data.net_minor), true)}
      </table>
      <div class="note">
        ${partial ? `${esc(FEE_NOTE)}<br>` : ''}
        Fees are what you paid on your card rates.
        ${esc(zoneNote)}
        Generated by ServOS on ${esc(formatVenueLongDate(new Date(), tz))}.
      </div>
      </body></html>`;
    const w = window.open('', '_blank', 'width=800,height=900');
    if (!w) { setError('The print window was blocked. Allow pop-ups for this site and try again.'); return; }
    w.document.write(html);
    w.document.close();
    w.focus();
    w.print();
  };

  return (
    <div style={{ padding: '4px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--t1)' }}>Monthly statement</div>
        {monthOptions.length > 0 && (
          <select
            aria-label="Month"
            value={shownMonth}
            disabled={loading}
            onChange={(e) => { if (e.target.value) setMonth(e.target.value); }}
            style={{ padding: '7px 10px', borderRadius: 8, border: '1px solid var(--bdr)', background: 'var(--bg1)', color: 'var(--t1)', fontSize: 13, fontFamily: 'inherit', cursor: 'pointer' }}
          >
            {monthOptions.map((ym) => <option key={ym} value={ym}>{formatMonthLabel(ym)}</option>)}
          </select>
        )}
        {hasPayments && (
          <button onClick={printStatement} style={{ padding: '7px 14px', borderRadius: 8, background: 'var(--acc)', border: 'none', color: '#fff', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>
            Print / save as PDF
          </button>
        )}
      </div>

      {loading && <div style={{ padding: 24, color: 'var(--t3)' }}>Building statement…</div>}
      {!loading && error && <EmptyState icon="⚠️" message={error} />}
      {!loading && !error && data?.mock && <EmptyState icon="📄" message="Statements are live only. View them on the deployed app." />}

      {!loading && !error && data && !data.mock && !hasPayments && (
        <EmptyState icon="📄" message={`No card payments in ${formatMonthLabel(shownMonth)}.`} />
      )}

      {!loading && !error && data && !data.mock && hasPayments && (
        <div style={{ background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 12, padding: '22px 24px', maxWidth: 560 }}>
          <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--t1)' }}>{data.venue || 'This venue'}</div>
          <div style={{ fontSize: 12.5, color: 'var(--t3)', marginBottom: 16 }}>ServOS Payments statement · {formatMonthLabel(shownMonth)}</div>
          {rows.map(([label, value]) => (
            <div key={label} style={{ display: 'flex', justifyContent: 'space-between', padding: '9px 0', borderBottom: '1px solid var(--bdr)', fontSize: 13.5 }}>
              <div style={{ color: 'var(--t2)' }}>{label}</div>
              <div style={{ color: 'var(--t1)', fontVariantNumeric: 'tabular-nums' }}>{value}</div>
            </div>
          ))}
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '11px 0 2px', fontSize: 14.5, fontWeight: 800 }}>
            <div style={{ color: 'var(--t1)' }}>You receive</div>
            <div style={{ color: data.net_minor == null ? 'var(--t4)' : 'var(--grn)', fontVariantNumeric: 'tabular-nums' }}>{m(data.net_minor)}</div>
          </div>
          {partial && (
            <div style={{ fontSize: 11.5, color: 'var(--t3)', marginTop: 12, lineHeight: 1.5 }}>{FEE_NOTE}</div>
          )}
          <div style={{ fontSize: 11, color: 'var(--t4)', marginTop: 10 }}>{zoneNote}</div>
        </div>
      )}
    </div>
  );
}
