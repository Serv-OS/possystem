// src/lib/emailJoinNotice.test.js
//
// THE ONE NOTICE AFTER AN AUTOMATIC JOIN (27 Sep 2026). When a till joins a customer by email,
// the email's owner is told once: "Your <venue> stamps and points are now linked to your phone
// ending 8167. If this wasn't you, reply to this email or tell staff." This drives the rules in
// supabase/functions/_shared/emailJoinNotice.js and pins the door of customer-join-notice: who may
// ask, that the join is proved by the profile's own data (never the caller's word), at most one
// notice per phone, the existing email path (send-receipt), and no gift card anywhere.
// Run: `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  EMAIL_JOIN_TAG, emailJoinTags, emailJoinPhones, joinNoticeTag, noticeSentFor, lastFour, validateNoticeRequest,
  decideJoinNotice, noticeVenueName, joinNoticeMessage, escapeHtml,
} from '../../supabase/functions/_shared/emailJoinNotice.js';

const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const code = (src) => src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

const ORG = 'cd97f0f0-4807-4e45-801e-56114b22128a';
const LEEDS = '1e252e7c-c875-4971-b91d-1e945c26956b';
const SIMON = 'aaa70b4f-0000-4000-8000-000000000001';
const SHELL = 'c462cbfc-be83-4ee9-9459-91ea0a682215';
const PHONE = '+447415748167';
const NOW = '2026-09-27T12:00:00.000Z';

const simon = (over = {}) => ({ id: SIMON, org_id: ORG, name: 'Simon Hughes', email: 'simon_h@example.com', phone: PHONE, tags: [], deleted_at: null, ...over });

test('the trail: which phone an email match linked, and when; nothing already there is dropped', () => {
  const tags = emailJoinTags(['merged:x'], PHONE, NOW);
  assert.deepEqual(tags, ['merged:x', `email_join:${PHONE}`, `email_join_at:${NOW}`]);
  assert.deepEqual(emailJoinTags(tags, PHONE, NOW), tags, 'written twice is written once');
  assert.deepEqual(emailJoinTags(null, PHONE, NOW), [`email_join:${PHONE}`, `email_join_at:${NOW}`]);
  assert.deepEqual(emailJoinPhones(tags), [PHONE]);
  assert.equal(joinNoticeTag(PHONE), `join_notice:${PHONE}`);
  assert.equal(EMAIL_JOIN_TAG.NOTICE, 'join_notice:');
  assert.equal(noticeSentFor([`join_notice:${PHONE}`], '07415748167'), true, 'the same number written another way');
  assert.equal(noticeSentFor([`join_notice:${PHONE}`], '+447700900123'), false);
});

test('the body is read in one place', () => {
  assert.deepEqual(validateNoticeRequest({ customer_id: SIMON, location_id: LEEDS }), { ok: true, customerId: SIMON, locationId: LEEDS, sourceId: null });
  assert.deepEqual(validateNoticeRequest({ customer_id: SIMON, location_id: LEEDS, source_id: SHELL }).sourceId, SHELL);
  assert.equal(validateNoticeRequest({ customer_id: 'x', location_id: LEEDS }).ok, false);
  assert.equal(validateNoticeRequest({ customer_id: SIMON }).ok, false);
  assert.equal(validateNoticeRequest({ customer_id: SIMON, location_id: LEEDS, source_id: 'nope' }).ok, false);
  assert.equal(validateNoticeRequest(null).ok, false);
});

test('a notice goes only for a join the profile itself records, for its CURRENT phone, once', () => {
  // (a) the till's own trail
  const joined = simon({ tags: [`email_join:${PHONE}`, `email_join_at:${NOW}`] });
  assert.deepEqual(decideJoinNotice({ customer: joined, venueOrgId: ORG }), { ok: true, phone: PHONE, tag: `join_notice:${PHONE}` });
  // (b) the merge core's trail on the folded in profile
  const source = { id: SHELL, org_id: ORG, deleted_at: NOW, tags: [`merged_into:${SIMON}`, `merge_phone:${PHONE}`, 'merge_done'] };
  assert.equal(decideJoinNotice({ customer: simon(), source, venueOrgId: ORG }).ok, true);
  // the caller's word is not a join
  assert.deepEqual(decideJoinNotice({ customer: simon(), venueOrgId: ORG }), { ok: false, code: 'not_joined' });
  // a trail for ANOTHER phone (the phone was changed since) is not this join
  assert.equal(decideJoinNotice({ customer: simon({ tags: ['email_join:+447700900123'] }), venueOrgId: ORG }).code, 'not_joined');
  // a source that is not folded into THIS profile, or still live, or handed over another phone
  assert.equal(decideJoinNotice({ customer: simon(), source: { ...source, tags: ['merged_into:00000000-0000-4000-8000-000000000000', `merge_phone:${PHONE}`] }, venueOrgId: ORG }).code, 'not_joined');
  assert.equal(decideJoinNotice({ customer: simon(), source: { ...source, deleted_at: null }, venueOrgId: ORG }).code, 'not_joined');
  assert.equal(decideJoinNotice({ customer: simon(), source: { ...source, tags: [`merged_into:${SIMON}`, 'merge_phone:+447700900123'] }, venueOrgId: ORG }).code, 'not_joined');
  assert.equal(decideJoinNotice({ customer: simon(), source: { ...source, org_id: 'other' }, venueOrgId: ORG }).code, 'not_joined');
  // once per phone
  assert.equal(decideJoinNotice({ customer: simon({ tags: [`email_join:${PHONE}`, `join_notice:${PHONE}`] }), venueOrgId: ORG }).code, 'already_sent');
  // another organisation's venue, a deleted profile, no email, no phone
  assert.equal(decideJoinNotice({ customer: joined, venueOrgId: 'other-org' }).code, 'other_org');
  assert.equal(decideJoinNotice({ customer: joined, venueOrgId: null }).code, 'other_org');
  assert.equal(decideJoinNotice({ customer: { ...joined, deleted_at: NOW }, venueOrgId: ORG }).code, 'not_found');
  assert.equal(decideJoinNotice({ customer: null, venueOrgId: ORG }).code, 'not_found');
  assert.equal(decideJoinNotice({ customer: { ...joined, email: ' ' }, venueOrgId: ORG }).code, 'no_email');
  assert.equal(decideJoinNotice({ customer: { ...joined, phone: null }, venueOrgId: ORG }).code, 'no_phone');
});

test("Peter's words, with the venue and the last four digits only", () => {
  const m = joinNoticeMessage({ venueName: 'Coffee Boy Leeds', phone: PHONE });
  assert.equal(m.text, "Your Coffee Boy Leeds stamps and points are now linked to your phone ending 8167. If this wasn't you, reply to this email or tell staff.");
  assert.equal(m.subject, 'Your Coffee Boy Leeds loyalty is now linked to your phone');
  assert.doesNotMatch(m.text, /7415/, 'never the whole number');
  const bare = joinNoticeMessage({ venueName: '', phone: '12' });
  assert.equal(bare.text, "Your stamps and points are now linked to your phone. If this wasn't you, reply to this email or tell staff.");
  assert.equal(lastFour('+44 7415 748167'), '8167');
  assert.equal(noticeVenueName('  Coffee   Boy ', 'x'), 'Coffee Boy');
  assert.equal(noticeVenueName('', 'Platform name'), 'Platform name');
  assert.equal(escapeHtml(`<b>"Tom's"</b> & co`), '&lt;b&gt;&quot;Tom&#39;s&quot;&lt;/b&gt; &amp; co');
  for (const s of [m.text, m.subject, bare.text]) assert.doesNotMatch(s, /[\u2013\u2014]/, 'no en or em dashes');
});

test('customer-join-notice: asks who is calling first, proves the join from data, sends once through send-receipt', () => {
  const src = code(read('../../supabase/functions/customer-join-notice/index.ts'));
  // the body is read only through validateNoticeRequest
  assert.match(src, /validateNoticeRequest\(body\)/);
  assert.doesNotMatch(src, /body\.(customer_id|source_id|location_id)/);
  // the caller is settled (service role, or staff or a device of the venue) before any customer is read
  const who = src.indexOf('callerStaffOrDevice(');
  const firstRead = src.indexOf(".from('customers')");
  assert.ok(who > 0 && firstRead > who, 'caller check before the customer read');
  assert.match(src, /if \(!f\.staff && !f\.device\)/);
  // the decision is the pure rule, on the service role's own read
  assert.match(src, /decideJoinNotice\(\{ customer, source, venueOrgId \}\)/);
  // one statement claims the notice, only while the profile is exactly as read
  assert.match(src, /\.eq\('updated_at', c\.updated_at\)/);
  assert.match(src, /\.eq\('phone', decision\.phone\)/);
  // the existing email path, with the service role (provider, branded sender, receipt_emails audit)
  assert.match(src, /functions\/v1\/send-receipt/);
  assert.match(src, /authorization: `Bearer \$\{SERVICE_ROLE\}`/);
  // HTML never carries raw text
  assert.match(src, /wrapInEmailHtml\(escapeHtml\(msg\.text\), \{ venueName: escapeHtml\(venueName\) \}\)/);
  // a till learns nothing about the customer from the answer
  assert.doesNotMatch(src, /json\(\{[^}]*email:/);
  // gift cards are never read or changed here
  assert.doesNotMatch(src, /gift_card/);
});
