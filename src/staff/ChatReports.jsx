// src/staff/ChatReports.jsx
//
// 5.11.102 team chat: Reports to check. One screen for Back Office (Workforce, Team chat) and the
// Manager app. The database decides which reports this person sees (managers: their own venues'
// people and groups; owners: everything; never a report about themselves) and what they may do.
// A DM stays private: a manager sees the reported message and the few around it, never the rest.
//
// call(body): the team-chat function for this screen's caller (Back Office login, or the Manager
// app's device and PIN).

import { useEffect, useState, useCallback } from 'react';

const btn = { border: '1px solid var(--bdr)', borderRadius: 10, padding: '7px 11px', background: 'transparent', color: 'var(--t1)', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' };
const danger = { ...btn, color: 'var(--red)', borderColor: 'var(--red-b, var(--bdr))' };
const card = { border: '1px solid var(--bdr)', borderRadius: 14, padding: 14, background: 'var(--glass-bg, var(--bg2))' };

const KIND = { dm: 'Direct message', group: 'Group', venue: 'Venue group', position: 'Position group', announce: 'Announcements' };
const SOURCE = { person: 'Reported by', ai: 'Flagged by the automatic check' };
const when = (iso, locale = 'en-GB') => (iso ? new Date(iso).toLocaleString(locale, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');

export default function ChatReports({ call, locale = 'en-GB', onCount }) {
  const [status, setStatus] = useState('open');
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');
  const [ctx, setCtx] = useState({});        // report id -> context messages
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState({});

  const load = useCallback(async () => {
    const r = await call({ action: 'reports.list', status });
    if (!r.ok) { setErr(r.message || 'Reports could not load.'); setRows([]); return; }
    setErr('');
    setRows(r.reports || []);
    if (status === 'open') onCount?.((r.reports || []).length);
  }, [call, status, onCount]);
  useEffect(() => { const t = setTimeout(load, 0); return () => clearTimeout(t); }, [load]);

  const act = async (rep, action, extra = {}) => {
    if (action === 'mod.chat_off' && !window.confirm(`Switch chat off for ${rep.offender_name || 'this person'}? They will not be able to read or send until you switch it back on.`)) return;
    setBusy(rep.id + action);
    const r = await call({ action, report_id: rep.id, note: note[rep.id] || undefined, ...extra });
    setBusy('');
    if (!r.ok) { setErr(r.message); return; }
    load();
  };
  const around = async (rep) => {
    if (ctx[rep.id]) { setCtx((c) => ({ ...c, [rep.id]: null })); return; }
    const r = await call({ action: 'report.context', report_id: rep.id });
    if (!r.ok) { setErr(r.message); return; }
    setCtx((c) => ({ ...c, [rep.id]: r.messages || [] }));
  };

  return (
    <div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 12, alignItems: 'center' }}>
        <button onClick={() => setStatus('open')} style={{ ...btn, background: status === 'open' ? 'var(--acc)' : 'transparent', color: status === 'open' ? '#fff' : 'var(--t1)' }}>To check</button>
        <button onClick={() => setStatus('all')} style={{ ...btn, background: status === 'all' ? 'var(--acc)' : 'transparent', color: status === 'all' ? '#fff' : 'var(--t1)' }}>All</button>
        <div style={{ flex: 1 }} />
        <button onClick={load} style={btn}>Refresh</button>
      </div>
      {err && <div style={{ color: 'var(--red)', fontSize: 12.5, fontWeight: 600, marginBottom: 10 }}>{err}</div>}
      {rows === null && <div style={{ color: 'var(--t3)', fontSize: 13 }}>Loading…</div>}
      {rows && rows.length === 0 && <div style={{ ...card, color: 'var(--t3)', fontSize: 13, textAlign: 'center' }}>{status === 'open' ? 'Nothing to check. Nice.' : 'No reports yet.'}</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {(rows || []).map((rep) => (
          <div key={rep.id} style={card}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap', marginBottom: 6 }}>
              <b style={{ fontSize: 14 }}>{rep.offender_name || 'Someone'}</b>
              <span style={{ fontSize: 12, color: 'var(--t3)' }}>in {rep.conversation_name || KIND[rep.conversation_kind] || 'a chat'}{rep.conversation_kind === 'dm' ? ' (direct message)' : ''}</span>
              <span style={{ fontSize: 12, color: 'var(--t3)', marginLeft: 'auto' }}>{when(rep.created_at, locale)}</span>
            </div>
            <div style={{ fontSize: 14, lineHeight: 1.45, whiteSpace: 'pre-wrap', padding: '8px 10px', borderRadius: 10, background: 'var(--inset, var(--bg2))', marginBottom: 6 }}>
              {rep.text || (rep.photos ? `${rep.photos} photo${rep.photos === 1 ? '' : 's'}` : 'No text')}
            </div>
            <div style={{ fontSize: 12, color: 'var(--t2)', marginBottom: 8 }}>
              {rep.source === 'ai' ? `${SOURCE.ai}: ${rep.ai_label || 'flagged'}` : `${SOURCE.person} ${rep.reporter_name || 'a colleague'}${rep.reason ? `: "${rep.reason}"` : ''}`}
              {rep.status !== 'open' && <> · {rep.status === 'hidden' ? 'Hidden' : 'Kept'}{rep.handled_by_name ? ` by ${rep.handled_by_name}` : ''}{rep.note ? `: ${rep.note}` : ''}</>}
              {rep.message_status === 'deleted' && ' · deleted by the sender'}
            </div>
            {ctx[rep.id] && (
              <div style={{ borderLeft: '3px solid var(--bdr)', paddingLeft: 10, margin: '6px 0 10px', display: 'flex', flexDirection: 'column', gap: 4 }}>
                {ctx[rep.id].map((m) => (
                  <div key={m.id} style={{ fontSize: 12.5, color: String(m.id) === String(rep.message_id) ? 'var(--t1)' : 'var(--t3)', fontWeight: String(m.id) === String(rep.message_id) ? 700 : 400 }}>
                    <span>{m.sender_name || 'Someone'}: </span>{m.removed_text || m.body || (m.deleted_at ? 'Message deleted' : '')}
                  </div>
                ))}
              </div>
            )}
            {rep.status === 'open' && (
              <input value={note[rep.id] || ''} onChange={(e) => setNote((n) => ({ ...n, [rep.id]: e.target.value.slice(0, 500) }))} placeholder="Note for the log (optional)"
                style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 10, border: '1px solid var(--bdr)', background: 'transparent', color: 'var(--t1)', fontSize: 13, fontFamily: 'inherit', marginBottom: 8 }} />
            )}
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button onClick={() => around(rep)} style={btn}>{ctx[rep.id] ? 'Hide context' : 'See around it'}</button>
              {rep.status === 'open' && <>
                <button disabled={!!busy} onClick={() => act(rep, 'mod.hide')} style={danger}>Hide message</button>
                <button disabled={!!busy} onClick={() => act(rep, 'mod.keep')} style={btn}>Keep, it is fine</button>
                <button disabled={!!busy} onClick={() => act(rep, 'mod.mute_person', { hours: 24 })} style={btn}>Mute 24 hours</button>
                <button disabled={!!busy} onClick={() => act(rep, 'mod.chat_off')} style={danger}>Chat off</button>
              </>}
              {rep.status === 'hidden' && <button disabled={!!busy} onClick={() => act(rep, 'mod.keep')} style={btn}>Put it back</button>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
