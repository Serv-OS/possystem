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
  const [bindFor, setBindFor] = useState(null);    // terminal_device id with settings open
  const [bindTo, setBindTo] = useState('');
  const [serial, setSerial] = useState('');
  // v5.6.81 — when set, a register/assign puts the POIID on THIS already-paired
  // app-terminal row (the S1F2L running MPOS) instead of minting a rival record.
  const [adoptId, setAdoptId] = useState('');
  const [tipOn, setTipOn] = useState(true);
  const [tipPcts, setTipPcts] = useState('5, 10, 15');
  const [tipCustom, setTipCustom] = useState(true);
  const [modeTable, setModeTable] = useState(true);
  const [modePos, setModePos] = useState(true);
  const [standalone, setStandalone] = useState(false);
  const [standaloneWas, setStandaloneWas] = useState(false);

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

  // v5.6.85 — "Release stuck payment", the twin of the one in the ServOS-app
  // panel. It has to exist HERE too: a cloud reader (AMS1) never appears in that
  // panel at all, and v5.6.84's last_seen_at filter also hides an S1F2L that has
  // not yet run our app — which is exactly when a dispatch can wedge. Without
  // this the only route out of "that card machine is already taking a payment"
  // was editing the database by hand (live 19 Aug: a £2.85 charging_unsent job
  // sat past its lease with no nexo_service_id, so it had provably never
  // reached the reader, and there was no button left to clear it).
  // v5.6.91 — the screensaver-by-push experiment (Peter: "is it possible to
  // force a screensaver etc from our software to the device?"). test_image
  // pushes the ServOS logo as a MessageRef/Image display with no timeout — docs
  // say it HOLDS until the next request, which would make idle branding on
  // Adyen-software readers a solved problem. test_idle hands the screen back.
  // Unverified on this fleet until these buttons are pressed; the fn returns the
  // raw reader response either way.
  const brandTest = async (t, mode) => {
    setBusy(`${mode}-${t.id}`);
    setErr(''); setNotice('');
    try {
      const r = await callAdmin(mode, { terminal_id: t.id });
      if (r?.ok) {
        setNotice(mode === 'test_image'
          ? `Image pushed to ${t.link?.label || t.id} (${Math.round((r.imageBytes || 0) / 1024)}KB). Look at the reader — if the logo is up and stays up, branding works. "Back to idle" hands the screen back.`
          : `${t.link?.label || t.id} sent back to its standby screen.`);
      } else {
        setErr(`${mode} failed (${r?.status ?? '?'}): ${JSON.stringify(r?.response ?? r?.error ?? r).slice(0, 300)}`);
      }
    } catch (e) {
      setErr(`${mode} failed: ${e.message}`);
    }
    setBusy('');
  };

  const release = async (t) => {
    const opsId = t?.link?.id;
    if (!opsId) return;
    if (!window.confirm(
      `Release "${t.link.label || t.id}"?\n\n`
      + 'Use this if the terminal says a payment is already in progress but nothing is happening.\n\n'
      + 'If a payment could not be confirmed, releasing it means you are satisfied the customer was NOT charged. '
      + 'Check your card statement first if you are unsure. This is recorded against your name.',
    )) return;
    setBusy(`release-${t.id}`);
    const { data, error } = await supabase.rpc('release_terminal_jobs', { p_terminal_id: opsId, p_note: null });
    setBusy('');
    if (error) { setErr(`Could not release: ${error.message}`); return; }
    const n = (data?.expired || 0) + (data?.released || 0);
    setNotice(n ? `Released ${n} stuck payment${n === 1 ? '' : 's'}. The terminal can take payments again.`
                : 'Nothing was stuck on this terminal.');
    await load();
  };

  const run = async (label, action, payload) => {
    setBusy(label); setErr(''); setNotice('');
    try {
      // An app terminal picked above adopts the POIID onto its OWN record.
      const body = action === 'assign' && adoptId ? { ...payload, terminal_device_id: adoptId } : payload;
      const r = await callAdmin(action, body);
      if (r.ok === false) throw new Error(r.error === 'scope_missing' ? (status.scopeError || 'API key missing Management role') : (r.error || 'failed'));
      setNotice(
        action === 'ensure_store' ? `Store created (${r.storeId})`
          : action === 'assign' ? (r.adopted ? 'Reader linked to the ServOS terminal — it can now take cards on its own screen' : 'Terminal registered to this venue')
            : 'Done',
      );
      if (action === 'assign' && r.adopted) setAdoptId('');
      await load();
    } catch (e) { setErr(e?.message || String(e)); }
    setBusy('');
  };

  const saveBinding = async (link) => {
    setBusy(`bind-${link.id}`); setErr(''); setNotice('');
    try {
      const percentages = tipPcts.split(/[\s,]+/).map(Number).filter((n) => Number.isFinite(n) && n > 0 && n <= 100).slice(0, 4);
      const tipConfig = { enabled: tipOn, percentages: percentages.length ? percentages : [5, 10, 15], allowCustom: tipCustom };
      // Whole-settings write — same contract as PaxTerminals: always the full
      // set, pass everything not edited here through unchanged.
      const { data, error } = await supabase.rpc('set_terminal_settings', {
        p_terminal_id: link.id,
        p_tip_config: tipConfig,
        p_bound_pos_device_id: bindTo || null,
        p_modes: { ...(link.modes || {}), table_pay: modeTable, pos_dispatch: modePos },
        p_label: link.label ?? null,
        p_idle_screen: link.idle_screen ?? null,
      });
      if (error || !data?.ok) throw new Error(error?.message || 'settings save failed');
      // Manual (standalone) mode lives at Adyen, per terminal — push on change.
      if (standalone !== standaloneWas) {
        const st = await callAdmin('standalone_set', { terminal_id: link.adyen_terminal_id, enabled: standalone });
        if (st.ok === false) throw new Error(`Saved here, but manual-payments mode did not sync: ${st.error}`);
      }
      // Push the tip presets onto the reader's own gratuity screen at Adyen.
      if (tipOn) {
        const g = await callAdmin('sync_gratuities', { percentages: tipConfig.percentages, allow_custom: tipCustom });
        if (g.ok === false) throw new Error(`Saved here, but the reader's tip presets did not sync: ${g.error}`);
      }
      setNotice('Reader settings saved' + (tipOn ? ' — tip presets synced to the reader (it picks them up within a minute)' : ''));
      setBindFor(null);
      await load();
    } catch (e) { setErr(e?.message || String(e)); }
    setBusy('');
  };

  const tillName = (id) => posDevices.find((d) => d.id === id)?.name || (id ? 'unknown till' : 'any till (unassigned)');

  // Type the serial off the box → find it anywhere in Adyen (company inventory
  // included) → register straight to this venue. The whole onboarding motion.
  const registerBySerial = async () => {
    setBusy('serial'); setErr(''); setNotice('');
    try {
      const found = await callAdmin('find_by_serial', { serial });
      if (found.ok === false) throw new Error(found.error === 'scope_missing' ? (status.scopeError || 'API key missing Management role') : (found.error || 'search failed'));
      const m = found.matches || [];
      if (m.length === 0) throw new Error('No reader with that serial is visible to your Adyen account yet. Check the number, and make sure the reader has been switched on and connected to WiFi at least once.');
      if (m.length > 1) throw new Error(`That serial matches ${m.length} readers — type more of the number.`);
      if (m[0].onStore) { setNotice(`${m[0].id} is already registered to this venue.`); setSerial(''); await load(); setBusy(''); return; }
      const r = await callAdmin('assign', {
        terminal_id: m[0].id, label: m[0].id,
        ...(adoptId ? { terminal_device_id: adoptId } : {}),
      });
      if (r.ok === false) throw new Error(r.error || 'register failed');
      setNotice(r.adopted
        ? `${m[0].id} linked to the ServOS terminal — it can now take cards on its own screen.`
        : `${m[0].id} registered — it syncs with Adyen for about a minute, then it is ready to assign to a till.`);
      setSerial('');
      if (r.adopted) setAdoptId('');
      await load();
    } catch (e) { setErr(e?.message || String(e)); }
    setBusy('');
  };

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

      {/* ── register by serial — the onboarding motion ── */}
      {status.scopeOk && status.storeId && (
        <div style={{ marginTop: 14, padding: 14, borderRadius: 10, background: 'var(--bg2)', border: '1px solid var(--bdr)' }}>
          <div style={{ fontSize: 13, fontWeight: 700 }}>Register a new reader</div>
          <div style={{ ...S.desc, marginTop: 4 }}>
            Plug the reader in, connect it to WiFi, then type the serial number from the label on
            the reader (or its box). It registers to this venue in one step.
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
            <input style={{ ...S.input, ...S.mono, flex: '1 1 220px', minWidth: 0 }} value={serial}
              onChange={(e) => setSerial(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && serial.trim()) registerBySerial(); }}
              placeholder="Serial number, e.g. 000168254080216" />
            <button style={{ ...S.btn, ...S.btnPrim }} disabled={!!busy || !serial.trim()} onClick={registerBySerial}>
              {busy === 'serial' ? 'Registering…' : 'Register'}
            </button>
          </div>
        </div>
      )}

      {/* ── app terminals waiting for a POIID (v5.6.81) ── */}
      {fleet?.appTerminals?.length > 0 && (
        <div style={{ marginTop: 14, padding: 14, borderRadius: 10, background: 'var(--bg2)', border: '1px solid var(--bdr)' }}>
          <div style={{ fontSize: 13, fontWeight: 700 }}>Terminals running the ServOS app</div>
          <div style={{ ...S.desc, marginTop: 4 }}>
            These are paired to this venue and take orders, but they have no Adyen reader linked yet,
            so they cannot take a card. Pick one below when you register the matching reader and the
            link lands on the terminal itself — not on a second, separate record.
          </div>
          <div style={{ marginTop: 10 }}>
            {fleet.appTerminals.map((a) => (
              <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0' }}>
                <input
                  type="radio" name="adyen-app-terminal"
                  checked={adoptId === a.id}
                  onChange={() => setAdoptId(adoptId === a.id ? '' : a.id)}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 700 }}>{a.label || 'Card terminal'}</div>
                  <div style={{ ...S.desc, margin: 0 }}>
                    <span style={S.mono}>{a.serial_number}</span>
                    {a.app_version ? ` · ${a.app_version}` : ''}
                  </div>
                </div>
                {onlineDot(a.last_seen_at)}
              </div>
            ))}
          </div>
          <div style={{ ...S.desc, marginTop: 6 }}>
            {adoptId
              ? 'Selected. Now register that terminal\'s reader below and the POIID goes onto this record.'
              : 'Nothing selected — registering a reader will create a separate record instead.'}
          </div>
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
                        onClick={() => {
                          if (bindFor === t.link.id) { setBindFor(null); return; }
                          setBindFor(t.link.id);
                          setBindTo(t.link.bound_pos_device_id || '');
                          const tc = t.link.tip_config || {};
                          setTipOn(tc.enabled !== false);
                          setTipPcts((Array.isArray(tc.percentages) && tc.percentages.length ? tc.percentages : [5, 10, 15]).join(', '));
                          setTipCustom(tc.allowCustom !== false);
                          const m = t.link.modes || {};
                          setModeTable(m.table_pay !== false);
                          setModePos(m.pos_dispatch !== false);
                          setStandalone(false); setStandaloneWas(false);
                          callAdmin('standalone_get', { terminal_id: t.id })
                            .then((r) => { if (r.ok) { setStandalone(!!r.enabled); setStandaloneWas(!!r.enabled); } })
                            .catch(() => {});
                        }}>
                        Settings
                      </button>
                      <button style={{ ...S.btn }} disabled={!!busy}
                        title="Push the ServOS logo full-screen to test idle branding"
                        onClick={() => brandTest(t, 'test_image')}>
                        {busy === `test_image-${t.id}` ? 'Pushing…' : 'Test branding'}
                      </button>
                      <button style={{ ...S.btn }} disabled={!!busy}
                        title="Return the reader to its own standby screen"
                        onClick={() => brandTest(t, 'test_idle')}>
                        {busy === `test_idle-${t.id}` ? 'Restoring…' : 'Back to idle'}
                      </button>
                      <button style={{ ...S.btn }} disabled={!!busy}
                        title="Use if the terminal says a payment is already in progress but nothing is happening"
                        onClick={() => release(t)}>
                        {busy === `release-${t.id}` ? 'Releasing…' : 'Release stuck payment'}
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
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '10px 0 14px', borderTop: '1px dashed var(--bdr)' }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span style={S.label}>Send payments from</span>
                    <select style={{ ...S.input, minWidth: 200 }} value={bindTo} onChange={(e) => setBindTo(e.target.value)}>
                      <option value="">Any till (unassigned)</option>
                      {posDevices.map((d) => <option key={d.id} value={d.id}>{d.name || d.id} ({d.type})</option>)}
                    </select>
                  </div>
                  <div style={{ display: 'flex', gap: 18, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span style={S.label}>This reader takes</span>
                    <label style={{ fontSize: 12.5, display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
                      <input type="checkbox" checked={modePos} onChange={(e) => setModePos(e.target.checked)} /> Payments sent from the POS
                    </label>
                    <label style={{ fontSize: 12.5, display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
                      <input type="checkbox" checked={modeTable} onChange={(e) => setModeTable(e.target.checked)} /> Table Pay
                    </label>
                    <label style={{ fontSize: 12.5, display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}
                      title="Staff type the amount on the reader itself. Payments book against the venue but do not attach to a POS check — they appear in payment reports.">
                      <input type="checkbox" checked={standalone} onChange={(e) => setStandalone(e.target.checked)} /> Manual payments on the reader
                    </label>
                  </div>
                  <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                    <label style={{ fontSize: 12.5, display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
                      <input type="checkbox" checked={tipOn} onChange={(e) => setTipOn(e.target.checked)} /> <b>Tipping on the reader</b>
                    </label>
                    {tipOn && (
                      <>
                        <span style={S.label}>Suggested %</span>
                        <input style={{ ...S.input, width: 130, ...S.mono }} value={tipPcts} onChange={(e) => setTipPcts(e.target.value)} placeholder="whole numbers, e.g. 5, 10, 15" />
                        <label style={{ fontSize: 12, display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
                          <input type="checkbox" checked={tipCustom} onChange={(e) => setTipCustom(e.target.checked)} /> allow custom amount
                        </label>
                      </>
                    )}
                  </div>
                  <div>
                    <button style={{ ...S.btn, ...S.btnPrim }} disabled={busy === `bind-${t.link.id}`}
                      onClick={() => saveBinding(t.link)}>
                      {busy === `bind-${t.link.id}` ? 'Saving…' : 'Save reader settings'}
                    </button>
                  </div>
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
              <div style={{ fontSize: 12, color: t.link ? 'var(--orn)' : 'var(--t3)' }}>
                {t.link ? 'registering — the reader is syncing with Adyen (about a minute)' : 'unregistered'}
              </div>
              {t.link ? (
                <button style={S.btn} disabled={!!busy} onClick={() => load()}>Check again</button>
              ) : (
                <button style={{ ...S.btn, ...S.btnPrim }} disabled={!!busy}
                  onClick={() => run(`assign-${t.id}`, 'assign', { terminal_id: t.id, label: t.id })}>
                  {busy === `assign-${t.id}` ? 'Registering…' : 'Register to this venue'}
                </button>
              )}
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
