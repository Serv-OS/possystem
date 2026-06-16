// src/backoffice/sections/wifi/WifiSetup.jsx
//
// Setup — connect the venue's UniFi guest network to our branded portal and choose how guests get
// online. The recommended methods authorize the guest DIRECTLY ON THE VENUE'S CONSOLE from our
// cloud (no on-site box, no port-forward): a cloud-adopted UniFi console is reachable from the
// internet at a valid-cert hostname, so wifi-authorize calls its API to authorize each device.
//   • unifi_local_api — Network Integration API + an API key (UniFi OS 9.x+). Cleanest.
//   • unifi_legacy    — classic API + a local-admin account. Most universal.
//   • unifi_voucher   — paste pre-made guest passes (fallback; no API access needed).
//   • none            — capture only.
// Secrets are sent once to wifi-admin, AES-GCM encrypted at rest, and never returned to the client.

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
  area: { width: '100%', boxSizing: 'border-box', minHeight: 90, border: '1px solid var(--bdr2)', borderRadius: 10, padding: '9px 12px', fontSize: 13, fontFamily: 'var(--font-mono,monospace)', color: 'var(--t1)', background: 'var(--bg2)', outline: 'none', resize: 'vertical' },
  field: { marginBottom: 14 },
  row2: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 },
  hint: { fontSize: 11.5, color: 'var(--t4)', marginTop: 5, lineHeight: 1.45 },
  btn: { padding: '8px 16px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'inherit', background: 'var(--acc)', color: '#0b0c10' },
  ghost: { padding: '7px 12px', borderRadius: 8, cursor: 'pointer', fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit', background: 'transparent', color: 'var(--t2)', border: '1px solid var(--bdr2)' },
  ok: { fontSize: 12.5, color: 'var(--grn)', fontWeight: 700 },
  err: { fontSize: 12, color: 'var(--red)' },
  empty: { textAlign: 'center', padding: '60px 20px', color: 'var(--t3)', fontSize: 14 },
  pill: { display: 'inline-block', padding: '3px 10px', borderRadius: 99, fontSize: 11.5, fontWeight: 700, background: 'var(--bg2)', border: '1px solid var(--bdr2)', color: 'var(--t2)' },
  step: { display: 'flex', gap: 10, marginBottom: 10, fontSize: 12.5, color: 'var(--t2)', lineHeight: 1.5 },
  num: { flexShrink: 0, width: 20, height: 20, borderRadius: 99, background: 'var(--acc)', color: '#0b0c10', fontSize: 11, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center' },
  code: { fontFamily: 'var(--font-mono,monospace)', background: 'var(--bg2)', border: '1px solid var(--bdr2)', borderRadius: 6, padding: '1px 6px', fontSize: 11.5, color: 'var(--t1)' },
  set: { fontSize: 11, color: 'var(--grn)', fontWeight: 700, marginLeft: 6 },
};

const METHODS = [
  ['unifi_connector', 'UniFi cloud connector (recommended)', 'Cloud-only, no box, no port-forward. We authorize each guest through Ubiquiti’s official Site Manager connector (api.ui.com) using a Site Manager API key. Works on any cloud-adopted console.'],
  ['unifi_cloud', 'UniFi account / cloud', 'We log into your Ubiquiti account and authorize through the cloud. Blocked by Ubiquiti’s bot-protection from servers — use the connector above instead.'],
  ['unifi_local_api', 'UniFi API key (direct)', 'Authorize via an API key — only works if your console is directly reachable from the internet (public address + valid cert).'],
  ['unifi_legacy', 'UniFi local admin (direct)', 'Authorize via a local-admin login — only works if your console is directly reachable from the internet.'],
  ['unifi_voucher', 'UniFi vouchers', 'Fallback. Paste a pool of guest passes; the portal hands one to each guest. No login needed.'],
  ['none', 'Capture only', 'Collect details; guests get online however they do today.'],
];
const isDirect = (m) => m === 'unifi_local_api' || m === 'unifi_legacy';
const isCloud = (m) => m === 'unifi_cloud';
const isConnector = (m) => m === 'unifi_connector';
// The connector reuses the Integration-API authorize path, pointed at the api.ui.com cloud connector.
const connectorUrl = (consoleId) => `https://api.ui.com/v1/connector/consoles/${String(consoleId || '').trim()}`;

export default function WifiSetup() {
  const [locId, setLocId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [slug, setSlug] = useState(null);
  const [b, setB] = useState({ auth_method: 'none', ssid: '', controller_url: '', site_id: 'default', console_id: '', auth_minutes: 1440, data_limit_mb: '', down_kbps: '', up_kbps: '' });
  const [secret, setSecret] = useState({ api_key: '', admin_user: '', admin_pass: '', totp_secret: '' }); // never pre-filled
  const [status, setStatus] = useState(null);
  const [codes, setCodes] = useState('');
  const [save, setSave] = useState({});
  const [test, setTest] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const id = await getActiveLocationSync(); setLocId(id);
        if (!supabase || !id) { setLoading(false); return; }
        try { const { data: loc } = await platformSupabase.from('locations').select('online_slug').or(`ops_location_id.eq.${id},id.eq.${id}`).maybeSingle(); setSlug(loc?.online_slug || null); } catch {}
        const { data } = await supabase.functions.invoke('wifi-admin', { body: { action: 'get_config', ops_location_id: id } });
        const st = data?.binding_status || {}; setStatus(st);
        // The connector is stored as unifi_local_api with an api.ui.com controller_url — show it as its own method.
        const isConn = (st.controller_url || '').includes('api.ui.com/v1/connector');
        setB({ auth_method: isConn ? 'unifi_connector' : (st.auth_method || 'none'), ssid: st.ssid || '', controller_url: st.controller_url || '', site_id: st.site_id || 'default', console_id: st.console_id || '', auth_minutes: st.auth_minutes || 1440, data_limit_mb: st.data_limit_mb || '', down_kbps: st.down_kbps || '', up_kbps: st.up_kbps || '' });
      } catch {} finally { setLoading(false); }
    })();
  }, []);

  const portalUrl = useMemo(() => (slug ? customerUrl(slug, '/wifi') : 'https://<your-venue>.serv-os.app/wifi'), [slug]);
  const set = (patch) => setB(x => ({ ...x, ...patch }));
  const setSec = (patch) => setSecret(x => ({ ...x, ...patch }));

  const saveBinding = async (extra = {}) => {
    setSave({ busy: true });
    try {
      const connector = b.auth_method === 'unifi_connector';
      const binding = {
        // The connector is stored as unifi_local_api with an api.ui.com controller_url.
        auth_method: connector ? 'unifi_local_api' : b.auth_method,
        ssid: b.ssid || null,
        controller_url: connector ? connectorUrl(b.console_id)
          : b.auth_method === 'unifi_cloud' ? (b.controller_url || 'https://unifi.ui.com') : (b.controller_url || null),
        site_id: b.site_id || null, console_id: b.console_id || null, auth_minutes: Number(b.auth_minutes) || 1440,
        data_limit_mb: b.data_limit_mb === '' ? null : Number(b.data_limit_mb),
        down_kbps: b.down_kbps === '' ? null : Number(b.down_kbps),
        up_kbps: b.up_kbps === '' ? null : Number(b.up_kbps),
        ...extra,
      };
      // Only send secrets the operator actually typed (blank = leave existing untouched).
      if ((b.auth_method === 'unifi_local_api' || connector) && secret.api_key.trim()) binding.api_key = secret.api_key.trim();
      if (b.auth_method === 'unifi_legacy' || b.auth_method === 'unifi_cloud') {
        if (secret.admin_user.trim()) binding.admin_user = secret.admin_user.trim();
        if (secret.admin_pass) binding.admin_pass = secret.admin_pass;
      }
      if (b.auth_method === 'unifi_cloud' && secret.totp_secret.trim()) binding.totp_secret = secret.totp_secret.replace(/\s/g, '');
      const { data, error } = await supabase.functions.invoke('wifi-admin', { body: { action: 'save_binding', ops_location_id: locId, binding } });
      if (error) { let j = null; try { j = await error.context?.json?.(); } catch {} throw new Error(j?.error || error.message); }
      if (data?.error) throw new Error(data.error);
      const { data: cfg } = await supabase.functions.invoke('wifi-admin', { body: { action: 'get_config', ops_location_id: locId } });
      setStatus(cfg?.binding_status || status); setCodes(''); setSecret({ api_key: '', admin_user: '', admin_pass: '', totp_secret: '' });
      setSave({ done: true }); setTimeout(() => setSave(s => (s.done ? {} : s)), 2200);
    } catch (e) { setSave({ err: e.message || 'Save failed' }); }
  };
  const runTest = async () => {
    setTest({ busy: true });
    try { const { data } = await supabase.functions.invoke('wifi-admin', { body: { action: 'test', ops_location_id: locId } }); setTest({ result: data?.result || {} }); }
    catch (e) { setTest({ err: e.message }); }
  };

  if (loading) return <div style={S.empty}>Loading…</div>;
  if (!supabase || !locId) return <div style={S.empty}>Pick a location to set up its WiFi.</div>;

  return (
    <div>
      <h1 style={S.h1}>WiFi setup</h1>
      <div style={S.sub}>Connect this venue's UniFi guest network to your branded portal and choose how guests get online. The recommended methods authorize each guest directly on your console from the cloud — no on-site box, no port-forwarding.</div>

      <div style={S.card}>
        <h2 style={S.h2}>How guests get online</h2>
        <div style={{ display: 'grid', gap: 8 }}>
          {METHODS.map(([k, t, d]) => (
            <label key={k} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '10px 12px', border: `1px solid ${b.auth_method === k ? 'var(--acc)' : 'var(--bdr2)'}`, borderRadius: 10, cursor: 'pointer', background: b.auth_method === k ? 'color-mix(in srgb, var(--acc) 8%, transparent)' : 'var(--bg2)' }}>
              <input type="radio" name="authm" checked={b.auth_method === k} onChange={() => set({ auth_method: k })} style={{ marginTop: 3, accentColor: 'var(--acc)' }} />
              <span><span style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--t1)' }}>{t}</span><div style={S.hint}>{d}</div></span>
            </label>
          ))}
        </div>
        <div style={{ marginTop: 14, display: 'flex', gap: 12, alignItems: 'center' }}>
          <button style={S.btn} onClick={() => saveBinding()} disabled={save.busy}>{save.busy ? 'Saving…' : 'Save'}</button>
          {save.done && <span style={S.ok}>✓ Saved</span>}{save.err && <span style={S.err}>{save.err}</span>}
        </div>
      </div>

      {isConnector(b.auth_method) && (
        <div style={S.card}>
          <h2 style={S.h2}>UniFi cloud connector</h2>
          <div style={{ ...S.hint, marginTop: -4, marginBottom: 12 }}>
            We authorize each guest through Ubiquiti’s official cloud connector — no box, no port-forward. You need a <b>Site Manager API key</b> (account-level) and your <b>console ID</b>.
          </div>
          <div style={S.field}>
            <label style={S.label}>Site Manager API key {status?.has_api_key && <span style={S.set}>✓ set</span>}</label>
            <input style={S.input} type="password" value={secret.api_key} onChange={e => setSec({ api_key: e.target.value })} placeholder={status?.has_api_key ? 'Leave blank to keep the saved key' : 'Paste the Site Manager key'} autoComplete="new-password" />
            <div style={S.hint}>Make it at <b>unifi.ui.com → Settings → API Keys</b> (NOT the per-console “Integrations” key). Stored encrypted; never shown again.</div>
          </div>
          <div style={S.field}>
            <label style={S.label}>Console ID</label>
            <input style={S.input} value={b.console_id} onChange={e => set({ console_id: e.target.value })} placeholder="from unifi.ui.com URL: /consoles/<THIS>/network" />
            <div style={S.hint}>At unifi.ui.com, open this console — the address bar shows <span style={S.code}>/consoles/&lt;ID&gt;/network</span>. Paste that ID.</div>
          </div>
          <div style={S.row2}>
            <div style={S.field}>
              <label style={S.label}>Site</label>
              <input style={S.input} value={b.site_id} onChange={e => set({ site_id: e.target.value })} placeholder="default" />
            </div>
            <div style={S.field}>
              <label style={S.label}>Access duration (minutes)</label>
              <input style={S.input} type="number" value={b.auth_minutes} onChange={e => set({ auth_minutes: e.target.value })} placeholder="1440" />
            </div>
          </div>
          <button style={S.btn} onClick={() => saveBinding()} disabled={save.busy || (!b.console_id && !status?.console_id)}>{save.busy ? 'Saving…' : 'Save connector'}</button>
        </div>
      )}

      {isCloud(b.auth_method) && (
        <div style={S.card}>
          <h2 style={S.h2}>Ubiquiti account</h2>
          <div style={{ ...S.hint, marginTop: -4, marginBottom: 12 }}>
            <b>Use a dedicated UniFi account</b>, not your personal one — create a new Ubiquiti account, then in UniFi add it as an <b>Admin</b> on this console. We log in as that account to get guests online. Credentials are encrypted; never shown again.
          </div>
          <div style={S.row2}>
            <div style={S.field}>
              <label style={S.label}>Account email {status?.has_admin && <span style={S.set}>✓ set</span>}</label>
              <input style={S.input} value={secret.admin_user} onChange={e => setSec({ admin_user: e.target.value })} placeholder={status?.has_admin ? 'Leave blank to keep saved' : 'servos@your-venue.com'} autoComplete="off" />
            </div>
            <div style={S.field}>
              <label style={S.label}>Account password</label>
              <input style={S.input} type="password" value={secret.admin_pass} onChange={e => setSec({ admin_pass: e.target.value })} placeholder={status?.has_admin ? 'Leave blank to keep saved' : '••••••••'} autoComplete="new-password" />
            </div>
          </div>
          <div style={S.field}>
            <label style={S.label}>2FA secret (authenticator key) {status?.has_totp && <span style={S.set}>✓ set</span>}</label>
            <input style={S.input} type="password" value={secret.totp_secret} onChange={e => setSec({ totp_secret: e.target.value })} placeholder={status?.has_totp ? 'Leave blank to keep saved' : 'e.g. JBSWY3DPEHPK3PXP'} autoComplete="new-password" />
            <div style={S.hint}>Ubiquiti requires 2-factor. When you turn on 2FA for the account, choose <b>authenticator app</b> and copy the <b>setup key / secret</b> shown — paste it here so we can generate codes automatically.</div>
          </div>
          <div style={S.field}>
            <label style={S.label}>Console ID</label>
            <input style={S.input} value={b.console_id} onChange={e => set({ console_id: e.target.value })} placeholder="from unifi.ui.com URL: /consoles/<THIS>/network" />
            <div style={S.hint}>At unifi.ui.com, open this console — the address bar shows <span style={S.code}>/consoles/&lt;ID&gt;/network</span>. Paste that ID.</div>
          </div>
          <div style={S.field}>
            <label style={S.label}>Site</label>
            <input style={{ ...S.input, maxWidth: 220 }} value={b.site_id} onChange={e => set({ site_id: e.target.value })} placeholder="default" />
          </div>
          <button style={S.btn} onClick={() => saveBinding()} disabled={save.busy}>{save.busy ? 'Saving…' : 'Save account'}</button>
        </div>
      )}

      {isDirect(b.auth_method) && (
        <div style={S.card}>
          <h2 style={S.h2}>Console connection</h2>
          <div style={S.field}>
            <label style={S.label}>Controller URL <span style={{ color: 'var(--t4)', fontWeight: 500 }}>(must be reachable from the internet, valid cert)</span></label>
            <input style={S.input} value={b.controller_url} onChange={e => set({ controller_url: e.target.value })} placeholder="https://your-console.ui.com  or  https://unifi.ui.com/…  or your console's public hostname" />
            <div style={S.hint}>Use your <b>cloud-adopted</b> console's remote address — turn on <b>Remote Access</b> in UniFi (Settings → System) and use the address it gives you. A raw LAN IP (192.168.x.x) won't work from the cloud. Self-signed certs are rejected; the cloud-adopted hostname has a valid cert.</div>
          </div>
          <div style={S.row2}>
            <div style={S.field}>
              <label style={S.label}>Site</label>
              <input style={S.input} value={b.site_id} onChange={e => set({ site_id: e.target.value })} placeholder="default" />
            </div>
            <div style={S.field}>
              <label style={S.label}>Access duration (minutes)</label>
              <input style={S.input} type="number" value={b.auth_minutes} onChange={e => set({ auth_minutes: e.target.value })} placeholder="1440" />
            </div>
          </div>

          {b.auth_method === 'unifi_local_api' ? (
            <div style={S.field}>
              <label style={S.label}>API key {status?.has_api_key && <span style={S.set}>✓ set</span>}</label>
              <input style={S.input} type="password" value={secret.api_key} onChange={e => setSec({ api_key: e.target.value })} placeholder={status?.has_api_key ? 'Leave blank to keep the saved key' : 'Paste the Integration API key'} autoComplete="new-password" />
              <div style={S.hint}>UniFi → <b>Settings → Control Plane → Integrations</b> → create an API key. Stored encrypted; never shown again.</div>
            </div>
          ) : (
            <div style={S.row2}>
              <div style={S.field}>
                <label style={S.label}>Local admin username {status?.has_admin && <span style={S.set}>✓ set</span>}</label>
                <input style={S.input} value={secret.admin_user} onChange={e => setSec({ admin_user: e.target.value })} placeholder={status?.has_admin ? 'Leave blank to keep saved' : 'servos'} autoComplete="off" />
              </div>
              <div style={S.field}>
                <label style={S.label}>Password</label>
                <input style={S.input} type="password" value={secret.admin_pass} onChange={e => setSec({ admin_pass: e.target.value })} placeholder={status?.has_admin ? 'Leave blank to keep saved' : '••••••••'} autoComplete="new-password" />
              </div>
            </div>
          )}

          <div style={S.row2}>
            <div style={S.field}>
              <label style={S.label}>Data cap (MB) <span style={{ color: 'var(--t4)', fontWeight: 500 }}>optional</span></label>
              <input style={S.input} type="number" value={b.data_limit_mb} onChange={e => set({ data_limit_mb: e.target.value })} placeholder="no limit" />
            </div>
            <div style={S.field}>
              <label style={S.label}>Speed cap ↓/↑ kbps <span style={{ color: 'var(--t4)', fontWeight: 500 }}>optional</span></label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input style={S.input} type="number" value={b.down_kbps} onChange={e => set({ down_kbps: e.target.value })} placeholder="down" />
                <input style={S.input} type="number" value={b.up_kbps} onChange={e => set({ up_kbps: e.target.value })} placeholder="up" />
              </div>
            </div>
          </div>
          <button style={S.btn} onClick={() => saveBinding()} disabled={save.busy}>{save.busy ? 'Saving…' : 'Save connection'}</button>
        </div>
      )}

      {b.auth_method === 'unifi_voucher' && (
        <div style={S.card}>
          <h2 style={S.h2}>WiFi vouchers (passes)</h2>
          <div style={{ marginBottom: 10 }}><span style={S.pill}>{status?.voucher_remaining ?? 0} remaining</span> <span style={{ ...S.pill, marginLeft: 6 }}>{status?.voucher_total ?? 0} loaded</span></div>
          <div style={S.field}>
            <label style={S.label}>Paste voucher codes</label>
            <textarea style={S.area} value={codes} onChange={e => setCodes(e.target.value)} placeholder={"Create a batch of vouchers in UniFi (Hotspot Manager → Vouchers), then paste the codes here — one per line."} />
            <div style={S.hint}>Codes are single-use passes. New codes are added to the pool; consumed ones are never re-used. Top up before you run low.</div>
          </div>
          <button style={S.btn} onClick={() => saveBinding({ voucher_codes: codes })} disabled={save.busy || !codes.trim()}>{save.busy ? 'Adding…' : 'Add to pool'}</button>
        </div>
      )}

      <div style={S.card}>
        <h2 style={S.h2}>Connect it on UniFi</h2>
        <div style={S.step}><span style={S.num}>1</span><span>In UniFi Network, create (or pick) your <b>Guest</b> WiFi network and turn on the <b>Hotspot / Captive Portal</b>.</span></div>
        <div style={S.step}><span style={S.num}>2</span><span>Set the portal to <b>External portal server</b> and point it at:<br/><span style={S.code}>{portalUrl}</span></span></div>
        <div style={S.step}><span style={S.num}>3</span><span>Add a <b>walled garden / pre-authorization allow-list</b> so guests can reach the page before they log in: <span style={S.code}>*.serv-os.app</span>, <span style={S.code}>tbetcegmszzotrwdtqhi.supabase.co</span>, <span style={S.code}>fonts.googleapis.com</span>, <span style={S.code}>fonts.gstatic.com</span>.</span></div>
        {isConnector(b.auth_method) ? (
          <>
            <div style={S.step}><span style={S.num}>4</span><span>Make a <b>Site Manager API key</b>: unifi.ui.com → <b>Settings → API Keys → Create</b>. Copy it.</span></div>
            <div style={S.step}><span style={S.num}>5</span><span>Grab your <b>Console ID</b> from the address bar at unifi.ui.com (<span style={S.code}>/consoles/&lt;ID&gt;/network</span>).</span></div>
            <div style={S.step}><span style={S.num}>6</span><span>Paste both above → <b>Save connector</b>, then hit <b>Test</b> below.</span></div>
          </>
        ) : isCloud(b.auth_method) ? (
          <>
            <div style={S.step}><span style={S.num}>4</span><span>Make a <b>dedicated Ubiquiti account</b> (a new email at account.ui.com), turn on its <b>2FA via authenticator app</b>, and copy the <b>secret/setup key</b>.</span></div>
            <div style={S.step}><span style={S.num}>5</span><span>In UniFi, add that account as an <b>Admin</b> on this console (Settings → Admins &amp; Users → Invite Admin).</span></div>
            <div style={S.step}><span style={S.num}>6</span><span>Enter the email, password, 2FA secret and console ID above → <b>Save</b>, then hit <b>Test</b> below.</span></div>
          </>
        ) : isDirect(b.auth_method) ? (
          <>
            <div style={S.step}><span style={S.num}>4</span><span>Make sure the console is <b>reachable from the internet</b> at a public address with a <b>valid certificate</b>, and enter that address above.</span></div>
            <div style={S.step}><span style={S.num}>5</span><span>{b.auth_method === 'unifi_local_api'
              ? <>Create an <b>API key</b> in Settings → Control Plane → Integrations, and paste it above.</>
              : <>Create a <b>local-admin</b> account (Settings → Admins &amp; Users → Add → Local Access Only) and enter it above.</>}</span></div>
            <div style={S.step}><span style={S.num}>6</span><span>Hit <b>Test authorize</b> below — it confirms we can reach + sign in to your console.</span></div>
          </>
        ) : b.auth_method === 'unifi_voucher' ? (
          <div style={S.step}><span style={S.num}>4</span><span>In <b>Hotspot Manager → Vouchers</b> generate a batch, then paste them above.</span></div>
        ) : null}
        <div style={{ ...S.hint, marginTop: 8 }}>Capture (name/email/phone → CRM) works the moment the portal loads — the connection method only controls how guests get online afterwards.</div>
      </div>

      <div style={S.card}>
        <h2 style={S.h2}>Status &amp; test</h2>
        <div style={{ fontSize: 12.5, color: 'var(--t2)', lineHeight: 1.7 }}>
          Method: <b>{status?.auth_method || 'none'}</b>{status?.last_authorize_at && <> · last authorize {new Date(status.last_authorize_at).toLocaleString('en-GB')}</>}{status?.last_error && <> · <span style={S.err}>{status.last_error}</span></>}
        </div>
        <div style={{ marginTop: 12, display: 'flex', gap: 12, alignItems: 'center' }}>
          <button style={S.ghost} onClick={runTest} disabled={test?.busy}>{test?.busy ? 'Testing…' : 'Test authorize'}</button>
          {test?.result && <span style={{ fontSize: 12.5, color: test.result.authorized ? 'var(--grn)' : 'var(--t3)' }}>{test.result.authorized ? `✓ connected (${test.result.auth_method})` : (test.result.message || 'not authorized')}</span>}
          {test?.err && <span style={S.err}>{test.err}</span>}
        </div>
        {(isConnector(b.auth_method) || isCloud(b.auth_method) || isDirect(b.auth_method)) && <div style={S.hint}>Test does a dry-run: it reaches your console {isConnector(b.auth_method) ? 'through the Ubiquiti cloud connector' : isCloud(b.auth_method) ? 'via your Ubiquiti account (incl. 2FA)' : 'directly'} to prove the connection works — without authorizing a real device.</div>}
      </div>
    </div>
  );
}
