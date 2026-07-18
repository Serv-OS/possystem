// src/surfaces/GroupOrderSurface.jsx
//
// Multi-site GROUP landing pages (Toast-style) — one link for a restaurant group.
// TWO separate faces of the business, two separate pickers (owner decision —
// catering must never sit as a button next to "Order online"):
//   variant='online'   /order/<groupSlug> (or ?group=)  → online-ordering venue picker
//   variant='catering' /cater/<groupSlug> (or ?cater=)  → catering venue picker
//                                                          (catering-enabled venues ONLY,
//                                                          with Delivery / Collection badges)
// The customer picks a venue, then is handed to that venue's EXISTING online or
// catering URL — this page never touches the per-venue ordering flows. If exactly
// ONE venue is eligible for the picker's channel, the picker is skipped entirely
// and the customer is redirected straight into that venue's site.
//
// Resolution: groupSlug → platform `companies.slug` → that company's platform
// `locations` rows (company_id linkage). Branding comes from the first eligible
// venue's online_branding (same MenuTheme engine as the storefront). OPEN/CLOSED
// (online picker only — catering runs on its own hours/lead-time, so the picker
// shows fulfilment badges instead) from each venue's platform opening_hours +
// timezone via lib/openingHours. Catering eligibility + fulfilment (takeout /
// delivery) come from the anon-safe catering_public_settings RPC on the ops DB —
// it returns the settings row ONLY when the catering site is enabled.
//
// Read-only / marketing-safe: no writes anywhere. The chosen venue is remembered in
// localStorage (offline-cache-style convenience only; separate keys per picker so
// online + catering choices don't clash) for an "Order again" banner — never a
// forced redirect.

import { useEffect, useMemo, useRef, useState } from 'react';
import { supabase, platformSupabase } from '../lib/supabase';
import { customerUrl } from '../lib/env';
import { isOpenNow, nextOpensAt, formatHoursPreview } from '../lib/openingHours';
import { readTheme, deriveVars, readableOn, FIXED, DISPLAY_FONT, BODY_FONT } from './menu/menuTheme';
import MenuHeader from './menu/MenuHeader';

// Separate keys per picker — an online choice must not pre-select a catering venue
// (and vice versa). The online key predates the split, so it keeps its old name.
const LAST_VENUE_KEY = (variant, groupSlug) =>
  variant === 'catering' ? `rpos-group-cater:${groupSlug}` : `rpos-group-last:${groupSlug}`;

function readLastVenue(variant, groupSlug) {
  try {
    const raw = window.localStorage.getItem(LAST_VENUE_KEY(variant, groupSlug));
    if (!raw) return null;
    const v = JSON.parse(raw);
    return v && v.locationId ? v : null;
  } catch { return null; }
}
function saveLastVenue(variant, groupSlug, loc) {
  try {
    window.localStorage.setItem(LAST_VENUE_KEY(variant, groupSlug), JSON.stringify({ locationId: loc.id, name: loc.name }));
  } catch { /* storage unavailable — banner just won't show */ }
}
function clearLastVenue(variant, groupSlug) {
  try { window.localStorage.removeItem(LAST_VENUE_KEY(variant, groupSlug)); } catch {}
}

export default function GroupOrderSurface({ groupSlug, variant = 'online' }) {
  const isCatering = variant === 'catering';
  const [state, setState] = useState({ loading: true, company: null, venues: [], error: null });
  const [lastVenue, setLastVenue] = useState(() => readLastVenue(variant, groupSlug));
  const [redirecting, setRedirecting] = useState(null);   // venue name while auto-redirecting
  const redirected = useRef(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (!platformSupabase) { setState({ loading: false, company: null, venues: [], error: 'not_found' }); return; }
        const { data: company } = await platformSupabase
          .from('companies').select('id, name, slug')
          .eq('slug', groupSlug).maybeSingle();
        if (cancelled) return;
        if (!company) { setState({ loading: false, company: null, venues: [], error: 'not_found' }); return; }

        const { data: locs } = await platformSupabase
          .from('locations')
          .select('id, ops_location_id, name, address, timezone, currency, online_slug, online_enabled, opening_hours, online_branding')
          .eq('company_id', company.id)
          .order('name');
        if (cancelled) return;
        const venues = locs || [];

        // v5.5.802: venue address for the picker cards. The platform row's address
        // is often unset — the ops DB `locations.address` (receipt/BO address) is
        // the populated source, so probe it as the fallback. Failure = no address
        // line, never a broken card.
        const opsAddr = {};
        if (supabase && venues.length) {
          try {
            const opsIds = [...new Set(venues.map(v => v.ops_location_id || v.id))];
            const { data: opsLocs } = await supabase.from('locations').select('id, address, receipt_branding').in('id', opsIds);
            (opsLocs || []).forEach(r => {
              // Fallback chain: ops address column → the receipt-settings address lines
              // (Settings → Receipt → "Address"), so venues only maintain it once.
              const rb = (r.receipt_branding?.header?.address_lines || []).filter(Boolean).join(', ');
              const a = (r.address && String(r.address).trim()) || rb;
              if (a) opsAddr[r.id] = a;
            });
          } catch { /* address line just won't render */ }
        }

        // Catering availability + fulfilment per venue — the anon-safe RPC returns
        // the settings row ONLY when the catering site is enabled, so a non-null
        // result = catering is on; takeout/delivery flags drive the picker badges.
        // Each probe is independently guarded: a failure treats catering as off.
        const catering = {};
        if (supabase) {
          await Promise.all(venues.map(async (v) => {
            try {
              const { data } = await supabase.rpc('catering_public_settings', { p_location: v.ops_location_id || v.id });
              if (data) {
                catering[v.id] = {
                  collection: !!data.takeout_enabled,
                  delivery: !!data.delivery_enabled,
                  collectionLabel: data.takeout_dining_option === 'pickup' ? 'Pickup' : 'Collection',
                };
              }
            } catch { /* catering treated as off for this venue */ }
          }));
        }

        setState({
          loading: false, company, error: null,
          venues: venues.map(v => ({
            ...v,
            address: (v.address && String(v.address).trim()) || opsAddr[v.ops_location_id || v.id] || null,
            catering: catering[v.id] || null,
          })),
        });
      } catch (e) {
        if (!cancelled) setState({ loading: false, company: null, venues: [], error: e?.message || 'load_failed' });
      }
    })();
    return () => { cancelled = true; };
  }, [groupSlug]);

  // Which venues does THIS picker show / link to?
  //   online   → all venues listed; the button only where online ordering is live
  //   catering → catering-enabled venues ONLY (a different face of the business)
  const displayVenues = isCatering
    ? state.venues.filter(v => v.catering && v.online_slug)
    : state.venues;
  const actionable = isCatering
    ? displayVenues
    : state.venues.filter(v => v.online_enabled && v.online_slug);
  const targetUrlFor = (v) => customerUrl(v.online_slug, isCatering ? '/catering' : '');

  // Single eligible venue → skip the picker, go straight into that venue's site.
  useEffect(() => {
    if (state.loading || state.error || !state.company || redirected.current) return;
    if (actionable.length === 1) {
      redirected.current = true;
      const v = actionable[0];
      setRedirecting(v.name);
      window.location.replace(targetUrlFor(v));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  // Brand theme from the first eligible venue that has branding — same MenuTheme
  // engine as the online/catering storefronts.
  const brandLoc = actionable.find(v => v.online_branding)
    || state.venues.find(v => v.online_enabled && v.online_branding)
    || state.venues.find(v => v.online_branding)
    || null;
  const mt = useMemo(() => readTheme(brandLoc?.online_branding), [brandLoc]);
  const vars = useMemo(() => deriveVars(mt.brandColor, mt.bodyBg), [mt.brandColor, mt.bodyBg]);
  const onBrand = readableOn(mt.brandColor);

  const shell = {
    ...vars,
    position: 'fixed', inset: 0, overflowY: 'auto', overflowX: 'hidden',
    WebkitOverflowScrolling: 'touch', containerType: 'inline-size',
    background: 'var(--bg)', color: 'var(--ink)', fontFamily: BODY_FONT,
  };

  if (state.loading || redirecting) {
    return (
      <div style={shell}>
        <div style={{ textAlign: 'center', padding: '90px 20px', color: FIXED.muted, fontSize: 14 }}>
          {redirecting ? <>Taking you to <b style={{ color: FIXED.ink }}>{redirecting}</b>…</> : 'Loading…'}
        </div>
      </div>
    );
  }

  if (state.error || !state.company) {
    return (
      <div style={shell}>
        <div style={{ maxWidth: 480, margin: '60px auto 0', padding: '40px 24px', textAlign: 'center', background: FIXED.card, border: `1px solid ${FIXED.line}`, borderRadius: 16 }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>🔍</div>
          <div style={{ fontFamily: DISPLAY_FONT, fontSize: 20, fontWeight: 700, marginBottom: 8 }}>Ordering page not found</div>
          <div style={{ fontSize: 14, color: FIXED.muted, lineHeight: 1.6 }}>
            We couldn't find an ordering page for <b>{groupSlug}</b>. Check the link with the restaurant.
          </div>
        </div>
      </div>
    );
  }

  const remembered = lastVenue && actionable.find(v => v.id === lastVenue.locationId);
  const pickCta = isCatering ? 'Order catering' : 'Order online';

  return (
    <div style={shell}>
      <MenuHeader theme={mt} name={state.company.name}
        pills={[{
          label: isCatering
            ? (displayVenues.length > 1 ? `Catering · ${displayVenues.length} venues` : 'Catering')
            : (displayVenues.length === 1 ? 'Order online' : `${displayVenues.length} locations · pick yours`),
        }]} />

      <div style={{ maxWidth: 640, margin: '0 auto', padding: '16px 16px 56px' }}>

        {/* Return visit — remembered venue banner (no forced redirect) */}
        {remembered && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
            padding: '12px 14px', margin: '4px 0 14px',
            background: `${mt.brandColor}14`,
            border: `1px solid ${mt.brandColor}55`,
            borderRadius: 14,
          }}>
            <div style={{ flex: '1 1 180px', fontSize: 14, minWidth: 0 }}>
              {isCatering
                ? <>Order catering from <b>{remembered.name}</b> again?</>
                : <>Order again from <b>{remembered.name}</b>?</>}
            </div>
            <div style={{ display: 'flex', gap: 8, flex: 'none' }}>
              <a href={targetUrlFor(remembered)}
                onClick={() => saveLastVenue(variant, groupSlug, remembered)}
                style={{
                  padding: '9px 16px', borderRadius: 99, background: 'var(--brand)', color: onBrand,
                  fontSize: 13, fontWeight: 700, textDecoration: 'none', whiteSpace: 'nowrap',
                }}>
                {pickCta}
              </a>
              <button onClick={() => { clearLastVenue(variant, groupSlug); setLastVenue(null); }}
                style={{
                  padding: '9px 14px', borderRadius: 99, background: 'transparent', color: FIXED.muted,
                  border: `1px solid ${FIXED.line}`, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap',
                }}>
                Change venue
              </button>
            </div>
          </div>
        )}

        <div style={{ fontFamily: DISPLAY_FONT, fontSize: 15, fontWeight: 700, letterSpacing: '-.01em', margin: '10px 2px 10px' }}>
          {displayVenues.length === 1 ? 'Our venue' : (isCatering ? 'Choose a venue for catering' : 'Choose a venue')}
        </div>

        {displayVenues.length === 0 && (
          <div style={{ padding: '28px 20px', textAlign: 'center', background: FIXED.card, border: `1px solid ${FIXED.line}`, borderRadius: 16, color: FIXED.muted, fontSize: 14 }}>
            {isCatering
              ? <>Catering isn't available to order online yet — please contact {state.company.name} directly.</>
              : <>No venues are set up for online ordering yet — please check back soon.</>}
          </div>
        )}

        <div style={{ display: 'grid', gap: 12 }}>
          {displayVenues.map(v => (
            <VenueCard key={v.id} venue={v} isCatering={isCatering} cta={pickCta}
              targetUrl={targetUrlFor(v)} brandColor={mt.brandColor} onBrand={onBrand}
              onPick={() => saveLastVenue(variant, groupSlug, v)} />
          ))}
        </div>

        <div style={{ textAlign: 'center', marginTop: 34, fontSize: 11, color: FIXED.muted }}>
          Powered by Serv OS
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
function VenueCard({ venue, isCatering, cta, targetUrl, brandColor, onBrand, onPick }) {
  const tz = venue.timezone || 'Europe/London';
  // OPEN/CLOSED is the venue's live door status — meaningful for ordering food now,
  // NOT for catering (pre-orders run on catering's own hours/lead-time), so the
  // catering picker shows fulfilment badges instead.
  const hasHours = !isCatering && !!venue.opening_hours?.weekly;
  const status = hasHours ? isOpenNow(venue.opening_hours, tz) : null;
  const canOrder = isCatering ? true : !!(venue.online_enabled && venue.online_slug);

  let closedLine = null;
  if (status && !status.open) {
    const next = nextOpensAt(venue.opening_hours, tz);
    if (next) {
      closedLine = `Opens ${new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', hour: 'numeric', minute: '2-digit', hour12: true }).format(next)}`;
    }
  }

  const badge = (label, emoji) => (
    <span key={label} style={{
      display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 99,
      fontSize: 12, fontWeight: 700, background: `${brandColor}12`, color: FIXED.ink,
      border: `1px solid ${brandColor}44`,
    }}>
      <span aria-hidden="true">{emoji}</span>{label}
    </span>
  );

  return (
    <div style={{ background: FIXED.card, border: `1px solid ${FIXED.line}`, borderRadius: 16, padding: '16px 16px 14px', boxShadow: '0 1px 2px rgba(36,31,28,.04)' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontFamily: DISPLAY_FONT, fontSize: 18, fontWeight: 700, letterSpacing: '-.01em', lineHeight: 1.2 }}>{venue.name}</div>
          {venue.address && <div style={{ fontSize: 13, color: FIXED.muted, marginTop: 3 }}>{venue.address}</div>}
        </div>
        {status && (
          <span style={{
            flex: 'none', display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '4px 10px', borderRadius: 99, fontSize: 12, fontWeight: 700,
            background: status.open ? 'rgba(34,197,94,.12)' : 'rgba(36,31,28,.06)',
            color: status.open ? '#15803d' : FIXED.muted,
            border: `1px solid ${status.open ? 'rgba(34,197,94,.35)' : FIXED.line}`,
          }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: status.open ? '#22c55e' : '#b6aca2' }} />
            {status.open ? 'Open' : 'Closed'}
          </span>
        )}
      </div>

      {closedLine && <div style={{ fontSize: 12, color: FIXED.muted, marginTop: 6 }}>{closedLine}</div>}

      {/* v5.5.802: full weekly opening times — not just the live open/closed dot.
          Door hours are meaningful for ordering food now, so (like the status
          pill) they show on the online picker only; catering runs on its own
          hours/lead-time and keeps its fulfilment badges instead. */}
      {hasHours && (
        <div style={{ fontSize: 12, color: FIXED.muted, marginTop: 6, lineHeight: 1.55 }}>
          {/* Stacked: one line per day-group / time window (owner preference) */}
          {String(formatHoursPreview(venue.opening_hours)).split(/,\s+|\s+&\s+/).map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </div>
      )}

      {/* Catering fulfilment badges — what this venue offers for catering */}
      {isCatering && venue.catering && (venue.catering.delivery || venue.catering.collection) && (
        <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
          {venue.catering.delivery && badge('Delivery', '🚚')}
          {venue.catering.collection && badge(venue.catering.collectionLabel, '🥡')}
        </div>
      )}

      {canOrder ? (
        <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          <a href={targetUrl} onClick={onPick}
            style={{
              flex: '1 1 140px', textAlign: 'center', padding: '11px 16px', borderRadius: 12,
              background: brandColor, color: onBrand, fontSize: 14, fontWeight: 700,
              textDecoration: 'none',
            }}>
            {cta}
          </a>
        </div>
      ) : (
        <div style={{ marginTop: 12, fontSize: 13, color: FIXED.muted, fontStyle: 'italic' }}>
          Online ordering isn't available at this venue yet.
        </div>
      )}
    </div>
  );
}
