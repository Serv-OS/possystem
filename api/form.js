// api/form.js: the hosted marketing form (5.12.36) behind the embed snippet.
//
//   GET /api/form?id=<form id>            the form as a whole, server rendered page: works with no
//                                         JavaScript (a real post to form-submit, which sends the
//                                         browser back here with ?form_sent= or ?form_error=).
//   GET /api/form?script=1&id=<form id>   the small loader script the snippet's <script> tag pulls:
//                                         it drops an iframe of the page above into the outside site
//                                         and grows it to fit (postMessage from this page, checked
//                                         against this origin). The snippet's <noscript> holds a
//                                         plain iframe for a browser with JavaScript off.
// Themed from the venue Appearance (online_branding of the form's venue, else the company's first)
// through the website builder's siteVars, so it matches the venue's other customer screens.
// noindex: the form page is a part of other pages, never a page of its own in Google.
// Customer facing never fails: every failure answers a readable page, never a stack trace.

import { createClient } from '@supabase/supabase-js';
import { platformEnv, opsEnv } from './_lib/website/env.js';
import { formHtml, submitUrl, enhanceScript, FORM_CSS, formDomId } from '../src/lib/forms/formHtml.js';
import { formStateFrom } from '../src/lib/forms/formRules.js';
import { siteVars, cssText, fontLinks } from '../src/surfaces/website/theme.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

let clients = null;
function getClients() {
  if (clients) return clients;
  const plat = platformEnv(), ops = opsEnv();
  const opts = { auth: { persistSession: false, autoRefreshToken: false } };
  clients = {
    platform: plat.url && plat.anon ? createClient(plat.url, plat.anon, opts) : null,
    ops: ops.url && ops.anon ? createClient(ops.url, ops.anon, opts) : null,
    opsUrl: ops.url,
  };
  return clients;
}

/** The loader script for one form, served from `origin`. Plain ES5 so any site's browser runs it. */
export function loaderScript(formId, origin) {
  const id = JSON.stringify(String(formId));
  const o = JSON.stringify(String(origin).replace(/\/$/, ''));
  return `(function(){var id=${id},origin=${o};var s=document.currentScript;var box=document.getElementById('servos-form-'+id);`
    + `if(box&&box.getAttribute('data-ready'))return;var f=document.createElement('iframe');f.src=origin+'/api/form?embed=1&id='+id;f.title='Form';`
    + `f.setAttribute('loading','lazy');f.style.cssText='display:block;width:100%;max-width:560px;height:640px;border:0;background:transparent';`
    + `if(box){box.setAttribute('data-ready','1');box.appendChild(f)}else if(s&&s.parentNode){s.parentNode.insertBefore(f,s)}`
    + `window.addEventListener('message',function(e){if(e.origin!==origin)return;var d=e.data;`
    + `if(d&&d.type==='servos-form-height'&&d.id===id&&d.height>0){f.style.height=Math.min(4000,Math.ceil(d.height))+'px'}`
    + `if(d&&d.type==='servos-form-scroll'&&d.id===id&&f.scrollIntoView){f.scrollIntoView({block:'nearest'})}});})();`;
}

/** The hosted page as a whole HTML document. Pure (tests call it with a form and branding). */
export function hostedPage({ form, branding, venueName = '', origin = '', action = '', state = {}, embed = false }) {
  const vars = siteVars({}, branding || {});
  const fonts = fontLinks({}).map((h) => `<link rel="stylesheet" href="${esc(h)}">`).join('');
  const self = `${origin}/api/form?${embed ? 'embed=1&' : ''}id=${form ? form.id : ''}`;
  const body = form
    ? formHtml(form, { action, returnTo: self, source: embed ? 'embed' : 'hosted', title: embed ? '' : form.name, sent: state.sent === form.id, error: state.errorFor === form.id ? state.error : '' })
    : '<p class="w-form-thanks">This form is not available.</p>';
  const logo = !embed && branding && branding.logo_url ? `<img class="hf-logo" src="${esc(branding.logo_url)}" alt="${esc(venueName)}">` : '';
  const brandLine = !embed && venueName ? `<div class="hf-venue">${logo}<span>${esc(venueName)}</span></div>` : '';
  // The height the parent page needs, after every change (the loader listens for this origin only).
  const height = form ? `window.__svH=function(){try{var h=Math.ceil(document.body.getBoundingClientRect().height)+2;parent.postMessage({type:'servos-form-height',id:${JSON.stringify(form.id)},height:h},'*')}catch(e){}};`
    + `window.addEventListener('load',__svH);window.addEventListener('resize',__svH);setTimeout(__svH,50);` : '';
  const scripts = form && !state.sent ? `<script>${height}${enhanceScript({ onChange: '__svH' })}</script>` : (form ? `<script>${height}</script>` : '');
  const title = form ? `${form.name}${venueName ? ` | ${venueName}` : ''}` : 'Form';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">`
    + `<title>${esc(title)}</title><meta name="robots" content="noindex, nofollow">`
    + `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>${fonts}`
    + `<style>${cssText(vars)}</style>`
    + `<style>html,body{margin:0;background:${embed ? 'transparent' : 'var(--w-bg)'};color:var(--w-ink);font-family:var(--w-font-body);line-height:1.5;-webkit-font-smoothing:antialiased}`
    + `*,*::before,*::after{box-sizing:border-box}.hf{max-width:600px;margin:0 auto;padding:${embed ? '4px' : '32px 16px'}}`
    + `.hf h2{font-family:var(--w-font-display);font-size:1.6rem;line-height:1.15}.hf-venue{display:flex;align-items:center;gap:10px;margin:0 0 18px;font-family:var(--w-font-display);font-weight:700}`
    + `.hf-logo{height:40px;width:auto;max-width:160px;object-fit:contain}`
    + `${FORM_CSS}</style></head>`
    + `<body><main class="hf" id="${form ? formDomId(form.id) : 'form'}-page">${brandLine}${body}</main>${scripts}</body></html>`;
}

function send(res, status, type, body, cache) {
  res.statusCode = status;
  res.setHeader('Content-Type', type);
  res.setHeader('Cache-Control', cache);
  res.end(body);
}

export default async function handler(req, res) {
  const url = new URL(req.url || '/', 'https://x.invalid');
  const id = String(url.searchParams.get('id') || '').toLowerCase();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  const proto = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host) ? 'http' : 'https';
  const origin = host ? `${proto}://${host}` : '';
  try {
    if (url.searchParams.get('script')) {
      if (!UUID_RE.test(id)) return send(res, 404, 'application/javascript; charset=utf-8', '/* no form */', 'no-store');
      return send(res, 200, 'application/javascript; charset=utf-8', loaderScript(id, origin), 'public, max-age=300');
    }
    const { platform, ops, opsUrl } = getClients();
    const state = formStateFrom(url.search);
    const embed = url.searchParams.get('embed') === '1';
    let form = null, branding = null, venueName = '';
    if (UUID_RE.test(id) && ops) {
      const { data } = await ops.rpc('marketing_form_public', { p_form_id: id, p_location_ids: null });
      form = data && data.id ? data : null;
    }
    if (form && form.brand_location_id && platform) {
      try {
        const loc = String(form.brand_location_id);
        const { data } = await platform.from('locations').select('name, online_branding').or(`ops_location_id.eq.${loc},id.eq.${loc}`).limit(1).maybeSingle();
        branding = (data && data.online_branding) || null;
        venueName = (branding && branding.display_name) || (data && data.name) || '';
      } catch { /* the default palette */ }
    }
    const html = hostedPage({ form, branding, venueName, origin, action: submitUrl(opsUrl), state, embed });
    const fresh = state.sent || state.errorFor;
    return send(res, form ? 200 : 404, 'text/html; charset=utf-8', html, fresh || !form ? 'no-store' : 'public, s-maxage=30, stale-while-revalidate=120');
  } catch (e) {
    console.error('[api/form]', e && e.message);
    return send(res, 500, 'text/html; charset=utf-8', hostedPage({ form: null, origin }), 'no-store');
  }
}
