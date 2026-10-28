// src/staff/chatNotifyWiring.test.js
//
// 5.11.109 team chat notifications and counts: the pure rules (chatModel.js), the migration text
// (20261105a and its ROLLBACK; the local Postgres proof is supabase/tests/team_chat/notify.mjs), the
// edge functions, and the wiring in the staff app, the Manager app and Back Office.
// Run: node --test src/staff/chatNotifyWiring.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { badgeTotal, forYouTotal, isForMe, forYouLabel, mentionParts, inboxSummary, inboxAnswerSummary, sortConversations } from './chatModel.js';
import { serverReads } from './chatServerSource.js';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const MIG = read('supabase/migrations/20261105a_OPS_chat_notifications.sql');
const RB = read('supabase/migrations/20261105a_OPS_chat_notifications_ROLLBACK.sql');
const CHAT = read('supabase/migrations/20261103a_OPS_team_chat.sql');
const FN = read('supabase/functions/team-chat/index.ts');
const PUSH = read('supabase/functions/_shared/push.ts');
const future = Date.now() + 3600000;

// ── the rules ────────────────────────────────────────────────────────────────
test('what is for me: a direct message to me, or an @mention of me; never my own or a deleted one', () => {
  assert.equal(isForMe({ sender_member_id: 'd', mentions: [] }, 'me', { kind: 'dm' }), true);
  assert.equal(isForMe({ sender_member_id: 'd', mentions: ['me'] }, 'me', { kind: 'venue' }), true);
  assert.equal(isForMe({ sender_member_id: 'd', mentions: ['x'] }, 'me', { kind: 'group' }), false);
  assert.equal(isForMe({ sender_member_id: 'me', mentions: ['me'] }, 'me', { kind: 'dm' }), false);
  assert.equal(isForMe({ sender_member_id: 'd', mentions: ['me'], deleted_at: 'x' }, 'me', { kind: 'group' }), false);
  assert.equal(forYouLabel({ kind: 'dm' }), 'For you');
  assert.equal(forYouLabel({ kind: 'venue' }), 'Mentions you');
});

test('the badge: unread in chats I have not muted, plus what is for me in muted chats; shown whenever above 0', () => {
  const rows = [
    { id: 'a', unread: 3, for_you: 0 },
    { id: 'b', unread: 5, for_you: 1, muted_until: new Date(future).toISOString() },
    { id: 'c', unread: 2, for_you: 2, muted_until: new Date(future).toISOString() },
  ];
  assert.equal(badgeTotal(rows), 3 + 1 + 2);
  assert.equal(forYouTotal(rows), 3);
  assert.equal(badgeTotal([{ unread: 0, for_you: 0 }]), 0);
  const staff = read('src/surfaces/StaffSurface.jsx');
  assert.match(staff, /\{k === 'chat' && chat\.total > 0 && \(/, 'the Chat tab badge shows whenever the count is above 0');
  assert.match(read('src/staff/useTeamChat.js'), /const total = useMemo\(\(\) => badgeTotal\(rows\), \[rows\]\);/);
});

test('chats with something for me sort to the top, then newest', () => {
  const list = [
    { id: 'new', last_message_at: '2026-10-28T10:00:00Z', for_you: 0 },
    { id: 'dm', last_message_at: '2026-10-27T10:00:00Z', for_you: 1 },
    { id: 'old', last_message_at: '2026-10-20T10:00:00Z', for_you: 0 },
  ];
  assert.deepEqual(sortConversations(list).map((c) => c.id), ['dm', 'new', 'old']);
});

test('@names in a bubble: only real names, longest first, mine marked, not inside an email address', () => {
  const parts = mentionParts('@Sam Lee and @Cara Cole, mail cara@Sam', ['Sam', 'Sam Lee', 'Cara Cole'], 'Cara Cole');
  assert.deepEqual(parts.filter((p) => p.at).map((p) => [p.text, p.me]), [['@Sam Lee', false], ['@Cara Cole', true]]);
  assert.equal(parts.map((p) => p.text).join(''), '@Sam Lee and @Cara Cole, mail cara@Sam', 'nothing is lost');
  assert.deepEqual(mentionParts('no names here', ['Sam']), [{ text: 'no names here', at: false, me: false }]);
});

test('the Back Office bell summary: unread chats only, for me first, titles from the people', () => {
  const s = inboxSummary([
    { id: 'v', kind: 'venue', name: 'Leeds', unread: 4, for_you: 0, last_message_at: '2026-10-28T10:00:00Z' },
    { id: 'd', kind: 'dm', unread: 1, for_you: 1, last_message_at: '2026-10-27T10:00:00Z' },
    { id: 'q', kind: 'group', name: 'Quiet', unread: 0, for_you: 0, last_message_at: '2026-10-28T11:00:00Z' },
  ], { me: 'me', dmMembers: { d: [{ member_id: 'me' }, { member_id: 'x' }] }, profilesById: { x: { display_name: 'Dev Dhar' } } });
  assert.equal(s.unread, 5);
  assert.equal(s.forYou, 1);
  assert.deepEqual(s.items.map((i) => [i.id, i.title]), [['d', 'Dev Dhar'], ['v', 'Leeds']]);
});

test('the server source reads for_you, and before 20261105a counts a direct message\'s unread as for you', async () => {
  const src = serverReads(async () => ({ ok: true, convs: [
    { id: 'a', kind: 'venue', unread: 3, for_you: 1 }, { id: 'b', kind: 'dm', unread: 2 }, { id: 'c', kind: 'group', unread: 2 },
  ] }));
  const d = await src.inbox();
  assert.deepEqual(d.forYou, { a: 1, b: 2, c: 0 });
});

// ── the migration ────────────────────────────────────────────────────────────
test('20261105a: Ops only, refuses a second run, 3 s lock wait, ASCII, no exclamation mark, a check row; the rollback too', () => {
  for (const [name, s] of [['migration', MIG], ['rollback', RB]]) {
    assert.ok([...s].every((c) => c.charCodeAt(0) < 128), `${name} is ASCII`);
    assert.ok(!s.includes('!'), `${name} has no exclamation mark`);
    assert.match(s, /to_regclass\('public\.billing_state'\) is not null/);
    assert.match(s, /set local lock_timeout = '3s';/);
    assert.match(s, /-- VISIBLE CHECK/);
  }
  assert.match(MIG, /Chat notifications \(20261105a\) has run already\. Nothing was changed\./);
  assert.ok(MIG.indexOf('do $guard$') < MIG.indexOf('alter table'), 'the guard runs before any change');
});

test('20261105a: notify always by default, the person\'s own choice OR the company setting, POSUP Test switched off', () => {
  assert.match(MIG, /alter table public\.chat_settings alter column quiet_off_shift set default false;/);
  assert.match(MIG, /row\(p_org, 'managers', 'company', 'standard', true, 2, true, false, now\(\), null\)/, 'no settings row: off');
  assert.match(MIG, /alter table public\.chat_profiles add column quiet_off_shift boolean not null default false;/);
  assert.match(MIG, /and \(not \(st\.quiet_off_shift or p\.quiet_off_shift\) or p\.staff_id is null or v_urgent/);
  assert.match(MIG, /update public\.chat_settings set quiet_off_shift = false, updated_at = now\(\)\n where org_id = 'a59a6d97-ffaa-470e-8bb7-04cba789f335' and quiet_off_shift;/);
});

test('20261105a: the replaced functions are 20261103a with only the intended changes; the rollback puts the originals back', () => {
  const body = (s, name) => { const i = s.indexOf(`function public.${name}(`); const a = s.indexOf('$f$', i) + 3; return s.slice(a, s.indexOf('$f$', a)); };
  for (const n of ['_chat_settings', 'chat_whoami', 'chat_push_targets', 'chat_push_staff_devices', 'chat_inbox', 'chat_purge']) {
    assert.match(MIG, new RegExp(`create or replace function public\\.${n}\\(`), `replaces ${n}`);
    assert.equal(body(RB, n), body(CHAT, n), `the rollback restores ${n} word for word`);
    assert.notEqual(body(MIG, n), body(CHAT, n), `${n} changes`);
  }
  assert.match(MIG, /'for_you', \(select count\(\*\) from public\.chat_messages x/);
  assert.match(MIG, /'org_id', d\.org_id, 'member_id', d\.member_id\)/);
  assert.match(MIG, /delete from public\.push_log where id in \(select id from public\.push_log where created_at < now\(\) - interval '30 days' limit 20000\);/);
});

test('20261105a: the push log and the new functions are the service role\'s only', () => {
  assert.match(MIG, /revoke all on public\.push_log from public, anon, authenticated;/);
  assert.match(MIG, /alter table public\.push_log force row level security;/);
  assert.match(MIG, /create function public\.chat_me_quiet\(p_member uuid, p_on boolean\) returns jsonb\nlanguage plpgsql volatile security definer set search_path = public, pg_temp/);
  assert.match(MIG, /create function public\.chat_notify_status\(p_member uuid\) returns jsonb\nlanguage plpgsql stable security definer set search_path = public, pg_temp/);
  assert.match(MIG, /if pw\.level not in \('owner', 'manager'\) then return jsonb_build_object\('ok', false, 'code', 'not_allowed'\); end if;/);
  assert.match(MIG, /execute format\('revoke all on function %s from public, anon, authenticated', f\);/);
  assert.doesNotMatch(MIG, /grant[^;]*to (anon|authenticated)/i);
});

// ── the edge functions ───────────────────────────────────────────────────────
test('team-chat: me.quiet and notify.status, never through the Manager app PIN, a plain answer before the database update', () => {
  assert.match(FN, /MARKER 5\.11\.109 team-chat notifications/);
  assert.match(FN, /rpc2\('chat_me_quiet', \{ p_member: me, p_on: body\.on === true \}\)/);
  assert.match(FN, /rpc2\('chat_notify_status', \{ p_member: me \}\)/);
  const never = FN.match(/PIN_NEVER = new Set\(\[([^\]]+)\]\)/)[1];
  assert.match(never, /'me\.quiet'/);
  assert.match(never, /'notify\.status'/);
  assert.match(FN, /not_ready: 'This needs a database update first\. Please ask ServOS\.'/);
  assert.match(FN, /return answer\(d\?\.ok \? \{ \.\.\.d, member_id: d\.member_id \|\| me \} : d\);/, 'the inbox carries my profile id');
});

test('push.ts: every phone tried gets a push_log row (company, person, kind, sent or not, status, reason), never an error', async () => {
  assert.match(PUSH, /MARKER 5\.11\.109 push log/);
  assert.match(PUSH, /if \(log\.length\) await writePushLog\(log\);/);
  assert.match(PUSH, /\$\{SUPABASE_URL\}\/rest\/v1\/push_log/);
  assert.match(PUSH, /catch \{ \/\* only a record: the push itself has gone \*\/ \}/);
  // pushLogRow, run here (the file is TypeScript, so the function is lifted out and its types dropped).
  const src = PUSH.slice(PUSH.indexOf('export function pushLogRow'), PUSH.indexOf('async function writePushLog'))
    .replace('export function pushLogRow(d: PushDevice, m: PushMessage, r: PushResult): PushLogRow | null', 'function pushLogRow(d, m, r)')
    .replace(/\(m\?\.data as any\)/, '(m?.data)');
  const pushLogRow = new Function('UUID_RE', `${src}; return pushLogRow;`)(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  const org = '0a000000-0000-4000-8000-000000000001', mem = '0b000000-0000-4000-8000-000000000001';
  assert.deepEqual(pushLogRow({ org_id: org, member_id: mem }, { data: { type: 'chat' } }, { ok: true, status: 201 }),
    { org_id: org, member_id: mem, kind: 'chat', ok: true, status: 201, reason: null });
  assert.deepEqual(pushLogRow({ org_id: org, member_id: 'x' }, {}, { ok: false, gone: true, status: 410 }),
    { org_id: org, member_id: null, kind: 'push', ok: false, status: 410, reason: 'gone' });
  assert.equal(pushLogRow({ member_id: mem }, {}, { ok: true }), null, 'an older database (no company on the phone): no row');
  assert.equal(pushLogRow({ org_id: org }, {}, { ok: false, skipped: 'apns_not_set_up' }).reason, 'apns_not_set_up');
});

// ── the screens ──────────────────────────────────────────────────────────────
test('staff app: Me has Quiet when off shift; chat rows carry For you or Mentions you; bubbles highlight @names', () => {
  const staff = read('src/surfaces/StaffSurface.jsx');
  assert.match(staff, /\{tab === 'me' && <MeTab snap=\{snap\} onSaved=\{loadSnapshot\} chat=\{chat\} \/>\}/);
  assert.match(staff, /const r = await chat\.call\(\{ action: 'me\.quiet', on: !mine \}\);/);
  assert.match(staff, /role="switch" aria-checked=\{mine\} aria-label="Quiet when off shift"/);
  const ui = read('src/staff/StaffChat.jsx');
  assert.match(ui, /\{c\.for_you > 0 && <span title=/);
  assert.match(ui, /\{forYouLabel\(c\)\}/);
  assert.match(ui, /<MessageBody msg=\{m\} gone=\{gone\} profiles=\{profiles\} me=\{me\} mine=\{mineMsg\} \/>/);
  assert.match(ui, /const names = msg\.mentions\.map\(\(id\) => profiles\[id\]\?\.display_name\)\.filter\(Boolean\);/, 'only the people the message really mentions');
  // The Manager app and Back Office draw the same ChatTab, so they get the same marks.
  assert.match(read('src/surfaces/manager/ManagerChat.jsx'), /<ChatTab chat=\{chat\}/);
  assert.match(read('src/staff/chatSource.js'), /\.is\('deleted_at', null\)\.contains\('mentions', \[w\.member_id\]\)/);
});

test('Back Office: the chat bell on every page, the count on Workforce and Team chat, the bell opens Chats and that chat', () => {
  const bo = read('src/backoffice/BackOfficeApp.jsx');
  assert.match(bo, /import \{ ChatBell, ChatCount \} from '\.\/components\/ChatBell';/);
  assert.match(bo, /import \{ useBoChatInbox, requestChatOpen \} from '\.\/components\/chatBellData';/);
  assert.match(bo, /const chatSummary = useBoChatInbox\(\{ enabled: !isMock && !!authUser && secondStepOk && !!orgCtx && canOpen\('wf-chat'\), orgId: orgCtx\?\.venueOrgId \|\| null \}\);/);
  assert.match(bo, /<ChatBell summary=\{chatSummary\} onOpen=\{openTeamChat\} \/>/);
  assert.match(bo, /\{sec\.label === 'Workforce' && <ChatCount summary=\{chatSummary\} \/>\}/);
  assert.match(bo, /\{id === 'wf-chat' && <ChatCount summary=\{chatSummary\} \/>\}/);
  assert.match(bo, /const openTeamChat = \(conversationId\) => \{ requestChatOpen\(conversationId\); setSection\('wf-chat'\); \};/);
  const bell = read('src/backoffice/components/chatBellData.js');
  assert.match(bell, /export const BO_CHAT_POLL_MS = 30000;/);
  assert.match(bell, /if \(alive\) setState\(inboxAnswerSummary\(r\)\);/);
  assert.match(bell, /action: 'inbox'/);
  assert.match(bell, /if \(document\.visibilityState !== 'visible'\) return;/, 'only while the tab is in front');
  const wf = read('src/backoffice/sections/workforce/WfChat.jsx');
  assert.match(wf, /if \(openReq && openReq !== prevReq\) \{ setPrevReq\(openReq\); setTab\('chats'\); \}/);
  assert.match(wf, /openRequest=\{openReq\?\.id \|\| null\} onOpenHandled=\{clearOpenReq\}/);
  assert.match(wf, /call\(\{ action: 'notify\.status' \}\)/);
  assert.match(wf, /\[\[false, 'No: every message pings their phone \(the default\)'\]/);
});

test('the Back Office bell reads an inbox answer the way the staff app counts', () => {
  const me = '0a000000-0000-4000-8000-000000000001', x = '0a000000-0000-4000-8000-000000000002';
  const s = inboxAnswerSummary({ ok: true, member_id: me,
    profiles: [{ id: x, display_name: 'Dev Dhar' }], dm_members: [{ conversation_id: 'd', member_id: me }, { conversation_id: 'd', member_id: x }],
    convs: [{ id: 'd', kind: 'dm', unread: 2, last_message_at: '2026-10-27T10:00:00Z' }, { id: 'v', kind: 'venue', name: 'Leeds', unread: 1, for_you: 1, last_message_at: '2026-10-28T10:00:00Z' }] });
  assert.equal(s.me, me);
  assert.equal(s.unread, 3);
  assert.equal(s.forYou, 3, 'a direct message before 20261105a counts as for you, and the @mention');
  assert.deepEqual(s.items.map((i) => i.title), ['Leeds', 'Dev Dhar']);
  assert.equal(inboxAnswerSummary({ ok: false, code: 'no_member' }), null, 'a refusal: no bell');
});
