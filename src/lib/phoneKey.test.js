// src/lib/phoneKey.test.js
//
// THE ONE PHONE MATCH KEY (29 Sep 2026). Peter: "I just placed an order online and its registered
// me again as a customer". The order sent '07931129015', the member was stored '+447931129015', and
// the database compared digits only, so a second customer was made. One key now finds and stores
// every customer: supabase/functions/_shared/phoneKey.js (the till and the edge functions) and
// public.phone_match_key (supabase/migrations/20260929a_OPS_customer_phone_match.sql). This file:
//   1. runs the node key over the shared fixtures (phoneKey.fixtures.json), checks the key of a key
//      is the key, and checks the one read (phoneLookupValues) finds exactly the stored shapes the
//      database finds (29 Sep 2026 review);
//   2. reads the migration's self test list and checks it IS the fixtures file, so the SQL was
//      tested against the same answers (the migration refuses to run on one wrong answer);
//   3. with PHONEKEY_PSQL set (a psql command line for a local Postgres, for example
//      PHONEKEY_PSQL="/opt/homebrew/opt/postgresql@17/bin/psql -h /tmp/pgs -p 55432 -U postgres -d postgres"),
//      runs the migration's own SQL function over the fixtures and a few thousand generated
//      numbers in a temporary schema, and its readable test over the keys; skipped otherwise;
//   4. checks no copy of the old UK only rule is left where a customer is found or created;
//   5. checks the rollback file puts back today's two functions word for word.
// Run: `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import process from 'node:process';

import {
  phoneMatchKey, phoneRegionFromCurrency, phoneLookupValues, samePhoneKey, legacyAppPhone, pickPhoneRow, phoneRawText,
  smsPhoneKey, phoneKeyReadable, storedPhoneRegion, storedPhoneIs, orgPhoneRegion,
} from '../../supabase/functions/_shared/phoneKey.js';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const FIXTURES = JSON.parse(read('../../supabase/functions/_shared/phoneKey.fixtures.json'));
const MIGRATION = read('../../supabase/migrations/20260929a_OPS_customer_phone_match.sql');
const ROLLBACK = read('../../supabase/migrations/20260929a_OPS_customer_phone_match_ROLLBACK.sql');
const FENCE = read('../../supabase/migrations/20260921_OPS_customers_fence.sql');
const OTP = read('../../supabase/functions/loyalty-otp/index.ts');

// ── 1. the node key ─────────────────────────────────────────────────────────

test('the fixtures: every way Peter\'s number is typed is one key, and nothing else is', () => {
  assert.ok(FIXTURES.length >= 60, 'the fixtures file is there');
  const wrong = FIXTURES.filter(([raw, region, want]) => phoneMatchKey(raw, region) !== want)
    .map(([raw, region, want]) => `${JSON.stringify(raw)} in ${region}: ${phoneMatchKey(raw, region)}, expected ${want}`);
  assert.deepEqual(wrong, []);
});

test('the bug: an order typed 07931129015 and the imported +447931129015 are the same person', () => {
  for (const typed of ['07931129015', '07931 129015', '0044 7931 129015', '+44 (0) 7931 129015', '447931129015']) {
    assert.equal(phoneMatchKey(typed, 'GB'), '+447931129015', typed);
    assert.ok(samePhoneKey(typed, '+447931129015', 'GB'), typed);
  }
  for (const typed of ['+1 650 555 1234', '6505551234', '(650) 555-1234', '1-650-555-1234']) {
    assert.equal(phoneMatchKey(typed, 'US'), '+16505551234', typed);
  }
});

test('safety: two different numbers are never one, and a number we cannot read stays its digits', () => {
  assert.equal(samePhoneKey('07931129015', '07931129016', 'GB'), false);
  assert.equal(samePhoneKey('+447931129015', '+17931129015', 'GB'), false);
  // a + number reads the same in every venue
  for (const r of ['GB', 'US', '']) assert.equal(phoneMatchKey('+44 7931 129015', r), '+447931129015');
  // an unknown region only makes a national number its digits (the old database rule)
  assert.equal(phoneMatchKey('07931129015', ''), '07931129015');
  assert.equal(phoneMatchKey('6505551234', 'GB'), '6505551234');
  // too short is nothing, and null in is null out
  assert.equal(phoneMatchKey('123456', 'GB'), null);
  assert.equal(phoneMatchKey(undefined, 'GB'), null);
  assert.equal(samePhoneKey('123', '123', 'GB'), false, 'two unreadable numbers are not the same person');
});

test('the venue region comes from its currency', () => {
  assert.equal(phoneRegionFromCurrency('GBP'), 'GB');
  assert.equal(phoneRegionFromCurrency(' usd '), 'US');
  assert.equal(phoneRegionFromCurrency('EUR'), '');
  assert.equal(phoneRegionFromCurrency(null), '');
});

/** A seeded list of typed numbers: the shapes people type, and noise around them. */
function generatedNumbers(n = 6000) {
  let seed = 20260929;
  const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const digits = (k) => Array.from({ length: k }, () => Math.floor(rnd() * 10)).join('');
  const pieces = ['0', '1', '4', '44', '7', '00', '011', '+', '+44', '+1', ' ', '-', '(', ')', '(0)', '( 0 )', '.', 'x', '9', '2', '3', '5', '8', '++'];
  const out = new Set();
  while (out.size < n) {
    const shape = rnd();
    if (shape < 0.4) {
      let t = '';
      for (let j = 1 + Math.floor(rnd() * 5); j > 0; j--) t += pick(pieces);
      out.add(t + digits(Math.floor(rnd() * 12)));
    } else if (shape < 0.7) {
      const nsn = pick(['7', '1', '2', '3', '5', '8', '9', '4', '6']) + digits(pick([7, 8, 9, 10]));
      out.add(pick(['0', '+44', '0044', '44', '+44 (0)', '+440', '(0)', '011 44 ', '+', '']) + pick(['', ' ']) + nsn);
    } else {
      const nanp = pick(['2', '3', '4', '6', '9', '0', '1']) + digits(2) + pick(['2', '5', '0', '1']) + digits(pick([5, 6, 7]));
      out.add(pick(['', '1', '+1', '001', '011 1 ', '+1 (', ' 1-', '+']) + nanp);
    }
  }
  return [...out];
}
const GENERATED = generatedNumbers();
const REGIONS = ['GB', 'US', ''];

test('the key of a key is the key (the till keys a number, the database keys it again)', () => {
  const wrong = [];
  for (const raw of [...FIXTURES.map((f) => f[0]), ...GENERATED]) {
    for (const r of REGIONS) {
      const k = phoneMatchKey(raw, r);
      if (k !== null && phoneMatchKey(k, r) !== k) wrong.push(`${JSON.stringify(raw)} in ${r}: ${k} then ${phoneMatchKey(k, r)}`);
    }
  }
  assert.deepEqual(wrong.slice(0, 10), []);
  // the review's cases: '(0)' is taken out only after a country code
  assert.equal(phoneMatchKey('(0)7931 129015', 'GB'), '+447931129015');
  assert.equal(phoneMatchKey('+33 (0)1 23 45 67 89', 'GB'), '+33123456789');
  // a + number we cannot read keeps its +, so a US venue never reads it again as American
  assert.equal(phoneMatchKey('+44 3887 9681', 'US'), '+4438879681');
  assert.equal(phoneMatchKey('+4438879681', 'US'), '+4438879681');
});

test('a readable key is a whole international number; the database tests it with the same pattern', () => {
  for (const k of ['+447931129015', '+16505551234', '+33123456789', '+353768887706', '+3531234567']) assert.ok(phoneKeyReadable(k), k);
  for (const k of ['+4438879681', '+15551234', '+10555551234', '07931129015', '004438879681', '6505551234', '', null, '+0447931129015']) {
    assert.ok(!phoneKeyReadable(k), String(k));
  }
  // the migration's v_readable pattern, run as a JS pattern, agrees on every key
  const pats = [...MIGRATION.matchAll(/v_(?:key|phone) ~ '(\^\\\+\(\?:44[^']*)'/g)].map((m) => m[1]);
  assert.equal(pats.length, 2, 'both lookups test readability');
  assert.equal(pats[0], pats[1]);
  const sqlReadable = new RegExp(pats[0]);
  const wrong = [];
  for (const raw of [...FIXTURES.map((f) => f[0]), ...GENERATED]) {
    for (const r of REGIONS) {
      const k = phoneMatchKey(raw, r);
      if (k !== null && sqlReadable.test(k) !== phoneKeyReadable(k)) wrong.push(k);
    }
  }
  assert.deepEqual(wrong.slice(0, 10), []);
});

test('one read finds the member however an older build stored the number, and nothing else', () => {
  assert.deepEqual(phoneLookupValues('07931 129015', 'GB'),
    ['+447931129015', '00447931129015', '004407931129015', '07931129015', '447931129015']);
  // an importer landline kept national
  assert.deepEqual(phoneLookupValues('+44 117 227 3489', 'GB'),
    ['+441172273489', '00441172273489', '004401172273489', '01172273489', '441172273489']);
  // a US venue keys a US number, but never reads a STORED bare 10 digit number as American
  assert.deepEqual(phoneLookupValues('(415) 555-0123', 'US'), ['+14155550123', '0014155550123']);
  assert.deepEqual(phoneLookupValues('+1 415 555 0123', 'GB'), ['+14155550123', '0014155550123']);
  // review finding 2: a +32 login never finds a bare '3235550147' (a US number typed without +1)
  assert.deepEqual(phoneLookupValues('+32 3 555 01 47', 'GB'), ['+3235550147', '003235550147']);
  // review finding 3: '+1 201 481 2891' never finds a London number stored without its 0
  assert.ok(!phoneLookupValues('+1 201 481 2891', 'US').includes('2014812891'));
  // the old UK only rule is not a lookup: '07931129015' is not British in a US venue
  assert.deepEqual(phoneLookupValues('07931129015', 'US'), ['07931129015']);
  // a number we cannot read is its key only (with its + when it was typed so, as the till stored it)
  assert.deepEqual(phoneLookupValues('+44 3887 9681', 'US'), ['+4438879681']);
  assert.deepEqual(phoneLookupValues('7931129015', 'GB'), ['7931129015']);
  // review finding 6: a long number is still looked up by its key
  assert.deepEqual(phoneLookupValues('07931 129015 ext 123456', 'GB'), ['07931129015123456']);
  // safe inside a PostgREST filter, whatever was typed
  for (const typed of ['07931,129015)', "0793'1129015", '+44 (0) 7931 129015 ext 5', 'Tel: 07931129015', ...GENERATED.slice(0, 500)]) {
    for (const r of REGIONS) for (const v of phoneLookupValues(typed, r)) assert.match(v, /^\+?[0-9]{7,}$/, typed);
  }
  assert.deepEqual(phoneLookupValues('12345', 'GB'), []);
});

test('the one read finds exactly the stored rows the database finds (20260929a, both lookups)', () => {
  // The database: the key, a row WITHOUT a + whose phone_match_key(row, storedPhoneRegion) is the
  // key (for a key we read), else the digits (for a key we cannot read; node keeps its old exact
  // match there). So for every readable key K and every bare stored value D:
  //   D is in phoneLookupValues(K) exactly when phoneMatchKey(D, storedPhoneRegion(region)) === K.
  assert.equal(storedPhoneRegion('GB'), 'GB');
  assert.equal(storedPhoneRegion('US'), '');
  assert.equal(storedPhoneRegion(''), '');
  const stored = new Set();
  for (const raw of [...FIXTURES.map((f) => f[0]), ...GENERATED]) {
    for (const r of [...REGIONS, 'GB']) {
      const k = phoneMatchKey(raw, r);
      if (!k) continue;
      const d = k.replace(/[^0-9]/g, '');
      for (const p of ['', '0', '00', '000', '44', '440', '0044', '00440', '1', '001', '011', '01144', '4']) stored.add(p + d);
      for (const v of phoneLookupValues(raw, r)) stored.add(v.replace(/^\+/, ''));
    }
  }
  // what the database reads each stored value as, in each stored region, indexed by that key
  const readAs = new Map();
  for (const sr of ['GB', '']) {
    const byKey = new Map();
    for (const d of stored) {
      const k = phoneMatchKey(d, sr);
      if (!byKey.has(k)) byKey.set(k, new Set());
      byKey.get(k).add(d);
    }
    readAs.set(sr, byKey);
  }
  const wrong = [];
  let checked = 0;
  for (const raw of [...FIXTURES.map((f) => f[0]), ...GENERATED]) {
    for (const r of REGIONS) {
      const key = phoneMatchKey(raw, r);
      if (!phoneKeyReadable(key)) continue;
      checked++;
      const values = new Set(phoneLookupValues(raw, r));
      for (const v of values) {
        if (v !== key && (v.startsWith('+') || phoneMatchKey(v, storedPhoneRegion(r)) !== key)) wrong.push(`${raw} in ${r}: ${v} is not ${key}`);
      }
      for (const d of readAs.get(storedPhoneRegion(r)).get(key) || []) {
        if (!values.has(d)) wrong.push(`${raw} in ${r}: misses ${d}`);
      }
    }
  }
  assert.ok(checked > 2500, 'enough readable keys checked');
  assert.deepEqual(wrong.slice(0, 10), []);
});

test('a stored number is the typed number only by the same rule', () => {
  assert.ok(storedPhoneIs('+447931129015', '07931 129015', 'GB'));
  assert.ok(storedPhoneIs('07931 129015', '+44 7931 129015', 'GB'), 'a phone_raw typed nationally in a UK venue');
  assert.ok(storedPhoneIs('+16505551234', '(650) 555-1234', 'US'));
  assert.ok(!storedPhoneIs('2014812891', '+1 201 481 2891', 'US'), 'a bare stored 10 digit number is not read as American');
  assert.ok(!storedPhoneIs('3235550147', '+32 3 555 01 47', 'GB'));
  assert.ok(!storedPhoneIs('', '07931129015', 'GB'));
  assert.ok(!storedPhoneIs('+447931129015', '123', 'GB'));
});

test('of two rows for one number, the one stored as the key wins, then the oldest', () => {
  const dup = { id: 'b', phone: '07931129015', created_at: '2026-09-29T11:35:00+00:00' };
  const member = { id: 'a', phone: '+447931129015', created_at: '2026-09-21T09:00:00+00:00' };
  assert.equal(pickPhoneRow([dup, member], '+447931129015').id, 'a');
  assert.equal(pickPhoneRow([{ ...member, phone: '7931129015' }, dup], '+447931129015').id, 'a', 'no exact row: the oldest');
  assert.equal(pickPhoneRow([], '+447931129015'), null);
  assert.equal(pickPhoneRow(null, 'x'), null);
});

test('the old rule is kept only for the loyalty login\'s second reading', () => {
  assert.equal(legacyAppPhone('07931 129015'), '+447931129015');
  assert.equal(legacyAppPhone('447931129015'), '+447931129015');
  assert.equal(legacyAppPhone('0117 227 3489'), '01172273489');
  assert.equal(legacyAppPhone('4405551234'), '+4405551234');
  assert.equal(legacyAppPhone(''), null);
  assert.equal(phoneRawText('  07931 129015 '), '07931 129015');
  assert.equal(phoneRawText('x'.repeat(50)).length, 40);
  assert.equal(phoneRawText('  '), null);
});

test('the loyalty login texts a whole number, and nobody who signed in before is refused', () => {
  // the key when it is E.164
  assert.equal(smsPhoneKey('07931 129015', 'GB'), '+447931129015');
  assert.equal(smsPhoneKey('(650) 555-1234', 'US'), '+16505551234');
  assert.equal(smsPhoneKey('+1 650 555 1234', 'GB'), '+16505551234');
  // a UK mobile typed without +44 where the region cannot read it: the old rule's +44, as before
  assert.equal(smsPhoneKey('07931129015', 'US'), '+447931129015');
  assert.equal(smsPhoneKey('07931129015', ''), '+447931129015');
  assert.equal(smsPhoneKey('447931129015', 'US'), '+447931129015');
  // a number whose country we cannot tell stays without + (the login asks for the country code)
  assert.equal(smsPhoneKey('6505551234', 'GB'), '6505551234');
  assert.equal(smsPhoneKey('0117 227 3489', ''), '01172273489');
  assert.equal(smsPhoneKey('12345', 'GB'), null);
  // a + number of the wrong length is not a whole number either (the login says so, never texts it)
  assert.equal(phoneKeyReadable(smsPhoneKey('+44 3887 9681', 'US')), false);
  // every number the old login texted as a whole UK or US number is texted the same now
  const cells = ['07931129015', '07931 129015', '+44 7931 129015', '447931129015', '+447931129015', '+1 650 555 1234', '+16505551234'];
  for (const region of ['GB', 'US', '']) {
    for (const cell of cells) assert.equal(smsPhoneKey(cell, region), phoneMatchKey(legacyAppPhone(cell), 'GB'), cell + ' in ' + region);
  }
});

test('the loyalty login reads a number in the region of the org it searches, never a request field (review 1)', () => {
  assert.equal(orgPhoneRegion(['GBP', 'GBP', 'gbp']), 'GB');
  assert.equal(orgPhoneRegion(['USD']), 'US');
  assert.equal(orgPhoneRegion(['GBP', 'USD']), '', 'an org whose venues differ has no one region');
  assert.equal(orgPhoneRegion(['USD', null]), '');
  assert.equal(orgPhoneRegion([]), '');
  assert.equal(orgPhoneRegion(null), '');
  // The attack: a UK company, a UK mobile once typed without its 0 and stored bare. Naming a US
  // venue in the request cannot make the login read '7723456789' as +1 any more: the region is
  // the UK company's own, the number is refused (ask for the country code), and a +1 number
  // never finds the bare row.
  const region = orgPhoneRegion(['GBP', 'GBP']);
  assert.equal(phoneKeyReadable(smsPhoneKey('7723456789', region)), false);
  assert.ok(!phoneLookupValues(smsPhoneKey('+1 772 345 6789', region), region).includes('7723456789'));
  // the handler: the org and its region come from the company alone, once, before any action
  const at = OTP.indexOf('async function loginOrg(companyId: string)');
  const end = OTP.indexOf('\n}\n', at);
  assert.ok(at > 0 && end > at, 'loginOrg is there');
  const code = OTP.slice(at, end).replace(/\/\/.*$/gm, '');
  assert.ok(!/\bbody\b|location_id\b/.test(code.replace(/ops_location_id/g, '')), 'loginOrg reads no request field');
  assert.ok(code.includes('orgPhoneRegion('), 'the region is the org\'s');
  assert.ok(!OTP.includes('phoneRegionFor('), 'the old request driven region is gone');
  const orgAt = OTP.indexOf('const org = tokenOnlyAction ? null : await loginOrg(companyId);');
  assert.ok(orgAt > 0 && orgAt < OTP.indexOf("if (action === 'send')") && orgAt < OTP.indexOf("if (action === 'verify')"));
  assert.equal(OTP.split('await loginOrg(').length - 1, 1, 'one resolution, shared by send and verify');
  assert.ok(OTP.includes('if (!tokenOnlyAction && !phoneKeyReadable(phone)) {'), 'only a whole number is texted');
  // the member is found only under the number the code was texted to
  const readAt = OTP.indexOf('const readByPhone = async () => (await readCustomerByPhone(opsAdmin, {');
  const readCall = OTP.slice(readAt, OTP.indexOf('})).data;', readAt));
  assert.ok(readCall.includes('orgId, phone, region: phoneRegion,') && !readCall.includes('typed'), readCall);
});

test('send and verify text and check the SAME number, with or without a venue in the request (review 4)', () => {
  // Clients send location_id on send and not on verify. Both now read the number in the org's
  // region, so for every org shape and every way a number is typed, the two are one number, and
  // a number the org's region cannot read is refused at send (never texted, then refused).
  const orgs = { uk: ['GBP', 'GBP'], us: ['USD'], mixed: ['GBP', 'USD'], unset: [] };
  for (const [name, currencies] of Object.entries(orgs)) {
    for (const typed of ['(650) 555-1234', '07931 129015', '+1 650 555 1234', '+44 7931 129015', '7723456789', '0117 227 3489']) {
      const send = smsPhoneKey(typed, orgPhoneRegion(currencies));
      const verify = smsPhoneKey(typed, orgPhoneRegion(currencies));
      assert.equal(send, verify, `${typed} in ${name}`);
    }
  }
  // a US only company reads a US number typed without +1; a UK mobile is +44 everywhere
  assert.equal(smsPhoneKey('(650) 555-1234', orgPhoneRegion(orgs.us)), '+16505551234');
  assert.equal(smsPhoneKey('07931 129015', orgPhoneRegion(orgs.mixed)), '+447931129015');
  assert.equal(phoneKeyReadable(smsPhoneKey('(650) 555-1234', orgPhoneRegion(orgs.mixed))), false, 'asked for +1 at send');
});

// ── 2. the SQL twin was tested against the same answers ─────────────────────

/** The migration's self test rows, read back from the SQL text. */
function migrationFixtures(sql) {
  const from = sql.indexOf('-- PHONE KEY FIXTURES BEGIN');
  const to = sql.indexOf('-- PHONE KEY FIXTURES END');
  assert.ok(from > 0 && to > from, 'the migration carries the fixtures block');
  const lit = String.raw`(null|'(?:[^']|'')*'::text|'(?:[^']|'')*')`;
  const row = new RegExp(String.raw`\(\s*${lit}(?:::text)?\s*,\s*${lit}(?:::text)?\s*,\s*${lit}(?:::text)?\s*\)`, 'g');
  const val = (s) => {
    const t = s.replace(/::text$/, '');
    return t === 'null' ? null : t.slice(1, -1).replace(/''/g, "'");
  };
  return [...sql.slice(from, to).matchAll(row)].map((m) => [val(m[1]), val(m[2]), val(m[3])]);
}

test('the migration\'s self test list IS the fixtures file', () => {
  assert.deepEqual(migrationFixtures(MIGRATION), FIXTURES);
});

test('the migration changes only functions: no table, no policy, no row', () => {
  // what runs when the file is pasted: everything outside the function bodies
  const outside = MIGRATION.replace(/^\s*--.*$/gm, '').replace(/\$(fn|guard|selftest)\$[\s\S]*?\$\1\$/g, '').toLowerCase();
  for (const bad of ['alter ', 'drop ', 'create table', 'policy', 'update ', 'insert ', 'delete ', 'truncate', 'begin;', 'commit;']) {
    assert.ok(!outside.includes(bad), 'the migration runs no ' + bad.trim());
  }
  assert.equal((outside.match(/create or replace function public\./g) || []).length, 4, 'four functions, all create or replace');
  // both functions keep their grants, word for word
  for (const g of [
    'grant execute on function public.customer_by_phone(text, text) to authenticated, service_role;',
    'grant execute on function public.attribute_public_order(text, text, text, jsonb, jsonb) to anon, authenticated, service_role;',
  ]) {
    assert.ok(MIGRATION.includes(g) && FENCE.includes(g), g);
  }
  // the lookup: the key; for a key we read, a row stored without a + read as a stored number
  // (the UK reading in a UK venue only); for a key we cannot read, today's digits; the member wins
  assert.equal((MIGRATION.match(/v_readable and c\.phone !~ '\^\\\+' and public\.phone_match_key\(c\.phone, v_read\)/g) || []).length, 2);
  assert.equal((MIGRATION.match(/v_read := case when v_region = 'GB' then 'GB' else '' end;/g) || []).length, 2);
  assert.equal((MIGRATION.match(/not v_readable and regexp_replace\(coalesce\(c\.phone, ''\), '\[\^0-9\]', '', 'g'\) = v_digits/g) || []).length, 2);
  assert.equal((MIGRATION.match(/order by \(c\.phone is not distinct from v_(key|phone)\) desc, c\.created_at, c\.id/g) || []).length, 2);
  assert.ok(!/\\d|\\s|\\D/.test(MIGRATION.replace(/^\s*--.*$/gm, '')), 'no \\d or \\s: the same answer under any locale');
});

test('the rollback puts back today\'s two functions word for word', () => {
  const fenceFn = (name) => {
    const at = FENCE.indexOf(`create or replace function public.${name}(`);
    const end = FENCE.indexOf('grant execute on function public.' + name, at);
    return FENCE.slice(at, FENCE.indexOf('\n', end) + 1);
  };
  for (const name of ['customer_by_phone', 'attribute_public_order']) {
    const live = fenceFn(name);
    assert.ok(live.length > 500, name);
    assert.ok(ROLLBACK.includes(live), 'the rollback carries ' + name + ' exactly as 20260921 wrote it');
  }
  assert.ok(ROLLBACK.includes('drop function if exists public.phone_match_key(text, text);'));
  assert.ok(ROLLBACK.indexOf('drop function if exists public.phone_match_key') > ROLLBACK.indexOf('create or replace function public.attribute_public_order'),
    'the key goes only after the functions that call it are put back');
});

// ── 3. the SQL twin itself, on a local Postgres (PHONEKEY_PSQL) ─────────────

test('the SQL key gives the same answer as node for every fixture and generated number', { skip: !process.env.PHONEKEY_PSQL && 'set PHONEKEY_PSQL to run the SQL key' }, () => {
  const [bin, ...args] = process.env.PHONEKEY_PSQL.trim().split(/\s+/);
  const fnAt = MIGRATION.indexOf('create or replace function public.phone_match_key(');
  const fnEnd = MIGRATION.indexOf('$fn$;', fnAt) + '$fn$;'.length;
  const fn = MIGRATION.slice(fnAt, fnEnd).replaceAll('public.phone_match_key(', 'phonekey_parity.phone_match_key(');
  const lit = (v) => (v === null ? 'null' : `'${String(v).replace(/'/g, "''")}'`);
  const cases = [...FIXTURES.map(([raw, region]) => [raw, region]), ...GENERATED.flatMap((raw) => REGIONS.map((r) => [raw, r]))];
  const values = cases.map(([raw, region], i) => `(${i}, ${lit(raw)}::text, ${lit(region)}::text)`).join(',\n');
  const script = [
    'begin;',
    'create schema phonekey_parity;',
    fn,
    `select i, coalesce(phonekey_parity.phone_match_key(raw, region), '<null>') from (values ${values}) v(i, raw, region) order by i;`,
    'rollback;',
  ].join('\n');
  const out = execFileSync(bin, [...args, '-X', '-A', '-t', '-q', '-F', '\t', '-v', 'ON_ERROR_STOP=1', '-f', '-'],
    { input: script, encoding: 'utf8', env: { ...process.env, LC_ALL: process.env.LC_ALL || 'en_GB.UTF-8' } });
  const sql = new Map(out.trim().split('\n').filter(Boolean).map((l) => {
    const [i, k] = l.split('\t');
    return [Number(i), k === '<null>' ? null : k];
  }));
  assert.equal(sql.size, cases.length);
  const wrong = cases.filter(([raw, region], i) => sql.get(i) !== phoneMatchKey(raw, region))
    .map(([raw, region]) => `${JSON.stringify(raw)} in ${region}: node ${phoneMatchKey(raw, region)}`);
  assert.deepEqual(wrong.slice(0, 10), []);
});

// ── 4. no copy of the old rule where a customer is found or created ─────────

test('every place that finds or creates a customer by phone uses the one key', () => {
  const OLD_RULE = /startsWith\('07'\)\s*&&\s*\w+\.length\s*===\s*11/;
  const finders = [
    './customerLookup.js',
    '../store/index.js',
    './customerAutoJoin.js',
    './customerAutoJoinRun.js',
    '../components/CustomerModal.jsx',
    '../surfaces/TablesSurface.jsx',
    '../../supabase/functions/wifi-capture/index.ts',
    '../../supabase/functions/loyalty-otp/index.ts',
    '../../supabase/functions/loyalty-member-lookup/index.ts',
    '../../supabase/functions/loyalty-balance/index.ts',
    '../../supabase/functions/gift-fulfill/index.ts',
    '../../supabase/functions/booking-widget/index.ts',
    '../../supabase/functions/_shared/hubrise-map.ts',
    '../../supabase/functions/_shared/hubrise-ingest.ts',
  ];
  for (const rel of finders) {
    const src = read(rel);
    assert.ok(!OLD_RULE.test(src), rel + ' has no copy of the old UK only rule');
    // the key itself, the shared read, or (the store) customerLookup's normalisePhone, which is the key
    assert.ok(/phoneKey\.js'|customerPhoneRead\.js'|normalisePhone as phoneKeyOfVenue/.test(src), rel + ' uses the one key');
  }
  assert.ok(OLD_RULE.test(read('../../supabase/functions/_shared/phoneKey.js')), 'the old rule lives on in phoneKey.js, for reads only');
});
