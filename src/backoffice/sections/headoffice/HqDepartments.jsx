// src/backoffice/sections/headoffice/HqDepartments.jsx
//
// Head office, Departments: one tab per department (src/lib/hq/departments.js) with the three
// figures that department lives by and its internal projects. The figures are the scorecard's
// own rows (HqScorecard buildRows, today's period); the cards and the create sheet are the
// Internal projects screen's own, with the department preset.
//
// Slice 2 (20261201a): Operations shows the week's missed opening and closing checks, failed temps
// and urgent repairs per site (src/lib/hq/opsStats.js); Finance shows the safes (src/lib/hq/safeLedger.js);
// every tile that has a metric is coloured by the company's targets (src/lib/hq/targets.js).

import { useEffect, useMemo, useState } from 'react';
import { fetchSnapshot, fetchDailyNumbers, fetchRatings, fetchTargets, fetchCashForSites, fetchOpsRows, NOT_SET_UP_2 } from '../../../lib/hq/data.js';
import { portfolio } from '../../../lib/hq/primeCost.js';
import { DEPARTMENTS } from '../../../lib/hq/departments.js';
import { resolveTargets, ragOf, bandWords } from '../../../lib/hq/targets.js';
import { checksWords } from '../../../lib/hq/opsStats.js';
import { weekStartIso } from '../../../lib/hq/checkinWeek.js';
import { buildRows, buildExtras, portfolioExtras } from './HqScorecard';
import HqProjectDetail from './HqProjectDetail';
import { useProjectData, buildCards, CardGrid, CreateProjectSheet } from './HqProjects';
import { page, card, mono, accBtn, linkBtn, th, td, toneColor, bigMoney, exactMoney, pct, num, signedPct, NA, addDays, PageHead, SectionHead, StatTile, AbsentCard, AmberLine, LoadingLine, EmptyCard, TabRow, hqHandoff } from './hqUi';

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

/**
 * The tiles for a department, from the portfolio figures (g), the slice 2 figures (more, from
 * portfolioExtras) and the company's bands (band, from resolveTargets). Each tile with a metric is
 * coloured by ragOf; a tile without one stays plain.
 */
export function tilesFor(dept, g, vsLast, currency, more = null, band = {}) {
  const primeWords = bandWords('prime_cost_pct', band.prime_cost_pct, (n) => `${n}%`);
  const prime = { label: 'Portfolio prime cost', value: pct(g.prime), tone: ragOf('prime_cost_pct', g.prime, band.prime_cost_pct), note: primeWords ? `Green ${primeWords.grn}` : 'No target set' };
  const hires = { label: 'Open hires', value: num(g.hires), note: 'Still needed' };
  const morale = { label: 'Leadership morale', value: g.morale === null ? NA : `${g.morale} / 10`, tone: ragOf('morale_score', g.morale, band.morale_score), note: 'Average of the sites' };
  const turnover = { label: 'Turnover', value: pct(g.turnover, 0), note: 'Average of the sites that logged it' };
  const vs = { label: 'Net sales vs last period', value: signedPct(vsLast), tone: vsLast === null ? null : (vsLast >= 0 ? 'grn' : 'red'), note: 'Today against the same day last week' };
  const rating = { label: 'Guest rating', value: g.rating === null ? NA : Number(g.rating).toFixed(1), tone: ragOf('review_rating', g.rating, band.review_rating), note: 'Out of 5' };
  const reviews = { label: 'Reviews', value: num(g.reviews), note: 'Counted this week' };
  // Slice 2
  const hasOps = !!more?.hasOps;
  const safes = { label: 'Cash in safes', value: more?.safeSites ? bigMoney(more.safes, currency) : NA, note: more?.safeSites ? `${more.safeSites} site${more.safeSites === 1 ? '' : 's'} on the safe ledger` : 'No safe ledger yet' };
  const transit = { label: 'In transit to bank', value: more ? bigMoney(more.transit, currency) : NA, tone: ragOf('unbanked_days', more?.worstDays, band.unbanked_days), note: more?.worstDays === null || more?.worstDays === undefined ? 'Prepared or banked, not yet confirmed' : `Worst site: ${more.worstDays} day${more.worstDays === 1 ? '' : 's'} unbanked` };
  const variance = { label: 'Last count variance', value: more?.worstVariance === null || more?.worstVariance === undefined ? NA : exactMoney(more.worstVariance, currency, 2), tone: more?.worstVariance === null || more?.worstVariance === undefined ? null : (more.worstVariance === 0 ? 'grn' : ragOf('safe_variance', more.worstVariance, band.safe_variance)), note: 'The biggest, either way, across the sites' };
  const missedOpen = { label: 'Missed opening checks', value: hasOps ? num(more.missedOpening) : NA, tone: !hasOps ? null : (more.missedOpening ? 'red' : 'grn'), note: 'This week, every site' };
  const missedClose = { label: 'Missed closing checks', value: hasOps ? num(more.missedClosing) : NA, tone: !hasOps ? null : (more.missedClosing ? 'red' : 'grn'), note: 'This week, every site' };
  const failed = { label: 'Failed temps', value: hasOps ? num(more.failed) : NA, tone: !hasOps ? null : (more.critical ? 'red' : (more.failed ? 'orn' : 'grn')), note: hasOps ? `${num(more.critical)} critical this week` : 'No temperature readings found' };
  const urgent = { label: 'Urgent repairs', value: hasOps ? num(more.urgent) : NA, tone: !hasOps ? null : (more.urgent ? 'red' : 'grn'), note: 'Open, high or urgent priority' };
  switch (dept) {
    case 'hr': return [morale, hires, turnover];
    case 'finance': return [safes, transit, variance, prime];
    case 'marketing': return [rating, reviews, vs];
    case 'store_leadership': return [morale, rating, prime];
    case 'operations':
    default: return [missedOpen, missedClose, failed, urgent, prime];
  }
}

/** The week's Operations figures and the safes, summed across the sites, on top of portfolioExtras. */
export function departmentExtras(extras) {
  const t = { ...portfolioExtras(extras), missedOpening: 0, missedClosing: 0, urgent: 0, worstVariance: null };
  for (const x of Object.values(extras || {})) {
    if (x?.week) { t.missedOpening += x.week.checklists.opening.missed; t.missedClosing += x.week.checklists.closing.missed; t.urgent += x.week.maintenance.urgent; }
    const v = x?.cash?.lastVariance;
    if (v !== null && v !== undefined && (t.worstVariance === null || Math.abs(v) > t.worstVariance)) t.worstVariance = Math.abs(v);
  }
  return t;
}

export default function HqDepartments({ hq, go }) {
  const [dept, setDept] = useState(DEPARTMENTS[0].id);
  const [figures, setFigures] = useState({ loading: true, absent: false, error: null, snapMessage: null, slice2Message: null, venues: [], daily: [], ratings: {}, targets: [], cash: null, ops: null });
  const data = useProjectData(hq.orgId);
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState(null);
  const ids = useMemo(() => hq.sites.map((s) => s.id), [hq.sites]);

  useEffect(() => {
    let live = true;
    Promise.all([
      fetchSnapshot('today'), fetchDailyNumbers(ids, addDays(hq.today, -14), hq.today), fetchRatings(ids, 7),
      fetchTargets(hq.orgId), fetchCashForSites(ids), fetchOpsRows(ids, weekStartIso(hq.today), hq.today),
    ]).then(([snap, daily, ratings, targets, cash, ops]) => {
      if (!live) return;
      if (daily.absent) { setFigures((s) => ({ ...s, loading: false, absent: true })); return; }
      // Slice 2 tables missing is not the end of the screen: one amber line and the old figures.
      const slice2Absent = !!(targets.absent || cash.absent);
      setFigures({
        loading: false, absent: false, error: daily.error ? daily.message : null, snapMessage: snap.error ? snap.message : null,
        slice2Message: slice2Absent ? NOT_SET_UP_2 : (targets.error ? targets.message : (cash.error ? cash.message : null)),
        venues: snap.data?.venues || [], daily: daily.data || [], ratings: ratings.data || {},
        targets: slice2Absent ? [] : (targets.data || []), cash: slice2Absent ? null : (cash.data || null), ops: ops.data || null,
      });
    });
    return () => { live = false; };
  }, [ids, hq.today, hq.orgId]);

  const rows = useMemo(() => buildRows({ sites: hq.sites, venues: figures.venues, dailyRows: figures.daily, ratings: figures.ratings, period: 'today', currency: hq.currency, targets: figures.targets }), [hq.sites, hq.currency, figures]);
  const group = useMemo(() => portfolio(rows), [rows]);
  const extras = useMemo(() => buildExtras({ sites: hq.sites, cash: figures.cash, ops: figures.ops, today: hq.today }), [hq.sites, figures.cash, figures.ops, hq.today]);
  const more = useMemo(() => departmentExtras(extras), [extras]);
  const band = useMemo(() => resolveTargets(figures.targets, null), [figures.targets]);
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
      <AmberLine>{figures.slice2Message}</AmberLine>
      <AmberLine>{data.error}</AmberLine>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
        {tilesFor(dept, group, vsLast, hq.currency, more, band).map((t) => <StatTile key={t.label} {...t} />)}
      </div>
      {dept === 'operations' && <OpsBySite hq={hq} extras={extras} targets={figures.targets} go={go} />}
      {dept === 'finance' && (
        <div style={{ marginTop: 10, fontSize: 12.5 }}>
          <button type="button" onClick={() => go('hq-safe')} style={linkBtn}>Open Safe and banking</button>
        </div>
      )}

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

      {creating && <CreateProjectSheet hq={hq} department={dept} onClose={() => setCreating(false)} onSaved={(p, note) => { setCreating(false); data.reload(); if (note) hqHandoff.notice = note; if (p?.id) setOpenId(p.id); }} />}
    </div>
  );
}

/** Operations per site this week: checks done, missed, failed temps, urgent repairs. */
function OpsBySite({ hq, extras, targets, go }) {
  const rows = hq.sites.map((s) => ({ site: s, w: extras[s.id]?.week || null, band: resolveTargets(targets, s.id) }));
  const any = rows.some((r) => extras[r.site.id]?.hasRows);
  return (
    <>
      <SectionHead title="Operations by site" sub="This week so far: checklists and temperature windows done on time, what was missed, failed temps and open urgent repairs."
        right={<button type="button" onClick={() => go('hq-scorecard')} style={linkBtn}>See the scorecard</button>} />
      <div style={{ ...card, padding: 0, overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}>
          <thead><tr><th style={th}>Site</th><th style={th}>Checks</th><th style={th}>Missed</th><th style={th}>Failed temps</th><th style={th}>Urgent repairs</th><th style={th}>Words</th></tr></thead>
          <tbody>
            {rows.map(({ site, w, band }) => {
              const missed = w ? w.checklists.all.missed + w.temps.windows.missed : null;
              const tone = w ? ragOf('checks_pct', w.checksPct, band.checks_pct) : null;
              return (
                <tr key={site.id}>
                  <td style={{ ...td, fontWeight: 600 }}>{site.name}</td>
                  <td style={{ ...td, ...mono, fontWeight: 700, color: tone ? toneColor(tone) : 'var(--t4)' }}>{w && w.checksPct !== null ? pct(w.checksPct, 0) : NA}</td>
                  <td style={{ ...td, ...mono, color: missed ? 'var(--red)' : 'var(--t2)' }}>{w ? num(missed) : NA}</td>
                  <td style={{ ...td, ...mono, color: w?.temps.failed.critical ? 'var(--red)' : (w?.temps.failed.count ? 'var(--orn)' : 'var(--t2)') }}>{w ? `${num(w.temps.failed.count)}${w.temps.failed.critical ? ` (${num(w.temps.failed.critical)} critical)` : ''}` : NA}</td>
                  <td style={{ ...td, ...mono, color: w?.maintenance.urgent ? 'var(--red)' : 'var(--t2)' }}>{w ? num(w.maintenance.urgent) : NA}</td>
                  <td style={{ ...td, color: 'var(--t3)', fontSize: 12 }}>{w ? checksWords(w) : 'No Operations rows'}</td>
                </tr>
              );
            })}
            {!rows.length && <tr><td style={{ ...td, color: 'var(--t3)' }} colSpan={6}>No sites yet.</td></tr>}
          </tbody>
        </table>
      </div>
      {!any && <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 6 }}>No checklists or temperature schedules were found for these sites in the Operations module.</div>}
    </>
  );
}
