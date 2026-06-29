// src/surfaces/CustomerDisplaySurface.jsx
//
// Dedicated customer-facing display (Sunmi D3 Pro rear screen / external monitor).
//   • idle      → full-screen ad slideshow (customer_display_images) / branding
//   • active    → SPLIT: LEFT = loyalty phone-capture keypad (if loyalty enabled),
//                 RIGHT = live order (items + mods + total)
//   • paying    → "follow the card reader" + amount
//   • approved/declined → full-screen ✓ / ✕
//
// Two-way over `display:<deviceId>` (lib/customerDisplay.js): POS broadcasts cart +
// payment + loyalty result; the display broadcasts the customer's phone number.
// No OTP (counter-side). New numbers get the enrolment SMS from the POS side.
//
// v5.5.368: theme-aware — follows the POS light/dark (broadcast in the display
// payload as `theme`, with a localStorage('rpos-theme') fallback for same-device).

import { useEffect, useRef, useState } from 'react';
import { supabase, ensureAuthToken } from '../lib/supabase';
import { money, setActiveCurrency } from '../lib/currency';
import { subscribeDisplay, getDisplayTargetId, publishCustomerPhone, publishRedeemReward, isLoyaltyEnabled } from '../lib/customerDisplay';
import { ServOSIcon } from '../components/ServOSBrand';

const IDLE_AFTER_MS = 45000;
const SLIDE_MS = 7000;

// Theme palette for the customer display (mirrors the ServOS POS light/dark).
function palette(theme) {
  const dark = theme !== 'light';
  return {
    dark,
    bg:       dark ? '#0F1211' : '#F4F6F2',
    text:     dark ? '#E9ECEA' : '#16191C',
    dim:      dark ? 'rgba(233,236,234,.62)' : 'rgba(22,25,28,.6)',
    faint:    dark ? 'rgba(233,236,234,.4)'  : 'rgba(22,25,28,.42)',
    surface:  dark ? 'rgba(255,255,255,.06)' : 'rgba(22,25,28,.05)',
    sBorder:  dark ? 'rgba(255,255,255,.15)' : 'rgba(22,25,28,.14)',
    hair:     dark ? 'rgba(255,255,255,.08)' : 'rgba(22,25,28,.08)',
    footBg:   dark ? 'rgba(0,0,0,.25)' : 'rgba(22,25,28,.04)',
    okBg:     dark ? '#0b1f12' : '#E7F6EC',
    badBg:    dark ? '#27110f' : '#FBEAE7',
  };
}

export default function CustomerDisplaySurface() {
  const [payload, setPayload] = useState(null);
  const [profile, setProfile] = useState(null);
  const [slideIdx, setSlideIdx] = useState(0);
  const [loyaltyEnabled, setLoyaltyEnabled] = useState(false);
  const [phoneInput, setPhoneInput] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [loyaltyResult, setLoyaltyResult] = useState(null);
  const [theme, setTheme] = useState(() => { try { return localStorage.getItem('rpos-theme') || 'dark'; } catch { return 'dark'; } });
  const idleTimer = useRef(null);
  const terminalUntil = useRef(0);
  const resultTimer = useRef(null);
  const submitTimer = useRef(null);
  const targetId = getDisplayTargetId();

  // Same-device live theme sync (POS toggles → localStorage 'storage' event).
  useEffect(() => {
    const onStorage = (e) => { if (e.key === 'rpos-theme' && e.newValue) setTheme(e.newValue); };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // Boot: auth → loyalty-enabled? + branding → subscribe (cart/state + loyalty result).
  useEffect(() => {
    let unsub = () => {};
    (async () => {
      try { await ensureAuthToken(); } catch { /* anon realtime ok */ }
      try { setLoyaltyEnabled(await isLoyaltyEnabled()); } catch { /* default off */ }
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
        unsub = subscribeDisplay(targetId,
          (p) => {  // cart / state
            if (p?.theme) setTheme(p.theme); // follow the POS light/dark
            if (typeof p?.loyaltyEnabled === 'boolean') setLoyaltyEnabled(p.loyaltyEnabled); // authoritative from POS
            if (p?.currency) { try { setActiveCurrency(p.currency); } catch { /* noop */ } }
            const st = p?.state || 'idle';
            if (st === 'idle' && Date.now() < terminalUntil.current) return;
            if (st === 'approved' || st === 'declined') terminalUntil.current = Date.now() + 6000;
            else if (st === 'active' || st === 'paying') terminalUntil.current = 0;
            if (st === 'idle') { setPhoneInput(''); setSubmitting(false); setLoyaltyResult(null); }
            setPayload(p);
            if (idleTimer.current) clearTimeout(idleTimer.current);
            if (st !== 'idle') {
              const ms = (st === 'approved' || st === 'declined') ? 6500 : IDLE_AFTER_MS;
              idleTimer.current = setTimeout(() => setPayload({ state: 'idle', items: [], total: 0 }), ms);
            }
          },
          (r) => {  // loyalty lookup result
            setSubmitting(false);
            if (submitTimer.current) clearTimeout(submitTimer.current);
            setPhoneInput('');
            setLoyaltyResult(r || {});
            if (resultTimer.current) clearTimeout(resultTimer.current);
            const ms = (r?.known && (r.rewards || []).length) ? 25000 : 9000; // longer while rewards are tappable
            resultTimer.current = setTimeout(() => setLoyaltyResult(null), ms);
          });
      }
    })();
    return () => {
      unsub();
      [idleTimer, resultTimer, submitTimer].forEach(t => t.current && clearTimeout(t.current));
    };
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

  const C = palette(theme);
  const brand = profile?.kiosk_brand_color || (C.dark ? '#46E08C' : '#0E9E55');
  const logo = profile?.kiosk_brand_logo_url || '';
  const venueName = profile?.kiosk_brand_name
    || (() => { try { return JSON.parse(localStorage.getItem('rpos-device') || 'null')?.locationName; } catch { return null; } })()
    || 'Serv OS';

  const state = payload?.state || 'idle';
  const items = Array.isArray(payload?.items) ? payload.items : [];
  const total = Number(payload?.total || 0);

  const root = {
    position: 'fixed', inset: 0, background: C.bg, color: C.text,
    fontFamily: "'Space Grotesk',-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif",
    display: 'flex', flexDirection: 'column', overflow: 'hidden', userSelect: 'none',
    transition: 'background .4s ease, color .4s ease',
  };
  const slides = <Slides images={slideImages} idx={slideIdx} C={C} brand={brand} logo={logo} venueName={venueName} />;

  const submitPhone = () => {
    if ((phoneInput || '').replace(/\D/g, '').length < 7) return;
    publishCustomerPhone(phoneInput);
    setSubmitting(true);
    if (submitTimer.current) clearTimeout(submitTimer.current);
    submitTimer.current = setTimeout(() => setSubmitting(false), 8000); // fallback if POS silent
  };

  // ── No target configured ─────────────────────────────────────────────────
  if (!targetId) {
    return (
      <div style={{ ...root, alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: 40 }}>
        <ServOSIcon size={72} />
        <div style={{ marginTop: 20, fontSize: 22, fontWeight: 700 }}>Customer display</div>
        <div style={{ marginTop: 10, fontSize: 15, color: C.dim, maxWidth: 520, lineHeight: 1.5 }}>
          Pair this device, or open with <code style={{ color: brand }}>?till=&lt;till id&gt;</code> to mirror a specific till.
        </div>
      </div>
    );
  }

  // ── Payment result (full screen) ─────────────────────────────────────────
  if (state === 'approved' || state === 'declined') {
    const ok = state === 'approved';
    return (
      <div style={{ ...root, alignItems: 'center', justifyContent: 'center', textAlign: 'center', background: ok ? C.okBg : C.badBg }}>
        <div style={{ width: 160, height: 160, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: ok ? '#16a34a' : '#dc2626', color: '#fff', fontSize: 96, lineHeight: 1, boxShadow: '0 10px 40px rgba(0,0,0,.25)' }}>{ok ? '✓' : '✕'}</div>
        <div style={{ marginTop: 32, fontSize: 40, fontWeight: 800 }}>{ok ? 'Payment approved' : 'Payment declined'}</div>
        {total > 0 && <div style={{ marginTop: 8, fontSize: 28, color: C.dim, fontVariantNumeric: 'tabular-nums' }}>{money(total)}</div>}
        {ok && <div style={{ marginTop: 28, fontSize: 22, color: C.dim }}>Thank you{venueName ? ` — ${venueName}` : ''}!</div>}
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
        <div style={{ marginTop: 18, fontSize: 20, color: C.dim }}>Tap, insert or swipe your card</div>
      </div>
    );
  }

  // ── Active sale — SPLIT: loyalty keypad left, order right ──────────────────
  if (state === 'active' && items.length > 0) {
    let left;
    if (loyaltyResult) left = <LoyaltyResultPanel result={loyaltyResult} brand={brand} venueName={venueName} C={C} onRedeem={(r) => publishRedeemReward(r)} />;
    else if (submitting) left = <Centered><div style={{ fontSize: 24, color: C.dim }}>Checking…</div></Centered>;
    else if (loyaltyEnabled) left = <PhoneKeypad value={phoneInput} brand={brand} C={C}
      onKey={d => setPhoneInput(p => (p + d).slice(0, 15))}
      onBackspace={() => setPhoneInput(p => p.slice(0, -1))}
      onSubmit={submitPhone} />;
    else left = slides;
    return (
      <div style={{ ...root, flexDirection: 'row' }}>
        <div style={{ position: 'relative', width: '42%', minWidth: 300 }}>{left}</div>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', borderLeft: `3px solid ${brand}` }}>
          <div style={{ padding: '18px 28px', display: 'flex', alignItems: 'center', gap: 12, borderBottom: `1px solid ${C.hair}` }}>
            {logo ? <img src={logo} alt="" style={{ height: 34 }} /> : <ServOSIcon size={34} />}
            <div style={{ fontSize: 20, fontWeight: 700 }}>{venueName}</div>
            <div style={{ marginLeft: 'auto', fontSize: 13, color: C.faint, textTransform: 'uppercase', letterSpacing: '.08em' }}>Your order</div>
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
            {items.map((it, i) => {
              const qty = Number(it.qty || 1);
              const line = Number(it.lineTotal != null ? it.lineTotal : (Number(it.price || 0) * qty));
              const mods = Array.isArray(it.mods) ? it.mods : [];
              return (
                <div key={it.uid || i} style={{ display: 'flex', alignItems: 'flex-start', gap: 14, padding: '12px 28px', borderBottom: `1px solid ${C.hair}` }}>
                  <div style={{ minWidth: 40, fontSize: 22, fontWeight: 800, color: brand, fontVariantNumeric: 'tabular-nums' }}>{qty}×</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 22, fontWeight: 600 }}>{it.name || it.displayName || 'Item'}</div>
                    {mods.length > 0 && (
                      <div style={{ marginTop: 4 }}>
                        {mods.map((m, mi) => {
                          const label = typeof m === 'string' ? m : m.label;
                          if (!label) return null;
                          const p = Number(m && m.price) || 0;
                          return (
                            <div key={mi} style={{ display: 'flex', justifyContent: 'space-between', gap: 14, fontSize: 15, color: C.dim, lineHeight: 1.55 }}>
                              <span>{label}</span>
                              {p > 0 && <span style={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>+{money(p)}</span>}
                            </div>
                          );
                        })}
                      </div>
                    )}
                    {it.notes && <div style={{ marginTop: 2, fontSize: 14, fontStyle: 'italic', color: C.faint }}>“{it.notes}”</div>}
                  </div>
                  <div style={{ fontSize: 22, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{money(line)}</div>
                </div>
              );
            })}
          </div>
          <div style={{ padding: '20px 28px', display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', borderTop: `3px solid ${brand}`, background: C.footBg }}>
            <div style={{ fontSize: 24, fontWeight: 700, color: C.dim }}>Total</div>
            <div style={{ fontSize: 52, fontWeight: 900, color: brand, fontVariantNumeric: 'tabular-nums' }}>{money(total)}</div>
          </div>
        </div>
      </div>
    );
  }

  // ── Idle — full-screen slideshow ─────────────────────────────────────────
  return <div style={root}>{slides}</div>;
}

function Centered({ children }) {
  return <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: 24 }}>{children}</div>;
}

function PhoneKeypad({ value, brand, C, onKey, onBackspace, onSubmit }) {
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'];
  const ready = (value || '').replace(/\D/g, '').length >= 7;
  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div style={{ fontSize: 30, fontWeight: 800, textAlign: 'center' }}>Earn rewards 🎁</div>
      <div style={{ fontSize: 16, color: C.dim, textAlign: 'center', marginTop: 6, marginBottom: 18 }}>Enter your mobile to collect points</div>
      <div style={{ fontSize: 32, fontWeight: 800, letterSpacing: '2px', minHeight: 42, marginBottom: 16, fontVariantNumeric: 'tabular-nums' }}>
        {value || <span style={{ color: C.faint }}>0000000000</span>}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 80px)', gap: 10 }}>
        {keys.map((k, i) => k === '' ? <div key={i} /> : (
          <button key={i} onClick={() => (k === '⌫' ? onBackspace() : onKey(k))} style={{
            height: 66, borderRadius: 14, border: `1px solid ${C.sBorder}`, background: C.surface,
            color: C.text, fontSize: 26, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
          }}>{k}</button>
        ))}
      </div>
      <button onClick={onSubmit} disabled={!ready} style={{
        marginTop: 18, width: 260, height: 60, borderRadius: 14, border: 'none',
        background: ready ? brand : C.surface, color: ready ? '#0b0c10' : C.faint,
        fontSize: 21, fontWeight: 800, cursor: ready ? 'pointer' : 'not-allowed', fontFamily: 'inherit',
      }}>Collect points</button>
      <div style={{ marginTop: 12, fontSize: 12, color: C.faint, textAlign: 'center', maxWidth: 280 }}>New? We'll text you a link to finish joining.</div>
    </div>
  );
}

function LoyaltyResultPanel({ result, brand, venueName, C, onRedeem }) {
  if (result?.error) {
    return <Centered><div style={{ fontSize: 44 }}>⚠️</div><div style={{ fontSize: 24, fontWeight: 700, marginTop: 10 }}>Sorry — please try again</div></Centered>;
  }
  if (result?.rewardSelected) {
    return (
      <Centered>
        <div style={{ fontSize: 64 }}>✅</div>
        <div style={{ fontSize: 26, fontWeight: 800, marginTop: 8 }}>{result.rewardSelected}</div>
        <div style={{ fontSize: 16, color: C.dim, marginTop: 10 }}>Added — applied at the till</div>
      </Centered>
    );
  }
  if (result?.known) {
    const rewards = Array.isArray(result.rewards) ? result.rewards : [];
    return (
      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', padding: '26px 20px', overflowY: 'auto' }}>
        <div style={{ textAlign: 'center', flexShrink: 0 }}>
          <div style={{ fontSize: 40 }}>🎉</div>
          <div style={{ fontSize: 26, fontWeight: 800, marginTop: 4 }}>Welcome back{result.name ? `, ${result.name}` : ''}!</div>
          {result.points != null && <div style={{ fontSize: 20, color: brand, fontWeight: 800, marginTop: 4 }}>{result.points} points</div>}
        </div>
        {rewards.length > 0 ? (
          <>
            <div style={{ fontSize: 15, color: C.dim, textAlign: 'center', margin: '16px 0 10px' }}>Tap a reward to use it</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {rewards.map(r => (
                <button key={r.id} onClick={() => onRedeem && onRedeem(r)} style={{
                  textAlign: 'left', padding: '14px 16px', borderRadius: 14, cursor: 'pointer', fontFamily: 'inherit',
                  background: C.surface, border: `1.5px solid ${brand}66`, color: C.text,
                }}>
                  <div style={{ fontSize: 18, fontWeight: 700 }}>{r.label}</div>
                  {r.description && <div style={{ fontSize: 13, color: C.dim, marginTop: 2 }}>{r.description}</div>}
                  {r.pointsCost != null && <div style={{ fontSize: 13, color: brand, fontWeight: 700, marginTop: 4 }}>{r.pointsCost} pts</div>}
                </button>
              ))}
            </div>
          </>
        ) : (
          <div style={{ fontSize: 16, color: C.dim, textAlign: 'center', marginTop: 16 }}>You're earning points on this order</div>
        )}
      </div>
    );
  }
  return (
    <Centered>
      <div style={{ fontSize: 64 }}>📱</div>
      <div style={{ fontSize: 28, fontWeight: 800, marginTop: 8 }}>You're in!</div>
      <div style={{ fontSize: 16, color: C.dim, marginTop: 10, maxWidth: 300 }}>We've texted you a link to finish setting up your {venueName} rewards. Earning points on this order.</div>
    </Centered>
  );
}

// Crossfading image slideshow with a branded fallback when no images are set.
function Slides({ images, idx, C, brand, logo, venueName }) {
  if (!images || images.length === 0) {
    return (
      <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: C.bg }}>
        <div style={{ textAlign: 'center', padding: 24 }}>
          {logo ? <img src={logo} alt="" style={{ maxHeight: 120, marginBottom: 20 }} /> : <ServOSIcon size={96} style={{ marginBottom: 16 }} />}
          <div style={{ fontSize: 44, fontWeight: 800, color: C.text }}>{venueName}</div>
          <div style={{ marginTop: 12, fontSize: 20, color: C.dim }}>Welcome</div>
        </div>
      </div>
    );
  }
  const cur = idx % images.length;
  return (
    <div style={{ position: 'absolute', inset: 0, background: C.bg }}>
      {images.map((src, i) => (
        <img key={src + i} src={src} alt="" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', opacity: i === cur ? 1 : 0, transition: 'opacity .8s ease' }} />
      ))}
    </div>
  );
}
