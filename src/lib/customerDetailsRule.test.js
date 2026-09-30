/**
 * customerDetailsRule.test.js: the one customer details setting now covers every till order type
 * (Peter, Coffee Boy, 30 Sep 2026). Run: `node --test src/lib/customerDetailsRule.test.js`.
 *
 * The pure rules first; then the wiring, read as text the way tillOrderType.test.js does, so a
 * future edit that puts the old dine in phone requirement back fails here.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  customerDetailsMode, customerFieldsFor, promptsOnTypeChange, sendsWithoutPrompt, customerFormProblem,
  CUSTOMER_DETAILS_MODES,
} from './customerDetailsRule.js';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const has = (text, needle, where) => assert.ok(text.includes(needle), `${where} carries ${needle}`);
const lacks = (text, needle, where) => assert.ok(!text.includes(needle), `${where} no longer carries ${needle}`);

// ── customerDetailsMode ──────────────────────────────────────────────────────

test('customerDetailsMode: the three modes pass, anything else is full', () => {
  for (const m of CUSTOMER_DETAILS_MODES) assert.equal(customerDetailsMode(m), m);
  assert.equal(customerDetailsMode(undefined), 'full');
  assert.equal(customerDetailsMode(null), 'full');
  assert.equal(customerDetailsMode(''), 'full');
  assert.equal(customerDetailsMode('FULL'), 'full');
  assert.equal(customerDetailsMode('phone'), 'full');
});

// ── customerFieldsFor ────────────────────────────────────────────────────────

test('dine in: full requires name and phone, as before', () => {
  assert.deepEqual(customerFieldsFor({ orderType: 'dine-in', mode: 'full' }), { name: true, phone: true, phoneShown: true, address: false });
  // A venue that never saved the setting keeps the old behaviour.
  assert.deepEqual(customerFieldsFor({ orderType: 'dine-in' }), { name: true, phone: true, phoneShown: true, address: false });
});

test('dine in: name and none require only a name, the phone stays on the form as optional (loyalty lookup)', () => {
  for (const mode of ['name', 'none']) {
    assert.deepEqual(customerFieldsFor({ orderType: 'dine-in', mode }), { name: true, phone: false, phoneShown: true, address: false }, mode);
  }
});

test('takeaway and collection: full requires the phone, name and none hide it (v5.5.799 unchanged)', () => {
  for (const orderType of ['takeaway', 'collection']) {
    assert.deepEqual(customerFieldsFor({ orderType, mode: 'full' }), { name: true, phone: true, phoneShown: true, address: false }, orderType);
    assert.deepEqual(customerFieldsFor({ orderType, mode: 'name' }), { name: true, phone: false, phoneShown: false, address: false }, orderType);
    assert.deepEqual(customerFieldsFor({ orderType, mode: 'none' }), { name: true, phone: false, phoneShown: false, address: false }, orderType);
  }
});

test('drive thru is name only whatever the setting; delivery is always the full form with the address', () => {
  for (const mode of CUSTOMER_DETAILS_MODES) {
    assert.deepEqual(customerFieldsFor({ orderType: 'drive-thru', mode }), { name: true, phone: false, phoneShown: false, address: false }, mode);
    assert.deepEqual(customerFieldsFor({ orderType: 'delivery', mode }), { name: true, phone: true, phoneShown: true, address: true }, mode);
  }
});

test('an unknown order type is treated like dine in', () => {
  assert.deepEqual(customerFieldsFor({ orderType: 'bar-tab', mode: 'name' }), customerFieldsFor({ orderType: 'dine-in', mode: 'name' }));
  assert.deepEqual(customerFieldsFor({}), customerFieldsFor({ orderType: 'dine-in', mode: 'full' }));
});

// ── promptsOnTypeChange ──────────────────────────────────────────────────────

test('picking dine in never opens the form; delivery always does', () => {
  for (const mode of CUSTOMER_DETAILS_MODES) {
    assert.equal(promptsOnTypeChange({ orderType: 'dine-in', mode }), false, mode);
    assert.equal(promptsOnTypeChange({ orderType: 'delivery', mode }), true, mode);
  }
});

test('picking takeaway, collection or drive thru opens the form unless the setting is none', () => {
  for (const orderType of ['takeaway', 'collection', 'drive-thru']) {
    assert.equal(promptsOnTypeChange({ orderType, mode: 'full' }), true, orderType);
    assert.equal(promptsOnTypeChange({ orderType, mode: 'name' }), true, orderType);
    assert.equal(promptsOnTypeChange({ orderType, mode: 'none' }), false, orderType);
    assert.equal(promptsOnTypeChange({ orderType }), true, orderType);
  }
});

// ── sendsWithoutPrompt ───────────────────────────────────────────────────────

test('send: a quick type under none goes straight through; with a name any quick type or delivery does', () => {
  for (const orderType of ['takeaway', 'collection', 'drive-thru']) {
    assert.equal(sendsWithoutPrompt({ orderType, mode: 'none', hasName: false }), true, orderType);
    assert.equal(sendsWithoutPrompt({ orderType, mode: 'name', hasName: false }), false, orderType);
    assert.equal(sendsWithoutPrompt({ orderType, mode: 'full', hasName: false }), false, orderType);
    assert.equal(sendsWithoutPrompt({ orderType, mode: 'full', hasName: true }), true, orderType);
  }
  assert.equal(sendsWithoutPrompt({ orderType: 'delivery', mode: 'none', hasName: false }), false);
  assert.equal(sendsWithoutPrompt({ orderType: 'delivery', mode: 'none', hasName: true }), true);
});

test('send: dine in under none goes straight through as an unnamed counter order (Peter, 30 Sep); name and full still open the send modal', () => {
  assert.equal(sendsWithoutPrompt({ orderType: 'dine-in', mode: 'none', hasName: false }), true);
  assert.equal(sendsWithoutPrompt({ orderType: 'dine-in', mode: 'none', hasName: true }), true);
  for (const mode of ['name', 'full']) {
    assert.equal(sendsWithoutPrompt({ orderType: 'dine-in', mode, hasName: false }), false, mode);
    assert.equal(sendsWithoutPrompt({ orderType: 'dine-in', mode, hasName: true }), false, mode);
  }
  assert.equal(sendsWithoutPrompt({ orderType: 'dine-in', mode: undefined, hasName: false }), false, 'unset = full');
});

// ── customerFormProblem ──────────────────────────────────────────────────────

test('form gate: dine in under name attaches on a name alone; under full it still wants the phone', () => {
  assert.equal(customerFormProblem({ orderType: 'dine-in', mode: 'name', name: 'Sam', phone: '' }), null);
  assert.equal(customerFormProblem({ orderType: 'dine-in', mode: 'none', name: 'Sam' }), null);
  assert.equal(customerFormProblem({ orderType: 'dine-in', mode: 'full', name: 'Sam', phone: '' }), 'Name and phone number are required');
  assert.equal(customerFormProblem({ orderType: 'dine-in', mode: 'full', name: 'Sam', phone: '07700 900000' }), null);
});

test('form gate: a name is always needed, whitespace is no name', () => {
  assert.equal(customerFormProblem({ orderType: 'dine-in', mode: 'name', name: '   ' }), 'Customer name is required');
  assert.equal(customerFormProblem({ orderType: 'takeaway', mode: 'none', name: '' }), 'Customer name is required');
  assert.equal(customerFormProblem({ orderType: 'takeaway', mode: 'full', name: '', phone: '07700 900000' }), 'Name and phone number are required');
  assert.equal(customerFormProblem({}), 'Name and phone number are required');
});

test('form gate: delivery wants the address and postcode after the name and phone', () => {
  const base = { orderType: 'delivery', mode: 'none', name: 'Sam', phone: '07700 900000' };
  assert.equal(customerFormProblem({ ...base }), 'Delivery address and postcode are required');
  assert.equal(customerFormProblem({ ...base, address: '1 High St', postcode: '' }), 'Delivery address and postcode are required');
  assert.equal(customerFormProblem({ ...base, address: '1 High St', postcode: 'HD4 7PT' }), null);
  assert.equal(customerFormProblem({ ...base, phone: '' }), 'Name and phone number are required');
});

// ── Wiring ───────────────────────────────────────────────────────────────────

test('CustomerModal asks the rule, not its own takeaway only nameOnly line', () => {
  const src = read('../components/CustomerModal.jsx');
  has(src, "from '../lib/customerDetailsRule'", 'CustomerModal');
  has(src, 'customerFieldsFor({ orderType, mode: takeawayCustomerDetails })', 'CustomerModal');
  has(src, 'customerFormProblem({', 'CustomerModal');
  lacks(src, "(orderType === 'takeaway' || isCollection) && takeawayCustomerDetails !== 'full'", 'CustomerModal');
  // The phone field is on the form when the rule shows it, and only starred when it is required.
  has(src, 'fields.phoneShown', 'CustomerModal');
  has(src, 'fields.phone ?', 'CustomerModal');
  // Dine in copy no longer assumes a floor table.
  has(src, 'Add customer to order', 'CustomerModal');
});

test('POSSurface picks types, sends and shows the Add customer button through the rule, for every order type', () => {
  const src = read('../surfaces/POSSurface.jsx');
  has(src, "from '../lib/customerDetailsRule'", 'POSSurface');
  has(src, 'promptsOnTypeChange({ orderType: t, mode: takeawayCustomerDetails })', 'POSSurface');
  has(src, 'sendsWithoutPrompt({ orderType, mode: takeawayCustomerDetails, hasName', 'POSSurface');
  lacks(src, "takeawayCustomerDetails === 'none' && (t === 'takeaway'", 'POSSurface');
  lacks(src, "takeawayCustomerDetails === 'none' && (orderType === 'takeaway'", 'POSSurface');
  // One customer row, rendered in the walk in header AND the table header (item 7).
  assert.equal(src.split('{customerRow()}').length - 1, 2, 'customerRow renders in both headers');
  has(src, 'Add customer', 'POSSurface');
  // Cancelling the form leaves the order type exactly as it was.
  lacks(src, "if(!customer)setOrderType('dine-in')", 'POSSurface');
  // A table guest with a name but no phone is hydrated too.
  has(src, 'sameGuest(', 'POSSurface');
});

test('Back Office names the setting for every order type', () => {
  const src = read('../backoffice/sections/LocationSettings.jsx');
  has(src, 'Customer details on the till', 'LocationSettings');
  has(src, 'dine in, takeaway, collection and drive thru', 'LocationSettings');
  lacks(src, 'Takeaway customer details</div>', 'LocationSettings');
  has(src, 'takeaway_customer_details: takeawayDetails', 'LocationSettings');   // the key stays
});
