// src/surfaces/StaffApp.jsx
//
// Hospitality Staff Management — module shell (?mode=staff).
// Build order §7: step 1 (shell + venue scope + seed/labour) + step 2 (Rota View
// A/B + labour engine, the spine). Other modules land in subsequent builds.
// Styled with the ServOS design system (data-skin=servos + glass); the wireframe
// is greyscale on purpose — palette comes from ServOS.

import { useState, useEffect } from 'react';
import { useStore } from '../store';
import { Icon } from '../components/ServOSIcons';
import { VENUES, DAYS, TODAY, SECTIONS, ROLES, GROUPS, SECTION_REQ, FORECAST } from '../staff/seed';
import { hoursOf, effectiveRate, wageByDay, labourPct, LABOUR_TARGET } from '../staff/labour';

const money = n => '£' + Math.round(n).toLocaleString();
// Section/role-group hues on the shared OKLCH colour-coding scale (ServOS §3).
const HUE = { mgmt: 250, bar: 200, floor: 150, kitchen: 38, door: 285 };
const groupColor = grp => `oklch(var(--cat-l) var(--cat-c) ${HUE[grp] ?? 250})`;

const NAV = [
  { label: 'Schedule', items: [
    ['dashboard', 'Dashboard', 'home'],
    ['rota', 'Rota', 'floor'],
    ['timesheets', 'Timesheets', 'status', 5],
    ['timeoff', 'Time Off & Availability', 'note', 3],
  ] },
  { label: 'Team', items: [
    ['staff', 'Staff', 'team'],
    ['onboarding', 'Onboarding', 'user', 2],
    ['compliance', 'Compliance', 'warn', 3],
  ] },
  { label: 'Pay', items: [
    ['pay', 'Pay & Rates', 'card'],
    ['tronc', 'Tronc / Tips', 'tag'],
  ] },
  { label: 'Comms', items: [
    ['announce', 'Announcements', 'sparkle'],
    ['settings', 'Venues, Roles & Sections', 'settings'],
  ] },
];
const TITLES = {
  dashboard: ['Dashboard', 'Today across the group'], rota: ['Rota', 'Schedule & labour'],
  timesheets: ['Timesheets', 'Clocked vs scheduled'], timeoff: ['Time Off & Availability', 'Leave, availability & swaps'],
  staff: ['Staff', 'HR records'], onboarding: ['Onboarding', 'New starter setup'], compliance: ['Compliance', 'Documents & expiries'],
  pay: ['Pay & Rates', 'Rates, labour & cost'], tronc: ['Tronc / Tips', 'Pooled tip distribution'],
  announce: ['Announcements', 'Team messaging'], settings: ['Venues, Roles & Sections', 'Configuration'],
};

export default function StaffApp() {
  const { theme, setTheme } = useStore();
  const [screen, setScreen] = useState('dashboard');
  const [venueId, setVenueId] = useState('anchor');
  const [venueOpen, setVenueOpen] = useState(false);
  const [rotaView, setRotaView] = useState('a');

  // Staff is a staff surface → ServOS skin + follow the POS theme.
  useEffect(() => {
    const el = document.documentElement;
    el.setAttribute('data-skin', 'servos');
    el.setAttribute('data-theme', theme || 'dark');
    return () => {};
  }, [theme]);

  const venue = VENUES.find(v => v.id === venueId) || { name: 'All venues' };
  const [title, sub] = TITLES[screen] || ['', ''];

  return (
    <div data-skin="servos" style={{ display: 'flex', height: '100vh', overflow: 'hidden', background: 'transparent', color: 'var(--t1)', fontFamily: "'Space Grotesk', sans-serif" }}>
      {/* ── Sidebar (glass) ── */}
      <aside style={{ width: 248, flexShrink: 0, display: 'flex', flexDirection: 'column', background: 'var(--glass-bg)', backdropFilter: 'blur(22px) saturate(150%)', WebkitBackdropFilter: 'blur(22px) saturate(150%)', borderRight: '1px solid var(--glass-border)' }}>
        <div style={{ padding: '16px 18px 14px', borderBottom: '1px solid var(--hair, var(--bdr))', display: 'flex', alignItems: 'center', gap: 11 }}>
          <div style={{ width: 38, height: 38, borderRadius: 11, background: 'var(--glass-bg)', border: '1px solid var(--glass-border)', boxShadow: 'var(--glass-hi)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: "'Syne', sans-serif", fontWeight: 800, color: 'var(--t1)' }}>P<span style={{ width: '0.17em', height: '0.17em', borderRadius: '50%', background: '#15C26A', marginLeft: 1, alignSelf: 'flex-end', marginBottom: 6 }} /></div>
          <div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '.18em', textTransform: 'uppercase', color: 'var(--t3)' }}>POS · Workforce</div>
            <div style={{ fontSize: 15, fontWeight: 700, letterSpacing: '-.01em' }}>Staff</div>
          </div>
        </div>

        <nav style={{ flex: 1, overflowY: 'auto', padding: '10px 8px', display: 'flex', flexDirection: 'column', gap: 1 }}>
          {NAV.map(grp => (
            <div key={grp.label} style={{ marginBottom: 8 }}>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, fontWeight: 700, letterSpacing: '.16em', textTransform: 'uppercase', color: 'var(--t4)', padding: '8px 11px 4px' }}>{grp.label}</div>
              {grp.items.map(([id, label, icon, count]) => {
                const active = screen === id;
                return (
                  <button key={id} onClick={() => setScreen(id)} style={{
                    display: 'flex', alignItems: 'center', gap: 11, padding: '9px 11px', borderRadius: 11, width: '100%',
                    cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left', transition: 'all .12s',
                    border: `1px solid ${active ? 'var(--acc-b)' : 'transparent'}`,
                    background: active ? 'var(--acc-d)' : 'transparent',
                    boxShadow: active ? 'var(--glass-hi)' : 'none',
                    color: active ? 'var(--acc)' : 'var(--t2)',
                  }}>
                    <Icon name={icon} size={18} style={{ color: active ? 'var(--acc)' : 'var(--t3)' }} />
                    <span style={{ flex: 1, fontSize: 13, fontWeight: active ? 600 : 500 }}>{label}</span>
                    {count ? <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 700, padding: '1px 7px', borderRadius: 999, background: 'rgba(245,166,35,.16)', color: 'var(--amber)' }}>{count}</span> : null}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>

        <div style={{ borderTop: '1px solid var(--hair, var(--bdr))', padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 32, height: 32, borderRadius: '50%', background: 'linear-gradient(180deg,#2FD984,#15C26A)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 800, color: '#06130C' }}>AM</div>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600 }}>Alex Mercer</div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--t4)' }}>Group Operations</div>
          </div>
        </div>
      </aside>

      {/* ── Main ── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {/* Top bar (glass) with venue switcher */}
        <div style={{ height: 60, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 14, padding: '0 22px', background: 'var(--glass-bg)', backdropFilter: 'blur(22px) saturate(150%)', WebkitBackdropFilter: 'blur(22px) saturate(150%)', borderBottom: '1px solid var(--glass-border)' }}>
          <div>
            <div style={{ fontSize: 17, fontWeight: 700, letterSpacing: '-.015em' }}>{title}</div>
            <div style={{ fontSize: 12, color: 'var(--t3)' }}>{sub}</div>
          </div>
          <div style={{ flex: 1 }} />
          {/* Venue switcher */}
          <div style={{ position: 'relative' }}>
            <button onClick={() => setVenueOpen(o => !o)} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '8px 13px', borderRadius: 11, cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, fontWeight: 600, color: 'var(--t1)', background: 'var(--inset)', border: '1px solid var(--inset-border)' }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#15C26A', boxShadow: '0 0 8px #46E08C' }} />
              {venue.name}
              <Icon name="chevron" size={13} style={{ color: 'var(--t4)', transform: 'rotate(90deg)' }} />
            </button>
            {venueOpen && (
              <div style={{ position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 20, minWidth: 200, background: 'var(--bg1)', border: '1px solid var(--glass-border)', borderRadius: 12, boxShadow: 'var(--glass-shadow)', overflow: 'hidden' }}>
                {[{ id: 'all', name: 'All venues', type: 'Group rollup' }, ...VENUES].map(v => (
                  <button key={v.id} onClick={() => { setVenueId(v.id); setVenueOpen(false); }} style={{ display: 'flex', alignItems: 'center', gap: 9, width: '100%', padding: '10px 13px', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left', border: 'none', background: venueId === v.id ? 'var(--acc-d)' : 'transparent', color: venueId === v.id ? 'var(--acc)' : 'var(--t1)' }}>
                    <span style={{ flex: 1, fontSize: 13, fontWeight: 600 }}>{v.name}</span>
                    <span style={{ fontSize: 11, color: 'var(--t4)', textTransform: 'capitalize' }}>{v.type}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <button onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} title="Theme" style={{ width: 34, height: 30, borderRadius: 9, border: '1px solid var(--inset-border)', background: 'var(--inset)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--t3)' }}>
            <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={15} />
          </button>
        </div>

        {/* Scene-backed content */}
        <div style={{ flex: 1, overflowY: 'auto', padding: 24 }}>
          {screen === 'dashboard' && <Dashboard venue={venue} />}
          {screen === 'rota' && <Rota venue={venue} view={rotaView} setView={setRotaView} />}
          {!['dashboard', 'rota'].includes(screen) && <Placeholder title={title} />}
        </div>
      </div>
    </div>
  );
}

// ── Cards / shared ──
function Card({ children, style }) {
  return <div style={{ background: 'var(--glass-bg)', backdropFilter: 'blur(22px) saturate(150%)', WebkitBackdropFilter: 'blur(22px) saturate(150%)', border: '1px solid var(--glass-border)', boxShadow: 'var(--glass-shadow), var(--glass-hi)', borderRadius: 16, padding: 18, ...style }}>{children}</div>;
}
function RoleChip({ role }) {
  const r = ROLES[role]; if (!r) return null;
  const col = groupColor(r.grp);
  return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, color: col }}><span style={{ width: 7, height: 7, borderRadius: '50%', background: col }} />{r.lbl}</span>;
}

// ── Dashboard (step 11 preview — headline stats) ──
function Dashboard({ venue }) {
  const wage = wageByDay();
  const todayWage = wage[TODAY];
  const todaySales = FORECAST[TODAY];
  const pct = labourPct(todayWage, todaySales);
  const over = pct > LABOUR_TARGET;
  const stats = [
    { k: 'On shift now', v: '14', sub: '/ 21 scheduled today', tone: '' },
    { k: 'Labour % today', v: Math.round(pct * 100) + '%', sub: `vs ${Math.round(LABOUR_TARGET * 100)}% target`, tone: over ? 'red' : 'grn' },
    { k: 'Wage cost today', v: money(todayWage), sub: `Forecast sales ${money(todaySales)}`, tone: '' },
    { k: 'Needs action', v: '8', sub: '5 timesheets · 3 docs', tone: 'amber' },
  ];
  const toneColor = t => t === 'red' ? 'var(--red)' : t === 'grn' ? 'var(--grn)' : t === 'amber' ? 'var(--amber)' : 'var(--t1)';
  return (
    <div style={{ maxWidth: 1240, margin: '0 auto' }}>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, letterSpacing: '.16em', textTransform: 'uppercase', color: 'var(--acc)' }}>{venue.name} · staff</div>
      <h1 style={{ fontSize: 28, fontWeight: 700, letterSpacing: '-.02em', margin: '8px 0 20px' }}>Good morning</h1>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 14, marginBottom: 24 }}>
        {stats.map(s => (
          <Card key={s.k} style={{ position: 'relative', overflow: 'hidden' }}>
            <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, background: toneColor(s.tone) }} />
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--t3)' }}>{s.k}</div>
            <div style={{ fontSize: 30, fontWeight: 800, letterSpacing: '-.02em', marginTop: 10, color: toneColor(s.tone), fontFamily: 'var(--font-mono)' }}>{s.v}</div>
            <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 6 }}>{s.sub}</div>
          </Card>
        ))}
      </div>
      <Card>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>Labour engine is live</div>
        <div style={{ fontSize: 13, color: 'var(--t3)', lineHeight: 1.6 }}>The rota's labour % is computed by the engine (effective rate → wage by day → % vs the {Math.round(LABOUR_TARGET * 100)}% target). Open <b style={{ color: 'var(--acc)' }}>Rota</b> to see the live footer. More modules — timesheets, tronc, onboarding, compliance — land in the next builds.</div>
      </Card>
    </div>
  );
}

// ── Rota — View A (by staff) + View B (section coverage). The spine. ──
function Rota({ view, setView }) {
  const wage = wageByDay();
  return (
    <div style={{ maxWidth: 1320, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <div style={{ display: 'inline-flex', padding: 3, borderRadius: 11, background: 'var(--inset)', border: '1px solid var(--inset-border)' }}>
          {[['a', 'By staff'], ['b', 'By section']].map(([k, lbl]) => (
            <button key={k} onClick={() => setView(k)} style={{ padding: '7px 14px', borderRadius: 8, border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5, fontWeight: 600, background: view === k ? 'var(--glass-bg)' : 'transparent', boxShadow: view === k ? 'var(--glass-hi)' : 'none', color: view === k ? 'var(--t1)' : 'var(--t3)' }}>{lbl}</button>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        <button className="btn btn-ghost" style={{ height: 36 }}>Copy last week</button>
        <button className="btn btn-acc" style={{ height: 36 }}>Publish rota →</button>
      </div>
      {view === 'a' ? <RotaByStaff wage={wage} /> : <RotaBySection />}
    </div>
  );
}

const cellBg = (col, a) => `color-mix(in oklch, ${col} ${a}%, transparent)`;

function RotaByStaff({ wage }) {
  return (
    <Card style={{ padding: 0, overflow: 'hidden' }}>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
          <thead>
            <tr>
              <th style={{ ...th, textAlign: 'left', minWidth: 200 }}>Staff · role</th>
              {DAYS.map((d, i) => <th key={i} style={{ ...th, color: i === TODAY ? 'var(--acc)' : 'var(--t3)' }}>{d[0]} {d[1]}</th>)}
            </tr>
          </thead>
          <tbody>
            {GROUPS.map(g => (
              <RotaGroup key={g.name} g={g} />
            ))}
          </tbody>
          <tfoot>
            <FootRow label="Forecast sales" cells={FORECAST.map(f => money(f))} />
            <FootRow label="Wage cost" cells={wage.map(w => money(w))} />
            <tr>
              <td style={{ ...td, fontWeight: 700, color: 'var(--t2)' }}>Labour % (target {Math.round(LABOUR_TARGET * 100)}%)</td>
              {wage.map((w, i) => {
                const p = labourPct(w, FORECAST[i]); const over = p > LABOUR_TARGET;
                return <td key={i} style={{ ...td, textAlign: 'center', fontFamily: 'var(--font-mono)', fontWeight: 800, color: over ? 'var(--red)' : 'var(--grn)' }}>{Math.round(p * 100)}%</td>;
              })}
            </tr>
          </tfoot>
        </table>
      </div>
    </Card>
  );
}

function RotaGroup({ g }) {
  return (
    <>
      <tr><td colSpan={8} style={{ ...td, fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '.12em', textTransform: 'uppercase', color: 'var(--t4)', background: 'var(--inset)', fontWeight: 700 }}>{g.name}</td></tr>
      {g.staff.map(s => {
        const role = ROLES[s.role];
        const rateLbl = role.rate ? `£${role.rate.toFixed(2)}/h${s.band ? ' · ' + s.band : ''}` : `£${(role.salary / 1000)}k · salaried`;
        return (
          <tr key={s.nm}>
            <td style={{ ...td, borderRight: '1px solid var(--hair, var(--bdr))' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                <span style={{ width: 26, height: 26, borderRadius: '50%', background: 'var(--inset)', border: '1px solid var(--inset-border)', flexShrink: 0 }} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>{s.nm}{s.blocked && <Icon name="warn" size={13} style={{ color: 'var(--red)' }} />}</div>
                  <div style={{ fontSize: 10.5, color: 'var(--t3)', display: 'flex', alignItems: 'center', gap: 6, marginTop: 1 }}><RoleChip role={s.role} /> <span style={{ fontFamily: 'var(--font-mono)' }}>{rateLbl}</span></div>
                </div>
              </div>
            </td>
            {Array.from({ length: 7 }, (_, i) => {
              const c = s.days[i]; const todayCol = i === TODAY;
              if (c && c.off) return <td key={i} style={{ ...td, background: todayCol ? 'var(--inset)' : undefined }}><div style={{ textAlign: 'center', fontSize: 11, color: 'var(--t4)', fontStyle: 'italic', padding: '6px 0' }}>{c.off}</div></td>;
              if (Array.isArray(c)) {
                const col = groupColor(c[2]); const hrs = hoursOf(c[0], c[1]);
                return (
                  <td key={i} style={{ ...td, padding: 4, background: todayCol ? 'var(--inset)' : undefined }}>
                    <div style={{ borderRadius: 9, padding: '6px 8px', background: cellBg(col, 13), border: `1px solid ${cellBg(col, 30)}`, borderLeft: `2.5px solid ${col}` }}>
                      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, fontWeight: 700, color: 'var(--t1)' }}>{c[0]}–{c[1]}</div>
                      <div style={{ fontSize: 10, color: 'var(--t3)' }}>{SECTIONS[c[2]] || role.lbl} · {hrs}h</div>
                    </div>
                  </td>
                );
              }
              return <td key={i} style={{ ...td, textAlign: 'center', background: todayCol ? 'var(--inset)' : undefined }}><button style={{ width: 26, height: 26, borderRadius: 8, border: '1px dashed var(--bdr2)', background: 'transparent', color: 'var(--t4)', cursor: 'pointer', fontSize: 15 }}>+</button></td>;
            })}
          </tr>
        );
      })}
    </>
  );
}

function FootRow({ label, cells }) {
  return <tr><td style={{ ...td, fontWeight: 600, color: 'var(--t2)' }}>{label}</td>{cells.map((c, i) => <td key={i} style={{ ...td, textAlign: 'center', fontFamily: 'var(--font-mono)', color: 'var(--t2)' }}>{c}</td>)}</tr>;
}

function RotaBySection() {
  // Build coverage map: section → day → [people]
  const map = { bar: {}, floor: {}, kitchen: {}, door: {} };
  GROUPS.forEach(g => g.staff.forEach(s => {
    for (let i = 0; i < 7; i++) { const c = s.days[i]; if (Array.isArray(c) && map[c[2]]) { (map[c[2]][i] = map[c[2]][i] || []).push({ nm: s.nm.split(' ')[0] + ' ' + (s.nm.split(' ')[1] || '')[0] + '.', t: c[0] + '–' + c[1] }); } }
  }));
  return (
    <Card style={{ padding: 0, overflow: 'hidden' }}>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead><tr><th style={{ ...th, textAlign: 'left', minWidth: 160 }}>Section</th>{DAYS.map((d, i) => <th key={i} style={{ ...th, color: i === TODAY ? 'var(--acc)' : 'var(--t3)' }}>{d[0]} {d[1]}</th>)}</tr></thead>
          <tbody>
            {Object.keys(map).map(sec => {
              const req = SECTION_REQ[sec]; const col = groupColor(sec);
              return (
                <tr key={sec}>
                  <td style={{ ...td, borderRight: '1px solid var(--hair, var(--bdr))' }}><div style={{ fontWeight: 600, color: col }}>{SECTIONS[sec]}</div><div style={{ fontSize: 10.5, color: 'var(--t4)' }}>Min {req} on peak</div></td>
                  {Array.from({ length: 7 }, (_, i) => {
                    const ppl = map[sec][i] || []; const n = ppl.length; const ok = n >= req;
                    return (
                      <td key={i} style={{ ...td, verticalAlign: 'top', padding: 6, background: i === TODAY ? 'var(--inset)' : undefined }}>
                        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700, color: ok ? 'var(--grn)' : 'var(--red)', marginBottom: 4 }}>{n}/{req}</div>
                        {ppl.map((p, j) => <div key={j} style={{ fontSize: 10.5, color: 'var(--t2)' }}><b style={{ fontWeight: 600 }}>{p.nm}</b> <span style={{ color: 'var(--t4)' }}>{p.t}</span></div>)}
                        {n < req && <div style={{ marginTop: 4, fontSize: 10, fontWeight: 700, color: 'var(--red)', background: 'var(--red-d)', border: '1px solid var(--red-b)', borderRadius: 6, padding: '2px 5px', display: 'inline-block' }}>Gap · need {req - n}</div>}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function Placeholder({ title }) {
  return (
    <div style={{ maxWidth: 700, margin: '40px auto 0', textAlign: 'center' }}>
      <Card>
        <div style={{ width: 52, height: 52, borderRadius: 14, margin: '0 auto 14px', background: 'var(--acc-d)', border: '1px solid var(--acc-b)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--acc)' }}><Icon name="sparkle" size={24} /></div>
        <div style={{ fontSize: 18, fontWeight: 700 }}>{title}</div>
        <div style={{ fontSize: 13, color: 'var(--t3)', marginTop: 8, lineHeight: 1.6 }}>This module is in the build queue. The foundation (venue scope, seed group, labour engine) and the Rota spine are live — {title} ships in the next build, wired to the same engine + ServOS design system.</div>
      </Card>
    </div>
  );
}

const th = { padding: '11px 8px', textAlign: 'center', fontFamily: 'var(--font-mono)', fontSize: 9.5, fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--t3)', borderBottom: '1px solid var(--glass-border)' };
const td = { padding: '9px 8px', borderBottom: '1px solid var(--hair, var(--bdr))', verticalAlign: 'middle' };
