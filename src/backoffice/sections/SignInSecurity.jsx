// src/backoffice/sections/SignInSecurity.jsx
//
// Back Office, Settings, Sign in security (docs/SECOND_STEP.md).
//   * your second steps: see them, remove one (needs this sign in to be aal2; the last
//     authenticator app stays, it is the backup that works everywhere)
//   * add Face ID or fingerprint on this device, or another authenticator app (a new phone)
//   * change your password (12 characters or more)
//   * your team (owners and ServOS only): who has set up, and a reset for a lost phone.
//     The second-step-reset edge function decides who may reset whom; this page only asks.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase, isMock } from '../../lib/supabase';
import {
  verifiedFactors, factorLabel, removalCheck, sessionAal, passwordProblem, explainError, MIN_PASSWORD_LENGTH,
} from '../../lib/secondStep/rules';
import {
  createSecondStepClient, detectFaceId, clearWeakPasswordNote, callResetFunction,
} from '../../lib/secondStep/client';
import AuthenticatorSetup from '../../components/secondStep/AuthenticatorSetup';

const ALLOW_LOCALHOST = !!import.meta.env?.DEV;

const card = { background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 14, padding: 20, marginBottom: 16 };
const h2 = { fontSize: 16, fontWeight: 700, color: 'var(--t1)', marginBottom: 6 };
const sub = { fontSize: 13.5, color: 'var(--t2)', lineHeight: 1.55, marginBottom: 14 };
const btn = (kind = 'primary') => ({
  padding: '10px 16px', borderRadius: 10, cursor: 'pointer', fontFamily: 'inherit', fontSize: 14, fontWeight: 700,
  border: kind === 'primary' ? 'none' : kind === 'danger' ? '1px solid var(--red-b)' : '1px solid var(--bdr2)',
  background: kind === 'primary' ? 'var(--acc)' : 'transparent',
  color: kind === 'primary' ? '#06130C' : kind === 'danger' ? 'var(--red)' : 'var(--t1)',
});
const input = { width: '100%', boxSizing: 'border-box', padding: '11px 13px', borderRadius: 10, border: '1px solid var(--bdr2)', background: 'var(--bg2)', color: 'var(--t1)', fontSize: 15, fontFamily: 'inherit', outline: 'none' };
const msgBox = (kind) => ({
  padding: '10px 12px', borderRadius: 10, fontSize: 13.5, lineHeight: 1.5, marginTop: 10,
  background: kind === 'error' ? 'var(--red-d)' : 'var(--acc-d)',
  border: `1px solid ${kind === 'error' ? 'var(--red-b)' : 'var(--acc-b)'}`,
  color: kind === 'error' ? 'var(--red)' : 'var(--t1)',
});

export default function SignInSecurity({ orgCtx }) {
  const client = useMemo(() => (supabase ? createSecondStepClient(supabase, { allowLocalhost: ALLOW_LOCALHOST }) : null), []);
  const [factors, setFactors] = useState([]);
  const [aal, setAal] = useState(null);
  const [email, setEmail] = useState('');
  const [face, setFace] = useState({ usable: false, label: 'Face ID or fingerprint', reason: 'host' });
  const [status, setStatus] = useState(null);
  const [msg, setMsg] = useState({ kind: '', text: '' });
  const [busy, setBusy] = useState('');
  const [addingApp, setAddingApp] = useState(false);

  const load = useCallback(async () => {
    if (!client) return;
    try {
      const session = await client.getSession();
      setAal(sessionAal(session));
      setEmail(session?.user?.email || '');
      const [all, f, s] = await Promise.all([client.listFactors(), detectFaceId({ allowLocalhost: ALLOW_LOCALHOST }), client.status()]);
      setFactors(all); setFace(f); setStatus(s);
    } catch (e) { setMsg({ kind: 'error', text: explainError(e) }); }
  }, [client]);

  useEffect(() => { load(); }, [load]);

  if (isMock || !client) {
    return <div style={{ padding: 24, color: 'var(--t3)' }}>Sign in security needs a live connection.</div>;
  }

  const verified = verifiedFactors(factors).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));

  const remove = async (f) => {
    const check = removalCheck({ factors, factorId: f.id, aal });
    if (!check.ok) { setMsg({ kind: 'error', text: check.reason }); return; }
    if (!window.confirm(`Remove "${factorLabel(f)}"? You will not be able to use it to sign in any more. If you signed in with it today, we will ask for your other second step straight away.`)) return;
    setBusy(f.id); setMsg({ kind: '', text: '' });
    try { await client.removeFactor(f.id); setMsg({ kind: 'ok', text: 'Removed.' }); await load(); }
    catch (e) { setMsg({ kind: 'error', text: explainError(e) }); }
    finally { setBusy(''); }
  };

  const addFace = async () => {
    setBusy('face'); setMsg({ kind: '', text: '' });
    try { await client.addFaceId({ email }); setMsg({ kind: 'ok', text: `${face.label} is set up on this device.` }); await load(); }
    catch (e) { setMsg({ kind: 'error', text: explainError(e) }); }
    finally { setBusy(''); }
  };

  return (
    <div style={{ maxWidth: 860, padding: '24px 0' }} data-testid="sign-in-security">
      <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--t1)', marginBottom: 4 }}>Sign in security</div>
      <div style={{ fontSize: 14, color: 'var(--t2)', marginBottom: 20, lineHeight: 1.55 }}>
        Signing in to the Back Office needs your password <strong>and</strong> a second step only you can do.
        {status && (status.enforce
          ? ' The server now refuses any sign in without it.'
          : ' Everyone sets it up at their next sign in. The server check switches on once everyone has.')}
      </div>

      {msg.text && <div style={msgBox(msg.kind)} role={msg.kind === 'error' ? 'alert' : undefined}>{msg.text}</div>}

      <div style={{ ...card, marginTop: 16 }}>
        <div style={h2}>Your second steps</div>
        <div style={sub}>Keep at least one authenticator app: it works everywhere, including our apps and the tills.</div>
        {verified.length === 0 && <div style={{ fontSize: 14, color: 'var(--t3)' }}>None yet. Sign out and back in to set one up.</div>}
        {verified.map((f) => {
          const check = removalCheck({ factors, factorId: f.id, aal });
          return (
            <div key={f.id} data-testid="security-factor" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 0', borderTop: '1px solid var(--bdr)' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14.5, fontWeight: 600, color: 'var(--t1)' }}>{factorLabel(f)}</div>
              </div>
              <button onClick={() => remove(f)} disabled={busy === f.id} title={check.ok ? '' : check.reason}
                style={{ ...btn('danger'), opacity: check.ok ? 1 : 0.5 }}>
                {busy === f.id ? 'Removing…' : 'Remove'}
              </button>
            </div>
          );
        })}
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 14 }}>
          {face.usable && (
            <button onClick={addFace} disabled={busy === 'face'} style={btn('primary')} data-testid="security-add-faceid">
              {busy === 'face' ? 'Waiting for you…' : `Add ${face.label} on this device`}
            </button>
          )}
          {!addingApp && (
            <button onClick={() => { setAddingApp(true); setMsg({ kind: '', text: '' }); }} style={btn('ghost')}>
              Add another authenticator app
            </button>
          )}
        </div>
        {!face.usable && (
          <div style={{ fontSize: 12.5, color: 'var(--t3)', marginTop: 10, lineHeight: 1.5 }}>
            {face.reason === 'app' && 'Face ID and fingerprint are coming to our apps. For now, use the authenticator app here, or add Face ID from your phone or computer browser at app.serv-os.app.'}
            {face.reason === 'host' && 'Face ID and fingerprint work at app.serv-os.app. On this web address, use the authenticator app.'}
            {face.reason === 'device' && 'This device has no Face ID, Touch ID, Windows Hello or fingerprint set up.'}
            {face.reason === 'browser' && 'This browser does not support Face ID or fingerprint sign in.'}
          </div>
        )}
        {addingApp && (
          <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--bdr)' }}>
            <AuthenticatorSetup client={client} tone="auto" onDone={async () => { setAddingApp(false); setMsg({ kind: 'ok', text: 'Authenticator app added.' }); await load(); }} />
            <button onClick={() => setAddingApp(false)} style={{ ...btn('ghost'), marginTop: 12 }}>Cancel</button>
          </div>
        )}
      </div>

      <ChangePassword client={client} />

      <TeamSecondSteps orgCtx={orgCtx} />
    </div>
  );
}

function ChangePassword({ client }) {
  const [p1, setP1] = useState('');
  const [p2, setP2] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState({ kind: '', text: '' });
  const save = async () => {
    const problem = passwordProblem(p1, p2);
    if (problem) { setMsg({ kind: 'error', text: problem }); return; }
    setBusy(true); setMsg({ kind: '', text: '' });
    try {
      await client.changePassword(p1);
      clearWeakPasswordNote();
      setP1(''); setP2('');
      setMsg({ kind: 'ok', text: 'Password changed.' });
    } catch (e) { setMsg({ kind: 'error', text: explainError(e) }); }
    finally { setBusy(false); }
  };
  return (
    <div style={card}>
      <div style={h2}>Change your password</div>
      <div style={sub}>At least {MIN_PASSWORD_LENGTH} characters. A short sentence you will remember is best. Never reuse a password from another website.</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
        <input style={input} type="password" autoComplete="new-password" placeholder="New password" value={p1} onChange={(e) => setP1(e.target.value)} data-testid="security-new-password" />
        <input style={input} type="password" autoComplete="new-password" placeholder="Type it again" value={p2} onChange={(e) => setP2(e.target.value)} data-testid="security-confirm-password" />
      </div>
      <button onClick={save} disabled={busy || !p1 || !p2} data-testid="security-change-password" style={{ ...btn('primary'), marginTop: 12, opacity: busy || !p1 || !p2 ? 0.6 : 1 }}>
        {busy ? 'Saving…' : 'Change password'}
      </button>
      {msg.text && <div style={msgBox(msg.kind)}>{msg.text}</div>}
    </div>
  );
}

function TeamSecondSteps({ orgCtx }) {
  const locationId = orgCtx?.locationId || null;
  const isSuper = orgCtx?.role === 'super_admin';
  const [data, setData] = useState(null);
  const [hidden, setHidden] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    if (!locationId) return;
    setErr('');
    try { setData(await callResetFunction(supabase, { action: 'team', location_id: locationId })); setHidden(false); }
    catch (e) {
      if (e.code === 'not_owner') setHidden(true);
      else setErr(explainError(e));
    }
  }, [locationId]);

  useEffect(() => { load(); }, [load]);

  if (hidden || !locationId) return null;

  const reset = async (row) => {
    const who = row.email || 'this person';
    if (!window.confirm(`Reset the second step for ${who}?\n\nThis removes their Face ID, fingerprint and authenticator apps. They set up again at their next sign in, and we email them. Only do this if they asked you (for example a lost phone).`)) return;
    setBusy(row.user_id); setNote(''); setErr('');
    try {
      const r = await callResetFunction(supabase, { action: 'reset', user_id: row.user_id, location_id: locationId, reason: 'reset from Back Office' });
      setNote(r.note || `Done. ${who} will set up again at their next sign in${r.emailed ? ', and we emailed them' : ''}.`);
      await load();
    } catch (e) { setErr(explainError(e)); }
    finally { setBusy(''); }
  };

  return (
    <div style={card}>
      <div style={h2}>Your team{orgCtx?.locationName ? ` at ${orgCtx.locationName}` : ''}</div>
      <div style={sub}>
        Who has set up their second step. If someone loses their phone, reset it here and they set up again at their next sign in.
        {isSuper ? ' As ServOS you can reset anyone.' : ' Only ServOS can reset an owner.'}
      </div>
      {err && <div style={msgBox('error')} role="alert">{err}</div>}
      {note && <div style={msgBox('ok')}>{note}</div>}
      {!data && !err && <div style={{ fontSize: 14, color: 'var(--t3)' }}>Loading…</div>}
      {data && (
        <>
          <div style={{ fontSize: 13, color: 'var(--t2)', margin: '6px 0 4px' }}>
            {data.set_up} of {data.total} set up
          </div>
          {data.rows.map((r) => (
            <div key={r.user_id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 0', borderTop: '1px solid var(--bdr)', flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 200 }}>
                <div style={{ fontSize: 14.5, fontWeight: 600, color: 'var(--t1)' }}>{r.name || r.email}{r.is_you ? ' (you)' : ''}</div>
                <div style={{ fontSize: 12.5, color: 'var(--t3)' }}>{r.email}{r.venue_role ? ` · ${r.venue_role}` : ''}{r.servos_admin ? ' · ServOS' : ''}</div>
              </div>
              <span style={{
                fontSize: 12, fontWeight: 700, padding: '4px 10px', borderRadius: 999,
                background: r.second_step.set_up ? 'var(--acc-d)' : 'rgba(245,166,35,0.14)',
                color: r.second_step.set_up ? 'var(--acc)' : 'var(--amber, #F5A623)',
              }}>
                {r.second_step.set_up ? `Set up${r.second_step.face_id ? ' · Face ID' : ''}` : 'Not set up yet'}
              </span>
              {!r.is_you && (
                r.can_reset
                  ? <button onClick={() => reset(r)} disabled={busy === r.user_id} style={btn('danger')}>{busy === r.user_id ? 'Resetting…' : 'Reset'}</button>
                  : <span style={{ fontSize: 12, color: 'var(--t3)', maxWidth: 220 }} title={r.reset_note || ''}>{r.reset_note ? 'ServOS only' : ''}</span>
              )}
            </div>
          ))}
        </>
      )}
    </div>
  );
}
