// src/staff/useTeamChat.js
//
// 5.11.102 ServOS Team Chat, the store shared by the staff app and the Manager app: who I am, my
// chats, unread counts, live updates. Where the data comes from is the source (chatSource.js): the
// staff app reads with its own login and listens live; the Manager app reads through the server and
// polls. Pass null to switch it off (signed out).

import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { unreadTotal } from './chatModel';

const POLL_LIST_MS = 15000;

export function useTeamChat(source) {
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
  const marks = useRef({});                         // my read markers, sent once each

  // MARKER 5.11.102 useTeamChat review fix A6: a new source (signed out, someone else signed in)
  // starts from nothing, so the last person's chats never show for a moment.
  const [prevSource, setPrevSource] = useState(source);
  if (source !== prevSource) {
    setPrevSource(source);
    setStatus('idle'); setOffText(''); setWho(null); setProfiles({}); setConvs([]); setMine({}); setDmMembers({}); setLast({}); setUnread({});
  }
  useEffect(() => { marks.current = {}; openRef.current = null; }, [source]);

  const me = who?.member_id || null;
  const call = useCallback((body) => (source ? source.call(body) : Promise.resolve({ ok: false, code: 'off' })), [source]);

  const load = useCallback(async () => {
    if (!source) return;
    const w = await source.call({ action: 'bootstrap' });   // the screen says Loading until the first answer
    if (!w?.ok) { setOffText(w?.message || 'Chat is not switched on yet.'); setStatus('off'); return; }
    setWho(w);
    const d = await source.inbox(w);
    if (d.error) { setOffText(d.message || 'Chat could not load. Pull down to try again.'); setStatus('off'); return; }
    if (openRef.current) d.unread[openRef.current] = 0;
    for (const [k, r] of Object.entries(d.mine)) marks.current[k] = Math.max(marks.current[k] || 0, Number(r?.last_read_message_id || 0));
    setProfiles(d.profiles); setMine(d.mine); setDmMembers(d.dmMembers); setConvs(d.convs); setLast(d.last); setUnread(d.unread);
    setStatus('ready');
  }, [source]);

  const reloadSoon = useCallback(() => {
    clearTimeout(reloadTimer.current);
    reloadTimer.current = setTimeout(() => { load(); }, 800);
  }, [load]);

  useEffect(() => {
    if (!source) return undefined;
    const t = setTimeout(load, 0);
    return () => { clearTimeout(t); clearTimeout(reloadTimer.current); };
  }, [source, load]);

  // Coming back to the front catches up anything missed while the phone slept. A source with no
  // live channel (the Manager app) also polls the list.
  useEffect(() => {
    if (!source) return undefined;
    const onVis = () => { if (document.visibilityState === 'visible') reloadSoon(); };
    document.addEventListener('visibilitychange', onVis);
    const t = source.live ? null : setInterval(() => { if (document.visibilityState === 'visible') load(); }, POLL_LIST_MS);
    return () => { document.removeEventListener('visibilitychange', onVis); if (t) clearInterval(t); };
  }, [source, load, reloadSoon]);

  const minesRef = useRef(mine);
  useEffect(() => { minesRef.current = mine; }, [mine]);

  const convKey = convs.map((c) => c.id).slice(0, 100).join(',');
  useEffect(() => {
    if (!source?.live || !me) return undefined;
    return source.subscribe(me, convKey ? convKey.split(',') : [], ({ table, p }) => {
      // review fix A2: my own row changing (read marker, mute) is patched in place; only joining a
      // chat or leaving one reloads the list.
      if (table === 'members') {
        const row = p.new || {};
        const known = row.conversation_id && Object.prototype.hasOwnProperty.call(minesRef.current, row.conversation_id);
        if (p.eventType === 'UPDATE' && known && !row.left_at) {
          setMine((m) => ({ ...m, [row.conversation_id]: { ...m[row.conversation_id], muted_until: row.muted_until, last_read_message_id: row.last_read_message_id, role: row.role } }));
          const mark = Number(row.last_read_message_id || 0);
          if (mark > (marks.current[row.conversation_id] || 0)) marks.current[row.conversation_id] = mark;
          return;
        }
        reloadSoon();
        return;
      }
      if (table === 'reactions') {
        for (const fn of listeners.current) fn({ type: 'reaction', row: p.new && p.new.message_id ? p.new : null, old: p.old, event: p.eventType });
        return;
      }
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
  }, [source, me, convKey, reloadSoon]);

  const rows = useMemo(() => convs.map((c) => ({ ...c, unread: unread[c.id] || 0, muted_until: mine[c.id]?.muted_until || null })), [convs, unread, mine]);
  const total = useMemo(() => unreadTotal(rows), [rows]);

  const setOpen = useCallback((id) => {
    openRef.current = id;
    if (id) setUnread((u) => ({ ...u, [id]: 0 }));
  }, []);
  const subscribe = useCallback((fn) => { listeners.current.add(fn); return () => listeners.current.delete(fn); }, []);
  const markRead = useCallback((convId, messageId) => {
    if (!source || !convId || !messageId || (marks.current[convId] || 0) >= Number(messageId)) return;
    marks.current[convId] = Number(messageId);
    source.call({ action: 'read', conversation_id: convId, message_id: messageId });
  }, [source]);

  return { source, call, status, offText, who, me, profiles, rows, mine, dmMembers, last, total, load, reloadSoon, setOpen, subscribe, markRead, setWho };
}
