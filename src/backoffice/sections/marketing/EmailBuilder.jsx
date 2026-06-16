// src/backoffice/sections/marketing/EmailBuilder.jsx — slice 5 block-based email builder.
// Edits a list of blocks (heading/text/button/image/divider/spacer/raw-html), reorder by drag or
// up/down, insert merge tags at the cursor, and a live rendered preview (with sample data). The parent
// compiles blocks → responsive HTML on save via compileEmail().

import { useRef, useState } from 'react';
import { compileEmail, renderMergePreview, SAMPLE_MERGE, MERGE_TAGS } from '../../../lib/emailCompiler';

const s = {
  wrap: { display: 'grid', gridTemplateColumns: '1fr 300px', gap: 14, alignItems: 'start' },
  col: { minWidth: 0 },
  block: { border: '1px solid var(--bdr2)', borderRadius: 10, background: 'var(--bg2)', padding: 10, marginBottom: 8 },
  bhead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  btype: { fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--t3)' },
  iconbtn: { background: 'transparent', border: '1px solid var(--bdr2)', borderRadius: 6, cursor: 'pointer', color: 'var(--t2)', fontSize: 12, padding: '2px 7px', fontWeight: 700 },
  input: { width: '100%', boxSizing: 'border-box', border: '1px solid var(--bdr2)', borderRadius: 8, padding: '7px 10px', fontSize: 13, fontFamily: 'inherit', color: 'var(--t1)', background: 'var(--bg1)', outline: 'none' },
  ta: { width: '100%', boxSizing: 'border-box', border: '1px solid var(--bdr2)', borderRadius: 8, padding: '7px 10px', fontSize: 13, fontFamily: 'inherit', color: 'var(--t1)', background: 'var(--bg1)', outline: 'none', minHeight: 54, resize: 'vertical' },
  add: { padding: '6px 11px', borderRadius: 8, border: '1px dashed var(--bdr2)', background: 'transparent', color: 'var(--t2)', cursor: 'pointer', fontSize: 12, fontWeight: 700, marginRight: 6, marginBottom: 6 },
  chip: { padding: '3px 8px', borderRadius: 99, border: '1px solid var(--bdr2)', background: 'var(--bg2)', color: 'var(--t2)', cursor: 'pointer', fontSize: 11, fontWeight: 700, marginRight: 5, marginBottom: 5, fontFamily: 'var(--font-mono, monospace)' },
  previewBox: { border: '1px solid var(--bdr2)', borderRadius: 10, overflow: 'hidden', position: 'sticky', top: 8 },
  previewHead: { fontSize: 11, fontWeight: 800, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.05em', padding: '8px 10px', background: 'var(--bg2)', borderBottom: '1px solid var(--bdr2)' },
};

const ADDABLE = [['heading', 'Heading'], ['text', 'Text'], ['button', 'Button'], ['image', 'Image'], ['divider', 'Divider'], ['spacer', 'Spacer'], ['html', 'Raw HTML']];
const blank = (type) => ({ type, ...(type === 'button' ? { text: 'Click here', url: 'https://', align: 'left', color: '#111111' } : type === 'spacer' ? { size: 16 } : type === 'image' ? { url: '', alt: '' } : type === 'html' ? { html: '' } : { text: '' }) });

export default function EmailBuilder({ blocks, onChange }) {
  const list = Array.isArray(blocks) ? blocks : [];
  const focusRef = useRef(null);      // { el, idx, field }
  const [dragIdx, setDragIdx] = useState(null);

  const set = (next) => onChange(next);
  const setField = (idx, field, val) => set(list.map((b, i) => (i === idx ? { ...b, [field]: val } : b)));
  const add = (type) => set([...list, blank(type)]);
  const remove = (idx) => set(list.filter((_, i) => i !== idx));
  const dup = (idx) => set([...list.slice(0, idx + 1), { ...list[idx] }, ...list.slice(idx + 1)]);
  const move = (idx, d) => { const j = idx + d; if (j < 0 || j >= list.length) return; const n = [...list]; [n[idx], n[j]] = [n[j], n[idx]]; set(n); };
  const drop = (idx) => { if (dragIdx == null || dragIdx === idx) return; const n = [...list]; const [m] = n.splice(dragIdx, 1); n.splice(idx, 0, m); setDragIdx(null); set(n); };

  const insertTag = (tag) => {
    const f = focusRef.current;
    if (!f || !f.el) { return; }
    const el = f.el; const start = el.selectionStart ?? el.value.length; const end = el.selectionEnd ?? el.value.length;
    const cur = el.value; const next = cur.slice(0, start) + tag + cur.slice(end);
    setField(f.idx, f.field, next);
    // restore caret after React re-render
    requestAnimationFrame(() => { try { el.focus(); el.setSelectionRange(start + tag.length, start + tag.length); } catch {} });
  };
  const track = (idx, field) => ({ onFocus: (e) => { focusRef.current = { el: e.target, idx, field }; } });

  const previewHtml = renderMergePreview(compileEmail(list), SAMPLE_MERGE);

  return (
    <div>
      <div style={{ marginBottom: 8 }}>
        {MERGE_TAGS.map(([tag, lbl]) => <button key={tag} type="button" style={s.chip} title={`Insert ${lbl}`} onMouseDown={(e) => e.preventDefault()} onClick={() => insertTag(tag)}>{tag}</button>)}
        <span style={{ fontSize: 11, color: 'var(--t4)', marginLeft: 4 }}>click to insert at cursor</span>
      </div>
      <div style={s.wrap}>
        <div style={s.col}>
          {list.length === 0 && <div style={{ fontSize: 12, color: 'var(--t4)', padding: '10px 0' }}>No blocks yet — add one below.</div>}
          {list.map((b, idx) => (
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
              {b.type === 'heading' && <input style={s.input} value={b.text || ''} placeholder="Heading text" {...track(idx, 'text')} onChange={(e) => setField(idx, 'text', e.target.value)} />}
              {b.type === 'text' && <textarea style={s.ta} value={b.text || ''} placeholder="Paragraph text" {...track(idx, 'text')} onChange={(e) => setField(idx, 'text', e.target.value)} />}
              {b.type === 'button' && (
                <div style={{ display: 'grid', gap: 6 }}>
                  <input style={s.input} value={b.text || ''} placeholder="Button label" {...track(idx, 'text')} onChange={(e) => setField(idx, 'text', e.target.value)} />
                  <input style={s.input} value={b.url || ''} placeholder="https://link" {...track(idx, 'url')} onChange={(e) => setField(idx, 'url', e.target.value)} />
                  <div style={{ display: 'flex', gap: 6 }}>
                    <select style={{ ...s.input, flex: 1 }} value={b.align || 'left'} onChange={(e) => setField(idx, 'align', e.target.value)}><option value="left">Left</option><option value="center">Center</option><option value="right">Right</option></select>
                    <input type="color" style={{ width: 40, height: 34, border: '1px solid var(--bdr2)', borderRadius: 8, background: 'var(--bg1)', cursor: 'pointer' }} value={b.color || '#111111'} onChange={(e) => setField(idx, 'color', e.target.value)} title="Button colour" />
                  </div>
                </div>
              )}
              {b.type === 'image' && (
                <div style={{ display: 'grid', gap: 6 }}>
                  <input style={s.input} value={b.url || ''} placeholder="Image URL (https://…)" {...track(idx, 'url')} onChange={(e) => setField(idx, 'url', e.target.value)} />
                  <input style={s.input} value={b.alt || ''} placeholder="Alt text" {...track(idx, 'alt')} onChange={(e) => setField(idx, 'alt', e.target.value)} />
                </div>
              )}
              {b.type === 'spacer' && <input type="number" min={4} max={120} style={s.input} value={b.size ?? 16} onChange={(e) => setField(idx, 'size', Number(e.target.value))} />}
              {b.type === 'html' && <textarea style={{ ...s.ta, fontFamily: 'var(--font-mono, monospace)' }} value={b.html || ''} placeholder="<p>Raw HTML…</p>" {...track(idx, 'html')} onChange={(e) => setField(idx, 'html', e.target.value)} />}
              {b.type === 'divider' && <div style={{ fontSize: 12, color: 'var(--t4)' }}>Horizontal divider line.</div>}
            </div>
          ))}
          <div style={{ marginTop: 6 }}>
            {ADDABLE.map(([type, lbl]) => <button key={type} type="button" style={s.add} onClick={() => add(type)}>+ {lbl}</button>)}
          </div>
        </div>

        <div style={s.previewBox}>
          <div style={s.previewHead}>Preview (sample data)</div>
          <div style={{ maxHeight: 460, overflow: 'auto', background: '#f4f4f5' }} dangerouslySetInnerHTML={{ __html: previewHtml }} />
        </div>
      </div>
    </div>
  );
}
