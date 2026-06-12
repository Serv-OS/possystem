// src/admin/sections/AdminBillingManager.jsx
// Admin-only payments manager: per-location PROCESSOR (Stripe | Ryft), the
// merchant account link/onboarding for whichever is active, negotiated markup %
// (the platform fee), and — for Ryft — a recorded buy rate for margin visibility.
//
// Stripe side is unchanged (markup only, client-side writes as before). Ryft
// account lifecycle + pricing + the processor toggle all go through the
// service-role `payments-admin` edge function (super_admin only), so the Ryft
// account/pricing tables stay service-role-write.
//
// Themed with the same CSS variables as the customer back office.

import { useEffect, useState, useCallback } from 'react';
import { supabase, platformSupabase } from '../../lib/supabase';

const FUNCTIONS_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`;

// Call the admin payments edge fn with the signed-in (Ops) super_admin token.
async function callPaymentsAdmin(action, payload) {
  const { data: session } = await supabase.auth.getSession();
  const token = session?.session?.access_token;
  if (!token) throw new Error('not authenticated');
  const res = await fetch(`${FUNCTIONS_URL}/payments-admin`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ action, ...payload }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.error) throw new Error(j.error ?? `HTTP ${res.status}`);
  return j;
}

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
  // Segmented processor toggle
  seg:     { display: 'inline-flex', border: '1px solid var(--bdr2)', borderRadius: 8, overflow: 'hidden' },
  segBtn:  (active) => ({ padding: '6px 14px', fontSize: 12, fontWeight: 700, cursor: 'pointer', border: 'none', fontFamily: 'inherit', background: active ? 'var(--acc)' : 'transparent', color: active ? '#0b0c10' : 'var(--t2)' }),
};

export default function AdminBillingManager({ authUser }) {
  const [companies, setCompanies] = useState([]);
  const [locations, setLocations] = useState([]);
  const [msaByLoc, setMsaByLoc] = useState({});
  const [ryaByLoc, setRyaByLoc] = useState({});
  const [bsByLoc, setBsByLoc] = useState({});
  const [platformDefaults, setPlatformDefaults] = useState({ default_cardpresent_markup_percent: 1.0, default_online_markup_percent: 0.5 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [linkModalLoc, setLinkModalLoc] = useState(null);
  const [ryftModalLoc, setRyftModalLoc] = useState(null);
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

      let q = platformSupabase.from('locations').select('id, name, company_id, timezone, payment_processor').order('name');
      if (filterCompanyId) q = q.eq('company_id', filterCompanyId);
      const { data: locs, error: locErr } = await q;
      if (locErr) throw locErr;
      setLocations(locs ?? []);

      const ids = (locs ?? []).map(l => l.id);
      if (ids.length) {
        const [{ data: msas }, { data: ryas }, { data: bses }] = await Promise.all([
          platformSupabase.from('merchant_stripe_accounts').select('*').in('location_id', ids),
          platformSupabase.from('merchant_ryft_accounts').select('*').in('location_id', ids),
          platformSupabase.from('billing_state').select('*').in('location_id', ids),
        ]);
        const m = {}; (msas ?? []).forEach(r => { m[r.location_id] = r; });
        const ry = {}; (ryas ?? []).forEach(r => { ry[r.location_id] = r; });
        const b = {}; (bses ?? []).forEach(r => { b[r.location_id] = r; });
        setMsaByLoc(m);
        setRyaByLoc(ry);
        setBsByLoc(b);
      } else {
        setMsaByLoc({}); setRyaByLoc({}); setBsByLoc({});
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
  const upsertRyaPatch = (locationId, patch) => {
    setRyaByLoc(prev => ({ ...prev, [locationId]: { ...(prev[locationId] ?? {}), ...patch } }));
  };
  const setLocProcessor = (locationId, processor) => {
    setLocations(prev => prev.map(l => l.id === locationId ? { ...l, payment_processor: processor } : l));
  };

  return (
    <div style={S.page}>
      <h1 style={S.h1}>Payments — processors, accounts &amp; pricing</h1>
      <div style={S.sub}>Per-location payment processor (Stripe or Ryft), merchant account onboarding, and negotiated markup. For Ryft, the buy rate is recorded for margin visibility.</div>

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
          rya={ryaByLoc[loc.id]}
          bs={bsByLoc[loc.id]}
          defaults={platformDefaults}
          onError={setError}
          onSetProcessor={async (processor) => {
            const prev = loc.payment_processor || 'stripe';
            setLocProcessor(loc.id, processor);            // optimistic
            try { await callPaymentsAdmin('set_processor', { location_id: loc.id, processor }); }
            catch (e) { setLocProcessor(loc.id, prev); setError(`Couldn't switch processor: ${e.message}`); }
          }}
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
          onRyftConnect={() => setRyftModalLoc(loc)}
          onRyftSync={async () => {
            try { const r = await callPaymentsAdmin('ryft_sync', { location_id: loc.id }); upsertRyaPatch(loc.id, { charges_enabled: r.charges_enabled, requirements: { status: r.verification_status } }); return true; }
            catch (e) { setError(`Sync failed: ${e.message}`); return false; }
          }}
          onRyftUnlink={async () => {
            if (!confirm(`Unlink Ryft account from ${loc.name}? This detaches it here; it is not deleted at Ryft.`)) return;
            try { await callPaymentsAdmin('ryft_unlink', { location_id: loc.id }); setRyaByLoc(prev => { const n = { ...prev }; delete n[loc.id]; return n; }); }
            catch (e) { setError(`Unlink failed: ${e.message}`); }
          }}
          onRyftOnboardingLink={async () => {
            try {
              const r = await callPaymentsAdmin('ryft_onboarding_link', { location_id: loc.id, redirect_url: window.location.origin + '/?ryft_onboarded=1' });
              return r.onboarding_url || null;
            } catch (e) { setError(`Couldn't create onboarding link: ${e.message}`); return null; }
          }}
          onRyftSavePricing={async (vals) => {
            try { await callPaymentsAdmin('ryft_pricing', { location_id: loc.id, ...vals }); upsertRyaPatch(loc.id, {
              markup_percent: vals.markup_percent === '' || vals.markup_percent == null ? null : Number(vals.markup_percent),
              markup_fixed_pence: vals.markup_fixed_pence === '' || vals.markup_fixed_pence == null ? null : Math.round(Number(vals.markup_fixed_pence)),
              pricing_notes: vals.pricing_notes || null,
            }); return true; }
            catch (e) { setError(`Save failed: ${e.message}`); return false; }
          }}
          onRyftFees={async () => {
            try { return await callPaymentsAdmin('ryft_fees', { location_id: loc.id }); }
            catch (e) { setError(`Couldn't load fees: ${e.message}`); return null; }
          }}
        />
      ))}

      {linkModalLoc && (
        <StripeLinkModal
          location={linkModalLoc}
          onClose={() => setLinkModalLoc(null)}
          onLinked={() => { setLinkModalLoc(null); refresh(); }}
        />
      )}
      {ryftModalLoc && (
        <RyftOnboardModal
          location={ryftModalLoc}
          onClose={() => setRyftModalLoc(null)}
          onDone={() => { setRyftModalLoc(null); refresh(); }}
        />
      )}
    </div>
  );
}

// ─── Platform-wide defaults panel ─────────────────────────────────────────
// Stripe: markup defaults (unchanged). Ryft: the IC+ BUY-RATE CARD (our cost,
// all-in per card type + fixed pence, by GMV tier) plus the DEFAULT MARKUP
// (single % + fixed pence) used where a merchant has no override.
function PlatformDefaultsPanel({ defaults, onSave, authUserId, onError }) {
  const [editing, setEditing] = useState(false);
  const [cp, setCp] = useState(defaults.default_cardpresent_markup_percent);
  const [on, setOn] = useState(defaults.default_online_markup_percent);
  // Ryft: our blended cost (what Ryft charges us) + the markup we add on top.
  const [cPct, setCPct] = useState(defaults.ryft_cost_percent ?? '');
  const [cFix, setCFix] = useState(defaults.ryft_cost_fixed_pence ?? '');
  const [mkPct, setMkPct] = useState(defaults.default_ryft_markup_percent ?? '');
  const [mkFix, setMkFix] = useState(defaults.default_ryft_markup_fixed_pence ?? '');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setCp(defaults.default_cardpresent_markup_percent);
    setOn(defaults.default_online_markup_percent);
    setCPct(defaults.ryft_cost_percent ?? '');
    setCFix(defaults.ryft_cost_fixed_pence ?? '');
    setMkPct(defaults.default_ryft_markup_percent ?? '');
    setMkFix(defaults.default_ryft_markup_fixed_pence ?? '');
  }, [defaults]);

  const numOrNull = (v) => (v === '' || v === null || v === undefined ? null : Number(v));
  const intOrNull = (v) => (v === '' || v === null || v === undefined ? null : Math.round(Number(v)));

  const save = async () => {
    setBusy(true);
    try {
      const patch = {
        default_cardpresent_markup_percent: Number(cp),
        default_online_markup_percent: Number(on),
        ryft_cost_percent: numOrNull(cPct),
        ryft_cost_fixed_pence: intOrNull(cFix),
        default_ryft_markup_percent: numOrNull(mkPct),
        default_ryft_markup_fixed_pence: intOrNull(mkFix),
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

  const pct = (v) => `${Number(v ?? 0).toFixed(2)}%`;
  const pence = (v) => `${Number(v ?? 0)}p`;

  return (
    <div style={{ ...S.card, borderColor: 'var(--acc-b)', background: 'var(--acc-d)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 260 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--acc)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 4 }}>
            Platform defaults
          </div>
          <div style={{ fontSize: 14, color: 'var(--t1)', marginBottom: 8, lineHeight: 1.4 }}>
            Stripe markup, and the Ryft model in two numbers — our cost (what Ryft charges us) and the markup we add. The customer pays the sum.
          </div>
          {!editing && (() => {
            const c = Number(defaults.ryft_cost_percent ?? 0), cf = Number(defaults.ryft_cost_fixed_pence ?? 0);
            const m = Number(defaults.default_ryft_markup_percent ?? 0), mf = Number(defaults.default_ryft_markup_fixed_pence ?? 0);
            return (
              <div style={{ display: 'grid', gap: 10 }}>
                <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
                  <Stat label="Stripe in-person markup" value={pct(defaults.default_cardpresent_markup_percent)} />
                  <Stat label="Stripe online markup"    value={pct(defaults.default_online_markup_percent)} />
                </div>
                <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', paddingTop: 8, borderTop: '1px solid var(--bdr)' }}>
                  <Stat label="Ryft cost (what Ryft charges us)" value={`${pct(c)} + ${pence(cf)}`} />
                  <Stat label="Ryft markup (what we add)" value={`${pct(m)} + ${pence(mf)}`} accent />
                  <Stat label="Customer pays (default)" value={`${pct(c + m)} + ${pence(cf + mf)}`} />
                </div>
              </div>
            );
          })()}
          {editing && (
            <div style={{ display: 'grid', gap: 14, maxWidth: 520 }}>
              <div>
                <div style={{ ...S.label, color: 'var(--t2)' }}>Stripe markup (platform fee)</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  <NumField label="In-person %" value={cp} onChange={setCp} />
                  <NumField label="Online %" value={on} onChange={setOn} />
                </div>
              </div>
              <div>
                <div style={{ ...S.label, color: 'var(--t2)' }}>Ryft cost — what Ryft charges us (blended)</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  <NumField label="Cost %" value={cPct} onChange={setCPct} />
                  <NumField label="Per-txn fee (pence)" value={cFix} onChange={setCFix} />
                </div>
              </div>
              <div>
                <div style={{ ...S.label, color: 'var(--t2)' }}>Ryft markup — what we add on top</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  <NumField label="Markup %" value={mkPct} onChange={setMkPct} />
                  <NumField label="Per-txn fee (pence)" value={mkFix} onChange={setMkFix} />
                </div>
              </div>
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {!editing && <button onClick={() => setEditing(true)} style={{ ...S.btn, ...S.btnGhost }}>Edit defaults</button>}
          {editing && <>
            <button onClick={() => setEditing(false)} disabled={busy} style={{ ...S.btn, ...S.btnGhost }}>Cancel</button>
            <button onClick={save} disabled={busy} style={{ ...S.btn, ...S.btnPrim }}>{busy ? 'Saving…' : 'Save defaults'}</button>
          </>}
        </div>
      </div>
    </div>
  );
}

function NumField({ label, value, onChange }) {
  return (
    <div>
      <label style={S.label}>{label}</label>
      <input type="number" step="0.01" min="0" max="100" value={value} onChange={e => onChange(e.target.value)} style={{ ...S.input, ...S.inputMono }} />
    </div>
  );
}

// ─── Per-location card ────────────────────────────────────────────────────
function LocationCard({ location, companyName, msa, rya, bs, defaults, onError,
  onSetProcessor, onLink, onUnlink, onSavePricing,
  onRyftConnect, onRyftSync, onRyftUnlink, onRyftOnboardingLink, onRyftSavePricing, onRyftFees }) {
  const processor = location.payment_processor || 'stripe';
  const currency = (msa?.default_currency || rya?.default_currency || bs?.current_period_currency || 'gbp').toUpperCase();

  return (
    <div style={S.card}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, marginBottom: 16, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div style={{ fontSize: 11, color: 'var(--acc)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 2 }}>
            {companyName}
          </div>
          <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--t1)', marginBottom: 3 }}>{location.name}</div>
          <div style={{ fontSize: 11, color: 'var(--t4)', marginBottom: 10, fontFamily: 'var(--font-mono, monospace)' }}>{location.id}</div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end' }}>
          <span style={{ ...S.label, marginBottom: 0 }}>Processor</span>
          <div style={S.seg}>
            <button style={S.segBtn(processor === 'stripe')} onClick={() => processor !== 'stripe' && onSetProcessor('stripe')}>Stripe</button>
            <button style={S.segBtn(processor === 'ryft')} onClick={() => processor !== 'ryft' && onSetProcessor('ryft')}>Ryft</button>
          </div>
        </div>
      </div>

      {processor === 'stripe'
        ? <StripeBlock msa={msa} bs={bs} currency={currency} defaults={defaults} onLink={onLink} onUnlink={onUnlink} onSavePricing={onSavePricing} />
        : <RyftBlock rya={rya} currency={currency} defaults={defaults} onError={onError} onConnect={onRyftConnect} onSync={onRyftSync} onUnlink={onRyftUnlink} onOnboardingLink={onRyftOnboardingLink} onSavePricing={onRyftSavePricing} onFees={onRyftFees} />}
    </div>
  );
}

// ─── Stripe block (unchanged behaviour) ────────────────────────────────────
function StripeBlock({ msa, bs, currency, defaults, onLink, onUnlink, onSavePricing }) {
  const linked = !!msa;
  const status = !linked
    ? { label: 'Not linked',       color: 'var(--t3)' }
    : !msa.charges_enabled
      ? { label: 'Onboarding incomplete', color: 'var(--orn)' }
      : { label: 'Live · charges enabled', color: 'var(--grn)' };

  const [cp, setCp] = useState(msa?.cardpresent_markup_percent ?? '');
  const [on, setOn] = useState(msa?.online_markup_percent ?? '');
  const [notes, setNotes] = useState(msa?.pricing_notes ?? '');
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState(null);

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
    <>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: linked ? 16 : 0 }}>
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
        <div style={{ marginLeft: 'auto' }}>
          {!linked && <button onClick={onLink} style={{ ...S.btn, ...S.btnPrim }}>Link Stripe account</button>}
          {linked && <button onClick={onUnlink} style={{ ...S.btn, ...S.btnDan }}>Unlink</button>}
        </div>
      </div>

      {linked && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
            <MarkupField label="In-person (card present) markup %" value={cp} onChange={setCp} effective={effectiveCp} isOverride={cp !== ''} def={defaults.default_cardpresent_markup_percent} />
            <MarkupField label="Online markup %" value={on} onChange={setOn} effective={effectiveOn} isOverride={on !== ''} def={defaults.default_online_markup_percent} />
          </div>
          <NotesRow notes={notes} setNotes={setNotes} />
          <SaveRow busy={busy} dirty={dirty} savedAt={savedAt}
            onSave={async () => { setBusy(true); const ok = await onSavePricing({ cardpresent: cp, online: on, notes }); setBusy(false); if (ok) { setSavedAt(Date.now()); setTimeout(() => setSavedAt(null), 2500); } }}
            onReset={() => { setCp(msa?.cardpresent_markup_percent ?? ''); setOn(msa?.online_markup_percent ?? ''); setNotes(msa?.pricing_notes ?? ''); }}
          />
          {bs && (
            <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap', paddingTop: 12, borderTop: '1px solid var(--bdr)', marginTop: 14 }}>
              <Stat label="GMV this month" value={fmt(bs.gmv_this_month, currency)} />
              <Stat label="Plan" value={(bs.current_plan ?? '—').toUpperCase()} accent />
              <Stat label="Monthly SaaS fee" value={fmt(bs.current_monthly_fee, currency)} />
              <Stat label="Last month GMV" value={fmt(bs.gmv_last_month, currency)} />
            </div>
          )}
        </>
      )}
    </>
  );
}

// ─── Ryft block ────────────────────────────────────────────────────────────
function RyftBlock({ rya, currency, defaults, onConnect, onSync, onUnlink, onOnboardingLink, onSavePricing, onFees }) {
  const linked = !!rya;
  const vStatus = rya?.requirements?.status ?? null;       // verification.status, when known
  const status = !linked
    ? { label: 'Not connected', color: 'var(--t3)' }
    : rya.charges_enabled
      ? { label: 'Live · charges enabled', color: 'var(--grn)' }
      : { label: vStatus ? `Onboarding · ${vStatus}` : 'Onboarding incomplete', color: 'var(--orn)' };

  const [mkPct, setMkPct] = useState(rya?.markup_percent ?? '');
  const [mkFix, setMkFix] = useState(rya?.markup_fixed_pence ?? '');
  const [notes, setNotes] = useState(rya?.pricing_notes ?? '');
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [link, setLink] = useState(null);      // freshly-minted onboarding URL
  const [fees, setFees] = useState(null);      // live fees pulled from Ryft
  const [feesBusy, setFeesBusy] = useState(false);

  useEffect(() => {
    setMkPct(rya?.markup_percent ?? '');
    setMkFix(rya?.markup_fixed_pence ?? '');
    setNotes(rya?.pricing_notes ?? '');
  }, [rya?.markup_percent, rya?.markup_fixed_pence, rya?.pricing_notes]);

  const dirty = linked && (
    String(mkPct) !== String(rya?.markup_percent ?? '') ||
    String(mkFix) !== String(rya?.markup_fixed_pence ?? '') ||
    (notes ?? '') !== (rya?.pricing_notes ?? '')
  );
  const num = (v, d) => (v === '' || v == null ? Number(d ?? 0) : Number(v));
  const mkPctEff = num(mkPct, defaults.default_ryft_markup_percent);
  const mkFixEff = num(mkFix, defaults.default_ryft_markup_fixed_pence);
  const costPct = Number(defaults.ryft_cost_percent ?? 0);
  const costFix = Number(defaults.ryft_cost_fixed_pence ?? 0);
  const fmtMoney = (minor) => fmt((Number(minor) || 0) / 100, fees?.currency || currency);

  return (
    <>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: linked ? 16 : 0 }}>
        <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 13, color: status.color, fontWeight: 700 }}>
          <span style={{ width: 8, height: 8, borderRadius: 99, background: status.color }} />
          {status.label}
        </span>
        {linked && (
          <>
            <span style={S.pill}>{rya.country ?? '—'}</span>
            <span style={S.pill}>{currency}</span>
            <span style={S.pill}>Hosted</span>
            <code style={{ fontSize: 11, color: 'var(--t2)', fontFamily: 'var(--font-mono, monospace)' }}>{rya.ryft_account_id}</code>
          </>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          {!linked && <button onClick={onConnect} style={{ ...S.btn, ...S.btnPrim }}>Connect Ryft merchant</button>}
          {linked && <>
            <button onClick={async () => { const url = await onOnboardingLink(); if (url) setLink(url); }} style={{ ...S.btn, ...S.btnGhost }}>Continue onboarding</button>
            <button onClick={async () => { setSyncing(true); await onSync(); setSyncing(false); }} disabled={syncing} style={{ ...S.btn, ...S.btnGhost }}>{syncing ? 'Syncing…' : 'Sync status'}</button>
            <button onClick={onUnlink} style={{ ...S.btn, ...S.btnDan }}>Unlink</button>
          </>}
        </div>
      </div>

      {link && <OnboardingLinkBox url={link} onClose={() => setLink(null)} />}

      {!linked && (
        <div style={{ fontSize: 12, color: 'var(--t3)', lineHeight: 1.5 }}>
          Create a Ryft sub-account (merchant) for this location, then send them through Ryft's hosted onboarding to complete KYC/KYB. Pricing appears here once connected.
        </div>
      )}

      {linked && (
        <>
          <div style={{ ...S.label, color: 'var(--t2)', marginBottom: 8 }}>Our markup — what we add on top of Ryft's cost (blank = platform default)</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 8 }}>
            <MarkupField label="Markup %" value={mkPct} onChange={setMkPct} effective={mkPctEff} isOverride={mkPct !== ''} def={defaults.default_ryft_markup_percent} />
            <MarkupField label="Per-transaction fee" value={mkFix} onChange={setMkFix} effective={mkFixEff} isOverride={mkFix !== ''} def={defaults.default_ryft_markup_fixed_pence} unit="p" />
          </div>
          {/* Our cost + what we add = what the customer pays */}
          <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap', padding: '10px 12px', background: 'var(--bg2)', borderRadius: 8, marginBottom: 12, border: '1px solid var(--bdr)' }}>
            <Stat label="Our cost" value={`${costPct.toFixed(2)}% + ${costFix}p`} />
            <Stat label="We add (markup)" value={`${mkPctEff.toFixed(2)}% + ${mkFixEff}p`} accent />
            <Stat label="Customer pays" value={`${(costPct + mkPctEff).toFixed(2)}% + ${costFix + mkFixEff}p`} />
          </div>
          <div style={{ fontSize: 11, color: 'var(--t3)', marginBottom: 12, lineHeight: 1.5 }}>
            Our cost is set in Platform defaults; markup is the platformFee we take. The customer sees only "customer pays". Actual fees come back live from Ryft below.
          </div>

          <NotesRow notes={notes} setNotes={setNotes} />
          <SaveRow busy={busy} dirty={dirty} savedAt={savedAt}
            onSave={async () => { setBusy(true); const ok = await onSavePricing({ markup_percent: mkPct, markup_fixed_pence: mkFix, pricing_notes: notes }); setBusy(false); if (ok) { setSavedAt(Date.now()); setTimeout(() => setSavedAt(null), 2500); } }}
            onReset={() => { setMkPct(rya?.markup_percent ?? ''); setMkFix(rya?.markup_fixed_pence ?? ''); setNotes(rya?.pricing_notes ?? ''); }}
          />

          {/* Live fees & margin from Ryft */}
          <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--bdr)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: fees ? 10 : 0 }}>
              <div style={{ ...S.label, marginBottom: 0 }}>Fees &amp; margin — live from Ryft</div>
              <button onClick={async () => { setFeesBusy(true); const r = await onFees(); if (r) setFees(r); setFeesBusy(false); }} disabled={feesBusy} style={{ ...S.btn, ...S.btnGhost, padding: '5px 10px', fontSize: 12 }}>
                {feesBusy ? 'Loading…' : (fees ? '↻ Refresh' : 'Load fees')}
              </button>
            </div>
            {fees && (fees.txn_count > 0 || fees.fee_count > 0 ? (
              <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap' }}>
                <Stat label="Processed (GMV)" value={fmtMoney(fees.gmv_minor)} />
                <Stat label="Ryft fees (cost)" value={fmtMoney(fees.ryft_fees_minor)} />
                <Stat label="Our markup collected" value={fmtMoney(fees.markup_collected_minor)} accent />
                <Stat label="Transactions" value={String(fees.txn_count)} />
              </div>
            ) : (
              <div style={{ fontSize: 12, color: 'var(--t4)' }}>No transactions yet — this populates from Ryft as the merchant takes payments.</div>
            ))}
          </div>
        </>
      )}
    </>
  );
}

// ─── Small shared pieces ───────────────────────────────────────────────────
function MarkupField({ label, value, onChange, effective, isOverride, def, muted, unit = '%' }) {
  const isPence = unit === 'p';
  const fmtV = (v) => (isPence ? `${Math.round(Number(v || 0))}p` : `${Number(v || 0).toFixed(2)}%`);
  return (
    <div>
      <label style={S.label}>{label}</label>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <input type="number" step={isPence ? '1' : '0.01'} min="0" max={isPence ? '1000' : '100'}
          placeholder={`default ${isPence ? Math.round(Number(def ?? 0)) : Number(def ?? 0).toFixed(2)}`}
          value={value} onChange={e => onChange(e.target.value)}
          style={{ ...S.input, ...S.inputMono, ...(muted ? { opacity: 0.92 } : null) }} />
        <span style={{ color: 'var(--t3)', fontSize: 13, fontWeight: 700 }}>{unit}</span>
      </div>
      <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 4 }}>
        {isOverride ? <>Override: <strong>{fmtV(value)}</strong></> : <>Using default. Effective: <strong>{fmtV(effective ?? 0)}</strong></>}
      </div>
    </div>
  );
}

function NotesRow({ notes, setNotes }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={S.label}>Pricing notes (internal)</label>
      <input type="text" value={notes} onChange={e => setNotes(e.target.value)}
        placeholder="e.g. Negotiated by Sales Aug-26, locked-in until Dec-26" style={S.input} />
    </div>
  );
}

function SaveRow({ busy, dirty, savedAt, onSave, onReset }) {
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      <button onClick={onSave} disabled={busy || !dirty} style={{ ...S.btn, ...(dirty ? S.btnPrim : S.btnGhost) }}>
        {busy ? 'Saving…' : 'Save pricing'}
      </button>
      <button onClick={onReset} disabled={busy || !dirty} style={{ ...S.btn, ...S.btnGhost }}>Reset</button>
      {savedAt && <span style={{ fontSize: 12, color: 'var(--grn)', fontWeight: 700 }}>✓ Saved</span>}
    </div>
  );
}

function OnboardingLinkBox({ url, onClose }) {
  const [copied, setCopied] = useState(false);
  return (
    <div style={{ ...S.okBox, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 14 }}>
      <div style={{ flex: 1, minWidth: 220 }}>
        <div style={{ fontWeight: 700, marginBottom: 4 }}>Hosted onboarding link (send to the merchant):</div>
        <code style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 11, wordBreak: 'break-all', color: 'var(--t2)' }}>{url}</code>
      </div>
      <button onClick={() => { navigator.clipboard?.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 1500); }} style={{ ...S.btn, ...S.btnGhost }}>{copied ? '✓ Copied' : 'Copy'}</button>
      <a href={url} target="_blank" rel="noreferrer" style={{ ...S.btn, ...S.btnPrim, textDecoration: 'none' }}>Open</a>
      <button onClick={onClose} style={{ ...S.btn, ...S.btnGhost }}>Dismiss</button>
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

// ─── Stripe link modal (unchanged) ─────────────────────────────────────────
function StripeLinkModal({ location, onClose, onLinked }) {
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
    <ModalShell onClose={onClose} title="Link Stripe account" subtitle={location.name}>
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
    </ModalShell>
  );
}

// ─── Ryft onboard modal ────────────────────────────────────────────────────
function RyftOnboardModal({ location, onClose, onDone }) {
  const [mode, setMode] = useState('create');   // 'create' | 'link'
  const [email, setEmail] = useState('');
  const [tradingName, setTradingName] = useState('');
  const [acctId, setAcctId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);   // { account_id, onboarding_url }

  const submitCreate = async () => {
    setError(null);
    if (!email) { setError('A contact email is required to create the merchant.'); return; }
    setSubmitting(true);
    try {
      const r = await callPaymentsAdmin('ryft_create', {
        location_id: location.id,
        email,
        trading_name: tradingName || undefined,
        redirect_url: window.location.origin + '/?ryft_onboarded=1',
      });
      setResult(r);
    } catch (e) {
      setError(String(e?.message ?? e));
    } finally {
      setSubmitting(false);
    }
  };

  const submitLink = async () => {
    setError(null);
    if (!acctId.startsWith('ac_')) { setError("Account ID must start with 'ac_'"); return; }
    setSubmitting(true);
    try {
      await callPaymentsAdmin('ryft_link', { location_id: location.id, ryft_account_id: acctId.trim() });
      onDone();
    } catch (e) {
      setError(String(e?.message ?? e));
    } finally {
      setSubmitting(false);
    }
  };

  if (result) {
    return (
      <ModalShell onClose={onDone} title="Ryft merchant created" subtitle={location.name}>
        <div style={{ fontSize: 13, color: 'var(--t2)', marginBottom: 12 }}>
          Account <code style={{ fontFamily: 'var(--font-mono, monospace)' }}>{result.account_id}</code> created
          {result.verification_status ? <> · verification: <strong>{result.verification_status}</strong></> : null}.
        </div>
        {result.onboarding_url
          ? <OnboardingLinkBox url={result.onboarding_url} onClose={() => {}} />
          : <div style={S.errorBox}>{result.link_error || 'No onboarding link was returned — use “Continue onboarding” on the card to mint one.'}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button onClick={onDone} style={{ ...S.btn, ...S.btnPrim }}>Done</button>
        </div>
      </ModalShell>
    );
  }

  return (
    <ModalShell onClose={onClose} title="Connect Ryft merchant" subtitle={location.name}>
      <div style={{ ...S.seg, marginBottom: 14 }}>
        <button style={S.segBtn(mode === 'create')} onClick={() => setMode('create')}>Create new (sandbox)</button>
        <button style={S.segBtn(mode === 'link')} onClick={() => setMode('link')}>Link existing</button>
      </div>

      {mode === 'create' && (
        <>
          <label style={S.label}>Contact email</label>
          <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="owner@venue.com" style={S.input} autoFocus />
          <div style={{ marginTop: 12 }}>
            <label style={S.label}>Trading name (optional)</label>
            <input type="text" value={tradingName} onChange={e => setTradingName(e.target.value)} placeholder="Acme Coffee — Soho" style={S.input} />
            <div style={{ fontSize: 11, color: 'var(--t4)', marginTop: 4 }}>Stored as a label on the Ryft account; the merchant confirms legal details during onboarding.</div>
          </div>
          <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 12, marginBottom: 16, lineHeight: 1.5 }}>
            Creates a Hosted sub-account on Ryft and returns a link the merchant uses to choose Business/Individual, finish KYC/KYB, and add bank &amp; payout details. They aren't payment-ready until verification clears.
          </div>
          {error && <div style={S.errorBox}>{error}</div>}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={onClose} disabled={submitting} style={{ ...S.btn, ...S.btnGhost }}>Cancel</button>
            <button onClick={submitCreate} disabled={submitting || !email} style={{ ...S.btn, ...S.btnPrim }}>{submitting ? 'Creating…' : 'Create merchant'}</button>
          </div>
        </>
      )}

      {mode === 'link' && (
        <>
          <label style={S.label}>Ryft account ID</label>
          <input type="text" value={acctId} onChange={e => setAcctId(e.target.value)} placeholder="ac_xxxxxxxx-..." style={{ ...S.input, ...S.inputMono }} autoFocus />
          <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 6, marginBottom: 16 }}>
            An existing sub-account id from the Ryft dashboard. Validated with Ryft before linking.
          </div>
          {error && <div style={S.errorBox}>{error}</div>}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={onClose} disabled={submitting} style={{ ...S.btn, ...S.btnGhost }}>Cancel</button>
            <button onClick={submitLink} disabled={submitting || !acctId} style={{ ...S.btn, ...S.btnPrim }}>{submitting ? 'Linking…' : 'Link account'}</button>
          </div>
        </>
      )}
    </ModalShell>
  );
}

function ModalShell({ title, subtitle, onClose, children }) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(2px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }} onClick={onClose}>
      <div style={{ ...S.card, width: 520, maxWidth: 'calc(100vw - 32px)', marginBottom: 0, boxShadow: 'var(--sh3)' }} onClick={e => e.stopPropagation()}>
        <h2 style={{ ...S.h1, fontSize: 18, marginBottom: 4 }}>{title}</h2>
        {subtitle && <div style={{ fontSize: 13, color: 'var(--t3)', marginBottom: 16 }}>to <strong style={{ color: 'var(--t1)' }}>{subtitle}</strong></div>}
        {children}
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
