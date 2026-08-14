// src/backoffice/sections/AdyenTerminals.jsx
//
// "💳 Adyen card terminals" — the Lightspeed-style register-on-the-location
// flow (Peter, 14 Aug). AMS1-class terminals run Adyen's own software, so
// there is no claim code: the panel lists the fleet Adyen says belongs to the
// merchant, and REGISTER = one tap that boards the terminal onto this venue's
// store and links it to a till-ready terminal_devices row.
//
// Self-gating sibling of PaxTerminals inside CardReaders (renders null until
// the adyen-terminal-admin 'status' probe says this venue is Adyen-relevant).
// All writes go through the edge fn (service-role); the ONLY client-side write
// is till binding via the existing set_terminal_settings RPC — the same
// whole-settings write PaxTerminals uses, so the two panels can never drift.

import { useEffect, useState, useCallback } from 'react';
import { supabase, getActiveLocationSync } from '../../lib/supabase';

const FN_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/adyen-terminal-admin`;

const S = {
  card: { background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 14, padding: 20, marginBottom: 18 },
  h2: { margin: 0, fontSize: 16, fontWeight: 800, letterSpacing: '-0.01em' },
  desc: { fontSize: 12, color: 'var(--t3)', margin: '6px 0 0', lineHeight: 1.5 },
  label: { fontSize: 10, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.07em' },
  input: { boxSizing: 'border-box', height: 34, padding: '0 10px', borderRadius: 8, border: '1px solid var(--bdr2)', background: 'var(--bg2)', color: 'var(--t1)', fontSize: 13, fontFamily: 'inherit' },
  btn: { boxSizing: 'border-box', minHeight: 34, padding: '7px 14px', borderRadius: 8, border: '1px solid var(--bdr2)', background: 'var(--bg2)', color: 'var(--t1)', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' },
  btnPrim: { background: 'var(--acc)', borderColor: 'var(--acc)', color: 'var(--acc-t, #fff)' },
  btnDan: { color: 'var(--red)', borderColor: 'var(--red-b, var(--red))', background: 'transparent' },
  err: { marginTop: 10, padding: '8px 12px', borderRadius: 8, background: 'var(--red-d, rgba(255,90,74,.1))', color: 'var(--red)', fontSize: 12, lineHeight: 1.5 },
  ok: { marginTop: 10, padding: '8px 12px', borderRadius: 8, background: 'var(--grn-d, rgba(21,194,106,.1))', color: 'var(--grn)', fontSize: 12 },
  mono: { fontFamily: 'var(--font-mono, ui-monospace, monospace)' },
  row: { display: 'grid', gridTemplateColumns: '1.4fr 1fr 1fr auto', gap: 10, alignItems: 'center', padding: '10px 0', borderTop: '1px solid var(--bdr)' },
  pill: { fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 999, display: 'inline-block' },
};

const onlineDot = (iso) => {
  const on = iso && Date.now() - new Date(iso).getTime() < 5 * 60_000;
  return <span title={on ? 'online' : 'not seen recently'} style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 999, background: on ? 'var(--grn)' : 'var(--t4)', marginRight: 7 }} />;
};

async function callAdmin(action, payload = {}) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('Not signed in');
  const locId = getActiveLocationSync();
  if (!locId) throw new Error('No location');
  const res = await fetch(FN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
    body: JSON.stringify({ action, ops_location_id: locId, ...payload }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

export default function AdyenTerminals() {
  const [status, setStatus] = useState(null);      // 'status' action result
  const [fleet, setFleet] = useState(null);        // { store, inventory }
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [notice, setNotice] = useState('');
  const [posDevices, setPosDevices] = useState([]);
  const [bindFor, setBindFor] = useState(null);    // terminal_device id being re-bound
  const [bindTo, setBindTo] = useState('');

  const load = useCallback(async () => {
    try {
      const st = await callAdmin('status');
      setStatus(st);
      if (st.storeId) {
        const fl = await callAdmin('list');
        if (fl.ok) setFleet(fl);
        else if (fl.error && fl.error !== 'no_store') setErr(fl.error === 'scope_missing' ? st.scopeError || 'API key missing Management role' : fl.error);
      }
      const locId = getActiveLocationSync();
      const { data: devs } = await supabase.from('devices')
        .select('id, name, type').eq('location_id', locId).in('type', ['pos', 'kiosk']);
      setPosDevices(devs || []);
    } catch (e) {
      // Panel self-hides on hard failures (venue not provisioned etc.)
      console.warn('[AdyenTerminals]', e?.message || e);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  if (!status?.ok || !status.merchant) return null;   // self-gating sibling

  const run = async (label, action, payload) => {
    setBusy(label); setErr(''); setNotice('');
    try {
      const r = await callAdmin(action, payload);
      if (r.ok === false) throw new Error(r.error === 'scope_missing' ? (status.scopeError || 'API key missing Management role') : (r.error || 'failed'));
      setNotice(action === 'ensure_store' ? `Store created (${r.storeId})` : action === 'assign' ? 'Terminal registered to this venue' : 'Done');
      await load();
    } catch (e) { setErr(e?.message || String(e)); }
    setBusy('');
  };

  const saveBinding = async (link) => {
    setBusy(`bind-${link.id}`); setErr(''); setNotice('');
    try {
      // Whole-settings write — same contract as PaxTerminals: always the full
      // set, pass everything else through unchanged.
      const { data, error } = await supabase.rpc('set_terminal_settings', {
        p_terminal_id: link.id,
        p_tip_config: link.tip_config ?? null,
        p_bound_pos_device_id: bindTo || null,
        p_modes: link.modes ?? null,
        p_label: link.label ?? null,
        p_idle_screen: link.idle_screen ?? null,
      });
      if (error || !data?.ok) throw new Error(error?.message || 'binding save failed');
      setNotice('Till assignment saved');
      setBindFor(null);
      await load();
    } catch (e) { setErr(e?.message || String(e)); }
    setBusy('');
  };

  const tillName = (id) => posDevices.find((d) => d.id === id)?.name || (id ? 'unknown till' : 'any till (unassigned)');

  return (
    <div style={S.card}>
      <h2 style={S.h2}>💳 Adyen card terminals</h2>
      <p style={S.desc}>
        Register a reader to this venue and it is paired: it appears here the moment Adyen sees it,
        one tap boards it onto <b>{status.venue}</b>'s store, and the till drives it from then on.
        Readers run Adyen's own software — there is no code to type.
      </p>

      {!status.scopeOk && <div style={S.err}>{status.scopeError}</div>}

      {/* ── no store yet: the one-time venue setup ── */}
      {status.scopeOk && !status.storeId && (
        <div style={{ marginTop: 14, padding: 14, borderRadius: 10, background: 'var(--bg2)', border: '1px solid var(--bdr)' }}>
          <div style={{ fontSize: 13, fontWeight: 700 }}>One-time setup — create this venue's store at Adyen</div>
          <div style={{ ...S.desc, marginTop: 4 }}>
            Adyen routes terminals and payments through a store per physical venue. This creates
            "{status.venue}" as a store under your merchant account ({status.merchant}) and maps it here.
          </div>
          <button style={{ ...S.btn, ...S.btnPrim, marginTop: 10 }} disabled={!!busy}
            onClick={() => run('store', 'ensure_store', {})}>
            {busy === 'store' ? 'Creating…' : `Create store for ${status.venue}`}
          </button>
        </div>
      )}

      {/* ── fleet ── */}
      {fleet && (
        <>
          <div style={{ ...S.label, marginTop: 18 }}>Registered to this venue</div>
          {fleet.store.length === 0 && <div style={{ ...S.desc, marginTop: 6 }}>None yet — register one from the list below.</div>}
          {fleet.store.map((t) => (
            <div key={t.id}>
              <div style={S.row}>
                <div>
                  {onlineDot(t.lastActivityAt)}
                  <span style={{ fontSize: 13.5, fontWeight: 800 }}>{t.link?.label || t.id}</span>
                  <div style={{ ...S.desc, margin: '2px 0 0' }}><span style={S.mono}>{t.id}</span>{t.firmwareVersion ? ` · fw ${t.firmwareVersion}` : ''}</div>
                </div>
                <div style={{ fontSize: 12, color: 'var(--t2)' }}>{t.model || 'AMS1'}</div>
                <div style={{ fontSize: 12, color: 'var(--t2)' }}>
                  {t.link
                    ? <>till: <b>{tillName(t.link.bound_pos_device_id)}</b></>
                    : <span style={{ color: 'var(--orn)' }}>boarded, not linked</span>}
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  {t.link ? (
                    <>
                      <button style={S.btn} disabled={!!busy}
                        onClick={() => { setBindFor(bindFor === t.link.id ? null : t.link.id); setBindTo(t.link.bound_pos_device_id || ''); }}>
                        Assign till
                      </button>
                      <button style={{ ...S.btn, ...S.btnDan }} disabled={!!busy}
                        onClick={() => { if (window.confirm(`Unlink ${t.link.label || t.id}? The reader stays boarded at Adyen and can be re-registered any time.`)) run(`unlink-${t.id}`, 'unlink', { terminal_device_id: t.link.id }); }}>
                        Unlink
                      </button>
                    </>
                  ) : (
                    <button style={{ ...S.btn, ...S.btnPrim }} disabled={!!busy}
                      onClick={() => run(`link-${t.id}`, 'assign', { terminal_id: t.id, label: t.id })}>
                      {busy === `link-${t.id}` ? 'Linking…' : 'Link to this venue'}
                    </button>
                  )}
                </div>
              </div>
              {t.link && bindFor === t.link.id && (
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '4px 0 12px', borderTop: '1px dashed var(--bdr)' }}>
                  <span style={S.label}>Send payments from</span>
                  <select style={{ ...S.input, minWidth: 200 }} value={bindTo} onChange={(e) => setBindTo(e.target.value)}>
                    <option value="">Any till (unassigned)</option>
                    {posDevices.map((d) => <option key={d.id} value={d.id}>{d.name || d.id} ({d.type})</option>)}
                  </select>
                  <button style={{ ...S.btn, ...S.btnPrim }} disabled={busy === `bind-${t.link.id}`}
                    onClick={() => saveBinding(t.link)}>
                    {busy === `bind-${t.link.id}` ? 'Saving…' : 'Save'}
                  </button>
                </div>
              )}
            </div>
          ))}

          <div style={{ ...S.label, marginTop: 18 }}>In your Adyen inventory</div>
          {fleet.inventory.length === 0 && (
            <div style={{ ...S.desc, marginTop: 6 }}>
              Nothing waiting. New readers appear here once Adyen assigns them to your merchant account
              — if a reader you have is not listed, it is still at company inventory level in the
              Customer Area, or boarded to a different merchant.
            </div>
          )}
          {fleet.inventory.map((t) => (
            <div key={t.id} style={S.row}>
              <div>
                {onlineDot(t.lastActivityAt)}
                <span style={{ fontSize: 13.5, fontWeight: 800, ...S.mono }}>{t.id}</span>
              </div>
              <div style={{ fontSize: 12, color: 'var(--t2)' }}>{t.model || 'AMS1'}</div>
              <div style={{ fontSize: 12, color: 'var(--t3)' }}>unregistered</div>
              <button style={{ ...S.btn, ...S.btnPrim }} disabled={!!busy}
                onClick={() => run(`assign-${t.id}`, 'assign', { terminal_id: t.id, label: t.id })}>
                {busy === `assign-${t.id}` ? 'Registering…' : 'Register to this venue'}
              </button>
            </div>
          ))}

          <button style={{ ...S.btn, marginTop: 14 }} disabled={!!busy} onClick={() => { setErr(''); setNotice(''); load(); }}>Refresh</button>
        </>
      )}

      {err && <div style={S.err}>{err}</div>}
      {notice && <div style={S.ok}>{notice}</div>}
    </div>
  );
}
