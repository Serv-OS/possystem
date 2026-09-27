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

// 27 Sep 2026 (review round 3): the Back Office used to settle the name before the button knew
// the staff name, so the button was handed "Manager" and never got further. The raw candidates
// now go down together, in order: the signed in person's names, the profile name (which can be
// an email address, and is then skipped), the staff name, and only then "Manager".
test('the staff name is reached when the signed in person has no display name', () => {
  const candidates = [undefined, undefined, 'peter@posup.co.uk'];   // full_name, name, profile name
  assert.equal(pushedByName(...candidates, 'Alex'), 'Alex');
  assert.equal(pushedByName(...candidates, undefined), 'Manager');
  assert.equal(pushedByName('Peter Roberts', undefined, 'peter@posup.co.uk', 'Alex'), 'Peter Roberts', 'a display name still comes first');
  // The old way: settled first, then offered the staff name. "Manager" won every time.
  assert.equal(pushedByName(pushedByName(...candidates), 'Alex'), 'Manager');
});
