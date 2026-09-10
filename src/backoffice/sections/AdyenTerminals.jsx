// src/backoffice/sections/AdyenTerminals.jsx
//
// Card readers for an Adyen venue (Back Office, Hardware, Card readers).
// REBUILT 10 Sep 2026 for the venue owner: one list of this venue's readers
// with editable names, Add a reader by serial, tips as one venue level box,
// everything else under Advanced. Registration pushes the store settings
// (events url, Pay at table button, pay at table flag, tips) on its own
// through the fn's sync_store_settings, so there is nothing to click after
// typing the serial.
//
// Self-gating sibling of PaxTerminals inside CardReaders (renders null until
// the adyen-terminal-admin 'status' probe says this venue is Adyen-relevant).
// All Adyen writes go through the edge fn (service-role); the only client
// side write is till binding and the till switch via the existing
// set_terminal_settings RPC (whole-settings write, the PaxTerminals contract).
// The pure helpers (tip presets, the readers view words, the sync state)
// live in src/lib/payments/readerSettings.js, mirrored in the fn.
//
// OWNER RULE (8 Sep 2026): the venue cannot move itself between test and
// live, create its Adyen store or request its card schemes. Those live in the
// ServOS admin portal. The environment is shown here read only, under
// Advanced, with a red banner across the panel while live.
//
// WORDS: body text 15px or more, one primary button per box, ids small and
// monospace with a Copy button, errors as one plain sentence with the raw
// detail behind Show detail. Status words: online, not seen recently, not
// added yet. No dashes as punctuation.

import { useEffect, useState, useCallback } from 'react';
import { supabase, getActiveLocationSync } from '../../lib/supabase';
import {
  DEFAULT_TIP_PRESETS, STATUS_ONLINE, normaliseTipPresets, parseTipPresetText, tillSentence, nextReaderName,
} from '../../lib/payments/readerSettings';

const FN_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/adyen-terminal-admin`;

const S = {
  card: { background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 14, padding: 20, marginBottom: 18, fontSize: 15, lineHeight: 1.5, color: 'var(--t1)' },
  h2: { margin: 0, fontSize: 19, fontWeight: 800, letterSpacing: '-0.01em' },
  h3: { margin: 0, fontSize: 16, fontWeight: 800 },
  p: { fontSize: 15, color: 'var(--t2)', margin: '6px 0 0', lineHeight: 1.5 },
  grey: { fontSize: 15, color: 'var(--t3)' },
  box: { marginTop: 16, padding: 16, borderRadius: 12, background: 'var(--bg2)', border: '1px solid var(--bdr)' },
  input: { boxSizing: 'border-box', height: 40, padding: '0 12px', borderRadius: 8, border: '1px solid var(--bdr2)', background: 'var(--bg)', color: 'var(--t1)', fontSize: 15, fontFamily: 'inherit' },
  select: { boxSizing: 'border-box', height: 40, padding: '0 10px', borderRadius: 8, border: '1px solid var(--bdr2)', background: 'var(--bg)', color: 'var(--t1)', fontSize: 15, fontFamily: 'inherit' },
  btn: { boxSizing: 'border-box', minHeight: 40, padding: '8px 16px', borderRadius: 8, border: '1px solid var(--bdr2)', background: 'var(--bg2)', color: 'var(--t1)', fontSize: 15, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' },
  btnPrim: { background: 'var(--acc)', borderColor: 'var(--acc)', color: 'var(--acc-t, #fff)' },
  btnDan: { color: 'var(--red)', borderColor: 'var(--red-b, var(--red))', background: 'transparent' },
  btnSmall: { minHeight: 32, padding: '4px 10px', fontSize: 14 },
  err: { marginTop: 12, padding: '10px 14px', borderRadius: 8, background: 'var(--red-d, rgba(255,90,74,.1))', color: 'var(--red)', fontSize: 15, lineHeight: 1.5 },
  ok: { marginTop: 12, padding: '10px 14px', borderRadius: 8, background: 'var(--grn-d, rgba(21,194,106,.1))', color: 'var(--grn)', fontSize: 15, lineHeight: 1.5 },
  mono: { fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: 13, color: 'var(--t3)' },
  row: { padding: '14px 0', borderTop: '1px solid var(--bdr)', display: 'flex', flexDirection: 'column', gap: 8 },
  pill: { fontSize: 12, fontWeight: 700, padding: '2px 9px', borderRadius: 999, display: 'inline-block', letterSpacing: '.05em' },
  pillTest: { background: 'var(--bg3, var(--bg2))', color: 'var(--t2)', border: '1px solid var(--bdr2)' },
  pillLive: { background: 'var(--red)', color: '#fff', border: '1px solid var(--red)' },
  liveBanner: { margin: '-20px -20px 16px', padding: '10px 20px', borderRadius: '14px 14px 0 0', background: 'var(--red)', color: '#fff', fontSize: 15, fontWeight: 700, lineHeight: 1.4, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  switchRow: { display: 'flex', alignItems: 'center', gap: 10, fontSize: 15, cursor: 'pointer' },
  linkBtn: { background: 'none', border: 'none', color: 'var(--acc)', cursor: 'pointer', fontSize: 14, fontWeight: 700, padding: 0, fontFamily: 'inherit' },
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
  if (!res.ok) {
    const err = new Error(data?.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

const fmtWhen = (iso) => {
  if (!iso) return 'never';
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleString() : 'never';
};

// One plain sentence, the raw detail behind Show detail.
function Notice({ kind, text, detail, onClose }) {
  const [open, setOpen] = useState(false);
  if (!text) return null;
  return (
    <div style={kind === 'error' ? S.err : S.ok} role={kind === 'error' ? 'alert' : 'status'}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        <div style={{ flex: 1 }}>{text}</div>
        {onClose && <button style={{ ...S.linkBtn, color: 'inherit' }} onClick={onClose}>Close</button>}
      </div>
      {detail && (
        <div style={{ marginTop: 4 }}>
          <button style={{ ...S.linkBtn, color: 'inherit', fontSize: 13 }} onClick={() => setOpen((v) => !v)}>{open ? 'Hide detail' : 'Show detail'}</button>
          {open && <div style={{ ...S.mono, color: 'inherit', marginTop: 4, wordBreak: 'break-word' }}>{detail}</div>}
        </div>
      )}
    </div>
  );
}

function CopyId({ value }) {
  const [done, setDone] = useState(false);
  if (!value) return null;
  return (
    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
      <span style={S.mono}>{value}</span>
      <button style={{ ...S.linkBtn, fontSize: 12 }} onClick={() => {
        try { navigator.clipboard?.writeText(String(value)); } catch { /* no clipboard */ }
        setDone(true); setTimeout(() => setDone(false), 1500);
      }}>{done ? 'Copied' : 'Copy'}</button>
    </span>
  );
}

function Switch({ checked, onChange, label, disabled, title }) {
  return (
    <label style={{ ...S.switchRow, opacity: disabled ? 0.6 : 1 }} title={title}>
      <input type="checkbox" role="switch" checked={!!checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)}
        style={{ width: 20, height: 20, margin: 0 }} />
      <span>{label}</span>
    </label>
  );
}

function StatusDot({ status }) {
  const on = status === STATUS_ONLINE;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, ...S.grey }}>
      <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 999, background: on ? 'var(--grn)' : 'var(--t4)' }} />
      {status}
    </span>
  );
}

export default function AdyenTerminals() {
  const [status, setStatus] = useState(null);      // 'status' action result
  const [statusErr, setStatusErr] = useState('');  // a LIVE venue whose probe failed
  const [envInfo, setEnvInfo] = useState(null);    // 'environment' action result
  const [list, setList] = useState(null);          // 'list' action result: { readers, notAdded, tips, settingsSync, currency }
  const [listErr, setListErr] = useState('');
  const [posDevices, setPosDevices] = useState([]);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState(null);            // { text, detail }
  const [notice, setNotice] = useState(null);      // { text, lines }
  // add a reader
  const [serial, setSerial] = useState('');
  // names
  const [editId, setEditId] = useState(null);
  const [editName, setEditName] = useState('');
  // standalone (Adyen, per reader): poiid -> true | false | undefined (not read yet)
  const [standalone, setStandalone] = useState({});
  // tips (venue level)
  const [tipText, setTipText] = useState(DEFAULT_TIP_PRESETS.join(', '));
  const [tipCustom, setTipCustom] = useState(true);
  const [tipsSeeded, setTipsSeeded] = useState(false);
  // advanced
  const [advOpen, setAdvOpen] = useState(false);
  const [syncOut, setSyncOut] = useState(null);    // last sync_store_settings answer shown on the page
  const [releaseId, setReleaseId] = useState('');
  const [pinInfo, setPinInfo] = useState(null);
  const [pinChoice, setPinChoice] = useState('');
  // tip on printed receipt (United States)
  const [torLoaded, setTorLoaded] = useState(false);
  const [torEnabled, setTorEnabled] = useState(false);
  const [torHours, setTorHours] = useState(24);
  const [torScope, setTorScope] = useState('all_pos');
  const [torMsg, setTorMsg] = useState('');

  // One plain sentence on top, the raw detail behind Show detail. A sentence
  // this page wrote itself (plainError) IS the headline; a server or Adyen
  // message rides as the detail under the generic line.
  const fail = (text, e) => {
    const msg = e?.message || (typeof e === 'string' ? e : '');
    if (e?.plain) { setErr({ text: msg, detail: null }); return; }
    setErr({ text, detail: msg && msg !== text ? msg : null });
  };
  const plainError = (m) => Object.assign(new Error(m), { plain: true });

  const loadList = useCallback(async (st) => {
    if (!st?.storeId) { setList(null); return; }
    try {
      const fl = await callAdmin('list');
      if (fl.ok) { setList(fl); setListErr(''); }
      else setListErr(fl.error === 'scope_missing' ? (st.scopeError || 'The Adyen credential lacks the Management roles.') : (fl.error || 'The readers could not be listed.'));
    } catch (e) { setListErr(e?.message || String(e)); }
  }, []);

  const load = useCallback(async () => {
    let env = null;
    try {
      env = await callAdmin('environment');
      if (env?.ok) setEnvInfo(env);
    } catch (e) { console.warn('[AdyenTerminals] environment', e?.message || e); }
    try {
      const st = await callAdmin('status', { probe: true });
      setStatus(st);
      setStatusErr('');
      await loadList(st);
      const locId = getActiveLocationSync();
      const { data: devs } = await supabase.from('devices')
        .select('id, name, type').eq('location_id', locId).in('type', ['pos', 'kiosk', 'handheld']);
      setPosDevices(devs || []);
      const { data: locRow } = await supabase.from('locations').select('pos_settings').eq('id', locId).maybeSingle();
      const tor = locRow?.pos_settings?.tip_on_receipt;
      setTorEnabled(tor?.enabled === true);
      const h = Number(tor?.capture_hours);
      setTorHours(Number.isFinite(h) ? Math.max(1, Math.min(72, h)) : 24);
      setTorScope(tor?.scope === 'table_checks' ? 'table_checks' : 'all_pos');
      setTorLoaded(true);
    } catch (e) {
      console.warn('[AdyenTerminals]', e?.message || e);
      setStatus(null); setList(null);
      if (env?.ok && env.environment === 'live') setStatusErr(e?.message || String(e));
    }
  }, [loadList]);
  useEffect(() => { load(); }, [load]);

  // Seed the tips box from the venue's saved tips once, then leave what is typed alone.
  useEffect(() => {
    if (!list?.tips || tipsSeeded) return;
    setTipText((list.tips.percentages || DEFAULT_TIP_PRESETS).join(', '));
    setTipCustom(list.tips.allowCustom !== false);
    setTipsSeeded(true);
  }, [list, tipsSeeded]);

  // Read the Adyen standalone flag for each reader once it is listed.
  useEffect(() => {
    const readers = list?.readers || [];
    for (const r of readers) {
      if (standalone[r.poiid] !== undefined) continue;
      setStandalone((m) => ({ ...m, [r.poiid]: null }));   // reading
      callAdmin('standalone_get', { terminal_id: r.poiid })
        .then((a) => setStandalone((m) => ({ ...m, [r.poiid]: a?.ok ? !!a.enabled : false })))
        .catch(() => setStandalone((m) => ({ ...m, [r.poiid]: false })));
    }
  }, [list]);   // eslint-disable-line react-hooks/exhaustive-deps

  // Admin PIN: read when Advanced opens the first time.
  useEffect(() => {
    if (!advOpen || pinInfo || !status?.storeId) return;
    callAdmin('passcodes').then((r) => setPinInfo(r)).catch((e) => setPinInfo({ ok: false, error: e?.message }));
  }, [advOpen, pinInfo, status]);

  const isLive = envInfo?.environment === 'live';
  const isUS = (status?.region || envInfo?.region) === 'US';
  const venueName = status?.venue || 'this venue';
  const readers = list?.readers || [];
  const notAdded = list?.notAdded || [];

  const liveBanner = isLive ? (
    <div style={S.liveBanner} role="alert">
      <span style={{ ...S.pill, background: '#fff', color: 'var(--red)', border: '1px solid #fff' }}>LIVE</span>
      <span>Real money. Every card taken at {venueName} is charged for real.</span>
    </div>
  ) : null;
  const envBadge = envInfo ? (
    <span style={{ ...S.pill, ...(isLive ? S.pillLive : S.pillTest), marginLeft: 10, verticalAlign: 'middle' }}>
      {isLive ? 'LIVE, real money' : 'Test cards'}{envInfo.region ? ` ${envInfo.region}` : ''}
    </span>
  ) : null;

  const ready = !!(status?.ok && status.merchant);
  if (!ready && !(isLive && statusErr)) return null;   // self-gating sibling

  if (!ready) {
    return (
      <div style={S.card}>
        {liveBanner}
        <h2 style={S.h2}>Card readers{envBadge}</h2>
        <Notice kind="error" text="ServOS could not reach Adyen for this venue. Contact ServOS support." detail={statusErr} />
      </div>
    );
  }

  const canAdd = !!(status.scopeOk && status.storeId);
  const addBlocked = !status.scopeOk
    ? 'The Adyen credential lacks the Management roles, so readers cannot be added. Contact ServOS support.'
    : !status.storeId
      ? 'This venue needs its Adyen store first. ServOS sets it up from the admin portal.'
      : '';

  const settingsLines = (settings) => {
    if (!settings) return [];
    return [...(settings.applied || []), ...(settings.errors || [])];
  };

  // ── add a reader ──────────────────────────────────────────────────────────
  const addReader = async (poiid, label) => {
    const r = await callAdmin('assign', { terminal_id: poiid, label });
    if (r.ok === false) throw new Error(r.error === 'scope_missing' ? (status.scopeError || 'The Adyen credential lacks the Management roles.') : (r.error || 'The reader could not be added.'));
    setNotice({
      text: r.adopted
        ? `${r.label || label} is added and linked to the terminal running the ServOS app.`
        : `${r.label || label} is added. It takes payments from the till now.`,
      lines: settingsLines(r.settings),
    });
    if (r.settings) setSyncOut(r.settings);
    await loadList(status);
  };

  const addBySerial = async () => {
    setBusy('serial'); setErr(null); setNotice(null);
    try {
      const found = await callAdmin('find_by_serial', { serial });
      if (found.ok === false) throw new Error(found.error === 'scope_missing' ? (status.scopeError || 'The Adyen credential lacks the Management roles.') : (found.error || 'The search failed.'));
      const m = found.matches || [];
      if (m.length === 0) throw plainError('No reader with that serial is on your Adyen account yet. Check the number, then switch the reader on and connect it to WiFi once.');
      if (m.length > 1) throw plainError(`That serial matches ${m.length} readers. Type the whole number from the label.`);
      const already = readers.find((r) => r.poiid === m[0].id);
      if (already) { setNotice({ text: `${already.label} is already added to this venue.` }); setSerial(''); setBusy(''); return; }
      await addReader(m[0].id, nextReaderName(readers.map((r) => r.label)));
      setSerial('');
    } catch (e) { fail('The reader could not be added.', e); }
    setBusy('');
  };

  const addFromStore = async (t) => {
    setBusy(`add-${t.poiid}`); setErr(null); setNotice(null);
    try { await addReader(t.poiid, nextReaderName(readers.map((r) => r.label))); }
    catch (e) { fail('The reader could not be added.', e); }
    setBusy('');
  };

  // ── names ─────────────────────────────────────────────────────────────────
  const saveName = async (r) => {
    const name = editName.trim();
    if (!name) { setEditId(null); return; }
    setBusy(`name-${r.id}`); setErr(null);
    try {
      const a = await callAdmin('rename', { terminal_device_id: r.id, label: name });
      if (a.ok === false) throw new Error(a.error || 'The name could not be saved.');
      setEditId(null);
      await loadList(status);
    } catch (e) { fail('The name could not be saved.', e); }
    setBusy('');
  };

  // ── till binding and the till switch: whole-settings RPC, passthrough ────
  const writeSettings = async (r, { bound = r.boundPosDeviceId, modes = r.modes } = {}) => {
    const { data, error } = await supabase.rpc('set_terminal_settings', {
      p_terminal_id: r.id,
      p_tip_config: r.tipConfig ?? null,
      p_bound_pos_device_id: bound || null,
      p_modes: modes || {},
      p_label: r.label ?? null,
      p_idle_screen: r.idleScreen ?? null,
    });
    if (error || !data?.ok) throw new Error(error?.message || 'settings save failed');
  };
  const setTill = async (r, deviceId) => {
    setBusy(`till-${r.id}`); setErr(null);
    try { await writeSettings(r, { bound: deviceId || null }); await loadList(status); }
    catch (e) { fail('The till choice could not be saved.', e); }
    setBusy('');
  };
  const setPosDispatch = async (r, on) => {
    setBusy(`pos-${r.id}`); setErr(null);
    try { await writeSettings(r, { modes: { ...(r.modes || {}), pos_dispatch: on } }); await loadList(status); }
    catch (e) { fail('The switch could not be saved.', e); }
    setBusy('');
  };
  const setStandaloneFor = async (r, on) => {
    setBusy(`sa-${r.id}`); setErr(null);
    try {
      const a = await callAdmin('standalone_set', { terminal_id: r.poiid, enabled: on });
      if (a.ok === false) throw new Error(a.error === 'scope_missing' ? (status.scopeError || 'The Adyen credential lacks the Management roles.') : (a.error || 'Adyen refused the change.'));
      setStandalone((m) => ({ ...m, [r.poiid]: on }));
    } catch (e) { fail('The reader setting could not be saved on Adyen.', e); }
    setBusy('');
  };

  // ── remove ────────────────────────────────────────────────────────────────
  const remove = async (r) => {
    if (!window.confirm(`Remove ${r.label} from this venue? The reader stays on your Adyen account and can be added again.`)) return;
    setBusy(`rm-${r.id}`); setErr(null); setNotice(null);
    try {
      const a = await callAdmin('unlink', { terminal_device_id: r.id });
      if (a.ok === false) throw new Error(a.error || 'The reader could not be removed.');
      setNotice({ text: `${r.label} is removed from this venue.` });
      await loadList(status);
    } catch (e) { fail('The reader could not be removed.', e); }
    setBusy('');
  };

  // ── tips (venue level) ────────────────────────────────────────────────────
  const saveTips = async () => {
    setBusy('tips'); setErr(null); setNotice(null);
    try {
      const pcts = normaliseTipPresets(parseTipPresetText(tipText), { allowCustom: tipCustom });
      if (!pcts.length) throw plainError('Type whole percentages, for example 5, 10, 15.');
      const g = await callAdmin('sync_gratuities', { percentages: pcts, allow_custom: tipCustom });
      if (g.ok === false) throw new Error(g.error === 'scope_missing' ? (status.scopeError || 'The Adyen credential lacks the Management roles.') : (g.error || 'Adyen refused the tip settings.'));
      setTipText((g.presets || pcts).join(', '));
      setNotice({ text: 'Tip choices saved. Every reader here picks them up within a minute.' });
      await loadList(status);
    } catch (e) { fail('The tip choices could not be saved.', e); }
    setBusy('');
  };

  // ── advanced ──────────────────────────────────────────────────────────────
  const sendSettings = async () => {
    setBusy('sync'); setErr(null); setNotice(null);
    try {
      const a = await callAdmin('sync_store_settings');
      setSyncOut(a);
      if (a.ok === false && !(a.applied || []).length) throw new Error((a.errors || []).join(' ') || a.error || 'Adyen refused the settings.');
      await loadList(status);
    } catch (e) { fail('The reader settings could not be sent to Adyen.', e); }
    setBusy('');
  };

  const release = async () => {
    const r = readers.find((x) => x.id === releaseId);
    if (!r) return;
    if (!window.confirm(
      `Release ${r.label}?\n\n`
      + 'Use this if the reader says a payment is already in progress but nothing is happening.\n\n'
      + 'If a payment could not be confirmed, releasing it means you are satisfied the customer was NOT charged. '
      + 'Check your card statement first if you are unsure. This is recorded against your name.',
    )) return;
    setBusy('release'); setErr(null); setNotice(null);
    const { data, error } = await supabase.rpc('release_terminal_jobs', { p_terminal_id: r.id, p_note: null });
    setBusy('');
    if (error) { fail('The payment could not be released.', error); return; }
    const n = (data?.expired || 0) + (data?.released || 0);
    setNotice({ text: n ? `Released ${n} stuck payment${n === 1 ? '' : 's'}. ${r.label} can take payments again.` : `Nothing was stuck on ${r.label}.` });
  };

  const setPin = async () => {
    setBusy('pin'); setErr(null);
    try {
      const pin = pinChoice.trim();
      if (isLive && !/^\d{4,6}$/.test(pin)) throw plainError('Choose a PIN of 4 to 6 digits.');
      const a = await callAdmin('passcodes', { set_default: true, ...(pin ? { pin } : {}) });
      if (a.ok === false) throw new Error(a.error || 'The PIN could not be set.');
      setPinInfo(a);
      setPinChoice('');
      setNotice({ text: 'The admin PIN is set on the readers.' });
    } catch (e) { fail('The admin PIN could not be set.', e); }
    setBusy('');
  };

  const saveTipOnReceipt = async () => {
    setBusy('tor'); setTorMsg(''); setErr(null);
    try {
      const locId = getActiveLocationSync();
      if (!locId) throw new Error('No location');
      const hours = Math.max(1, Math.min(72, Math.round(Number(torHours) || 24)));
      const { data, error: readErr } = await supabase.from('locations').select('pos_settings').eq('id', locId).maybeSingle();
      if (readErr) throw new Error(`could not read the current settings: ${readErr.message}`);
      const scope = torScope === 'table_checks' ? 'table_checks' : 'all_pos';
      const { error: writeErr } = await supabase.from('locations').update({
        pos_settings: { ...(data?.pos_settings || {}), tip_on_receipt: { enabled: torEnabled, capture_hours: hours, scope } },
      }).eq('id', locId);
      if (writeErr) throw new Error(writeErr.message);
      setTorHours(hours);
      setTorMsg(torEnabled
        ? `Saved. Tills pick it up next boot or Push to POS. Cards nobody adjusts capture at the original amount after ${hours} hour${hours === 1 ? '' : 's'}.`
        : 'Saved. Tip on printed receipt is off. Cards capture at payment time as normal.');
    } catch (e) { fail('Tip on receipt could not be saved.', e); }
    setBusy('');
  };

  const lastSync = syncOut || list?.settingsSync || null;

  return (
    <div style={S.card}>
      {liveBanner}
      <h2 style={S.h2}>Card readers at {venueName}{envBadge}</h2>
      <p style={S.p}>Add a reader by its serial number and it takes payments from the till.</p>

      {!status.scopeOk && <Notice kind="error" text="Adyen refused ServOS access to this venue's readers. Contact ServOS support." detail={status.scopeError} />}

      {/* ── 1. the readers ── */}
      <div style={{ ...S.box, marginTop: 18 }}>
        <h3 style={S.h3}>Readers at {venueName}</h3>
        {listErr && <Notice kind="error" text="The readers could not be listed. Refresh to try again." detail={listErr} />}
        {!listErr && !list && status.storeId && <p style={S.p}>Loading the readers.</p>}
        {!status.storeId && <p style={S.p}>This venue has no Adyen store yet, so no readers can be listed.</p>}
        {list && readers.length === 0 && <p style={S.p}>No readers yet. Add one below.</p>}
        {readers.map((r) => {
          const sa = standalone[r.poiid];
          return (
            <div key={r.id} style={S.row}>
              <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                {editId === r.id ? (
                  <>
                    <input style={{ ...S.input, width: 220 }} value={editName} autoFocus maxLength={60}
                      onChange={(e) => setEditName(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') saveName(r); if (e.key === 'Escape') setEditId(null); }} />
                    <button style={{ ...S.btn, ...S.btnPrim, ...S.btnSmall }} disabled={busy === `name-${r.id}`} onClick={() => saveName(r)}>
                      {busy === `name-${r.id}` ? 'Saving' : 'Save'}
                    </button>
                    <button style={{ ...S.btn, ...S.btnSmall }} onClick={() => setEditId(null)}>Cancel</button>
                  </>
                ) : (
                  <>
                    <span style={{ fontSize: 17, fontWeight: 800 }}>{r.label}</span>
                    <button style={S.linkBtn} title="Rename" aria-label={`Rename ${r.label}`}
                      onClick={() => { setEditId(r.id); setEditName(r.label); }}>Rename</button>
                  </>
                )}
                <StatusDot status={r.status} />
                <span style={{ flex: 1 }} />
                <button style={{ ...S.btn, ...S.btnDan, ...S.btnSmall }} disabled={!!busy} onClick={() => remove(r)}>
                  {busy === `rm-${r.id}` ? 'Removing' : 'Remove'}
                </button>
              </div>
              <div style={{ ...S.grey, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <span>{r.model || 'Reader'}</span>
                <CopyId value={r.serialNumber} />
                {!r.onAdyen && <span style={{ color: 'var(--orn, #e8a020)' }}>Adyen no longer lists this reader on the venue's store.</span>}
              </div>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <span>Sends payments from:</span>
                <select style={{ ...S.select, minWidth: 200 }} value={r.boundPosDeviceId || ''} disabled={!!busy}
                  onChange={(e) => setTill(r, e.target.value)}>
                  <option value="">Any till</option>
                  {posDevices.map((d) => <option key={d.id} value={d.id}>{d.name || d.id}</option>)}
                </select>
                {r.boundPosDeviceId && !posDevices.some((d) => d.id === r.boundPosDeviceId) && (
                  <span style={S.grey}>{tillSentence(r.boundPosDeviceId, posDevices)}</span>
                )}
              </div>
              <div style={{ display: 'flex', gap: 24, alignItems: 'center', flexWrap: 'wrap' }}>
                <Switch label="Take payments from the till" checked={r.modes?.pos_dispatch !== false} disabled={!!busy}
                  onChange={(on) => setPosDispatch(r, on)} />
                <Switch label="Staff can type an amount on the reader" checked={sa === true} disabled={!!busy || sa == null}
                  title="Payments typed on the reader book against the venue and show in payment reports. They do not attach to a till check."
                  onChange={(on) => setStandaloneFor(r, on)} />
              </div>
            </div>
          );
        })}
      </div>

      {/* ── 2. add a reader ── */}
      <div style={{ ...S.box, opacity: canAdd ? 1 : 0.8 }}>
        <h3 style={S.h3}>Add a reader</h3>
        <p style={S.p}>Switch the reader on, connect it to WiFi, then type the serial number from the label on the reader or its box.</p>
        {addBlocked && <p style={{ ...S.p, color: status.scopeOk ? 'var(--orn, #e8a020)' : 'var(--red)' }}>{addBlocked}</p>}
        <div style={{ display: 'flex', gap: 10, marginTop: 12, flexWrap: 'wrap' }}>
          <input style={{ ...S.input, flex: '1 1 260px', minWidth: 0, fontFamily: 'var(--font-mono, ui-monospace, monospace)' }} value={serial}
            disabled={!canAdd}
            onChange={(e) => setSerial(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && canAdd && serial.trim()) addBySerial(); }}
            placeholder="Serial number from the label" aria-label="Serial number from the label" />
          <button style={{ ...S.btn, ...S.btnPrim }} disabled={!canAdd || !!busy || !serial.trim()} onClick={addBySerial}>
            {busy === 'serial' ? 'Adding' : 'Add'}
          </button>
        </div>
        {notAdded.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <div style={{ fontWeight: 700 }}>Readers already on this venue's Adyen store that are not added yet</div>
            {notAdded.map((t) => (
              <div key={t.poiid} style={{ ...S.row, flexDirection: 'row', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <span>{t.model || 'Reader'}</span>
                <CopyId value={t.serialNumber} />
                <StatusDot status={t.seen} />
                <span style={{ flex: 1 }} />
                <button style={{ ...S.btn, ...S.btnPrim, ...S.btnSmall }} disabled={!canAdd || !!busy} onClick={() => addFromStore(t)}>
                  {busy === `add-${t.poiid}` ? 'Adding' : 'Add'}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── 3. tips (venue level) ── */}
      <div style={S.box}>
        <h3 style={S.h3}>Tips on the reader <span style={{ ...S.grey, fontWeight: 400, fontSize: 13 }}>(Adyen gratuities)</span></h3>
        <p style={S.p}>These tip choices apply to every reader at {venueName}.</p>
        <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap', marginTop: 12 }}>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span>Choices</span>
            <input style={{ ...S.input, width: 160 }} value={tipText} onChange={(e) => setTipText(e.target.value)} placeholder="5, 10, 15" aria-label="Tip choices, whole percentages" />
          </label>
          <Switch label="Allow a custom amount" checked={tipCustom} onChange={setTipCustom} />
          <button style={{ ...S.btn, ...S.btnPrim }} disabled={!canAdd || busy === 'tips'} onClick={saveTips}>
            {busy === 'tips' ? 'Saving' : 'Save tips'}
          </button>
        </div>
        <p style={{ ...S.grey, marginTop: 8 }}>
          Whole percentages, up to {tipCustom ? 'three plus the custom amount' : 'four'}.
          {list?.tips?.syncedAt ? ` Last sent to Adyen ${fmtWhen(list.tips.syncedAt)}.` : ''}
        </p>
      </div>

      {/* ── 4. advanced ── */}
      <div style={S.box}>
        <button style={{ ...S.linkBtn, fontSize: 16 }} onClick={() => setAdvOpen((v) => !v)} aria-expanded={advOpen}>
          {advOpen ? 'Hide advanced' : 'Advanced'}
        </button>
        {advOpen && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 18, marginTop: 12 }}>

            <div>
              <div style={{ fontWeight: 800 }}>Send reader settings to Adyen</div>
              <p style={S.p}>Sends the events address, the Pay at table button and the tip choices to every reader here. Adding a reader does this on its own.</p>
              <div style={{ marginTop: 8 }}>
                <button style={S.btn} disabled={!canAdd || busy === 'sync'} onClick={sendSettings}>{busy === 'sync' ? 'Sending' : 'Send reader settings to Adyen'}</button>
              </div>
              {lastSync && (
                <div style={{ marginTop: 8 }}>
                  <div style={S.grey}>Last run {fmtWhen(lastSync.at)}.</div>
                  {(lastSync.applied || []).map((l, i) => <div key={`a${i}`} style={{ color: 'var(--grn)' }}>{l}</div>)}
                  {(lastSync.errors || []).map((l, i) => <div key={`e${i}`} style={{ color: 'var(--red)' }}>{l}</div>)}
                </div>
              )}
            </div>

            <div>
              <div style={{ fontWeight: 800 }}>Release stuck payment</div>
              <p style={S.p}>Use this if a reader says a payment is already in progress but nothing is happening.</p>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
                <select style={{ ...S.select, minWidth: 200 }} value={releaseId} onChange={(e) => setReleaseId(e.target.value)} aria-label="Reader">
                  <option value="">Choose a reader</option>
                  {readers.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
                </select>
                <button style={S.btn} disabled={!releaseId || busy === 'release'} onClick={release}>{busy === 'release' ? 'Releasing' : 'Release'}</button>
              </div>
            </div>

            <div>
              <div style={{ fontWeight: 800 }}>Environment</div>
              <p style={{ ...S.p, color: isLive ? 'var(--red)' : 'var(--t2)' }}>
                {isLive
                  ? 'LIVE, real money. Every card taken at this venue is charged for real. Refunds and disputes are real too.'
                  : 'Test cards. Card payments go to the Adyen test system. Only test cards work. Nobody is charged.'}
                {' '}Moving between test and live is done by ServOS support.
              </p>
            </div>

            <div>
              <div style={{ fontWeight: 800 }}>Admin PIN on the readers</div>
              {!pinInfo && <p style={S.p}>Reading the PIN.</p>}
              {pinInfo?.ok === false && <Notice kind="error" text="The PIN could not be read from Adyen." detail={pinInfo.error} />}
              {pinInfo?.ok && (
                <p style={S.p}>
                  {pinInfo.adminMenuPin
                    ? <>The admin menu PIN is <span style={{ ...S.mono, color: 'var(--t1)', fontSize: 15 }}>{pinInfo.adminMenuPin}</span>.</>
                    : 'No admin PIN is set yet.'}
                </p>
              )}
              {pinInfo?.ok && !pinInfo.adminMenuPin && (
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
                  {isLive && (
                    <input style={{ ...S.input, width: 160 }} value={pinChoice} inputMode="numeric" maxLength={6}
                      onChange={(e) => setPinChoice(e.target.value.replace(/\D/g, ''))} placeholder="Choose a PIN" aria-label="Choose a PIN" />
                  )}
                  <button style={S.btn} disabled={!canAdd || busy === 'pin' || (isLive && !pinChoice)} onClick={setPin}>
                    {busy === 'pin' ? 'Setting' : isLive ? 'Set this PIN' : 'Set the standard PIN'}
                  </button>
                </div>
              )}
            </div>

            {isUS && torLoaded && (
              <div>
                <div style={{ fontWeight: 800 }}>Tip on printed receipt (United States)</div>
                <p style={S.p}>
                  The reader approves the card and holds the charge. The till prints a slip with a tip line, the guest writes a tip
                  and signs, and staff type the tip in from History. While this is on, the reader does not ask for a tip on till payments.
                </p>
                <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap', marginTop: 10 }}>
                  <Switch label="Print a tip line on the merchant copy" checked={torEnabled} onChange={setTorEnabled} />
                  {torEnabled && (
                    <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <span>Capture window</span>
                      <input type="number" min={1} max={72} value={torHours} onChange={(e) => setTorHours(e.target.value)} style={{ ...S.input, width: 80 }} />
                      <span style={S.grey}>hours, 1 to 72</span>
                    </label>
                  )}
                </div>
                {torEnabled && (
                  <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <label style={S.switchRow}>
                      <input type="radio" name="tor-scope" checked={torScope === 'all_pos'} onChange={() => setTorScope('all_pos')} />
                      All card payments at the till
                    </label>
                    <label style={S.switchRow}>
                      <input type="radio" name="tor-scope" checked={torScope === 'table_checks'} onChange={() => setTorScope('table_checks')} />
                      Table checks only. Counter sales keep the tip prompt on the reader.
                    </label>
                    <p style={{ ...S.grey, margin: 0 }}>A card nobody adjusts captures at the original amount when the window closes. 24 hours covers a normal close.</p>
                  </div>
                )}
                <div style={{ marginTop: 10 }}>
                  <button style={{ ...S.btn, ...S.btnPrim }} disabled={busy === 'tor'} onClick={saveTipOnReceipt}>{busy === 'tor' ? 'Saving' : 'Save tip on receipt'}</button>
                </div>
                {torMsg && <div style={S.ok}>{torMsg}</div>}
              </div>
            )}

            <div>
              <div style={{ fontWeight: 800 }}>Ids Adyen gave this venue</div>
              <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 6 }}>
                <span style={S.grey}>Store <CopyId value={status.storeId} /></span>
                {readers.map((r) => <span key={r.id} style={S.grey}>{r.label} <CopyId value={r.poiid} /></span>)}
              </div>
            </div>
          </div>
        )}
      </div>

      <div style={{ marginTop: 14 }}>
        <button style={S.btn} disabled={!!busy} onClick={() => { setErr(null); setNotice(null); load(); }}>Refresh</button>
      </div>

      {err && <Notice kind="error" text={err.text} detail={err.detail} onClose={() => setErr(null)} />}
      {notice && (
        <div style={S.ok} role="status">
          <div>{notice.text}</div>
          {(notice.lines || []).map((l, i) => <div key={i} style={{ marginTop: 2 }}>{l}</div>)}
        </div>
      )}
    </div>
  );
}
