// src/staff/pinRules.test.js (5.12.91): a till PIN picked for the manager, and the text that carries it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { weakPin, generatePin, takenPins, pinMessage, pinSentWords } from './pinRules.js';

test('easy guesses are never offered', () => {
  for (const p of ['0000', '1111', '9999', '1234', '2345', '7890', '9012', '4321', '3210', '0987', '1212', '4747', '12', 'abcd', '', null]) assert.equal(weakPin(p), true, `${p} is weak`);
  for (const p of ['4827', '9031', '1357', '2468', '1221', '0042']) assert.equal(weakPin(p), false, `${p} is fine`);
});

test('a generated PIN is four digits, free at the site and not an easy guess', () => {
  const taken = ['4827', '9031'];
  let i = 0;
  const seq = [0.4827, 0.1234, 0.9031, 0.5566];   // taken, weak, taken, then a good one
  const pin = generatePin(taken, () => seq[i++ % seq.length]);
  assert.equal(pin, '5566');
  for (let n = 0; n < 200; n++) {
    const p = generatePin(taken);
    assert.match(p, /^\d{4}$/);
    assert.ok(!taken.includes(p) && !weakPin(p));
  }
  // A leading zero is kept.
  assert.equal(generatePin([], () => 0.0042), '0042');
});

test('a stuck random source still finds a free PIN, and a full site gets none', () => {
  assert.equal(generatePin(['0001'], () => 0.0001), '0002');   // random keeps saying 0001: first free in order
  const all = Array.from({ length: 10000 }, (_, n) => String(n).padStart(4, '0'));
  assert.equal(generatePin(all), '');
});

test('PINs in use: active till users only, leaving the person being edited out', () => {
  const team = [{ id: 'a', pin: '4827', active: true }, { id: 'b', pin: '9031', active: false }, { id: 'c', pin: '', active: true }, { id: 'd', pin: '5566' }, null];
  assert.deepEqual(takenPins(team), ['4827', '5566']);
  assert.deepEqual(takenPins(team, 'a'), ['5566']);
  assert.deepEqual(takenPins(null), []);
});

test('the text carries the PIN, the venue and a warning, in one message', () => {
  const m = pinMessage({ name: 'Sam Jones', pin: '4827', venueName: 'H Mall' });
  assert.equal(m, 'Hi Sam, your till PIN at H Mall is 4827. Use it to sign in at the till and to clock in. Keep it to yourself.');
  assert.ok(m.length <= 160);
  assert.match(pinMessage({ pin: '0042' }), /^Your till PIN is 0042\./);
});

test('the Back Office says what happened to the text', () => {
  assert.equal(pinSentWords('Sam Jones', { ok: true }), 'PIN sent to Sam by text.');
  assert.match(pinSentWords('Sam Jones', { ok: false, skipped: 'no-mobile' }), /no mobile number/);
  assert.match(pinSentWords('Sam Jones', { skipped: 'no-record' }), /no Workforce staff record/);
  assert.match(pinSentWords('Sam', new Error('Twilio said no')), /did not send \(Twilio said no\)/);
});
