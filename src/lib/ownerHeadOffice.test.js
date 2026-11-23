// ownerHeadOffice.test.js: the Owner app's Head office card (18 Nov 2026, slice 5): the figures,
// the currency rule, who sees the check ins, and the wiring into the Owner surface.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import {
  hqSites, pickOrg, newestBySite, rankedRows, byCurrency, primeTile, cashTile, unbankedWords, projectsView, checkinsView, hiresView, pctWords, buildOwnerHq,
} from './ownerHeadOffice.js';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(here, rel), 'utf8');
const LONG_DASHES = new RegExp('[\\u2013\\u2014]');

const venue = (id, name, currency, net, labour, gp) => ({
  ops_location_id: id, name, currency,
  today: { net_sales: net, labour },
  period_totals: { net_sales: net * 5, labour: labour * 5 },
  stock: gp === null ? null : { gp_pct_actual: gp },
});
const snapshot = {
  locations: [
    venue('a', 'Provo', 'USD', 1000, 300, 70),     // COGS 30 + labour 30 = 60
    venue('b', 'Sandy', 'USD', 2000, 500, 65),     // COGS 35 + labour 25 = 60 (more sales, ranks first among equals)
    venue('c', 'Leeds', 'GBP', 800, 320, 72),      // COGS 28 + labour 40 = 68
    venue('d', 'Hull', 'GBP', 0, 0, null),         // nothing on the till
  ],
};
const targets = [{ metric: 'prime_cost_pct', location_id: null, green_to: 60, amber_to: 65 }, { metric: 'unbanked_days', location_id: null, green_to: 2, amber_to: 4 }];

test('hqSites and pickOrg: the snapshot venues keyed by ops_location_id, the company most sites are in', () => {
  assert.deepEqual(hqSites(snapshot).map((s) => s.id), ['a', 'b', 'c', 'd']);
  assert.deepEqual(hqSites(null), []);
  assert.equal(pickOrg({ a: 'org1', b: 'org1', c: 'org2' }), 'org1');
  assert.equal(pickOrg({}), null);
  assert.equal(pickOrg({ a: null }), null);
});

test('rankedRows: the till wins, typed fills, the colour is the band, ranked lowest prime cost first', () => {
  const daily = [{ location_id: 'd', business_date: '2026-11-18', net_sales: 500, cogs: 150, labour: 200, hires_needed: 2 }];
  const rows = rankedRows({ sites: hqSites(snapshot), venues: snapshot.locations, daily, targets, period: 'today' });
  assert.deepEqual(rows.map((r) => [r.name, r.prime, r.rank, r.tone]), [
    ['Sandy', 60, 1, 'grn'], ['Provo', 60, 2, 'grn'], ['Leeds', 68, 3, 'red'], ['Hull', 70, 4, 'red'],
  ]);
  assert.equal(rows[3].typed, true, 'Hull is typed');
  assert.equal(rows[0].typed, false);
  assert.equal(newestBySite(daily).get('d').hires_needed, 2);
  // This week: the period totals stand in for today's block (same ratios here, so the same prime cost).
  const week = rankedRows({ sites: hqSites(snapshot), venues: snapshot.locations, daily: [], targets, period: 'week' });
  assert.equal(week.find((r) => r.id === 'a').net, 5000);
});

test('byCurrency and primeTile: one entry per currency, never one total, with the band words', () => {
  const rows = rankedRows({ sites: hqSites(snapshot), venues: snapshot.locations, daily: [], targets });
  const groups = byCurrency(rows);
  assert.deepEqual(groups.map((g) => [g.currency, g.rows.length]), [['GBP', 2], ['USD', 2]]);
  const tile = primeTile(groups, targets);
  assert.deepEqual(tile.entries.map((e) => [e.currency, e.pct, e.tone, e.sites]), [['GBP', 68, 'red', '1 of 2 sites'], ['USD', 60, 'grn', '2 of 2 sites']]);
  assert.equal(tile.green, 'Green up to 60%');
  assert.equal(tile.any, true);
  assert.equal(primeTile(groups, []).green, 'Green up to 60%', 'the built in default band when none is set');
});

test('cashTile: the safe ledger per currency, the typed figure only where no ledger exists, unbanked days coloured', () => {
  const rows = rankedRows({ sites: hqSites(snapshot), venues: snapshot.locations, daily: [{ location_id: 'c', business_date: '2026-11-18', cash_on_hand: 900 }], targets });
  const groups = byCurrency(rows);
  const cash = {
    movements: [{ location_id: 'a', amount: 400, business_date: '2026-11-10' }, { location_id: 'a', amount: -100, business_date: '2026-11-12' }, { location_id: 'b', amount: 250, business_date: '2026-11-17' }],
    counts: [], deposits: [{ location_id: 'a', status: 'prepared', amount: 100, business_date: '2026-11-12' }],
    clocks: { a: { today: '2026-11-18' }, b: { today: '2026-11-18' } },
  };
  const tile = cashTile(groups, cash, targets, '2026-11-18');
  const usd = tile.entries.find((e) => e.currency === 'USD');
  assert.equal(usd.amount, 550); assert.equal(usd.kind, 'ledger'); assert.equal(usd.transit, 100);
  assert.equal(usd.worstDays, 6, 'Provo banked 6 days ago, Sandy started yesterday');
  assert.equal(usd.tone, 'red');
  assert.equal(usd.sites, '2 of 2 sites on the safe ledger');
  assert.equal(unbankedWords(usd), '6 days unbanked at the worst site');
  const gbp = tile.entries.find((e) => e.currency === 'GBP');
  assert.equal(gbp.amount, 900); assert.equal(gbp.kind, 'typed'); assert.equal(gbp.sites, 'Typed figures, no safe ledger yet');
  assert.equal(unbankedWords(gbp), '');
  assert.equal(cashTile(groups, null, targets, '2026-11-18').entries.find((e) => e.currency === 'USD').kind, null, 'no ledger read, no typed figure: n/a');
});

test('projectsView: open projects, the ones with a live risk first, blocked before at risk', () => {
  const projects = [
    { id: 'p1', name: 'New site', status: 'in_progress', department: 'finance', due_date: '2026-12-01' },
    { id: 'p2', name: 'Handbook', status: 'planning', department: 'hr', due_date: '2026-11-01' },
    { id: 'p3', name: 'Menu', status: 'in_progress', department: 'operations' },
    { id: 'p4', name: 'Old', status: 'done', department: 'operations' },
  ];
  const tasks = [{ id: 't1', project_id: 'p3', status: 'blocked' }, { id: 't2', project_id: 'p3', status: 'done' }];
  const v = projectsView(projects, tasks, '2026-11-18');
  assert.equal(v.open, 3);
  assert.deepEqual(v.attention.map((a) => [a.name, a.status, a.reason, a.department]), [['Menu', 'blocked', '1 task blocked', 'Operations'], ['Handbook', 'at_risk', 'Due 17 days ago', 'HR']]);
  assert.equal(v.tone, 'red'); assert.equal(v.note, '2 need attention'); assert.equal(v.more, 0);
  assert.equal(projectsView([], [], '2026-11-18').note, 'None in flight');
  assert.equal(projectsView([projects[0]], [], '2026-11-18').note, 'None at risk');
  assert.equal(projectsView(projects, tasks, '2026-11-18', 1).more, 1);
});

test('checkinsView and hiresView: this week only, the departments not in yet; hires add up over the sites that logged', () => {
  const rows = [
    { week_start: '2026-11-16', department: 'operations' }, { week_start: '2026-11-16', department: 'hr' }, { week_start: '2026-11-09', department: 'finance' },
  ];
  const v = checkinsView(rows, '2026-11-16');
  assert.equal(v.received, 2);
  assert.deepEqual(v.departmentsIn, ['Operations', 'HR']);
  assert.equal(v.note, 'Not in yet: Finance, Marketing, Store leadership');
  assert.equal(checkinsView([], '2026-11-16').note, 'None in yet this week');
  const groups = byCurrency(rankedRows({ sites: hqSites(snapshot), venues: snapshot.locations, daily: [{ location_id: 'a', business_date: '2026-11-18', hires_needed: 2 }, { location_id: 'c', business_date: '2026-11-17', hires_needed: 1 }], targets: [] }));
  assert.deepEqual(hiresView(groups), { hires: 3, note: 'Still needed, 2 sites logged it' });
  assert.equal(hiresView([]).hires, null);
  assert.equal(pctWords(61.44), '61.4%'); assert.equal(pctWords(null), null);
});

test('buildOwnerHq: an owner gets the check ins tile, a director the hires tile; nothing to show is null', () => {
  const base = { snapshot, daily: [], targets, cash: null, projects: [], tasks: [], checkins: [{ week_start: '2026-11-16', department: 'hr' }], today: '2026-11-18', weekStart: '2026-11-16' };
  const owner = buildOwnerHq({ ...base, isOwner: true });
  assert.equal(owner.checkins.received, 1);
  assert.equal(owner.mixed, true);
  assert.equal(owner.rows.length, 4);
  const director = buildOwnerHq({ ...base, isOwner: false });
  assert.equal(director.checkins, null);
  assert.equal(director.hires.hires, null);
  assert.equal(buildOwnerHq({ snapshot: { locations: [] } }), null, 'no sites, no card');
  const quiet = { locations: [{ ops_location_id: 'z', name: 'Quiet', currency: 'GBP', today: { net_sales: 0, labour: 0 } }] };
  assert.equal(buildOwnerHq({ snapshot: quiet, targets: [], isOwner: false }), null, 'a hub with no figure at all draws nothing');
});

test('the screens: the card sits between the company and the venue cards, hides without the hub, works out no percent, no long dashes', () => {
  const surface = read('../surfaces/OwnerSurface.jsx');
  const card = read('../surfaces/owner/OwnerHeadOffice.jsx');
  const lib = read('./ownerHeadOffice.js');
  const data = read('./hq/data.js');
  for (const [name, src] of Object.entries({ surface, card, lib, data })) assert.doesNotMatch(src, LONG_DASHES, `${name} has no long dashes`);
  assert.doesNotMatch(card, /\/ *100\)/, 'the card works out no percent');
  assert.ok(surface.includes("import OwnerHeadOffice from './owner/OwnerHeadOffice';"));
  const groupAt = surface.indexOf('{groups.map((g) => (');
  const hqAt = surface.indexOf('<OwnerHeadOffice snapshot={data} period={shown} reload={loads} />');
  const venuesAt = surface.indexOf('{data?.locations?.map(l => <VenueCard');
  assert.ok(groupAt > 0 && hqAt > groupAt && venuesAt > hqAt, 'company card, then Head office, then the venues');
  // a database without the hub draws nothing; a failed read keeps the last card and says so in grey
  assert.ok(card.includes("if (res?.absent) { setAbsent(true); return; }"));
  assert.ok(card.includes('if (absent || !ids) return null;'));
  assert.ok(card.includes('.catch(() => { if (live && mine === seq.current) setFail(HQ_COULD_NOT); });'));
  assert.ok(card.includes("withTimeout(fetchOwnerHq(ids.split(','), { today, pickOrg }), HQ_TIMEOUT_MS, 'Head office')"), 'the reads are raced against a timer');
  assert.ok(card.includes('<span style={{ fontSize: 11.5, color: \'var(--t4)\', fontWeight: 700, flexShrink: 0 }}>Read only</span>'));
  // the reads: the owner's inbox only for an owner, the absent rule from the hub's own tables
  assert.ok(data.includes('const checkins = owner ? await fetchCheckins(orgId, { weeks: 2 }) : ok([]);'));
  assert.ok(data.includes('if (daily.absent || projects.absent) return { data: null, error: daily.error || projects.error, absent: true, message: NOT_SET_UP };'));
  // a partly failed read keeps the last card (review, 18 Nov 2026); a snapshot that lands re reads, even inside the same minute
  assert.ok(card.includes("setGot((prev) => (res.message && prev && prev.ids === ids ? prev : { ids, reads: res.data, today }));"));
  assert.ok(card.includes('}, [ids, reload]);'));
  assert.ok(surface.includes('setLoads((n) => n + 1);'), 'every snapshot that lands bumps the counter');
  assert.ok(data.includes('].find((r) => r.error && !r.absent);'), 'every failed read is said');
  assert.ok(!data.includes('fetchCashForSites(ids),\n    fetchProjects(orgId)'), 'the phone takes the lighter cash read');
});

test('hqSites: each site once, and only the company\'s sites when the orgs are known', () => {
  const twice = { locations: [{ ops_location_id: 'a', name: 'Provo', currency: 'USD' }, { ops_location_id: 'a', name: 'Provo again' }, { ops_location_id: 'b', name: 'Leeds', currency: 'GBP' }] };
  assert.deepEqual(hqSites(twice).map((s) => s.name), ['Provo', 'Leeds']);
  assert.deepEqual(hqSites(twice, { a: 'org1', b: 'org2' }, 'org1').map((s) => s.id), ['a']);
  assert.deepEqual(hqSites(twice, { a: 'org1' }, 'org1').map((s) => s.id), ['a', 'b'], 'a site with no known company stays');
  const view = buildOwnerHq({ snapshot: twice, orgs: { a: 'org1', b: 'org2' }, orgId: 'org1', daily: [{ location_id: 'a', business_date: '2026-11-18', hires_needed: 1 }] });
  assert.equal(view.rows.length, 1);
});
