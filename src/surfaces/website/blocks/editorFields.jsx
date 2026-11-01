// src/surfaces/website/blocks/editorFields.jsx
//
// 5.12.9: the Back Office page editor's pickers, mounted by Puck as custom fields (puckFields.js
// turns a typed schema prop into { type: 'custom', render } when puckConfig.jsx hands it these).
// Each one receives Puck's props ({ name, id, value, onChange, readOnly }) plus the schema `field`
// and the editor `opts` ({ pages, menus, categories, uploadAsset }). The rules live in
// editorFields.js (pure, tested); this file is only the React. Back Office tokens only, plain
// English labels, and the stored values keep their plain shapes (a URL string, '#rrggbb' or '',
// a menu id, [{ id }], an href string, a markdown string).

import { useRef, useState } from 'react';
import { W } from '../../../backoffice/sections/website/ui.js';
import { shrinkImage } from '../../../backoffice/sections/website/designer/screenshots.js';
import { renderMarkdown } from '../markdown.js';
import {
  CUSTOM_LINK, categoryIds, categoryOptions, classifyHref, insertMarkdown, isHexColor, linkOptions, menuOptions,
  normaliseHex, toggleCategory,
} from './editorFields.js';

const PHOTO_MAX_EDGE = 1600;

// Compact versions of the W styles: the Puck side bar is narrow.
const F = {
  wrap: { marginBottom: 12 },
  label: { ...W.label, marginBottom: 5 },
  input: { ...W.input, padding: '7px 10px', fontSize: 13, borderRadius: 8 },
  select: { ...W.input, padding: '7px 10px', fontSize: 13, borderRadius: 8, cursor: 'pointer' },
  textarea: { ...W.textarea, padding: '8px 10px', fontSize: 13, borderRadius: 8, minHeight: 140 },
  btn: { ...W.ghost, padding: '5px 9px', fontSize: 12 },
  tool: { ...W.ghost, padding: '4px 8px', fontSize: 12, lineHeight: 1.3 },
  hint: { ...W.hint, marginTop: 4 },
  err: { fontSize: 12, color: 'var(--red)', marginTop: 5, lineHeight: 1.4 },
  row: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  thumbBox: { width: '100%', height: 96, borderRadius: 8, border: '1px solid var(--bdr2)', background: 'var(--bg2)', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', marginBottom: 6 },
  thumb: { width: '100%', height: '100%', objectFit: 'cover', display: 'block' },
  swatch: { width: 34, height: 34, padding: 0, border: '1px solid var(--bdr2)', borderRadius: 8, background: 'var(--bg2)', cursor: 'pointer' },
  check: { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', fontSize: 13, color: 'var(--t1)', cursor: 'pointer' },
  pop: { marginTop: 6, padding: 10, border: '1px solid var(--bdr)', borderRadius: 10, background: 'var(--bg1)' },
  preview: { ...W.input, minHeight: 140, fontSize: 13, lineHeight: 1.5, color: 'var(--t1)', overflow: 'auto' },
};

function Label({ field, name }) {
  const text = (field && field.label) || name || '';
  return text ? <label style={F.label}>{text}</label> : null;
}

function plainError(e) {
  const m = e && typeof e === 'object' && e.message ? String(e.message) : (typeof e === 'string' ? e : '');
  if (!m) return 'The upload did not finish. Please try again.';
  if (/413|too large|size/i.test(m)) return 'That photo is too big. Try a smaller one.';
  if (/network|fetch|load failed/i.test(m)) return 'The upload did not reach the server. Check the connection and try again.';
  return m;
}

/** A photo file ready to upload: shrunk to a 1600 px JPEG when the browser can decode it. */
async function fileForUpload(file) {
  if (!file || !/^image\//.test(file.type || '')) throw new Error('Choose a photo file (JPG, PNG, HEIC or WebP).');
  const shrunk = await shrinkImage(file, { maxEdge: PHOTO_MAX_EDGE });
  if (!shrunk || !shrunk.preview) return file; // the browser could not decode it: send it as it is
  const blob = await (await fetch(shrunk.preview)).blob();
  const base = String(file.name || 'photo').replace(/\.[a-z0-9]+$/i, '') || 'photo';
  return new File([blob], `${base}.jpg`, { type: 'image/jpeg' });
}

/** image: thumbnail, Upload photo (shrunk then opts.uploadAsset(file, 'photo')), Remove, or paste a web address. */
export function ImageField({ name, value, onChange, readOnly, field, opts }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const fileRef = useRef(null);
  const url = typeof value === 'string' ? value : '';
  const canUpload = !!(opts && typeof opts.uploadAsset === 'function');

  const pick = async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    setBusy(true);
    setErr('');
    try {
      const ready = await fileForUpload(file);
      const res = await opts.uploadAsset(ready, 'photo');
      if (!res || res.error || !res.url) setErr(plainError(res && res.error));
      else onChange(res.url);
    } catch (e2) {
      setErr(plainError(e2));
    }
    setBusy(false);
  };

  return (
    <div style={F.wrap}>
      <Label field={field} name={name} />
      <div style={F.thumbBox}>
        {url ? <img src={url} alt="" style={F.thumb} /> : <span style={{ fontSize: 12, color: 'var(--t4)' }}>No photo yet</span>}
      </div>
      <div style={F.row}>
        <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={pick} disabled={readOnly || busy} />
        <button type="button" style={F.btn} disabled={readOnly || busy || !canUpload} onClick={() => fileRef.current && fileRef.current.click()}>
          {busy ? 'Uploading…' : (url ? 'Change photo' : 'Upload photo')}
        </button>
        {url && <button type="button" style={F.btn} disabled={readOnly || busy} onClick={() => { setErr(''); onChange(''); }}>Remove</button>}
      </div>
      {!canUpload && <div style={F.hint}>Uploads are not available here. Paste a web address instead.</div>}
      {err && <div style={F.err}>{err}</div>}
      <div style={{ marginTop: 8 }}>
        <div style={{ ...F.hint, marginTop: 0, marginBottom: 4 }}>Or paste a web address</div>
        <input style={F.input} value={url} placeholder="https://" disabled={readOnly || busy} onChange={(e) => onChange(e.target.value)} />
      </div>
      {field && field.hint ? <div style={F.hint}>{field.hint}</div> : null}
    </div>
  );
}

/** color: a swatch next to a hex box and None. Only '#rrggbb' or '' is ever written. */
export function ColorField({ name, value, onChange, readOnly, field }) {
  const v = isHexColor(value) ? String(value).toLowerCase() : '';
  // What the owner is typing, kept only while it belongs to the current value (no effect needed).
  const [draft, setDraft] = useState({ of: v, text: v });
  const text = draft.of === v ? draft.text : v;
  const typed = (t) => {
    setDraft({ of: v, text: t });
    const hex = normaliseHex(t);
    if (hex && hex !== v) onChange(hex);
    else if (!t.trim() && v) onChange('');
  };
  return (
    <div style={F.wrap}>
      <Label field={field} name={name} />
      <div style={F.row}>
        <input type="color" aria-label="Pick a colour" style={F.swatch} value={v || '#ffffff'} disabled={readOnly} onChange={(e) => onChange(String(e.target.value).toLowerCase())} />
        <input style={{ ...F.input, width: 110, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }} value={text} placeholder="#c8493b" disabled={readOnly}
          onChange={(e) => typed(e.target.value)} onBlur={() => setDraft({ of: v, text: v })} />
        <button type="button" style={F.btn} disabled={readOnly || !v} onClick={() => { setDraft({ of: '', text: '' }); onChange(''); }}>None</button>
      </div>
      <div style={F.hint}>{v ? v : 'None: the theme colour is used.'}</div>
    </div>
  );
}

/** menu: Live right now, then every venue menu by name; an unknown saved id stays as "Menu <id>". */
export function MenuField({ name, value, onChange, readOnly, field, opts }) {
  const v = typeof value === 'string' && value ? value : 'follow';
  const options = menuOptions(opts && opts.menus, v);
  return (
    <div style={F.wrap}>
      <Label field={field} name={name} />
      <select style={F.select} value={v} disabled={readOnly} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {options.length === 1 && <div style={F.hint}>Your menus appear here once the venue menu has loaded.</div>}
    </div>
  );
}

/** categories: tick the categories to show; none ticked = all. Written as [{ id }] in menu order. */
export function CategoriesField({ name, value, onChange, readOnly, field, opts }) {
  const options = categoryOptions(opts && opts.categories);
  const ticked = categoryIds(value);
  const order = options.map((o) => o.id);
  // A saved id the menu no longer has still shows, so an untick can clear it.
  const extra = ticked.filter((id) => !order.includes(id)).map((id) => ({ id, label: `Category ${id}` }));
  const rows = [...options, ...extra];
  return (
    <div style={F.wrap}>
      <Label field={field} name={name} />
      {rows.length === 0 && <div style={F.hint}>Your categories appear here once the venue menu has loaded.</div>}
      {rows.map((o) => (
        <label key={o.id} style={F.check}>
          <input type="checkbox" checked={ticked.includes(o.id)} disabled={readOnly} onChange={() => onChange(toggleCategory(value, o.id, order))} />
          <span>{o.label}</span>
        </label>
      ))}
      <div style={F.hint}>{ticked.length === 0 ? 'All categories' : `${ticked.length} of ${rows.length} shown`}</div>
    </div>
  );
}

/** href: site pages, the ServOS links, Blog, or a web address box (https://, mailto:, tel:). */
export function LinkField({ name, value, onChange, readOnly, field, opts, compact = false }) {
  const pages = opts && opts.pages;
  const options = linkOptions(pages);
  const v = typeof value === 'string' ? value : '';
  const found = classifyHref(v, pages);
  // Once the owner picks "Web address" the box stays, even while it is empty or matches a page.
  const [custom, setCustom] = useState(found.choice === CUSTOM_LINK && v !== '');
  const choice = custom ? CUSTOM_LINK : found.choice;
  const pick = (next) => {
    if (next === CUSTOM_LINK) { setCustom(true); if (found.choice !== CUSTOM_LINK) onChange(''); }
    else { setCustom(false); onChange(next); }
  };
  return (
    <div style={compact ? undefined : F.wrap}>
      {!compact && <Label field={field} name={name} />}
      <select style={F.select} value={choice} disabled={readOnly} onChange={(e) => pick(e.target.value)}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {choice === CUSTOM_LINK && (
        <input style={{ ...F.input, marginTop: 6 }} value={v} placeholder="https://, mailto: or tel:" disabled={readOnly} onChange={(e) => { setCustom(true); onChange(e.target.value); }} />
      )}
    </div>
  );
}

const TOOLS = [
  { kind: 'heading', label: 'Heading', title: 'Make the line a heading' },
  { kind: 'bold', label: 'Bold', title: 'Bold the selected words' },
  { kind: 'italic', label: 'Italic', title: 'Italic for the selected words' },
  { kind: 'bullet', label: 'Bullet list', title: 'Turn the lines into a bullet list' },
];

/** markdown text: a textarea with a toolbar (Heading, Bold, Italic, Bullet list, Link) and a Preview. */
export function MarkdownField({ name, value, onChange, readOnly, field, opts }) {
  const [preview, setPreview] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkTarget, setLinkTarget] = useState('');
  const taRef = useRef(null);
  const selRef = useRef({ start: 0, end: 0 });
  const text = typeof value === 'string' ? value : '';

  const selection = () => {
    const ta = taRef.current;
    if (!ta) return selRef.current;
    return { start: ta.selectionStart || 0, end: ta.selectionEnd || 0 };
  };
  const apply = (kind, extra, sel) => {
    const { start, end } = sel || selection();
    const r = insertMarkdown(text, start, end, kind, extra);
    onChange(r.text);
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (!ta) return;
      try { ta.focus(); ta.setSelectionRange(r.start, r.end); } catch { /* fine */ }
    });
  };
  const openLink = () => {
    selRef.current = selection();
    setLinkTarget('');
    setLinkOpen(true);
  };
  const insertLink = () => {
    apply('link', { target: linkTarget }, selRef.current);
    setLinkOpen(false);
  };

  return (
    <div style={F.wrap}>
      <Label field={field} name={name} />
      <div style={{ ...F.row, marginBottom: 6 }}>
        {TOOLS.map((t) => <button key={t.kind} type="button" style={F.tool} title={t.title} disabled={readOnly || preview} onClick={() => apply(t.kind)}>{t.label}</button>)}
        <button type="button" style={F.tool} title="Add a link to a page, ordering or a web address" disabled={readOnly || preview} onClick={openLink}>Link</button>
        <button type="button" style={{ ...F.tool, marginLeft: 'auto', ...(preview ? { borderColor: 'var(--acc)', color: 'var(--acc)' } : {}) }} onClick={() => setPreview(!preview)}>{preview ? 'Edit' : 'Preview'}</button>
      </div>
      {linkOpen && (
        <div style={F.pop}>
          <div style={{ ...F.label, marginBottom: 6 }}>Where should the link go?</div>
          <LinkField compact value={linkTarget} onChange={setLinkTarget} opts={opts} readOnly={readOnly} />
          <div style={{ ...F.row, marginTop: 8, justifyContent: 'flex-end' }}>
            <button type="button" style={F.btn} onClick={() => setLinkOpen(false)}>Cancel</button>
            <button type="button" style={{ ...F.btn, background: 'var(--acc)', color: '#0b0c10', borderColor: 'var(--acc)' }} disabled={!linkTarget} onClick={insertLink}>Insert link</button>
          </div>
        </div>
      )}
      {preview
        // renderMarkdown escapes every piece of text first (markdown.js), so this is safe to inject.
        ? <div style={F.preview} dangerouslySetInnerHTML={{ __html: renderMarkdown(text) || '<p style="color:var(--t4)">Nothing to show yet.</p>' }} />
        : <textarea ref={taRef} style={F.textarea} value={text} disabled={readOnly} placeholder={field && field.hint ? field.hint : 'Write here'} onChange={(e) => onChange(e.target.value)} />}
      <div style={F.hint}>Select a word, then press a button. No codes to learn.</div>
    </div>
  );
}
