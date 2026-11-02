// src/surfaces/website/blocks/components/FormBlock.jsx
//
// 5.12.36 Marketing forms: the Form block in the browser and in the Back Office editor. The same
// markup and class names as the server's formHtml (src/lib/forms/formHtml.js), so React replaces
// the server form without a jump. It is still a real <form method="post">: with JavaScript it
// sends JSON with fetch and swaps in the thank you words; if fetch fails it lets the plain post go,
// so the person is never stuck. Colours are the site's --w-* variables only.

import { useState } from 'react';
import { CN } from '../classNames.js';
import { useSite } from '../../siteContext.js';
import { useNested } from '../nested.js';
import { FCN, formDomId } from '../../../../lib/forms/formHtml.js';
import { HONEYPOT_FIELD, KIND_LABELS, formStateFrom } from '../../../../lib/forms/formRules.js';

const cls = (...xs) => xs.filter(Boolean).join(' ');
const AUTOCOMPLETE = { first_name: 'given-name', last_name: 'family-name', email: 'email', phone: 'tel', birthday: 'bday' };
const INPUT_TYPE = { email: 'email', phone: 'tel', birthday: 'date' };

function readState() {
  try { return formStateFrom(typeof window !== 'undefined' ? window.location.search : ''); } catch { return { sent: null, errorFor: null, error: '' }; }
}

function Field({ form, f, error }) {
  const id = `${formDomId(form.id)}-${f.id}`;
  const label = f.label || KIND_LABELS[f.kind] || f.id;
  const req = f.required ? <> <span className={FCN.req} aria-hidden="true">*</span></> : null;
  const a11y = { required: f.required || undefined, 'aria-required': f.required ? 'true' : undefined, 'aria-invalid': error ? 'true' : undefined, 'aria-describedby': error ? `${id}-err` : undefined };
  const err = error ? <span className={FCN.fieldError} id={`${id}-err`}>{error}</span> : null;
  if (f.kind === 'tickbox') {
    return <div className={cls(FCN.field, FCN.tick)}><label htmlFor={id}><input type="checkbox" id={id} name={f.id} value="on" {...a11y} /> <span>{label}{req}</span></label>{err}</div>;
  }
  let control;
  if (f.kind === 'dropdown') {
    control = <select className={FCN.input} id={id} name={f.id} defaultValue="" {...a11y}><option value="">Choose</option>{(f.options || []).map((o) => <option key={o} value={o}>{o}</option>)}</select>;
  } else if (f.kind === 'text' && f.long) {
    control = <textarea className={FCN.input} id={id} name={f.id} rows={4} maxLength={1000} {...a11y} />;
  } else {
    control = <input className={FCN.input} type={INPUT_TYPE[f.kind] || 'text'} id={id} name={f.id} autoComplete={AUTOCOMPLETE[f.kind]} maxLength={f.kind === 'birthday' ? undefined : (f.kind === 'email' ? 200 : 120)} inputMode={f.kind === 'phone' ? 'tel' : undefined} {...a11y} />;
  }
  return <div className={FCN.field}><label className={FCN.label} htmlFor={id}>{label}{req}</label>{control}{err}</div>;
}

/** The form itself (also used by the Back Office preview). `preview` = never sends. */
export function ServosForm({ form, action, title, sub, source = 'website', preview = false }) {
  const [initial] = useState(readState);
  const [state, setState] = useState(() => ({
    sent: !preview && initial.sent === form.id,
    error: !preview && initial.errorFor === form.id ? initial.error : '',
    errors: {}, busy: false, thanks: form.thanks_text || 'Thank you.',
  }));
  const dom = formDomId(form.id);
  const returnTo = typeof window !== 'undefined' ? window.location.href.split('#')[0] : '';
  const head = <>{title ? <h2 className={FCN.title}>{title}</h2> : null}{sub ? <p className={FCN.sub}>{sub}</p> : null}</>;
  if (state.sent) return <div className={FCN.wrap} id={dom} data-form={form.id}>{head}<p className={FCN.thanks} role="status">{state.thanks}</p></div>;

  const onSubmit = async (ev) => {
    const el = ev.currentTarget;
    if (preview) { ev.preventDefault(); return; }
    if (el.dataset.plain === '1' || typeof fetch !== 'function') return;   // the plain post goes ahead
    ev.preventDefault();
    const data = {};
    new FormData(el).forEach((v, k) => { data[k] = v; });
    setState((s) => ({ ...s, busy: true, error: '' }));
    try {
      const r = await fetch(el.action, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.ok) { setState((s) => ({ ...s, sent: true, busy: false, thanks: j.thanks || s.thanks })); return; }
      setState((s) => ({ ...s, busy: false, error: j.error || 'Something went wrong. Please try again.', errors: j.errors || {} }));
    } catch {
      // Could not reach the server with fetch: the plain post still might (no CORS, no script).
      el.dataset.plain = '1';
      el.submit();
    }
  };

  return (
    <div className={FCN.wrap} id={dom} data-form={form.id}>
      {head}
      <p className={FCN.error} role="alert" hidden={!state.error}>{state.error}</p>
      <form className={FCN.form} method="post" action={action} data-servos-form={form.id} noValidate onSubmit={onSubmit}>
        <input type="hidden" name="form_id" value={form.id} />
        <input type="hidden" name="return_to" value={returnTo} />
        <input type="hidden" name="source" value={source} />
        {form.fields.map((f) => <Field key={f.id} form={form} f={f} error={state.errors[f.id]} />)}
        {form.consent_enabled !== false ? (
          <div className={cls(FCN.field, FCN.tick, FCN.consent)}><label htmlFor={`${dom}-consent`}><input type="checkbox" id={`${dom}-consent`} name="consent" value="on" /> <span>{form.consent_text}</span></label></div>
        ) : null}
        <div className={FCN.hp} aria-hidden="true"><label htmlFor={`${dom}-hp`}>Leave this empty</label><input type="text" id={`${dom}-hp`} name={HONEYPOT_FIELD} tabIndex={-1} autoComplete="off" /></div>
        <button type="submit" className={cls(CN.btn, CN.btnPrimary, FCN.submit)} disabled={state.busy}>{form.submit_label || 'Send'}</button>
      </form>
    </div>
  );
}

export function Form({ id, form_id, title, sub, width }) {
  const { ctx, forms, editor } = useSite();
  const nested = useNested();
  const all = forms || (ctx && ctx.forms) || {};
  const form = form_id ? all[form_id] : null;
  const action = (ctx && ctx.formAction) || '';
  // The live site paints nothing for a missing form (the SSR does the same); the editor says why.
  if (!form || !Array.isArray(form.fields) || !form.fields.length) {
    if (!editor) return null;
    return (
      <section className={cls(CN.block, 'w-formblock')} data-block="Form" data-id={id} data-nested={nested ? 'true' : undefined}>
        <div className={CN.inner}><p className={CN.empty}>{form_id ? 'That form is archived or not one of yours. Pick another in Form.' : 'Pick a form in Form on the right. Make forms in Customers, Forms.'}</p></div>
      </section>
    );
  }
  return (
    <section className={cls(CN.block, 'w-formblock')} data-block="Form" data-id={id} data-nested={nested ? 'true' : undefined} data-width={!nested && (width === 'wide' || width === 'full') ? width : undefined}>
      <div className={CN.inner}><ServosForm form={form} action={action} title={title} sub={sub} preview={!!editor} /></div>
    </section>
  );
}
