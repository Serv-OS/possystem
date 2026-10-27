// src/surfaces/manager/ManagerChat.jsx
// MARKER 5.11.102 Manager app chat
//
// Manager app, Chat tab (5.11.102): the manager's own chats and Reports to check.
// The Manager app runs on a paired device with a PIN, so there is no personal login: the manager
// confirms their PIN once (kept in memory for this session, as the Team tab's approvals do) and the
// team-chat function proves the device and the PIN, then acts as that manager's chat profile.
// Reads go through the server (row level security would show a device nothing) and are polled.

import { useMemo, useState, useEffect } from 'react';
import { useTeamChat } from '../../staff/useTeamChat';
import { serverChatSource } from '../../staff/chatSource';
import { ChatTab } from '../../staff/StaffChat';
import ChatReports from '../../staff/ChatReports';

export default function ManagerChat({ ctx }) {
  const [pin, setPin] = useState('');
  const [entry, setEntry] = useState('');
  const [view, setView] = useState('chats');
  const [reportCount, setReportCount] = useState(0);
  const source = useMemo(() => (pin && ctx.loc ? serverChatSource({ opsLocationId: ctx.loc, pin }) : null), [pin, ctx.loc]);
  const chat = useTeamChat(source);
  const pinWrong = chat.status === 'off' && /PIN/i.test(chat.offText || '');

  // Leaving the tab (or switching user) hands the bar back.
  const setFull = ctx.setChatFull;
  useEffect(() => () => setFull?.(false), [setFull]);

  if (!pin || pinWrong) {
    return (
      <div className="sv-glass" style={{ padding: 16, borderRadius: 16 }}>
        <div style={{ fontSize: 14, fontWeight: 800 }}>Manager PIN</div>
        <div style={{ fontSize: 12.5, color: 'var(--t3)', marginTop: 4, lineHeight: 1.5 }}>Chat and reports are personal, so confirm it is you.</div>
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <input type="password" inputMode="numeric" autoComplete="off" value={entry} placeholder="PIN"
            onChange={(e) => setEntry(e.target.value.replace(/\D/g, '').slice(0, 8))}
            onKeyDown={(e) => { if (e.key === 'Enter' && entry.length >= 4) setPin(entry); }}
            style={{ flex: 1, padding: '11px 14px', borderRadius: 12, border: '1px solid var(--bdr)', background: 'var(--glass-bg)', color: 'var(--t1)', fontFamily: 'var(--font-mono)', fontSize: 16, letterSpacing: '.3em', outline: 'none' }} />
          <button onClick={() => entry.length >= 4 && setPin(entry)} disabled={entry.length < 4} className="sv-glass"
            style={{ padding: '0 18px', borderRadius: 12, border: '1px solid var(--grn-b)', color: 'var(--grn)', fontWeight: 800, fontSize: 13, fontFamily: 'inherit', cursor: 'pointer', opacity: entry.length >= 4 ? 1 : 0.5 }}>Unlock</button>
        </div>
        {pinWrong && <div style={{ color: 'var(--red)', fontSize: 12.5, marginTop: 8 }}>{chat.offText}</div>}
      </div>
    );
  }

  const seg = (k, label) => (
    <button key={k} onClick={() => setView(k)} style={{ flex: 1, padding: '8px 10px', borderRadius: 999, border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5, fontWeight: 800,
      background: view === k ? 'var(--acc)' : 'transparent', color: view === k ? '#fff' : 'var(--t2)' }}>{label}</button>
  );
  return (
    <div>
      <div className="sv-glass" style={{ display: 'flex', gap: 4, padding: 4, borderRadius: 999, marginBottom: 12 }}>
        {seg('chats', `Chats${chat.total ? ` (${chat.total})` : ''}`)}
        {seg('reports', `Reports to check${reportCount ? ` (${reportCount})` : ''}`)}
      </div>
      {view === 'chats'
        ? <ChatTab chat={chat} locale={ctx.locale || 'en-GB'} onFullScreen={ctx.setChatFull} pushApp="manager" />
        : <ChatReports call={chat.call} locale={ctx.locale || 'en-GB'} onCount={setReportCount} />}
    </div>
  );
}
