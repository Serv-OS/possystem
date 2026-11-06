// src/surfaces/website/visitPing.js (6 Nov 2026, 5.12.67)
//
// Peter: "website traffic reports". One small POST per page view from the venue's own website to
// the website-visit function: the host, the page, the referring page's host, the utm tags and the
// sv_m token a tracked email link carried. Nothing is stored in the browser: no cookie, no local
// storage, so no banner is needed; the server makes a visitor key that changes every day.
// Off when the owner switches visits off (settings.analytics_enabled false), on a draft preview,
// and in the editor. Plain JS so the payload rule is testable.

export const PING_PATH = '/functions/v1/website-visit';

/** True when this site and this render should report a view. */
export function shouldPing({ snapshot, preview = false, editor = false } = {}) {
  if (preview || editor || !snapshot) return false;
  const s = snapshot.site && snapshot.site.settings;
  return !(s && s.analytics_enabled === false);
}

/** The body for one page view. `loc` is window.location, `referrer` document.referrer. */
export function pingPayload({ loc, referrer = '', path = null } = {}) {
  if (!loc) return null;
  const host = String(loc.hostname || '').toLowerCase();
  if (!host) return null;
  let q;
  try { q = new URLSearchParams(loc.search || ''); } catch { q = new URLSearchParams(); }
  const take = (k) => { const v = q.get(k); return v ? String(v).slice(0, 120) : undefined; };
  const body = { host, path: String(path || loc.pathname || '/').slice(0, 512) };
  const ref = String(referrer || '').slice(0, 1024);
  if (ref) body.referrer = ref;
  const us = take('utm_source'), um = take('utm_medium'), uc = take('utm_campaign'), svm = take('sv_m');
  if (us) body.utm_source = us;
  if (um) body.utm_medium = um;
  if (uc) body.utm_campaign = uc;
  if (svm) body.sv_m = svm;
  return body;
}

/** Send it, fire and forget. Returns true when something was sent. */
export function sendPing(opsUrl, body) {
  if (!opsUrl || !body || typeof fetch !== 'function') return false;
  const url = String(opsUrl).replace(/\/$/, '') + PING_PATH;
  try {
    fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), keepalive: true, credentials: 'omit' }).catch(() => {});
    return true;
  } catch { return false; }
}
