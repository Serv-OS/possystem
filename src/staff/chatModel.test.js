// src/staff/chatModel.test.js — 5.11.102 team chat, the staff app's pure rules.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  conversationTitle, messageText, previewText, mergeMessages, canEdit, canDelete, canReport, unreadCount, unreadTotal,
  seenBy, isMutedNow, mentionAt, insertMention, mentionIds, groupReactions, sortConversations, timeLabel, newClientId, EDIT_WINDOW_MS,
} from './chatModel.js';

const P = { me: { display_name: 'Cara Cole' }, d: { display_name: 'Dev Dhar' }, s: { display_name: 'Sam' }, sl: { display_name: 'Sam Lee' } };

test('a DM is named after the other person; groups by their name', () => {
  const membersByConv = { c1: [{ member_id: 'me' }, { member_id: 'd' }] };
  assert.equal(conversationTitle({ id: 'c1', kind: 'dm' }, { me: 'me', membersByConv, profilesById: P }), 'Dev Dhar');
  assert.equal(conversationTitle({ id: 'c2', kind: 'dm' }, { me: 'me', membersByConv, profilesById: P }), 'Direct message');
  assert.equal(conversationTitle({ id: 'c3', kind: 'venue', name: 'Leeds' }), 'Leeds');
  assert.equal(conversationTitle({ id: 'c4', kind: 'announce' }), 'Announcements');
});

test('message text: deleted and hidden say so; previews name the sender', () => {
  assert.equal(messageText({ body: 'x', deleted_at: '2026-10-26' }), 'Message deleted');
  assert.equal(messageText({ body: '', status: 'hidden' }), 'Removed by a manager');
  assert.equal(previewText({ sender_member_id: 'me', body: 'hi', status: 'visible' }, { me: 'me', profilesById: P }), 'You: hi');
  assert.equal(previewText({ sender_member_id: 'd', body: '', photos: [{}, {}], status: 'visible' }, { me: 'me', profilesById: P }), 'Dev: 2 photos');
  assert.equal(previewText(null), 'No messages yet');
});

test('merging keeps one per id, oldest first, and applies updates', () => {
  const a = mergeMessages([{ id: 2, body: 'b' }, { id: 1, body: 'a' }], [{ id: 3, body: 'c' }, { id: 2, body: 'B', edited_at: 'x' }]);
  assert.deepEqual(a.map((m) => [m.id, m.body]), [[1, 'a'], [2, 'B'], [3, 'c']]);
  assert.equal(mergeMessages(a, { id: '3', body: 'C' }).length, 3);
});

test('edit within 15 minutes of my own visible message; delete mine; report others', () => {
  const now = Date.parse('2026-10-26T12:00:00Z');
  const fresh = { sender_member_id: 'me', status: 'visible', created_at: new Date(now - 60000).toISOString() };
  assert.ok(canEdit(fresh, 'me', now));
  assert.ok(!canEdit({ ...fresh, created_at: new Date(now - EDIT_WINDOW_MS - 1).toISOString() }, 'me', now));
  assert.ok(!canEdit(fresh, 'd', now));
  assert.ok(!canEdit({ ...fresh, deleted_at: 'x' }, 'me', now));
  assert.ok(canDelete(fresh, 'me') && !canDelete(fresh, 'd'));
  assert.ok(canReport(fresh, 'd') && !canReport(fresh, 'me') && !canReport({ ...fresh, status: 'hidden' }, 'd'));
});

test('unread: after my marker, not mine; muted chats leave the badge', () => {
  const msgs = [{ id: 1, sender_member_id: 'd' }, { id: 2, sender_member_id: 'me' }, { id: 3, sender_member_id: 'd' }];
  assert.equal(unreadCount(msgs, 1, 'me'), 1);
  assert.equal(unreadCount(msgs, null, 'me'), 2);
  const now = Date.parse('2026-10-26T12:00:00Z');
  assert.ok(isMutedNow('2026-10-27T00:00:00Z', now) && !isMutedNow('2026-10-25T00:00:00Z', now) && !isMutedNow(null, now));
  assert.equal(unreadTotal([{ unread: 2 }, { unread: 3, muted_until: '2026-10-27T00:00:00Z' }, { unread: 1, muted_until: '2026-10-25T00:00:00Z' }], now), 3);
});

test('Seen by: members whose marker reached the message, never the sender', () => {
  const members = [{ member_id: 'me', last_read_message_id: 9 }, { member_id: 'd', last_read_message_id: 5 }, { member_id: 's', last_read_message_id: 4 }, { member_id: 'sl', last_read_message_id: 9, left_at: 'x' }];
  assert.deepEqual(seenBy({ id: 5, sender_member_id: 'me' }, members, P), ['Dev Dhar']);
});

test('@mentions: the word being typed, putting a name in, and finding who was named', () => {
  assert.deepEqual(mentionAt('hey @de', 7), { start: 4, query: 'de' });
  assert.equal(mentionAt('email me@x', 10), null);
  assert.equal(mentionAt('hey @dev now', 12), null);
  const r = insertMention('hey @de', { start: 4, query: 'de' }, 7, 'Dev Dhar');
  assert.deepEqual(r, { text: 'hey @Dev Dhar ', caret: 14 });
  const members = [{ member_id: 'd' }, { member_id: 's' }, { member_id: 'sl' }];
  assert.deepEqual(mentionIds('@Sam Lee can you and @Dev Dhar swap', members, P).sort(), ['d', 'sl']);
  assert.deepEqual(mentionIds('@Sam and @Sam Lee', members, P).sort(), ['s', 'sl']);
  assert.deepEqual(mentionIds('@Samuel', members, P), []);
  assert.deepEqual(mentionIds('no tags', members, P), []);
});

test('reactions grouped with mine marked; chats sorted newest first; time labels; client ids', () => {
  const g = groupReactions([{ message_id: 1, emoji: '👍', member_id: 'd' }, { message_id: 1, emoji: '👍', member_id: 'me' }, { message_id: 1, emoji: '😂', member_id: 'd' }, { message_id: 2, emoji: '👍', member_id: 'd' }], 1, 'me');
  assert.deepEqual(g, [{ emoji: '👍', count: 2, mine: true }, { emoji: '😂', count: 1, mine: false }]);
  const s = sortConversations([{ id: 'a', name: 'B', last_message_at: null }, { id: 'b', name: 'A', last_message_at: '2026-10-26T10:00:00Z' }, { id: 'c', name: 'A' }]);
  assert.deepEqual(s.map((c) => c.id), ['b', 'c', 'a']);
  const now = new Date('2026-10-26T15:00:00Z');
  assert.match(timeLabel('2026-10-26T14:05:00Z', 'en-GB', now), /\d\d:\d\d/);
  assert.equal(timeLabel(''), '');
  assert.notEqual(newClientId(), newClientId());
});
