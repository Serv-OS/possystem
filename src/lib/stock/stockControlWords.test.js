// node --test: the Team 'Stock control' line and the Site groups rules (src/lib/stock/stockControlWords.js,
// Drop 1). Synthetic ids and neutral names only: the repo is public.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STOCK_CONTROL_CHOICES, levelLabel, savedWords, ownsCompany, stockControlLine, canChangeStockControl,
  groupsCardShows, groupFromRow, groupProblem, groupSaveArg, groupSitesWords,
} from './stockControlWords.js';
import { stockLevelOf } from '../../../supabase/functions/_shared/boSectionRules.js';

const A = 'a0000000-0000-4000-8000-00000000000a';   // the company being looked at
const B = 'b0000000-0000-4000-8000-00000000000b';   // another company
const S1 = '10000000-0000-4000-8000-000000000001';
const S2 = '10000000-0000-4000-8000-000000000002';
const S3 = '10000000-0000-4000-8000-000000000003';

test('three choices, lowest first, the database values, the words of the approved list', () => {
  assert.deepEqual(STOCK_CONTROL_CHOICES.map((c) => c.level), ['sites', 'sites_full', 'all']);
  assert.deepEqual(STOCK_CONTROL_CHOICES.map((c) => c.label), ['Their sites', 'Their sites, full control', 'All sites']);
  assert.equal(STOCK_CONTROL_CHOICES[0].words, 'Counts, orders, deliveries, waste, transfers, batches and pars at their own sites, and local items.');
  assert.equal(STOCK_CONTROL_CHOICES[1].words, 'All of that, plus the price here and the supplier here at their own sites.');
  assert.match(STOCK_CONTROL_CHOICES[2].words, /^Edits the company stock list in the sections ticked above\.$/);
  for (const c of STOCK_CONTROL_CHOICES) assert.doesNotMatch(`${c.label} ${c.words}`, /[\u2013\u2014]/);
  assert.ok(Object.isFrozen(STOCK_CONTROL_CHOICES) && Object.isFrozen(STOCK_CONTROL_CHOICES[2]));
  assert.equal(levelLabel('sites_full'), 'Their sites, full control');
  assert.equal(levelLabel(null), 'Their sites', 'null is stored for sites');
  assert.equal(levelLabel('head_office'), 'Their sites', 'never a value the database does not have');
  assert.equal(savedWords('all'), 'Stock control saved: All sites.');
});

test('the line for each kind of login, per company (an owner elsewhere is Their sites here)', () => {
  const line = (profile) => stockControlLine({ profile, companyOrgId: A });
  assert.deepEqual(line({ role: 'manager', org_id: A, stock_control: null }), { words: 'Their sites', canChangeWhy: null, level: 'sites' });
  assert.deepEqual(line({ role: 'manager', org_id: A, stock_control: 'sites_full' }), { words: 'Their sites, full control', canChangeWhy: null, level: 'sites_full' });
  assert.deepEqual(line({ role: 'manager', org_id: A, stock_control: 'all' }), { words: 'All sites', canChangeWhy: null, level: 'all' });
  assert.deepEqual(line({ role: 'owner', org_id: A, stock_control: null }), { words: 'All sites (owner)', canChangeWhy: 'An owner always has All sites.', level: 'all' });
  assert.deepEqual(line({ role: 'owner', org_id: B, stock_control: 'all' }), { words: 'Their sites (belongs to another company)', canChangeWhy: 'This login belongs to another company.', level: 'sites' });
  assert.deepEqual(line({ role: 'manager', org_id: B, stock_control: 'all' }).words, 'Their sites (belongs to another company)');
  assert.deepEqual(line({ role: 'owner', org_id: null }).words, 'Their sites (belongs to another company)', 'a role owner with no company');
  assert.deepEqual(line({ role: 'super_admin', org_id: null }), { words: 'All sites', canChangeWhy: 'ServOS staff always have All sites.', level: 'all' });
  // the company id is compared case blind, like the shared rule
  assert.equal(line({ role: 'manager', org_id: A.toUpperCase(), stock_control: 'all' }).words, 'All sites');
  // a stored value the database would never hold reads as sites
  assert.equal(line({ role: 'manager', org_id: A, stock_control: 'head_office' }).words, 'Their sites');
  // the column missing (before 0a) reads as sites; the org not read is not known
  assert.equal(line({ role: 'manager', org_id: A }).words, 'Their sites');
  assert.deepEqual(line({ role: 'manager' }), { words: 'Not known', canChangeWhy: 'Could not read this login\'s Stock control. Reload the page.', level: null });
  assert.equal(stockControlLine({ profile: { role: 'manager', org_id: A }, companyOrgId: null }).words, 'Not known', 'no company: never guessed');
  assert.equal(stockControlLine().words, 'Not known');
});

test('the line agrees with the shared rule (and so with the database) for every login shape', () => {
  const shapes = [];
  for (const role of ['owner', 'manager', 'super_admin', 'staff', null]) {
    for (const org of [A, B, null]) {
      for (const sc of [null, 'sites', 'sites_full', 'all', 'junk']) shapes.push({ role, org_id: org, stock_control: sc });
    }
  }
  for (const p of shapes) assert.equal(stockControlLine({ profile: p, companyOrgId: A }).level, stockLevelOf(p, A), JSON.stringify(p));
});

test('who may change it: an owner of this company or ServOS staff, never their own, never an owner, never another company', () => {
  const owner = { id: 'u-owner', role: 'owner', orgId: A };
  const staff = { id: 'u-staff', role: 'super_admin', orgId: null };
  const target = { id: 'u-mgr', role: 'manager', org_id: A, stock_control: null };
  const ask = (caller, t = target) => canChangeStockControl({ caller, target: t, companyOrgId: A });
  assert.deepEqual(ask(owner), { ok: true, why: null });
  assert.deepEqual(ask(staff), { ok: true, why: null });
  assert.deepEqual(ask({ id: 'u-other-owner', role: 'owner', orgId: B }), { ok: false, why: 'Only the owner can change this.' }, 'an owner of another company linked here');
  assert.deepEqual(ask({ id: 'u-lead', role: 'manager', orgId: A }), { ok: false, why: 'Only the owner can change this.' }, 'Stock control All sites is not enough');
  assert.deepEqual(ask({ id: 'u-mgr', role: 'manager', orgId: A }), { ok: false, why: 'This is your own login. You cannot change it.' });
  assert.deepEqual(ask(owner, { id: 'u-owner2', role: 'owner', org_id: A }), { ok: false, why: 'An owner always has All sites.' });
  assert.deepEqual(ask(owner, { id: 'u-b', role: 'manager', org_id: B }), { ok: false, why: 'This login belongs to another company.' });
  assert.deepEqual(ask(owner, { id: 'u-x', role: 'manager' }).ok, false, 'not read: never offered');
  assert.deepEqual(ask(null).ok, false);
});

test('owner of this company: role owner with this company, or ServOS staff', () => {
  assert.equal(ownsCompany({ role: 'owner', org_id: A }, A), true);
  assert.equal(ownsCompany({ role: 'owner', orgId: A }, A), true);
  assert.equal(ownsCompany({ role: 'owner', org_id: B }, A), false);
  assert.equal(ownsCompany({ role: 'owner', org_id: null }, A), false);
  assert.equal(ownsCompany({ role: 'manager', org_id: A, stock_control: 'all' }, A), false);
  assert.equal(ownsCompany({ role: 'super_admin' }, A), true);
  assert.equal(ownsCompany(null, A), false);
});

test('the Site groups card: multi site companies, owners and All sites logins only; never a one site company', () => {
  assert.equal(groupsCardShows({ ready: true, multi: true, level: 'all' }), true);
  assert.equal(groupsCardShows({ ready: true, multi: true, level: 'sites_full' }), false);
  assert.equal(groupsCardShows({ ready: true, multi: true, level: 'sites' }), false);
  assert.equal(groupsCardShows({ ready: true, multi: false, level: 'all' }), false, 'one site company: exactly today');
  assert.equal(groupsCardShows({ ready: false, multi: true, level: 'all' }), false);
  assert.equal(groupsCardShows(null), false);
});

test('a group: read from a row or the scope, checked like the database, saved with its version on an edit', () => {
  const rows = [
    { id: 'g1', org_id: A, name: 'North', location_ids: [S1, S2, S1, null], sort_order: 2, row_version: 3 },
    { id: 'g2', name: 'South', locationIds: [S3], sortOrder: 1 },
  ];
  assert.deepEqual(groupFromRow(rows[0]), { id: 'g1', name: 'North', locationIds: [S1, S2], sortOrder: 2, rowVersion: 3 });
  assert.deepEqual(groupFromRow(rows[1]), { id: 'g2', name: 'South', locationIds: [S3], sortOrder: 1, rowVersion: null });
  assert.equal(groupProblem({ name: '  ', locationIds: [S1] }, rows), 'Give the group a name.');
  assert.equal(groupProblem({ name: 'East', locationIds: [] }, rows), 'Pick at least one site.');
  assert.equal(groupProblem({ name: ' north ', locationIds: [S3] }, rows), 'There is already a group called North.');
  assert.equal(groupProblem({ id: 'g1', name: 'NORTH', locationIds: [S1] }, rows), null, 'renaming a group to its own name in other letters');
  assert.equal(groupProblem({ name: 'East', locationIds: [S3] }, rows), null);
  assert.deepEqual(groupSaveArg({ name: ' East ', locationIds: [S1, S1, S2] }, A), { org_id: A, name: 'East', location_ids: [S1, S2], sort_order: 0 });
  assert.deepEqual(groupSaveArg({ id: 'g1', name: 'North', locationIds: [S1], sortOrder: 2, rowVersion: 3 }, A),
    { org_id: A, name: 'North', location_ids: [S1], sort_order: 2, id: 'g1', row_version: 3 });
  const names = { [S1]: 'North Site', [S2]: 'South Site', [S3]: 'East Site' };
  const nameOf = (id) => names[id];
  assert.equal(groupSitesWords({ location_ids: [S1] }, nameOf), 'North Site');
  assert.equal(groupSitesWords({ location_ids: [S1, S2, S3] }, nameOf), 'North Site, South Site and East Site');
  assert.equal(groupSitesWords({ location_ids: [S1, S2, S3, 'x', 'y'] }, nameOf), 'North Site, South Site and 3 more');
  assert.equal(groupSitesWords({ location_ids: ['gone'] }, nameOf), 'A closed site');
  assert.equal(groupSitesWords({}, nameOf), 'No sites');
});

// -- one site companies: today's Team and Location settings screens (Rule 2; the one site check company) --
//
// The proof is the text: undo the Drop 1 edits and the sha256 is main's file (f1a8f397, v5.11.84) from
// its first import line. What is left of the edits only draws something in a multi site company:
// the Stock control line is behind stockMulti (the scope says multi), and the Site groups card draws
// nothing unless groupsCardShows (multi and All sites); goLiveRules.test.js renders that card for a
// one site company and gets nothing at all.

import fs from 'node:fs';
import crypto from 'node:crypto';

const readSrc = (rel) => fs.readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
const sha = (text) => crypto.createHash('sha256').update(text.slice(text.search(/^import /m))).digest('hex');
const once = (text, part, why) => { assert.equal(text.split(part).length - 1, 1, why || part.trim().slice(0, 80)); };
const cut = (text, from, to) => {
  const a = text.indexOf(from);
  const b = text.indexOf(to, a);
  assert.ok(a >= 0 && b > a, `${from.trim().slice(0, 60)} ... ${to.trim().slice(0, 40)}`);
  return text.slice(0, a) + text.slice(b);
};

test('one site: Location settings is main\'s file plus one import and one card line (sha256)', () => {
  const now = readSrc('backoffice/sections/LocationSettings.jsx');
  const IMPORT = "import SiteGroupsCard from './stock/SiteGroupsCard';\n";
  const CARD = '      <SiteGroupsCard />\n';
  once(now, IMPORT);
  once(now, CARD);
  assert.equal(sha(now.replace(IMPORT, '').replace(CARD, '')), '4b6a266b789b8862c3a4a363e20b5c8050e5ed7e92bc5309c1c111278170563e');
  const card = readSrc('backoffice/sections/stock/SiteGroupsCard.jsx');
  assert.ok(card.includes('export default function SiteGroupsCard() {\n  const sc = useStockScope();\n  if (!groupsCardShows(sc)) return null;\n'), 'nothing at all before the scope says multi and All sites');
});

test('one site: the Team screen is main\'s file once the Stock control line is taken out (sha256), and the line needs multi', () => {
  const now = readSrc('backoffice/sections/StaffManager.jsx');
  let t = now;
  once(t, 'isSectionsColumnMissing, canSwitchLoginOn, missingProfileColumn,\n');
  t = t.replace('isSectionsColumnMissing, canSwitchLoginOn, missingProfileColumn,\n', 'isSectionsColumnMissing, canSwitchLoginOn,\n');
  for (const line of [
    "import { useStockScope } from '../StockScope';\n",
    "import { stockApi } from '../../lib/stock/stockApi';\n",
    "import { STOCK_CONTROL_CHOICES, stockControlLine, canChangeStockControl, savedWords } from '../../lib/stock/stockControlWords';\n",
    '    // The login\'s own company (undefined: not read) and its Stock control (null = Their sites).\n',
    '    orgId: p.org_id === undefined ? undefined : (p.org_id ?? null),\n',
    '    stockControl: p.stock_control ?? null,\n',
    '                    {stockMulti && stockControlAccess(sel.id, link)}\n',
  ]) { once(t, line); t = t.replace(line, ''); }
  // the teammate read: the stock columns ride along, today's read and fallbacks are unchanged
  t = cut(t, '// v5.11.86 (multi site stock Drop 1, map 4.25): org_id and stock_control ride along', 'async function readLogins(ids) {');
  once(t, '  let stockCols = ');
  t = cut(t, '  let stockCols = ', '  let hasSections = true;');
  t = t.replace('  let hasSections = true;', "  const read = (cols) => supabase.from('user_profiles').select(cols).in('id', ids);\n  let hasSections = true;");
  t = cut(t, '  // v5.11.86 (multi site stock Drop 1, map 4.25): Stock control, a line on each login card', '  // v5.5.17: BO-access state.');
  t = cut(t, '  // saveStockControl (v5.11.86)', '  // unlinkBOAccess:');
  assert.equal(sha(t), '3464bc3e6a115703f38adb1cad9f4ee2ad1416c9fe9afb2a949720636033ed79', 'everything else is main\'s text byte for byte');
  // the one thing drawn is behind multi; the save is the database function and believes its answer
  assert.match(now, /const stockMulti = !isMock && stockScope\.ready && stockScope\.multi;/);
  assert.equal(now.split('const stockControlAccess = (staffId, link) => {').length - 1, 1, 'defined once');
  assert.equal(now.split('stockControlAccess(').length - 1, 1, 'drawn once, behind stockMulti');
  assert.match(now, /const r = await stockApi\.setStockControl\(link\.authUserId, level\);/);
  assert.match(now, /if \(r\.data\?\.ok !== true \|\| r\.data\?\.level !== level\) \{ showToast\('Not saved\. Reload the page and check\.'/);
  assert.doesNotMatch(now, /\.update\(\{[^}]*stock_control/, 'never a direct write of the column from the browser');
  assert.match(now, /const stockCompanyId = orgCtx\?\.venueOrgId \|\| stockScope\.orgId \|\| null;/, 'the venue\'s company, never the viewer\'s own');
  // a missing stock_control column is asked again without it, never failing the list
  assert.ok(now.includes("missingProfileColumn(res.error, ['bo_sections', 'bo_access']) === 'stock_control') {\n      stockCols = ', org_id';"), 'a missing stock_control is asked again without it');
  // no long dash in anything this change added
  const added = now.split('\n').filter((l) => /Stock control|stockControl|stockMulti|stockCols|STOCK_CONTROL/.test(l));
  for (const l of added) assert.doesNotMatch(l, /[\u2013\u2014]/, l.trim());
});
