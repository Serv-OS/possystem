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
// SAFETY: the countdown pauses while a payment is in progress, so a till mid sale is never yanked
// out from under staff. Customer-facing routes (/online, /qr, …) are skipped entirely — those are
// short-lived sessions served fresh each visit, and we never want to reload a customer mid-payment.
//
// v5.11.1: the pause is real. Until now it read window.__RPOS_BUSY, which nothing ever set, so a
// release reloaded Leeds POS 1 three seconds after its checkout sent a card machine job (27 Sep
// 2026). Every pay flow now holds lib/paymentBusy.js. The countdown stops while anything holds
// and for 15 s after, the busy check is repeated right before the reload, and Update now is
// refused while a payment is live.

import { useEffect, useRef, useState } from 'react';
import { VERSION } from '../lib/version';
import { canApplyUpdate, isPaymentBusy, subscribePaymentBusy, updateCountdownStep } from '../lib/paymentBusy';

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

// Returns true once the reload is under way. It looks at the busy flag again right before the
// reload, because a payment can start while the caches clear; false means wait and try again.
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
  if (!canApplyUpdate()) return false;
  window.location.reload();
  return true;
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
  const [waiting, setWaiting] = useState(false);  // countdown paused for a payment
  const [busyNow, setBusyNow] = useState(isPaymentBusy);   // a payment holds now: Update now refuses
  const nowRef = useRef(false);                   // staff pressed Update now

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
  // The side effects live in the interval, never inside a setState updater (React may run an
  // updater twice, or ahead of time).
  useEffect(() => {
    if (!pending) return undefined;
    let left = COUNTDOWN_S;
    let applying = false;
    const iv = setInterval(() => {
      if (applying) return;
      // Paused while a payment holds or has just ended; resumes where it was once the till is quiet.
      const step = updateCountdownStep({ left, mayApply: canApplyUpdate(), nowRequested: nowRef.current });
      left = step.left;
      setWaiting(step.waiting);
      setCount(left);
      if (!step.apply) return;
      applying = true;
      applyUpdate()
        .then((reloading) => { if (!reloading) applying = false; })   // a payment started: wait again
        .catch(() => { applying = false; });
    }, 1000);
    return () => clearInterval(iv);
  }, [pending]);

  // ── follow the busy flag, for the button ─────────────────────────────────────
  useEffect(() => subscribePaymentBusy((n) => setBusyNow(n > 0)), []);

  if (!pending) return null;

  // Refused while a payment holds. Otherwise the countdown applies it on its next tick, or, in the
  // quiet seconds just after a payment, the moment those end.
  const updateNow = () => {
    if (isPaymentBusy()) { setBusyNow(true); return; }
    nowRef.current = true;
  };

  return (
    <div role="alert" style={{
      position: 'fixed', top: 0, left: 0, right: 0, zIndex: 2147483647,
      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 14,
      padding: '12px 16px', background: '#1f6feb', color: '#fff', fontFamily: 'inherit',
      fontSize: 15, fontWeight: 600, boxShadow: '0 2px 12px rgba(0,0,0,0.35)',
    }}>
      <span>
        {waiting
          ? `🔄 New version ${pending} is ready. This till updates once the payment is finished.`
          : `🔄 New version ${pending} is ready. This till updates in ${count}s.`}
      </span>
      <button
        onClick={updateNow}
        disabled={busyNow}
        style={{
          padding: '8px 16px', borderRadius: 8, border: 'none', cursor: busyNow ? 'default' : 'pointer',
          background: '#fff', color: '#1f6feb', fontWeight: 700, fontFamily: 'inherit', fontSize: 15,
          opacity: busyNow ? 0.6 : 1,
        }}
      >{busyNow ? 'After the payment' : 'Update now'}</button>
    </div>
  );
}
