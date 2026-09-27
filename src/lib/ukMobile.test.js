// src/lib/ukMobile.test.js
//
// THE CUSTOMER DISPLAY TAKES ONLY A REAL UK MOBILE (27 Sep 2026). Peter: a customer typed
// 0776295512 (ten digits) and the till made a loyalty profile for a number that is nobody's.
// Run: `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  isUkMobile, normaliseUkMobile, ukRuleApplies, displayNumberAccepted, CHECK_NUMBER_TEXT,
} from './ukMobile.js';

const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const code = (src) => src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

test("Peter's cases: the ten digit mistype is refused, real mobiles in every written form pass", () => {
  assert.equal(isUkMobile('0776295512'), false, 'ten digits: one short');
  assert.equal(isUkMobile('07762955142'), true);
  assert.equal(isUkMobile('+447762955142'), true);
  assert.equal(isUkMobile('447762955142'), true);
  assert.equal(isUkMobile('07762 955 142'), true, 'spaces are fine');
  assert.equal(isUkMobile(' 07762  955142 '), true);
  assert.equal(isUkMobile('+44 7762 955142'), true);
});

test('not a UK mobile: landlines, letters, empty, too long, the wrong prefix, stray symbols', () => {
  assert.equal(isUkMobile('01132 496 000'), false, 'a landline');
  assert.equal(isUkMobile('+441132496000'), false, 'a landline in +44 form');
  assert.equal(isUkMobile('077629551ab'), false, 'letters');
  assert.equal(isUkMobile('abc'), false);
  assert.equal(isUkMobile(''), false);
  assert.equal(isUkMobile('   '), false);
  assert.equal(isUkMobile(null), false);
  assert.equal(isUkMobile(undefined), false);
  assert.equal(isUkMobile('077629551421'), false, 'twelve digits');
  assert.equal(isUkMobile('7762955142'), false, 'the leading 0 missing (a live Coffee Boy record)');
  assert.equal(isUkMobile('0782862725'), false, 'ten digits (a live Coffee Boy record)');
  assert.equal(isUkMobile('+4407762955142'), false, 'a 0 after the country code');
  assert.equal(isUkMobile('004477629551 42'), false, '00 is not one of the forms');
  assert.equal(isUkMobile('07762-955142'), false, 'dashes are not spaces');
  assert.equal(isUkMobile('+1 801 555 1234'), false, 'a US number');
  assert.equal(isUkMobile('07+762955142'), false, 'a + in the middle');
});

test('the stored form is the one the till saves (+44 and the national number)', () => {
  assert.equal(normaliseUkMobile('07762 955 142'), '+447762955142');
  assert.equal(normaliseUkMobile('447762955142'), '+447762955142');
  assert.equal(normaliseUkMobile('+447762955142'), '+447762955142');
  assert.equal(normaliseUkMobile('0776295512'), null);
  assert.equal(normaliseUkMobile(''), null);
});

test('only a UK till uses the UK rule; a US or EU till keeps the old seven digit rule', () => {
  assert.equal(ukRuleApplies('GBP'), true);
  assert.equal(ukRuleApplies('gbp'), true);
  assert.equal(ukRuleApplies(''), true, 'a currency not known yet counts as the UK (the app default)');
  assert.equal(ukRuleApplies(undefined), true);
  assert.equal(ukRuleApplies('USD'), false);
  assert.equal(ukRuleApplies('EUR'), false);
  assert.equal(displayNumberAccepted('0776295512', 'GBP'), false);
  assert.equal(displayNumberAccepted('0776295512'), false, 'GBP by default');
  assert.equal(displayNumberAccepted('07762955142', 'GBP'), true);
  assert.equal(displayNumberAccepted('01132 496 000', 'GBP'), false);
  assert.equal(displayNumberAccepted('8015551234', 'USD'), true, 'a US venue is not broken by the UK rule');
  assert.equal(displayNumberAccepted('123456', 'USD'), false, 'still at least seven digits');
  assert.equal(displayNumberAccepted('1234567890123456', 'USD'), false, 'at most fifteen digits');
  assert.equal(CHECK_NUMBER_TEXT, 'Please check your number');
});

test('pins: the display checks before it sends, the till checks again before it creates anything', () => {
  const display = code(read('../surfaces/CustomerDisplaySurface.jsx'));
  assert.match(display, /import \{ displayNumberAccepted, ukRuleApplies, CHECK_NUMBER_TEXT \} from '\.\.\/lib\/ukMobile'/);
  const submit = display.slice(display.indexOf('const submitPhone = () => {'), display.indexOf('publishCustomerPhone(phoneInput);'));
  assert.match(submit, /if \(!displayNumberAccepted\(phoneInput, getActiveCurrencyCode\(\)\)\) \{ setPhoneError\(true\); return; \}/,
    'a number that is not accepted is never published to the till');
  assert.match(display, /\{CHECK_NUMBER_TEXT\}/);
  // the till's own guard runs before the lookup and before the insert
  const lookup = code(read('./customerLookup.js'));
  const start = lookup.indexOf('export async function captureLoyaltyByPhone(');
  const body = lookup.slice(start, lookup.indexOf('\nexport async function', start + 10));
  const guard = body.indexOf("if (!displayNumberAccepted(rawPhone, getActiveCurrencyCode())) return { ok: false, code: 'bad_number' };");
  assert.ok(guard > 0, 'captureLoyaltyByPhone refuses a number the display would refuse');
  assert.ok(guard < body.indexOf(".from('customers')"), 'before any read');
  assert.ok(guard < body.indexOf('.insert('), 'before any profile is created');
  assert.ok(guard < body.indexOf('send-welcome'), 'before any text is sent');
  // the till tells the display in words, never a generic error for a bad number
  const pos = code(read('../surfaces/POSSurface.jsx'));
  assert.match(pos, /publishLoyalty\(res\?\.code === 'bad_number' \? \{ error: true, badNumber: true \} : \{ error: true \}\)/);
  assert.match(display, /if \(result\?\.badNumber\)/);
});

test('pins: "Please check your number" never carries over to the next order', () => {
  // 27 Sep 2026 (review): v5.9.91's 20 minute net for an abandoned order reset the keypad but not
  // the warning, so the next customer met an empty keypad that already said "Please check your number".
  const display = code(read('../surfaces/CustomerDisplaySurface.jsx'));
  const at = display.indexOf('if (ms > 0) idleTimer.current = setTimeout(');
  assert.ok(at > 0, 'the abandoned order net is still there');
  const net = display.slice(at, display.indexOf('\n', at));
  assert.match(net, /setPhoneInput\(''\); setPhoneError\(false\); \}, ms\)/, 'the abandoned order net clears the warning');
  // the till's idle (order paid or cleared) clears it, and so does the next key the customer taps
  assert.match(display, /if \(st === 'idle'\) \{ setPhoneInput\(''\); setPhoneError\(false\);/);
  assert.match(display, /onKey=\{d => \{ setPhoneError\(false\);/);
  assert.match(display, /onBackspace=\{\(\) => \{ setPhoneError\(false\);/);
});
