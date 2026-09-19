// src/admin/sections/AdminSecondSteps.jsx
//
// Company Admin, Sign in security (ServOS super admin only; docs/SECOND_STEP.md).
// Every Back Office login, whether it has set up its second step, and the ServOS reset for a
// lost phone (owners and super admins can only be reset here). The second-step-reset edge
// function checks the caller is a super admin at aal2; this screen only asks.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { callResetFunction } from '../../lib/secondStep/client';
import { explainError } from '../../lib/secondStep/rules';

const card = { background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 12, padding: 20, marginBottom: 16 };

export default function AdminSecondSteps() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState('');
  const [q, setQ] = useState('');

  const load = useCallback(async () => {
    setErr('');
    try { setData(await callResetFunction(supabase, { action: 'team' })); }
    catch (e) { setErr(explainError(e)); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const rows = useMemo(() => {
    const all = data?.rows || [];
    const term = q.trim().toLowerCase();
    return term ? all.filter((r) => `${r.email} ${r.name || ''}`.toLowerCase().includes(term)) : all;
  }, [data, q]);

  const reset = async (r) => {
    const who = r.email || 'this login';
    if (!window.confirm(`Reset the second step for ${who}?\n\nThis removes their Face ID, fingerprint and authenticator apps. They set up again at their next sign in, and we email them. Only do this after checking it is really them asking (call them back on a number you already know).`)) return;
    setBusy(r.user_id); setNote(''); setErr('');
    try {
      const res = await callResetFunction(supabase, { action: 'reset', user_id: r.user_id, reason: 'reset by ServOS from Company Admin' });
      setNote(res.note || `Done. ${who} will set up again at their next sign in${res.emailed ? ', and we emailed them' : ''}.`);
      await load();
    } catch (e) { setErr(explainError(e)); }
    finally { setBusy(''); }
  };

  return (
    <div data-testid="admin-second-steps">
      <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--t1)', marginBottom: 4 }}>🔐 Sign in security</div>
      <div style={{ fontSize: 13, color: 'var(--t3)', marginBottom: 20 }}>
        Every Back Office login and whether it has set up its second step.
        {data && ` ${data.set_up} of ${data.total} set up.`} Switch the server check on only when everyone active has (docs/SECOND_STEP.md).
      </div>
      {err && <div style={{ ...card, color: 'var(--red)', borderColor: 'var(--red-b)' }} role="alert">{err}</div>}
      {note && <div style={{ ...card, color: 'var(--t1)', borderColor: 'var(--acc-b)' }}>{note}</div>}
      <div style={card}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by email or name"
          style={{ width: '100%', boxSizing: 'border-box', padding: '9px 12px', borderRadius: 8, border: '1px solid var(--bdr2)', background: 'var(--bg2)', color: 'var(--t1)', fontSize: 13, fontFamily: 'inherit', marginBottom: 10 }} />
        {!data && !err && <div style={{ fontSize: 13, color: 'var(--t3)' }}>Loading…</div>}
        {rows.map((r) => (
          <div key={r.user_id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', borderTop: '1px solid var(--bdr)', flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 220 }}>
              <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--t1)' }}>{r.name || r.email}{r.is_you ? ' (you)' : ''}</div>
              <div style={{ fontSize: 11.5, color: 'var(--t3)', fontFamily: 'monospace' }}>{r.email}{r.servos_admin ? ' · ServOS admin' : ''}</div>
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--t3)', minWidth: 120 }}>
              {r.last_sign_in_at ? `Last in ${new Date(r.last_sign_in_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}` : 'Never signed in'}
            </div>
            <span style={{
              fontSize: 11, fontWeight: 700, padding: '3px 9px', borderRadius: 999,
              background: r.second_step.set_up ? 'var(--acc-d)' : 'rgba(245,166,35,0.14)',
              color: r.second_step.set_up ? 'var(--acc)' : 'var(--amber, #F5A623)',
            }}>
              {r.second_step.set_up ? `Set up${r.second_step.face_id ? ' · Face ID' : ''}` : 'Not set up yet'}
            </span>
            {!r.is_you && r.can_reset && (
              <button onClick={() => reset(r)} disabled={busy === r.user_id}
                style={{ padding: '6px 12px', borderRadius: 8, border: '1px solid var(--red-b)', background: 'transparent', color: 'var(--red)', cursor: 'pointer', fontSize: 12, fontWeight: 700, fontFamily: 'inherit' }}>
                {busy === r.user_id ? 'Resetting…' : 'Reset'}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
