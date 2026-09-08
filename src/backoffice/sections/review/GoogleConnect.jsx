// src/backoffice/sections/review/GoogleConnect.jsx
//
// One-click Google Business Profile connection for a venue, shown inside the
// Settings → Google platform card. The manager clicks Connect → signs in with
// Google → (picks a location if they manage several) → done. Reviews then sync
// in and approved replies post back. All token handling is server-side
// (review-google); this component only drives the flow + shows status.

import { useEffect, useState } from 'react';
import { supabase } from '../../../lib/supabase';

const S = {
  box:   { marginTop: 12, border: '1px solid var(--bdr)', borderRadius: 10, background: 'var(--bg2)', padding: 12 },
  btnG:  { display: 'inline-flex', alignItems: 'center', gap: 8, padding: '9px 14px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'inherit', background: '#1f1f24', color: '#fff' },
  gG:    { width: 18, height: 18, borderRadius: 99, background: '#fff', color: '#4285F4', fontWeight: 800, fontSize: 11, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' },
  ghost: { padding: '7px 12px', borderRadius: 8, cursor: 'pointer', fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit', background: 'transparent', color: 'var(--t2)', border: '1px solid var(--bdr2)' },
  input: { width: '100%', boxSizing: 'border-box', border: '1px solid var(--bdr2)', borderRadius: 8, padding: '8px 10px', fontSize: 13, fontFamily: 'inherit', color: 'var(--t1)', background: 'var(--bg)', outline: 'none', marginTop: 8 },
  ok:    { fontSize: 12.5, color: 'var(--grn)', fontWeight: 700 },
  err:   { fontSize: 12, color: 'var(--red)', marginTop: 6 },
  hint:  { fontSize: 11.5, color: 'var(--t4)', marginTop: 6, lineHeight: 1.45 },
  banner:(kind) => ({ fontSize: 12.5, fontWeight: 700, padding: '8px 10px', borderRadius: 8, marginBottom: 10, color: kind === 'ok' ? 'var(--grn)' : 'var(--red)', background: kind === 'ok' ? 'var(--grn-d, rgba(48,164,108,.12))' : 'var(--red-d, rgba(226,75,74,.12))', border: '1px solid var(--bdr)' }),
};

const RETURN_MSG = {
  connected: ['ok', 'Google connected ✓'],
  pick: ['ok', 'Connected — choose which location below.'],
  error: ['err', 'Google connection failed — please try again.'],
  expired: ['err', 'That connect link expired — please try again.'],
  norefresh: ['err', 'Google didn’t return a refresh token — remove the app’s access in your Google account and reconnect.'],
};

export default function GoogleConnect({ locId }) {
  const [st, setSt] = useState(null);   // { configured, connected, location_title, needs_pick, available }
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [pick, setPick] = useState('');
  const [banner, setBanner] = useState(null);

  const call = async (action, extra = {}) => {
    const { data, error } = await supabase.functions.invoke('review-google', { body: { action, ops_location_id: locId, ...extra } });
    if (error) { let b = null; try { b = await error.context?.json?.(); } catch {} throw new Error(b?.error || error.message); }
    if (data?.error) throw new Error(data.error);
    return data;
  };
  const loadStatus = async () => { try { setSt(await call('status')); } catch (e) { setErr(e.message); } };

  useEffect(() => {
    // surface the OAuth return (review-google redirects to ?google=…)
    try {
      const g = new URLSearchParams(window.location.search).get('google');
      if (g && RETURN_MSG[g]) setBanner(RETURN_MSG[g]);
    } catch {}
    loadStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locId]);

  const connect = async () => {
    setBusy(true); setErr('');
    try { const { url } = await call('start'); if (url) window.location.href = url; }
    catch (e) { setErr(e.message); setBusy(false); }
  };
  const choose = async () => {
    if (!pick) return;
    setBusy(true); setErr('');
    try { await call('set_location', { location_name: pick }); await loadStatus(); }
    catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const disconnect = async () => {
    if (!confirm('Disconnect Google? Reviews will stop syncing and replies won’t post.')) return;
    setBusy(true); setErr('');
    try { await call('disconnect'); await loadStatus(); }
    catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  if (!st) return <div style={S.box}><div style={S.hint}>Checking Google connection…</div></div>;

  return (
    <div style={S.box}>
      {banner && <div style={S.banner(banner[0])}>{banner[1]}</div>}

      {!st.configured ? (
        <div style={S.hint}>Google connection isn’t switched on for the platform yet — the operator needs to add the Google OAuth credentials. Once that’s done, a one-click “Connect Google” button appears here.</div>
      ) : !st.connected ? (
        <>
          <button style={S.btnG} onClick={connect} disabled={busy}><span style={S.gG}>G</span>{busy ? 'Opening…' : 'Connect Google'}</button>
          <div style={S.hint}>Sign in with the Google account that manages this venue’s Business Profile. Reviews then sync in and your approved replies post back automatically.</div>
        </>
      ) : st.needs_pick ? (
        <>
          <div style={{ fontSize: 13, color: 'var(--t1)', fontWeight: 700, marginBottom: 2 }}>Choose this venue’s Google location</div>
          <select style={S.input} value={pick} onChange={e => setPick(e.target.value)}>
            <option value="">Select a location…</option>
            {(st.available || []).map(l => <option key={l.name} value={l.name}>{l.title}</option>)}
          </select>
          <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
            <button style={S.btnG} onClick={choose} disabled={busy || !pick}>{busy ? 'Saving…' : 'Use this location'}</button>
            <button style={S.ghost} onClick={disconnect} disabled={busy}>Disconnect</button>
          </div>
        </>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <span style={S.ok}>✓ Connected</span>
            {st.location_title && <span style={{ fontSize: 12.5, color: 'var(--t3)', marginLeft: 8 }}>{st.location_title}</span>}
            <div style={S.hint}>Reviews sync into the Approvals queue; approved replies post back to Google.</div>
          </div>
          <button style={S.ghost} onClick={disconnect} disabled={busy}>Disconnect</button>
        </div>
      )}
      {err && <div style={S.err}>{err}</div>}
    </div>
  );
}
