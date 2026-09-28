// OpsDocuments: Back Office, Operations, Documents (28 Sep 2026, v5.11.4).
// Upload a venue's documents (food safety records, certificates, policies) and open them any
// time. The same list shows on the Operations tablet, where staff can open them too.
// Files live in the private 'ops-files' bucket and open through a 5 minute signed link.
// Archive, never delete. Before migration 20260928c runs the screen says "not set up yet".

import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../../../store';
import { getActiveLocationSync, getLocationId } from '../../../lib/supabase';
import { getLocationConfig } from '../../../lib/locationTime';
import { reportSave } from '../../../lib/saveHealth';
import { fetchDocuments, uploadDocument, archiveDocument, restoreDocument, openDocument } from '../../../lib/ops/documents';
import {
  DOC_CATEGORIES, docCategoryLabel, checkDocumentDraft, titleFromFileName, formatBytes, formatWhen,
  fileKind, fileKindWord,
} from '../../../lib/ops/formRules';
import { Icon } from '../../../components/ServOSIcons';
import OpsDocViewer from '../../../components/OpsDocViewer';
import { useBoActorName } from './useBoActorName';

const field = { width: '100%', background: 'var(--bg2)', color: 'var(--t1)', border: '1px solid var(--bdr)', borderRadius: 8, padding: '9px 11px', fontSize: 13.5, outline: 'none', boxSizing: 'border-box', fontFamily: 'inherit' };
const lbl = { display: 'block', fontSize: 11, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 5 };
const card = { background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 14, padding: 18 };
const btn = { padding: '8px 14px', borderRadius: 8, border: '1px solid var(--bdr2)', background: 'var(--bg2)', color: 'var(--t1)', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5, fontWeight: 600 };
const KIND_HUE = { pdf: 'var(--red)', image: 'var(--acc)', word: 'var(--uv, var(--acc))', sheet: 'var(--grn)', slides: 'var(--orn)', text: 'var(--t2)', other: 'var(--t3)' };

async function resolveLoc(current) {
  return current || getActiveLocationSync() || await getLocationId().catch(() => null);
}

export default function OpsDocuments() {
  const showToast = useStore((s) => s.showToast);
  const byName = useBoActorName();
  const [locId, setLocId] = useState(getActiveLocationSync());
  const [tz, setTz] = useState('Europe/London');
  const [docs, setDocs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [absent, setAbsent] = useState('');
  const [loadErr, setLoadErr] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [cat, setCat] = useState('all');
  const [file, setFile] = useState(null);
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('food_safety');
  const [busy, setBusy] = useState(false);
  const [formErr, setFormErr] = useState('');
  const [blocked, setBlocked] = useState(null);   // { id, url } when the browser refused a new tab
  const [viewing, setViewing] = useState(null);   // { doc, url }: the in-app viewer (iOS shells, Sunmi)
  const fileRef = useRef(null);

  const reload = useCallback(() => resolveLoc(locId).then((loc) => {
    if (loc && loc !== locId) setLocId(loc);
    return fetchDocuments(loc, { includeArchived: showArchived }).then((r) => {
      setAbsent(r.absent ? r.message : '');
      setLoadErr(r.error && !r.absent ? r.message : '');
      setDocs(r.data || []);
      setLoading(false);
    });
  }), [locId, showArchived]);
  useEffect(() => { reload(); }, [reload]);
  useEffect(() => {
    let live = true;
    resolveLoc(locId).then((loc) => getLocationConfig(loc)).then((c) => { if (live && c?.timezone) setTz(c.timezone); }).catch(() => {});
    return () => { live = false; };
  }, [locId]);

  const pick = (e) => {
    const f = e.target.files && e.target.files[0];
    setFormErr('');
    setFile(f || null);
    if (f && !title.trim()) setTitle(titleFromFileName(f.name));
  };

  const upload = async () => {
    const check = checkDocumentDraft({ title, category, file });
    if (!check.ok) { setFormErr(Object.values(check.errors)[0]); return; }
    setBusy(true); setFormErr('');
    const { error } = await uploadDocument({ file, title, category, byName, source: 'back_office' }, locId);
    setBusy(false);
    reportSave('operations document', error);
    if (error) { setFormErr(error.message || 'Upload failed'); showToast?.('Document NOT saved', 'error'); return; }
    showToast?.('Document uploaded', 'success');
    setFile(null); setTitle('');
    if (fileRef.current) fileRef.current.value = '';
    reload();
  };

  const open = async (d) => {
    setBlocked(null);
    const r = await openDocument(d);
    if (r.error) { showToast?.(r.error.message || 'Could not open it', 'error'); return; }
    if (r.viewer) { setViewing({ doc: d, url: r.url }); return; }
    if (r.blocked) setBlocked({ id: d.id, url: r.url });
  };

  const archive = async (d) => {
    if (!window.confirm(`Archive "${d.title}"? It leaves the list and the tablets. You can bring it back with Show archived.`)) return;
    const { error } = await archiveDocument(d.id, locId, byName);
    reportSave('operations document archive', error);
    if (error) { showToast?.(error.message || 'Not archived', 'error'); return; }
    showToast?.('Archived', 'success'); reload();
  };
  const restore = async (d) => {
    const { error } = await restoreDocument(d.id, locId);
    reportSave('operations document restore', error);
    if (error) { showToast?.(error.message || 'Not restored', 'error'); return; }
    showToast?.('Restored', 'success'); reload();
  };

  const counts = docs.reduce((m, d) => { m[d.category] = (m[d.category] || 0) + 1; return m; }, {});
  const shown = cat === 'all' ? docs : docs.filter((d) => d.category === cat);

  return (
    <div style={{ height: '100%', overflowY: 'auto', background: 'var(--bg0)', padding: '22px 26px' }}>
      {viewing && <OpsDocViewer doc={viewing.doc} url={viewing.url} onClose={() => setViewing(null)} />}
      <h1 style={{ fontSize: 22, fontWeight: 700, margin: '0 0 4px', color: 'var(--t1)' }}>Documents</h1>
      <div style={{ fontSize: 13, color: 'var(--t3)', marginBottom: 18, maxWidth: 720 }}>
        Food safety records, certificates and policies for this venue. Staff can open them on the Operations tablet too.
      </div>

      {absent ? (
        <div style={{ ...card, maxWidth: 820, color: 'var(--t2)', fontSize: 13.5 }}>{absent}</div>
      ) : (
        <>
          <div style={{ ...card, maxWidth: 820, marginBottom: 18 }}>
            <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--t1)', marginBottom: 12 }}>Upload a document</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1.1fr 1fr 0.8fr', gap: 12, alignItems: 'end' }}>
              <div>
                <label style={lbl}>File (any type, up to 20 MB)</label>
                <input ref={fileRef} type="file" onChange={pick} style={{ display: 'none' }} />
                <button type="button" onClick={() => fileRef.current?.click()} style={{ ...btn, width: '100%', textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {file ? `${file.name} (${formatBytes(file.size)})` : 'Choose a file'}
                </button>
              </div>
              <div>
                <label style={lbl}>Title</label>
                <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="For example: Pest control report" maxLength={200} style={field} />
              </div>
              <div>
                <label style={lbl}>Category</label>
                <select value={category} onChange={(e) => setCategory(e.target.value)} style={field}>
                  {DOC_CATEGORIES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
                </select>
              </div>
            </div>
            {formErr && <div style={{ color: 'var(--red)', fontSize: 12.5, marginTop: 10 }}>{formErr}</div>}
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 14 }}>
              <button onClick={upload} disabled={busy} className="btn btn-acc" style={{ padding: '10px 22px', borderRadius: 8, background: 'var(--acc)', color: '#fff', border: 0, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', opacity: busy ? 0.6 : 1 }}>
                {busy ? 'Uploading...' : 'Upload'}
              </button>
            </div>
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginBottom: 12, maxWidth: 820 }}>
            {[{ key: 'all', label: 'All' }, ...DOC_CATEGORIES].map((c) => {
              const on = cat === c.key;
              const n = c.key === 'all' ? docs.length : (counts[c.key] || 0);
              return (
                <button key={c.key} onClick={() => setCat(c.key)} style={{ padding: '6px 12px', borderRadius: 999, fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', border: `1px solid ${on ? 'var(--acc)' : 'var(--bdr)'}`, background: on ? 'var(--acc-d)' : 'var(--bg1)', color: on ? 'var(--acc)' : 'var(--t2)', fontWeight: on ? 700 : 500 }}>
                  {c.label} {n > 0 ? `(${n})` : ''}
                </button>
              );
            })}
            <label style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--t2)', cursor: 'pointer' }}>
              <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Show archived
            </label>
          </div>

          {loadErr && <div style={{ color: 'var(--red)', fontSize: 13, marginBottom: 10 }}>{loadErr}</div>}
          {loading ? <div style={{ color: 'var(--t3)' }}>Loading...</div> : shown.length === 0 ? (
            <div style={{ ...card, maxWidth: 820, color: 'var(--t3)', fontSize: 13 }}>
              {docs.length === 0 ? 'No documents yet. Upload the first one above.' : 'No documents in this category.'}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 820 }}>
              {shown.map((d) => {
                const kind = fileKind(d.fileName, d.mimeType);
                const archived = !!d.archivedAt;
                return (
                  <div key={d.id} style={{ background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 12, padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 14, opacity: archived ? 0.6 : 1 }}>
                    <span style={{ width: 54, flexShrink: 0, textAlign: 'center', fontSize: 10, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: KIND_HUE[kind], border: `1px solid ${KIND_HUE[kind]}`, borderRadius: 6, padding: '4px 0' }}>{fileKindWord(kind)}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--t1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.title}</div>
                      <div style={{ fontSize: 11.5, color: 'var(--t3)', marginTop: 2 }}>
                        {docCategoryLabel(d.category)} · {d.fileName} · {formatBytes(d.sizeBytes)} · {formatWhen(d.createdAt, tz)}{d.uploadedByName ? ` · ${d.uploadedByName}` : ''}{d.source === 'tablet' ? ' (tablet)' : ''}
                        {archived ? ` · archived ${formatWhen(d.archivedAt, tz)}${d.archivedByName ? ` by ${d.archivedByName}` : ''}` : ''}
                      </div>
                      {blocked?.id === d.id && (
                        <a href={blocked.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12, color: 'var(--acc)', fontWeight: 700 }}>Your browser blocked the new tab. Tap here to open it.</a>
                      )}
                    </div>
                    <button onClick={() => open(d)} style={{ ...btn, background: 'var(--acc-d)', color: 'var(--acc)', borderColor: 'var(--acc-b, var(--bdr2))' }}>Open</button>
                    {archived
                      ? <button onClick={() => restore(d)} style={btn}>Restore</button>
                      : <button onClick={() => archive(d)} title="Archive" style={{ ...btn, color: 'var(--t2)', display: 'inline-flex', alignItems: 'center', gap: 5 }}><Icon name="close" size={13} /> Archive</button>}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
