// src/admin/sections/AdminSharedStock.jsx
//
// MULTI SITE STOCK (v5.11.80): the Company Admin card under the Multi site menu card (plan 5.1).
//   * The switch: Shared stock, Off or On. Only ServOS staff with the second step (the database
//     checks: stock_admin_set_enabled). Needs the Multi site menu on for the company first.
//   * Peter (19 Oct 2026): "if a site is multi site stock, multi site should be on". Switching it on
//     puts central stock depletion on at every site of the company (and every site that joins later);
//     there is no second switch.
//   * The stock people: Editors and Viewers, a separate list from the menu people. Owners are not
//     added automatically.
// Nothing shows as done until the database answers; the card always shows what it returned.

import { useEffect, useMemo, useState } from 'react';
import { stockCompanyApi } from '../../lib/stock/company/stockCompanyApi';
import BetaTag from '../../components/BetaTag';

const st = {
  card: { background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 12, padding: 20, marginBottom: 16, boxShadow: 'var(--sh)' },
  h: { fontSize: 14, fontWeight: 700, color: 'var(--t1)', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 8 },
  sub: { fontSize: 12.5, color: 'var(--t3)', marginBottom: 14, lineHeight: 1.5 },
  btn: { padding: '7px 13px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit' },
  on: { background: 'var(--acc)', color: '#0b0c10' },
  ghost: { background: 'transparent', color: 'var(--t2)', border: '1px solid var(--bdr2)' },
  danger: { background: 'transparent', color: 'var(--red)', border: '1px solid var(--red-b)' },
  input: { width: '100%', padding: '8px 11px', borderRadius: 8, border: '1px solid var(--bdr2)', background: 'var(--bg2)', color: 'var(--t1)', fontSize: 13, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' },
  row: { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderTop: '1px solid var(--bdr)' },
  err: { fontSize: 12.5, color: 'var(--red)', marginTop: 10 },
};

export default function AdminSharedStock({ org, allUsers = [] }) {
  const orgId = org?.id || null;
  const [status, setStatus] = useState(null);
  const [state, setState] = useState('loading');   // loading | ready | missing | error
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  const [search, setSearch] = useState('');
  const [newRole, setNewRole] = useState('editor');
  const [asking, setAsking] = useState(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!orgId) return undefined;
    let live = true;
    stockCompanyApi.adminStatus(orgId).then((r) => {
      if (!live) return;
      if (r.ok) { setStatus(r.data); setState('ready'); setError(''); }
      else if (r.notInstalled) setState('missing');
      else { setState('error'); setError(r.words); }
    });
    return () => { live = false; };
  }, [orgId, reload]);

  const act = async (fn) => {
    setWorking(true); setError('');
    const r = await fn();
    setWorking(false);
    if (r.ok) setStatus(r.data); else setError(r.words);
  };
  const members = useMemo(() => (Array.isArray(status?.members) ? status.members : []), [status]);
  const memberIds = useMemo(() => new Set(members.map((m) => m.user_id)), [members]);
  const candidates = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [];
    return (allUsers || []).filter((u) => u && u.email && !memberIds.has(u.id))
      .filter((u) => (u.email || '').toLowerCase().includes(q) || (u.full_name || '').toLowerCase().includes(q))
      .sort((a, b) => (b.org_id === orgId) - (a.org_id === orgId) || String(a.email).localeCompare(String(b.email)))
      .slice(0, 8);
  }, [allUsers, search, memberIds, orgId]);

  if (!orgId) return null;
  const blocked = !status?.enabled && !status?.menu_enabled;
  return (
    <div style={st.card} data-testid="shared-stock-admin-card">
      <div style={st.h}>Shared stock (multi site stock)<BetaTag /></div>
      {state === 'loading' && <div style={st.sub}>Loading…</div>}
      {state === 'missing' && <div style={st.sub}>Not installed yet. It appears here once the database update for multi site stock (20261019c) has been run.</div>}
      {state === 'error' && <><div style={st.err}>{error}</div><button style={{ ...st.btn, ...st.ghost, marginTop: 10 }} onClick={() => { setState('loading'); setReload((n) => n + 1); }}>Try again</button></>}
      {state === 'ready' && status && (
        <>
          <div style={st.sub}>
            Head office owns the stock items, packs, suppliers and prices; each site keeps its own stock on hand, cost, counts and orders.
            Nothing changes at any site until a stock Editor publishes. Switching it on also puts central stock on at every site of the company, and at every site that joins later.
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 10 }}>
            <button type="button" role="switch" aria-checked={!!status.enabled} aria-label="Shared stock on or off" disabled={working || blocked}
              title={blocked ? 'Switch the Multi site menu on for this company first' : ''}
              onClick={() => {
                if (status.enabled) setAsking({ words: `Turn Shared stock off for ${org?.name || 'this company'}? Publishing stops and nobody sees the screens. Nothing at any site changes, and central stock stays on.`, yes: 'Turn it off', run: () => act(() => stockCompanyApi.adminSetEnabled(orgId, false)) });
                else act(() => stockCompanyApi.adminSetEnabled(orgId, true));
              }}
              style={{ width: 46, height: 26, borderRadius: 13, border: 'none', cursor: blocked ? 'not-allowed' : 'pointer', position: 'relative', flexShrink: 0, background: status.enabled ? 'var(--acc)' : 'var(--bg3)', opacity: working || blocked ? 0.45 : 1 }}>
              <span style={{ position: 'absolute', top: 3, left: status.enabled ? 23 : 3, width: 20, height: 20, borderRadius: 10, background: '#fff', transition: 'left .15s' }} />
            </button>
            <span style={{ fontSize: 13, color: 'var(--t1)', fontWeight: 650 }}>
              {status.enabled ? `On${status.enabled_at ? ` since ${new Date(status.enabled_at).toLocaleDateString('en-GB')}` : ''}` : 'Off'}
              <span style={{ color: 'var(--t3)', fontWeight: 500 }}> · central stock at {status.sites_central} of {status.sites} sites{status.sites_paused ? ` (${status.sites_paused} paused by ServOS)` : ''} · {status.items} company items</span>
            </span>
          </div>
          {blocked && <div style={{ fontSize: 12.5, color: 'var(--t1)', marginBottom: 12, padding: '8px 10px', borderRadius: 8, background: 'color-mix(in srgb, var(--amber, #F5A623) 10%, transparent)' }}>Switch the Multi site menu on for this company first: Shared stock lives beside it.</div>}
          {status.switched_central > 0 && <div style={{ fontSize: 12.5, color: 'var(--t1)', marginBottom: 12 }}>Central stock switched on at {status.switched_central} site{status.switched_central === 1 ? '' : 's'} that were on the till path.</div>}
          {asking && (
            <div role="alertdialog" style={{ fontSize: 12.5, color: 'var(--t1)', marginBottom: 12, padding: '10px 12px', borderRadius: 10, border: '1px solid var(--red-b)', background: 'var(--red-d, var(--bg2))' }}>
              <div style={{ marginBottom: 8 }}>{asking.words}</div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button style={{ ...st.btn, ...st.danger }} disabled={working} onClick={() => { const run = asking.run; setAsking(null); run(); }}>{asking.yes}</button>
                <button style={{ ...st.btn, ...st.ghost }} onClick={() => setAsking(null)}>Keep it as it is</button>
              </div>
            </div>
          )}
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 4 }}>Stock people</div>
          {members.length === 0 && <div style={{ fontSize: 13, color: 'var(--t4)', padding: '6px 0 10px' }}>Nobody yet.</div>}
          {members.map((m) => (
            <div key={m.user_id} style={st.row}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--t1)' }}>{m.full_name || m.email || 'A login'}</div>
                <div style={{ fontSize: 11, color: 'var(--t3)', fontFamily: 'monospace' }}>{m.email}</div>
              </div>
              <span style={{ padding: '2px 8px', borderRadius: 20, fontSize: 11, fontWeight: 700, background: m.role === 'editor' ? 'var(--acc-d)' : 'var(--bg3)', color: m.role === 'editor' ? 'var(--acc)' : 'var(--t2)' }}>{m.role === 'editor' ? 'Editor' : 'Viewer'}</span>
              <button disabled={working} style={{ ...st.btn, ...st.ghost, padding: '4px 10px', fontSize: 11 }}
                onClick={() => act(() => stockCompanyApi.adminSetMember(orgId, m.user_id, m.role === 'editor' ? 'viewer' : 'editor'))}>Make {m.role === 'editor' ? 'viewer' : 'editor'}</button>
              <button disabled={working} style={{ ...st.btn, ...st.danger, padding: '4px 10px', fontSize: 11 }}
                onClick={() => setAsking({ words: `Remove ${m.full_name || m.email || 'this login'} from Shared stock? Nothing at any site changes.`, yes: 'Remove', run: () => act(() => stockCompanyApi.adminSetMember(orgId, m.user_id, null)) })}>Remove</button>
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
                <div style={{ fontSize: 11, color: 'var(--t3)', fontFamily: 'monospace' }}>{u.email}{u.org_id !== orgId && <span style={{ color: 'var(--red)', fontFamily: 'inherit', fontWeight: 700 }}> · another company</span>}</div>
              </div>
              <button disabled={working} style={{ ...st.btn, ...st.on, padding: '4px 12px', fontSize: 11 }}
                onClick={async () => { await act(() => stockCompanyApi.adminSetMember(orgId, u.id, newRole)); setSearch(''); }}>Add as {newRole}</button>
            </div>
          ))}
          {error && <div style={st.err}>{error}</div>}
        </>
      )}
    </div>
  );
}
