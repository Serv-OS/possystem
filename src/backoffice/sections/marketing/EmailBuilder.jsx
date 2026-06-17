// src/backoffice/sections/marketing/EmailBuilder.jsx — visual email builder (v2).
// Edits content blocks + an email-level Design panel (page/card background, width, font, header logo
// + brand preset). Per-block styling: section background, padding, alignment, text colour. Images can be
// uploaded (Supabase Storage, public receipt-assets bucket) or pasted as a URL. Email-level design is
// stored as a `{type:'settings'}` block at index 0 so the whole design lives inside `blocks`.

import { useRef, useState } from 'react';
import { supabase } from '../../../lib/supabase';
import { compileEmail, renderMergePreview, SAMPLE_MERGE, MERGE_TAGS, FONTS, DEFAULT_SETTINGS } from '../../../lib/emailCompiler';

const s = {
  wrap: { display: 'grid', gridTemplateColumns: '1fr 300px', gap: 14, alignItems: 'start' },
  block: { border: '1px solid var(--bdr2)', borderRadius: 10, background: 'var(--bg2)', padding: 10, marginBottom: 8 },
  bhead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  btype: { fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--t3)' },
  iconbtn: { background: 'transparent', border: '1px solid var(--bdr2)', borderRadius: 6, cursor: 'pointer', color: 'var(--t2)', fontSize: 12, padding: '2px 7px', fontWeight: 700 },
  input: { width: '100%', boxSizing: 'border-box', border: '1px solid var(--bdr2)', borderRadius: 8, padding: '7px 10px', fontSize: 13, fontFamily: 'inherit', color: 'var(--t1)', background: 'var(--bg1)', outline: 'none' },
  ta: { width: '100%', boxSizing: 'border-box', border: '1px solid var(--bdr2)', borderRadius: 8, padding: '7px 10px', fontSize: 13, fontFamily: 'inherit', color: 'var(--t1)', background: 'var(--bg1)', outline: 'none', minHeight: 54, resize: 'vertical' },
  add: { padding: '6px 11px', borderRadius: 8, border: '1px dashed var(--bdr2)', background: 'transparent', color: 'var(--t2)', cursor: 'pointer', fontSize: 12, fontWeight: 700, marginRight: 6, marginBottom: 6 },
  chip: { padding: '3px 8px', borderRadius: 99, border: '1px solid var(--bdr2)', background: 'var(--bg2)', color: 'var(--t2)', cursor: 'pointer', fontSize: 11, fontWeight: 700, marginRight: 5, marginBottom: 5, fontFamily: 'var(--font-mono, monospace)' },
  styleRow: { display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginTop: 8, paddingTop: 8, borderTop: '1px dashed var(--bdr2)' },
  ctl: { display: 'flex', gap: 5, alignItems: 'center', fontSize: 11.5, color: 'var(--t3)', fontWeight: 600 },
  swatch: { width: 28, height: 24, border: '1px solid var(--bdr2)', borderRadius: 6, background: 'var(--bg1)', cursor: 'pointer', padding: 0 },
  num: { width: 52, boxSizing: 'border-box', border: '1px solid var(--bdr2)', borderRadius: 6, padding: '4px 6px', fontSize: 12, background: 'var(--bg1)', color: 'var(--t1)' },
  seg: { display: 'inline-flex', border: '1px solid var(--bdr2)', borderRadius: 6, overflow: 'hidden' },
  segb: (on) => ({ padding: '3px 8px', fontSize: 11, fontWeight: 700, cursor: 'pointer', border: 'none', background: on ? 'var(--acc)' : 'transparent', color: on ? '#0b0c10' : 'var(--t2)' }),
  design: { border: '1px solid var(--bdr2)', borderRadius: 10, background: 'var(--bg2)', padding: 12, marginBottom: 10 },
  previewBox: { border: '1px solid var(--bdr2)', borderRadius: 10, overflow: 'hidden', position: 'sticky', top: 8 },
  previewHead: { fontSize: 11, fontWeight: 800, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.05em', padding: '8px 10px', background: 'var(--bg2)', borderBottom: '1px solid var(--bdr2)' },
  upbtn: { padding: '6px 10px', borderRadius: 8, border: '1px solid var(--bdr2)', background: 'var(--bg1)', color: 'var(--t2)', cursor: 'pointer', fontSize: 12, fontWeight: 700 },
};

const ADDABLE = [['heading', 'Heading'], ['text', 'Text'], ['button', 'Button'], ['image', 'Image'], ['divider', 'Divider'], ['spacer', 'Spacer'], ['html', 'Raw HTML']];
const blank = (type) => ({ type, align: 'left', ...(type === 'button' ? { text: 'Click here', url: 'https://' } : type === 'spacer' ? { size: 16 } : type === 'image' ? { url: '', alt: '' } : type === 'html' ? { html: '' } : { text: '' }) });
const ALIGN = ['left', 'center', 'right'];

export default function EmailBuilder({ blocks, onChange, locationId }) {
  const list = Array.isArray(blocks) ? blocks : [];
  const settings = { ...DEFAULT_SETTINGS, ...(list.find((b) => b && b.type === 'settings') || {}) };
  const content = list.filter((b) => b && b.type !== 'settings');
  const focusRef = useRef(null);
  const [dragIdx, setDragIdx] = useState(null);
  const [showDesign, setShowDesign] = useState(false);
  const [uploading, setUploading] = useState(null);   // idx being uploaded ('header' for logo)

  const emit = (nextContent, nextSettings) => onChange([{ type: 'settings', ...(nextSettings || settings) }, ...nextContent]);
  const setSettings = (patch) => emit(content, { ...settings, ...patch });
  const setContent = (next) => emit(next, settings);
  const setField = (idx, patch) => setContent(content.map((b, i) => (i === idx ? { ...b, ...patch } : b)));
  const add = (type) => setContent([...content, blank(type)]);
  const remove = (idx) => setContent(content.filter((_, i) => i !== idx));
  const dup = (idx) => setContent([...content.slice(0, idx + 1), { ...content[idx] }, ...content.slice(idx + 1)]);
  const move = (idx, d) => { const j = idx + d; if (j < 0 || j >= content.length) return; const n = [...content]; [n[idx], n[j]] = [n[j], n[idx]]; setContent(n); };
  const drop = (idx) => { if (dragIdx == null || dragIdx === idx) return; const n = [...content]; const [m] = n.splice(dragIdx, 1); n.splice(idx, 0, m); setDragIdx(null); setContent(n); };

  const insertTag = (tag) => {
    const f = focusRef.current; if (!f || !f.el) return;
    const el = f.el; const start = el.selectionStart ?? el.value.length; const end = el.selectionEnd ?? el.value.length;
    setField(f.idx, { [f.field]: el.value.slice(0, start) + tag + el.value.slice(end) });
    requestAnimationFrame(() => { try { el.focus(); el.setSelectionRange(start + tag.length, start + tag.length); } catch {} });
  };
  const track = (idx, field) => ({ onFocus: (e) => { focusRef.current = { el: e.target, idx, field }; } });

  const upload = async (file, cb, key) => {
    if (!file) return;
    if (!locationId) { alert('Pick a location first.'); return; }
    if (file.size > 3 * 1024 * 1024) { alert('Image must be under 3 MB.'); return; }
    setUploading(key);
    try {
      const ext = (file.name.split('.').pop() || 'png').toLowerCase();
      const path = `locations/${locationId}/marketing/${Date.now()}-${Math.round(Math.random() * 1e6)}.${ext}`;
      const { error } = await supabase.storage.from('receipt-assets').upload(path, file, { upsert: true, contentType: file.type });
      if (error) throw error;
      const { data } = supabase.storage.from('receipt-assets').getPublicUrl(path);
      cb(`${data.publicUrl}?t=${Date.now()}`);
    } catch (e) { alert(`Upload failed: ${e.message || e}. The "receipt-assets" storage bucket must exist and be public.`); }
    finally { setUploading(null); }
  };

  const applyBranding = async () => {
    try {
      const { data } = await supabase.from('locations').select('receipt_branding').eq('id', locationId).maybeSingle();
      const logo = data?.receipt_branding?.header?.logo_url;
      if (logo) setSettings({ headerLogo: logo });
      else alert('No logo found in Receipt branding. Upload one there, or upload a header logo here.');
    } catch (e) { alert(e.message); }
  };

  const ColorCtl = ({ label, value, onSet, allowNone }) => (
    <span style={s.ctl}>{label}
      <input type="color" style={s.swatch} value={value || '#ffffff'} onChange={(e) => onSet(e.target.value)} />
      {allowNone && value ? <button type="button" style={{ ...s.iconbtn, padding: '2px 5px' }} onClick={() => onSet('')} title="No background">✕</button> : null}
    </span>
  );
  const AlignCtl = ({ value, onSet }) => (
    <span style={s.seg}>{ALIGN.map((a) => <button key={a} type="button" style={s.segb((value || 'left') === a)} onClick={() => onSet(a)}>{a[0].toUpperCase()}</button>)}</span>
  );

  const previewHtml = renderMergePreview(compileEmail(list.length ? list : [{ type: 'settings', ...settings }]), SAMPLE_MERGE);

  return (
    <div>
      <div style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" style={s.upbtn} onClick={() => setShowDesign((v) => !v)}>{showDesign ? '▾' : '▸'} Design & branding</button>
        {MERGE_TAGS.map(([tag, lbl]) => <button key={tag} type="button" style={s.chip} title={`Insert ${lbl}`} onMouseDown={(e) => e.preventDefault()} onClick={() => insertTag(tag)}>{tag}</button>)}
        <span style={{ fontSize: 11, color: 'var(--t4)' }}>click to insert at cursor</span>
      </div>

      {showDesign && (
        <div style={s.design}>
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center' }}>
            <ColorCtl label="Page bg" value={settings.pageBg} onSet={(v) => setSettings({ pageBg: v })} />
            <ColorCtl label="Email bg" value={settings.cardBg} onSet={(v) => setSettings({ cardBg: v })} />
            <ColorCtl label="Brand / buttons" value={settings.brandColor} onSet={(v) => setSettings({ brandColor: v })} />
            <span style={s.ctl}>Width<input type="number" min={400} max={700} style={s.num} value={settings.width} onChange={(e) => setSettings({ width: Number(e.target.value) })} /></span>
            <span style={s.ctl}>Font
              <select style={{ ...s.input, width: 'auto', padding: '4px 8px' }} value={settings.font} onChange={(e) => setSettings({ font: e.target.value })}>{FONTS.map(([v, l]) => <option key={l} value={v}>{l}</option>)}</select>
            </span>
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginTop: 10, paddingTop: 10, borderTop: '1px dashed var(--bdr2)' }}>
            <span style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--t2)' }}>Header logo</span>
            <button type="button" style={s.upbtn} onClick={applyBranding}>Use my branding</button>
            <label style={s.upbtn}>{uploading === 'header' ? 'Uploading…' : 'Upload logo'}<input type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => upload(e.target.files?.[0], (url) => setSettings({ headerLogo: url }), 'header')} /></label>
            {settings.headerLogo && <><img src={settings.headerLogo} alt="" style={{ height: 28, borderRadius: 4 }} /><button type="button" style={{ ...s.iconbtn, color: 'var(--red)' }} onClick={() => setSettings({ headerLogo: '' })}>Remove</button></>}
            {settings.headerLogo && <ColorCtl label="Header bg" value={settings.headerBg} onSet={(v) => setSettings({ headerBg: v })} allowNone />}
          </div>
        </div>
      )}

      <div style={s.wrap}>
        <div style={{ minWidth: 0 }}>
          {content.length === 0 && <div style={{ fontSize: 12, color: 'var(--t4)', padding: '10px 0' }}>No blocks yet — add one below.</div>}
          {content.map((b, idx) => (
            <div key={idx} style={{ ...s.block, ...(dragIdx === idx ? { opacity: 0.5 } : {}) }}
              draggable onDragStart={() => setDragIdx(idx)} onDragOver={(e) => e.preventDefault()} onDrop={() => drop(idx)}>
              <div style={s.bhead}>
                <span style={s.btype}>⠿ {b.type}</span>
                <span style={{ display: 'flex', gap: 4 }}>
                  <button type="button" style={s.iconbtn} onClick={() => move(idx, -1)} title="Up">↑</button>
                  <button type="button" style={s.iconbtn} onClick={() => move(idx, 1)} title="Down">↓</button>
                  <button type="button" style={s.iconbtn} onClick={() => dup(idx)} title="Duplicate">⎘</button>
                  <button type="button" style={{ ...s.iconbtn, color: 'var(--red)' }} onClick={() => remove(idx)} title="Delete">✕</button>
                </span>
              </div>

              {b.type === 'heading' && <input style={s.input} value={b.text || ''} placeholder="Heading text" {...track(idx, 'text')} onChange={(e) => setField(idx, { text: e.target.value })} />}
              {b.type === 'text' && <textarea style={s.ta} value={b.text || ''} placeholder="Paragraph text" {...track(idx, 'text')} onChange={(e) => setField(idx, { text: e.target.value })} />}
              {b.type === 'button' && (
                <div style={{ display: 'grid', gap: 6 }}>
                  <input style={s.input} value={b.text || ''} placeholder="Button label" {...track(idx, 'text')} onChange={(e) => setField(idx, { text: e.target.value })} />
                  <input style={s.input} value={b.url || ''} placeholder="https://link" {...track(idx, 'url')} onChange={(e) => setField(idx, { url: e.target.value })} />
                </div>
              )}
              {b.type === 'image' && (
                <div style={{ display: 'grid', gap: 6 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <label style={s.upbtn}>{uploading === idx ? 'Uploading…' : '⬆ Upload image'}<input type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => upload(e.target.files?.[0], (url) => setField(idx, { url }), idx)} /></label>
                    {b.url && <img src={b.url} alt="" style={{ height: 32, borderRadius: 4 }} />}
                  </div>
                  <input style={s.input} value={b.url || ''} placeholder="…or paste an image URL" {...track(idx, 'url')} onChange={(e) => setField(idx, { url: e.target.value })} />
                  <input style={s.input} value={b.alt || ''} placeholder="Alt text (for accessibility)" {...track(idx, 'alt')} onChange={(e) => setField(idx, { alt: e.target.value })} />
                </div>
              )}
              {b.type === 'spacer' && <input type="number" min={4} max={120} style={s.input} value={b.size ?? 16} onChange={(e) => setField(idx, { size: Number(e.target.value) })} />}
              {b.type === 'html' && <textarea style={{ ...s.ta, fontFamily: 'var(--font-mono, monospace)' }} value={b.html || ''} placeholder="<p>Raw HTML…</p>" {...track(idx, 'html')} onChange={(e) => setField(idx, { html: e.target.value })} />}
              {b.type === 'divider' && <ColorCtl label="Line colour" value={b.color || '#e5e5e5'} onSet={(v) => setField(idx, { color: v })} />}

              {/* per-block styling (not for spacer) */}
              {b.type !== 'spacer' && b.type !== 'divider' && (
                <div style={s.styleRow}>
                  {(b.type === 'heading' || b.type === 'text' || b.type === 'button' || b.type === 'image') && <span style={s.ctl}>Align<AlignCtl value={b.align} onSet={(v) => setField(idx, { align: v })} /></span>}
                  <ColorCtl label="Section bg" value={b.bgColor} onSet={(v) => setField(idx, { bgColor: v })} allowNone />
                  {(b.type === 'heading' || b.type === 'text') && <ColorCtl label="Text" value={b.textColor || (b.type === 'heading' ? '#111111' : '#333333')} onSet={(v) => setField(idx, { textColor: v })} />}
                  {b.type === 'button' && <ColorCtl label="Button" value={b.color || settings.brandColor} onSet={(v) => setField(idx, { color: v })} />}
                  <span style={s.ctl}>Pad<input type="number" min={0} max={64} style={s.num} value={b.pad != null ? b.pad : 16} onChange={(e) => setField(idx, { pad: Number(e.target.value) })} /></span>
                </div>
              )}
            </div>
          ))}
          <div style={{ marginTop: 6 }}>
            {ADDABLE.map(([type, lbl]) => <button key={type} type="button" style={s.add} onClick={() => add(type)}>+ {lbl}</button>)}
          </div>
        </div>

        <div style={s.previewBox}>
          <div style={s.previewHead}>Preview (sample data)</div>
          <div style={{ maxHeight: 480, overflow: 'auto' }} dangerouslySetInnerHTML={{ __html: previewHtml }} />
        </div>
      </div>
    </div>
  );
}
