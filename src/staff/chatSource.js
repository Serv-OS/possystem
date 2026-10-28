// src/staff/chatSource.js
//
// 5.11.102 team chat: where the chat screens get their data. One shape, two doors:
//   staffChatSource()   the staff app. The person's own login reads the database directly (row
//                       level security, members only) and listens live (realtime, filtered to
//                       their own chats). Writes through the team-chat function.
//   serverChatSource()  the Manager app: a paired device and a manager's PIN, no personal login,
//                       so row level security would show nothing. Everything goes through the
//                       team-chat function (inbox, thread, members.list) and is polled.
//   backOfficeChatSource()  Back Office (5.11.106): the Back Office login's own chats, the same
//                       server reads as the Manager app, polled (chatServerSource.js).
// Each source: { live, call(body), inbox(who), thread(convId, { before, after }), members(convId),
// subscribe(me, convIds, onEvent), upload(path, token, file) }.

import { staffSupabase, supabase as mainSupabase } from '../lib/supabase';
import { MSG_COLUMNS, PAGE_SIZE } from './chatModel';
import { MAX_LIST, serverReads, backOfficeChatSource as backOfficeSource } from './chatServerSource';

async function post(client, body) {
  try {
    const { data: sess } = await client.auth.getSession();
    const jwt = sess?.session?.access_token;
    const url = `${client.supabaseUrl || import.meta.env.VITE_SUPABASE_URL}/functions/v1/team-chat`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(jwt ? { authorization: `Bearer ${jwt}` } : {}) },
      body: JSON.stringify(body),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok && !j.code) return { ok: false, code: 'server', status: res.status, message: `Chat is not available right now (${res.status}).` };
    return { status: res.status, ...j };
  } catch {
    return { ok: false, code: 'offline', message: 'No connection. Your message is still in the box, try again.' };
  }
}

/** One call to the team-chat function with this client's login (Back Office uses its own). */
export const callTeamChat = (client, body) => post(client, body);

const empty = () => ({ profiles: {}, convs: [], mine: {}, dmMembers: {}, last: {}, unread: {}, forYou: {} });

export function staffChatSource(client = staffSupabase) {
  return {
    live: true,
    call: (body) => post(client, body),
    async inbox(w) {
      const out = empty();
      const [pr, cv, mr] = await Promise.all([
        client.from('chat_profiles').select('id, display_name, kind').eq('org_id', w.org_id).order('display_name').range(0, 999),
        client.from('chat_conversations').select('*').is('archived_at', null).order('last_message_at', { ascending: false, nullsFirst: false }).limit(MAX_LIST),
        client.from('chat_members').select('conversation_id, role, muted_until, last_read_message_id').eq('member_id', w.member_id).is('left_at', null).limit(1000),
      ]);
      if (cv.error || mr.error) return { ...out, error: true };
      for (const p of pr.data || []) out.profiles[p.id] = p;
      for (const r of mr.data || []) out.mine[r.conversation_id] = r;
      out.convs = (cv.data || []).filter((c) => out.mine[c.id]);
      const dmIds = out.convs.filter((c) => c.kind === 'dm').map((c) => c.id);
      if (dmIds.length) {
        const { data } = await client.from('chat_members').select('conversation_id, member_id').in('conversation_id', dmIds).limit(1000);
        for (const r of data || []) (out.dmMembers[r.conversation_id] ||= []).push(r);
      }
      await Promise.all(out.convs.map(async (c) => {
        const mark = Number(out.mine[c.id]?.last_read_message_id || 0);
        // 5.11.109: what is for me. A direct message: every unread one. A group: unread ones that
        // @mention me (chat_messages.mentions holds the profile ids).
        const [lm, uc, fy] = await Promise.all([
          client.from('chat_messages').select(MSG_COLUMNS).eq('conversation_id', c.id).order('id', { ascending: false }).limit(1),
          client.from('chat_messages').select('id', { count: 'exact', head: true }).eq('conversation_id', c.id).gt('id', mark).neq('sender_member_id', w.member_id),
          c.kind === 'dm' ? null
            : client.from('chat_messages').select('id', { count: 'exact', head: true }).eq('conversation_id', c.id).gt('id', mark).neq('sender_member_id', w.member_id)
              .is('deleted_at', null).contains('mentions', [w.member_id]),
        ]);
        if (lm.data?.[0]) out.last[c.id] = lm.data[0];
        out.unread[c.id] = uc.count || 0;
        out.forYou[c.id] = c.kind === 'dm' ? out.unread[c.id] : (fy?.count || 0);
      }));
      return out;
    },
    async thread(convId, { before = null, after = null } = {}) {
      let q = client.from('chat_messages').select(MSG_COLUMNS).eq('conversation_id', convId).order('id', { ascending: false }).limit(PAGE_SIZE);
      if (before) q = q.lt('id', before);
      if (after) q = q.gt('id', after);
      const { data } = await q;
      const messages = data || [];
      let reactions = [];
      if (messages.length) {
        const { data: rs } = await client.from('chat_reactions').select('message_id, member_id, emoji').eq('conversation_id', convId).in('message_id', messages.map((m) => m.id)).limit(1000);
        reactions = rs || [];
      }
      return { messages, reactions };
    },
    async members(convId) {
      const { data } = await client.from('chat_members').select('member_id, role, last_read_message_id, left_at').eq('conversation_id', convId).is('left_at', null).range(0, 999);
      return data || [];
    },
    subscribe(me, convIds, onEvent) {
      const ch = client.channel(`team-chat-${me}`);
      const ids = (convIds || []).slice(0, 100);
      if (ids.length) {
        const inList = `conversation_id=in.(${ids.join(',')})`;
        ch.on('postgres_changes', { event: '*', schema: 'public', table: 'chat_messages', filter: inList }, (p) => onEvent({ table: 'messages', p }));
        ch.on('postgres_changes', { event: '*', schema: 'public', table: 'chat_reactions', filter: inList }, (p) => onEvent({ table: 'reactions', p }));
      }
      ch.on('postgres_changes', { event: '*', schema: 'public', table: 'chat_members', filter: `member_id=eq.${me}` }, (p) => onEvent({ table: 'members', p }));
      ch.subscribe();
      return () => { client.removeChannel(ch); };
    },
    upload: (path, token, file) => client.storage.from('chat-photos').uploadToSignedUrl(path, token, file),
  };
}

export function serverChatSource({ opsLocationId, pin, client = mainSupabase }) {
  const call = (body) => post(client, { ...body, ops_location_id: opsLocationId, pin: String(pin || '') });
  return { ...serverReads(call, (path, token, file) => client.storage.from('chat-photos').uploadToSignedUrl(path, token, file)), call };
}

// MARKER 5.11.106 Back Office chat: the signed in Back Office person's own chats, through the
// server with their Back Office login (chatServerSource.js), polled.
export function backOfficeChatSource({ orgId = null, who = null, client = mainSupabase } = {}) {
  return backOfficeSource({
    post: (body) => post(client, body), orgId, who,
    upload: (path, token, file) => client.storage.from('chat-photos').uploadToSignedUrl(path, token, file),
  });
}
