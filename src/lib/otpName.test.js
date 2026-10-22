import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { twilioName, sameServiceName } from '../../supabase/functions/_shared/otpName.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(here, '..', '..', rel), 'utf8');

test('a code text name is what Twilio accepts: one space between words, trimmed, cut to 30 characters', () => {
  assert.equal(twilioName('  Coffee Shop  Station Road North End  '), 'Coffee Shop Station Road North');
  assert.equal(twilioName('Coffee Shop   Preston'), 'Coffee Shop Preston', 'a triple space becomes one');
  assert.equal(twilioName('Coffee\tShop\nLeeds'), 'Coffee Shop Leeds');
  assert.equal(twilioName(null), '');
});

test('a code may only go out from a service that already carries this venue\'s own name', () => {
  assert.equal(sameServiceName('Coffee Shop Leeds', 'Coffee Shop Leeds'), true);
  assert.equal(sameServiceName('coffee shop leeds', 'Coffee Shop Leeds '), true);
  assert.equal(sameServiceName('Demo Cafe', 'Coffee Shop Leeds'), false, 'another venue\'s name');
  assert.equal(sameServiceName(null, 'Coffee Shop Leeds'), false, 'a name that could not be read');
  assert.equal(sameServiceName('', ''), false, 'no name at all');
});

test('every name that goes to Twilio passes through the one rule (source)', () => {
  const src = read('supabase/functions/_shared/twilio-verify.ts');
  assert.match(src, /import \{ twilioName \} from '\.\/otpName\.js'/);
  assert.equal((src.match(/twilioName\(/g) || []).length, 3, 'create, send and rename');
  assert.doesNotMatch(src, /\.slice\(0, 30\)/, 'no second copy of the 30 character cut');
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

test('the send repairs the venue\'s own service through the one shared module before the name check (source, 22 Oct 2026)', () => {
  const src = read('supabase/functions/loyalty-otp/index.ts');
  const ensure = src.indexOf('await ensureVenueService({ ops: opsAdmin, platform: platformAdmin, opsLocationId: locationId, companyId, fix: true');
  const guard = src.indexOf('sameServiceName(');
  const send = src.indexOf("await startVerification(phone!, { channel: 'sms'");
  assert.ok(ensure > 0 && ensure < guard && guard < send, 'ensure, then the name check, then the send');
  assert.ok(src.includes("action === 'ensure_service' || action === 'audit'"), 'the two service actions');
  assert.ok(src.includes("content-type, x-cron-key'"), 'the cron header is allowed through CORS');
});

test('only the shared module talks to Twilio about a service, and it refuses to rename the shared one (source)', () => {
  // Nobody creates or renames a Verify service except otpService.ts. loyalty-otp and
  // message-templates used to carry their own copies (one of them is how 21 Oct 2026 happened).
  for (const rel of ['supabase/functions/loyalty-otp/index.ts', 'supabase/functions/message-templates/index.ts', 'supabase/functions/location-admin/index.ts', 'supabase/functions/provision-location/index.ts', 'supabase/functions/loyalty-config/index.ts']) {
    const src = read(rel);
    assert.doesNotMatch(src, /setVerifyServiceName\(/, `${rel} renames no service itself`);
    assert.doesNotMatch(src, /createVerifyService\(/, `${rel} creates no service itself`);
    assert.match(src, /from '\.\.\/_shared\/otpService\.ts'/, `${rel} uses the shared module`);
  }
  const svc = read('supabase/functions/_shared/otpService.ts');
  const guard = svc.indexOf('the shared text service is never renamed');
  const firstRename = svc.indexOf('setVerifyServiceName(name, sid)');
  assert.ok(guard > 0 && firstRename > guard, 'the guard comes before the only rename call');
  // every rename call sits inside renameOwnService, after the guard
  const renames = [...svc.matchAll(/setVerifyServiceName\(/g)].map((m) => m.index).filter((i) => !svc.slice(Math.max(0, i - 40), i).includes('import'));
  const fnStart = svc.indexOf('async function renameOwnService');
  const fnEnd = svc.indexOf('async function createOwnService');
  assert.ok(renames.length >= 1 && renames.every((i) => i > fnStart && i < fnEnd), 'renames only inside renameOwnService');
  assert.ok(svc.indexOf('sid === shared') > fnStart && svc.indexOf('sid === shared') < firstRename);
  // the audit never reads the shared service as if it were a venue's own
  assert.match(svc, /if \(sidRow && !\(shared && sidRow === shared\)\)/);
  assert.doesNotMatch(svc, /[\u2013\u2014]/, 'no dashes');
});

test('message-templates: every write and the two service actions need staff of the venue (source)', () => {
  const src = read('supabase/functions/message-templates/index.ts');
  assert.match(src, /const STAFF_ACTIONS = new Set\(\['save', 'reset', 'service_status', 'fix_service'\]\)/);
  const check = src.indexOf('STAFF_ACTIONS.has(action)');
  const dispatch = src.indexOf('switch (action)');
  assert.ok(check > 0 && check < dispatch, 'the staff check comes before any action runs');
  assert.match(src, /callerIsStaffFor\(user, locationId, companyId\)/);
  assert.match(src, /isVenueWriter\(opsAdmin, user, locationId\)/, 'an owner inside their own organisation');
});
