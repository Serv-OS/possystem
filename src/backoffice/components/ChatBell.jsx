// src/backoffice/components/ChatBell.jsx
// MARKER 5.11.109 Back Office chat bell
//
// Team chat from every Back Office page (Peter, 28 Oct 2026): a chat bell in the top bar with the
// unread count, the same count on Workforce and Team chat in the sidebar, and a list of the chats
// with something new, direct messages and @mentions of you first. A click opens Workforce, Team
// chat, Chats (and that chat). Polled through the team-chat inbox action every 30 s while the
// browser tab is in front; nothing runs for a login that may not open Team chat.
// The counting rules are chatModel.js (inboxAnswerSummary, badgeTotal), shared with the staff app;
// the polling and the open request are chatBellData.js.

import { useState } from 'react';
import { previewText, timeLabel, forYouLabel } from '../../staff/chatModel';
import { Icon } from '../../components/ServOSIcons';

const badge = (n, red) => (
  <span style={{ position:'absolute', top:-5, right:-6, minWidth:17, height:17, padding:'0 4px', borderRadius:999, background: red ? 'var(--red)' : 'var(--acc)',
    color:'#fff', fontSize:9.5, fontWeight:800, display:'grid', placeItems:'center', boxSizing:'border-box' }}>{n > 99 ? '99+' : n}</span>
);

/** The small count beside Workforce and Team chat in the sidebar. */
export function ChatCount({ summary }) {
  const n = summary?.unread || 0;
  if (!n) return null;
  return (
    <span title={summary.forYou ? `${summary.forYou} for you` : `${n} unread in Team chat`}
      style={{ marginLeft:'auto', minWidth:18, height:18, padding:'0 5px', borderRadius:999, background: summary.forYou ? 'var(--red)' : 'var(--acc)',
        color:'#fff', fontSize:10, fontWeight:800, display:'inline-grid', placeItems:'center', boxSizing:'border-box', flexShrink:0 }}>{n > 99 ? '99+' : n}</span>
  );
}

/** The chat bell in the top bar. onOpen(conversationId | null) goes to Workforce, Team chat, Chats. */
export function ChatBell({ summary, onOpen }) {
  const [open, setOpen] = useState(false);
  if (!summary) return null;
  const n = summary.unread || 0;
  const go = (id) => { setOpen(false); onOpen(id); };
  return (
    <div style={{ position:'relative' }}>
      <button onClick={() => setOpen((o) => !o)} title="Team chat" aria-label={n ? `Team chat, ${n} unread` : 'Team chat'} aria-expanded={open}
        style={{ position:'relative', width:34, height:34, borderRadius:10, border:'1px solid var(--bdr)', background:'transparent', color: n ? 'var(--t1)' : 'var(--t3)',
          cursor:'pointer', display:'grid', placeItems:'center', fontFamily:'inherit' }}>
        <Icon name="chat" size={17} />
        {n > 0 && badge(n, summary.forYou > 0)}
      </button>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position:'fixed', inset:0, zIndex:999 }} />
          <div role="dialog" aria-label="Team chat" className="sv-glass"
            style={{ position:'absolute', right:0, top:'calc(100% + 8px)', width:340, maxWidth:'calc(100vw - 32px)', zIndex:1000, borderRadius:14,
              border:'1px solid var(--bdr)', background:'var(--bg)', boxShadow:'0 12px 40px rgba(0,0,0,.25)', overflow:'hidden' }}>
            <div style={{ padding:'12px 14px 8px', borderBottom:'1px solid var(--bdr)' }}>
              <div style={{ fontSize:14, fontWeight:800, color:'var(--t1)' }}>Team chat</div>
              <div style={{ fontSize:12, color:'var(--t3)', marginTop:2 }}>
                {n ? `${n} unread` : 'Nothing new.'}{summary.forYou ? `, ${summary.forYou} for you` : ''}
              </div>
            </div>
            <div style={{ maxHeight:360, overflowY:'auto' }}>
              {summary.items.map((it) => (
                <button key={it.id} onClick={() => go(it.id)}
                  style={{ display:'flex', gap:10, alignItems:'center', width:'100%', padding:'10px 14px', border:'none', borderBottom:'1px solid var(--bdr)',
                    background:'transparent', color:'var(--t1)', cursor:'pointer', fontFamily:'inherit', textAlign:'left' }}>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ display:'flex', gap:6, alignItems:'center' }}>
                      <span style={{ fontSize:13, fontWeight:800, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{it.title}</span>
                      {it.forYou > 0 && <span style={{ fontSize:10, fontWeight:800, color:'var(--acc)', border:'1px solid var(--acc)', borderRadius:999, padding:'0 6px', whiteSpace:'nowrap' }}>{it.kind === 'dm' ? '' : '@ '}{forYouLabel(it)}</span>}
                    </div>
                    <div style={{ fontSize:12, color:'var(--t3)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', marginTop:2 }}>
                      {it.last ? previewText(it.last, { me: summary.me, profilesById: summary.profilesById }) : ''}
                    </div>
                  </div>
                  <div style={{ display:'flex', flexDirection:'column', alignItems:'flex-end', gap:4, flexShrink:0 }}>
                    <span style={{ fontSize:10.5, color:'var(--t4)' }}>{it.last ? timeLabel(it.last.created_at) : ''}</span>
                    {it.unread > 0 && <span style={{ minWidth:18, height:18, padding:'0 5px', borderRadius:999, background: it.forYou ? 'var(--red)' : 'var(--acc)', color:'#fff', fontSize:10, fontWeight:800, display:'grid', placeItems:'center' }}>{it.unread > 99 ? '99+' : it.unread}</span>}
                  </div>
                </button>
              ))}
            </div>
            <button onClick={() => go(null)}
              style={{ width:'100%', padding:'10px 14px', border:'none', background:'var(--bg2)', color:'var(--acc)', fontWeight:800, fontSize:12.5, cursor:'pointer', fontFamily:'inherit' }}>
              Open Team chat
            </button>
          </div>
        </>
      )}
    </div>
  );
}
