// src/staff/useTeamChat.js
//
// 5.11.102 ServOS Team Chat, the staff app's store: who I am, my chats, unread counts, the live
// channel. Used by StaffSurface (the tab bar badge) and drawn by StaffChat.jsx.
//
// READS go straight to the database with the person's own staff login (staffSupabase), fenced by row
// level security: they see only the chats they are a member of (20261103a). WRITES go through the
// team-chat edge function (callChat). LIVE: one realtime channel filtered to the person's own chats
// (never every chat message in the platform), plus a reload when the app comes back to the front.

import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { staffSupabase as supabase, isMock } from '../lib/supabase';
import { unreadTotal, MSG_COLUMNS } from './chatModel';

const MAX_LIST = 60;

export async function callChat(body) {
  try {
    const { data: sess } = await supabase.auth.getSession();
    const jwt = sess?.session?.access_token;
    const url = `${supabase.supabaseUrl || import.meta.env.VITE_SUPABASE_URL}/functions/v1/team-chat`;
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

// ── The store: who I am, my chats, unread counts, the live channel ────────────
export function useTeamChat(enabled) {
  const [status, setStatus] = useState('idle');     // idle | loading | ready | off
  const [offText, setOffText] = useState('');
  const [who, setWho] = useState(null);
  const [profiles, setProfiles] = useState({});
  const [convs, setConvs] = useState([]);
  const [mine, setMine] = useState({});             // conversation_id -> my chat_members row
  const [dmMembers, setDmMembers] = useState({});   // conversation_id -> [{ member_id }]
  const [last, setLast] = useState({});             // conversation_id -> newest message
  const [unread, setUnread] = useState({});         // conversation_id -> count
  const openRef = useRef(null);                     // the conversation on screen
  const listeners = useRef(new Set());              // the open conversation's live handler
  const reloadTimer = useRef(null);

  const me = who?.member_id || null;

  const load = useCallback(async () => {
    if (!enabled || isMock || !supabase) return;
    setStatus((s) => (s === 'ready' ? s : 'loading'));
    const w = await callChat({ action: 'bootstrap' });
    if (!w?.ok) { setOffText(w?.message || 'Chat is not switched on yet.'); setStatus('off'); return; }
    setWho(w);
    const [pr, cv, mr] = await Promise.all([
      supabase.from('chat_profiles').select('id, display_name, kind').eq('org_id', w.org_id).order('display_name').range(0, 999),
      supabase.from('chat_conversations').select('*').is('archived_at', null).order('last_message_at', { ascending: false, nullsFirst: false }).limit(MAX_LIST),
      supabase.from('chat_members').select('conversation_id, role, muted_until, last_read_message_id').eq('member_id', w.member_id).is('left_at', null).limit(1000),
    ]);
    if (cv.error || mr.error) { setOffText('Chat could not load. Pull down to try again.'); setStatus('off'); return; }
    const pmap = {};
    for (const p of pr.data || []) pmap[p.id] = p;
    const mmap = {};
    for (const r of mr.data || []) mmap[r.conversation_id] = r;
    const list = (cv.data || []).filter((c) => mmap[c.id]);
    const dmIds = list.filter((c) => c.kind === 'dm').map((c) => c.id);
    const dm = {};
    if (dmIds.length) {
      const { data } = await supabase.from('chat_members').select('conversation_id, member_id').in('conversation_id', dmIds).limit(1000);
      for (const r of data || []) (dm[r.conversation_id] ||= []).push(r);
    }
    const lastMap = {}, unreadMap = {};
    await Promise.all(list.map(async (c) => {
      const mark = Number(mmap[c.id]?.last_read_message_id || 0);
      const [lm, uc] = await Promise.all([
        supabase.from('chat_messages').select(MSG_COLUMNS).eq('conversation_id', c.id).order('id', { ascending: false }).limit(1),
        supabase.from('chat_messages').select('id', { count: 'exact', head: true }).eq('conversation_id', c.id).gt('id', mark).neq('sender_member_id', w.member_id),
      ]);
      if (lm.data?.[0]) lastMap[c.id] = lm.data[0];
      unreadMap[c.id] = openRef.current === c.id ? 0 : (uc.count || 0);
    }));
    setProfiles(pmap); setMine(mmap); setDmMembers(dm); setConvs(list); setLast(lastMap); setUnread(unreadMap);
    setStatus('ready');
  }, [enabled]);

  const reloadSoon = useCallback(() => {
    clearTimeout(reloadTimer.current);
    reloadTimer.current = setTimeout(() => { load(); }, 800);
  }, [load]);

  useEffect(() => { if (enabled) load(); return () => clearTimeout(reloadTimer.current); }, [enabled, load]);

  // Coming back to the front catches up anything the channel missed while the phone slept.
  useEffect(() => {
    if (!enabled) return undefined;
    const onVis = () => { if (document.visibilityState === 'visible') reloadSoon(); };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [enabled, reloadSoon]);

  // One live channel for my own chats (at most 100 ids per filter, the realtime limit).
  const convKey = convs.map((c) => c.id).slice(0, 100).join(',');
  useEffect(() => {
    if (!enabled || isMock || !supabase || !me) return undefined;
    const ch = supabase.channel(`team-chat-${me}`);
    if (convKey) {
      const inList = `conversation_id=in.(${convKey})`;
      ch.on('postgres_changes', { event: '*', schema: 'public', table: 'chat_messages', filter: inList }, (p) => {
        const msg = p.new && p.new.id != null ? p.new : null;
        if (!msg) return;
        for (const fn of listeners.current) fn({ type: 'message', msg, event: p.eventType });
        setLast((l) => (!l[msg.conversation_id] || Number(msg.id) >= Number(l[msg.conversation_id].id) ? { ...l, [msg.conversation_id]: msg } : l));
        if (p.eventType === 'INSERT') {
          setConvs((cs) => cs.map((c) => (c.id === msg.conversation_id ? { ...c, last_message_at: msg.created_at } : c)));
          if (msg.sender_member_id !== me && openRef.current !== msg.conversation_id) {
            setUnread((u) => ({ ...u, [msg.conversation_id]: (u[msg.conversation_id] || 0) + 1 }));
          }
        }
      });
      ch.on('postgres_changes', { event: '*', schema: 'public', table: 'chat_reactions', filter: inList }, (p) => {
        for (const fn of listeners.current) fn({ type: 'reaction', row: p.new && p.new.message_id ? p.new : null, old: p.old, event: p.eventType });
      });
    }
    // Being added to or taken out of a chat (a new DM, a new group, offboarding).
    ch.on('postgres_changes', { event: '*', schema: 'public', table: 'chat_members', filter: `member_id=eq.${me}` }, () => reloadSoon());
    ch.subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [enabled, me, convKey, reloadSoon]);

  const rows = useMemo(() => convs.map((c) => ({ ...c, unread: unread[c.id] || 0, muted_until: mine[c.id]?.muted_until || null })), [convs, unread, mine]);
  const total = useMemo(() => unreadTotal(rows), [rows]);

  const setOpen = useCallback((id) => {
    openRef.current = id;
    if (id) setUnread((u) => ({ ...u, [id]: 0 }));
  }, []);
  const subscribe = useCallback((fn) => { listeners.current.add(fn); return () => listeners.current.delete(fn); }, []);
  // My read markers, kept in a ref so a marker is sent once (never from inside a state updater).
  const marks = useRef({});
  useEffect(() => { for (const [k, r] of Object.entries(mine)) marks.current[k] = Math.max(marks.current[k] || 0, Number(r?.last_read_message_id || 0)); }, [mine]);
  const markRead = useCallback((convId, messageId) => {
    if (!convId || !messageId || (marks.current[convId] || 0) >= Number(messageId)) return;
    marks.current[convId] = Number(messageId);
    callChat({ action: 'read', conversation_id: convId, message_id: messageId });
  }, []);

  return { status, offText, who, me, profiles, rows, mine, dmMembers, last, total, load, reloadSoon, setOpen, subscribe, markRead, setWho };
}

