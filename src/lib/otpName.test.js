import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { twilioName, sameServiceName } from '../../supabase/functions/_shared/otpName.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(here, '..', '..', rel), 'utf8');

test('a code text name is what Twilio shows: trimmed and cut to 30 characters', () => {
  assert.equal(twilioName('  Coffee Shop  Station Road North End  '), 'Coffee Shop  Station Road Nort');
  assert.equal(twilioName(null), '');
});

test('a code may only go out from a service that already carries this venue\'s own name', () => {
  assert.equal(sameServiceName('Coffee Shop Leeds', 'Coffee Shop Leeds'), true);
  assert.equal(sameServiceName('coffee shop leeds', 'Coffee Shop Leeds '), true);
  assert.equal(sameServiceName('Demo Cafe', 'Coffee Shop Leeds'), false, 'another venue\'s name');
  assert.equal(sameServiceName(null, 'Coffee Shop Leeds'), false, 'a name that could not be read');
  assert.equal(sameServiceName('', ''), false, 'no name at all');
});

test('the loyalty code send never falls back to the shared service under another venue\'s name (source)', () => {
  const src = read('supabase/functions/loyalty-otp/index.ts');
  assert.match(src, /sameServiceName\(/, 'the send path checks the shared service name');
  assert.match(src, /getVerifyServiceName\(/, 'the shared service name is read before a fallback send');
  const guard = src.indexOf('sameServiceName(');
  const send = src.indexOf("await startVerification(phone!, { channel: 'sms'");
  assert.ok(guard > 0 && send > guard, 'the name check comes before the send');
  const newWords = src.slice(src.indexOf('the messages come from what is set in Back Office'), src.indexOf("console.log('[loyalty-otp] send'"));
  assert.doesNotMatch(newWords, /[\u2013\u2014]/, 'the new words carry no dashes');
});
