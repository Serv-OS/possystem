// v5.5.103 — Customer-facing boot loader.
// Mounts when the URL parser identifies the visitor as a customer (subdomain
// match or ?loc=... fallback). Steps:
//   1. Resolve slug → platform location row
//   2. Check the requested surface (online / qr) is enabled
//   3. Check opening hours; show "we're closed" banner if shut
//   4. Route to OnlineSurface (Phase 3a — coming) or QRSurface (Phase 3b — coming)
//
// For now the surface stubs render a confirmation page so we can test the
// full subdomain → location → enabled → hours pipeline before Phase 3
// builds the actual menu / cart UIs.

import { useEffect, useState } from 'react';
import { platformSupabase } from '../lib/supabase';
import { setActiveCurrency } from '../lib/currency';
import { lookupLocationBySlug } from '../lib/customerUrl';
import { CUSTOMER_ROOT } from '../lib/env';
import { isOpenNow, nextOpensAt, formatHoursPreview } from '../lib/openingHours';
import { readTheme, deriveVars, readableOn, DISPLAY_FONT, BODY_FONT } from './menu/menuTheme';
import MenuHeader from './menu/MenuHeader';
import OnlineSurface from './online/OnlineSurface';
import { buildGiftTheme } from './gift/giftHelpers';
import GiftPurchaseSurface from './gift/GiftPurchaseSurface';
import GiftBalanceSurface from './gift/GiftBalanceSurface';
import GiftSuccessSurface from './gift/GiftSuccessSurface';
import CustomerPortal from './customer/CustomerPortal';
import ReviewSurface from './ReviewSurface';
import WifiSurface from './WifiSurface';
import CateringSurface from './catering/CateringSurface';
import WaitlistJoinSurface from './waitlist/WaitlistJoinSurface';
import BookingWidget from './online/BookingWidget';

export default function CustomerBoot({ slug, mode, tableId }) {
  const [state, setState] = useState({ loading: true, location: null, error: null });
  // v5.5.802: the customer tapped through the closed screen — browse the menu
  // (and order ahead for reopening) while the venue is shut.
  const [browseClosed, setBrowseClosed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const loc = await lookupLocationBySlug(slug, platformSupabase);
        if (cancelled) return;
        if (!loc) { setState({ loading: false, location: null, error: 'not_found' }); return; }
        // v5.5.326: resolve this venue's currency so online/QR/gift/portal money
        // displays + Stripe charges use the right symbol/code (not the GBP default).
        setActiveCurrency(loc.currency || 'GBP');
        setState({ loading: false, location: loc, error: null });
      } catch (e) {
        if (!cancelled) setState({ loading: false, location: null, error: e?.message || 'load_failed' });
      }
    })();
    return () => { cancelled = true; };
  }, [slug]);

  if (state.loading) return <CustomerShell><Spinner label="Loading…"/></CustomerShell>;

  if (state.error === 'not_found' || !state.location) {
    return <CustomerShell>
      <ErrorState
        icon="🔍"
        title="Shop not found"
        body={<>We couldn't find a shop at <code style={{ fontFamily:'var(--font-mono)' }}>{slug}.{CUSTOMER_ROOT}</code>. Check the link with the venue.</>}
      />
    </CustomerShell>;
  }
  if (state.error) {
    return <CustomerShell><ErrorState icon="⚠️" title="Couldn't load" body={state.error}/></CustomerShell>;
  }

  const loc = state.location;

  // v5.5.196: Gift card surfaces skip opening-hours and enabled-surface
  // gates — gift cards are purchasable 24/7 as long as the location exists.
  if (mode === 'gift')         return <GiftPurchaseSurface location={loc}/>;
  if (mode === 'gift_balance') return <GiftBalanceSurface location={loc}/>;
  if (mode === 'gift_success') return <GiftSuccessSurface location={loc}/>;

  // v5.5.221: Customer loyalty portal — always available (like gift cards).
  if (mode === 'account')      return <CustomerPortal location={loc}/>;

  // Review Manager card — always available (feedback isn't gated by hours or
  // whether online ordering is on). Server enforces the rating→routing split.
  if (mode === 'review')       return <ReviewSurface location={loc}/>;

  // WiFi captive-portal — always available (guests connect any time the venue
  // exists; not gated by opening hours or online-ordering being on).
  if (mode === 'wifi')         return <WifiSurface location={loc}/>;

  // Catering ordering — has its OWN hours/lead-time (set in BO), so it bypasses the
  // venue's live opening-hours gate below. The surface self-checks the catering site is enabled.
  if (mode === 'catering')     return <CateringSurface location={loc}/>;

  // F2: Tables Ready guest self-service — always available (not gated by online-ordering
  // or opening hours). The surface self-checks waitlist_public_config (null = not open).
  // "waitlist" = QR join form; "waitlist_status" = live status page (token-driven).
  if (mode === 'waitlist')         return <WaitlistJoinSurface location={loc} view="join"/>;
  if (mode === 'waitlist_status')  return <WaitlistJoinSurface location={loc} view="status"/>;

  // Phase 5: table-booking widget — always available (guests book FUTURE dates
  // at any hour, so the live opening-hours gate doesn't apply). The booking-widget
  // edge fn self-checks widget_enabled + the service window, and the surface shows
  // its own polite "call the venue" screen when the widget is off/unconfigured.
  if (mode === 'book')             return <BookingWidget location={loc}/>;

  // Surface enabled check
  if (mode === 'online' && !loc.online_enabled) {
    return <CustomerShell><ErrorState icon="🚫" title="Online ordering not enabled" body={<>Visit {loc.name} in person, or contact them directly.</>}/></CustomerShell>;
  }
  if (mode === 'qr' && !loc.qr_enabled) {
    return <CustomerShell><ErrorState icon="🚫" title="Table-side ordering not available" body={<>Please order with a server.</>}/></CustomerShell>;
  }

  // Opening hours gate
  const tz = loc.timezone || 'Europe/London';
  const status = isOpenNow(loc.opening_hours, tz);
  if (!status.open) {
    const next = nextOpensAt(loc.opening_hours, tz);
    if (mode === 'online') {
      // v5.5.802: closed ≠ locked out. The customer can always browse the full
      // menu, and — when the venue reopens within the checkout's 7-day slot
      // window — order ahead (checkout forces a scheduled slot, never ASAP).
      // v5.8.20: honour the venue's "days ahead" setting. 0 = today only, so a
      // venue that is closed now but reopens LATER TODAY still takes an order
      // for later today, while one that reopens tomorrow does not. Blank = 7.
      const maxDays = (loc.online_advance_days === null || loc.online_advance_days === undefined)
        ? 7 : Math.max(0, Number(loc.online_advance_days) || 0);
      const ymd = (d) => d.toLocaleDateString('en-CA', { timeZone: tz });
      const dayDiff = next ? Math.round((Date.parse(ymd(next)) - Date.parse(ymd(new Date()))) / 86400000) : Infinity;
      const canOrderAhead = !!(next && dayDiff <= maxDays);
      const closedInfo = { reopenAt: next, canOrderAhead };
      if (browseClosed) return <OnlineSurface location={loc} closedInfo={closedInfo}/>;
      return <ClosedScreen location={loc} nextOpens={next} canOrderAhead={canOrderAhead}
        onEnter={() => setBrowseClosed(true)}/>;
    }
    return <CustomerShell location={loc}>
      <ClosedBanner location={loc} nextOpensAt={next}/>
    </CustomerShell>;
  }

  // v5.5.145: Online and QR table-side both run through OnlineSurface,
  // which switches behaviour internally on the mode prop. QR mode auto-
  // sets dine-in, hides the order-type picker / scheduled-time picker,
  // shows a "Table T5" chip in the header, and routes checkout through
  // QrCheckout (no address, no time, adds tip + service charge, will
  // gain open-tab pre-auth in commit 2).
  if (mode === 'online') return <OnlineSurface location={loc}/>;
  if (mode === 'qr')     return <OnlineSurface location={loc} mode="qr" tableId={tableId} tableLabel={tableId}/>;
  return <CustomerShell location={loc}><QrStub location={loc} tableId={tableId}/></CustomerShell>;
}

// ─────────────────────────────────────────────────────────────────────────────
function CustomerShell({ children, location }) {
  // v5.5.897: shells carry the venue's Appearance theme the moment the location row is
  // loaded — the hardcoded dark shell only remains for a FAILED slug (no venue to theme by).
  const t = location ? buildGiftTheme(location) : null;
  return (
    <div style={{
      minHeight:'100vh', background: t?.bg || '#0e0e10', color: t?.text || '#fff',
      fontFamily:'system-ui, -apple-system, sans-serif',
      display:'flex', flexDirection:'column', alignItems:'center', padding:'40px 20px',
    }}>
      {location && (
        <div style={{ marginBottom:24, textAlign:'center' }}>
          {t?.logo && <img src={t.logo} alt="" style={{ height:52, maxWidth:180, objectFit:'contain', marginBottom:10 }}/>}
          <div style={{ fontSize:24, fontWeight:800 }}>{t?.companyName || location.name}</div>
          {(t?.showPoweredBy !== false) && (
            <div style={{ fontSize:12, opacity:.55, marginTop:4 }}>
              Powered by Serv OS
            </div>
          )}
        </div>
      )}
      <div style={{ width:'100%', maxWidth:480 }}>
        {children}
      </div>
    </div>
  );
}

function Spinner({ label }) {
  return (
    <div style={{ textAlign:'center', padding:'80px 0', color:'#777', fontSize:13 }}>
      <div style={{ fontSize:30, marginBottom:12 }}>⏳</div>
      {label}
    </div>
  );
}

function ErrorState({ icon, title, body }) {
  return (
    <div style={{ textAlign:'center', padding:'40px 24px', background:'rgba(127,127,127,0.10)', border:'1px solid rgba(127,127,127,0.25)', borderRadius:14 }}>
      <div style={{ fontSize:42, marginBottom:14 }}>{icon}</div>
      <div style={{ fontSize:18, fontWeight:800, marginBottom:8 }}>{title}</div>
      <div style={{ fontSize:13, opacity:.7, lineHeight:1.6 }}>{body}</div>
    </div>
  );
}

function ClosedBanner({ location, nextOpensAt }) {
  const tz = location.timezone || 'Europe/London';
  const fmt = nextOpensAt
    ? new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday:'long', hour:'numeric', minute:'2-digit', hour12:true }).format(nextOpensAt)
    : null;
  return (
    <div style={{ textAlign:'center', padding:'40px 24px', background:'rgba(127,127,127,0.10)', border:'1px solid rgba(127,127,127,0.25)', borderRadius:14 }}>
      <div style={{ fontSize:42, marginBottom:14 }}>🌙</div>
      <div style={{ fontSize:18, fontWeight:800, marginBottom:8 }}>We're closed</div>
      <div style={{ fontSize:13, opacity:.7, marginBottom:16 }}>
        {fmt ? <>Opens <b>{fmt}</b></> : 'Hours not set yet — please come back later.'}
      </div>
      <div style={{ fontSize:11, opacity:.55, marginTop:18 }}>
        {formatHoursPreview(location.opening_hours)}
      </div>
    </div>
  );
}

// v5.5.802: themed closed screen for online ordering — same MenuTheme engine as
// the storefront (brand palette + cinematic/framed/compact header + logo plate),
// with a graceful default when the venue has no Menu-appearance branding set.
// The button is never dead: it always opens the menu — labelled "Order ahead for
// later" when scheduled checkout is possible, "Browse the menu" otherwise.
function ClosedScreen({ location, nextOpens, canOrderAhead, onEnter }) {
  const tz = location.timezone || 'Europe/London';
  const mt = readTheme(location.online_branding);
  const vars = deriveVars(mt.brandColor, mt.bodyBg);
  const onBrand = readableOn(mt.brandColor);
  const fmt = nextOpens
    ? new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday:'long', hour:'numeric', minute:'2-digit', hour12:true }).format(nextOpens)
    : null;
  return (
    <div style={{
      ...vars, position:'fixed', inset:0, overflowY:'auto', overflowX:'hidden',
      WebkitOverflowScrolling:'touch', containerType:'inline-size',
      background:'var(--bg)', color:'var(--ink)', fontFamily: BODY_FONT,
    }}>
      <MenuHeader theme={mt} name={location.name} pills={[{ label: fmt ? `Closed · opens ${fmt}` : 'Closed' }]}/>
      <div style={{ maxWidth:560, margin:'0 auto', padding:'18px 16px 56px' }}>
        <div style={{
          background:'var(--card)', border:'1px solid var(--line)', borderRadius:16,
          padding:'30px 22px', textAlign:'center', boxShadow:'0 1px 2px rgba(36,31,28,.04)',
        }}>
          <div style={{ fontSize:38, marginBottom:10 }}>🌙</div>
          <div style={{ fontFamily: DISPLAY_FONT, fontSize:21, fontWeight:700, letterSpacing:'-.01em', marginBottom:6 }}>
            We're closed right now
          </div>
          <div style={{ fontSize:14, color:'var(--muted)', lineHeight:1.6, marginBottom:18 }}>
            {fmt ? <>We open again <b style={{ color:'var(--ink)' }}>{fmt}</b>. </> : <>Opening hours haven't been set yet. </>}
            {canOrderAhead
              ? 'Order ahead now and it’ll be ready when we reopen — or just browse the menu.'
              : 'You can still browse the full menu.'}
          </div>
          <button onClick={onEnter} className="op-btn-primary" style={{
            width:'100%', maxWidth:340, padding:'14px 22px', borderRadius:99,
            background:'var(--brand)', color:onBrand, border:'none',
            fontSize:15, fontWeight:700, cursor:'pointer', fontFamily:'inherit',
          }}>
            {canOrderAhead ? 'Order ahead for later' : 'Browse the menu'}
          </button>
          {canOrderAhead && (
            <div style={{ marginTop:10 }}>
              <button onClick={onEnter} style={{
                background:'none', border:'none', color:'var(--muted)', fontSize:13, fontWeight:600,
                cursor:'pointer', textDecoration:'underline', fontFamily:'inherit',
              }}>
                Just browse the menu
              </button>
            </div>
          )}
          <div style={{ fontSize:12, color:'var(--muted)', marginTop:18, lineHeight:1.6 }}>
            {formatHoursPreview(location.opening_hours)}
          </div>
        </div>
        <div style={{ textAlign:'center', marginTop:26, fontSize:11, color:'var(--muted)' }}>
          Powered by Serv OS
        </div>
      </div>
    </div>
  );
}

// ── Phase 3 stubs ───────────────────────────────────────────────────────────
function OnlineStub({ location }) {
  return (
    <div style={{ padding:'30px 24px', background:'rgba(127,127,127,0.10)', border:'1px solid rgba(127,127,127,0.25)', borderRadius:14 }}>
      <div style={{ fontSize:11, color:'#e8a020', fontWeight:800, letterSpacing:'.08em', textTransform:'uppercase', marginBottom:8 }}>
        Online Ordering
      </div>
      <div style={{ fontSize:18, fontWeight:800, marginBottom:6 }}>Open for collection &amp; delivery</div>
      <div style={{ fontSize:13, color:'#aaa', lineHeight:1.6 }}>
        We're open right now. Phase 3a builds the menu browse + cart + customer-detail capture + Stripe checkout flow on top of this surface.
      </div>
      <div style={{ marginTop:18, padding:'12px 14px', background:'#0e0e10', border:'1px solid #2a2a30', borderRadius:10, fontSize:11, color:'#888' }}>
        Resolved location: <b style={{ color:'#ccc' }}>{location.name}</b> ({location.id.slice(0, 8)}…)
        <br/>Mode: <b style={{ color:'#ccc' }}>online</b>
      </div>
    </div>
  );
}

function QrStub({ location, tableId }) {
  return (
    <div style={{ padding:'30px 24px', background:'rgba(127,127,127,0.10)', border:'1px solid rgba(127,127,127,0.25)', borderRadius:14 }}>
      <div style={{ fontSize:11, color:'#e8a020', fontWeight:800, letterSpacing:'.08em', textTransform:'uppercase', marginBottom:8 }}>
        Table-side
      </div>
      <div style={{ fontSize:18, fontWeight:800, marginBottom:6 }}>
        {tableId ? <>You're at table <code style={{ fontFamily:'var(--font-mono)', color:'#e8a020' }}>{tableId}</code></> : 'Welcome'}
      </div>
      <div style={{ fontSize:13, color:'#aaa', lineHeight:1.6 }}>
        We're open. Phase 3b builds the menu + cart + "fire to kitchen" flow that drops items into this table's session on the POS — no payment required upfront, your server settles the bill.
      </div>
      <div style={{ marginTop:18, padding:'12px 14px', background:'#0e0e10', border:'1px solid #2a2a30', borderRadius:10, fontSize:11, color:'#888' }}>
        Resolved location: <b style={{ color:'#ccc' }}>{location.name}</b> ({location.id.slice(0, 8)}…)
        <br/>Mode: <b style={{ color:'#ccc' }}>qr</b>
        {tableId && <><br/>Table id: <b style={{ color:'#ccc' }}>{tableId}</b></>}
      </div>
    </div>
  );
}
