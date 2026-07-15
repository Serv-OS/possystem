// src/backoffice/sections/XeroIntegration.jsx
//
// Back office → Settings → "Xero (accounting)". Connects THIS venue to its own Xero
// organisation (OAuth) so we can push sales, bills/expenses and payment data. Phase 1:
// connect + show the linked org. The tokens live server-side (xero_connections); this
// screen only ever sees the non-secret status.

import { useCallback, useEffect, useState } from 'react';
import { getActiveLocationSync } from '../../lib/supabase';
import { xeroStatus, xeroOAuthStart, xeroDisconnect, xeroSyncSales, xeroOptions, xeroGetMapping, xeroSaveMapping, xeroSetAutoDaily } from '../../lib/xero';

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

const sel = { width: '100%', boxSizing: 'border-box', border: '1px solid var(--bdr2)', borderRadius: 9, padding: '8px 10px', fontSize: 13, fontFamily: 'inherit', color: 'var(--t1)', background: 'var(--bg2)', outline: 'none' };
const fieldRow = { display: 'grid', gridTemplateColumns: '150px 1fr', gap: 12, alignItems: 'center', marginBottom: 10 };
const flabel = { fontSize: 12.5, fontWeight: 700, color: 'var(--t2)' };

// Advanced: map each money flow to a Xero account + the default VAT rate + which clearing
// account each payment method lands in. All optional — sensible defaults apply if left blank.
function MappingCard({ locId }) {
  const [open, setOpen] = useState(false);
  const [opts, setOpts] = useState(null);
  const [map, setMap] = useState({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState('');

  const load = async () => {
    setLoading(true); setErr('');
    try {
      const [o, m] = await Promise.all([xeroOptions(locId), xeroGetMapping(locId)]);
      setOpts(o); setMap((m && m.mapping) || {});
    } catch (e) { setErr(e.message || 'Could not load your Xero accounts'); }
    finally { setLoading(false); }
  };
  const toggle = () => { const n = !open; setOpen(n); if (n && !opts && !loading) load(); };
  const set = (patch) => setMap(m => ({ ...m, ...patch }));
  const setPay = (method, acctId) => setMap(m => ({ ...m, paymentMap: { ...(m.paymentMap || {}), [method]: acctId } }));
  const save = async () => {
    setSaving(true); setSaved(false); setErr('');
    try { await xeroSaveMapping(locId, map); setSaved(true); setTimeout(() => setSaved(false), 2200); }
    catch (e) { setErr(e.message || 'Save failed'); } finally { setSaving(false); }
  };

  const accounts = opts?.accounts || [];
  const banks = accounts.filter(a => a.bank);
  const byType = (types) => accounts.filter(a => !a.bank && (!types || types.includes(String(a.type).toUpperCase())));
  const AcctSelect = ({ value, onChange, types }) => (
    <select value={value || ''} onChange={e => onChange(e.target.value)} style={sel}>
      <option value="">Default (Sales)</option>
      {byType(types).map(a => <option key={a.id} value={a.code || a.id}>{a.code ? `${a.code} · ` : ''}{a.name}</option>)}
    </select>
  );

  return (
    <div style={{ ...S.card, marginTop: 0 }}>
      <button onClick={toggle} style={{ width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontFamily: 'inherit' }}>
        <span style={{ fontSize: 14, fontWeight: 800, color: 'var(--t1)' }}>Account mapping <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--t4)' }}>· optional</span></span>
        <span style={{ color: 'var(--t3)', fontSize: 13 }}>{open ? 'Hide ▲' : 'Set up ▼'}</span>
      </button>
      {open && (
        <div style={{ marginTop: 14 }}>
          <div style={S.note}>Choose exactly where each part of a sale posts in Xero. Leave anything blank to use the default. Tips are usually a <b>liability</b> (money owed to staff), not income.</div>
          {loading && <div style={{ ...S.note, marginTop: 12 }}>Loading your Xero accounts…</div>}
          {err && <div style={{ ...S.banner(false), marginTop: 12 }}>{err}</div>}
          {opts && !loading && (
            <div style={{ marginTop: 14 }}>
              <div style={fieldRow}><span style={flabel}>Sales revenue</span><AcctSelect value={map.revenueAccount} onChange={v => set({ revenueAccount: v })} types={['REVENUE', 'SALES']} /></div>
              <div style={fieldRow}><span style={flabel}>Tips / gratuities</span><AcctSelect value={map.tipsAccount} onChange={v => set({ tipsAccount: v })} types={['CURRLIAB', 'LIABILITY', 'REVENUE']} /></div>
              <div style={fieldRow}><span style={flabel}>Service charge</span><AcctSelect value={map.serviceAccount} onChange={v => set({ serviceAccount: v })} types={['REVENUE', 'CURRLIAB', 'LIABILITY']} /></div>
              <div style={fieldRow}><span style={flabel}>VAT / tax rate</span>
                <select value={map.taxDefault || ''} onChange={e => set({ taxDefault: e.target.value })} style={sel}>
                  <option value="">Auto (from Xero)</option>
                  {(opts.taxRates || []).map(t => <option key={t.taxType} value={t.taxType}>{t.name} ({t.rate}%)</option>)}
                </select>
              </div>

              <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--t1)', margin: '18px 0 4px' }}>Payment method → bank account</div>
              <div style={S.note}>Each method lands in a Xero “clearing” bank account so its payout reconciles there.</div>
              <div style={{ marginTop: 10 }}>
                {(opts.paymentMethods || []).length === 0 && <div style={{ fontSize: 12, color: 'var(--t4)' }}>No sales yet to map.</div>}
                {(opts.paymentMethods || []).map(m => (
                  <div key={m} style={fieldRow}>
                    <span style={{ ...flabel, textTransform: 'capitalize' }}>{m}</span>
                    <select value={(map.paymentMap || {})[m] || ''} onChange={e => setPay(m, e.target.value)} style={sel}>
                      <option value="">Auto ({/cash/i.test(m) ? 'Cash' : 'Card'} Clearing)</option>
                      {banks.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                    </select>
                  </div>
                ))}
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 16 }}>
                <button style={S.btn} onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save mapping'}</button>
                {saved && <span style={{ color: '#2f8f4e', fontWeight: 700, fontSize: 13 }}>✓ Saved</span>}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function XeroIntegration() {
  const [locId, setLocId] = useState(null);
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [flash, setFlash] = useState('');
  const today = new Date().toISOString().slice(0, 10);
  const [syncDate, setSyncDate] = useState(today);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState(null);
  const [syncErr, setSyncErr] = useState('');
  const [autoDaily, setAutoDaily] = useState(false);
  const [autoBusy, setAutoBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setErr('');
    const id = getActiveLocationSync(); setLocId(id);
    if (!id) { setLoading(false); return; }
    try {
      setStatus(await xeroStatus(id));
      try { const m = await xeroGetMapping(id); setAutoDaily(!!m.autoDaily); } catch { /* non-fatal */ }
    } catch (e) { setErr(e.message || 'Could not load Xero status'); } finally { setLoading(false); }
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

  const syncSales = async () => {
    if (!locId) return;
    setSyncing(true); setSyncErr(''); setSyncResult(null);
    try { setSyncResult(await xeroSyncSales(locId, syncDate)); }
    catch (e) { setSyncErr(e.message || 'Sync failed'); }
    finally { setSyncing(false); }
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
        <>
        <div style={S.card}>
          <div style={S.pill('rgba(46,143,78,.16)', '#2f8f4e')}>● Connected</div>
          <div style={{ marginTop: 12, fontSize: 15, fontWeight: 800, color: 'var(--t1)' }}>{status.tenant_name || 'Xero organisation'}</div>
          <div style={{ fontSize: 12, color: 'var(--t4)', marginTop: 2 }}>Linked {status.connected_at ? new Date(status.connected_at).toLocaleDateString() : ''}</div>
          <div style={{ display: 'flex', gap: 10, marginTop: 16, flexWrap: 'wrap' }}>
            <a href={status.manager_url || 'https://go.xero.com'} target="_blank" rel="noreferrer" style={{ ...S.ghost, textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}>Open in Xero ↗</a>
            <button style={S.ghost} onClick={disconnect} disabled={busy}>Disconnect</button>
          </div>
          <div style={{ marginTop: 18, paddingTop: 16, borderTop: '1px solid var(--bdr)' }}>
            <div style={{ fontSize: 14, fontWeight: 800, color: 'var(--t1)', marginBottom: 6 }}>Push sales to Xero</div>
            <div style={S.note}>Posts that day’s takings into Xero as “received money” in a clearing account (card and cash kept separate). When your card <b>payout</b> lands in the bank, reconcile it against the clearing account — that’s how sales connect to the cash in the bank.</div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 14, flexWrap: 'wrap' }}>
              <input type="date" value={syncDate} max={today} onChange={e => setSyncDate(e.target.value)}
                style={{ border: '1px solid var(--bdr2)', borderRadius: 9, padding: '9px 11px', fontSize: 13, fontFamily: 'inherit', color: 'var(--t1)', background: 'var(--bg2)' }} />
              <button style={S.btn} onClick={syncSales} disabled={syncing}>{syncing ? 'Pushing…' : 'Push sales to Xero'}</button>
            </div>
            {syncErr && <div style={S.banner(false)}>{syncErr}</div>}
            {syncResult?.ok && syncResult.already && <div style={{ ...S.banner(true), marginTop: 12 }}>✓ Already pushed for {syncResult.date}.</div>}
            {syncResult?.ok && !syncResult.already && (
              <div style={{ marginTop: 12 }}>
                <div style={{ ...S.banner(true), marginBottom: 8 }}>✓ Pushed {syncResult.date} to Xero{syncResult.sample ? ' (test figures — no real sales that day)' : ''}.</div>
                {(syncResult.lines || []).map((l, i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13, padding: '7px 10px', border: '1px solid var(--bdr2)', borderRadius: 8, marginBottom: 6, background: 'var(--bg2)' }}>
                    <span style={{ color: 'var(--t1)', fontWeight: 700, textTransform: 'capitalize' }}>{l.method} · £{Number(l.gross).toFixed(2)}</span>
                    {l.link && <a href={l.link} target="_blank" rel="noreferrer" style={{ color: 'var(--acc)', fontWeight: 700, textDecoration: 'none', fontSize: 12 }}>View in Xero ↗</a>}
                  </div>
                ))}
              </div>
            )}
            <div style={{ ...S.note, marginTop: 10 }}>Safe to click more than once — a day already sent won’t be duplicated.</div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--bdr)' }}>
              <input type="checkbox" checked={autoDaily} disabled={autoBusy}
                onChange={async (e) => {
                  const v = e.target.checked;
                  setAutoDaily(v); setAutoBusy(true);
                  try { await xeroSetAutoDaily(locId, v); } catch { setAutoDaily(!v); } finally { setAutoBusy(false); }
                }}
                style={{ width: 17, height: 17 }} />
              <span style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--t1)' }}>Auto-post each night</span>
              <span style={{ fontSize: 12, color: 'var(--t4)' }}>— yesterday’s takings post automatically every morning. Days with no sales are skipped.</span>
            </label>
          </div>
        </div>
        <MappingCard locId={locId} />
        </>
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
