// src/lib/portalEmailJoin.test.js
//
// THE PORTAL JOINS A MEMBER TO THEIR OLD PROFILE BY EMAIL, BY ITSELF (27 Sep 2026).
//
// Peter: "I don't want a merge tool, I want it so when someone signs up it auto merges their
// records, matches them as long as they use the same email, it knows the record exists and just
// adds them together." 1,357 imported Coffee Boy members have an email and no phone; signing up
// with a phone made a blank profile that clashed with theirs on the email.
//
// This drives supabase/functions/_shared/portalEmailJoin.js: the pure decision (every case of an
// email and who holds it), the notice, and saveMemberProfile, which is exactly what loyalty-otp
// update_profile runs, against the in memory databases the merge core is tested with
// (fixtures/fakeSupabaseDb.js enforces the live unique indexes). Stamps and points must land on
// the kept profile exactly once, a save asked again must change nothing, and a save stopped at
// any write and asked again must end exactly where a clean one ends.
// Run: `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  JOIN_MEMBER_COLS, JOIN_TAG, JOIN_MESSAGES, joinMessage, hasJoinedBefore, holdsPhone, foldedInto,
  emailOwnersQuery, decideEmailJoin, fillBlanksPatch, emailAfterJoin, phoneEnding, joinNotice,
  providerEmailRequest, pickPortalVenue, portalVenueName, runPortalJoin, saveMemberProfile,
} from '../../supabase/functions/_shared/portalEmailJoin.js';
import { MERGE_TAG } from '../../supabase/functions/_shared/customerMergePlan.js';
import { fakeDb, newFault } from './fixtures/fakeSupabaseDb.js';

const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

// ── the people ────────────────────────────────────────────────────────────────

const ORG = 'cd97f0f0-4807-4e45-801e-56114b22128a';
const OTHER_ORG = '0b7c2c1e-1111-4a4a-9b9b-222222222222';
const ELA = 'cd96ff83-22ca-4af1-9af9-7ca5de9f6597';     // imported: email, 2 stamps, no phone
const BLANK = 'c462cbfc-be83-4ee9-9459-91ea0a682215';   // what verify made from her phone
const PROGRAM = '0afb5e8b-1e95-402a-83ec-5b3e750d7977';
const LEEDS = '1e252e7c-c875-4971-b91d-1e945c26956b';
const PHONE = '+447415748167';
const EMAIL = 'elastettner@hotmail.com';
const NOW = '2026-09-27T10:00:00Z';

const member = (over = {}) => ({ id: BLANK, org_id: ORG, name: '', email: null, phone: PHONE, phone_raw: null, birthday: null, marketing_opt_in: false, tags: [], deleted_at: null, ...over });
const owner = (over = {}) => ({ id: ELA, org_id: ORG, name: 'Ela Stettner', email: EMAIL, phone: null, phone_raw: null, birthday: null, marketing_opt_in: false, tags: [], deleted_at: null, ...over });

// ── the decision ──────────────────────────────────────────────────────────────

test('a free email is saved on the member', () => {
  assert.deepEqual(decideEmailJoin({ member: member(), provenPhone: PHONE, email: 'new@example.com', owners: [] }), { action: 'save', code: 'free' });
});

test('an email on a profile with NO phone joins the two (the imported member)', () => {
  const d = decideEmailJoin({ member: member(), provenPhone: PHONE, email: 'ElaStettner@Hotmail.com ', owners: [owner()] });
  assert.deepEqual(d, { action: 'join', code: 'join', ownerId: ELA });
});

test('an email on a profile with ANOTHER phone is never joined (safeguard 1)', () => {
  assert.deepEqual(decideEmailJoin({ member: member(), provenPhone: PHONE, email: EMAIL, owners: [owner({ phone: '+447700900123' })] }), { action: 'refuse', code: 'email_in_use' });
  // Another phone held only in the raw form counts too.
  assert.deepEqual(decideEmailJoin({ member: member(), provenPhone: PHONE, email: EMAIL, owners: [owner({ phone_raw: '07700 900123' })] }), { action: 'refuse', code: 'email_in_use' });
  // Same last digits in another country is another phone.
  assert.equal(decideEmailJoin({ member: member(), provenPhone: PHONE, email: EMAIL, owners: [owner({ phone: '+17415748167' })] }).action, 'refuse');
  assert.match(JOIN_MESSAGES.email_in_use, /different phone number/);
  assert.match(JOIN_MESSAGES.email_in_use, /other details are saved/);
});

test('an email on a profile that already has THIS phone (written another way) joins', () => {
  const d = decideEmailJoin({ member: member(), provenPhone: PHONE, email: EMAIL, owners: [owner({ phone_raw: '07415 748167' })] });
  assert.deepEqual(d, { action: 'join', code: 'join', ownerId: ELA });
});

test('an email on two live profiles is refused, never guessed (safeguard 2)', () => {
  const two = [owner(), owner({ id: 'b1b1b1b1-0000-4000-8000-000000000001' })];
  assert.deepEqual(decideEmailJoin({ member: member(), provenPhone: PHONE, email: EMAIL, owners: two }), { action: 'refuse', code: 'several_owners' });
});

test('owners of another business, deleted ones, and near misses do not count', () => {
  const noise = [
    owner({ org_id: OTHER_ORG }),
    owner({ id: 'd1d1d1d1-0000-4000-8000-000000000001', deleted_at: '2026-09-01T00:00:00Z' }),
    owner({ id: 'd1d1d1d1-0000-4000-8000-000000000002', email: 'elastettner@hotmail.co' }),
  ];
  assert.deepEqual(decideEmailJoin({ member: member(), provenPhone: PHONE, email: EMAIL, owners: noise }), { action: 'save', code: 'free' });
});

test('the member\'s own email, text that is not an email, and a missing member are plain saves', () => {
  assert.equal(decideEmailJoin({ member: member({ email: EMAIL }), provenPhone: PHONE, email: 'ELASTETTNER@hotmail.com', owners: [owner()] }).code, 'own_email');
  assert.equal(decideEmailJoin({ member: member(), provenPhone: PHONE, email: 'not an email', owners: [owner()] }).code, 'not_an_email');
  assert.equal(decideEmailJoin({ member: null, provenPhone: PHONE, email: EMAIL, owners: [owner()] }).code, 'no_member');
});

test('no proven phone, or a profile that does not hold it: sign in again, nothing joins', () => {
  assert.equal(decideEmailJoin({ member: member(), provenPhone: null, email: EMAIL, owners: [owner()] }).code, 'sign_in_again');
  assert.equal(decideEmailJoin({ member: member({ phone: '+447700900123' }), provenPhone: PHONE, email: EMAIL, owners: [owner()] }).code, 'sign_in_again');
  assert.equal(decideEmailJoin({ member: member({ phone: null }), provenPhone: PHONE, email: EMAIL, owners: [owner()] }).code, 'sign_in_again');
});

test('one automatic join per account: a profile that already took one in is not joined again', () => {
  const joined = member({ id: ELA, tags: [`${MERGE_TAG.FROM}${BLANK}`] });
  const other = owner({ id: 'e2e2e2e2-0000-4000-8000-000000000001', email: 'someone@example.com' });
  assert.equal(hasJoinedBefore(joined.tags), true);
  assert.deepEqual(decideEmailJoin({ member: joined, provenPhone: PHONE, email: 'someone@example.com', owners: [other] }), { action: 'refuse', code: 'already_joined' });
});

test('holdsPhone and foldedInto', () => {
  assert.equal(holdsPhone({ phone: PHONE }, '07415748167'), true);
  assert.equal(holdsPhone({ phone: null, phone_raw: '07415 748167' }, PHONE), true);
  assert.equal(holdsPhone({ phone: '+447700900123' }, PHONE), false);
  assert.equal(holdsPhone({ phone: PHONE }, null), false);
  assert.equal(foldedInto(member({ deleted_at: NOW, tags: [`${MERGE_TAG.INTO}${ELA}`] })), ELA);
  assert.equal(foldedInto(member({ tags: [`${MERGE_TAG.INTO}${ELA}`] })), null, 'a live profile is not folded');
  assert.equal(foldedInto(member({ deleted_at: NOW })), null, 'deleted by staff, not joined');
});

// ── what the member typed, onto the kept profile ────────────────────────────

test('typed details fill the kept profile only where it is empty', () => {
  assert.deepEqual(fillBlanksPatch(owner(), { name: 'Ela S', birthday: '1990-05-01', marketing_opt_in: true }), { birthday: '1990-05-01', marketing_opt_in: true }, 'an imported name is never replaced');
  assert.deepEqual(fillBlanksPatch(owner({ name: '' }), { name: '  Ela Stettner ' }), { name: 'Ela Stettner' }, 'a blank name takes the typed one');
  assert.deepEqual(fillBlanksPatch(owner({ name: 'Customer' }), { name: 'Ela Stettner' }), { name: 'Ela Stettner' }, '"Customer" is a blank name');
  assert.deepEqual(fillBlanksPatch(owner({ name: '' }), { name: 'Customer' }), {}, 'a blank name is never "filled" with a blank one');
  assert.deepEqual(fillBlanksPatch(owner({ birthday: '1985-01-01', marketing_opt_in: true }), { birthday: '1990-05-01', marketing_opt_in: false }), {}, 'a birthday is kept, a typed no never switches a yes off');
});

test('the typed email onto the kept profile: only when it has none, or when it is the member\'s own', () => {
  assert.equal(emailAfterJoin(owner(), EMAIL), null, 'already there');
  assert.equal(emailAfterJoin(owner({ email: null }), EMAIL), EMAIL);
  assert.equal(emailAfterJoin(owner({ email: 'old@example.com' }), EMAIL), null, 'the email owner keeps its own');
  assert.equal(emailAfterJoin(owner({ email: 'old@example.com' }), EMAIL, { memberIsSurvivor: true }), EMAIL, 'the member replaces their own');
  assert.equal(emailAfterJoin(owner({ email: null }), 'not an email'), null);
});

// ── the notice (safeguard 3) ──────────────────────────────────────────────────

test('the notice says it in Peter\'s words, with the last four digits only', () => {
  const n = joinNotice({ venueName: 'Coffee Boy  Leeds', provenPhone: PHONE });
  assert.equal(n.text, "Your Coffee Boy Leeds stamps and points are now linked to your phone ending 8167. If this wasn't you, reply to this email or tell staff.");
  assert.equal(n.subject, 'Your Coffee Boy Leeds loyalty account is now linked to your phone');
  assert.ok(!n.text.includes('7415'), 'never the whole number');
  assert.ok(n.html.includes('ending 8167') && n.html.includes('Coffee Boy Leeds'));
  assert.equal(phoneEnding('07415 748167'), '8167');
  assert.equal(phoneEnding('12'), '');
  const noVenue = joinNotice({ venueName: '', provenPhone: PHONE });
  assert.match(noVenue.text, /^Your loyalty stamps and points are now linked to your phone ending 8167\./);
});

test('the notice escapes the venue name', () => {
  const n = joinNotice({ venueName: 'Tom & Jo <b>', provenPhone: PHONE });
  assert.ok(n.html.includes('Tom &amp; Jo &lt;b&gt;'));
  assert.ok(!n.html.includes('<b>'));
});

test('every word the member or the email owner reads has no dashes', () => {
  const words = [...Object.values(JOIN_MESSAGES), ...Object.values(joinNotice({ venueName: 'Coffee Boy - Leeds', provenPhone: PHONE })).filter((v) => typeof v === 'string')];
  for (const w of words) assert.ok(!/[\u2013\u2014]/.test(w), w);
  assert.equal(joinNotice({ venueName: 'Coffee Boy - Leeds', provenPhone: PHONE }).subject, 'Your Coffee Boy Leeds loyalty account is now linked to your phone');
  assert.equal(joinMessage('email_in_use'), JOIN_MESSAGES.email_in_use);
  assert.equal(joinMessage('nonsense'), JOIN_MESSAGES.not_linked);
  assert.equal(joinMessage('nonsense', 'email_not_saved'), JOIN_MESSAGES.email_not_saved);
});

test('the notice goes through the same provider request as the welcome and receipts', () => {
  const sender = { from: 'Coffee Boy <hello@coffeeboy.co.uk>', replyTo: 'team@coffeeboy.co.uk' };
  const base = { sender, to: EMAIL, subject: 's', html: '<p>h</p>', text: 't' };
  const resend = providerEmailRequest({ ...base, provider: 'resend', resendKey: 're_x', postmarkKey: '' });
  assert.equal(resend.url, 'https://api.resend.com/emails');
  assert.equal(resend.headers.Authorization, 'Bearer re_x');
  assert.deepEqual(resend.body, { from: sender.from, to: [EMAIL], subject: 's', html: '<p>h</p>', text: 't', reply_to: 'team@coffeeboy.co.uk' });
  const postmark = providerEmailRequest({ ...base, sender: { from: 'hello@posup.co.uk' }, provider: 'postmark', resendKey: '', postmarkKey: 'pm' });
  assert.equal(postmark.url, 'https://api.postmarkapp.com/email');
  assert.deepEqual(postmark.body, { From: 'hello@posup.co.uk', To: EMAIL, Subject: 's', HtmlBody: '<p>h</p>', TextBody: 't' });
  assert.equal(providerEmailRequest({ ...base, provider: 'log', resendKey: 're_x' }), null, 'the log provider sends nothing');
  assert.equal(providerEmailRequest({ ...base, provider: 'resend', resendKey: '' }), null, 'no key, no send');
  assert.equal(providerEmailRequest({ ...base, to: '', provider: 'resend', resendKey: 're_x' }), null);
});

test('the venue is the portal\'s own when it is the member\'s company\'s, never another company\'s', () => {
  const rows = [
    { id: 'p-leeds', name: 'Coffee Boy - Leeds', ops_location_id: LEEDS },
    { id: 'p-york', name: 'Coffee Boy York', ops_location_id: 'ops-york' },
    { id: 'p-new', name: 'Not linked yet', ops_location_id: null },
  ];
  assert.deepEqual(pickPortalVenue(rows, 'ops-york'), { opsLocationId: 'ops-york', platformName: 'Coffee Boy York' });
  assert.deepEqual(pickPortalVenue(rows, 'p-york'), { opsLocationId: 'ops-york', platformName: 'Coffee Boy York' });
  assert.deepEqual(pickPortalVenue(rows, 'ops-of-another-company'), { opsLocationId: LEEDS, platformName: 'Coffee Boy Leeds' });
  assert.deepEqual(pickPortalVenue(rows, ''), { opsLocationId: LEEDS, platformName: 'Coffee Boy Leeds' });
  assert.deepEqual(pickPortalVenue([], 'x'), { opsLocationId: null, platformName: '' });
  assert.equal(portalVenueName('Coffee Boy - Leeds', 'ignored'), 'Coffee Boy Leeds');
  assert.equal(portalVenueName('', 'Coffee Boy York'), 'Coffee Boy York');
  assert.equal(portalVenueName('', ''), '');
});

// ── against the databases ─────────────────────────────────────────────────────

function world({ elaPoints = 0, blankPoints = 0 } = {}) {
  const cust = (over) => ({ org_id: ORG, phone_raw: null, notes: null, marketing_opt_in: false, marketing_opt_in_at: null, deleted_at: null, allergens: [], birthday: null, welcome_sent_at: null, first_name: null, last_name: null, is_local: null, source: null, sources: [], tags: [], no_shows: 0, shopper_reference: null, stored_payment_method_id: null, ...over });
  const membership = (over) => ({ points_redeemed_total: 0, points_expired_total: 0, tier_id: null, tier_qualified_at: null, visit_count: 0, lifetime_spend_minor: 0, referred_by: null, birthday: null, wallet_pass_serial: null, last_earn_at: null, last_redeem_at: null, points_expire_at: null, ...over });
  return {
    ops: {
      customers: [
        cust({ id: BLANK, phone: PHONE, email: null, name: '', created_at: '2026-09-26 13:25:59.631026+00', updated_at: '2026-09-26 13:25:59.631026+00' }),
        cust({ id: ELA, phone: null, email: EMAIL, name: 'Ela Stettner', first_name: 'Ela', last_name: 'Stettner', source: 'import', sources: ['import', 'import:d843efc0-b887-4b5a-a209-0aa69a703d1e'], created_at: '2026-09-26 12:20:18.020496+00', updated_at: '2026-09-26 12:20:18.020496+00' }),
        // Somebody else: an email with an underscore, and a phone of their own.
        cust({ id: 'f0f0f0f0-0000-4000-8000-000000000001', phone: '+447700900123', email: 'jo_smith@example.com', name: 'Jo Smith', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' }),
        // The same email in another business.
        cust({ id: 'f0f0f0f0-0000-4000-8000-000000000002', org_id: OTHER_ORG, phone: null, email: EMAIL, name: 'Ela elsewhere', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' }),
      ],
      stamp_transactions: [
        { id: '37eabaf3-3231-4298-b652-a7811a93792f', customer_id: ELA, program_id: PROGRAM, location_id: LEEDS, stamps: 2, type: 'earn', note: 'Imported from another system', created_at: '2026-09-26 12:20:17.411+00', idempotency_key: `import:d843efc0-b887-4b5a-a209-0aa69a703d1e:${ELA}:${PROGRAM}`, order_ref: 'import:d843efc0-b887-4b5a-a209-0aa69a703d1e' },
      ],
      loyalty_transactions: [
        ...(elaPoints ? [{ id: 'lt-ela', customer_id: ELA, company_id: ORG, type: 'earn', points: elaPoints, created_at: '2026-09-26 12:20:17.411+00' }] : []),
        ...(blankPoints ? [{ id: 'lt-blank', customer_id: BLANK, company_id: ORG, type: 'earn', points: blankPoints, created_at: '2026-09-26 14:00:00+00' }] : []),
      ],
      customer_locations: [
        { customer_id: BLANK, location_id: LEEDS, first_visit_at: '2026-09-26T14:00:00Z', last_visit_at: '2026-09-26T14:00:00Z', visit_count: blankPoints ? 1 : 0, lifetime_revenue: blankPoints ? 3.2 : 0, notes: null },
      ],
    },
    platform: {
      customer_loyalty: [
        membership({ id: '80c45795-9c27-4485-bf93-8b00eccce709', customer_id: BLANK, company_id: ORG, points_balance: blankPoints, points_earned_total: blankPoints, member_code: 'SRV-UEMY79', referral_code: 'WTZFD49E', enrolled_at: '2026-09-26 13:25:59.762038+00' }),
        membership({ id: '74afebf8-5a6b-4755-b1c2-f31f3ca95826', customer_id: ELA, company_id: ORG, points_balance: elaPoints, points_earned_total: elaPoints, member_code: 'SRV-Q43HGG', referral_code: 'REF-DTJYCZ', enrolled_at: '2026-09-26 12:20:17.411+00' }),
      ],
      customer_stamp_cards: [
        { id: 'e7e0f1d6-d057-4bfb-8ad7-eab1863a8c7b', customer_id: ELA, program_id: PROGRAM, company_id: ORG, stamps_collected: 2, completed_count: 0, last_stamp_at: '2026-09-26 12:20:17.411+00', created_at: '2026-09-26 12:20:19.166375+00' },
      ],
      stamp_card_programs: [{ id: PROGRAM, company_id: ORG, name: 'Free Drink', stamps_required: 10, active: true }],
    },
  };
}

function clientsFor(w, fault = newFault()) {
  return { ops: fakeDb(w.ops, fault), platform: fakeDb(w.platform, fault), fault };
}

// The volatile columns (stamped with the clock) are compared for presence, not value.
function settled(c) {
  const s = JSON.parse(JSON.stringify({ ops: c.ops.dump(), platform: c.platform.dump() }));
  for (const r of s.ops.customers || []) { r.updated_at = r.updated_at ? 'set' : null; r.deleted_at = r.deleted_at ? 'set' : null; }
  for (const db of [s.ops, s.platform]) for (const k of Object.keys(db)) db[k] = [...db[k]].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return s;
}

/** Ela signs up in the portal: her phone made BLANK; she types her name, birthday and email. */
const elaTypes = { updates: { name: 'Ela Stettner', birthday: '1990-05-01', marketing_opt_in: true }, typedEmail: 'ElaStettner@hotmail.com' };
const save = (c, sessionCustomerId = BLANK, typed = elaTypes) => saveMemberProfile(c, { sessionCustomerId, provenPhone: PHONE, now: NOW, ...typed });

const row = (c, table, id) => c.ops.dump()[table]?.find((r) => r.id === id) || c.platform.dump()[table]?.find((r) => r.id === id);
const cardsOf = (c, id) => (c.platform.dump().customer_stamp_cards || []).filter((r) => r.customer_id === id);
const membershipsOf = (c, id) => (c.platform.dump().customer_loyalty || []).filter((r) => r.customer_id === id);

test('the ilike matches the exact email only (case aside): _ and % are escaped (safeguard 2)', async () => {
  const c = clientsFor(world());
  const hit = await emailOwnersQuery(c.ops, ORG, 'JO_SMITH@example.com');
  assert.deepEqual(hit.data.map((r) => r.id), ['f0f0f0f0-0000-4000-8000-000000000001']);
  const wild = await emailOwnersQuery(c.ops, ORG, 'joxsmith@example.com');
  assert.deepEqual(wild.data, [], '"_" is not a wildcard');
  const pct = await emailOwnersQuery(c.ops, ORG, '%@example.com');
  assert.deepEqual(pct.data, [], '"%" is not a wildcard');
  const mine = await emailOwnersQuery(c.ops, ORG, EMAIL);
  assert.deepEqual(mine.data.map((r) => r.id), [ELA], 'only this business');
  assert.equal(JOIN_MEMBER_COLS.includes('tags') && JOIN_MEMBER_COLS.includes('phone_raw'), true);
});

test('Ela signs up with her phone and types her email: one profile, her 2 stamps, her phone', async () => {
  const c = clientsFor(world());
  const out = await save(c);
  assert.equal(out.kind, 'joined', JSON.stringify(out));
  const j = out.join;
  assert.equal(j.ok, true);
  assert.equal(j.survivorId, ELA, 'the imported profile with the history is kept');
  assert.equal(j.sourceId, BLANK);
  assert.equal(j.notify, true);
  assert.equal(j.noticeTo, EMAIL, 'the notice goes to the email the join was made on');

  const ela = row(c, 'customers', ELA);
  assert.equal(ela.phone, PHONE, 'the proven phone moved onto her profile');
  assert.equal(ela.email, EMAIL);
  assert.equal(ela.name, 'Ela Stettner');
  assert.equal(ela.birthday, '1990-05-01', 'the typed birthday filled her empty one');
  assert.equal(ela.marketing_opt_in, true);
  assert.equal(ela.deleted_at, null);
  assert.ok(ela.tags.includes(`${MERGE_TAG.FROM}${BLANK}`), 'the survivor records the join');
  assert.deepEqual(j.survivor.phone, PHONE);

  const blank = row(c, 'customers', BLANK);
  assert.ok(blank.deleted_at, 'the blank profile is folded in');
  assert.equal(blank.phone, null);
  for (const t of [`${MERGE_TAG.INTO}${ELA}`, `${MERGE_TAG.PHONE}${PHONE}`, MERGE_TAG.DONE, JOIN_TAG.VIA, JOIN_TAG.NOTICE]) {
    assert.ok(blank.tags.includes(t), `folded in profile tagged ${t}`);
  }

  const cards = cardsOf(c, ELA);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].stamps_collected, 2, 'her 2 stamps, exactly once');
  assert.deepEqual(membershipsOf(c, BLANK), [], 'the blank membership is gone');
  assert.equal(membershipsOf(c, ELA).length, 1);
  assert.equal(membershipsOf(c, ELA)[0].member_code, 'SRV-Q43HGG', 'her member code is kept');
  assert.equal(c.ops.dump().customer_locations.every((r) => r.customer_id === ELA), true, 'visit records moved');
});

test('asked again with the old session, and again with the new one: nothing changes, no second notice', async () => {
  const c = clientsFor(world());
  assert.equal((await save(c)).kind, 'joined');
  const after = settled(c);

  // The old session (another tab still holding BLANK's token): finishes nothing, signs in to Ela.
  const again = await save(c);
  assert.equal(again.kind, 'joined');
  assert.equal(again.join.mode, 'resume');
  assert.equal(again.join.survivorId, ELA);
  assert.equal(again.join.notify, false, 'the notice was claimed by the first join');
  assert.deepEqual(settled(c), after);

  // The new session (Ela's) saving the same details: her own email, a plain save, nothing moves.
  const mine = await save(c, ELA, { updates: elaTypes.updates, typedEmail: EMAIL });
  assert.equal(mine.kind, 'saved');
  assert.equal(mine.emailCode, null);
  assert.deepEqual(settled(c), after);
  // Only the case of her own email changed: saved as she typed it, like any plain save.
  await save(c, ELA, { updates: {}, typedEmail: 'ElaStettner@hotmail.com' });
  assert.equal(row(c, 'customers', ELA).email, 'ElaStettner@hotmail.com');
  assert.equal(cardsOf(c, ELA)[0].stamps_collected, 2);
  assert.equal(row(c, 'customers', ELA).phone, PHONE);
});

test('both have points: the older imported profile is kept and the points add up exactly once', async () => {
  const c = clientsFor(world({ elaPoints: 40, blankPoints: 5 }));
  const out = await save(c);
  assert.equal(out.kind, 'joined');
  assert.equal(out.join.survivorId, ELA);
  const m = membershipsOf(c, ELA);
  assert.equal(m.length, 1);
  assert.equal(m[0].points_balance, 45);
  assert.equal(m[0].points_earned_total, 45);
  assert.equal(membershipsOf(c, BLANK).length, 0);
  const visits = c.ops.dump().customer_locations.filter((r) => r.customer_id === ELA);
  assert.equal(visits.length, 1);
  assert.equal(visits[0].visit_count, 1);
  const ledger = c.ops.dump().loyalty_transactions.filter((r) => r.customer_id === ELA);
  assert.equal(ledger.length, 2, 'both points history rows now name Ela');
  // Asked again: still 45.
  await save(c);
  await save(c, ELA);
  assert.equal(membershipsOf(c, ELA)[0].points_balance, 45);
});

test('stopped at EVERY write, before it lands or after, then saved again: exactly the clean result', async () => {
  const cleanC = clientsFor(world({ elaPoints: 40, blankPoints: 5 }));
  assert.equal((await save(cleanC)).kind, 'joined');
  const want = settled(cleanC);
  const total = cleanC.fault.writes;
  assert.ok(total >= 10, `a join is many writes (${total})`);
  for (const mode of ['before', 'after']) {
    for (let k = 0; k < total; k += 1) {
      const fault = newFault();
      fault.at = k; fault.mode = mode;
      const c = clientsFor(world({ elaPoints: 40, blankPoints: 5 }), fault);
      let out = await save(c);
      fault.at = null;
      // The member presses Save again (the same session) until the portal gets the joined account.
      for (let tries = 0; out.kind !== 'joined' && tries < 3; tries += 1) out = await save(c);
      assert.equal(out.kind, 'joined', `${mode} at write ${k} (${fault.log[k]}): ${JSON.stringify(out.join || out)}`);
      // One more save from the old session finishes anything a silent write left behind.
      await save(c);
      assert.deepEqual(settled(c), want, `${mode} at write ${k} (${fault.log[k]})`);
      assert.equal(membershipsOf(c, ELA)[0].points_balance, 45, `${mode} ${k}: points once`);
      assert.equal(cardsOf(c, ELA)[0].stamps_collected, 2, `${mode} ${k}: stamps once`);
    }
  }
});

test('an email on a profile with another phone: other details saved, email kept off, nothing joined', async () => {
  const c = clientsFor(world());
  const before = settled(c);
  const out = await save(c, BLANK, { updates: { name: 'Jo S' }, typedEmail: 'jo_smith@example.com' });
  assert.deepEqual({ kind: out.kind, emailCode: out.emailCode }, { kind: 'saved', emailCode: 'email_in_use' });
  const blank = row(c, 'customers', BLANK);
  assert.equal(blank.name, 'Jo S', 'the name was saved');
  assert.equal(blank.email, null, 'the email was not');
  assert.equal(blank.deleted_at, null);
  const jo = row(c, 'customers', 'f0f0f0f0-0000-4000-8000-000000000001');
  assert.equal(jo.phone, '+447700900123', 'the other phone is never moved (safeguard 1)');
  const unchanged = settled(c);
  unchanged.ops.customers = unchanged.ops.customers.map((r) => (r.id === BLANK ? { ...r, name: '' } : r));
  assert.deepEqual(unchanged, before, 'nothing but the name changed');
});

test('a free email is saved; a cleared box clears it; the member\'s own is left alone', async () => {
  const c = clientsFor(world());
  assert.deepEqual(await save(c, BLANK, { updates: {}, typedEmail: 'new@example.com' }).then((o) => [o.kind, o.emailCode]), ['saved', null]);
  assert.equal(row(c, 'customers', BLANK).email, 'new@example.com');
  const writes = c.fault.writes;
  await save(c, BLANK, { updates: {}, typedEmail: 'new@example.com' });
  assert.equal(c.fault.writes, writes, 'the same email again writes nothing');
  await save(c, BLANK, { updates: {}, typedEmail: '' });
  assert.equal(row(c, 'customers', BLANK).email, null);
});

test('a failed owners read never saves or joins the email', async () => {
  const c = clientsFor(world());
  const realFrom = c.ops.from;
  let reads = 0;
  c.ops.from = (table) => {
    const b = realFrom(table);
    if (table !== 'customers') return b;
    const ilike = b.ilike;
    b.ilike = (...a) => { reads += 1; ilike(...a); return { then: (ok) => Promise.resolve({ data: null, error: { message: 'read failed (fake)' } }).then(ok), limit() { return this; } }; };
    return b;
  };
  const out = await save(c);
  assert.ok(reads >= 1);
  assert.deepEqual([out.kind, out.emailCode], ['saved', 'email_not_saved']);
  assert.equal(row(c, 'customers', BLANK).email, null);
  assert.equal(row(c, 'customers', BLANK).deleted_at, null);
  assert.equal(row(c, 'customers', BLANK).name, 'Ela Stettner', 'the other details are saved');
});

test('the phone taken meanwhile: the join finishes without it and the old session signs in again', async () => {
  const fault = newFault();
  const c = clientsFor(world(), fault);
  // Stop the first save at the hand over of the phone (after the fold, before Ela takes it).
  const probe = clientsFor(world());
  await save(probe);
  const handOver = probe.fault.log.findIndex((w, i) => w === 'customers.update' && i > probe.fault.log.indexOf('customers.upsert'));
  assert.ok(handOver > 0);
  fault.at = handOver; fault.mode = 'before';
  const first = await save(c);
  assert.deepEqual([first.kind, first.emailCode], ['saved', 'join_incomplete'], 'press Save again');
  fault.at = null;
  // Somebody signs up with that phone before she presses Save again.
  await c.ops.from('customers').upsert([{ id: 'a9a9a9a9-0000-4000-8000-000000000009', org_id: ORG, phone: PHONE, email: null, name: '', deleted_at: null, tags: [] }], { onConflict: 'id' });
  const again = await save(c);
  assert.equal(again.kind, 'signed_out', 'her session names a folded in profile the phone cannot follow');
  assert.equal(row(c, 'customers', ELA).phone, null, 'never two profiles with one phone');
  assert.equal(cardsOf(c, ELA)[0].stamps_collected, 2);
});

test('a deleted profile that was not joined: sign in again, nothing written', async () => {
  const w = world();
  w.ops.customers = w.ops.customers.map((r) => (r.id === BLANK ? { ...r, deleted_at: '2026-09-27T09:00:00Z' } : r));
  const c = clientsFor(w);
  const before = settled(c);
  const out = await save(c);
  assert.equal(out.kind, 'signed_out');
  assert.deepEqual(settled(c), before);
});

test('runPortalJoin refuses what the merge core refuses, and moves no session', async () => {
  const c = clientsFor(world());
  const out = await runPortalJoin(c, { memberId: BLANK, ownerId: 'f0f0f0f0-0000-4000-8000-000000000002', provenPhone: PHONE, typed: {}, now: NOW });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'not_linked');
  assert.deepEqual(out.refusals.map((r) => r.code), ['different_org']);
});

// ── the wiring (Deno is not run here, so the edge function is pinned by its source) ──

test('loyalty-otp update_profile runs the join itself, with the service clients, never over HTTP', () => {
  const src = read('../../supabase/functions/loyalty-otp/index.ts');
  const up = src.slice(src.indexOf("if (action === 'update_profile') {"), src.indexOf("return json({ error: 'Unknown action."));
  assert.ok(up.includes('await saveMemberProfile(\n      { ops: opsAdmin, platform: platformAdmin },'), 'the shared run, service clients');
  assert.ok(!up.includes('functions/v1/customer-merge'), 'no HTTP call to customer-merge');
  assert.ok(up.includes('const provenPhone: string | null = session.phone || null;'), 'the phone proven with the code');
  // The joined account is answered in verify's shape: a fresh token for the kept profile, with the proven phone.
  assert.ok(up.includes('createSessionToken(joined.survivorId, session.companyId, provenPhone)'));
  assert.ok(up.includes('...(await memberAccount(joined.survivor, session.companyId, provenPhone)),'));
  assert.ok(up.includes('verified: true,') && up.includes('joined: true,'));
  // The notice never blocks or fails the join.
  assert.ok(up.includes('await afterReply(sendJoinNotice({'));
  assert.ok(src.includes('const safe = work.catch(() => {});'));
  // An email on another profile never fails the whole save.
  assert.ok(up.includes("return json({ updated: true, email_saved: false, code: outcome.emailCode, message: joinMessage(outcome.emailCode, 'email_not_saved') });"));
  assert.ok(up.includes("if (outcome.kind === 'signed_out') return json({ error: JOIN_MESSAGES.signed_out, code: 'sign_in_again' }, 401);"));
});

test('gift cards still come only from the phone proven with the code (safeguard 4)', () => {
  const src = read('../../supabase/functions/loyalty-otp/index.ts');
  const account = src.slice(src.indexOf('async function memberAccount('), src.indexOf('// ── The venue a portal save is made from'));
  assert.ok(account.includes('const giftCards = await giftCardsForProvenPhone(companyId, phone);'));
  assert.ok(!src.includes('recipient_email') && !src.includes('recipient_name'));
  // verify and the join both hand memberAccount the proven phone, never the stored one.
  assert.ok(src.includes('...(await memberAccount(customer, companyId, phone)),'));
  assert.ok(!/memberAccount\([^)]*\.phone\)/.test(src), 'never a profile\'s stored phone');
});

test('verify stays phone only: no email lookup, no join', () => {
  const src = read('../../supabase/functions/loyalty-otp/index.ts');
  const verify = src.slice(src.indexOf("if (action === 'verify') {"), src.indexOf("if (action === 'refresh') {"));
  assert.ok(verify.includes(".eq('phone', phone)"));
  assert.ok(!verify.includes("'email'") && !verify.includes('ilike') && !verify.includes('saveMemberProfile') && !verify.includes('runPortalJoin'));
  assert.ok(!/link_?email/i.test(src), 'no link email flow');
});

test('the notice goes through the welcome and receipt email path and is logged', () => {
  const src = read('../../supabase/functions/loyalty-otp/index.ts');
  const fn = src.slice(src.indexOf('async function sendJoinNotice('), src.indexOf('// ── Phone normalisation'));
  assert.ok(fn.includes("const sender = await resolveSenderForOrg(opsAdmin, p.orgId, EMAIL_FROM);"));
  assert.ok(fn.includes("provider: EMAIL_PROVIDER,"));
  assert.ok(fn.includes("await opsAdmin.from('receipt_emails').insert({"));
  assert.ok(fn.includes("console.log('[loyalty-otp] join notice'"));
  assert.ok(src.includes("const EMAIL_PROVIDER = (Deno.env.get('RECEIPT_EMAIL_PROVIDER') || 'log').toLowerCase();"));
});
