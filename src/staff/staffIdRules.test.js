// src/staff/staffIdRules.test.js (5.12.85): the team member's own date of birth and ID number rules,
// shared by the staff-portal and the staff app.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NI_RE, normaliseNi, formatNi, niProblem, ssnLast4Problem, dobProblem, ageOn, idNumberKind, idDetailsStep } from '../../supabase/functions/_shared/staffIdRules.js';

test('NI number: HMRC format, spaces and case forgiven', () => {
  assert.equal(niProblem('AB 12 34 56 C'), null);
  assert.equal(niProblem('ab123456c'), null);
  assert.ok(niProblem('QQ 12 34 56 C'));   // HMRC's own placeholder: Q is never a first letter
  assert.equal(niProblem(''), null);          // blank = leave it blank
  assert.equal(niProblem(null), null);
  assert.equal(normaliseNi(' ab 12 34 56 c '), 'AB123456C');
  assert.equal(formatNi('AB123456C'), 'AB 12 34 56 C');
  assert.equal(formatNi('nonsense'), 'nonsense');
  for (const bad of ['AB12345C', 'AB1234567C', 'AB123456E', 'DA123456A', 'AO123456A', 'BG123456A', 'GB123456A', 'NK123456A', 'ZZ123456A', 'Q1123456A', '123456']) {
    assert.ok(niProblem(bad), `${bad} should be refused`);
    assert.ok(!NI_RE.test(normaliseNi(bad)));
  }
});

test('SSN last 4: exactly four digits or blank', () => {
  assert.equal(ssnLast4Problem('1234'), null);
  assert.equal(ssnLast4Problem(''), null);
  assert.ok(ssnLast4Problem('123'));
  assert.ok(ssnLast4Problem('12345'));
  assert.ok(ssnLast4Problem('12a4'));
});

test('date of birth: real past date, age 13 to 100', () => {
  const today = '2026-11-20';
  assert.equal(dobProblem('1990-05-14', today), null);
  assert.equal(dobProblem('', today), null);
  assert.equal(dobProblem('2013-11-20', today), null);                 // exactly 13 today
  assert.ok(dobProblem('2013-11-21', today));                          // 13 tomorrow: too young
  assert.ok(dobProblem('1925-11-19', today));                          // 101: over 100
  assert.equal(dobProblem('1926-11-20', today), null);                 // exactly 100
  assert.ok(dobProblem('2027-01-01', today));                          // future
  assert.ok(dobProblem('2026-11-20', today));                          // today
  assert.ok(dobProblem('1990-02-30', today));                          // not a real date
  assert.ok(dobProblem('14/05/1990', today));                          // wrong shape
  assert.ok(dobProblem('1990-13-01', today));
  assert.equal(ageOn('2000-02-29', '2026-02-28'), 25);
  assert.equal(ageOn('2000-02-29', '2026-03-01'), 26);
});

test('which ID number the venue uses and the checklist step', () => {
  const uk = { payrollFields: ['bankSortCode', 'bankAccount', 'bankAccountName', 'niNumber', 'taxCode'] };
  const us = { payrollFields: ['ssnLast4', 'payrollEmployeeId'] };
  const ie = { payrollFields: ['bankAccount', 'bankAccountName'] };
  assert.equal(idNumberKind(uk), 'ni');
  assert.equal(idNumberKind(us), 'ssn4');
  assert.equal(idNumberKind(ie), null);
  assert.equal(idNumberKind(null), null);

  assert.deepEqual(idDetailsStep({ dob: null, ni_number: null }, uk), { done: false, label: 'Add your date of birth and NI number', missing: ['date of birth', 'NI number'] });
  assert.deepEqual(idDetailsStep({ dob: '1990-05-14', ni_number: null }, uk).missing, ['NI number']);
  assert.equal(idDetailsStep({ dob: '1990-05-14', ni_number: 'AB123456C' }, uk).done, true);
  // The UK step never asks for an SSN, the US one never for an NI number.
  assert.equal(idDetailsStep({ dob: '1990-05-14', ni_number: 'AB123456C' }, us).done, false);
  assert.deepEqual(idDetailsStep({ dob: '1990-05-14', ssn_last4: '1234' }, us), { done: true, label: 'Add your date of birth and SSN last 4', missing: [] });
  assert.deepEqual(idDetailsStep({ dob: null }, ie), { done: false, label: 'Add your date of birth', missing: ['date of birth'] });
  assert.equal(idDetailsStep(null, ie).done, false);
});
