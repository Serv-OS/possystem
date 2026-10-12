// 12 Oct 2026: a till applies a live update of its device profile. The live update service
// can send a change that carries an error and no row; the realtime library hands that over as
// new = {} (truthy). profileRowToProfile({}) is an all defaults profile: not master, no card
// reader, eat in only. This pin keeps the guard in front of the apply.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../App.jsx', import.meta.url), 'utf8');

test('the device profile live handler ignores a change with an error, with no row, or for another profile', () => {
  const at = app.indexOf("table: 'device_profiles',");
  assert.ok(at > 0, 'the handler is still in App.jsx');
  const body = app.slice(at, at + 1400);
  const guard = body.indexOf('if (payload?.errors?.length || !payload?.new || payload.new.id !== profileId) return;');
  const apply = body.indexOf('applyDeviceConfig(configFromProfile(profileRowToProfile(payload.new))');
  assert.ok(guard > 0, 'the guard is there');
  assert.ok(apply > guard, 'and it runs before the profile is applied');
});

test('what the guard lets through and what it stops', () => {
  const ok = (payload, profileId) => !(payload?.errors?.length || !payload?.new || payload.new.id !== profileId);
  assert.equal(ok({ new: { id: 'p1', is_master: true } }, 'p1'), true);
  assert.equal(ok({ new: {}, errors: ['Error 401: Unauthorized'] }, 'p1'), false, 'the errored change');
  assert.equal(ok({ new: {} }, 'p1'), false, 'a row with no id');
  assert.equal(ok({ new: { id: 'p2' } }, 'p1'), false, 'another profile');
  assert.equal(ok({ new: null }, 'p1'), false);
  assert.equal(ok(undefined, 'p1'), false);
});
