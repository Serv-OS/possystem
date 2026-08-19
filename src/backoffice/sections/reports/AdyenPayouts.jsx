// src/backoffice/sections/reports/AdyenPayouts.jsx
// ServOS Payments — Payouts tab (v5.6.99). Settlement batches for this venue
// from adyen_payouts / adyen_payout_lines (fed by adyen-report-ingest), served
// by the location-fenced adyen-financial fn (actions: payouts, payout_detail).
// Lightspeed parity: a payout list (date, gross, fees, net, batch) that clicks
// through to every transaction in the payout with its fee.
//
// Empty state is honest: payouts only exist once settlement reporting is
// switched on at the payment provider, so it walks the owner through the
// one-time Customer Area setup instead of pretending data is coming.

import { useEffect, useState } from 'react';
import { supabase, isMock, getLocationId } from '../../../lib/supabase';
import { EmptyState, ExportBtn, StatTile } from './_charts';
import { toCsv, downloadCsv } from './_csv';
import { money } from '../../../lib/currency';

const fmtDate = (d) => {
  if (!d) return '—';
  try { return new Date(`${d}T00:00:00`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }); }
  catch { return String(d); }
};
const fmtWhen = (iso) => {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); }
  catch { return '—'; }
};
const cardLabel = (card) => {
  if (!card) return '';
  const brand = card.brand ? String(card.brand).toUpperCase() : '';
  const last4 = card.last4 ? `···${card.last4}` : '';
  return `${brand}${brand && last4 ? ' ' : ''}${last4}`;
};
// Operator wording for report line types (code values stay in the raw data).
const lineTypeLabel = (t) => ({
  Settled: 'Payment', SettledExternally: 'Payment',
  Refunded: 'Refund', RefundedExternally: 'Refund', RefundedReversed: 'Refund reversed',
  Chargeback: 'Dispute', SecondChargeback: 'Dispute', ChargebackReversed: 'Dispute reversed',
  Fee: 'Service fee', MiscCosts: 'Service fee', InvoiceDeduction: 'Invoice deduction',
  PaymentCost: 'Service fee', SettleCost: 'Service fee',
  MerchantPayout: 'Paid to bank', DepositCorrection: 'Deposit correction',
  Balancetransfer: 'Balance transfer',
}[t] || t || '—');

// Shared with the Documents tab: the one-time setup that makes settlement
// reports (and therefore payouts, fees and statements) start flowing.
export function SettlementSetupSteps() {
  const steps = [
    'Log in to your payments provider dashboard (ca-test.adyen.com) with an admin account.',
    'Create a Report user: go to Developers, then API credentials, choose Create credential and pick Report user. Note the username and password it generates.',
    'Switch on the Settlement details report: go to Reports, find Settlement details and turn on automatic generation.',
    'In that report’s column settings, add two extra columns: Store and Gratuity amount.',
    'Send the Report user’s username and password to ServOS support. They are stored as secure server settings, never in the app.',
  ];
  return (
    <div style={{ background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 12, padding: 18, marginTop: 14 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)', marginBottom: 6 }}>
        One-time setup, about ten minutes
      </div>
      <ol style={{ margin: 0, paddingLeft: 20, fontSize: 12.5, color: 'var(--t2)', lineHeight: 1.7 }}>
        {steps.map((s, i) => <li key={i}>{s}</li>)}
      </ol>
      <p style={{ fontSize: 12, color: 'var(--t3)', margin: '10px 0 0', lineHeight: 1.5 }}>
        Once that is done, every settlement generates a report automatically and your payouts,
        per-payment fees and monthly statements fill themselves, usually the next working day.
      </p>
    </div>
  );
}

const th = { fontSize: 11, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.04em' };
const numCell = { fontWeight: 700, color: 'var(--t1)', textAlign: 'right' };

export default function AdyenPayouts() {
  const [payouts, setPayouts] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [detail, setDetail] = useState(null);      // { payout, lines }
  const [detailLoading, setDetailLoading] = useState(false);

  const call = async (payload) => {
    const locId = await getLocationId().catch(() => null);
    const { data: session } = await supabase.auth.getSession();
    const token = session?.session?.access_token;
    if (!token) throw new Error('Please sign in again.');
    const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/adyen-financial`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ ops_location_id: locId, ...payload }),
    });
    const j = await res.json();
    if (!res.ok || j.error) throw new Error(j.error || `HTTP ${res.status}`);
    return j;
  };

  const load = async () => {
    setLoading(true); setError('');
    try {
      if (isMock) { setPayouts([]); return; }
      const j = await call({ action: 'payouts' });
      setPayouts(j.payouts || []);
    } catch (e) { setError(e.message || 'Failed to load'); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const openDetail = async (p) => {
    setDetailLoading(true); setError('');
    try {
      const j = await call({ action: 'payout_detail', payout_id: p.id });
      setDetail(j);
    } catch (e) { setError(e.message || 'Failed to load payout detail'); }
    finally { setDetailLoading(false); }
  };

  const m = (minor, cur) => (minor == null ? '—' : money((Number(minor) || 0) / 100, cur || 'GBP'));

  if (loading && payouts == null) return <div style={{ padding: 24, color: 'var(--t3)' }}>Loading payouts…</div>;
  if (error && payouts == null) return <EmptyState icon="⚠️" message={error} />;

  // ── Drill-down: one payout, every transaction inside it ──────────────────
  if (detail) {
    const p = detail.payout || {};
    const lines = detail.lines || [];
    const cur = p.currency || 'GBP';
    const exportLines = () => {
      const headers = [
        { label: 'Type', key: (l) => lineTypeLabel(l.line_type) },
        { label: 'Date', key: (l) => fmtWhen(l.payment?.created_at) },
        { label: 'Card', key: (l) => cardLabel(l.payment?.card) },
        { label: 'Gross', key: (l) => ((Number(l.gross_minor) || 0) / 100).toFixed(2) },
        { label: 'Fee', key: (l) => ((Number(l.fee_minor) || 0) / 100).toFixed(2) },
        { label: 'Net', key: (l) => ((Number(l.net_minor) || 0) / 100).toFixed(2) },
        { label: 'Currency', key: (l) => l.currency || cur },
        { label: 'PSP reference', key: (l) => l.psp_reference || '' },
      ];
      downloadCsv(`servos-payout-${p.payout_date || p.id}.csv`, toCsv(lines, headers));
    };
    return (
      <div style={{ padding: '4px 0' }}>
        <button onClick={() => setDetail(null)} style={{ background: 'none', border: 'none', color: 'var(--acc)', cursor: 'pointer', fontSize: 12.5, fontWeight: 700, padding: 0, marginBottom: 12, fontFamily: 'inherit' }}>
          ‹ All payouts
        </button>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
          <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--t1)' }}>Payout, {fmtDate(p.payout_date)}</div>
          {p.batch_number != null && <div style={{ fontSize: 12, color: 'var(--t3)' }}>Batch {p.batch_number}</div>}
          {p.shared && <span style={{ fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: 'var(--bg3)', color: 'var(--t3)' }}>Your share of a shared payout</span>}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 12, marginBottom: 18 }}>
          <StatTile label="Gross" value={m(p.gross_minor, cur)} />
          <StatTile label="Fees" value={m(p.fees_minor, cur)} color="var(--amb,#e8a020)" />
          <StatTile label="Paid out" value={m(p.net_minor, cur)} color="var(--grn)" />
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--t1)' }}>
            {lines.length} line{lines.length === 1 ? '' : 's'} in this payout
          </div>
          {lines.length > 0 && <ExportBtn onClick={exportLines} />}
        </div>
        {lines.length === 0 ? (
          <EmptyState icon="🏦" message="No transaction lines recorded for this payout." />
        ) : (
          <div style={{ border: '1px solid var(--bdr)', borderRadius: 10, overflow: 'hidden' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1.1fr 1.2fr 1.1fr 0.8fr 0.8fr 0.8fr', padding: '9px 14px', background: 'var(--bg2)', ...th }}>
              <div>Type</div><div>Date</div><div>Card</div>
              <div style={{ textAlign: 'right' }}>Gross</div><div style={{ textAlign: 'right' }}>Fee</div><div style={{ textAlign: 'right' }}>Net</div>
            </div>
            {lines.map((l) => (
              <div key={l.id} style={{ display: 'grid', gridTemplateColumns: '1.1fr 1.2fr 1.1fr 0.8fr 0.8fr 0.8fr', fontSize: 13, padding: '9px 14px', borderTop: '1px solid var(--bdr)', alignItems: 'center' }}>
                <div style={{ color: 'var(--t2)', fontWeight: 600 }} title={l.line_type}>{lineTypeLabel(l.line_type)}</div>
                <div style={{ color: 'var(--t3)', fontSize: 12 }}>{fmtWhen(l.payment?.created_at)}</div>
                <div style={{ color: 'var(--t2)', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={l.psp_reference || ''}>
                  {cardLabel(l.payment?.card) || (l.psp_reference ? `…${String(l.psp_reference).slice(-6)}` : '—')}
                </div>
                <div style={{ ...numCell, color: (Number(l.gross_minor) || 0) < 0 ? 'var(--red)' : 'var(--t1)' }}>{m(l.gross_minor, l.currency)}</div>
                <div style={{ ...numCell, color: 'var(--amb,#e8a020)' }}>{(Number(l.fee_minor) || 0) !== 0 ? m(l.fee_minor, l.currency) : '—'}</div>
                <div style={{ ...numCell, color: (Number(l.net_minor) || 0) < 0 ? 'var(--red)' : 'var(--t1)' }}>{m(l.net_minor, l.currency)}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  // ── Payout list ──────────────────────────────────────────────────────────
  const rows = payouts || [];
  if (rows.length === 0) {
    return (
      <div style={{ padding: '4px 0' }}>
        <EmptyState icon="🏦" message="Payouts appear here once settlement reporting is switched on." />
        <SettlementSetupSteps />
      </div>
    );
  }

  const exportCsv = () => {
    const headers = [
      { label: 'Date', key: (p) => p.payout_date || '' },
      { label: 'Batch', key: (p) => (p.batch_number != null ? String(p.batch_number) : '') },
      { label: 'Gross', key: (p) => ((Number(p.gross_minor) || 0) / 100).toFixed(2) },
      { label: 'Fees', key: (p) => ((Number(p.fees_minor) || 0) / 100).toFixed(2) },
      { label: 'Net', key: (p) => ((Number(p.net_minor) || 0) / 100).toFixed(2) },
      { label: 'Currency', key: (p) => p.currency || 'GBP' },
      { label: 'Status', key: (p) => p.status || '' },
      { label: 'Shared batch', key: (p) => (p.shared ? 'yes' : 'no') },
    ];
    downloadCsv('servos-payouts.csv', toCsv(rows, headers));
  };

  return (
    <div style={{ padding: '4px 0' }}>
      {error && <div style={{ padding: 10, background: 'var(--red-d)', color: 'var(--red)', borderRadius: 8, fontSize: 12, border: '1px solid var(--red-b)', marginBottom: 14 }}>{error}</div>}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--t1)' }}>Payouts</div>
        <ExportBtn onClick={exportCsv} />
      </div>
      <div style={{ border: '1px solid var(--bdr)', borderRadius: 10, overflow: 'hidden' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 0.7fr 0.9fr 0.9fr 0.9fr 1fr 0.5fr', padding: '9px 14px', background: 'var(--bg2)', ...th }}>
          <div>Date</div><div>Batch</div>
          <div style={{ textAlign: 'right' }}>Gross</div><div style={{ textAlign: 'right' }}>Fees</div><div style={{ textAlign: 'right' }}>Paid out</div>
          <div style={{ paddingLeft: 14 }}>Status</div><div />
        </div>
        {rows.map((p) => (
          <button key={p.id} onClick={() => openDetail(p)} disabled={detailLoading} style={{
            display: 'grid', gridTemplateColumns: '1.2fr 0.7fr 0.9fr 0.9fr 0.9fr 1fr 0.5fr', width: '100%',
            fontSize: 13, padding: '10px 14px', alignItems: 'center',
            background: 'transparent', border: 'none', borderTop: '1px solid var(--bdr)', cursor: 'pointer',
            textAlign: 'left', fontFamily: 'inherit', color: 'inherit',
          }}>
            <div style={{ color: 'var(--t1)', fontWeight: 600 }}>{fmtDate(p.payout_date)}</div>
            <div style={{ color: 'var(--t3)' }}>{p.batch_number != null ? p.batch_number : '—'}</div>
            <div style={numCell}>{m(p.gross_minor, p.currency)}</div>
            <div style={{ ...numCell, color: 'var(--amb,#e8a020)' }}>{m(p.fees_minor, p.currency)}</div>
            <div style={{ ...numCell, color: 'var(--grn)' }}>{m(p.net_minor, p.currency)}</div>
            <div style={{ paddingLeft: 14, fontSize: 12, color: 'var(--t2)' }}>
              {p.status === 'settled' ? 'Settled' : (p.status || '—')}
              {p.shared && <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 999, background: 'var(--bg3)', color: 'var(--t3)' }}>shared</span>}
            </div>
            <div style={{ textAlign: 'right', color: 'var(--t4)' }}>›</div>
          </button>
        ))}
      </div>
      <div style={{ fontSize: 11, color: 'var(--t4)', marginTop: 10 }}>
        {rows.length} payout{rows.length === 1 ? '' : 's'} ·{' '}
        <button onClick={load} style={{ background: 'none', border: 'none', color: 'var(--acc)', cursor: 'pointer', fontSize: 11, fontWeight: 700, padding: 0 }}>↻ Refresh</button>
        {detailLoading && <span style={{ marginLeft: 10 }}>Opening payout…</span>}
      </div>
    </div>
  );
}
