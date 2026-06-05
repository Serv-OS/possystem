// src/surfaces/CustomerDisplaySurface.jsx
//
// Dedicated customer-facing display (Sunmi D3 Pro rear screen / external monitor).
// Mirrors a till. Layouts:
//   • idle      → full-screen ad slideshow (customer_display_images) / branding
//   • active    → SPLIT: slideshow on the left, live order (items + mods + total) on the right
//   • paying    → "follow the card reader" + amount
//   • approved/declined → full-screen ✓ / ✕
//
// Read-only; the POS broadcasts state over `display:<deviceId>` (lib/customerDisplay.js).
// Reached via ?mode=customer-display. Mirrors ?till=<deviceId> or this device's pairing.

import { useEffect, useRef, useState } from 'react';
import { supabase, ensureAuthToken } from '../lib/supabase';
import { money, setActiveCurrency } from '../lib/currency';
import { subscribeDisplay, getDisplayTargetId } from '../lib/customerDisplay';
import { ServOSIcon } from '../components/ServOSBrand';

const IDLE_AFTER_MS = 45000;
const SLIDE_MS = 7000;

export default function CustomerDisplaySurface() {
  const [payload, setPayload] = useState(null);
  const [profile, setProfile] = useState(null);
  const [slideIdx, setSlideIdx] = useState(0);
  const idleTimer = useRef(null);
  const terminalUntil = useRef(0);
  const targetId = getDisplayTargetId();

  // Boot: auth (realtime) → load branding/images → subscribe.
  useEffect(() => {
    let unsub = () => {};
    (async () => {
      try { await ensureAuthToken(); } catch { /* anon realtime ok */ }
      try {
        const dev = JSON.parse(localStorage.getItem('rpos-device') || 'null');
        if (dev?.profileId && supabase) {
          const { data } = await supabase
            .from('device_profiles')
            .select('kiosk_brand_name,kiosk_brand_color,kiosk_brand_bg_color,kiosk_brand_logo_url,kiosk_banners,customer_display_images')
            .eq('id', dev.profileId)
            .maybeSingle();
          if (data) setProfile(data);
        }
      } catch { /* branding optional */ }

      if (targetId) {
        unsub = subscribeDisplay(targetId, (p) => {
          if (p?.currency) { try { setActiveCurrency(p.currency); } catch { /* noop */ } }
          const st = p?.state || 'idle';
          if (st === 'idle' && Date.now() < terminalUntil.current) return;  // hold ✓/✕ past cart-clear
          if (st === 'approved' || st === 'declined') terminalUntil.current = Date.now() + 6000;
          else if (st === 'active' || st === 'paying') terminalUntil.current = 0;
          setPayload(p);
          if (idleTimer.current) clearTimeout(idleTimer.current);
          if (st !== 'idle') {
            const ms = (st === 'approved' || st === 'declined') ? 6500 : IDLE_AFTER_MS;
            idleTimer.current = setTimeout(() => setPayload({ state: 'idle', items: [], total: 0 }), ms);
          }
        });
      }
    })();
    return () => { unsub(); if (idleTimer.current) clearTimeout(idleTimer.current); };
  }, [targetId]);

  // Slideshow images: dedicated set, else fall back to kiosk banners.
  const slideImages = (() => {
    const cdi = Array.isArray(profile?.customer_display_images) ? profile.customer_display_images : [];
    const urls = cdi.map(x => (typeof x === 'string' ? x : x?.url)).filter(Boolean);
    if (urls.length) return urls;
    const banners = Array.isArray(profile?.kiosk_banners) ? profile.kiosk_banners : [];
    return banners.map(b => b?.imageUrl).filter(Boolean);
  })();

  useEffect(() => {
    if (slideImages.length < 2) return;
    const t = setInterval(() => setSlideIdx(i => (i + 1) % slideImages.length), SLIDE_MS);
    return () => clearInterval(t);
  }, [slideImages.length]);

  const brand = profile?.kiosk_brand_color || '#E8743C';
  const bg = profile?.kiosk_brand_bg_color || '#0E0D0A';
  const logo = profile?.kiosk_brand_logo_url || '';
  const venueName = profile?.kiosk_brand_name
    || (() => { try { return JSON.parse(localStorage.getItem('rpos-device') || 'null')?.locationName; } catch { return null; } })()
    || 'Serv OS';

  const state = payload?.state || 'idle';
  const items = Array.isArray(payload?.items) ? payload.items : [];
  const total = Number(payload?.total || 0);

  const root = {
    position: 'fixed', inset: 0, background: bg, color: '#fff',
    fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif",
    display: 'flex', flexDirection: 'column', overflow: 'hidden', userSelect: 'none',
  };

  const slides = <Slides images={slideImages} idx={slideIdx} bg={bg} logo={logo} venueName={venueName} />;

  // ── No target configured ─────────────────────────────────────────────────
  if (!targetId) {
    return (
      <div style={{ ...root, alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: 40 }}>
        <ServOSIcon size={72} />
        <div style={{ marginTop: 20, fontSize: 22, fontWeight: 700 }}>Customer display</div>
        <div style={{ marginTop: 10, fontSize: 15, opacity: 0.6, maxWidth: 520, lineHeight: 1.5 }}>
          Pair this device, or open with <code style={{ color: brand }}>?till=&lt;till id&gt;</code> to mirror a specific till.
        </div>
      </div>
    );
  }

  // ── Payment result (full screen) ─────────────────────────────────────────
  if (state === 'approved' || state === 'declined') {
    const ok = state === 'approved';
    return (
      <div style={{ ...root, alignItems: 'center', justifyContent: 'center', textAlign: 'center', background: ok ? '#0b1f12' : '#27110f' }}>
        <div style={{
          width: 160, height: 160, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: ok ? '#16a34a' : '#dc2626', fontSize: 96, lineHeight: 1, boxShadow: '0 10px 40px rgba(0,0,0,.4)',
        }}>{ok ? '✓' : '✕'}</div>
        <div style={{ marginTop: 32, fontSize: 40, fontWeight: 800 }}>{ok ? 'Payment approved' : 'Payment declined'}</div>
        {total > 0 && <div style={{ marginTop: 8, fontSize: 28, opacity: 0.85, fontVariantNumeric: 'tabular-nums' }}>{money(total)}</div>}
        {ok && <div style={{ marginTop: 28, fontSize: 22, opacity: 0.7 }}>Thank you{venueName ? ` — ${venueName}` : ''}!</div>}
      </div>
    );
  }

  // ── Paying (full screen) ─────────────────────────────────────────────────
  if (state === 'paying') {
    return (
      <div style={{ ...root, alignItems: 'center', justifyContent: 'center', textAlign: 'center' }}>
        <div style={{ fontSize: 88, marginBottom: 8 }}>💳</div>
        <div style={{ fontSize: 40, fontWeight: 800 }}>Please follow the card reader</div>
        <div style={{ marginTop: 20, fontSize: 64, fontWeight: 900, color: brand, fontVariantNumeric: 'tabular-nums' }}>{money(total)}</div>
        <div style={{ marginTop: 18, fontSize: 20, opacity: 0.6 }}>Tap, insert or swipe your card</div>
      </div>
    );
  }

  // ── Active sale — SPLIT: slideshow left, order right ──────────────────────
  if (state === 'active' && items.length > 0) {
    return (
      <div style={{ ...root, flexDirection: 'row' }}>
        <div style={{ position: 'relative', width: '40%', minWidth: 280 }}>{slides}</div>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', borderLeft: `3px solid ${brand}` }}>
          <div style={{ padding: '18px 28px', display: 'flex', alignItems: 'center', gap: 12, borderBottom: '1px solid rgba(255,255,255,.08)' }}>
            {logo ? <img src={logo} alt="" style={{ height: 34 }} /> : <ServOSIcon size={34} />}
            <div style={{ fontSize: 20, fontWeight: 700 }}>{venueName}</div>
            <div style={{ marginLeft: 'auto', fontSize: 13, opacity: 0.5, textTransform: 'uppercase', letterSpacing: '.08em' }}>Your order</div>
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
            {items.map((it, i) => {
              const qty = Number(it.qty || 1);
              const line = Number(it.lineTotal != null ? it.lineTotal : (Number(it.price || 0) * qty));
              const mods = Array.isArray(it.mods) ? it.mods : [];
              return (
                <div key={it.uid || i} style={{ display: 'flex', alignItems: 'flex-start', gap: 14, padding: '12px 28px', borderBottom: '1px solid rgba(255,255,255,.05)' }}>
                  <div style={{ minWidth: 40, fontSize: 22, fontWeight: 800, color: brand, fontVariantNumeric: 'tabular-nums' }}>{qty}×</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 22, fontWeight: 600 }}>{it.name || it.displayName || 'Item'}</div>
                    {mods.length > 0 && (
                      <div style={{ marginTop: 3, fontSize: 15, opacity: 0.55 }}>{mods.map(m => m.label || m).filter(Boolean).join(' · ')}</div>
                    )}
                    {it.notes && <div style={{ marginTop: 2, fontSize: 14, fontStyle: 'italic', opacity: 0.5 }}>“{it.notes}”</div>}
                  </div>
                  <div style={{ fontSize: 22, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{money(line)}</div>
                </div>
              );
            })}
          </div>
          <div style={{ padding: '20px 28px', display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', borderTop: `3px solid ${brand}`, background: 'rgba(0,0,0,.25)' }}>
            <div style={{ fontSize: 24, fontWeight: 700, opacity: 0.8 }}>Total</div>
            <div style={{ fontSize: 52, fontWeight: 900, color: brand, fontVariantNumeric: 'tabular-nums' }}>{money(total)}</div>
          </div>
        </div>
      </div>
    );
  }

  // ── Idle — full-screen slideshow ─────────────────────────────────────────
  return <div style={root}>{slides}</div>;
}

// Crossfading image slideshow with a branded fallback when no images are set.
function Slides({ images, idx, bg, logo, venueName }) {
  if (!images || images.length === 0) {
    return (
      <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: bg }}>
        <div style={{ textAlign: 'center', padding: 24 }}>
          {logo ? <img src={logo} alt="" style={{ maxHeight: 120, marginBottom: 20 }} /> : <ServOSIcon size={96} style={{ marginBottom: 16 }} />}
          <div style={{ fontSize: 44, fontWeight: 800, color: '#fff' }}>{venueName}</div>
          <div style={{ marginTop: 12, fontSize: 20, opacity: 0.55, color: '#fff' }}>Welcome</div>
        </div>
      </div>
    );
  }
  const cur = idx % images.length;
  return (
    <div style={{ position: 'absolute', inset: 0, background: bg }}>
      {images.map((src, i) => (
        <img key={src + i} src={src} alt=""
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', opacity: i === cur ? 1 : 0, transition: 'opacity .8s ease' }} />
      ))}
    </div>
  );
}
