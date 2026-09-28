// src/surfaces/ops/OpsDocsForms.jsx
//
// Operations tablet (?mode=ops, and the Manager app's Ops tab): Documents and Forms
// (28 Sep 2026, v5.11.4). Rendered inside OpsContent, so the tablet's own pairing, staff PIN
// and venue apply.
//
//   Documents: the venue's documents; tap to open one (a 5 minute signed link, opened by the
//   phone's own viewer in the app shells). Staff may upload one too: adding a record is what
//   the module lets a paired tablet do, the same as raising maintenance. Archiving is Back
//   Office only.
//   Forms: fill in a venue's form (the Accident book). The submitter is the staff member
//   signed in on the tablet. Submissions are manager only: they are read in Back Office, and
//   the database never lets a tablet read one back.
//
// Before migration 20260928c runs both say "not set up yet".

import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../../store';
import { Icon } from '../../components/ServOSIcons';
import OpsDocViewer from '../../components/OpsDocViewer';
import { photoInputProps, photoButtonLabel } from '../../lib/cameraCapture';
import { reportSave } from '../../lib/saveHealth';
import { fetchDocuments, uploadDocument, openDocument } from '../../lib/ops/documents';
import { fetchForms, submitForm } from '../../lib/ops/forms';
import {
  DOC_CATEGORIES, docCategoryLabel, checkDocumentDraft, titleFromFileName, formatBytes,
  fileKind, fileKindWord, validateAnswers, validateAnswer, newId,
} from '../../lib/ops/formRules';

const mono = { fontFamily: 'var(--font-mono)' };
const fieldStyle = { width: '100%', padding: '12px 14px', borderRadius: 12, color: 'var(--t1)', border: '1px solid var(--bdr)', fontFamily: 'inherit', fontSize: 15, background: 'var(--glass-bg)', outline: 'none', boxSizing: 'border-box' };
const fieldLbl = { fontSize: 10.5, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.08em', margin: '16px 0 8px', ...mono };
const HUE = { documents: 260, forms: 330 };

function Header({ title, sub, onBack }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
      {onBack && <button onClick={onBack} aria-label="Back" className="sv-glass" style={{ width: 38, height: 38, borderRadius: 11, display: 'grid', placeItems: 'center', cursor: 'pointer', color: 'var(--t1)', fontSize: 18, border: '1px solid var(--bdr)' }}>‹</button>}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 17, fontWeight: 800 }}>{title}</div>
        {sub && <div style={{ fontSize: 10.5, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.08em', ...mono }}>{sub}</div>}
      </div>
    </div>
  );
}
const Note = ({ children }) => <div className="sv-glass" style={{ padding: 18, color: 'var(--t3)', textAlign: 'center', lineHeight: 1.5 }}>{children}</div>;
const Chip = ({ on, onClick, children }) => (
  <button onClick={onClick} type="button" style={{ padding: '9px 14px', borderRadius: 999, cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', border: `1px solid ${on ? 'var(--acc-b)' : 'var(--bdr)'}`, color: on ? 'var(--acc)' : 'var(--t2)', background: on ? 'var(--acc-d)' : 'var(--glass-bg)' }}>{children}</button>
);

// ── Documents ────────────────────────────────────────────────────────────────
export function OpsDocuments({ loc, operator, onBack }) {
  const [rows, setRows] = useState(null);
  const [absent, setAbsent] = useState('');
  const [err, setErr] = useState('');
  const [cat, setCat] = useState('all');
  const [uploading, setUploading] = useState(false);
  const [opening, setOpening] = useState(null);
  const [blocked, setBlocked] = useState(null);   // { id, url }
  const [viewing, setViewing] = useState(null);   // { doc, url }: the in-app viewer (iOS shells, Sunmi)
  const showToast = useStore((s) => s.showToast);

  const reload = useCallback(() => fetchDocuments(loc).then((r) => {
    setAbsent(r.absent ? r.message : '');
    setErr(r.error && !r.absent ? r.message : '');
    setRows(r.data || []);
  }), [loc]);
  useEffect(() => { reload(); }, [reload]);

  if (uploading) return <UploadDocument loc={loc} operator={operator} onDone={(saved) => { setUploading(false); if (saved) reload(); }} />;

  const open = async (d) => {
    setOpening(d.id); setBlocked(null);
    const r = await openDocument(d);
    setOpening(null);
    if (r.error) { showToast?.(r.error.message || 'Could not open it', 'error'); return; }
    if (r.viewer) { setViewing({ doc: d, url: r.url }); return; }
    if (r.blocked) setBlocked({ id: d.id, url: r.url });
  };

  const list = rows || [];
  const shown = cat === 'all' ? list : list.filter((d) => d.category === cat);
  return (
    <div>
      {viewing && <OpsDocViewer doc={viewing.doc} url={viewing.url} onClose={() => setViewing(null)} />}
      <Header title="Documents" sub={rows == null ? '' : `${list.length} document${list.length === 1 ? '' : 's'}`} onBack={onBack} />
      {absent ? <Note>{absent}</Note> : (
        <>
          <button onClick={() => setUploading(true)} className="btn btn-acc" style={{ width: '100%', padding: 13, marginBottom: 12, fontSize: 14, fontWeight: 800, borderRadius: 14, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
            <Icon name="plus" size={16} /> Upload a document
          </button>
          <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 6, marginBottom: 8 }}>
            {[{ key: 'all', label: 'All' }, ...DOC_CATEGORIES].map((c) => <Chip key={c.key} on={cat === c.key} onClick={() => setCat(c.key)}>{c.label}</Chip>)}
          </div>
          {err && <div style={{ color: 'var(--red)', fontSize: 13, marginBottom: 10 }}>{err}</div>}
          {rows == null && <div style={{ color: 'var(--t3)', padding: 12, ...mono }}>Loading...</div>}
          {rows && shown.length === 0 && !err && <Note>{list.length === 0 ? 'No documents yet.' : 'No documents in this category.'}</Note>}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {shown.map((d) => (
              <div key={d.id}>
                <button onClick={() => open(d)} disabled={!!opening} className="sv-tile" style={{ '--h': HUE.documents, width: '100%', display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderRadius: 14, cursor: 'pointer', color: 'var(--t1)', textAlign: 'left', fontFamily: 'inherit' }}>
                  <div style={{ width: 38, height: 38, borderRadius: 10, display: 'grid', placeItems: 'center', background: `oklch(0.8 0.12 ${HUE.documents} / 0.18)`, color: `oklch(0.85 0.14 ${HUE.documents})`, flexShrink: 0 }}><Icon name="note" size={19} /></div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.title}</div>
                    <div style={{ fontSize: 11, color: 'var(--t3)', ...mono }}>{docCategoryLabel(d.category)} · {fileKindWord(fileKind(d.fileName, d.mimeType))} · {formatBytes(d.sizeBytes)}</div>
                  </div>
                  <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--acc)', ...mono }}>{opening === d.id ? 'Opening...' : 'Open'}</span>
                </button>
                {blocked?.id === d.id && (
                  <a href={blocked.url} target="_blank" rel="noopener noreferrer" style={{ display: 'block', fontSize: 12.5, color: 'var(--acc)', fontWeight: 700, padding: '6px 4px' }}>Tap here to open it</a>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function UploadDocument({ loc, operator, onDone }) {
  const [file, setFile] = useState(null);
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('food_safety');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const fileRef = useRef(null);
  const showToast = useStore((s) => s.showToast);

  const pick = (e) => {
    const f = e.target.files && e.target.files[0];
    setErr(''); setFile(f || null);
    if (f && !title.trim()) setTitle(titleFromFileName(f.name));
  };
  const save = async () => {
    const check = checkDocumentDraft({ title, category, file });
    if (!check.ok) { setErr(Object.values(check.errors)[0]); return; }
    setBusy(true); setErr('');
    const { error } = await uploadDocument({ file, title, category, byName: operator?.name || null, byStaffId: operator?.id || null, source: 'tablet' }, loc);
    setBusy(false);
    reportSave('operations document', error);
    if (error) { setErr(error.message || 'Upload failed'); return; }
    showToast?.('Document uploaded', 'success');
    onDone(true);
  };

  return (
    <div>
      <Header title="Upload a document" sub="Any file, up to 20 MB" onBack={() => onDone(false)} />
      <input ref={fileRef} type="file" onChange={pick} style={{ display: 'none' }} />
      <button type="button" onClick={() => fileRef.current?.click()} style={{ width: '100%', border: '1.5px dashed var(--bdr3)', borderRadius: 14, padding: 22, textAlign: 'center', color: file ? 'var(--t1)' : 'var(--t3)', background: 'transparent', cursor: 'pointer', fontFamily: 'inherit', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
        <Icon name="note" size={22} />
        <div style={{ fontSize: 13.5, fontWeight: 600, wordBreak: 'break-all' }}>{file ? file.name : 'Choose a file'}</div>
        {file && <div style={{ fontSize: 11, ...mono }}>{formatBytes(file.size)} · tap to change</div>}
      </button>

      <div style={fieldLbl}>Title</div>
      <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} placeholder="For example: Fire risk assessment" style={fieldStyle} />

      <div style={fieldLbl}>Category</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {DOC_CATEGORIES.map((c) => <Chip key={c.key} on={category === c.key} onClick={() => setCategory(c.key)}>{c.label}</Chip>)}
      </div>

      {err && <div style={{ color: 'var(--red)', fontSize: 13, marginTop: 12 }}>{err}</div>}
      <button onClick={save} disabled={busy} className="btn btn-acc" style={{ width: '100%', padding: 15, marginTop: 18, fontSize: 15, fontWeight: 800, borderRadius: 14, opacity: busy ? 0.6 : 1 }}>{busy ? 'Uploading...' : 'Upload'}</button>
      {operator?.name && <div style={{ fontSize: 11, color: 'var(--t3)', textAlign: 'center', marginTop: 8, ...mono }}>Uploaded by {operator.name}</div>}
    </div>
  );
}

// ── Forms ────────────────────────────────────────────────────────────────────
export function OpsForms({ loc, operator, onBack }) {
  const [forms, setForms] = useState(null);
  const [absent, setAbsent] = useState('');
  const [err, setErr] = useState('');
  const [active, setActive] = useState(null);

  const reload = useCallback(() => fetchForms(loc).then((r) => {
    setAbsent(r.absent ? r.message : '');
    setErr(r.error && !r.absent ? r.message : '');
    setForms(r.data || []);
  }), [loc]);
  useEffect(() => { reload(); }, [reload]);

  if (active) return <FormFill loc={loc} operator={operator} form={active} onDone={() => setActive(null)} />;

  return (
    <div>
      <Header title="Forms" sub={forms == null ? '' : `${forms.length} form${forms.length === 1 ? '' : 's'}`} onBack={onBack} />
      {absent ? <Note>{absent}</Note> : (
        <>
          {err && <div style={{ color: 'var(--red)', fontSize: 13, marginBottom: 10 }}>{err}</div>}
          {forms == null && <div style={{ color: 'var(--t3)', padding: 12, ...mono }}>Loading...</div>}
          {forms && forms.length === 0 && !err && <Note>No forms yet. A manager adds them in Back Office, under Operations, Forms.</Note>}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {(forms || []).map((f) => (
              <button key={f.id} onClick={() => setActive(f)} className="sv-tile" style={{ '--h': HUE.forms, display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderRadius: 14, cursor: 'pointer', color: 'var(--t1)', textAlign: 'left', fontFamily: 'inherit' }}>
                <div style={{ width: 38, height: 38, borderRadius: 10, display: 'grid', placeItems: 'center', background: `oklch(0.8 0.12 ${HUE.forms} / 0.18)`, color: `oklch(0.85 0.14 ${HUE.forms})`, flexShrink: 0 }}><Icon name="edit" size={19} /></div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 700 }}>{f.name}</div>
                  <div style={{ fontSize: 11, color: 'var(--t3)', ...mono }}>{f.fields.length} question{f.fields.length === 1 ? '' : 's'}</div>
                </div>
                <span className="btn btn-acc" style={{ padding: '8px 14px', fontSize: 13, fontWeight: 800, borderRadius: 999 }}>Fill in</span>
              </button>
            ))}
          </div>
          <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 14, lineHeight: 1.5, ...mono }}>Completed forms go to managers in Back Office. They cannot be opened on this tablet.</div>
        </>
      )}
    </div>
  );
}

export function FormFill({ loc, operator, form, onDone }) {
  const [answers, setAnswers] = useState({});
  const [errors, setErrors] = useState({});
  const [previews, setPreviews] = useState({});        // question id to an object URL of the chosen photo
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [saved, setSaved] = useState(false);
  const [submissionId, setSubmissionId] = useState(() => newId());   // the same id on a retry: never saved twice
  const urlsRef = useRef(new Set());
  const shownRef = useRef({});   // the preview each photo question shows now
  const photoRef = useRef(null);
  const photoFieldRef = useRef(null);

  // Free every photo preview when the form closes.
  useEffect(() => {
    const urls = urlsRef.current;
    return () => { urls.forEach((u) => { try { URL.revokeObjectURL(u); } catch { /* gone */ } }); urls.clear(); };
  }, []);

  const set = (f, v) => {
    setAnswers((a) => ({ ...a, [f.id]: v }));
    setErrors((e) => { if (!e[f.id]) return e; const n = { ...e }; delete n[f.id]; return n; });
  };
  const setPreview = (id, url) => {
    const old = shownRef.current[id];
    if (old && old !== url) { try { URL.revokeObjectURL(old); } catch { /* gone */ } urlsRef.current.delete(old); }
    if (url) { urlsRef.current.add(url); shownRef.current[id] = url; } else delete shownRef.current[id];
    setPreviews({ ...shownRef.current });
  };

  const choosePhoto = (f) => {
    photoFieldRef.current = f;
    if (photoRef.current) { photoRef.current.value = ''; photoRef.current.click(); }
  };
  const onPhoto = (e) => {
    const file = e.target.files && e.target.files[0];
    const f = photoFieldRef.current;
    photoFieldRef.current = null;
    if (!file || !f) return;
    const msg = validateAnswer({ ...f, required: false }, file);
    if (msg) { setErrors((x) => ({ ...x, [f.id]: msg })); return; }
    set(f, file);
    setPreview(f.id, URL.createObjectURL(file));
  };
  const removePhoto = (f) => { set(f, null); setPreview(f.id, null); };

  const submit = async () => {
    const v = validateAnswers(form.fields, answers);
    if (!v.ok) {
      setErrors(v.errors);
      setErr('Some answers need attention.');
      const first = form.fields.find((f) => v.errors[f.id]);
      if (first) document.getElementById(`opsf-${first.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    setBusy(true); setErr('');
    const r = await submitForm({ form, answers, operator, source: 'tablet', submissionId }, loc);
    setBusy(false);
    reportSave('operations form', r.error);
    if (r.error) {
      if (r.fieldErrors) setErrors((x) => ({ ...x, ...r.fieldErrors }));
      setErr(r.error.message || 'The form was NOT saved. Try again.');
      return;
    }
    setSaved(true);
  };
  const another = () => {
    Object.keys(shownRef.current).forEach((id) => setPreview(id, null));
    setAnswers({}); setErrors({}); setErr(''); setSaved(false); setSubmissionId(newId());
  };

  if (saved) {
    return (
      <div>
        <Header title={form.name} sub="Saved" onBack={onDone} />
        <div className="sv-glass" style={{ padding: 24, textAlign: 'center', marginBottom: 14 }}>
          <div style={{ width: 48, height: 48, borderRadius: 999, margin: '0 auto 10px', display: 'grid', placeItems: 'center', background: 'var(--grn-d)', color: 'var(--grn)' }}><Icon name="check" size={26} /></div>
          <div style={{ fontSize: 17, fontWeight: 800 }}>Form saved</div>
          <div style={{ fontSize: 13, color: 'var(--t2)', marginTop: 6, lineHeight: 1.5 }}>Managers can read it in Back Office, under Operations, Forms.</div>
        </div>
        <button onClick={another} className="btn btn-acc" style={{ width: '100%', padding: 14, fontSize: 15, fontWeight: 800, borderRadius: 14 }}>Fill in another</button>
        <button onClick={onDone} className="btn btn-ghost" style={{ width: '100%', padding: 14, marginTop: 10, fontSize: 15, borderRadius: 14 }}>Back to forms</button>
      </div>
    );
  }

  return (
    <div>
      <Header title={form.name} sub={`${form.fields.length} question${form.fields.length === 1 ? '' : 's'}`} onBack={onDone} />
      {form.description && <div style={{ fontSize: 13, color: 'var(--t2)', lineHeight: 1.5, marginBottom: 6 }}>{form.description}</div>}
      <input ref={photoRef} {...photoInputProps()} onChange={onPhoto} style={{ display: 'none' }} />
      {form.fields.map((f) => (
        <div key={f.id} id={`opsf-${f.id}`}>
          <div style={fieldLbl}>{f.label}{f.required ? <span style={{ color: 'var(--red)' }}> *</span> : null}</div>
          {f.help && <div style={{ fontSize: 12, color: 'var(--t3)', margin: '-4px 0 8px', lineHeight: 1.45 }}>{f.help}</div>}
          <FieldInput f={f} value={answers[f.id]} onChange={(v) => set(f, v)} preview={previews[f.id]}
            onChoosePhoto={() => choosePhoto(f)} onRemovePhoto={() => removePhoto(f)} padKey={submissionId} />
          {errors[f.id] && <div style={{ color: 'var(--red)', fontSize: 12.5, marginTop: 6 }}>{errors[f.id]}</div>}
        </div>
      ))}
      {err && <div style={{ color: 'var(--red)', fontSize: 13, marginTop: 14 }}>{err}</div>}
      <button onClick={submit} disabled={busy} className="btn btn-acc" style={{ width: '100%', padding: 15, marginTop: 18, fontSize: 15, fontWeight: 800, borderRadius: 14, opacity: busy ? 0.6 : 1 }}>{busy ? 'Saving...' : 'Submit'}</button>
      <div style={{ fontSize: 11, color: 'var(--t3)', textAlign: 'center', marginTop: 8, ...mono }}>{operator?.name ? `Submitted by ${operator.name}` : 'No staff member signed in'}</div>
    </div>
  );
}

function FieldInput({ f, value, onChange, preview, onChoosePhoto, onRemovePhoto, padKey }) {
  switch (f.type) {
    case 'long_text':
      return <textarea value={value || ''} onChange={(e) => onChange(e.target.value)} rows={4} maxLength={5000} style={{ ...fieldStyle, resize: 'vertical' }} />;
    case 'number':
      return <input value={value ?? ''} onChange={(e) => onChange(e.target.value)} inputMode="decimal" style={fieldStyle} />;
    case 'date':
      return <input type="date" value={value || ''} onChange={(e) => onChange(e.target.value)} style={fieldStyle} />;
    case 'time':
      return <input type="time" value={value || ''} onChange={(e) => onChange(e.target.value)} style={fieldStyle} />;
    case 'yes_no':
      return (
        <div className="sv-glass sv-pill" style={{ display: 'flex', padding: 4, gap: 4 }}>
          {[['yes', 'Yes'], ['no', 'No']].map(([k, l]) => (
            <button key={k} type="button" onClick={() => onChange(value === k ? null : k)} style={{ flex: 1, padding: 11, borderRadius: 999, border: 'none', cursor: 'pointer', fontWeight: 700, fontFamily: 'inherit', fontSize: 14, background: value === k ? 'var(--acc)' : 'transparent', color: value === k ? '#06130C' : 'var(--t2)' }}>{l}</button>
          ))}
        </div>
      );
    case 'single_choice':
      return (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {(f.options || []).map((o) => <Chip key={o} on={value === o} onClick={() => onChange(value === o ? null : o)}>{o}</Chip>)}
        </div>
      );
    case 'multi_choice': {
      const list = Array.isArray(value) ? value : [];
      return (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {(f.options || []).map((o) => {
            const on = list.includes(o);
            return <Chip key={o} on={on} onClick={() => onChange(on ? list.filter((x) => x !== o) : [...list, o])}>{on ? '✓ ' : ''}{o}</Chip>;
          })}
        </div>
      );
    }
    case 'photo':
      return value && preview ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <img src={preview} alt={f.label} style={{ width: 96, height: 96, objectFit: 'cover', borderRadius: 12, border: '1px solid var(--bdr)' }} />
          <button type="button" onClick={onChoosePhoto} className="btn btn-ghost" style={{ padding: '10px 14px', borderRadius: 12 }}>Change</button>
          <button type="button" onClick={onRemovePhoto} className="btn btn-ghost" style={{ padding: '10px 14px', borderRadius: 12, color: 'var(--red)' }}>Remove</button>
        </div>
      ) : (
        <button type="button" onClick={onChoosePhoto} style={{ width: '100%', border: '1.5px dashed var(--bdr3)', borderRadius: 14, padding: 18, color: 'var(--t3)', background: 'transparent', cursor: 'pointer', fontFamily: 'inherit', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
          <Icon name="camera" size={22} />
          <div style={{ fontSize: 13 }}>{photoButtonLabel()}</div>
        </button>
      );
    case 'signature':
      return <SignaturePad key={padKey} onChange={onChange} />;
    default:
      return <input value={value || ''} onChange={(e) => onChange(e.target.value)} maxLength={500} style={fieldStyle} />;
  }
}

// A finger or stylus signature on a white canvas, saved as a PNG data URL (dark ink on white,
// whatever the tablet's theme, so it prints and reads the same everywhere).
function SignaturePad({ onChange }) {
  const ref = useRef(null);
  const drawing = useRef(false);
  const last = useRef(null);
  const inked = useRef(false);
  // The parent passes a new onChange on every render; keep the latest here so the canvas is
  // set up ONCE (setting it up again would wipe the signature).
  const onChangeRef = useRef(onChange);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);

  const paper = useCallback(() => {
    const c = ref.current;
    if (!c) return null;
    const ctx = c.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const ratio = Math.max(1, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
    c.width = Math.round(c.clientWidth * ratio);
    c.height = Math.round(c.clientHeight * ratio);
    ctx.scale(ratio, ratio);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, c.clientWidth, c.clientHeight);
    ctx.lineWidth = 2.4; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#111111';
    inked.current = false;
    return ctx;
  }, []);
  useEffect(() => {
    paper();
    // A turned tablet changes the pad's width: the ink would no longer line up with the
    // finger, so start the signature again rather than keep a skewed one.
    let width = ref.current?.clientWidth || 0;
    const onResize = () => {
      const w = ref.current?.clientWidth || 0;
      if (w && w !== width) { width = w; paper(); onChangeRef.current?.(null); }
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [paper]);

  const at = (e) => { const r = ref.current.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const down = (e) => {
    e.preventDefault();
    try { ref.current.setPointerCapture(e.pointerId); } catch { /* older WebView */ }
    drawing.current = true;
    const p = at(e); last.current = p;
    const ctx = ref.current.getContext('2d');
    ctx.beginPath(); ctx.arc(p.x, p.y, 1.2, 0, Math.PI * 2); ctx.fillStyle = '#111111'; ctx.fill();
    inked.current = true;
  };
  const move = (e) => {
    if (!drawing.current) return;
    e.preventDefault();
    const p = at(e);
    const ctx = ref.current.getContext('2d');
    ctx.beginPath(); ctx.moveTo(last.current.x, last.current.y); ctx.lineTo(p.x, p.y); ctx.stroke();
    last.current = p;
  };
  const end = () => {
    if (!drawing.current) return;
    drawing.current = false;
    if (inked.current) onChange(ref.current.toDataURL('image/png'));
  };
  const clear = () => { paper(); onChange(null); };

  return (
    <div>
      <canvas ref={ref} onPointerDown={down} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onPointerLeave={end}
        style={{ width: '100%', height: 170, display: 'block', touchAction: 'none', background: '#ffffff', borderRadius: 12, border: '1px solid var(--bdr)', cursor: 'crosshair' }} />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 6 }}>
        <span style={{ fontSize: 11, color: 'var(--t3)', ...mono }}>Sign with a finger</span>
        <button type="button" onClick={clear} className="btn btn-ghost" style={{ padding: '6px 12px', borderRadius: 10, fontSize: 12.5 }}>Clear</button>
      </div>
    </div>
  );
}
