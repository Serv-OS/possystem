// src/surfaces/GroupOrderSurface.jsx
//
// Multi-site GROUP landing page (Toast-style) — one link for a restaurant group:
// /order/<groupSlug> (or ?group=<groupSlug>). The customer picks a venue, then is
// handed to that venue's EXISTING online / catering URL — this page never touches
// the per-venue ordering flows.
//
// Resolution: groupSlug → platform `companies.slug` → that company's platform
// `locations` rows (company_id linkage). Branding comes from the first online-enabled
// venue's online_branding (same MenuTheme engine as the storefront), OPEN/CLOSED from
// each venue's platform opening_hours + timezone via lib/openingHours. Catering
// buttons show only where the venue's catering site is enabled (anon-safe
// catering_public_settings RPC on the ops DB — returns null when the site is off).
//
// Read-only / marketing-safe: no writes anywhere. The chosen venue is remembered in
// localStorage (offline-cache-style convenience only) so return visits get an
// "Order again from <venue>" banner — never a forced redirect.

import { useEffect, useMemo, useState } from 'react';
import { supabase, platformSupabase } from '../lib/supabase';
import { customerUrl } from '../lib/env';
import { isOpenNow, nextOpensAt } from '../lib/openingHours';
import { readTheme, deriveVars, readableOn, FIXED, DISPLAY_FONT, BODY_FONT } from './menu/menuTheme';
import MenuHeader from './menu/MenuHeader';

const LAST_VENUE_KEY = (groupSlug) => `rpos-group-last:${groupSlug}`;

function readLastVenue(groupSlug) {
  try {
    const raw = window.localStorage.getItem(LAST_VENUE_KEY(groupSlug));
    if (!raw) return null;
    const v = JSON.parse(raw);
    return v && v.locationId ? v : null;
  } catch { return null; }
}
function saveLastVenue(groupSlug, loc) {
  try {
    window.localStorage.setItem(LAST_VENUE_KEY(groupSlug), JSON.stringify({ locationId: loc.id, name: loc.name }));
  } catch { /* storage unavailable — banner just won't show */ }
}
function clearLastVenue(groupSlug) {
  try { window.localStorage.removeItem(LAST_VENUE_KEY(groupSlug)); } catch {}
}

export default function GroupOrderSurface({ groupSlug }) {
  const [state, setState] = useState({ loading: true, company: null, venues: [], error: null });
  const [lastVenue, setLastVenue] = useState(() => readLastVenue(groupSlug));

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

        // Catering availability per venue — the anon-safe RPC returns settings ONLY
        // when the catering site is enabled, so a non-null result = show the button.
        // Each probe is independently guarded: a failure just hides that button.
        const cateringOk = {};
        if (supabase) {
          await Promise.all(venues.map(async (v) => {
            try {
              const { data } = await supabase.rpc('catering_public_settings', { p_location: v.ops_location_id || v.id });
              if (data) cateringOk[v.id] = true;
            } catch { /* button stays hidden */ }
          }));
        }

        setState({ loading: false, company, venues: venues.map(v => ({ ...v, cateringEnabled: !!cateringOk[v.id] })), error: null });
      } catch (e) {
        if (!cancelled) setState({ loading: false, company: null, venues: [], error: e?.message || 'load_failed' });
      }
    })();
    return () => { cancelled = true; };
  }, [groupSlug]);

  // Brand theme from the first online-enabled venue that has branding (falling back
  // to any branded venue) — same MenuTheme engine as the online/catering storefronts.
  const brandLoc = state.venues.find(v => v.online_enabled && v.online_branding)
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

  if (state.loading) {
    return (
      <div style={shell}>
        <div style={{ textAlign: 'center', padding: '90px 20px', color: FIXED.muted, fontSize: 14 }}>Loading…</div>
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

  const venues = state.venues;
  const remembered = lastVenue && venues.find(v => v.id === lastVenue.locationId);
  const rememberedOrderable = remembered && remembered.online_slug && (remembered.online_enabled || remembered.cateringEnabled);

  return (
    <div style={shell}>
      <MenuHeader theme={mt} name={state.company.name}
        pills={[{ label: venues.length === 1 ? 'Order online' : `${venues.length} locations · pick yours` }]} />

      <div style={{ maxWidth: 640, margin: '0 auto', padding: '16px 16px 56px' }}>

        {/* Return visit — remembered venue banner (no forced redirect) */}
        {rememberedOrderable && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
            padding: '12px 14px', margin: '4px 0 14px',
            background: `${mt.brandColor}14`,
            border: `1px solid ${mt.brandColor}55`,
            borderRadius: 14,
          }}>
            <div style={{ flex: '1 1 180px', fontSize: 14, minWidth: 0 }}>
              Order again from <b>{remembered.name}</b>?
            </div>
            <div style={{ display: 'flex', gap: 8, flex: 'none' }}>
              {remembered.online_enabled && (
                <a href={customerUrl(remembered.online_slug, '')}
                  onClick={() => saveLastVenue(groupSlug, remembered)}
                  style={{
                    padding: '9px 16px', borderRadius: 99, background: 'var(--brand)', color: onBrand,
                    fontSize: 13, fontWeight: 700, textDecoration: 'none', whiteSpace: 'nowrap',
                  }}>
                  Order online
                </a>
              )}
              <button onClick={() => { clearLastVenue(groupSlug); setLastVenue(null); }}
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
          {venues.length === 1 ? 'Our venue' : 'Choose a venue'}
        </div>

        {venues.length === 0 && (
          <div style={{ padding: '28px 20px', textAlign: 'center', background: FIXED.card, border: `1px solid ${FIXED.line}`, borderRadius: 16, color: FIXED.muted, fontSize: 14 }}>
            No venues are set up for online ordering yet — please check back soon.
          </div>
        )}

        <div style={{ display: 'grid', gap: 12 }}>
          {venues.map(v => (
            <VenueCard key={v.id} venue={v} brandColor={mt.brandColor} onBrand={onBrand}
              onPick={() => saveLastVenue(groupSlug, v)} />
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
function VenueCard({ venue, brandColor, onBrand, onPick }) {
  const tz = venue.timezone || 'Europe/London';
  const hasHours = !!venue.opening_hours?.weekly;
  const status = hasHours ? isOpenNow(venue.opening_hours, tz) : null;
  const canOnline = !!(venue.online_enabled && venue.online_slug);
  const canCatering = !!(venue.cateringEnabled && venue.online_slug);

  let closedLine = null;
  if (status && !status.open) {
    const next = nextOpensAt(venue.opening_hours, tz);
    if (next) {
      closedLine = `Opens ${new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', hour: 'numeric', minute: '2-digit', hour12: true }).format(next)}`;
    }
  }

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

      {(canOnline || canCatering) ? (
        <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          {canOnline && (
            <a href={customerUrl(venue.online_slug, '')} onClick={onPick}
              style={{
                flex: '1 1 140px', textAlign: 'center', padding: '11px 16px', borderRadius: 12,
                background: brandColor, color: onBrand, fontSize: 14, fontWeight: 700,
                textDecoration: 'none',
              }}>
              Order online
            </a>
          )}
          {canCatering && (
            <a href={customerUrl(venue.online_slug, '/catering')} onClick={onPick}
              style={{
                flex: '1 1 140px', textAlign: 'center', padding: '11px 16px', borderRadius: 12,
                background: 'transparent', color: FIXED.ink, fontSize: 14, fontWeight: 700,
                border: `1.5px solid ${FIXED.line}`, textDecoration: 'none',
              }}>
              Catering
            </a>
          )}
        </div>
      ) : (
        <div style={{ marginTop: 12, fontSize: 13, color: FIXED.muted, fontStyle: 'italic' }}>
          Online ordering isn't available at this venue yet.
        </div>
      )}
    </div>
  );
}
