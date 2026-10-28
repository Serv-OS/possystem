// src/staff/boChatWiring.test.js
//
// 5.11.106 chat from Back Office. The owner: "there needs to be a way to chat from the back office
// and send messages out from there too." These tests pin the Back Office chat source (run with a
// pretend team-chat server) and the wiring: the Chats tab is first in Workforce, Team chat, it
// mounts the staff app's own chat screen (not a copy), the owner's private message door stays a
// reading door, and team-chat seats an owner in the venue groups of their own company only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { backOfficeChatSource, serverReads, BO_BOOTSTRAP_KEEP_MS, BO_THREAD_POLL_MS, MAX_LIST } from './chatServerSource.js';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const WF = read('src/backoffice/sections/workforce/WfChat.jsx');
const CHAT = read('src/staff/StaffChat.jsx');
const SRC = read('src/staff/chatSource.js');
const FN = read('supabase/functions/team-chat/index.ts');

function fakeServer(answers = {}) {
  const calls = [];
  const post = async (body) => {
    calls.push(body);
    const a = answers[body.action];
    return typeof a === 'function' ? a(body) : (a ?? { ok: true });
  };
  return { calls, post };
}

test('every Back Office call carries the company and goes to team-chat with the login', async () => {
  const srv = fakeServer();
  const src = backOfficeChatSource({ post: srv.post, orgId: 'org-1' });
  await src.call({ action: 'send', conversation_id: 'c1', body: 'Hello' });
  assert.deepEqual(srv.calls[0], { org_id: 'org-1', action: 'send', conversation_id: 'c1', body: 'Hello' });
  const noOrg = fakeServer();
  await backOfficeChatSource({ post: noOrg.post }).call({ action: 'inbox' });
  assert.deepEqual(noOrg.calls[0], { action: 'inbox' }, 'no company picked: the server uses the login\'s own');
});

test('the screen\'s first bootstrap is reused: opening Chats costs no second bootstrap', async () => {
  const srv = fakeServer({ bootstrap: { ok: true, member_id: 'm2', level: 'owner' } });
  let t = 1000;
  const who = { ok: true, member_id: 'm1', level: 'owner' };
  const src = backOfficeChatSource({ post: srv.post, orgId: 'o', who, now: () => t });
  assert.equal(await src.call({ action: 'bootstrap' }), who);
  t += BO_BOOTSTRAP_KEEP_MS - 1;
  assert.equal(await src.call({ action: 'bootstrap' }), who, 'the 15 s list poll does not re-run the company sync');
  assert.equal(srv.calls.length, 0);
  t += 2;
  const fresh = await src.call({ action: 'bootstrap' });
  assert.equal(fresh.member_id, 'm2', 'after five minutes it asks again');
  assert.equal(srv.calls.length, 1);
});

test('saying OK to the privacy notice asks for a fresh bootstrap; a refused bootstrap is never kept', async () => {
  let n = 0;
  const srv = fakeServer({ bootstrap: () => (++n === 1 ? { ok: false, message: 'Chat is not switched on yet.' } : { ok: true, member_id: 'm', privacy_ok: n > 2 }) });
  const src = backOfficeChatSource({ post: srv.post });
  assert.equal((await src.call({ action: 'bootstrap' })).ok, false);
  assert.equal((await src.call({ action: 'bootstrap' })).privacy_ok, false, 'tried again after a refusal');
  assert.equal((await src.call({ action: 'bootstrap' })).privacy_ok, false, 'kept');
  await src.call({ action: 'privacy.ok' });
  assert.equal((await src.call({ action: 'bootstrap' })).privacy_ok, true, 'asked again after privacy.ok');
});

test('the inbox, a thread and members come from the server in the shape the shared store reads', async () => {
  const srv = fakeServer({
    inbox: {
      ok: true,
      profiles: [{ id: 'p1', display_name: 'Ann', kind: 'staff' }, { id: 'me', display_name: 'Peter', kind: 'office' }],
      convs: [
        { id: 'c1', kind: 'venue', name: 'Leeds', my_role: 'admin', muted_until: null, last_read_message_id: 4, unread: '3', last: { id: 7, body: 'hi' } },
        { id: 'c2', kind: 'dm', my_role: 'member', unread: 0 },
      ],
      dm_members: [{ conversation_id: 'c2', member_id: 'p1' }, { conversation_id: 'c2', member_id: 'me' }],
    },
    thread: (b) => ({ ok: true, messages: [{ id: 9, conversation_id: b.conversation_id }], reactions: [{ message_id: 9, member_id: 'p1', emoji: '👍' }] }),
    'members.list': { ok: true, members: [{ member_id: 'p1', role: 'member' }] },
  });
  const src = backOfficeChatSource({ post: srv.post, orgId: 'o' });
  assert.equal(src.live, false, 'no live channel: the store polls');
  assert.equal(src.threadPollMs, BO_THREAD_POLL_MS);
  assert.ok(BO_THREAD_POLL_MS >= 10000 && BO_THREAD_POLL_MS <= 15000);
  const box = await src.inbox();
  assert.equal(box.unread.c1, 3);
  assert.equal(box.mine.c1.role, 'admin');
  assert.equal(box.last.c1.id, 7);
  assert.equal(box.profiles.p1.display_name, 'Ann');
  assert.equal(box.dmMembers.c2.length, 2);
  assert.deepEqual(box.convs.map((c) => c.id), ['c1', 'c2']);
  const th = await src.thread('c1', { after: 8 });
  assert.equal(th.messages[0].id, 9);
  assert.deepEqual(srv.calls.at(-1), { org_id: 'o', action: 'thread', conversation_id: 'c1', before: null, after: 8 });
  assert.equal((await src.members('c1'))[0].member_id, 'p1');
  assert.equal(typeof src.subscribe(), 'function');
});

test('a refused inbox shows the server\'s words; refused reads are empty, never a crash', async () => {
  const srv = fakeServer({ inbox: { ok: false, message: 'Chat is switched off for you. Please speak to your manager.' }, thread: { ok: false }, 'members.list': { ok: false } });
  const src = backOfficeChatSource({ post: srv.post });
  const box = await src.inbox();
  assert.equal(box.error, true);
  assert.match(box.message, /switched off/);
  assert.deepEqual(await src.thread('c'), { messages: [], reactions: [] });
  assert.deepEqual(await src.members('c'), []);
});

test('the list is capped like the Manager app; the Manager app uses the same reads', async () => {
  const convs = Array.from({ length: MAX_LIST + 5 }, (_, i) => ({ id: `c${i}`, kind: 'group' }));
  const box = await serverReads(async () => ({ ok: true, convs }), null).inbox();
  assert.equal(box.convs.length, MAX_LIST);
  assert.match(SRC, /export function serverChatSource\([^)]*\) \{\s+const call = [^\n]+\n\s+return \{ \.\.\.serverReads\(call,/);
  assert.match(SRC, /export function backOfficeChatSource\(/);
  assert.match(SRC, /post: \(body\) => post\(client, body\)/, 'Back Office posts with its own login (the main client)');
});

test('Workforce, Team chat: Chats is the first tab and opens first, with the unread count', () => {
  assert.match(WF, /const \[tab, setTab\] = useState\('chats'\);/);
  assert.match(WF, /const tabs = \[\['chats', 'Chats', chat\.total\], \['groups', 'Groups'\], \['reports', 'Reports to check', openCount\],/);
  for (const t of ["['settings', 'Settings']", "['words', 'Word lists']", "['log', 'Moderation log']", "['export', 'Export a person']", "['dm', 'Read a private message (owner only)']"]) {
    assert.ok(WF.includes(t), `kept: ${t}`);
  }
  assert.match(WF, /const chat = useTeamChat\(source\);/, 'the store lives on the screen, so the count shows on every tab');
  assert.match(WF, /setSource\(r\.level === 'staff' \? null : backOfficeChatSource\(\{ orgId, who: r \}\)\);/);
  assert.match(WF, /\{tab === 'chats' && <ChatTab chat=\{chat\} locale="en-GB" pushApp="none" embed emptyNote="Your chats\. Groups you are in, and direct messages\."\s+openRequest=\{openReq\?\.id \|\| null\} onOpenHandled=\{clearOpenReq\} \/>\}/);
  assert.match(WF, /import \{ ChatTab \} from '\.\.\/\.\.\/\.\.\/staff\/StaffChat';/, 'the staff app\'s own screen, not a copy');
  assert.doesNotMatch(WF, /function (Conversation|NewChat)\b/, 'no forked chat components');
});

test('the owner\'s private message door is a reading door, explained in plain words, Pick one kept', () => {
  const door = WF.slice(WF.indexOf('function OpenDm('));
  assert.match(door, /Read a private message \(owner only\)/);
  assert.match(door, /only for a grievance, a safety worry or the law/);
  assert.match(door, /typing a reason/);
  assert.match(door, /kept in the log/);
  assert.match(door, /This is for reading, not sending/);
  assert.match(door, /The list is empty until people have sent each other direct messages\./);
  assert.match(door, /<option value="">Pick one<\/option>/);
  assert.match(door, /action: 'owner\.open_dm', conversation_id: pick, reason/);
});

test('the shared chat screen fits Back Office: composer in the panel, list beside the chat when wide', () => {
  assert.match(CHAT, /export function ChatTab\(\{[^}]*embed = false, emptyNote = '', fitScreen = false \}\)/);
  assert.match(CHAT, /const split = useWide\(embed\);/);
  assert.match(CHAT, /const WIDE_QUERY = '\(min-width: 1024px\)';/);
  assert.match(CHAT, /if \(conv && !split\) return convView;/, 'narrow: the staff app\'s single column');
  assert.match(CHAT, /gridTemplateColumns: 'minmax\(260px, 340px\) minmax\(0, 1fr\)'/);
  assert.match(CHAT, /<Conversation key=\{conv\.id\}.* embed=\{embed\} fit=\{fitScreen && !embed\} \/>/);
  const composer = CHAT.slice(CHAT.indexOf('In Back\n          Office it sits at the foot of the panel.'));
  assert.match(composer, /style=\{embed\s+\? \{ marginTop: 8,/, 'not fixed to the bottom of the window in Back Office');
  assert.match(CHAT, /source\.threadPollMs \|\| 5000/, 'the Manager app keeps 5 s, Back Office uses its own');
  assert.match(CHAT, /if \(document\.visibilityState === 'visible'\) fetchNewer\(\)/, 'no polling while the browser tab is hidden');
});

test('team-chat: an owner is seated in the venue groups of their own company only, not automatic, existing rows kept', () => {
  const boot = FN.slice(FN.indexOf("case 'bootstrap': {"), FN.indexOf("case 'inbox':"));
  assert.match(boot, /await rpc2\('chat_sync_org', \{ p_org: caller\.orgId, p_staff: null \}\)/, 'managers: the sync seats them (user_locations)');
  assert.match(boot, /const w = await rpc2\('chat_whoami', \{ p_member: me \}\);\s+if \(w\?\.ok\) await seatOwner\(caller, w\.level\)/);
  const groups = FN.slice(FN.indexOf('async function seatGroups('), FN.indexOf('async function seatOwner('));
  assert.match(groups, /from\('chat_conversations'\)\.select\('id, created_by'\)\.eq\('org_id', orgId\)\.in\('kind', \['venue', 'announce'\]\)/);
  assert.match(groups, /if \(openOnly\) q = q\.is\('archived_at', null\);/);
  const seat = FN.slice(FN.indexOf('async function seatOwner('), FN.indexOf('async function sweepOwnerSeats('));
  assert.match(seat, /if \(level !== 'owner' \|\| !caller\.hasBackOffice \|\| caller\.viaPin\) return;/);
  assert.match(seat, /const convs = await seatGroups\(caller\.orgId, true\);/, 'their own company only');
  assert.match(seat, /!got\.has\(id\)/, 'a row that exists is never inserted again');
  assert.match(seat, /role: 'admin', auto: false/);
  assert.match(seat, /ignoreDuplicates: true/);
  assert.match(FN, /MARKER 5\.11\.106 team-chat owner seats/);
});

test('plain words: no dashes as punctuation in the new Back Office chat text', () => {
  for (const [name, s] of [['WfChat', WF], ['StaffChat', CHAT], ['chatServerSource', read('src/staff/chatServerSource.js')]]) {
    assert.doesNotMatch(s, /[–—]/, `${name} has no en or em dash`);
  }
});

// ── 5.11.106 iPhone fixes (Peter, on his iPhone): "when the keyboard comes up it pushes the whole
// chat off the screen rather than just the text" and "you can pinch and zoom, which is wrong".
const STAFF = read('src/surfaces/StaffSurface.jsx');
const MANAGER = read('src/surfaces/manager/ManagerChat.jsx');

test('the staff app viewport: fixed to the screen, notch aware, keyboard shrinks the page, put back on leaving', () => {
  assert.match(STAFF, /export const STAFF_VIEWPORT = 'width=device-width, initial-scale=1\.0, maximum-scale=1, user-scalable=no, viewport-fit=cover, interactive-widget=resizes-content';/);
  const fx = STAFF.slice(STAFF.indexOf('MARKER 5.11.106 staff app fixed to the screen'), STAFF.indexOf('The staff app deliberately uses the servos glass skin'));
  assert.match(fx, /m\.setAttribute\('content', STAFF_VIEWPORT\);/);
  assert.match(fx, /if \(prev\) m\.setAttribute\('content', prev\);/, 'reverted on unmount (the notch trap: other surfaces keep their own)');
  assert.match(fx, /document\.addEventListener\('gesturestart', noPinch\);/);
  assert.match(fx, /document\.removeEventListener\('gesturestart', noPinch\)/);
  assert.doesNotMatch(read('index.html'), /user-scalable=no/, 'only the staff app is fixed, not every surface');
});

test('the staff app chat: no double tap zoom, 16px boxes, the phone box only in the staff app', () => {
  assert.match(STAFF, /<div style=\{\{ touchAction: 'manipulation' \}\}>\s+<ChatTab [^\n]* fitScreen \/>/);
  assert.match(CHAT, /const inputStyle = \{[^}]*fontSize: 16,/);
  assert.match(CHAT, /fit=\{fitScreen && !embed\}/);
  assert.doesNotMatch(MANAGER, /fitScreen/, 'the Manager app layout is unchanged');
  assert.doesNotMatch(WF, /fitScreen/, 'the Back Office layout is unchanged');
});

test('an open chat on a phone is the size of the visible screen: header still, list scrolls, box at the bottom', () => {
  const hook = CHAT.slice(CHAT.indexOf('function readViewport()'), CHAT.indexOf('// Back Office only: is the window wide enough'));
  assert.match(hook, /top: vv \? vv\.offsetTop : 0, height/);
  assert.match(hook, /const height = vv \? vv\.height : window\.innerHeight;/);
  assert.match(hook, /vv\?\.addEventListener\('resize', update\);\s+vv\?\.addEventListener\('scroll', update\);/);
  assert.match(hook, /vv\?\.removeEventListener\('resize', update\);\s+vv\?\.removeEventListener\('scroll', update\);/);
  assert.match(CHAT, /const vp = useVisualViewport\(fit\);/);
  const portal = CHAT.slice(CHAT.indexOf('if (!fit || !vp) return view;'));
  assert.match(portal, /createPortal\(\s+<div style=\{\{ position: 'fixed', left: 0, right: 0, top: vp\.top, height: vp\.height,/);
  assert.match(portal, /touchAction: 'manipulation'/);
  assert.match(portal, /document\.body,/, 'outside the staff page that scrolls and pulls to refresh');
  assert.match(CHAT, /ref=\{embed \|\| fit \? scrollRef : null\} style=\{embed \|\| fit \? \{ flex: 1, minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain'/, 'the list is the only scroller');
  const composer = CHAT.slice(CHAT.indexOf('In Back\n          Office it sits at the foot of the panel.'));
  assert.match(composer, /: fit \? \{ margin: '8px -10px 0', padding: `8px 12px \$\{vp\?\.keyboard \? '8px'/, 'not position fixed on the phone');
  assert.match(CHAT, /html\.style\.overflow = 'hidden'; body\.style\.overflow = 'hidden';/, 'no page scroll while a chat is open');
  assert.match(CHAT, /return \(\) => \{ html\.style\.overflow = prev\[0\]; body\.style\.overflow = prev\[1\];/);
  assert.match(CHAT, /onFocus=\{\(\) => \{ if \(fit\) setTimeout\(scrollEnd, 300\); \}\}/, 'focusing the box shows the newest message');
  assert.match(CHAT, /if \(!fit \|\| !vpHeight \|\| document\.activeElement !== taRef\.current\) return undefined;/, 'and again as the keyboard comes up');
});

// ── 5.11.106 security review of the owner seats: a seat must not outlive the owner.
test('team-chat: a demoted owner\'s seats go back to the sync before it runs; a re-promoted owner is seated again', () => {
  const boot = FN.slice(FN.indexOf("case 'bootstrap': {"), FN.indexOf("case 'inbox':"));
  assert.match(boot, /if \(caller\.hasBackOffice\) \{\s+await sweepOwnerSeats\(caller\)[^\n]*\n\s+await rpc2\('chat_sync_org'/, 'Back Office only, and before the sync');
  const sweep = FN.slice(FN.indexOf('async function sweepOwnerSeats('), FN.indexOf('async function isMember('));
  assert.match(sweep, /if \(!caller\.hasBackOffice \|\| caller\.viaPin\) return;/);
  assert.match(sweep, /\.eq\('org_id', caller\.orgId\)\.eq\('auto', false\)\.is\('left_at', null\)\.in\('conversation_id', convs\.map/, 'this company\'s active seat rows in venue and announcement groups');
  assert.match(sweep, /creator\.get\(r\.conversation_id\) !== r\.member_id/, 'the creator of an announcement group is never touched');
  assert.match(sweep, /rpc\('chat_whoami', \{ p_member: m \}\)/, 'the database says who is still an owner');
  assert.match(sweep, /if \(w\.ok && w\.level === 'owner' && w\.active !== false\) continue;/);
  assert.match(sweep, /update\(\{ auto: true \}\)/, 'handed back to the sync, which removes it or keeps a manager in their own venue');
  const groups = FN.slice(FN.indexOf('async function seatGroups('), FN.indexOf('async function seatOwner('));
  assert.match(groups, /\.in\('kind', \['venue', 'announce'\]\)\s+\.not\('location_id', 'is', null\)/);
  const seat = FN.slice(FN.indexOf('async function seatOwner('), FN.indexOf('async function sweepOwnerSeats('));
  assert.match(seat, /update\(\{ left_at: null, left_reason: null, auto: false, role: 'admin' \}\)\s+\.eq\('member_id', caller\.memberId\)\.eq\('org_id', caller\.orgId\)\.eq\('left_reason', 'auto'\)/, 'only rows the automatic side took');
  assert.ok(seat.indexOf("eq('left_reason', 'auto')") < seat.indexOf('upsert('), 'seated again before new seats are added');
  assert.match(FN, /TODO \(needs a migration, not tonight\): put owners and Admins into want0 of chat_sync_org/);
});
