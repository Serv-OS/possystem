import { useEffect } from 'react';

// Auto-update for UNATTENDED kiosk surfaces (host stand / waitlist, KDS, menu board, ops, clock).
//
// There is NO service worker in this app (sw.js exists in public/ but is never registered), so a
// stale screen comes from the browser/webview HTTP cache or a locked device that simply never gets
// reloaded. Those screens have no one to tap an "update" prompt, so they can sit on an old build
// indefinitely (this is what made the waitlist look broken — the tablet ran pre-fix code for ages).
//
// Fix: poll the live index.html for the entry-bundle hash and hard-reload when a NEW build is
// deployed. Deliberately NOT mounted on customer-cart surfaces (kiosk self-order, customer display)
// or attended ones (POS / back office) so we never reload away an in-progress order or a staff task.
//
// Safety: only reloads when BOTH the running and deployed entry filenames parse AND differ; a
// sessionStorage gate caps reloads to once per 10 min so a CDN/caching hiccup can't loop. In dev
// (no hashed bundle) it self-disables.

const CHECK_MS = 10 * 60 * 1000;          // poll every 10 min
const MIN_RELOAD_GAP_MS = 10 * 60 * 1000; // never auto-reload more than once per 10 min (loop guard)

function entryFile(src) {
  if (!src) return null;
  const m = String(src).split('?')[0].match(/index-[A-Za-z0-9_-]+\.js$/);
  return m ? m[0] : null;
}
function loadedEntryFile() {
  for (const s of document.querySelectorAll('script[type="module"][src]')) {
    const f = entryFile(s.getAttribute('src'));
    if (f) return f;
  }
  return null;
}
async function deployedEntryFile() {
  const res = await fetch('/?_cv=' + Date.now(), { cache: 'no-store' });
  if (!res.ok) return null;
  const html = await res.text();
  const m = html.match(/index-[A-Za-z0-9_-]+\.js/);
  return m ? m[0] : null;
}

export default function KioskAutoUpdate() {
  useEffect(() => {
    if (typeof window === 'undefined' || typeof fetch !== 'function') return;
    const mine = loadedEntryFile();
    if (!mine) return; // dev / unknown build structure — do nothing

    let stopped = false;
    const check = async () => {
      try {
        const live = await deployedEntryFile();
        if (stopped || !live || live === mine) return;
        const last = Number(sessionStorage.getItem('kiosk-au-last') || 0);
        if (Date.now() - last < MIN_RELOAD_GAP_MS) return; // loop guard
        sessionStorage.setItem('kiosk-au-last', String(Date.now()));
        console.warn(`[KioskAutoUpdate] new build ${live} (running ${mine}) — reloading`);
        window.location.reload();
      } catch { /* offline / transient — retry next tick */ }
    };

    const t0 = setTimeout(check, 30_000);     // shortly after mount: catches a device left open across a deploy
    const t = setInterval(check, CHECK_MS);
    return () => { stopped = true; clearTimeout(t0); clearInterval(t); };
  }, []);
  return null;
}
