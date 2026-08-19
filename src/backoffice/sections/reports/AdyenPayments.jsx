// src/backoffice/sections/reports/AdyenPayments.jsx
// Card Payments (Adyen) — every Adyen card payment for this venue from the
// server-truth ledger (adyen_payments, fed by adyen-webhook). Self-fetching via
// the location-fenced adyen-financial edge fn (action: 'payments'), a
// self-fetching report. Fees (v5.6.99): once settlement ingestion has run,
// summary.fees_minor and per-row fee_minor arrive from adyen-report-ingest and
// light up the tile + a per-row Fee column; until then both show an honest "—".
// Payment types (v5.7.3): each payment carries its pricing tier
// (rate_category, stamped by adyen-webhook) rendered as a Type chip, with a
// type filter that refetches server-side so the tiles match the list. The
// filter hides itself until the server says the type column is live.

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
// Venue-facing names for the four pricing tiers — never internal ids.
const TYPE_LABELS = {
  card_present: 'In person',
  card_not_present: 'Online',
  amex: 'Amex & business',
  keyed: 'Keyed',
};
const TYPE_FILTERS = [
  { id: '', label: 'All types' },
  { id: 'card_present', label: 'In person' },
  { id: 'card_not_present', label: 'Online' },
  { id: 'amex', label: 'Amex & business' },
  { id: 'keyed', label: 'Manually keyed' },
];
const typeLabel = (r) => TYPE_LABELS[r?.rate_category] ?? '—';

const cardLabel = (card) => {
  if (!card) return '—';
  const brand = card.brand ? String(card.brand).toUpperCase() : '';
  const last4 = card.last4 ? `···${card.last4}` : '';
  return (brand || last4) ? `${brand}${brand && last4 ? ' ' : ''}${last4}` : '—';
};

export default function AdyenPayments() {
  const [data, setData] = useState(null);
  const [page, setPage] = useState(0);
  const [typeFilter, setTypeFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = async (p = page, tf = typeFilter) => {
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
        body: JSON.stringify({ action: 'payments', ops_location_id: locId, page: p, page_size: PAGE_SIZE, rate_category: tf || undefined }),
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
      { label: 'Type', key: (r) => typeLabel(r) },
      { label: 'Amount', key: (r) => ((Number(r.amount_minor) || 0) / 100).toFixed(2) },
      { label: 'Refunded', key: (r) => ((Number(r.amount_refunded_minor) || 0) / 100).toFixed(2) },
      { label: 'Fee', key: (r) => (r.fee_minor != null ? (Number(r.fee_minor) / 100).toFixed(2) : '') },
      { label: 'Currency', key: (r) => r.currency || cur },
      { label: 'Status', key: (r) => statusOf(r).label },
      { label: 'Reference', key: (r) => r.merchant_reference || '' },
      { label: 'PSP reference', key: (r) => r.psp_reference || '' },
    ];
    downloadCsv('servos-payments.csv', toCsv(rows, headers));
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
        {s.fees_minor != null ? (
          <div title={`Fees reported at settlement, recorded for ${s.fee_known} payment${s.fee_known === 1 ? '' : 's'} in this period so far.`}>
            <StatTile label="Fees" value={m(s.fees_minor)} color="var(--amb,#e8a020)" />
          </div>
        ) : (
          <div title="Fees arrive with settlement ingestion in a later update. They are reported when funds settle, not per payment.">
            <StatTile label="Estimated fees" value="—" color="var(--t3)" />
          </div>
        )}
      </div>

      {error && <div style={{ padding: 10, background: 'var(--red-d)', color: 'var(--red)', borderRadius: 8, fontSize: 12, border: '1px solid var(--red-b)', marginBottom: 14 }}>{error}</div>}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, gap: 10, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--t1)' }}>Card payments</div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {data?.typed !== false && (
            <select
              value={typeFilter}
              onChange={(e) => { setTypeFilter(e.target.value); load(0, e.target.value); }}
              style={{ padding: '6px 10px', borderRadius: 8, background: 'var(--bg3)', border: '1px solid var(--bdr)', color: 'var(--t2)', fontSize: 12, fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer' }}
            >
              {TYPE_FILTERS.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
            </select>
          )}
          {payments.length > 0 && <ExportBtn onClick={exportCsv} />}
        </div>
      </div>

      {payments.length === 0 ? (
        <EmptyState icon="💳" message={typeFilter ? 'No card payments of this type in this period.' : 'No card payments recorded yet. They appear here the moment one is taken.'} />
      ) : (
        <div style={{ border: '1px solid var(--bdr)', borderRadius: 10, overflow: 'hidden' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 0.9fr 0.9fr 0.9fr 0.8fr 0.7fr 1.1fr 1.2fr', fontSize: 11, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.04em', padding: '9px 14px', background: 'var(--bg2)' }}>
            <div>Date</div><div>Card</div><div>Type</div><div>Amount</div><div>Refunded</div><div>Fee</div><div>Status</div><div>PSP ref</div>
          </div>
          {payments.map((p) => {
            const st = statusOf(p);
            return (
              <div key={p.psp_reference} style={{ display: 'grid', gridTemplateColumns: '1.2fr 0.9fr 0.9fr 0.9fr 0.8fr 0.7fr 1.1fr 1.2fr', fontSize: 13, padding: '9px 14px', borderTop: '1px solid var(--bdr)', alignItems: 'center' }}>
                <div style={{ color: 'var(--t2)' }}>{fmtWhen(p.created_at)}</div>
                <div style={{ color: 'var(--t2)' }}>{cardLabel(p.card)}</div>
                <div>
                  {p.rate_category ? (
                    <span style={{ fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: 'var(--bg3)', border: '1px solid var(--bdr)', color: 'var(--t2)', whiteSpace: 'nowrap' }}>
                      {typeLabel(p)}
                    </span>
                  ) : <span style={{ color: 'var(--t4)' }}>—</span>}
                </div>
                <div style={{ fontWeight: 700, color: 'var(--t1)' }}>{money((Number(p.amount_minor) || 0) / 100, p.currency || cur)}</div>
                <div style={{ color: (Number(p.amount_refunded_minor) || 0) > 0 ? 'var(--amb,#e8a020)' : 'var(--t4)' }}>
                  {(Number(p.amount_refunded_minor) || 0) > 0 ? money(Number(p.amount_refunded_minor) / 100, p.currency || cur) : '—'}
                </div>
                <div
                  style={{ color: p.fee_minor != null ? 'var(--amb,#e8a020)' : 'var(--t4)' }}
                  title={p.fee_minor != null && p.settled_at ? `Settled ${fmtWhen(p.settled_at)}` : undefined}
                >
                  {p.fee_minor != null ? money(Number(p.fee_minor) / 100, p.currency || cur) : '—'}
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
