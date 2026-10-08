// src/lib/updateEmailRules.test.js: email an update to Back Office logins, the rules (8 Oct 2026).
// The draft limits, the Markdown subset and its escaping, the email frame and footer, who gets
// it (owners and managers with access and an email, staff left out, one email once), the text
// fingerprint that gates Send behind a test, the provider request, sending with a stub, and the
// Sent list rollup.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SUBJECT_MAX, BODY_MAX, MAX_RECIPIENTS_PER_SEND, TEST_PREFIX, TEST_NOTE, NO_PROVIDER_LINE,
  oneLine, cleanBodyMd, cleanDraft, textHash, sameText, isUuid, isEmail,
  escapeHtml, inlineHtml, inlineText, parseBlocks, blocksToHtml, blocksToText, renderMarkdown,
  emailFooter, buildEmail, servosSender, providerRequest, providerMessageId, providerReady,
  isStaffEmail, pickRecipients, countByCompany, sendQuestion, sendResultLine, peopleWord,
  deliverAll, stillToSend, rollupSends, countsLine, formatWhen, ROLE_LABEL,
} from '../../supabase/functions/_shared/updateEmailRules.js';
import * as app from './updateEmailRules.js';

const ORG_A = '00000000-0000-4000-8000-0000000000a1';
const ORG_B = '00000000-0000-4000-8000-0000000000b1';
const orgs = [{ id: ORG_A, name: 'Coffee Boy' }, { id: ORG_B, name: 'Wing Fest' }];

// ── the draft ───────────────────────────────────────────────────────────────

test('cleanDraft: a pasted what\'s new goes through as written, Windows line breaks made plain', () => {
  const d = cleanDraft({ subject: '  What\'s new this week ', body_md: '# Hello\r\n\r\nSome **news**.\r\n\r\n\r\n\r\n- one\r\n- two  \r\n' });
  assert.deepEqual(d, { ok: true, subject: 'What\'s new this week', bodyMd: '# Hello\n\nSome **news**.\n\n- one\n- two' });
});

test('cleanDraft: refuses a missing subject, a missing body, and too long (never cuts)', () => {
  assert.equal(cleanDraft({ subject: '', body_md: 'x' }).ok, false);
  assert.equal(cleanDraft({ subject: 'Hi', body_md: '  \n\n ' }).ok, false);
  assert.equal(cleanDraft({ subject: 'Hi', body_md: 'x' }).ok, true);
  const longSubject = cleanDraft({ subject: 'a'.repeat(SUBJECT_MAX + 1), body_md: 'x' });
  assert.equal(longSubject.ok, false);
  assert.match(longSubject.error, /too long/);
  assert.equal(cleanDraft({ subject: 'a'.repeat(SUBJECT_MAX), body_md: 'x' }).ok, true);
  const longBody = cleanDraft({ subject: 'Hi', body_md: 'b'.repeat(BODY_MAX + 1) });
  assert.equal(longBody.ok, false);
  assert.equal(cleanDraft({ subject: 'Hi', body_md: 'b'.repeat(BODY_MAX) }).ok, true);
  // bodyMd (camel) is accepted too: the screen's own draft shape.
  assert.equal(cleanDraft({ subject: 'Hi', bodyMd: 'x' }).ok, true);
});

test('oneLine and cleanBodyMd drop control characters but keep the words; tabs become spaces', () => {
  assert.equal(oneLine('New\u0007 update\nnow'), 'New update now');
  assert.equal(cleanBodyMd('\t- a\u0000b\n\n\n\nc'), '  - ab\n\nc');
});

test('textHash: the same text has the same code, any change has another, spaces at the ends do not count', () => {
  const a = textHash('Hi', 'Body **here**');
  assert.equal(textHash(' Hi ', 'Body **here**\n\n'), a);
  assert.notEqual(textHash('Hi', 'Body here'), a);
  assert.notEqual(textHash('Hi!', 'Body **here**'), a);
  assert.match(a, /^[0-9a-f]+$/);
});

test('sameText: row shape (body_md) against draft shape (bodyMd)', () => {
  assert.equal(sameText({ subject: 'Hi', body_md: 'A\n\nB' }, { subject: 'Hi ', bodyMd: 'A\r\n\r\nB\n' }), true);
  assert.equal(sameText({ subject: 'Hi', body_md: 'A' }, { subject: 'Hi', bodyMd: 'B' }), false);
  assert.equal(sameText(null, { subject: 'Hi', bodyMd: 'B' }), false);
});

test('isUuid and isEmail', () => {
  assert.equal(isUuid(ORG_A), true);
  assert.equal(isUuid('nope'), false);
  assert.equal(isEmail('peter@posup.co.uk'), true);
  assert.equal(isEmail('not an email'), false);
  assert.equal(isEmail('<a@b.c>'), false);
});

// ── Markdown ────────────────────────────────────────────────────────────────

test('escapeHtml: nothing typed reaches the email as HTML', () => {
  assert.equal(escapeHtml('<script>alert("x")</script> & \'q\''), '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;q&#39;');
  const { html } = renderMarkdown('<b>not bold</b> <img src=x onerror=alert(1)>');
  assert.doesNotMatch(html, /<b>|<img/);
  assert.match(html, /&lt;b&gt;not bold&lt;\/b&gt;/);
});

test('inline: bold, italic, a link, and a bare star left alone', () => {
  assert.equal(inlineHtml('a **b** c'), 'a <strong>b</strong> c');
  assert.equal(inlineHtml('a *b* c'), 'a <em>b</em> c');
  assert.equal(inlineHtml('*b*'), '<em>b</em>');
  assert.equal(inlineHtml('2*3*4'), '2*3*4', 'stars inside a sum are not italics');
  assert.equal(inlineHtml('**b *i* b**'), '<strong>b <em>i</em> b</strong>');
  assert.equal(inlineHtml('See [the guide](https://serv-os.app/help?a=1&b=2) now'),
    'See <a href="https://serv-os.app/help?a=1&amp;b=2" style="color:#0A8F4F;text-decoration:underline;">the guide</a> now');
  assert.equal(inlineHtml('[mail us](mailto:hello@posup.co.uk)'), '<a href="mailto:hello@posup.co.uk" style="color:#0A8F4F;text-decoration:underline;">mail us</a>');
});

test('inline: a link that is not web or mail is shown as written, never followed', () => {
  assert.equal(inlineHtml('[x](javascript:alert(1))'), '[x](javascript:alert(1))');
  assert.equal(inlineHtml('[x](ftp://a.b)'), '[x](ftp://a.b)');
  assert.equal(inlineText('[x](javascript:alert(1))'), '[x](javascript:alert(1))');
});

test('inline text: marks dropped, link as label (url)', () => {
  assert.equal(inlineText('a **b** *c* [d](https://e.f)'), 'a b c d (https://e.f)');
});

test('parseBlocks: headings, paragraphs with line breaks, bullets, numbers, blank lines', () => {
  const md = '# Title\nFirst line\nsecond line\n\n## Sub\n- one\n- two\n* three\n• four\n\n1. a\n2) b\n\nPlain\n#### deep\n###nospace';
  assert.deepEqual(parseBlocks(md), [
    { type: 'h', level: 1, text: 'Title' },
    { type: 'p', lines: ['First line', 'second line'] },
    { type: 'h', level: 2, text: 'Sub' },
    { type: 'ul', items: ['one', 'two', 'three', 'four'] },
    { type: 'ol', start: 1, items: ['a', 'b'] },
    { type: 'p', lines: ['Plain'] },
    { type: 'h', level: 3, text: 'deep' },
    { type: 'p', lines: ['###nospace'] },
  ]);
});

test('parseBlocks: a plain line straight after a list ends the list; nested bullets flatten', () => {
  assert.deepEqual(parseBlocks('- a\n  - b\nThanks'), [
    { type: 'ul', items: ['a', 'b'] },
    { type: 'p', lines: ['Thanks'] },
  ]);
  assert.deepEqual(parseBlocks(''), []);
  assert.deepEqual(parseBlocks(null), []);
});

test('blocksToHtml: inline styles on every element, a numbered list keeps its start', () => {
  const html = blocksToHtml(parseBlocks('## Hi\nA\nB\n\n3. x\n4. y\n\n- z'));
  assert.match(html, /^<h2 style="[^"]+">Hi<\/h2>\n<p style="[^"]+">A<br>B<\/p>\n<ol start="3" style="[^"]+"><li style="[^"]+">x<\/li><li style="[^"]+">y<\/li><\/ol>\n<ul style="[^"]+"><li style="[^"]+">z<\/li><\/ul>$/);
});

test('blocksToText: the plain alternative reads well on its own', () => {
  const text = blocksToText(parseBlocks('# Hi\nA **b**\nC\n\n- one\n- [two](https://x.y)\n\n2. a\n3. b'));
  assert.equal(text, 'Hi\n\nA b\nC\n\n- one\n- two (https://x.y)\n\n2. a\n3. b');
});

// ── the email ───────────────────────────────────────────────────────────────

test('emailFooter: names the company, and still reads without one', () => {
  assert.equal(emailFooter('Coffee Boy'), 'You get this because you have a ServOS Back Office login for Coffee Boy.');
  assert.equal(emailFooter(''), 'You get this because you have a ServOS Back Office login.');
});

test('buildEmail: real send has the frame, the body and the footer; a test adds [TEST] and a note and nothing else', () => {
  const real = buildEmail({ subject: 'What\'s new', bodyMd: '# Hi\n\nNews **here** <b>x</b>', companyName: 'Coffee Boy' });
  assert.equal(real.subject, 'What\'s new');
  assert.match(real.html, /^<!DOCTYPE html>/);
  assert.match(real.html, /<h1 style="[^"]+">Hi<\/h1>/);
  assert.match(real.html, /News <strong>here<\/strong> &lt;b&gt;x&lt;\/b&gt;/);
  assert.match(real.html, /You get this because you have a ServOS Back Office login for Coffee Boy\./);
  assert.doesNotMatch(real.html, /This is a test/);
  assert.doesNotMatch(real.html, /Unsubscribe/i);
  assert.equal(real.text, 'Hi\n\nNews here <b>x</b>\n\n--\nYou get this because you have a ServOS Back Office login for Coffee Boy.');
  // The title in the head is escaped too.
  assert.match(real.html, /<title>What&#39;s new<\/title>/);

  const t = buildEmail({ subject: 'What\'s new', bodyMd: '# Hi\n\nNews **here** <b>x</b>', companyName: 'Coffee Boy', test: true });
  assert.equal(t.subject, `${TEST_PREFIX}What's new`);
  assert.match(t.html, new RegExp(TEST_NOTE.replace(/\./g, '\\.')));
  assert.equal(t.text.startsWith(`${TEST_NOTE}\n\n`), true);
  // Same body either way: the test shows the real thing.
  assert.equal(t.html.replace(/\n {2}<tr><td style="padding:0 24px;">.*?<\/td><\/tr>/s, '').replace(/<title>.*?<\/title>/, ''), real.html.replace(/<title>.*?<\/title>/, ''));
});

test('servosSender: display name ServOS, reply to the same address, a bad or empty value falls back', () => {
  assert.deepEqual(servosSender('hello@posup.co.uk'), { from: 'ServOS <hello@posup.co.uk>', email: 'hello@posup.co.uk', replyTo: 'hello@posup.co.uk' });
  assert.deepEqual(servosSender('Receipts <Receipts@Serv-OS.app>'), { from: 'ServOS <receipts@serv-os.app>', email: 'receipts@serv-os.app', replyTo: 'receipts@serv-os.app' });
  assert.deepEqual(servosSender(''), { from: 'ServOS <hello@posup.co.uk>', email: 'hello@posup.co.uk', replyTo: 'hello@posup.co.uk' });
  assert.equal(servosSender('not an address').email, 'hello@posup.co.uk');
});

test('providerRequest: resend and postmark shapes, nothing for log or a missing key or a bad address', () => {
  const sender = servosSender('hello@posup.co.uk');
  const base = { sender, to: 'mo@coffeeboy.co.uk', subject: 'S', html: '<p>h</p>', text: 't' };
  const resend = providerRequest({ ...base, provider: 'resend', resendKey: 'rk' });
  assert.equal(resend.url, 'https://api.resend.com/emails');
  assert.deepEqual(resend.headers, { Authorization: 'Bearer rk', 'Content-Type': 'application/json' });
  assert.deepEqual(resend.body, { from: 'ServOS <hello@posup.co.uk>', to: ['mo@coffeeboy.co.uk'], subject: 'S', html: '<p>h</p>', text: 't', reply_to: 'hello@posup.co.uk' });
  const postmark = providerRequest({ ...base, provider: 'Postmark', postmarkKey: 'pk' });
  assert.equal(postmark.url, 'https://api.postmarkapp.com/email');
  assert.deepEqual(postmark.body, { From: 'ServOS <hello@posup.co.uk>', To: 'mo@coffeeboy.co.uk', Subject: 'S', HtmlBody: '<p>h</p>', TextBody: 't', ReplyTo: 'hello@posup.co.uk' });
  assert.equal(providerRequest({ ...base, provider: 'log' }), null);
  assert.equal(providerRequest({ ...base, provider: 'resend', resendKey: '' }), null);
  assert.equal(providerRequest({ ...base, provider: 'resend', resendKey: 'rk', to: 'nope' }), null);
  assert.equal(providerMessageId('resend', { id: 'r1' }), 'r1');
  assert.equal(providerMessageId('postmark', { MessageID: 'p1' }), 'p1');
  assert.equal(providerMessageId('resend', null), null);
  assert.equal(providerReady({ provider: 'resend', resendKey: 'rk' }), true);
  assert.equal(providerReady({ provider: 'resend', resendKey: '' }), false);
  assert.equal(providerReady({ provider: 'log' }), false);
  assert.match(NO_PROVIDER_LINE, /Nothing was sent/);
});

// ── who gets it ─────────────────────────────────────────────────────────────

const U = (n) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
const profiles = [
  { id: U(1), org_id: ORG_A, full_name: 'Mo Owner', role: 'owner', email: 'mo@coffeeboy.co.uk', bo_access: true },
  { id: U(2), org_id: ORG_A, full_name: 'Sam Manager', role: 'manager', email: 'sam@coffeeboy.co.uk', bo_access: true },
  { id: U(3), org_id: ORG_A, full_name: 'Old Manager', role: 'manager', email: 'old@coffeeboy.co.uk', bo_access: false },
  { id: U(4), org_id: ORG_A, full_name: 'No Email', role: 'owner', email: null, bo_access: true },
  { id: U(5), org_id: ORG_A, full_name: 'Till Staff', role: 'staff', email: 'till@coffeeboy.co.uk', bo_access: true },
  { id: U(6), org_id: ORG_B, full_name: 'Wing Owner', role: 'owner', email: 'owner@wingfest.com', bo_access: null },
  { id: U(7), org_id: ORG_B, full_name: 'Peter at Wing Fest', role: 'manager', email: 'peter@posup.co.uk', bo_access: true },
  { id: U(8), org_id: null, full_name: 'Neil', role: 'super_admin', email: 'neil@serv-os.app', bo_access: true },
  { id: U(9), org_id: ORG_A, full_name: 'Mo Again', role: 'manager', email: 'MO@coffeeboy.co.uk', bo_access: true },
];

test('pickRecipients: owners and managers with access and an email, staff out, one email once, company then name', () => {
  const { recipients, left } = pickRecipients({ profiles, orgs });
  assert.deepEqual(recipients.map((r) => [r.name, r.email, r.role, r.company]), [
    ['Mo Owner', 'mo@coffeeboy.co.uk', 'owner', 'Coffee Boy'],
    ['Sam Manager', 'sam@coffeeboy.co.uk', 'manager', 'Coffee Boy'],
    ['Wing Owner', 'owner@wingfest.com', 'owner', 'Wing Fest'],
  ]);
  assert.deepEqual(left, { notLogin: 1, noAccess: 1, noEmail: 1, staff: 2, managers: 0, otherCompany: 0, duplicate: 1 });
  assert.equal(recipients[0].userId, U(1), 'the owner wins the shared address, not the manager');
  assert.equal(recipients[0].orgId, ORG_A);
});

test('pickRecipients: the sign in email wins over the profile email', () => {
  const authEmails = new Map([[U(1), 'Mo.Real@CoffeeBoy.co.uk']]);
  const { recipients } = pickRecipients({ profiles: [profiles[0]], orgs, authEmails });
  assert.equal(recipients[0].email, 'mo.real@coffeeboy.co.uk');
  const asObject = pickRecipients({ profiles: [profiles[0]], orgs, authEmails: { [U(1)]: 'x@y.co' } });
  assert.equal(asObject.recipients[0].email, 'x@y.co');
});

test('pickRecipients: owners only, chosen companies, include staff', () => {
  assert.deepEqual(pickRecipients({ profiles, orgs, ownersOnly: true }).recipients.map((r) => r.email), ['mo@coffeeboy.co.uk', 'owner@wingfest.com']);
  assert.deepEqual(pickRecipients({ profiles, orgs, companyIds: [ORG_B] }).recipients.map((r) => r.email), ['owner@wingfest.com']);
  assert.deepEqual(pickRecipients({ profiles, orgs, companyIds: [] }).recipients, [], 'no company ticked means nobody');
  const staff = pickRecipients({ profiles, orgs, includeStaff: true }).recipients;
  assert.deepEqual(staff.map((r) => [r.email, r.company]), [
    ['mo@coffeeboy.co.uk', 'Coffee Boy'], ['sam@coffeeboy.co.uk', 'Coffee Boy'],
    ['neil@serv-os.app', 'ServOS'],
    ['peter@posup.co.uk', 'Wing Fest'], ['owner@wingfest.com', 'Wing Fest'],
  ]);
  // A super admin with no company is reached only when every company is picked.
  assert.deepEqual(pickRecipients({ profiles, orgs, includeStaff: true, companyIds: [ORG_B] }).recipients.map((r) => r.email), ['peter@posup.co.uk', 'owner@wingfest.com']);
});

test('pickRecipients: a company that is gone still names its people, and an unknown row never breaks it', () => {
  const { recipients } = pickRecipients({ profiles: [profiles[0], null, {}], orgs: [] });
  assert.equal(recipients[0].company, 'Company removed');
});

test('isStaffEmail: exact ServOS domains only', () => {
  assert.equal(isStaffEmail('Peter@PosUp.co.uk'), true);
  assert.equal(isStaffEmail('peter+tom@serv-os.app'), true);
  assert.equal(isStaffEmail('peter@posup.co.uk.evil.com'), false);
  assert.equal(isStaffEmail('owner@wingfest.com'), false);
  assert.equal(isStaffEmail(''), false);
});

test('countByCompany, peopleWord, sendQuestion, sendResultLine', () => {
  const { recipients } = pickRecipients({ profiles, orgs });
  assert.deepEqual([...countByCompany(recipients)], [[ORG_A, 2], [ORG_B, 1]]);
  assert.equal(peopleWord(1), '1 person');
  assert.equal(peopleWord(7), '7 people');
  assert.equal(sendQuestion(7), 'Email 7 people now?');
  assert.equal(sendResultLine({ sent: 7 }), 'Sent to 7 people.');
  assert.equal(sendResultLine({ sent: 6, failed: 1 }), 'Sent to 6 people. 1 email failed. See Sent below for who, then Send again: only the failed ones go.');
  assert.equal(sendResultLine({ sent: 0, skipped: 7 }), '7 people already had it. Nothing was sent twice.');
  assert.equal(sendResultLine({}), 'Nothing was sent.');
  assert.equal(MAX_RECIPIENTS_PER_SEND, 100);
  assert.equal(ROLE_LABEL.super_admin, 'ServOS staff');
});

// ── sending, with a stub ────────────────────────────────────────────────────

test('deliverAll: one failure never stops the others, results keep the order, the stub is the only sender', async () => {
  const { recipients } = pickRecipients({ profiles, orgs });
  const calls = [];
  const sendOne = async (r) => {
    calls.push(r.email);
    if (r.email === 'sam@coffeeboy.co.uk') throw new Error('Resend HTTP 422');
    if (r.email === 'owner@wingfest.com') return { ok: false, error: 'rate limited' };
    return { ok: true, id: `id-${r.name}` };
  };
  const out = await deliverAll(recipients, sendOne, { concurrency: 2 });
  assert.equal(calls.length, 3);
  assert.deepEqual(out.map((o) => [o.recipient.email, o.ok, o.id, o.error]), [
    ['mo@coffeeboy.co.uk', true, 'id-Mo Owner', null],
    ['sam@coffeeboy.co.uk', false, null, 'Resend HTTP 422'],
    ['owner@wingfest.com', false, null, 'rate limited'],
  ]);
  assert.deepEqual(await deliverAll([], sendOne), []);
});

test('stillToSend: a second try skips those already sent and takes the failed and queued again', () => {
  const { recipients } = pickRecipients({ profiles, orgs });
  const prior = [
    { to_email: 'MO@coffeeboy.co.uk', status: 'sent' },
    { to_email: 'sam@coffeeboy.co.uk', status: 'failed' },
    { to_email: 'owner@wingfest.com', status: 'queued' },
  ];
  const { todo, skipped } = stillToSend(recipients, prior);
  assert.deepEqual(todo.map((r) => r.email), ['sam@coffeeboy.co.uk', 'owner@wingfest.com']);
  assert.equal(skipped, 1);
  assert.deepEqual(stillToSend(recipients, []).todo.length, 3);
});

// ── the Sent list ───────────────────────────────────────────────────────────

const row = (over = {}) => ({
  id: 'r1', broadcast_id: 'b1', subject: 'What\'s new', body_md: '# Hi', to_email: 'mo@coffeeboy.co.uk', to_user_id: U(1), to_name: 'Mo Owner',
  org_id: ORG_A, role: 'owner', sent_by: U(8), sent_by_name: 'Peter', sent_at: '2026-10-08T10:00:00Z', provider: 'resend', provider_id: 'x',
  status: 'sent', error: null, is_test: false, ...over,
});

test('rollupSends: grouped by send, newest first, counts and people, a test marked', () => {
  const rows = [
    row(),
    row({ id: 'r2', to_email: 'sam@coffeeboy.co.uk', to_name: 'Sam Manager', role: 'manager', status: 'failed', error: 'Resend HTTP 422', sent_at: '2026-10-08T10:00:01Z' }),
    row({ id: 'r3', to_email: 'owner@wingfest.com', to_name: 'Wing Owner', org_id: ORG_B, status: 'queued', sent_at: '2026-10-08T10:00:02Z' }),
    row({ id: 'r4', broadcast_id: 'b0', subject: 'Older', sent_at: '2026-10-01T09:00:00Z' }),
    // A test row keeps the plain subject (is_test marks it), so the server can match it to the text.
    row({ id: 'r5', broadcast_id: 'bt', to_email: 'peter@posup.co.uk', is_test: true, sent_at: '2026-10-08T09:59:00Z' }),
    { id: 'junk' },
  ];
  const sends = rollupSends(rows, orgs);
  assert.deepEqual(sends.map((g) => [g.broadcastId, g.isTest, g.total, g.sent, g.failed, g.queued, g.sentAt]), [
    ['b1', false, 3, 1, 1, 1, '2026-10-08T10:00:00Z'],
    ['bt', true, 1, 1, 0, 0, '2026-10-08T09:59:00Z'],
    ['b0', false, 1, 1, 0, 0, '2026-10-01T09:00:00Z'],
  ]);
  assert.deepEqual(sends[0].recipients.map((r) => [r.name, r.company, r.status, r.error]), [
    ['Mo Owner', 'Coffee Boy', 'sent', null],
    ['Sam Manager', 'Coffee Boy', 'failed', 'Resend HTTP 422'],
    ['Wing Owner', 'Wing Fest', 'queued', null],
  ]);
  assert.equal(countsLine(sends[0]), '1 sent, 1 failed, 1 still queued');
  assert.equal(countsLine(sends[2]), '1 sent');
  assert.equal(sends[0].sentByName, 'Peter');
});

test('formatWhen: a readable time, and nothing for a bad date', () => {
  assert.equal(formatWhen('2026-10-08T14:32:00Z', 'Europe/London'), '8 Oct, 15:32');
  assert.equal(formatWhen('nope'), '');
});

// ── the app side re-export ──────────────────────────────────────────────────

test('src/lib/updateEmailRules.js re-exports the shared rules and adds the not ready check', () => {
  assert.equal(app.renderMarkdown, renderMarkdown, 'the screen previews with the very renderer the server sends');
  assert.equal(app.buildEmail, buildEmail);
  assert.equal(app.isMissingUpdateEmails({ code: '42P01' }), true);
  assert.equal(app.isMissingUpdateEmails({ code: 'PGRST205' }), true);
  assert.equal(app.isMissingUpdateEmails({ message: 'relation "public.update_emails" does not exist' }), true);
  assert.equal(app.isMissingUpdateEmails({ message: 'other' }), false);
  assert.equal(app.isMissingUpdateEmails(null), false);
  assert.match(app.NEEDS_UPDATE_LINE, /20261008b/);
});
