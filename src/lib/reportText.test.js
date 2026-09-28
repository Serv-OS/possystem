import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plainText, checkCustomerText } from './reportText.js';

test('plainText keeps strings and numbers', () => {
  assert.equal(plainText('Table 4'), 'Table 4');
  assert.equal(plainText(12), '12');
  assert.equal(plainText(0), '0');
});

test('plainText never returns an object', () => {
  assert.equal(plainText({ name: 'Sam', phone: '07700900123' }), 'Sam');
  assert.equal(plainText({ label: 'Staff discount' }), 'Staff discount');
  assert.equal(plainText({ id: 'x' }), '');
  assert.equal(plainText({ name: { first: 'Sam' } }), '');
  assert.equal(plainText(null), '');
  assert.equal(plainText(undefined), '');
  assert.equal(plainText(true), '');
  assert.equal(plainText(NaN), '');
  assert.equal(plainText(['Sam', { name: 'Jo' }]), 'Sam, Jo');
});

test('checkCustomerText reads the collection customer object (Leeds crash)', () => {
  const customer = {
    name: 'Sam', email: '', notes: '', phone: '07700900123',
    isASAP: true, collectionISO: '2026-09-28T11:00:00Z', collectionTime: '11:00',
  };
  assert.equal(checkCustomerText(customer), 'Sam');
  assert.equal(checkCustomerText({ ...customer, name: '' }), '07700900123');
  assert.equal(checkCustomerText({ ...customer, name: '  ', phone: '' }), '');
  assert.equal(checkCustomerText('Walk in Jo'), 'Walk in Jo');
  assert.equal(checkCustomerText(null), '');
});
