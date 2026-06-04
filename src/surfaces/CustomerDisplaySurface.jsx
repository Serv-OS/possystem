// src/surfaces/CustomerDisplaySurface.jsx
//
// Dedicated customer-facing display (Sunmi D3 Pro rear screen / external monitor).
// Mirrors a till: idle ads/branding → live cart → payment status. Read-only; the
// POS broadcasts state over `display:<deviceId>` (see lib/customerDisplay.js).
//
// Reached via ?mode=customer-display. Which till it mirrors: ?till=<deviceId> if
// set, else this (paired) device's own id (same-device D3 Pro main+rear).

import { useEffect, useRef, useState } from 'react';
import { supabase, ensureAuthToken } from '../lib/supabase';
import { money, setActiveCurrency } from '../lib/currency';
import { subscribeDisplay, getDisplayTargetId } from '../lib/customerDisplay';
import { ServOSIcon, ServOSWordmark } from '../components/ServOSBrand';

const IDLE_AFTER_MS = 45000; // fall back to idle after this much inactivity

export default function CustomerDisplaySurface() {
  const [payload, setPayload] = useState(null);   // { items, total, currency, state }
  const [profile, setProfile] = useState(null);   // branding / banners (best-effort)
  const [bannerIdx, setBannerIdx] = useState(0);
  const idleTimer = useRef(null);
  const terminalUntil = useRef(0); // hold approved/declined past the post-sale cart-clear
  const targetId = getDisplayTargetId();

  // Boot: auth (for realtime) → load branding → subscribe to the till's broadcast.
  useEffect(() => {
    let unsub = () => {};
    (async () => {
      try { await ensureAuthToken(); } catch { /* anon realtime still ok for broadcast */ }
      try {
        const dev = JSON.parse(localStorage.getItem('rpos-device') || 'null');
        if (dev?.profileId && supabase) {
          const { data } = await supabase
            .from('device_profiles')
            .select('kiosk_brand_name,kiosk_brand_color,kiosk_brand_bg_color,kiosk_brand_logo_url,kiosk_attract_video_url,kiosk_banners')
            .eq('id', dev.profileId)
            .maybeSingle();
          if (data) setProfile(data);
        }
      } catch { /* branding optional */ }

      if (targetId) {
        unsub = subscribeDisplay(targetId, (p) => {
          if (p?.currency) { try { setActiveCurrency(p.currency); } catch { /* noop */ } }
          const st = p?.state || 'idle';
          // Keep the approved/declined screen up ~6s even though the sale's
          // cart-clear immediately broadcasts 'idle' right after.
          if (st === 'idle' && Date.now() < terminalUntil.current) return;
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

  // Cycle banners while idle.
  const banners = Array.isArray(profile?.kiosk_banners) ? profile.kiosk_banners.filter(b => b?.imageUrl) : [];
  useEffect(() => {
    if (banners.length < 2) return;
    const t = setInterval(() => setBannerIdx(i => (i + 1) % banners.length), 7000);
    return () => clearInterval(t);
  }, [banners.length]);

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

  // ── No target configured ──────────────────────────────────────────────────
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

  // ── Payment result overlay ──────────────────────────────────────────────────
  if (state === 'approved' || state === 'declined') {
    const ok = state === 'approved';
    return (
      <div style={{ ...root, alignItems: 'center', justifyContent: 'center', textAlign: 'center', background: ok ? '#0b1f12' : '#27110f' }}>
        <div style={{
          width: 160, height: 160, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: ok ? '#16a34a' : '#dc2626', fontSize: 96, lineHeight: 1, color: '#fff', boxShadow: '0 10px 40px rgba(0,0,0,.4)',
        }}>{ok ? '✓' : '✕'}</div>
        <div style={{ marginTop: 32, fontSize: 40, fontWeight: 800 }}>{ok ? 'Payment approved' : 'Payment declined'}</div>
        {total > 0 && <div style={{ marginTop: 8, fontSize: 28, opacity: 0.85, fontVariantNumeric: 'tabular-nums' }}>{money(total)}</div>}
        {ok && <div style={{ marginTop: 28, fontSize: 22, opacity: 0.7 }}>Thank you{venueName ? ` — ${venueName}` : ''}!</div>}
      </div>
    );
  }

  // ── Paying ───────────────────────────────────────────────────────────────
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

  // ── Active sale — live cart ─────────────────────────────────────────────────
  if (state === 'active' && items.length > 0) {
    return (
      <div style={root}>
        <div style={{ padding: '20px 32px', display: 'flex', alignItems: 'center', gap: 14, borderBottom: '1px solid rgba(255,255,255,.08)' }}>
          {logo ? <img src={logo} alt="" style={{ height: 40 }} /> : <ServOSIcon size={40} />}
          <div style={{ fontSize: 22, fontWeight: 700 }}>{venueName}</div>
          <div style={{ marginLeft: 'auto', fontSize: 14, opacity: 0.5, textTransform: 'uppercase', letterSpacing: '.08em' }}>Your order</div>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '12px 0' }}>
          {items.map((it, i) => {
            const qty = Number(it.qty || 1);
            const line = Number(it.lineTotal != null ? it.lineTotal : (Number(it.price || 0) * qty));
            const mods = Array.isArray(it.mods) ? it.mods : [];
            return (
              <div key={it.uid || i} style={{ display: 'flex', alignItems: 'flex-start', gap: 16, padding: '14px 32px', borderBottom: '1px solid rgba(255,255,255,.05)' }}>
                <div style={{ minWidth: 44, fontSize: 24, fontWeight: 800, color: brand, fontVariantNumeric: 'tabular-nums' }}>{qty}×</div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 24, fontWeight: 600 }}>{it.name || it.displayName || 'Item'}</div>
                  {mods.length > 0 && (
                    <div style={{ marginTop: 4, fontSize: 16, opacity: 0.55 }}>{mods.map(m => m.label || m).filter(Boolean).join(' · ')}</div>
                  )}
                  {it.notes && <div style={{ marginTop: 3, fontSize: 15, fontStyle: 'italic', opacity: 0.5 }}>“{it.notes}”</div>}
                </div>
                <div style={{ fontSize: 24, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{money(line)}</div>
              </div>
            );
          })}
        </div>
        <div style={{ padding: '22px 32px', display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', borderTop: `3px solid ${brand}`, background: 'rgba(0,0,0,.25)' }}>
          <div style={{ fontSize: 26, fontWeight: 700, opacity: 0.8 }}>Total</div>
          <div style={{ fontSize: 56, fontWeight: 900, color: brand, fontVariantNumeric: 'tabular-nums' }}>{money(total)}</div>
        </div>
      </div>
    );
  }

  // ── Idle — branding / ad carousel ──────────────────────────────────────────
  return (
    <div style={{ ...root, alignItems: 'center', justifyContent: 'center' }}>
      {banners.length > 0 ? (
        <img src={banners[bannerIdx % banners.length].imageUrl} alt=""
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', transition: 'opacity .6s' }} />
      ) : (
        <div style={{ textAlign: 'center' }}>
          {logo ? <img src={logo} alt="" style={{ maxHeight: 120, marginBottom: 24 }} />
                : <ServOSIcon size={96} style={{ marginBottom: 20 }} />}
          <div style={{ fontSize: 48, fontWeight: 800 }}>{venueName}</div>
          <div style={{ marginTop: 14, fontSize: 22, opacity: 0.55 }}>Welcome</div>
          {venueName === 'Serv OS' && <div style={{ marginTop: 40 }}><ServOSWordmark fontSize={28} color="#fff" /></div>}
        </div>
      )}
    </div>
  );
}
