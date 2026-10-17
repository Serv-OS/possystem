// src/admin/sections/AdminMultiSiteMenu.jsx
//
// MULTI SITE MENU (17 Oct 2026, v5.11.75): the Company Admin card. Peter: "I only want people to
// be able to access it if we add them from the admin area."
//
//   * The switch (Off / On) for this company. Nothing changes at any venue until one of the
//     people below publishes.
//   * The people: named logins, each an Editor (edit, publish, schedule) or a Viewer (looks only).
//     Owners and ServOS staff are NOT let in automatically; add yourself if you need to.
//   * Not installed (the migration has not run): the card says so and shows nothing else.
// Every change goes through the database's own functions (msm_admin_set_enabled,
// msm_admin_set_member), which check for ServOS with the second step. Nothing shows as done until
// the database answers; the card always shows what the database returned.

import { useEffect, useMemo, useState } from 'react';
import { msmApi } from '../../lib/msm/msmApi';

const st = {
  card: { background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 12, padding: 20, marginBottom: 16, boxShadow: 'var(--sh)' },
  h: { fontSize: 14, fontWeight: 700, color: 'var(--t1)', marginBottom: 6 },
  sub: { fontSize: 12.5, color: 'var(--t3)', marginBottom: 14, lineHeight: 1.5 },
  btn: { padding: '7px 13px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit' },
  on: { background: 'var(--acc)', color: '#0b0c10' },
  ghost: { background: 'transparent', color: 'var(--t2)', border: '1px solid var(--bdr2)' },
  danger: { background: 'transparent', color: 'var(--red)', border: '1px solid var(--red-b)' },
  input: { width: '100%', padding: '8px 11px', borderRadius: 8, border: '1px solid var(--bdr2)', background: 'var(--bg2)', color: 'var(--t1)', fontSize: 13, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' },
  pill: { padding: '2px 8px', borderRadius: 20, fontSize: 11, fontWeight: 700 },
  row: { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderTop: '1px solid var(--bdr)' },
  err: { fontSize: 12.5, color: 'var(--red)', marginTop: 10 },
};

export default function AdminMultiSiteMenu({ org, allUsers = [] }) {
  const orgId = org?.id || null;
  const [status, setStatus] = useState(null);       // what the database says
  const [state, setState] = useState('loading');    // loading | ready | missing | error
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  const [search, setSearch] = useState('');
  const [newRole, setNewRole] = useState('editor');

  const [reload, setReload] = useState(0);
  // Read on open, whenever the company changes, and on Try again. A late answer for a company the
  // page has moved away from is dropped.
  useEffect(() => {
    if (!orgId) return undefined;
    let live = true;
    msmApi.adminStatus(orgId).then((r) => {
      if (!live) return;
      if (r.ok) { setStatus(r.data); setState('ready'); setError(''); }
      else if (r.notInstalled) setState('missing');
      else { setState('error'); setError(r.words); }
    });
    return () => { live = false; };
  }, [orgId, reload]);
  const load = () => { setState('loading'); setError(''); setReload((n) => n + 1); };

  const act = async (fn) => {
    setWorking(true); setError('');
    const r = await fn();
    setWorking(false);
    if (r.ok) setStatus(r.data);
    else setError(r.words);
  };

  const members = useMemo(() => (Array.isArray(status?.members) ? status.members : []), [status]);
  const memberIds = useMemo(() => new Set(members.map((m) => m.user_id)), [members]);
  const candidates = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [];
    return (allUsers || [])
      .filter((u) => u && u.email && !memberIds.has(u.id))
      .filter((u) => (u.email || '').toLowerCase().includes(q) || (u.full_name || '').toLowerCase().includes(q))
      .sort((a, b) => (b.org_id === orgId) - (a.org_id === orgId) || String(a.email).localeCompare(String(b.email)))
      .slice(0, 8);
  }, [allUsers, search, memberIds, orgId]);

  if (!orgId) return null;
  return (
    <div style={st.card} data-testid="msm-admin-card">
      <div style={st.h}>Multi site menu</div>
      {state === 'loading' && <div style={st.sub}>Loading…</div>}
      {state === 'missing' && <div style={st.sub}>Not installed yet. It appears here once the database update for the Multi site menu has been run.</div>}
      {state === 'error' && (
        <>
          <div style={st.err}>{error}</div>
          <button style={{ ...st.btn, ...st.ghost, marginTop: 10 }} onClick={load}>Try again</button>
        </>
      )}
      {state === 'ready' && status && (
        <>
          <div style={st.sub}>
            Turning this on shows the Multi site menu to the people below. Nothing changes at any venue until one of them publishes.
            Owners and ServOS staff are not let in automatically: add each person by name.
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 16 }}>
            <button disabled={working || !status.enabled} style={{ ...st.btn, ...(status.enabled ? st.ghost : st.on) }}
              onClick={() => act(() => msmApi.adminSetEnabled(orgId, false))}>Off</button>
            <button disabled={working || status.enabled} style={{ ...st.btn, ...(status.enabled ? st.on : st.ghost) }}
              onClick={() => act(() => msmApi.adminSetEnabled(orgId, true))}>On</button>
            <span style={{ fontSize: 12, color: 'var(--t3)' }}>
              {status.enabled ? `On${status.enabled_at ? ` since ${new Date(status.enabled_at).toLocaleDateString('en-GB')}` : ''}` : 'Off: nobody sees it'}
              {status.has_menu ? ' · group menu set up' : ''}
            </span>
          </div>

          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 4 }}>People</div>
          {members.length === 0 && <div style={{ fontSize: 13, color: 'var(--t4)', padding: '6px 0 10px' }}>Nobody yet.</div>}
          {members.map((m) => (
            <div key={m.user_id} style={st.row}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--t1)' }}>{m.full_name || m.email || 'A login'}</div>
                <div style={{ fontSize: 11, color: 'var(--t3)', fontFamily: 'monospace' }}>{m.email}</div>
              </div>
              <span style={{ ...st.pill, background: m.role === 'editor' ? 'var(--acc-d)' : 'var(--bg3)', color: m.role === 'editor' ? 'var(--acc)' : 'var(--t2)' }}>
                {m.role === 'editor' ? 'Editor' : 'Viewer'}
              </span>
              <button disabled={working} style={{ ...st.btn, ...st.ghost, padding: '4px 10px', fontSize: 11 }}
                onClick={() => act(() => msmApi.adminSetMember(orgId, m.user_id, m.role === 'editor' ? 'viewer' : 'editor'))}>
                Make {m.role === 'editor' ? 'viewer' : 'editor'}
              </button>
              <button disabled={working} style={{ ...st.btn, ...st.danger, padding: '4px 10px', fontSize: 11 }}
                onClick={() => act(() => msmApi.adminSetMember(orgId, m.user_id, null))}>Remove</button>
            </div>
          ))}

          <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
            <input style={st.input} placeholder="Add person: search by email or name" value={search} onChange={(e) => setSearch(e.target.value)} />
            <select style={{ ...st.input, width: 120 }} value={newRole} onChange={(e) => setNewRole(e.target.value)}>
              <option value="editor">Editor</option>
              <option value="viewer">Viewer</option>
            </select>
          </div>
          {candidates.map((u) => (
            <div key={u.id} style={st.row}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--t1)' }}>{u.full_name || u.email}</div>
                <div style={{ fontSize: 11, color: 'var(--t3)', fontFamily: 'monospace' }}>{u.email}{u.org_id !== orgId ? ' · another company' : ''}</div>
              </div>
              <button disabled={working} style={{ ...st.btn, ...st.on, padding: '4px 12px', fontSize: 11 }}
                onClick={async () => { await act(() => msmApi.adminSetMember(orgId, u.id, newRole)); setSearch(''); }}>
                Add as {newRole === 'editor' ? 'editor' : 'viewer'}
              </button>
            </div>
          ))}
          {error && <div style={st.err}>{error}</div>}
        </>
      )}
    </div>
  );
}
