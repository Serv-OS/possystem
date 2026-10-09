/**
 * salesGroupsMapping.test.js: the per site cache in front of xero-config 'get' that the Sales
 * mix surfaces read a site's Xero groups through.
 * Run: `npm test`, or `node --test src/lib/salesGroupsMapping.test.js`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchSiteMapping, _setMappingFetcher, _resetMappingCache, MAPPING_LIFE_MS, MAPPING_RETRY_MS,
} from './salesGroupsMapping.js';

const T0 = Date.parse('2026-10-08T10:00:00Z');

function counting(answer) {
  const calls = [];
  const fn = async (id) => { calls.push(id); if (typeof answer === 'function') return answer(id); return answer; };
  return { fn, calls };
}

test('a mapping answer gives { mapping, failed: false }; two calls inside the life share one fetch', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: T0 });
  _resetMappingCache();
  const { fn, calls } = counting({ mapping: { groups: { food: { name: 'Food' } } }, detail: {}, postMode: 'sales_invoice' });
  _setMappingFetcher(fn);
  const [a, b] = await Promise.all([fetchSiteMapping('site-1'), fetchSiteMapping('site-1')]);
  assert.deepEqual(a, { mapping: { groups: { food: { name: 'Food' } } }, failed: false });
  assert.equal(a, b, 'the very same promise answer');
  assert.deepEqual(calls, ['site-1']);
  // A number id reads as the same site.
  await fetchSiteMapping(7);
  await fetchSiteMapping('7');
  assert.deepEqual(calls, ['site-1', '7']);
  // Still inside the life: no new call.
  t.mock.timers.setTime(T0 + MAPPING_LIFE_MS - 1);
  await fetchSiteMapping('site-1');
  assert.deepEqual(calls, ['site-1', '7']);
  // Past it: read again.
  t.mock.timers.setTime(T0 + MAPPING_LIFE_MS);
  await fetchSiteMapping('site-1');
  assert.deepEqual(calls, ['site-1', '7', 'site-1']);
  _setMappingFetcher(null);
});

test('a site with no xero_config row (mapping null) is an empty mapping, not a failure', async () => {
  _resetMappingCache();
  _setMappingFetcher(async () => ({ mapping: null, detail: null }));
  assert.deepEqual(await fetchSiteMapping('site-2'), { mapping: {}, failed: false });
  _setMappingFetcher(async () => ({ mapping: 'nonsense' }));
  _resetMappingCache();
  assert.deepEqual(await fetchSiteMapping('site-2'), { mapping: {}, failed: false });
  _setMappingFetcher(async () => undefined);
  _resetMappingCache();
  assert.deepEqual(await fetchSiteMapping('site-2'), { mapping: {}, failed: false });
  _setMappingFetcher(null);
});

test('a call that throws resolves failed and is tried again after a minute, not before', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: T0 });
  _resetMappingCache();
  const { fn, calls } = counting(() => { throw new Error('No access to this location'); });
  _setMappingFetcher(fn);
  assert.deepEqual(await fetchSiteMapping('site-3'), { mapping: {}, failed: true });
  assert.deepEqual(calls, ['site-3']);
  t.mock.timers.setTime(T0 + MAPPING_RETRY_MS - 1);
  assert.deepEqual(await fetchSiteMapping('site-3'), { mapping: {}, failed: true });
  assert.deepEqual(calls, ['site-3'], 'inside the minute the failure is kept');
  t.mock.timers.setTime(T0 + MAPPING_RETRY_MS);
  await fetchSiteMapping('site-3');
  assert.deepEqual(calls, ['site-3', 'site-3'], 'after it the function is asked again');
  // A rejecting promise is the same as a throw.
  _resetMappingCache();
  _setMappingFetcher(() => Promise.reject(new Error('down')));
  assert.deepEqual(await fetchSiteMapping('site-4'), { mapping: {}, failed: true });
  _setMappingFetcher(null);
});

test('the call can be handed in per call; with none at all the read fails softly; no site reads nothing', async () => {
  _resetMappingCache();
  _setMappingFetcher(null);
  assert.deepEqual(await fetchSiteMapping('site-5'), { mapping: {}, failed: true }, 'no reader is a failure, never a throw');
  _resetMappingCache();
  const { fn, calls } = counting({ mapping: { itemGroups: { 'm-1': 'retail' } } });
  assert.deepEqual(await fetchSiteMapping('site-5', fn), { mapping: { itemGroups: { 'm-1': 'retail' } }, failed: false });
  assert.deepEqual(calls, ['site-5']);
  assert.deepEqual(await fetchSiteMapping(null, fn), { mapping: {}, failed: false });
  assert.deepEqual(await fetchSiteMapping('', fn), { mapping: {}, failed: false });
  assert.deepEqual(await fetchSiteMapping(undefined, fn), { mapping: {}, failed: false });
  assert.deepEqual(calls, ['site-5'], 'no site, no call');
  assert.equal(MAPPING_LIFE_MS, 600000);
  assert.equal(MAPPING_RETRY_MS, 60000);
});
