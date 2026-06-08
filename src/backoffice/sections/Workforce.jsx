// src/backoffice/sections/Workforce.jsx
//
// Workforce (staff management) — a Back Office section group. Renders inside the
// BO content area (the BO provides the shell + sidebar nav: Workforce accordion).
// Uses the ServOS / BO design system. Seed-first build (src/staff/*); POS-sourced
// numbers (sales, clock-ins, tip pool) wire to the POS in the hardening pass.

import { useState } from 'react';
import { Icon } from '../../components/ServOSIcons';
import {
  VENUES, DAYS, TODAY, SECTIONS, ROLES, GROUPS, SECTION_REQ, FORECAST,
  STAFF, TIMESHEETS, TRONC_POOL, TRONC_HOURS, PAYROWS, COMPLIANCE,
} from '../../staff/seed';
import { hoursOf, effectiveRate, wageByDay, labourPct, LABOUR_TARGET, troncRun, tsVariance } from '../../staff/labour';

const money = (n, dp = 0) => '£' + Number(n).toLocaleString('en-GB', { minimumFractionDigits: dp, maximumFractionDigits: dp });
const HUE = { mgmt: 250, bar: 200, floor: 150, kitchen: 38, door: 285 };
const groupColor = grp => `oklch(var(--cat-l) var(--cat-c) ${HUE[grp] ?? 250})`;

const SUBS = {
  'wf-dashboard': ['Dashboard', 'Today across the group'],
  'wf-rota': ['Rota', 'Schedule & labour'],
  'wf-timesheets': ['Timesheets', 'Clocked vs scheduled'],
  'wf-timeoff': ['Time off & availability', 'Leave, availability & swaps'],
  'wf-staff': ['Staff', 'HR records'],
  'wf-onboarding': ['Onboarding', 'New starter setup'],
  'wf-compliance': ['Compliance', 'Documents & expiries'],
  'wf-pay': ['Pay & rates', 'Rates, labour & cost'],
  'wf-tronc': ['Tronc / tips', 'Pooled tip distribution'],
  'wf-announce': ['Announcements', 'Team messaging'],
  'wf-settings': ['Workforce settings', 'Venues, roles & sections'],
};

export default function Workforce({ section }) {
  const [venueId, setVenueId] = useState('anchor');
  const venue = VENUES.find(v => v.id === venueId) || { name: 'All venues' };
  const key = (section || 'wf-dashboard').replace('wf-', '');
  const [title, sub] = SUBS[section] || ['Workforce', ''];

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 16, marginBottom: 20, flexWrap: 'wrap' }}>
        <div>
          <div className="mono" style={{ fontSize: 10.5, letterSpacing: '.16em', textTransform: 'uppercase', color: 'var(--acc)' }}>Workforce · {venue.name}</div>
          <h1 style={{ fontSize: 24, fontWeight: 700, letterSpacing: '-.02em', marginTop: 6 }}>{title}</h1>
          <div style={{ fontSize: 13, color: 'var(--t3)', marginTop: 2 }}>{sub}</div>
        </div>
        <div style={{ flex: 1 }} />
        <VenueSwitch venueId={venueId} setVenueId={setVenueId} />
      </div>

      {key === 'dashboard' && <WfDashboard />}
      {key === 'rota' && <WfRota />}
      {key === 'timesheets' && <WfTimesheets />}
      {key === 'pay' && <WfPay />}
      {key === 'tronc' && <WfTronc />}
      {key === 'compliance' && <WfCompliance />}
      {key === 'staff' && <WfStaff />}
      {['timeoff', 'onboarding', 'announce', 'settings'].includes(key) && <WfPlaceholder title={title} />}
    </div>
  );
}

// ── shared bits ──
function Card({ children, style }) {
  return <div style={{ background: 'var(--glass-bg)', backdropFilter: 'blur(22px) saturate(150%)', WebkitBackdropFilter: 'blur(22px) saturate(150%)', border: '1px solid var(--glass-border)', boxShadow: 'var(--glass-shadow), var(--glass-hi)', borderRadius: 16, padding: 18, ...style }}>{children}</div>;
}
function RoleChip({ role }) {
  const r = ROLES[role]; if (!r) return null; const col = groupColor(r.grp);
  return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, color: col }}><span style={{ width: 7, height: 7, borderRadius: '50%', background: col }} />{r.lbl}</span>;
}
const BADGE = {
  green: { bg: 'var(--grn-d)', bd: 'var(--grn-b)', fg: 'var(--grn)' },
  amber: { bg: 'rgba(245,166,35,.13)', bd: 'rgba(245,166,35,.30)', fg: 'var(--amber)' },
  red: { bg: 'var(--red-d)', bd: 'var(--red-b)', fg: 'var(--red)' },
  blue: { bg: 'var(--blu-d)', bd: 'var(--blu-b)', fg: 'var(--blu)' },
};
function Badge({ tone = 'green', children }) {
  const c = BADGE[tone];
  return <span style={{ display: 'inline-flex', alignItems: 'center', fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: c.bg, border: `1px solid ${c.bd}`, color: c.fg, whiteSpace: 'nowrap' }}>{children}</span>;
}
function VenueSwitch({ venueId, setVenueId }) {
  const [open, setOpen] = useState(false);
  const venue = VENUES.find(v => v.id === venueId) || { name: 'All venues' };
  return (
    <div style={{ position: 'relative' }}>
      <button onClick={() => setOpen(o => !o)} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '9px 13px', borderRadius: 11, cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, fontWeight: 600, color: 'var(--t1)', background: 'var(--inset)', border: '1px solid var(--inset-border)' }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#15C26A', boxShadow: '0 0 8px #46E08C' }} />{venue.name}
        <Icon name="chevron" size={13} style={{ color: 'var(--t4)', transform: 'rotate(90deg)' }} />
      </button>
      {open && (
        <div style={{ position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 30, minWidth: 210, background: 'var(--bg1)', border: '1px solid var(--glass-border)', borderRadius: 12, boxShadow: 'var(--sh2)', overflow: 'hidden' }}>
          {[{ id: 'all', name: 'All venues', type: 'Group rollup' }, ...VENUES].map(v => (
            <button key={v.id} onClick={() => { setVenueId(v.id); setOpen(false); }} style={{ display: 'flex', alignItems: 'center', gap: 9, width: '100%', padding: '10px 13px', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left', border: 'none', background: venueId === v.id ? 'var(--acc-d)' : 'transparent', color: venueId === v.id ? 'var(--acc)' : 'var(--t1)' }}>
              <span style={{ flex: 1, fontSize: 13, fontWeight: 600 }}>{v.name}</span><span style={{ fontSize: 11, color: 'var(--t4)', textTransform: 'capitalize' }}>{v.type}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
const th = { padding: '11px 10px', textAlign: 'left', fontFamily: 'var(--font-mono)', fontSize: 9.5, fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--t3)', borderBottom: '1px solid var(--glass-border)' };
const td = { padding: '10px 10px', borderBottom: '1px solid var(--bdr)', verticalAlign: 'middle', fontSize: 13 };

// ── Dashboard ──
function WfDashboard() {
  const wage = wageByDay();
  const pct = labourPct(wage[TODAY], FORECAST[TODAY]); const over = pct > LABOUR_TARGET;
  const stats = [
    { k: 'On shift now', v: '14', sub: '/ 21 scheduled today', col: 'var(--t1)' },
    { k: 'Labour % today', v: Math.round(pct * 100) + '%', sub: `vs ${Math.round(LABOUR_TARGET * 100)}% target`, col: over ? 'var(--red)' : 'var(--grn)' },
    { k: 'Wage cost today', v: money(wage[TODAY]), sub: `Forecast sales ${money(FORECAST[TODAY])}`, col: 'var(--acc)' },
    { k: 'Needs action', v: '8', sub: '5 timesheets · 3 docs', col: 'var(--amber)' },
  ];
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 14 }}>
      {stats.map(s => (
        <Card key={s.k} style={{ position: 'relative', overflow: 'hidden' }}>
          <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, background: s.col }} />
          <div className="mono" style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--t3)' }}>{s.k}</div>
          <div className="mono" style={{ fontSize: 28, fontWeight: 800, letterSpacing: '-.02em', marginTop: 10, color: s.col }}>{s.v}</div>
          <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 6 }}>{s.sub}</div>
        </Card>
      ))}
    </div>
  );
}

// ── Rota (the spine) ──
function WfRota() {
  const [view, setView] = useState('a');
  const [pub, setPub] = useState(false);
  const wage = wageByDay();
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
        <div style={{ display: 'inline-flex', padding: 3, borderRadius: 11, background: 'var(--inset)', border: '1px solid var(--inset-border)' }}>
          {[['a', 'By staff'], ['b', 'By section']].map(([k, lbl]) => (
            <button key={k} onClick={() => setView(k)} style={{ padding: '7px 14px', borderRadius: 8, border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5, fontWeight: 600, background: view === k ? 'var(--bg1)' : 'transparent', boxShadow: view === k ? 'var(--glass-hi)' : 'none', color: view === k ? 'var(--t1)' : 'var(--t3)' }}>{lbl}</button>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        <button className="btn btn-ghost btn-sm">Copy last week</button>
        <button className="btn btn-acc btn-sm" onClick={() => setPub(true)}>Publish rota →</button>
      </div>
      <Card style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto' }}>
          {view === 'a' ? <RotaByStaff wage={wage} /> : <RotaBySection />}
        </div>
      </Card>
      {pub && <PublishModal onClose={() => setPub(false)} />}
    </>
  );
}

const cellTint = (col, a) => `color-mix(in oklch, ${col} ${a}%, transparent)`;

function RotaByStaff({ wage }) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5, minWidth: 880 }}>
      <thead><tr><th style={{ ...th, minWidth: 200 }}>Staff · role</th>{DAYS.map((d, i) => <th key={i} style={{ ...th, textAlign: 'center', color: i === TODAY ? 'var(--acc)' : 'var(--t3)' }}>{d[0]} {d[1]}</th>)}</tr></thead>
      <tbody>
        {GROUPS.map(g => (
          <RotaGroupRows key={g.name} g={g} />
        ))}
      </tbody>
      <tfoot>
        <FootRow label="Forecast sales" cells={FORECAST.map(f => money(f))} />
        <FootRow label="Wage cost" cells={wage.map(w => money(w))} />
        <tr>
          <td style={{ ...td, fontWeight: 700, color: 'var(--t2)' }}>Labour % <span style={{ color: 'var(--t4)', fontWeight: 400 }}>(target {Math.round(LABOUR_TARGET * 100)}%)</span></td>
          {wage.map((w, i) => { const p = labourPct(w, FORECAST[i]); const over = p > LABOUR_TARGET; return <td key={i} style={{ ...td, textAlign: 'center', fontFamily: 'var(--font-mono)', fontWeight: 800, color: over ? 'var(--red)' : 'var(--grn)' }}>{Math.round(p * 100)}%</td>; })}
        </tr>
      </tfoot>
    </table>
  );
}
function RotaGroupRows({ g }) {
  return (
    <>
      <tr><td colSpan={8} style={{ ...td, fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '.12em', textTransform: 'uppercase', color: 'var(--t4)', background: 'var(--inset)', fontWeight: 700 }}>{g.name}</td></tr>
      {g.staff.map(s => {
        const role = ROLES[s.role];
        const rateLbl = role.rate ? `£${role.rate.toFixed(2)}/h${s.band ? ' · ' + s.band : ''}` : `£${role.salary / 1000}k · salaried`;
        return (
          <tr key={s.nm}>
            <td style={{ ...td, borderRight: '1px solid var(--bdr)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                <span style={{ width: 26, height: 26, borderRadius: '50%', background: 'var(--inset)', border: '1px solid var(--inset-border)', flexShrink: 0 }} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>{s.nm}{s.blocked && <Icon name="warn" size={13} style={{ color: 'var(--red)' }} title="Blocked — expired right to work" />}</div>
                  <div style={{ fontSize: 10.5, color: 'var(--t3)', display: 'flex', alignItems: 'center', gap: 6, marginTop: 1 }}><RoleChip role={s.role} /><span style={{ fontFamily: 'var(--font-mono)' }}>{rateLbl}</span></div>
                </div>
              </div>
            </td>
            {Array.from({ length: 7 }, (_, i) => {
              const c = s.days[i]; const tcol = i === TODAY ? 'var(--inset)' : undefined;
              if (c && c.off) return <td key={i} style={{ ...td, background: tcol, textAlign: 'center' }}><span style={{ fontSize: 11, color: 'var(--t4)', fontStyle: 'italic' }}>{c.off}</span></td>;
              if (Array.isArray(c)) {
                const col = groupColor(c[2]); const hrs = hoursOf(c[0], c[1]);
                return <td key={i} style={{ ...td, padding: 4, background: tcol }}><div style={{ borderRadius: 9, padding: '6px 8px', background: cellTint(col, 13), border: `1px solid ${cellTint(col, 30)}`, borderLeft: `2.5px solid ${col}` }}><div style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, fontWeight: 700 }}>{c[0]}–{c[1]}</div><div style={{ fontSize: 10, color: 'var(--t3)' }}>{SECTIONS[c[2]] || role.lbl} · {hrs}h</div></div></td>;
              }
              return <td key={i} style={{ ...td, textAlign: 'center', background: tcol }}><button style={{ width: 26, height: 26, borderRadius: 8, border: '1px dashed var(--bdr2)', background: 'transparent', color: 'var(--t4)', cursor: 'pointer', fontSize: 15 }}>+</button></td>;
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
  const map = { bar: {}, floor: {}, kitchen: {}, door: {} };
  GROUPS.forEach(g => g.staff.forEach(s => { for (let i = 0; i < 7; i++) { const c = s.days[i]; if (Array.isArray(c) && map[c[2]]) { (map[c[2]][i] = map[c[2]][i] || []).push({ nm: s.nm.split(' ')[0] + ' ' + (s.nm.split(' ')[1] || '')[0] + '.', t: c[0] + '–' + c[1] }); } } }));
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, minWidth: 880 }}>
      <thead><tr><th style={{ ...th, minWidth: 160 }}>Section</th>{DAYS.map((d, i) => <th key={i} style={{ ...th, textAlign: 'center', color: i === TODAY ? 'var(--acc)' : 'var(--t3)' }}>{d[0]} {d[1]}</th>)}</tr></thead>
      <tbody>
        {Object.keys(map).map(sec => {
          const req = SECTION_REQ[sec]; const col = groupColor(sec);
          return (
            <tr key={sec}>
              <td style={{ ...td, borderRight: '1px solid var(--bdr)' }}><div style={{ fontWeight: 600, color: col }}>{SECTIONS[sec]}</div><div style={{ fontSize: 10.5, color: 'var(--t4)' }}>Min {req} on peak</div></td>
              {Array.from({ length: 7 }, (_, i) => {
                const ppl = map[sec][i] || []; const n = ppl.length; const ok = n >= req;
                return <td key={i} style={{ ...td, verticalAlign: 'top', padding: 6, textAlign: 'center', background: i === TODAY ? 'var(--inset)' : undefined }}>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700, color: ok ? 'var(--grn)' : 'var(--red)', marginBottom: 4 }}>{n}/{req}</div>
                  {ppl.map((p, j) => <div key={j} style={{ fontSize: 10.5, color: 'var(--t2)' }}><b style={{ fontWeight: 600 }}>{p.nm}</b> <span style={{ color: 'var(--t4)' }}>{p.t}</span></div>)}
                  {n < req && <div style={{ marginTop: 4, fontSize: 10, fontWeight: 700, color: 'var(--red)', background: 'var(--red-d)', border: '1px solid var(--red-b)', borderRadius: 6, padding: '2px 5px', display: 'inline-block' }}>Gap · need {req - n}</div>}
                </td>;
              })}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ── Timesheets ──
function WfTimesheets() {
  return (
    <Card style={{ padding: 0, overflow: 'hidden' }}>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 880 }}>
          <thead><tr>{['Staff', 'Role', 'Scheduled', 'In', 'Out', 'Sched', 'Actual', 'Variance', 'Pay', 'Status', ''].map((h, i) => <th key={i} style={{ ...th, textAlign: i >= 5 && i <= 8 ? 'right' : 'left' }}>{h}</th>)}</tr></thead>
          <tbody>
            {TIMESHEETS.map((r, idx) => {
              const role = ROLES[r.role]; const { v, cls } = tsVariance(r.act, r.sch);
              const vTxt = r.status === 'missing' ? '—' : (v >= 0 ? '+' : '') + v.toFixed(2) + 'h';
              const vCol = cls === 'over' ? 'var(--amber)' : cls === 'under' ? 'var(--red)' : 'var(--grn)';
              const pay = role.rate ? money(r.act * role.rate, 2) : '—';
              return (
                <tr key={idx}>
                  <td style={td}><b style={{ fontWeight: 600 }}>{r.nm}</b></td>
                  <td style={td}><RoleChip role={r.role} /></td>
                  <td style={td}>{r.sched}</td>
                  <td style={{ ...td, fontFamily: 'var(--font-mono)' }}>{r.inn}</td>
                  <td style={{ ...td, fontFamily: 'var(--font-mono)' }}>{r.out}</td>
                  <td style={{ ...td, textAlign: 'right' }}>{r.sch}h</td>
                  <td style={{ ...td, textAlign: 'right' }}>{r.status === 'missing' ? '—' : r.act.toFixed(2) + 'h'}</td>
                  <td style={{ ...td, textAlign: 'right', fontFamily: 'var(--font-mono)', fontWeight: 700, color: vCol }}>{vTxt}</td>
                  <td style={{ ...td, textAlign: 'right', fontFamily: 'var(--font-mono)' }}>{pay}</td>
                  <td style={td}>{r.status === 'approved' ? <Badge tone="green">Approved</Badge> : r.status === 'missing' ? <Badge tone="red">No clock-out</Badge> : <Badge tone="amber">Pending</Badge>}</td>
                  <td style={{ ...td, textAlign: 'right' }}>{r.status !== 'approved' && <button className="btn btn-acc btn-xs">Approve</button>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 9, padding: 14, borderTop: '1px solid var(--bdr)' }}>
        <button className="btn btn-ghost btn-sm">Export to payroll</button>
        <button className="btn btn-acc btn-sm">Approve all pending</button>
      </div>
    </Card>
  );
}

// ── Pay & rates ──
function WfPay() {
  return (
    <Card style={{ padding: 0, overflow: 'hidden' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr>{['Role', 'Pay type', 'Rate', 'Note', ''].map((h, i) => <th key={i} style={{ ...th, textAlign: i === 2 ? 'right' : 'left' }}>{h}</th>)}</tr></thead>
        <tbody>
          {PAYROWS.map((r, i) => (
            <tr key={i}>
              <td style={td}><span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 600, color: groupColor(r.grp) }}><span style={{ width: 7, height: 7, borderRadius: '50%', background: groupColor(r.grp) }} />{r.role}</span></td>
              <td style={{ ...td, color: 'var(--t2)' }}>{r.type}</td>
              <td style={{ ...td, textAlign: 'right', fontFamily: 'var(--font-mono)', fontWeight: 700 }}>{r.rate}</td>
              <td style={{ ...td, color: 'var(--t3)', fontSize: 12 }}>{r.note || '—'}</td>
              <td style={{ ...td, textAlign: 'right' }}><button className="btn btn-ghost btn-xs">Edit</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

// ── Tronc / tips ──
function WfTronc() {
  const { totalUnits, lines } = troncRun(TRONC_POOL, TRONC_HOURS);
  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 14, marginBottom: 16 }}>
        <Card><div className="mono" style={{ fontSize: 10, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--t3)' }}>Pool this week</div><div className="mono" style={{ fontSize: 26, fontWeight: 800, color: 'var(--acc)', marginTop: 8 }}>{money(TRONC_POOL, 2)}</div><div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 4 }}>Card tips + service charge (POS)</div></Card>
        <Card><div className="mono" style={{ fontSize: 10, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--t3)' }}>Total units</div><div className="mono" style={{ fontSize: 26, fontWeight: 800, marginTop: 8 }}>{totalUnits.toFixed(1)}</div><div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 4 }}>Σ (hours × role points)</div></Card>
        <Card><div className="mono" style={{ fontSize: 10, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--t3)' }}>Point value</div><div className="mono" style={{ fontSize: 26, fontWeight: 800, marginTop: 8 }}>{money(TRONC_POOL / totalUnits, 2)}</div><div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 4 }}>Pool ÷ total units</div></Card>
      </div>
      <Card style={{ padding: 0, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr>{['Staff', 'Role', 'Hours', 'Points', 'Units', 'Share', 'Payout'].map((h, i) => <th key={i} style={{ ...th, textAlign: i >= 2 ? 'right' : 'left' }}>{h}</th>)}</tr></thead>
          <tbody>
            {lines.map((r, i) => (
              <tr key={i}>
                <td style={td}><b style={{ fontWeight: 600 }}>{r.nm}</b></td>
                <td style={td}><RoleChip role={r.role} /></td>
                <td style={{ ...td, textAlign: 'right' }}>{r.hrs}h</td>
                <td style={{ ...td, textAlign: 'right' }}>{r.pts.toFixed(1)}×</td>
                <td style={{ ...td, textAlign: 'right', fontFamily: 'var(--font-mono)' }}>{r.units.toFixed(1)}</td>
                <td style={{ ...td, textAlign: 'right' }}>{Math.round(r.sharePct * 100)}%</td>
                <td style={{ ...td, textAlign: 'right', fontFamily: 'var(--font-mono)', fontWeight: 700 }}>{money(r.payout, 2)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot><tr><td colSpan={4} style={{ ...td, fontWeight: 700, color: 'var(--t2)' }}>Distributes the full pool</td><td style={{ ...td, textAlign: 'right', fontFamily: 'var(--font-mono)', fontWeight: 800 }}>{totalUnits.toFixed(1)}</td><td style={{ ...td, textAlign: 'right', fontWeight: 800 }}>100%</td><td style={{ ...td, textAlign: 'right', fontFamily: 'var(--font-mono)', fontWeight: 800, color: 'var(--acc)' }}>{money(TRONC_POOL, 2)}</td></tr></tfoot>
        </table>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 14, borderTop: '1px solid var(--bdr)' }}>
          <div style={{ flex: 1, fontSize: 12, color: 'var(--t3)' }}>Tipping-Act compliant · split by hours × role points · separate from wages.</div>
          <button className="btn btn-ghost btn-sm">Edit weights</button>
          <button className="btn btn-acc btn-sm">Run & export →</button>
        </div>
      </Card>
    </>
  );
}

// ── Compliance ──
function WfCompliance() {
  const tiles = [
    { k: 'Expired / missing', n: COMPLIANCE.reduce((a, p) => a + p.items.filter(i => i[1] === 'expired' || i[1] === 'missing').length, 0), tone: 'red' },
    { k: 'Expiring ≤30 days', n: COMPLIANCE.reduce((a, p) => a + p.items.filter(i => i[1] === 'expiring').length, 0), tone: 'amber' },
    { k: 'Under-18 restrictions', n: COMPLIANCE.reduce((a, p) => a + p.items.filter(i => i[1] === 'watch').length, 0), tone: 'blue' },
    { k: 'People tracked', n: COMPLIANCE.length, tone: 'green' },
  ];
  const toneCol = t => BADGE[t].fg;
  const badgeFor = s => ({ valid: ['green', 'Valid'], expiring: ['amber', 'Expiring'], expired: ['red', 'Expired'], missing: ['red', 'Missing'], watch: ['blue', 'Restriction'] }[s] || ['green', s]);
  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 14, marginBottom: 16 }}>
        {tiles.map(t => <Card key={t.k} style={{ position: 'relative', overflow: 'hidden' }}><div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, background: toneCol(t.tone) }} /><div className="mono" style={{ fontSize: 10, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--t3)' }}>{t.k}</div><div className="mono" style={{ fontSize: 28, fontWeight: 800, marginTop: 8, color: toneCol(t.tone) }}>{t.n}</div></Card>)}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 14 }}>
        {COMPLIANCE.map(p => (
          <Card key={p.nm}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
              <span style={{ width: 30, height: 30, borderRadius: '50%', background: 'var(--inset)', border: '1px solid var(--inset-border)' }} />
              <div><div style={{ fontWeight: 650 }}>{p.nm}</div><div style={{ marginTop: 1 }}><RoleChip role={p.role} /></div></div>
            </div>
            {p.items.map((it, i) => { const [tone, lbl] = badgeFor(it[1]); return (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', borderBottom: i < p.items.length - 1 ? '1px solid var(--bdr)' : 'none' }}>
                <div style={{ flex: 1, fontSize: 12.5 }}><b style={{ fontWeight: 600 }}>{it[0]}</b> <span style={{ color: 'var(--t3)' }}>{it[2]}</span></div>
                <Badge tone={tone}>{lbl}</Badge>
              </div>
            ); })}
          </Card>
        ))}
      </div>
    </>
  );
}

// ── Staff (HR list) ──
function WfStaff() {
  return (
    <Card style={{ padding: 0, overflow: 'hidden' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr>{['Name', 'Role', 'Section', 'Rate', ''].map((h, i) => <th key={i} style={{ ...th, textAlign: i === 3 ? 'right' : 'left' }}>{h}</th>)}</tr></thead>
        <tbody>
          {STAFF.map((s, i) => {
            const role = ROLES[s.role];
            const rate = role.rate ? `£${role.rate.toFixed(2)}/h` : `£${role.salary / 1000}k · salaried`;
            return (
              <tr key={i}>
                <td style={td}><div style={{ display: 'flex', alignItems: 'center', gap: 9 }}><span style={{ width: 28, height: 28, borderRadius: '50%', background: 'var(--inset)', border: '1px solid var(--inset-border)', flexShrink: 0 }} /><b style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>{s.nm}{s.blocked && <Badge tone="red">RTW</Badge>}{s.band && <span style={{ fontSize: 10, color: 'var(--t4)' }}>{s.band}</span>}</b></div></td>
                <td style={td}><RoleChip role={s.role} /></td>
                <td style={{ ...td, color: 'var(--t2)' }}>{s.section}</td>
                <td style={{ ...td, textAlign: 'right', fontFamily: 'var(--font-mono)' }}>{rate}</td>
                <td style={{ ...td, textAlign: 'right' }}><button className="btn btn-ghost btn-xs">Profile</button></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}

// ── Publish modal ──
function PublishModal({ onClose }) {
  const recipients = STAFF.filter(s => Object.values(s.days).some(d => Array.isArray(d)));
  return (
    <div className="modal-back" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal-box" style={{ maxWidth: 460 }}>
        <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 4 }}>Publish rota</div>
        <div style={{ fontSize: 13, color: 'var(--t3)', marginBottom: 14 }}>Sends each person their own shifts by SMS with a confirm link.</div>
        <div style={{ border: '1px solid var(--bdr)', borderRadius: 10, maxHeight: 200, overflowY: 'auto', marginBottom: 12 }}>
          {recipients.map((s, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '9px 12px', borderBottom: i < recipients.length - 1 ? '1px solid var(--bdr)' : 'none', fontSize: 13 }}>
              <span style={{ width: 15, height: 15, borderRadius: 4, background: s.blocked ? 'var(--red-d)' : 'var(--acc-d)', border: `1.5px solid ${s.blocked ? 'var(--red-b)' : 'var(--acc-b)'}`, flexShrink: 0 }} />
              <span style={{ flex: 1 }}>{s.nm}</span>
              {s.blocked ? <Badge tone="red">Skipped · RTW</Badge> : <span className="mono" style={{ fontSize: 11, color: 'var(--t4)' }}>+44 7700 900xxx</span>}
            </div>
          ))}
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: 'var(--t2)', marginBottom: 8 }}><input type="checkbox" /> Only text staff whose shifts changed</label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: 'var(--t2)', marginBottom: 16 }}><input type="checkbox" defaultChecked /> Skip compliance-blocked staff</label>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 9 }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-acc" onClick={onClose}>Publish & send SMS</button>
        </div>
      </div>
    </div>
  );
}

function WfPlaceholder({ title }) {
  return (
    <Card style={{ textAlign: 'center', padding: 40, maxWidth: 640, margin: '0 auto' }}>
      <div style={{ width: 52, height: 52, borderRadius: 14, margin: '0 auto 14px', background: 'var(--acc-d)', border: '1px solid var(--acc-b)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--acc)' }}><Icon name="sparkle" size={24} /></div>
      <div style={{ fontSize: 18, fontWeight: 700 }}>{title}</div>
      <div style={{ fontSize: 13, color: 'var(--t3)', marginTop: 8, lineHeight: 1.6 }}>This Workforce screen is in the build queue. The foundation (venue scope, seed group, labour engine), Rota, Timesheets, Pay, Tronc, Compliance and Staff are live — {title} ships next, wired to the same engine.</div>
    </Card>
  );
}
