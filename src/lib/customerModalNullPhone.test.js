// customerModalNullPhone.test.js: picking a customer with no phone never crashes the till (v5.9.86).
// Leeds, 27 Sep 2026: "App Error: TypeError: Cannot read properties of null (reading 'replace')"
// after staff picked Simon Hughes (imported, email only, no phone).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

test('the till customer form never stores null in its text fields', () => {
  const src = read('../components/CustomerModal.jsx');
  assert.match(src, /setName\(c\.name \|\| ''\); setPhone\(c\.phone \|\| ''\); setEmail\(c\.email \|\| ''\);/);
  assert.doesNotMatch(src, /setPhone\(c\.phone\)/, 'a picked customer with no phone must not set null');
  assert.match(src, /const phoneDigits = String\(phone \|\| ''\)\.replace/, 'the live search survives a null phone');
});

test('the MPOS capture sheet already guards the same way', () => {
  const src = read('../surfaces/mpos/MCustomerCapture.jsx');
  assert.match(src, /setPhone\(c\.phone \|\| ''\)/);
});
