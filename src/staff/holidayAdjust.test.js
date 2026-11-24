// src/staff/holidayAdjust.test.js (5.12.89): holiday balances changed by hand, and hours brought
// over from another site. Shared by workforce-compute and the Back Office.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adjustProblem, transferProblem, samePersonRecords, transferNotes, ledgerBalance } from '../../supabase/functions/_shared/holidayAdjust.js';

test('a correction needs hours and a reason', () => {
  assert.equal(adjustProblem({ hours: 12.5, note: 'Carried over from the old system' }), null);
  assert.equal(adjustProblem({ hours: -4, note: 'Paid in final pay' }), null);
  assert.ok(adjustProblem({ hours: 0, note: 'x y z' }));
  assert.ok(adjustProblem({ hours: 'abc', note: 'x y z' }));
  assert.ok(adjustProblem({ hours: 5, note: '' }));
  assert.ok(adjustProblem({ hours: 501, note: 'typo guard' }));
  assert.ok(adjustProblem());
});

test('a move cannot take more than the old site holds', () => {
  assert.equal(transferProblem({ hours: 10, sourceBalance: 14.48, sourceSite: 'Selfridges' }), null);
  assert.equal(transferProblem({ hours: 14.48, sourceBalance: 14.48 }), null);
  assert.match(transferProblem({ hours: 20, sourceBalance: 14.48, sourceSite: 'Selfridges' }), /Only 14\.5 hours are left at Selfridges/);
  assert.ok(transferProblem({ hours: 0, sourceBalance: 5 }));
  assert.ok(transferProblem({ hours: -3, sourceBalance: 5 }));
  assert.ok(transferProblem({ hours: 3, sourceBalance: 0 }));
});

test('the same person at another site: linked, email, mobile, or name with date of birth', () => {
  const me = { id: 'me', name: 'Sam Jones', email: 'Sam@Example.com', mobile: '07931 129015', dob: '1998-04-02', person_id: 'p1' };
  const found = samePersonRecords(me, [
    { id: 'me', name: 'Sam Jones', email: 'sam@example.com' },
    { id: 'a', name: 'S Jones', person_id: 'p1' },
    { id: 'b', name: 'Samuel', email: ' sam@example.com ' },
    { id: 'c', name: 'Sammy', mobile: '+447931129015' },
    { id: 'd', name: 'sam  jones', dob: '1998-04-02' },
    { id: 'e', name: 'Sam Jones', dob: '1990-01-01' },      // same name, another person
    { id: 'f', name: 'Sam Jones' },                         // a name alone never moves hours
    { id: 'g', name: 'Someone Else', email: 'else@example.com' },
  ]);
  assert.deepEqual(found.map((r) => [r.id, r.why]), [['a', 'linked record'], ['b', 'same email'], ['c', 'same mobile'], ['d', 'same name and date of birth']]);
  assert.deepEqual(samePersonRecords(null, [{ id: 'a' }]), []);
});

test('each site gets a line saying where the hours went', () => {
  const n = transferNotes({ hours: 14.484, fromSite: 'Selfridges', toSite: 'H Mall', note: 'Moved site 1 Nov' });
  assert.equal(n.out, 'Moved 14.48h to H Mall. Moved site 1 Nov');
  assert.equal(n.in, 'Brought over 14.48h from Selfridges. Moved site 1 Nov');
  assert.equal(transferNotes({ hours: 3, fromSite: 'A', toSite: 'B' }).in, 'Brought over 3.00h from A');
});

test('a balance is the sum of the ledger', () => {
  assert.equal(ledgerBalance([{ accrued_hours: 10.5 }, { accrued_hours: -4 }, { accruedHours: 1.25 }]), 7.75);
  assert.equal(ledgerBalance(null), 0);
});
