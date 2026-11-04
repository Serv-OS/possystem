// src/staff/docTemplatesOrder.test.js
//
// 5.12.58 (Peter's decision 4.1, 4 Nov 2026): a venue's own saved templates come first, the first
// one preselected (onboarding takes list[0]), and the built in ones are last, still there to pick.
// A US venue is never offered the built in UK contract (5.12.57, unchanged).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { templatesForVenue } from './docTemplates.js';

const ids = (list) => list.map((t) => t.id);

test('UK with two saved contracts: saved A, saved B, then the built in last', () => {
  const own = [{ id: 'a', kind: 'contract', name: 'Contract A' }, { id: 'b', kind: 'contract', name: 'Contract B' }];
  assert.deepEqual(ids(templatesForVenue(own, { kind: 'contract', country: 'UK' })), ['a', 'b', 'builtin-contract']);
  // The whole list keeps the same rule: own first, built ins last.
  assert.deepEqual(ids(templatesForVenue(own, { country: 'UK' })), ['a', 'b', 'builtin-offer', 'builtin-contract']);
});

test('UK with no saved template: the built in only, so there is always something to send', () => {
  assert.deepEqual(ids(templatesForVenue([], { kind: 'contract', country: 'UK' })), ['builtin-contract']);
  assert.deepEqual(ids(templatesForVenue([], { kind: 'offer', country: 'UK' })), ['builtin-offer']);
  assert.deepEqual(ids(templatesForVenue(undefined, { kind: 'contract', country: 'UK' })), ['builtin-contract']);
});

test('US: never the built in contract, own first, the offer letter still last', () => {
  const own = [{ id: 'a', kind: 'contract', name: 'Agreement' }, { id: 'o', kind: 'offer', name: 'Offer' }];
  assert.deepEqual(ids(templatesForVenue(own, { kind: 'contract', country: 'US' })), ['a']);
  assert.deepEqual(ids(templatesForVenue([], { kind: 'contract', country: 'US' })), []);
  assert.deepEqual(ids(templatesForVenue(own, { kind: 'offer', country: 'US' })), ['o', 'builtin-offer']);
  assert.ok(!templatesForVenue(own, { country: 'US' }).some((t) => t.id === 'builtin-contract'));
});

test('the built in copies are the same objects, not changed by the ordering', () => {
  const own = [{ id: 'a', kind: 'contract', name: 'Contract A' }];
  const list = templatesForVenue(own, { kind: 'contract', country: 'UK' });
  assert.equal(list[0], own[0]);
  assert.equal(list[1].builtin, true);
});
