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

/** Sort the chats list: chats with something for me first (5.11.109), then newest message, then by name. */
export function sortConversations(list, titleOf = (c) => c.name || '') {
  return [...(list || [])].sort((a, b) => {
    const fa = Number(a.for_you || 0) > 0 ? 1 : 0;
    const fb = Number(b.for_you || 0) > 0 ? 1 : 0;
    const ta = a.last_message_at ? Date.parse(a.last_message_at) : 0;
    const tb = b.last_message_at ? Date.parse(b.last_message_at) : 0;
    return fb - fa || tb - ta || String(titleOf(a)).localeCompare(String(titleOf(b)));
  });
}

// ── 5.11.109: what is for me, the badge, @names in a bubble ─────────────────

/** Is this message for me: a direct message to me, or one that @mentions me? (Never my own.) */
export function isForMe(msg, me, conv) {
  if (!msg || !me || msg.sender_member_id === me || msg.deleted_at) return false;
  if (conv?.kind === 'dm') return true;
  return Array.isArray(msg.mentions) && msg.mentions.includes(me);
}

/** The mark on a chat row with something for me: "For you" in a direct message, else "Mentions you". */
export function forYouLabel(conv) {
  return conv?.kind === 'dm' ? 'For you' : 'Mentions you';
}

/**
 * The badge on the Chat tab (and the Back Office bell): unread in chats I have not muted, plus what
 * is for me in muted chats (a direct ask always counts, as it always pushes). Shown whenever > 0.
 */
export function badgeTotal(rows, now = Date.now()) {
  return (rows || []).reduce((n, r) => {
    const muted = r.muted_until && new Date(r.muted_until).getTime() > now;
    return n + (muted ? Number(r.for_you || 0) : Number(r.unread || 0));
  }, 0);
}

/** How many unread messages are for me, across chats. */
export function forYouTotal(rows) {
  return (rows || []).reduce((n, r) => n + Number(r.for_you || 0), 0);
}

const escapeRe = (t) => String(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A message's text in pieces, so @names can be drawn highlighted: [{ text, at, me }].
 * names: the display names that may be mentioned (the chat's members); myName: mine (drawn
 * stronger). Longest names first, so @Sam Lee beats @Sam; an @name sits between word edges (an
 * email address is not a mention).
 */
export function mentionParts(text, names = [], myName = '') {
  const t = String(text || '');
  const list = [...new Set((names || []).map((n) => String(n || '').trim()).filter(Boolean))].sort((a, b) => b.length - a.length);
  if (!t.includes('@') || !list.length) return [{ text: t, at: false, me: false }];
  const re = new RegExp(`(?<![\\p{L}\\p{N}])@(${list.map(escapeRe).join('|')})(?![\\p{L}\\p{N}])`, 'giu');
  const out = [];
  let last = 0;
  for (let m = re.exec(t); m; m = re.exec(t)) {
    if (m.index > last) out.push({ text: t.slice(last, m.index), at: false, me: false });
    out.push({ text: m[0], at: true, me: !!myName && m[1].toLowerCase() === String(myName).toLowerCase() });
    last = m.index + m[0].length;
  }
  if (last < t.length) out.push({ text: t.slice(last), at: false, me: false });
  return out.length ? out : [{ text: t, at: false, me: false }];
}

/**
 * The Back Office chat bell: the chats with something unread, for me first (direct messages and
 * @mentions), then newest. rows: the inbox chats ({ id, kind, name, unread, for_you, muted_until,
 * last_message_at, last }). Returns { unread, forYou, items: [{ id, title, unread, forYou, last }] }.
 */
export function inboxSummary(rows, { me = null, dmMembers = {}, profilesById = {}, now = Date.now(), max = 8 } = {}) {
  const list = (rows || []).filter((r) => Number(r.unread || 0) > 0 || Number(r.for_you || 0) > 0);
  const sorted = sortConversations(list);
  return {
    unread: badgeTotal(rows, now),
    forYou: forYouTotal(rows),
    items: sorted.slice(0, max).map((r) => ({
      id: r.id, kind: r.kind, title: conversationTitle(r, { me, membersByConv: dmMembers, profilesById }),
      unread: Number(r.unread || 0), forYou: Number(r.for_you || 0), last: r.last || null,
    })),
  };
}

/** A client id that makes a retry of the same send safe. */
export function newClientId() {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * One team-chat inbox answer as the Back Office bell shows it: inboxSummary on its chats, with the
 * caller's profile id (member_id) and the people, or null when the answer is a refusal. for_you
 * comes from the server (20261105a); before it, a direct message's unread counts as for you.
 */
export function inboxAnswerSummary(r) {
  if (!r || !r.ok) return null;
  const profilesById = Object.fromEntries((r.profiles || []).map((p) => [p.id, p]));
  const dmMembers = {};
  for (const d of r.dm_members || []) (dmMembers[d.conversation_id] ||= []).push(d);
  const rows = (r.convs || []).map((c) => ({
    ...c, unread: Number(c.unread || 0),
    for_you: c.for_you != null ? Number(c.for_you || 0) : (c.kind === 'dm' ? Number(c.unread || 0) : 0),
  }));
  const me = typeof r.member_id === 'string' && /^[0-9a-f-]{36}$/i.test(r.member_id) ? r.member_id : null;
  return { ...inboxSummary(rows, { me, dmMembers, profilesById }), me, profilesById };
}
