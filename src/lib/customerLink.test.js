// src/lib/customerLink.test.js
//
// "LINK TO EXISTING MEMBER" ON THE ORDER CHIP: THE RULES AND THE WORDS (27 Sep 2026).
// Peter: "if a customer adds their number and then a staff member can link that to a profile that
// currently has no number". Pure helpers only; the reads and writes are in customerLinkRun.test.js.
// Run: `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  canOfferLink, displayProfileLooksBlank, hasNoPhone, linkSearchTerm, phonelessResults, memberCard,
  decideLink, joinRefusalShown, linkMessage, linkedToast, customerAfterLink,
} from './customerLink.js';
import { joinRefusalCode } from './customerAutoJoin.js';

const PHONE = '+447762955142';
const SIMON = 'aaa70b4f-0000-4000-8000-000000000001';
const SHELL = 'c462cbfc-be83-4ee9-9459-91ea0a682215';

// ── the chip ─────────────────────────────────────────────────────────────────

test('the chip offers the link for a new customer with just a phone, whatever the details setting', () => {
  // the customer display made it: no name, the phone as typed
  assert.equal(canOfferLink({ phone: '07762955142', name: '' }), true);
  assert.equal(canOfferLink({ phone: '07762955142', name: 'Customer' }), true, "'Customer' is no name");
  assert.equal(canOfferLink({ phone: '07762955142', name: '  CUSTOMER ' }), true, 'any case');
  assert.equal(canOfferLink({ phone: '07762955142' }), true, 'no name at all');
  assert.equal(canOfferLink({ phone: '07762955142', name: null, email: null }), true);
  // staff typed a name in the name only form, then the customer typed the number on the display
  assert.equal(canOfferLink({ phone: '07762955142', name: 'Sam', blankProfile: true }), true);
});

test('the chip does not offer it: a named or emailed customer, no phone, already linked, junk', () => {
  assert.equal(canOfferLink({ phone: '07762955142', name: 'Simon Hughes' }), false);
  assert.equal(canOfferLink({ phone: '07762955142', name: '', email: 'simon@example.com' }), false, 'the email route covers it');
  assert.equal(canOfferLink({ phone: '', name: '' }), false);
  assert.equal(canOfferLink({ phone: '123', name: '' }), false, 'fewer than seven digits');
  assert.equal(canOfferLink({ phone: null, name: null }), false);
  assert.equal(canOfferLink({ phone: '07762955142', name: '', memberLinked: true }), false);
  assert.equal(canOfferLink({ phone: '07762955142', name: 'Sam', blankProfile: false }), false);
  assert.equal(canOfferLink(null), false);
  assert.equal(canOfferLink(undefined), false);
  assert.equal(canOfferLink('07762955142'), false);
});

test("the display's lookup: a number it just made a profile for, or one with no name, is an empty profile", () => {
  assert.equal(displayProfileLooksBlank({ ok: true, known: false, customerId: SHELL }), true);
  assert.equal(displayProfileLooksBlank({ ok: true, known: true, name: '' }), true);
  assert.equal(displayProfileLooksBlank({ ok: true, known: true, name: 'Customer' }), true);
  assert.equal(displayProfileLooksBlank({ ok: true, known: true, name: 'Simon Hughes' }), false);
  assert.equal(displayProfileLooksBlank({ ok: false }), false);
  assert.equal(displayProfileLooksBlank(null), false);
});

// ── the search ───────────────────────────────────────────────────────────────

test('only profiles with NO phone are offered; each is marked "no phone"', () => {
  assert.equal(hasNoPhone({ id: 1, phone: null, phone_raw: null }), true);
  assert.equal(hasNoPhone({ id: 1, phone: '', phone_raw: '  ' }), true);
  assert.equal(hasNoPhone({ id: 1, phone: PHONE }), false);
  assert.equal(hasNoPhone({ id: 1, phone: null, phone_raw: '07415 748167' }), false, 'a raw phone is a phone');
  assert.equal(hasNoPhone(null), false);
  const rows = [
    { id: 'a', name: 'Simon Hughes', email: 'simon@example.com', phone: null, phone_raw: null },
    { id: 'b', name: 'Simon Phone', email: 'sp@example.com', phone: '+447700900123', phone_raw: '07700 900123' },
    { id: 'c', name: 'Simon Raw', email: null, phone: null, phone_raw: '07700 900124' },
    null,
    { id: 'a', name: 'Simon Hughes again', phone: null },
    { name: 'no id', phone: null },
  ];
  assert.deepEqual(phonelessResults(rows).map((r) => r.id), ['a'], 'with a phone, a raw phone, twice, no id: all left out');
  assert.deepEqual(phonelessResults(null), []);
  assert.equal(phonelessResults(Array.from({ length: 30 }, (_, i) => ({ id: `m${i}`, phone: null }))).length, 10);
  assert.deepEqual(memberCard({ id: 'a', name: 'Simon Hughes', email: 'simon_h@example.com', phone: null }),
    { id: 'a', name: 'Simon Hughes', email: 's•••@example.com', noPhone: true }, 'the email is masked on a counter screen');
  // never a crash on nulls (v5.9.86 and v5.9.88 were crashes on exactly that)
  assert.deepEqual(memberCard({ id: 'x', name: null, email: null, phone: null, phone_raw: null }), { id: 'x', name: 'No name', email: '', noPhone: true });
  assert.deepEqual(memberCard(null), { id: '', name: 'No name', email: '', noPhone: false });
});

test('the search text is safe inside the or() filter and needs three characters', () => {
  assert.equal(linkSearchTerm('  Simon  Hughes '), 'Simon Hughes');
  assert.equal(linkSearchTerm('simon_h@example.com'), 'simon_h@example.com');
  assert.equal(linkSearchTerm('a,b),name.eq.x'), 'abname.eq.x', 'a comma or a bracket never ends the filter');
  assert.equal(linkSearchTerm('%*"\'\\'), '');
  assert.equal(linkSearchTerm('si'), '');
  assert.equal(linkSearchTerm(null), '');
});

// ── the decision ─────────────────────────────────────────────────────────────

const member = (over = {}) => ({ id: SIMON, name: 'Simon Hughes', email: 'simon_h@example.com', phone: null, phone_raw: null, ...over });
const shell = (over = {}) => ({ id: SHELL, name: '', email: null, phone: PHONE, phone_raw: '07762955142', ...over });

test('the empty profile the display made is folded into the member', () => {
  assert.deepEqual(decideLink({ member: member(), phoneHit: shell(), phone: PHONE }), { step: 'join', source: shell() });
  assert.deepEqual(decideLink({ member: member(), phoneHit: shell({ name: 'Customer' }), phone: PHONE }).step, 'join');
});

test('no profile has the number yet: it goes on the member', () => {
  assert.deepEqual(decideLink({ member: member(), phoneHit: null, phone: PHONE }), { step: 'claim', rawOnly: false });
  assert.deepEqual(decideLink({ member: member({ phone_raw: '07762 955142' }), phoneHit: null, phone: PHONE }), { step: 'claim', rawOnly: true },
    'an import kept the raw cell of this very number');
});

test('never moves a phone: a member with a phone, the number elsewhere, a profile with details', () => {
  assert.deepEqual(decideLink({ member: member({ phone: '+447700900123' }), phoneHit: shell(), phone: PHONE }), { step: 'refuse', code: 'member_has_phone' });
  assert.deepEqual(decideLink({ member: member({ phone_raw: '0770 090 0123' }), phoneHit: shell(), phone: PHONE }), { step: 'refuse', code: 'member_has_phone' });
  assert.deepEqual(decideLink({ member: member({ phone_raw: '123' }), phoneHit: shell(), phone: PHONE }), { step: 'refuse', code: 'member_has_phone' });
  assert.deepEqual(decideLink({ member: member(), phoneHit: shell(), phoneOthers: [{ id: 'other', phone_raw: '07762955142' }], phone: PHONE }),
    { step: 'refuse', code: 'phone_elsewhere' });
  assert.deepEqual(decideLink({ member: member(), phoneHit: shell({ name: 'Ela' }), phone: PHONE }), { step: 'refuse', code: 'phone_profile_has_details' });
  assert.deepEqual(decideLink({ member: member(), phoneHit: shell({ email: 'e@example.com' }), phone: PHONE }), { step: 'refuse', code: 'phone_profile_has_details' });
  assert.deepEqual(decideLink({ member: null, phoneHit: shell(), phone: PHONE }), { step: 'refuse', code: 'member_gone' });
  assert.deepEqual(decideLink(), { step: 'refuse', code: 'member_gone' });
});

test('the member already has this number (another till linked a moment ago): nothing to write', () => {
  assert.deepEqual(decideLink({ member: member({ phone: PHONE }), phoneHit: member({ phone: PHONE }), phone: PHONE }), { step: 'already' });
});

test("'already' only when payment would find the member: the number written another way is refused (review, 27 Sep 2026)", () => {
  // the member holds 07762955142, the display's empty profile holds +447762955142: payment and the
  // stamp lookup find the EMPTY profile, so the till must not say "Linked"
  assert.deepEqual(decideLink({ member: member({ phone: '07762955142' }), phoneHit: shell(), phoneOthers: [member({ phone: '07762955142' })], phone: PHONE }),
    { step: 'refuse', code: 'phone_elsewhere' });
  // no profile holds the exact number, but the member holds it written another way
  assert.deepEqual(decideLink({ member: member({ phone: '07762955142' }), phoneHit: null, phoneOthers: [member({ phone: '07762955142' })], phone: PHONE }),
    { step: 'refuse', code: 'member_phone_format' });
  // the member holds the exact number, and another profile holds it another way
  assert.deepEqual(decideLink({ member: member({ phone: PHONE }), phoneHit: member({ phone: PHONE }), phoneOthers: [{ id: 'raw', phone: null, phone_raw: '07762955142' }], phone: PHONE }),
    { step: 'refuse', code: 'phone_elsewhere' });
});

test('a refused fold is put down to an order only when the server cannot have just kept the older profile (review, 27 Sep 2026)', () => {
  const older = { created_at: '2026-09-20T09:00:00Z' };
  const newer = { created_at: '2026-09-27T09:00:00Z' };
  // the empty profile is newer than the member: the member is kept unless the empty one has history
  assert.equal(joinRefusalShown('device_needs_blank_source', { source: newer, member: older }), 'device_needs_blank_source');
  assert.equal(joinRefusalShown('not_blank', { source: newer, member: older }), 'not_blank');
  // the empty profile is OLDER: with no history on either the server keeps it and folds the MEMBER in
  assert.equal(joinRefusalShown('device_needs_blank_source', { source: older, member: newer }), 'swapped');
  assert.equal(joinRefusalShown('not_blank', { source: older, member: newer }), 'swapped');
  assert.equal(linkMessage(joinRefusalShown('device_needs_blank_source', { source: older, member: newer })),
    'These two could not be linked here. A manager can join them in Back Office > Customers.');
  // unreadable dates, or any other refusal: the code stands
  assert.equal(joinRefusalShown('device_needs_blank_source', { source: { created_at: null }, member: newer }), 'device_needs_blank_source');
  assert.equal(joinRefusalShown('device_needs_blank_source'), 'device_needs_blank_source');
  assert.equal(joinRefusalShown('different_phones', { source: older, member: newer }), 'different_phones');
  assert.equal(joinRefusalShown(undefined, { source: older, member: newer }), undefined);
});

// ── customer-merge's answers, and the words ──────────────────────────────────

test("customer-merge's refusals become short codes", () => {
  const ids = { sourceId: SHELL, targetId: SIMON };
  assert.equal(joinRefusalCode({ status: 403, body: { ok: false, code: 'device_needs_blank_source' } }, ids), 'device_needs_blank_source');
  assert.equal(joinRefusalCode({ status: 200, body: { ok: true, can_merge: true, source_blank: false, source_id: SHELL, target_id: SIMON } }, ids), 'not_blank',
    'a till signed in as an owner passes the staff rule; the till holds itself to the shell rule');
  // review, 27 Sep 2026: the server kept the older empty profile, so the MEMBER is the one folded
  // in and source_blank is about the member; that is 'swapped', never "already has an order"
  assert.equal(joinRefusalCode({ status: 200, body: { ok: true, can_merge: true, swapped: true, source_blank: false, source_id: SIMON, target_id: SHELL } }, ids), 'swapped');
  assert.equal(joinRefusalCode({ status: 200, body: { ok: true, can_merge: true, source_blank: false, source_id: SIMON, target_id: SHELL } }, ids), 'swapped');
  assert.equal(joinRefusalCode({ status: 200, body: { ok: true, can_merge: true, source_blank: true, swapped: true } }, ids), 'swapped');
  assert.equal(joinRefusalCode({ status: 200, body: { ok: true, can_merge: false, source_blank: true, refusals: [{ code: 'different_phones' }], source_id: SHELL, target_id: SIMON } }, ids), 'different_phones');
  assert.equal(joinRefusalCode({ status: 409, body: { ok: false, code: 'refused', refusals: [{ code: 'different_phones' }] } }, ids), 'different_phones');
  assert.equal(joinRefusalCode({ status: 500, body: { ok: false, code: 'step_failed', retry_safe: true } }, ids), 'step_failed');
  assert.equal(joinRefusalCode({ status: 0, body: {} }, ids), 'no_answer');
  assert.equal(joinRefusalCode(null, ids), 'no_answer');
  assert.equal(joinRefusalCode({ status: 200, body: { ok: true, can_merge: true, source_blank: true, source_id: 'x', target_id: SIMON } }, ids), 'swapped');
});

test('every refusal is plain words, never a database error, never a dash', () => {
  assert.equal(linkMessage('device_needs_blank_source'), 'This customer already has an order. A manager can join them in Back Office > Customers.');
  assert.equal(linkMessage('not_blank'), linkMessage('device_needs_blank_source'));
  assert.doesNotMatch(linkMessage('swapped'), /order/, 'a turned round pair is never put down to an order');
  assert.match(linkMessage('member_phone_format'), /already has this number, written another way/);
  const codes = ['device_needs_blank_source', 'not_blank', 'member_has_phone', 'different_phones', 'phone_profile_has_details',
    'phone_elsewhere', 'member_gone', 'not_found', 'changed', 'phone_taken', 'read_failed', 'no_answer', 'timeout', 'join_unfinished',
    'step_failed', 'not_allowed', 'sign_in', 'training', 'not_new_customer', 'no_phone', 'offline', 'no_venue', 'failed', 'swapped', 'member_phone_format',
    'refused', undefined, null, 'duplicate key value violates unique constraint "idx_customers_org_email"'];
  for (const c of codes) {
    const m = linkMessage(c);
    assert.ok(m && typeof m === 'string', String(c));
    assert.doesNotMatch(m, /duplicate|constraint|idx_|23505|null|undefined|[\u2013\u2014]/, String(c));
  }
});

test("Peter's toast: Linked to <name>'s loyalty", () => {
  assert.equal(linkedToast('Simon Hughes'), "Linked to Simon Hughes's loyalty");
  assert.equal(linkedToast(''), "Linked to the member's loyalty");
  assert.equal(linkedToast(null), "Linked to the member's loyalty");
  assert.equal(linkedToast('Customer'), "Linked to the member's loyalty");
});

test('the order after the link: the member, their allergies and stamps, no email copied, no second offer', () => {
  const stamps = [{ id: 'p1', name: 'Coffee', icon: '☕', have: 2, need: 9, ready: 0, reward: '' }];
  const out = customerAfterLink({ phone: '07762955142', name: '', stampSummary: [], blankProfile: true, isASAP: true },
    { name: 'Simon Hughes', allergens: ['nuts'], stamps });
  assert.deepEqual(out, {
    phone: '07762955142', name: 'Simon Hughes', stampSummary: stamps, isASAP: true, memberLinked: true, allergens: ['nuts'],
  });
  assert.equal(canOfferLink(out), false, 'the chip stops offering the link');
  assert.equal('email' in out, false, "the member's email is not copied onto the order");
  // the name staff typed stays when the member has none; no allergy list on either side stays none
  const kept = customerAfterLink({ phone: '07762955142', name: 'Sam', blankProfile: true }, { name: '', allergens: null, stamps: null });
  assert.deepEqual(kept, { phone: '07762955142', name: 'Sam', memberLinked: true });
  // the order's own allergy list is never dropped
  assert.deepEqual(customerAfterLink({ phone: '07762955142', allergens: ['milk'] }, { allergens: ['nuts'] }).allergens, ['milk', 'nuts']);
  // nulls never crash
  assert.deepEqual(customerAfterLink(null), { name: '', memberLinked: true });
});
