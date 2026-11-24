// src/staff/staffAddress.test.js (5.12.89): the home address rules shared by the staff app, the
// Back Office and staff-portal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalisePostcode, splitAddress, joinAddress, addressProblem, addressIncomplete, addressChangeProblem, fromLookup, postcodeWord, postcodeRequired } from '../../supabase/functions/_shared/staffAddress.js';

test('UK postcode: tidied, spaces and case forgiven, nonsense refused', () => {
  assert.equal(normalisePostcode('ls14ap'), 'LS1 4AP');
  assert.equal(normalisePostcode(' sw1a 1aa '), 'SW1A 1AA');
  assert.equal(normalisePostcode('M1 1AE'), 'M1 1AE');
  assert.equal(normalisePostcode('EC1A1BB'), 'EC1A 1BB');
  for (const bad of ['', 'LS1', '12345', 'ABCDE', 'LS1 4A', 'QQ1 1AA', 'LS1 4AP extra']) assert.equal(normalisePostcode(bad), '', `${bad} should be refused`);
});

test('US ZIP and Irish Eircode', () => {
  assert.equal(normalisePostcode('84101', 'US'), '84101');
  assert.equal(normalisePostcode('84101-1234', 'US'), '84101-1234');
  assert.equal(normalisePostcode('8410', 'US'), '');
  assert.equal(normalisePostcode('d02x285', 'IE'), 'D02 X285');
  assert.equal(postcodeWord('US'), 'ZIP code');
  assert.equal(postcodeWord('UK'), 'Postcode');
  assert.equal(postcodeRequired('UK'), true);
  assert.equal(postcodeRequired('US'), false);
});

test('split: the postcode is the last part, however it was typed', () => {
  assert.deepEqual(splitAddress('12 High Street, Leeds, LS1 4AP'), { street: '12 High Street, Leeds', postcode: 'LS1 4AP' });
  assert.deepEqual(splitAddress('12 High Street Leeds ls14ap'), { street: '12 High Street Leeds', postcode: 'LS1 4AP' });
  assert.deepEqual(splitAddress('Flat 2, 5 Park Row, Leeds LS1 5HD.'), { street: 'Flat 2, 5 Park Row, Leeds', postcode: 'LS1 5HD' });
  assert.deepEqual(splitAddress('12 High Street, Leeds'), { street: '12 High Street, Leeds', postcode: '' });
  assert.deepEqual(splitAddress(''), { street: '', postcode: '' });
  assert.deepEqual(splitAddress(null), { street: '', postcode: '' });
  assert.deepEqual(splitAddress('500 S Main St, Salt Lake City, UT 84101', 'US'), { street: '500 S Main St, Salt Lake City, UT', postcode: '84101' });
  // A five digit house number is not a ZIP code.
  assert.deepEqual(splitAddress('12345 Main St, Provo, UT', 'US'), { street: '12345 Main St, Provo, UT', postcode: '' });
});

test('join then split gives the same two boxes back', () => {
  const stored = joinAddress('12 High Street, Leeds', 'ls14ap');
  assert.equal(stored, '12 High Street, Leeds, LS1 4AP');
  assert.deepEqual(splitAddress(stored), { street: '12 High Street, Leeds', postcode: 'LS1 4AP' });
  // The postcode typed in both boxes is kept once.
  assert.equal(joinAddress('12 High Street, Leeds, LS1 4AP', 'LS1 4AP'), '12 High Street, Leeds, LS1 4AP');
  assert.equal(joinAddress('', ''), '');
  assert.equal(joinAddress('12 High Street,  ', ''), '12 High Street');
});

test('the form: a UK address needs a street and a real postcode; blank clears', () => {
  assert.equal(addressProblem('', ''), null);
  assert.equal(addressProblem('12 High Street, Leeds', 'LS1 4AP'), null);
  assert.match(addressProblem('12 High Street, Leeds', ''), /postcode/i);
  assert.match(addressProblem('', 'LS1 4AP'), /street/i);
  assert.match(addressProblem('12 High Street', 'LEEDS'), /does not look right/);
  // US and Ireland: optional, checked when typed.
  assert.equal(addressProblem('500 S Main St', '', 'US'), null);
  assert.match(addressProblem('500 S Main St', '841', 'US'), /ZIP code/);
  assert.equal(addressProblem('1 Grafton Street, Dublin', '', 'IE'), null);
});

test('Back Office flag: on file with no postcode, UK only', () => {
  assert.equal(addressIncomplete('12 High Street, Leeds'), true);
  assert.equal(addressIncomplete('12 High Street, Leeds, LS1 4AP'), false);
  assert.equal(addressIncomplete(''), false);
  assert.equal(addressIncomplete(null), false);
  assert.equal(addressIncomplete('500 S Main St', 'US'), false);
});

test('server: only a CHANGED UK address with no postcode is refused', () => {
  assert.equal(addressChangeProblem('12 High Street', '12 High Street'), null);       // unchanged old address
  assert.match(addressChangeProblem('14 High Street', '12 High Street'), /postcode/);
  assert.equal(addressChangeProblem('14 High Street, LS1 4AP', '12 High Street'), null);
  assert.equal(addressChangeProblem('', '12 High Street'), null);                     // clearing it
  assert.equal(addressChangeProblem('500 S Main St', '', 'US'), null);
});

test('an address the search found fills both boxes', () => {
  assert.deepEqual(fromLookup({ line1: '12 High Street', city: 'Leeds', postcode: 'ls1 4ap' }), { street: '12 High Street, Leeds', postcode: 'LS1 4AP' });
  assert.deepEqual(fromLookup({ full: '12 High Street, Leeds, LS1 4AP, United Kingdom' }), { street: '12 High Street, Leeds', postcode: 'LS1 4AP' });
  // A result with no full postcode fills none (the form then clears the old one).
  assert.deepEqual(fromLookup({ line1: '12 High Street', city: 'Leeds', postcode: 'LS1' }), { street: '12 High Street, Leeds', postcode: '' });
  // US: the state is kept (review, 23 Nov 2026: line 1 and city alone dropped "UT").
  assert.deepEqual(fromLookup({ line1: '123 Main Street', city: 'Salt Lake City', postcode: '84101', full: '123 Main Street, Salt Lake City, Utah 84101, United States' }, 'US'),
    { street: '123 Main Street, Salt Lake City, Utah', postcode: '84101' });
  assert.deepEqual(fromLookup(null), { street: '', postcode: '' });
});

test('review fixes: line breaks, double spaces, a country after the postcode, and US state and ZIP', () => {
  assert.deepEqual(splitAddress('12 High Street\nLeeds\nLS1 4AP'), { street: '12 High Street\nLeeds', postcode: 'LS1 4AP' });
  assert.equal(addressChangeProblem(joinAddress('12 High Street\nLeeds', 'LS1 4AP'), ''), null);
  assert.deepEqual(splitAddress('12 High Street, Leeds LS1  4AP'), { street: '12 High Street, Leeds', postcode: 'LS1 4AP' });
  assert.deepEqual(splitAddress('12 High Street, Leeds, LS1 4AP, UK'), { street: '12 High Street, Leeds', postcode: 'LS1 4AP' });
  assert.deepEqual(splitAddress('12 High Street, Leeds, LS1 4AP, United Kingdom.'), { street: '12 High Street, Leeds', postcode: 'LS1 4AP' });
  assert.equal(addressIncomplete('12 High Street, Leeds, LS1 4AP, UK'), false);
  // A postcode alone is not an address.
  assert.match(addressChangeProblem('LS1 4AP', ''), /street/);
  // US: "PO Box 12345" is not a ZIP code; the ZIP follows the state with a space and round trips unchanged.
  assert.deepEqual(splitAddress('PO Box 12345', 'US'), { street: 'PO Box 12345', postcode: '' });
  assert.deepEqual(splitAddress('12 Main St, PO Box 12345', 'US'), { street: '12 Main St, PO Box 12345', postcode: '' });
  const us = '500 S Main St, Salt Lake City, UT 84101';
  assert.equal(joinAddress(splitAddress(us, 'US').street, splitAddress(us, 'US').postcode, 'US'), us);
  assert.equal(joinAddress('500 S Main St', '84101', 'US'), '500 S Main St, 84101');
  assert.deepEqual(splitAddress('500 S Main St, 84101', 'US'), { street: '500 S Main St', postcode: '84101' });
  assert.deepEqual(splitAddress('500 S Main St, Salt Lake City, Utah 84101, United States', 'US'), { street: '500 S Main St, Salt Lake City, Utah', postcode: '84101' });
});
