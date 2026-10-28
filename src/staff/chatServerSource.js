// src/staff/chatServerSource.js
//
// 5.11.106 team chat read through the server. Two screens have no row level security reads of
// their own and go through the team-chat function instead (inbox, thread, members.list), polled:
//   the Manager app   a paired device and a manager's PIN (serverChatSource in chatSource.js)
//   Back Office       the signed in Back Office person's own login, acting as their office chat
//                     profile (backOfficeChatSource below). Back Office runs on a desktop browser
//                     with no realtime channel set up for chat, so it polls like the Manager app.
// This file has no imports, so the tests can run it with a pretend server.

export const MAX_LIST = 60;
// Back Office: how long one bootstrap answer is reused. Every Back Office bootstrap re-runs the
// company's automatic membership on the server, so the list poll must not repeat it every 15 s.
export const BO_BOOTSTRAP_KEEP_MS = 5 * 60 * 1000;
// Back Office: how often an open conversation asks for anything new (the list polls every 15 s
// in useTeamChat).
export const BO_THREAD_POLL_MS = 10000;

const empty = () => ({ profiles: {}, convs: [], mine: {}, dmMembers: {}, last: {}, unread: {} });

/** The reads every server source shares: inbox, thread, members, no live channel. */
export function serverReads(call, upload) {
  return {
    live: false,
    async inbox() {
      const r = await call({ action: 'inbox' });
      const out = empty();
      if (!r || !r.ok) return { ...out, error: true, message: r && r.message };
      for (const p of r.profiles || []) out.profiles[p.id] = p;
      for (const c of r.convs || []) {
        out.mine[c.id] = { conversation_id: c.id, role: c.my_role, muted_until: c.muted_until, last_read_message_id: c.last_read_message_id };
        if (c.last) out.last[c.id] = c.last;
        out.unread[c.id] = Number(c.unread || 0);
      }
      out.convs = (r.convs || []).slice(0, MAX_LIST);
      for (const d of r.dm_members || []) (out.dmMembers[d.conversation_id] ||= []).push(d);
      return out;
    },
    async thread(convId, { before = null, after = null } = {}) {
      const r = await call({ action: 'thread', conversation_id: convId, before, after });
      return r && r.ok ? { messages: r.messages || [], reactions: r.reactions || [] } : { messages: [], reactions: [] };
    },
    async members(convId) {
      const r = await call({ action: 'members.list', conversation_id: convId });
      return r && r.ok ? r.members || [] : [];
    },
    subscribe() { return () => {}; },
    upload,
  };
}

/**
 * Back Office chat: the signed in person's own chats, read and sent through team-chat with their
 * Back Office login. `post(body)` is one call to team-chat with that login; `orgId` picks the
 * company when the login reaches two; `who` is the bootstrap answer the screen already has (so
 * opening the Chats tab costs no second bootstrap).
 */
export function backOfficeChatSource({ post, upload, orgId = null, who = null, now = () => Date.now() }) {
  const raw = (body) => post(orgId ? { org_id: orgId, ...body } : body);
  let boot = who && who.ok ? { at: now(), r: who } : null;
  const call = async (body) => {
    const action = body && body.action;
    if (action === 'bootstrap') {
      if (boot && now() - boot.at < BO_BOOTSTRAP_KEEP_MS) return boot.r;
      const r = await raw(body);
      boot = r && r.ok ? { at: now(), r } : null;
      return r;
    }
    // Saying OK to the privacy notice changes the bootstrap answer: ask again next time.
    if (action === 'privacy.ok') boot = null;
    return raw(body);
  };
  return { ...serverReads(call, upload), call, office: true, threadPollMs: BO_THREAD_POLL_MS };
}
