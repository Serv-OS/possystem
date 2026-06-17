// src/backoffice/sections/marketing/Workflows.jsx
//
// Marketing → Workflows (slice 6): drip / automated sequences. A workflow has an entry trigger
// (signup / birthday / segment / manual) and an ordered list of steps, each with a delay, channel,
// content (block email + SMS) and optional offer. Customers are enrolled on the trigger and advanced
// daily by the engine (marketing-run). All sends go through marketing-send (consent/suppression/
// sandbox enforced). Reads/writes via the marketing-workflows edge fn.

import { useEffect, useState } from 'react';
import { supabase, getActiveLocationSync } from '../../../lib/supabase';
import EmailBuilder from './EmailBuilder';
import { compileEmail, STARTER_BLOCKS, MERGE_TAGS } from '../../../lib/emailCompiler';

const S = {
  h1: { fontSize: 22, fontWeight: 800, color: 'var(--t1)', margin: 0, letterSpacing: '-.01em' },
  sub: { fontSize: 13, color: 'var(--t3)', marginTop: 4, marginBottom: 18 },
  card: { border: '1px solid var(--bdr)', borderRadius: 14, background: 'var(--bg1)', padding: 18, marginBottom: 16, maxWidth: 880 },
  h2: { fontSize: 15.5, fontWeight: 800, color: 'var(--t1)', margin: '0 0 12px' },
  label: { display: 'block', fontSize: 12, fontWeight: 700, color: 'var(--t2)', marginBottom: 6 },
  input: { width: '100%', boxSizing: 'border-box', border: '1px solid var(--bdr2)', borderRadius: 10, padding: '9px 12px', fontSize: 13.5, fontFamily: 'inherit', color: 'var(--t1)', background: 'var(--bg2)', outline: 'none' },
  ta: { width: '100%', boxSizing: 'border-box', border: '1px solid var(--bdr2)', borderRadius: 10, padding: '9px 12px', fontSize: 13, fontFamily: 'inherit', color: 'var(--t1)', background: 'var(--bg2)', outline: 'none', minHeight: 56, resize: 'vertical' },
  field: { marginBottom: 12 },
  row3: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 },
  hint: { fontSize: 11.5, color: 'var(--t4)', marginTop: 5, lineHeight: 1.45 },
  btn: { padding: '8px 16px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'inherit', background: 'var(--acc)', color: '#0b0c10' },
  ghost: { padding: '7px 12px', borderRadius: 8, cursor: 'pointer', fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit', background: 'transparent', color: 'var(--t2)', border: '1px solid var(--bdr2)' },
  ok: { fontSize: 12.5, color: 'var(--grn)', fontWeight: 700 },
  err: { fontSize: 12, color: 'var(--red)' },
  empty: { textAlign: 'center', padding: '60px 20px', color: 'var(--t3)', fontSize: 14 },
  pill: { display: 'inline-block', padding: '2px 9px', borderRadius: 99, fontSize: 11, fontWeight: 700, background: 'var(--bg2)', border: '1px solid var(--bdr2)', color: 'var(--t2)' },
  row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '12px 0', borderTop: '1px solid var(--bdr2)' },
  step: { border: '1px solid var(--bdr2)', borderRadius: 12, background: 'var(--bg2)', padding: 12, marginBottom: 10 },
  stephead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer' },
};
const STATUS_COLOR = { active: 'var(--grn)', paused: 'var(--amber,#d98a00)', draft: 'var(--t4)', archived: 'var(--t4)' };

const newStep = (n) => ({ key: `s${n}_${Math.round(Math.random() * 1e6)}`, after_days: n === 0 ? 0 : 3, channel: 'email', subject: '', email_blocks: STARTER_BLOCKS(), sms_body: '', offer_id: '' });
const BLANK = () => ({ name: '', description: '', status: 'draft', entry_trigger: { type: 'signup' }, segment_id: '', steps: [newStep(0)] });
const ensureStepBlocks = (st) => ({ ...st, email_blocks: (Array.isArray(st.email_blocks) && st.email_blocks.length) ? st.email_blocks : (st.email_html ? [{ type: 'html', html: st.email_html }] : STARTER_BLOCKS()) });

export default function Workflows() {
  const [locId, setLocId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [workflows, setWorkflows] = useState([]);
  const [segments, setSegments] = useState([]);
  const [prebuilt, setPrebuilt] = useState([]);
  const [offers, setOffers] = useState([]);
  const [editing, setEditing] = useState(null);
  const [expanded, setExpanded] = useState(0);
  const [save, setSave] = useState({});
  const [runMsg, setRunMsg] = useState({});
  const [enrollView, setEnrollView] = useState(null);

  const call = (action, extra = {}) => supabase.functions.invoke('marketing-workflows', { body: { action, ops_location_id: locId, ...extra } })
    .then(({ data, error }) => { if (error) throw new Error(error.message); if (data?.error) throw new Error(data.error); return data; });

  const load = async (id = locId) => {
    const { data } = await supabase.functions.invoke('marketing-workflows', { body: { action: 'list_workflows', ops_location_id: id } });
    setWorkflows(data?.workflows || []); setSegments(data?.segments || []); setPrebuilt(data?.prebuilt || []); setOffers(data?.offers || []);
  };

  const segmentOptions = () => (
    <>
      {prebuilt.length > 0 && <optgroup label="Prebuilt audiences">{prebuilt.map((p) => <option key={p.key} value={`prebuilt:${p.key}`}>{p.icon} {p.name}</option>)}</optgroup>}
      {segments.length > 0 && <optgroup label="Your segments">{segments.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</optgroup>}
    </>
  );

  useEffect(() => {
    (async () => {
      try { const id = await getActiveLocationSync(); setLocId(id); if (!supabase || !id) { setLoading(false); return; } await load(id); } catch {} finally { setLoading(false); }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openEdit = (w) => { setEditing({ ...BLANK(), ...w, entry_trigger: w.entry_trigger || { type: 'signup' }, segment_id: w.segment_id || '', steps: (Array.isArray(w.steps) && w.steps.length ? w.steps : [newStep(0)]).map(ensureStepBlocks) }); setExpanded(0); setSave({}); };

  const saveWf = async () => {
    if (!editing?.name?.trim()) { setSave({ err: 'Give the workflow a name.' }); return; }
    if (!editing.steps.length) { setSave({ err: 'Add at least one step.' }); return; }
    setSave({ busy: true });
    try {
      const steps = editing.steps.map((st) => ({ key: st.key, after_days: Number(st.after_days) || 0, channel: st.channel, subject: st.subject || null, email_blocks: st.email_blocks || [], email_html: (st.channel === 'email' || st.channel === 'both') ? compileEmail(st.email_blocks || []) : null, sms_body: st.sms_body || null, offer_id: st.offer_id || null }));
      const workflow = { ...(editing.id ? { id: editing.id } : {}), name: editing.name.trim(), description: editing.description || null, status: editing.status || 'draft', entry_trigger: editing.entry_trigger || {}, segment_id: editing.segment_id || null, steps };
      await call('save_workflow', { workflow });
      setEditing(null); setSave({ done: true }); setTimeout(() => setSave((s) => (s.done ? {} : s)), 2000); await load();
    } catch (e) { setSave({ err: e.message || 'Save failed' }); }
  };

  const setStatus = async (w, status) => { try { await call('set_status', { id: w.id, status }); await load(); } catch (e) { alert(e.message); } };
  const del = async (w) => { if (!window.confirm(`Delete workflow "${w.name}"?`)) return; try { await call('delete_workflow', { id: w.id }); await load(); } catch (e) { alert(e.message); } };
  const runNow = async (w) => { setRunMsg((s) => ({ ...s, [w.id]: { busy: true } })); try { const d = await call('run_now', { id: w.id }); setRunMsg((s) => ({ ...s, [w.id]: { summary: d.summary } })); await load(); } catch (e) { setRunMsg((s) => ({ ...s, [w.id]: { err: e.message } })); } };
  const viewEnroll = async (w) => { try { const d = await call('list_enrollments', { workflow_id: w.id }); setEnrollView({ workflow: w, ...d }); } catch (e) { alert(e.message); } };

  // step editing
  const setStep = (i, patch) => setEditing((e) => ({ ...e, steps: e.steps.map((s, j) => (j === i ? { ...s, ...patch } : s)) }));
  const addStep = () => setEditing((e) => { const next = [...e.steps, newStep(e.steps.length)]; setExpanded(next.length - 1); return { ...e, steps: next }; });
  const rmStep = (i) => setEditing((e) => ({ ...e, steps: e.steps.filter((_, j) => j !== i) }));
  const moveStep = (i, d) => setEditing((e) => { const j = i + d; if (j < 0 || j >= e.steps.length) return e; const n = [...e.steps]; [n[i], n[j]] = [n[j], n[i]]; return { ...e, steps: n }; });

  const tr = editing?.entry_trigger || {};
  const setTrigger = (patch) => setEditing((e) => ({ ...e, entry_trigger: { ...e.entry_trigger, ...patch } }));

  if (loading) return <div style={S.empty}>Loading…</div>;
  if (!supabase || !locId) return <div style={S.empty}>Pick a location to manage workflows.</div>;

  return (
    <div>
      <h1 style={S.h1}>Workflows</h1>
      <div style={S.sub}>Automated drip sequences — e.g. a welcome series or post-visit follow-ups. Customers join on a trigger and move through the steps over time. Consent &amp; suppression are checked at every send.</div>

      {/* List */}
      {!editing && !enrollView && (
        <div style={S.card}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <h2 style={{ ...S.h2, margin: 0 }}>Your workflows</h2>
            <button style={S.btn} onClick={() => { setEditing(BLANK()); setExpanded(0); setSave({}); }}>+ New workflow</button>
          </div>
          {workflows.length === 0 && <div style={{ ...S.hint, padding: '14px 0' }}>No workflows yet. Create a welcome series to greet new sign-ups automatically.</div>}
          {workflows.map((w) => {
            const rm = runMsg[w.id] || {};
            return (
              <div key={w.id} style={S.row}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--t1)' }}>{w.name} <span style={{ ...S.pill, marginLeft: 6, color: STATUS_COLOR[w.status] || 'var(--t2)' }}>{w.status}</span></div>
                  <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 2 }}>On {w.entry_trigger?.type || 'manual'} · {(w.steps || []).length} step{(w.steps || []).length === 1 ? '' : 's'}</div>
                  {rm.summary && <div style={{ ...S.ok, marginTop: 6 }}>Ran: {rm.summary.enrolled} enrolled · {rm.summary.advanced} advanced · {rm.summary.completed} completed{rm.summary.failed ? ` · ${rm.summary.failed} failed` : ''}</div>}
                  {rm.err && <div style={S.err}>{rm.err}</div>}
                </div>
                <div style={{ display: 'flex', gap: 8, flexShrink: 0, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                  <button style={S.ghost} onClick={() => runNow(w)} disabled={rm.busy}>{rm.busy ? 'Running…' : 'Run now'}</button>
                  {w.status !== 'active' && <button style={S.ghost} onClick={() => setStatus(w, 'active')}>Activate</button>}
                  {w.status === 'active' && <button style={S.ghost} onClick={() => setStatus(w, 'paused')}>Pause</button>}
                  <button style={S.ghost} onClick={() => viewEnroll(w)}>Enrollments</button>
                  <button style={S.ghost} onClick={() => openEdit(w)}>Edit</button>
                </div>
              </div>
            );
          })}
          {save.done && <div style={{ ...S.ok, marginTop: 10 }}>✓ Saved</div>}
        </div>
      )}

      {/* Editor */}
      {editing && (
        <div style={S.card}>
          <h2 style={S.h2}>{editing.id ? 'Edit workflow' : 'New workflow'}</h2>
          <div style={S.field}><label style={S.label}>Name</label><input style={S.input} value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="Welcome series" /></div>
          <div style={S.row3}>
            <div style={S.field}><label style={S.label}>Enrol customers on…</label>
              <select style={S.input} value={tr.type || 'signup'} onChange={(e) => setTrigger({ type: e.target.value })}>
                <option value="signup">New sign-up</option><option value="birthday">Birthday</option><option value="segment">Entering a segment</option><option value="manual">Manual only</option>
              </select>
            </div>
            {(tr.type || 'signup') === 'birthday' && <div style={S.field}><label style={S.label}>Days before birthday</label><input style={S.input} type="number" min={0} max={60} value={tr.days_before ?? 7} onChange={(e) => setTrigger({ days_before: Number(e.target.value) })} /></div>}
            {tr.type === 'segment' && <div style={S.field}><label style={S.label}>Segment</label>
              <select style={S.input} value={tr.segment_id || ''} onChange={(e) => setTrigger({ segment_id: e.target.value })}><option value="">Select…</option>{segmentOptions()}</select>
            </div>}
          </div>

          <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--t1)', margin: '8px 0' }}>Steps</div>
          {editing.steps.map((st, i) => (
            <div key={st.key} style={S.step}>
              <div style={S.stephead} onClick={() => setExpanded(expanded === i ? -1 : i)}>
                <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)' }}>
                  {expanded === i ? '▾' : '▸'} Step {i + 1} · {i === 0 ? (Number(st.after_days) ? `${st.after_days}d after joining` : 'immediately') : `+${st.after_days}d`} · {st.channel}{st.offer_id ? ' · offer' : ''}
                </div>
                <div style={{ display: 'flex', gap: 4 }} onClick={(e) => e.stopPropagation()}>
                  <button style={{ ...S.ghost, padding: '4px 8px' }} onClick={() => moveStep(i, -1)}>↑</button>
                  <button style={{ ...S.ghost, padding: '4px 8px' }} onClick={() => moveStep(i, 1)}>↓</button>
                  <button style={{ ...S.ghost, padding: '4px 8px', color: 'var(--red)' }} onClick={() => rmStep(i)}>✕</button>
                </div>
              </div>
              {expanded === i && (
                <div style={{ marginTop: 10 }}>
                  <div style={S.row3}>
                    <div style={S.field}><label style={S.label}>{i === 0 ? 'Days after joining' : 'Days after previous step'}</label><input style={S.input} type="number" min={0} value={st.after_days} onChange={(e) => setStep(i, { after_days: Number(e.target.value) })} /></div>
                    <div style={S.field}><label style={S.label}>Channel</label><select style={S.input} value={st.channel} onChange={(e) => setStep(i, { channel: e.target.value })}><option value="email">Email</option><option value="sms">SMS</option><option value="both">Email + SMS</option></select></div>
                    <div style={S.field}><label style={S.label}>Attach offer <span style={{ color: 'var(--t4)', fontWeight: 500 }}>opt.</span></label><select style={S.input} value={st.offer_id || ''} onChange={(e) => setStep(i, { offer_id: e.target.value })}><option value="">No code</option>{offers.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></div>
                  </div>
                  {(st.channel === 'email' || st.channel === 'both') && (
                    <>
                      <div style={S.field}><label style={S.label}>Email subject</label><input style={S.input} value={st.subject || ''} onChange={(e) => setStep(i, { subject: e.target.value })} placeholder="Welcome {{first_name}}!" /></div>
                      <div style={S.field}><label style={S.label}>Email content</label><EmailBuilder blocks={st.email_blocks} onChange={(blocks) => setStep(i, { email_blocks: blocks })} /></div>
                    </>
                  )}
                  {(st.channel === 'sms' || st.channel === 'both') && (
                    <div style={S.field}><label style={S.label}>SMS message</label>
                      <div style={{ marginBottom: 6 }}>{MERGE_TAGS.map(([t]) => <button key={t} type="button" onClick={() => setStep(i, { sms_body: (st.sms_body || '') + t })} style={{ ...S.ghost, padding: '3px 8px', marginRight: 5, fontFamily: 'var(--font-mono,monospace)', fontSize: 11 }}>{t}</button>)}</div>
                      <textarea style={S.ta} value={st.sms_body || ''} onChange={(e) => setStep(i, { sms_body: e.target.value })} placeholder="Hi {{first_name}}…" />
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
          <button style={S.ghost} onClick={addStep}>+ Add step</button>

          <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 16 }}>
            <button style={S.btn} onClick={saveWf} disabled={save.busy}>{save.busy ? 'Saving…' : (editing.id ? 'Save workflow' : 'Create workflow')}</button>
            <button style={S.ghost} onClick={() => { setEditing(null); setSave({}); }}>Cancel</button>
            {save.err && <span style={S.err}>{save.err}</span>}
          </div>
          <div style={{ ...S.hint, marginTop: 10 }}>Save as a draft, use <b>Run now</b> to test (no step is sent twice), then <b>Activate</b>. Steps advance once per daily run.</div>
        </div>
      )}

      {/* Enrollments */}
      {enrollView && (
        <div style={S.card}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <h2 style={{ ...S.h2, margin: 0 }}>Enrollments — {enrollView.workflow.name}</h2>
            <button style={S.ghost} onClick={() => setEnrollView(null)}>← Back</button>
          </div>
          <div style={{ fontSize: 13, color: 'var(--t2)' }}><b>{enrollView.active}</b> active · <b>{enrollView.completed}</b> completed</div>
          {(enrollView.sends || []).length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--t2)', marginBottom: 4 }}>Recent step sends</div>
              {enrollView.sends.slice(0, 25).map((s, i) => <div key={i} style={{ fontSize: 12, color: 'var(--t3)' }}>· {new Date(s.created_at).toLocaleDateString('en-GB')} — {s.step_key} — {s.channel} — {s.status}{s.promo_code ? ` — ${s.promo_code}` : ''}</div>)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
