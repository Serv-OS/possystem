// src/lib/customerAutoJoin.test.js
//
// THE TILL'S JOIN BY EMAIL, DECIDED (27 Sep 2026). Peter: "I don't want a merge tool, I want it so
// when someone signs up it auto merges their records, matches them as long as they use the same
// email, it knows the record exists and just adds them together." This drives the pure decision
// (src/lib/customerAutoJoin.js decideAutoJoin) through its three outcomes and the safeguards:
//   (a) the phone is not on file, the email is on a profile with NO phone: claim
//   (b) the phone is on an empty profile, the email on a profile with no phone: join
//   (c) any other clash: apart (saved without the email), in plain words
// Run: `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  looksLikeEmail, sameEmail, emailSearchPattern, exactEmailRows, emailIsNew, phoneVariants, holderPhone,
  rowLooksBlank, decideAutoJoin, joinAllowed, mergeOutcome, realName, linkedToast, apartToast,
  unionAllergens, customerAfterJoin, AUTO_JOIN_COLS,
} from './customerAutoJoin.js';

const PHONE = '+447415748167';
// Simon Hughes as the 5Loyalty import left him: an email, stamps, NO phone (1,357 like him).
const SIMON = { id: 'aaa70b4f-0000-4000-8000-000000000001', name: 'Simon Hughes', email: 'simon_h@example.com', phone: null, phone_raw: null, allergens: ['nuts'] };
// The empty profile the customer display or the portal makes from a phone alone.
const SHELL = { id: 'c462cbfc-be83-4ee9-9459-91ea0a682215', name: '', email: null, phone: PHONE, phone_raw: '07415748167', first_name: null, last_name: null };

test('(a) the phone is not on file and the email is on a profile with no phone: the phone goes on it', () => {
  const d = decideAutoJoin({ phoneHit: null, emailHits: [SIMON], phone: PHONE });
  assert.equal(d.step, 'claim');
  assert.equal(d.holder.id, SIMON.id);
  assert.equal(d.rawOnly, false);
  // blank text in the phone cells counts as no phone (an import can leave '')
  assert.equal(decideAutoJoin({ emailHits: [{ ...SIMON, phone: '', phone_raw: ' ' }], phone: PHONE }).step, 'claim');
  // the profile holds this very number as typed text only: the phone column is filled
  const raw = decideAutoJoin({ emailHits: [{ ...SIMON, phone_raw: '07415 748167' }], phone: PHONE });
  assert.equal(raw.step, 'claim');
  assert.equal(raw.rawOnly, true);
});

test('(b) the phone is on an empty profile and the email on a profile with no phone: the empty one is folded in', () => {
  const d = decideAutoJoin({ phoneHit: SHELL, emailHits: [SIMON], phone: PHONE });
  assert.equal(d.step, 'join');
  assert.equal(d.source.id, SHELL.id);
  assert.equal(d.target.id, SIMON.id);
  // 'Customer' is what the till stores when nobody typed a name: still empty
  assert.equal(decideAutoJoin({ phoneHit: { ...SHELL, name: 'Customer' }, emailHits: [SIMON], phone: PHONE }).step, 'join');
});

test('(c) a profile that already holds a DIFFERENT phone never loses it (safeguard 1)', () => {
  const other = { ...SIMON, phone: '+447700900123' };
  assert.deepEqual(decideAutoJoin({ emailHits: [other], phone: PHONE }), { step: 'apart', reason: 'holder_has_phone', holder: other });
  assert.equal(decideAutoJoin({ phoneHit: SHELL, emailHits: [other], phone: PHONE }).step, 'apart');
  // two people in two countries are two numbers (the merge core's samePhone, first review)
  assert.equal(decideAutoJoin({ emailHits: [{ ...SIMON, phone: '+17415748167' }], phone: PHONE }).reason, 'holder_has_phone');
  // a phone_raw that is a different whole number is a phone too
  assert.equal(decideAutoJoin({ emailHits: [{ ...SIMON, phone_raw: '07700 900123' }], phone: PHONE }).reason, 'holder_has_phone');
  // a phone_raw that is not a whole number: the till does not guess
  assert.equal(decideAutoJoin({ emailHits: [{ ...SIMON, phone_raw: 'n/a 12' }], phone: PHONE }).reason, 'holder_phone_unreadable');
  // the same number written another way is not "no phone": the save would make a second profile
  assert.equal(decideAutoJoin({ emailHits: [{ ...SIMON, phone: '07415748167' }], phone: PHONE }).reason, 'holder_phone_format');
});

test('(c) the phone is on a profile with details: never folded in by a till', () => {
  for (const phoneHit of [
    { ...SHELL, name: 'Ela' },
    { ...SHELL, email: 'someone@else.com' },
    { ...SHELL, first_name: 'Ela' },
    { ...SHELL, last_name: 'Stettner' },
  ]) {
    assert.deepEqual(decideAutoJoin({ phoneHit, emailHits: [SIMON], phone: PHONE }), { step: 'apart', reason: 'phone_profile_has_details', holder: SIMON });
  }
});

test('(c) exactly one live profile with the email, and the number on no other profile', () => {
  assert.deepEqual(decideAutoJoin({ emailHits: [SIMON, { ...SIMON, id: 'x2' }], phone: PHONE }), { step: 'apart', reason: 'several' });
  // the number is stored in another form on a third profile: two profiles would share it
  const stray = { id: 'stray', name: 'Old', phone: '07415748167', phone_raw: null, email: null };
  assert.equal(decideAutoJoin({ phoneOthers: [stray], emailHits: [SIMON], phone: PHONE }).reason, 'phone_elsewhere');
  // the email's own profile and the phone's own profile are not strays
  assert.equal(decideAutoJoin({ phoneHit: SHELL, phoneOthers: [{ ...SIMON, phone_raw: '07415748167' }], emailHits: [{ ...SIMON, phone_raw: '07415748167' }], phone: PHONE }).step, 'join');
});

test('nothing to join: no email profile, or the phone and the email are the same profile', () => {
  assert.deepEqual(decideAutoJoin({ phoneHit: SHELL, emailHits: [], phone: PHONE }), { step: 'save' });
  assert.deepEqual(decideAutoJoin({ phoneHit: null, emailHits: [], phone: PHONE }), { step: 'save' });
  assert.deepEqual(decideAutoJoin({ phoneHit: { ...SIMON, phone: PHONE }, emailHits: [{ ...SIMON, phone: PHONE }], phone: PHONE }), { step: 'save' });
  assert.deepEqual(decideAutoJoin(), { step: 'save' });
});

test('only an email TYPED in this form joins; one carried in on an order or a table never does', () => {
  assert.equal(emailIsNew('', 'simon_h@example.com'), true);
  assert.equal(emailIsNew(null, 'simon_h@example.com'), true);
  assert.equal(emailIsNew('other@example.com', 'simon_h@example.com'), true);
  // the Orders Hub reopen / the table's guest: the same email, any case, joins nothing
  assert.equal(emailIsNew('Simon_H@Example.com', ' simon_h@example.com '), false);
  // not a whole email: nothing to look up
  assert.equal(emailIsNew('', 'simon'), false);
  assert.equal(emailIsNew('', ''), false);
});

test('exact email, case aside: _ % and * match only themselves (safeguard 2)', () => {
  assert.equal(looksLikeEmail('simon_h@example.com'), true);
  assert.equal(looksLikeEmail('simon@'), false);
  assert.equal(sameEmail('A@B.com', ' a@b.COM '), true);
  assert.equal(sameEmail('', ''), false);
  assert.equal(emailSearchPattern('simon_h@example.com'), 'simon\\_h@example.com');
  assert.equal(emailSearchPattern('100%@x.com'), '100\\%@x.com');
  // PostgREST reads * as %; a backslash cannot stop that, so it becomes one character and the
  // rows are filtered to this very email afterwards
  assert.equal(emailSearchPattern('a*b@x.com'), 'a_b@x.com');
  const rows = [{ id: 1, email: 'axb@x.com' }, { id: 2, email: 'A*B@x.com' }, null];
  assert.deepEqual(exactEmailRows(rows, 'a*b@x.com').map((r) => r.id), [2]);
});

test('the number in the forms the till and the imports store it, safe inside an or() filter', () => {
  // 29 Sep 2026: the stored shapes of the one phone match key that are provably this number: 00
  // for the + anywhere, and in a UK venue the national form and 44 and the rest
  assert.deepEqual(phoneVariants(PHONE, '07415 748167', 'GB'), [PHONE, '00447415748167', '004407415748167', '07415748167', '447415748167']);
  // a US venue never reads a stored bare 10 digit number as American (a UK number stored without
  // its 0 looks the same, 29 Sep 2026 review)
  assert.deepEqual(phoneVariants('+14155550123', '(415) 555-0123', 'US'), ['+14155550123', '0014155550123']);
  // a region we do not know: the key's 00 forms and the typed number's own key (its digits),
  // never a guessed country
  assert.deepEqual(phoneVariants(PHONE, '07415 748167'), [PHONE, '00447415748167', '004407415748167', '07415748167']);
  for (const v of phoneVariants(PHONE, '07415,748167)', 'GB')) assert.match(v, /^\+?\d+$/);
  assert.deepEqual(phoneVariants('', '123'), []);
  assert.equal(holderPhone(null, PHONE), 'none');
  assert.equal(holderPhone({ phone: '+44 (0) 7415 748167' }, PHONE), 'saved');
});

test('the shell rule the till can see: no name, no first or last name, no email', () => {
  assert.equal(rowLooksBlank(SHELL), true);
  assert.equal(rowLooksBlank({ ...SHELL, name: 'customer' }), true);
  assert.equal(rowLooksBlank({ ...SHELL, name: 'Sam' }), false);
  assert.equal(rowLooksBlank({ ...SHELL, email: 'x@y.com' }), false);
  assert.equal(rowLooksBlank(null), false);
  assert.match(AUTO_JOIN_COLS, /\bphone_raw\b/);
  assert.match(AUTO_JOIN_COLS, /\btags\b/);
});

test('the till folds in only what customer-merge itself says is an empty profile, into the email one', () => {
  const ids = { sourceId: SHELL.id, targetId: SIMON.id };
  const ok = { ok: true, can_merge: true, source_blank: true, swapped: false, source_id: SHELL.id, target_id: SIMON.id };
  assert.equal(joinAllowed(ok, ids), true);
  assert.equal(joinAllowed({ ...ok, source_blank: false }, ids), false, 'points, stamps or orders on the phone profile');
  assert.equal(joinAllowed({ ...ok, swapped: true }, ids), false, 'the phone profile would be kept');
  assert.equal(joinAllowed({ ...ok, can_merge: false }, ids), false);
  assert.equal(joinAllowed({ ...ok, ok: false }, ids), false);
  assert.equal(joinAllowed({ ...ok, target_id: 'other' }, ids), false);
  assert.equal(joinAllowed(null, ids), false);
  assert.equal(mergeOutcome(200, { ok: true }), 'merged');
  assert.equal(mergeOutcome(500, { code: 'step_failed', retry_safe: true }), 'retry');
  assert.equal(mergeOutcome(500, { code: 'step_failed' }), 'refused');
  assert.equal(mergeOutcome(403, { code: 'device_needs_blank_source' }), 'refused');
  assert.equal(mergeOutcome(0, null), 'refused');
});

test("Peter's toast, and (c) in plain words, never a database error", () => {
  assert.equal(linkedToast('Simon Hughes', 'Simon'), "Linked to Simon Hughes's loyalty (joined by email)");
  // an empty profile name: the name staff typed
  assert.equal(linkedToast('', 'Simon'), "Linked to Simon's loyalty (joined by email)");
  assert.equal(linkedToast('Customer', ''), 'Linked to the loyalty profile with this email (joined by email)');
  assert.equal(realName('simon@x.com'), '');
  assert.equal(realName('07415'), '');
  const reasons = ['several', 'holder_has_phone', 'holder_phone_format', 'holder_phone_unreadable', 'phone_elsewhere',
    'phone_profile_has_details', 'join_refused', 'join_unfinished', 'changed', 'phone_taken', 'timeout', 'failed', undefined];
  for (const r of reasons) {
    const t = apartToast(r);
    assert.match(t, /^Saved without the email: /);
    assert.doesNotMatch(t, /duplicate|23505|constraint|idx_|DB error/i);
    assert.doesNotMatch(t, /[\u2013\u2014]/, 'no en or em dashes');
  }
  assert.doesNotMatch(linkedToast('A', ''), /[\u2013\u2014]/);
});

test('an allergy the member told us about travels with the order; no list stays no list', () => {
  assert.deepEqual(unionAllergens(['milk'], ['nuts', 'milk'], null), ['milk', 'nuts']);
  assert.deepEqual(customerAfterJoin({ name: 'Simon', allergens: ['milk'] }, ['nuts']).allergens, ['milk', 'nuts']);
  assert.equal('allergens' in customerAfterJoin({ name: 'Simon' }, []), false);
  const c = { name: 'Simon', phone: '07415748167', email: 'simon_h@example.com' };
  const after = customerAfterJoin(c, SIMON.allergens);
  assert.equal(after.email, c.email, 'the email stays on the order for the receipt');
  assert.equal(after.phone, c.phone);
});
