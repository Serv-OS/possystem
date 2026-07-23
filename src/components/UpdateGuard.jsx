// UpdateGuard (v5.5.870) — makes every operator till run the latest code, automatically.
//
// WHY: a deploy reaches Vercel, but a running device — especially the Sunmi POS, which loads the
// app in an Android WebView that keeps the old page in memory on a mere "refresh" — can keep
// running STALE code until someone force-restarts it. Nobody knows to. That silently broke online
// kitchen printing and cost hours to find. This guard removes the human from the loop.
//
// HOW: each build emits /version.json (see vite.config.js). Every ~3 min we fetch it (cache-busted,
// no-store). When the DEPLOYED version is newer than the one we're RUNNING, we show an unmissable
// banner with a short countdown, then apply the update — clearing caches and reloading, which pulls
// the fresh index.html through the network-first service worker and beats the WebView's stale cache.
//
// SAFETY: the countdown pauses while a payment/checkout is in progress (window.__RPOS_BUSY), so a
// till mid-sale is never yanked out from under staff. Customer-facing routes (/online, /qr, …) are
// skipped entirely — those are short-lived sessions served fresh each visit, and we never want to
// reload a customer mid-payment.

import { useEffect, useRef, useState } from 'react';
import { VERSION } from '../lib/version';

const POLL_MS = 3 * 60 * 1000;   // check every 3 minutes
const FIRST_CHECK_MS = 20 * 1000; // and once ~20s after boot
const COUNTDOWN_S = 90;           // grace before auto-applying

// Numeric semver compare: returns >0 if a is newer than b.
function cmpVersion(a, b) {
  const pa = String(a || '').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b || '').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

async function applyUpdate() {
  // Activate a waiting service worker, then wipe caches so the reload can't be served stale.
  try {
    if ('serviceWorker' in navigator) {
      const reg = await navigator.serviceWorker.getRegistration();
      reg?.waiting?.postMessage?.({ type: 'SKIP_WAITING' });
    }
  } catch { /* best-effort */ }
  try {
    if (typeof caches !== 'undefined') {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    }
  } catch { /* best-effort */ }
  window.location.reload();
}

// Customer-facing surfaces are path-routed (/online/:slug, /qr/*, …); operator surfaces are served
// from '/' with a ?mode= query. Only auto-update the operator/device surfaces.
function isCustomerRoute() {
  try { return /^\/(online|qr|gift|customer|review)(\/|$)/.test(window.location.pathname); }
  catch { return false; }
}

export default function UpdateGuard() {
  const [pending, setPending] = useState(null);   // deployed version string, once an update is found
  const [count, setCount] = useState(COUNTDOWN_S);
  const tick = useRef(null);

  // ── poll /version.json ──────────────────────────────────────────────────────
  useEffect(() => {
    if (isCustomerRoute()) return;
    let alive = true;
    const check = async () => {
      if (!alive || document.hidden) return;               // don't churn while backgrounded
      try {
        const r = await fetch(`/version.json?ts=${Date.now()}`, { cache: 'no-store' });
        if (!r.ok) return;                                  // pre-870 deploy has no version.json — ignore
        const { version: deployed } = await r.json();
        if (alive && deployed && cmpVersion(deployed, VERSION) > 0) {
          setPending(prev => prev || deployed);             // latch the first newer version we see
        }
      } catch { /* offline / transient — try again next tick */ }
    };
    const first = setTimeout(check, FIRST_CHECK_MS);
    const iv = setInterval(check, POLL_MS);
    return () => { alive = false; clearTimeout(first); clearInterval(iv); };
  }, []);

  // ── countdown → auto-apply (paused during an active payment) ─────────────────
  useEffect(() => {
    if (!pending) return;
    setCount(COUNTDOWN_S);
    tick.current = setInterval(() => {
      setCount(c => {
        if (c <= 1) {
          if (window.__RPOS_BUSY) return COUNTDOWN_S;       // mid-sale: hold, re-arm the countdown
          clearInterval(tick.current);
          applyUpdate();
          return 0;
        }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(tick.current);
  }, [pending]);

  if (!pending) return null;

  return (
    <div role="alert" style={{
      position: 'fixed', top: 0, left: 0, right: 0, zIndex: 2147483647,
      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 14,
      padding: '12px 16px', background: '#1f6feb', color: '#fff', fontFamily: 'inherit',
      fontSize: 15, fontWeight: 600, boxShadow: '0 2px 12px rgba(0,0,0,0.35)',
    }}>
      <span>🔄 New version {pending} available — updating in {count}s to keep this till current.</span>
      <button
        onClick={applyUpdate}
        style={{
          padding: '8px 16px', borderRadius: 8, border: 'none', cursor: 'pointer',
          background: '#fff', color: '#1f6feb', fontWeight: 700, fontFamily: 'inherit', fontSize: 15,
        }}
      >Update now</button>
    </div>
  );
}
