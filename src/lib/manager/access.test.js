/** access.test.js — Manager role-adaptive tab flags. Run: `node --test` */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roleFlags, TABS } from './access.js';

test('owner: every tab + all venues', () => {
  const f = roleFlags('owner');
  assert.equal(f.reports_view, true);
  assert.equal(f.team_approvals, true);
  assert.equal(f.multi_venue, 'all');
  assert.equal(TABS.filter((t) => f[t.flag]).length, 5);
});
test('manager: every tab, own venues', () => {
  const f = roleFlags('Manager');           // case-insensitive
  assert.equal(f.team_approvals, true);
  assert.equal(f.multi_venue, 'mine');
  assert.equal(TABS.filter((t) => f[t.flag]).length, 5);
});
test('supervisor: reports read-only, no approvals', () => {
  const f = roleFlags('supervisor');
  assert.equal(f.reports_view, true);
  assert.equal(f.reports_readonly, true);
  assert.equal(f.team_approvals, false);
});
test('staff: only Home + Ops + Kitchen', () => {
  const f = roleFlags('staff');
  const tabs = TABS.filter((t) => f[t.flag]).map((t) => t.key);
  assert.deepEqual(tabs, ['home', 'ops', 'kitchen']);
});
test('unknown role → staff (safe minimum)', () => {
  assert.deepEqual(roleFlags('weird'), roleFlags('staff'));
  assert.deepEqual(roleFlags(null), roleFlags('staff'));
});
test('per-person permission widens a flag without changing role', () => {
  const f = roleFlags('staff', ['manager_reports']);
  assert.equal(f.reports_view, true);
  assert.ok(TABS.filter((t) => f[t.flag]).map((t) => t.key).includes('reports'));
});
