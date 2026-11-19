// src/lib/ownerHeadOffice.js: the Owner app's Head office card, the part that is not drawing.
//
// 18 Nov 2026 (Head office, slice 5: "Owner app read only tiles"). The phone app gets one card
// between the company card and the venue cards with the head office figures the Back Office
// Scorecard shows: the portfolio's prime cost, the cash in the safes, the internal projects in
// flight and at risk, and the week's check ins for an owner. Under the tiles, the sites ranked by
// prime cost and the projects that need attention. Read only: nothing on the phone writes.
//
// THE RULES THIS FILE KEEPS
//   * The arithmetic is the Scorecard's own (src/lib/hq/primeCost.js, targets.js, safeLedger.js,
//     projectRollup.js): the till wins, a typed figure fills, nothing is guessed, and the colours
//     are the company's own bands (a site override wins).
//   * CURRENCIES ARE NEVER ADDED TOGETHER (Peter, 5 Oct 2026): a login with pound and dollar
//     venues gets one prime cost line and one cash line per currency, never one total.
//   * A DATABASE WITHOUT THE HUB (migration 20261130a not run) draws nothing at all: the card
//     appears by itself once the hub is set up, the way the Stock line does.
//   * Check ins are the owner's alone: the tile shows for a company owner (the database's own
//     answer, hq_is_company_owner) and everyone else sees the open hires tile in its place.
//   * No em or en dash anywhere; money stays in the venue's own currency and is formatted by the
//     screen (src/surfaces/owner/style.js money), never here.
//
// PURE: node:test loads it (src/lib/ownerHeadOffice.test.js).

import { siteRow, rankSites, portfolio } from './hq/primeCost.js';
import { resolveTargets, ragOf, bandWords } from './hq/targets.js';
import { cashSummary } from './hq/safeLedger.js';
import { projectCard } from './hq/projectRollup.js';
import { OPEN_PROJECT_STATUSES, DEPARTMENTS, departmentLabel } from './hq/departments.js';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * The sites the card ranks: the snapshot's own venues, keyed the way every hq_ row is (ops_location_id),
 * each once. With orgs ({ siteId: orgId }) and an orgId, only that company's sites (the Back Office
 * hub's rule), so a ServOS super admin spanning companies never sees one company's sites coloured
 * by another's bands.
 */
export function hqSites(snapshot, orgs = null, orgId = null) {
  const list = Array.isArray(snapshot?.locations) ? snapshot.locations : [];
  const out = new Map();
  for (const l of list) {
    if (!l?.ops_location_id || out.has(l.ops_location_id)) continue;
    if (orgId && orgs && orgs[l.ops_location_id] && orgs[l.ops_location_id] !== orgId) continue;
    out.set(l.ops_location_id, { id: l.ops_location_id, name: l.name || 'Venue', currency: l.currency || null });
  }
  return [...out.values()];
}

/** The company the hub works in: the one most of the sites belong to ({ siteId: orgId }), or null. */
export function pickOrg(orgById) {
  const counts = new Map();
  for (const org of Object.values(orgById || {})) if (org) counts.set(org, (counts.get(org) || 0) + 1);
  let best = null; let n = 0;
  for (const [org, c] of counts) if (c > n) { best = org; n = c; }
  return best;
}

/** The newest hq_daily_numbers row per site. */
export function newestBySite(rows) {
  const m = new Map();
  for (const r of rows || []) if (r?.location_id && !m.has(r.location_id)) m.set(r.location_id, r);
  return m;
}

/** For This week and This month the venue's period totals stand where its today block stands (the Scorecard's rule). */
export function venueForPeriod(venue, period) {
  if (!venue || period === 'today' || !venue.period_totals) return venue;
  return { ...venue, today: { ...venue.today, net_sales: venue.period_totals.net_sales, labour: venue.period_totals.labour } };
}

/**
 * The sites ranked by prime cost, coloured by the company's bands, for the period on the chips.
 * venues: the snapshot's locations; daily: hq_daily_numbers rows (newest first); targets: hq_targets rows.
 */
export function rankedRows({ sites, venues, daily, targets, period = 'today' }) {
  const latest = newestBySite(daily);
  const byId = new Map((venues || []).filter((v) => v?.ops_location_id).map((v) => [v.ops_location_id, v]));
  return rankSites((sites || []).map((s) => {
    const venue = venueForPeriod(byId.get(s.id) || null, period);
    const row = siteRow({ id: s.id, name: s.name, currency: s.currency, venue, typed: latest.get(s.id) || null });
    const band = resolveTargets(targets || [], s.id);
    row.band = band;
    row.tone = ragOf('prime_cost_pct', row.prime, band.prime_cost_pct);
    row.cogsTone = ragOf('cogs_pct', row.cogsPct, band.cogs_pct);
    row.labourTone = ragOf('labour_pct', row.labourPct, band.labour_pct);
    row.typed = ['net', 'cogs', 'labour'].some((k) => row.from[k] === 'typed' || row.from[k] === 'csv');
    return row;
  }));
}

/** Rows grouped by currency, each group with its own portfolio figures; the currencies in order. */
export function byCurrency(rows) {
  const groups = new Map();
  for (const r of rows || []) {
    const cur = r.currency || '';
    if (!groups.has(cur)) groups.set(cur, []);
    groups.get(cur).push(r);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([currency, list]) => ({ currency: currency || null, rows: list, group: portfolio(list) }));
}

/**
 * The Prime cost tile: one entry per currency { currency, pct, tone, sites: 'n of m sites' }, and the
 * company band's words ('up to 60%') or null when no band is set.
 */
export function primeTile(groups, targets) {
  const band = resolveTargets(targets || [], null);
  const words = bandWords('prime_cost_pct', band.prime_cost_pct, (n) => `${n}%`);
  const entries = (groups || []).map((g) => ({
    currency: g.currency,
    pct: isNum(g.group.prime) ? g.group.prime : null,
    tone: ragOf('prime_cost_pct', g.group.prime, band.prime_cost_pct),
    sites: `${g.group.primeSites} of ${g.rows.length} site${g.rows.length === 1 ? '' : 's'}`,
  }));
  return { entries, green: words ? `Green ${words.grn}` : 'No target set', any: entries.some((e) => e.pct !== null) };
}

/**
 * The Cash in safes tile: one entry per currency from the safe ledger (the typed cash on hand only
 * at a currency with no ledger yet). cash is fetchCashForSites' data; today the business day for
 * each site comes from its clock, else the phone's date.
 */
export function cashTile(groups, cash, targets, today) {
  const band = resolveTargets(targets || [], null);
  const bySite = (rows, id) => (rows || []).filter((r) => r?.location_id === id);
  const entries = (groups || []).map((g) => {
    let safes = 0; let sites = 0; let transit = 0; let worst = null;
    for (const r of g.rows) {
      if (!cash) continue;
      const day = cash.clocks?.[r.id]?.today || today || null;
      const s = cashSummary({ movements: bySite(cash.movements, r.id), counts: bySite(cash.counts, r.id), deposits: bySite(cash.deposits, r.id), today: day });
      transit += s.inTransit || 0;
      if (s.used) {
        safes += s.balance || 0; sites += 1;
        if (s.unbankedDays !== null && (worst === null || s.unbankedDays > worst)) worst = s.unbankedDays;
      }
    }
    const typed = g.group.cash;
    return {
      currency: g.currency,
      amount: sites ? Math.round(safes * 100) / 100 : (isNum(typed) ? typed : null),
      kind: sites ? 'ledger' : (isNum(typed) ? 'typed' : null),
      sites: sites ? `${sites} of ${g.rows.length} site${g.rows.length === 1 ? '' : 's'} on the safe ledger` : (isNum(typed) ? 'Typed figures, no safe ledger yet' : 'No safe ledger yet'),
      transit: Math.round(transit * 100) / 100,
      worstDays: worst,
      tone: ragOf('unbanked_days', worst, band.unbanked_days),
    };
  });
  return { entries, any: entries.some((e) => e.amount !== null || e.transit > 0) };
}

/** 'Worst site 3 days unbanked' or 'Nothing waiting to bank' words for a cash entry (the money is the screen's). */
export function unbankedWords(entry) {
  if (!entry) return '';
  if (entry.worstDays === null || entry.worstDays === undefined) return entry.transit > 0 ? 'waiting to bank' : '';
  return `${entry.worstDays} day${entry.worstDays === 1 ? '' : 's'} unbanked at the worst site`;
}

/**
 * The Projects tile and the attention list: the open projects (planning, in progress, at risk,
 * blocked) and those with a live risk (the project rollup's rule), worst first, at most `limit`.
 */
export function projectsView(projects, tasks, today, limit = 3) {
  const byProject = new Map();
  for (const t of tasks || []) { if (!byProject.has(t.project_id)) byProject.set(t.project_id, []); byProject.get(t.project_id).push(t); }
  const open = (projects || []).filter((p) => OPEN_PROJECT_STATUSES.includes(p?.status));
  const cards = open.map((p) => projectCard(p, byProject.get(p.id) || [], [], today));
  const rank = { blocked: 0, at_risk: 1 };
  const attention = cards
    .filter((c) => c.shownStatus === 'blocked' || c.shownStatus === 'at_risk')
    .sort((a, b) => (rank[a.shownStatus] ?? 2) - (rank[b.shownStatus] ?? 2) || String(a.due_date || '9999').localeCompare(String(b.due_date || '9999')))
    .map((c) => ({
      id: c.id, name: c.name || 'Project', status: c.shownStatus, department: departmentLabel(c.department),
      reason: c.risk?.reason || (c.shownStatus === 'blocked' ? 'Marked blocked' : 'Marked at risk'),
      pct: c.progress?.pct ?? 0,
    }));
  const blocked = attention.filter((a) => a.status === 'blocked').length;
  return {
    open: open.length,
    atRisk: attention.length,
    blocked,
    tone: blocked ? 'red' : (attention.length ? 'orn' : (open.length ? 'grn' : null)),
    note: !open.length ? 'None in flight' : (attention.length ? `${attention.length} need${attention.length === 1 ? 's' : ''} attention` : 'None at risk'),
    attention: attention.slice(0, limit),
    more: Math.max(0, attention.length - limit),
  };
}

/**
 * The owner's Check ins tile for the week that started on weekStart: how many came in and which
 * departments have not written one yet (company wide, any site).
 */
export function checkinsView(rows, weekStart) {
  const week = (rows || []).filter((r) => r?.week_start === weekStart);
  const seen = new Set(week.map((r) => r.department).filter(Boolean));
  const missing = DEPARTMENTS.filter((d) => !seen.has(d.id)).map((d) => d.label);
  return {
    received: week.length,
    departmentsIn: DEPARTMENTS.filter((d) => seen.has(d.id)).map((d) => d.label),
    missing,
    note: !week.length ? 'None in yet this week' : (missing.length ? `Not in yet: ${missing.join(', ')}` : 'Every department is in'),
  };
}

/** The open hires tile (a typed figure on Daily numbers, never from the system: Peter, 18 Nov 2026). */
export function hiresView(groups) {
  let total = null; let sites = 0;
  for (const g of groups || []) for (const r of g.rows) if (isNum(r.hires)) { total = (total || 0) + r.hires; sites += 1; }
  return { hires: total, note: total === null ? 'Not logged on Daily numbers' : `Still needed, ${sites} site${sites === 1 ? '' : 's'} logged it` };
}

/** '61.4%' or null (the screen then says so, never 0%). */
export function pctWords(v) {
  if (!isNum(v)) return null;
  return `${(Math.round(v * 10) / 10).toFixed(1)}%`;
}

/**
 * Everything the card draws, from one set of reads. Returns null when there is nothing worth a
 * card: no sites, or a hub with no figures at all (no bands, no money, no projects, no check ins).
 */
export function buildOwnerHq({ snapshot, orgs = null, orgId = null, daily = [], targets = [], cash = null, projects = [], tasks = [], checkins = [], isOwner = false, period = 'today', today = null, weekStart = null } = {}) {
  const sites = hqSites(snapshot, orgs, orgId);
  if (!sites.length) return null;
  const rows = rankedRows({ sites, venues: snapshot?.locations, daily, targets, period });
  const groups = byCurrency(rows);
  const prime = primeTile(groups, targets);
  const money = cashTile(groups, cash, targets, today);
  const proj = projectsView(projects, tasks, today);
  const hires = hiresView(groups);
  const week = isOwner ? checkinsView(checkins, weekStart) : null;
  const anything = prime.any || money.any || proj.open > 0 || hires.hires !== null || (week && week.received > 0);
  if (!anything) return null;
  return { sites, rows, groups, prime, cash: money, projects: proj, hires, checkins: week, mixed: groups.length > 1 };
}
