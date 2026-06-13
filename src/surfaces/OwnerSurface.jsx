// src/surfaces/OwnerSurface.jsx  (?mode=owner)
//
// The owner phone app — a top-down snapshot of the whole business at a glance.
// Mobile-first PWA surface: back-office login (owners' existing credentials),
// then a rollup across every location they can access plus a per-venue card —
// today's sales vs forecast, labour %, live orders/tables, WTD vs last week and
// today's top items. All figures come from the owner-snapshot edge fn in one
// round trip. Read-only by design.

import { useEffect, useMemo, useState, useCallback } from 'react';
import { supabase, isMock } from '../lib/supabase';
import { ServOSWordmark, ServOSLockup } from '../components/ServOSBrand';

const money = (n, currency = 'GBP', dp = 0) => {
  try { return new Intl.NumberFormat('en-GB', { style: 'currency', currency, minimumFractionDigits: dp, maximumFractionDigits: dp }).format(Number(n) || 0); }
  catch { return `£${(Number(n) || 0).toFixed(dp)}`; }
};
const pctTone = (p, good = 'up') => p == null ? 'var(--t3)' : (good === 'up' ? (p >= 100 ? 'var(--grn)' : p >= 85 ? 'var(--amber)' : 'var(--red)') : 'var(--t1)');

export default function OwnerSurface() {
  const [session, setSession] = useState(undefined); // undefined=checking
  // Theme: reuse the app-wide rpos-theme key + [data-theme] CSS so the owner's
  // choice persists and matches the rest of ServOS.
  const [theme, setTheme] = useState(() => { try { return localStorage.getItem('rpos-theme') || 'dark'; } catch { return 'dark'; } });
  const toggleTheme = useCallback(() => setTheme(t => (t === 'dark' ? 'light' : 'dark')), []);

  useEffect(() => { try { document.documentElement.setAttribute('data-skin', 'servos'); } catch {} }, []);
  useEffect(() => { try { document.documentElement.setAttribute('data-theme', theme); localStorage.setItem('rpos-theme', theme); } catch {} }, [theme]);

  useEffect(() => {
    if (isMock || !supabase) { setSession(null); return; }
    supabase.auth.getSession().then(({ data }) => setSession(data?.session || null));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s || null));
    return () => sub?.subscription?.unsubscribe?.();
  }, []);

  if (session === undefined) return <Shell><div style={{ color: 'var(--t3)', textAlign: 'center', paddingTop: 80 }}>Loading…</div></Shell>;
  if (!session) return <Shell><Login theme={theme} onToggleTheme={toggleTheme} /></Shell>;
  return <Shell><Dashboard email={session.user?.email} theme={theme} onToggleTheme={toggleTheme} /></Shell>;
}

function Shell({ children }) {
  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg, #0F1211)', color: 'var(--t1)', fontFamily: 'var(--font, system-ui, sans-serif)' }}>
      <div style={{ maxWidth: 520, margin: '0 auto', padding: '16px 14px 40px' }}>{children}</div>
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
  const [err, setErr] = useState('');
  const [updated, setUpdated] = useState('');

  const load = useCallback(async () => {
    setErr('');
    try {
      const { data: d, error } = await supabase.functions.invoke('owner-snapshot', { body: {} });
      if (error) { let b = null; try { b = await error.context?.json?.(); } catch {} throw new Error(b?.error || error.message); }
      if (d?.error) throw new Error(d.error);
      setData(d);
      setUpdated(new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }));
    } catch (e) { setErr(e.message || 'Could not load'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); const t = setInterval(load, 120000); return () => clearInterval(t); }, [load]);

  const r = data?.rollup;
  const multi = (data?.locations?.length || 0) > 1;

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
          <button onClick={load} title="Refresh" style={iconBtn}>↻</button>
          <button onClick={() => supabase.auth.signOut()} title="Sign out" style={iconBtn}>⎋</button>
        </div>
      </div>

      {loading && !data && <div style={{ color: 'var(--t3)', textAlign: 'center', padding: '60px 0' }}>Loading your business…</div>}
      {err && <div style={{ color: 'var(--red)', textAlign: 'center', padding: '20px 0', fontSize: 13 }}>{err}</div>}

      {data && data.locations.length === 0 && (
        <div style={{ color: 'var(--t3)', textAlign: 'center', padding: '50px 16px', fontSize: 14 }}>No locations are linked to your account yet.</div>
      )}

      {/* ── Rollup (all venues today) ── */}
      {r && data.locations.length > 0 && (
        <div style={{ background: 'linear-gradient(160deg, var(--acc-d), var(--bg1))', border: '1px solid var(--acc-b)', borderRadius: 18, padding: '18px 18px 16px', marginBottom: 16 }}>
          <div style={{ fontSize: 11.5, color: 'var(--t3)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em' }}>{multi ? `Today · ${r.locations} venues` : 'Today'}</div>
          <div style={{ fontSize: 38, fontWeight: 900, letterSpacing: '-.02em', margin: '2px 0 2px', lineHeight: 1.05 }}>{money(r.net_sales, data.locations[0]?.currency)}</div>
          {r.forecast > 0 && (
            <div style={{ fontSize: 13, fontWeight: 700, color: pctTone(r.forecast_pct) }}>
              {r.forecast_pct}% of forecast <span style={{ color: 'var(--t4)', fontWeight: 600 }}>({money(r.forecast, data.locations[0]?.currency)})</span>
            </div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 8, marginTop: 14 }}>
            <Mini label="Orders" value={r.orders} />
            <Mini label="Labour" value={r.labour_pct != null ? `${r.labour_pct}%` : '—'} tone={r.labour_pct > 35 ? 'var(--red)' : 'var(--t1)'} />
            <Mini label="Live now" value={r.live_orders} />
            <Mini label="On floor" value={r.open_tables} />
          </div>
          {r.wtd_vs_last_week_pct != null && (
            <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 12 }}>
              Week to date {money(r.wtd_net, data.locations[0]?.currency)} ·{' '}
              <span style={{ color: r.wtd_vs_last_week_pct >= 0 ? 'var(--grn)' : 'var(--red)', fontWeight: 700 }}>{r.wtd_vs_last_week_pct >= 0 ? '+' : ''}{r.wtd_vs_last_week_pct}%</span> vs last week
            </div>
          )}
        </div>
      )}

      {/* ── Per-venue cards ── */}
      {data?.locations?.map(l => <VenueCard key={l.ops_location_id} l={l} showName={multi} />)}
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

function VenueCard({ l, showName }) {
  const t = l.today;
  const fpct = t.forecast_pct;
  return (
    <div style={{ background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 16, padding: 16, marginBottom: 12 }}>
      {showName && <div style={{ fontSize: 14, fontWeight: 800, marginBottom: 10 }}>{l.name}</div>}
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <div style={{ fontSize: 10.5, color: 'var(--t4)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em' }}>Net sales today</div>
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
        {l.wtd.vs_last_week_pct != null && <Chip tone={l.wtd.vs_last_week_pct >= 0 ? 'var(--grn)' : 'var(--red)'}>WTD {l.wtd.vs_last_week_pct >= 0 ? '+' : ''}{l.wtd.vs_last_week_pct}% vs last wk</Chip>}
      </div>

      {l.top_items?.length > 0 && (
        <div style={{ marginTop: 14, borderTop: '1px solid var(--bdr)', paddingTop: 10 }}>
          <div style={{ fontSize: 10.5, color: 'var(--t4)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 6 }}>Top sellers today</div>
          {l.top_items.map((it, i) => (
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
const iconBtn = { width: 38, height: 38, borderRadius: 10, border: '1px solid var(--bdr)', background: 'var(--bg1)', color: 'var(--t2)', fontSize: 16, cursor: 'pointer', fontFamily: 'inherit' };
