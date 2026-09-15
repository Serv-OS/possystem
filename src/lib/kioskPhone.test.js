import test from 'node:test';
import assert from 'node:assert/strict';
import {
  kioskPhoneRegion, kioskPhoneMaxLength, kioskE164, kioskPhoneValid, kioskPhoneDisplay, kioskMaskPhone,
} from './kioskPhone.js';

test('region follows the venue currency', () => {
  assert.equal(kioskPhoneRegion('USD'), 'us');
  assert.equal(kioskPhoneRegion('usd'), 'us');
  assert.equal(kioskPhoneRegion('GBP'), 'uk');
  assert.equal(kioskPhoneRegion('EUR'), 'uk');
  assert.equal(kioskPhoneRegion(null), 'uk');
});

test('keypad caps: UK 11 digits, US 10', () => {
  assert.equal(kioskPhoneMaxLength('uk'), 11);
  assert.equal(kioskPhoneMaxLength('us'), 10);
});

test('UK numbers: 11 digits from 07, or 10 digits from 7', () => {
  assert.equal(kioskE164('07700900123', 'uk'), '+447700900123');
  assert.equal(kioskE164('7700900123', 'uk'), '+447700900123');
  assert.equal(kioskPhoneValid('07700900123', 'uk'), true);
  assert.equal(kioskPhoneValid('7700900123', 'uk'), true);
  assert.equal(kioskPhoneValid('0770090012', 'uk'), false);    // 10 digits from 07 is short
  assert.equal(kioskPhoneValid('077009001234', 'uk'), false);  // 12 digits
  assert.equal(kioskE164('02079460000', 'uk'), null);          // a landline cannot get texts
  assert.equal(kioskE164('', 'uk'), null);
});

test('US numbers: exactly 10 digits', () => {
  assert.equal(kioskE164('4155550123', 'us'), '+14155550123');
  assert.equal(kioskPhoneValid('415555012', 'us'), false);
  assert.equal(kioskPhoneValid('14155550123', 'us'), false);
  assert.equal(kioskPhoneValid('0155550123', 'us'), false);    // area codes never start 0 or 1
});

test('display grouping', () => {
  assert.equal(kioskPhoneDisplay('07700900123', 'uk'), '07700 900123');
  assert.equal(kioskPhoneDisplay('0770', 'uk'), '0770');
  assert.equal(kioskPhoneDisplay('077009', 'uk'), '07700 9');
  assert.equal(kioskPhoneDisplay('4155550123', 'us'), '415 555 0123');
  assert.equal(kioskPhoneDisplay('4155', 'us'), '415 5');
});

test('masking shows the last 3 digits only', () => {
  assert.equal(kioskMaskPhone('07700900123'), '•••• •••123');
  assert.equal(kioskMaskPhone('+447700900987'), '•••• •••987');
  assert.ok(!kioskMaskPhone('07700900123').includes('07700'));
});
