// src/backoffice/sections/wifi/WifiSetup.jsx
//
// WiFi setup — connect the venue's UniFi guest network to the branded ServOS portal so guests sign
// up (→ CRM) and get online automatically. ONE supported, working method: the Ubiquiti cloud
// connector (api.ui.com). Cloud-only — no on-site box, no port-forward. We authorize each guest by
// calling the console through Ubiquiti's connector with a Site Manager API key + classic cmd/stamgr.
//
// Stored in wifi_unifi_bindings as auth_method 'unifi_local_api' + controller_url
// 'https://api.ui.com/v1/connector/consoles/<consoleId>' + the Site Manager key (AES-GCM encrypted
// via wifi-admin, never returned to the client).

import { useEffect, useMemo, useState } from 'react';
import { supabase, platformSupabase, getActiveLocationSync } from '../../../lib/supabase';
import { customerUrl } from '../../../lib/env';

const S = {
  h1: { fontSize: 22, fontWeight: 800, color: 'var(--t1)', margin: 0, letterSpacing: '-.01em' },
  sub: { fontSize: 13, color: 'var(--t3)', marginTop: 4, marginBottom: 18 },
  card: { border: '1px solid var(--bdr)', borderRadius: 14, background: 'var(--bg1)', padding: 18, marginBottom: 16, maxWidth: 720 },
  h2: { fontSize: 15.5, fontWeight: 800, color: 'var(--t1)', margin: '0 0 12px' },
  label: { display: 'block', fontSize: 12, fontWeight: 700, color: 'var(--t2)', marginBottom: 6 },
  input: { width: '100%', boxSizing: 'border-box', border: '1px solid var(--bdr2)', borderRadius: 10, padding: '9px 12px', fontSize: 13.5, fontFamily: 'inherit', color: 'var(--t1)', background: 'var(--bg2)', outline: 'none' },
  field: { marginBottom: 14 },
  row2: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 },
  hint: { fontSize: 11.5, color: 'var(--t4)', marginTop: 5, lineHeight: 1.45 },
  btn: { padding: '8px 16px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'inherit', background: 'var(--acc)', color: '#0b0c10' },
  ghost: { padding: '7px 12px', borderRadius: 8, cursor: 'pointer', fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit', background: 'transparent', color: 'var(--t2)', border: '1px solid var(--bdr2)' },
  ok: { fontSize: 12.5, color: 'var(--grn)', fontWeight: 700 },
  err: { fontSize: 12, color: 'var(--red)', marginTop: 3 },
  empty: { textAlign: 'center', padding: '60px 20px', color: 'var(--t3)', fontSize: 14 },
  step: { display: 'flex', gap: 10, marginBottom: 10, fontSize: 12.5, color: 'var(--t2)', lineHeight: 1.5 },
  num: { flexShrink: 0, width: 20, height: 20, borderRadius: 99, background: 'var(--acc)', color: '#0b0c10', fontSize: 11, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center' },
  code: { fontFamily: 'var(--font-mono,monospace)', background: 'var(--bg2)', border: '1px solid var(--bdr2)', borderRadius: 6, padding: '1px 6px', fontSize: 11.5, color: 'var(--t1)', marginRight: 4, display: 'inline-block', marginTop: 3 },
  set: { fontSize: 11, color: 'var(--grn)', fontWeight: 700, marginLeft: 6 },
};

const connectorUrl = (consoleId) => `https://api.ui.com/v1/connector/consoles/${String(consoleId || '').trim()}`;

const BADGE = {
  connected: { bg: 'color-mix(in srgb, var(--grn) 15%, transparent)', bd: 'var(--grn)', dot: 'var(--grn)', text: '✓ Connected — guests get online automatically' },
  down: { bg: 'color-mix(in srgb, var(--red) 13%, transparent)', bd: 'var(--red)', dot: 'var(--red)', text: 'Not connected' },
  checking: { bg: 'var(--bg2)', bd: 'var(--bdr2)', dot: 'var(--t3)', text: 'Checking connection…' },
  unset: { bg: 'var(--bg2)', bd: 'var(--bdr2)', dot: 'var(--t4)', text: 'Not set up yet — add your key + Console ID below' },
};

export default function WifiSetup() {
  const [locId, setLocId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [slug, setSlug] = useState(null);
  const [consoleId, setConsoleId] = useState('');
  const [site, setSite] = useState('default');
  const [minutes, setMinutes] = useState(1440);
  const [apiKey, setApiKey] = useState('');            // secret — never pre-filled
  const [status, setStatus] = useState(null);
  const [save, setSave] = useState({});
  const [conn, setConn] = useState({ state: 'unset' }); // unset | checking | connected | down

  const portalUrl = useMemo(() => (slug ? customerUrl(slug, '/wifi') : 'https://<your-venue>.serv-os.app/wifi'), [slug]);

  const load = async (id) => {
    const { data } = await supabase.functions.invoke('wifi-admin', { body: { action: 'get_config', ops_location_id: id } });
    const st = data?.binding_status || {};
    setStatus(st);
    setConsoleId(st.console_id || '');
    setSite(st.site_id || 'default');
    setMinutes(st.auth_minutes || 1440);
    return st;
  };

  const runCheck = async (id = locId) => {
    setConn({ state: 'checking' });
    try {
      const { data } = await supabase.functions.invoke('wifi-admin', { body: { action: 'test', ops_location_id: id } });
      const r = data?.result || {};
      if (r.authorized) setConn({ state: 'connected' });
      else setConn({ state: 'down', msg: r.message || 'Could not reach your console — check the key and Console ID.' });
    } catch (e) { setConn({ state: 'down', msg: e.message || 'Connection test failed.' }); }
  };

  useEffect(() => {
    (async () => {
      try {
        const id = await getActiveLocationSync(); setLocId(id);
        if (!supabase || !id) { setLoading(false); return; }
        try { const { data: loc } = await platformSupabase.from('locations').select('online_slug').or(`ops_location_id.eq.${id},id.eq.${id}`).maybeSingle(); setSlug(loc?.online_slug || null); } catch {}
        const st = await load(id);
        if (st?.has_api_key && (st.controller_url || '').includes('api.ui.com')) runCheck(id);
        else setConn({ state: 'unset' });
      } catch {} finally { setLoading(false); }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveConnector = async () => {
    if (!consoleId.trim()) { setSave({ err: 'Add your Console ID first.' }); return; }
    if (!status?.has_api_key && !apiKey.trim()) { setSave({ err: 'Paste your Site Manager API key.' }); return; }
    setSave({ busy: true });
    try {
      const binding = {
        auth_method: 'unifi_local_api',
        controller_url: connectorUrl(consoleId),
        console_id: consoleId.trim(),
        site_id: site.trim() || 'default',
        auth_minutes: Number(minutes) || 1440,
      };
      if (apiKey.trim()) binding.api_key = apiKey.trim();
      const { data, error } = await supabase.functions.invoke('wifi-admin', { body: { action: 'save_binding', ops_location_id: locId, binding } });
      if (error) { let j = null; try { j = await error.context?.json?.(); } catch {} throw new Error(j?.error || error.message); }
      if (data?.error) throw new Error(data.error);
      setApiKey('');
      await load(locId);
      setSave({ done: true }); setTimeout(() => setSave((s) => (s.done ? {} : s)), 2200);
      await runCheck(locId);
    } catch (e) { setSave({ err: e.message || 'Save failed' }); }
  };

  const turnOff = async () => {
    if (!window.confirm('Turn WiFi authorise off? Guests will still sign up (captured to your CRM) but won’t be put online automatically.')) return;
    setSave({ busy: true });
    try {
      await supabase.functions.invoke('wifi-admin', { body: { action: 'save_binding', ops_location_id: locId, binding: { auth_method: 'none' } } });
      await load(locId); setConn({ state: 'unset' });
      setSave({ done: true }); setTimeout(() => setSave((s) => (s.done ? {} : s)), 2200);
    } catch (e) { setSave({ err: e.message }); }
  };

  if (loading) return <div style={S.empty}>Loading…</div>;
  if (!supabase || !locId) return <div style={S.empty}>Pick a location to set up its WiFi.</div>;

  const b = BADGE[conn.state] || BADGE.unset;

  return (
    <div>
      <h1 style={S.h1}>WiFi</h1>
      <div style={S.sub}>Guests sign up on your branded page (saved to your CRM) and get online automatically. Cloud-only — nothing to install at the venue.</div>

      {/* Live status */}
      <div style={{ ...S.card, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, background: b.bg, borderColor: b.bd }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ width: 11, height: 11, borderRadius: 99, background: b.dot, flexShrink: 0 }} />
          <div>
            <div style={{ fontSize: 14, fontWeight: 800, color: 'var(--t1)' }}>{b.text}</div>
            {conn.state === 'down' && conn.msg && <div style={S.err}>{conn.msg}</div>}
            {conn.state === 'connected' && status?.last_authorize_at && <div style={{ fontSize: 11.5, color: 'var(--t3)', marginTop: 2 }}>Last guest online {new Date(status.last_authorize_at).toLocaleString('en-GB')}</div>}
          </div>
        </div>
        <button style={S.ghost} onClick={() => runCheck()} disabled={conn.state === 'checking'}>{conn.state === 'checking' ? 'Checking…' : 'Re-check'}</button>
      </div>

      {/* The one connection method */}
      <div style={S.card}>
        <h2 style={S.h2}>Connect your UniFi</h2>
        <div style={{ ...S.hint, marginTop: -4, marginBottom: 14 }}>We authorise guests through Ubiquiti’s official cloud connector — no box, no port-forward. You need two things from UniFi: a <b>Site Manager API key</b> and your <b>Console ID</b>.</div>
        <div style={S.field}>
          <label style={S.label}>Site Manager API key {status?.has_api_key && <span style={S.set}>✓ saved</span>}</label>
          <input style={S.input} type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={status?.has_api_key ? 'Leave blank to keep the saved key' : 'Paste the Site Manager key'} autoComplete="new-password" />
          <div style={S.hint}>Create at <b>unifi.ui.com → API Keys → Create API Key</b> (the account-level key — NOT a console “Integrations” key). Stored encrypted; shown only once.</div>
        </div>
        <div style={S.field}>
          <label style={S.label}>Console ID</label>
          <input style={S.input} value={consoleId} onChange={(e) => setConsoleId(e.target.value)} placeholder="e.g. 8CEDE118817…:632754593" />
          <div style={S.hint}>At unifi.ui.com, open your console — the address bar reads <span style={S.code}>/consoles/&lt;ID&gt;/network</span>. Copy that ID.</div>
        </div>
        <div style={S.row2}>
          <div style={S.field}><label style={S.label}>Site</label><input style={S.input} value={site} onChange={(e) => setSite(e.target.value)} placeholder="default" /><div style={S.hint}>Usually “default”.</div></div>
          <div style={S.field}><label style={S.label}>Time online per guest (mins)</label><input style={S.input} type="number" value={minutes} onChange={(e) => setMinutes(e.target.value)} placeholder="1440" /></div>
        </div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <button style={S.btn} onClick={saveConnector} disabled={save.busy}>{save.busy ? 'Saving…' : 'Save & connect'}</button>
          {save.done && <span style={S.ok}>✓ Saved</span>}{save.err && <span style={{ ...S.err, marginTop: 0 }}>{save.err}</span>}
        </div>
      </div>

      {/* Documented setup */}
      <div style={S.card}>
        <h2 style={S.h2}>Set it up in UniFi (one time)</h2>
        <div style={S.step}><span style={S.num}>1</span><span>In <b>UniFi Network → Settings → WiFi</b>, create a <b>Guest</b> network and turn on <b>Hotspot / Captive Portal</b>.</span></div>
        <div style={S.step}><span style={S.num}>2</span><span>Set the portal type to <b>External portal server</b> and point it at:<br /><span style={S.code}>{portalUrl}</span></span></div>
        <div style={S.step}><span style={S.num}>3</span><span>Add these to the <b>walled garden / pre-authorization</b> allow-list so guests can load the page before signing in:<br /><span style={S.code}>*.serv-os.app</span><span style={S.code}>tbetcegmszzotrwdtqhi.supabase.co</span><span style={S.code}>fonts.googleapis.com</span><span style={S.code}>fonts.gstatic.com</span></span></div>
        <div style={S.step}><span style={S.num}>4</span><span>At <b>unifi.ui.com → API Keys</b>, click <b>Create API Key</b> and copy it → paste above.</span></div>
        <div style={S.step}><span style={S.num}>5</span><span>Copy your <b>Console ID</b> from the unifi.ui.com address bar (<span style={S.code}>/consoles/&lt;ID&gt;/network</span>) → paste above.</span></div>
        <div style={S.step}><span style={S.num}>6</span><span><b>Save &amp; connect</b> → the status badge turns <b style={{ color: 'var(--grn)' }}>green</b> when it’s working.</span></div>
        <div style={{ ...S.hint, marginTop: 8 }}>Done. New guests fill the form once; returning devices reconnect automatically. Data capture works the moment the page loads, even before this is connected.</div>
      </div>

      {/* Off switch */}
      {status?.has_api_key && (
        <div style={{ maxWidth: 720 }}>
          <button style={{ ...S.ghost, color: 'var(--red)', borderColor: 'color-mix(in srgb, var(--red) 50%, var(--bdr2))' }} onClick={turnOff} disabled={save.busy}>Turn WiFi authorise off (capture only)</button>
        </div>
      )}
    </div>
  );
}
