// src/backoffice/sections/headoffice/HqCheckin.jsx
//
// Head office, Weekly check in: "Close out the week". A director answers the company's questions
// for a week, department and site; the owner reads every check in in the Owner inbox and edits
// the questions there. Who may read what is the database's rule (hq_checkins_select); the inbox
// tab is shown only once isCompanyOwner (the database's own answer) has said true, so a director
// never sees a door that would be empty anyway.

import { useEffect, useMemo, useState } from 'react';
import { Icon } from '../../../components/ServOSIcons';
import { fetchQuestions, saveQuestions, sendCheckin, fetchCheckins, isCompanyOwner } from '../../../lib/hq/data.js';
import { weekStartIso, weekLabel, scoreOf } from '../../../lib/hq/checkinWeek.js';
import { DEPARTMENTS, departmentLabel } from '../../../lib/hq/departments.js';
import {
  page, card, mono, accBtn, btn, smallBtn, field, lbl, disabled, localeFor, dateTimeText, siteName,
  PageHead, SectionHead, Chip, AbsentCard, AmberLine, GreenLine, LoadingLine, EmptyCard, TabRow, Field,
} from './hqUi';

export default function HqCheckin({ hq }) {
  const locale = localeFor(hq.currency);
  const [tab, setTab] = useState('write');
  const [isOwner, setIsOwner] = useState(false);
  const [state, setState] = useState({ loading: true, absent: false, error: null, questions: [] });
  const [date, setDate] = useState(hq.today);
  const [department, setDepartment] = useState(DEPARTMENTS[0].id);
  const [locationId, setLocationId] = useState(hq.locationId && hq.sites.some((s) => s.id === hq.locationId) ? hq.locationId : '');
  const [answers, setAnswers] = useState({});
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(null);
  const [sendMsg, setSendMsg] = useState(null);

  const weekStart = useMemo(() => weekStartIso(date || hq.today), [date, hq.today]);
  const label = weekLabel(weekStart, locale);

  useEffect(() => {
    let live = true;
    Promise.all([fetchQuestions(hq.orgId), isCompanyOwner(hq.orgId)]).then(([q, owner]) => {
      if (!live) return;
      // The database's own answer, and only true opens the inbox (a failed call reads as false).
      setIsOwner(owner === true);
      if (q.absent) { setState({ loading: false, absent: true, error: null, questions: [] }); return; }
      setState({ loading: false, absent: false, error: q.error ? q.message : null, questions: q.data || [] });
    });
    return () => { live = false; };
  }, [hq.orgId]);

  const send = async () => {
    setSending(true); setSendMsg(null); setSent(null);
    const res = await sendCheckin({ department, locationId: locationId || null, answers, weekStart, questions: state.questions }, hq.orgId, hq.userName);
    setSending(false);
    if (res.error) setSendMsg(res.message); else setSent(label);
  };

  if (state.absent) {
    return (
      <div style={page}>
        <PageHead title="Close out the week" sub="A short set of questions at the end of every week. Only the owner can read what you write here." />
        <AbsentCard message="Ask ServOS to run migration 20261130a." />
      </div>
    );
  }

  return (
    <div style={page}>
      <PageHead title="Close out the week" sub="A short set of questions at the end of every week. Only the owner can read what you write here."
        right={isOwner ? <TabRow tabs={[['write', 'My check in'], ['inbox', 'Owner inbox']]} value={tab} onChange={setTab} /> : null} />
      {state.loading && <LoadingLine>Loading</LoadingLine>}
      <AmberLine>{state.error}</AmberLine>

      {tab === 'inbox' && isOwner && <OwnerInbox hq={hq} locale={locale} questions={state.questions} onQuestions={(qs) => setState((s) => ({ ...s, questions: qs }))} />}

      {tab === 'write' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 280px', gap: 18, alignItems: 'start' }}>
          <div style={{ ...card, padding: 18, display: 'grid', gap: 14 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
              <Field label="Week">
                <input type="date" style={field} value={date} onChange={(e) => setDate(e.target.value || hq.today)} />
                <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 4 }}>{label}</div>
              </Field>
              <Field label="Department">
                <select style={field} value={department} onChange={(e) => setDepartment(e.target.value)}>{DEPARTMENTS.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}</select>
              </Field>
              <Field label="Site">
                <select style={field} value={locationId} onChange={(e) => setLocationId(e.target.value)}><option value="">No site</option>{hq.sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
              </Field>
            </div>
            {state.questions.map((q, i) => (
              <div key={q.id}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', marginBottom: 6 }}>
                  <span className="mono" style={{ ...mono, fontSize: 11, color: 'var(--t4)', fontWeight: 700 }}>{String(i + 1).padStart(2, '0')}</span>
                  <div>
                    <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--t1)' }}>{q.label}</div>
                    {q.hint && <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 2 }}>{q.hint}</div>}
                  </div>
                </div>
                {q.type === 'score5' ? (
                  <div style={{ display: 'flex', gap: 6 }}>
                    {[1, 2, 3, 4, 5].map((n) => (
                      <button key={n} type="button" onClick={() => setAnswers((a) => ({ ...a, [q.id]: n }))}
                        style={{ ...btn, width: 44, padding: '8px 0', ...mono, fontWeight: 700, background: answers[q.id] === n ? 'var(--acc)' : 'var(--bg2)', color: answers[q.id] === n ? '#fff' : 'var(--t1)', borderColor: answers[q.id] === n ? 'var(--acc)' : 'var(--bdr2)' }}>{n}</button>
                    ))}
                  </div>
                ) : (
                  <textarea style={{ ...field, minHeight: 64, resize: 'vertical' }} value={answers[q.id] || ''} onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))} />
                )}
              </div>
            ))}
            <AmberLine>{sendMsg}</AmberLine>
            <GreenLine>{sent ? `Sent for ${sent}. You can resend to replace it.` : null}</GreenLine>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button type="button" style={{ ...accBtn, ...disabled(sending || state.loading) }} disabled={sending || state.loading} onClick={send}>{sending ? 'Sending' : 'Send check in'}</button>
            </div>
          </div>
          <div style={{ ...card, padding: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13.5, fontWeight: 700, color: 'var(--t1)' }}><Icon name="lock" size={16} style={{ color: 'var(--t3)' }} />Private by design</div>
            <div style={{ fontSize: 12.5, color: 'var(--t3)', lineHeight: 1.6, marginTop: 8 }}>
              Check ins go to the owner only. Other directors cannot open them, and the database enforces that, not just the screen.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function OwnerInbox({ hq, locale, questions, onQuestions }) {
  const [state, setState] = useState({ loading: true, error: null, rows: [] });
  const [week, setWeek] = useState('');
  const [openId, setOpenId] = useState(null);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    let live = true;
    fetchCheckins(hq.orgId).then((r) => { if (live) setState({ loading: false, error: r.error ? r.message : null, rows: r.data || [] }); });
    return () => { live = false; };
  }, [hq.orgId]);

  const weeks = [...new Set(state.rows.map((r) => r.week_start))];
  const shown = week ? state.rows.filter((r) => r.week_start === week) : state.rows;

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <select style={{ ...field, width: 'auto' }} value={week} onChange={(e) => setWeek(e.target.value)}>
          <option value="">Every week</option>
          {weeks.map((w) => <option key={w} value={w}>{weekLabel(w, locale)}</option>)}
        </select>
        <span style={{ fontSize: 12.5, color: 'var(--t3)' }}>{shown.length} check in{shown.length === 1 ? '' : 's'}</span>
        <span style={{ flex: 1 }} />
        <button type="button" style={btn} onClick={() => setEditing((v) => !v)}>{editing ? 'Close questions' : 'Edit questions'}</button>
      </div>
      {editing && <QuestionEditor hq={hq} questions={questions} onSaved={(qs) => { onQuestions(qs); setEditing(false); }} />}
      {state.loading && <LoadingLine>Loading</LoadingLine>}
      <AmberLine>{state.error}</AmberLine>
      {!state.loading && !shown.length && <EmptyCard title="No check ins yet" body="They show here the moment a director sends one." />}
      {shown.map((r) => {
        const open = openId === r.id;
        const score = r.score ?? scoreOf(r.answers, questions);
        return (
          <div key={r.id} style={card}>
            <button type="button" onClick={() => setOpenId(open ? null : r.id)} style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%', background: 'none', border: 0, padding: 0, cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left', color: 'var(--t1)' }}>
              <Icon name="chevron" size={13} style={{ color: 'var(--t4)', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }} />
              <span style={{ fontSize: 13, fontWeight: 600, minWidth: 190 }}>{weekLabel(r.week_start, locale)}</span>
              <span style={{ fontSize: 13 }}>{r.author_name || 'Someone'}</span>
              <Chip tone="t2">{departmentLabel(r.department)}</Chip>
              <span style={{ fontSize: 12.5, color: 'var(--t3)' }}>{siteName(hq.sites, r.location_id, 'No site')}</span>
              <span style={{ flex: 1 }} />
              {score !== null && <Chip tone={score >= 4 ? 'grn' : score >= 3 ? 'orn' : 'red'}>Confidence {score} / 5</Chip>}
              <span style={{ fontSize: 11.5, color: 'var(--t4)' }}>{dateTimeText(r.updated_at || r.created_at, hq.currency)}</span>
            </button>
            {open && (
              <div style={{ marginTop: 12, display: 'grid', gap: 10 }}>
                {questions.map((q, i) => {
                  const v = r.answers?.[q.id];
                  return (
                    <div key={q.id} style={{ display: 'grid', gridTemplateColumns: '28px 1fr', gap: 8 }}>
                      <span className="mono" style={{ ...mono, fontSize: 11, color: 'var(--t4)', fontWeight: 700, paddingTop: 2 }}>{String(i + 1).padStart(2, '0')}</span>
                      <div>
                        <div style={{ fontSize: 12.5, color: 'var(--t3)' }}>{q.label}</div>
                        <div style={{ fontSize: 13.5, color: v === undefined || v === '' ? 'var(--t4)' : 'var(--t1)', whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{v === undefined || v === '' ? 'Left blank' : (q.type === 'score5' ? `${v} / 5` : String(v))}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function QuestionEditor({ hq, questions, onSaved }) {
  const [list, setList] = useState(() => questions.map((q) => ({ ...q })));
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);
  const set = (i, k, v) => setList((l) => l.map((q, j) => (j === i ? { ...q, [k]: v } : q)));
  const move = (i, d) => setList((l) => { const n = [...l]; const j = i + d; if (j < 0 || j >= n.length) return l; [n[i], n[j]] = [n[j], n[i]]; return n; });
  const remove = (i) => setList((l) => l.filter((_, j) => j !== i));
  const add = () => setList((l) => [...l, { id: `q${Date.now().toString(36)}`, label: '', hint: '', type: 'text' }]);
  const save = async () => {
    setSaving(true); setMsg(null);
    const res = await saveQuestions(hq.orgId, list);
    setSaving(false);
    if (res.error) setMsg(res.message); else onSaved(res.data || []);
  };
  return (
    <div style={{ ...card, padding: 16 }}>
      <SectionHead title="The questions" sub="Every director answers these, in this order. A question with no label is dropped." style={{ margin: '0 0 10px' }} />
      <div style={{ display: 'grid', gap: 10 }}>
        {list.map((q, i) => (
          <div key={q.id} style={{ display: 'grid', gridTemplateColumns: '28px minmax(0, 1fr) 130px auto', gap: 8, alignItems: 'start' }}>
            <span className="mono" style={{ ...mono, fontSize: 11, color: 'var(--t4)', fontWeight: 700, paddingTop: 10 }}>{String(i + 1).padStart(2, '0')}</span>
            <div style={{ display: 'grid', gap: 6 }}>
              <input style={field} value={q.label} placeholder="The question" onChange={(e) => set(i, 'label', e.target.value)} />
              <input style={{ ...field, fontSize: 12 }} value={q.hint} placeholder="A hint under it (optional)" onChange={(e) => set(i, 'hint', e.target.value)} />
            </div>
            <select style={field} value={q.type} onChange={(e) => set(i, 'type', e.target.value)}><option value="text">Text</option><option value="score5">Score 1 to 5</option></select>
            <div style={{ display: 'flex', gap: 4 }}>
              <button type="button" style={smallBtn} onClick={() => move(i, -1)} aria-label="Move up"><Icon name="arrowUp" size={12} /></button>
              <button type="button" style={smallBtn} onClick={() => move(i, 1)} aria-label="Move down"><Icon name="arrowDown" size={12} /></button>
              <button type="button" style={smallBtn} onClick={() => remove(i)} aria-label="Remove"><Icon name="trash" size={12} /></button>
            </div>
          </div>
        ))}
      </div>
      <AmberLine>{msg}</AmberLine>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between', marginTop: 12 }}>
        <button type="button" style={btn} onClick={add}>Add a question</button>
        <button type="button" style={{ ...accBtn, ...disabled(saving) }} disabled={saving} onClick={save}>{saving ? 'Saving' : 'Save questions'}</button>
      </div>
      <div style={{ ...lbl, marginTop: 10, textTransform: 'none', letterSpacing: 0, fontWeight: 500 }}>The first score question is the confidence chip on each check in.</div>
    </div>
  );
}
