// node --test: Inventory > Overview in multi site stock Drop 1.
//   - the rules (src/lib/stock/goLiveRules.js): the go live plan, which Overview, Needs attention,
//     Set up health, Go live, the cost rule;
//   - a one site company sees today's Overview pixel for pixel (text proof and render proof, with
//     its data loaded), and Location settings' Site groups card draws nothing for it;
//   - where Set up health comes from: the stock-nightly run asks each venue that holds stock.
// Synthetic ids and neutral site names only: the repo is public.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GOLIVE_STEPS, GOLIVE_STEP_KEYS, isoDay, dayWords, addDays, todayIn, autoDone, stepState, stepWords, planLines, stepsLeft,
  planShows, goLiveStepPatch, overviewMode, siteMenuNeeded, attentionWords, attentionRows, healthRows, goLiveRows, siteChunks,
  settingsOf, ruleAt,
} from './goLiveRules.js';

const S1 = '10000000-0000-4000-8000-000000000001';
const S2 = '10000000-0000-4000-8000-000000000002';
const S3 = '10000000-0000-4000-8000-000000000003';

test('the five go live steps, in order, with the card words (the database step names)', () => {
  assert.deepEqual(GOLIVE_STEPS.map((s) => [s.step, s.label, s.auto]), [
    ['copy_site', 'Copy a site', true],
    ['opening_count', 'Opening count', true],
    ['train_the_trainer', 'Train the trainer', false],
    ['side_by_side', 'Two weeks side by side', false],
    ['switch_off', 'Switch the old system off', false],
  ]);
  assert.deepEqual([...GOLIVE_STEP_KEYS], ['copy_site', 'opening_count', 'train_the_trainer', 'side_by_side', 'switch_off']);
  assert.ok(Object.isFrozen(GOLIVE_STEPS) && Object.isFrozen(GOLIVE_STEPS[0]));
  for (const s of GOLIVE_STEPS) assert.doesNotMatch(s.label, /[\u2013\u2014]/);
});

test('days: real days only, en-GB words, adding days across a month and a year', () => {
  assert.equal(isoDay('2026-11-03'), '2026-11-03');
  assert.equal(isoDay('2026-11-03T22:15:00Z'), '2026-11-03');
  assert.equal(isoDay('2026-02-30'), null);
  assert.equal(isoDay('3 Nov'), null);
  assert.equal(isoDay(null), null);
  assert.equal(isoDay(''), null);
  assert.equal(dayWords('2026-11-03'), '3 Nov');
  assert.equal(dayWords('2026-01-31'), '31 Jan');
  assert.equal(dayWords('nope'), '');
  assert.equal(addDays('2026-10-29', 6), '2026-11-04');
  assert.equal(addDays('2026-12-30', 3), '2027-01-02');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(addDays(null, 1), null);
});

test('today on the venue clock: the zone decides the day, a zone that is not real falls back', () => {
  const at = new Date('2026-10-21T23:30:00Z');
  assert.equal(todayIn('Europe/London', at), '2026-10-22', '00:30 BST is the next day in London');
  assert.equal(todayIn('America/Los_Angeles', at), '2026-10-21');
  assert.match(todayIn('Mars/Base', at), /^\d{4}-\d{2}-\d{2}$/);
  assert.match(todayIn(), /^\d{4}-\d{2}-\d{2}$/);
});

test('Copy a site and Opening count tick themselves from the facts; the other three never do', () => {
  assert.equal(autoDone('copy_site', { items_on: 12 }), true);
  assert.equal(autoDone('copy_site', { items_on: 0 }), false);
  assert.equal(autoDone('opening_count', { approved_counts: 1 }), true);
  assert.equal(autoDone('opening_count', { approved_counts: 0, items_on: 50 }), false);
  for (const s of ['train_the_trainer', 'side_by_side', 'switch_off']) assert.equal(autoDone(s, { items_on: 9, approved_counts: 9, orders_sent: 9 }), false, s);
  assert.equal(autoDone('copy_site', null), false);
});

test('a step is done, late, due (this week or no day yet) or later', () => {
  const today = '2026-10-22';
  assert.equal(stepState({ step: 'switch_off', done_at: '2026-10-01T10:00:00Z', due_day: '2026-09-01' }, {}, today), 'done', 'done wins over a passed day');
  assert.equal(stepState({ step: 'copy_site', due_day: '2026-10-01' }, { items_on: 3 }, today), 'done', 'ticked itself');
  assert.equal(stepState({ step: 'side_by_side', due_day: '2026-10-21' }, {}, today), 'late');
  assert.equal(stepState({ step: 'side_by_side', due_day: '2026-10-22' }, {}, today), 'due');
  assert.equal(stepState({ step: 'side_by_side', due_day: '2026-10-28' }, {}, today), 'due');
  assert.equal(stepState({ step: 'side_by_side', due_day: '2026-10-29' }, {}, today), 'later');
  assert.equal(stepState({ step: 'side_by_side' }, {}, today), 'due', 'no day set yet');
  assert.equal(stepState('train_the_trainer', {}, today), 'due', 'a bare key is a step with no row');
  assert.equal(stepState({ step: 'side_by_side', due_day: '2026-10-01' }, {}, null), 'due', 'no today: never called late');
});

test('the plan card: every step in order, rows matched by step, versions only for rows that exist', () => {
  const plan = {
    steps: [
      { step: 'switch_off', due_day: '2026-11-20', done_at: null, done_by_name: null, note: '', row_version: 2 },
      { step: 'train_the_trainer', due_day: '2026-10-20', done_at: null, done_by_name: null, note: 'Two people', row_version: 1 },
      { step: 'side_by_side', due_day: null, done_at: '2026-10-21T09:00:00Z', done_by_name: 'Sam Lead', note: null, row_version: 4 },
      { step: 'not_a_step', due_day: '2026-10-20' },
      null,
    ],
    facts: { items_on: 40, approved_counts: 0, first_approved_count_at: null, orders_sent: 0 },
  };
  const lines = planLines(plan, '2026-10-22');
  assert.deepEqual(lines.map((l) => l.step), ['copy_site', 'opening_count', 'train_the_trainer', 'side_by_side', 'switch_off']);
  assert.deepEqual(lines.map((l) => l.state), ['done', 'due', 'late', 'done', 'later']);
  assert.deepEqual(lines.map((l) => l.words), ['Done', 'No day set', 'Due 20 Oct', 'Done 21 Oct by Sam Lead', 'Due 20 Nov']);
  assert.deepEqual(lines.map((l) => l.rowVersion), [null, null, 1, 4, 2]);
  assert.deepEqual(lines.map((l) => l.tickedItself), [true, false, false, false, false]);
  assert.equal(lines[2].late, true);
  assert.equal(lines[2].note, 'Two people');
  assert.equal(stepsLeft(plan, '2026-10-22'), 3);
  // nothing back yet: five open steps with no day
  assert.deepEqual(planLines(null, '2026-10-22').map((l) => l.words), ['No day set', 'No day set', 'No day set', 'No day set', 'No day set']);
  assert.equal(stepWords(null), '');
});

test('the plan shows on a site that has steps, or that has nothing on yet; never on an old site with no plan', () => {
  assert.equal(planShows({ steps: [{ step: 'switch_off' }], facts: { items_on: 300 } }), true);
  assert.equal(planShows({ steps: [], facts: { items_on: 0 } }), true);
  assert.equal(planShows({ steps: [], facts: { items_on: 55 } }), false);
  assert.equal(planShows({ steps: [], facts: {} }), false, 'facts not known: no card');
  assert.equal(planShows(null), false);
});

test('a go live save sends only what changed, a cleared day as null', () => {
  assert.deepEqual(goLiveStepPatch('side_by_side', { dueDay: '2026-11-03' }), { step: 'side_by_side', due_day: '2026-11-03' });
  assert.deepEqual(goLiveStepPatch('side_by_side', { dueDay: '' }), { step: 'side_by_side', due_day: null });
  assert.deepEqual(goLiveStepPatch('switch_off', { done: true }), { step: 'switch_off', done: true });
  assert.deepEqual(goLiveStepPatch('switch_off', { done: 0 }), { step: 'switch_off', done: false });
  assert.deepEqual(goLiveStepPatch('train_the_trainer', { note: '  ' }), { step: 'train_the_trainer', note: null });
  assert.equal(goLiveStepPatch('train_the_trainer', { note: 'x'.repeat(900) }).note.length, 500);
});

test('which Overview: one site companies always get today\'s screen; multi gets All sites or the one site view', () => {
  assert.equal(overviewMode(null), 'loading');
  assert.equal(overviewMode({ ready: false, multi: true }), 'loading');
  assert.equal(overviewMode({ ready: true, multi: false, oneSite: { id: S1 } }), 'one_site');
  assert.equal(overviewMode({ ready: true, multi: false, oneSite: null }), 'one_site', 'even with no site known');
  assert.equal(overviewMode({ ready: true, failed: true, multi: false }), 'one_site', 'a scope that failed fails to today');
  assert.equal(overviewMode({ ready: true, multi: true, oneSite: null, isAll: true }), 'all');
  assert.equal(overviewMode({ ready: true, multi: true, oneSite: { id: null } }), 'all');
  assert.equal(overviewMode({ ready: true, multi: true, oneSite: { id: S2 } }), 'site');
});

test('the one site view reads a site\'s own menu only when it is not the venue signed in to', () => {
  assert.equal(siteMenuNeeded({ multi: false, siteId: S2, signedInId: S1 }), false, 'one site company: the store, exactly today');
  assert.equal(siteMenuNeeded({ multi: true, siteId: S1, signedInId: S1 }), false);
  assert.equal(siteMenuNeeded({ multi: true, siteId: S2, signedInId: S1 }), true);
  assert.equal(siteMenuNeeded({ multi: true, siteId: S2, signedInId: null }), true);
  assert.equal(siteMenuNeeded({ multi: true, siteId: null, signedInId: S1 }), false);
  assert.equal(siteMenuNeeded(), false);
});

test('Needs attention: one line per site, plain words, singular and plural, nothing for a quiet site', () => {
  const rows = [
    { location_id: S1, name: 'North Site', below_zero: 3, no_price: 1, counts_ready: 1, orders_overdue: 2, below_reorder: 0, queue_failed: 1, golive_open: 0, health: null },
    { location_id: S2, name: 'South Site', below_zero: 0, no_price: 0, counts_ready: 0, orders_overdue: 0, below_reorder: 0, queue_failed: 0, golive_open: 2, health: null },
    { location_id: S3, name: 'East Site', below_zero: 0, no_price: 2, counts_ready: 2, orders_overdue: 1, below_reorder: 7, queue_failed: 2 },
  ];
  assert.equal(attentionWords(rows[0]), '3 below zero, 1 with no price, 1 count ready to approve, 2 orders overdue, 1 save did not finish');
  assert.equal(attentionWords(rows[1]), '');
  assert.equal(attentionWords(rows[2]), '2 with no price, 2 counts ready to approve, 1 order overdue, 7 below reorder, 2 saves did not finish');
  assert.deepEqual(attentionRows(rows).map((r) => [r.locationId, r.total]), [[S1, 8], [S3, 14]]);
  assert.deepEqual(attentionRows(null), []);
  for (const r of attentionRows(rows)) assert.doesNotMatch(r.words, /[\u2013\u2014]/);
});

test('Set up health: only sites out of step, with the count of things; never checked is said apart from in step', () => {
  const rows = [
    { location_id: S1, name: 'North Site', health: { checked_at: '2026-10-22T03:41:00Z', planned_writes: 3, recipe_planned_writes: 1, lines: ['Oat milk: price differs', 'Brioche bun: pack differs', 'x', 'y', 5] } },
    { location_id: S2, name: 'South Site', health: { checked_at: '2026-10-22T03:41:00Z', planned_writes: 0, recipe_planned_writes: 0, lines: [] } },
    { location_id: S3, name: 'East Site', health: null },
    { location_id: S3, name: 'West Site', health: { checked_at: '2026-10-22T03:41:00Z', planned_writes: 1, recipe_planned_writes: 0 } },
  ];
  const h = healthRows(rows);
  assert.equal(h.checked, true);
  assert.deepEqual(h.out.map((r) => r.words), ['North Site: 4 things out of step.', 'West Site: 1 thing out of step.']);
  assert.deepEqual(h.out[0].lines, ['Oat milk: price differs', 'Brioche bun: pack differs', 'x']);
  assert.deepEqual(healthRows([{ location_id: S1, name: 'North Site', health: null }]), { checked: false, out: [] });
});

test('Go live (All sites): sites with steps left, singular and plural', () => {
  assert.deepEqual(goLiveRows([
    { location_id: S1, name: 'North Site', golive_open: 1 },
    { location_id: S2, name: 'South Site', golive_open: 0 },
    { location_id: S3, name: 'East Site', golive_open: 4 },
  ]).map((r) => r.words), ['North Site: 1 step left', 'East Site: 4 steps left']);
});

test('needs attention is asked 50 sites at a time at most (the database refuses more)', () => {
  const ids = Array.from({ length: 120 }, (_, i) => `site-${i}`);
  const parts = siteChunks(ids);
  assert.deepEqual(parts.map((p) => p.length), [50, 50, 20]);
  assert.deepEqual(parts.flat(), ids);
  assert.deepEqual(siteChunks([...ids.slice(0, 3), 'site-1', null]).flat(), ['site-0', 'site-1', 'site-2'], 'no repeats, no blanks');
  assert.deepEqual(siteChunks(ids, 500).map((p) => p.length), [50, 50, 20], 'never above 50');
  assert.deepEqual(siteChunks([]), []);
});

test('the cost rule: the company rule, the site overrides, and what applies at one site', () => {
  const s = settingsOf({
    settings: { org_id: 'o', cost_rule: 'deliveries', row_version: 3 },
    sites: [
      { location_id: S1, cost_rule_override: 'price_list' },
      { location_id: S2, cost_rule_override: null },
      { location_id: S3, cost_rule_override: 'junk' },
    ],
  });
  assert.deepEqual(s, { companyRule: 'deliveries', overrides: { [S1]: 'price_list' }, rowVersion: 3 });
  assert.deepEqual(ruleAt(s, S1), { rule: 'price_list', own: true });
  assert.deepEqual(ruleAt(s, S2), { rule: 'deliveries', own: false });
  assert.deepEqual(settingsOf(null), { companyRule: 'price_list', overrides: {}, rowVersion: null }, 'no row yet: the price list');
  assert.deepEqual(settingsOf({ settings: { cost_rule: 'nonsense' } }).companyRule, 'price_list');
  assert.deepEqual(ruleAt(null, S1), { rule: 'price_list', own: false });
});

// -- one site companies: today's Overview, pixel for pixel (Rule 2; the one site check company) --
//
//  1. The text proof: StockOverview.jsx from its first import line, with the Drop 1 edits undone, is
//     main's file (f1a8f397, v5.11.84) byte for byte. Each edit is a no op for a one site company:
//     the router hands it today's body with multi false; the site it starts from is the signed in
//     venue (siteId is what Back Office passes a one site company, else today's getActiveLocationSync);
//     the menu is the store's; the cost rule card is today's.
//  2. The render proof: today's file (rebuilt by undoing the edits, which the hash ties to main) and
//     the new file are rendered in node (JSX compiled with rolldown, the database and the store
//     replaced by quiet stand ins); the HTML must be identical for a one site company.

import fs from 'node:fs';
import crypto from 'node:crypto';
import { createRequire, registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const SRC = new URL('../../', import.meta.url);
const at = (p) => new URL(p, SRC);
const OVERVIEW = at('backoffice/sections/StockOverview.jsx');
const OVERVIEW_MAIN_SHA = '768d2c61a1d066a9a62740796f7668bd1aeeb45703c5c9bd8b07832c62004fae';
const OVERVIEW_IMPORTS = [
  "import { overviewMode } from '../../lib/stock/goLiveRules';\n",
  "import { useSiteStockContext } from '../../lib/stock/siteContext';\n",
  "import { useStockScope } from '../StockScope';\n",
  "import OverviewAllSites from './stock/OverviewAllSites';\n",
  "import GoLivePlanCard from './stock/GoLivePlanCard';\n",
  "import { SiteCostRuleCard } from './stock/CompanySettingsCard';\n",
];
const ROUTER_FROM = '// Drop 1: which Overview (goLiveRules.js overviewMode).';
const ROUTER_TO = '  const menuItems = useSiteMenu(siteId, multi);\n';
const TODAY_HEAD = 'export default function StockOverview({ setSection, canOpen = () => true }) {\n  const menuItems = useStore(s => s.menuItems) || [];\n';
const EDIT_LOC = ['useState(siteId || getActiveLocationSync())', 'useState(getActiveLocationSync())'];
const EDIT_CARD = ['{multi && <GoLivePlanCard siteId={locId} />}\n          {multi ? <SiteCostRuleCard siteId={locId} /> : costRule && (', '{costRule && ('];
const times = (text, part) => text.split(part).length - 1;

/** Today's StockOverview.jsx from its first import line, rebuilt from the new file. */
function overviewMainText(now) {
  let body = now.slice(now.search(/^import /m));
  for (const line of OVERVIEW_IMPORTS) body = body.replace(line, '');
  const a = body.indexOf(ROUTER_FROM);
  const b = body.indexOf(ROUTER_TO);
  body = body.slice(0, a) + TODAY_HEAD + body.slice(b + ROUTER_TO.length);
  return body.replace(EDIT_LOC[0], EDIT_LOC[1]).replace(EDIT_CARD[0], EDIT_CARD[1]);
}

test('one site: StockOverview.jsx is main\'s file once the Drop 1 edits are undone (sha256)', () => {
  const now = fs.readFileSync(OVERVIEW, 'utf8');
  const body = now.slice(now.search(/^import /m));
  for (const line of OVERVIEW_IMPORTS) assert.equal(times(body, line), 1, line.trim());
  assert.equal(times(body, ROUTER_FROM), 1, 'the router, once');
  assert.equal(times(body, ROUTER_TO), 1, 'the body starts with the site menu, once');
  assert.ok(body.indexOf(ROUTER_FROM) < body.indexOf(ROUTER_TO));
  assert.equal(times(body, EDIT_LOC[0]), 1, 'starts from siteId, once');
  assert.equal(times(body, EDIT_CARD[0]), 1, 'the two cards of a multi site company, once');
  assert.equal(crypto.createHash('sha256').update(overviewMainText(now)).digest('hex'), OVERVIEW_MAIN_SHA,
    'everything else is main\'s text byte for byte');
  // what the router hands a one site company: today's body, multi false, nothing around it
  const router = body.slice(body.indexOf(ROUTER_FROM), body.indexOf(ROUTER_TO));
  assert.ok(router.includes('export default function StockOverview({ setSection, canOpen = () => true, siteId = null }) {\n  const sc = useStockScope();\n  const mode = overviewMode(sc);\n'), 'the router reads the scope first');
  assert.match(router, /if \(mode === 'loading'\) return <div style=\{\{ padding: 26, color: 'var\(--t3\)' \}\}>Loading…<\/div>;/, 'today\'s own Loading line');
  assert.match(router, /return <StockOverviewSite setSection=\{setSection\} canOpen=\{canOpen\} siteId=\{mode === 'site' \? \(siteId \|\| sc\.oneSite\.id\) : siteId\} multi=\{mode === 'site'\} \/>;/);
  assert.ok(router.includes('function useSiteMenu(siteId, multi) {\n  const storeMenu = useStore(s => s.menuItems);\n  const site = useSiteStockContext(multi ? siteId : null);\n  return (multi ? site.menuItems : storeMenu) || [];\n}'),
    'one site: the store\'s menu, exactly today\'s read');
  assert.doesNotMatch(fs.readFileSync(OVERVIEW, 'utf8').slice(0, now.search(/^import /m)), /[\u2013\u2014]/, 'the new top comment has no long dash');
});

// -- the render proof --

const require = createRequire(import.meta.url);
let transformSync = null;
try { ({ transformSync } = require('rolldown/experimental')); } catch { transformSync = null; }

const STUBBED = ['store/index.js', 'lib/supabase.js', 'lib/locationTime.js', 'lib/saveHealth.js', 'lib/stock/data.js', 'lib/stock/counts.js',
  'lib/stock/areas.js', 'lib/stock/recipes.js', 'lib/stock/purchasing.js'];
const SPECIAL = {
  getActiveLocationSync: "() => 'site-home'",
  getLocationId: "async () => 'site-home'",
  useStore: '(sel) => (typeof sel === "function" ? sel(STATE) : STATE)',
  isMock: 'false',
  supabase: 'null',
  platformSupabase: 'null',
  movementLabel: "(t) => (t === 'SALE' ? 'Sale' : t === 'DELIVERY' ? 'Delivery' : String(t))",
};
function exportNames(text) {
  const names = new Set();
  for (const m of text.matchAll(/^export\s+(?:async\s+)?(?:const|let|var|function\*?|class)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of text.matchAll(/^export\s*\{([^}]*)\}/gm)) for (const part of m[1].split(',')) { const n = part.trim().split(/\s+as\s+/).pop().trim(); if (n) names.add(n); }
  return [...names];
}
function stubSource(path) {
  const names = exportNames(fs.readFileSync(path, 'utf8'));
  const body = names.map((n) => `export const ${n} = ${SPECIAL[n] || '(...a) => Promise.resolve({ data: [], error: null })'};`).join('\n');
  return `const STATE = { showToast: () => {}, taxRates: [], menuItems: [{ id: 'm1', name: 'Test Dish', type: 'item' }, { id: 'm2', name: 'Side Salad', type: 'item' }], locationConfig: null };\n${body}\n`;
}
const SCOPE_RULES = at('lib/stock/siteScope.js').href;
const scopeStub = (scope) => `import { scopeAnswer } from '${SCOPE_RULES}';
const base = scopeAnswer({ scope: ${scope}, homeId: 'site-home', access: null, userId: 'u-test' });
const answer = { ...base, setChoice() {}, showClosed: false, setShowClosed() {}, askWhichSite: async () => null, go() {}, takeOpenNew: () => false, reload() {} };
export const useStockScope = () => answer;
export function StockScopeProvider({ children }) { return children; }
export function StockSiteGate({ children }) { return children('site-home'); }`;
const SITES = "[{ id: 'site-home', name: 'North Site', status: 'active' }, { id: 'site-2', name: 'South Site', status: 'active' }]";
const MARKERS = {
  'stub:scope-one': scopeStub("{ ready: true, multi: false, orgId: 'org-1', homeSite: 'site-home', level: 'sites', sites: [{ id: 'site-home', name: 'North Site', status: 'active' }], closedSites: [], groups: [], editors: [] }"),
  'stub:scope-owner': scopeStub("{ ready: true, multi: false, orgId: 'org-1', homeSite: 'site-home', level: 'all', sites: [{ id: 'site-home', name: 'North Site', status: 'active' }], closedSites: [], groups: [], editors: [] }"),
  'stub:scope-loading': 'export const useStockScope = () => ({ ready: false, multi: false });',
  'stub:scope-all': scopeStub(`{ ready: true, multi: true, orgId: 'org-1', homeSite: 'site-home', level: 'all', sites: ${SITES}, closedSites: [], groups: [], editors: ['Pat Lee'] }`),
  'stub:scope-allsites-manager': scopeStub(`{ ready: true, multi: true, orgId: 'org-1', homeSite: 'site-home', level: 'sites', sites: ${SITES}, closedSites: [], groups: [], editors: ['Pat Lee'] }`),
  'stub:all-sites': "export default function OverviewAllSites(p) { return globalThis.__h('overview-all-sites', { 'data-can': String(typeof p.canOpen) }); }",
};
// The loaded Overview (map 9.2 "with fixed fixtures"): server rendering runs no effect, so the data
// never lands. For StockOverview.jsx alone (today's and the new one), 'react' is a copy whose
// useState hands the body its loaded data: the 2nd and 3rd useState after the one that holds the
// venue id are the data (d) and the cost rule, in both files (the hash ties their order to main).
const REACT_URL = new URL(`file://${require.resolve('react')}`).href;
MARKERS['stub:react-preset'] = `import R from '${REACT_URL}';
export * from '${REACT_URL}';
export default R;
let calls = 0;
export function useState(init) {
  const p = globalThis.__overviewPreset;
  if (!p) return R.useState(init);
  if (init === p.locId) calls = 0; else calls += 1;
  if (calls === 1) return R.useState(p.d);
  if (calls === 2) return R.useState(p.costRule);
  return R.useState(init);
}`;
const VIRTUAL = new Map();
const MAIN_OVERVIEW_URL = at('backoffice/sections/__main_StockOverview.jsx').href;
const isOverviewModule = (u) => typeof u === 'string' && (u.split('?')[0] === OVERVIEW.href || u === MAIN_OVERVIEW_URL);

const inSrc = (url) => typeof url === 'string' && url.startsWith(SRC.href);
const isFile = (u) => { try { return fs.statSync(fileURLToPath(u)).isFile(); } catch { return false; } };
const compile = (url, text) => {
  const t = text.replace(/import\.meta\.env/g, '({})');
  if (!url.split('?')[0].endsWith('.jsx')) return t;
  const out = transformSync(fileURLToPath(url.split('?')[0]), t, { jsx: { runtime: 'automatic' } });
  if (out.errors?.length) throw new Error(`${url}: ${out.errors.map((e) => e.message).join('; ')}`);
  return out.code;
};

if (transformSync) {
  registerHooks({
    resolve(specifier, context, next) {
      if (MARKERS[specifier] || VIRTUAL.has(specifier)) return { url: specifier, shortCircuit: true };
      const parent = context.parentURL || '';
      if (specifier === 'react' && isOverviewModule(parent)) return { url: 'stub:react-preset', shortCircuit: true };
      if ((specifier.startsWith('./') || specifier.startsWith('../')) && (inSrc(parent) || VIRTUAL.has(parent))) {
        const variant = parent.includes('?scope=') ? parent.slice(parent.indexOf('?scope=') + 7) : null;
        const base = new URL(specifier, parent.split('?')[0]);
        const rel = base.href.slice(SRC.href.length);
        if (variant && rel === 'backoffice/StockScope') return { url: `stub:scope-${variant}`, shortCircuit: true };
        if (variant && rel === 'backoffice/sections/stock/OverviewAllSites') return { url: 'stub:all-sites', shortCircuit: true };
        for (const ext of ['', '.js', '.jsx', '/index.js', '/index.jsx']) {
          const u = new URL(base.href + ext);
          if (isFile(u)) return { url: variant ? `${u.href}?scope=${variant}` : u.href, shortCircuit: true };
        }
      }
      return next(specifier, context);
    },
    load(url, context, next) {
      if (MARKERS[url]) return { format: 'module', source: MARKERS[url], shortCircuit: true };
      if (VIRTUAL.has(url)) return { format: 'module', source: compile(url, VIRTUAL.get(url)), shortCircuit: true };
      if (inSrc(url)) {
        const path = fileURLToPath(url.split('?')[0]);
        const rel = url.split('?')[0].slice(SRC.href.length);
        if (STUBBED.includes(rel)) return { format: 'module', source: stubSource(path), shortCircuit: true };
        if (path.endsWith('.jsx') || path.endsWith('.js')) return { format: 'module', source: compile(url, fs.readFileSync(path, 'utf8')), shortCircuit: true };
      }
      return next(url, context);
    },
  });
}

const html = (Comp, props) => renderToStaticMarkup(createElement(Comp, props));
const NO_ROLLDOWN = 'rolldown is not installed here, so the JSX cannot be compiled (the sha256 proof above still holds)';

test('rendered: a one site company gets main\'s Overview HTML; loading shows today\'s line; All sites gets the company view', { skip: transformSync ? false : NO_ROLLDOWN }, async () => {
  globalThis.__h = createElement;
  VIRTUAL.set(MAIN_OVERVIEW_URL, overviewMainText(fs.readFileSync(OVERVIEW, 'utf8')));
  const Main = (await import(MAIN_OVERVIEW_URL)).default;
  const today = html(Main, { setSection: () => {}, canOpen: () => true });
  assert.equal(today, '<div style="padding:26px;color:var(--t3)">Loading…</div>', 'today\'s first paint (its data loads after)');

  const One = (await import(`${OVERVIEW.href}?scope=one`)).default;
  assert.equal(html(One, { setSection: () => {}, canOpen: () => true, siteId: 'site-home' }), today, 'one site company, given the signed in venue');
  assert.equal(html(One, { setSection: () => {}, canOpen: () => true, siteId: null }), today, 'one site company, no site named');
  const Owner = (await import(`${OVERVIEW.href}?scope=owner`)).default;
  assert.equal(html(Owner, { setSection: () => {}, canOpen: () => true, siteId: 'site-home' }), today, 'the owner of a one site company: still today');

  const Loading = (await import(`${OVERVIEW.href}?scope=loading`)).default;
  assert.equal(html(Loading, { setSection: () => {}, siteId: 'site-home' }), today, 'the scope still loading: today\'s Loading line');

  const All = (await import(`${OVERVIEW.href}?scope=all`)).default;
  assert.equal(html(All, { setSection: () => {}, canOpen: () => true, siteId: null }), '<overview-all-sites data-can="function"></overview-all-sites>', 'All sites: the company view in place of today\'s body');
});

// A small made up venue: one item priced, one with no price, one below zero, a dish with a recipe,
// one menu item without one, a supplier, two movements. Areas not installed (today's default).
const OVERVIEW_FIXTURE = {
  items: [
    { id: 'i1', name: 'Oat milk', kind: 'PURCHASED', currentCost: 1.2, onHand: 10, baseUnit: 'l', packaging: [], archivedAt: null },
    { id: 'i2', name: 'Brioche bun', kind: 'PURCHASED', currentCost: null, onHand: 0, baseUnit: 'each', packaging: [], archivedAt: null },
    { id: 'i3', name: 'Beef patty', kind: 'PURCHASED', currentCost: 0.9, onHand: -4, baseUnit: 'each', packaging: [], archivedAt: null },
    { id: 'i4', name: 'Old item', kind: 'PURCHASED', currentCost: 1, onHand: 1, baseUnit: 'each', packaging: [], archivedAt: '2026-01-01T00:00:00Z' },
  ],
  recipes: [{ id: 'r1', recipeType: 'MENU', menuItemId: 'm1' }],
  suppliers: [{ id: 's1', name: 'Sample Dairy' }],
  pos: [{ id: 'po1' }],
  moves: [
    { id: 'mv1', movementType: 'SALE', inventoryItemId: 'i3', qtyBase: -2, valueDelta: -1.8 },
    { id: 'mv2', movementType: 'DELIVERY', inventoryItemId: 'i1', qtyBase: 6, valueDelta: 7.2 },
  ],
  areas: null, holdings: {}, counts: [], health: null,
};

test('rendered with its data loaded: a one site company\'s Overview is main\'s HTML, both cost rules', { skip: transformSync ? false : NO_ROLLDOWN }, async () => {
  globalThis.__h = createElement;
  VIRTUAL.set(MAIN_OVERVIEW_URL, overviewMainText(fs.readFileSync(OVERVIEW, 'utf8')));
  const Main = (await import(MAIN_OVERVIEW_URL)).default;
  const One = (await import(`${OVERVIEW.href}?scope=one`)).default;
  const SiteView = (await import(`${OVERVIEW.href}?scope=allsites-manager`)).default;
  try {
    for (const costRule of ['price_list', 'deliveries']) {
      globalThis.__overviewPreset = { locId: 'site-home', d: OVERVIEW_FIXTURE, costRule };
      const today = html(Main, { setSection: () => {}, canOpen: () => true });
      for (const words of ['Stock control', 'Set up your stock', 'Need a price', '1 item with no price', '1 item below zero', '1 menu item without a recipe',
        'Recent stock movements', 'Cost here', 'Oat milk', 'Beef patty']) assert.ok(today.includes(words), `${costRule}: today's page shows ${words}`);
      assert.equal(html(One, { setSection: () => {}, canOpen: () => true, siteId: 'site-home' }), today, `${costRule}: pixel for pixel`);
      assert.equal(html(One, { setSection: () => {}, canOpen: (s) => s !== 'recipes', siteId: 'site-home' }),
        html(Main, { setSection: () => {}, canOpen: (s) => s !== 'recipes' }), `${costRule}: a login not shown Produce, the same buttons left out`);
      assert.equal(html(One, { setSection: null, siteId: 'site-home' }), html(Main, { setSection: null }), `${costRule}: no route setter, the same`);
    }
    // the same data in a multi site company's one site view (a Their sites manager on their site):
    // today's body, with the company's cost rule card, locked, in place of the site's own
    globalThis.__overviewPreset = { locId: 'site-home', d: OVERVIEW_FIXTURE, costRule: 'price_list' };
    const site = html(SiteView, { setSection: () => {}, canOpen: () => true, siteId: 'site-home' });
    const today = html(Main, { setSection: () => {}, canOpen: () => true });
    for (const words of ['Set up your stock', '1 item below zero', 'Recent stock movements', 'Cost here', 'Set by head office. Ask Pat Lee to change it.'])
      assert.ok(site.includes(words), `one site view: ${words}`);
    assert.ok(!today.includes('Set by head office'), 'never on a one site company\'s page');
    assert.ok(!site.includes('name="cost-rule"'), 'the site\'s own rule buttons are not drawn in a multi site company');
  } finally {
    globalThis.__overviewPreset = null;
  }
});

test('rendered: the All sites Overview draws its cards and words (first paint, before its reads land)', { skip: transformSync ? false : NO_ROLLDOWN }, async () => {
  globalThis.__h = createElement;
  const url = at('backoffice/sections/stock/OverviewAllSites.jsx').href;
  const Editor = (await import(`${url}?scope=all`)).default;
  const page = html(Editor, { setSection: () => {}, canOpen: () => true });
  for (const words of ['Stock control', 'Every site at a glance.', 'Needs attention', 'Set up health', 'Company stock settings', 'Cost here', 'Applies to every site.'])
    assert.ok(page.includes(words), words);
  assert.doesNotMatch(page, /[\u2013\u2014]/, 'no long dash on the page');
  assert.doesNotMatch(page, /Set by head office/, 'a company editor sees no lock line');
  const Manager = (await import(`${url}?scope=allsites-manager`)).default;
  const locked = html(Manager, { setSection: () => {}, canOpen: () => true });
  assert.ok(locked.includes('Set by head office. Ask Pat Lee to change it.'), 'a Their sites login sees the cost rule locked, with who to ask');
});

test('rendered: Location settings\' Site groups card is nothing at all for a one site company, owner or not', { skip: transformSync ? false : NO_ROLLDOWN }, async () => {
  globalThis.__h = createElement;
  const url = at('backoffice/sections/stock/SiteGroupsCard.jsx').href;
  for (const v of ['one', 'owner', 'loading']) {
    const Card = (await import(`${url}?scope=${v}`)).default;
    assert.equal(html(Card, {}), '', v);
  }
  const Card = (await import(`${url}?scope=all`)).default;
  const out = html(Card, {});
  for (const words of ['Site groups', 'Groups of sites for the site picker, for example North or South.', '+ Add a group']) assert.ok(out.includes(words), words);
  const Manager = (await import(`${url}?scope=allsites-manager`)).default;
  assert.equal(html(Manager, {}), '', 'a Their sites login of a multi site company: no card');
});

// -- where Set up health comes from: the nightly run asks each venue that holds stock --
//
// supabase/functions/stock-nightly/index.ts is loaded as it ships (types stripped by node, the
// Supabase client a stand in answering from plain rows, Deno.serve handing over the handler), the
// way stockEdgeRoles.test.js drives it. Synthetic ids only.

import os from 'node:os';
import nodePath from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { pathToFileURL } from 'node:url';

const EDGE_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const EDGE_ENV = { SUPABASE_URL: 'https://ops.test', SUPABASE_SERVICE_ROLE_KEY: 'service-key', PLATFORM_SUPABASE_URL: 'https://platform.test', PLATFORM_SUPABASE_SERVICE_ROLE_KEY: 'platform-key' };
const V1 = '10000000-0000-4000-8000-0000000000a1';
const V2 = '10000000-0000-4000-8000-0000000000a2';
const V3 = '10000000-0000-4000-8000-0000000000a3';   // holds no stock

function fakeDb(tables, rpc) {
  const calls = [];
  const from = (table) => {
    const st = { filters: [], range: null, limit: null };
    const run = () => {
      let rows = (tables[table] || []).filter((r) => st.filters.every(([op, k, v]) => (op === 'eq' ? r[k] === v : v.includes(r[k]))));
      if (st.range) rows = rows.slice(st.range[0], st.range[1] + 1);
      if (st.limit != null) rows = rows.slice(0, st.limit);
      return { data: rows, error: null };
    };
    const q = {
      select() { return q; }, order() { return q; },
      eq(k, v) { st.filters.push(['eq', k, v]); return q; },
      in(k, v) { st.filters.push(['in', k, v]); return q; },
      limit(n) { st.limit = n; return q; },
      range(a, b) { st.range = [a, b]; return q; },
      then(res, rej) { return Promise.resolve(run()).then(res, rej); },
    };
    return q;
  };
  return {
    calls, from,
    rpc: async (name, args) => {
      calls.push({ name, args });
      const f = rpc[name];
      return f ? f(args) : { data: null, error: { code: 'PGRST202', message: `Could not find the function public.${name}` } };
    },
  };
}

async function loadNightly(dbs) {
  const file = nodePath.join(EDGE_ROOT, 'supabase/functions/stock-nightly/index.ts');
  let src = fs.readFileSync(file, 'utf8');
  src = src.replace("import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';", 'const createClient = (url) => globalThis.__nightlyDbs[url];');
  src = src.replace(/from '(\.\.?\/[^']+)'/g, (_m, rel) => `from '${pathToFileURL(nodePath.resolve(nodePath.dirname(file), rel)).href}'`);
  assert.doesNotMatch(src, /from 'https:/);
  const out = nodePath.join(os.tmpdir(), `nightly-health-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);
  fs.writeFileSync(out, stripTypeScriptTypes(src, { mode: 'strip' }));
  globalThis.__nightlyDbs = dbs;
  let handler = null;
  globalThis.Deno = { env: { get: (k) => EDGE_ENV[k] }, serve: (h) => { handler = h; } };
  try { await import(pathToFileURL(out).href); } finally { fs.rmSync(out, { force: true }); }
  assert.equal(typeof handler, 'function');
  return handler;
}

const runNightly = async (handler) => {
  const res = await handler(new Request('https://ops.test/functions/v1/stock-nightly', {
    method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${EDGE_ENV.SUPABASE_SERVICE_ROLE_KEY}` }, body: JSON.stringify({ action: 'run' }),
  }));
  return { status: res.status, body: await res.json() };
};

const nightlyTables = () => ({
  locations: [{ id: V1, timezone: 'Europe/London' }, { id: V2, timezone: 'Europe/London' }, { id: V3, timezone: 'Europe/London' }],
  inventory_items: [{ id: 'i1', location_id: V1 }, { id: 'i2', location_id: V2 }],
  venue_clock: [],
});
const dayRpcs = {
  venue_clock_sync: () => ({ data: { ok: true, upserted: 0, mismatches: [], missing: [] }, error: null }),
  stock_day_sums_rebuild: () => ({ data: { ok: true }, error: null }),
  sales_day_sums_rebuild: () => ({ data: { ok: true }, error: null }),
  stock_day_sums_check: () => ({ data: { ok: true }, error: null }),
  sales_day_sums_check: () => ({ data: { ok: true }, error: null }),
  stock_nightly_upkeep: () => ({ data: { pin_tries_purged: 0 }, error: null }),
};

test('the nightly run asks every venue that holds stock for its set up health, after the day totals and before upkeep; one failure is named and the rest go on', async () => {
  const ops = fakeDb(nightlyTables(), {
    ...dayRpcs,
    stock_nightly_health: ({ p_location }) => (p_location === V2
      ? { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } }
      : { data: { location_id: p_location, planned_writes: 3, recipe_planned_writes: 1 }, error: null }),
  });
  const handler = await loadNightly({ [EDGE_ENV.SUPABASE_URL]: ops, [EDGE_ENV.PLATFORM_SUPABASE_URL]: fakeDb({ locations: [] }, {}) });
  const r = await runNightly(handler);
  assert.equal(r.status, 200);
  const health = ops.calls.filter((c) => c.name === 'stock_nightly_health');
  assert.deepEqual(health.map((c) => c.args).sort((a, b) => a.p_location.localeCompare(b.p_location)), [{ p_location: V1 }, { p_location: V2 }], 'each venue that holds stock, once, with only p_location');
  const names = ops.calls.map((c) => c.name);
  assert.ok(names.lastIndexOf('sales_day_sums_check') < names.indexOf('stock_nightly_health'), 'after the day totals');
  // v5.11.90: the drainer health read follows upkeep, so upkeep is no longer the last call.
  assert.ok(names.includes('stock_nightly_upkeep') && names.lastIndexOf('stock_nightly_health') < names.indexOf('stock_nightly_upkeep'), 'upkeep still runs, after every venue');
  assert.equal(r.body.ok, false, 'a real failure is a failed step');
  assert.ok(r.body.errors.some((e) => e.startsWith(`stock_nightly_health ${V2}: canceling statement`)), JSON.stringify(r.body.errors));
  assert.equal(r.body.health.checked, 1);
  assert.deepEqual(r.body.health.out_of_step, [V1]);
  assert.deepEqual(r.body.upkeep, { pin_tries_purged: 0 });
});

test('before 20261024a (no stock_nightly_health) the run skips set up health, says so, and is not a failure', async () => {
  const ops = fakeDb(nightlyTables(), dayRpcs);
  const handler = await loadNightly({ [EDGE_ENV.SUPABASE_URL]: ops, [EDGE_ENV.PLATFORM_SUPABASE_URL]: fakeDb({ locations: [] }, {}) });
  const r = await runNightly(handler);
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true, JSON.stringify(r.body.errors));
  assert.equal(r.body.health.skipped, 'This needs a database update (20261024a). Set up health was not checked.');
  assert.ok(ops.calls.filter((c) => c.name === 'stock_nightly_health').length <= 3, 'stops asking once the database says it has no such function');
  const src = fs.readFileSync(nodePath.join(EDGE_ROOT, 'supabase/functions/stock-nightly/index.ts'), 'utf8');
  assert.doesNotMatch(src, /\.(insert|update|upsert|delete)\(/, 'every write is a database function');
  assert.doesNotMatch(src, /[\u2013\u2014]/);
});
