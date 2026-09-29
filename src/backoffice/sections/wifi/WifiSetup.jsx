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
import { APP_TIER } from '../../../lib/env';
import { WIFI_FRONT_DOOR_IP, WIFI_PREAUTH_ALLOWANCES, wifiPortalDomain, wifiPortalZone } from '../../../lib/wifiPortal';

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
  part: { fontSize: 13, fontWeight: 800, color: 'var(--t1)', margin: '16px 0 6px' },
  hint2: { fontSize: 12, color: 'var(--t3)', marginBottom: 10, lineHeight: 1.45 },
  warn: { fontSize: 12, color: 'var(--t2)', lineHeight: 1.45, margin: '0 0 10px 30px', padding: '8px 10px', borderRadius: 8, border: '1px solid color-mix(in srgb, var(--red) 45%, var(--bdr2))', background: 'color-mix(in srgb, var(--red) 8%, transparent)' },
  copy: { display: 'inline-flex', alignItems: 'center', gap: 8, marginTop: 5, marginRight: 6, padding: '3px 4px 3px 8px', borderRadius: 7, border: '1px solid var(--bdr2)', background: 'var(--bg2)' },
  copyBtn: { padding: '2px 8px', borderRadius: 5, border: 'none', cursor: 'pointer', fontSize: 11, fontWeight: 700, fontFamily: 'inherit', background: 'var(--acc)', color: '#0b0c10' },
};

// A value to type into UniFi, with a Copy button (so nobody has to retype an address).
function Copy({ text }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500); } catch { /* clipboard blocked: the text is still there to select */ }
  };
  return (
    <span style={S.copy}>
      <span style={{ fontFamily: 'var(--font-mono,monospace)', fontSize: 12, color: 'var(--t1)', userSelect: 'all' }}>{text}</span>
      <button type="button" style={S.copyBtn} onClick={copy}>{done ? 'Copied' : 'Copy'}</button>
    </span>
  );
}

// The WiFi FRONT DOOR (29 Sep 2026). The venue host (<venue>.serv-os.app, Vercel) resolves to a
// DIFFERENT address per resolver and per lookup (216.150.1.x and 216.150.16.x seen at Huddersfield),
// so UniFi's IP-only External Portal Server and its pre-auth allow-list failed at random: iOS showed
// "Cannot verify server identity", and after allowing whole /24s nothing popped up at all.
// Guests now land on <venue>.wifi.serv-os.app, which ALWAYS resolves to one fixed IPv4 (our Fly app
// servos-wifi-relay, see wifi-relay/README.md). It serves the page and both Supabase projects from
// that one address, so UniFi needs that IP plus Google Fonts and nothing else.
// If guests stop reaching the portal: `dig +short A <venue>.wifi.serv-os.app` must print this IP.
const FRONT_DOOR_IP = WIFI_FRONT_DOOR_IP;
const PREAUTH_HOSTS = WIFI_PREAUTH_ALLOWANCES;

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

  // UniFi's External Portal Server box takes an IPv4 ONLY, and its allow-list takes no wildcards
  // (29 Sep 2026, Huddersfield). UniFi gets the front door's IP plus Domain = this venue's front door
  // host. The relay turns UniFi's /guest/s/<site>/ redirect into /wifi on the same host and serves
  // the venue's page from it. Every tier shows the LIVE front door for now: the dev one
  // (<venue>.wifi.dev.serv-os.app) has no DNS or certificate yet, and real venues appear in the dev
  // Back Office too (WIFI_DEV_FRONT_DOOR_READY in lib/wifiPortal.js).
  const portalHost = useMemo(
    () => wifiPortalDomain(slug, APP_TIER) || `<your-venue>.${wifiPortalZone(APP_TIER)}`,
    [slug],
  );

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
      // 29 Sep 2026: show UniFi's own reply too (Huddersfield's 403 said nothing about why).
      else setConn({ state: 'down', msg: r.message || 'Could not reach your console — check the key and Console ID.', said: typeof r.detail === 'string' ? r.detail.trim().slice(0, 300) : '' });
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
            {conn.state === 'down' && conn.said && <div style={{ ...S.hint, fontFamily: 'var(--font-mono,monospace)', wordBreak: 'break-word' }}>UniFi said: {conn.said}</div>}
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

      {/* Documented setup (29 Sep 2026): rewritten to follow UniFi Network 10's own screens, with
          the exact section names, after Huddersfield's setup went wrong three times on the old
          guide (URL in an IP-only box, wildcard in the allow-list, hosts in the wrong list). */}
      <div style={S.card}>
        <h2 style={S.h2}>Set it up in UniFi (one time per venue)</h2>

        <div style={S.part}>A. In UniFi Network, open this venue's guest WiFi <b>Hotspot Portal</b></div>
        <div style={S.hint2}>At unifi.ui.com open this venue's console, then <b>Clients → Hotspot → Landing Page</b> (older versions: <b>Settings → WiFi →</b> your guest network <b>→ Hotspot</b>).</div>
        <div style={S.step}><span style={S.num}>1</span><span>Under <b>One Way Methods</b>, tick <b>External Portal Server</b>, press <b>Edit</b> and enter this IP address, then <b>Save</b>. UniFi only accepts an IP address here, never a web address. It is the ServOS WiFi front door, the same for every venue.<br /><Copy text={FRONT_DOOR_IP} /></span></div>
        <div style={S.step}><span style={S.num}>2</span><span>Under <b>Landing Page Settings</b>: tick <b>Show Landing Page</b> and <b>HTTPs Redirection Support</b>; <b>untick Encrypted URL</b> (it scrambles the phone's ID, so guests could not be put online); leave <b>Secure Portal</b> unticked. Tick <b>Domain</b> and enter the address below (older versions call it <b>Redirect using hostname</b>). The Domain is how the front door knows which venue's page to show; without it phones show a certificate warning or no page at all.<br /><Copy text={portalHost} />{APP_TIER !== 'prod' && wifiPortalZone(APP_TIER) === 'wifi.serv-os.app' && <span style={{ ...S.hint, display: 'block' }}>This is the live address on every ServOS tier, so it is safe to copy into a real venue's UniFi.</span>}</span></div>
        <div style={S.step}><span style={S.num}>3</span><span>Under <b>Pre-Authorization Allowances</b> (the <b>top</b> list), press the <b>Add Hostname, IP or Subnet</b> button <b>directly under that heading</b> once for each of these. The Add button further down belongs to the other list. UniFi does not accept <b>*</b>. Anything older ServOS guides had you add here (216.150.x ranges, supabase.co addresses) is no longer needed and can be removed.<br />{PREAUTH_HOSTS.map((h) => <Copy key={h} text={h} />)}</span></div>
        <div style={{ ...S.warn }}>Do <b>not</b> put these in <b>Post-Authorization Restrictions</b> (the list below it). That list <b>blocks</b> addresses after sign up. Keep only its three number ranges (192.168.0.0/16, 172.16.0.0/12, 10.0.0.0/8) and delete anything else there.</div>
        <div style={S.step}><span style={S.num}>4</span><span>Press <b>Apply Changes</b>.</span></div>

        <div style={S.part}>B. Connect ServOS to this venue's UniFi</div>
        <div style={S.step}><span style={S.num}>5</span><span>Sign in to unifi.ui.com <b>as the owner</b> of this venue's console, in the <b>workspace where that console appears</b> (check the switcher at the top left). Otherwise UniFi refuses with <b>"user is not the owner of this host"</b>.</span></div>
        <div style={S.step}><span style={S.num}>6</span><span>Go to <b>API → Create API Key</b>. Tick <b>Site Manager</b> and <b>UniFi Applications</b> (Network), leave <b>All Sites</b> ticked and <b>Never Expires</b>. Copy the key straight away (it is shown once) and paste it in <b>Site Manager API key</b> above. One key can serve every venue this owner has.</span></div>
        <div style={S.step}><span style={S.num}>7</span><span>Open <b>this venue's</b> console. The address bar reads <span style={S.code}>/consoles/&lt;ID&gt;/network</span>. Copy the ID into <b>Console ID</b> above. This is how ServOS knows which venue's WiFi to open.</span></div>
        <div style={S.step}><span style={S.num}>8</span><span>Press <b>Save &amp; connect</b>. The badge turns <b style={{ color: 'var(--grn)' }}>green</b> when it is working.</span></div>

        <div style={S.part}>C. Test it</div>
        <div style={S.step}><span style={S.num}>9</span><span>On a phone, <b>forget</b> the guest WiFi and join it again. This venue's sign up page should open. Fill it in: the phone goes online and the guest appears in <b>Customers</b>.</span></div>
        <div style={{ ...S.hint, marginTop: 8 }}>To check the page on its own, open <span style={S.code}>https://{portalHost}/wifi</span> on any phone. New guests fill the form once; returning devices reconnect automatically. Sign ups are saved the moment the page loads, even before step 8 is done.</div>
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
