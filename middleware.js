// middleware.js (Vercel Edge Middleware, repo root)
//
// 5.12.7: the home page of a venue website. Vercel serves a static file before it looks at the
// rewrites in vercel.json, and the SPA's own /index.html sits at "/", so "/" on a website host
// (posup-test.sites.serv-os.app) came back as the bare app shell: no server rendered page, no
// title for Google, and the shell's css pinned the page so it would not scroll. Every other path
// already reached api/site.js through the rewrites. This runs before the filesystem and sends
// "/" (and "/index.html") on a website host to api/site.js; every other host and path is left
// exactly as it was. Any error here means "do nothing", never a broken page.

export const config = { matcher: ['/', '/index.html'] };

// The same host rule as vercel.json: a free site host, or a host that is not one of our own.
const OWN_HOST = /(^|\.)(serv-os\.app|servos\.app|pos-up\.com|vercel\.app|localhost)$/i;
const FREE_SITE = /^[a-z0-9-]+\.sites\.serv-os\.app$/i;

/** True when a request host is a venue website (free address or a venue's own domain). */
export function isWebsiteHost(host) {
  const h = String(host || '').split(',')[0].trim().toLowerCase().replace(/:\d+$/, '');
  if (!h) return false;
  if (FREE_SITE.test(h)) return h !== 'www.sites.serv-os.app';
  return !OWN_HOST.test(h);
}

/** The rewrite answer for a request, or null to let Vercel carry on as before. */
export function rewriteFor(url, host) {
  try {
    if (!isWebsiteHost(host)) return null;
    const u = new URL(url);
    if (u.pathname !== '/' && u.pathname !== '/index.html') return null;
    const dest = new URL('/api/site', u.origin);
    dest.searchParams.set('path', '/');
    for (const [k, v] of u.searchParams) if (k !== 'path') dest.searchParams.set(k, v);
    return dest.toString();
  } catch {
    return null;
  }
}

export default function middleware(request) {
  try {
    const host = request.headers.get('x-forwarded-host') || request.headers.get('host') || new URL(request.url).hostname;
    const dest = rewriteFor(request.url, host);
    if (!dest) return undefined;
    // The documented rewrite shape (what @vercel/edge's rewrite() builds): Vercel serves `dest`
    // for this request without a redirect.
    return new Response(null, { headers: { 'x-middleware-rewrite': dest } });
  } catch {
    return undefined;
  }
}
