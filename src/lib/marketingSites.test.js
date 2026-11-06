// marketingSites.test.js (6 Nov 2026, 5.12.69): the organisation owns, the sites use.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rowSiteIds, onSite, filterOnSite, siteBadge, defaultScope, siteChoiceKey, readSiteChoice, writeSiteChoice, siteList, siteReportRow, siteReportRows, SHARED_NOTE } from './marketingSites.js';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const venues = [{ id: A, name: 'Leeds' }, { id: B, name: 'Hudds' }];

test('rowSiteIds: each kind keeps its scope somewhere else, one reader', () => {
  assert.deepEqual(rowSiteIds('campaign', { schedule: { location_ids: [A, B] } }), [A, B]);
  assert.deepEqual(rowSiteIds('campaign', { schedule: {} }), []);
  assert.deepEqual(rowSiteIds('automation', { entry_trigger: { type: 'lapsed', location_ids: [B.toUpperCase()] } }), [B]);
  for (const type of ['signup', 'manual', 'form_submitted']) assert.deepEqual(rowSiteIds('automation', { entry_trigger: { type, location_ids: [B] } }), [], `${type} never carries a scope`);
  assert.deepEqual(rowSiteIds('offer', { venue_ids: [A, 'junk', A] }), [A]);
  assert.deepEqual(rowSiteIds('offer', { venue_ids: null }), []);
  assert.deepEqual(rowSiteIds('form', { location_id: B }), [B]);
  assert.deepEqual(rowSiteIds('form', { location_id: null }), []);
  assert.deepEqual(rowSiteIds('campaign', null), []);
  assert.deepEqual(rowSiteIds('other', { schedule: { location_ids: [A] } }), []);
});

test('onSite and filterOnSite: All sites shows everything; one site shows its own and the shared', () => {
  assert.equal(onSite([], ''), true);
  assert.equal(onSite([A], ''), true);
  assert.equal(onSite([], A), true, 'aimed at every site shows on every site');
  assert.equal(onSite([A], A), true);
  assert.equal(onSite([A], B), false);
  assert.equal(onSite([A], A.toUpperCase()), true, 'case never matters');
  const rows = [
    { id: 1, schedule: { location_ids: [] } },
    { id: 2, schedule: { location_ids: [A] } },
    { id: 3, schedule: { location_ids: [B] } },
    { id: 4, schedule: { location_ids: [A, B] } },
  ];
  assert.deepEqual(filterOnSite('campaign', rows, '').map((r) => r.id), [1, 2, 3, 4]);
  assert.deepEqual(filterOnSite('campaign', rows, A).map((r) => r.id), [1, 2, 4]);
  assert.deepEqual(filterOnSite('campaign', rows, C).map((r) => r.id), [1], 'a site nothing is aimed at still sees the shared');
  assert.deepEqual(filterOnSite('offer', [{ venue_ids: [B] }, { venue_ids: [] }], A), [{ venue_ids: [] }]);
  assert.deepEqual(filterOnSite('form', [{ location_id: A }, { location_id: null }], B), [{ location_id: null }]);
  assert.throws(() => filterOnSite('nope', [], ''), /unknown kind/);
  assert.deepEqual(filterOnSite('campaign', null, ''), []);
});

test('siteBadge and defaultScope: the words on a row, what a new thing is aimed at', () => {
  assert.equal(siteBadge([], venues), 'All sites');
  assert.equal(siteBadge([A, B], venues), 'Leeds, Hudds');
  assert.equal(siteBadge([C], venues), 'a venue no longer here');
  assert.deepEqual(defaultScope(''), []);
  assert.deepEqual(defaultScope(null), []);
  assert.deepEqual(defaultScope(A.toUpperCase()), [A]);
  assert.deepEqual(defaultScope('junk'), [], 'a non id never becomes a scope');
});

test('the remembered choice: per venue key, All sites when nothing or a gone venue, never throws', () => {
  const mem = new Map();
  const store = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) };
  assert.equal(siteChoiceKey('loc1'), 'rpos-mkt-site:loc1');
  assert.equal(siteChoiceKey(''), 'rpos-mkt-site:none');
  assert.equal(readSiteChoice(store, 'loc1', venues), '');
  writeSiteChoice(store, 'loc1', A.toUpperCase());
  assert.equal(readSiteChoice(store, 'loc1', venues), A);
  assert.equal(readSiteChoice(store, 'loc2', venues), '', 'another signed in venue has its own choice');
  assert.equal(readSiteChoice(store, 'loc1', [{ id: B, name: 'Hudds' }]), '', 'a venue the company no longer has = All sites');
  assert.equal(readSiteChoice(store, 'loc1', [{ id: A, name: 'Leeds' }]), '', 'one venue left: no choice exists, even the remembered one');
  writeSiteChoice(store, 'loc1', '');
  assert.equal(mem.has('rpos-mkt-site:loc1'), false, 'All sites is the absence of a choice');
  const broken = { getItem: () => { throw new Error('private'); }, setItem: () => { throw new Error('private'); }, removeItem: () => { throw new Error('private'); } };
  assert.equal(readSiteChoice(broken, 'loc1', venues), '');
  assert.doesNotThrow(() => writeSiteChoice(broken, 'loc1', A));
  assert.equal(readSiteChoice(null, 'loc1', venues), '');
  assert.doesNotThrow(() => writeSiteChoice(null, 'loc1', A));
});

test('siteList: the report venues (location_id) and the picker venues (id) read the same; dupes and blanks dropped', () => {
  assert.deepEqual(siteList([{ location_id: A, name: 'Leeds' }, { id: A, name: 'Leeds again' }, { id: '', name: 'x' }, { id: B }]), [{ id: A, name: 'Leeds' }, { id: B, name: 'Unnamed site' }]);
  assert.deepEqual(siteList(null), []);
});

test('siteReportRow and siteReportRows: one site of the By site split', () => {
  const rep = {
    venues: [{ location_id: A, name: 'Leeds', sent: 10, revenue: 5 }, { location_id: B, name: 'Hudds', sent: 2 }],
    campaigns: [{ campaign_id: 'c1', name: 'Birthday', status: 'active', venues: [{ location_id: A, sent: 7 }] }, { campaign_id: 'c2', name: 'Quiet', venues: [] }],
    workflows: [{ workflow_id: 'w1', name: 'Welcome', venues: [{ location_id: B, sent: 1 }, { location_id: A, sent: 3 }] }],
  };
  assert.equal(siteReportRow(rep, ''), null);
  assert.equal(siteReportRow(rep, A).sent, 10);
  assert.equal(siteReportRow(rep, C), null);
  assert.deepEqual(siteReportRows(rep, A).map((x) => [x.kind, x.name, x.v.sent]), [['Campaign', 'Birthday', 7], ['Automation', 'Welcome', 3]]);
  assert.deepEqual(siteReportRows(rep, B).map((x) => x.name), ['Welcome']);
  assert.deepEqual(siteReportRows(rep, ''), []);
  assert.deepEqual(siteReportRows(null, A), []);
  assert.match(SHARED_NOTE, /organisation/);
});
