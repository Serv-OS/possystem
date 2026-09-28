// OpsForms: Back Office, Operations, Forms (28 Sep 2026, v5.11.4).
// Two views:
//   Completed forms: every submission at the venue, newest first, across all its forms. Filter
//     by form, search the answers and who submitted, and pick a date range (venue calendar
//     days). Open one to read every answer with its photos and signature, and Print it.
//     Export CSV downloads the rows the filters show: one form gives that form's own columns
//     (as before); every form gives one sheet with each form's questions in their own columns.
//   Edit forms: build and name the venue's forms (short text, long text, number, date, time,
//     yes or no, single and multiple choice, photo, signature; each with a required flag and a
//     help line). There are no ready made forms: an "Accident book" is a form the venue builds
//     and names itself (Peter, 28 Sep 2026).
// Submissions can hold personal data, so they are read HERE only (row level security: Back
// Office logins of the venue). Before migration 20260928c runs the screen says "not set up yet".

import { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react';
import { useStore } from '../../../store';
import { getActiveLocationSync, getLocationId, getAvailableLocations } from '../../../lib/supabase';
import { getLocationConfig, venueDayBoundsIso } from '../../../lib/locationTime';
import { reportSave } from '../../../lib/saveHealth';
import {
  fetchForms, saveForm, archiveForm, restoreForm, fetchCompletedForms, signSubmissionFiles,
} from '../../../lib/ops/forms';
import {
  FIELD_TYPES, CHOICE_TYPES, MAX_COMPLETED_ROWS, blankField, validateFormDef, fieldTypeLabel,
  answerText, formatWhen, submissionsToCsv, csvFileName, completedFormsToCsv, completedCsvFileName,
  buildSubmissionPrintHtml, searchWords, textHasWords, submissionSearchText, submissionPreview,
  dateRangeProblem, dateRangeText,
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
const tabBtn = (on) => ({ ...btn, background: on ? 'var(--acc-d)' : 'var(--bg2)', color: on ? 'var(--acc)' : 'var(--t2)', borderColor: on ? 'var(--acc)' : 'var(--bdr2)' });
// A filter that is set says so by its own colour: an empty date box in Safari shows today in
// grey, which reads as a filter that is on when it is not.
const onStyle = (on) => (on ? { borderColor: 'var(--acc)', background: 'var(--acc-d)' } : {});
const SHOW_STEP = 100;
const NO_FILTERS = { formId: '', fromYmd: '', toYmd: '', query: '' };
const plural = (n, word) => `${n.toLocaleString('en-GB')} ${word}${n === 1 ? '' : 's'}`;

async function resolveLoc(current) {
  return current || getActiveLocationSync() || await getLocationId().catch(() => null);
}

export default function OpsForms() {
  const showToast = useStore((s) => s.showToast);
  const byName = useBoActorName();
  const [locId, setLocId] = useState(getActiveLocationSync());
  const [tz, setTz] = useState('Europe/London');
  const [venueName, setVenueName] = useState('');
  const [forms, setForms] = useState([]);            // every form, archived ones included
  const [loading, setLoading] = useState(true);
  const [absent, setAbsent] = useState('');
  const [loadErr, setLoadErr] = useState('');
  const [view, setView] = useState(null);            // 'completed' | 'edit'; null: Completed once a form exists
  const [showArchived, setShowArchived] = useState(false);
  const [selId, setSelId] = useState(null);          // the form being edited, or 'new'
  const [resetN, setResetN] = useState(0);           // Cancel throws away unsaved edits
  const [filters, setFilters] = useState(NO_FILTERS); // Completed forms (kept while Edit forms is open)

  const reload = useCallback((selectId = null) => resolveLoc(locId).then((loc) => {
    if (loc && loc !== locId) setLocId(loc);
    return fetchForms(loc, { includeArchived: true }).then((r) => {
      const list = r.data || [];
      setAbsent(r.absent ? r.message : '');
      setLoadErr(r.error && !r.absent ? r.message : '');
      setForms(list);
      setSelId((prev) => {
        const want = selectId || prev;
        if (want === 'new') return want;
        if (want && list.some((f) => f.id === want)) return want;
        return (list.find((f) => !f.archivedAt) || list[0])?.id || null;
      });
      setLoading(false);
    });
  }), [locId]);
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

  const shownView = view || (forms.some((f) => !f.archivedAt) ? 'completed' : 'edit');
  const listed = forms.filter((f) => showArchived || !f.archivedAt);
  const firstId = () => (listed.find((f) => !f.archivedAt) || listed[0])?.id || null;
  const sel = selId && selId !== 'new' ? forms.find((f) => f.id === selId) || null : null;
  const seeCompleted = (id) => { setFilters((x) => ({ ...x, formId: id || '' })); setView('completed'); };

  return (
    <div style={{ height: '100%', overflowY: 'auto', background: 'var(--bg0)', padding: '22px 26px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 2, flexWrap: 'wrap' }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0, color: 'var(--t1)', flex: 1 }}>Forms</h1>
        {!absent && <button onClick={() => { setSelId('new'); setView('edit'); }} style={accBtn}>+ New form</button>}
      </div>
      <div style={{ fontSize: 13, color: 'var(--t3)', marginBottom: 14, maxWidth: 780, lineHeight: 1.5 }}>
        Give each form a name, for example Accident book. Staff find it by name on the Operations tablet and fill it in. Completed forms can hold personal data, so they are only shown here in Back Office.
      </div>

      {absent ? (
        <div style={{ ...card, maxWidth: 820, color: 'var(--t2)', fontSize: 13.5 }}>{absent}</div>
      ) : loading ? <div style={{ color: 'var(--t3)' }}>Loading...</div> : (
        <>
          <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
            {[['completed', 'Completed forms'], ['edit', 'Edit forms']].map(([k, l]) => (
              <button key={k} onClick={() => setView(k)} style={tabBtn(shownView === k)}>{l}</button>
            ))}
          </div>
          {loadErr && <div style={{ color: 'var(--red)', fontSize: 12.5, marginBottom: 10 }}>{loadErr}</div>}

          {shownView === 'completed' ? (
            <CompletedForms forms={forms} locId={locId} tz={tz} venueName={venueName} showToast={showToast}
              filters={filters} setFilters={setFilters} onEditForms={() => setView('edit')} />
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: '300px 1fr', gap: 16, alignItems: 'start' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {listed.length === 0 ? (
                  <div style={{ ...card, color: 'var(--t3)', fontSize: 13 }}>No forms yet. Build one with New form and give it a name.</div>
                ) : listed.map((f) => {
                  const on = f.id === selId;
                  return (
                    <button key={f.id} onClick={() => setSelId(f.id)} style={{
                      display: 'block', textAlign: 'left', cursor: 'pointer', fontFamily: 'inherit', color: 'var(--t1)',
                      background: on ? 'var(--acc-d)' : 'var(--bg1)', border: '1px solid var(--bdr)',
                      borderLeft: on ? '3px solid var(--acc)' : '1px solid var(--bdr)', borderRadius: 12, padding: '12px 16px',
                      opacity: f.archivedAt ? 0.6 : 1,
                    }}>
                      <div style={{ fontSize: 14, fontWeight: 600, color: on ? 'var(--acc)' : 'var(--t1)' }}>{f.name}</div>
                      <div style={{ fontSize: 11.5, color: 'var(--t3)', marginTop: 2 }}>
                        {f.fields.length} question{f.fields.length === 1 ? '' : 's'}{f.archivedAt ? ' · archived' : ''}
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
                    onSaved={(saved) => reload(saved?.id || null)}
                    onCancel={() => setSelId(firstId())} onChanged={() => reload()} />
                ) : sel ? (
                  <>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                      <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--t1)', flex: 1 }}>{sel.name}</div>
                      <button onClick={() => seeCompleted(sel.id)} style={btn}>See completed</button>
                    </div>
                    <Builder key={`${sel.id}:${sel.version}:${resetN}`} form={sel} locId={locId} byName={byName} showToast={showToast}
                      onSaved={(saved) => reload(saved?.id || sel.id)} onCancel={() => setResetN((n) => n + 1)} onChanged={() => reload(sel.id)} />
                  </>
                ) : (
                  <div style={{ ...card, padding: 40, color: 'var(--t3)', fontSize: 13, textAlign: 'center' }}>Select a form, or create a new one.</div>
                )}
              </div>
            </div>
          )}
        </>
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
    if (!archived && !window.confirm(`Archive "${form.name}"? It leaves the tablet. Its completed forms stay here.`)) return;
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
          Changing the questions does not change forms already completed: each keeps the questions it was made with.
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

// ── Completed forms: every form at the venue, filter, search, dates, detail, print, CSV ──
function CompletedForms({ forms, locId, tz, venueName, showToast, filters, setFilters, onEditForms }) {
  const { formId, fromYmd, toYmd, query } = filters;
  const setF = (patch) => setFilters((x) => ({ ...x, ...patch }));
  const [reloadN, setReloadN] = useState(0);
  // The rows of ONE load, tagged with the load's key: a result for older filters is never shown.
  const [res, setRes] = useState({ key: '', rows: [], done: false, err: '', capped: false });
  const [more, setMore] = useState({ sig: '', n: SHOW_STEP });
  const [openSub, setOpenSub] = useState(null);
  const q = useDeferredValue(query);

  const rangeErr = dateRangeProblem(fromYmd, toYmd);
  // Venue calendar days as real instants (from venue midnight, to the next venue midnight).
  const bounds = useMemo(() => {
    if (rangeErr) return null;
    try {
      return {
        fromIso: fromYmd ? venueDayBoundsIso(fromYmd, tz).fromIso : null,
        toIso: toYmd ? venueDayBoundsIso(toYmd, tz).toIso : null,
      };
    } catch {
      return null;
    }
  }, [fromYmd, toYmd, tz, rangeErr]);
  const fromIso = bounds?.fromIso || null;
  const toIso = bounds?.toIso || null;
  const key = bounds ? [locId || '', formId || '', fromIso || '', toIso || '', reloadN].join('|') : '';

  useEffect(() => {
    if (!key) return undefined;
    let live = true;
    fetchCompletedForms({
      formId: formId || null, fromIso, toIso,
      onPage: (rows) => { if (live) setRes({ key, rows, done: false, err: '', capped: false }); },
    }, locId).then((r) => {
      if (!live) return;
      setRes({ key, rows: r.data || [], done: true, err: r.error ? (r.message || 'Could not load every completed form.') : '', capped: !!r.capped });
    });
    return () => { live = false; };
  }, [key, formId, fromIso, toIso, locId]);

  const current = !!key && res.key === key;
  const rows = current ? res.rows : null;             // null until the first page is in
  const loadingMore = current && !res.done;
  const hay = useMemo(() => new Map((rows || []).map((s) => [s.id, submissionSearchText(s)])), [rows]);
  const filtered = useMemo(() => {
    const words = searchWords(q);
    return words.length ? (rows || []).filter((s) => textHasWords(hay.get(s.id), words)) : (rows || []);
  }, [rows, hay, q]);
  const formsById = useMemo(() => new Map(forms.map((f) => [f.id, f])), [forms]);
  const options = useMemo(() => [...forms].sort((a, b) => (
    (Number(!!a.archivedAt) - Number(!!b.archivedAt)) || a.name.localeCompare(b.name, 'en', { sensitivity: 'base' })
  )), [forms]);

  const nameFor = (s) => formsById.get(s.formId)?.name || s.formName || 'Form';
  const selForm = formId ? formsById.get(formId) || null : null;
  const searching = searchWords(q).length > 0;
  const anyFilter = !!(formId || fromYmd || toYmd || query.trim());
  const sig = `${key}|${q}`;
  const showN = more.sig === sig ? more.n : SHOW_STEP;
  const canExport = current && res.done && !res.err && filtered.length > 0;

  if (openSub) {
    return <SubmissionDetail submission={openSub} formName={nameFor(openSub)} form={formsById.get(openSub.formId) || null}
      tz={tz} venueName={venueName} showToast={showToast} onBack={() => setOpenSub(null)} />;
  }

  const exportCsv = () => {
    if (!canExport) return;
    if (selForm) downloadCsv(csvFileName(selForm.name), submissionsToCsv(selForm, filtered, { timeZone: tz }));
    else downloadCsv(completedCsvFileName(), completedFormsToCsv(filtered, { forms, timeZone: tz }));
    if (res.capped) showToast?.(`The file has the newest ${MAX_COMPLETED_ROWS.toLocaleString('en-GB')} only. Narrow the dates for older ones.`, 'error');
  };

  let summary = 'Loading...';
  if (rows) {
    const scope = `${selForm ? selForm.name : 'every form'}, ${dateRangeText(fromYmd, toYmd)}`;
    summary = `${plural(filtered.length, 'completed form')}${searching ? ` matching "${q.trim()}"` : ''}: ${scope}, newest first.`;
    if (loadingMore) summary += ` Loading more (${rows.length.toLocaleString('en-GB')} so far)...`;
  }
  const th = { padding: '6px 8px' };
  const td = { padding: '8px', color: 'var(--t2)' };

  return (
    <div>
      <div style={{ ...card, display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end', marginBottom: 12 }}>
        <div style={{ width: 240 }}>
          <label style={lbl} htmlFor="opsf-filter-form">Form</label>
          <select id="opsf-filter-form" value={formId} onChange={(e) => setF({ formId: e.target.value })} style={{ ...field, ...onStyle(!!formId) }}>
            <option value="">Every form</option>
            {options.map((f) => <option key={f.id} value={f.id}>{f.name}{f.archivedAt ? ' (archived)' : ''}</option>)}
          </select>
        </div>
        <div style={{ flex: '1 1 240px', minWidth: 200 }}>
          <label style={lbl} htmlFor="opsf-filter-search">Search</label>
          <input id="opsf-filter-search" type="search" value={query} onChange={(e) => setF({ query: e.target.value })}
            placeholder="Words in the answers, or who submitted" style={{ ...field, ...onStyle(!!query.trim()) }} />
        </div>
        <div>
          <label style={lbl} htmlFor="opsf-filter-from">From</label>
          <input id="opsf-filter-from" type="date" value={fromYmd} max={toYmd || undefined} onChange={(e) => setF({ fromYmd: e.target.value })} style={{ ...field, width: 160, ...onStyle(!!fromYmd) }} />
        </div>
        <div>
          <label style={lbl} htmlFor="opsf-filter-to">To</label>
          <input id="opsf-filter-to" type="date" value={toYmd} min={fromYmd || undefined} onChange={(e) => setF({ toYmd: e.target.value })} style={{ ...field, width: 160, ...onStyle(!!toYmd) }} />
        </div>
        {anyFilter && <button onClick={() => setFilters(NO_FILTERS)} style={btn}>Clear filters</button>}
      </div>
      {rangeErr && <div style={{ color: 'var(--red)', fontSize: 12.5, marginBottom: 10 }}>{rangeErr}</div>}

      {!rangeErr && (
        <div style={card}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
            <div style={{ fontSize: 13, color: 'var(--t2)', flex: 1, minWidth: 260 }}>{summary}</div>
            <button onClick={exportCsv} disabled={!canExport} title={canExport ? 'Download the completed forms shown, as a CSV file' : ''}
              style={{ ...btn, opacity: canExport ? 1 : 0.5, cursor: canExport ? 'pointer' : 'default' }}>Export CSV</button>
          </div>
          {current && res.err && (
            <div style={{ color: 'var(--red)', fontSize: 12.5, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span>{res.err}{rows?.length ? ` Only the newest ${rows.length.toLocaleString('en-GB')} are shown, so the list is not complete.` : ''}</span>
              <button onClick={() => setReloadN((n) => n + 1)} style={btn}>Try again</button>
            </div>
          )}
          {current && res.capped && (
            <div style={{ color: 'var(--t3)', fontSize: 12.5, marginBottom: 10 }}>
              Only the newest {MAX_COMPLETED_ROWS.toLocaleString('en-GB')} are loaded. Narrow the dates to see older ones.
            </div>
          )}
          {current && res.done && !res.err && rows.length === 0 && (
            <div style={{ color: 'var(--t3)', fontSize: 13, padding: '14px 0', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              {forms.length === 0 ? (
                <>
                  <span>No forms yet. Build one under Edit forms and give it a name; staff then fill it in on the Operations tablet.</span>
                  <button onClick={onEditForms} style={btn}>Edit forms</button>
                </>
              ) : formId || fromYmd || toYmd
                ? 'No completed forms for these filters.'
                : 'No completed forms yet. Staff fill forms in on the Operations tablet (Forms tile).'}
            </div>
          )}
          {rows && rows.length > 0 && filtered.length === 0 && (
            <div style={{ color: 'var(--t3)', fontSize: 13, padding: '14px 0' }}>No completed form matches &quot;{q.trim()}&quot;.</div>
          )}
          {filtered.length > 0 && (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: 'left', color: 'var(--t3)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '.05em' }}>
                  <th style={th}>Submitted</th>
                  {!selForm && <th style={th}>Form</th>}
                  <th style={th}>By</th>
                  <th style={th}>First answer</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {filtered.slice(0, showN).map((s) => {
                  const p = submissionPreview(s);
                  return (
                    <tr key={s.id} style={{ borderTop: '1px solid var(--bdr)' }}>
                      <td style={{ ...td, whiteSpace: 'nowrap', color: 'var(--t1)' }}>{formatWhen(s.submittedAt, tz)}</td>
                      {!selForm && <td style={{ ...td, color: 'var(--t1)', fontWeight: 600 }}>{nameFor(s)}</td>}
                      <td style={td}>{s.submittedByName || 'Not signed in'}</td>
                      <td style={{ ...td, maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {p ? <><span style={{ color: 'var(--t3)' }}>{p.label}: </span>{p.text}</> : ''}
                      </td>
                      <td style={{ padding: '8px', textAlign: 'right' }}><button onClick={() => setOpenSub(s)} style={btn}>View</button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {filtered.length > showN && (
            <button onClick={() => setMore({ sig, n: showN + SHOW_STEP })} style={{ ...btn, marginTop: 12 }}>
              Show {Math.min(SHOW_STEP, filtered.length - showN)} more ({(filtered.length - showN).toLocaleString('en-GB')} not shown)
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function SubmissionDetail({ submission, formName, form, tz, venueName, showToast, onBack }) {
  const [urls, setUrls] = useState({});
  useEffect(() => {
    let live = true;
    signSubmissionFiles([submission]).then((m) => { if (live) setUrls(m || {}); });
    return () => { live = false; };
  }, [submission]);
  // Each submission keeps the questions it was made with; the form's own only if it has none.
  const fields = submission.fields.length ? submission.fields : (form?.fields || []);

  const print = async () => {
    // Open the window straight from the tap (browsers block a later one), then fill it with
    // freshly signed pictures: the ones on screen may be older than their 10 minutes.
    const w = window.open('', '_blank', 'width=820,height=1000');
    if (!w) { showToast?.('Allow pop ups for this site to print.', 'error'); return; }
    const fresh = await signSubmissionFiles([submission]);
    w.document.open();
    w.document.write(buildSubmissionPrintHtml({
      formName, submission: { ...submission, fields },
      venueName, timeZone: tz, fileUrls: { ...urls, ...fresh },
    }));
    w.document.close();
  };

  return (
    <div style={card}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <button onClick={onBack} style={btn}>Back</button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--t1)' }}>{formName}</div>
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
