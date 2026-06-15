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
import OnlineSurface from './online/OnlineSurface';
import GiftPurchaseSurface from './gift/GiftPurchaseSurface';
import GiftBalanceSurface from './gift/GiftBalanceSurface';
import GiftSuccessSurface from './gift/GiftSuccessSurface';
import CustomerPortal from './customer/CustomerPortal';
import ReviewSurface from './ReviewSurface';
import WifiSurface from './WifiSurface';

export default function CustomerBoot({ slug, mode, tableId }) {
  const [state, setState] = useState({ loading: true, location: null, error: null });

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
    return <CustomerShell location={loc}>
      <ClosedBanner location={loc} nextOpensAt={next} mode={mode}/>
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
  return (
    <div style={{
      minHeight:'100vh', background:'#0e0e10', color:'#fff', fontFamily:'system-ui, -apple-system, sans-serif',
      display:'flex', flexDirection:'column', alignItems:'center', padding:'40px 20px',
    }}>
      {location && (
        <div style={{ marginBottom:24, textAlign:'center' }}>
          <div style={{ fontSize:24, fontWeight:800 }}>{location.name}</div>
          <div style={{ fontSize:12, color:'#777', marginTop:4 }}>
            Powered by Serv OS
          </div>
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
    <div style={{ textAlign:'center', padding:'40px 24px', background:'#16161a', border:'1px solid #2a2a30', borderRadius:14 }}>
      <div style={{ fontSize:42, marginBottom:14 }}>{icon}</div>
      <div style={{ fontSize:18, fontWeight:800, marginBottom:8 }}>{title}</div>
      <div style={{ fontSize:13, color:'#aaa', lineHeight:1.6 }}>{body}</div>
    </div>
  );
}

function ClosedBanner({ location, nextOpensAt, mode }) {
  const tz = location.timezone || 'Europe/London';
  const fmt = nextOpensAt
    ? new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday:'long', hour:'numeric', minute:'2-digit', hour12:true }).format(nextOpensAt)
    : null;
  return (
    <div style={{ textAlign:'center', padding:'40px 24px', background:'#16161a', border:'1px solid #2a2a30', borderRadius:14 }}>
      <div style={{ fontSize:42, marginBottom:14 }}>🌙</div>
      <div style={{ fontSize:18, fontWeight:800, marginBottom:8 }}>We're closed</div>
      <div style={{ fontSize:13, color:'#aaa', marginBottom:16 }}>
        {fmt ? <>Opens <b style={{ color:'#fff' }}>{fmt}</b></> : 'Hours not set yet — please come back later.'}
      </div>
      {mode === 'online' && nextOpensAt && (
        <button style={{
          padding:'12px 22px', borderRadius:99, background:'#e8a020', color:'#0b0c10', border:'none',
          fontWeight:800, fontSize:13, cursor:'pointer', marginTop:6,
        }}>
          Order ahead for later
        </button>
      )}
      <div style={{ fontSize:11, color:'#666', marginTop:18 }}>
        {formatHoursPreview(location.opening_hours)}
      </div>
    </div>
  );
}

// ── Phase 3 stubs ───────────────────────────────────────────────────────────
function OnlineStub({ location }) {
  return (
    <div style={{ padding:'30px 24px', background:'#16161a', border:'1px solid #2a2a30', borderRadius:14 }}>
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
    <div style={{ padding:'30px 24px', background:'#16161a', border:'1px solid #2a2a30', borderRadius:14 }}>
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
