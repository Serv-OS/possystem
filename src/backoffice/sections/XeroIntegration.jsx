// src/backoffice/sections/XeroIntegration.jsx
//
// Back office → Settings → "Xero (accounting)". Connects THIS venue to its own Xero
// organisation (OAuth) so we can push sales, bills/expenses and payment data. Phase 1:
// connect + show the linked org. The tokens live server-side (xero_connections); this
// screen only ever sees the non-secret status.

import { useCallback, useEffect, useState } from 'react';
import { getActiveLocationSync } from '../../lib/supabase';
import { xeroStatus, xeroOAuthStart, xeroDisconnect } from '../../lib/xero';

const S = {
  h1: { fontSize: 22, fontWeight: 800, color: 'var(--t1)', margin: 0, letterSpacing: '-.01em' },
  sub: { fontSize: 13, color: 'var(--t3)', marginTop: 4, marginBottom: 18, maxWidth: 620, lineHeight: 1.5 },
  card: { border: '1px solid var(--bdr)', borderRadius: 14, background: 'var(--bg1)', padding: 20, marginBottom: 14, maxWidth: 620 },
  btn: { padding: '11px 18px', borderRadius: 10, border: 'none', cursor: 'pointer', fontSize: 14, fontWeight: 800, fontFamily: 'inherit', background: 'var(--acc)', color: '#0b0c10' },
  ghost: { padding: '9px 14px', borderRadius: 9, cursor: 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'inherit', background: 'transparent', color: 'var(--t2)', border: '1px solid var(--bdr2)' },
  empty: { textAlign: 'center', padding: '60px 20px', color: 'var(--t3)', fontSize: 14 },
  note: { fontSize: 12.5, color: 'var(--t3)', lineHeight: 1.55 },
  pill: (bg, fg) => ({ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 10px', borderRadius: 999, fontSize: 12, fontWeight: 800, background: bg, color: fg }),
  banner: (ok) => ({ padding: '10px 14px', borderRadius: 10, fontSize: 13, fontWeight: 700, marginBottom: 14, maxWidth: 620, background: ok ? 'rgba(46,143,78,.14)' : 'rgba(200,60,60,.14)', color: ok ? '#2f8f4e' : '#c33', border: `1px solid ${ok ? 'rgba(46,143,78,.3)' : 'rgba(200,60,60,.3)'}` }),
};

export default function XeroIntegration() {
  const [locId, setLocId] = useState(null);
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [flash, setFlash] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setErr('');
    const id = getActiveLocationSync(); setLocId(id);
    if (!id) { setLoading(false); return; }
    try { setStatus(await xeroStatus(id)); } catch (e) { setErr(e.message || 'Could not load Xero status'); } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  // Handle the redirect back from Xero (?xero=connected|error|expired|invalid|no_org).
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const x = p.get('xero');
    if (!x) return;
    setFlash(x);
    p.delete('xero');
    const q = p.toString();
    window.history.replaceState({}, '', window.location.pathname + (q ? '?' + q : '') + window.location.hash);
    load();
  }, [load]);

  const connect = async () => {
    if (!locId) return;
    setBusy(true); setErr('');
    try {
      const { url } = await xeroOAuthStart(locId, window.location.href);
      if (url) window.location.href = url;        // full-page redirect to Xero consent
      else { setErr('Could not start the Xero connection.'); setBusy(false); }
    } catch (e) { setErr(e.message || 'Could not start the Xero connection.'); setBusy(false); }
  };

  const disconnect = async () => {
    if (!locId || !window.confirm('Disconnect this venue from Xero? You can reconnect any time.')) return;
    setBusy(true); setErr('');
    try { await xeroDisconnect(locId); await load(); } catch (e) { setErr(e.message || 'Disconnect failed'); } finally { setBusy(false); }
  };

  if (loading) return <div style={S.empty}>Loading…</div>;
  if (!locId) return <div style={S.empty}>Pick a location to connect Xero.</div>;

  const connected = !!status?.connected;
  const configured = status?.configured !== false;

  return (
    <div>
      <h1 style={S.h1}>Xero (accounting)</h1>
      <div style={S.sub}>
        Connect this venue to its own Xero organisation so your books stay up to date automatically —
        daily sales &amp; VAT, supplier bills/expenses, and payment data for bank reconciliation.
      </div>

      {flash === 'connected' && <div style={S.banner(true)}>✓ Connected to Xero.</div>}
      {flash && flash !== 'connected' && <div style={S.banner(false)}>Xero connection didn’t complete ({flash}). Please try again.</div>}
      {err && <div style={S.banner(false)}>{err}</div>}

      {!configured ? (
        <div style={S.card}>
          <div style={S.pill('rgba(200,150,40,.16)', '#c89628')}>● Not set up yet</div>
          <div style={{ ...S.note, marginTop: 12 }}>
            The Xero app hasn’t been configured on the server yet (missing keys). Once the
            <b> Client ID</b> and <b>Secret</b> are in place, a <b>Connect Xero</b> button will appear here.
          </div>
        </div>
      ) : connected ? (
        <div style={S.card}>
          <div style={S.pill('rgba(46,143,78,.16)', '#2f8f4e')}>● Connected</div>
          <div style={{ marginTop: 12, fontSize: 15, fontWeight: 800, color: 'var(--t1)' }}>{status.tenant_name || 'Xero organisation'}</div>
          <div style={{ fontSize: 12, color: 'var(--t4)', marginTop: 2 }}>Linked {status.connected_at ? new Date(status.connected_at).toLocaleDateString() : ''}</div>
          <div style={{ display: 'flex', gap: 10, marginTop: 16, flexWrap: 'wrap' }}>
            <a href={status.manager_url || 'https://go.xero.com'} target="_blank" rel="noreferrer" style={{ ...S.ghost, textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}>Open in Xero ↗</a>
            <button style={S.ghost} onClick={disconnect} disabled={busy}>Disconnect</button>
          </div>
          <div style={{ ...S.note, marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--bdr)' }}>
            <b>Next:</b> pushing daily sales &amp; VAT is coming in the next update — you’ll get a “Sync today’s sales” button and a nightly auto-post option here.
          </div>
        </div>
      ) : (
        <div style={S.card}>
          <div style={S.pill('rgba(120,120,120,.16)', 'var(--t2)')}>● Not connected</div>
          <div style={{ ...S.note, marginTop: 12, marginBottom: 16 }}>
            Click below and sign in to Xero, then choose the organisation for this venue. You’ll be brought straight back here.
          </div>
          <button style={S.btn} onClick={connect} disabled={busy}>{busy ? 'Opening Xero…' : 'Connect Xero'}</button>
        </div>
      )}

      <div style={{ ...S.note, maxWidth: 620, marginTop: 6 }}>
        Your Xero login and tokens are stored securely on the server and never shown here. Disconnecting removes them and revokes access in Xero.
      </div>
    </div>
  );
}
