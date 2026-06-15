// src/backoffice/sections/wifi/WifiSetup.jsx
//
// Setup — connect the venue's UniFi guest network to our portal + load WiFi voucher passes.
// Voucher method (default) needs zero networking from the venue: paste a pool of UniFi guest
// vouchers and the portal hands one to each guest to get online. The seamless "local API"
// method (direct authorize) is wired in the hardware-testing phase. Saves via wifi-admin.

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
};

const METHODS = [['none', 'Capture only', 'Collect details; guests get online however they do today.'], ['unifi_voucher', 'UniFi vouchers', 'Paste guest passes; the portal hands one to each guest. No venue networking needed.']];

export default function WifiSetup() {
  const [locId, setLocId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [slug, setSlug] = useState(null);
  const [b, setB] = useState({ auth_method: 'none', ssid: '', controller_url: '', site_id: 'default', auth_minutes: 1440 });
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
        setB({ auth_method: st.auth_method || 'none', ssid: st.ssid || '', controller_url: st.controller_url || '', site_id: st.site_id || 'default', auth_minutes: st.auth_minutes || 1440 });
      } catch {} finally { setLoading(false); }
    })();
  }, []);

  const portalUrl = useMemo(() => (slug ? customerUrl(slug, '/wifi') : 'https://<your-venue>.serv-os.app/wifi'), [slug]);
  const set = (patch) => setB(x => ({ ...x, ...patch }));

  const saveBinding = async (extra = {}) => {
    setSave({ busy: true });
    try {
      const binding = { auth_method: b.auth_method, ssid: b.ssid || null, controller_url: b.controller_url || null, site_id: b.site_id || null, auth_minutes: Number(b.auth_minutes) || 1440, ...extra };
      const { data, error } = await supabase.functions.invoke('wifi-admin', { body: { action: 'save_binding', ops_location_id: locId, binding } });
      if (error) { let j = null; try { j = await error.context?.json?.(); } catch {} throw new Error(j?.error || error.message); }
      if (data?.error) throw new Error(data.error);
      // refresh status
      const { data: cfg } = await supabase.functions.invoke('wifi-admin', { body: { action: 'get_config', ops_location_id: locId } });
      setStatus(cfg?.binding_status || status); setCodes('');
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
      <div style={S.sub}>Connect this venue's UniFi guest network to your branded portal, and load the passes that get guests online.</div>

      <div style={S.card}>
        <h2 style={S.h2}>How guests get online</h2>
        <div style={{ display: 'grid', gap: 8 }}>
          {METHODS.map(([k, t, d]) => (
            <label key={k} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '10px 12px', border: `1px solid ${b.auth_method === k ? 'var(--acc)' : 'var(--bdr2)'}`, borderRadius: 10, cursor: 'pointer', background: b.auth_method === k ? 'color-mix(in srgb, var(--acc) 8%, transparent)' : 'var(--bg2)' }}>
              <input type="radio" name="authm" checked={b.auth_method === k} onChange={() => set({ auth_method: k })} style={{ marginTop: 3, accentColor: 'var(--acc)' }} />
              <span><span style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--t1)' }}>{t}</span><div style={S.hint}>{d}</div></span>
            </label>
          ))}
          <div style={{ ...S.hint, opacity: 0.8 }}>Seamless “authorize directly on the controller” is added once we test against your UniFi hardware.</div>
        </div>
        <div style={{ marginTop: 14, display: 'flex', gap: 12, alignItems: 'center' }}>
          <button style={S.btn} onClick={() => saveBinding()} disabled={save.busy}>{save.busy ? 'Saving…' : 'Save'}</button>
          {save.done && <span style={S.ok}>✓ Saved</span>}{save.err && <span style={S.err}>{save.err}</span>}
        </div>
      </div>

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
        <div style={S.step}><span style={S.num}>4</span><span>For the voucher method: in <b>Hotspot Manager → Vouchers</b> generate a batch, then paste them above.</span></div>
        <div style={{ ...S.hint, marginTop: 8 }}>We'll confirm the exact voucher hand-back against your UniFi Express 7 when it arrives — the capture side already works without any of this.</div>
      </div>

      <div style={S.card}>
        <h2 style={S.h2}>Status &amp; test</h2>
        <div style={{ fontSize: 12.5, color: 'var(--t2)', lineHeight: 1.7 }}>
          Method: <b>{status?.auth_method || 'none'}</b>{status?.last_authorize_at && <> · last authorize {new Date(status.last_authorize_at).toLocaleString('en-GB')}</>}{status?.last_error && <> · <span style={S.err}>{status.last_error}</span></>}
        </div>
        <div style={{ marginTop: 12, display: 'flex', gap: 12, alignItems: 'center' }}>
          <button style={S.ghost} onClick={runTest} disabled={test?.busy}>{test?.busy ? 'Testing…' : 'Test authorize'}</button>
          {test?.result && <span style={{ fontSize: 12.5, color: test.result.authorized ? 'var(--grn)' : 'var(--t3)' }}>{test.result.authorized ? `✓ ${test.result.auth_method}` : (test.result.message || 'not authorized')}</span>}
          {test?.err && <span style={S.err}>{test.err}</span>}
        </div>
      </div>
    </div>
  );
}
