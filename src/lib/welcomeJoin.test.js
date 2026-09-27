// welcomeJoin.test.js: the customer display join and the loyalty welcome (v5.9.85).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { welcomePortalUrl, dropEmptyLinkLines, welcomeVenueName } from '../../supabase/functions/_shared/welcomeLink.js';

const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

test('the welcome link is built from the Platform slug', () => {
  assert.equal(welcomePortalUrl('coffee-boy-leeds', 'serv-os.app'), 'https://coffee-boy-leeds.serv-os.app/account/register');
  assert.equal(welcomePortalUrl('coffeeboystation'), 'https://coffeeboystation.serv-os.app/account/register');
  assert.equal(welcomePortalUrl(''), '');
  assert.equal(welcomePortalUrl(null), '');
  assert.equal(welcomePortalUrl('bad slug/../x'), '', 'never a malformed host');
});

test('an empty link never leaves "View your account:" hanging', () => {
  // Peter, 27 Sep: "View your account:" with nothing after it.
  const sent = "Hi Peter! Welcome to our venue! You're now earning loyalty points on every order. Earn rewards, track gift cards, and more.\n\nView your account: ";
  assert.equal(dropEmptyLinkLines(sent), "Hi Peter! Welcome to our venue! You're now earning loyalty points on every order. Earn rewards, track gift cards, and more.");
  const good = 'Hi Peter!\n\nView your account: https://coffee-boy-leeds.serv-os.app/account/register';
  assert.equal(dropEmptyLinkLines(good), good, 'a message with its link is unchanged');
  assert.equal(dropEmptyLinkLines('Thanks: see you soon'), 'Thanks: see you soon', 'a colon mid sentence stays');
});

test('the venue name comes from Ops, then Platform, never "our venue"', () => {
  assert.equal(welcomeVenueName('Coffee Boy Leeds', 'x'), 'Coffee Boy Leeds');
  assert.equal(welcomeVenueName('', 'Coffee Boy - Preston'), 'Coffee Boy Preston');
  assert.equal(welcomeVenueName(null, null), 'us');
});

test('pins: send-welcome reads the slug from Platform and trims empty link lines', () => {
  const fn = read('../../supabase/functions/send-welcome/index.ts');
  assert.doesNotMatch(fn, /\.from\('locations'\)\s*\.select\('name, online_slug'\)\s*\.eq\('id', location_id\)/, 'never online_slug from OPS');
  assert.match(fn, /platformAdmin\s*\.from\('locations'\)\s*\.select\('name, online_slug'\)/);
  assert.match(fn, /const smsMsg = dropEmptyLinkLines\(/);
});

test('pins: a new number on the customer display is created with a name and no marketing consent', () => {
  // Leeds, 27 Sep: "the customer just typed his number in, came up with an error".
  const src = read('./customerLookup.js');
  assert.match(src, /\.insert\(\{ org_id: orgId, phone: phoneN, phone_raw: rawPhone, name: '', marketing_opt_in: false \}\)/);
  assert.doesNotMatch(src, /marketing_opt_in: true \}\)/, 'typing a number is not marketing consent');
  assert.match(src, /if \(lookupErr\) \{/, 'a failed read is not a new number');
  assert.match(src, /error\.code === '23505'/, 'a race with another till uses the existing row');
});
