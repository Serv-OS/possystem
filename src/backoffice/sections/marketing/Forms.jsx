// src/backoffice/sections/marketing/Forms.jsx
//
// Customers → Forms (5.12.40). Peter: "we need a way to have forms that you can create and embed on
// a website or on the website builder that then you can attach to an automation to trigger the code
// to be sent out automatically to the customer filling in the form".
//
// Build a form (up to 12 fields, the marketing tick with the venue's words, the button and thank you
// words, one venue or the whole company), see who sent it (newest first, CSV export), and put it
// anywhere: the Form block in the website builder, or the embed snippet on any website. The
// automation that sends a code lives in Automations (trigger "Form submitted"). Every rule is in
// src/lib/forms/formRules.js, the same file the marketing-forms and form-submit functions use.

import { useEffect, useMemo, useState } from 'react';
import { supabase, getActiveLocationSync } from '../../../lib/supabase';
import { useMarketingSites } from './useMarketingSites';
import { MarketingSitesBar, SiteBadge } from './MarketingSites';
import {
  FIELD_KINDS, CONTACT_KINDS, KIND_LABELS, LIMITS, newField, starterForm, normaliseFormDef, submissionsCsv, embedSnippet,
} from '../../../lib/forms/formRules.js';
import { FORM_CSS } from '../../../lib/forms/formHtml.js';
import { ServosForm } from '../../../surfaces/website/blocks/components/FormBlock.jsx';
import { siteVars } from '../../../surfaces/website/theme.js';
import { localeString, zoneOr } from '../../../lib/venueDates';

const S = {
  h1: { fontSize: 22, fontWeight: 800, color: 'var(--t1)', margin: 0, letterSpacing: '-.01em' },
  sub: { fontSize: 13, color: 'var(--t3)', marginTop: 4, marginBottom: 18, maxWidth: 760 },
  card: { border: '1px solid var(--bdr)', borderRadius: 14, background: 'var(--bg1)', padding: 18, marginBottom: 16, maxWidth: 1080 },
  h2: { fontSize: 15.5, fontWeight: 800, color: 'var(--t1)', margin: '0 0 12px' },
  label: { display: 'block', fontSize: 12, fontWeight: 700, color: 'var(--t2)', marginBottom: 6 },
  input: { width: '100%', boxSizing: 'border-box', border: '1px solid var(--bdr2)', borderRadius: 10, padding: '9px 12px', fontSize: 13.5, fontFamily: 'inherit', color: 'var(--t1)', background: 'var(--bg2)', outline: 'none' },
  ta: { width: '100%', boxSizing: 'border-box', border: '1px solid var(--bdr2)', borderRadius: 10, padding: '9px 12px', fontSize: 13, fontFamily: 'inherit', color: 'var(--t1)', background: 'var(--bg2)', outline: 'none', minHeight: 56, resize: 'vertical' },
  field: { marginBottom: 12 },
  hint: { fontSize: 11.5, color: 'var(--t4)', marginTop: 5, lineHeight: 1.45 },
  btn: { padding: '8px 16px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'inherit', background: 'var(--acc)', color: '#0b0c10' },
  ghost: { padding: '7px 12px', borderRadius: 8, cursor: 'pointer', fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit', background: 'transparent', color: 'var(--t2)', border: '1px solid var(--bdr2)' },
  ok: { fontSize: 12.5, color: 'var(--grn)', fontWeight: 700 },
  err: { fontSize: 12.5, color: 'var(--red)', fontWeight: 600 },
  empty: { textAlign: 'center', padding: '60px 20px', color: 'var(--t3)', fontSize: 14 },
  pill: { display: 'inline-block', padding: '2px 9px', borderRadius: 99, fontSize: 11, fontWeight: 700, background: 'var(--bg2)', border: '1px solid var(--bdr2)', color: 'var(--t2)' },
  row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '12px 0', borderTop: '1px solid var(--bdr2)', flexWrap: 'wrap' },
  fieldBox: { border: '1px solid var(--bdr2)', borderRadius: 12, background: 'var(--bg2)', padding: 12, marginBottom: 8 },
  grid2: { display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 12 },
  split: { display: 'grid', gridTemplateColumns: 'minmax(0,1.15fr) minmax(0,1fr)', gap: 18, alignItems: 'start' },
  th: { textAlign: 'left', fontSize: 11.5, fontWeight: 700, color: 'var(--t3)', padding: '6px 8px', borderBottom: '1px solid var(--bdr2)', whiteSpace: 'nowrap' },
  td: { fontSize: 12.5, color: 'var(--t1)', padding: '7px 8px', borderBottom: '1px solid var(--bdr2)', verticalAlign: 'top', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis' },
  code: { width: '100%', boxSizing: 'border-box', fontFamily: 'var(--font-mono, monospace)', fontSize: 12, border: '1px solid var(--bdr2)', borderRadius: 10, padding: 10, background: 'var(--bg2)', color: 'var(--t1)', minHeight: 96, resize: 'vertical' },
};

// Venue clock (the venue-clock rule): a submission's time reads in the form's venue timezone.
// 5.12.57 (US basics batch 8): in the venue's words (Nov 3, 2:05 PM at a US venue), and with no zone for the form
// the active venue's, never the laptop's ('' while a US venue's zone is not known yet).
const when = (iso, tz) => { const z = zoneOr(tz); if (!z) return ''; try { return localeString(iso, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: z }); } catch { return iso || ''; } };
const answerText = (v) => (v === true ? 'Yes' : v === false ? 'No' : String(v ?? ''));

function download(name, text) {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

export default function Forms() {
  const [locId, setLocId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [forms, setForms] = useState([]);
  const [venues, setVenues] = useState([]);
  const [notReady, setNotReady] = useState('');
  const [loadErr, setLoadErr] = useState('');
  const [editing, setEditing] = useState(null);
  const [save, setSave] = useState({});
  const [view, setView] = useState(null);      // { form, rows, total, offset, busy, err }
  const [embedFor, setEmbedFor] = useState(null);
  const [copied, setCopied] = useState(false);

  const call = (action, extra = {}) => supabase.functions.invoke('marketing-forms', { body: { action, ops_location_id: locId, ...extra } })
    .then(({ data, error }) => {
      if (data?.error) throw new Error(data.error);
      if (error) throw new Error(error.message);
      return data;
    });

  const load = async (id = locId) => {
    setLoadErr('');
    try {
      const { data, error } = await supabase.functions.invoke('marketing-forms', { body: { action: 'list_forms', ops_location_id: id } });
      if (error || data?.error) throw new Error(data?.error || error.message);
      setForms(data?.forms || []); setVenues(data?.venues || []); setNotReady(data?.not_ready || '');
    } catch (e) { setLoadErr(`Forms could not load: ${e.message || e}`); }
  };

  useEffect(() => {
    (async () => {
      try { const id = await getActiveLocationSync(); setLocId(id); if (!supabase || !id) return; await load(id); } catch { /* shown below */ } finally { setLoading(false); }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const venueName = (id) => (id ? (venues.find((v) => v.id === id)?.name || 'One venue') : 'Whole company');
  const venueTz = (id) => (venues.find((v) => v.id === id) || venues[0] || {}).timezone || undefined;
  // 5.12.69: the Sites control (src/lib/marketingSites.js): a form is the whole company's or one venue's.
  const scope = useMarketingSites(locId, venues);
  const visible = scope.filter('form', forms);

  // ── editing ──
  const check = useMemo(() => (editing ? normaliseFormDef(editing) : null), [editing]);
  const setField = (i, patch) => setEditing((e) => ({ ...e, fields: e.fields.map((f, j) => (j === i ? { ...f, ...patch } : f)) }));
  const addField = (kind) => setEditing((e) => (e.fields.length >= LIMITS.MAX_FIELDS ? e : { ...e, fields: [...e.fields, newField(kind, e.fields.map((f) => f.id))] }));
  const rmField = (i) => setEditing((e) => ({ ...e, fields: e.fields.filter((_, j) => j !== i) }));
  const moveField = (i, d) => setEditing((e) => { const j = i + d; if (j < 0 || j >= e.fields.length) return e; const n = [...e.fields]; [n[i], n[j]] = [n[j], n[i]]; return { ...e, fields: n }; });
  const usedContact = new Set((editing?.fields || []).map((f) => f.kind).filter((k) => CONTACT_KINDS.includes(k)));

  const saveForm = async () => {
    if (!check?.ok) { setSave({ err: check?.errors?.[0] || 'Check the form.' }); return; }
    setSave({ busy: true });
    try {
      await call('save_form', { form: { ...(editing.id ? { id: editing.id } : {}), ...check.clean } });
      setEditing(null); setSave({ done: true }); setTimeout(() => setSave((s) => (s.done ? {} : s)), 2500); await load();
    } catch (e) { setSave({ err: e.message || 'Save failed' }); }
  };

  const setStatus = async (f, status) => { try { await call('set_status', { id: f.id, status }); await load(); } catch (e) { setLoadErr(e.message); } };

  // ── submissions ──
  const openSubs = async (form, offset = 0) => {
    setView((v) => ({ ...(v && v.form.id === form.id ? v : { rows: [], total: 0 }), form, busy: true, err: '', offset }));
    try { const d = await call('list_submissions', { form_id: form.id, limit: 50, offset }); setView({ form, rows: d.rows || [], total: d.total || 0, offset, busy: false, err: '' }); }
    catch (e) { setView((v) => ({ ...v, busy: false, err: e.message })); }
  };
  const exportCsv = async (form) => {
    try {
      const d = await call('export_submissions', { form_id: form.id });
      const safe = String(form.name || 'form').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
      download(`${safe}-submissions.csv`, submissionsCsv(form, d.rows || []));
    } catch (e) { setView((v) => (v ? { ...v, err: e.message } : v)); }
  };

  // ── embed ──
  const origin = typeof window !== 'undefined' ? window.location.origin : 'https://app.serv-os.app';
  const snippet = embedFor ? embedSnippet(embedFor.id, origin) : '';
  const copy = async () => {
    try { await navigator.clipboard.writeText(snippet); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { setCopied(false); }
  };

  const previewVars = useMemo(() => { try { return siteVars({}, {}); } catch { return {}; } }, []);

  if (loading) return <div style={S.empty}>Loading…</div>;
  if (!supabase || !locId) return <div style={S.empty}>Pick a location to manage forms.</div>;

  return (
    <div>
      <style>{FORM_CSS}</style>
      <h1 style={S.h1}>Forms</h1>
      <div style={S.sub}>
        Collect names, emails and phone numbers on your website or any other site. Each person lands in Customers.
        To send them a promo code automatically, make an automation with the trigger <b>Form submitted</b> (Customers, Automations).
        Marketing is only ever sent to people who tick the marketing box.
      </div>
      <MarketingSitesBar scope={scope} what="forms" />
      {notReady && <div style={{ ...S.card, borderColor: 'var(--amber,#d98a00)' }}><div style={S.err}>{notReady}</div></div>}
      {loadErr && <div style={{ ...S.card }}><div style={S.err}>{loadErr}</div></div>}

      {/* List */}
      {!editing && !view && !embedFor && (
        <div style={S.card}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
            <h2 style={{ ...S.h2, margin: 0 }}>Your forms</h2>
            <button style={S.btn} onClick={() => { setEditing({ ...starterForm(), location_id: scope.siteId || null }); setSave({}); }}>+ New form</button>
          </div>
          {forms.length === 0 && <div style={{ ...S.hint, padding: '14px 0' }}>No forms yet. A sign up form with a welcome code is a good first one.</div>}
          {forms.length > 0 && visible.length === 0 && <div style={{ ...S.hint, padding: '14px 0' }}>No form is for {scope.siteName} or the whole company yet.</div>}
          {visible.map((f) => (
            <div key={f.id} style={S.row} data-form-row={f.id}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--t1)' }}>
                  {f.name} {f.status === 'archived' && <span style={{ ...S.pill, marginLeft: 6 }}>archived</span>}
                </div>
                <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 2 }}>
                  {venueName(f.location_id)} · {(f.fields || []).length} field{(f.fields || []).length === 1 ? '' : 's'} · <b>{f.submissions ?? 0}</b> sent
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                <button style={S.ghost} onClick={() => openSubs(f)}>Submissions</button>
                <button style={S.ghost} onClick={() => { setEmbedFor(f); setCopied(false); }}>Embed</button>
                <button style={S.ghost} onClick={() => { setEditing({ ...starterForm(), ...f }); setSave({}); }}>Edit</button>
                {f.status !== 'archived'
                  ? <button style={S.ghost} onClick={() => setStatus(f, 'archived')}>Archive</button>
                  : <button style={S.ghost} onClick={() => setStatus(f, 'active')}>Restore</button>}
              </div>
            </div>
          ))}
          {save.done && <div style={{ ...S.ok, marginTop: 10 }}>✓ Saved</div>}
        </div>
      )}

      {/* Builder */}
      {editing && (
        <div style={S.card}>
          <h2 style={S.h2}>{editing.id ? 'Edit form' : 'New form'}</h2>
          <div style={S.split}>
            <div>
              <div style={S.grid2}>
                <div style={S.field}><label style={S.label} htmlFor="form-name">Name</label><input id="form-name" style={S.input} value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="Join our list" /></div>
                <div style={S.field}><label style={S.label} htmlFor="form-venue">Which venue</label>
                  <select id="form-venue" style={S.input} value={editing.location_id || ''} onChange={(e) => setEditing({ ...editing, location_id: e.target.value || null })}>
                    <option value="">Whole company</option>
                    {venues.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                  </select>
                </div>
              </div>

              <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--t1)', margin: '6px 0 8px' }}>Fields <span style={{ color: 'var(--t4)', fontWeight: 600 }}>{editing.fields.length} of {LIMITS.MAX_FIELDS}</span></div>
              {editing.fields.map((f, i) => (
                <div key={`${f.id}-${i}`} style={S.fieldBox}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span style={S.pill}>{KIND_LABELS[f.kind]}</span>
                    <input aria-label={`Label for field ${i + 1}`} style={{ ...S.input, flex: '1 1 160px', width: 'auto' }} value={f.label} onChange={(e) => setField(i, { label: e.target.value })} />
                    <label style={{ fontSize: 12.5, color: 'var(--t2)', display: 'flex', gap: 5, alignItems: 'center' }}><input type="checkbox" checked={!!f.required} onChange={(e) => setField(i, { required: e.target.checked })} /> Required</label>
                    <button style={{ ...S.ghost, padding: '4px 8px' }} onClick={() => moveField(i, -1)} aria-label="Move up">↑</button>
                    <button style={{ ...S.ghost, padding: '4px 8px' }} onClick={() => moveField(i, 1)} aria-label="Move down">↓</button>
                    <button style={{ ...S.ghost, padding: '4px 8px', color: 'var(--red)' }} onClick={() => rmField(i)} aria-label="Remove field">✕</button>
                  </div>
                  {f.kind === 'dropdown' && (
                    <div style={{ marginTop: 8 }}>
                      <label style={S.label}>Choices, one per line</label>
                      <textarea style={S.ta} value={(f.options || []).join('\n')} onChange={(e) => setField(i, { options: e.target.value.split('\n') })} />
                    </div>
                  )}
                  {f.kind === 'text' && (
                    <label style={{ fontSize: 12.5, color: 'var(--t2)', display: 'flex', gap: 5, alignItems: 'center', marginTop: 8 }}><input type="checkbox" checked={!!f.long} onChange={(e) => setField(i, { long: e.target.checked })} /> A big box (for a message)</label>
                  )}
                </div>
              ))}
              {editing.fields.length < LIMITS.MAX_FIELDS && (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '6px 0 14px' }}>
                  {FIELD_KINDS.filter((k) => !usedContact.has(k)).map((k) => <button key={k} style={{ ...S.ghost, padding: '5px 10px' }} onClick={() => addField(k)}>+ {KIND_LABELS[k]}</button>)}
                </div>
              )}

              <div style={S.field}>
                <label style={{ fontSize: 13, color: 'var(--t1)', fontWeight: 700, display: 'flex', gap: 6, alignItems: 'center' }}>
                  <input type="checkbox" checked={editing.consent_enabled !== false} onChange={(e) => setEditing({ ...editing, consent_enabled: e.target.checked })} /> Show the marketing tick box
                </label>
                <textarea aria-label="Marketing tick words" style={{ ...S.ta, marginTop: 6 }} value={editing.consent_text} onChange={(e) => setEditing({ ...editing, consent_text: e.target.value })} disabled={editing.consent_enabled === false} />
                <div style={S.hint}>Your own words. Never ticked for them. Without a tick nothing marketing is sent (UK and US rules). Name what you will send and how to stop it.</div>
              </div>
              <div style={S.grid2}>
                <div style={S.field}><label style={S.label} htmlFor="form-submit">Button words</label><input id="form-submit" style={S.input} value={editing.submit_label} onChange={(e) => setEditing({ ...editing, submit_label: e.target.value })} /></div>
                <div style={S.field}><label style={S.label} htmlFor="form-thanks">Thank you words</label><input id="form-thanks" style={S.input} value={editing.thanks_text} onChange={(e) => setEditing({ ...editing, thanks_text: e.target.value })} /></div>
              </div>

              <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
                <button style={S.btn} onClick={saveForm} disabled={save.busy}>{save.busy ? 'Saving…' : (editing.id ? 'Save form' : 'Create form')}</button>
                <button style={S.ghost} onClick={() => { setEditing(null); setSave({}); }}>Cancel</button>
                {save.err && <span style={S.err}>{save.err}</span>}
                {!save.err && check && !check.ok && <span style={S.err}>{check.errors[0]}</span>}
              </div>
            </div>
            <div>
              <div style={{ ...S.label, marginBottom: 8 }}>Preview (your website shows it in your Appearance colours)</div>
              <div className="w-site" style={{ ...previewVars, padding: 18, borderRadius: 14, border: '1px solid var(--bdr2)', minHeight: 0 }}>
                {check && check.clean.fields.length
                  ? <ServosForm form={{ id: editing.id || '00000000-0000-0000-0000-000000000000', ...check.clean }} action="" title={check.clean.name} preview />
                  : <div style={S.hint}>Add a field to see the form.</div>}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Submissions */}
      {view && (
        <div style={S.card}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 10, flexWrap: 'wrap' }}>
            <h2 style={{ ...S.h2, margin: 0 }}>Submissions: {view.form.name} <span style={{ color: 'var(--t4)', fontWeight: 600 }}>{view.total}</span></h2>
            <div style={{ display: 'flex', gap: 8 }}>
              <button style={S.ghost} onClick={() => exportCsv(view.form)} disabled={!view.total}>Export CSV</button>
              <button style={S.ghost} onClick={() => setView(null)}>← Back</button>
            </div>
          </div>
          {view.err && <div style={S.err}>{view.err}</div>}
          {view.busy && <div style={S.hint}>Loading…</div>}
          {!view.busy && !view.rows.length && <div style={S.hint}>Nobody has sent this form yet.</div>}
          {view.rows.length > 0 && (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ borderCollapse: 'collapse', width: '100%' }}>
                <thead><tr>
                  <th style={S.th}>Sent</th>
                  {(view.form.fields || []).map((f) => <th key={f.id} style={S.th}>{f.label}</th>)}
                  <th style={S.th}>Marketing tick</th><th style={S.th}>Customer</th>
                </tr></thead>
                <tbody>
                  {view.rows.map((r) => (
                    <tr key={r.id}>
                      <td style={S.td}>{when(r.created_at, venueTz(view.form.location_id))}</td>
                      {(view.form.fields || []).map((f) => <td key={f.id} style={S.td} title={answerText(r.answers?.[f.id])}>{answerText(r.answers?.[f.id])}</td>)}
                      <td style={S.td}>{r.consent ? 'Yes' : 'No'}</td>
                      <td style={S.td}>{r.customer_name || (r.customer_id ? 'Customer' : '')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {view.total > 50 && (
            <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' }}>
              <button style={S.ghost} disabled={view.offset === 0} onClick={() => openSubs(view.form, Math.max(0, view.offset - 50))}>Newer</button>
              <button style={S.ghost} disabled={view.offset + 50 >= view.total} onClick={() => openSubs(view.form, view.offset + 50)}>Older</button>
              <span style={S.hint}>{view.offset + 1} to {Math.min(view.offset + 50, view.total)} of {view.total}</span>
            </div>
          )}
        </div>
      )}

      {/* Embed */}
      {embedFor && (
        <div style={S.card}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 10 }}>
            <h2 style={{ ...S.h2, margin: 0 }}>Put “{embedFor.name}” on a website</h2>
            <button style={S.ghost} onClick={() => setEmbedFor(null)}>← Back</button>
          </div>
          <div style={{ fontSize: 13, color: 'var(--t2)', fontWeight: 700, marginBottom: 6 }}>Your ServOS website</div>
          <div style={{ ...S.hint, marginTop: 0, marginBottom: 14 }}>In Channels, Appearance, Website builder: drop the <b>Form</b> block on a page and pick this form.</div>
          <div style={{ fontSize: 13, color: 'var(--t2)', fontWeight: 700, marginBottom: 6 }}>Any other website</div>
          <textarea readOnly style={S.code} value={snippet} onFocus={(e) => e.target.select()} aria-label="Embed code" />
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
            <button style={S.btn} onClick={copy}>{copied ? 'Copied' : 'Copy code'}</button>
            <a style={{ ...S.ghost, textDecoration: 'none' }} href={`${origin}/api/form?id=${embedFor.id}`} target="_blank" rel="noopener noreferrer">Open the form page</a>
          </div>
          <div style={S.hint}>Paste the code where the form should appear (WordPress: a Custom HTML block; Wix and Squarespace: an Embed code block). It takes your Appearance colours and works with JavaScript off too.</div>
        </div>
      )}
    </div>
  );
}
