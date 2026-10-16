// src/surfaces/OwnerSurface.jsx  (?mode=owner)
//
// The owner phone app: a top-down snapshot of the whole business at a glance.
// Mobile-first PWA surface: back-office login (owners' existing credentials),
// then a rollup across every location they can access plus a per-venue card:
// today's sales vs forecast, labour %, live orders/tables, WTD vs last week and
// today's top items. All figures come from the owner-snapshot edge fn in one
// round trip. Read-only by design.
//
// 2 Oct 2026, Peter: "On the owner app I want to be able to have quick filters for
// today, this week, this month." Three chips under the header choose the period for
// the group card and every venue card; the phone remembers the last one. Today is
// the default and reads the same fields as before. The words and the fallback for a
// function from before the filters are in src/lib/ownerPeriod.js.
//
// 5 Oct 2026 (Peter's decisions on multi site reporting):
//   * THE COMPARISON LINE IS ALWAYS DRAWN, on every venue card and on the group card, and it
//     says what it compares to: "+2% vs last Monday by 2pm", "+2% vs same days last week",
//     "New this week" and "No sales yet today" in grey (never a red minus 100%), and for the
//     group "Same days last week £881 · +177% (2 of 6 venues, 4 new)". The percent and the
//     reason word are the function's; the words are src/lib/ownerCompare.js.
//   * TAP A CARD. A venue card opens that venue's seven reports, the group card the same
//     seven across all sites (src/surfaces/owner/OwnerDetail.jsx). The chips stay on top and
//     the phone's own back closes the screen, as the Back button does.
//   * CURRENCIES ARE NEVER ADDED TOGETHER: a login with pound and dollar venues gets one
//     group card per currency (the function's rollup.by_currency).
//   * AN OLD FUNCTION (no `compare` block, no detail call): the cards draw exactly what they
//     drew before, and the venue screen says "More reports need a ServOS update".
//
// 8 Oct 2026, Peter: "what is Food/drink/other split ... in hospitality a valued piece of data".
// Every venue card and every group card gets a thin sales mix bar under its sales figure (Food,
// Drinks, Other, with each group's share and its change in points), from the function's own
// `mix` blocks through src/lib/ownerMix.js (src/surfaces/owner/MixBar.jsx draws it). Only when
// the function says it has the mix (canMix); a function from before it shows no bar at all.
//
// 16 Oct 2026, Peter: "the owner app needs a switch to show net or gross sales". A Net / Gross
// switch under the period chips, remembered on the phone, Net by default (what every figure
// showed before). Every sales figure, comparison, average and chart follows it, each with a small
// "Including VAT" or "Excluding VAT" line under it. The figures are the function's (gross beside
// net from the same check parts); the picking and the words are src/lib/ownerBasis.js.

import { useEffect, useRef, useState, useCallback } from 'react';
import { supabase, isMock } from '../lib/supabase';
import { VERSION } from '../lib/version';
import { ServOSWordmark, ServOSLockup } from '../components/ServOSBrand';
import SecondStepGate from '../components/secondStep/SecondStepGate';
import { isRealLogin, sessionProvesSecondStep } from '../lib/secondStep/rules';
import { createSecondStepClient } from '../lib/secondStep/client';
import { signInPlan, wrongHostMessage, passkeyPrompt, explainPasskeyError, noPasskeyNote } from '../lib/secondStep/passkeyRules';
import { withTimeout, TimeoutError } from '../lib/withTimeout';
import {
  PERIOD_CHIPS, PERIOD_COPY, NEEDS_UPDATE, readStoredPeriod, storePeriod, shownPeriod,
  venueView, rollupView, likeForLikeNote, rangeLabel, sharedRange, signedPct, groupCards,
} from '../lib/ownerPeriod';
import { compareBlock, groupCompareBlock, compareLine, groupLine, sharedCompareRange } from '../lib/ownerCompare';
import { canDetail, canMix, groupTarget, venueTarget } from '../lib/ownerDetail';
import { cardBar, allOtherByCurrency } from '../lib/ownerMix';
import {
  BASIS_CHIPS, grossNeedsUpdate, readStoredBasis, storeBasis, shownBasis, basisCompare, cardLines, topItemsNote, salesHeading, venueSales, rollupSales,
} from '../lib/ownerBasis';
import OwnerDetail from './owner/OwnerDetail';
import MixBar from './owner/MixBar';
import { money, toneColor, periodChip, periodChipOn } from './owner/style';

/** A refresh that has not answered by now is never going to (a woken phone). */
const LOAD_TIMEOUT_MS = 15000;
/** This month reads two months of checks for every venue, so it is given longer to answer. */
const MONTH_LOAD_TIMEOUT_MS = 30000;
/** The screen refreshes itself every two minutes; a month is a heavier read, so every ten. */
const REFRESH_MS = 120000;
const MONTH_REFRESH_MS = 600000;
// Private browsing can throw on the very mention of localStorage.
const phoneStorage = () => { try { return window.localStorage; } catch { return null; } };

const pctTone = (p, good = 'up') => p == null ? 'var(--t3)' : (good === 'up' ? (p >= 100 ? 'var(--grn)' : p >= 85 ? 'var(--amber)' : 'var(--red)') : 'var(--t1)');

export default function OwnerSurface() {
  // undefined = checking; with no backend (the demo build) there is no session to check for.
  const [session, setSession] = useState(isMock || !supabase ? null : undefined);
  // SECOND SIGN IN STEP (docs/SECOND_STEP.md): the Owner app signs in with Back Office
  // credentials and its token can read everything the Back Office can, so it asks for the
  // same second step. Closed again whenever the session drops back to password only.
  const [secondStepOk, setSecondStepOk] = useState(false);
  // Theme: reuse the app-wide rpos-theme key + [data-theme] CSS so the owner's
  // choice persists and matches the rest of ServOS.
  const [theme, setTheme] = useState(() => { try { return localStorage.getItem('rpos-theme') || 'dark'; } catch { return 'dark'; } });
  const toggleTheme = useCallback(() => setTheme(t => (t === 'dark' ? 'light' : 'dark')), []);

  useEffect(() => { try { document.documentElement.setAttribute('data-skin', 'servos'); } catch { /* no document */ } }, []);
  useEffect(() => { try { document.documentElement.setAttribute('data-theme', theme); localStorage.setItem('rpos-theme', theme); } catch { /* storage closed to us */ } }, [theme]);

  // The app globally locks html/body/#root to height:100% + overflow:hidden
  // (kiosk/POS style, no page scroll). The owner app is a normal scrollable
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
    if (isMock || !supabase) return undefined;
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
  // PASSKEY SIGN IN (15 Oct 2026). Peter on his iPad: "there is no button that mentions passkey".
  // This form only ever asked for a password, so the Owner app, and ?mode=owner in Safari, never
  // offered Face ID even where Back Office did. Same plan and client as BOLogin: the device says
  // what it can do, the auth server decides who gets in, and the session listener in OwnerSurface
  // takes the signed in session like any other.
  const [stepClient] = useState(() => (isMock || !supabase ? null : createSecondStepClient(supabase, { allowLocalhost: !!import.meta.env?.DEV })));
  const [pk, setPk] = useState({ ready: false, canUse: false, primary: 'password' });
  const [pkBusy, setPkBusy] = useState(false);
  useEffect(() => {
    if (!stepClient) return undefined;
    let alive = true;
    (async () => {
      try {
        const can = await stepClient.canUsePasskey();
        const plan = signInPlan({ hostname: window.location.hostname, supported: !!can.usable, reason: can.reason || '', allowLocalhost: !!import.meta.env?.DEV });
        if (alive) setPk({ ready: true, canUse: plan.canUsePasskey, primary: plan.primary, reason: can.reason || '' });
      } catch { if (alive) setPk({ ready: true, canUse: false, primary: 'password', reason: 'browser' }); }
    })();
    return () => { alive = false; };
  }, [stepClient]);
  const passkey = async () => {
    if (pkBusy || !stepClient) return;
    setPkBusy(true); setErr('');
    try { await stepClient.signInWithPasskey(); }   // onAuthStateChange above sees the new session
    catch (e2) { setErr(explainPasskeyError(e2)); }
    finally { setPkBusy(false); }
  };
  const toggleRow = <div style={{ display: 'flex', justifyContent: 'flex-end' }}><ThemeBtn theme={theme} onClick={onToggleTheme} /></div>;
  if (isMock || !supabase) return <>{toggleRow}<Brand /><div style={{ textAlign: 'center', color: 'var(--t3)', fontSize: 13, lineHeight: 1.6 }}>The owner app needs a live backend connection.</div></>;
  const inp = { width: '100%', padding: '13px 14px', borderRadius: 12, border: '1px solid var(--bdr2)', background: 'var(--bg2)', color: 'var(--t1)', fontSize: 16, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' };
  const btn = (off) => ({ padding: '14px', borderRadius: 12, border: 'none', background: 'var(--acc)', color: '#0b0c10', fontWeight: 800, fontSize: 16, fontFamily: 'inherit', cursor: 'pointer', opacity: off ? .6 : 1, width: '100%' });
  return (
    <>
      {toggleRow}
      <Brand sub={pk.canUse ? `Sign in with ${passkeyPrompt(navigator.userAgent)}` : 'Sign in to your business'} />
      {pk.canUse && (
        <div style={{ marginTop: 10 }}>
          <button type="button" onClick={passkey} disabled={pkBusy} style={btn(pkBusy)}>{pkBusy ? 'Checking…' : 'Sign in with a passkey'}</button>
          <div style={{ textAlign: 'center', color: 'var(--t3)', fontSize: 13, marginTop: 10 }}>or use your password</div>
        </div>
      )}
      {pk.ready && pk.primary === 'wrong_host' && (
        <div style={{ color: 'var(--amber)', fontSize: 12.5, lineHeight: 1.5, marginTop: 10 }}>{wrongHostMessage(window.location.hostname)}</div>
      )}
      {pk.ready && pk.primary === 'password' && noPasskeyNote(pk.reason, navigator.userAgent) && (
        <div style={{ color: 'var(--t3)', fontSize: 12.5, lineHeight: 1.5, marginTop: 10 }}>{noPasskeyNote(pk.reason, navigator.userAgent)}</div>
      )}
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 10 }}>
        <input style={inp} type="email" inputMode="email" autoComplete="email" placeholder="Email" value={email} onChange={e => setEmail(e.target.value)} required />
        <input style={inp} type="password" autoComplete="current-password" placeholder="Password" value={pw} onChange={e => setPw(e.target.value)} required />
        {err && <div style={{ color: 'var(--red)', fontSize: 13 }}>{err}</div>}
        <button type="submit" disabled={busy} style={btn(busy)}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
      <div style={{ textAlign: 'center', color: 'var(--t4)', fontSize: 11.5, marginTop: 18, lineHeight: 1.6 }}>Use your back-office login. You’ll see every venue you manage.<div style={{ marginTop: 6, fontSize: 11, opacity: 0.7 }}>ServOS {VERSION}</div></div>
    </>
  );
}

function Dashboard({ theme, onToggleTheme }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [updated, setUpdated] = useState('');
  // The chip. `period` is what the owner asked for; what the cards SAY always comes from the
  // answer itself (shownPeriod), so numbers and labels can never be for different periods.
  const [period, setPeriod] = useState(() => readStoredPeriod(phoneStorage()));
  const [needsUpdate, setNeedsUpdate] = useState(false);
  // 16 Oct 2026: the Net / Gross switch. Both are in every answer, so a tap redraws and never reloads.
  const [basisAsked, setBasisAsked] = useState(() => readStoredBasis(phoneStorage()));
  const pickBasis = useCallback((id) => { storeBasis(phoneStorage(), id); setBasisAsked(id); }, []);
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
      if (error) { let b = null; try { b = await error.context?.json?.(); } catch { /* no body to read */ } throw new Error(b?.error || error.message); }
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

  // The screen behind a card: which venue (or group) is open, null for the cards. Opening adds
  // a step to the phone's history so its own back (the Android button, the iOS swipe) closes
  // the screen and does not leave the app.
  const [open, setOpen] = useState(null);
  const [tick, setTick] = useState(0);
  const cardsScroll = useRef(0);
  const openDetail = useCallback((target) => {
    try { cardsScroll.current = window.scrollY || 0; } catch { /* no window */ }
    try { window.history.pushState({ ...(window.history.state || {}), ownerDetail: true }, ''); } catch { /* history closed to us: the Back button still works */ }
    setOpen(target);
  }, []);
  const closeDetail = useCallback(() => {
    let went = false;
    try { if (window.history.state?.ownerDetail) { window.history.back(); went = true; } } catch { /* fall through to a plain close */ }
    if (!went) setOpen(null);
  }, []);
  useEffect(() => {
    const onPop = () => setOpen(null);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  // The reports start at the top; the cards come back where they were left.
  const isOpen = !!open;
  useEffect(() => { try { window.scrollTo(0, isOpen ? 0 : cardsScroll.current); } catch { /* no window */ } }, [isOpen]);
  const refresh = useCallback(() => { load(period); setTick((n) => n + 1); }, [load, period]);

  const pick = useCallback((id) => {
    setNeedsUpdate(false);
    storePeriod(phoneStorage(), id);
    if (id === period) load(id); else setPeriod(id);
  }, [load, period]);

  const r = data?.rollup;
  const multi = (data?.locations?.length || 0) > 1;
  // The period the numbers on screen are for (the function's own word, never the chip's).
  const shown = shownPeriod(data, period).period;
  const dates = shown === 'today' ? null : sharedRange(data?.locations);
  // One group card, or one per currency when the venues do not share one.
  const groups = groupCards(data);
  // 8 Oct 2026: the sales mix bars, only from a function that sends the mix. A venue card in a
  // currency with nothing set up anywhere stays quiet; its group card carries the one hint.
  const mixOn = canMix(data);
  const quietBy = allOtherByCurrency(groups);
  // The numbers on screen are for another period than the lit chip: they stay, dimmed, under
  // their own labels, until an answer for the chip lands. NOT only while the call is running:
  // a This month call that failed left Today's figures at full brightness under a lit
  // This month chip, with only the red line to say they were not the month's.
  const waiting = !!data && shown !== period;
  // What the figures are: Gross only from a function that sends it (otherwise net, under net words).
  const sb = shownBasis(data, basisAsked);
  const basis = sb.basis;

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
          <button onClick={refresh} disabled={busy} title="Refresh" aria-busy={busy}
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

      {/* ── Net or gross sales (16 Oct 2026): every sales figure below follows it ── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, margin: '-4px 0 14px' }}>
        <span style={{ fontSize: 12, color: 'var(--t3)', fontWeight: 700 }}>Sales shown</span>
        <div role="group" aria-label="Net or gross sales" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 84px)', gap: 6 }}>
          {BASIS_CHIPS.map((c) => (
            <button key={c.id} onClick={() => pickBasis(c.id)} aria-pressed={basisAsked === c.id}
              style={{ ...periodChip, minHeight: 44, ...(basisAsked === c.id ? periodChipOn : null) }}>{c.label}</button>
          ))}
        </div>
      </div>
      {sb.needsUpdate && <div style={{ color: 'var(--t3)', textAlign: 'center', fontSize: 12.5, margin: '-6px 0 12px' }}>{grossNeedsUpdate(r?.currency || 'GBP')}</div>}

      {loading && !data && <div style={{ color: 'var(--t3)', textAlign: 'center', padding: '60px 0' }}>Loading your business…</div>}
      {err && <div style={{ color: 'var(--red)', textAlign: 'center', padding: '20px 0', fontSize: 13 }}>{err}</div>}

      {data && data.locations.length === 0 && (
        <div style={{ color: 'var(--t3)', textAlign: 'center', padding: '50px 16px', fontSize: 14 }}>No locations are linked to your account yet.</div>
      )}

      {open && (
        <OwnerDetail target={open} period={period} basis={basis} supported={canDetail(data)} tick={tick} onBack={closeDetail} backLabel="Back" />
      )}

      {!open && (
        <div style={{ opacity: waiting ? 0.5 : 1, transition: 'opacity .15s' }}>
          {/* ── Rollup (all venues of one currency, the period shown) ── */}
          {groups.map((g) => (
            <GroupCard key={g.currency} g={g} shown={shown} basis={basis} multi={multi} mixed={groups.length > 1}
              bar={mixOn ? cardBar(g.rollup.mix, { hint: true }) : null}
              onOpen={() => openDetail(groupTarget(groups.length > 1 ? g.currency : (r.currency || null), g.rollup.locations))} />
          ))}

          {/* ── Per-venue cards ── */}
          {data?.locations?.map(l => <VenueCard key={l.ops_location_id} l={l} showName={multi} period={shown} basis={basis} showDates={shown !== 'today' && !dates}
            bar={mixOn ? cardBar(l.mix, { quiet: !!quietBy[l.currency] }) : null} onOpen={() => openDetail(venueTarget(l))} />)}
        </div>
      )}
    </>
  );
}

// A card that opens a screen: a tap, or Enter or Space from a keyboard.
const tapProps = (onOpen, label) => ({
  role: 'button', tabIndex: 0, 'aria-label': label, onClick: onOpen,
  onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } },
});
const MoreHint = () => <span style={{ fontSize: 11.5, color: 'var(--t3)', fontWeight: 700, flexShrink: 0 }}>Reports ›</span>;

function GroupCard({ g, shown, basis, multi, mixed, onOpen, bar }) {
  const r = g.rollup;
  const cur = g.currency;
  const copy = PERIOD_COPY[shown];
  const rv = rollupView(r, shown);
  // 16 Oct 2026: the sales, the old line's figure and its percent, net or gross.
  const rs = rollupSales(r, rv, basis);
  const words = cardLines(basis, cur);
  const dates = sharedRange(g.locations);
  const heading = [copy.heading, multi ? `${r?.locations} venue${r?.locations === 1 ? '' : 's'}` : '', mixed ? cur : '', shown === 'today' ? '' : rangeLabel(dates)].filter(Boolean).join(' · ');
  // The function's own comparison for the period shown; null from a function before the reason word.
  const cmp = basisCompare(groupCompareBlock(r, rv.period), basis);
  const line = cmp ? groupLine(cmp, sharedCompareRange(g.locations), rv.period) : null;
  return (
    <div {...tapProps(onOpen, `Reports for ${mixed ? `${cur} venues` : 'all venues'}`)}
      style={{ background: 'linear-gradient(160deg, var(--acc-d), var(--bg1))', border: '1px solid var(--acc-b)', borderRadius: 18, padding: '18px 18px 16px', marginBottom: 16, cursor: 'pointer' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10 }}>
        <div style={{ fontSize: 11.5, color: 'var(--t3)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em' }}>{heading}</div>
        <MoreHint />
      </div>
      <div style={{ fontSize: 38, fontWeight: 900, letterSpacing: '-.02em', margin: '2px 0 2px', lineHeight: 1.05 }}>{money(rs.sales, cur)}</div>
      <BasisLine text={words.line} />
      {rv.forecast > 0 && (
        <div style={{ fontSize: 13, fontWeight: 700, color: pctTone(rv.forecast_pct) }}>
          {rv.forecast_pct}% of forecast{words.groupForecast} <span style={{ color: 'var(--t4)', fontWeight: 600 }}>({money(rv.forecast, cur)})</span>
        </div>
      )}
      {/* 8 Oct 2026: the sales mix of this currency's venues, from the function; nothing from an old one. */}
      <MixBar bar={bar} size="group"/>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 8, marginTop: 14 }}>
        <Mini label="Orders" value={rv.orders} />
        <Mini label="Labour" value={rv.labour_pct != null ? `${rv.labour_pct}%` : '-'} tone={rv.labour_pct > 35 ? 'var(--red)' : 'var(--t1)'} />
        <Mini label="Live now" value={rv.live_orders} />
        <Mini label="On floor" value={rv.open_tables} />
      </div>
      {/* The comparison line is ALWAYS drawn, and the pounds are always the comparison's. */}
      {line && (
        <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 12 }}>
          {line.grey ? <span style={{ fontWeight: 700 }}>{line.grey}</span> : (
            <>{line.label} {money(line.amount, cur)} ·{' '}
              <span style={{ color: toneColor(line.tone), fontWeight: 700 }}>{line.pct}</span>{line.note}</>
          )}
        </div>
      )}
      {/* A function from before the reason word: the line it has always had. */}
      {!line && rs.vs_pct != null && (
        <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 12 }}>
          {rv.period === 'today' ? 'Week to date' : copy.before} {money(rs.before, cur)} ·{' '}
          <span style={{ color: rs.vs_pct >= 0 ? 'var(--grn)' : 'var(--red)', fontWeight: 700 }}>{signedPct(rs.vs_pct)}</span>{rv.period === 'today' ? ' vs last week' : likeForLikeNote(rv, r.locations)}
        </div>
      )}
    </div>
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

function VenueCard({ l, showName, period, basis, showDates, onOpen, bar }) {
  const t = venueView(l, period);
  const copy = PERIOD_COPY[t.period];
  const fpct = t.forecast_pct;
  // 16 Oct 2026: the sales, the average check and the old chip's percent, net or gross.
  const vs = venueSales(l, t, basis);
  const words = cardLines(basis, l.currency);
  // The function's own comparison for the period shown; null from a function before the reason word.
  const cmp = basisCompare(compareBlock(l, t.period), basis);
  const line = cmp ? compareLine(cmp, l.range, t.period) : null;
  return (
    <div {...tapProps(onOpen, `Reports for ${l.name}`)}
      style={{ background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 16, padding: 16, marginBottom: 12, cursor: 'pointer' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, marginBottom: 10 }}>
        <div style={{ fontSize: 14, fontWeight: 800, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{showName ? l.name : ''}</div>
        <MoreHint />
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <div style={{ fontSize: 10.5, color: 'var(--t4)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em' }}>{salesHeading(basis, t.period)}{showDates && rangeLabel(l.range) ? ` · ${rangeLabel(l.range)}` : ''}</div>
          <div style={{ fontSize: 28, fontWeight: 900, letterSpacing: '-.02em', lineHeight: 1.1 }}>{money(vs.sales, l.currency)}</div>
          <BasisLine text={words.line} />
        </div>
        <div style={{ textAlign: 'right' }}>
          {t.forecast > 0
            ? <><div style={{ fontSize: 18, fontWeight: 800, color: pctTone(fpct) }}>{fpct}%</div><div style={{ fontSize: 10, color: 'var(--t4)' }}>of {money(t.forecast, l.currency)}{words.forecastSuffix}</div></>
            : <div style={{ fontSize: 11, color: 'var(--t4)' }}>no forecast</div>}
        </div>
      </div>

      {/* forecast progress */}
      {t.forecast > 0 && (
        <div style={{ height: 6, background: 'var(--bg3)', borderRadius: 99, marginTop: 10, overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${Math.min(100, fpct || 0)}%`, background: pctTone(fpct), borderRadius: 99 }} />
        </div>
      )}
      {/* 8 Oct 2026: the sales mix bar (Food, Drinks, Other), from the function; nothing from an old one. */}
      <MixBar bar={bar}/>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8, marginTop: 14 }}>
        <Stat label="Orders" value={t.orders} />
        <Stat label="Avg check" value={money(vs.avg, l.currency, 2)} />
        <Stat label="Labour" value={t.labour_pct != null ? `${t.labour_pct}%` : '-'} tone={t.labour_pct > 35 ? 'var(--red)' : undefined} />
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        <Chip>● {l.live.orders} live order{l.live.orders === 1 ? '' : 's'}</Chip>
        <Chip>▢ {l.live.tables} on floor</Chip>
        {t.tips > 0 && <Chip>{money(t.tips, l.currency)} tips</Chip>}
        {/* A function from before the reason word: the chip it has always had. */}
        {!line && vs.vs_pct != null && <Chip tone={vs.vs_pct >= 0 ? 'var(--grn)' : 'var(--red)'}>{t.period === 'today' ? `WTD ${signedPct(vs.vs_pct)} vs last wk` : `${signedPct(vs.vs_pct)} ${copy.versus}`}</Chip>}
      </div>
      {/* The comparison line is ALWAYS drawn: a percent with what it is against, or the reason in grey. */}
      {line && <div style={{ fontSize: 12.5, fontWeight: 700, color: toneColor(line.tone), marginTop: 10 }}>{line.text}</div>}

      {t.top_items.length > 0 && (
        <div style={{ marginTop: 14, borderTop: '1px solid var(--bdr)', paddingTop: 10 }}>
          <div style={{ fontSize: 10.5, color: 'var(--t4)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 6 }}>{copy.top}<span style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 600 }}>{topItemsNote(l.currency)}</span></div>
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

// 16 Oct 2026: the small line under a sales figure, so a screenshot is never ambiguous. Always
// one short line ('Including VAT, after refunds' or 'Excluding VAT, after refunds', the same
// length), so a tap on the switch never makes a card change height.
function BasisLine({ text }) {
  return <div style={{ fontSize: 11, color: 'var(--t4)', fontWeight: 600, marginTop: 3 }}>{text}</div>;
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
const iconBtn = { width: 38, height: 38, borderRadius: 10, border: '1px solid var(--bdr)', background: 'var(--bg1)', color: 'var(--t2)', fontSize: 16, cursor: 'pointer', fontFamily: 'inherit' };
