// src/surfaces/StaffSurface.jsx
//
// ServOS Staff (?mode=staff) — the staff SELF-SERVICE app, on their own phone.
// New surface (v5.5.996): until now the only staff-facing screen was the shared
// Time Clock tablet, which is the wrong place for anything that takes longer
// than a glance — a 20-minute training module would hold the clock hostage.
//
// Flow: onboarding emails a one-use link → they CREATE THEIR PASSWORD here →
// from then on email + password (Supabase Auth, Ops project). A portal auth
// user has no BO access rows, so RLS shows them nothing — every read/write goes
// through the staff-portal edge fn, which serves only THEIR data.
//
// Tabs: Shifts · News · Timesheets · Me. Training joins as a tab when the
// training module lands (TRAINING_MODULE_PLAN.md).

import { useEffect, useState, useCallback } from 'react';
import { staffSupabase as supabase, isMock } from '../lib/supabase';
import { Icon } from '../components/ServOSIcons';

const glass = { padding: '14px 16px', borderRadius: 16 };

async function callPortal(body, jwt) {
  const url = `${supabase.supabaseUrl || import.meta.env.VITE_SUPABASE_URL}/functions/v1/staff-portal`;
  const headers = { 'content-type': 'application/json' };
  if (jwt) headers.authorization = `Bearer ${jwt}`;
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.error) throw new Error(j.error || `Request failed (${res.status})`);
  return j;
}

const fmtDay = iso => new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
const fmtStamp = (iso) => iso ? new Date(iso).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
const hm = h => { const m = Math.round((Number(h) || 0) * 60); return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`; };

export default function StaffSurface() {
  const [stage, setStage] = useState('boot');   // boot | invite | login | app
  const [inviteToken] = useState(() => new URLSearchParams(window.location.search).get('invite') || '');
  const [snap, setSnap] = useState(null);
  const [tab, setTab] = useState('shifts');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');

  // The staff app deliberately uses the servos glass skin (same as Manager).
  useEffect(() => {
    const el = document.documentElement;
    const prev = el.getAttribute('data-skin');
    el.setAttribute('data-skin', 'servos');
    return () => { if (prev) el.setAttribute('data-skin', prev); else el.removeAttribute('data-skin'); };
  }, []);

  const loadSnapshot = useCallback(async () => {
    const { data: sess } = await supabase.auth.getSession();
    const jwt = sess?.session?.access_token;
    if (!jwt) { setStage('login'); return; }
    try {
      const s = await callPortal({ action: 'snapshot' }, jwt);
      setSnap(s); setStage('app');
    } catch (e) {
      // An expired or revoked staff login → back to the login screen. This
      // client's storage is isolated ('rpos-staff-auth'), so signing out here
      // can never touch a Back Office or POS session — see lib/supabase.js.
      if (/not signed in/i.test(e.message)) { await supabase.auth.signOut().catch(() => {}); setStage('login'); }
      else setErr(e.message);
    }
  }, []);

  useEffect(() => {
    if (isMock || !supabase) return;
    if (inviteToken) { setStage('invite'); return; }
    loadSnapshot();
  }, [inviteToken, loadSnapshot]);

  if (isMock || !supabase) {
    return <Shell><div className="sv-glass" style={glass}>The staff app needs the live system — it isn't available in local demo mode.</div></Shell>;
  }

  // ── invite: create the password ─────────────────────────────────────────────
  if (stage === 'invite') {
    return (
      <Shell title="Set up your login">
        <CreateLogin
          onSubmit={async (password) => {
            setBusy(true); setErr('');
            try {
              const r = await callPortal({ action: 'accept_invite', token: inviteToken, password });
              const { error } = await supabase.auth.signInWithPassword({ email: r.email, password });
              if (error) throw new Error(error.message);
              // Drop the one-use token from the URL so a refresh doesn't retry it.
              window.history.replaceState(null, '', '?mode=staff');
              await loadSnapshot();
            } catch (e) { setErr(e.message); }
            finally { setBusy(false); }
          }}
          busy={busy} err={err}
        />
      </Shell>
    );
  }

  // ── login ───────────────────────────────────────────────────────────────────
  if (stage === 'login' || stage === 'boot') {
    return (
      <Shell title="Staff app">
        {stage === 'boot' ? <div className="sv-glass" style={glass}>Loading…</div> : (
          <Login
            busy={busy} err={err} notice={notice}
            onSubmit={async (email, password) => {
              setBusy(true); setErr(''); setNotice('');
              try {
                const { error } = await supabase.auth.signInWithPassword({ email, password });
                if (error) throw new Error(/invalid/i.test(error.message) ? 'Wrong email or password' : error.message);
                await loadSnapshot();
              } catch (e) { setErr(e.message); }
              finally { setBusy(false); }
            }}
            onForgot={async (email) => {
              if (!email) { setErr('Type your email first, then tap Forgotten password'); return; }
              setBusy(true); setErr('');
              try { await callPortal({ action: 'reset_start', email }); setNotice('If that email is on file, a new setup link is on its way.'); }
              catch { setNotice('If that email is on file, a new setup link is on its way.'); }
              finally { setBusy(false); }
            }}
          />
        )}
      </Shell>
    );
  }

  // ── the app ─────────────────────────────────────────────────────────────────
  const me = snap?.me || {};
  return (
    <Shell
      title={`Hi, ${String(me.name || '').split(' ')[0]}`}
      right={<button onClick={async () => { await supabase.auth.signOut(); setSnap(null); setStage('login'); }} className="sv-glass" style={{ padding: '7px 12px', borderRadius: 999, border: '1px solid var(--bdr)', color: 'var(--t3)', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>Sign out</button>}
    >
      {tab === 'shifts' && <ShiftsTab snap={snap} onChanged={loadSnapshot} />}
      {tab === 'tasks' && <TasksTab snap={snap} onChanged={loadSnapshot} goToMe={() => setTab('me')} />}
      {tab === 'news' && <NewsTab snap={snap} />}
      {tab === 'sheets' && <SheetsTab snap={snap} />}
      {tab === 'me' && <MeTab snap={snap} onSaved={loadSnapshot} />}
      <nav style={{ position: 'fixed', left: 0, right: 0, bottom: 12, display: 'flex', justifyContent: 'center', pointerEvents: 'none' }}>
        <div className="sv-glass" style={{ display: 'flex', gap: 4, padding: 6, borderRadius: 999, pointerEvents: 'auto' }}>
          {[['shifts', 'clock', 'Shifts'], ['tasks', 'check', 'Tasks'], ['news', 'status', 'News'], ['sheets', 'clipboard', 'Sheets'], ['me', 'team', 'Me']].map(([k, icon, lbl]) => (
            <button key={k} onClick={() => setTab(k)} style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, minWidth: 58,
              padding: '8px 10px', borderRadius: 999, border: 'none', cursor: 'pointer', fontFamily: 'inherit',
              background: tab === k ? 'var(--acc)' : 'transparent', color: tab === k ? '#fff' : 'var(--t2)', fontSize: 10.5, fontWeight: 700,
            }}>
              <Icon name={icon} size={16} />{lbl}
            </button>
          ))}
        </div>
      </nav>
    </Shell>
  );
}

function Shell({ title, right, children }) {
  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', color: 'var(--t1)', padding: '18px 14px 96px', maxWidth: 560, margin: '0 auto' }}>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <div>
          <div className="mono" style={{ fontSize: 10, letterSpacing: '.18em', textTransform: 'uppercase', color: 'var(--acc)' }}>ServOS Staff</div>
          {title && <div style={{ fontSize: 20, fontWeight: 800, marginTop: 2 }}>{title}</div>}
        </div>
        {right}
      </header>
      {children}
    </div>
  );
}

function Field({ label, ...props }) {
  return (
    <label style={{ display: 'block', marginBottom: 12 }}>
      <span style={{ display: 'block', fontSize: 11, fontWeight: 700, color: 'var(--t3)', marginBottom: 5, letterSpacing: '.04em', textTransform: 'uppercase' }}>{label}</span>
      <input {...props} style={{ width: '100%', padding: '12px 14px', borderRadius: 12, border: '1px solid var(--bdr)', background: 'var(--bg2)', color: 'var(--t1)', fontSize: 15, fontFamily: 'inherit', boxSizing: 'border-box' }} />
    </label>
  );
}
const Primary = ({ children, ...p }) => (
  <button {...p} style={{ width: '100%', padding: '13px 16px', borderRadius: 12, border: 'none', background: 'var(--acc)', color: '#fff', fontSize: 15, fontWeight: 800, cursor: p.disabled ? 'default' : 'pointer', opacity: p.disabled ? 0.6 : 1, fontFamily: 'inherit' }}>{children}</button>
);
const ErrLine = ({ children }) => children ? <div style={{ color: 'var(--red)', fontSize: 12.5, fontWeight: 600, margin: '10px 0' }}>{children}</div> : null;

function CreateLogin({ onSubmit, busy, err }) {
  const [p1, setP1] = useState(''); const [p2, setP2] = useState('');
  const mismatch = p1 && p2 && p1 !== p2;
  return (
    <div className="sv-glass" style={glass}>
      <div style={{ fontSize: 14, color: 'var(--t2)', lineHeight: 1.6, marginBottom: 16 }}>
        Welcome to the team. Choose a password and you're in — you'll use it with your email address from now on.
      </div>
      <Field label="Password" type="password" value={p1} onChange={e => setP1(e.target.value)} autoComplete="new-password" placeholder="At least 8 characters" />
      <Field label="Repeat password" type="password" value={p2} onChange={e => setP2(e.target.value)} autoComplete="new-password" />
      {mismatch && <ErrLine>Passwords don't match</ErrLine>}
      <ErrLine>{err}</ErrLine>
      <Primary disabled={busy || !p1 || p1.length < 8 || p1 !== p2} onClick={() => onSubmit(p1)}>{busy ? 'Setting up…' : 'Create my login'}</Primary>
    </div>
  );
}

function Login({ onSubmit, onForgot, busy, err, notice }) {
  const [email, setEmail] = useState(''); const [pw, setPw] = useState('');
  return (
    <div className="sv-glass" style={glass}>
      <Field label="Email" type="email" value={email} onChange={e => setEmail(e.target.value)} autoComplete="email" inputMode="email" />
      <Field label="Password" type="password" value={pw} onChange={e => setPw(e.target.value)} autoComplete="current-password" />
      <ErrLine>{err}</ErrLine>
      {notice && <div style={{ color: 'var(--grn)', fontSize: 12.5, fontWeight: 600, margin: '10px 0' }}>{notice}</div>}
      <Primary disabled={busy || !email || !pw} onClick={() => onSubmit(email.trim(), pw)}>{busy ? 'Signing in…' : 'Sign in'}</Primary>
      <button onClick={() => onForgot(email.trim())} disabled={busy} style={{ display: 'block', margin: '14px auto 2px', background: 'none', border: 'none', color: 'var(--t3)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>Forgotten password?</button>
    </div>
  );
}

// ── tabs ─────────────────────────────────────────────────────────────────────

async function withJwt(body) {
  const { data: sess } = await supabase.auth.getSession();
  return callPortal(body, sess?.session?.access_token);
}

function ShiftsTab({ snap, onChanged }) {
  const shifts = snap?.shifts || [];
  const leave = snap?.leave || { accruedHours: 0, requests: [] };
  const [requesting, setRequesting] = useState(false);
  const [form, setForm] = useState({ type: 'holiday', from: '', to: '', note: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const TONE = { pending: 'var(--amber)', approved: 'var(--grn)', denied: 'var(--red)' };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {!shifts.length
        ? <div className="sv-glass" style={glass}>No published shifts in the next two weeks. When the rota is published, they show here.</div>
        : shifts.map((s, i) => (
          <div key={i} className="sv-glass" style={{ ...glass, display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14.5, fontWeight: 800 }}>{fmtDay(s.date)}</div>
              {s.section && <div style={{ fontSize: 11.5, color: 'var(--t3)', marginTop: 2 }}>{s.section}</div>}
            </div>
            <div style={{ textAlign: 'right' }}>
              <div className="mono" style={{ fontSize: 15, fontWeight: 700 }}>{s.start}–{s.finish}</div>
              {s.breakMins > 0 && <div style={{ fontSize: 10.5, color: 'var(--t4)', marginTop: 2 }}>{s.breakMins}m break</div>}
            </div>
          </div>
        ))}

      {/* ── Time off ── */}
      <div className="sv-glass" style={{ ...glass, marginTop: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <span style={{ fontSize: 13.5, fontWeight: 800 }}>Time off</span>
          <button onClick={() => { setRequesting(r => !r); setErr(''); }} style={{ background: 'none', border: '1px solid var(--bdr)', borderRadius: 999, padding: '5px 12px', color: requesting ? 'var(--t3)' : 'var(--acc)', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>{requesting ? 'Cancel' : 'Request time off'}</button>
        </div>
        <div style={{ fontSize: 12, color: 'var(--t3)', marginBottom: requesting || leave.requests.length ? 10 : 0 }}>
          Holiday accrued so far: <b className="mono" style={{ color: 'var(--t1)' }}>{hm(leave.accruedHours)}</b>
        </div>
        {requesting && (
          <div>
            <label style={{ display: 'block', marginBottom: 12 }}>
              <span style={{ display: 'block', fontSize: 11, fontWeight: 700, color: 'var(--t3)', marginBottom: 5, letterSpacing: '.04em', textTransform: 'uppercase' }}>Type</span>
              <select value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value }))} style={{ width: '100%', padding: '12px 14px', borderRadius: 12, border: '1px solid var(--bdr)', background: 'var(--bg2)', color: 'var(--t1)', fontSize: 15, fontFamily: 'inherit' }}>
                <option value="holiday">Holiday</option><option value="unpaid">Unpaid leave</option><option value="sick">Sick</option><option value="parental">Parental</option>
              </select>
            </label>
            <Field label="First day" type="date" value={form.from} onChange={e => setForm(f => ({ ...f, from: e.target.value }))} />
            <Field label="Last day" type="date" value={form.to} onChange={e => setForm(f => ({ ...f, to: e.target.value }))} />
            <Field label="Note (optional)" value={form.note} onChange={e => setForm(f => ({ ...f, note: e.target.value }))} placeholder="Anything your manager should know" />
            <ErrLine>{err}</ErrLine>
            <Primary disabled={busy || !form.from} onClick={async () => {
              setBusy(true); setErr('');
              try {
                await withJwt({ action: 'timeoff_request', type: form.type, from: form.from, to: form.to || form.from, note: form.note });
                setRequesting(false); setForm({ type: 'holiday', from: '', to: '', note: '' });
                await onChanged();
              } catch (e) { setErr(e.message); }
              finally { setBusy(false); }
            }}>{busy ? 'Sending…' : 'Send request'}</Primary>
          </div>
        )}
        {leave.requests.map(r => (
          <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', borderTop: '1px solid var(--bdr)', fontSize: 12.5 }}>
            <span style={{ flex: 1 }}>
              <b style={{ textTransform: 'capitalize' }}>{r.type}</b> · {fmtDay(r.from)}{r.to !== r.from ? ` – ${fmtDay(r.to)}` : ''}{r.days != null ? ` (${r.days}d)` : ''}
            </span>
            <b style={{ color: TONE[r.status] || 'var(--t3)', fontSize: 11.5, textTransform: 'capitalize' }}>{r.status}</b>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Tasks: onboarding to-dos + training modules ─────────────────────────────
function TasksTab({ snap, onChanged, goToMe }) {
  const onb = snap?.onboarding;
  const training = snap?.training || [];
  const [busyTask, setBusyTask] = useState('');
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState('');

  const uploadRtw = async (file) => {
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { setErr('The file must be under 10MB'); return; }
    setUploading(true); setErr('');
    try {
      const ext = (String(file.name).split('.').pop() || 'jpg').toLowerCase();
      const { path, token } = await withJwt({ action: 'rtw_upload_url', ext });
      const { error } = await supabase.storage.from('wf-documents').uploadToSignedUrl(path, token, file);
      if (error) throw new Error(error.message);
      await withJwt({ action: 'rtw_submit', path });
      await onChanged();
    } catch (e) { setErr(e.message); }
    finally { setUploading(false); }
  };

  const tick = async (assignmentId, taskId, done) => {
    setBusyTask(`${assignmentId}:${taskId}`); setErr('');
    try { await withJwt({ action: 'training_tick', assignment_id: assignmentId, task_id: taskId, done }); await onChanged(); }
    catch (e) { setErr(e.message); }
    finally { setBusyTask(''); }
  };

  if (!onb?.open && !training.length) {
    return <div className="sv-glass" style={glass}>Nothing to do right now. Onboarding steps and training modules appear here when they're assigned to you.</div>;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <ErrLine>{err}</ErrLine>

      {onb?.open && (
        <div className="sv-glass" style={glass}>
          <div style={{ fontSize: 13.5, fontWeight: 800, marginBottom: 10 }}>Getting you started</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {onb.steps.map(st => (
              <div key={st.key} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{
                  width: 20, height: 20, borderRadius: '50%', flexShrink: 0, display: 'grid', placeItems: 'center',
                  background: st.done ? 'var(--grn)' : 'var(--bg2)', border: st.done ? 'none' : '1px solid var(--bdr)', color: '#fff', fontSize: 11,
                }}>{st.done ? '✓' : ''}</span>
                <span style={{ flex: 1, fontSize: 13.5, fontWeight: 600, color: st.done ? 'var(--t3)' : 'var(--t1)', textDecoration: st.done ? 'line-through' : 'none' }}>{st.label}</span>
                {!st.done && st.action === 'sign' && st.signUrl && (
                  <a href={st.signUrl} target="_blank" rel="noopener noreferrer" style={{ background: 'var(--acc)', color: '#fff', borderRadius: 999, padding: '6px 13px', fontSize: 12, fontWeight: 700, textDecoration: 'none' }}>Sign</a>
                )}
                {!st.done && st.action === 'rtw' && (
                  <label style={{ background: 'var(--acc)', color: '#fff', borderRadius: 999, padding: '6px 13px', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
                    {uploading ? 'Uploading…' : 'Upload'}
                    <input type="file" accept="image/*,.pdf" style={{ display: 'none' }} disabled={uploading} onChange={e => { uploadRtw(e.target.files?.[0]); e.target.value = ''; }} />
                  </label>
                )}
                {!st.done && st.action === 'bank' && (
                  <button onClick={goToMe} style={{ background: 'var(--acc)', color: '#fff', border: 'none', borderRadius: 999, padding: '6px 13px', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>Add</button>
                )}
                {!st.done && !st.action && st.waiting && <span style={{ fontSize: 10.5, color: 'var(--t4)' }}>{st.waiting}</span>}
              </div>
            ))}
          </div>
          <div style={{ fontSize: 10.5, color: 'var(--t4)', marginTop: 10, lineHeight: 1.5 }}>
            Your Right to Work upload is reviewed by a manager before it counts.
          </div>
        </div>
      )}

      {training.map(t => {
        const done = t.tasks.filter(x => x.done).length;
        return (
          <div key={t.id} className="sv-glass" style={glass}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13.5, fontWeight: 800, flex: 1 }}>{t.name}</span>
              {t.status === 'complete'
                ? <b style={{ color: 'var(--grn)', fontSize: 11.5 }}>Complete ✓</b>
                : t.overdue
                  ? <b style={{ color: 'var(--red)', fontSize: 11.5 }}>Overdue — was due {fmtDay(t.due)}</b>
                  : t.due && <span style={{ fontSize: 11, color: 'var(--t4)' }}>Due {fmtDay(t.due)}</span>}
            </div>
            {t.description && <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 4, lineHeight: 1.5 }}>{t.description}</div>}
            {/* progress */}
            <div style={{ height: 4, borderRadius: 2, background: 'var(--bg2)', margin: '10px 0' }}>
              <div style={{ height: 4, borderRadius: 2, width: `${t.tasks.length ? Math.round(done / t.tasks.length * 100) : 0}%`, background: t.status === 'complete' ? 'var(--grn)' : 'var(--acc)', transition: 'width .25s' }} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {t.tasks.map(task => {
                const busy = busyTask === `${t.id}:${task.id}`;
                return (
                  <label key={task.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer', opacity: busy ? 0.5 : 1 }}>
                    <input type="checkbox" checked={task.done} disabled={busy} onChange={() => tick(t.id, task.id, !task.done)} style={{ marginTop: 2 }} />
                    <span>
                      <span style={{ fontSize: 13, fontWeight: 600, color: task.done ? 'var(--t3)' : 'var(--t1)', textDecoration: task.done ? 'line-through' : 'none' }}>{task.title}</span>
                      {task.detail && <span style={{ display: 'block', fontSize: 11.5, color: 'var(--t4)', marginTop: 2, lineHeight: 1.45 }}>{task.detail}</span>}
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function NewsTab({ snap }) {
  const items = snap?.announcements || [];
  if (!items.length) return <div className="sv-glass" style={glass}>No announcements right now.</div>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {items.map((a, i) => (
        <div key={i} className="sv-glass" style={glass}>
          <div style={{ fontSize: 14, lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>{a.body}</div>
          <div style={{ fontSize: 11, color: 'var(--t4)', marginTop: 8 }}>{a.author || 'Management'} · {fmtStamp(a.at)}</div>
        </div>
      ))}
    </div>
  );
}

function SheetsTab({ snap }) {
  const rows = (snap?.timesheets || []).filter(t => t.out);
  if (!rows.length) return <div className="sv-glass" style={glass}>No timesheets in the last four weeks. Clock in as usual — they appear here after your shift.</div>;
  const totalH = rows.reduce((a, t) => a + (t.hours || 0), 0);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div className="sv-glass" style={{ ...glass, display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span style={{ fontSize: 12, color: 'var(--t3)', fontWeight: 700 }}>Last 4 weeks</span>
        <span className="mono" style={{ fontSize: 16, fontWeight: 800 }}>{hm(totalH)}</span>
      </div>
      {rows.map((t, i) => (
        <div key={i} className="sv-glass" style={{ ...glass, display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13.5, fontWeight: 700 }}>{fmtStamp(t.in)}</div>
            <div style={{ fontSize: 11, color: 'var(--t4)', marginTop: 2 }}>{t.breakMins ? `${t.breakMins}m break · ` : ''}{t.status}</div>
          </div>
          <div className="mono" style={{ fontSize: 14.5, fontWeight: 800 }}>{t.hours != null ? hm(t.hours) : '—'}</div>
        </div>
      ))}
    </div>
  );
}

function MeTab({ snap, onSaved }) {
  const me = snap?.me || {};
  const [editing, setEditing] = useState(null);   // 'details' | 'bank' | null
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [saved, setSaved] = useState('');
  const [form, setForm] = useState({});

  const save = async (patch) => {
    setBusy(true); setErr(''); setSaved('');
    try {
      const { data: sess } = await supabase.auth.getSession();
      await callPortal({ action: 'update_details', patch }, sess?.session?.access_token);
      setEditing(null); setSaved('Saved');
      await onSaved();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div className="sv-glass" style={glass}>
        <div style={{ fontSize: 16, fontWeight: 800 }}>{me.name}</div>
        <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 2 }}>{me.role || ''}{me.startDate ? ` · started ${fmtDay(me.startDate)}` : ''}</div>
        <div style={{ fontSize: 12.5, color: 'var(--t2)', marginTop: 10 }}>{me.email}<br />{me.mobile || 'No mobile on file'}</div>
        {(snap?.payRate || snap?.leave) && (
          <div style={{ display: 'flex', gap: 18, marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--bdr)' }}>
            {snap?.payRate && (
              <div>
                <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--t4)' }}>Pay rate</div>
                <div className="mono" style={{ fontSize: 15, fontWeight: 800, marginTop: 2 }}>
                  {snap.payRate.kind === 'hourly' ? `£${Number(snap.payRate.rate).toFixed(2)}/h` : `£${Math.round(snap.payRate.annual / 1000)}k/yr`}
                </div>
              </div>
            )}
            {snap?.leave && (
              <div>
                <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--t4)' }}>Holiday accrued</div>
                <div className="mono" style={{ fontSize: 15, fontWeight: 800, marginTop: 2 }}>{hm(snap.leave.accruedHours)}</div>
              </div>
            )}
          </div>
        )}
      </div>

      {saved && <div style={{ color: 'var(--grn)', fontSize: 12.5, fontWeight: 700 }}>{saved}</div>}

      <div className="sv-glass" style={glass}>
        <RowHead title="My details" onEdit={() => { setForm({ address: me.address || '', ecName: me.emergencyContact?.name || '', ecPhone: me.emergencyContact?.phone || '', ecRelation: me.emergencyContact?.relationship || '' }); setEditing(editing === 'details' ? null : 'details'); }} open={editing === 'details'} />
        {editing !== 'details' ? (
          <div style={{ fontSize: 12.5, color: 'var(--t2)', lineHeight: 1.6 }}>
            {me.address || 'No address on file'}<br />
            Emergency contact: {me.emergencyContact?.name ? `${me.emergencyContact.name} (${me.emergencyContact.relationship || 'contact'}) ${me.emergencyContact.phone || ''}` : 'none on file'}
          </div>
        ) : (
          <div>
            <Field label="Home address" value={form.address} onChange={e => setForm(f => ({ ...f, address: e.target.value }))} />
            <Field label="Emergency contact name" value={form.ecName} onChange={e => setForm(f => ({ ...f, ecName: e.target.value }))} />
            <Field label="Their phone" value={form.ecPhone} onChange={e => setForm(f => ({ ...f, ecPhone: e.target.value }))} inputMode="tel" />
            <Field label="Relationship" value={form.ecRelation} onChange={e => setForm(f => ({ ...f, ecRelation: e.target.value }))} placeholder="e.g. partner, parent" />
            <ErrLine>{err}</ErrLine>
            <Primary disabled={busy} onClick={() => save({ address: form.address, emergencyContact: { name: form.ecName, phone: form.ecPhone, relationship: form.ecRelation } })}>{busy ? 'Saving…' : 'Save details'}</Primary>
          </div>
        )}
      </div>

      <div className="sv-glass" style={glass}>
        <RowHead title="Bank details" onEdit={() => { setForm({ sortCode: '', account: '', accountName: me.bankAccountName || '' }); setEditing(editing === 'bank' ? null : 'bank'); }} open={editing === 'bank'} />
        {editing !== 'bank' ? (
          <div style={{ fontSize: 12.5, color: 'var(--t2)' }}>
            {me.bankMasked ? <>Account ending <b className="mono">{String(me.bankMasked).slice(-4)}</b> · sort code <b className="mono">{me.bankSortCode}</b>{me.bankAccountName ? <> · {me.bankAccountName}</> : null}</> : 'No bank details on file — add them so you can be paid.'}
          </div>
        ) : (
          <div>
            <Field label="Sort code" value={form.sortCode} onChange={e => setForm(f => ({ ...f, sortCode: e.target.value }))} inputMode="numeric" placeholder="00-00-00" />
            <Field label="Account number" value={form.account} onChange={e => setForm(f => ({ ...f, account: e.target.value }))} inputMode="numeric" placeholder="8 digits" />
            <Field label="Account holder name" value={form.accountName} onChange={e => setForm(f => ({ ...f, accountName: e.target.value }))} placeholder="As it appears at the bank" />
            <div style={{ fontSize: 11, color: 'var(--t4)', lineHeight: 1.5, marginBottom: 12 }}>Your manager is notified whenever bank details change — it protects your pay.</div>
            <ErrLine>{err}</ErrLine>
            <Primary disabled={busy || !form.sortCode || !form.account} onClick={() => save({ bank: { sortCode: form.sortCode, account: form.account, accountName: form.accountName } })}>{busy ? 'Saving…' : 'Save bank details'}</Primary>
          </div>
        )}
      </div>
    </div>
  );
}

function RowHead({ title, onEdit, open }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
      <span style={{ fontSize: 13.5, fontWeight: 800 }}>{title}</span>
      <button onClick={onEdit} style={{ background: 'none', border: '1px solid var(--bdr)', borderRadius: 999, padding: '5px 12px', color: open ? 'var(--t3)' : 'var(--acc)', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>{open ? 'Cancel' : 'Edit'}</button>
    </div>
  );
}
