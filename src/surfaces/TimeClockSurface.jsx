// src/surfaces/TimeClockSurface.jsx
//
// Dedicated Time Clock device surface (?mode=clock). A full-screen, tablet-first
// PIN pad where staff clock in/out and take breaks. Punches are written
// SERVER-SIDE by the workforce-clock edge function (paired clock devices auth
// anonymously and cannot write wf_timesheets directly). Designed to sit on a
// second tablet by the staff entrance — fast, glanceable, seamless.

import { useState, useEffect, useRef, useCallback } from 'react';
import { useStore } from '../store';
import { supabase, isMock, getActiveLocationSync } from '../lib/supabase';
import { getLocationConfig } from '../lib/locationTime';
import { Icon } from '../components/ServOSIcons';

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'];
// Punches are stored UTC (the edge fn uses toISOString) — render in the VENUE tz, not the device's
// browser tz, so an off-tz tablet still shows the correct local clock-in time.
const fmtTime = (iso, tz) => iso ? new Intl.DateTimeFormat('en-GB', { timeZone: tz || 'Europe/London', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso)) : '';
const hoursSince = iso => iso ? Math.max(0, (Date.now() - new Date(iso).getTime()) / 3600000) : 0;
const fmtHrs = h => `${Math.floor(h)}h ${Math.round((h % 1) * 60)}m`;

// ── Mock clock (dev / no Supabase): matches PIN against store staff, state in LS ──
const MK = 'rpos-clock-mock';
const mkGet = () => { try { return JSON.parse(localStorage.getItem(MK) || '{}'); } catch { return {}; } };
const mkSet = o => { try { localStorage.setItem(MK, JSON.stringify(o)); } catch { /* */ } };
function mockClock(action, pin, staffMembers) {
  const m = (staffMembers || []).find(s => s.pin && String(s.pin) === String(pin));
  if (!m) { const e = new Error('PIN not recognised'); e.code = 404; throw e; }
  const who = { name: m.name, initials: m.initials || (m.name || '?').slice(0, 2).toUpperCase(), color: m.color || '#15C26A', role: m.role };
  const all = mkGet(); const cur = all[m.id] || { state: 'out' };
  const now = new Date().toISOString();
  if (action === 'status') {
    // Mock parity with the live edge fn: surface recent in-app announcements.
    let announcements = [];
    try {
      const roleLc = String(m.role || '').toLowerCase();
      announcements = (JSON.parse(localStorage.getItem('rpos-wf-announce') || '[]'))
        .filter(a => { const k = a.audience?.kind; return !k || k === 'all' || (k === 'role' && String(a.audience?.value || '').toLowerCase() === roleLc); })
        .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
        .slice(0, 3).map(a => ({ body: a.body, author: a.authorName || null, at: a.createdAt }));
    } catch { /* none */ }
    return { ok: true, staff: who, state: cur.state, since: cur.since || null, breakSince: cur.breakSince || null, onBreak: cur.state === 'break', announcements };
  }
  if (action === 'in') { all[m.id] = { state: 'in', since: now, breakMins: 0 }; mkSet(all); return { ok: true, staff: who, state: 'in', since: now }; }
  if (action === 'break_start') { all[m.id] = { ...cur, state: 'break', breakSince: now }; mkSet(all); return { ok: true, staff: who, state: 'break', since: cur.since, breakSince: now }; }
  if (action === 'break_end') { const mins = cur.breakSince ? Math.round((Date.now() - new Date(cur.breakSince).getTime()) / 60000) : 0; all[m.id] = { ...cur, state: 'in', breakSince: null, breakMins: (cur.breakMins || 0) + mins }; mkSet(all); return { ok: true, staff: who, state: 'in', since: cur.since, breakAdded: mins }; }
  if (action === 'out') { const gross = hoursSince(cur.since); const actual = Math.max(0, gross - (cur.breakMins || 0) / 60); delete all[m.id]; mkSet(all); return { ok: true, staff: who, state: 'out', actualHours: Math.round(actual * 100) / 100, breakMins: cur.breakMins || 0, pay: 0 }; }
  throw new Error('unknown action');
}

export default function TimeClockSurface() {
  const { staffMembers } = useStore();
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [shake, setShake] = useState(false);
  const [error, setError] = useState('');
  const [session, setSession] = useState(null); // { staff, state, since, breakSince }
  const [flash, setFlash] = useState(null);      // confirmation message
  const [, force] = useState(0);
  const locationId = getActiveLocationSync();
  const [tz, setTz] = useState('Europe/London');
  useEffect(() => { let alive = true; getLocationConfig(locationId).then(c => { if (alive && c?.timezone) setTz(c.timezone); }).catch(() => {}); return () => { alive = false; }; }, [locationId]);
  const venueName = (() => { try { return JSON.parse(localStorage.getItem('rpos-device') || 'null')?.name; } catch { return null; } })();
  const resetTimer = useRef(null);

  // ServOS skin + persisted theme
  useEffect(() => {
    const el = document.documentElement;
    el.setAttribute('data-skin', 'servos');
    el.setAttribute('data-theme', localStorage.getItem('rpos-theme') || 'dark');
  }, []);
  // Live clock tick (for "on shift since" elapsed)
  useEffect(() => { const id = setInterval(() => force(n => n + 1), 1000 * 20); return () => clearInterval(id); }, []);
  useEffect(() => () => { if (resetTimer.current) clearTimeout(resetTimer.current); }, []);

  const callClock = useCallback(async (action, enteredPin) => {
    if (isMock || !supabase) return mockClock(action, enteredPin, staffMembers);
    let token = null;
    try { const { ensureAuthToken } = await import('../lib/supabase'); token = await ensureAuthToken(); } catch { /* */ }
    const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/workforce-clock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ location_id: locationId, pin: enteredPin, action }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(j.error || 'Clock error'); e.code = res.status; throw e; }
    return j;
  }, [staffMembers, locationId]);

  const goHome = (delay = 4500) => {
    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => { setSession(null); setFlash(null); setPin(''); }, delay);
  };

  const tap = async (k) => {
    if (busy) return;
    setError('');
    if (k === '⌫') return setPin(p => p.slice(0, -1));
    const next = (pin + k).slice(0, 6);
    setPin(next);
    if (next.length >= 4) {
      setBusy(true);
      try {
        const r = await callClock('status', next);
        setSession(r);
      } catch (e) {
        setShake(true); setError(e.code === 404 ? 'PIN not recognised' : (e.message || 'Error'));
        setTimeout(() => setShake(false), 500);
        setPin('');
      } finally { setBusy(false); }
    }
  };

  const doAction = async (action) => {
    if (busy || !session) return;
    setBusy(true); setError('');
    try {
      const r = await callClock(action, pin);
      const name = (r.staff?.name || '').split(' ')[0];
      // Show the punch time in the VENUE tz, not the device's (the punch is server-stamped UTC).
      const now = fmtTime(r.since || new Date().toISOString(), tz);
      const msg = action === 'in' ? `Clocked in at ${now} — have a great shift, ${name}!`
        : action === 'out' ? `Clocked out at ${now} — ${fmtHrs(r.actualHours || 0)} worked. See you soon, ${name}!`
        : action === 'break_start' ? `Break started at ${now}. Enjoy, ${name}.`
        : `Welcome back, ${name} — break over at ${now}.`;
      setFlash({ msg, tone: action === 'out' ? 'out' : 'in' });
      goHome();
    } catch (e) { setError(e.message || 'Could not record that — try again'); setBusy(false); return; }
    setBusy(false);
  };

  // ── Confirmation flash ──
  if (flash) {
    return (
      <Shell venue={venueName} tz={tz}>
        <div style={{ textAlign: 'center', maxWidth: 460 }}>
          <div style={{ width: 92, height: 92, borderRadius: '50%', margin: '0 auto 24px', display: 'flex', alignItems: 'center', justifyContent: 'center', background: flash.tone === 'out' ? 'var(--inset)' : 'var(--grn-d)', border: `1px solid ${flash.tone === 'out' ? 'var(--inset-border)' : 'var(--grn-b)'}` }}>
            <Icon name={flash.tone === 'out' ? 'check' : 'check'} size={44} stroke={2} />
          </div>
          <div style={{ fontSize: 24, fontWeight: 700, lineHeight: 1.3, color: 'var(--t1)' }}>{flash.msg}</div>
          <button className="btn btn-ghost" style={{ marginTop: 28 }} onClick={() => { setSession(null); setFlash(null); setPin(''); }}>Done</button>
        </div>
      </Shell>
    );
  }

  // ── Status + actions (after PIN) ──
  if (session) {
    const s = session;
    const onShift = s.state === 'in' || s.state === 'break';
    const elapsed = onShift ? hoursSince(s.since) : 0;
    const tone = s.state === 'break' ? 'amber' : s.state === 'in' ? 'grn' : 't3';
    const stateLabel = s.state === 'break' ? 'On break' : s.state === 'in' ? 'On shift' : 'Clocked out';
    return (
      <Shell venue={venueName} tz={tz}>
        <div style={{ width: '100%', maxWidth: 520, textAlign: 'center' }}>
          <div style={{ width: 76, height: 76, borderRadius: '50%', margin: '0 auto 16px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 26, fontWeight: 800, background: (s.staff?.color || '#15C26A') + '22', border: `2px solid ${(s.staff?.color || '#15C26A')}66`, color: s.staff?.color || 'var(--t1)' }}>{s.staff?.initials}</div>
          <div style={{ fontSize: 26, fontWeight: 700, color: 'var(--t1)' }}>{s.staff?.name}</div>
          <div style={{ fontSize: 14, color: 'var(--t3)', marginTop: 2 }}>{s.staff?.role}</div>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 9, marginTop: 18, padding: '9px 16px', borderRadius: 999, background: 'var(--inset)', border: '1px solid var(--inset-border)' }}>
            <span style={{ width: 9, height: 9, borderRadius: '50%', background: `var(--${tone === 't3' ? 't4' : tone})`, boxShadow: tone !== 't3' ? `0 0 9px var(--${tone})` : 'none' }} />
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--t1)' }}>{stateLabel}</span>
            {onShift && <span style={{ fontSize: 12, color: 'var(--t3)' }}>· since {fmtTime(s.since, tz)} · {fmtHrs(elapsed)}</span>}
          </div>

          <div style={{ display: 'grid', gap: 12, marginTop: 30 }}>
            {s.state === 'out' && <BigBtn icon="clock" label="Clock in" tone="acc" onClick={() => doAction('in')} busy={busy} />}
            {s.state === 'in' && <>
              <BigBtn icon="clock" label="Clock out" tone="acc" onClick={() => doAction('out')} busy={busy} />
              <BigBtn icon="status" label="Start break" tone="ghost" onClick={() => doAction('break_start')} busy={busy} />
            </>}
            {s.state === 'break' && <>
              <BigBtn icon="check" label="End break" tone="acc" onClick={() => doAction('break_end')} busy={busy} />
              <BigBtn icon="clock" label="Clock out" tone="ghost" onClick={() => doAction('out')} busy={busy} />
            </>}
          </div>
          {error && <div style={{ marginTop: 16, color: 'var(--red)', fontSize: 13, fontWeight: 600 }}>{error}</div>}

          {/* Outstanding work (v5.6.0) — flagged at the clock because it is the
              one surface everyone touches every shift. Read-only: they DO the
              training in the staff app on their phone, never on this tablet. */}
          {s.outstanding?.total > 0 && (() => {
            const overdue = (s.outstanding.training || []).filter(t => t.overdue).length;
            return (
              <div style={{ marginTop: 26, textAlign: 'left', padding: '12px 14px', borderRadius: 12, border: `1px solid ${overdue ? 'var(--red-b)' : 'var(--amber)'}`, background: overdue ? 'rgba(224,49,49,.10)' : 'rgba(245,166,35,.10)' }}>
                <div style={{ fontSize: 13.5, fontWeight: 800, color: overdue ? 'var(--red)' : 'var(--t1)' }}>
                  {overdue > 0 ? `${overdue} training module${overdue === 1 ? '' : 's'} overdue` : `You have ${s.outstanding.total} thing${s.outstanding.total === 1 ? '' : 's'} to do`}
                </div>
                <div style={{ display: 'grid', gap: 3, marginTop: 6 }}>
                  {(s.outstanding.training || []).slice(0, 4).map((t, i) => (
                    <div key={i} style={{ fontSize: 12, color: 'var(--t2)' }}>
                      • {t.name}{t.due ? <span style={{ color: t.overdue ? 'var(--red)' : 'var(--t4)' }}> — due {new Date(t.due + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span> : null}
                    </div>
                  ))}
                  {s.outstanding.onboardingOpen > 0 && (
                    <div style={{ fontSize: 12, color: 'var(--t2)' }}>• {s.outstanding.onboardingOpen} onboarding step{s.outstanding.onboardingOpen === 1 ? '' : 's'} to finish</div>
                  )}
                </div>
                <div style={{ fontSize: 11, color: 'var(--t4)', marginTop: 8 }}>Open the ServOS Staff app on your phone to do these.</div>
              </div>
            );
          })()}

          {/* Team announcements — the "in-app" channel from Workforce → Announcements */}
          {Array.isArray(s.announcements) && s.announcements.length > 0 && (
            <div style={{ marginTop: 26, textAlign: 'left' }}>
              <div className="mono" style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.12em', textTransform: 'uppercase', color: 'var(--t3)', marginBottom: 8 }}>Team announcements</div>
              <div style={{ display: 'grid', gap: 8 }}>
                {s.announcements.map((a, i) => (
                  <div key={i} style={{ padding: '10px 14px', borderRadius: 12, background: 'var(--inset)', border: '1px solid var(--inset-border)' }}>
                    <div style={{ fontSize: 13.5, color: 'var(--t1)', lineHeight: 1.5 }}>{a.body}</div>
                    <div style={{ fontSize: 11, color: 'var(--t4)', marginTop: 4 }}>{a.author ? `${a.author} · ` : ''}{a.at ? new Date(a.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : ''}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <button className="btn btn-ghost btn-sm" style={{ marginTop: 22 }} onClick={() => { setSession(null); setPin(''); setError(''); }}>Cancel</button>
        </div>
      </Shell>
    );
  }

  // ── PIN pad ──
  return (
    <Shell venue={venueName} tz={tz}>
      <div style={{ textAlign: 'center', animation: shake ? 'shake .45s' : 'none' }}>
        <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--t1)' }}>Enter your PIN</div>
        <div style={{ fontSize: 14, color: 'var(--t3)', marginTop: 4 }}>to clock in, take a break, or clock out</div>
        <div style={{ display: 'flex', justifyContent: 'center', gap: 14, margin: '28px 0 26px' }}>
          {[0, 1, 2, 3].map(i => (
            <div key={i} style={{ width: 16, height: 16, borderRadius: '50%', background: i < pin.length ? 'var(--acc)' : 'transparent', border: `2px solid ${i < pin.length ? 'var(--acc)' : 'var(--bdr2)'}`, boxShadow: i < pin.length ? '0 0 10px var(--acc)' : 'none', transition: 'all .12s' }} />
          ))}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 84px)', gap: 12, justifyContent: 'center' }}>
          {KEYS.map((k, i) => (
            <button key={i} disabled={!k || busy} onClick={() => k && tap(k)} style={{
              height: 72, borderRadius: 16, fontFamily: 'inherit', fontSize: k === '⌫' ? 24 : 28, fontWeight: 500,
              background: k === '⌫' ? 'transparent' : 'var(--glass-bg)', backdropFilter: k === '⌫' ? 'none' : 'blur(12px)',
              border: `1px solid ${k === '⌫' ? 'transparent' : 'var(--glass-border)'}`, color: 'var(--t1)',
              cursor: k ? 'pointer' : 'default', visibility: k === '' ? 'hidden' : 'visible', transition: 'all .1s',
            }}>{k}</button>
          ))}
        </div>
        {error && <div style={{ marginTop: 18, color: 'var(--red)', fontSize: 14, fontWeight: 600 }}>{error}</div>}
      </div>
    </Shell>
  );
}

function BigBtn({ icon, label, tone, onClick, busy }) {
  const acc = tone === 'acc';
  return (
    <button onClick={onClick} disabled={busy} style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, width: '100%', height: 64,
      borderRadius: 16, cursor: busy ? 'default' : 'pointer', fontFamily: 'inherit', fontSize: 18, fontWeight: 700,
      background: acc ? 'var(--acc)' : 'var(--glass-bg)', backdropFilter: acc ? 'none' : 'blur(12px)',
      border: `1px solid ${acc ? 'var(--acc)' : 'var(--glass-border)'}`, color: acc ? '#06130C' : 'var(--t1)',
      opacity: busy ? 0.6 : 1, boxShadow: acc ? '0 8px 24px -8px var(--acc)' : 'var(--glass-hi)',
    }}><Icon name={icon} size={22} stroke={2} /> {label}</button>
  );
}

// v5.5.971 — THE TIME CLOCK NEVER RENDERED TOASTS. store.showToast() sets `toast`,
// but the only <Toast> in the app lives inside the POS shell (App.jsx ValidatedPOSApp)
// and this surface returns from an EARLIER branch (App.jsx:288), so anything raised
// through the store from here was silently discarded. Mirrors BackOfficeToast in
// src/backoffice/BackOfficeApp.jsx. (Punch errors still show inline — this is for
// everything that goes through the store.)
function ClockToast() {
  const toast = useStore(s => s.toast);
  if (!toast) return null;
  const map = {
    success: { bg: 'var(--grn-d)', bdr: 'var(--grn-b)', color: 'var(--grn)' },
    error:   { bg: 'var(--red-d)', bdr: 'var(--red-b)', color: 'var(--red)' },
    warning: { bg: 'var(--acc-d)', bdr: 'var(--acc-b)', color: 'var(--acc)' },
    info:    { bg: 'var(--bg3)',   bdr: 'var(--bdr2)',  color: 'var(--t1)'  },
  };
  const c = map[toast.type] || map.info;
  return (
    <div className="toast" key={toast.key}
      style={{ background: c.bg, border: `1px solid ${c.bdr}`, color: c.color, zIndex: 100003 }}>
      {toast.msg}
    </div>
  );
}

function Shell({ venue, tz, children }) {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 24, position: 'relative' }}>
      <div style={{ position: 'absolute', top: 22, left: 24, display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ width: 36, height: 36, borderRadius: 10, background: 'var(--glass-bg)', border: '1px solid var(--glass-border)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--acc)' }}><Icon name="clock" size={19} /></div>
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--t1)', lineHeight: 1.1 }}>Time Clock</div>
          <div className="mono" style={{ fontSize: 10, letterSpacing: '.16em', textTransform: 'uppercase', color: 'var(--t4)' }}>{venue || 'Serv OS'}</div>
        </div>
      </div>
      <div style={{ position: 'absolute', top: 24, right: 26, fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--t3)' }}>
        {fmtTime(new Date().toISOString(), tz)}
      </div>
      {children}
      <ClockToast />
    </div>
  );
}
