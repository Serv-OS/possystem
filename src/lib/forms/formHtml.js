// src/lib/forms/formHtml.js
//
// Marketing forms (5.12.37): the ONE markup of a form, as a plain string. The website builder's
// server renderer (src/surfaces/website/ssr/renderBlocks.js), the hosted form page behind the embed
// (api/form.js) and the React Form block (src/surfaces/website/blocks/components/FormBlock.jsx,
// same class names) all paint this, so a form looks the same wherever it is.
//
// No JavaScript needed (customer facing never fails): it is a real <form method="post"> straight
// to the form-submit function, which sends the browser back to `returnTo` with ?form_sent= or
// ?form_error= (the page then paints the thank you words or the error line). With JavaScript the
// page sends it with fetch instead and swaps in the thank you words (enhanceScript below).
// Colours are the site's --w-* variables (theme.js siteVars, from the venue Appearance), never a
// literal colour: Peter's rule, customer screens follow the venue branding.
// Plain JS, no DOM, no React: api/*.js imports it in Node.

import { HONEYPOT_FIELD, KIND_LABELS } from '../../../supabase/functions/_shared/formRules.js';

export const FCN = Object.freeze({
  wrap: 'w-form', title: 'w-form-title', sub: 'w-form-sub', form: 'w-form-form', field: 'w-form-field',
  label: 'w-form-label', input: 'w-form-input', req: 'w-form-req', tick: 'w-form-tick', consent: 'w-form-consent',
  hp: 'w-form-hp', error: 'w-form-error', fieldError: 'w-form-field-error', thanks: 'w-form-thanks', submit: 'w-form-submit',
});

const esc = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const AUTOCOMPLETE = { first_name: 'given-name', last_name: 'family-name', email: 'email', phone: 'tel', birthday: 'bday' };
const INPUT_TYPE = { email: 'email', phone: 'tel', birthday: 'date' };

/** The submit address of the form-submit function for an Ops project URL. */
export function submitUrl(opsUrl) {
  const base = String(opsUrl || '').replace(/\/$/, '');
  return base ? `${base}/functions/v1/form-submit` : '';
}

/** The DOM id a form's wrapper takes on a page (the #form-<id> a plain post comes back to). */
export const formDomId = (formId) => `form-${String(formId || '').replace(/[^a-zA-Z0-9-]/g, '')}`;

function fieldHtml(form, f, errors) {
  const id = `${formDomId(form.id)}-${f.id}`;
  const label = esc(f.label || KIND_LABELS[f.kind] || f.id);
  const req = f.required ? ` <span class="${FCN.req}" aria-hidden="true">*</span>` : '';
  const reqAttr = f.required ? ' required aria-required="true"' : '';
  const err = errors && errors[f.id] ? `<span class="${FCN.fieldError}" id="${id}-err">${esc(errors[f.id])}</span>` : '';
  const desc = err ? ` aria-invalid="true" aria-describedby="${id}-err"` : '';
  if (f.kind === 'tickbox') {
    return `<div class="${FCN.field} ${FCN.tick}"><label for="${id}"><input type="checkbox" id="${id}" name="${esc(f.id)}" value="on"${reqAttr}${desc}> <span>${label}${req}</span></label>${err}</div>`;
  }
  let control;
  if (f.kind === 'dropdown') {
    const opts = (Array.isArray(f.options) ? f.options : []).map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join('');
    control = `<select class="${FCN.input}" id="${id}" name="${esc(f.id)}"${reqAttr}${desc}><option value="">Choose</option>${opts}</select>`;
  } else if (f.kind === 'text' && f.long) {
    control = `<textarea class="${FCN.input}" id="${id}" name="${esc(f.id)}" rows="4" maxlength="1000"${reqAttr}${desc}></textarea>`;
  } else {
    const type = INPUT_TYPE[f.kind] || 'text';
    const ac = AUTOCOMPLETE[f.kind] ? ` autocomplete="${AUTOCOMPLETE[f.kind]}"` : '';
    const max = f.kind === 'birthday' ? '' : ` maxlength="${f.kind === 'email' ? 200 : 120}"`;
    const inputmode = f.kind === 'phone' ? ' inputmode="tel"' : '';
    control = `<input class="${FCN.input}" type="${type}" id="${id}" name="${esc(f.id)}"${ac}${max}${inputmode}${reqAttr}${desc}>`;
  }
  return `<div class="${FCN.field}"><label class="${FCN.label}" for="${id}">${label}${req}</label>${control}${err}</div>`;
}

/**
 * The form as HTML. form: the public form ({ id, fields, consent_enabled, consent_text,
 * submit_label, thanks_text }). opts:
 *   action    the form-submit URL (submitUrl(opsUrl))
 *   returnTo  the page to come back to after a plain post (absolute URL)
 *   source    'website' | 'embed' | 'hosted'
 *   title, sub  optional heading and line under it (the website block's own words)
 *   sent      true = paint the thank you words instead of the form
 *   error     one line of words to show above the form (from ?form_error=)
 * A missing or empty form paints `emptyText` (or nothing): never a crash.
 */
export function formHtml(form, opts = {}) {
  const { action = '', returnTo = '', source = 'website', title = '', sub = '', sent = false, error = '', emptyText = '' } = opts;
  if (!form || !form.id || !Array.isArray(form.fields) || !form.fields.length) {
    return emptyText ? `<p class="${FCN.thanks}">${esc(emptyText)}</p>` : '';
  }
  const dom = formDomId(form.id);
  const head = `${title ? `<h2 class="${FCN.title}">${esc(title)}</h2>` : ''}${sub ? `<p class="${FCN.sub}">${esc(sub)}</p>` : ''}`;
  if (sent) {
    return `<div class="${FCN.wrap}" id="${dom}" data-form="${esc(form.id)}">${head}<p class="${FCN.thanks}" role="status">${esc(form.thanks_text || 'Thank you.')}</p></div>`;
  }
  const errLine = error ? `<p class="${FCN.error}" role="alert">${esc(error)}</p>` : '<p class="' + FCN.error + '" role="alert" hidden></p>';
  const fields = form.fields.map((f) => fieldHtml(form, f, opts.errors)).join('');
  const consent = form.consent_enabled !== false
    ? `<div class="${FCN.field} ${FCN.tick} ${FCN.consent}"><label for="${dom}-consent"><input type="checkbox" id="${dom}-consent" name="consent" value="on"> <span>${esc(form.consent_text || '')}</span></label></div>`
    : '';
  // The honeypot: off screen, out of the tab order, hidden from screen readers. People never fill it.
  const hp = `<div class="${FCN.hp}" aria-hidden="true"><label for="${dom}-hp">Leave this empty</label><input type="text" id="${dom}-hp" name="${HONEYPOT_FIELD}" tabindex="-1" autocomplete="off"></div>`;
  const hidden = `<input type="hidden" name="form_id" value="${esc(form.id)}"><input type="hidden" name="return_to" value="${esc(returnTo)}"><input type="hidden" name="source" value="${esc(source)}">`;
  return `<div class="${FCN.wrap}" id="${dom}" data-form="${esc(form.id)}">${head}${errLine}`
    + `<form class="${FCN.form}" method="post" action="${esc(action)}" data-servos-form="${esc(form.id)}" novalidate>`
    + `${hidden}${fields}${consent}${hp}<button type="submit" class="w-btn w-btn-primary ${FCN.submit}">${esc(form.submit_label || 'Send')}</button></form></div>`;
}

/** The form CSS: --w-* variables only (the site's theme or the hosted page's), phone first. */
export const FORM_CSS = `
.${FCN.wrap}{max-width:560px;scroll-margin-top:110px}
.${FCN.title}{margin:0 0 .3em}
.${FCN.sub}{color:var(--w-muted);margin:0 0 1em}
.${FCN.form}{display:flex;flex-direction:column;gap:14px}
.${FCN.field}{display:flex;flex-direction:column;gap:6px}
.${FCN.label}{font-weight:600;font-size:.95rem}
.${FCN.req}{color:var(--w-brand)}
.${FCN.input}{width:100%;min-height:46px;padding:10px 14px;border:1.5px solid var(--w-line);border-radius:12px;background:var(--w-card);color:var(--w-ink);font:inherit;font-size:1rem}
.${FCN.input}:focus{outline:2px solid var(--w-brand);outline-offset:1px;border-color:var(--w-brand)}
textarea.${FCN.input}{min-height:110px;resize:vertical}
.${FCN.tick} label{display:flex;gap:10px;align-items:flex-start;font-size:.95rem;cursor:pointer}
.${FCN.tick} input{width:20px;height:20px;margin:2px 0 0;flex:none;accent-color:var(--w-brand)}
.${FCN.consent}{color:var(--w-muted)}
.${FCN.hp}{position:absolute !important;left:-10000px !important;width:1px;height:1px;overflow:hidden}
.${FCN.error}{margin:0 0 12px;padding:10px 14px;border-radius:12px;border:1.5px solid var(--w-brand);background:var(--w-card);font-weight:600}
.${FCN.fieldError}{font-size:.85rem;font-weight:600;color:var(--w-brand)}
.${FCN.thanks}{margin:0;padding:18px;border-radius:14px;background:var(--w-card);border:1px solid var(--w-line);font-weight:600}
.${FCN.submit}{align-self:flex-start;min-width:140px;display:inline-flex;align-items:center;justify-content:center;min-height:46px;padding:10px 20px;border-radius:var(--w-radius);border:1.5px solid var(--w-brand);background:var(--w-brand);color:var(--w-on-brand);font:inherit;font-weight:600;cursor:pointer}
.${FCN.submit}:hover{background:var(--w-brand-deep);border-color:var(--w-brand-deep)}
.${FCN.submit}[disabled]{opacity:.6;cursor:progress}
`;

/**
 * The fetch enhancement as a small inline script (the hosted page and the server rendered site use
 * it; the React block does the same in JSX). Every form with data-servos-form posts JSON with
 * fetch; on success the thank you words replace the form, on refusal the error line shows. If
 * fetch fails for any reason the plain post goes ahead, so the person is never stuck.
 * onDone(name) is an optional global function name called after a change (the hosted page uses it
 * to tell the parent page its new height).
 */
export function enhanceScript({ onChange = '' } = {}) {
  const notify = onChange ? `try{window[${JSON.stringify(onChange)}]&&window[${JSON.stringify(onChange)}]()}catch(e){}` : '';
  return `(function(){if(!window.fetch||!window.FormData)return;var forms=document.querySelectorAll('form[data-servos-form]');Array.prototype.forEach.call(forms,function(f){if(f.__sv)return;f.__sv=1;f.addEventListener('submit',function(ev){if(f.__plain)return;ev.preventDefault();var wrap=f.parentNode;var err=wrap.querySelector('.${FCN.error}');var btn=f.querySelector('button[type=submit]');var data={};var fd=new FormData(f);fd.forEach(function(v,k){data[k]=v});if(btn)btn.disabled=true;fetch(f.action,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)}).then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j}})}).then(function(x){if(x.ok&&x.j&&x.j.ok){var p=document.createElement('p');p.className='${FCN.thanks}';p.setAttribute('role','status');p.textContent=x.j.thanks||'Thank you.';f.parentNode.replaceChild(p,f);if(err)err.hidden=true;${notify}return}if(btn)btn.disabled=false;if(err){err.textContent=(x.j&&x.j.error)||'Something went wrong. Please try again.';err.hidden=false}${notify}}).catch(function(){f.__plain=1;f.submit()})})})})();`;
}
