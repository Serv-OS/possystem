// src/staff/StaffChat.jsx
//
// 5.11.102 ServOS Team Chat in the staff app (?mode=staff): the Chat tab.
//
// READS go straight to the database with the person's own staff login (staffSupabase), fenced by row
// level security: they see only the chats they are a member of (20261103a). WRITES all go through
// the team-chat edge function, which runs the word filter and asks the database to judge every rule.
// LIVE: one realtime channel, filtered to the person's own chats (never every chat message in the
// platform), plus a reload when the app comes back to the front, so a missed event is caught up.
//
// useTeamChat(enabled) (useTeamChat.js) lives in StaffSurface (the unread badge on the tab bar needs
// it while another tab is open); <ChatTab chat={...}/> draws it.

import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { staffSupabase as supabase } from '../lib/supabase';
import { callChat } from './useTeamChat';
import { Icon } from '../components/ServOSIcons';
import {
  conversationTitle, kindLabel, messageText, previewText, mergeMessages, canEdit, canDelete, canReport, isMutedNow,
  seenBy, mentionAt, insertMention, mentionIds, groupReactions, sortConversations, timeLabel, newClientId, PAGE_SIZE, REACTIONS, MSG_COLUMNS,
} from './chatModel';

const MAX_PHOTO_BYTES = 8 * 1024 * 1024;

// ── Little pieces ─────────────────────────────────────────────────────────────
const btn = { border: '1px solid var(--bdr)', borderRadius: 999, padding: '7px 12px', background: 'transparent', color: 'var(--t2)', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' };
const primary = { ...btn, background: 'var(--acc)', color: '#fff', border: 'none' };
const inputStyle = { width: '100%', padding: '11px 13px', borderRadius: 12, border: '1px solid var(--bdr)', background: 'var(--bg2)', color: 'var(--t1)', fontSize: 15, fontFamily: 'inherit', boxSizing: 'border-box' };

function Avatar({ name, size = 36 }) {
  const initials = String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
  return <div style={{ width: size, height: size, borderRadius: 999, background: 'var(--bg2)', border: '1px solid var(--bdr)', display: 'grid', placeItems: 'center', fontSize: size * 0.36, fontWeight: 800, color: 'var(--t2)', flexShrink: 0 }}>{initials}</div>;
}

function Sheet({ title, onClose, children }) {
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 60, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
      <div onClick={(e) => e.stopPropagation()} className="sv-glass" style={{ width: '100%', maxWidth: 560, maxHeight: '80dvh', overflowY: 'auto', borderRadius: '18px 18px 0 0', padding: '16px 16px calc(18px + env(safe-area-inset-bottom, 0px))', background: 'var(--bg)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <div style={{ fontSize: 16, fontWeight: 800 }}>{title}</div>
          <button onClick={onClose} style={{ ...btn, padding: '6px 10px' }} aria-label="Close"><Icon name="close" size={14} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

function PrivacyNotice({ who, onOk }) {
  const years = who?.settings?.keep_years || 2;
  return (
    <div className="sv-glass" style={{ padding: '16px 16px', borderRadius: 16, marginBottom: 12 }}>
      <div style={{ fontSize: 16, fontWeight: 800, marginBottom: 8 }}>Before you start</div>
      <ul style={{ margin: '0 0 14px', paddingLeft: 18, fontSize: 13.5, lineHeight: 1.6, color: 'var(--t2)' }}>
        <li><b>Kept</b> for {years} year{years === 1 ? '' : 's'}, then deleted.</li>
        <li><b>Direct messages</b> are private. A manager sees one only if someone reports it.</li>
        <li><b>Owners</b> can open a direct message only with a written reason, and that is logged.</li>
        <li><b>Be kind.</b> Words your team does not allow are blocked, and hurtful messages can be flagged for a manager.</li>
        <li><b>Never</b> send card numbers or bank details here.</li>
      </ul>
      <button onClick={onOk} style={{ ...primary, width: '100%', padding: '12px 14px', fontSize: 14 }}>Got it</button>
    </div>
  );
}

// ── The Chat tab ──────────────────────────────────────────────────────────────
export function ChatTab({ chat, locale = 'en-GB', onFullScreen }) {
  const [openId, setOpenId] = useState(null);
  const [newOpen, setNewOpen] = useState(false);
  const { status, offText, who, me, profiles, rows, dmMembers, last, setOpen, load, setWho } = chat;

  const open = useCallback((id) => { setOpenId(id); setOpen(id); onFullScreen?.(!!id); }, [setOpen, onFullScreen]);
  useEffect(() => () => { setOpen(null); onFullScreen?.(false); }, [setOpen, onFullScreen]);

  if (status === 'idle' || status === 'loading') return <div style={{ color: 'var(--t3)', fontSize: 13, padding: 20, textAlign: 'center' }}>Loading chat…</div>;
  if (status === 'off') {
    return (
      <div className="sv-glass" style={{ padding: 18, borderRadius: 16, textAlign: 'center' }}>
        <div style={{ fontSize: 14, color: 'var(--t2)', marginBottom: 12 }}>{offText || 'Chat is not switched on yet.'}</div>
        <button onClick={load} style={btn}>Try again</button>
      </div>
    );
  }
  if (who && !who.privacy_ok) {
    return <PrivacyNotice who={who} onOk={async () => { const r = await callChat({ action: 'privacy.ok' }); if (r.ok) setWho({ ...who, privacy_ok: true }); }} />;
  }
  if (who?.chat_off) return <div className="sv-glass" style={{ padding: 18, borderRadius: 16, fontSize: 14, color: 'var(--t2)' }}>Chat is switched off for you. Please speak to your manager.</div>;

  const titleOf = (c) => conversationTitle(c, { me, membersByConv: dmMembers, profilesById: profiles });
  const conv = openId ? rows.find((c) => c.id === openId) : null;
  if (openId && conv) return <Conversation key={conv.id} chat={chat} conv={conv} title={titleOf(conv)} locale={locale} onBack={() => open(null)} />;

  const canGroup = who && (who.level !== 'staff' || who.settings?.groups_by === 'everyone');
  const sorted = sortConversations(rows, titleOf);
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <div style={{ fontSize: 17, fontWeight: 800 }}>Chats</div>
        <button onClick={() => setNewOpen(true)} style={primary}><span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="plus" size={13} />New</span></button>
      </div>
      {who?.muted_until && <div style={{ fontSize: 12.5, color: 'var(--red)', fontWeight: 600, marginBottom: 8 }}>You are muted until {new Date(who.muted_until).toLocaleString(locale, { weekday: 'short', hour: '2-digit', minute: '2-digit' })}.</div>}
      {sorted.length === 0 && <div style={{ color: 'var(--t3)', fontSize: 13, padding: 20, textAlign: 'center' }}>No chats yet. Tap New to message someone.</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {sorted.map((c) => {
          const lm = last[c.id];
          const muted = isMutedNow(c.muted_until);
          return (
            <button key={c.id} onClick={() => open(c.id)} className="sv-glass" style={{ display: 'flex', gap: 11, alignItems: 'center', width: '100%', textAlign: 'left', padding: '11px 12px', borderRadius: 14, border: '1px solid var(--bdr)', cursor: 'pointer', font: 'inherit', color: 'var(--t1)' }}>
              <Avatar name={titleOf(c)} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <span style={{ fontWeight: c.unread ? 800 : 700, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{titleOf(c)}</span>
                  <span style={{ fontSize: 11, color: 'var(--t3)', flexShrink: 0 }}>{lm ? timeLabel(lm.created_at, locale) : ''}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginTop: 2 }}>
                  <span style={{ fontSize: 12.5, color: c.unread ? 'var(--t1)' : 'var(--t3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {lm ? previewText(lm, { me, profilesById: profiles }) : kindLabel(c)}
                  </span>
                  <span style={{ display: 'flex', gap: 4, alignItems: 'center', flexShrink: 0 }}>
                    {muted && <span title="Muted" style={{ color: 'var(--t3)' }}><Icon name="bell" size={12} /></span>}
                    {c.unread > 0 && <span style={{ minWidth: 18, height: 18, padding: '0 5px', borderRadius: 999, background: muted ? 'var(--t3)' : 'var(--acc)', color: '#fff', fontSize: 10.5, fontWeight: 800, display: 'grid', placeItems: 'center' }}>{c.unread > 99 ? '99+' : c.unread}</span>}
                  </span>
                </div>
              </div>
            </button>
          );
        })}
      </div>
      {newOpen && <NewChat chat={chat} canGroup={canGroup} onClose={() => setNewOpen(false)} onOpened={async (id) => { setNewOpen(false); await load(); open(id); }} />}
    </div>
  );
}

function NewChat({ chat, canGroup, onClose, onOpened }) {
  const { me, profiles } = chat;
  const [q, setQ] = useState('');
  const [group, setGroup] = useState(false);
  const [name, setName] = useState('');
  const [picked, setPicked] = useState([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const people = Object.values(profiles).filter((p) => p.id !== me && (!q || p.display_name.toLowerCase().includes(q.toLowerCase()))).slice(0, 200);

  const dm = async (id) => {
    setBusy(true); setErr('');
    const r = await callChat({ action: 'dm.open', member_id: id });
    setBusy(false);
    if (r.ok) onOpened(r.conversation_id); else setErr(r.message);
  };
  const makeGroup = async () => {
    setBusy(true); setErr('');
    const r = await callChat({ action: 'group.create', kind: 'group', name: name.trim(), members: picked });
    setBusy(false);
    if (r.ok) onOpened(r.conversation_id); else setErr(r.message);
  };
  return (
    <Sheet title={group ? 'New group' : 'New message'} onClose={onClose}>
      {canGroup && (
        <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
          <button onClick={() => setGroup(false)} style={group ? btn : primary}>Person</button>
          <button onClick={() => setGroup(true)} style={group ? primary : btn}>Group</button>
        </div>
      )}
      {group && <input value={name} onChange={(e) => setName(e.target.value.slice(0, 80))} placeholder="Group name" style={{ ...inputStyle, marginBottom: 8 }} />}
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search people" style={{ ...inputStyle, marginBottom: 8 }} />
      {err && <div style={{ color: 'var(--red)', fontSize: 12.5, fontWeight: 600, margin: '6px 0' }}>{err}</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {people.map((p) => {
          const on = picked.includes(p.id);
          return (
            <button key={p.id} disabled={busy} onClick={() => (group ? setPicked((x) => (on ? x.filter((y) => y !== p.id) : [...x, p.id])) : dm(p.id))}
              style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 6px', border: 'none', borderRadius: 10, background: on ? 'var(--bg2)' : 'transparent', color: 'var(--t1)', cursor: 'pointer', font: 'inherit', textAlign: 'left' }}>
              <Avatar name={p.display_name} size={30} />
              <span style={{ flex: 1, fontSize: 14, fontWeight: 600 }}>{p.display_name}</span>
              {group && on && <span style={{ color: 'var(--acc)' }}><Icon name="check" size={16} /></span>}
            </button>
          );
        })}
      </div>
      {group && <button disabled={busy || !name.trim() || !picked.length} onClick={makeGroup} style={{ ...primary, width: '100%', marginTop: 12, padding: 12, opacity: busy || !name.trim() || !picked.length ? 0.6 : 1 }}>Make group ({picked.length})</button>}
    </Sheet>
  );
}

// ── One conversation ──────────────────────────────────────────────────────────
function Conversation({ chat, conv, title, locale, onBack }) {
  const { me, profiles, mine, subscribe, markRead, reloadSoon } = chat;
  const [msgs, setMsgs] = useState([]);
  const [reactions, setReactions] = useState([]);
  const [members, setMembers] = useState([]);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [photoUrls, setPhotoUrls] = useState({});
  const [text, setText] = useState('');
  const [caret, setCaret] = useState(0);
  const [replyTo, setReplyTo] = useState(null);
  const [editing, setEditing] = useState(null);
  const [photos, setPhotos] = useState([]);       // uploaded, waiting to send: [{ path, name }]
  const [urgent, setUrgent] = useState(false);
  const [err, setErr] = useState('');
  const [sending, setSending] = useState(false);
  const [actionFor, setActionFor] = useState(null);
  const [menu, setMenu] = useState(false);
  const [seenFor, setSeenFor] = useState(null);
  const clientId = useRef(newClientId());
  const endRef = useRef(null);
  const fileRef = useRef(null);
  const taRef = useRef(null);
  const myRow = mine[conv.id] || {};
  const isAdmin = myRow.role === 'admin' || chat.who?.level === 'owner';
  const canPost = !(conv.kind === 'announce' || conv.post_policy === 'admins') || isAdmin;
  const muted = isMutedNow(myRow.muted_until);
  const nameOf = (id) => profiles[id]?.display_name || 'Someone';

  const scrollEnd = () => setTimeout(() => endRef.current?.scrollIntoView({ block: 'end' }), 30);

  const loadPage = useCallback(async (beforeId) => {
    let q = supabase.from('chat_messages').select(MSG_COLUMNS).eq('conversation_id', conv.id).order('id', { ascending: false }).limit(PAGE_SIZE);
    if (beforeId) q = q.lt('id', beforeId);
    const { data } = await q;
    const page = data || [];
    setMore(page.length === PAGE_SIZE);
    setMsgs((m) => mergeMessages(m, page));
    if (page.length) {
      const ids = page.map((x) => x.id);
      const { data: rs } = await supabase.from('chat_reactions').select('message_id, member_id, emoji').eq('conversation_id', conv.id).in('message_id', ids).limit(1000);
      setReactions((r) => [...r.filter((x) => !ids.includes(x.message_id)), ...(rs || [])]);
    }
    return page;
  }, [conv.id]);

  const fetchMembers = useCallback(async () => {
    const { data } = await supabase.from('chat_members').select('member_id, role, last_read_message_id, left_at').eq('conversation_id', conv.id).is('left_at', null).range(0, 999);
    const list = data || [];
    setMembers(list);
    return list;
  }, [conv.id]);

  useEffect(() => {
    let alive = true;   // one Conversation per chat (keyed by its id), so the state starts empty
    (async () => {
      const page = await loadPage(null);
      if (!alive) return;
      setLoading(false);
      if (page[0]) markRead(conv.id, page[0].id);
      scrollEnd();
      const list = await fetchMembers();
      if (alive) setMembers(list);
    })();
    return () => { alive = false; };
  }, [conv.id, loadPage, markRead, fetchMembers]);

  // Live: new and changed messages, reactions.
  useEffect(() => subscribe((ev) => {
    if (ev.type === 'message' && ev.msg.conversation_id === conv.id) {
      setMsgs((m) => mergeMessages(m, ev.msg));
      if (ev.event === 'INSERT') {
        if (document.visibilityState === 'visible') markRead(conv.id, ev.msg.id);
        scrollEnd();
      }
    } else if (ev.type === 'reaction') {
      if (ev.event === 'DELETE' && ev.old) {
        setReactions((r) => r.filter((x) => !(String(x.message_id) === String(ev.old.message_id) && x.member_id === ev.old.member_id && x.emoji === ev.old.emoji)));
      } else if (ev.row && ev.row.conversation_id === conv.id) {
        setReactions((r) => [...r.filter((x) => !(String(x.message_id) === String(ev.row.message_id) && x.member_id === ev.row.member_id && x.emoji === ev.row.emoji)), ev.row]);
      }
    }
  }), [subscribe, conv.id, markRead]);

  // Signed links for photos on screen (1 hour, from the server).
  useEffect(() => {
    const need = [...new Set(msgs.flatMap((m) => (Array.isArray(m.photos) ? m.photos.map((p) => p?.path) : [])).filter((p) => p && !photoUrls[p]))];
    if (!need.length) return;
    callChat({ action: 'photo.urls', conversation_id: conv.id, paths: need.slice(0, 50) }).then((r) => {
      if (r.ok && r.urls) setPhotoUrls((u) => ({ ...u, ...r.urls }));
    });
  }, [msgs, conv.id, photoUrls]);

  const mention = mentionAt(text, caret);
  const mentionList = mention ? members.filter((m) => m.member_id !== me && nameOf(m.member_id).toLowerCase().includes(mention.query)).slice(0, 6) : [];

  const pickPhoto = async (file) => {
    if (!file) return;
    if (file.size > MAX_PHOTO_BYTES) { setErr('That photo is too big (8 MB at most).'); return; }
    setErr('');
    const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
    const u = await callChat({ action: 'photo.upload_url', conversation_id: conv.id, ext });
    if (!u.ok) { setErr(u.message); return; }
    const { error } = await supabase.storage.from('chat-photos').uploadToSignedUrl(u.path, u.token, file);
    if (error) { setErr('The photo did not upload. Try again.'); return; }
    setPhotos((p) => [...p, { path: u.path, name: file.name }].slice(0, 10));
  };

  const send = async () => {
    if (sending) return;
    const body = text.trim();
    if (!body && !photos.length) return;
    setSending(true); setErr('');
    let r;
    if (editing) {
      r = await callChat({ action: 'edit', message_id: editing.id, body });
    } else {
      r = await callChat({
        action: 'send', conversation_id: conv.id, body, photos: photos.map((p) => ({ path: p.path })),
        reply_to: replyTo?.id || null, urgent: conv.kind === 'announce' && urgent, client_id: clientId.current,
        mentions: mentionIds(body, members, profiles),
      });
    }
    setSending(false);
    if (!r.ok) { setErr(r.message || 'That did not send.'); return; }   // the text stays in the box
    if (r.message) setMsgs((m) => mergeMessages(m, r.message));
    if (!editing && r.message?.id) markRead(conv.id, r.message.id);
    setText(''); setPhotos([]); setReplyTo(null); setEditing(null); setUrgent(false);
    clientId.current = newClientId();
    scrollEnd();
  };

  const act = async (kind, msg, extra = {}) => {
    setActionFor(null); setErr('');
    if (kind === 'reply') { setReplyTo(msg); setEditing(null); taRef.current?.focus(); return; }
    if (kind === 'edit') { setEditing(msg); setReplyTo(null); setText(msg.body || ''); taRef.current?.focus(); return; }
    let r;
    if (kind === 'react') r = await callChat({ action: 'react', message_id: msg.id, emoji: extra.emoji, on: !extra.mine });
    if (kind === 'delete') { if (!window.confirm('Delete this message for everyone?')) return; r = await callChat({ action: 'delete', message_id: msg.id }); }
    if (kind === 'report') {
      const reason = window.prompt('Why are you reporting this? A manager will look at it.') ;
      if (reason === null) return;
      r = await callChat({ action: 'report', message_id: msg.id, reason });
      if (r.ok) setErr('Thanks. A manager will look at it.');
    }
    if (r && !r.ok) setErr(r.message);
    if (r?.ok && r.message) setMsgs((m) => mergeMessages(m, r.message));
  };

  const mute = async (hours) => {
    setMenu(false);
    const r = await callChat(hours ? { action: 'mute', conversation_id: conv.id, hours } : { action: 'mute', conversation_id: conv.id });
    if (!r.ok) setErr(r.message); else reloadSoon();
  };
  const leave = async () => {
    setMenu(false);
    if (!window.confirm('Leave this chat?')) return;
    const r = await callChat({ action: 'leave', conversation_id: conv.id });
    if (!r.ok) setErr(r.message); else { reloadSoon(); onBack(); }
  };

  const byId = useMemo(() => Object.fromEntries(msgs.map((m) => [String(m.id), m])), [msgs]);

  return (
    <div style={{ paddingBottom: 150 }}>
      <div className="sv-glass" style={{ position: 'sticky', top: 0, zIndex: 10, display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 14, marginBottom: 10 }}>
        <button onClick={onBack} style={{ ...btn, padding: '6px 9px' }} aria-label="Back"><Icon name="back" size={14} /></button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 800, fontSize: 15, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</div>
          <div style={{ fontSize: 11.5, color: 'var(--t3)' }}>{kindLabel(conv)}{conv.kind !== 'dm' && members.length ? ` · ${members.length} people` : ''}{muted ? ' · muted' : ''}</div>
        </div>
        <button onClick={() => setMenu(true)} style={{ ...btn, padding: '6px 10px' }} aria-label="Chat options">•••</button>
      </div>

      {more && <div style={{ textAlign: 'center', marginBottom: 8 }}><button onClick={() => loadPage(msgs[0]?.id)} style={btn}>Load earlier</button></div>}
      {loading && <div style={{ color: 'var(--t3)', fontSize: 13, textAlign: 'center', padding: 16 }}>Loading…</div>}
      {!loading && !msgs.length && <div style={{ color: 'var(--t3)', fontSize: 13, textAlign: 'center', padding: 16 }}>No messages yet. Say hello.</div>}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {msgs.map((m, i) => {
          const mineMsg = m.sender_member_id === me;
          const prev = msgs[i - 1];
          const showName = !mineMsg && conv.kind !== 'dm' && (!prev || prev.sender_member_id !== m.sender_member_id);
          const gone = m.deleted_at || m.status === 'hidden';
          const quoted = m.reply_to ? byId[String(m.reply_to)] : null;
          const reacts = groupReactions(reactions, m.id, me);
          const seen = conv.kind === 'announce' && (mineMsg || isAdmin) ? seenBy(m, members, profiles) : null;
          return (
            <div key={m.id} style={{ display: 'flex', flexDirection: 'column', alignItems: mineMsg ? 'flex-end' : 'flex-start' }}>
              {showName && <div style={{ fontSize: 11, color: 'var(--t3)', fontWeight: 700, margin: '4px 8px 2px' }}>{nameOf(m.sender_member_id)}</div>}
              <button onClick={() => !gone && setActionFor(m)} style={{
                maxWidth: '82%', textAlign: 'left', padding: '8px 11px', borderRadius: 14, cursor: gone ? 'default' : 'pointer', font: 'inherit',
                border: m.urgent ? '1px solid var(--red)' : '1px solid var(--bdr)',
                background: mineMsg ? 'var(--acc)' : 'var(--bg2)', color: mineMsg ? '#fff' : 'var(--t1)', opacity: gone ? 0.7 : 1,
              }}>
                {m.urgent && <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '.06em', color: mineMsg ? '#fff' : 'var(--red)', marginBottom: 3 }}>URGENT</div>}
                {quoted && <div style={{ fontSize: 12, borderLeft: '3px solid currentColor', paddingLeft: 7, opacity: 0.8, marginBottom: 5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{nameOf(quoted.sender_member_id)}: {messageText(quoted) || 'Photo'}</div>}
                {!gone && Array.isArray(m.photos) && m.photos.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: m.body ? 6 : 0 }}>
                    {m.photos.map((p) => (photoUrls[p.path]
                      ? <a key={p.path} href={photoUrls[p.path]} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}><img src={photoUrls[p.path]} alt={p.caption || 'Photo'} style={{ width: m.photos.length === 1 ? 220 : 104, height: m.photos.length === 1 ? 'auto' : 104, maxHeight: 280, objectFit: 'cover', borderRadius: 10, display: 'block' }} /></a>
                      : <div key={p.path} style={{ width: 104, height: 104, borderRadius: 10, background: 'rgba(127,127,127,.2)' }} />))}
                  </div>
                )}
                <div style={{ fontSize: 14.5, lineHeight: 1.4, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontStyle: gone ? 'italic' : 'normal' }}>{messageText(m)}</div>
                <div style={{ fontSize: 10.5, opacity: 0.7, marginTop: 3, textAlign: 'right' }}>{m.edited_at && !gone ? 'edited · ' : ''}{timeLabel(m.created_at, locale)}</div>
              </button>
              {reacts.length > 0 && (
                <div style={{ display: 'flex', gap: 4, margin: '3px 6px 0' }}>
                  {reacts.map((g) => (
                    <button key={g.emoji} onClick={() => act('react', m, { emoji: g.emoji, mine: g.mine })} style={{ ...btn, padding: '2px 7px', fontSize: 12, borderColor: g.mine ? 'var(--acc)' : 'var(--bdr)' }}>{g.emoji} {g.count}</button>
                  ))}
                </div>
              )}
              {seen && <button onClick={async () => { const fresh = await fetchMembers(); setSeenFor({ msg: m, names: seenBy(m, fresh, profiles) }); }} style={{ background: 'none', border: 'none', color: 'var(--t3)', fontSize: 11, margin: '2px 6px', cursor: 'pointer', fontFamily: 'inherit' }}>Seen by {seen.length}</button>}
            </div>
          );
        })}
      </div>
      <div ref={endRef} />

      {/* Composer, fixed above the home indicator (the tab bar hides while a chat is open). */}
      <div className="sv-glass" style={{ position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 30, padding: '8px 12px calc(10px + env(safe-area-inset-bottom, 0px))', maxWidth: 560, margin: '0 auto', borderRadius: '16px 16px 0 0', background: 'var(--bg)' }}>
        {err && <div style={{ color: err.startsWith('Thanks') ? 'var(--grn)' : 'var(--red)', fontSize: 12.5, fontWeight: 600, margin: '0 2px 6px' }}>{err}</div>}
        {(replyTo || editing) && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--t2)', marginBottom: 6 }}>
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{editing ? 'Editing your message' : `Replying to ${nameOf(replyTo.sender_member_id)}: ${messageText(replyTo)}`}</span>
            <button onClick={() => { setReplyTo(null); if (editing) { setEditing(null); setText(''); } }} style={{ ...btn, padding: '3px 8px' }}>Cancel</button>
          </div>
        )}
        {photos.length > 0 && <div style={{ fontSize: 12, color: 'var(--t2)', marginBottom: 6 }}>{photos.length} photo{photos.length === 1 ? '' : 's'} ready <button onClick={() => setPhotos([])} style={{ ...btn, padding: '2px 8px', marginLeft: 6 }}>Remove</button></div>}
        {mentionList.length > 0 && (
          <div style={{ display: 'flex', gap: 6, overflowX: 'auto', marginBottom: 6 }}>
            {mentionList.map((mm) => (
              <button key={mm.member_id} onClick={() => { const r = insertMention(text, mention, caret, nameOf(mm.member_id)); setText(r.text); setCaret(r.caret); taRef.current?.focus(); }} style={{ ...btn, whiteSpace: 'nowrap' }}>@{nameOf(mm.member_id)}</button>
            ))}
          </div>
        )}
        {canPost ? (
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
            {!editing && <button onClick={() => fileRef.current?.click()} style={{ ...btn, padding: '9px 10px' }} aria-label="Add a photo"><Icon name="camera" size={16} /></button>}
            <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => { pickPhoto(e.target.files?.[0]); e.target.value = ''; }} />
            <textarea ref={taRef} value={text} rows={1} maxLength={4000} placeholder="Message"
              onChange={(e) => { setText(e.target.value); setCaret(e.target.selectionStart || 0); }}
              onSelect={(e) => setCaret(e.target.selectionStart || 0)}
              style={{ ...inputStyle, resize: 'none', minHeight: 42, maxHeight: 120, padding: '10px 12px' }} />
            <button onClick={send} disabled={sending || (!text.trim() && !photos.length)} style={{ ...primary, padding: '10px 14px', opacity: sending || (!text.trim() && !photos.length) ? 0.6 : 1 }}>{editing ? 'Save' : 'Send'}</button>
          </div>
        ) : (
          <div style={{ fontSize: 12.5, color: 'var(--t3)', textAlign: 'center', padding: 8 }}>Only the group admins post here.</div>
        )}
        {canPost && conv.kind === 'announce' && !editing && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--t2)', marginTop: 6 }}>
            <input type="checkbox" checked={urgent} onChange={(e) => setUrgent(e.target.checked)} /> Mark as urgent
          </label>
        )}
      </div>

      {actionFor && (
        <Sheet title="Message" onClose={() => setActionFor(null)}>
          <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
            {REACTIONS.map((e) => {
              const minei = reactions.some((r) => String(r.message_id) === String(actionFor.id) && r.member_id === me && r.emoji === e);
              return <button key={e} onClick={() => act('react', actionFor, { emoji: e, mine: minei })} style={{ ...btn, fontSize: 20, padding: '6px 10px', borderColor: minei ? 'var(--acc)' : 'var(--bdr)' }}>{e}</button>;
            })}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {canPost && <button onClick={() => act('reply', actionFor)} style={btn}>Reply</button>}
            {canEdit(actionFor, me) && <button onClick={() => act('edit', actionFor)} style={btn}>Edit</button>}
            {canDelete(actionFor, me) && <button onClick={() => act('delete', actionFor)} style={{ ...btn, color: 'var(--red)' }}>Delete for everyone</button>}
            {canReport(actionFor, me) && <button onClick={() => act('report', actionFor)} style={{ ...btn, color: 'var(--red)' }}>Report to a manager</button>}
          </div>
        </Sheet>
      )}
      {menu && (
        <Sheet title={title} onClose={() => setMenu(false)}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {muted ? <button onClick={() => mute(0)} style={btn}>Unmute</button> : (
              <>
                <button onClick={() => mute(8)} style={btn}>Mute for 8 hours</button>
                <button onClick={() => mute(24 * 7)} style={btn}>Mute for a week</button>
              </>
            )}
            {(conv.kind === 'group' || conv.kind === 'dm') && <button onClick={leave} style={{ ...btn, color: 'var(--red)' }}>Leave chat</button>}
          </div>
        </Sheet>
      )}
      {seenFor && (
        <Sheet title={`Seen by ${seenFor.names.length}`} onClose={() => setSeenFor(null)}>
          {seenFor.names.length ? seenFor.names.map((n, i) => <div key={i} style={{ padding: '6px 2px', fontSize: 14 }}>{n}</div>) : <div style={{ color: 'var(--t3)', fontSize: 13 }}>Nobody yet.</div>}
        </Sheet>
      )}
    </div>
  );
}
