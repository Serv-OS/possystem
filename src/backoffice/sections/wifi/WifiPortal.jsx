// src/backoffice/sections/wifi/WifiPortal.jsx
//
// "Your page" — the branded WiFi captive portal, edited in the back office with a LIVE
// phone preview of exactly what the guest sees. Left: wording + which fields to show/require
// + look (background/logo/colour) + compliance links. Right: live preview. Plus the shareable
// link + QR. The portal lives at customerUrl(slug, '/wifi'). Saves via wifi-admin. Mirrors ReviewCard.

import { useEffect, useMemo, useState } from 'react';
import { supabase, platformSupabase, getActiveLocationSync } from '../../../lib/supabase';
import { customerUrl } from '../../../lib/env';
import QRCode from 'qrcode';

const FALLBACK_ACCENT = '#15C36B';
const ASSET_BUCKET = 'receipt-assets';
const FIELD_LABELS = [['first_name', 'First name'], ['last_name', 'Last name'], ['email', 'Email'], ['phone', 'Mobile'], ['dob', 'Date of birth'], ['is_local', '“Are you local?”']];
const DEFAULT_FIELDS = {
  email: { show: true, required: true }, phone: { show: true, required: false },
  first_name: { show: true, required: true }, last_name: { show: true, required: false },
  dob: { show: true, required: true }, is_local: { show: true, required: false },
};
const DEFAULTS = {
  enabled: true, headline: 'Connect to free WiFi', subtext: '',
  marketing_copy: 'Keep me updated with news, offers and events by email and SMS.',
  success_copy: "You're connected. Enjoy your visit!",
  button_style: 'dark', age_gate: true, bg_image_url: '', logo_url: '', terms_url: '', privacy_url: '',
  fields: DEFAULT_FIELDS,
};

async function uploadAsset(file, opsId, kind) {
  const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
  const path = `locations/${opsId}/wifi/${kind}.${ext}`;
  const { error } = await supabase.storage.from(ASSET_BUCKET).upload(path, file, { upsert: true, contentType: file.type });
  if (error) throw error;
  const { data } = supabase.storage.from(ASSET_BUCKET).getPublicUrl(path);
  return `${data.publicUrl}?t=${Date.now()}`;
}

const S = {
  h1: { fontSize: 22, fontWeight: 800, color: 'var(--t1)', margin: 0, letterSpacing: '-.01em' },
  sub: { fontSize: 13, color: 'var(--t3)', marginTop: 4, marginBottom: 18 },
  grid: { display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 300px', gap: 20, alignItems: 'start' },
  card: { border: '1px solid var(--bdr)', borderRadius: 14, background: 'var(--bg1)', padding: 18, marginBottom: 16 },
  h2: { fontSize: 15.5, fontWeight: 800, color: 'var(--t1)', margin: '0 0 12px' },
  label: { display: 'block', fontSize: 12, fontWeight: 700, color: 'var(--t2)', marginBottom: 6 },
  input: { width: '100%', boxSizing: 'border-box', border: '1px solid var(--bdr2)', borderRadius: 10, padding: '9px 12px', fontSize: 13.5, fontFamily: 'inherit', color: 'var(--t1)', background: 'var(--bg2)', outline: 'none' },
  area: { width: '100%', boxSizing: 'border-box', minHeight: 54, border: '1px solid var(--bdr2)', borderRadius: 10, padding: '9px 12px', fontSize: 13.5, fontFamily: 'inherit', color: 'var(--t1)', background: 'var(--bg2)', outline: 'none', resize: 'vertical', lineHeight: 1.5 },
  field: { marginBottom: 14 },
  hint: { fontSize: 11.5, color: 'var(--t4)', marginTop: 5, lineHeight: 1.45 },
  btn: { padding: '8px 16px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'inherit', background: 'var(--acc)', color: '#0b0c10' },
  ghost: { padding: '7px 12px', borderRadius: 8, cursor: 'pointer', fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit', background: 'transparent', color: 'var(--t2)', border: '1px solid var(--bdr2)' },
  ok: { fontSize: 12.5, color: 'var(--grn)', fontWeight: 700 },
  err: { fontSize: 12, color: 'var(--red)' },
  empty: { textAlign: 'center', padding: '60px 20px', color: 'var(--t3)', fontSize: 14 },
  linkBox: { display: 'flex', gap: 8, alignItems: 'center', border: '1px solid var(--bdr2)', borderRadius: 10, padding: '8px 10px', background: 'var(--bg2)' },
  frow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '7px 0', borderBottom: '1px solid var(--bdr)' },
  toggle: (on) => ({ padding: '4px 10px', borderRadius: 99, border: '1px solid var(--bdr2)', cursor: 'pointer', fontSize: 11.5, fontWeight: 700, fontFamily: 'inherit', background: on ? 'var(--acc)' : 'var(--bg2)', color: on ? '#0b0c10' : 'var(--t3)' }),
};

export default function WifiPortal() {
  const [locId, setLocId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [venue, setVenue] = useState({ name: 'Your venue', slug: null, branding: {} });
  const [cfg, setCfg] = useState(DEFAULTS);
  const [save, setSave] = useState({});
  const [qr, setQr] = useState(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const id = await getActiveLocationSync();
        setLocId(id);
        if (!supabase || !id) { setLoading(false); return; }
        let v = { name: 'Your venue', slug: null, branding: {} };
        try {
          const { data: loc } = await platformSupabase.from('locations').select('name, online_slug, online_branding').or(`ops_location_id.eq.${id},id.eq.${id}`).maybeSingle();
          if (loc) v = { name: loc.name || 'Your venue', slug: loc.online_slug || null, branding: loc.online_branding || {} };
        } catch { /* brand best-effort */ }
        setVenue(v);
        const { data } = await supabase.functions.invoke('wifi-admin', { body: { action: 'get_config', ops_location_id: id } });
        const s = data?.settings || {};
        setCfg({ ...DEFAULTS, ...Object.fromEntries(Object.entries(s).filter(([, v]) => v != null)), fields: s.fields || DEFAULT_FIELDS });
      } catch { /* defaults */ }
      finally { setLoading(false); }
    })();
  }, []);

  const portalUrl = useMemo(() => (venue.slug ? customerUrl(venue.slug, '/wifi') : null), [venue.slug]);
  useEffect(() => { if (!portalUrl) { setQr(null); return; } QRCode.toDataURL(portalUrl, { width: 480, margin: 1 }).then(setQr).catch(() => setQr(null)); }, [portalUrl]);

  const accent = cfg.accent_color || venue.branding?.accent_color || venue.branding?.primary_color || FALLBACK_ACCENT;
  const logo = cfg.logo_url || venue.branding?.logo_url || null;
  const set = (patch) => setCfg(c => ({ ...c, ...patch }));

  const doSave = async (next = cfg) => {
    setSave({ busy: true });
    try {
      const { data, error } = await supabase.functions.invoke('wifi-admin', { body: { action: 'save_settings', ops_location_id: locId, settings: next } });
      if (error) { let b = null; try { b = await error.context?.json?.(); } catch {} throw new Error(b?.error || error.message); }
      if (data?.error) throw new Error(data.error);
      setSave({ done: true }); setTimeout(() => setSave(s => (s.done ? {} : s)), 2200);
    } catch (e) { setSave({ err: e.message || 'Save failed' }); }
  };
  // Look/field toggles save immediately; wording uses the Save button.
  const persist = async (patch) => { const next = { ...cfg, ...patch }; setCfg(next); try { await supabase.functions.invoke('wifi-admin', { body: { action: 'save_settings', ops_location_id: locId, settings: next } }); } catch (e) { setSave({ err: e.message }); } };
  const toggleField = (key, prop) => { const f = cfg.fields || DEFAULT_FIELDS; const cur = f[key] || { show: false, required: false }; const nextField = { ...cur, [prop]: !cur[prop] }; if (prop === 'show' && !nextField.show) nextField.required = false; persist({ fields: { ...f, [key]: nextField } }); };
  const onFile = async (kind, e) => { const file = e.target.files?.[0]; if (!file) return; setBusy(kind); setSave({}); try { const url = await uploadAsset(file, locId, kind); await persist({ [kind === 'background' ? 'bg_image_url' : 'logo_url']: url }); } catch (err) { setSave({ err: err.message || 'Upload failed' }); } finally { setBusy(''); } };
  const copyLink = async () => { try { await navigator.clipboard.writeText(portalUrl); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch {} };

  if (loading) return <div style={S.empty}>Loading…</div>;
  if (!supabase || !locId) return <div style={S.empty}>{!locId ? 'Pick a location to manage its WiFi page.' : 'Mock mode — connect Supabase to manage the WiFi page.'}</div>;

  const fields = cfg.fields || DEFAULT_FIELDS;
  return (
    <div>
      <h1 style={S.h1}>Your WiFi page</h1>
      <div style={S.sub}>The branded page guests see when they connect to your guest WiFi. Edit it on the left; the preview is exactly what they get.</div>
      <div style={S.grid}>
        <div>
          <div style={S.card}>
            <h2 style={S.h2}>Wording</h2>
            <div style={S.field}><label style={S.label}>Headline</label><input style={S.input} value={cfg.headline} maxLength={60} onChange={e => set({ headline: e.target.value })} /></div>
            <div style={S.field}><label style={S.label}>Sub-text</label><input style={S.input} value={cfg.subtext} maxLength={120} onChange={e => set({ subtext: e.target.value })} placeholder="Pop in your details and you're online." /></div>
            <div style={S.field}><label style={S.label}>Marketing opt-in wording</label><textarea style={S.area} value={cfg.marketing_copy} onChange={e => set({ marketing_copy: e.target.value })} /><div style={S.hint}>Exact text shown next to the (unticked) opt-in box. Stored with each consent for your records.</div></div>
            <div style={S.field}><label style={S.label}>“You're connected” message</label><input style={S.input} value={cfg.success_copy} maxLength={120} onChange={e => set({ success_copy: e.target.value })} /></div>
            <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
              <button style={S.btn} onClick={() => doSave()} disabled={save.busy}>{save.busy ? 'Saving…' : 'Save wording'}</button>
              {save.done && <span style={S.ok}>✓ Saved</span>}{save.err && <span style={S.err}>{save.err}</span>}
            </div>
          </div>

          <div style={S.card}>
            <h2 style={S.h2}>Fields to capture</h2>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', gap: '0 14px', alignItems: 'center', fontSize: 11.5, fontWeight: 700, color: 'var(--t4)', paddingBottom: 6, borderBottom: '1px solid var(--bdr)' }}>
              <span>Field</span><span>Show</span><span>Required</span>
            </div>
            {FIELD_LABELS.map(([key, label]) => { const f = fields[key] || { show: false, required: false }; return (
              <div key={key} style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', gap: '0 14px', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid var(--bdr)' }}>
                <span style={{ fontSize: 13, color: 'var(--t1)' }}>{label}</span>
                <button style={S.toggle(f.show)} onClick={() => toggleField(key, 'show')}>{f.show ? 'On' : 'Off'}</button>
                <button style={{ ...S.toggle(f.required && f.show), opacity: f.show ? 1 : 0.4 }} disabled={!f.show} onClick={() => toggleField(key, 'required')}>{f.required ? 'Yes' : 'No'}</button>
              </div>
            ); })}
            <div style={{ ...S.field, marginTop: 14, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div><div style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)' }}>Require 18+ for marketing</div><div style={S.hint}>Under-18s can still use the WiFi but can't opt into marketing (UK rules).</div></div>
              <button style={S.toggle(cfg.age_gate)} onClick={() => persist({ age_gate: !cfg.age_gate })}>{cfg.age_gate ? 'On' : 'Off'}</button>
            </div>
          </div>

          <div style={S.card}>
            <h2 style={S.h2}>Look</h2>
            <div style={S.field}><label style={S.label}>Background image</label>
              {cfg.bg_image_url ? (<div style={{ display: 'flex', gap: 12, alignItems: 'center' }}><img src={cfg.bg_image_url} alt="bg" style={{ width: 96, height: 60, objectFit: 'cover', borderRadius: 8, border: '1px solid var(--bdr)' }} /><label style={{ ...S.ghost, display: 'inline-block' }}>{busy === 'background' ? 'Uploading…' : 'Replace'}<input type="file" accept="image/*" onChange={e => onFile('background', e)} style={{ display: 'none' }} /></label><button style={S.ghost} onClick={() => persist({ bg_image_url: '' })}>Remove</button></div>)
                : (<label style={{ ...S.ghost, display: 'inline-block' }}>{busy === 'background' ? 'Uploading…' : 'Upload background'}<input type="file" accept="image/*" onChange={e => onFile('background', e)} style={{ display: 'none' }} /></label>)}
              <div style={S.hint}>A photo of your venue works well. Sits behind the card with a dark overlay.</div></div>
            <div style={S.field}><label style={S.label}>Logo (optional — defaults to your brand logo)</label>
              {cfg.logo_url ? (<div style={{ display: 'flex', gap: 12, alignItems: 'center' }}><img src={cfg.logo_url} alt="logo" style={{ height: 40, maxWidth: 120, objectFit: 'contain', borderRadius: 6, border: '1px solid var(--bdr)', background: '#fff', padding: 4 }} /><button style={S.ghost} onClick={() => persist({ logo_url: '' })}>Remove</button></div>)
                : (<label style={{ ...S.ghost, display: 'inline-block' }}>{busy === 'logo' ? 'Uploading…' : 'Upload logo'}<input type="file" accept="image/*" onChange={e => onFile('logo', e)} style={{ display: 'none' }} /></label>)}</div>
            <div style={S.field}><label style={S.label}>Button style</label><div style={{ display: 'flex', gap: 8 }}>{[['dark', 'Dark'], ['accent', 'Brand colour']].map(([k, l]) => <button key={k} onClick={() => persist({ button_style: k })} style={{ padding: '8px 14px', borderRadius: 8, border: '1px solid var(--bdr2)', cursor: 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'inherit', background: cfg.button_style === k ? 'var(--acc)' : 'var(--bg2)', color: cfg.button_style === k ? '#0b0c10' : 'var(--t2)' }}>{l}</button>)}</div></div>
          </div>

          <div style={S.card}>
            <h2 style={S.h2}>Legal links</h2>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div style={S.field}><label style={S.label}>Terms URL</label><input style={S.input} value={cfg.terms_url} onChange={e => set({ terms_url: e.target.value })} placeholder="https://…" /></div>
              <div style={S.field}><label style={S.label}>Privacy policy URL</label><input style={S.input} value={cfg.privacy_url} onChange={e => set({ privacy_url: e.target.value })} placeholder="https://…" /></div>
            </div>
            <button style={S.btn} onClick={() => doSave()} disabled={save.busy}>{save.busy ? 'Saving…' : 'Save links'}</button>
            <div style={S.hint}>Shown under the Connect button. You (the venue) are the data controller; Serv OS is the processor.</div>
          </div>

          <div style={S.card}>
            <h2 style={S.h2}>Share / set up</h2>
            {portalUrl ? (<>
              <label style={S.label}>Portal link (point your UniFi external portal here)</label>
              <div style={S.linkBox}><span style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: 'var(--t2)', fontFamily: 'var(--font-mono,monospace)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{portalUrl}</span><button style={S.ghost} onClick={copyLink}>{copied ? 'Copied ✓' : 'Copy'}</button></div>
              <div style={{ display: 'flex', gap: 16, alignItems: 'center', marginTop: 14 }}>{qr && <img src={qr} alt="QR" width={104} height={104} style={{ borderRadius: 8, border: '1px solid var(--bdr)' }} />}<div style={{ fontSize: 12.5, color: 'var(--t3)', lineHeight: 1.5 }}>Test it now by opening the link. To get guests online via WiFi, finish <b>Setup</b>. {qr && <a href={qr} download={`wifi-qr-${venue.slug}.png`} style={{ color: 'var(--acc)', fontWeight: 700 }}>Download QR</a>}</div></div>
            </>) : <div style={S.hint}>This venue has no online slug yet — set one in Settings → Location → online ordering to get a shareable WiFi link.</div>}
          </div>
        </div>

        <div style={{ position: 'sticky', top: 8 }}>
          <Phone accent={accent} logo={logo} venue={venue.name} cfg={cfg} fields={fields} />
        </div>
      </div>
    </div>
  );
}

// Faithful mini-render of WifiSurface.
function Phone({ accent, logo, venue, cfg, fields }) {
  const bg = cfg.bg_image_url || null;
  const btnBg = cfg.button_style === 'accent' ? accent : '#1f1f24';
  const screenBg = bg ? { background: `linear-gradient(rgba(15,15,20,.55), rgba(15,15,20,.7)), url("${bg}") center/cover` } : { background: '#0e0e10' };
  const heroStyle = bg ? {} : { background: `linear-gradient(135deg, ${accent}22, ${accent}08)` };
  const P = {
    frame: { width: 280, margin: '0 auto', background: '#0e0e10', borderRadius: 30, padding: 9 },
    screen: { ...screenBg, borderRadius: 22, padding: 14, fontFamily: '"Hanken Grotesk",system-ui,sans-serif' },
    cardEl: { background: '#fff', borderRadius: 20, overflow: 'hidden' },
    hero: { padding: '18px 14px', display: 'flex', alignItems: 'center', justifyContent: 'center', ...heroStyle },
    logo: { border: `1.5px dashed ${accent}66`, borderRadius: 9, padding: '8px 14px', fontSize: 13, fontWeight: 800, color: '#1f1f24' },
    body: { padding: '14px 14px 16px' },
    title: { fontSize: 15, fontWeight: 800, color: '#1f1f24', letterSpacing: '-.02em', margin: '0 0 4px' },
    sub: { fontSize: 10.5, color: '#56565e', lineHeight: 1.4, margin: '0 0 10px' },
    inp: { border: '1px solid #ececef', borderRadius: 8, background: '#fafafb', padding: '7px 9px', fontSize: 10, color: '#9a9aa2', marginBottom: 6 },
    dark: { background: btnBg, color: '#fff', borderRadius: 8, padding: 9, textAlign: 'center', fontSize: 12, fontWeight: 700, marginTop: 4 },
    chk: { display: 'flex', gap: 6, fontSize: 9, color: '#56565e', marginTop: 8, lineHeight: 1.3 },
  };
  const show = (k) => fields[k]?.show;
  return (
    <div style={P.frame}><div style={P.screen}><div style={P.cardEl}>
      <div style={P.hero}>{logo ? <img src={logo} alt={venue} style={{ maxHeight: 38, maxWidth: '70%', objectFit: 'contain' }} /> : <div style={P.logo}>{venue}</div>}</div>
      <div style={P.body}>
        <div style={P.title}>{cfg.headline || 'Connect to free WiFi'}</div>
        <div style={P.sub}>{cfg.subtext || `Pop in your details and you're online at ${venue}.`}</div>
        {(show('first_name') || show('last_name')) && <div style={{ display: 'flex', gap: 6 }}>{show('first_name') && <div style={{ ...P.inp, flex: 1 }}>First name</div>}{show('last_name') && <div style={{ ...P.inp, flex: 1 }}>Last name</div>}</div>}
        {show('email') && <div style={P.inp}>Email</div>}
        {show('phone') && <div style={P.inp}>Mobile</div>}
        {show('dob') && <div style={P.inp}>Date of birth</div>}
        {show('is_local') && <div style={{ ...P.chk, marginTop: 2 }}><span style={{ width: 12, height: 12, border: '1px solid #c9c9cf', borderRadius: 3 }} />Are you local?</div>}
        <div style={P.chk}><span style={{ width: 12, height: 12, border: '1px solid #c9c9cf', borderRadius: 3, flexShrink: 0 }} /><span>{cfg.marketing_copy}</span></div>
        <div style={P.dark}>Connect to WiFi</div>
      </div>
    </div></div></div>
  );
}
