// src/admin/sections/AdminBillingManager.jsx
// Admin-only billing manager: per-location Stripe Connect status,
// negotiated markup % (card-present + online), GMV stats.
// Plus a platform-defaults panel for the global fallback values.
//
// Themed with the same CSS variables as the customer back office, so it
// follows the user's light/dark theme choice automatically.

import { useEffect, useState, useCallback } from 'react';
import { supabase, platformSupabase } from '../../lib/supabase';

const FUNCTIONS_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`;

// ─── Reusable styles (BO theme tokens) ─────────────────────────────────────
const S = {
  page:    { padding: 0 },
  h1:      { fontSize: 22, fontWeight: 800, color: 'var(--t1)', margin: 0, marginBottom: 4, letterSpacing: '-.01em' },
  sub:     { fontSize: 13, color: 'var(--t3)', marginBottom: 24 },
  card:    { background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 12, padding: 18, marginBottom: 14, boxShadow: 'var(--sh)' },
  label:   { fontSize: 11, fontWeight: 700, color: 'var(--t3)', marginBottom: 5, display: 'block', textTransform: 'uppercase', letterSpacing: '.06em' },
  input:   { width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid var(--bdr2)', background: 'var(--bg2)', color: 'var(--t1)', fontSize: 13, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' },
  inputMono: { fontFamily: 'var(--font-mono, monospace)' },
  btn:     { padding: '8px 14px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'inherit' },
  btnPrim: { background: 'var(--acc)', color: '#0b0c10' },
  btnGhost:{ background: 'transparent', color: 'var(--t2)', border: '1px solid var(--bdr2)' },
  btnDan:  { background: 'transparent', color: 'var(--red)', border: '1px solid var(--red-b)' },
  pill:    { fontSize: 11, padding: '2px 8px', borderRadius: 99, background: 'var(--bg3)', color: 'var(--t2)', textTransform: 'uppercase', letterSpacing: '.05em', fontWeight: 700, border: '1px solid var(--bdr)' },
  errorBox:{ padding: 12, background: 'var(--red-d)', color: 'var(--red)', borderRadius: 8, marginBottom: 14, fontSize: 13, border: '1px solid var(--red-b)' },
  okBox:   { padding: 10, background: 'var(--grn-d)', color: 'var(--grn)', borderRadius: 8, marginBottom: 0, fontSize: 12, border: '1px solid var(--grn-b)' },
};

export default function AdminBillingManager({ authUser }) {
  const [companies, setCompanies] = useState([]);
  const [locations, setLocations] = useState([]);
  const [msaByLoc, setMsaByLoc] = useState({});
  const [bsByLoc, setBsByLoc] = useState({});
  const [platformDefaults, setPlatformDefaults] = useState({ default_cardpresent_markup_percent: 1.0, default_online_markup_percent: 0.5 });
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
      const [{ data: cos, error: coErr }, { data: ps }] = await Promise.all([
        platformSupabase.from('companies').select('id, name').order('name'),
        platformSupabase.from('platform_settings').select('*').eq('id', true).maybeSingle(),
      ]);
      if (coErr) throw coErr;
      setCompanies(cos ?? []);
      if (ps) setPlatformDefaults(ps);

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
        setMsaByLoc({}); setBsByLoc({});
      }
    } catch (e) {
      setError(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  }, [filterCompanyId]);

  useEffect(() => { refresh(); }, [refresh]);

  const companyName = (id) => companies.find(c => c.id === id)?.name ?? '(unknown)';
  const upsertMsaPatch = (locationId, patch) => {
    setMsaByLoc(prev => ({ ...prev, [locationId]: { ...(prev[locationId] ?? {}), ...patch } }));
  };

  return (
    <div style={S.page}>
      <h1 style={S.h1}>Billing &amp; Stripe accounts</h1>
      <div style={S.sub}>Per-location Stripe Connect status, negotiated transaction markup %, and rolling GMV.</div>

      {/* Platform-wide defaults */}
      <PlatformDefaultsPanel
        defaults={platformDefaults}
        onSave={(next) => { setPlatformDefaults(next); }}
        authUserId={authUser?.id}
        onError={setError}
      />

      <div style={{ display: 'flex', gap: 10, marginBottom: 14, alignItems: 'center', flexWrap: 'wrap' }}>
        <select
          value={filterCompanyId}
          onChange={e => setFilterCompanyId(e.target.value)}
          style={{ ...S.input, width: 320 }}
        >
          <option value="">All companies ({companies.length})</option>
          {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <button onClick={refresh} disabled={loading} style={{ ...S.btn, ...S.btnGhost }}>
          {loading ? 'Loading…' : '↻ Refresh'}
        </button>
        <div style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--t3)' }}>
          {locations.length} location{locations.length === 1 ? '' : 's'}
        </div>
      </div>

      {error && <div style={S.errorBox}>{error}</div>}

      {!error && locations.length === 0 && !loading && (
        <div style={{ ...S.card, color: 'var(--t3)', textAlign: 'center', padding: 40 }}>No locations found.</div>
      )}

      {locations.map(loc => (
        <LocationCard
          key={loc.id}
          location={loc}
          companyName={companyName(loc.company_id)}
          msa={msaByLoc[loc.id]}
          bs={bsByLoc[loc.id]}
          defaults={platformDefaults}
          onLink={() => setLinkModalLoc(loc)}
          onUnlink={async () => {
            if (!confirm(`Unlink Stripe account from ${loc.name}? Future payments will fail until re-linked.`)) return;
            const { error } = await platformSupabase.from('merchant_stripe_accounts').delete().eq('id', msaByLoc[loc.id].id);
            if (error) alert(`Unlink failed: ${error.message}`);
            else refresh();
          }}
          onSavePricing={async ({ cardpresent, online, notes }) => {
            const patch = {
              cardpresent_markup_percent: cardpresent === '' ? null : Number(cardpresent),
              online_markup_percent:      online      === '' ? null : Number(online),
              pricing_notes: notes || null,
            };
            const { error } = await platformSupabase.from('merchant_stripe_accounts')
              .update(patch).eq('id', msaByLoc[loc.id].id);
            if (error) { alert(`Save failed: ${error.message}`); return false; }
            upsertMsaPatch(loc.id, patch);
            return true;
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

// ─── Platform-wide defaults panel ─────────────────────────────────────────
function PlatformDefaultsPanel({ defaults, onSave, authUserId, onError }) {
  const [editing, setEditing] = useState(false);
  const [cp, setCp] = useState(defaults.default_cardpresent_markup_percent);
  const [on, setOn] = useState(defaults.default_online_markup_percent);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setCp(defaults.default_cardpresent_markup_percent);
    setOn(defaults.default_online_markup_percent);
  }, [defaults]);

  const save = async () => {
    setBusy(true);
    try {
      const patch = {
        default_cardpresent_markup_percent: Number(cp),
        default_online_markup_percent: Number(on),
        updated_at: new Date().toISOString(),
        updated_by_user_id: authUserId,
      };
      const { error } = await platformSupabase.from('platform_settings').update(patch).eq('id', true);
      if (error) throw error;
      onSave({ ...defaults, ...patch });
      setEditing(false);
    } catch (e) {
      onError(`Failed to save platform defaults: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ ...S.card, borderColor: 'var(--acc-b)', background: 'var(--acc-d)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 260 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--acc)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 4 }}>
            Platform defaults
          </div>
          <div style={{ fontSize: 14, color: 'var(--t1)', marginBottom: 8, lineHeight: 1.4 }}>
            Used for any location where the merchant doesn't have a per-merchant override.
          </div>
          {!editing && (
            <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
              <Stat label="In-person markup" value={`${Number(defaults.default_cardpresent_markup_percent ?? 0).toFixed(2)}%`} />
              <Stat label="Online markup"    value={`${Number(defaults.default_online_markup_percent ?? 0).toFixed(2)}%`} />
            </div>
          )}
          {editing && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, maxWidth: 460 }}>
              <div>
                <label style={S.label}>In-person markup %</label>
                <input type="number" step="0.01" min="0" max="100" value={cp} onChange={e => setCp(e.target.value)} style={S.input} />
              </div>
              <div>
                <label style={S.label}>Online markup %</label>
                <input type="number" step="0.01" min="0" max="100" value={on} onChange={e => setOn(e.target.value)} style={S.input} />
              </div>
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {!editing && <button onClick={() => setEditing(true)} style={{ ...S.btn, ...S.btnGhost }}>Edit defaults</button>}
          {editing && <>
            <button onClick={() => { setEditing(false); setCp(defaults.default_cardpresent_markup_percent); setOn(defaults.default_online_markup_percent); }} disabled={busy} style={{ ...S.btn, ...S.btnGhost }}>Cancel</button>
            <button onClick={save} disabled={busy} style={{ ...S.btn, ...S.btnPrim }}>{busy ? 'Saving…' : 'Save defaults'}</button>
          </>}
        </div>
      </div>
    </div>
  );
}

// ─── Per-location card ────────────────────────────────────────────────────
function LocationCard({ location, companyName, msa, bs, defaults, onLink, onUnlink, onSavePricing }) {
  const linked = !!msa;
  const status = !linked
    ? { label: 'Not linked',       color: 'var(--t3)' }
    : !msa.charges_enabled
      ? { label: 'Onboarding incomplete', color: 'var(--orn)' }
      : { label: 'Live · charges enabled', color: 'var(--grn)' };
  const currency = (msa?.default_currency || bs?.current_period_currency || 'gbp').toUpperCase();

  // Local edit state for pricing fields
  const [cp, setCp] = useState(msa?.cardpresent_markup_percent ?? '');
  const [on, setOn] = useState(msa?.online_markup_percent ?? '');
  const [notes, setNotes] = useState(msa?.pricing_notes ?? '');
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState(null);

  // Sync local state if msa changes from outside
  useEffect(() => {
    setCp(msa?.cardpresent_markup_percent ?? '');
    setOn(msa?.online_markup_percent ?? '');
    setNotes(msa?.pricing_notes ?? '');
  }, [msa?.cardpresent_markup_percent, msa?.online_markup_percent, msa?.pricing_notes]);

  const dirty = linked && (
    String(cp) !== String(msa?.cardpresent_markup_percent ?? '') ||
    String(on) !== String(msa?.online_markup_percent ?? '') ||
    (notes ?? '') !== (msa?.pricing_notes ?? '')
  );

  const effectiveCp = cp === '' ? defaults.default_cardpresent_markup_percent : Number(cp);
  const effectiveOn = on === '' ? defaults.default_online_markup_percent      : Number(on);

  return (
    <div style={S.card}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, marginBottom: linked ? 16 : 0, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div style={{ fontSize: 11, color: 'var(--acc)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 2 }}>
            {companyName}
          </div>
          <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--t1)', marginBottom: 3 }}>{location.name}</div>
          <div style={{ fontSize: 11, color: 'var(--t4)', marginBottom: 10, fontFamily: 'var(--font-mono, monospace)' }}>{location.id}</div>

          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 13, color: status.color, fontWeight: 700 }}>
              <span style={{ width: 8, height: 8, borderRadius: 99, background: status.color }} />
              {status.label}
            </span>
            {linked && (
              <>
                <span style={S.pill}>{msa.country ?? '—'}</span>
                <span style={S.pill}>{currency}</span>
                <span style={S.pill}>{msa.link_method === 'admin_manual' ? 'Manual' : 'Express'}</span>
                <code style={{ fontSize: 11, color: 'var(--t2)', fontFamily: 'var(--font-mono, monospace)' }}>{msa.stripe_account_id}</code>
              </>
            )}
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flexShrink: 0 }}>
          {!linked && <button onClick={onLink} style={{ ...S.btn, ...S.btnPrim }}>Link Stripe account</button>}
          {linked && <button onClick={onUnlink} style={{ ...S.btn, ...S.btnDan }}>Unlink</button>}
        </div>
      </div>

      {/* Pricing + GMV (only meaningful once linked) */}
      {linked && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
            <div>
              <label style={S.label}>In-person (card present) markup %</label>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input
                  type="number" step="0.01" min="0" max="100"
                  placeholder={`default ${Number(defaults.default_cardpresent_markup_percent ?? 0).toFixed(2)}`}
                  value={cp} onChange={e => setCp(e.target.value)}
                  style={{ ...S.input, ...S.inputMono }}
                />
                <span style={{ color: 'var(--t3)', fontSize: 13, fontWeight: 700 }}>%</span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 4 }}>
                {cp === '' ? <>Using platform default. Effective: <strong>{effectiveCp.toFixed(2)}%</strong></> : <>Override: <strong>{Number(cp).toFixed(2)}%</strong></>}
              </div>
            </div>
            <div>
              <label style={S.label}>Online markup %</label>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input
                  type="number" step="0.01" min="0" max="100"
                  placeholder={`default ${Number(defaults.default_online_markup_percent ?? 0).toFixed(2)}`}
                  value={on} onChange={e => setOn(e.target.value)}
                  style={{ ...S.input, ...S.inputMono }}
                />
                <span style={{ color: 'var(--t3)', fontSize: 13, fontWeight: 700 }}>%</span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 4 }}>
                {on === '' ? <>Using platform default. Effective: <strong>{effectiveOn.toFixed(2)}%</strong></> : <>Override: <strong>{Number(on).toFixed(2)}%</strong></>}
              </div>
            </div>
          </div>

          <div style={{ marginBottom: 14 }}>
            <label style={S.label}>Pricing notes (internal)</label>
            <input
              type="text" value={notes} onChange={e => setNotes(e.target.value)}
              placeholder="e.g. Negotiated by Sales Aug-26, locked-in until Dec-26"
              style={S.input}
            />
          </div>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: bs ? 14 : 0 }}>
            <button
              onClick={async () => {
                setBusy(true);
                const ok = await onSavePricing({ cardpresent: cp, online: on, notes });
                setBusy(false);
                if (ok) { setSavedAt(Date.now()); setTimeout(() => setSavedAt(null), 2500); }
              }}
              disabled={busy || !dirty}
              style={{ ...S.btn, ...(dirty ? S.btnPrim : S.btnGhost) }}
            >
              {busy ? 'Saving…' : 'Save pricing'}
            </button>
            <button
              onClick={() => {
                setCp(msa?.cardpresent_markup_percent ?? '');
                setOn(msa?.online_markup_percent ?? '');
                setNotes(msa?.pricing_notes ?? '');
              }}
              disabled={busy || !dirty}
              style={{ ...S.btn, ...S.btnGhost }}
            >Reset</button>
            {savedAt && <span style={{ fontSize: 12, color: 'var(--grn)', fontWeight: 700 }}>✓ Saved</span>}
          </div>

          {bs && (
            <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap', paddingTop: 12, borderTop: '1px solid var(--bdr)' }}>
              <Stat label="GMV this month" value={fmt(bs.gmv_this_month, currency)} />
              <Stat label="Plan" value={(bs.current_plan ?? '—').toUpperCase()} accent />
              <Stat label="Monthly SaaS fee" value={fmt(bs.current_monthly_fee, currency)} />
              <Stat label="Last month GMV" value={fmt(bs.gmv_last_month, currency)} />
              <Stat label="Period start" value={bs.current_period_start ?? '—'} />
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Stat({ label, value, accent }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 2, fontWeight: 700 }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 700, color: accent ? 'var(--acc)' : 'var(--t1)' }}>{value}</div>
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
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(2px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }} onClick={onClose}>
      <div style={{ ...S.card, width: 480, maxWidth: 'calc(100vw - 32px)', marginBottom: 0, boxShadow: 'var(--sh3)' }} onClick={e => e.stopPropagation()}>
        <h2 style={{ ...S.h1, fontSize: 18, marginBottom: 4 }}>Link Stripe account</h2>
        <div style={{ fontSize: 13, color: 'var(--t3)', marginBottom: 16 }}>
          to <strong style={{ color: 'var(--t1)' }}>{location.name}</strong>
        </div>
        <label style={S.label}>Stripe account ID</label>
        <input type="text" value={acctId} onChange={e => setAcctId(e.target.value)} placeholder="acct_1ABC..." style={{ ...S.input, ...S.inputMono }} autoFocus />
        <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 6, marginBottom: 16 }}>
          The connected account from <code style={{ fontFamily: 'var(--font-mono, monospace)' }}>dashboard.stripe.com → Connect → Accounts</code>. Validated with Stripe before linking.
        </div>
        {error && <div style={S.errorBox}>{error}</div>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={onClose} disabled={submitting} style={{ ...S.btn, ...S.btnGhost }}>Cancel</button>
          <button onClick={submit} disabled={submitting || !acctId} style={{ ...S.btn, ...S.btnPrim }}>
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
