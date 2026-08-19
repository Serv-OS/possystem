// src/backoffice/sections/reports/AdyenPayments.jsx
// Card Payments (Adyen) — every Adyen card payment for this venue from the
// server-truth ledger (adyen_payments, fed by adyen-webhook). Self-fetching via
// the location-fenced adyen-financial edge fn (action: 'payments'), same
// pattern as RyftPayouts. Fees show "—" honestly: they arrive with settlement
// ingestion in a later phase.

import { useEffect, useState } from 'react';
import { supabase, isMock, getLocationId } from '../../../lib/supabase';
import { StatTile, EmptyState, ExportBtn } from './_charts';
import { toCsv, downloadCsv } from './_csv';
import { money } from '../../../lib/currency';

const PAGE_SIZE = 50;

// Operator-friendly status chip from the ledger row. Dispute states outrank
// refund amounts; refund amounts outrank the plain Paid.
function statusOf(p) {
  const code = String(p.last_event_code || '');
  const amount = Number(p.amount_minor) || 0;
  const refunded = Number(p.amount_refunded_minor) || 0;
  if (code === 'AUTHORISATION' && p.success === false) return { label: 'Declined', color: 'var(--red)' };
  if (code === 'CHARGEBACK' || code === 'NOTIFICATION_OF_CHARGEBACK') return { label: 'Disputed', color: 'var(--red)' };
  if (code === 'SECOND_CHARGEBACK') return { label: 'Dispute lost', color: 'var(--red)' };
  if (code === 'CHARGEBACK_REVERSED') return { label: 'Dispute won', color: 'var(--grn)' };
  if (code === 'REQUEST_FOR_INFORMATION') return { label: 'Info requested', color: 'var(--amb,#e8a020)' };
  if (code === 'CAPTURE_FAILED') return { label: 'Capture failed', color: 'var(--red)' };
  if (code === 'REFUND_FAILED' && refunded <= 0) return { label: 'Refund failed', color: 'var(--red)' };
  if (refunded > 0 && amount > 0 && refunded >= amount) return { label: 'Refunded', color: 'var(--t2)' };
  if (refunded > 0) return { label: 'Partly refunded', color: 'var(--amb,#e8a020)' };
  if (code === 'CANCELLATION') return { label: 'Cancelled', color: 'var(--t2)' };
  if (p.success === true) return { label: 'Paid', color: 'var(--grn)' };
  return { label: code || '—', color: 'var(--t3)' };
}

const fmtWhen = (iso) => {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); }
  catch { return '—'; }
};
const cardLabel = (card) => {
  if (!card) return '—';
  const brand = card.brand ? String(card.brand).toUpperCase() : '';
  const last4 = card.last4 ? `···${card.last4}` : '';
  return (brand || last4) ? `${brand}${brand && last4 ? ' ' : ''}${last4}` : '—';
};

export default function AdyenPayments() {
  const [data, setData] = useState(null);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = async (p = page) => {
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
        body: JSON.stringify({ action: 'payments', ops_location_id: locId, page: p, page_size: PAGE_SIZE }),
      });
      const j = await res.json();
      if (!res.ok || j.error) throw new Error(j.error || `HTTP ${res.status}`);
      setData(j); setPage(p);
    } catch (e) { setError(e.message || 'Failed to load'); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(0); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const cur = data?.summary?.currency || 'GBP';
  const m = (minor) => money((Number(minor) || 0) / 100, cur);

  const exportCsv = () => {
    const rows = data?.payments || [];
    const headers = [
      { label: 'Date', key: (r) => fmtWhen(r.created_at) },
      { label: 'Card', key: (r) => cardLabel(r.card) },
      { label: 'Amount', key: (r) => ((Number(r.amount_minor) || 0) / 100).toFixed(2) },
      { label: 'Refunded', key: (r) => ((Number(r.amount_refunded_minor) || 0) / 100).toFixed(2) },
      { label: 'Currency', key: (r) => r.currency || cur },
      { label: 'Status', key: (r) => statusOf(r).label },
      { label: 'Reference', key: (r) => r.merchant_reference || '' },
      { label: 'PSP reference', key: (r) => r.psp_reference || '' },
    ];
    downloadCsv('adyen-payments.csv', toCsv(rows, headers));
  };

  if (loading && !data) return <div style={{ padding: 24, color: 'var(--t3)' }}>Loading card payments…</div>;
  if (error && !data) return <EmptyState icon="⚠️" message={error} />;
  if (data?.mock) return <EmptyState icon="💳" message="Card payment data is live only — view it on the deployed app." />;

  const s = data?.summary || {};
  const payments = data?.payments || [];
  const total = Number(data?.total) || 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div style={{ padding: '4px 0' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 12, marginBottom: 18 }}>
        <StatTile label="Payments" value={String(s.count ?? 0)} />
        <StatTile label="Taken" value={m(s.sum_minor)} color="var(--grn)" />
        <StatTile label="Refunds" value={m(s.refunds_minor)} />
        <div title="Fees arrive with settlement ingestion in a later update — Adyen reports them when it settles funds, not per payment.">
          <StatTile label="Estimated fees" value="—" color="var(--t3)" />
        </div>
      </div>

      {error && <div style={{ padding: 10, background: 'var(--red-d)', color: 'var(--red)', borderRadius: 8, fontSize: 12, border: '1px solid var(--red-b)', marginBottom: 14 }}>{error}</div>}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--t1)' }}>Card payments</div>
        {payments.length > 0 && <ExportBtn onClick={exportCsv} />}
      </div>

      {payments.length === 0 ? (
        <EmptyState icon="💳" message="No Adyen card payments recorded yet. They appear here the moment one is taken." />
      ) : (
        <div style={{ border: '1px solid var(--bdr)', borderRadius: 10, overflow: 'hidden' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1.3fr 1fr 0.9fr 0.9fr 1.1fr 1.4fr', fontSize: 11, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.04em', padding: '9px 14px', background: 'var(--bg2)' }}>
            <div>Date</div><div>Card</div><div>Amount</div><div>Refunded</div><div>Status</div><div>PSP ref</div>
          </div>
          {payments.map((p) => {
            const st = statusOf(p);
            return (
              <div key={p.psp_reference} style={{ display: 'grid', gridTemplateColumns: '1.3fr 1fr 0.9fr 0.9fr 1.1fr 1.4fr', fontSize: 13, padding: '9px 14px', borderTop: '1px solid var(--bdr)', alignItems: 'center' }}>
                <div style={{ color: 'var(--t2)' }}>{fmtWhen(p.created_at)}</div>
                <div style={{ color: 'var(--t2)' }}>{cardLabel(p.card)}</div>
                <div style={{ fontWeight: 700, color: 'var(--t1)' }}>{money((Number(p.amount_minor) || 0) / 100, p.currency || cur)}</div>
                <div style={{ color: (Number(p.amount_refunded_minor) || 0) > 0 ? 'var(--amb,#e8a020)' : 'var(--t4)' }}>
                  {(Number(p.amount_refunded_minor) || 0) > 0 ? money(Number(p.amount_refunded_minor) / 100, p.currency || cur) : '—'}
                </div>
                <div style={{ fontSize: 12, fontWeight: 700, color: st.color }}>{st.label}</div>
                <div style={{ color: 'var(--t4)', fontSize: 11, fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={p.psp_reference}>{p.psp_reference}</div>
              </div>
            );
          })}
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 10 }}>
        <div style={{ fontSize: 11, color: 'var(--t4)' }}>
          {total} payment{total === 1 ? '' : 's'}{s.capped ? ' (summary counts the most recent 5,000)' : ''} ·{' '}
          <button onClick={() => load(page)} style={{ background: 'none', border: 'none', color: 'var(--acc)', cursor: 'pointer', fontSize: 11, fontWeight: 700, padding: 0 }}>↻ Refresh</button>
        </div>
        {pages > 1 && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button disabled={page === 0 || loading} onClick={() => load(page - 1)} style={pgBtn}>‹ Prev</button>
            <span style={{ fontSize: 11, color: 'var(--t3)' }}>Page {page + 1} of {pages}</span>
            <button disabled={page >= pages - 1 || loading} onClick={() => load(page + 1)} style={pgBtn}>Next ›</button>
          </div>
        )}
      </div>
    </div>
  );
}

const pgBtn = { padding: '5px 10px', borderRadius: 8, background: 'var(--bg3)', border: '1px solid var(--bdr)', color: 'var(--t2)', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' };
