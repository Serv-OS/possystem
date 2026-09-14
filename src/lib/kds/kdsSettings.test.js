// KDS per screen settings (v5.8.66).

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  KDS_DEFAULTS, KDS_TOGGLES, clampThresholds, normaliseKdsSettings, isMissingColumnError,
  isManagerStaff, matchManagerPin, kdsSettingsStorageKey,
} from './kdsSettings.js';

test('defaults: 10 and 15 minutes, colour by type, comfortable, every switch on', () => {
  const s = normaliseKdsSettings(null);
  assert.equal(s.caution, 10);
  assert.equal(s.late, 15);
  assert.equal(s.colour, 'type');
  assert.equal(s.density, 'comfortable');
  assert.equal(Object.keys(s.show).length, KDS_TOGGLES.length);
  assert.ok(Object.values(s.show).every(v => v === true));
  assert.deepEqual(Object.keys(KDS_DEFAULTS.show), KDS_TOGGLES.map(([k]) => k));
});

test('the switches Peter asked for are all there', () => {
  const keys = KDS_TOGGLES.map(([k]) => k);
  for (const k of ['name', 'source', 'timer', 'course', 'notes', 'counts', 'rail', 'staff', 'covers', 'heldToEnd']) {
    assert.ok(keys.includes(k), k);
  }
});

test('clampThresholds: the stepper rules from the design', () => {
  assert.deepEqual(clampThresholds(14, 15, 'caution'), { caution: 14, late: 15 });
  assert.deepEqual(clampThresholds(15, 15, 'caution'), { caution: 15, late: 16 });
  assert.deepEqual(clampThresholds(0, 15, 'caution'), { caution: 1, late: 15 });
  assert.deepEqual(clampThresholds(10, 10, 'late'), { caution: 9, late: 10 });
  assert.deepEqual(clampThresholds(10, 500, 'late'), { caution: 10, late: 120 });
  assert.deepEqual(clampThresholds(10, 1, 'late'), { caution: 1, late: 2 });
  assert.deepEqual(clampThresholds('', 'abc'), { caution: 10, late: 15 });
  assert.deepEqual(clampThresholds('12', '25'), { caution: 12, late: 25 });
});

test('normaliseKdsSettings: keeps good values, repairs bad ones, reads a JSON string', () => {
  const s = normaliseKdsSettings(JSON.stringify({ colour: 'status', density: 'compact', caution: 20, late: 18, show: { rail: false, name: 'no' } }));
  assert.equal(s.colour, 'status');
  assert.equal(s.density, 'compact');
  assert.equal(s.late, 18);
  assert.equal(s.caution, 17);
  assert.equal(s.show.rail, false);
  assert.equal(s.show.name, true);
  assert.equal(normaliseKdsSettings({ colour: 'pink' }).colour, 'type');
  assert.equal(normaliseKdsSettings('{bad json').caution, 10);
});

test('isMissingColumnError spots the migration not being run yet', () => {
  assert.equal(isMissingColumnError({ code: 'PGRST204', message: "Could not find the 'meta' column of 'kds_tickets' in the schema cache" }, 'meta'), true);
  assert.equal(isMissingColumnError({ code: '42703', message: 'column devices.kds_settings does not exist' }, 'kds_settings'), true);
  assert.equal(isMissingColumnError({ code: '42501', message: 'permission denied' }, 'meta'), false);
  assert.equal(isMissingColumnError(null, 'meta'), false);
});

test('manager PIN: Manager role or manager permission, active, with a PIN', () => {
  const staff = [
    { id: 1, role: 'Server', pin: '1111' },
    { id: 2, role: 'Manager', pin: '2222' },
    { id: 3, role: 'Chef', pin: '3333', permissions: ['manager'] },
    { id: 4, role: 'Manager', pin: '4444', active: false },
    { id: 5, role: 'manager', pin: null },
  ];
  assert.equal(matchManagerPin(staff, '1111'), null);
  assert.equal(matchManagerPin(staff, '2222').id, 2);
  assert.equal(matchManagerPin(staff, '3333').id, 3);
  assert.equal(matchManagerPin(staff, '4444'), null);
  assert.equal(matchManagerPin(staff, ''), null);
  assert.equal(isManagerStaff(staff[4]), true);
});

test('storage key is per device', () => {
  assert.notEqual(kdsSettingsStorageKey('a'), kdsSettingsStorageKey('b'));
  assert.equal(kdsSettingsStorageKey(null), 'rpos-kds-settings-local');
});
