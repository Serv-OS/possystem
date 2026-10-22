/**
 * plateCostsRead.test.js: plate costs from the database (v5.11.93, multi site stock Drop 2,
 * contract 3.1). Run: npm test. Synthetic ids and amounts: the repo is public.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plateCostMap, readPlateCosts, readPlateCostMap, costOrFallback, PLATE_PAGES_MAX } from './plateCostsRead.js';

const L1 = 'a1000000-0000-4000-8000-000000000001';
const row = (id, cost, extra = {}) => ({ menu_item_id: id, site_recipe_id: `sr-${id}`, recipe_id: `cr-${id}`, cost, ...extra });

/** A stand in api: pages answered in order, every call recorded. */
function fakeApi(pages) {
  const calls = [];
  return {
    calls,
    plateCosts: async (loc, after) => {
      calls.push([loc, after]);
      const p = pages.shift();
      if (p === undefined) return { data: { rows: [], next: null }, error: null, needsUpdate: false };
      if (typeof p === 'function') return p();
      return p;
    },
  };
}
const page = (rows, next = null) => ({ data: { rows, next }, error: null, needsUpdate: false, conflict: null, queued: [] });

test('plateCostMap: a Map keyed on the menu item id as text; a row with no cost is left out, never 0', () => {
  const m = plateCostMap([row('m1', 2.5), row(77, '1.25'), row('m3', null), row('m4', 'abc'), row(null, 1), null, row('', 3), row('m5', 0)]);
  assert.deepEqual([...m.entries()], [['m1', 2.5], ['77', 1.25], ['m5', 0]]);
  assert.equal(plateCostMap(null).size, 0);
  assert.equal(plateCostMap([]).size, 0);
});

test('readPlateCosts: pages by next until null, the site named on every call, all the rows together', async () => {
  const api = fakeApi([page([row('m1', 1), row('m2', 2)], 'm2'), page([row('m3', 3)], 'm3'), page([], null)]);
  const r = await readPlateCosts(api, L1);
  assert.deepEqual(r, { data: [row('m1', 1), row('m2', 2), row('m3', 3)], error: null, needsUpdate: false });
  assert.deepEqual(api.calls, [[L1, null], [L1, 'm2'], [L1, 'm3']]);
  // one page with next null: one call
  const one = fakeApi([page([row('m1', 1)], null)]);
  assert.equal((await readPlateCosts(one, L1)).data.length, 1);
  assert.equal(one.calls.length, 1);
  // an empty first page: no rows, one call
  const none = fakeApi([page([], null)]);
  assert.deepEqual((await readPlateCosts(none, L1)).data, []);
  // a page with rows but a next that is empty text stops too
  const blank = fakeApi([page([row('m1', 1)], '')]);
  assert.equal((await readPlateCosts(blank, L1)).data.length, 1);
  assert.equal(blank.calls.length, 1);
});

test('readPlateCosts: a failed page is a failure with the database words; a missing function is needsUpdate; a throw never escapes', async () => {
  const refused = fakeApi([page([row('m1', 1)], 'm1'), { data: null, error: new Error('Not allowed: that site is not in your reach.'), needsUpdate: false }]);
  const r = await readPlateCosts(refused, L1);
  assert.equal(r.data, null); assert.match(r.error.message, /Not allowed/); assert.equal(r.needsUpdate, false);
  const missing = fakeApi([{ data: null, error: new Error('This needs a database update. Ask ServOS to run it.'), needsUpdate: true }]);
  const m = await readPlateCosts(missing, L1);
  assert.equal(m.data, null); assert.equal(m.needsUpdate, true); assert.match(m.error.message, /database update/);
  const thrown = fakeApi([() => { throw new Error('Failed to fetch'); }]);
  const t = await readPlateCosts(thrown, L1);
  assert.match(t.error.message, /Failed to fetch/); assert.equal(t.needsUpdate, false);
  // junk answers are no rows, not a crash
  const junk = fakeApi([{ data: 'nope', error: null }]);
  assert.deepEqual((await readPlateCosts(junk, L1)).data, []);
  // no api, no site
  assert.match((await readPlateCosts(null, L1)).error.message, /No database/);
  assert.match((await readPlateCosts({}, L1)).error.message, /No database/);
  assert.match((await readPlateCosts(fakeApi([]), null)).error.message, /No site/);
});

test('readPlateCosts: a read that never ends is cut at the page limit and says so', async () => {
  let n = 0;
  const endless = { plateCosts: async () => { n += 1; return page([row(`m${n}`, 1)], `m${n}`); } };
  const r = await readPlateCosts(endless, L1, { maxPages: 3 });
  assert.equal(n, 3); assert.equal(r.data, null); assert.match(r.error.message, /Too many rows/);
  assert.equal(PLATE_PAGES_MAX, 50);
});

test('readPlateCostMap: the Map of every page; an error or needsUpdate comes through as is', async () => {
  const api = fakeApi([page([row('m1', 1.5), row('m2', null)], 'm2'), page([row('m3', 3)], null)]);
  const r = await readPlateCostMap(api, L1);
  assert.deepEqual([...r.data.entries()], [['m1', 1.5], ['m3', 3]]);
  assert.equal(r.error, null); assert.equal(r.needsUpdate, false);
  const m = await readPlateCostMap(fakeApi([{ data: null, error: new Error('x'), needsUpdate: true }]), L1);
  assert.equal(m.data, null); assert.equal(m.needsUpdate, true);
});

test('costOrFallback: the database first; today\'s maths only on needsUpdate; any other refusal is the answer', async () => {
  const dbMap = new Map([['m1', 2]]);
  const todayMap = new Map([['m1', 2.1]]);
  let todayAsked = 0;
  const today = async () => { todayAsked += 1; return { data: todayMap, error: null }; };
  const ok = await costOrFallback(async () => ({ data: dbMap, error: null, needsUpdate: false }), today);
  assert.deepEqual(ok, { data: dbMap, error: null, via: 'database' });
  assert.equal(todayAsked, 0, 'the database answered: today\'s maths never run');
  const fb = await costOrFallback(async () => ({ data: null, error: new Error('needs update'), needsUpdate: true }), today);
  assert.deepEqual(fb, { data: todayMap, error: null, via: 'today' });
  assert.equal(todayAsked, 1);
  const refused = await costOrFallback(async () => ({ data: null, error: new Error('Not allowed'), needsUpdate: false }), today);
  assert.equal(refused.data, null); assert.match(refused.error.message, /Not allowed/); assert.equal(refused.via, 'database');
  assert.equal(todayAsked, 1, 'a refusal is not a reason to run today\'s maths');
  // throws never escape, from either reader
  const dbThrew = await costOrFallback(async () => { throw new Error('offline'); }, today);
  assert.match(dbThrew.error.message, /offline/); assert.equal(dbThrew.via, 'database');
  const todayThrew = await costOrFallback(async () => ({ data: null, error: null, needsUpdate: true }), async () => { throw new Error('ctx failed'); });
  assert.match(todayThrew.error.message, /ctx failed/); assert.equal(todayThrew.via, 'today'); assert.equal(todayThrew.data, null);
  const todayFailed = await costOrFallback(async () => ({ needsUpdate: true }), async () => ({ data: null, error: new Error('no recipes') }));
  assert.match(todayFailed.error.message, /no recipes/);
  const empty = await costOrFallback(async () => null, today);
  assert.deepEqual(empty, { data: null, error: null, via: 'database' });
});

test('no em or en dash in the reader or this test', async () => {
  const fs = await import('node:fs');
  for (const f of ['./plateCostsRead.js', './plateCostsRead.test.js']) {
    assert.doesNotMatch(fs.readFileSync(new URL(f, import.meta.url), 'utf8'), /[\u2013\u2014]/, f);
  }
});
