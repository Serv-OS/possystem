// src/backoffice/sections/reports/RyftPayouts.jsx
// Card payments & payouts — LIVE from Ryft for this location's account:
// available/pending balance, payout history (with status + settlement dates),
// and recent sales / fees / refunds. Self-fetching via the location-scoped
// payments-onboard edge fn (action: 'report').

import { useEffect, useState } from 'react';
import { supabase, isMock, getLocationId } from '../../../lib/supabase';
import { StatTile, EmptyState, ExportBtn } from './_charts';
import { toCsv, downloadCsv } from './_csv';
import { money } from '../../../lib/currency';

const statusColor = (s) => {
  const v = String(s || '').toLowerCase();
  if (/complete|paid|success/.test(v)) return 'var(--grn)';
  if (/fail|error|cancel/.test(v)) return 'var(--red)';
  return 'var(--amb,#e8a020)';     // pending / scheduled / in-progress
};
const fmtDate = (epoch) => {
  if (!epoch) return '—';
  try { return new Date(Number(epoch) * 1000).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }); }
  catch { return '—'; }
};

export default function RyftPayouts() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = async () => {
    setLoading(true); setError('');
    try {
      if (isMock) { setData({ mock: true }); return; }
      const locId = await getLocationId().catch(() => null);
      const { data: session } = await supabase.auth.getSession();
      const token = session?.session?.access_token;
      if (!token) throw new Error('Please sign in again.');
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/payments-onboard`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: 'report', ops_location_id: locId }),
      });
      const j = await res.json();
      if (!res.ok || j.error) throw new Error(j.error || `HTTP ${res.status}`);
      setData(j);
    } catch (e) { setError(e.message || 'Failed to load'); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const cur = data?.currency || 'GBP';
  const m = (minor) => money((Number(minor) || 0) / 100, cur);

  const exportCsv = () => {
    const rows = (data?.payouts || []).map((p) => ({
      Created: fmtDate(p.created), Amount: ((Number(p.amount) || 0) / 100).toFixed(2),
      Currency: p.currency || cur, Status: p.status || '', Schedule: p.scheduleType || '',
      Completed: fmtDate(p.completed),
    }));
    downloadCsv('ryft-payouts.csv', toCsv(rows));
  };

  if (loading) return <div style={{ padding: 24, color: 'var(--t3)' }}>Loading card payments…</div>;
  if (error) return <EmptyState icon="⚠️" message={error} />;
  if (data?.mock) return <EmptyState icon="💳" message="Card payout data is live only — view it on the deployed app." />;
  if (!data?.linked) return <EmptyState icon="💳" message="No card payments account yet. Set one up in Location Settings → Card payments." />;

  const s = data.summary || {};
  const payouts = data.payouts || [];

  return (
    <div style={{ padding: '4px 0' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 12, marginBottom: 18 }}>
        <StatTile label="Available balance" value={m(data.balance?.cleared)} color="var(--grn)" />
        <StatTile label="Pending" value={m(data.balance?.pending)} color="var(--amb,#e8a020)" />
        <StatTile label="Sales (recent)" value={m(s.gmv_minor)} />
        <StatTile label="Fees (recent)" value={m(s.fees_minor)} />
        <StatTile label="Refunds (recent)" value={m(s.refunds_minor)} />
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--t1)' }}>Payouts to your bank</div>
        {payouts.length > 0 && <ExportBtn onClick={exportCsv} />}
      </div>

      {payouts.length === 0 ? (
        <EmptyState icon="🏦" message="No payouts yet — they appear here once Ryft settles funds to your bank." />
      ) : (
        <div style={{ border: '1px solid var(--bdr)', borderRadius: 10, overflow: 'hidden' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr 1.2fr 1fr 1fr', fontSize: 11, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.04em', padding: '9px 14px', background: 'var(--bg2)' }}>
            <div>Created</div><div>Amount</div><div>Status</div><div>Schedule</div><div>Completed</div>
          </div>
          {payouts.map((p, i) => (
            <div key={p.id || i} style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr 1.2fr 1fr 1fr', fontSize: 13, padding: '9px 14px', borderTop: '1px solid var(--bdr)', alignItems: 'center' }}>
              <div style={{ color: 'var(--t2)' }}>{fmtDate(p.created)}</div>
              <div style={{ fontWeight: 700, color: 'var(--t1)' }}>{money((Number(p.amount) || 0) / 100, p.currency || cur)}</div>
              <div style={{ fontSize: 12, fontWeight: 700, color: statusColor(p.status) }}>{p.status || '—'}{p.failureReason ? ` · ${p.failureReason}` : ''}</div>
              <div style={{ color: 'var(--t3)' }}>{p.scheduleType || '—'}</div>
              <div style={{ color: 'var(--t2)' }}>{fmtDate(p.completed)}</div>
            </div>
          ))}
        </div>
      )}

      <div style={{ fontSize: 11, color: 'var(--t4)', marginTop: 10 }}>
        Live from Ryft · {payouts.length} most recent payout{payouts.length === 1 ? '' : 's'}.{' '}
        <button onClick={load} style={{ background: 'none', border: 'none', color: 'var(--acc)', cursor: 'pointer', fontSize: 11, fontWeight: 700, padding: 0 }}>↻ Refresh</button>
      </div>
    </div>
  );
}
