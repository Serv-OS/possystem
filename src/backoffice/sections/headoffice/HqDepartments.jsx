// src/backoffice/sections/headoffice/HqDepartments.jsx
//
// Head office, Departments: one tab per department (src/lib/hq/departments.js) with the three
// figures that department lives by and its internal projects. The figures are the scorecard's
// own rows (HqScorecard buildRows, today's period); the cards and the create sheet are the
// Internal projects screen's own, with the department preset.

import { useEffect, useMemo, useState } from 'react';
import { fetchSnapshot, fetchDailyNumbers, fetchRatings } from '../../../lib/hq/data.js';
import { portfolio, PRIME_COST_TARGET } from '../../../lib/hq/primeCost.js';
import { DEPARTMENTS } from '../../../lib/hq/departments.js';
import { buildRows } from './HqScorecard';
import HqProjectDetail from './HqProjectDetail';
import { useProjectData, buildCards, CardGrid, CreateProjectSheet } from './HqProjects';
import { page, accBtn, bigMoney, pct, num, signedPct, NA, addDays, PageHead, SectionHead, StatTile, AbsentCard, AmberLine, LoadingLine, EmptyCard, TabRow } from './hqUi';

/** The group's sales against the compared period, from the snapshot venues that have both figures. */
export function groupVsLast(venues) {
  let now = 0; let then = 0; let n = 0;
  for (const v of venues || []) {
    const c = v?.compare;
    if (!c || c.reason !== 'ok') continue;
    const a = Number(c.net_sales); const b = Number(c.cmp_net_sales);
    if (!Number.isFinite(a) || !Number.isFinite(b) || b <= 0) continue;
    now += a; then += b; n += 1;
  }
  return n && then > 0 ? Math.round(((now - then) / then) * 1000) / 10 : null;
}

/** The three tiles for a department, from the portfolio figures. */
export function tilesFor(dept, g, vsLast, currency) {
  const primeTone = g.prime === null ? null : (g.prime < PRIME_COST_TARGET ? 'grn' : 'orn');
  const prime = { label: 'Portfolio prime cost', value: pct(g.prime), tone: primeTone, note: `Target under ${PRIME_COST_TARGET}%` };
  const net = { label: 'Net sales today', value: bigMoney(g.netToday, currency), note: 'Every site, from the tills' };
  const hires = { label: 'Open hires', value: num(g.hires), note: 'Still needed' };
  const morale = { label: 'Leadership morale', value: g.morale === null ? NA : `${g.morale} / 10`, note: 'Average of the sites' };
  const turnover = { label: 'Turnover', value: pct(g.turnover, 0), note: 'Average of the sites that logged it' };
  const cash = { label: 'Cash on hand', value: bigMoney(g.cash, currency), note: 'Sites combined' };
  const vs = { label: 'Net sales vs last period', value: signedPct(vsLast), tone: vsLast === null ? null : (vsLast >= 0 ? 'grn' : 'red'), note: 'Today against the same day last week' };
  const rating = { label: 'Guest rating', value: g.rating === null ? NA : Number(g.rating).toFixed(1), note: 'Out of 5' };
  const reviews = { label: 'Reviews', value: num(g.reviews), note: 'Counted this week' };
  switch (dept) {
    case 'hr': return [morale, hires, turnover];
    case 'finance': return [cash, prime, vs];
    case 'marketing': return [rating, reviews, vs];
    case 'store_leadership': return [morale, rating, prime];
    case 'operations':
    default: return [prime, net, hires];
  }
}

export default function HqDepartments({ hq, go }) {
  const [dept, setDept] = useState(DEPARTMENTS[0].id);
  const [figures, setFigures] = useState({ loading: true, absent: false, error: null, snapMessage: null, venues: [], daily: [], ratings: {} });
  const data = useProjectData(hq.orgId);
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState(null);
  const ids = useMemo(() => hq.sites.map((s) => s.id), [hq.sites]);

  useEffect(() => {
    let live = true;
    Promise.all([fetchSnapshot('today'), fetchDailyNumbers(ids, addDays(hq.today, -14), hq.today), fetchRatings(ids, 7)]).then(([snap, daily, ratings]) => {
      if (!live) return;
      if (daily.absent) { setFigures((s) => ({ ...s, loading: false, absent: true })); return; }
      setFigures({ loading: false, absent: false, error: daily.error ? daily.message : null, snapMessage: snap.error ? snap.message : null, venues: snap.data?.venues || [], daily: daily.data || [], ratings: ratings.data || {} });
    });
    return () => { live = false; };
  }, [ids, hq.today]);

  const rows = useMemo(() => buildRows({ sites: hq.sites, venues: figures.venues, dailyRows: figures.daily, ratings: figures.ratings, period: 'today', currency: hq.currency }), [hq.sites, hq.currency, figures]);
  const group = useMemo(() => portfolio(rows), [rows]);
  const vsLast = useMemo(() => groupVsLast(figures.venues), [figures.venues]);
  const cards = useMemo(() => buildCards(data.projects, data.tasks, data.updates, hq.today), [data.projects, data.tasks, data.updates, hq.today]);
  const mine = cards.filter((c) => c.department === dept);
  const info = DEPARTMENTS.find((d) => d.id === dept) || DEPARTMENTS[0];

  if (figures.absent || data.absent) {
    return (
      <div style={page}>
        <PageHead title="Departments" sub="Each department's figures and the projects it is running." />
        <AbsentCard message="Ask ServOS to run migration 20261130a." />
      </div>
    );
  }

  const open = openId ? data.projects.find((p) => p.id === openId) : null;
  if (open) {
    return <HqProjectDetail hq={hq} project={open} tasks={data.tasks.filter((t) => t.project_id === open.id)} updates={data.updates.filter((u) => u.project_id === open.id)} onBack={() => setOpenId(null)} reload={data.reload} />;
  }

  return (
    <div style={page}>
      <PageHead title="Departments" sub="Each department's figures and the projects it is running." />
      <TabRow tabs={DEPARTMENTS.map((d) => [d.id, d.label])} value={dept} onChange={setDept} style={{ marginBottom: 14 }} />
      <div style={{ fontSize: 13, color: 'var(--t3)', marginBottom: 14 }}>{info.blurb}</div>
      {(figures.loading || data.loading) && <LoadingLine>Loading</LoadingLine>}
      <AmberLine>{figures.error}</AmberLine>
      <AmberLine>{figures.snapMessage}</AmberLine>
      <AmberLine>{data.error}</AmberLine>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
        {tilesFor(dept, group, vsLast, hq.currency).map((t) => <StatTile key={t.label} {...t} />)}
      </div>

      <SectionHead title="Internal projects" sub={`${mine.length} in ${info.label}`} right={<button type="button" style={accBtn} onClick={() => setCreating(true)}>New project</button>} />
      {!data.loading && !mine.length && (
        <EmptyCard title={`No ${info.label} projects yet`} body="Start one and it shows here and on the Internal projects screen.">
          <button type="button" style={accBtn} onClick={() => setCreating(true)}>New project</button>
        </EmptyCard>
      )}
      <CardGrid cards={mine} sites={hq.sites} currency={hq.currency} onOpen={(c) => setOpenId(c.id)} />
      <div style={{ marginTop: 14, fontSize: 12.5 }}>
        <button type="button" onClick={() => go('hq-projects')} style={{ background: 'none', border: 0, padding: 0, color: 'var(--acc)', cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600 }}>Every department's projects</button>
      </div>

      {creating && <CreateProjectSheet hq={hq} department={dept} onClose={() => setCreating(false)} onSaved={(p) => { setCreating(false); data.reload(); if (p?.id) setOpenId(p.id); }} />}
    </div>
  );
}
