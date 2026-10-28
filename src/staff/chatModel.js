// src/staff/chatModel.js
//
// 5.11.102 team chat, the staff app's pure rules (no React, no network), tested by chatModel.test.js:
// names of chats, unread counts, @mentions, merging live messages, who may edit, Seen by.

// The message columns a login may read (20261103a grants exactly these; select('*') would be refused,
// because the edited and removed text columns are server only).
export const MSG_COLUMNS = 'id, org_id, conversation_id, sender_member_id, body, photos, reply_to, status, edited_at, deleted_at, urgent, mentions, client_id, created_at';
export const EDIT_WINDOW_MS = 15 * 60 * 1000;
export const PAGE_SIZE = 50;
export const REACTIONS = Object.freeze(['👍', '❤️', '😂', '😮', '😢', '🙏']);

/** The name a chat shows: a DM is the other person; a group its own name. */
export function conversationTitle(conv, { me, membersByConv = {}, profilesById = {} } = {}) {
  if (!conv) return '';
  if (conv.kind === 'dm') {
    const other = (membersByConv[conv.id] || []).find((m) => m.member_id !== me);
    return (other && profilesById[other.member_id]?.display_name) || 'Direct message';
  }
  if (conv.name) return conv.name;
  return conv.kind === 'venue' ? 'Venue' : conv.kind === 'announce' ? 'Announcements' : 'Group';
}

/** A short label for the kind of chat, under its name. */
export function kindLabel(conv) {
  return ({ dm: 'Direct message', group: 'Group', venue: 'Everyone at the venue', position: 'Position group', announce: 'Announcements' })[conv?.kind] || '';
}

/** What a message says on screen. */
export function messageText(msg) {
  if (!msg) return '';
  if (msg.deleted_at) return 'Message deleted';
  if (msg.status === 'hidden') return 'Removed by a manager';
  return msg.body || '';
}

/** The one line preview in the chats list. */
export function previewText(msg, { me, profilesById = {} } = {}) {
  if (!msg) return 'No messages yet';
  const who = msg.sender_member_id === me ? 'You' : (profilesById[msg.sender_member_id]?.display_name || '').split(' ')[0];
  const photos = Array.isArray(msg.photos) ? msg.photos.length : 0;
  const text = msg.deleted_at || msg.status === 'hidden' ? messageText(msg) : (msg.body || (photos ? (photos === 1 ? 'Photo' : `${photos} photos`) : ''));
  return who ? `${who}: ${text}` : text;
}

/** Merge new or changed messages into a list: one per id, oldest first. */
export function mergeMessages(list, incoming) {
  const byId = new Map((list || []).map((m) => [String(m.id), m]));
  for (const m of [].concat(incoming || [])) {
    if (!m || m.id == null) continue;
    const prev = byId.get(String(m.id));
    byId.set(String(m.id), prev ? { ...prev, ...m } : m);
  }
  return [...byId.values()].sort((a, b) => Number(a.id) - Number(b.id));
}

/** May I edit this message? Mine, visible, within 15 minutes. */
export function canEdit(msg, me, now = Date.now()) {
  return !!msg && msg.sender_member_id === me && !msg.deleted_at && msg.status === 'visible'
    && now - new Date(msg.created_at).getTime() < EDIT_WINDOW_MS;
}

/** May I delete it? Mine and not already gone. */
export function canDelete(msg, me) {
  return !!msg && msg.sender_member_id === me && !msg.deleted_at;
}

/** May I report it? Someone else's, still showing. */
export function canReport(msg, me) {
  return !!msg && !!msg.sender_member_id && msg.sender_member_id !== me && !msg.deleted_at && msg.status === 'visible';
}

/** Unread in one chat: messages after my read marker that someone else sent. */
export function unreadCount(messages, lastRead, me) {
  const mark = Number(lastRead || 0);
  return (messages || []).filter((m) => Number(m.id) > mark && m.sender_member_id !== me).length;
}

/** Is a mute still running? */
export function isMutedNow(until, now = Date.now()) {
  return !!until && new Date(until).getTime() > now;
}

/** The badge on the Chat tab: unread across chats I have not muted. */
export function unreadTotal(rows, now = Date.now()) {
  return (rows || []).reduce((n, r) => {
    const muted = r.muted_until && new Date(r.muted_until).getTime() > now;
    return n + (muted ? 0 : Number(r.unread || 0));
  }, 0);
}

/** Seen by: the members (not the sender) whose read marker has reached this message. */
export function seenBy(msg, members, profilesById = {}) {
  if (!msg) return [];
  return (members || [])
    .filter((m) => m.member_id !== msg.sender_member_id && !m.left_at && Number(m.last_read_message_id || 0) >= Number(msg.id))
    .map((m) => profilesById[m.member_id]?.display_name || 'Someone');
}

/** The @word being typed at the caret, or null. { start, query } */
export function mentionAt(text, caret) {
  const s = String(text || '').slice(0, caret ?? String(text || '').length);
  const m = /(^|\s)@([^\s@]{0,30})$/.exec(s);
  return m ? { start: s.length - m[2].length - 1, query: m[2].toLowerCase() } : null;
}

/** Put a person's name in place of the @word being typed. Returns { text, caret }. */
export function insertMention(text, at, caret, name) {
  const t = String(text || '');
  const before = t.slice(0, at.start);
  const after = t.slice(caret);
  const tag = `@${name} `;
  return { text: before + tag + after.replace(/^\S*/, ''), caret: before.length + tag.length };
}

/** The members named in a message (@Full Name), longest names first so @Sam Lee beats @Sam. */
export function mentionIds(text, members, profilesById = {}) {
  const t = String(text || '').toLowerCase();
  if (!t.includes('@')) return [];
  const named = (members || [])
    .map((m) => ({ id: m.member_id, name: String(profilesById[m.member_id]?.display_name || '').toLowerCase() }))
    .filter((x) => x.name)
    .sort((a, b) => b.name.length - a.name.length);
  const out = [];
  let rest = t;
  for (const x of named) {
    const tag = `@${x.name}`;
    let i = rest.indexOf(tag);
    let hit = false;
    while (i !== -1) {
      const next = rest.charAt(i + tag.length);
      if (!next || !/[a-z0-9]/i.test(next)) { hit = true; rest = rest.slice(0, i) + ' '.repeat(tag.length) + rest.slice(i + tag.length); }
      i = rest.indexOf(tag, i + 1);
    }
    if (hit) out.push(x.id);
  }
  return out;
}

/** Reactions on one message, grouped: [{ emoji, count, mine }]. */
export function groupReactions(reactions, messageId, me) {
  const by = new Map();
  for (const r of reactions || []) {
    if (String(r.message_id) !== String(messageId)) continue;
    const g = by.get(r.emoji) || { emoji: r.emoji, count: 0, mine: false };
    g.count += 1;
    if (r.member_id === me) g.mine = true;
    by.set(r.emoji, g);
  }
  return [...by.values()].sort((a, b) => b.count - a.count || a.emoji.localeCompare(b.emoji));
}

/** Short time for a message: today 14:05, else Tue 14:05, else 3 Oct. */
export function timeLabel(iso, locale = 'en-GB', now = new Date()) {
  if (!iso) return '';
  const d = new Date(iso);
  const sameDay = d.toDateString() === now.toDateString();
  const t = d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return t;
  if (now.getTime() - d.getTime() < 6 * 86400000) return `${d.toLocaleDateString(locale, { weekday: 'short' })} ${t}`;
  return d.toLocaleDateString(locale, { day: 'numeric', month: 'short' });
}

/** Sort the chats list: newest message first, then by name. */
export function sortConversations(list, titleOf = (c) => c.name || '') {
  return [...(list || [])].sort((a, b) => {
    const ta = a.last_message_at ? Date.parse(a.last_message_at) : 0;
    const tb = b.last_message_at ? Date.parse(b.last_message_at) : 0;
    return tb - ta || String(titleOf(a)).localeCompare(String(titleOf(b)));
  });
}

/** A client id that makes a retry of the same send safe. */
export function newClientId() {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}
