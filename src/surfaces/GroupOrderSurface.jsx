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
// v5.5.807 — DESIGN-HANDOFF redesign ("location picker"). Below the branded
// MenuTheme header the page follows the handoff spec: Figtree type on cream
// neutrals, venue cards with live status pills (Open / Closing soon / Closed),
// hours trimmed to Today + Tomorrow (full week behind a disclosure), a sticky
// Leaflet + OpenStreetMap map with numbered teardrop pins synced to the cards,
// and a "Use my location" flow (never prompts on load; silent locate only when
// permission is already granted) that sorts venues nearest-first with distances.
// ONE deliberate deviation from the handoff: its brand red (#C7503B) maps to the
// group's own theme accent colour so the page stays on-brand per company; the
// cream neutrals stay exactly as designed. Catering keeps its own face inside
// the same layout: fulfilment badges + "Order catering" CTA, and NO open/closed
// emphasis (catering runs on its own hours/lead-time).
//
// Coordinates: platform `locations.latitude/longitude` (additive columns,
// 20260718_PLATFORM_location_coords.sql). Venues without coords degrade
// gracefully — no distance line, no pin; no coords anywhere → no map at all.
// Map stack: Leaflet + OSM raster tiles (attribution is a licence requirement).
// The codebase's Mapbox stack is geocoding-only (fetch helpers, no renderer —
// the delivery "live map" is Stuart's hosted iframe), so Leaflet is the first
// map renderer here: tiny, token-free, and exactly what the handoff prototyped.
//
// Resolution: groupSlug → platform `companies.slug` → that company's platform
// `locations` rows (company_id linkage). Branding comes from the first eligible
// venue's online_branding (same MenuTheme engine as the storefront). Live status
// (online picker only) from each venue's platform opening_hours + timezone via
// lib/openingHours. Catering eligibility + fulfilment (takeout / delivery) come
// from the anon-safe catering_public_settings RPC on the ops DB — it returns the
// settings row ONLY when the catering site is enabled.
//
// Read-only / marketing-safe: no writes anywhere. The chosen venue is remembered in
// localStorage (offline-cache-style convenience only; separate keys per picker so
// online + catering choices don't clash) for an "Order again" banner — never a
// forced redirect.

import { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { supabase, platformSupabase } from '../lib/supabase';
import { customerUrl } from '../lib/env';
import { isOpenNow, nextOpensAt } from '../lib/openingHours';
import { readTheme, deriveVars, readableOn } from './menu/menuTheme';
import MenuHeader from './menu/MenuHeader';

// ── Handoff design tokens (cream neutrals — fixed per the spec; the brand red is
//    the ONE token deliberately swapped for the group's theme accent) ───────────
const T = {
  bg: '#FAF8F3', card: '#FFFFFF', border: '#ECE6DA', borderStrong: '#E0D9CA',
  ink: '#26231E', muted: '#8B857A', faint: '#B3ACA0',
  green: '#1F9143', greenBg: '#E5F4E8', greenDot: '#27A853',
  amber: '#9A6B1F', amberBg: '#F7EEDD', amberDot: '#D89A3A',
  grayPill: '#F0EDE5', grayInk: '#6F695F', youDot: '#2E7CF6',
};
const FIGTREE = "'Figtree', system-ui, sans-serif";

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

// ── Time / hours helpers (venue-timezone aware — the handoff prototype used the
//    device clock; real venues carry their own tz on the platform row) ──────────
const WEEK_ORDER = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DAY_ABBR = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };

// Day key + minutes-since-midnight + ISO date for `date` in the venue's tz.
function tzInfo(tz, date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  return {
    dayKey: (p.weekday || '').toLowerCase().slice(0, 3),
    minutes: Number(p.hour) * 60 + Number(p.minute),
    isoDate: `${p.year}-${p.month}-${p.day}`,
  };
}

// "09:00" → "9am", "23:30" → "11:30pm" (handoff format: minutes only when nonzero).
function fmt12(hhmm) {
  const [h0, m] = String(hhmm || '').split(':').map(Number);
  if (!Number.isFinite(h0)) return '';
  const ap = h0 >= 12 ? 'pm' : 'am';
  const h = h0 % 12 || 12;
  return m ? `${h}:${String(m).padStart(2, '0')}${ap}` : `${h}${ap}`;
}
const fmtMins = (mins) => fmt12(`${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, '0')}`);

// Our weekly windows [{open,close}] → the handoff's "9am – 11pm · 5pm – 10pm" line;
// null = closed (rendered as italic "Closed").
function rangesLine(wins) {
  if (!Array.isArray(wins) || wins.length === 0) return null;
  return wins.map((w) => `${fmt12(w.open)} – ${fmt12(w.close)}`).join(' · ');
}

// Live status per the handoff: Open / Closing soon (≤60 min) / Closed, with the
// matching status line. Built on lib/openingHours so overnight windows and
// closedDates behave exactly like the rest of the product.
function venueStatus(hours, tz, now) {
  const st = isOpenNow(hours, tz, now);
  if (st.open) {
    const left = st.closesAtMinutes - tzInfo(tz, now).minutes;
    const closeLabel = fmt12(st.window?.close);
    if (left <= 60) return { k: 'soon', pill: 'Closing soon', line: `Open now · closes ${closeLabel}` };
    return { k: 'open', pill: 'Open', line: `Open until ${closeLabel}` };
  }
  const next = nextOpensAt(hours, tz, now);
  if (!next) return { k: 'closed', pill: 'Closed', line: 'Temporarily closed' };
  const today = tzInfo(tz, now);
  const tomorrow = tzInfo(tz, new Date(now.getTime() + 86400000));
  const nextP = tzInfo(tz, next);
  const when = nextP.isoDate === today.isoDate ? 'today'
    : nextP.isoDate === tomorrow.isoDate ? 'tomorrow'
    : new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'long' }).format(next);
  return { k: 'closed', pill: 'Closed', line: `Opens ${when} at ${fmtMins(nextP.minutes)}` };
}

// Today + Tomorrow rows (closedDates override the weekly pattern for that date).
function nextTwoDays(hours, tz, now) {
  return [0, 1].map((i) => {
    const p = tzInfo(tz, new Date(now.getTime() + i * 86400000));
    const closedDate = Array.isArray(hours?.closedDates) && hours.closedDates.includes(p.isoDate);
    return {
      label: i === 0 ? 'Today' : 'Tomorrow',
      abbr: DAY_ABBR[p.dayKey] || '',
      text: closedDate ? null : rangesLine(hours?.weekly?.[p.dayKey]),
    };
  });
}

// ── Geometry ──────────────────────────────────────────────────────────────────
const hasCoords = (v) => Number.isFinite(v?.latitude) && Number.isFinite(v?.longitude);
function distMiles(pos, v) {
  const R = 3958.8, rad = (x) => x * Math.PI / 180;
  const dLat = rad(v.latitude - pos.lat), dLng = rad(v.longitude - pos.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(pos.lat)) * Math.cos(rad(v.latitude)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Numbered teardrop pin (30px, one square corner, rotated) — handoff spec. `dx`
// fans out pins that share the exact same coordinates (two venues at one address)
// so both stay visible and clickable; the geographic point is untouched.
const pinIcon = (n, active, dx = 0) => L.divIcon({
  className: '',
  html: `<div class="gop-pin ${active ? 'active' : ''}"><span>${n}</span></div>`,
  iconSize: [30, 30], iconAnchor: [15 - dx, 28],
});
const youIcon = () => L.divIcon({ className: '', html: '<div class="gop-pin-you"></div>', iconSize: [16, 16], iconAnchor: [8, 8] });

const hexPair = (hex) => {
  const c = String(hex || '').replace('#', '');
  const n = c.length === 3 ? c.split('').map((x) => x + x).join('') : c;
  return /^[0-9a-fA-F]{6}$/.test(n) ? n : 'C7503B';
};
const tint = (hex, a) => {
  const n = hexPair(hex);
  return `rgba(${parseInt(n.slice(0, 2), 16)},${parseInt(n.slice(2, 4), 16)},${parseInt(n.slice(4, 6), 16)},${a})`;
};

// ─────────────────────────────────────────────────────────────────────────────
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
          .select('id, ops_location_id, name, address, timezone, currency, online_slug, online_enabled, opening_hours, online_branding, latitude, longitude')
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

  // Shell keeps the MenuTheme CSS vars (the branded header needs them) but the
  // page body below is the handoff's cream — deliberately NOT the storefront bg.
  const shell = {
    ...vars,
    position: 'fixed', inset: 0, overflowY: 'auto', overflowX: 'hidden',
    WebkitOverflowScrolling: 'touch', containerType: 'inline-size',
    background: T.bg, color: T.ink, fontFamily: FIGTREE,
  };

  if (state.loading || redirecting) {
    return (
      <div style={shell}>
        <div style={{ textAlign: 'center', padding: '90px 20px', color: T.muted, fontSize: 14 }}>
          {redirecting ? <>Taking you to <b style={{ color: T.ink }}>{redirecting}</b>…</> : 'Loading…'}
        </div>
      </div>
    );
  }

  if (state.error || !state.company) {
    return (
      <div style={shell}>
        <div style={{ maxWidth: 480, margin: '60px auto 0', padding: '40px 24px', textAlign: 'center', background: T.card, border: `1px solid ${T.border}`, borderRadius: 20 }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>🔍</div>
          <div style={{ fontSize: 20, fontWeight: 800, letterSpacing: '-.02em', marginBottom: 8 }}>Ordering page not found</div>
          <div style={{ fontSize: 14, color: T.muted, lineHeight: 1.6 }}>
            We couldn't find an ordering page for <b>{groupSlug}</b>. Check the link with the restaurant.
          </div>
        </div>
      </div>
    );
  }

  const remembered = lastVenue && actionable.find(v => v.id === lastVenue.locationId);

  return (
    <div style={shell} data-gop-shell="">
      <MenuHeader theme={mt} name={state.company.name}
        pills={[{
          label: isCatering
            ? (displayVenues.length > 1 ? `Catering · ${displayVenues.length} venues` : 'Catering')
            : (displayVenues.length === 1 ? 'Order online' : `${displayVenues.length} locations · pick yours`),
        }]} />
      <PickerBody
        isCatering={isCatering}
        venues={displayVenues}
        companyName={state.company.name}
        brand={mt.brandColor}
        brandDark={vars['--brand-deep']}
        onBrand={onBrand}
        targetUrlFor={targetUrlFor}
        onPick={(v) => saveLastVenue(variant, groupSlug, v)}
        remembered={remembered}
        onForget={() => { clearLastVenue(variant, groupSlug); setLastVenue(null); }}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The redesigned picker under the branded header — handoff layout: header row +
// locate button, card list + sticky map grid, footer. Own component so the map /
// geolocation hooks only mount once venues are actually on screen.
function PickerBody({ isCatering, venues, companyName, brand, brandDark, onBrand, targetUrlFor, onPick, remembered, onForget }) {
  const [now, setNow] = useState(() => new Date());
  const [userPos, setUserPos] = useState(null);
  const [locState, setLocState] = useState('idle');   // idle | busy | done | error
  const [selected, setSelected] = useState(null);
  const [hovered, setHovered] = useState(null);

  const shellFindRef = useRef(null);                  // wrapper div → closest scroll parent
  const mapDivRef = useRef(null);
  const mapRef = useRef(null);
  const markersRef = useRef({});
  const anchorsRef = useRef({});
  const youRef = useRef(null);
  const cardRefs = useRef({});
  const selectRef = useRef(() => {});

  const mappable = useMemo(() => venues.filter(hasCoords), [venues]);

  // Distance sort (nearest first) once located; venues without coords keep their
  // alphabetical order at the end. No location → original order, no distances.
  const ordered = useMemo(() => {
    if (!userPos) return venues;
    return [...venues].sort((a, b) =>
      (hasCoords(a) ? distMiles(userPos, a) : Infinity) - (hasCoords(b) ? distMiles(userPos, b) : Infinity));
  }, [venues, userPos]);

  // Live status pills recompute every 60s (handoff requirement).
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60000);
    return () => clearInterval(t);
  }, []);

  const doSelect = (id, { pan, scroll } = {}) => {
    setSelected(id);
    const v = venues.find((x) => x.id === id);
    if (pan && mapRef.current && hasCoords(v)) mapRef.current.panTo([v.latitude, v.longitude]);
    if (scroll) {
      // Scroll the surface's own scroll container (the fixed shell), not window —
      // scrollIntoView would fight the sticky map (handoff calls this out too).
      const card = cardRefs.current[id];
      const scroller = shellFindRef.current?.closest('[data-gop-shell]');
      if (card && scroller) {
        const top = card.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 20;
        scroller.scrollTo({ top, behavior: 'smooth' });
      }
    }
  };
  selectRef.current = doSelect;

  // ── Map: init once (venues are stable once loaded) ──────────────────────────
  useEffect(() => {
    const el = mapDivRef.current;
    if (!el || mappable.length === 0 || mapRef.current) return undefined;
    const map = L.map(el, { scrollWheelZoom: false, zoomControl: true });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors', maxZoom: 19,
    }).addTo(map);

    // Venues sharing the exact same point (e.g. two demo venues at one address)
    // fan out horizontally ±17px per pin so every number stays visible.
    const groups = {};
    mappable.forEach((v) => {
      const k = `${v.latitude.toFixed(5)},${v.longitude.toFixed(5)}`;
      (groups[k] = groups[k] || []).push(v.id);
    });
    const anchors = {};
    Object.values(groups).forEach((ids) => ids.forEach((id, i) => {
      anchors[id] = ids.length > 1 ? Math.round((i - (ids.length - 1) / 2) * 34) : 0;
    }));
    anchorsRef.current = anchors;

    mappable.forEach((v) => {
      const n = venues.indexOf(v) + 1;
      markersRef.current[v.id] = L.marker([v.latitude, v.longitude], { icon: pinIcon(n, false, anchors[v.id]) })
        .addTo(map)
        .on('click', () => selectRef.current(v.id, { scroll: true }));
    });
    map.fitBounds(L.latLngBounds(mappable.map((v) => [v.latitude, v.longitude])).pad(0.25), { maxZoom: 15 });
    mapRef.current = map;
    const t = setTimeout(() => map.invalidateSize(), 0);
    return () => { clearTimeout(t); map.remove(); mapRef.current = null; markersRef.current = {}; youRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mappable.length]);

  // Pin numbers follow the card order (they re-assign after the distance sort);
  // hovering a card or selecting darkens its pin.
  useEffect(() => {
    if (!mapRef.current) return;
    ordered.forEach((v, i) => {
      const m = markersRef.current[v.id];
      if (!m) return;
      const active = selected === v.id || hovered === v.id;
      m.setIcon(pinIcon(i + 1, active, anchorsRef.current[v.id] || 0));
      m.setZIndexOffset(selected === v.id ? 1000 : hovered === v.id ? 500 : 0);
    });
  }, [ordered, selected, hovered]);

  // You-are-here dot + refit around user + venues once located.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !userPos) return;
    if (youRef.current) youRef.current.remove();
    youRef.current = L.marker([userPos.lat, userPos.lng], { icon: youIcon(), interactive: false }).addTo(map);
    map.fitBounds(
      L.latLngBounds([[userPos.lat, userPos.lng], ...mappable.map((v) => [v.latitude, v.longitude])]).pad(0.2),
      { maxZoom: 15 },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userPos]);

  // ── Locate flow. NEVER prompts on load — silent locate only if the browser
  //    says permission is already granted; otherwise it waits for the button.
  //    On failure: neutral fallback (unsorted, distances hidden) — no fake point.
  const locate = () => {
    if (!navigator.geolocation) { setLocState('error'); return; }
    setLocState('busy');
    navigator.geolocation.getCurrentPosition(
      (p) => { setUserPos({ lat: p.coords.latitude, lng: p.coords.longitude }); setLocState('done'); },
      () => setLocState('error'),
      { timeout: 7000, maximumAge: 60000 },
    );
  };
  const autoTried = useRef(false);
  useEffect(() => {
    if (autoTried.current || mappable.length === 0) return;
    autoTried.current = true;
    try {
      navigator.permissions?.query({ name: 'geolocation' })
        .then((r) => { if (r.state === 'granted') locate(); })
        .catch(() => {});
    } catch { /* permissions API unavailable — wait for the button */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mappable.length]);

  // Located → auto-select the nearest venue (first with coords after the sort).
  useEffect(() => {
    if (!userPos) return;
    const nearest = ordered.find(hasCoords);
    if (nearest) setSelected(nearest.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userPos]);

  const located = !!userPos;
  const cta = isCatering ? 'Order catering' : 'Order online';
  const subline = located
    ? 'Sorted by distance — closest to you first'
    : (isCatering ? 'Find your nearest location to order catering' : 'Find your nearest location to start an order');

  return (
    <div ref={shellFindRef} className="gop-wrap">
      <style>{buildCss(brand, brandDark, onBrand)}</style>

      <div className="gop-head">
        <div>
          <h1>Choose a venue</h1>
          <p className="gop-sub">
            {located && <span className="gop-live-dot" />}
            {subline}
          </p>
        </div>
        {mappable.length > 0 && (
          <button type="button" className={`gop-locate${locState === 'busy' ? ' busy' : ''}`} onClick={locate}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3.2" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" /></svg>
            {locState === 'busy' ? 'Finding you…' : located ? 'Update my location' : 'Use my location'}
          </button>
        )}
      </div>

      {locState === 'error' && (
        <p className="gop-note">
          {located
            ? "Couldn't refresh your location — distances are from your last position."
            : "Couldn't access your device location — venues are shown without distances."}
        </p>
      )}

      {/* Return visit — remembered venue banner (no forced redirect) */}
      {remembered && (
        <div className="gop-remember">
          <div className="gop-remember-txt">
            {isCatering
              ? <>Order catering from <b>{remembered.name}</b> again?</>
              : <>Order again from <b>{remembered.name}</b>?</>}
          </div>
          <div className="gop-remember-btns">
            <a className="gop-remember-go" href={targetUrlFor(remembered)} onClick={() => onPick(remembered)}>{cta}</a>
            <button type="button" className="gop-remember-clear" onClick={onForget}>Change venue</button>
          </div>
        </div>
      )}

      {venues.length === 0 && (
        <div className="gop-empty">
          {isCatering
            ? <>Catering isn't available to order online yet — please contact {companyName} directly.</>
            : <>No venues are set up for online ordering yet — please check back soon.</>}
        </div>
      )}

      <div className={`gop-grid${mappable.length === 0 ? ' nomap' : ''}`}>
        <div className="gop-cards">
          {ordered.map((v, i) => (
            <VenueCard key={v.id} venue={v} isCatering={isCatering} cta={cta} now={now}
              targetUrl={targetUrlFor(v)}
              selected={selected === v.id}
              nearest={located && i === 0 && hasCoords(v)}
              distance={located && hasCoords(v) ? distMiles(userPos, v) : null}
              refCb={(el) => { cardRefs.current[v.id] = el; }}
              onHover={(on) => setHovered(on ? v.id : null)}
              onSelect={() => doSelect(v.id, { pan: true })}
              onPick={() => onPick(v)} />
          ))}
        </div>
        {mappable.length > 0 && (
          <div className="gop-map-panel"><div ref={mapDivRef} className="gop-map" /></div>
        )}
      </div>

      <footer className="gop-footer">Powered by Serv OS</footer>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
function VenueCard({ venue, isCatering, cta, now, targetUrl, selected, nearest, distance, refCb, onHover, onSelect, onPick }) {
  const tz = venue.timezone || 'Europe/London';
  // OPEN/CLOSED is the venue's live door status — meaningful for ordering food now,
  // NOT for catering (pre-orders run on catering's own hours/lead-time), so the
  // catering picker shows fulfilment badges instead of any open/closed emphasis.
  const hasHours = !isCatering && !!venue.opening_hours?.weekly;
  const status = hasHours ? venueStatus(venue.opening_hours, tz, now) : null;
  const canOrder = isCatering ? true : !!(venue.online_enabled && venue.online_slug);
  const days = hasHours ? nextTwoDays(venue.opening_hours, tz, now) : [];
  const todayKey = hasHours ? tzInfo(tz, now).dayKey : null;

  return (
    <article ref={refCb}
      className={`gop-card${selected ? ' selected' : ''}`}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      onClick={(e) => { if (e.target.closest('a, button, summary')) return; onSelect(); }}>
      <div className="gop-card-top">
        <div>
          <h2>
            {venue.name}
            {nearest && <span className="gop-nearest">Nearest to you</span>}
          </h2>
          <div className="gop-addr-row">
            {venue.address && <span className="gop-addr">{venue.address}</span>}
            {distance != null && <span className="gop-dist">{distance.toFixed(1)} mi away</span>}
          </div>
        </div>
        {status && (
          <span className={`gop-pill ${status.k}`}><span className="gop-dot" />{status.pill}</span>
        )}
      </div>

      {status && (
        <p className={`gop-status-line ${status.k === 'closed' ? 'closed-now' : 'open-now'}`}>{status.line}</p>
      )}

      {/* Hours — Today + Tomorrow only; the full week sits behind the disclosure */}
      {hasHours && (
        <>
          <div className="gop-hours">
            {days.map((d) => (
              <div className="gop-hrow" key={d.label}>
                <span className="gop-day">{d.label}<small>{d.abbr}</small></span>
                <span className={`gop-times${d.text ? '' : ' shut'}`}>{d.text || 'Closed'}</span>
              </div>
            ))}
          </div>
          <details className="gop-allhours">
            <summary>
              All opening times
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
            </summary>
            <div className="gop-week">
              {WEEK_ORDER.map((d) => {
                const line = rangesLine(venue.opening_hours?.weekly?.[d]);
                return (
                  <div className={`gop-hrow${d === todayKey ? ' today' : ''}`} key={d}>
                    <span className="gop-day">{DAY_ABBR[d]}</span>
                    <span className={`gop-times${line ? '' : ' shut'}`}>{line || 'Closed'}</span>
                  </div>
                );
              })}
            </div>
          </details>
        </>
      )}

      {/* Catering fulfilment badges — what this venue offers for catering */}
      {isCatering && venue.catering && (venue.catering.delivery || venue.catering.collection) && (
        <div className="gop-badges">
          {venue.catering.delivery && <span className="gop-badge"><span aria-hidden="true">🚚</span>Delivery</span>}
          {venue.catering.collection && <span className="gop-badge"><span aria-hidden="true">🥡</span>{venue.catering.collectionLabel}</span>}
        </div>
      )}

      {canOrder ? (
        <a className="gop-cta" href={targetUrl} onClick={onPick}>{cta}</a>
      ) : (
        <div className="gop-unavailable">Online ordering isn't available at this venue yet.</div>
      )}
    </article>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Handoff CSS, verbatim tokens — with the brand red mapped to the group's theme
// accent (the one deliberate deviation). Class-prefixed `gop-` so nothing leaks.
function buildCss(brand, brandDark, onBrand) {
  return `
.gop-wrap{max-width:1080px;margin:0 auto;padding:40px 24px 32px;font-family:${FIGTREE};color:${T.ink};-webkit-font-smoothing:antialiased;}
.gop-head{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:20px;}
.gop-head h1{font-size:28px;font-weight:800;letter-spacing:-0.02em;margin:0 0 4px;}
.gop-sub{color:${T.muted};font-size:15px;font-weight:500;margin:0;display:flex;align-items:center;gap:8px;}
.gop-live-dot{width:7px;height:7px;border-radius:50%;background:${T.greenDot};flex:none;}
.gop-locate{display:inline-flex;align-items:center;gap:9px;border:1.5px solid ${T.borderStrong};background:${T.card};color:${T.ink};font:600 14.5px ${FIGTREE};padding:11px 18px;border-radius:999px;cursor:pointer;transition:border-color .15s,box-shadow .15s,background .15s;white-space:nowrap;}
.gop-locate:hover{border-color:${brand};box-shadow:0 2px 10px ${tint(brand, 0.12)};}
.gop-locate svg{flex:none;}
.gop-locate.busy{color:${T.muted};pointer-events:none;}
.gop-note{font-size:13px;color:${T.muted};margin:-10px 2px 14px;}
.gop-remember{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:13px 16px;margin:0 0 16px;background:${T.card};border:1px solid ${T.border};border-radius:16px;}
.gop-remember-txt{flex:1 1 180px;font-size:14.5px;min-width:0;}
.gop-remember-btns{display:flex;gap:8px;flex:none;}
.gop-remember-go{padding:9px 16px;border-radius:999px;background:${brand};color:${onBrand};font-size:13.5px;font-weight:700;text-decoration:none;white-space:nowrap;transition:background .15s;}
.gop-remember-go:hover{background:${brandDark};color:${onBrand};}
.gop-remember-clear{padding:9px 14px;border-radius:999px;background:transparent;color:${T.muted};border:1px solid ${T.borderStrong};font:600 13.5px ${FIGTREE};cursor:pointer;white-space:nowrap;transition:border-color .15s,color .15s;}
.gop-remember-clear:hover{border-color:${T.faint};color:${T.ink};}
.gop-empty{padding:28px 20px;text-align:center;background:${T.card};border:1px solid ${T.border};border-radius:20px;color:${T.muted};font-size:14.5px;}
.gop-grid{display:grid;grid-template-columns:minmax(0,1fr) 400px;gap:20px;align-items:start;}
.gop-grid.nomap{grid-template-columns:minmax(0,1fr);}
.gop-cards{display:flex;flex-direction:column;gap:14px;min-width:0;}
.gop-map-panel{position:sticky;top:20px;border:1px solid ${T.border};border-radius:20px;overflow:hidden;background:${T.card};}
.gop-map{height:min(560px,calc(100vh - 120px));min-height:340px;width:100%;}
.gop-map-panel .leaflet-tile-pane{filter:saturate(.72) contrast(.96);}
.gop-map-panel .leaflet-container{font-family:${FIGTREE};}
.gop-pin{display:flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:50% 50% 50% 4px;transform:rotate(-45deg);background:${brand};border:2.5px solid #fff;box-shadow:0 3px 8px rgba(38,35,30,.3);cursor:pointer;transition:background .15s;}
.gop-pin span{transform:rotate(45deg);color:${onBrand};font:700 13px ${FIGTREE};}
.gop-pin.active{background:${T.ink};}
.gop-pin.active span{color:#fff;}
.gop-pin-you{width:16px;height:16px;border-radius:50%;background:${T.youDot};border:3px solid #fff;box-shadow:0 0 0 5px rgba(46,124,246,.22),0 2px 6px rgba(0,0,0,.25);}
.gop-card{background:${T.card};border:1px solid ${T.border};border-radius:20px;padding:22px 22px 20px;transition:border-color .15s,box-shadow .15s;position:relative;cursor:pointer;}
.gop-card:hover{border-color:${T.borderStrong};}
.gop-card.selected{border-color:${brand};box-shadow:0 4px 18px ${tint(brand, 0.10)};}
.gop-card-top{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;}
.gop-card h2{font-size:21px;font-weight:800;letter-spacing:-0.015em;margin:0;display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
.gop-nearest{font:700 11px ${FIGTREE};letter-spacing:.06em;text-transform:uppercase;color:${brand};background:${tint(brand, 0.08)};padding:4px 9px;border-radius:999px;}
.gop-addr-row{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;margin-top:5px;}
.gop-addr{color:${T.muted};font-size:15px;}
.gop-dist{color:${T.ink};font-size:13.5px;font-weight:700;}
.gop-addr + .gop-dist::before{content:'·';color:${T.faint};font-weight:400;margin-right:8px;}
.gop-pill{display:inline-flex;align-items:center;gap:7px;font-size:13.5px;font-weight:700;padding:7px 13px;border-radius:999px;white-space:nowrap;flex:none;transition:background .15s,color .15s;}
.gop-pill .gop-dot{width:7px;height:7px;border-radius:50%;}
.gop-pill.open{background:${T.greenBg};color:${T.green};}
.gop-pill.open .gop-dot{background:${T.greenDot};}
.gop-pill.soon{background:${T.amberBg};color:${T.amber};}
.gop-pill.soon .gop-dot{background:${T.amberDot};}
.gop-pill.closed{background:${T.grayPill};color:${T.grayInk};}
.gop-pill.closed .gop-dot{background:${T.faint};}
.gop-status-line{font-size:14px;font-weight:600;margin:12px 0 0;}
.gop-status-line.open-now{color:${T.green};}
.gop-status-line.closed-now{color:${T.grayInk};}
.gop-hours{margin-top:12px;border-top:1px dashed ${T.border};padding-top:12px;display:grid;gap:7px;}
.gop-hrow{display:grid;grid-template-columns:110px 1fr;gap:12px;font-size:14.5px;align-items:baseline;}
.gop-hrow .gop-day{color:${T.ink};font-weight:700;}
.gop-hrow .gop-day small{color:${T.muted};font-weight:500;margin-left:6px;font-size:smaller;}
.gop-hrow .gop-times{color:${T.muted};font-variant-numeric:tabular-nums;}
.gop-hrow .gop-times.shut{color:${T.faint};font-style:italic;}
details.gop-allhours{margin-top:10px;}
details.gop-allhours summary{list-style:none;cursor:pointer;font-size:13.5px;font-weight:700;color:${T.muted};display:inline-flex;align-items:center;gap:6px;user-select:none;transition:color .15s;}
details.gop-allhours summary::-webkit-details-marker{display:none;}
details.gop-allhours summary:hover{color:${T.ink};}
details.gop-allhours summary svg{transition:transform .15s;}
details.gop-allhours[open] summary svg{transform:rotate(180deg);}
.gop-week{margin-top:10px;display:grid;gap:6px;}
.gop-week .gop-hrow{font-size:13.5px;}
.gop-week .gop-hrow.today .gop-day,.gop-week .gop-hrow.today .gop-times{color:${T.ink};font-weight:700;}
.gop-badges{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;}
.gop-badge{display:inline-flex;align-items:center;gap:6px;padding:5px 11px;border-radius:999px;font-size:12.5px;font-weight:700;background:${tint(brand, 0.08)};color:${T.ink};border:1px solid ${tint(brand, 0.25)};}
.gop-cta{display:block;width:100%;margin-top:16px;background:${brand};color:${onBrand};text-align:center;font:700 16px ${FIGTREE};padding:15px 20px;border-radius:14px;border:none;cursor:pointer;transition:background .15s;text-decoration:none;box-sizing:border-box;}
.gop-cta:hover{background:${brandDark};color:${onBrand};}
.gop-unavailable{margin-top:14px;font-size:13.5px;color:${T.muted};font-style:italic;}
.gop-footer{margin-top:36px;text-align:center;color:${T.faint};font-size:13.5px;}
@media (max-width:900px){
  .gop-grid{grid-template-columns:1fr;}
  .gop-map-panel{position:static;order:-1;}
  .gop-map{height:240px;min-height:240px;}
  .gop-head h1{font-size:24px;}
}
`;
}
