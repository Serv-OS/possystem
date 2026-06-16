// src/surfaces/WifiSurface.jsx
//
// PUBLIC WiFi captive-portal page (no auth). A guest connects to the venue's guest WLAN,
// UniFi redirects them here with their device identity in the URL (id=MAC, ap, t, url, ssid).
// They fill the branded form → we capture them into the CRM (wifi-capture) → authorize them
// onto WiFi (voucher hand-back when the venue is set up; capture-only until then).
//
// UK GDPR/PECR: WiFi is NEVER gated on the marketing tick (one "Connect" button; consent is the
// optional checkbox). DOB required + 18+ gate (under-18 connects but can't opt into marketing).
// Mirrors the Review Manager surface pattern (branded light card, venue online_branding).

import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';

const FALLBACK_ACCENT = '#15C36B';

async function callWifi(body) {
  if (!supabase) return { mock: true };
  const { data, error } = await supabase.functions.invoke('wifi-capture', { body });
  if (error) {
    let msg = error.message || 'Something went wrong';
    try { const b = await error.context?.json?.(); if (b?.error) msg = b.error; } catch { /* keep */ }
    throw new Error(msg);
  }
  if (data?.error) throw new Error(data.error);
  return data;
}

// Read UniFi captive-portal redirect params (present when a real guest is redirected here).
function readUnifiParams() {
  try {
    const p = new URLSearchParams(window.location.search || '');
    return {
      client_mac: p.get('id') || p.get('mac') || null,
      ap_mac: p.get('ap') || null,
      ssid: p.get('ssid') || null,
      orig_url: p.get('url') || null,
    };
  } catch { return { client_mac: null, ap_mac: null, ssid: null, orig_url: null }; }
}

const DEFAULT_FIELDS = {
  email: { show: true, required: true },
  phone: { show: true, required: false },
  first_name: { show: true, required: true },
  last_name: { show: true, required: false },
  dob: { show: true, required: true },
  is_local: { show: true, required: false },
};

function ageFrom(dob) {
  if (!dob) return null;
  const d = new Date(dob); if (isNaN(d.getTime())) return null;
  const n = new Date(); let a = n.getFullYear() - d.getFullYear();
  const m = n.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && n.getDate() < d.getDate())) a--;
  return a;
}

export default function WifiSurface({ location }) {
  const brand = location.online_branding || {};
  const venueName = location.name || 'us';
  const unifi = useMemo(readUnifiParams, []);

  const [cfg, setCfg] = useState(null);
  // 'checking' first when we have a device id (try a silent reconnect); else straight to the form.
  const [phase, setPhase] = useState(unifi.client_mac ? 'checking' : 'form');  // checking | form | connecting | connected | error
  const [form, setForm] = useState({ email: '', phone: '', first_name: '', last_name: '', dob: '', is_local: false });
  const [marketing, setMarketing] = useState(false);
  const [joinLoyalty, setJoinLoyalty] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);

  // Bounce the captive browser to its original check URL so the OS re-tests and drops the sign-in screen.
  const releaseDevice = () => {
    const rel = unifi.orig_url || cfg?.redirect_url || 'http://captive.apple.com/hotspot-detect.html';
    setTimeout(() => { try { window.location.href = rel; } catch { /* user taps the button */ } }, 1600);
  };

  useEffect(() => {
    let off = false;
    callWifi({ action: 'portal_config', platform_location_id: location.id })
      .then((c) => { if (!off) setCfg(c || {}); })
      .catch(() => { if (!off) setCfg({}); });
    return () => { off = true; };
  }, [location.id]);

  // Seamless return: if this device signed up here before, authorise it instantly — no form.
  useEffect(() => {
    if (!unifi.client_mac) return;
    let off = false;
    callWifi({ action: 'reconnect', platform_location_id: location.id, client_mac: unifi.client_mac, ap_mac: unifi.ap_mac, ssid: unifi.ssid })
      .then((r) => {
        if (off) return;
        if (r?.returning && r?.authorized) { setResult(r); setPhase('connected'); releaseDevice(); }
        else setPhase('form');   // new device (or couldn't auto-authorise) → collect details
      })
      .catch(() => { if (!off) setPhase('form'); });
    return () => { off = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.id]);

  const fields = cfg?.fields || DEFAULT_FIELDS;
  const accent = cfg?.accent_color || brand.accent_color || brand.primary_color || FALLBACK_ACCENT;
  const logo = cfg?.logo_url || brand.logo_url || null;
  const bg = cfg?.bg_image_url || null;
  const ageGate = cfg?.age_gate !== false;
  const age = ageFrom(form.dob);
  const isMinor = ageGate && age != null && age < 18;
  const btnBg = cfg?.button_style === 'accent' ? accent : '#1f1f24';

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const validate = () => {
    const need = (k) => fields[k]?.show && fields[k]?.required;
    if (need('email') && !form.email.trim()) return 'Please enter your email.';
    if (form.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.email.trim())) return 'That email doesn’t look right.';
    if (need('phone') && !form.phone.trim()) return 'Please enter your phone number.';
    if (need('first_name') && !form.first_name.trim()) return 'Please enter your first name.';
    if (need('last_name') && !form.last_name.trim()) return 'Please enter your last name.';
    if (need('dob') && !form.dob) return 'Please enter your date of birth.';
    if (form.dob && (age == null || age < 0 || age > 120)) return 'Please enter a valid date of birth.';
    if (!form.email.trim() && !form.phone.trim()) return 'Please enter an email or phone number.';
    return '';
  };

  const connect = async () => {
    const v = validate();
    if (v) { setError(v); return; }
    setError(''); setPhase('connecting');
    try {
      const r = await callWifi({
        action: 'capture', platform_location_id: location.id,
        email: form.email.trim() || null, phone: form.phone.trim() || null,
        first_name: form.first_name.trim() || null, last_name: form.last_name.trim() || null,
        dob: form.dob || null, is_local: fields.is_local?.show ? form.is_local : null,
        marketing_consent: (cfg?.loyalty_offer ? joinLoyalty : marketing) && !isMinor,
        join_loyalty: cfg?.loyalty_offer ? (joinLoyalty && !isMinor) : false,
        consent_text: (cfg?.loyalty_offer ? cfg?.loyalty_copy : cfg?.marketing_copy) || null, privacy_version: cfg?.privacy_version || null,
        client_mac: unifi.client_mac, ap_mac: unifi.ap_mac, ssid: unifi.ssid,
        user_agent: typeof navigator !== 'undefined' ? navigator.userAgent : null,
      });
      setResult(r);
      // If the venue is live with vouchers, hand the browser to the gateway to get online.
      if (r?.voucher_redirect_url) { window.location.href = r.voucher_redirect_url; return; }
      setPhase('connected');
      // UniFi authorised the device, but the phone's captive screen only drops once the OS re-tests
      // connectivity — bounce it to its original check URL so it notices and releases.
      if (r?.authorized) releaseDevice();
    } catch (e) {
      setError(e.message || 'Could not connect — please try again.');
      setPhase('form');
    }
  };

  const pageStyle = bg
    ? { ...S.page, background: `linear-gradient(rgba(15,15,20,.55), rgba(15,15,20,.7)), url("${bg}")`, backgroundSize: 'cover', backgroundPosition: 'center' }
    : { ...S.page, background: '#0e0e10' };

  return (
    <div style={pageStyle}>
      <div style={S.card}>
        <div style={{ ...S.hero, ...(bg ? {} : { background: `linear-gradient(135deg, ${accent}22, ${accent}08)` }) }}>
          {logo
            ? <img src={logo} alt={venueName} style={{ maxHeight: 60, maxWidth: '72%', objectFit: 'contain' }} />
            : <div style={{ ...S.logoBox, borderColor: `${accent}66`, color: '#1f1f24' }}>{venueName}</div>}
        </div>

        <div style={{ padding: '22px 22px 26px' }}>
          {phase === 'checking' ? (
            <div style={{ textAlign: 'center', padding: '24px 0' }}>
              <div style={{ fontSize: 40, marginBottom: 8 }}>📶</div>
              <h1 style={S.h1}>Getting you online…</h1>
              <p style={S.sub}>Welcome back — reconnecting you to {venueName} WiFi.</p>
            </div>
          ) : phase === 'connected' ? (
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 44, marginBottom: 6 }}>📶</div>
              <h1 style={S.h1}>{cfg?.success_copy || "You're connected. Enjoy your visit!"}</h1>
              {result?.authorized ? (
                <>
                  <p style={S.sub}>You're online! If this screen doesn't close on its own, tap below.</p>
                  <a href={unifi.orig_url || cfg?.redirect_url || 'http://captive.apple.com/hotspot-detect.html'} style={{ ...S.btn, background: btnBg, marginTop: 12, display: 'inline-block', textDecoration: 'none' }}>Open the internet →</a>
                </>
              ) : (
                <>
                  <p style={S.sub}>You're all set. If the internet doesn't open automatically, ask a member of staff.</p>
                  {cfg?.redirect_url && (
                    <a href={cfg.redirect_url} style={{ ...S.btn, background: btnBg, marginTop: 12, display: 'inline-block', textDecoration: 'none' }}>Continue →</a>
                  )}
                </>
              )}
            </div>
          ) : (
            <>
              <h1 style={S.h1}>{cfg?.headline || 'Connect to free WiFi'}</h1>
              <p style={S.sub}>{cfg?.subtext || `Pop in your details and you're online at ${venueName}.`}</p>

              <div style={{ display: 'grid', gap: 10 }}>
                {fields.first_name?.show && (
                  <div style={S.row2}>
                    <input style={S.input} placeholder={`First name${fields.first_name?.required ? '' : ' (optional)'}`} value={form.first_name} onChange={(e) => set('first_name', e.target.value)} />
                    {fields.last_name?.show && <input style={S.input} placeholder={`Last name${fields.last_name?.required ? '' : ' (optional)'}`} value={form.last_name} onChange={(e) => set('last_name', e.target.value)} />}
                  </div>
                )}
                {fields.email?.show && (
                  <input style={S.input} type="email" inputMode="email" placeholder={`Email${fields.email?.required ? '' : ' (optional)'}`} value={form.email} onChange={(e) => set('email', e.target.value)} />
                )}
                {fields.phone?.show && (
                  <input style={S.input} type="tel" inputMode="tel" placeholder={`Mobile${fields.phone?.required ? '' : ' (optional)'}`} value={form.phone} onChange={(e) => set('phone', e.target.value)} />
                )}
                {fields.dob?.show && (
                  <label style={S.dobWrap}>
                    <span style={S.dobLabel}>Date of birth{fields.dob?.required ? '' : ' (optional)'}</span>
                    <input style={S.dobInput} type="date" max={new Date().toISOString().slice(0, 10)} value={form.dob} onChange={(e) => set('dob', e.target.value)} />
                  </label>
                )}
                {fields.is_local?.show && (
                  <label style={S.check}>
                    <input type="checkbox" checked={form.is_local} onChange={(e) => set('is_local', e.target.checked)} style={S.checkbox} />
                    <span>Are you local?</span>
                  </label>
                )}
              </div>

              {/* Opt-in (unticked) — WiFi is never gated on this. When the venue offers loyalty,
                  one "Join rewards" tick = marketing consent + loyalty enrolment. */}
              <label style={{ ...S.check, marginTop: 14, alignItems: 'flex-start', opacity: isMinor ? 0.5 : 1 }}>
                {cfg?.loyalty_offer ? (
                  <>
                    <input type="checkbox" checked={joinLoyalty && !isMinor} disabled={isMinor} onChange={(e) => setJoinLoyalty(e.target.checked)} style={{ ...S.checkbox, marginTop: 2 }} />
                    <span style={{ fontSize: 12.5, color: '#56565e', lineHeight: 1.45 }}>
                      {cfg?.loyalty_copy || 'Join our rewards — earn points and get exclusive offers by email & SMS.'}
                      {isMinor && <em style={{ display: 'block', color: '#b06a3c', marginTop: 4 }}>You must be 18 or over to join rewards — you can still use the WiFi.</em>}
                    </span>
                  </>
                ) : (
                  <>
                    <input type="checkbox" checked={marketing && !isMinor} disabled={isMinor} onChange={(e) => setMarketing(e.target.checked)} style={{ ...S.checkbox, marginTop: 2 }} />
                    <span style={{ fontSize: 12.5, color: '#56565e', lineHeight: 1.45 }}>
                      {cfg?.marketing_copy || 'Keep me updated with news, offers and events by email and SMS.'}
                      {isMinor && <em style={{ display: 'block', color: '#b06a3c', marginTop: 4 }}>You must be 18 or over to receive marketing — you can still use the WiFi.</em>}
                    </span>
                  </>
                )}
              </label>

              {error && <div style={S.err}>{error}</div>}

              <button onClick={connect} disabled={phase === 'connecting'} style={{ ...S.btn, background: btnBg }}>
                {phase === 'connecting' ? 'Connecting…' : 'Connect to WiFi'}
              </button>

              <div style={S.legal}>
                By connecting you agree to our {cfg?.terms_url ? <a href={cfg.terms_url} target="_blank" rel="noopener noreferrer" style={S.legalLink}>terms</a> : 'terms'}
                {cfg?.privacy_url && <> &amp; <a href={cfg.privacy_url} target="_blank" rel="noopener noreferrer" style={S.legalLink}>privacy policy</a></>}. Marketing is optional and separate from WiFi access.
              </div>
            </>
          )}
        </div>
        <div style={S.footer}>Powered by Serv OS</div>
      </div>
    </div>
  );
}

const S = {
  page: { minHeight: '100vh', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '28px 16px', fontFamily: '"Hanken Grotesk", system-ui, -apple-system, sans-serif' },
  card: { width: '100%', maxWidth: 440, background: '#fff', borderRadius: 26, overflow: 'hidden', boxShadow: '0 14px 40px rgba(0,0,0,0.28)' },
  hero: { padding: '30px 22px', display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 96 },
  logoBox: { border: '1.5px dashed', borderRadius: 12, padding: '12px 20px', fontSize: 18, fontWeight: 800, letterSpacing: '-0.01em' },
  h1: { fontSize: 22, fontWeight: 800, color: '#1f1f24', margin: '0 0 8px', letterSpacing: '-0.02em', lineHeight: 1.2 },
  sub: { fontSize: 14, color: '#56565e', margin: '0 0 18px', lineHeight: 1.5 },
  row2: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 },
  input: { width: '100%', boxSizing: 'border-box', border: '1px solid #ececef', borderRadius: 10, padding: '13px 14px', fontSize: 15, fontFamily: 'inherit', outline: 'none', color: '#1f1f24', background: '#fafafb' },
  dobWrap: { display: 'flex', flexDirection: 'column', gap: 4 },
  dobLabel: { fontSize: 11.5, fontWeight: 700, color: '#8a8a92', letterSpacing: '0.04em', paddingLeft: 2 },
  dobInput: { width: '100%', boxSizing: 'border-box', border: '1px solid #ececef', borderRadius: 10, padding: '12px 14px', fontSize: 15, fontFamily: 'inherit', outline: 'none', color: '#1f1f24', background: '#fafafb' },
  check: { display: 'flex', alignItems: 'center', gap: 10, fontSize: 14, color: '#1f1f24', cursor: 'pointer' },
  checkbox: { width: 18, height: 18, accentColor: '#15C36B', flexShrink: 0 },
  btn: { width: '100%', marginTop: 16, padding: '15px', borderRadius: 12, color: '#fff', border: 'none', fontSize: 16, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' },
  err: { marginTop: 12, fontSize: 13, color: '#b06a3c', fontWeight: 600 },
  legal: { marginTop: 14, fontSize: 11, color: '#9a9aa2', lineHeight: 1.5, textAlign: 'center' },
  legalLink: { color: '#56565e', textDecoration: 'underline' },
  footer: { textAlign: 'center', fontSize: 11, color: '#9a9aa2', padding: '14px', borderTop: '1px solid #f0f0f3', fontFamily: '"Spline Sans Mono", ui-monospace, monospace', letterSpacing: '0.06em' },
};
