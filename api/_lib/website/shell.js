// api/_lib/website/shell.js
//
// The SPA shell for the server rendered site (ARCHITECTURE.md section 4 step 6). api/site.js
// fetches the deployment's own /index.html (so the script tags point at THIS deployment's hashed
// bundles), keeps it in module scope for 5 minutes, and injects the rendered head and body into
// it. The deployment URL (x-vercel-deployment-url, a *.vercel.app host) is never a website host,
// so the fetch cannot loop back into this function. Pure helpers, tested with a fake fetch.

export const SHELL_TTL_MS = 5 * 60 * 1000;
const cache = new Map(); // deploymentUrl → { html, at }

export function _resetShellCache() { cache.clear(); }

/** The deployment's index.html, cached per deployment URL for SHELL_TTL_MS. null on any failure. */
export async function getShell(deploymentUrl, { fetchImpl = globalThis.fetch, now = Date.now(), timeoutMs = 4000 } = {}) {
  const dep = String(deploymentUrl || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  if (!dep || typeof fetchImpl !== 'function') return null;
  const hit = cache.get(dep);
  if (hit && now - hit.at < SHELL_TTL_MS) return hit.html;
  try {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const t = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
    let res;
    try { res = await fetchImpl(`https://${dep}/index.html`, { headers: { accept: 'text/html' }, ...(ctl ? { signal: ctl.signal } : {}) }); }
    finally { if (t) clearTimeout(t); }
    if (!res || !res.ok) return hit ? hit.html : null;
    const html = await res.text();
    if (!/<div id="root">/.test(html) || !/<\/head>/.test(html)) return hit ? hit.html : null;
    cache.set(dep, { html, at: now });
    return html;
  } catch {
    return hit ? hit.html : null;
  }
}

/** Serialise the boot payload the SPA reads (window.__SERVOS_SITE__), safe inside <script>. */
export function bootScript(payload) {
  return `<script>window.__SERVOS_SITE__=${JSON.stringify(payload).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')}</script>`;
}

/**
 * Put `head` before </head>, `body` inside <div id="root"></div> and `boot` right after it.
 * The shell's own <title> and description are removed so the page carries one of each.
 */
// 5.12.5: the SPA's global stylesheet pins html, body and #root to the viewport with overflow
// hidden (the till scrolls inside its own panes). A public website must scroll like a web page,
// so the shell carries this reset after the SPA's own styles. Kept out of SITE_CSS on purpose:
// that string is also mounted inside the Back Office preview, where the app's pinning must stay.
export const SHELL_RESET_CSS = 'html,body,#root{overflow:auto !important;height:auto !important;min-height:100%;position:static !important}body{overscroll-behavior:auto}';
export const SHELL_RESET_TAG = `<style id="w-shell-reset">${SHELL_RESET_CSS}</style>`;

export function injectShell(shellHtml, { head = '', body = '', boot = '' } = {}) {
  let html = String(shellHtml || '');
  html = html.replace(/<title>[\s\S]*?<\/title>/i, '').replace(/<meta name="description"[^>]*>/i, '');
  html = html.replace(/<\/head>/i, `${SHELL_RESET_TAG}${head}\n</head>`);
  html = html.replace(/<div id="root"><\/div>/i, `<div id="root">${body}</div>${boot}`);
  return html;
}
