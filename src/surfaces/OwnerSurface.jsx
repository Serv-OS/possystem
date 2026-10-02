// src/surfaces/OwnerSurface.jsx  (?mode=owner)
//
// The owner phone app — a top-down snapshot of the whole business at a glance.
// Mobile-first PWA surface: back-office login (owners' existing credentials),
// then a rollup across every location they can access plus a per-venue card —
// today's sales vs forecast, labour %, live orders/tables, WTD vs last week and
// today's top items. All figures come from the owner-snapshot edge fn in one
// round trip. Read-only by design.
//
// 2 Oct 2026, Peter: "On the owner app I want to be able to have quick filters for
// today, this week, this month." Three chips under the header choose the period for
// the group card and every venue card; the phone remembers the last one. Today is
// the default and reads the same fields as before. The words and the fallback for a
// function from before the filters are in src/lib/ownerPeriod.js.

import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { supabase, isMock } from '../lib/supabase';
import { ServOSWordmark, ServOSLockup } from '../components/ServOSBrand';
import SecondStepGate from '../components/secondStep/SecondStepGate';
import { isRealLogin, sessionProvesSecondStep } from '../lib/secondStep/rules';
import { withTimeout, TimeoutError } from '../lib/withTimeout';
import {
  PERIOD_CHIPS, PERIOD_COPY, NEEDS_UPDATE, readStoredPeriod, storePeriod, shownPeriod,
  venueView, rollupView, likeForLikeNote, rangeLabel, sharedRange, signedPct,
} from '../lib/ownerPeriod';

/** A refresh that has not answered by now is never going to (a woken phone). */
const LOAD_TIMEOUT_MS = 15000;
/** This month reads two months of checks for every venue, so it is given longer to answer. */
const MONTH_LOAD_TIMEOUT_MS = 30000;
/** The screen refreshes itself every two minutes; a month is a heavier read, so every ten. */
const REFRESH_MS = 120000;
const MONTH_REFRESH_MS = 600000;
// Private browsing can throw on the very mention of localStorage.
const phoneStorage = () => { try { return window.localStorage; } catch { return null; } };

const money = (n, currency = 'GBP', dp = 0) => {
  try { return new Intl.NumberFormat('en-GB', { style: 'currency', currency, minimumFractionDigits: dp, maximumFractionDigits: dp }).format(Number(n) || 0); }
  catch { return `£${(Number(n) || 0).toFixed(dp)}`; }
};
const pctTone = (p, good = 'up') => p == null ? 'var(--t3)' : (good === 'up' ? (p >= 100 ? 'var(--grn)' : p >= 85 ? 'var(--amber)' : 'var(--red)') : 'var(--t1)');

export default function OwnerSurface() {
  const [session, setSession] = useState(undefined); // undefined=checking
  // SECOND SIGN IN STEP (docs/SECOND_STEP.md): the Owner app signs in with Back Office
  // credentials and its token can read everything the Back Office can, so it asks for the
  // same second step. Closed again whenever the session drops back to password only.
  const [secondStepOk, setSecondStepOk] = useState(false);
  // Theme: reuse the app-wide rpos-theme key + [data-theme] CSS so the owner's
  // choice persists and matches the rest of ServOS.
  const [theme, setTheme] = useState(() => { try { return localStorage.getItem('rpos-theme') || 'dark'; } catch { return 'dark'; } });
  const toggleTheme = useCallback(() => setTheme(t => (t === 'dark' ? 'light' : 'dark')), []);

  useEffect(() => { try { document.documentElement.setAttribute('data-skin', 'servos'); } catch {} }, []);
  useEffect(() => { try { document.documentElement.setAttribute('data-theme', theme); localStorage.setItem('rpos-theme', theme); } catch {} }, [theme]);

  // The app globally locks html/body/#root to height:100% + overflow:hidden
  // (kiosk/POS style — no page scroll). The owner app is a normal scrollable
  // mobile page, so unlock scrolling while it's mounted and restore on unmount.
  useEffect(() => {
    const nodes = [document.documentElement, document.body, document.getElementById('root')].filter(Boolean);
    const prev = nodes.map((n) => ({ n, overflow: n.style.overflow, height: n.style.height }));
    nodes.forEach((n) => { n.style.overflow = 'auto'; n.style.height = 'auto'; });
    return () => { prev.forEach((p) => { p.n.style.overflow = p.overflow; p.n.style.height = p.height; }); };
  }, []);

  // Owner runs on a PHONE with a notch, so it goes edge to edge and pads its own
  // chrome with env(safe-area-inset-*). Without viewport-fit=cover iOS insets the
  // whole web view instead, leaving a band above the app in the shell's colour,
  // which is wrong in light mode and never matches the page. Set here and
  // reverted on unmount, NOT in index.html: every other surface has zero inset
  // handling, so turning this on globally would slide them under the notch.
  useEffect(() => {
    const m = document.querySelector('meta[name="viewport"]');
    if (!m) return undefined;
    const prev = m.getAttribute('content');
    m.setAttribute('content', 'width=device-width, initial-scale=1.0, viewport-fit=cover');
    return () => { if (prev) m.setAttribute('content', prev); };
  }, []);

  useEffect(() => {
    if (isMock || !supabase) { setSession(null); return; }
    supabase.auth.getSession().then(({ data }) => setSession(data?.session || null));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
      setSession(s || null);
      // A passkey sign in is aal1 and is DONE, so it stays in.
      if (!s || (isRealLogin(s) && !sessionProvesSecondStep(s))) setSecondStepOk(false);
    });
    return () => sub?.subscription?.unsubscribe?.();
  }, []);

  if (session === undefined) return <Shell><div style={{ color: 'var(--t3)', textAlign: 'center', paddingTop: 80 }}>Loading…</div></Shell>;
  // An anonymous session (a till or payment token in the same storage) is not an owner login.
  if (!session || !isRealLogin(session)) return <Shell><Login theme={theme} onToggleTheme={toggleTheme} /></Shell>;
  if (!secondStepOk) {
    return (
      <Shell>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}><ThemeBtn theme={theme} onClick={toggleTheme} /></div>
        <Brand sub="Confirm it is you" />
        <SecondStepGate
          supabase={supabase}
          mode="login"
          tone="auto"
          frame={false}
          area="Owner"
          onPassed={() => setSecondStepOk(true)}
          onSignOut={() => { supabase.auth.signOut({ scope: 'local' }); }}
        />
      </Shell>
    );
  }
  return <Shell><Dashboard email={session.user?.email} theme={theme} onToggleTheme={toggleTheme} /></Shell>;
}

function Shell({ children }) {
  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg, #0F1211)', color: 'var(--t1)', fontFamily: 'var(--font, system-ui, sans-serif)' }}>
      {/* The page paints its own background through the notch and the home bar,
          so the app reads as one continuous surface on a phone. */}
      <div style={{
        maxWidth: 520, margin: '0 auto',
        padding: 'calc(16px + env(safe-area-inset-top, 0px)) 14px calc(40px + env(safe-area-inset-bottom, 0px))',
      }}>{children}</div>
    </div>
  );
}

const ThemeBtn = ({ theme, onClick }) => (
  <button onClick={onClick} title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'} aria-label="Toggle theme" style={iconBtn}>
    {theme === 'dark' ? '☀' : '☾'}
  </button>
);

function Brand({ sub }) {
  return (
    <div style={{ textAlign: 'center', marginBottom: 22, paddingTop: 18 }}>
      <div style={{ display: 'flex', justifyContent: 'center' }}>
        <ServOSLockup iconSize={36} fontSize={28} />
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--t3)', marginTop: 8 }}>{sub || 'Owner snapshot'}</div>
    </div>
  );
}

function Login({ theme, onToggleTheme }) {
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const submit = async (e) => {
    e.preventDefault(); setErr(''); setBusy(true);
    try {
      const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password: pw });
      if (error) throw error;
    } catch (e2) { setErr(e2.message || 'Could not sign in'); } finally { setBusy(false); }
  };
  const toggleRow = <div style={{ display: 'flex', justifyContent: 'flex-end' }}><ThemeBtn theme={theme} onClick={onToggleTheme} /></div>;
  if (isMock || !supabase) return <>{toggleRow}<Brand /><div style={{ textAlign: 'center', color: 'var(--t3)', fontSize: 13, lineHeight: 1.6 }}>The owner app needs a live backend connection.</div></>;
  const inp = { width: '100%', padding: '13px 14px', borderRadius: 12, border: '1px solid var(--bdr2)', background: 'var(--bg2)', color: 'var(--t1)', fontSize: 16, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' };
  return (
    <>
      {toggleRow}
      <Brand sub="Sign in to your business" />
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 10 }}>
        <input style={inp} type="email" inputMode="email" autoComplete="email" placeholder="Email" value={email} onChange={e => setEmail(e.target.value)} required />
        <input style={inp} type="password" autoComplete="current-password" placeholder="Password" value={pw} onChange={e => setPw(e.target.value)} required />
        {err && <div style={{ color: 'var(--red)', fontSize: 13 }}>{err}</div>}
        <button type="submit" disabled={busy} style={{ padding: '14px', borderRadius: 12, border: 'none', background: 'var(--acc)', color: '#0b0c10', fontWeight: 800, fontSize: 16, fontFamily: 'inherit', cursor: 'pointer', opacity: busy ? .6 : 1 }}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
      <div style={{ textAlign: 'center', color: 'var(--t4)', fontSize: 11.5, marginTop: 18, lineHeight: 1.6 }}>Use your back-office login. You’ll see every venue you manage.</div>
    </>
  );
}

function Dashboard({ email, theme, onToggleTheme }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [updated, setUpdated] = useState('');
  // The chip. `period` is what the owner asked for; what the cards SAY always comes from the
  // answer itself (shownPeriod), so numbers and labels can never be for different periods.
  const [period, setPeriod] = useState(() => readStoredPeriod(phoneStorage()));
  const [needsUpdate, setNeedsUpdate] = useState(false);
  // Chips can be tapped faster than answers come back: only the latest request is shown.
  const seq = useRef(0);

  const load = useCallback(async (want) => {
    const mine = ++seq.current;
    // 27 Sep 2026: tapping refresh looked like it did nothing at all. On a phone that has
    // been asleep the call can hang for good (a stalled auth lock or a socket the OS
    // dropped), and nothing here ever finished: no new time, no error, no spinner. So the
    // call is raced against a timer, the arrow shows it is working, and a call that never
    // comes back says so.
    setErr(''); setBusy(true);
    try {
      const { data: d, error } = await withTimeout(
        supabase.functions.invoke('owner-snapshot', { body: { period: want } }),
        want === 'month' ? MONTH_LOAD_TIMEOUT_MS : LOAD_TIMEOUT_MS, 'Owner snapshot');
      if (error) { let b = null; try { b = await error.context?.json?.(); } catch {} throw new Error(b?.error || error.message); }
      if (d?.error) throw new Error(d.error);
      if (mine !== seq.current) return;
      setData(d);
      setUpdated(new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }));
      // A function from before the filters answers a week or a month with today's numbers and
      // no echo. They are shown as today's, the chip goes back to Today, and one line says why.
      if (shownPeriod(d, want).needsUpdate) {
        setNeedsUpdate(true);
        setPeriod('today');
        storePeriod(phoneStorage(), 'today');
      }
    } catch (e) {
      if (mine !== seq.current) return;
      setErr(e instanceof TimeoutError
        ? 'Could not reach ServOS. Tap the arrow to try again, or close and reopen the app.'
        : (e.message || 'Could not load'));
    }
    finally { if (mine === seq.current) { setBusy(false); setLoading(false); } }
  }, []);
  useEffect(() => {
    load(period);
    const t = setInterval(() => load(period), period === 'month' ? MONTH_REFRESH_MS : REFRESH_MS);
    return () => clearInterval(t);
  }, [load, period]);

  const pick = useCallback((id) => {
    setNeedsUpdate(false);
    storePeriod(phoneStorage(), id);
    if (id === period) load(id); else setPeriod(id);
  }, [load, period]);

  const r = data?.rollup;
  const multi = (data?.locations?.length || 0) > 1;
  // The period the numbers on screen are for (the function's own word, never the chip's).
  const shown = shownPeriod(data, period).period;
  const copy = PERIOD_COPY[shown];
  const rv = rollupView(r, shown);
  const dates = shown === 'today' ? null : sharedRange(data?.locations);
  const heading = [copy.heading, multi ? `${r?.locations} venues` : '', rangeLabel(dates)].filter(Boolean).join(' · ');
  // The numbers on screen are for another period than the lit chip: they stay, dimmed, under
  // their own labels, until an answer for the chip lands. NOT only while the call is running:
  // a This month call that failed left Today's figures at full brightness under a lit
  // This month chip, with only the red line to say they were not the month's.
  const waiting = !!data && shown !== period;

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 7 }}>
            <ServOSWordmark fontSize={19} />
            <span style={{ color: 'var(--t3)', fontWeight: 700, fontSize: 13 }}>Owner</span>
          </div>
          <div style={{ fontSize: 11, color: 'var(--t4)', marginTop: 2 }}>{updated ? `Updated ${updated}` : 'Today'}</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <ThemeBtn theme={theme} onClick={onToggleTheme} />
          <button onClick={() => load(period)} disabled={busy} title="Refresh" aria-busy={busy}
            style={{ ...iconBtn, opacity: busy ? 0.55 : 1, cursor: busy ? 'default' : 'pointer' }}>{busy ? '⋯' : '↻'}</button>
          <button onClick={() => supabase.auth.signOut()} title="Sign out" style={iconBtn}>⎋</button>
        </div>
      </div>

      {/* ── Quick filters: the period for the group card and every venue card ── */}
      <div role="group" aria-label="Period" style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 6, marginBottom: 14 }}>
        {PERIOD_CHIPS.map((c) => (
          <button key={c.id} onClick={() => pick(c.id)} aria-pressed={period === c.id}
            style={{ ...periodChip, ...(period === c.id ? periodChipOn : null) }}>{c.label}</button>
        ))}
      </div>
      {needsUpdate && <div style={{ color: 'var(--t3)', textAlign: 'center', fontSize: 12.5, margin: '-4px 0 12px' }}>{NEEDS_UPDATE}</div>}

      {loading && !data && <div style={{ color: 'var(--t3)', textAlign: 'center', padding: '60px 0' }}>Loading your business…</div>}
      {err && <div style={{ color: 'var(--red)', textAlign: 'center', padding: '20px 0', fontSize: 13 }}>{err}</div>}

      {data && data.locations.length === 0 && (
        <div style={{ color: 'var(--t3)', textAlign: 'center', padding: '50px 16px', fontSize: 14 }}>No locations are linked to your account yet.</div>
      )}

      <div style={{ opacity: waiting ? 0.5 : 1, transition: 'opacity .15s' }}>
        {/* ── Rollup (all venues, the period shown) ── */}
        {r && data.locations.length > 0 && (
          <div style={{ background: 'linear-gradient(160deg, var(--acc-d), var(--bg1))', border: '1px solid var(--acc-b)', borderRadius: 18, padding: '18px 18px 16px', marginBottom: 16 }}>
            <div style={{ fontSize: 11.5, color: 'var(--t3)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em' }}>{heading}</div>
            <div style={{ fontSize: 38, fontWeight: 900, letterSpacing: '-.02em', margin: '2px 0 2px', lineHeight: 1.05 }}>{money(rv.net_sales, data.locations[0]?.currency)}</div>
            {rv.forecast > 0 && (
              <div style={{ fontSize: 13, fontWeight: 700, color: pctTone(rv.forecast_pct) }}>
                {rv.forecast_pct}% of forecast <span style={{ color: 'var(--t4)', fontWeight: 600 }}>({money(rv.forecast, data.locations[0]?.currency)})</span>
              </div>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 8, marginTop: 14 }}>
              <Mini label="Orders" value={rv.orders} />
              <Mini label="Labour" value={rv.labour_pct != null ? `${rv.labour_pct}%` : '—'} tone={rv.labour_pct > 35 ? 'var(--red)' : 'var(--t1)'} />
              <Mini label="Live now" value={rv.live_orders} />
              <Mini label="On floor" value={rv.open_tables} />
            </div>
            {rv.vs_pct != null && (
              <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 12 }}>
                {shown === 'today' ? 'Week to date' : copy.before} {money(rv.before, data.locations[0]?.currency)} ·{' '}
                <span style={{ color: rv.vs_pct >= 0 ? 'var(--grn)' : 'var(--red)', fontWeight: 700 }}>{signedPct(rv.vs_pct)}</span>{shown === 'today' ? ' vs last week' : likeForLikeNote(rv, r.locations)}
              </div>
            )}
          </div>
        )}

        {/* ── Per-venue cards ── */}
        {data?.locations?.map(l => <VenueCard key={l.ops_location_id} l={l} showName={multi} period={shown} showDates={shown !== 'today' && !dates} />)}
      </div>
    </>
  );
}

function Mini({ label, value, tone }) {
  return (
    <div>
      <div style={{ fontSize: 18, fontWeight: 800, color: tone || 'var(--t1)', lineHeight: 1.1 }}>{value}</div>
      <div style={{ fontSize: 10, color: 'var(--t4)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', marginTop: 2 }}>{label}</div>
    </div>
  );
}

function VenueCard({ l, showName, period, showDates }) {
  const t = venueView(l, period);
  const copy = PERIOD_COPY[t.period];
  const fpct = t.forecast_pct;
  return (
    <div style={{ background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 16, padding: 16, marginBottom: 12 }}>
      {showName && <div style={{ fontSize: 14, fontWeight: 800, marginBottom: 10 }}>{l.name}</div>}
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <div style={{ fontSize: 10.5, color: 'var(--t4)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em' }}>{copy.sales}{showDates && rangeLabel(l.range) ? ` · ${rangeLabel(l.range)}` : ''}</div>
          <div style={{ fontSize: 28, fontWeight: 900, letterSpacing: '-.02em', lineHeight: 1.1 }}>{money(t.net_sales, l.currency)}</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          {t.forecast > 0
            ? <><div style={{ fontSize: 18, fontWeight: 800, color: pctTone(fpct) }}>{fpct}%</div><div style={{ fontSize: 10, color: 'var(--t4)' }}>of {money(t.forecast, l.currency)}</div></>
            : <div style={{ fontSize: 11, color: 'var(--t4)' }}>no forecast</div>}
        </div>
      </div>

      {/* forecast progress */}
      {t.forecast > 0 && (
        <div style={{ height: 6, background: 'var(--bg3)', borderRadius: 99, marginTop: 10, overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${Math.min(100, fpct || 0)}%`, background: pctTone(fpct), borderRadius: 99 }} />
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8, marginTop: 14 }}>
        <Stat label="Orders" value={t.orders} />
        <Stat label="Avg check" value={money(t.avg_check, l.currency, 2)} />
        <Stat label="Labour" value={t.labour_pct != null ? `${t.labour_pct}%` : '—'} tone={t.labour_pct > 35 ? 'var(--red)' : undefined} />
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        <Chip>● {l.live.orders} live order{l.live.orders === 1 ? '' : 's'}</Chip>
        <Chip>▢ {l.live.tables} on floor</Chip>
        {t.tips > 0 && <Chip>{money(t.tips, l.currency)} tips</Chip>}
        {t.vs_pct != null && <Chip tone={t.vs_pct >= 0 ? 'var(--grn)' : 'var(--red)'}>{t.period === 'today' ? `WTD ${signedPct(t.vs_pct)} vs last wk` : `${signedPct(t.vs_pct)} ${copy.versus}`}</Chip>}
      </div>

      {t.top_items.length > 0 && (
        <div style={{ marginTop: 14, borderTop: '1px solid var(--bdr)', paddingTop: 10 }}>
          <div style={{ fontSize: 10.5, color: 'var(--t4)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 6 }}>{copy.top}</div>
          {t.top_items.map((it, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '3px 0', color: 'var(--t2)' }}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.qty}× {it.name}</span>
              <span style={{ color: 'var(--t3)', marginLeft: 10, flexShrink: 0 }}>{money(it.rev, l.currency)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, tone }) {
  return (
    <div style={{ background: 'var(--bg2)', borderRadius: 10, padding: '8px 10px' }}>
      <div style={{ fontSize: 15, fontWeight: 800, color: tone || 'var(--t1)', lineHeight: 1.15 }}>{value}</div>
      <div style={{ fontSize: 9.5, color: 'var(--t4)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', marginTop: 2 }}>{label}</div>
    </div>
  );
}
const Chip = ({ children, tone }) => (
  <span style={{ fontSize: 11.5, fontWeight: 700, color: tone || 'var(--t3)', background: 'var(--bg2)', border: '1px solid var(--bdr)', borderRadius: 99, padding: '4px 10px' }}>{children}</span>
);
const periodChip = { padding: '9px 6px', borderRadius: 99, border: '1px solid var(--bdr)', background: 'var(--bg1)', color: 'var(--t2)', fontSize: 13, fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer' };
const periodChipOn = { background: 'var(--acc)', border: '1px solid var(--acc)', color: '#0b0c10' };
const iconBtn = { width: 38, height: 38, borderRadius: 10, border: '1px solid var(--bdr)', background: 'var(--bg1)', color: 'var(--t2)', fontSize: 16, cursor: 'pointer', fontFamily: 'inherit' };
