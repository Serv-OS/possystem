import { useState, useEffect } from 'react';
import { platformSupabase, supabase, getLocationId } from '../../lib/supabase';
import { clearLocationConfigCache } from '../../lib/locationTime';
import { defaultOpeningHours, emptyOpeningHours, isOpenNow, formatHoursPreview } from '../../lib/openingHours';
import { isValidSlug, suggestSlug } from '../../lib/customerUrl';
import { CUSTOMER_ROOT } from '../../lib/env';
import { CURRENCIES, money, setActiveCurrency } from '../../lib/currency';

const TIMEZONES = [
  { value:'Europe/London',      label:'Europe/London (UK)' },
  { value:'Europe/Paris',       label:'Europe/Paris (CET)' },
  { value:'Europe/Berlin',      label:'Europe/Berlin (CET)' },
  { value:'Europe/Amsterdam',   label:'Europe/Amsterdam (CET)' },
  { value:'Europe/Dublin',      label:'Europe/Dublin' },
  { value:'America/New_York',   label:'America/New York (ET)' },
  { value:'America/Chicago',    label:'America/Chicago (CT)' },
  { value:'America/Denver',     label:'America/Denver (MT)' },
  { value:'America/Los_Angeles',label:'America/Los Angeles (PT)' },
  { value:'America/Toronto',    label:'America/Toronto (ET)' },
  { value:'Australia/Sydney',   label:'Australia/Sydney (AEDT)' },
  { value:'Australia/Melbourne',label:'Australia/Melbourne (AEDT)' },
  { value:'Asia/Dubai',         label:'Asia/Dubai (GST)' },
  { value:'Asia/Singapore',     label:'Asia/Singapore (SGT)' },
  { value:'Asia/Tokyo',         label:'Asia/Tokyo (JST)' },
];

const HOURS = Array.from({ length: 48 }, (_, i) => {
  const h = Math.floor(i / 2);
  const m = (i % 2) * 30;
  const s = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
  return { value: s, label: s };
});

// Strip junk and coerce types so the JSONB column gets clean data and the
// migration can rely on shape. Days that aren't a valid weekday key are
// dropped; windows missing an open or close are dropped.
const _DAYS = ['mon','tue','wed','thu','fri','sat','sun'];
function sanitiseOpeningHours(oh) {
  const weekly = {};
  for (const d of _DAYS) {
    const arr = Array.isArray(oh?.weekly?.[d]) ? oh.weekly[d] : [];
    weekly[d] = arr
      .filter(w => w && typeof w.open === 'string' && typeof w.close === 'string')
      .map(w => ({
        open:  String(w.open).slice(0, 5),
        close: String(w.close).slice(0, 5),
      }));
  }
  const closedDates = Array.isArray(oh?.closedDates)
    ? oh.closedDates
        .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(String(d)))
        .slice(0, 200)
    : [];
  return { weekly, closedDates };
}

// v4.6.25: Duration in minutes between a start and end HH:MM. Handles
// overnight wrap where end <= start (e.g. late bar 22:00 -> 02:00).
function shiftDurationMinutes(start, end) {
  if (!start || !end) return 0;
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  const startMin = sh * 60 + sm;
  const endMin   = eh * 60 + em;
  return endMin > startMin ? endMin - startMin : (24 * 60) - startMin + endMin;
}

const S = {
  page: { padding:'32px 40px', maxWidth:760, overflowY:'auto' },
  h1:   { fontSize:22, fontWeight:800, marginBottom:4, color:'var(--t1)' },
  sub:  { fontSize:13, color:'var(--t3)', marginBottom:32 },
  card: { background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:14, padding:24, marginBottom:20 },
  h2:   { fontSize:14, fontWeight:700, color:'var(--t1)', marginBottom:4 },
  desc: { fontSize:12, color:'var(--t4)', marginBottom:16, lineHeight:1.6 },
  label:{ fontSize:12, fontWeight:600, color:'var(--t3)', marginBottom:5, display:'block', textTransform:'uppercase', letterSpacing:'.04em' },
  select:{ width:'100%', padding:'9px 12px', borderRadius:8, border:'1px solid var(--bdr)', background:'var(--bg)', color:'var(--t1)', fontSize:13, fontFamily:'inherit', outline:'none' },
  input: { padding:'9px 12px', borderRadius:8, border:'1px solid var(--bdr)', background:'var(--bg)', color:'var(--t1)', fontSize:13, fontFamily:'inherit', outline:'none' },
  row:  { display:'grid', gridTemplateColumns:'1fr 1fr 1fr auto', gap:8, alignItems:'end', marginBottom:8 },
  btn:  { padding:'9px 18px', borderRadius:8, border:'none', cursor:'pointer', fontSize:13, fontWeight:700, fontFamily:'inherit' },
};

export default function LocationSettings() {
  const [location, setLocation] = useState(null);
  const [loading, setLoading]   = useState(true);
  const [saving, setSaving]     = useState(false);
  const [saved, setSaved]       = useState(false);
  const [error, setError]       = useState('');

  const [timezone, setTimezone]     = useState('Europe/London');
  const [currency, setCurrency]     = useState('GBP');   // v5.5.326: per-location currency
  const [bizDayStart, setBizDayStart] = useState('06:00');
  const [collectionLeadMin, setCollectionLeadMin] = useState(30);
  const [shifts, setShifts]         = useState([]);
  const [showItemImages, setShowItemImages] = useState(false);
  const [loadingImageSetting, setLoadingImageSetting] = useState(true);
  // Opening hours — Phase 1 of online ordering. Stored on locations.opening_hours
  // (jsonb). Both kiosk and online surfaces gate ordering on this.
  const [openingHours, setOpeningHours] = useState(emptyOpeningHours());
  const [closedDateInput, setClosedDateInput] = useState('');
  // Phase 2 — online ordering URL + enabled toggles
  const [onlineSlug,  setOnlineSlug]  = useState('');
  const [onlineEnabled, setOnlineEnabled] = useState(false);
  const [qrEnabled,     setQrEnabled]     = useState(false);
  const [slugError,   setSlugError]   = useState('');
  // Card processing rates (read-only here — set by us in the admin portal).
  const [payInfo, setPayInfo] = useState(null);   // { processor, std, ovr }
  const [onbBusy, setOnbBusy] = useState(false);
  const [onbErr, setOnbErr]   = useState('');
  const [onbLink, setOnbLink] = useState(null);

  // Self-serve Ryft onboarding: ensure a sub-account + mint a hosted link.
  const startRyftOnboarding = async () => {
    setOnbBusy(true); setOnbErr(''); setOnbLink(null);
    try {
      const locId = await getLocationId().catch(() => null);
      if (!locId) throw new Error('No location id.');
      const { data: session } = await supabase.auth.getSession();
      const token = session?.session?.access_token;
      if (!token) throw new Error('Please sign in again.');
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/payments-onboard`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: 'ryft_start', ops_location_id: locId, redirect_url: window.location.origin + '/?ryft_onboarded=1' }),
      });
      const j = await res.json();
      if (!res.ok || j.error) throw new Error(j.error || `HTTP ${res.status}`);
      setOnbLink(j.onboarding_url || null);
      if (j.onboarding_url) window.open(j.onboarding_url, '_blank', 'noopener');
    } catch (e) {
      setOnbErr(e.message || 'Could not start onboarding');
    } finally {
      setOnbBusy(false);
    }
  };

  useEffect(() => {
    if (!platformSupabase) { setLoading(false); return; }
    // CROSS-DB JOIN — platform.locations.id ≠ ops.locations.id in general.
    // We resolve the ops location id (what BO is logged into) and look it
    // up via platform.locations.ops_location_id. The previous .limit(1)
    // fallback was a wrong-row-targeting bug: when ops.id had no matching
    // platform.id, it returned the FIRST platform row (e.g. Huddersfield)
    // and the user unwittingly edited a different tenant's location. No
    // org-level data leaked (RLS held), but writes hit the wrong row.
    (async () => {
      try {
        const locId = await getLocationId().catch(() => null);
        const select = 'id, name, timezone, currency, business_day_start, shifts, collection_lead_minutes, opening_hours, online_slug, online_enabled, qr_enabled, ops_location_id, payment_processor';
        let row = null;
        let lastErr = null;
        if (locId) {
          // First: ops_location_id mapping (the right join key).
          const r1 = await platformSupabase.from('locations').select(select).eq('ops_location_id', locId).maybeSingle();
          row = r1.data;
          lastErr = r1.error;
          if (!row) {
            // Legacy data: some platform rows have id == ops_location_id (set
            // up before the join column existed). Try matching on id too —
            // safe because we still scope to one specific value, never .limit(1).
            const r2 = await platformSupabase.from('locations').select(select).eq('id', locId).maybeSingle();
            row = r2.data;
            lastErr = r2.error || lastErr;
          }
          if (lastErr) console.warn('[LocationSettings] load failed:', lastErr);
        }
        if (row) {
          setLocation(row);
          setTimezone(row.timezone || 'Europe/London');
          setCurrency(row.currency || 'GBP');
          setBizDayStart(row.business_day_start || '06:00');
          setShifts(Array.isArray(row.shifts) ? row.shifts : []);
          setCollectionLeadMin(typeof row.collection_lead_minutes === 'number' ? row.collection_lead_minutes : 30);
          // Defensive: opening_hours may not exist on the row yet if the SQL
          // migration hasn't been run. Fall back to empty schedule so the
          // editor renders cleanly and surfaces a "set me up" CTA.
          setOpeningHours(
            row.opening_hours && row.opening_hours.weekly
              ? row.opening_hours
              : emptyOpeningHours()
          );
          setOnlineSlug(row.online_slug || '');
          setOnlineEnabled(!!row.online_enabled);
          setQrEnabled(!!row.qr_enabled);
          // Card processing rates for display (the standard Ryft rate card +
          // this location's negotiated override, if any). Non-fatal on error.
          try {
            const [{ data: ps }, { data: mra }] = await Promise.all([
              platformSupabase.from('platform_settings').select('ryft_cost_percent, ryft_cost_fixed_pence, default_ryft_markup_percent, default_ryft_markup_fixed_pence').eq('id', true).maybeSingle(),
              platformSupabase.from('merchant_ryft_accounts').select('charges_enabled, ryft_account_id, markup_percent, markup_fixed_pence').eq('location_id', row.id).maybeSingle(),
            ]);
            setPayInfo({ processor: row.payment_processor || 'stripe', std: ps || null, ovr: mra || null });
          } catch { /* rates display is best-effort */ }
        } else {
          setError('Could not load any location row from the platform DB. Check VITE_PLATFORM_SUPABASE_URL/KEY and the locations table SELECT policy.');
        }
      } catch (e) {
        console.error('[LocationSettings] load threw:', e);
        setError(`Load failed: ${e.message}`);
      } finally {
        setLoading(false);
      }
    })();

    // Load show_item_images from ops DB
    (async () => {
      const locId = await getLocationId().catch(() => null);
      if (!locId || !supabase) { setLoadingImageSetting(false); return; }
      const { data } = await supabase.from('locations').select('show_item_images').eq('id', locId).single();
      if (data) setShowItemImages(data.show_item_images ?? false);
      setLoadingImageSetting(false);
    })();
  }, []);

  const addShift = () => {
    setShifts(s => [...s, { id:`shift-${Date.now()}`, name:'New shift', start:'09:00', end:'17:00' }]);
  };
  const updateShift = (id, key, val) => {
    setShifts(s => s.map(sh => sh.id === id ? { ...sh, [key]: val } : sh));
  };
  const removeShift = (id) => setShifts(s => s.filter(sh => sh.id !== id));

  const save = async () => {
    if (!platformSupabase) {
      setError('Platform DB not configured. Set VITE_PLATFORM_SUPABASE_URL/KEY.');
      return;
    }
    if (!location) {
      setError('No location loaded — nothing to save against. Check the platform DB locations table or run the load again.');
      return;
    }
    // Slug validation up-front so the user gets a clear message instead of
    // a Postgres unique-violation in the toast.
    if (onlineSlug && !isValidSlug(onlineSlug)) {
      setSlugError('Slug must be 3-40 chars, lowercase letters / digits / hyphens, no leading or trailing hyphen.');
      return;
    }
    setSlugError('');
    setSaving(true); setError(''); setSaved(false);

    // Sanitise shifts payload — strip any fields the JSONB column doesn't
    // expect, coerce times to HH:MM strings. The Service Periods bug was
    // caused by the update silently no-op'ing: .update().eq() returns success
    // (no error) even when RLS denies the write OR when the row id mismatches.
    // Adding .select().single() forces a round-trip on the actual mutated
    // row, so we can confirm shifts came back persisted.
    const cleanShifts = (shifts || []).map(sh => ({
      id:    sh.id || `shift-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name:  String(sh.name || 'Shift').slice(0, 60),
      start: String(sh.start || '00:00').slice(0, 5),
      end:   String(sh.end   || '00:00').slice(0, 5),
    }));

    const { data, error: err } = await platformSupabase
      .from('locations')
      .update({
        timezone,
        currency,
        business_day_start:      bizDayStart,
        shifts:                  cleanShifts,
        collection_lead_minutes: collectionLeadMin,
        opening_hours:           sanitiseOpeningHours(openingHours),
        online_slug:             onlineSlug ? onlineSlug.toLowerCase() : null,
        online_enabled:          !!onlineEnabled,
        qr_enabled:              !!qrEnabled,
      })
      .eq('id', location.id)
      .select('id, shifts, timezone, business_day_start, collection_lead_minutes, opening_hours, online_slug, online_enabled, qr_enabled')
      // maybeSingle so a 0-row return doesn't throw "Cannot coerce" — it
      // resolves to data:null which we then handle with a specific error
      // pointing at the RLS UPDATE policy (the most common cause).
      .maybeSingle();

    // Save show_item_images to ops DB (separate concern)
    const locId = await getLocationId().catch(() => null);
    if (locId && supabase) {
      try { await supabase.from('locations').update({ show_item_images: showItemImages }).eq('id', locId); } catch {}
    }
    setSaving(false);

    if (err) {
      console.warn('[LocationSettings] save failed:', err);
      setError(err.message || 'Save failed (check console)');
      return;
    }
    if (!data) {
      // Update affected 0 rows even though SELECT found the location — almost
      // always RLS denying UPDATE for the (anon) platformSupabase session.
      // Surface a copy-pasteable SQL fix the user can run in Supabase SQL editor.
      setError(
        'Save reached the DB but updated 0 rows. This is an RLS policy on the platform DB locations table — UPDATE is blocked. Open Supabase → SQL editor and run: ' +
        `CREATE POLICY locations_anon_update ON public.locations FOR UPDATE USING (true) WITH CHECK (true); ` +
        '(Tighten the predicate later — this unblocks Save right now.)'
      );
      return;
    }
    // Verify shifts round-tripped — surfaces the bug instead of hiding it
    const persistedShifts = Array.isArray(data.shifts) ? data.shifts : [];
    if (cleanShifts.length !== persistedShifts.length) {
      setError(`Save reported success but shifts didn't persist: sent ${cleanShifts.length}, got ${persistedShifts.length} back. Check the locations.shifts column type (must be jsonb) and RLS UPDATE policy.`);
      return;
    }
    // Keep local state in sync with what's actually persisted
    setShifts(persistedShifts);
    if (data.opening_hours && data.opening_hours.weekly) setOpeningHours(data.opening_hours);
    setOnlineSlug(data.online_slug || '');
    setOnlineEnabled(!!data.online_enabled);
    setQrEnabled(!!data.qr_enabled);
    clearLocationConfigCache(); // force refresh on next read
    setActiveCurrency(currency); // v5.5.326: reflect the new currency immediately in this session
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  };

  if (loading) return <div style={{ padding:40, color:'var(--t4)', fontSize:13 }}>Loading…</div>;
  if (!platformSupabase) return (
    <div style={S.page}>
      <div style={S.h1}>Location Settings</div>
      <div style={{ padding:'20px 0', color:'var(--red)', fontSize:13 }}>
        Platform DB not configured. Add <code>VITE_PLATFORM_SUPABASE_URL</code> and <code>VITE_PLATFORM_SUPABASE_ANON_KEY</code> to Vercel environment variables.
      </div>
    </div>
  );

  return (
    <div style={S.page}>
      <div style={S.h1}>Location Settings</div>
      <div style={S.sub}>Configure timezone and service periods for {location?.name || 'your location'}</div>

      {/* Card processing rates (Ryft venues) — read-only; rates set by us in admin */}
      {payInfo?.processor === 'ryft' && payInfo.std && (() => {
        const std = payInfo.std, ovr = payInfo.ovr || {};
        const eff = (o, s) => (o != null ? Number(o) : Number(s ?? 0));
        const mkPct = eff(ovr.markup_percent, std.default_ryft_markup_percent);
        const mkFix = eff(ovr.markup_fixed_pence, std.default_ryft_markup_fixed_pence);
        const costPct = Number(std.ryft_cost_percent ?? 0), costFix = Number(std.ryft_cost_fixed_pence ?? 0);
        const payPct = costPct + mkPct, payFix = costFix + mkFix;   // what the customer pays
        const linked = !!payInfo.ovr?.ryft_account_id;
        const live = !!payInfo.ovr?.charges_enabled;
        return (
          <div style={S.card}>
            <div style={S.h2}>💳 Card payments</div>
            <div style={S.desc}>
              {linked ? (live ? 'Your payments account is live.' : 'Your account is set up — finish onboarding to start taking payments.') : 'Connect your payments account below to start taking cards.'}
            </div>
            <div style={{ border:'1px solid var(--bdr)', borderRadius:10, padding:'14px 16px', background:'var(--bg2)' }}>
              <div style={{ fontSize:11, fontWeight:700, color:'var(--t3)', textTransform:'uppercase', letterSpacing:'.04em', marginBottom:6 }}>What you pay per card transaction</div>
              <div style={{ fontSize:24, fontWeight:800, color:'var(--t1)' }}>{payPct.toFixed(2)}% + {payFix}p</div>
              <div style={{ fontSize:12, color:'var(--t4)', marginTop:6, lineHeight:1.5 }}>
                One simple all-in rate per card payment.
              </div>
            </div>
            <div style={{ fontSize:11, color:'var(--t4)', marginTop:8 }}>
              Your rate is set by your account manager.
            </div>

            {/* Self-serve onboarding */}
            {!live && (
              <div style={{ marginTop:16, paddingTop:16, borderTop:'1px solid var(--bdr)' }}>
                <button
                  onClick={startRyftOnboarding}
                  disabled={onbBusy}
                  style={{ ...S.btn, background:'var(--acc)', color:'#0b0c10' }}
                >
                  {onbBusy ? 'Opening…' : (linked ? 'Continue payment setup' : 'Set up card payments')}
                </button>
                <span style={{ fontSize:12, color:'var(--t4)', marginLeft:12 }}>
                  Opens secure onboarding to verify your business and add bank &amp; payout details.
                </span>
                {onbErr && <div style={{ fontSize:12, color:'var(--red)', marginTop:8 }}>{onbErr}</div>}
                {onbLink && (
                  <div style={{ fontSize:12, color:'var(--t3)', marginTop:8 }}>
                    If a tab didn't open, use this link: <a href={onbLink} target="_blank" rel="noreferrer" style={{ color:'var(--acc)', wordBreak:'break-all' }}>{onbLink}</a>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })()}

      {/* Timezone */}
      <div style={S.card}>
        <div style={S.h2}>🌍 Timezone</div>
        <div style={S.desc}>
          All timestamps, reporting, and shift calculations use this timezone.
          Reports will show "today's" data from the correct local midnight — not the server or device time.
        </div>
        <label style={S.label}>Location timezone</label>
        <select style={S.select} value={timezone} onChange={e => setTimezone(e.target.value)}>
          {TIMEZONES.map(tz => <option key={tz.value} value={tz.value}>{tz.label}</option>)}
        </select>
        <div style={{ fontSize:11, color:'var(--t4)', marginTop:6 }}>
          Current time in {timezone}: <strong style={{ color:'var(--t2)' }}>
            {new Date().toLocaleTimeString('en-GB', { timeZone: timezone, hour:'2-digit', minute:'2-digit' })}
          </strong>
        </div>
      </div>

      {/* v5.5.326: Currency */}
      <div style={S.card}>
        <div style={S.h2}>💱 Currency</div>
        <div style={S.desc}>
          The currency this location trades in. Drives the symbol shown across POS, kiosk,
          online ordering and receipts, and the currency cards are charged in.
        </div>
        <label style={S.label}>Location currency</label>
        <select style={{ ...S.select, maxWidth:280 }} value={currency} onChange={e => setCurrency(e.target.value)}>
          {Object.values(CURRENCIES).map(c => <option key={c.code} value={c.code}>{c.label}</option>)}
        </select>
        <div style={{ fontSize:11, color:'var(--t4)', marginTop:6 }}>
          Example: <strong style={{ color:'var(--t2)' }}>{money(12.5, currency)}</strong> · {money(1234.56, currency)}
        </div>
      </div>

      {/* Business day start */}
      <div style={S.card}>
        <div style={S.h2}>⏰ Business day start</div>
        <div style={S.desc}>
          The time a new reporting day begins. Checks closed before this time are attributed to the previous day.
          Set to <strong>06:00</strong> for a standard restaurant. Nightclubs or late bars might use <strong>04:00</strong>.
        </div>
        <label style={S.label}>New day starts at</label>
        <select style={{ ...S.select, maxWidth:160 }} value={bizDayStart} onChange={e => setBizDayStart(e.target.value)}>
          {HOURS.map(h => <option key={h.value} value={h.value}>{h.label}</option>)}
        </select>
        <div style={{ fontSize:11, color:'var(--t4)', marginTop:6 }}>
          Today's reporting period: <strong style={{ color:'var(--t2)' }}>{bizDayStart} — {bizDayStart} tomorrow</strong>
        </div>

      {/* v4.6.60: Collection lead time */}
      <div style={S.card}>
        <div style={S.h2}>🕐 Collection lead time</div>
        <div style={S.desc}>
          When a customer schedules a collection time, the kitchen ticket fires this many minutes before the collection time.
          Set to <strong>30</strong> for a normal kitchen. Set to <strong>0</strong> to fire immediately on send.
        </div>
        <label style={S.label}>Fire to kitchen N minutes before collection</label>
        <select style={{ ...S.select, maxWidth:160 }} value={collectionLeadMin} onChange={e => setCollectionLeadMin(parseInt(e.target.value, 10) || 0)}>
          {Array.from({ length: 25 }, (_, i) => i * 5).map(m => (
            <option key={m} value={m}>{m === 0 ? 'Fire immediately' : `${m} minutes`}</option>
          ))}
        </select>
        <div style={{ fontSize:11, color:'var(--t4)', marginTop:6 }}>
          Example: customer collects at <strong style={{ color:'var(--t2)' }}>19:00</strong>, lead time <strong style={{ color:'var(--t2)' }}>{collectionLeadMin} min</strong> → kitchen fires at <strong style={{ color:'var(--t2)' }}>{collectionLeadMin === 0 ? '19:00 (immediately)' : (() => { const d = new Date(); d.setHours(19, 0, 0, 0); d.setMinutes(d.getMinutes() - collectionLeadMin); return d.toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' }); })()}</strong>.
        </div>
      </div>
      </div>

      {/* Shifts */}
      <div style={S.card}>
        <div style={S.h2}>🕐 Service periods</div>
        <div style={S.desc}>
          Named shifts let you filter reports by period (Breakfast / Lunch / Dinner) and give the AI assistant
          shift context. Leave empty to use whole-day reporting only.
        </div>

        {shifts.map((sh, i) => {
          const dur = shiftDurationMinutes(sh.start, sh.end);
          const tooLong = dur > 12 * 60;  // More than 12h likely indicates misconfiguration
          return (
          <div key={sh.id} style={S.row}>
            <div>
              {i === 0 && <label style={S.label}>Name</label>}
              <input style={{ ...S.input, width:'100%', boxSizing:'border-box' }}
                value={sh.name} onChange={e => updateShift(sh.id, 'name', e.target.value)}
                placeholder="e.g. Dinner"/>
            </div>
            <div>
              {i === 0 && <label style={S.label}>Start</label>}
              <select style={{ ...S.select, ...(tooLong ? { borderColor:'var(--red-b)' } : {}) }} value={sh.start} onChange={e => updateShift(sh.id, 'start', e.target.value)}>
                {HOURS.map(h => <option key={h.value} value={h.value}>{h.label}</option>)}
              </select>
            </div>
            <div>
              {i === 0 && <label style={S.label}>End</label>}
              <select style={{ ...S.select, ...(tooLong ? { borderColor:'var(--red-b)' } : {}) }} value={sh.end} onChange={e => updateShift(sh.id, 'end', e.target.value)}>
                {HOURS.map(h => <option key={h.value} value={h.value}>{h.label}</option>)}
              </select>
              {tooLong && (
                <div style={{ fontSize:10, color:'var(--red)', marginTop:4 }}>
                  {Math.floor(dur/60)}h long — check start/end are correct
                </div>
              )}
            </div>
            <div>
              {i === 0 && <label style={S.label}>&nbsp;</label>}
              <button onClick={() => removeShift(sh.id)}
                style={{ ...S.btn, background:'var(--red-d)', color:'var(--red)', border:'1px solid var(--red-b)', padding:'9px 12px' }}>✕</button>
            </div>
          </div>
          );
        })}

        <div style={{ display:'flex', gap:8, flexWrap:'wrap', marginTop:4 }}>
          <button onClick={addShift}
            style={{ ...S.btn, background:'var(--bg3)', color:'var(--t2)', border:'1px solid var(--bdr)' }}>
            + Add shift
          </button>
          <button onClick={() => setShifts([
            { id:`shift-${Date.now()}-b`, name:'Breakfast', start:'07:00', end:'11:00' },
            { id:`shift-${Date.now()}-l`, name:'Lunch',     start:'11:00', end:'17:00' },
            { id:`shift-${Date.now()}-d`, name:'Dinner',    start:'17:00', end:'23:00' },
          ])}
            style={{ ...S.btn, background:'transparent', color:'var(--t3)', border:'1px solid var(--bdr)' }}>
            Use defaults (Breakfast / Lunch / Dinner)
          </button>
        </div>

        {shifts.length > 0 && (
          <div style={{ marginTop:12, fontSize:11, color:'var(--t4)', lineHeight:1.8 }}>
            ⓘ Service periods drive Shifts, Daypart, and Business summary reports (v4.6.25+). They also appear in the AI assistant context.
            Gaps between shifts are valid — not all time needs to be covered.
          </div>
        )}
      </div>

      {/* Opening Hours — Phase 1 of online ordering */}
      <OpeningHoursCard
        hours={openingHours}
        setHours={setOpeningHours}
        timezone={timezone}
        closedDateInput={closedDateInput}
        setClosedDateInput={setClosedDateInput}
      />

      {/* Online ordering / QR code surfaces — Phase 2 */}
      <OnlineOrderingCard
        locationName={location?.name}
        slug={onlineSlug}
        setSlug={setOnlineSlug}
        slugError={slugError}
        setSlugError={setSlugError}
        onlineEnabled={onlineEnabled}
        setOnlineEnabled={setOnlineEnabled}
        qrEnabled={qrEnabled}
        setQrEnabled={setQrEnabled}
      />

      {/* POS Display */}
      <div style={S.card}>
        <div style={S.h2}>🖼 POS Display</div>
        <div style={S.desc}>
          When enabled, product images appear as background photos on the POS item buttons.
          Images can be added per-item in the menu manager. Images always show on long-press regardless of this setting.
        </div>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'12px 0' }}>
          <div>
            <div style={{ fontSize:13, fontWeight:700, color:'var(--t1)' }}>Show images on POS buttons</div>
            <div style={{ fontSize:11, color:'var(--t4)', marginTop:2 }}>Applies to all terminals at this location</div>
          </div>
          <button
            onClick={() => setShowItemImages(v => !v)}
            style={{
              width:44, height:24, borderRadius:12, border:'none', cursor:'pointer',
              background: showItemImages ? 'var(--acc)' : 'var(--bdr2)',
              position:'relative', transition:'background .2s', flexShrink:0,
            }}>
            <div style={{
              position:'absolute', top:3, left: showItemImages ? 23 : 3,
              width:18, height:18, borderRadius:'50%', background:'#fff',
              transition:'left .2s', boxShadow:'0 1px 3px rgba(0,0,0,.2)',
            }}/>
          </button>
        </div>
        {loadingImageSetting && <div style={{ fontSize:11, color:'var(--t4)' }}>Loading…</div>}
      </div>

      {/* Save */}
      <div style={{ display:'flex', alignItems:'center', gap:12 }}>
        <button onClick={save} disabled={saving}
          style={{ ...S.btn, background:'var(--acc)', color:'#fff', opacity:saving?.6:1 }}>
          {saving ? 'Saving…' : 'Save settings'}
        </button>
        {saved && <span style={{ fontSize:13, color:'var(--grn)', fontWeight:600 }}>✓ Saved</span>}
        {error && <span style={{ fontSize:13, color:'var(--red)' }}>{error}</span>}
      </div>
    </div>
  );
}

// ── Online Ordering / QR card ────────────────────────────────────────────────
// Phase 2 — lets the operator pick a slug ("peters-cafe") that becomes
// peters-cafe.serv-os.app for the customer, and toggle the two
// customer-facing surfaces independently:
//   • Online ordering   — collection / delivery, customer details, Stripe online
//   • QR table-side     — diners scan a QR at their table, fires into the
//                         table's session on the POS, server brings food
function OnlineOrderingCard({
  locationName, slug, setSlug, slugError, setSlugError,
  onlineEnabled, setOnlineEnabled, qrEnabled, setQrEnabled,
}) {
  // Domain shown in the preview matches the active tier (dev/stage/prod).
  const previewHost = slug ? `${slug}.${CUSTOMER_ROOT}` : `(slug).${CUSTOMER_ROOT}`;
  const onlineUrl   = slug ? `https://${slug}.${CUSTOMER_ROOT}`               : '';
  const qrUrl       = slug ? `https://${slug}.${CUSTOMER_ROOT}/t/<table-id>`  : '';

  return (
    <div style={S.card}>
      <div style={S.h2}>📱 Online ordering & QR code</div>
      <div style={S.desc}>
        Two customer-facing surfaces. <b>Online</b> is for remote orders (collection / delivery, pay online).
        <b>QR table-side</b> is for in-store guests scanning a code at their table — fires straight into the table's session on the POS.
        Set a slug below and your URLs become {previewHost.includes('serv-os') ? <code style={{ color:'var(--acc)' }}>{previewHost}</code> : previewHost}.
      </div>

      {/* Slug */}
      <label style={S.label}>Online slug</label>
      <div style={{ display:'flex', alignItems:'center', gap:6 }}>
        <input
          style={{ ...S.input, flex:1, fontFamily:'var(--font-mono)' }}
          value={slug}
          placeholder={locationName ? suggestSlug(locationName) : 'peters-cafe'}
          onChange={e => { setSlug(e.target.value.toLowerCase()); setSlugError(''); }}/>
        <span style={{ fontSize:12, color:'var(--t4)', fontFamily:'var(--font-mono)' }}>.{CUSTOMER_ROOT}</span>
        {locationName && !slug && (
          <button onClick={() => setSlug(suggestSlug(locationName))} style={{ ...S.btn, background:'var(--bg3)', color:'var(--t2)', border:'1px solid var(--bdr)', padding:'7px 10px', fontSize:11 }}>
            Suggest
          </button>
        )}
      </div>
      {slugError && <div style={{ fontSize:11, color:'var(--red)', marginTop:6 }}>{slugError}</div>}
      <div style={{ fontSize:11, color:'var(--t4)', marginTop:6, lineHeight:1.5 }}>
        Lowercase letters, digits and hyphens. 3-40 chars. Must be unique across all locations.
      </div>

      {/* Surface toggles */}
      <div style={{ marginTop:18, paddingTop:14, borderTop:'1px solid var(--bdr)' }}>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'10px 0', gap:10 }}>
          <div style={{ flex:1 }}>
            <div style={{ fontSize:13, fontWeight:700, color:'var(--t1)' }}>🌐 Online ordering</div>
            <div style={{ fontSize:11, color:'var(--t4)', marginTop:2 }}>
              {slug ? <><code style={{ fontFamily:'var(--font-mono)' }}>{onlineUrl}</code> — collection / delivery, customer details, Stripe online checkout.</> : 'Set a slug above first.'}
            </div>
          </div>
          <Toggle on={onlineEnabled} onChange={setOnlineEnabled} disabled={!slug}/>
        </div>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'10px 0', gap:10, borderTop:'1px solid var(--bdr)' }}>
          <div style={{ flex:1 }}>
            <div style={{ fontSize:13, fontWeight:700, color:'var(--t1)' }}>📱 QR table-side ordering</div>
            <div style={{ fontSize:11, color:'var(--t4)', marginTop:2 }}>
              {slug ? <><code style={{ fontFamily:'var(--font-mono)' }}>{qrUrl}</code> — guests scan a QR at their table, items fire into that table's session on the POS.</> : 'Set a slug above first.'}
            </div>
          </div>
          <Toggle on={qrEnabled} onChange={setQrEnabled} disabled={!slug}/>
        </div>
      </div>

      {slug && (
        <div style={{ marginTop:14, padding:'10px 12px', background:'var(--bg3)', borderRadius:8, border:'1px solid var(--bdr)' }}>
          <div style={{ fontSize:11, color:'var(--t4)', lineHeight:1.6 }}>
            <b>DNS pending.</b> Once <code style={{ fontFamily:'var(--font-mono)' }}>*.{CUSTOMER_ROOT}</code> is wired (Vercel + registrar), the URLs above go live.
            <br/>Test now (no DNS) on the existing host:&nbsp;
            <code style={{ fontFamily:'var(--font-mono)' }}>?loc={slug}&surface=online</code>
            &nbsp;or&nbsp;
            <code style={{ fontFamily:'var(--font-mono)' }}>?loc={slug}&surface=qr&t=&lt;table-id&gt;</code>.
          </div>
        </div>
      )}
    </div>
  );
}

function Toggle({ on, onChange, disabled }) {
  return (
    <button
      onClick={() => !disabled && onChange(!on)}
      disabled={disabled}
      style={{
        width:44, height:24, borderRadius:12, border:'none', cursor: disabled ? 'not-allowed' : 'pointer',
        background: disabled ? 'var(--bdr)' : (on ? 'var(--acc)' : 'var(--bdr2)'),
        position:'relative', transition:'background .2s', flexShrink:0, opacity: disabled ? .5 : 1,
      }}>
      <div style={{
        position:'absolute', top:3, left: on ? 23 : 3,
        width:18, height:18, borderRadius:'50%', background:'#fff',
        transition:'left .2s', boxShadow:'0 1px 3px rgba(0,0,0,.2)',
      }}/>
    </button>
  );
}

// ── Opening Hours editor ─────────────────────────────────────────────────────
const DAY_LABELS = [
  { key:'mon', label:'Monday' },
  { key:'tue', label:'Tuesday' },
  { key:'wed', label:'Wednesday' },
  { key:'thu', label:'Thursday' },
  { key:'fri', label:'Friday' },
  { key:'sat', label:'Saturday' },
  { key:'sun', label:'Sunday' },
];

function OpeningHoursCard({ hours, setHours, timezone, closedDateInput, setClosedDateInput }) {
  const status = isOpenNow(hours, timezone, new Date());
  const preview = formatHoursPreview(hours);

  const updateDay = (dayKey, windows) => {
    setHours(h => ({ ...h, weekly: { ...(h.weekly || {}), [dayKey]: windows } }));
  };
  const addWindow = (dayKey) => {
    const w = (hours.weekly?.[dayKey] || []);
    const last = w[w.length - 1];
    // Smart default: if previous window is e.g. 11:30-15:00, suggest 17:00-22:00
    const next = last
      ? { open: '17:00', close: '22:00' }
      : { open: '09:00', close: '17:00' };
    updateDay(dayKey, [...w, next]);
  };
  const removeWindow = (dayKey, idx) => {
    const w = (hours.weekly?.[dayKey] || []).slice();
    w.splice(idx, 1);
    updateDay(dayKey, w);
  };
  const setWindowField = (dayKey, idx, field, value) => {
    const w = (hours.weekly?.[dayKey] || []).slice();
    w[idx] = { ...w[idx], [field]: value };
    updateDay(dayKey, w);
  };
  const copyMondayToAll = () => {
    const mon = hours.weekly?.mon || [];
    setHours(h => ({
      ...h,
      weekly: Object.fromEntries(DAY_LABELS.map(d => [d.key, mon])),
    }));
  };
  const useDefault = () => setHours(defaultOpeningHours());

  const addClosedDate = () => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(closedDateInput)) return;
    setHours(h => ({
      ...h,
      closedDates: Array.from(new Set([...(h.closedDates || []), closedDateInput])).sort(),
    }));
    setClosedDateInput('');
  };
  const removeClosedDate = (d) => {
    setHours(h => ({ ...h, closedDates: (h.closedDates || []).filter(x => x !== d) }));
  };

  return (
    <div style={S.card}>
      <div style={S.h2}>🚪 Opening hours</div>
      <div style={S.desc}>
        Drives the kiosk and the online ordering surface. When you're closed, customers see a "Closed — opens at X" banner instead of an order button. Multi-window per day supports lunch / dinner with a break (e.g. 11:30-15:00 then 17:00-22:00). Overnight windows (close before open, e.g. 22:00-02:00) are valid.
      </div>

      {/* Live status */}
      <div style={{
        padding:'12px 14px', borderRadius:10, marginBottom:14,
        background: status.open ? 'var(--grn-d)' : 'var(--red-d)',
        border: `1px solid ${status.open ? 'var(--grn-b)' : 'var(--red-b)'}`,
        display:'flex', alignItems:'center', gap:10,
      }}>
        <div style={{ fontSize:18 }}>{status.open ? '🟢' : '🔴'}</div>
        <div style={{ flex:1 }}>
          <div style={{ fontSize:13, fontWeight:800, color: status.open ? 'var(--grn)' : 'var(--red)' }}>
            {status.open ? 'Open right now' : 'Closed right now'}
          </div>
          <div style={{ fontSize:11, color:'var(--t4)', marginTop:2 }}>{preview}</div>
        </div>
      </div>

      {/* Weekly grid */}
      <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
        {DAY_LABELS.map(({ key, label }) => {
          const windows = hours.weekly?.[key] || [];
          const isClosed = windows.length === 0;
          return (
            <div key={key} style={{
              padding:'10px 12px', borderRadius:8,
              background:'var(--bg)', border:'1px solid var(--bdr)',
              display:'grid', gridTemplateColumns:'90px 1fr auto', gap:10, alignItems:'start',
            }}>
              <div style={{ fontSize:13, fontWeight:700, color:'var(--t1)', paddingTop:4 }}>{label}</div>
              <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
                {isClosed && (
                  <div style={{ fontSize:12, color:'var(--t4)', fontStyle:'italic', paddingTop:6 }}>Closed</div>
                )}
                {windows.map((w, idx) => (
                  <div key={idx} style={{ display:'flex', gap:6, alignItems:'center' }}>
                    <select style={{ ...S.select, width:90, padding:'6px 8px', fontSize:12 }}
                      value={w.open || '09:00'}
                      onChange={e => setWindowField(key, idx, 'open', e.target.value)}>
                      {HOURS.map(h => <option key={h.value} value={h.value}>{h.label}</option>)}
                    </select>
                    <span style={{ fontSize:11, color:'var(--t4)' }}>to</span>
                    <select style={{ ...S.select, width:90, padding:'6px 8px', fontSize:12 }}
                      value={w.close || '17:00'}
                      onChange={e => setWindowField(key, idx, 'close', e.target.value)}>
                      {HOURS.map(h => <option key={h.value} value={h.value}>{h.label}</option>)}
                    </select>
                    <button onClick={() => removeWindow(key, idx)}
                      style={{ ...S.btn, background:'var(--red-d)', color:'var(--red)', border:'1px solid var(--red-b)', padding:'4px 9px', fontSize:11 }}>
                      ✕
                    </button>
                  </div>
                ))}
              </div>
              <button onClick={() => addWindow(key)}
                style={{ ...S.btn, background:'var(--bg3)', color:'var(--t2)', border:'1px solid var(--bdr)', padding:'6px 10px', fontSize:11 }}>
                + Window
              </button>
            </div>
          );
        })}
      </div>

      <div style={{ display:'flex', gap:8, flexWrap:'wrap', marginTop:12 }}>
        <button onClick={copyMondayToAll}
          style={{ ...S.btn, background:'var(--bg3)', color:'var(--t2)', border:'1px solid var(--bdr)' }}>
          Copy Monday to every day
        </button>
        <button onClick={useDefault}
          style={{ ...S.btn, background:'transparent', color:'var(--t3)', border:'1px solid var(--bdr)' }}>
          Use defaults (11:30-22:00 daily)
        </button>
      </div>

      {/* Closed dates */}
      <div style={{ marginTop:18, paddingTop:14, borderTop:'1px solid var(--bdr)' }}>
        <div style={{ fontSize:13, fontWeight:700, color:'var(--t1)', marginBottom:4 }}>Closed dates</div>
        <div style={{ fontSize:11, color:'var(--t4)', marginBottom:10 }}>
          Holidays / one-off closures override the weekly schedule. Date in the location's timezone (YYYY-MM-DD).
        </div>
        <div style={{ display:'flex', gap:8, flexWrap:'wrap', alignItems:'center', marginBottom:10 }}>
          <input type="date"
            value={closedDateInput}
            onChange={e => setClosedDateInput(e.target.value)}
            style={{ ...S.input }}/>
          <button onClick={addClosedDate} disabled={!closedDateInput}
            style={{ ...S.btn, background:'var(--bg3)', color:'var(--t2)', border:'1px solid var(--bdr)', opacity: closedDateInput ? 1 : .5 }}>
            + Add closed date
          </button>
        </div>
        {(hours.closedDates || []).length === 0 ? (
          <div style={{ fontSize:11, color:'var(--t4)', fontStyle:'italic' }}>No closed dates set.</div>
        ) : (
          <div style={{ display:'flex', flexWrap:'wrap', gap:6 }}>
            {(hours.closedDates || []).map(d => (
              <span key={d} style={{
                display:'inline-flex', alignItems:'center', gap:6,
                padding:'4px 10px', borderRadius:99,
                background:'var(--red-d)', color:'var(--red)', border:'1px solid var(--red-b)',
                fontSize:11, fontFamily:'var(--font-mono)', fontWeight:700,
              }}>
                {d}
                <button onClick={() => removeClosedDate(d)} style={{
                  background:'transparent', border:'none', color:'var(--red)',
                  cursor:'pointer', padding:0, fontSize:13, lineHeight:1, fontFamily:'inherit',
                }}>×</button>
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
