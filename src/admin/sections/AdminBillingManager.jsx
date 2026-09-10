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
// OWNER RULES (8 Sep 2026, reordered 10 Sep 2026: "the admin processing is
// a complete mess"):
//   0. No Start onboarding, New onboarding link, Configure splits or Set up
//      daily payout buttons anywhere here, and no "create store" wording
//      outside the flow. The flow owns every Adyen write, one step at a time.
//   1. Onboarding is seamless: Adyen already holds the venue's store,
//      balance account and account holder under the venue code (SV-1007),
//      so the admin PULLS the ids from Adyen by reference and never types
//      them. That is a GUIDED FLOW of six numbered steps, one open at a
//      time, one primary button each (AdyenGoLiveFlow, driven by the fn's
//      golive_state). The manual link survives under a collapsed Advanced
//      section, reduced to a merchant account select and a store select.
//   2. The Processing list scales to many customers: one compact row per
//      venue (name, venue code, region chip, environment chip, then Linked /
//      Holder / KYC / Payouts chips), a search box (name, code or slug), the
//      detail only on expand. The open row and the search survive a reload
//      through sessionStorage.
//   3. Inside an expanded venue, in this order: (a) the go live flow, (b)
//      Card rates (the venue rate card editor, RateCardRows, the same editor
//      the flow's Edit rates opens), (c) Plan (the SaaS plan), (d) Advanced,
//      collapsed: environment and region, the Adyen connection, the ids
//      Adyen gave us as grey rows with Copy, and the manual link.
//   4. The platform defaults panel is collapsed by default and shows the
//      Adyen balance platform known per environment and region.
//   The per venue Adyen ENVIRONMENT switch and the region are ServOS
//   internal actions too (AdyenEnvironmentControls; the adyen-terminal-admin
//   fn refuses them for anyone but a super_admin). Going LIVE is the flow's
//   fourth step, so the environment line only switches a live venue back to
//   test: one way to do each thing.
//
// Themed with the same CSS variables as the customer back office.

import { useEffect, useState, useCallback, useMemo } from 'react';
import { supabase, platformSupabase } from '../../lib/supabase';
import AdyenEnvironmentControls from '../components/AdyenEnvironmentControls';
import AdyenGoLiveFlow from '../components/AdyenGoLiveFlow';
import RateCardRows from '../components/RateCardRows';
import { adyenVenueStatus, stripeVenueStatus, matchesVenueSearch } from '../../lib/payments/adyenAdminRows';
import { RATE_CARD_TIERS, emptyCard, cardToState, stateToCard, cardsEqual, fmtRate } from '../../lib/payments/rateCard';

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
// / error) and the panel renders each kind differently. Since 10 Sep 2026
// the portal only calls list_merchants, list_stores and save_manual, from
// the manual link under Advanced (OWNER RULE 0: the onboarding actions have
// no buttons here).
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
// .data so AdyenEnvironmentControls and AdyenGoLiveFlow can act on structured
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

// The four pricing tiers and the editor helpers live in
// src/lib/payments/rateCard.js (10 Sep 2026), shared with the go live flow.
const TIERS = RATE_CARD_TIERS;

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
      <div style={S.sub}>Which processor each venue uses, the Adyen link found by venue code, and the card rates each venue pays.</div>

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

// ─── Platform-wide defaults panel ─────────────────────────────────────────
// Stripe: markup defaults (unchanged). ServOS Payments (Adyen): the DEFAULT
// TIERED RATE CARD (four payment types, each % + pence) used wherever a
// venue has no override. The old flat default stays on file as the legacy
// card-present fallback until this card is saved.
function PlatformDefaultsPanel({ defaults, onSave, authUserId, onError }) {
  // Collapsed by default (10 Sep 2026): the venues are the page.
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  // What we know about OUR Adyen accounts: the balance platform id per
  // environment and region (payments-admin platform_settings), read on open.
  const [known, setKnown] = useState(null);   // null = not read, { rows, available, warning } or { error }
  useEffect(() => {
    if (!open || known !== null) return;
    let live = true;
    callPaymentsAdmin('platform_settings', {})
      .then((r) => { if (live) setKnown(r); })
      .catch((e) => { if (live) setKnown({ error: e.message }); });
    return () => { live = false; };
  }, [open, known]);
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
      return { value: v == null ? null : Number(v), label: 'old flat rate' };
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
    if (tierId === 'card_present' && hasLegacy) return { pct: legacyPct, fix: legacyFix, src: 'old flat rate' };
    return { pct: null, fix: null, src: null };
  };

  const bpRows = Array.isArray(known?.rows) ? known.rows : [];
  const bpLine = (r) => `${r.environment === 'live' ? 'Live' : 'Test'} ${r.region}`;

  return (
    <div style={{ ...S.card, borderColor: 'var(--acc-b)', background: 'var(--acc-d)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 260 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--acc)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 4 }}>
            Platform defaults
          </div>
          <div style={{ fontSize: 14, color: 'var(--t1)', marginBottom: 8, lineHeight: 1.4 }}>
            The standard card rates a venue pays when it has no rates of its own, the Stripe markup, and the Adyen accounts we know.
          </div>
          {open && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ ...S.label, color: 'var(--t2)', marginBottom: 4 }}>Adyen balance platform</div>
              {known === null && <div style={{ fontSize: 12.5, color: 'var(--t3)' }}>Reading what is known.</div>}
              {known?.error && <div style={{ fontSize: 12.5, color: 'var(--red)' }}>Could not read it: {known.error}</div>}
              {known && !known.error && known.available === false && <div style={{ fontSize: 12.5, color: 'var(--orn, #e8a020)' }}>One database step is waiting on ServOS, so nothing is known yet.</div>}
              {known && !known.error && known.available !== false && bpRows.length === 0 && <div style={{ fontSize: 12.5, color: 'var(--t3)' }}>No balance platform is known yet. The first venue read on each account teaches it.</div>}
              {bpRows.map((r) => (
                <div key={`${r.environment}-${r.region}`} style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 12.5, margin: '3px 0', flexWrap: 'wrap' }}>
                  <span style={{ color: 'var(--t3)', minWidth: 70 }}>{bpLine(r)}</span>
                  <code style={{ fontFamily: 'var(--font-mono, monospace)', color: r.balance_platform_id ? 'var(--t1)' : 'var(--t4)' }}>{r.balance_platform_id || 'not known'}</code>
                  {r.merchant_accounts > 0 && <span style={{ color: 'var(--t4)' }}>{r.merchant_accounts} merchant account{r.merchant_accounts === 1 ? '' : 's'} seen</span>}
                </div>
              ))}
            </div>
          )}
          {open && !editing && (
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
                <div style={{ fontSize: 12, color: 'var(--t3)' }}>
                  An old flat rate is on file: {fmtRate(legacyPct, legacyFix)}. It counts as the in person default until a value replaces it.
                </div>
              )}
              {defaults.adyen_rate_card_ready === false && (
                <div style={{ fontSize: 12, color: 'var(--orn, #e8a020)' }}>
                  The rate card storage is not there yet. Apply migration 20260821b_adyen_rate_card.sql, then save the card.
                </div>
              )}
            </div>
          )}
          {open && editing && (
            <div style={{ display: 'grid', gap: 14, maxWidth: 640 }}>
              <div>
                <div style={{ ...S.label, color: 'var(--t2)' }}>Stripe markup (platform fee)</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  <NumField label="In-person %" value={cp} onChange={setCp} />
                  <NumField label="Online %" value={on} onChange={setOn} />
                </div>
              </div>
              <div>
                <div style={{ ...S.label, color: 'var(--t2)' }}>Standard card rates: what a venue pays per payment type</div>
                <RateCardRows value={drc} onChange={setDrc} fallbackFor={fallbackFor} />
              </div>
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {!open && <button onClick={() => setOpen(true)} style={{ ...S.btn, ...S.btnGhost }} aria-expanded={false}>Show</button>}
          {open && !editing && <>
            <button onClick={() => setEditing(true)} style={{ ...S.btn, ...S.btnGhost }}>Edit defaults</button>
            <button onClick={() => setOpen(false)} style={{ ...S.btn, ...S.btnGhost }} aria-expanded>Hide</button>
          </>}
          {open && editing && <>
            <button onClick={() => setEditing(false)} disabled={busy} style={{ ...S.btn, ...S.btnGhost }}>Cancel</button>
            <button onClick={save} disabled={busy} style={{ ...S.btn, ...S.btnPrim }}>{busy ? 'Saving' : 'Save defaults'}</button>
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

// SaasPlansPanel (one list of every venue) was replaced on 10 Sep 2026 by
// VenuePlanPanel inside each expanded venue (Plan), below AdyenBlock.

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

// ─── Adyen block (owner, 10 Sep 2026) ──────────────────────────────────────
// Inside an expanded Adyen venue, in this order:
//   (a) the go live flow (AdyenGoLiveFlow, driven by golive_state)
//   (b) Card rates: the venue's rate card editor with Save (RateCardRows,
//       the same editor the flow's Edit rates opens)
//   (c) Plan: the SaaS plan (unchanged, now inside the venue)
//   (d) Advanced, collapsed: the environment and region controls, the Adyen
//       connection, the ids Adyen gave us as grey rows with Copy, and the
//       manual link reduced to a merchant account select and a store select
// Nothing here makes a store, starts onboarding, configures splits or sets up
// a payout: the flow owns all of that, one step at a time.
const BOX = { marginTop: 14, padding: '14px 16px', borderRadius: 12, background: 'var(--bg2)', border: '1px solid var(--bdr2)' };
const PLAIN = { fontSize: 14, color: 'var(--t2)', lineHeight: 1.5 };
const QUIET = { fontSize: 13, color: 'var(--t3)', lineHeight: 1.5 };

// A grey monospace id with a Copy button. Never inside a sentence.
function IdRow({ label, value }) {
  const [copied, setCopied] = useState(false);
  if (!value) return null;
  const copy = async () => {
    try { await navigator.clipboard.writeText(String(value)); setCopied(true); setTimeout(() => setCopied(false), 1400); }
    catch { /* clipboard blocked: the id is on screen to read */ }
  };
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '4px 0', flexWrap: 'wrap' }}>
      <span style={{ fontSize: 12.5, color: 'var(--t3)', minWidth: 170 }}>{label}</span>
      <code style={{ fontSize: 12.5, color: 'var(--t3)', fontFamily: 'var(--font-mono, monospace)', wordBreak: 'break-all' }}>{value}</code>
      <button type="button" onClick={copy} style={{ background: 'transparent', border: '1px solid var(--bdr2)', borderRadius: 6, color: 'var(--t3)', fontSize: 11.5, padding: '2px 8px', cursor: 'pointer', fontFamily: 'inherit' }}>{copied ? 'Copied' : 'Copy'}</button>
    </div>
  );
}

// The ids Adyen gave us, from the bulk adyen_accounts row, in plain words.
const ADYEN_ID_ROWS = [
  ['store_id', 'Payments location'],
  ['merchant_account', 'Adyen account'],
  ['account_holder_id', 'Adyen business account'],
  ['balance_account_id', 'Where the money lands'],
  ['legal_entity_id', 'Registered company'],
  ['split_profile_id', 'Rates on Adyen'],
  ['transfer_instrument_id', 'Bank account'],
  ['business_line_id', 'Business line'],
  ['payout_sweep_id', 'Daily payout'],
];

function AdyenBlock({ location, venueCode, adyenRow, defaults, onError, onRowChanged }) {
  const [st, setSt] = useState(null);   // null=loading, {error} or the adyen-checkout status payload
  // envRev: bumped by ANY change, so the connection line and the rates
  // re-read the venue. linkRev and flowRev point the OTHER way round, so
  // nothing reads itself twice: the flow reloads itself after its own actions
  // and bumps linkRev (the environment line re-reads); the environment line
  // reloads itself after its own flips and bumps flowRev (the flow re-reads).
  const [envRev, setEnvRev] = useState(0);
  const [linkRev, setLinkRev] = useState(0);
  const [flowRev, setFlowRev] = useState(0);
  const callTerminalAdmin = useMemo(() => terminalAdminFor(location), [location.id, location.ops_location_id]);   // eslint-disable-line react-hooks/exhaustive-deps
  const envChanged = () => { setEnvRev((n) => n + 1); setFlowRev((n) => n + 1); onRowChanged?.(); };
  const linkChanged = () => { setEnvRev((n) => n + 1); setLinkRev((n) => n + 1); onRowChanged?.(); };
  const currency = String(location.currency || 'GBP').toUpperCase();
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const { data: session } = await supabase.auth.getSession();
        // location_id (platform id) makes the fn answer for THIS venue: its
        // environment ('test' | 'live', per venue since 7 Sep 2026), its keys,
        // its store. wallets:true asks for one extra /paymentMethods probe, so
        // the go live flow can say whether Adyen OFFERS Apple Pay and Google
        // Pay on this venue. Admin only: the checkout never asks.
        const res = await fetch(`${FUNCTIONS_URL}/adyen-checkout`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${session?.session?.access_token || ''}` },
          body: JSON.stringify({ action: 'status', location_id: location.id, wallets: true }),
        });
        const j = await res.json();
        if (live) setSt(j.error ? { error: j.error } : j);
      } catch (e) { if (live) setSt({ error: e.message }); }
    })();
    return () => { live = false; };
  }, [location.id, envRev]);

  // (b) The venue's rate card. merchant_adyen_accounts is service-role-only,
  // so reads AND writes go through payments-admin adyen_pricing. Re-read
  // after any change (the flow's Edit rates saves through the same action).
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
  }, [location.id, envRev]);

  // Blank venue field: the platform default card, then (in person only) the
  // legacy flat markup, the same chain the server resolves with.
  const fallbackFor = (tierId, field) => {
    const defRow = acct?.defaults?.rate_card?.[tierId] ?? defaults?.default_adyen_rate_card?.[tierId];
    const defVal = defRow?.[field];
    if (defVal != null) return { value: Number(defVal), label: 'platform default' };
    if (tierId === 'card_present') {
      const legacyVenue = field === 'percent' ? acct?.account?.markup_percent : acct?.account?.markup_fixed_pence;
      if (legacyVenue != null) return { value: Number(legacyVenue), label: 'venue flat rate' };
      const legacyDef = field === 'percent'
        ? (acct?.defaults?.default_markup_percent ?? defaults?.default_adyen_markup_percent)
        : (acct?.defaults?.default_markup_fixed_pence ?? defaults?.default_adyen_markup_fixed_pence);
      if (legacyDef != null) return { value: Number(legacyDef), label: 'platform flat rate' };
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
      // The flow's step 5 reads the resolved card, so it reads again.
      setFlowRev((n) => n + 1);
    } catch (e) { onError?.(`The rates could not be saved: ${e.message}`); }
    finally { setBusy(false); }
  };

  return (
    <>
      {/* (a) The guided flow: six steps, one open at a time, one primary
          button each. It owns the pull by reference, the store create, the
          merchant picker, going live, the card rates on Adyen, the payouts
          and the web addresses. */}
      <AdyenGoLiveFlow
        location={location}
        venueCode={venueCode}
        callAdmin={callTerminalAdmin}
        callPayments={callPaymentsAdmin}
        wallets={st && !st.error ? (st.wallets || null) : null}
        onChanged={linkChanged}
        refreshKey={flowRev}
      />

      {/* (b) Card rates: what the venue pays per payment type. Blank means the
          platform default applies. The same resolved card drives what the
          ledger stamps and what the flow applies on Adyen. */}
      <div style={BOX}>
        <div style={{ ...S.label, color: 'var(--t2)', marginBottom: 6 }}>Card rates</div>
        <div style={{ ...PLAIN, marginBottom: 12 }}>What the venue pays per payment type. Blank means the platform default applies.</div>
        {acct == null && <div style={QUIET}>Loading the rates.</div>}
        {acct?.error && <div style={{ fontSize: 13, color: 'var(--red)' }}>The rates could not be read: {acct.error}</div>}
        {acct && !acct.error && (
          <>
            <RateCardRows value={rc} onChange={setRc} fallbackFor={fallbackFor} currency={currency} />
            {hasVenueLegacy && (
              <div style={{ ...QUIET, marginTop: 8 }}>
                An old flat rate is on file for this venue: {fmtRate(legacyVenuePct, legacyVenueFix, currency)}. It counts as the in person rate until a value replaces it.
              </div>
            )}
            {acct.rate_card_ready === false && (
              <div style={{ fontSize: 13, color: 'var(--orn, #e8a020)', marginTop: 8 }}>
                The rate card storage is not there yet. Apply migration 20260821b_adyen_rate_card.sql, then save.
              </div>
            )}
            <div style={{ ...QUIET, margin: '10px 0 12px' }}>
              The venue sees these rates read only in Back Office, under Card payments. Step 5 of the flow applies them on Adyen.
            </div>
            <SaveRow busy={busy} dirty={dirty} savedAt={savedAt}
              onSave={savePricing}
              onReset={() => setRc(savedCard)}
            />
          </>
        )}
      </div>

      {/* (c) Plan: the SaaS plan, unchanged, inside the venue. */}
      <VenuePlanPanel location={location} onError={onError} />

      {/* (d) Advanced, collapsed. */}
      <AdvancedPanel
        location={location}
        adyenRow={adyenRow}
        st={st}
        callTerminalAdmin={callTerminalAdmin}
        onEnvChanged={envChanged}
        linkRev={linkRev}
        onManualSaved={linkChanged}
      />
    </>
  );
}

// ─── Plan (SaaS), one venue (10 Sep 2026) ──────────────────────────────────
// The saas_pricing read answers every venue at once (the catalog, the plan,
// the devices, the volume), so it is read ONCE per page and shared between
// the expanded venues; a save reads it again. subscriptions is an OPS table,
// so the venue is matched on its ops id.
let saasShared = null;
const loadSaas = (force = false) => {
  if (force || !saasShared) {
    saasShared = callPaymentsAdmin('saas_pricing', {}).catch((e) => { saasShared = null; throw e; });
  }
  return saasShared;
};

function VenuePlanPanel({ location, onError }) {
  const [data, setData] = useState(null);   // null = loading, {error} or the saas_pricing get payload
  // rev: bumped after a save so the shared read runs again.
  const [rev, setRev] = useState(0);
  useEffect(() => {
    let live = true;
    (async () => {
      let next;
      try { next = await loadSaas(rev > 0); }
      catch (e) { next = { error: e.message }; }
      if (live) setData(next);
    })();
    return () => { live = false; };
  }, [rev]);
  const opsId = location.ops_location_id || location.id;
  const venue = (data?.venues ?? []).find((v) => v.location_id === opsId || v.location_id === location.id) || null;
  return (
    <div style={BOX}>
      <div style={{ ...S.label, color: 'var(--t2)', marginBottom: 6 }}>Plan</div>
      {data == null && <div style={QUIET}>Loading the plan.</div>}
      {data?.error && <div style={{ fontSize: 13, color: 'var(--red)' }}>The plan could not be read: {data.error}</div>}
      {data && !data.error && data.typed === false && (
        <div style={{ ...QUIET, padding: 10, borderRadius: 8, background: 'var(--orn-d, rgba(230,160,60,.12))', color: 'var(--orn, #e8a020)', border: '1px solid var(--orn-b, var(--bdr2))' }}>
          {data.migration_note || 'The extra devices and HubRise columns are not on the subscriptions table yet. Apply supabase/migrations/20260822_saas_plans.sql on the Ops database.'}
        </div>
      )}
      {data && !data.error && data.typed !== false && !venue && <div style={QUIET}>This venue has no plan row yet.</div>}
      {data && !data.error && data.typed !== false && venue && (
        <SaasVenueRow venue={venue} catalog={data.catalog} deviceNote={data.device_count_note} onSaved={() => setRev((n) => n + 1)} onError={onError} />
      )}
    </div>
  );
}

// ─── Advanced (10 Sep 2026), collapsed ─────────────────────────────────────
function AdvancedPanel({ location, adyenRow, st, callTerminalAdmin, onEnvChanged, linkRev, onManualSaved }) {
  const [open, setOpen] = useState(false);
  const row = adyenRow || {};
  const idRows = ADYEN_ID_ROWS.filter(([key]) => !!row[key]);
  const liveVenue = st && !st.error ? st.environment === 'live' : String(row.environment || '') === 'live';
  return (
    <div style={BOX}>
      <button
        type="button"
        style={{ ...S.btn, ...S.btnGhost, padding: '4px 10px', fontSize: 13 }}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}>
        {open ? '▾' : '▸'} Advanced
      </button>
      {open && (
        <div style={{ marginTop: 12 }}>
          <div style={{ ...QUIET, marginBottom: 4 }}>The environment and region, the Adyen connection, the ids Adyen gave us, and a manual link.</div>

          {/* The region select and the environment switch. ServOS internal:
              going live is the flow's fourth step, so this only brings a
              live venue back to test. */}
          <AdyenEnvironmentControls
            opsLocationId={location.ops_location_id || null}
            platformLocationId={location.id}
            venueName={location.name}
            callAdmin={callTerminalAdmin}
            onChanged={onEnvChanged}
            refreshKey={linkRev}
          />

          {/* The Adyen connection, as adyen-checkout status answers it. */}
          <div style={{ ...BOX, background: 'var(--bg1)' }}>
            <div style={{ ...S.label, color: 'var(--t2)', marginBottom: 6 }}>Adyen connection</div>
            {!st && <div style={QUIET}>Checking the Adyen connection.</div>}
            {st && (st.error || !st.configured) && (
              <>
                <div style={PLAIN}>Adyen is not reachable on this environment, so card payments refuse safely here.</div>
                {st.error && <div style={{ ...QUIET, marginTop: 4 }}>{st.error}</div>}
              </>
            )}
            {st && !st.error && st.configured && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ ...PLAIN, color: 'var(--t1)', fontWeight: 700 }}>Adyen is connected.</span>
                  <span
                    title={liveVenue ? 'Live, real money at this venue' : 'Test cards only at this venue'}
                    style={{ ...S.pill, ...(liveVenue ? { background: 'var(--red)', color: '#fff', borderColor: 'var(--red)' } : {}) }}>
                    {liveVenue ? 'LIVE' : 'TEST'}
                  </span>
                </div>
                <AdyenRow ok={st.online}>{st.online ? 'Online shop payments go through Adyen.' : 'Online shop payments are not set up yet.'}</AdyenRow>
                <AdyenRow ok={st.inPerson}>{st.inPerson ? 'A card reader is paired for the tills.' : 'No card reader is paired for the tills yet.'}</AdyenRow>
                <IdRow label="Adyen account" value={st.merchantAccount} />
              </div>
            )}
          </div>

          {/* The ids Adyen gave us, grey and monospace, with Copy. */}
          <div style={{ ...BOX, background: 'var(--bg1)' }}>
            <div style={{ ...S.label, color: 'var(--t2)', marginBottom: 6 }}>The ids Adyen gave us</div>
            {idRows.length === 0 && <div style={QUIET}>Adyen has given us no ids for this venue yet. The flow above finds them.</div>}
            {idRows.map(([key, label]) => <IdRow key={key} label={label} value={row[key]} />)}
          </div>

          <ManualLink location={location} adyenRow={adyenRow} onSaved={onManualSaved} />
        </div>
      )}
    </div>
  );
}

// ─── The manual link (10 Sep 2026): a merchant account and a store, picked ──
// from Adyen's own lists, for a venue the flow cannot find by its code. No
// typed ids: the business account, where the money lands, the registered
// company and the rates on Adyen are pulled by the flow, never pasted.
function ManualLink({ location, adyenRow, onSaved }) {
  const [form, setForm] = useState(null);       // null = closed
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);         // { kind, text }
  const [merchants, setMerchants] = useState(null);   // null = not read, [] = could not
  const [stores, setStores] = useState(null);         // stores of the chosen merchant
  const openForm = () => {
    if (merchants === null) {
      callAdyenOnboard('list_merchants', { location_id: location.id })
        .then((r) => setMerchants(r?.merchants || []))
        .catch(() => setMerchants([]));
    }
    setMsg(null);
    setForm({ merchant_account: adyenRow?.merchant_account || '', store_id: adyenRow?.store_id || '', region: null });
  };
  const kindStyle = (kind) => kind === 'ok'
    ? { background: 'var(--grn-d)', color: 'var(--grn)', border: '1px solid var(--grn-b)' }
    : kind === 'warning'
    ? { background: 'var(--orn-d, rgba(230,160,60,.12))', color: 'var(--orn)', border: '1px solid var(--orn-b, var(--bdr2))' }
    : { background: 'var(--red-d)', color: 'var(--red)', border: '1px solid var(--red-b)' };
  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      const fields = { merchant_account: form.merchant_account, store_id: form.store_id };
      // The region rides only when the merchant pick decided it, or the venue
      // has no row yet: sending it on every save was refused until the region
      // migration ran, even when only the store changed (8 Sep 2026).
      if (form.region && (!adyenRow || form.region !== adyenRow.region)) fields.region = form.region;
      const r = await callAdyenOnboard('save_manual', { location_id: location.id, ...fields });
      if (r.ok) {
        setForm(null);
        setMsg(r.warning ? { kind: 'warning', text: `The Adyen details are saved. ${r.warning}` } : { kind: 'ok', text: 'The Adyen details are saved for this venue.' });
        onSaved?.();
      } else setMsg({ kind: r.kind === 'warning' ? 'warning' : 'error', text: r.message || r.error || 'The details could not be saved.' });
    } catch (e) { setMsg({ kind: 'error', text: e.message }); }
    finally { setBusy(false); }
  };
  return (
    <div style={{ ...BOX, background: 'var(--bg1)' }}>
      <div style={{ ...S.label, color: 'var(--t2)', marginBottom: 6 }}>Manual link</div>
      <div style={{ ...QUIET, marginBottom: 10 }}>The flow finds the venue by its code. Use this only when Adyen holds it under another store.</div>
      {msg && <div style={{ padding: 10, borderRadius: 8, fontSize: 13, lineHeight: 1.5, marginBottom: 10, ...kindStyle(msg.kind) }}>{msg.text}</div>}
      {!form && <button style={{ ...S.btn, ...S.btnGhost }} disabled={busy} onClick={openForm}>Pick the merchant account and store</button>}
      {form && (
        <div>
          <div style={{ marginBottom: 10 }}>
            <div style={{ ...S.label, color: 'var(--t3)', marginBottom: 4 }}>Merchant account</div>
            {merchants === null ? (
              <div style={QUIET}>Reading the list from Adyen.</div>
            ) : merchants.length ? (
              <select style={{ ...S.input, fontSize: 13 }} value={form.merchant_account || ''}
                onChange={(e) => {
                  const pick = merchants.find((m) => m.id === e.target.value);
                  // The merchant's own country decides the endpoint, so the
                  // region follows the choice instead of being guessed again.
                  setForm((f) => ({ ...f, merchant_account: e.target.value, store_id: '', region: pick ? (pick.country === 'US' ? 'US' : 'UK') : null }));
                  setStores(null);
                  if (e.target.value) {
                    callAdyenOnboard('list_stores', { location_id: location.id, merchant_account: e.target.value })
                      .then((r) => {
                        const list = r?.stores || [];
                        setStores(list);
                        // The store whose reference is this venue's code is picked for you.
                        const hit = list.find((st) => st.suggested);
                        if (hit) setForm((f) => ({ ...f, store_id: hit.id }));
                      })
                      .catch(() => setStores([]));
                  }
                }}>
                <option value="">Pick one</option>
                {merchants.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}{m.country ? ` (${m.country})` : ''}{m.status && m.status !== 'active' ? ` (${m.status})` : ''}
                  </option>
                ))}
              </select>
            ) : (
              <div style={{ fontSize: 13, color: 'var(--orn, #e8a020)' }}>The merchant accounts could not be read from Adyen.</div>
            )}
          </div>
          <div style={{ marginBottom: 12 }}>
            <div style={{ ...S.label, color: 'var(--t3)', marginBottom: 4 }}>Store</div>
            {!form.merchant_account ? (
              <div style={QUIET}>Pick a merchant account first.</div>
            ) : stores === null ? (
              <div style={QUIET}>Reading the stores on that account.</div>
            ) : stores.length ? (
              <select style={{ ...S.input, fontSize: 13 }} value={form.store_id || ''}
                onChange={(e) => setForm((f) => ({ ...f, store_id: e.target.value }))}>
                <option value="">Pick one</option>
                {stores.map((st) => (
                  <option key={st.id} value={st.id}>
                    {st.reference || st.id}{st.description ? `: ${st.description}` : ''}
                    {st.suggested ? '   (matches this venue)' : ''}
                    {st.status && st.status !== 'active' ? `  (${st.status})` : ''}
                  </option>
                ))}
              </select>
            ) : (
              <div style={{ fontSize: 13, color: 'var(--orn, #e8a020)' }}>No stores were found on that account.</div>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button style={{ ...S.btn, ...S.btnPrim, opacity: busy ? 0.6 : 1 }} disabled={busy || !form.merchant_account} onClick={save}>
              {busy ? 'Saving' : 'Save the Adyen details'}
            </button>
            <button style={{ ...S.btn, ...S.btnGhost }} disabled={busy} onClick={() => setForm(null)}>Cancel</button>
          </div>
        </div>
      )}
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
