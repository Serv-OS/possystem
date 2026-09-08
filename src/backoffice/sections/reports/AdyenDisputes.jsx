// src/backoffice/sections/reports/AdyenDisputes.jsx
// Adyen chargebacks for this venue — read from merchant_adyen_disputes via the
// location-fenced adyen-financial edge fn (action: 'disputes'). Cloned from
// the old RyftDisputes report (removed v5.7.2) but LIST-ONLY in Phase 1: rows,
// status and the respond-by countdown render; accept/challenge wiring comes in
// a later phase.

import { useEffect, useState } from 'react';
import { supabase, isMock, getLocationId } from '../../../lib/supabase';
import { StatTile, EmptyState } from './_charts';
import { money } from '../../../lib/currency';

const OPEN = (s) => ['open', 'info_requested'].includes(String(s || '').toLowerCase());
const statusColor = (s) => {
  const v = String(s || '').toLowerCase();
  if (v === 'won') return 'var(--grn)';
  if (['lost', 'expired'].includes(v)) return 'var(--red)';
  if (['accepted', 'defended'].includes(v)) return 'var(--t2)';
  return 'var(--amb,#e8a020)'; // open / info_requested
};
const statusLabel = (s) => {
  const v = String(s || '').toLowerCase();
  if (v === 'info_requested') return 'Info requested';
  return v ? v.charAt(0).toUpperCase() + v.slice(1) : '—';
};
function countdown(respondBy) {
  if (!respondBy) return null;
  const ms = new Date(respondBy).getTime() - Date.now();
  if (isNaN(ms)) return null;
  if (ms <= 0) return { text: 'deadline passed', urgent: true };
  const h = Math.floor(ms / 3.6e6), d = Math.floor(h / 24);
  return { text: d >= 1 ? `${d}d ${h % 24}h left` : `${h}h left`, urgent: h < 72 };
}

export default function AdyenDisputes() {
  const [disputes, setDisputes] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = async () => {
    setLoading(true); setError('');
    try {
      if (isMock) { setDisputes([]); return; }
      const locId = await getLocationId().catch(() => null);
      const { data: session } = await supabase.auth.getSession();
      const token = session?.session?.access_token;
      if (!token) throw new Error('Please sign in again.');
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/adyen-financial`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: 'disputes', ops_location_id: locId }),
      });
      const j = await res.json();
      if (!res.ok || j.error) throw new Error(j.error || `HTTP ${res.status}`);
      setDisputes(j.disputes || []);
    } catch (e) { setError(e.message || 'Failed to load'); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) return <div style={{ padding: 24, color: 'var(--t3)' }}>Loading disputes…</div>;
  if (error && !disputes) return <EmptyState icon="⚠️" message={error} />;

  const list = disputes || [];
  const open = list.filter((d) => OPEN(d.status));
  const atStake = open.reduce((s, d) => s + (Number(d.amount_minor) || 0), 0);
  const cur = list[0]?.currency || 'GBP';

  return (
    <div style={{ padding: '4px 0' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 12, marginBottom: 18 }}>
        <StatTile label="Open disputes" value={String(open.length)} color={open.length ? 'var(--amb,#e8a020)' : 'var(--t1)'} />
        <StatTile label="At stake (open)" value={money(atStake / 100, cur)} color={open.length ? 'var(--red)' : 'var(--t1)'} />
        <StatTile label="All disputes" value={String(list.length)} />
      </div>

      {error && <div style={{ padding: 10, background: 'var(--red-d)', color: 'var(--red)', borderRadius: 8, fontSize: 12, border: '1px solid var(--red-b)', marginBottom: 14 }}>{error}</div>}

      {list.length === 0 ? (
        <EmptyState icon="🛡" message="No chargebacks. If a customer disputes a card payment it will appear here with its deadline." />
      ) : list.map((d) => {
        const cd = countdown(d.respond_by);
        return (
          <div key={d.dispute_psp_reference} style={{ background: 'var(--bg1)', border: `1px solid ${OPEN(d.status) ? 'var(--amb,#e8a020)' : 'var(--bdr)'}`, borderRadius: 12, padding: 18, marginBottom: 12 }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 }}>
              <span style={{ fontSize: 18, fontWeight: 800, color: 'var(--t1)' }}>{money((Number(d.amount_minor) || 0) / 100, d.currency || cur)}</span>
              <span style={{ fontSize: 12, fontWeight: 700, color: statusColor(d.status), textTransform: 'uppercase', letterSpacing: '.04em' }}>{statusLabel(d.status)}</span>
              {OPEN(d.status) && cd && (
                <span style={{ fontSize: 12, fontWeight: 700, color: cd.urgent ? 'var(--red)' : 'var(--t2)' }}>⏳ {cd.text}</span>
              )}
            </div>
            <div style={{ fontSize: 13, color: 'var(--t2)' }}>
              {d.reason || d.reason_code || 'Card dispute'}
              {d.reason && d.reason_code ? ` · ${d.reason_code}` : ''}
            </div>
            <div style={{ fontSize: 11, color: 'var(--t4)', marginTop: 6, fontFamily: 'var(--font-mono)' }}>
              Payment {d.payment_psp_reference || '—'} · Dispute {d.dispute_psp_reference}
            </div>
            {OPEN(d.status) && (
              <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 8 }}>
                Responding from here is coming in a later update. For now, contact ServOS support before the deadline and we will respond with you.
              </div>
            )}
          </div>
        );
      })}

      {list.length > 0 && (
        <div style={{ fontSize: 11, color: 'var(--t4)', marginTop: 6 }}>
          <button onClick={load} style={{ background: 'none', border: 'none', color: 'var(--acc)', cursor: 'pointer', fontSize: 11, fontWeight: 700, padding: 0 }}>↻ Refresh</button> · Disputes are captured automatically as they arrive from the card networks.
        </div>
      )}
    </div>
  );
}
