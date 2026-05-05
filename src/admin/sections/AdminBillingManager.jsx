// src/admin/sections/AdminBillingManager.jsx
// Admin-only: manage Stripe Connect accounts per location across all companies.
// Mounted inside CompanyAdminApp (super_admin gated, ?mode=admin).

import { useEffect, useState, useCallback } from 'react';
import { supabase, platformSupabase } from '../../lib/supabase';

const FUNCTIONS_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`;

// Reusable admin styles (mirrors CompanyAdminApp's `S` object so the look matches)
const S = {
  page: { padding: '0' },
  h1: { fontSize: 22, fontWeight: 800, color: '#f1f5f9', marginBottom: 4 },
  sub: { fontSize: 13, color: '#64748b', marginBottom: 28 },
  card: { background: '#1a1d27', border: '1px solid #2d3148', borderRadius: 12, padding: 20, marginBottom: 16 },
  label: { fontSize: 12, fontWeight: 600, color: '#94a3b8', marginBottom: 6, display: 'block', textTransform: 'uppercase', letterSpacing: '.05em' },
  input: { width: '100%', padding: '9px 12px', borderRadius: 8, border: '1px solid #2d3148', background: '#0f1117', color: '#f1f5f9', fontSize: 13, fontFamily: 'monospace', outline: 'none', boxSizing: 'border-box' },
  btn: { padding: '8px 16px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'inherit' },
  btnPrimary: { background: '#6366f1', color: '#fff' },
  btnGhost: { background: 'transparent', color: '#94a3b8', border: '1px solid #2d3148' },
  btnDanger: { background: 'transparent', color: '#ef4444', border: '1px solid #7f1d1d' },
  pill: { fontSize: 11, padding: '3px 8px', borderRadius: 99, background: '#2d3148', color: '#cbd5e1', textTransform: 'uppercase', letterSpacing: '.05em', fontWeight: 600 },
  errorBox: { padding: 12, background: '#3f1d1d', color: '#fca5a5', borderRadius: 8, marginBottom: 16, fontSize: 13, border: '1px solid #7f1d1d' },
};

export default function AdminBillingManager({ authUser }) {
  const [companies, setCompanies] = useState([]);
  const [locations, setLocations] = useState([]);
  const [msaByLoc, setMsaByLoc] = useState({});
  const [bsByLoc, setBsByLoc] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [linkModalLoc, setLinkModalLoc] = useState(null);
  const [filterCompanyId, setFilterCompanyId] = useState('');

  const refresh = useCallback(async () => {
    if (!platformSupabase) {
      setError('Platform Supabase not configured (VITE_PLATFORM_SUPABASE_URL / _ANON_KEY missing).');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const { data: cos, error: coErr } = await platformSupabase.from('companies').select('id, name').order('name');
      if (coErr) throw coErr;
      setCompanies(cos ?? []);

      let q = platformSupabase.from('locations').select('id, name, company_id, timezone').order('name');
      if (filterCompanyId) q = q.eq('company_id', filterCompanyId);
      const { data: locs, error: locErr } = await q;
      if (locErr) throw locErr;
      setLocations(locs ?? []);

      const ids = (locs ?? []).map(l => l.id);
      if (ids.length) {
        const [{ data: msas }, { data: bses }] = await Promise.all([
          platformSupabase.from('merchant_stripe_accounts').select('*').in('location_id', ids),
          platformSupabase.from('billing_state').select('*').in('location_id', ids),
        ]);
        const m = {}; (msas ?? []).forEach(r => { m[r.location_id] = r; });
        const b = {}; (bses ?? []).forEach(r => { b[r.location_id] = r; });
        setMsaByLoc(m);
        setBsByLoc(b);
      } else {
        setMsaByLoc({});
        setBsByLoc({});
      }
    } catch (e) {
      setError(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  }, [filterCompanyId]);

  useEffect(() => { refresh(); }, [refresh]);

  const companyName = (id) => companies.find(c => c.id === id)?.name ?? '(unknown company)';

  return (
    <div style={S.page}>
      <h1 style={S.h1}>Billing & Stripe accounts</h1>
      <div style={S.sub}>Manage Stripe Connect linkage and rolling GMV per location, across all companies.</div>

      <div style={{ display: 'flex', gap: 12, marginBottom: 16, alignItems: 'center' }}>
        <select
          value={filterCompanyId}
          onChange={e => setFilterCompanyId(e.target.value)}
          style={{ ...S.input, width: 320, fontFamily: 'inherit' }}
        >
          <option value="">All companies ({companies.length})</option>
          {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <button onClick={refresh} disabled={loading} style={{ ...S.btn, ...S.btnGhost }}>
          {loading ? 'Loading…' : '↻ Refresh'}
        </button>
        <div style={{ marginLeft: 'auto', fontSize: 12, color: '#64748b' }}>
          {locations.length} location{locations.length === 1 ? '' : 's'}
        </div>
      </div>

      {error && <div style={S.errorBox}>{error}</div>}

      {!error && locations.length === 0 && !loading && (
        <div style={{ ...S.card, color: '#64748b', textAlign: 'center', padding: 40 }}>No locations found.</div>
      )}

      {locations.map(loc => (
        <LocationCard
          key={loc.id}
          location={loc}
          companyName={companyName(loc.company_id)}
          msa={msaByLoc[loc.id]}
          bs={bsByLoc[loc.id]}
          onLink={() => setLinkModalLoc(loc)}
          onUnlink={async () => {
            if (!confirm(`Unlink Stripe account from ${loc.name}? Future payments will fail until re-linked.`)) return;
            const { error } = await platformSupabase.from('merchant_stripe_accounts').delete().eq('id', msaByLoc[loc.id].id);
            if (error) alert(`Unlink failed: ${error.message}`);
            else refresh();
          }}
        />
      ))}

      {linkModalLoc && (
        <LinkModal
          location={linkModalLoc}
          onClose={() => setLinkModalLoc(null)}
          onLinked={() => { setLinkModalLoc(null); refresh(); }}
        />
      )}
    </div>
  );
}

function LocationCard({ location, companyName, msa, bs, onLink, onUnlink }) {
  const linked = !!msa;
  const status = !linked
    ? { label: 'Not linked', color: '#64748b', dot: '#475569' }
    : !msa.charges_enabled
      ? { label: 'Onboarding incomplete', color: '#fbbf24', dot: '#fbbf24' }
      : { label: 'Live · charges enabled', color: '#34d399', dot: '#34d399' };
  const currency = (msa?.default_currency || bs?.current_period_currency || 'gbp').toUpperCase();

  return (
    <div style={S.card}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 11, color: '#6366f1', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 2 }}>
            {companyName}
          </div>
          <div style={{ fontSize: 18, fontWeight: 700, color: '#f1f5f9', marginBottom: 4 }}>{location.name}</div>
          <div style={{ fontSize: 11, color: '#475569', marginBottom: 14, fontFamily: 'monospace' }}>{location.id}</div>

          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 14 }}>
            <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 13, color: status.color, fontWeight: 600 }}>
              <span style={{ width: 8, height: 8, borderRadius: 99, background: status.dot }} />
              {status.label}
            </span>
            {linked && (
              <>
                <span style={S.pill}>{msa.country ?? '—'}</span>
                <span style={S.pill}>{currency}</span>
                <span style={S.pill}>{msa.link_method === 'admin_manual' ? 'Manual' : 'Express'}</span>
                <code style={{ fontSize: 12, color: '#94a3b8', fontFamily: 'monospace' }}>{msa.stripe_account_id}</code>
              </>
            )}
          </div>

          {bs && (
            <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap' }}>
              <Stat label="GMV this month" value={fmt(bs.gmv_this_month, currency)} />
              <Stat label="Plan" value={(bs.current_plan ?? '—').toUpperCase()} accent />
              <Stat label="Monthly fee" value={fmt(bs.current_monthly_fee, currency)} />
              <Stat label="Last month" value={fmt(bs.gmv_last_month, currency)} />
              <Stat label="Period start" value={bs.current_period_start ?? '—'} />
            </div>
          )}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flexShrink: 0 }}>
          {!linked && <button onClick={onLink} style={{ ...S.btn, ...S.btnPrimary }}>Link Stripe account</button>}
          {linked && <button onClick={onUnlink} style={{ ...S.btn, ...S.btnDanger }}>Unlink</button>}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, accent }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: '#64748b', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 2, fontWeight: 700 }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 700, color: accent ? '#a5b4fc' : '#f1f5f9' }}>{value}</div>
    </div>
  );
}

function LinkModal({ location, onClose, onLinked }) {
  const [acctId, setAcctId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const submit = async () => {
    setError(null);
    if (!acctId.startsWith('acct_')) { setError("Account ID must start with 'acct_'"); return; }
    setSubmitting(true);
    try {
      const { data: session } = await supabase.auth.getSession();
      const token = session?.session?.access_token;
      if (!token) throw new Error('not authenticated');
      const res = await fetch(`${FUNCTIONS_URL}/stripe-link-merchant`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ stripe_account_id: acctId.trim(), location_id: location.id }),
      });
      const j = await res.json();
      if (!res.ok || j.error) throw new Error(j.error ?? `HTTP ${res.status}`);
      onLinked();
    } catch (e) {
      setError(String(e?.message ?? e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }} onClick={onClose}>
      <div style={{ ...S.card, width: 480, maxWidth: 'calc(100vw - 32px)', marginBottom: 0 }} onClick={e => e.stopPropagation()}>
        <h2 style={{ ...S.h1, fontSize: 18, marginBottom: 4 }}>Link Stripe account</h2>
        <div style={{ fontSize: 13, color: '#64748b', marginBottom: 16 }}>
          to <strong style={{ color: '#cbd5e1' }}>{location.name}</strong>
        </div>
        <label style={S.label}>Stripe account ID</label>
        <input type="text" value={acctId} onChange={e => setAcctId(e.target.value)} placeholder="acct_1ABC..." style={S.input} autoFocus />
        <div style={{ fontSize: 12, color: '#64748b', marginTop: 8, marginBottom: 16 }}>
          The merchant account from <code style={{ color: '#94a3b8' }}>dashboard.stripe.com → Connect → Accounts</code>. The function validates with Stripe before linking.
        </div>
        {error && <div style={S.errorBox}>{error}</div>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={onClose} disabled={submitting} style={{ ...S.btn, ...S.btnGhost }}>Cancel</button>
          <button onClick={submit} disabled={submitting || !acctId} style={{ ...S.btn, ...S.btnPrimary }}>
            {submitting ? 'Linking…' : 'Link account'}
          </button>
        </div>
      </div>
    </div>
  );
}

function fmt(n, c = 'GBP') {
  const code = (c || 'GBP').toUpperCase();
  try {
    return new Intl.NumberFormat(code === 'GBP' ? 'en-GB' : 'en-US', {
      style: 'currency', currency: code, minimumFractionDigits: 2,
    }).format(Number(n ?? 0));
  } catch { return `${code} ${Number(n ?? 0).toFixed(2)}`; }
}
