// src/lib/pushedBy.test.js
//
// 27 Sep 2026: Push to POS is stamped with who pressed it, but config_pushes can be read with the
// public key (online ordering, the kiosk and the booking page read it), so the stamp is a display
// name, never an email address.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pushedByName } from './pushedBy.js';

test('a push is stamped with a display name, never an email', () => {
  assert.equal(pushedByName('Peter Roberts', 'Alex'), 'Peter Roberts');
  assert.equal(pushedByName('  ', null, 'Alex'), 'Alex', 'blank is skipped');
  assert.equal(pushedByName('peter@posup.co.uk', 'Alex'), 'Alex', 'an email is never used');
  assert.equal(pushedByName('peter@posup.co.uk'), 'Manager');
  assert.equal(pushedByName(undefined, null, 42, {}), 'Manager');
  assert.equal(pushedByName(), 'Manager');
  assert.equal(pushedByName('x'.repeat(200)).length, 80, 'kept short');
});
