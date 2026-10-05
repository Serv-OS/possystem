/**
 * reportScope.test.js — which sites a Back Office report is looking at.
 * Run: `npm test`, or `node --test src/lib/reportScope.test.js`.
 *
 * Peter, 5 Oct 2026: "make every report we have multi site when sites are connected
 * together, and you can filter them down to just one site."
 *
 * Pinned:
 *   1. Connected = same company AND readable. A Coffee Boy owner sees all 6; a login that
 *      holds sites in two companies never has them mixed; a super admin (who can read every
 *      site) still gets only the signed in site's company.
 *   2. Could not ask what is readable = the signed in site alone. Never wider on a guess.
 *   3. It starts on the signed in site and remembers the last choice per login and company;
 *      a remembered site that has gone is dropped.
 *   4. A one site login has no choice (the control hides).
 *   5. Currencies: one combined total only when every ticked site shares one known currency.
 *   6. Every site on its own clock and business day: 06:30 and 00:00 venues, a US venue.
 *   7. One ticked site gets the very range the shell built: nothing about it changes.
 *   8. A report that is not multi site ready shows one site with a note, never mixed rows.
 *   9. Item reports across several sites stop at 7 days.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  connectedSites, buildReportScope, choiceKey, readSiteChoice, writeSiteChoice, resolveTicked, toggleTicked, choiceFor,
  isMulti, currenciesInScope, canShowCombinedTotal, sitesLabel, sitesForView, siteModeFor, siteRange, rangeDayCount,
  itemCapLine, figuresFrom, totalsByCurrency, groupCompare, REPORT_SITE_MODE, ITEM_CAP_TEXT,
} from './reportScope.js';
import { getPeriodRange, venueRange } from '../backoffice/sections/reports/_filters.js';

const CB = 'org-coffee-boy', WING = 'org-wing-fest', CABIN = 'org-cabin';
const LOCS = [
  { id: 'leeds',   name: 'Coffee Boy Leeds',                    org_id: CB, currency: 'GBP' },
  { id: 'hudds',   name: 'Coffee Boy Huddersfield',             org_id: CB, currency: 'GBP' },
  { id: 'head',    name: 'Coffee Boy   Headingley',             org_id: CB, currency: 'GBP' },
  { id: 'barns',   name: 'Coffee Boy Barnsley',                 org_id: CB, currency: 'GBP' },
  { id: 'station', name: 'Coffee Boy  Barnsley Train Station',  org_id: CB, currency: 'GBP' },
  { id: 'preston', name: 'Coffee Boy  Preston',                 org_id: CB, currency: 'GBP' },
  { id: 'brum',    name: 'Birmingham',                          org_id: WING, currency: 'GBP' },
  { id: 'cabin',   name: 'The Cabin',                           org_id: CABIN, currency: 'USD' },
];
const SIX = ['leeds', 'hudds', 'head', 'barns', 'station', 'preston'];
const CLOCKS = {
  hudds:   { timezone: 'Europe/London', businessDayStart: '06:30', shifts: [] },
  head:    { timezone: 'Europe/London', businessDayStart: '06:30', shifts: [] },
  barns:   { timezone: 'Europe/London', businessDayStart: '06:30', shifts: [] },
  station: { timezone: 'Europe/London', businessDayStart: '00:00', shifts: [] },
  preston: { timezone: 'Europe/London', businessDayStart: '06:30', shifts: [] },
  cabin:   { timezone: 'America/New_York', businessDayStart: '06:00', shifts: [], currency: 'USD' },
};
const LEEDS_CFG = { timezone: 'Europe/London', businessDayStart: '06:30', shifts: [{ id: 'lunch', name: 'Lunch', start: '11:00', end: '15:00' }], currency: 'GBP' };
const at = (iso) => Date.parse(iso);
const ids = (sites) => sites.map((s) => String(s.id)).sort();
const scopeOf = (over = {}) => buildReportScope({ homeId: 'leeds', userId: 'u1', locations: LOCS, readableIds: SIX, clocks: CLOCKS, homeConfig: LEEDS_CFG, ...over });

function memoryStore() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); } };
}

// ── 1 and 2: who is connected ────────────────────────────────────────────────

test('a Coffee Boy owner sees all 6 sites, whatever the link rows say', () => {
  assert.deepEqual(ids(connectedSites({ homeId: 'leeds', locations: LOCS, readableIds: SIX })), [...SIX].sort());
});

test('a login with sites in two companies never has them mixed', () => {
  const readable = [...SIX, 'brum', 'cabin'];
  assert.deepEqual(ids(connectedSites({ homeId: 'leeds', locations: LOCS, readableIds: readable })), [...SIX].sort());
  assert.deepEqual(ids(connectedSites({ homeId: 'brum', locations: LOCS, readableIds: readable })), ['brum']);
});

test('a super admin can read every site but still gets one company', () => {
  const all = LOCS.map((l) => l.id);
  assert.deepEqual(ids(connectedSites({ homeId: 'cabin', locations: LOCS, readableIds: all })), ['cabin']);
  assert.equal(connectedSites({ homeId: 'hudds', locations: LOCS, readableIds: all }).length, 6);
});

test('same company but NOT readable is left out', () => {
  assert.deepEqual(ids(connectedSites({ homeId: 'leeds', locations: LOCS, readableIds: ['leeds', 'hudds'] })), ['hudds', 'leeds']);
});

test('could not ask what is readable, or no company: the signed in site alone', () => {
  assert.deepEqual(ids(connectedSites({ homeId: 'leeds', locations: LOCS, readableIds: null })), ['leeds']);
  const noOrg = [{ id: 'a', name: 'A', org_id: null }, { id: 'b', name: 'B', org_id: null }];
  assert.deepEqual(ids(connectedSites({ homeId: 'a', locations: noOrg, readableIds: ['a', 'b'] })), ['a']);
  // the signed in site is there even when its row could not be read
  assert.deepEqual(ids(connectedSites({ homeId: 'zzz', locations: LOCS, readableIds: SIX })), ['zzz']);
  assert.deepEqual(connectedSites({ homeId: null, locations: LOCS, readableIds: SIX }), []);
});

// ── 3 and 4: the choice ──────────────────────────────────────────────────────

test('it starts on the signed in site', () => {
  const s = scopeOf();
  assert.deepEqual(s.tickedIds, ['leeds']);
  assert.equal(s.primary.id, 'leeds');
  assert.equal(s.isMulti, false);
  assert.equal(s.hasChoice, true);
  assert.equal(s.companyId, CB);
  assert.equal(sitesLabel(s), 'Coffee Boy Leeds');
  // names are tidied (the live rows have double spaces) and sorted
  assert.deepEqual(s.sites.map((x) => x.name), ['Coffee Boy Barnsley', 'Coffee Boy Barnsley Train Station', 'Coffee Boy Headingley', 'Coffee Boy Huddersfield', 'Coffee Boy Leeds', 'Coffee Boy Preston']);
});

test('the last choice is remembered per login and per company', () => {
  const store = memoryStore();
  const s = scopeOf();
  const key = choiceKey('u1', CB);
  assert.equal(readSiteChoice(store, key), null);
  writeSiteChoice(store, key, choiceFor(['hudds', 'preston'], s.sites));
  assert.deepEqual(resolveTicked(readSiteChoice(store, key), s.sites, 'leeds'), ['hudds', 'preston']);
  // another login, or the same login in another company, starts on its own signed in site
  assert.equal(readSiteChoice(store, choiceKey('u2', CB)), null);
  assert.equal(readSiteChoice(store, choiceKey('u1', WING)), null);
  assert.notEqual(choiceKey('u1', CB), choiceKey('u1', WING));
});

test('"All sites" stays all when a site is added; a site that has gone is dropped', () => {
  const store = memoryStore();
  const s = scopeOf();
  const key = choiceKey('u1', CB);
  writeSiteChoice(store, key, choiceFor(s.sites.map((x) => x.id), s.sites));
  assert.deepEqual(readSiteChoice(store, key), { all: true });
  const five = s.sites.filter((x) => x.id !== 'preston');
  assert.equal(resolveTicked({ all: true }, five, 'leeds').length, 5);
  assert.deepEqual(resolveTicked({ ids: ['preston', 'hudds'] }, five, 'leeds'), ['hudds']);
  // nothing left of the choice (or a site of another company): back to the signed in site
  assert.deepEqual(resolveTicked({ ids: ['preston'] }, five, 'leeds'), ['leeds']);
  assert.deepEqual(resolveTicked({ ids: ['brum', 'cabin'] }, s.sites, 'leeds'), ['leeds']);
});

test('storage that throws or holds rubbish is "no choice", never a crash', () => {
  const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('quota'); } };
  assert.equal(readSiteChoice(broken, 'k'), null);
  assert.doesNotThrow(() => writeSiteChoice(broken, 'k', { all: true }));
  assert.equal(readSiteChoice({ getItem: () => 'not json' }, 'k'), null);
  assert.equal(readSiteChoice(null, 'k'), null);
});

test('ticking: several, all, and the last one cannot be unticked', () => {
  const s = scopeOf();
  let t = toggleTicked(['leeds'], 'hudds', s.sites);
  assert.deepEqual([...t].sort(), ['hudds', 'leeds']);
  t = toggleTicked(t, 'leeds', s.sites);
  assert.deepEqual(t, ['hudds']);
  assert.deepEqual(toggleTicked(t, 'hudds', s.sites), ['hudds']);
  assert.deepEqual(toggleTicked(t, 'cabin', s.sites), ['hudds']);   // not in the scope: ignored
  const multi = scopeOf({ tickedIds: ['hudds', 'preston', 'leeds'] });
  assert.equal(isMulti(multi), true);
  assert.equal(multi.primary.id, 'leeds', 'the signed in site leads when it is ticked');
  assert.equal(sitesLabel(multi), '3 of 6 sites');
  assert.equal(sitesLabel(scopeOf({ tickedIds: SIX })), 'All sites (6)');
  assert.equal(scopeOf({ tickedIds: ['preston', 'hudds'] }).primary.id, 'hudds', 'else the first ticked by name');
  // a ticked id from another company never gets in
  assert.deepEqual(scopeOf({ tickedIds: ['cabin', 'brum'] }).tickedIds, ['leeds']);
});

test('a one site login has no choice', () => {
  const s = buildReportScope({ homeId: 'brum', userId: 'u9', locations: LOCS, readableIds: ['brum'], homeConfig: { timezone: 'Europe/London', businessDayStart: '06:00', currency: 'GBP' } });
  assert.equal(s.hasChoice, false);
  assert.equal(s.sites.length, 1);
  assert.deepEqual(s.tickedIds, ['brum']);
  assert.equal(sitesForView('summary', s).note, null);
  assert.equal(sitesForView('zreport', s).note, null);
  assert.equal(sitesForView('location_compare', s).note, null);
});

// ── 5: currencies ────────────────────────────────────────────────────────────

test('currencies are never added together', () => {
  const s = scopeOf({ tickedIds: SIX });
  assert.deepEqual(s.currencies, ['GBP']);
  assert.equal(s.canShowCombinedTotal, true);
  // one company with a pound site and a dollar site
  const mixedLocs = [{ id: 'uk', name: 'UK', org_id: 'o', currency: 'GBP' }, { id: 'us', name: 'US', org_id: 'o', currency: 'usd' }, { id: 'new', name: 'New', org_id: 'o', currency: null }];
  const mixed = buildReportScope({ homeId: 'uk', locations: mixedLocs, readableIds: ['uk', 'us', 'new'], tickedIds: ['uk', 'us'], homeConfig: { currency: 'GBP' } });
  assert.deepEqual(currenciesInScope(mixed), ['GBP', 'USD']);
  assert.equal(canShowCombinedTotal(mixed), false);
  assert.equal(canShowCombinedTotal(mixed, [mixed.siteOf('us')]), true);
  // a site whose currency nobody knows blocks the one total
  const unknown = buildReportScope({ homeId: 'uk', locations: mixedLocs, readableIds: ['uk', 'us', 'new'], tickedIds: ['uk', 'new'], homeConfig: { currency: 'GBP' } });
  assert.equal(unknown.canShowCombinedTotal, false);
  const rows = [{ siteId: 'uk', total: 10 }, { siteId: 'us', total: 5 }, { siteId: 'uk', total: 2.5 }];
  assert.deepEqual(totalsByCurrency(rows, mixed), [{ currency: 'GBP', total: 12.5 }, { currency: 'USD', total: 5 }]);
});

// ── 6 and 7: each site's own clock and business day ──────────────────────────

test('the 06:30 sites and the 00:00 site turn the same days into different instants', () => {
  const now = at('2026-10-05T13:00:00Z');   // Mon 5 Oct, 14:00 in Leeds
  const range = { ...getPeriodRange('last-7', null, LEEDS_CFG, now), builtAt: now };
  const s = scopeOf({ tickedIds: SIX });
  const hudds = siteRange('last-7', range, s.siteOf('hudds'), now);
  const station = siteRange('last-7', range, s.siteOf('station'), now);
  assert.equal(hudds.fromDay, '2026-09-29'); assert.equal(hudds.toDay, '2026-10-05');
  assert.equal(station.fromDay, hudds.fromDay); assert.equal(station.toDay, hudds.toDay);
  assert.equal(hudds.from.toISOString(), '2026-09-29T05:30:00.000Z');     // 06:30 BST
  assert.equal(station.from.toISOString(), '2026-09-28T23:00:00.000Z');   // 00:00 BST
  assert.equal(hudds.to.toISOString(), '2026-10-06T05:29:59.999Z');
  assert.equal(station.to.toISOString(), '2026-10-05T22:59:59.999Z');
  // a 06:10 sale on 5 Oct is the 4th at Huddersfield and the 5th at the station
  const sale = at('2026-10-05T05:10:00Z');
  const yesterday = { ...getPeriodRange('yesterday', null, LEEDS_CFG, now), builtAt: now };
  const inRange = (r) => sale >= r.from.getTime() && sale <= r.to.getTime();
  assert.equal(inRange(siteRange('yesterday', yesterday, s.siteOf('hudds'), now)), true);
  assert.equal(inRange(siteRange('yesterday', yesterday, s.siteOf('station'), now)), false);
  assert.deepEqual(s.clockOf('station'), { timeZone: 'Europe/London', dayStart: '00:00' });
});

test('a US venue is read over its own day, and its comparison is cut on its own clock', () => {
  const now = at('2026-10-05T18:00:00Z');   // 19:00 Leeds, 14:00 New York
  const range = { ...getPeriodRange('today', null, LEEDS_CFG, now), builtAt: now };
  const cabin = { id: 'cabin', name: 'The Cabin', timezone: 'America/New_York', businessDayStart: '06:00' };
  const r = siteRange('today', range, cabin, now);
  assert.equal(r.fromDay, '2026-10-05');
  assert.equal(r.from.toISOString(), '2026-10-05T10:00:00.000Z');   // 06:00 EDT
  assert.equal(r.timeZone, 'America/New_York');
  // the same weekday last week, up to 14:00 NEW YORK time (not 19:00, not London)
  assert.equal(r.prevFrom.toISOString(), '2026-09-28T10:00:00.000Z');
  assert.equal(r.prevTo.toISOString(), '2026-09-28T18:00:00.000Z');
  assert.equal(r.compare.cut, true);
  assert.match(r.compare.label, /by 2pm/);
  assert.match(range.compare.label, /by 7pm/);
});

test('the site the range was built on gets the SAME instants and the same comparison', () => {
  for (const period of ['today', 'yesterday', 'this-week', 'last-week', 'this-month', 'last-month', 'last-7', 'last-30', 'service:today:lunch']) {
    const now = at('2026-10-05T13:00:00Z');
    const range = getPeriodRange(period, null, LEEDS_CFG, now);
    const mine = siteRange(period, range, { id: 'leeds', timezone: LEEDS_CFG.timezone, businessDayStart: LEEDS_CFG.businessDayStart }, now);
    for (const k of ['from', 'to', 'prevFrom', 'prevTo']) assert.equal(mine[k].getTime(), range[k].getTime(), `${period} ${k}`);
    assert.equal(mine.fromDay, range.fromDay); assert.equal(mine.toDay, range.toDay);
    assert.equal(mine.timeZone, range.timeZone); assert.equal(mine.dayStart, range.dayStart);
    assert.deepEqual(mine.compare, range.compare, period);
  }
  const custom = { from: '2026-09-01', to: '2026-09-20' };
  const now = at('2026-10-05T13:00:00Z');
  const range = getPeriodRange('custom', custom, LEEDS_CFG, now);
  assert.deepEqual(siteRange('custom', range, { timezone: 'Europe/London', businessDayStart: '06:30' }, now).compare, range.compare);
  assert.equal(siteRange('today', { fromDay: 'x' }, { timezone: 'Europe/London' }, now), null);
});

test('the home site in the scope carries the very clock the shell loaded for it', () => {
  // The scope must not swap the signed in site's clock for a second read of it.
  const s = scopeOf({ clocks: { ...CLOCKS, leeds: { timezone: 'America/New_York', businessDayStart: '03:00' } } });
  assert.equal(s.home.timezone, 'Europe/London');
  assert.equal(s.home.businessDayStart, '06:30');
  assert.equal(s.home.shifts, LEEDS_CFG.shifts);
  assert.equal(s.home.clockKnown, true);
  // a site with no clock on record reads London 06:00 (as getVenueClock always has) and says so
  const bare = scopeOf({ clocks: {} });
  assert.equal(bare.siteOf('hudds').timezone, 'Europe/London');
  assert.equal(bare.siteOf('hudds').businessDayStart, '06:00');
  assert.equal(bare.siteOf('hudds').clockKnown, false);
  const now = at('2026-10-05T13:00:00Z');
  const range = getPeriodRange('today', null, LEEDS_CFG, now);
  assert.deepEqual(venueRange(range, { timezone: s.home.timezone, businessDayStart: s.home.businessDayStart }).from, range.from);
});

// ── 8: what each report is shown ─────────────────────────────────────────────

test('one site ticked: every report gets that site and no note', () => {
  const s = scopeOf();
  for (const view of [...Object.keys(REPORT_SITE_MODE), 'loyalty_members']) {
    const v = sitesForView(view, s);
    if (v.mode === 'all') { assert.equal(v.sites.length, 6); continue; }
    assert.deepEqual(v.sites.map((x) => x.id), ['leeds'], view);
    assert.equal(v.note, null, view);
    assert.deepEqual(v.choices, [], view);
  }
});

test('filtered down to ANOTHER single site: the multi site reports show it, the rest stay on the signed in site and say so', () => {
  const s = scopeOf({ tickedIds: ['preston'] });
  const summary = sitesForView('summary', s);
  assert.deepEqual(summary.sites.map((x) => x.id), ['preston']);
  assert.equal(summary.note, null);
  const items = sitesForView('items', s);
  assert.deepEqual(items.sites.map((x) => x.id), ['leeds']);
  assert.equal(items.note, 'This report shows the site you are signed in to for now. Showing Coffee Boy Leeds.');
  const z = sitesForView('zreport', s);
  assert.deepEqual(z.sites.map((x) => x.id), ['leeds']);
  assert.equal(z.note, 'This report is for one site: the one you are signed in to. Showing Coffee Boy Leeds.');
  // Step 3: the Transactions LIST follows the ticks. Its refunds and receipts are locked to
  // the signed in site inside the report (reportSplit.actionLock, pinned in reportSplit.test.js).
  assert.deepEqual(sitesForView('transactions', s).sites.map((x) => x.id), ['preston']);
  assert.equal(sitesForView('transactions', s).note, null);
});

test('several ticked: a report that is not multi site ready shows ONE site with a note, never mixed rows', () => {
  const s = scopeOf({ tickedIds: ['hudds', 'preston', 'leeds'] });
  // Step 3 flipped every 'one' report to 'multi', so the one at a time rule is pinned on a
  // probe: it is what a report gets if it is ever flagged 'one' again.
  REPORT_SITE_MODE.__one = 'one';
  try {
    const v = sitesForView('__one', s);
    assert.equal(v.sites.length, 1);
    assert.equal(v.sites[0].id, 'leeds');
    assert.equal(v.note, 'This report shows one site at a time. Showing Coffee Boy Leeds.');
    assert.deepEqual(v.choices.map((x) => x.id).sort(), ['hudds', 'leeds', 'preston']);
    // the chooser in the note picks among the ticked sites only
    assert.equal(sitesForView('__one', s, 'preston').sites[0].id, 'preston');
    assert.equal(sitesForView('__one', s, 'preston').note, 'This report shows one site at a time. Showing Coffee Boy Preston.');
    assert.equal(sitesForView('__one', s, 'station').sites[0].id, 'leeds');
  } finally { delete REPORT_SITE_MODE.__one; }
  // a multi site report gets every ticked site and no note
  const summary = sitesForView('summary', s);
  assert.deepEqual(summary.sites.map((x) => x.id).sort(), ['hudds', 'leeds', 'preston']);
  assert.equal(summary.note, null);
  // every other report still gets one site only: never mixed rows it cannot split
  assert.equal(sitesForView('items', s).sites.length, 1);
  assert.equal(sitesForView('tax', s).note, 'This report shows the site you are signed in to for now. Showing Coffee Boy Leeds.');
  for (const view of Object.keys(REPORT_SITE_MODE)) {
    const got = sitesForView(view, s);
    if (REPORT_SITE_MODE[view] === 'all') assert.equal(got.sites.length, 6);
    else if (REPORT_SITE_MODE[view] === 'multi') assert.equal(got.sites.length, 3);
    else assert.equal(got.sites.length, 1, view);
  }
  assert.equal(sitesForView('location_compare', s).note, 'This overview always shows every site.');
});

test('the flag list covers every report in the shell, and an unknown one is the signed in site', () => {
  for (const id of ['summary', 'exceptions', 'payments', 'daypart', 'shifts', 'payroll', 'items', 'item_trend', 'daily_trend',
    'daily_trading', 'menu_eng', 'servers', 'tips', 'order_types', 'order_sources', 'tables', 'bookings', 'kds_perf', 'zreport',
    'tax', 'location_compare', 'cash_drawer', 'transactions', 'open']) {
    assert.ok(REPORT_SITE_MODE[id], id);
  }
  assert.equal(siteModeFor('loyalty_points'), 'home');
  assert.equal(siteModeFor('something_new'), 'home');
  assert.equal(siteModeFor('catalog'), 'home');
  // a report flipped to 'multi' gets every ticked site
  const s = scopeOf({ tickedIds: ['hudds', 'leeds'] });
  REPORT_SITE_MODE.__probe = 'multi';
  try { assert.deepEqual(sitesForView('__probe', s).sites.map((x) => x.id).sort(), ['hudds', 'leeds']); }
  finally { delete REPORT_SITE_MODE.__probe; }
});

// ── 9: long periods across several sites ─────────────────────────────────────

test('item reports across several sites stop at 7 days; one site has no cap', () => {
  const two = [{ id: 'a' }, { id: 'b' }];
  const week = { fromDay: '2026-09-29', toDay: '2026-10-05' };
  const eight = { fromDay: '2026-09-28', toDay: '2026-10-05' };
  assert.equal(rangeDayCount(week), 7);
  assert.equal(rangeDayCount(eight), 8);
  assert.equal(rangeDayCount({ fromDay: 'x', toDay: 'y' }), 0);
  assert.equal(itemCapLine('items', two, week), null);
  assert.equal(itemCapLine('items', two, eight), ITEM_CAP_TEXT);
  assert.equal(itemCapLine('menu_eng', two, eight), ITEM_CAP_TEXT);
  assert.equal(itemCapLine('item_trend', [{ id: 'a' }], { fromDay: '2026-07-01', toDay: '2026-10-05' }), null);
  assert.equal(itemCapLine('summary', two, eight), null);
  assert.equal(ITEM_CAP_TEXT, 'Item reports across several sites cover up to 7 days. Pick one site for longer.');
  assert.doesNotMatch(ITEM_CAP_TEXT, /[–—]/);
});

test('figures come from rows until a report can draw from the day sums AND they are there', () => {
  const two = [{ id: 'a' }, { id: 'b' }];
  const month = { fromDay: '2026-09-06', toDay: '2026-10-05' };
  assert.equal(figuresFrom('servers', two, month, { available: true }), 'rows', 'a report that cannot draw from the sums reads rows');
  assert.equal(figuresFrom('summary', two, month, { available: true }), 'sums');
  assert.equal(figuresFrom('summary', two, month, { available: false, reason: 'not_installed' }), 'rows');
  assert.equal(figuresFrom('summary', [{ id: 'a' }], month, { available: true }), 'rows');
  assert.equal(scopeOf().daySums.available, null);
  assert.equal(scopeOf({ daySums: { available: false, reason: 'not_installed' } }).daySums.reason, 'not_installed');
});

// ── the group percent ────────────────────────────────────────────────────────

test('the group percent is like for like: a new site cannot make the group read up 500%', () => {
  const g = groupCompare([
    { current: 110, previous: 100 }, { current: 220, previous: 200 },
    { current: 900, previous: 0 }, { current: 50, previous: null }, { current: 0, previous: 0 }, { current: 0, previous: 0 },
  ]);
  assert.equal(g.pct.toFixed(1), '10.0');
  assert.equal(g.previous, 300);
  assert.equal(g.text, '(2 of 6 sites, 2 new)');
  assert.equal(groupCompare([{ current: 5, previous: 4 }, { current: 3, previous: 4 }]).text, '');
  assert.equal(groupCompare([{ current: 5, previous: 0 }]).pct, null);
  assert.equal(groupCompare([]).pct, null);
});

// ── the shell's wiring: one site is built exactly as it was before the scope ─────────────

import { readFileSync } from 'node:fs';
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

test('pin: for the signed in site the shell hands on the same config, range and money format as before', () => {
  const bo = read('../backoffice/sections/BOReports.jsx');
  // locationConfig IS the object getLocationConfig returned, so getPeriodRange builds the same range
  assert.match(bo, /if \(!rangeSite \|\| rangeSite\.isHome\) return homeConfig;/);
  assert.match(bo, /getPeriodRange\(period, customRange, locationConfig, builtAt\)/);
  // the site the range was built on is read over the range itself, not a second working out
  assert.match(bo, /range: s\.id === rangeSite\?\.id \? range : siteRange\(period, range, s, range\.builtAt\)/);
  // money: the Back Office currency unless ANOTHER site is on screen
  assert.match(bo, /const otherCurrency = rangeSite && !rangeSite\.isHome \? rangeSite\.currency : null;/);
  assert.match(bo, /otherCurrency \? \(n\) => money\(n \|\| 0, otherCurrency\) : fmtActive/);
  // the overview reads its own rows: under it the shell holds the signed in site only
  assert.match(bo, /viewSites\.mode === 'all' \? \[scope\.home\] : viewSites\.sites/);
});

test('pin: every report in the shell gets the optional multi site props, and the control is by the period filter', () => {
  const bo = read('../backoffice/sections/BOReports.jsx');
  const lines = bo.split('\n').filter((l) => /^\s+\{view(\.startsWith\('loyalty_'\)| === '[a-z_]+')\s+&& </.test(l));
  assert.ok(lines.length >= 25, `found ${lines.length} report lines`);
  for (const l of lines) assert.match(l, /\{\.\.\.siteProps\}\/>\}$/, l.trim().slice(0, 60));
  assert.match(bo, /<SitesControl scope=\{scope\} disabled=\{viewSites\.mode === 'all'\}/);
  assert.match(bo, /<SiteNote note=\{viewSites\.note\} choices=\{viewSites\.choices\}/);
  assert.match(bo, /writeSiteChoice\(browserStore\(\), choiceKey\(scope\.userId, scope\.companyId\), choiceFor\(ids, scope\.sites\)\)/);
  assert.match(bo, /resolveTicked\(readSiteChoice\(browserStore\(\), choiceKey\(data\.userId, orgId\)\), found, locId\)/);
  // hidden for a login with one site
  assert.match(read('../backoffice/sections/reports/SitesControl.jsx'), /if \(!scope\?\.hasChoice\) return null;/);
});

test('pin: the overview compares the scope\'s sites, per currency, on one row budget', () => {
  const lc = read('../backoffice/sections/reports/LocationCompare.jsx');
  assert.match(lc, /const locs = scopeSites\s+\? scopeSites\.map\(/);
  assert.match(lc, /stop: \(\) => stale, budget,/);
  assert.match(lc, /fetchClosedChecksMultiRange\(prevWindows, \{ stop: \(\) => stale, budget \}\)/);
  assert.match(lc, /groupCompare\(g\.rows\.map\(/);
  assert.match(read('./db.js'), /const budget = o\.budget \|\| rowBudget\(CHECK_ROWS_ON_SCREEN\);/);
  // the one rule for "my sites": what the database lets the login read
  assert.match(read('./reportSites.js'), /supabase\.rpc\('accessible_location_ids'\)/);
});
