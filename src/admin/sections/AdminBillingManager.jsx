// src/admin/sections/AdminBillingManager.jsx
// Admin-only "Processing" section: per-location PROCESSOR (Stripe | Adyen),
// the merchant account link for whichever is active, and the negotiated
// pricing: the TIERED RATE CARD every competitor uses (card-present credit
// and debit / card-not-present online / American Express and business cards
// / manually keyed, each % + pence), set as a platform default and
// overridable per venue. The v5.7.0 flat rate stays on file as the legacy
// card-present fallback until a rate card is saved, so nothing already
// negotiated stops working.
//
// Writes go through the service-role `payments-admin` edge function
// (super_admin only): Stripe markup pricing + unlink, the processor toggle,
// the Adyen rate card (adyen_pricing v2) and, since 8 Sep 2026, the bulk
// adyen_accounts read the compact list is built from. The account/pricing
// tables are RLS select-only (or service-role-only) for the anon platform
// client, so client-side writes silently no-op: reads stay direct where
// allowed, writes go through the edge fn.
//
// OWNER RULES (8 Sep 2026):
//   0. The four payout onboarding buttons (Start onboarding, New onboarding
//      link, Configure splits, Set up daily payout) are HIDDEN from the admin
//      portal, not collapsed: the owner cannot use them here. The
//      adyen-onboard actions stay on the server; no UI in this portal calls
//      them.
//   1. Onboarding is seamless: Adyen already holds the venue's store,
//      balance account and account holder under the venue code (SV-1007) as
//      the store reference, so the admin PULLS the ids from Adyen by
//      reference (AdyenLinkPanel: adyen_lookup, then adyen_link) and never
//      types them. The manual "Enter Adyen details" form survives only under
//      a collapsed Advanced section, as a fallback.
//   2. The Processing list scales to many customers: one compact row per
//      venue (name, venue code, region chip, environment chip, then Linked /
//      Holder / KYC / Payouts chips), a search box (name, code or slug), the
//      detail only on expand. The open row and the search survive a reload
//      through sessionStorage.
//   The per venue Adyen ENVIRONMENT switch and the region are ServOS
//   internal actions too (AdyenEnvironmentControls; the adyen-terminal-admin
//   fn refuses them for anyone but a super_admin).
//
// Themed with the same CSS variables as the customer back office.

import { useEffect, useState, useCallback, useMemo } from 'react';
import { supabase, platformSupabase } from '../../lib/supabase';
import AdyenEnvironmentControls from '../components/AdyenEnvironmentControls';
import AdyenLinkPanel from '../components/AdyenLinkPanel';
import { adyenVenueStatus, stripeVenueStatus, matchesVenueSearch } from '../../lib/payments/adyenAdminRows';

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

// Call the payout-onboarding edge fn (adyen-onboard, super_admin fenced).
// Unlike callPaymentsAdmin this RETURNS non-ok payloads instead of throwing:
// the fn classifies every failure (awaiting_enablement / missing_prerequisite
// / error) and the panel renders each kind differently. Since 8 Sep 2026
// the portal only calls status, list_merchants, list_stores and save_manual
// (OWNER RULE 0: the onboarding actions have no buttons here).
async function callAdyenOnboard(action, payload) {
  const { data: session } = await supabase.auth.getSession();
  const token = session?.session?.access_token;
  if (!token) throw new Error('not authenticated');
  const res = await fetch(`${FUNCTIONS_URL}/adyen-onboard`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ action, ...payload }),
  });
  const j = await res.json().catch(() => ({}));
  if (j.error && j.ok === undefined) throw new Error(j.error);
  return j;
}

// Call adyen-terminal-admin for ONE venue with the signed-in (Ops) super_admin
// token, the same session callAdyenOnboard uses. The fn fences on
// user_locations membership OR super_admin, so the admin needs no
// user_locations row at the venue. It resolves the venue from either id: the
// ops id is sent when the platform row knows it, else the platform id, which
// the fn maps onto the ops id itself. Non-2xx answers THROW with .status and
// .data so AdyenEnvironmentControls and AdyenLinkPanel can act on structured
// refusals (set_environment answers 409 + needs_reprovision, adyen_link 409 +
// needs_relink).
function terminalAdminFor(location) {
  return async (action, payload = {}) => {
    const { data: session } = await supabase.auth.getSession();
    const token = session?.session?.access_token;
    if (!token) throw new Error('not authenticated');
    const res = await fetch(`${FUNCTIONS_URL}/adyen-terminal-admin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ action, ops_location_id: location.ops_location_id || location.id, location_id: location.id, ...payload }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(j?.error || `HTTP ${res.status}`);
      err.status = res.status;
      err.data = j;
      throw err;
    }
    return j;
  };
}

// The four pricing tiers (migration 20260821b); the order matches the venue's
// Settings tab so both screens read the same way.
const TIERS = [
  { id: 'card_present', label: 'Card-present (credit & debit)' },
  { id: 'card_not_present', label: 'Card-not-present (online)' },
  { id: 'amex', label: 'American Express & business cards' },
  { id: 'keyed', label: 'Manually keyed' },
];

const emptyCard = () => Object.fromEntries(TIERS.map(t => [t.id, { percent: '', fixed_pence: '' }]));

// jsonb rate card → editor state ('' for null so inputs stay controlled).
const cardToState = (card) => {
  const st = emptyCard();
  for (const t of TIERS) {
    const row = card?.[t.id];
    if (!row) continue;
    st[t.id] = {
      percent: row.percent === null || row.percent === undefined ? '' : String(row.percent),
      fixed_pence: row.fixed_pence === null || row.fixed_pence === undefined ? '' : String(row.fixed_pence),
    };
  }
  return st;
};

// editor state → jsonb rate card ('' → null; the server sanitizes again).
const stateToCard = (st) => Object.fromEntries(TIERS.map(t => {
  const row = st[t.id] ?? {};
  return [t.id, {
    percent: row.percent === '' || row.percent === undefined ? null : Number(row.percent),
    fixed_pence: row.fixed_pence === '' || row.fixed_pence === undefined ? null : Math.round(Number(row.fixed_pence)),
  }];
}));

const cardsEqual = (a, b) => JSON.stringify(stateToCard(a)) === JSON.stringify(stateToCard(b));

const fmtRate = (pct, pence) => {
  if (pct == null && pence == null) return 'Not set';
  return `${Number(pct ?? 0).toFixed(2)}% + ${Math.round(Number(pence ?? 0))}p`;
};

// The search box and the open row survive a reload (per tab). Every access
// is guarded: private mode, blocked storage and a quota error all just mean
// the page starts clean.
const SS_SEARCH = 'admin.processing.search';
const SS_EXPANDED = 'admin.processing.expanded';
const ssGet = (key) => { try { return sessionStorage.getItem(key) ?? ''; } catch { return ''; } };
const ssSet = (key, value) => {
  try { if (value) sessionStorage.setItem(key, value); else sessionStorage.removeItem(key); }
  catch { /* storage blocked: the page still works, it just forgets on reload */ }
};

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
  warnBox: { padding: 10, background: 'var(--orn-d, rgba(230,160,60,.12))', color: 'var(--orn, #e8a020)', borderRadius: 8, marginBottom: 14, fontSize: 12, border: '1px solid var(--orn-b, var(--bdr2))', lineHeight: 1.5 },
  // Segmented processor toggle
  seg:     { display: 'inline-flex', border: '1px solid var(--bdr2)', borderRadius: 8, overflow: 'hidden' },
  segBtn:  (active) => ({ padding: '6px 14px', fontSize: 12, fontWeight: 700, cursor: 'pointer', border: 'none', fontFamily: 'inherit', background: active ? 'var(--acc)' : 'transparent', color: active ? '#0b0c10' : 'var(--t2)' }),
};

// Row chips. The owner's palette: live red, test grey, ok green, missing
// amber; bad (red) is a rejected KYC, muted says nothing is known.
const CHIP_TONES = {
  live:    { background: 'var(--red)', color: '#fff', borderColor: 'var(--red)' },
  test:    { background: 'var(--bg3)', color: 'var(--t2)', borderColor: 'var(--bdr2)' },
  ok:      { background: 'var(--grn-d, rgba(21,194,106,.12))', color: 'var(--grn)', borderColor: 'var(--grn-b, var(--grn))' },
  missing: { background: 'var(--orn-d, rgba(230,160,60,.12))', color: 'var(--orn, #e8a020)', borderColor: 'var(--orn-b, var(--bdr2))' },
  bad:     { background: 'var(--red-d, rgba(255,90,74,.1))', color: 'var(--red)', borderColor: 'var(--red-b, var(--red))' },
  muted:   { background: 'transparent', color: 'var(--t3)', borderColor: 'var(--bdr2)' },
};
function Chip({ tone = 'muted', title, children }) {
  return <span title={title} style={{ ...S.pill, ...CHIP_TONES[tone], whiteSpace: 'nowrap' }}>{children}</span>;
}

export default function AdminBillingManager({ authUser }) {
  const [companies, setCompanies] = useState([]);
  const [locations, setLocations] = useState([]);
  const [msaByLoc, setMsaByLoc] = useState({});
  const [bsByLoc, setBsByLoc] = useState({});
  // merchant_adyen_accounts rows (whitelisted fields) by platform location
  // id, from the bulk adyen_accounts read. null = the read failed (an older
  // payments-admin build): the rows then say "status unknown" rather than
  // painting every venue amber.
  const [adyenByLoc, setAdyenByLoc] = useState(null);
  // ops locations.venue_code by platform location id (the Adyen store
  // reference; rides on the same bulk read, or is read from the ops
  // locations directly when that read failed).
  const [venueCodes, setVenueCodes] = useState({});
  const [rowsNote, setRowsNote] = useState(null);
  const [platformDefaults, setPlatformDefaults] = useState({ default_cardpresent_markup_percent: 1.0, default_online_markup_percent: 0.5 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [linkModalLoc, setLinkModalLoc] = useState(null);
  const [filterCompanyId, setFilterCompanyId] = useState('');
  const [search, setSearch] = useState(() => ssGet(SS_SEARCH));
  const [expandedId, setExpandedId] = useState(() => ssGet(SS_EXPANDED));

  // The bulk Adyen read on its own, so a link or a flip refreshes the chips
  // without reloading the whole page.
  const loadAdyenRows = useCallback(async (locs) => {
    const list = locs ?? [];
    const ids = list.map((l) => l.id);
    if (!ids.length) { setAdyenByLoc({}); setVenueCodes({}); setRowsNote(null); return; }
    try {
      const r = await callPaymentsAdmin('adyen_accounts', { location_ids: ids });
      const m = {};
      (r.accounts ?? []).forEach((row) => { if (row?.location_id) m[row.location_id] = row; });
      setAdyenByLoc(m);
      setVenueCodes(r.venue_codes ?? {});
      setRowsNote(Array.isArray(r.notes) && r.notes.length ? r.notes.join(' ') : null);
    } catch (e) {
      setAdyenByLoc(null);
      setRowsNote(`The row status could not be read (${e.message}). Redeploy payments-admin for the Linked, Holder, KYC and Payouts chips; a venue's detail still loads when expanded.`);
      // The venue codes straight from the ops locations, with the signed in
      // super_admin token (the Companies section reads them the same way).
      try {
        const opsIds = Array.from(new Set(list.map((l) => l.ops_location_id || l.id)));
        const { data } = await supabase.from('locations').select('id, venue_code').in('id', opsIds);
        const byOps = {};
        (data ?? []).forEach((o) => { if (o.venue_code) byOps[o.id] = o.venue_code; });
        const codes = {};
        list.forEach((l) => { const c = byOps[l.ops_location_id || l.id]; if (c) codes[l.id] = c; });
        setVenueCodes(codes);
      } catch { setVenueCodes({}); }
    }
  }, []);

  const refresh = useCallback(async () => {
    if (!platformSupabase) {
      setError('Platform Supabase not configured (VITE_PLATFORM_SUPABASE_URL / _ANON_KEY missing).');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [{ data: cos, error: coErr }, { data: ps }, adyenDef] = await Promise.all([
        platformSupabase.from('companies').select('id, name').order('name'),
        platformSupabase.from('platform_settings').select('*').eq('id', true).maybeSingle(),
        // platform_settings can be unreadable to the anon platform client, so
        // the Adyen defaults come through the service-role payments-admin fn.
        callPaymentsAdmin('adyen_pricing', {}).catch(e => { console.warn('[billing] adyen defaults failed', e?.message); return null; }),
      ]);
      if (coErr) throw coErr;
      setCompanies(cos ?? []);
      const merged = { ...(ps ?? {}) };
      if (adyenDef?.defaults) {
        merged.default_adyen_markup_percent = adyenDef.defaults.default_markup_percent;
        merged.default_adyen_markup_fixed_pence = adyenDef.defaults.default_markup_fixed_pence;
        merged.default_adyen_rate_card = adyenDef.defaults.rate_card ?? null;
        merged.adyen_rate_card_ready = adyenDef.rate_card_ready !== false;
      }
      if (Object.keys(merged).length) setPlatformDefaults(prev => ({ ...prev, ...merged }));

      // No `country` here: platform locations has no such column, and a bad
      // column fails the whole query (no venue rows at all). online_slug is
      // real (migration 20260508) and feeds the search box.
      let q = platformSupabase.from('locations').select('id, name, company_id, timezone, payment_processor, ops_location_id, address, currency, online_slug').order('name');
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
      await loadAdyenRows(locs ?? []);
    } catch (e) {
      setError(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  }, [filterCompanyId, loadAdyenRows]);

  useEffect(() => { refresh(); }, [refresh]);

  const companyName = (id) => companies.find(c => c.id === id)?.name ?? '(unknown)';
  const upsertMsaPatch = (locationId, patch) => {
    setMsaByLoc(prev => ({ ...prev, [locationId]: { ...(prev[locationId] ?? {}), ...patch } }));
  };
  const setLocProcessor = (locationId, processor) => {
    setLocations(prev => prev.map(l => l.id === locationId ? { ...l, payment_processor: processor } : l));
  };
  const toggleRow = (id) => setExpandedId((cur) => { const next = cur === id ? '' : id; ssSet(SS_EXPANDED, next); return next; });
  const onSearch = (value) => { setSearch(value); ssSet(SS_SEARCH, value); };

  const shown = locations.filter((loc) => matchesVenueSearch({
    name: loc.name, venue_code: venueCodes[loc.id], online_slug: loc.online_slug, company: companyName(loc.company_id), id: loc.id,
  }, search));

  return (
    <div style={S.page}>
      <h1 style={S.h1}>Processing: accounts and pricing</h1>
      <div style={S.sub}>Per-location payment processor (Stripe or ServOS Payments via Adyen), the Adyen link pulled by venue reference, and the tiered processing rates each venue pays.</div>

      {/* Platform-wide defaults */}
      <PlatformDefaultsPanel
        defaults={platformDefaults}
        onSave={(next) => { setPlatformDefaults(next); }}
        authUserId={authUser?.id}
        onError={setError}
      />

      {/* SaaS plans (v5.7.4): its own card, separate from the card-rate editors */}
      <SaasPlansPanel onError={setError} />

      <div style={{ display: 'flex', gap: 10, marginBottom: 14, alignItems: 'center', flexWrap: 'wrap' }}>
        <select
          value={filterCompanyId}
          onChange={e => setFilterCompanyId(e.target.value)}
          style={{ ...S.input, width: 260 }}
        >
          <option value="">All companies ({companies.length})</option>
          {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <input
          type="search"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          placeholder="Search name, venue code or slug"
          aria-label="Search venues"
          style={{ ...S.input, width: 280 }}
        />
        <button onClick={refresh} disabled={loading} style={{ ...S.btn, ...S.btnGhost }}>
          {loading ? 'Loading…' : '↻ Refresh'}
        </button>
        <div style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--t3)' }}>
          {search ? `${shown.length} of ${locations.length}` : locations.length} venue{locations.length === 1 ? '' : 's'}
        </div>
      </div>

      {error && <div style={S.errorBox}>{error}</div>}
      {rowsNote && !error && <div style={S.warnBox}>{rowsNote}</div>}

      {!error && locations.length === 0 && !loading && (
        <div style={{ ...S.card, color: 'var(--t3)', textAlign: 'center', padding: 40 }}>No locations found.</div>
      )}
      {!error && locations.length > 0 && shown.length === 0 && (
        <div style={{ ...S.card, color: 'var(--t3)', textAlign: 'center', padding: 30 }}>No venue matches &ldquo;{search}&rdquo;.</div>
      )}

      {shown.length > 0 && (
        <div style={{ ...S.card, padding: 0, overflow: 'hidden' }}>
          {shown.map(loc => (
            <VenueRow
              key={loc.id}
              location={loc}
              companyName={companyName(loc.company_id)}
              venueCode={venueCodes[loc.id] || null}
              adyenRow={adyenByLoc ? (adyenByLoc[loc.id] ?? null) : null}
              adyenKnown={adyenByLoc !== null}
              msa={msaByLoc[loc.id]}
              expanded={expandedId === loc.id}
              onToggle={() => toggleRow(loc.id)}
            >
              <VenueDetail
                location={loc}
                venueCode={venueCodes[loc.id] || null}
                adyenRow={adyenByLoc ? (adyenByLoc[loc.id] ?? null) : null}
                msa={msaByLoc[loc.id]}
                bs={bsByLoc[loc.id]}
                defaults={platformDefaults}
                onError={setError}
                onAdyenChanged={() => loadAdyenRows(locations)}
                onSetProcessor={async (processor) => {
                  const prev = loc.payment_processor || 'stripe';
                  setLocProcessor(loc.id, processor);            // optimistic
                  try { await callPaymentsAdmin('set_processor', { location_id: loc.id, processor }); }
                  catch (e) { setLocProcessor(loc.id, prev); setError(`Couldn't switch processor: ${e.message}`); }
                }}
                onLink={() => setLinkModalLoc(loc)}
                onUnlink={async () => {
                  if (!confirm(`Unlink Stripe account from ${loc.name}? Future payments will fail until re-linked.`)) return;
                  // Same RLS reason as onSavePricing: a direct client .delete() no-ops
                  // (0 rows, no error), so the account never actually detaches. Route
                  // the delete through the service-role payments-admin edge fn.
                  try { await callPaymentsAdmin('stripe_unlink', { location_id: loc.id }); refresh(); }
                  catch (e) { setError(`Unlink failed: ${e.message}`); }
                }}
                onSavePricing={async ({ cardpresent, online, notes }) => {
                  // merchant_stripe_accounts is RLS select-only for the anon platform
                  // client, so a direct .update() here silently affects 0 rows. Route
                  // the write through the service-role payments-admin edge fn.
                  const patch = {
                    cardpresent_markup_percent: cardpresent === '' ? null : Number(cardpresent),
                    online_markup_percent:      online      === '' ? null : Number(online),
                    pricing_notes: notes || null,
                  };
                  try { await callPaymentsAdmin('stripe_pricing', { location_id: loc.id, cardpresent, online, notes }); }
                  catch (e) { setError(`Save failed: ${e.message}`); return false; }
                  upsertMsaPatch(loc.id, patch);
                  return true;
                }}
              />
            </VenueRow>
          ))}
        </div>
      )}

      {linkModalLoc && (
        <StripeLinkModal
          location={linkModalLoc}
          onClose={() => setLinkModalLoc(null)}
          onLinked={() => { setLinkModalLoc(null); refresh(); }}
        />
      )}
    </div>
  );
}

// ─── Rate card editor rows (shared by defaults + per-venue) ─────────────────
// One row per tier: % + pence inputs and the live effective value with where
// it comes from (override / default / legacy flat). `fallbackFor(tierId,
// field)` returns { value, label } for what applies when the input is blank.
function RateCardRows({ value, onChange, fallbackFor }) {
  const setField = (tierId, field, v) => onChange({ ...value, [tierId]: { ...(value[tierId] ?? { percent: '', fixed_pence: '' }), [field]: v } });
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(190px, 1.4fr) 1fr 1fr minmax(150px, 1.2fr)', gap: 10, alignItems: 'center' }}>
        <span style={{ ...S.label, marginBottom: 0 }}>Payment type</span>
        <span style={{ ...S.label, marginBottom: 0 }}>Rate %</span>
        <span style={{ ...S.label, marginBottom: 0 }}>Per-txn (pence)</span>
        <span style={{ ...S.label, marginBottom: 0 }}>Effective</span>
      </div>
      {TIERS.map(t => {
        const row = value[t.id] ?? { percent: '', fixed_pence: '' };
        const fbPct = fallbackFor(t.id, 'percent');
        const fbFix = fallbackFor(t.id, 'fixed_pence');
        const effPct = row.percent === '' ? fbPct.value : Number(row.percent);
        const effFix = row.fixed_pence === '' ? fbFix.value : Math.round(Number(row.fixed_pence));
        const isOverride = row.percent !== '' || row.fixed_pence !== '';
        const srcLabel = isOverride ? 'set here' : (fbPct.label ?? fbFix.label);
        return (
          <div key={t.id} style={{ display: 'grid', gridTemplateColumns: 'minmax(190px, 1.4fr) 1fr 1fr minmax(150px, 1.2fr)', gap: 10, alignItems: 'center' }}>
            <span style={{ fontSize: 13, color: 'var(--t1)', fontWeight: 600 }}>{t.label}</span>
            <input type="number" step="0.01" min="0" max="100" value={row.percent}
              placeholder={fbPct.value == null ? 'none' : Number(fbPct.value).toFixed(2)}
              onChange={e => setField(t.id, 'percent', e.target.value)}
              style={{ ...S.input, ...S.inputMono }} />
            <input type="number" step="1" min="0" max="10000" value={row.fixed_pence}
              placeholder={fbFix.value == null ? 'none' : String(Math.round(Number(fbFix.value)))}
              onChange={e => setField(t.id, 'fixed_pence', e.target.value)}
              style={{ ...S.input, ...S.inputMono }} />
            <div style={{ fontSize: 12, color: (effPct == null && effFix == null) ? 'var(--t4)' : 'var(--t2)' }}>
              <strong style={{ color: (effPct == null && effFix == null) ? 'var(--t4)' : 'var(--acc)' }}>{fmtRate(effPct, effFix)}</strong>
              {srcLabel && (effPct != null || effFix != null) && <span style={{ color: 'var(--t4)' }}> · {srcLabel}</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Platform-wide defaults panel ─────────────────────────────────────────
// Stripe: markup defaults (unchanged). ServOS Payments (Adyen): the DEFAULT
// TIERED RATE CARD (four payment types, each % + pence) used wherever a
// venue has no override. The old flat default stays on file as the legacy
// card-present fallback until this card is saved.
function PlatformDefaultsPanel({ defaults, onSave, authUserId, onError }) {
  const [editing, setEditing] = useState(false);
  const [cp, setCp] = useState(defaults.default_cardpresent_markup_percent);
  const [on, setOn] = useState(defaults.default_online_markup_percent);
  const [drc, setDrc] = useState(cardToState(defaults.default_adyen_rate_card));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setCp(defaults.default_cardpresent_markup_percent);
    setOn(defaults.default_online_markup_percent);
    setDrc(cardToState(defaults.default_adyen_rate_card));
  }, [defaults]);

  const legacyPct = defaults.default_adyen_markup_percent;
  const legacyFix = defaults.default_adyen_markup_fixed_pence;
  const hasLegacy = legacyPct != null || legacyFix != null;

  // Blank default field → the legacy flat rate, card-present tier only.
  const fallbackFor = (tierId, field) => {
    if (tierId === 'card_present' && hasLegacy) {
      const v = field === 'percent' ? legacyPct : legacyFix;
      return { value: v == null ? null : Number(v), label: 'legacy flat rate' };
    }
    return { value: null, label: null };
  };

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
      // The Adyen rate card goes through the service-role fn: platform_settings
      // is not reliably writable from the anon platform client.
      await callPaymentsAdmin('adyen_pricing', { set: true, rate_card: stateToCard(drc) });
      onSave({ ...defaults, ...patch, default_adyen_rate_card: stateToCard(drc) });
      setEditing(false);
    } catch (e) {
      onError(`Failed to save platform defaults: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  const pct = (v) => `${Number(v ?? 0).toFixed(2)}%`;
  const resolvedDefault = (tierId) => {
    const row = defaults.default_adyen_rate_card?.[tierId];
    if (row && (row.percent != null || row.fixed_pence != null)) return { pct: row.percent, fix: row.fixed_pence, src: null };
    if (tierId === 'card_present' && hasLegacy) return { pct: legacyPct, fix: legacyFix, src: 'legacy flat rate' };
    return { pct: null, fix: null, src: null };
  };

  return (
    <div style={{ ...S.card, borderColor: 'var(--acc-b)', background: 'var(--acc-d)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 260 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--acc)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 4 }}>
            Platform defaults
          </div>
          <div style={{ fontSize: 14, color: 'var(--t1)', marginBottom: 8, lineHeight: 1.4 }}>
            Stripe markup, and the ServOS Payments standard rate card: four payment types, each a percent plus pence per transaction. Venues without their own agreed card pay these.
          </div>
          {!editing && (
            <div style={{ display: 'grid', gap: 10 }}>
              <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
                <Stat label="Stripe in-person markup" value={pct(defaults.default_cardpresent_markup_percent)} />
                <Stat label="Stripe online markup"    value={pct(defaults.default_online_markup_percent)} />
              </div>
              <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', paddingTop: 8, borderTop: '1px solid var(--bdr)' }}>
                {TIERS.map(t => {
                  const r = resolvedDefault(t.id);
                  return <Stat key={t.id} label={t.label} value={fmtRate(r.pct, r.fix)} accent={r.pct != null || r.fix != null} />;
                })}
              </div>
              {hasLegacy && (
                <div style={{ fontSize: 11, color: 'var(--t3)' }}>
                  Legacy flat rate on file: {fmtRate(legacyPct, legacyFix)}. It counts as the card-present default until a rate card value replaces it.
                </div>
              )}
              {defaults.adyen_rate_card_ready === false && (
                <div style={{ fontSize: 11, color: 'var(--orn, #e8a020)' }}>
                  Rate-card storage is not live yet. Hand-apply migration 20260821b_adyen_rate_card.sql, then save the card.
                </div>
              )}
            </div>
          )}
          {editing && (
            <div style={{ display: 'grid', gap: 14, maxWidth: 640 }}>
              <div>
                <div style={{ ...S.label, color: 'var(--t2)' }}>Stripe markup (platform fee)</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  <NumField label="In-person %" value={cp} onChange={setCp} />
                  <NumField label="Online %" value={on} onChange={setOn} />
                </div>
              </div>
              <div>
                <div style={{ ...S.label, color: 'var(--t2)' }}>ServOS Payments standard rate card: what a venue pays per payment type</div>
                <RateCardRows value={drc} onChange={setDrc} fallbackFor={fallbackFor} />
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

// ─── SaaS plans panel (v5.7.4) ─────────────────────────────────────────────
// One row per venue: plan dropdown, additional devices, HubRise add-on, and a
// live monthly total. All pricing comes from the SERVER catalog returned by
// the saas_pricing get action (no client-side pricing constants), so the
// preview here always matches what the edge fn writes to monthly_fee.
// Peter invoices SaaS manually through the CRM; this only records the plan and
// reports the money. Volume bands and device allowances are advisory: the
// server sends a recommended plan and a devices-over flag, shown quietly under
// each row, never enforced.
const gbp = (pounds) => new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(Number(pounds) || 0);

function SaasPlansPanel({ onError }) {
  const [data, setData] = useState(null);   // null = loading, {error} or saas_pricing get payload
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try { setData(await callPaymentsAdmin('saas_pricing', {})); }
    catch (e) { setData({ error: e.message }); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const catalog = data?.catalog;

  return (
    <div style={S.card}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap', marginBottom: 6 }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--acc)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 4 }}>SaaS plans</div>
          <div style={{ fontSize: 13, color: 'var(--t2)', lineHeight: 1.5, maxWidth: 720 }}>
            The monthly software plan each venue is on. Invoiced manually through the CRM, so this only records the plan and feeds the Revenue section.
            {catalog && ` Plans: ${Object.values(catalog.plans).map(p => p.monthly > 0 ? `${p.label} ${p.monthly} GBP with ${p.devices} devices` : `${p.label} with ${p.devices} devices`).join(', ')}. Extra devices ${catalog.extra_device_monthly} GBP each, HubRise ${catalog.hubrise_monthly} GBP per month.`}
          </div>
        </div>
        <button onClick={load} disabled={loading} style={{ ...S.btn, ...S.btnGhost }}>{loading ? 'Loading…' : '↻ Refresh'}</button>
      </div>

      {data == null && <div style={{ fontSize: 12, color: 'var(--t3)', padding: '10px 0' }}>Loading SaaS plans…</div>}
      {data?.error && <div style={{ fontSize: 12, color: 'var(--red)', padding: '10px 0' }}>Could not load SaaS plans: {data.error}</div>}

      {data && !data.error && data.typed === false && (
        <div style={{ padding: 12, borderRadius: 8, background: 'var(--orn-d, rgba(230,160,60,.12))', color: 'var(--orn, #e8a020)', fontSize: 12.5, lineHeight: 1.5, border: '1px solid var(--orn-b, var(--bdr2))', marginTop: 8 }}>
          {data.migration_note || 'The extra devices and HubRise columns are not on the subscriptions table yet. Apply supabase/migrations/20260822_saas_plans.sql on the Ops database, then refresh this panel.'}
        </div>
      )}

      {data && !data.error && data.typed !== false && (data.venues ?? []).map(v => (
        <SaasVenueRow key={v.location_id} venue={v} catalog={catalog} deviceNote={data.device_count_note} onSaved={load} onError={onError} />
      ))}
      {data && !data.error && data.typed !== false && (data.venues ?? []).length === 0 && (
        <div style={{ fontSize: 12, color: 'var(--t3)', padding: '10px 0' }}>No venues found.</div>
      )}
    </div>
  );
}

function SaasVenueRow({ venue, catalog, deviceNote, onSaved, onError }) {
  // A stored plan outside the catalog (legacy or hand-set) is kept as-is, not
  // silently coerced to Free: the row would be born dirty and one Save click
  // would rewrite the venue's fee with no warning. Saving requires picking a
  // real plan; the dropdown shows the stored value until then.
  const planKnown = venue.plan in (catalog?.plans ?? {});
  const [plan, setPlan] = useState(venue.plan);
  const [extra, setExtra] = useState(String(venue.extra_devices ?? 0));
  const [hubrise, setHubrise] = useState(!!venue.hubrise);
  const [state, setState] = useState('idle');   // idle | saving | saved | error
  const [errMsg, setErrMsg] = useState(null);

  // Keep the inputs in step with the server when the panel refreshes.
  // Deriving state from a changed prop DURING render is the React-sanctioned
  // pattern (not an effect). After a save this is a visual no-op because the
  // reloaded values equal what was just typed.
  const [seen, setSeen] = useState({ plan: venue.plan, extra: venue.extra_devices ?? 0, hubrise: !!venue.hubrise });
  if (seen.plan !== venue.plan || seen.extra !== (venue.extra_devices ?? 0) || seen.hubrise !== !!venue.hubrise) {
    setSeen({ plan: venue.plan, extra: venue.extra_devices ?? 0, hubrise: !!venue.hubrise });
    setPlan(venue.plan);
    setExtra(String(venue.extra_devices ?? 0));
    setHubrise(!!venue.hubrise);
  }

  const planDef = catalog?.plans?.[plan];
  const extraNum = extra === '' ? 0 : Math.max(0, Math.round(Number(extra) || 0));
  // Live preview from the SERVER catalog, the same sum the edge fn writes.
  const total = (planDef?.monthly ?? 0) + extraNum * (catalog?.extra_device_monthly ?? 0) + (hubrise ? (catalog?.hubrise_monthly ?? 0) : 0);
  const dirty = plan !== venue.plan || extraNum !== (venue.extra_devices ?? 0) || hubrise !== !!venue.hubrise;
  const planSelectable = plan in (catalog?.plans ?? {});

  const allowance = (planDef?.devices ?? 0) + extraNum;
  const devCount = venue.devices?.count ?? 0;
  const byType = venue.devices?.by_type ?? {};
  const typeSummary = Object.entries(byType).map(([t, n]) => `${n} ${t}`).join(', ');

  const save = async () => {
    setState('saving'); setErrMsg(null);
    try {
      await callPaymentsAdmin('saas_pricing', { set: true, location_id: venue.location_id, plan, extra_devices: extraNum, hubrise });
      setState('saved');
      setTimeout(() => setState(s => (s === 'saved' ? 'idle' : s)), 2500);
      onSaved?.();
    } catch (e) {
      setState('error'); setErrMsg(e.message);
      onError?.(`SaaS plan save failed for ${venue.name}: ${e.message}`);
    }
  };

  return (
    <div style={{ padding: '12px 0', borderTop: '1px solid var(--bdr)', marginTop: 10 }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 160px', minWidth: 160 }}>
          <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--t1)' }}>{venue.name}</div>
          <div style={{ fontSize: 10.5, color: 'var(--t4)', fontFamily: 'var(--font-mono, monospace)' }}>{venue.location_id}</div>
        </div>
        <div>
          <label style={S.label}>Plan</label>
          <select value={plan} onChange={e => setPlan(e.target.value)} style={{ ...S.input, width: 170 }}>
            {!planKnown && <option value={venue.plan}>{venue.plan} (not in catalog)</option>}
            {Object.entries(catalog?.plans ?? {}).map(([key, p]) => (
              <option key={key} value={key}>{p.monthly > 0 ? `${p.label} ${p.monthly} GBP` : p.label}</option>
            ))}
          </select>
          {!planSelectable && (
            <div style={{ fontSize: 10.5, color: 'var(--orn, #e8a020)', marginTop: 3 }}>
              Stored plan is not in the catalog. Pick a plan to update this venue.
            </div>
          )}
        </div>
        <div>
          <label style={S.label}>Additional devices</label>
          <input type="number" step="1" min="0" max="500" value={extra}
            onChange={e => setExtra(e.target.value)} style={{ ...S.input, ...S.inputMono, width: 110 }} />
          <div style={{ fontSize: 10.5, color: 'var(--t4)', marginTop: 3 }}>{catalog?.extra_device_monthly ?? 39} GBP each</div>
        </div>
        <div>
          <label style={S.label}>HubRise add-on</label>
          <label style={{ display: 'flex', gap: 7, alignItems: 'center', fontSize: 13, color: 'var(--t1)', cursor: 'pointer', padding: '8px 0' }}>
            <input type="checkbox" checked={hubrise} onChange={e => setHubrise(e.target.checked)} />
            HubRise
          </label>
          <div style={{ fontSize: 10.5, color: 'var(--t4)' }}>{catalog?.hubrise_monthly ?? 45} GBP per month</div>
        </div>
        <div style={{ minWidth: 110 }}>
          <label style={S.label}>Monthly total</label>
          <div style={{ fontSize: 17, fontWeight: 800, color: 'var(--acc)', padding: '6px 0' }}>{gbp(planSelectable ? total : (venue.monthly_fee ?? 0))}</div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', paddingBottom: 4 }}>
          <button onClick={save} disabled={state === 'saving' || !dirty || !planSelectable} style={{ ...S.btn, ...(dirty && planSelectable ? S.btnPrim : S.btnGhost) }}>
            {state === 'saving' ? 'Saving…' : 'Save'}
          </button>
          {state === 'saved' && <span style={{ fontSize: 12, color: 'var(--grn)', fontWeight: 700 }}>✓ Saved</span>}
          {state === 'error' && <span style={{ fontSize: 12, color: 'var(--red)' }} title={errMsg || undefined}>Save failed</span>}
        </div>
      </div>

      {/* Context: devices, this month's volume, advisories. Quiet, not alarms. */}
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center', marginTop: 7, fontSize: 11.5, color: 'var(--t3)' }}>
        <span title={deviceNote || undefined}>
          {devCount} paired device{devCount === 1 ? '' : 's'}{typeSummary ? ` (${typeSummary})` : ''} · plan covers {allowance}
        </span>
        <span>Card volume this month: {gbp((venue.volume_minor ?? 0) / 100)}</span>
        {venue.recommended_plan && (
          <span style={{ padding: '2px 8px', borderRadius: 99, background: 'var(--orn-d, rgba(230,160,60,.12))', color: 'var(--orn, #e8a020)', border: '1px solid var(--orn-b, var(--bdr2))', fontWeight: 700 }}>
            Volume suggests {catalog?.plans?.[venue.recommended_plan]?.label ?? venue.recommended_plan}
          </span>
        )}
        {venue.devices_over && (
          <span style={{ padding: '2px 8px', borderRadius: 99, background: 'var(--orn-d, rgba(230,160,60,.12))', color: 'var(--orn, #e8a020)', border: '1px solid var(--orn-b, var(--bdr2))', fontWeight: 700 }}>
            {venue.devices_over.count} devices paired, plan covers {venue.devices_over.allowance}
          </span>
        )}
        {venue.hubrise_detected === true && !hubrise && (
          <span title="A live HubRise connection exists for this venue but the add-on is not ticked.">HubRise connection detected</span>
        )}
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


// ─── Compact venue row (OWNER RULE 2) ──────────────────────────────────────
// One line per venue: name and company, the venue code, then the chips. The
// chips are derived from the bulk adyen_accounts row (adyenAdminRows.js), so
// the list makes no Adyen call at all; the detail below loads on expand.
function VenueRow({ location, companyName, venueCode, adyenRow, adyenKnown, msa, expanded, onToggle, children }) {
  const processor = location.payment_processor || 'stripe';
  let chips;
  if (processor === 'adyen') {
    if (adyenKnown) {
      const s = adyenVenueStatus(adyenRow, location);
      const c = s.chips;
      chips = (
        <>
          <Chip tone="muted" title={c.region.title}>{c.region.label}</Chip>
          <Chip tone={c.environment.tone} title={c.environment.title}>{c.environment.label}</Chip>
          <Chip tone={c.linked.tone} title={c.linked.title}>{c.linked.label}</Chip>
          <Chip tone={c.holder.tone} title={c.holder.title}>{c.holder.label}</Chip>
          <Chip tone={c.kyc.tone} title={c.kyc.title}>{c.kyc.label}</Chip>
          <Chip tone={c.payouts.tone} title={c.payouts.title}>{c.payouts.label}</Chip>
        </>
      );
    } else {
      chips = <Chip tone="muted" title="The bulk row read failed; expand the venue for its live detail">Adyen · status unknown</Chip>;
    }
  } else if (processor === 'stripe') {
    const s = stripeVenueStatus(msa);
    chips = (
      <>
        <Chip tone="muted" title="Stripe account country">{msa?.country || (String(location.currency || '').toUpperCase() === 'USD' ? 'US' : 'UK')}</Chip>
        <Chip tone="test" title="This venue takes payments through Stripe">Stripe</Chip>
        <Chip tone={s.status.tone} title={s.status.title}>{s.status.label}</Chip>
      </>
    );
  } else {
    chips = <Chip tone="bad" title="A retired processor: switch the venue to Stripe or Adyen in its detail">Retired: {processor}</Chip>;
  }
  const onKey = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } };
  return (
    <div style={{ borderBottom: '1px solid var(--bdr)' }}>
      <div
        role="button" tabIndex={0} aria-expanded={expanded} onClick={onToggle} onKeyDown={onKey}
        style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '9px 14px', cursor: 'pointer', background: expanded ? 'var(--bg2)' : 'transparent', minHeight: 44, boxSizing: 'border-box' }}>
        <span style={{ width: 12, color: 'var(--t3)', fontSize: 12, flexShrink: 0 }}>{expanded ? '▾' : '▸'}</span>
        <div style={{ flex: '1 1 220px', minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--t1)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{location.name}</div>
          <div style={{ fontSize: 11, color: 'var(--t3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {companyName}{location.online_slug ? ` · ${location.online_slug}` : ''}
          </div>
        </div>
        <code style={{ fontSize: 11.5, color: venueCode ? 'var(--t2)' : 'var(--t4)', fontFamily: 'var(--font-mono, monospace)', letterSpacing: '.04em', flexShrink: 0 }}
          title={venueCode ? 'Venue code, the Adyen store reference' : 'This venue has no code yet'}>
          {venueCode || 'no code'}
        </code>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end', flex: '0 1 auto' }}>{chips}</div>
      </div>
      {expanded && <div style={{ padding: '0 14px 16px' }}>{children}</div>}
    </div>
  );
}

// ─── Expanded venue detail ────────────────────────────────────────────────
function VenueDetail({ location, venueCode, adyenRow, msa, bs, defaults, onError, onAdyenChanged,
  onSetProcessor, onLink, onUnlink, onSavePricing }) {
  const processor = location.payment_processor || 'stripe';
  const currency = (msa?.default_currency || bs?.current_period_currency || location.currency || 'gbp').toUpperCase();

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, margin: '6px 0 12px', flexWrap: 'wrap' }}>
        <div style={{ fontSize: 11, color: 'var(--t4)', fontFamily: 'var(--font-mono, monospace)' }}>{location.id}</div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ ...S.label, marginBottom: 0 }}>Processor</span>
          <div style={S.seg}>
            <button style={S.segBtn(processor === 'stripe')} onClick={() => processor !== 'stripe' && onSetProcessor('stripe')}>Stripe</button>
            <button style={S.segBtn(processor === 'adyen')} onClick={() => processor !== 'adyen' && onSetProcessor('adyen')}>Adyen</button>
          </div>
        </div>
      </div>

      {processor === 'stripe'
        ? <StripeBlock msa={msa} bs={bs} currency={currency} defaults={defaults} onLink={onLink} onUnlink={onUnlink} onSavePricing={onSavePricing} />
        : processor === 'adyen'
        ? <AdyenBlock location={location} venueCode={venueCode} adyenRow={adyenRow} defaults={defaults} onError={onError} onRowChanged={onAdyenChanged} />
        : (
          // A retired processor value (the removed Ryft, for example): say so
          // plainly and let the toggle above move the venue onto a live one.
          <div style={{ padding: '14px 16px', borderRadius: 12, background: 'var(--bg2)', border: '1px solid var(--bdr2)', fontSize: 12.5, color: 'var(--t3)' }}>
            This venue is set to a retired processor ({processor}). Switch it to Stripe or Adyen above.
          </div>
        )}
    </div>
  );
}

// ─── Adyen block: LIVE status, asked of the server, never hardcoded ─────────
const AdyenRow = ({ ok, children }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 }}>
    <span style={{ color: ok ? 'var(--grn, #15C26A)' : 'var(--t4)', fontWeight: 700 }}>{ok ? '✓' : '·'}</span>
    <span style={{ color: ok ? 'var(--t1)' : 'var(--t3)' }}>{children}</span>
  </div>
);

// Order (owner, 8 Sep 2026): Link to Adyen first, then the environment line
// (region, switch, readers), then the connection status, the rate card and
// the payout status with the manual form under Advanced.
function AdyenBlock({ location, venueCode, adyenRow, defaults, onError, onRowChanged }) {
  const [st, setSt] = useState(null);   // null=loading, {error} or status payload
  // envRev: bumped after a link, a flip or a region change, so the
  // connection pill here and the payout panel re-read the venue. linkRev:
  // bumped after a link only, so the environment line re-reads the fn (it
  // reloads itself after its own flips and region changes).
  const [envRev, setEnvRev] = useState(0);
  const [linkRev, setLinkRev] = useState(0);
  const callTerminalAdmin = useMemo(() => terminalAdminFor(location), [location.id, location.ops_location_id]);   // eslint-disable-line react-hooks/exhaustive-deps
  const envChanged = () => { setEnvRev((n) => n + 1); onRowChanged?.(); };
  const linkChanged = () => { setLinkRev((n) => n + 1); envChanged(); };
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const { data: session } = await supabase.auth.getSession();
        // location_id (platform id) makes the fn answer for THIS venue: its
        // environment ('test' | 'live', per venue since 7 Sep 2026), its keys,
        // its store. Without it the fn falls back to the global default.
        const res = await fetch(`${FUNCTIONS_URL}/adyen-checkout`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${session?.session?.access_token || ''}` },
          body: JSON.stringify({ action: 'status', location_id: location.id }),
        });
        const j = await res.json();
        if (live) setSt(j.error ? { error: j.error } : j);
      } catch (e) { if (live) setSt({ error: e.message }); }
    })();
    return () => { live = false; };
  }, [location.id, envRev]);

  // Per-venue TIERED rate card (v5.7.3). merchant_adyen_accounts is
  // service-role-only, so reads AND writes go through payments-admin
  // adyen_pricing. Independent of the checkout-keys probe above: rates are
  // editable even while the probe runs.
  const [acct, setAcct] = useState(null);      // adyen_pricing get result (null = loading)
  const [rc, setRc] = useState(emptyCard());
  const [savedCard, setSavedCard] = useState(emptyCard());
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState(null);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const r = await callPaymentsAdmin('adyen_pricing', { location_id: location.id });
        if (!live) return;
        setAcct(r);
        const st0 = cardToState(r?.account?.rate_card);
        setRc(st0);
        setSavedCard(st0);
      } catch (e) { if (live) { setAcct({ error: e.message }); } }
    })();
    return () => { live = false; };
  }, [location.id]);

  // Blank venue field → the platform default card, then (card-present only)
  // the legacy flat markup: the same chain the server resolves with.
  const fallbackFor = (tierId, field) => {
    const defRow = acct?.defaults?.rate_card?.[tierId] ?? defaults?.default_adyen_rate_card?.[tierId];
    const defVal = defRow?.[field];
    if (defVal != null) return { value: Number(defVal), label: 'platform default' };
    if (tierId === 'card_present') {
      const legacyVenue = field === 'percent' ? acct?.account?.markup_percent : acct?.account?.markup_fixed_pence;
      if (legacyVenue != null) return { value: Number(legacyVenue), label: 'legacy venue flat rate' };
      const legacyDef = field === 'percent'
        ? (acct?.defaults?.default_markup_percent ?? defaults?.default_adyen_markup_percent)
        : (acct?.defaults?.default_markup_fixed_pence ?? defaults?.default_adyen_markup_fixed_pence);
      if (legacyDef != null) return { value: Number(legacyDef), label: 'legacy flat default' };
    }
    return { value: null, label: null };
  };

  const dirty = acct && !acct.error && !cardsEqual(rc, savedCard);
  const legacyVenuePct = acct?.account?.markup_percent;
  const legacyVenueFix = acct?.account?.markup_fixed_pence;
  const hasVenueLegacy = legacyVenuePct != null || legacyVenueFix != null;

  const savePricing = async () => {
    setBusy(true);
    try {
      await callPaymentsAdmin('adyen_pricing', { set: true, location_id: location.id, rate_card: stateToCard(rc) });
      setSavedCard(rc);
      setAcct(prev => ({ ...prev, account: { ...(prev?.account ?? {}), exists: true, rate_card: stateToCard(rc) } }));
      setSavedAt(Date.now()); setTimeout(() => setSavedAt(null), 2500);
    } catch (e) { onError?.(`Save failed: ${e.message}`); }
    finally { setBusy(false); }
  };

  const statusBox = !st
    ? <div style={{ marginTop: 14, padding: '12px 16px', borderRadius: 12, background: 'var(--bg2)', border: '1px solid var(--bdr2)', fontSize: 12.5, color: 'var(--t3)' }}>Checking the Adyen connection…</div>
    : (st.error || !st.configured)
    ? <div style={{ marginTop: 14, padding: '12px 16px', borderRadius: 12, background: 'var(--bg2)', border: '1px solid var(--bdr2)', fontSize: 12.5, color: 'var(--t3)' }}>
        <b style={{ color: 'var(--t1)' }}>Adyen: not reachable.</b><br/>
        {st.error || 'Keys are not configured on this environment.'} Card payments will refuse safely at this venue until it is.
      </div>
    : <div style={{ marginTop: 14, padding: '12px 16px', borderRadius: 12, background: 'var(--bg2)', border: '1px solid var(--bdr2)', display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ fontSize: 13, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <span>Adyen connected <span style={{ fontWeight: 400, color: 'var(--t3)' }}>· {st.merchantAccount}</span></span>
          {/* This VENUE's environment (merchant_adyen_accounts.environment),
              not the global default. Switched in the environment line above
              (ServOS admin only since 8 Sep 2026). */}
          <span
            title={st.environment === 'live' ? 'Live, real money at this venue' : 'Test cards only at this venue'}
            style={{ ...S.pill, ...(st.environment === 'live' ? { background: 'var(--red)', color: '#fff', borderColor: 'var(--red)' } : {}) }}>
            {st.environment === 'live' ? 'LIVE' : 'TEST'}
          </span>
        </div>
        <AdyenRow ok={st.online}>Online payments: this venue&rsquo;s online shop charges through Adyen{st.environment === 'test' ? ' (test cards only)' : ' (real money)'}</AdyenRow>
        <AdyenRow ok={st.inPerson}>In-person on the tills: a card reader is paired and boarded</AdyenRow>
        <AdyenRow ok={!!adyenRow?.store_id}>Linked to Adyen: {adyenRow?.store_id ? `store ${adyenRow.store_id} is mapped on ${adyenRow.environment || st.environment || 'this environment'}` : 'no store is mapped yet. Use Link to Adyen'}</AdyenRow>
        <AdyenRow ok={!!adyenRow?.account_holder_id}>Account holder and payouts: Link to Adyen pulls the venue&rsquo;s balance account and account holder by its reference{adyenRow?.store_id && !adyenRow?.account_holder_id ? ' (this store names no balance account)' : ''}</AdyenRow>
      </div>;

  // This VENUE's Adyen environment for the link panel: the status probe's
  // answer (re-read after every flip and link), else the bulk row's.
  const venueEnvironment = (st && !st.error && st.environment) || adyenRow?.environment || null;

  return (
    <>
      {/* (a) Link to Adyen: pull by reference, never typed (OWNER RULE 1). */}
      <AdyenLinkPanel
        location={location}
        venueCode={venueCode}
        environment={venueEnvironment}
        callAdmin={callTerminalAdmin}
        onChanged={linkChanged}
      />
      {/* (b) Region select and environment switch on one line, with the
          reader count (c). ServOS internal (OWNER RULE). */}
      <AdyenEnvironmentControls
        opsLocationId={location.ops_location_id || null}
        platformLocationId={location.id}
        venueName={location.name}
        callAdmin={callTerminalAdmin}
        onChanged={envChanged}
        refreshKey={linkRev}
      />
      {statusBox}
      {/* Pricing: the venue's tiered rate card. Shown read-only to the venue
          in Back Office → Card payments → Settings; the same resolved card
          drives commission stamping (adyen-webhook) and the split rules.
          Blank = platform default. */}
      <div style={{ marginTop: 14 }}>
        <div style={{ ...S.label, color: 'var(--t2)', marginBottom: 8 }}>Venue rate card: what the venue pays, per payment type (blank = platform default)</div>
        {acct == null && <div style={{ fontSize: 12, color: 'var(--t3)' }}>Loading rates…</div>}
        {acct?.error && <div style={{ fontSize: 12, color: 'var(--red)' }}>Couldn't load the rates: {acct.error}</div>}
        {acct && !acct.error && (
          <>
            <RateCardRows value={rc} onChange={setRc} fallbackFor={fallbackFor} />
            {hasVenueLegacy && (
              <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 8 }}>
                Legacy flat rate on file for this venue: {fmtRate(legacyVenuePct, legacyVenueFix)}. It counts as the card-present tier until a rate card value replaces it.
              </div>
            )}
            {acct.rate_card_ready === false && (
              <div style={{ fontSize: 11, color: 'var(--orn, #e8a020)', marginTop: 8 }}>
                Rate-card storage is not live yet. Hand-apply migration 20260821b_adyen_rate_card.sql, then save.
              </div>
            )}
            <div style={{ fontSize: 11, color: 'var(--t3)', margin: '10px 0 12px', lineHeight: 1.5 }}>
              The venue sees the effective card read-only in Back Office → Card payments → Settings, branded ServOS Payments.
              Commission on each payment is stamped from these rates.
            </div>
            <SaveRow busy={busy} dirty={dirty} savedAt={savedAt}
              onSave={savePricing}
              onReset={() => setRc(savedCard)}
            />
          </>
        )}
      </div>
      <AdyenPayoutPanel key={envRev} location={location} />
    </>
  );
}

// ─── Payout status panel (Phase 4, v5.7.1; trimmed 8 Sep 2026) ─────────────
// Reads the adyen-onboard status: which ids the venue holds, whether the
// balance platform answers for it, its balances and sweeps. Every failure
// arrives pre-classified: awaiting_enablement (amber: the balance platform
// is not switched on yet), missing_prerequisite (neutral: says exactly what
// to do first), error (red).
//
// OWNER RULE 0 (8 Sep 2026): the four payout onboarding buttons (Start
// onboarding, New onboarding link, Configure splits, Set up daily payout)
// are HIDDEN from the admin portal, not collapsed: the owner cannot use
// them here. The adyen-onboard start / refresh_link / configure_splits /
// setup_sweep actions stay on the server; nothing in this portal calls them.
// The manual "Enter Adyen details" form lives under Advanced as a fallback:
// Link to Adyen (above) is the normal route.
const fmtMinor = (m, cur = 'GBP') =>
  new Intl.NumberFormat('en-GB', { style: 'currency', currency: cur }).format((Number(m) || 0) / 100);

function OnbStep({ done, label, detail }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 12.5 }}>
      <span style={{ color: done ? 'var(--grn, #15C26A)' : 'var(--t4)', fontWeight: 700, width: 12 }}>{done ? '✓' : '·'}</span>
      <span style={{ color: done ? 'var(--t1)' : 'var(--t3)' }}>{label}</span>
      {detail && <code style={{ fontSize: 10.5, color: 'var(--t4)', fontFamily: 'var(--font-mono, monospace)' }}>{detail}</code>}
    </div>
  );
}

function AdyenPayoutPanel({ location }) {
  const [st, setSt] = useState(null);        // null = loading, {error} or adyen-onboard status payload
  const [msg, setMsg] = useState(null);      // { kind, text } from the last action
  // Advanced: the manual form, collapsed (OWNER RULE 1: pull by reference is
  // the normal route; typing ids is the fallback).
  const [advanced, setAdvanced] = useState(false);
  // v5.7.93: venues onboarded BY HAND in the Adyen Customer Area can have the
  // ids typed in here. Same columns the API path and adyen_link write, so
  // everything downstream behaves identically.
  const [manual, setManual] = useState(null);   // null = form closed
  const [manualBusy, setManualBusy] = useState(false);
  // The real merchant accounts from Adyen. null = not fetched, [] = could not.
  const [merchants, setMerchants] = useState(null);
  // Stores for the CHOSEN merchant. Refetched when the merchant changes.
  const [stores, setStores] = useState(null);

  const load = useCallback(async () => {
    try {
      const r = await callAdyenOnboard('status', { location_id: location.id });
      setSt(r.ok ? r : { error: r.message || r.error || 'status failed' });
    } catch (e) { setSt({ error: e.message }); }
  }, [location.id]);

  useEffect(() => { setSt(null); load(); }, [load]);

  const box = { marginTop: 14, padding: '12px 16px', borderRadius: 12, background: 'var(--bg2)', border: '1px solid var(--bdr2)' };

  if (st == null) return <div style={box}><div style={{ fontSize: 12, color: 'var(--t3)' }}>Checking payout status…</div></div>;
  if (st.error) {
    return (
      <div style={box}>
        <div style={{ ...S.label, color: 'var(--t2)', marginBottom: 6 }}>Payout status</div>
        <div style={{ fontSize: 12, color: 'var(--red)' }}>Couldn't load the payout status: {st.error}</div>
        <button style={{ ...S.btn, ...S.btnGhost, marginTop: 8 }} onClick={() => { setSt(null); load(); }}>Retry</button>
      </div>
    );
  }

  const ids = st.ids || {};
  const awaiting = st.enablement === 'awaiting_enablement';
  const hasSweep = Array.isArray(st.sweeps) && st.sweeps.length > 0;
  const bal = Array.isArray(st.balances) && st.balances.length ? st.balances[0] : null;
  // This VENUE's Adyen environment (older fn builds send none: treat as test).
  const liveVenue = st.environment === 'live';

  const kindStyle = (kind) => kind === 'ok'
    ? { background: 'var(--grn-d)', color: 'var(--grn)', border: '1px solid var(--grn-b)' }
    : kind === 'awaiting_enablement' || kind === 'warning'
    ? { background: 'var(--orn-d, rgba(230,160,60,.12))', color: 'var(--orn)', border: '1px solid var(--orn-b, var(--bdr2))' }
    : kind === 'missing_prerequisite'
    ? { background: 'var(--bg3)', color: 'var(--t2)', border: '1px solid var(--bdr2)' }
    : { background: 'var(--red-d)', color: 'var(--red)', border: '1px solid var(--red-b)' };

  const openManual = () => {
    if (merchants === null) {
      callAdyenOnboard('list_merchants', { location_id: location.id })
        .then((r) => setMerchants(r?.merchants || []))
        .catch(() => setMerchants([]));
    }
    setMsg(null);
    setManual({
      merchant_account: ids.merchant_account || '', store_id: ids.store_id || '',
      account_holder_id: ids.account_holder_id || '', balance_account_id: ids.balance_account_id || '',
      legal_entity_id: ids.legal_entity_id || '', split_profile_id: ids.split_profile_id || '',
      // a stored legacy 'EU' reads as UK. The region is only SENT when
      // the admin picks one here or the venue has no row yet (8 Sep 2026).
      region: st.region === 'US' ? 'US' : 'UK',
      region_touched: false,
    });
  };

  return (
    <div style={box}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
        <div style={{ ...S.label, color: 'var(--t2)', marginBottom: 0 }}>Payout status</div>
        <span style={S.pill}>{awaiting ? 'Awaiting enablement' : st.enablement === 'enabled' ? 'Balance platform live' : 'Not started'}</span>
        {st.environment && (
          <span title={liveVenue ? 'Live, real money at this venue' : 'Test only at this venue'}
            style={{ ...S.pill, ...(liveVenue ? { background: 'var(--red)', color: '#fff', borderColor: 'var(--red)' } : {}) }}>
            {liveVenue ? 'LIVE money' : 'Test'}
          </span>
        )}
        {st.payouts_ok && <span style={{ ...S.pill, color: 'var(--grn)', borderColor: 'var(--grn-b)' }}>Payouts allowed</span>}
        <button style={{ ...S.btn, ...S.btnGhost, marginLeft: 'auto', padding: '4px 10px', fontSize: 12 }} disabled={manualBusy} onClick={() => { setSt(null); setMsg(null); load(); }}>Refresh</button>
      </div>

      {awaiting && (
        <div style={{ padding: 10, borderRadius: 8, fontSize: 12, lineHeight: 1.5, marginBottom: 10, ...kindStyle('awaiting_enablement') }}>
          <b>The balance platform does not answer for this venue yet.</b> Link to Adyen (above) pulls the
          venue&rsquo;s balance account and account holder once Adyen holds them; nothing needs redeploying when it does.
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 12 }}>
        <OnbStep done={!!ids.legal_entity_id} label="Legal entity" detail={ids.legal_entity_id} />
        <OnbStep done={!!ids.account_holder_id} label="Account holder" detail={ids.account_holder_id} />
        <OnbStep done={!!ids.balance_account_id} label="Balance account (funds land here)" detail={ids.balance_account_id} />
        <OnbStep done={!!ids.transfer_instrument_id} label="Bank account (the venue adds it through Adyen's hosted onboarding)" detail={ids.transfer_instrument_id} />
        <OnbStep done={!!ids.split_profile_id} label="Commission splits on the store" detail={ids.split_profile_id} />
        <OnbStep done={hasSweep} label="Payout sweep (pushes the balance to the venue bank)" detail={hasSweep ? `${st.sweeps[0].schedule || ''} · ${st.sweeps[0].status || ''}` : null} />
      </div>

      {bal && (
        <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap', padding: '10px 12px', background: 'var(--bg1)', borderRadius: 8, marginBottom: 12, border: '1px solid var(--bdr)' }}>
          <Stat label="Total balance" value={fmtMinor(bal.total_minor, bal.currency)} accent />
          <Stat label="Pending" value={fmtMinor(bal.pending_minor, bal.currency)} />
          <Stat label="Available" value={fmtMinor(bal.available_minor, bal.currency)} />
        </div>
      )}

      {msg && (
        <div style={{ padding: 10, borderRadius: 8, fontSize: 12, lineHeight: 1.5, marginBottom: 12, ...kindStyle(msg.kind) }}>{msg.text}</div>
      )}

      {/* OWNER RULE 0: no Start onboarding / New onboarding link / Configure
          splits / Set up daily payout buttons here. Hidden, not collapsed. */}
      <div style={{ borderTop: '1px solid var(--bdr)', paddingTop: 8 }}>
        <button
          style={{ ...S.btn, ...S.btnGhost, padding: '4px 10px', fontSize: 12 }}
          aria-expanded={advanced}
          onClick={() => setAdvanced((v) => !v)}>
          {advanced ? '▾' : '▸'} Advanced
        </button>
        {advanced && (
          <div style={{ marginTop: 10 }}>
            <div style={{ fontSize: 12, color: 'var(--t3)', lineHeight: 1.55, marginBottom: 10 }}>
              Link to Adyen (at the top of this venue) is the normal route: it pulls every id from Adyen by the venue reference.
              Type ids here only when Adyen holds no store with the venue code and the ids must be copied from the Customer Area by hand.
            </div>
            {!manual && (
              <button style={{ ...S.btn, ...S.btnGhost }} disabled={manualBusy} onClick={openManual}>Enter Adyen details</button>
            )}
            {manual && (
              <div style={{ ...box, marginTop: 0, marginBottom: 12 }}>
                <div style={{ ...S.label, color: 'var(--t2)', marginBottom: 4 }}>Enter the Adyen details for this venue</div>
                <div style={{ fontSize: 12, color: 'var(--t3)', lineHeight: 1.55, marginBottom: 12 }}>
                  Onboard the venue in the Adyen Customer Area first, then copy the ids from that screen
                  into here. Leave a box empty to keep what is already saved.
                </div>
                <div style={{ marginBottom: 10 }}>
                  <div style={{ ...S.label, color: 'var(--t3)', marginBottom: 4 }}>Merchant account *</div>
                  {merchants === null ? (
                    <div style={{ fontSize: 12, color: 'var(--t3)' }}>Loading the list from Adyen…</div>
                  ) : merchants.length ? (
                    <>
                      <select style={{ ...S.input, fontSize: 12.5 }} value={manual.merchant_account || ''}
                        onChange={(e) => {
                          const pick = merchants.find((m) => m.id === e.target.value);
                          setManual((m) => ({
                            ...m,
                            merchant_account: e.target.value,
                            store_id: '',
                            // The merchant's own country decides the endpoint, so the
                            // region follows the choice instead of being guessed again.
                            // Region codes are UK and US (8 Sep 2026, EU is gone).
                            region: pick?.country === 'US' ? 'US' : (pick ? 'UK' : m.region),
                            region_touched: !!pick || !!m.region_touched,
                          }));
                          setStores(null);
                          if (e.target.value) {
                            callAdyenOnboard('list_stores', { location_id: location.id, merchant_account: e.target.value })
                              .then((r) => {
                                const list = r?.stores || [];
                                setStores(list);
                                // Pre-pick the store whose Adyen reference matches this
                                // venue's own code, so the common case needs no thought.
                                const hit = list.find((st) => st.suggested);
                                if (hit) setManual((m) => ({ ...m, store_id: hit.id }));
                              })
                              .catch(() => setStores([]));
                          }
                        }}>
                        <option value="">Choose the merchant account…</option>
                        {merchants.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name}{m.country ? ` (${m.country})` : ''}{m.status && m.status !== 'active' ? ` (${m.status})` : ''}
                          </option>
                        ))}
                      </select>
                      <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 5 }}>
                        Straight from Adyen, so it cannot be mistyped. Choosing one sets the region for you.
                      </div>
                    </>
                  ) : (
                    <>
                      <input style={{ ...S.input, ...S.inputMono, fontSize: 12 }} value={manual.merchant_account || ''}
                        placeholder="e.g. Franpos US"
                        onChange={(e) => setManual((m) => ({ ...m, merchant_account: e.target.value }))} />
                      <div style={{ fontSize: 11, color: 'var(--orn, #e8a020)', marginTop: 5 }}>
                        Could not read the list from Adyen, so type it exactly as it appears in the Customer Area.
                      </div>
                    </>
                  )}
                </div>
                <div style={{ marginBottom: 10 }}>
                  <div style={{ ...S.label, color: 'var(--t3)', marginBottom: 4 }}>Store</div>
                  {!manual.merchant_account ? (
                    <div style={{ fontSize: 12, color: 'var(--t3)' }}>Choose a merchant account first.</div>
                  ) : stores === null ? (
                    <div style={{ fontSize: 12, color: 'var(--t3)' }}>Loading this merchant&rsquo;s stores…</div>
                  ) : stores.length ? (
                    <>
                      <select style={{ ...S.input, fontSize: 12.5 }} value={manual.store_id || ''}
                        onChange={(e) => setManual((m) => ({ ...m, store_id: e.target.value }))}>
                        <option value="">Choose the store…</option>
                        {stores.map((st) => (
                          <option key={st.id} value={st.id}>
                            {st.reference || st.id}{st.description ? `: ${st.description}` : ''}
                            {st.suggested ? '   ← matches this venue' : ''}
                            {st.status && st.status !== 'active' ? `  (${st.status})` : ''}
                          </option>
                        ))}
                      </select>
                      <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 5 }}>
                        Shown by the store reference set in Adyen. Put this venue&rsquo;s code
                        (for example SV-1007) in that field when you create the store and it
                        will match itself here every time.
                      </div>
                    </>
                  ) : (
                    <>
                      <input style={{ ...S.input, ...S.inputMono, fontSize: 12 }} value={manual.store_id || ''}
                        placeholder="ST32DG5223..."
                        onChange={(e) => setManual((m) => ({ ...m, store_id: e.target.value }))} />
                      <div style={{ fontSize: 11, color: 'var(--orn, #e8a020)', marginTop: 5 }}>
                        No stores found for this merchant, or the list could not be read. Paste the Store Id from the Customer Area.
                      </div>
                    </>
                  )}
                </div>
                {[
                  ['account_holder_id', 'Account holder Id', 'AH32DB9223...'],
                  ['balance_account_id', 'Balance Account Id', 'BA32DH2223...'],
                  ['legal_entity_id', 'Legal entity Id (optional)', 'LE32...'],
                  ['split_profile_id', 'Split configuration Id (optional)', 'SP...'],
                ].map(([key, label, ph, req]) => (
                  <div key={key} style={{ marginBottom: 10 }}>
                    <div style={{ ...S.label, color: 'var(--t3)', marginBottom: 4 }}>
                      {label}{req ? ' *' : ''}
                    </div>
                    <input
                      style={{ ...S.input, ...S.inputMono, fontSize: 12 }}
                      value={manual[key] || ''}
                      placeholder={ph}
                      onChange={(e) => setManual((m) => ({ ...m, [key]: e.target.value }))}
                    />
                  </div>
                ))}
                <div style={{ marginBottom: 12 }}>
                  <div style={{ ...S.label, color: 'var(--t3)', marginBottom: 4 }}>Region</div>
                  <select style={{ ...S.input, fontSize: 12.5 }} value={manual.region === 'US' ? 'US' : 'UK'}
                    onChange={(e) => setManual((m) => ({ ...m, region: e.target.value, region_touched: true }))}>
                    <option value="UK">United Kingdom (Adyen EU data centre)</option>
                    <option value="US">United States</option>
                  </select>
                  <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 5 }}>
                    The UK and US live accounts are different Adyen accounts: this decides which keys, Checkout host
                    and Terminal API endpoint the venue uses. Getting it wrong stops payments.
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button style={{ ...S.btn, ...S.btnPrim, opacity: manualBusy ? 0.6 : 1 }} disabled={manualBusy}
                    onClick={async () => {
                      setManualBusy(true); setMsg(null);
                      try {
                        const { region_touched, ...fields } = manual;
                        // The region only rides when the admin chose it here, or the
                        // venue has no row yet (8 Sep 2026): sending the prefilled
                        // value on every save meant a UK save was refused until the
                        // region migration runs, even when only the store id changed.
                        if (!region_touched && st.account_row !== false) delete fields.region;
                        const r = await callAdyenOnboard('save_manual', { location_id: location.id, ...fields });
                        if (r.ok) {
                          setManual(null);
                          setMsg(r.warning
                            ? { kind: 'warning', text: `Adyen details saved. ${r.warning}` }
                            : { kind: 'ok', text: 'Adyen details saved for this venue.' });
                          await load();
                        } else setMsg({ kind: r.kind || 'error', text: r.message || r.error || 'Could not save' });
                      } catch (e) { setMsg({ kind: 'error', text: e.message }); }
                      finally { setManualBusy(false); }
                    }}>
                    {manualBusy ? 'Saving…' : 'Save Adyen details'}
                  </button>
                  <button style={{ ...S.btn, ...S.btnGhost }} disabled={manualBusy} onClick={() => setManual(null)}>Cancel</button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
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

  // Keep the inputs in step with the row when the list refreshes. Deriving
  // state from a changed prop DURING render is the React-sanctioned pattern
  // (not an effect), the same as SaasVenueRow.
  const [seen, setSeen] = useState({ cp: msa?.cardpresent_markup_percent ?? '', on: msa?.online_markup_percent ?? '', notes: msa?.pricing_notes ?? '' });
  const nowCp = msa?.cardpresent_markup_percent ?? '';
  const nowOn = msa?.online_markup_percent ?? '';
  const nowNotes = msa?.pricing_notes ?? '';
  if (seen.cp !== nowCp || seen.on !== nowOn || seen.notes !== nowNotes) {
    setSeen({ cp: nowCp, on: nowOn, notes: nowNotes });
    setCp(nowCp);
    setOn(nowOn);
    setNotes(nowNotes);
  }

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
            <span style={S.pill}>{msa.country ?? 'n/a'}</span>
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
              <Stat label="Plan" value={(bs.current_plan ?? 'n/a').toUpperCase()} accent />
              <Stat label="Monthly SaaS fee" value={fmt(bs.current_monthly_fee, currency)} />
              <Stat label="Last month GMV" value={fmt(bs.gmv_last_month, currency)} />
            </div>
          )}
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
