// supabase/functions/_shared/marketingLinks.js (6 Nov 2026, marketing v3). PURE, no imports: node
// tests load it directly and marketing-send, the batch sender and marketing-webhook share one rule.
//
// Peter: "be able to find out if someone has clicked on links from email campaigns". Every link in
// a campaign email is swapped for a signed redirect on marketing-webhook (?action=click) that writes
// one marketing_link_clicks row (campaign, customer, link, time), moves the message to 'clicked'
// (once; the provider's own click event moves the same status, never a second count) and then sends
// the person on. The destination gets utm tags and the message token (sv_m) so the website visit
// report can say "this visit came from that campaign".
//
// Links that are NEVER wrapped: the unsubscribe and preference links (they must keep working if the
// click table is ever down), mailto:, tel:, sms:, anchors (#) and merge tags left in a href.

const SKIP_RE = /^(mailto:|tel:|sms:|#|\{\{)/i;

/** Every distinct http(s) href in the html, in document order. */
export function collectHrefs(html) {
  const out = [];
  const seen = new Set();
  const re = /<a\b[^>]*?\bhref\s*=\s*("([^"]*)"|'([^']*)')/gi;
  let m;
  while ((m = re.exec(String(html || '')))) {
    const href = decodeEntities(m[2] != null ? m[2] : m[3] || '');
    if (!isTrackable(href) || seen.has(href)) continue;
    seen.add(href);
    out.push(href);
  }
  return out;
}

export function isTrackable(href, skipBases = []) {
  const h = String(href || '').trim();
  if (!h || SKIP_RE.test(h)) return false;
  if (!/^https?:\/\//i.test(h)) return false;
  for (const b of skipBases) if (b && h.startsWith(b)) return false;
  return true;
}

function decodeEntities(s) {
  return String(s).replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}
function encodeEntities(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

/** The redirect url for one link of one message. token = HMAC over `${messageId}:${url}` (first 32 hex). */
export function trackedUrl(base, messageId, url, token) {
  return `${String(base).replace(/\/$/, '')}?action=click&m=${encodeURIComponent(messageId)}&u=${encodeURIComponent(url)}&t=${encodeURIComponent(token)}`;
}

/** The string the token signs. One place, so the sender and the webhook can never drift. */
export function clickSignText(messageId, url) {
  return `click:${messageId}:${url}`;
}

/**
 * Swap every trackable href for its redirect. `redirects` maps original href -> redirect url
 * (built by the caller from collectHrefs + trackedUrl, because signing is async in Deno).
 * Hrefs not in the map (unsubscribe, preferences, mailto, anchors) stay as they are.
 */
export function wrapTrackedLinks(html, redirects) {
  if (!html || !redirects || typeof redirects.get !== 'function' && typeof redirects !== 'object') return html || '';
  const lookup = (h) => (typeof redirects.get === 'function' ? redirects.get(h) : redirects[h]);
  return String(html).replace(/(<a\b[^>]*?\bhref\s*=\s*)("([^"]*)"|'([^']*)')/gi, (whole, pre, quoted, dq, sq) => {
    const raw = dq != null ? dq : sq || '';
    const href = decodeEntities(raw);
    const to = lookup(href);
    if (!to) return whole;
    const q = quoted[0];
    return `${pre}${q}${encodeEntities(to)}${q}`;
  });
}

/**
 * Where the click lands: the original url plus utm tags (only the ones it lacks) and sv_m, the
 * message token the website visit ping reports back. Never touches a url that cannot be parsed.
 */
export function campaignDestination(url, { campaignId = null, messageId = null, source = 'servos', medium = 'email' } = {}) {
  let u;
  try { u = new URL(String(url)); } catch { return String(url || ''); }
  if (!/^https?:$/.test(u.protocol)) return String(url);
  const set = (k, v) => { if (v && !u.searchParams.has(k)) u.searchParams.set(k, String(v)); };
  set('utm_source', source);
  set('utm_medium', medium);
  if (campaignId) set('utm_campaign', campaignId);
  if (messageId) set('sv_m', messageId);
  return u.toString();
}

/** A click is only honoured for a url the message really carried: same string, same signature. */
export function clickParamsOk(params) {
  const m = String(params?.m || '');
  const u = String(params?.u || '');
  const t = String(params?.t || '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(m)) return { ok: false, reason: 'bad message id' };
  if (!isTrackable(u)) return { ok: false, reason: 'bad url' };
  if (!/^[0-9a-f]{32}$/i.test(t)) return { ok: false, reason: 'bad token' };
  if (u.length > 2048) return { ok: false, reason: 'url too long' };
  return { ok: true, messageId: m, url: u, token: t.toLowerCase() };
}

/** The link as the email author wrote it: the sv_m token and the utm tags this module added taken off. */
export function plainUrl(url) {
  let u;
  try { u = new URL(String(url)); } catch { return String(url || ''); }
  if (u.searchParams.get('utm_source') === 'servos') {
    u.searchParams.delete('utm_source');
    u.searchParams.delete('utm_medium');
    u.searchParams.delete('utm_campaign');
  }
  u.searchParams.delete('sv_m');
  let out = u.toString();
  if (out.endsWith('?')) out = out.slice(0, -1);
  return out;
}
