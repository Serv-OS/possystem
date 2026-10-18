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
//   * Round 2 (UI issue 12c): a company with a site that has more than one menu needs a tick before
//     it is switched on: "The multi site menu changes one menu per site for now".
// Every change goes through the database's own functions (msm_admin_set_enabled,
// msm_admin_set_member), which check for ServOS with the second step. Nothing shows as done until
// the database answers; the card always shows what the database returned.

import { useEffect, useMemo, useState } from 'react';
import { msmApi } from '../../lib/msm/msmApi';
import { adminSwitchState } from '../../lib/msm/msmStatus';

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
  // { org, n, r }: the check of the sites' menus for this company and this read (null until it
  // answers, so the switch stays blocked while it runs: 17 Oct verification).
  const [manyBy, setManyBy] = useState(null);
  const [manyTicked, setManyTicked] = useState(false);
  const [asking, setAsking] = useState(null);       // { words, yes, run } an in page "are you sure"

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
    // The switch stays blocked until this check answers; a failed or thrown check still needs the
    // tick (17 Oct verification: it failed open).
    const check = msmApi.sitesWithManyMenus ? msmApi.sitesWithManyMenus(orgId) : Promise.resolve({ ok: false, sites: [] });
    Promise.resolve(check)
      .then((r) => { if (live) setManyBy({ org: orgId, n: reload, r: r || { ok: false, sites: [] } }); })
      .catch(() => { if (live) setManyBy({ org: orgId, n: reload, r: { ok: false, sites: [] } }); });
    return () => { live = false; };
  }, [orgId, reload]);
  const many = manyBy && manyBy.org === orgId && manyBy.n === reload ? manyBy.r : null;
  const sw = adminSwitchState({ enabled: !!status?.enabled, many, ticked: manyTicked, working });
  const needsTick = sw.needsTick;
  const load = () => { setState('loading'); setError(''); setManyTicked(false); setReload((n) => n + 1); };

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
          {/* One switch with words (round 2, design 2 item 23). Turning it off asks first. */}
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 8 }}>
            <button type="button" role="switch" aria-checked={!!status.enabled} aria-label="Multi site menu on or off" data-testid="msm-admin-switch"
              disabled={sw.disabled} aria-disabled={sw.disabled} title={sw.title}
              onClick={() => {
                if (status.enabled) setAsking({ words: `Turn the Multi site menu off for ${org?.name || 'this company'}? Nobody will see it, and scheduled pushes wait until it is on again. Nothing at any site changes.`, yes: 'Turn it off', run: () => act(() => msmApi.adminSetEnabled(orgId, false)) });
                else act(() => msmApi.adminSetEnabled(orgId, true));
              }}
              style={{ width: 46, height: 26, borderRadius: 13, border: 'none', cursor: sw.blocked ? 'not-allowed' : 'pointer', position: 'relative', flexShrink: 0, background: status.enabled ? 'var(--acc)' : 'var(--bg3)', opacity: working || sw.blocked ? 0.45 : 1 }}>
              <span style={{ position: 'absolute', top: 3, left: status.enabled ? 23 : 3, width: 20, height: 20, borderRadius: 10, background: '#fff', transition: 'left .15s' }} />
            </button>
            <span style={{ fontSize: 13, color: 'var(--t1)', fontWeight: 650 }}>
              {status.enabled ? `On${status.enabled_at ? ` since ${new Date(status.enabled_at).toLocaleDateString('en-GB')}` : ''}: the people below can open it` : 'Off: nobody sees it, and scheduled pushes wait until it is on again.'}
              {status.has_menu ? <span style={{ color: 'var(--t3)', fontWeight: 500 }}> · group menu set up</span> : ''}
            </span>
          </div>
          {asking && (
            <div role="alertdialog" style={{ fontSize: 12.5, color: 'var(--t1)', marginBottom: 12, padding: '10px 12px', borderRadius: 10, border: '1px solid var(--red-b)', background: 'var(--red-d, var(--bg2))' }}>
              <div style={{ marginBottom: 8 }}>{asking.words}</div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button style={{ ...st.btn, ...st.danger }} disabled={working} onClick={() => { const run = asking.run; setAsking(null); run(); }}>{asking.yes}</button>
                <button style={{ ...st.btn, ...st.ghost }} onClick={() => setAsking(null)}>Keep it as it is</button>
              </div>
            </div>
          )}
          {status.enabled && members.length === 0 && (
            <div style={{ fontSize: 12.5, color: 'var(--t1)', marginBottom: 12, padding: '8px 10px', borderRadius: 8, background: 'color-mix(in srgb, var(--amber, #F5A623) 10%, transparent)' }}>Nobody can open it yet. Add a person below.</div>
          )}
          <div style={{ marginBottom: 12 }} />

          {!status.enabled && sw.checking && <div style={{ fontSize: 12.5, color: 'var(--t3)', marginBottom: 14 }}>{sw.note}</div>}
          {!status.enabled && needsTick && (
            <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12.5, color: 'var(--t1)', marginBottom: 14, padding: '10px 12px', borderRadius: 10, border: '1px solid color-mix(in srgb, var(--amber, #F5A623) 45%, transparent)', background: 'color-mix(in srgb, var(--amber, #F5A623) 10%, transparent)', cursor: 'pointer' }}>
              <input type="checkbox" checked={manyTicked} onChange={(e) => setManyTicked(e.target.checked)} style={{ marginTop: 2 }} />
              <span>{sw.note}
                {!sw.failed && <span style={{ display: 'block', color: 'var(--t3)', marginTop: 4 }}>{many.sites.slice(0, 4).map((x) => `${x.name}: ${x.menus.join(', ')}`).join(' · ')}{many.sites.length > 4 ? ` and ${many.sites.length - 4} more` : ''}</span>}
              </span>
            </label>
          )}
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 4 }}>People</div>
          {members.length === 0 && <div style={{ fontSize: 13, color: 'var(--t4)', padding: '6px 0 10px' }}>Nobody yet.</div>}
          {members.map((m) => {
            const other = (allUsers || []).some((u) => u && u.id === m.user_id && u.org_id && u.org_id !== orgId);
            return (
            <div key={m.user_id} style={st.row}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--t1)' }}>{m.full_name || m.email || 'A login'}</div>
                <div style={{ fontSize: 11, color: 'var(--t3)', fontFamily: 'monospace' }}>{m.email}{other && <span style={{ color: 'var(--red)', fontFamily: 'inherit', fontWeight: 700 }}> · another company</span>}</div>
              </div>
              <span style={{ ...st.pill, background: m.role === 'editor' ? 'var(--acc-d)' : 'var(--bg3)', color: m.role === 'editor' ? 'var(--acc)' : 'var(--t2)' }}>
                {m.role === 'editor' ? 'Editor' : 'Viewer'}
              </span>
              <button disabled={working} style={{ ...st.btn, ...st.ghost, padding: '4px 10px', fontSize: 11 }}
                onClick={() => act(() => msmApi.adminSetMember(orgId, m.user_id, m.role === 'editor' ? 'viewer' : 'editor'))}>
                Make {m.role === 'editor' ? 'viewer' : 'editor'}
              </button>
              <button disabled={working} style={{ ...st.btn, ...st.danger, padding: '4px 10px', fontSize: 11 }}
                onClick={() => setAsking({ words: `Remove ${m.full_name || m.email || 'this login'} from the Multi site menu? They will not be able to open it. Nothing at any site changes.`, yes: 'Remove', run: () => act(() => msmApi.adminSetMember(orgId, m.user_id, null)) })}>Remove</button>
            </div>
            );
          })}

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
