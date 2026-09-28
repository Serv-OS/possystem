// OpsForms: Back Office, Operations, Forms (28 Sep 2026, v5.11.4).
// Build a venue's forms (short text, long text, number, date, time, yes or no, single and
// multiple choice, photo, signature; each with a required flag and a help line), add the ready
// made Accident book in one tap, and read the submissions staff make on the Operations tablet.
// Submissions hold personal data, so they are read HERE only (row level security: Back Office
// logins of the venue). Print uses the browser's print view; Export CSV downloads them all.
// Before migration 20260928c runs the screen says "not set up yet".

import { useCallback, useEffect, useState } from 'react';
import { useStore } from '../../../store';
import { getActiveLocationSync, getLocationId, getAvailableLocations } from '../../../lib/supabase';
import { getLocationConfig } from '../../../lib/locationTime';
import { reportSave } from '../../../lib/saveHealth';
import {
  fetchForms, saveForm, addFormFromTemplate, archiveForm, restoreForm, fetchSubmissions, signSubmissionFiles,
} from '../../../lib/ops/forms';
import {
  FIELD_TYPES, CHOICE_TYPES, ACCIDENT_BOOK_TEMPLATE, blankField, validateFormDef, fieldTypeLabel,
  answerText, formatWhen, submissionsToCsv, csvFileName, buildSubmissionPrintHtml,
} from '../../../lib/ops/formRules';
import { downloadCsv } from '../reports/_csv';
import { Icon } from '../../../components/ServOSIcons';
import { useBoActorName } from './useBoActorName';

const field = { width: '100%', background: 'var(--bg2)', color: 'var(--t1)', border: '1px solid var(--bdr)', borderRadius: 8, padding: '8px 10px', fontSize: 13, outline: 'none', boxSizing: 'border-box', fontFamily: 'inherit' };
const lbl = { display: 'block', fontSize: 11, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 5 };
const card = { background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 14, padding: 18 };
const btn = { padding: '8px 14px', borderRadius: 8, border: '1px solid var(--bdr2)', background: 'var(--bg2)', color: 'var(--t1)', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5, fontWeight: 600 };
const accBtn = { padding: '9px 16px', borderRadius: 8, background: 'var(--acc)', color: '#fff', border: 0, fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' };
const iconBtn = { background: 'var(--bg2)', border: '1px solid var(--bdr)', borderRadius: 7, padding: '4px 7px', color: 'var(--t2)', cursor: 'pointer', fontFamily: 'inherit', fontSize: 11 };

async function resolveLoc(current) {
  return current || getActiveLocationSync() || await getLocationId().catch(() => null);
}

export default function OpsForms() {
  const showToast = useStore((s) => s.showToast);
  const byName = useBoActorName();
  const [locId, setLocId] = useState(getActiveLocationSync());
  const [tz, setTz] = useState('Europe/London');
  const [venueName, setVenueName] = useState('');
  const [forms, setForms] = useState([]);
  const [loading, setLoading] = useState(true);
  const [absent, setAbsent] = useState('');
  const [loadErr, setLoadErr] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [selId, setSelId] = useState(null);          // a form id, or 'new'
  const [tab, setTab] = useState('submissions');     // submissions | questions
  const [adding, setAdding] = useState(false);

  const reload = useCallback((selectId = null) => resolveLoc(locId).then((loc) => {
    if (loc && loc !== locId) setLocId(loc);
    return fetchForms(loc, { includeArchived: showArchived }).then((r) => {
      const list = r.data || [];
      setAbsent(r.absent ? r.message : '');
      setLoadErr(r.error && !r.absent ? r.message : '');
      setForms(list);
      setSelId((prev) => {
        const want = selectId || prev;
        if (want === 'new') return want;
        if (want && list.some((f) => f.id === want)) return want;
        return list[0]?.id || null;
      });
      setLoading(false);
    });
  }), [locId, showArchived]);
  useEffect(() => { reload(); }, [reload]);

  useEffect(() => {
    let live = true;
    (async () => {
      const loc = await resolveLoc(locId);
      try { const c = await getLocationConfig(loc); if (live && c?.timezone) setTz(c.timezone); } catch { /* London */ }
      try {
        const hit = ((await getAvailableLocations()) || []).find((l) => l.id === loc);
        if (live && hit?.name) setVenueName(hit.name);
      } catch { /* no venue name on the print */ }
    })();
    return () => { live = false; };
  }, [locId]);

  const hasAccidentBook = forms.some((f) => f.templateKey === ACCIDENT_BOOK_TEMPLATE.key && !f.archivedAt);
  const addAccidentBook = async () => {
    setAdding(true);
    const { data, error } = await addFormFromTemplate(ACCIDENT_BOOK_TEMPLATE.key, locId, byName);
    setAdding(false);
    reportSave('operations form', error);
    if (error) { showToast?.(error.message || 'Not added', 'error'); return; }
    showToast?.('Accident book added. It is on the Operations tablet now.', 'success');
    setTab('submissions');
    reload(data?.id || null);
  };

  const sel = selId && selId !== 'new' ? forms.find((f) => f.id === selId) || null : null;

  return (
    <div style={{ height: '100%', overflowY: 'auto', background: 'var(--bg0)', padding: '22px 26px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 2, flexWrap: 'wrap' }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0, color: 'var(--t1)', flex: 1 }}>Forms</h1>
        {!absent && !hasAccidentBook && (
          <button onClick={addAccidentBook} disabled={adding} style={{ ...btn, opacity: adding ? 0.6 : 1 }}>{adding ? 'Adding...' : '+ Add Accident book'}</button>
        )}
        {!absent && <button onClick={() => { setSelId('new'); setTab('questions'); }} style={accBtn}>+ New form</button>}
      </div>
      <div style={{ fontSize: 13, color: 'var(--t3)', marginBottom: 16, maxWidth: 760 }}>
        Staff fill these in on the Operations tablet. Submissions can hold personal data, so they are only shown here in Back Office.
      </div>

      {absent ? (
        <div style={{ ...card, maxWidth: 820, color: 'var(--t2)', fontSize: 13.5 }}>{absent}</div>
      ) : loading ? <div style={{ color: 'var(--t3)' }}>Loading...</div> : (
        <div style={{ display: 'grid', gridTemplateColumns: '300px 1fr', gap: 16, alignItems: 'start' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {loadErr && <div style={{ color: 'var(--red)', fontSize: 12.5 }}>{loadErr}</div>}
            {forms.length === 0 ? (
              <div style={{ ...card, color: 'var(--t3)', fontSize: 13 }}>No forms yet. Add the Accident book, or build your own with New form.</div>
            ) : forms.map((f) => {
              const on = f.id === selId;
              return (
                <button key={f.id} onClick={() => { setSelId(f.id); setTab('submissions'); }} style={{
                  display: 'block', textAlign: 'left', cursor: 'pointer', fontFamily: 'inherit', color: 'var(--t1)',
                  background: on ? 'var(--acc-d)' : 'var(--bg1)', border: '1px solid var(--bdr)',
                  borderLeft: on ? '3px solid var(--acc)' : '1px solid var(--bdr)', borderRadius: 12, padding: '12px 16px',
                  opacity: f.archivedAt ? 0.6 : 1,
                }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: on ? 'var(--acc)' : 'var(--t1)' }}>{f.name}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--t3)', marginTop: 2 }}>
                    {f.fields.length} question{f.fields.length === 1 ? '' : 's'}{f.templateKey ? ' · ready made' : ''}{f.archivedAt ? ' · archived' : ''}
                  </div>
                </button>
              );
            })}
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--t2)', cursor: 'pointer', marginTop: 4 }}>
              <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Show archived forms
            </label>
          </div>

          <div>
            {selId === 'new' ? (
              <Builder key="new" form={null} locId={locId} byName={byName} showToast={showToast}
                onSaved={(saved) => { setTab('submissions'); reload(saved?.id || null); }}
                onCancel={() => setSelId(forms[0]?.id || null)} onChanged={() => reload()} />
            ) : sel ? (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                  <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--t1)', flex: 1 }}>{sel.name}</div>
                  {[['submissions', 'Submissions'], ['questions', 'Questions']].map(([k, l]) => (
                    <button key={k} onClick={() => setTab(k)} style={{ ...btn, background: tab === k ? 'var(--acc-d)' : 'var(--bg2)', color: tab === k ? 'var(--acc)' : 'var(--t2)', borderColor: tab === k ? 'var(--acc)' : 'var(--bdr2)' }}>{l}</button>
                  ))}
                </div>
                {tab === 'questions' ? (
                  <Builder key={`${sel.id}:${sel.version}`} form={sel} locId={locId} byName={byName} showToast={showToast}
                    onSaved={(saved) => reload(saved?.id || sel.id)} onCancel={() => setTab('submissions')} onChanged={() => reload(sel.id)} />
                ) : (
                  <Submissions key={sel.id} form={sel} locId={locId} tz={tz} venueName={venueName} showToast={showToast} />
                )}
              </>
            ) : (
              <div style={{ ...card, padding: 40, color: 'var(--t3)', fontSize: 13, textAlign: 'center' }}>Select a form, or create a new one.</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── The form builder ──────────────────────────────────────────────────────────
function Builder({ form, locId, byName, showToast, onSaved, onCancel, onChanged }) {
  const [d, setD] = useState(() => (form
    ? { ...form, fields: form.fields.map((f) => ({ ...f, options: [...(f.options || [])] })) }
    : { name: '', description: '', fields: [blankField('short_text')] }));
  const [busy, setBusy] = useState(false);
  const [errs, setErrs] = useState({ errors: [], fieldErrors: {} });
  const [addType, setAddType] = useState('short_text');

  const up = (k, v) => setD((x) => ({ ...x, [k]: v }));
  const upField = (i, patch) => setD((x) => ({ ...x, fields: x.fields.map((f, j) => (j === i ? { ...f, ...patch } : f)) }));
  const move = (i, dir) => setD((x) => {
    const a = [...x.fields]; const j = i + dir;
    if (j < 0 || j >= a.length) return x;
    [a[i], a[j]] = [a[j], a[i]];
    return { ...x, fields: a };
  });
  const remove = (i) => setD((x) => ({ ...x, fields: x.fields.filter((_, j) => j !== i) }));
  const add = () => setD((x) => ({ ...x, fields: [...x.fields, blankField(addType, x.fields.map((f) => f.id))] }));
  const changeType = (i, type) => setD((x) => ({
    ...x,
    fields: x.fields.map((f, j) => (j !== i ? f : {
      ...f, type,
      options: CHOICE_TYPES.includes(type) ? (f.options?.length ? f.options : ['Option 1', 'Option 2']) : [],
    })),
  }));

  const save = async () => {
    const v = validateFormDef(d);
    setErrs(v);
    if (!v.ok) { showToast?.(v.errors[0] || 'Check the questions', 'error'); return; }
    setBusy(true);
    const { data, error } = await saveForm(d, locId, byName);
    setBusy(false);
    reportSave('operations form', error);
    if (error) { showToast?.(error.message || 'Not saved', 'error'); return; }
    showToast?.('Form saved. The tablet shows it next time Forms opens.', 'success');
    onSaved(data);
  };
  const toggleArchive = async () => {
    if (!form?.id) return;
    const archived = !!form.archivedAt;
    if (!archived && !window.confirm(`Archive "${form.name}"? It leaves the tablet. Its submissions stay here.`)) return;
    const { error } = archived ? await restoreForm(form.id, locId) : await archiveForm(form.id, locId);
    reportSave('operations form archive', error);
    if (error) { showToast?.(error.message || 'Not changed', 'error'); return; }
    showToast?.(archived ? 'Restored' : 'Archived', 'success');
    onChanged();
  };

  return (
    <div style={{ ...card, borderColor: 'var(--bdr2)', padding: 22 }}>
      <label style={lbl}>Form name</label>
      <input value={d.name} onChange={(e) => up('name', e.target.value)} placeholder="For example: Accident book" maxLength={200} style={{ ...field, fontSize: 16, fontWeight: 700, marginBottom: 12 }} />
      <label style={lbl}>Description (optional)</label>
      <textarea value={d.description || ''} onChange={(e) => up('description', e.target.value)} rows={2} maxLength={1000} placeholder="Shown to staff above the questions." style={{ ...field, resize: 'vertical', marginBottom: 16 }} />
      {form?.id && (
        <div style={{ fontSize: 11.5, color: 'var(--t3)', marginBottom: 12, lineHeight: 1.5 }}>
          Changing the questions does not change submissions already made: each keeps the questions it was made with.
        </div>
      )}
      {errs.errors.length > 0 && <div style={{ color: 'var(--red)', fontSize: 12.5, marginBottom: 10 }}>{errs.errors[0]}</div>}

      <div style={{ ...lbl, color: 'var(--t2)' }}>Questions · {d.fields.length}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {d.fields.map((f, i) => (
          <div key={f.id || i} style={{ background: 'var(--bg2)', border: `1px solid ${errs.fieldErrors[i] ? 'var(--red-b, var(--red))' : 'var(--bdr)'}`, borderRadius: 12, padding: 12 }}>
            <input value={f.label} onChange={(e) => upField(i, { label: e.target.value })} placeholder={`Question ${i + 1}`} maxLength={200} style={{ ...field, background: 'var(--bg1)', fontWeight: 600 }} />
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginTop: 8 }}>
              <select value={f.type} onChange={(e) => changeType(i, e.target.value)} style={{ ...field, background: 'var(--bg1)', width: 170, flex: '0 0 auto' }}>
                {FIELD_TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
              </select>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--t2)', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                <input type="checkbox" checked={f.required === true} onChange={(e) => upField(i, { required: e.target.checked })} /> Required
              </label>
              <div style={{ display: 'flex', gap: 4, marginLeft: 'auto' }}>
                <button onClick={() => move(i, -1)} title="Move up" style={iconBtn}>▲</button>
                <button onClick={() => move(i, 1)} title="Move down" style={iconBtn}>▼</button>
                <button onClick={() => remove(i)} title="Remove question" style={{ ...iconBtn, color: 'var(--red)' }}><Icon name="close" size={12} /></button>
              </div>
            </div>
            <input value={f.help || ''} onChange={(e) => upField(i, { help: e.target.value })} placeholder="Help line (optional), shown under the question" maxLength={500} style={{ ...field, background: 'var(--bg1)', fontSize: 12, marginTop: 8 }} />
            {CHOICE_TYPES.includes(f.type) && (
              <div style={{ marginTop: 8 }}>
                <div style={{ fontSize: 11, color: 'var(--t3)', marginBottom: 4 }}>Options, one per line ({fieldTypeLabel(f.type).toLowerCase()})</div>
                <textarea value={(f.options || []).join('\n')} onChange={(e) => upField(i, { options: e.target.value.split('\n') })} rows={Math.min(8, Math.max(3, (f.options || []).length + 1))} style={{ ...field, background: 'var(--bg1)', resize: 'vertical', fontSize: 12.5 }} />
              </div>
            )}
            {errs.fieldErrors[i] && <div style={{ color: 'var(--red)', fontSize: 12, marginTop: 6 }}>{errs.fieldErrors[i][0]}</div>}
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12 }}>
        <select value={addType} onChange={(e) => setAddType(e.target.value)} style={{ ...field, width: 190 }}>
          {FIELD_TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
        </select>
        <button onClick={add} style={{ ...btn, display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="plus" size={13} /> Add question</button>
      </div>

      <div style={{ display: 'flex', gap: 10, marginTop: 20, borderTop: '1px solid var(--bdr)', paddingTop: 16 }}>
        {form?.id && (
          <button onClick={toggleArchive} style={{ ...btn, background: form.archivedAt ? 'var(--bg2)' : 'var(--red-d)', color: form.archivedAt ? 'var(--t1)' : 'var(--red)', borderColor: form.archivedAt ? 'var(--bdr2)' : 'var(--red-b, var(--red))' }}>
            {form.archivedAt ? 'Restore form' : 'Archive form'}
          </button>
        )}
        <button onClick={onCancel} style={btn}>Cancel</button>
        <button onClick={save} disabled={busy} style={{ ...accBtn, marginLeft: 'auto', opacity: busy ? 0.6 : 1 }}>{busy ? 'Saving...' : 'Save form'}</button>
      </div>
    </div>
  );
}

// ── Submissions: list, detail, print, CSV ────────────────────────────────────
function Submissions({ form, locId, tz, venueName, showToast }) {
  const [rows, setRows] = useState(null);
  const [more, setMore] = useState(false);
  const [err, setErr] = useState('');
  const [openSub, setOpenSub] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback((before = null) => fetchSubmissions(form.id, locId, { before }).then((r) => {
    if (r.error) { setErr(r.message || 'Could not load submissions.'); if (!before) setRows([]); return; }
    setErr(''); setMore(r.more);
    setRows((prev) => (before ? [...(prev || []), ...r.data] : r.data));
  }), [form.id, locId]);
  useEffect(() => { load(); }, [load]);

  const exportCsv = async () => {
    setBusy(true);
    let all = [...(rows || [])];
    let m = more;
    while (m && all.length && all.length < 20000) {
      const r = await fetchSubmissions(form.id, locId, { before: all[all.length - 1].submittedAt, limit: 500 });
      if (r.error) { showToast?.('Could not load every submission. The file has the ones loaded so far.', 'error'); break; }
      all = all.concat(r.data); m = r.more;
    }
    setBusy(false);
    if (!all.length) { showToast?.('No submissions to export yet', 'error'); return; }
    downloadCsv(csvFileName(form.name), submissionsToCsv(form, all, { timeZone: tz }));
  };

  if (openSub) return <SubmissionDetail submission={openSub} form={form} tz={tz} venueName={venueName} showToast={showToast} onBack={() => setOpenSub(null)} />;

  // A short preview: the first text answer of each submission.
  const previewField = form.fields.find((f) => ['short_text', 'long_text', 'single_choice'].includes(f.type));
  return (
    <div style={card}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <div style={{ fontSize: 13, color: 'var(--t2)', flex: 1 }}>
          {rows == null ? 'Loading...' : `${rows.length}${more ? '+' : ''} submission${rows.length === 1 ? '' : 's'}, newest first`}
        </div>
        <button onClick={exportCsv} disabled={busy || !rows?.length} style={{ ...btn, opacity: busy || !rows?.length ? 0.5 : 1 }}>{busy ? 'Exporting...' : 'Export CSV'}</button>
      </div>
      {err && <div style={{ color: 'var(--red)', fontSize: 12.5, marginBottom: 10 }}>{err}</div>}
      {rows && rows.length === 0 && !err && (
        <div style={{ color: 'var(--t3)', fontSize: 13, padding: '14px 0' }}>No submissions yet. Staff fill this form in on the Operations tablet (Forms tile).</div>
      )}
      {rows && rows.length > 0 && (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: 'left', color: 'var(--t3)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '.05em' }}>
              <th style={{ padding: '6px 8px' }}>Submitted</th>
              <th style={{ padding: '6px 8px' }}>By</th>
              {previewField && <th style={{ padding: '6px 8px' }}>{previewField.label}</th>}
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.id} style={{ borderTop: '1px solid var(--bdr)' }}>
                <td style={{ padding: '8px', whiteSpace: 'nowrap', color: 'var(--t1)' }}>{formatWhen(s.submittedAt, tz)}</td>
                <td style={{ padding: '8px', color: 'var(--t2)' }}>{s.submittedByName || 'Not signed in'}</td>
                {previewField && <td style={{ padding: '8px', color: 'var(--t2)', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{answerText(previewField, s.answers[previewField.id])}</td>}
                <td style={{ padding: '8px', textAlign: 'right' }}><button onClick={() => setOpenSub(s)} style={btn}>View</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {more && rows?.length > 0 && (
        <button onClick={() => load(rows[rows.length - 1].submittedAt)} style={{ ...btn, marginTop: 12 }}>Load more</button>
      )}
    </div>
  );
}

function SubmissionDetail({ submission, form, tz, venueName, showToast, onBack }) {
  const [urls, setUrls] = useState({});
  useEffect(() => {
    let live = true;
    signSubmissionFiles([submission]).then((m) => { if (live) setUrls(m || {}); });
    return () => { live = false; };
  }, [submission]);
  const fields = submission.fields.length ? submission.fields : form.fields;

  const print = async () => {
    // Open the window straight from the tap (browsers block a later one), then fill it with
    // freshly signed pictures: the ones on screen may be older than their 10 minutes.
    const w = window.open('', '_blank', 'width=820,height=1000');
    if (!w) { showToast?.('Allow pop ups for this site to print.', 'error'); return; }
    const fresh = await signSubmissionFiles([submission]);
    w.document.open();
    w.document.write(buildSubmissionPrintHtml({
      formName: submission.formName || form.name, submission: { ...submission, fields },
      venueName, timeZone: tz, fileUrls: { ...urls, ...fresh },
    }));
    w.document.close();
  };

  return (
    <div style={card}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <button onClick={onBack} style={btn}>Back</button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--t1)' }}>{submission.formName || form.name}</div>
          <div style={{ fontSize: 12, color: 'var(--t3)' }}>
            {formatWhen(submission.submittedAt, tz)} · {submission.submittedByName || 'Not signed in'}{submission.source === 'back_office' ? ' · Back Office' : ' · tablet'}
          </div>
        </div>
        <button onClick={print} style={{ ...btn, display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="print" size={14} /> Print</button>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {fields.map((f) => {
          const v = submission.answers[f.id];
          const url = typeof v === 'string' ? urls[v] : null;
          return (
            <div key={f.id} style={{ display: 'grid', gridTemplateColumns: '240px 1fr', gap: 12, padding: '10px 0', borderTop: '1px solid var(--bdr)' }}>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--t2)' }}>{f.label}</div>
              <div style={{ fontSize: 13.5, color: 'var(--t1)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {(f.type === 'photo' || f.type === 'signature') && url ? (
                  <a href={url} target="_blank" rel="noopener noreferrer">
                    <img src={url} alt={f.label} style={{ maxWidth: f.type === 'signature' ? 320 : 360, maxHeight: f.type === 'signature' ? 130 : 320, borderRadius: 8, border: '1px solid var(--bdr)', background: '#fff' }} />
                  </a>
                ) : (answerText(f, v) || <span style={{ color: 'var(--t4, var(--t3))', fontStyle: 'italic' }}>No answer</span>)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
