// Back office → Channels → Appearance → "App branding" (v5.12.70). The customer app's theme:
// identity, logos and icon, accent with the contrast readout, typefaces, radius, money and
// language, module switches, support links, and a live preview drawn from the same payload the
// app fetches. Saves through customer-app-admin (the only writer of tenant_app_config); installed
// apps pick the change up on their next launch. Rules live in _shared/customerAppBrand.js.
import { useEffect, useMemo, useRef, useState } from 'react';
import { supabase, getActiveLocationSync } from '../../../lib/supabase';
import { Icon } from '../../../components/ServOSIcons';
import {
  BODY_FACES, CURRENCIES, DISPLAY_FACES, LOCALES, MODULES, RADIUS_MAX, RADIUS_MIN, MAX_ASSET_BYTES, ASSET_TYPES,
  accentReadout, bundleIdFor, cleanPayload, formProblems, isHex, slugify, withFormDefaults,
} from '../../../../supabase/functions/_shared/customerAppBrand.js';

const S = {
  card: { border: '1px solid var(--bdr)', borderRadius: 14, background: 'var(--bg1)', padding: 18, marginBottom: 16 },
  h2: { fontSize: 11, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--t3)', margin: '0 0 12px' },
  label: { display: 'block', fontSize: 12, fontWeight: 700, color: 'var(--t2)', marginBottom: 6 },
  input: { width: '100%', boxSizing: 'border-box', border: '1px solid var(--bdr2)', borderRadius: 10, padding: '9px 12px', fontSize: 13.5, fontFamily: 'inherit', color: 'var(--t1)', background: 'var(--bg2)' },
  field: { marginBottom: 14 },
  hint: { fontSize: 11.5, color: 'var(--t4)', marginTop: 5 },
  btn: { padding: '9px 18px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 13.5, fontWeight: 700, fontFamily: 'inherit', background: 'var(--acc)', color: '#0b0c10' },
  ghost: { padding: '7px 12px', borderRadius: 8, cursor: 'pointer', fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit', background: 'transparent', color: 'var(--t2)', border: '1px solid var(--bdr2)' },
  row: { display: 'flex', alignItems: 'center', gap: 10 },
  problem: { fontSize: 12.5, color: 'var(--red, #e5484d)', marginTop: 4 },
};

async function callAdmin(body) {
  const { data, error } = await supabase.functions.invoke('customer-app-admin', { body });
  if (error) {
    let b = null;
    try { b = await error.context?.json?.(); } catch { /* not json */ }
    throw new Error(b?.error || error.message);
  }
  if (data?.error) throw new Error(data.error);
  return data;
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(new Error('Could not read the file'));
    r.readAsDataURL(file);
  });
}

function Toggle({ on, onChange, label }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)}
      style={{ width: 42, height: 24, borderRadius: 999, border: 'none', cursor: 'pointer', padding: 2, background: on ? 'var(--acc)' : 'var(--bdr2)', position: 'relative', flexShrink: 0 }}>
      <span style={{ display: 'block', width: 20, height: 20, borderRadius: 999, background: '#fff', transform: on ? 'translateX(18px)' : 'none', transition: 'transform .15s' }} />
    </button>
  );
}

function AssetBox({ label, url, onPick, busy, dark, hint }) {
  const ref = useRef(null);
  return (
    <div>
      <span style={S.label}>{label}</span>
      <div style={{ height: 84, borderRadius: 12, border: '1px dashed var(--bdr2)', background: dark ? '#14110F' : '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
        {url ? <img src={url} alt="" style={{ maxHeight: 64, maxWidth: '90%', objectFit: 'contain' }} /> : <span style={{ fontSize: 12, color: dark ? '#9a918b' : 'var(--t4)' }}>No image yet</span>}
      </div>
      <input ref={ref} type="file" accept="image/png,image/jpeg,image/svg+xml" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) onPick(f); }} />
      <button type="button" style={{ ...S.ghost, marginTop: 8 }} disabled={busy} onClick={() => ref.current?.click()}>{busy ? 'Uploading…' : 'Upload PNG, JPEG or SVG'}</button>
      {hint ? <div style={S.hint}>{hint}</div> : null}
    </div>
  );
}

/** The preview: the same payload the app fetches, drawn as the home screen. */
function PhonePreview({ p }) {
  const read = accentReadout(p.color.accent, p.color.surface);
  const accentText = read.accentText || p.color.accent;
  const r = Number(p.shape.radius) || 26;
  const display = `'${p.type.display}', serif`;
  const body = `'${p.type.body}', sans-serif`;
  useEffect(() => {
    const fam = [p.type.display, p.type.body].map((f) => `family=${encodeURIComponent(f).replace(/%20/g, '+')}:wght@400;600`).join('&');
    const id = 'bo-app-brand-fonts';
    let link = document.getElementById(id);
    if (!link) { link = document.createElement('link'); link.id = id; link.rel = 'stylesheet'; document.head.appendChild(link); }
    link.href = `https://fonts.googleapis.com/css2?${fam}&display=swap`;
  }, [p.type.display, p.type.body]);
  const tabs = [['Home', true], ...(p.modules.ordering ? [['Order', false]] : []), ['Card', false], ['Rewards', false], ['More', false]];
  const money = (minor) => { try { return new Intl.NumberFormat(p.locale, { style: 'currency', currency: p.currency }).format(minor / 100); } catch { return String(minor / 100); } };
  return (
    <div style={{ width: 300, height: 600, borderRadius: 40, border: '8px solid #1a1a1a', background: p.color.surface, overflow: 'hidden', fontFamily: body, color: p.color.ink, position: 'relative', margin: '0 auto', boxShadow: '0 20px 40px rgba(0,0,0,.25)' }}>
      <div style={{ padding: '26px 16px 0', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ width: 22, height: 2, background: p.color.ink, boxShadow: `0 6px 0 ${p.color.ink}, 0 -6px 0 ${p.color.ink}` }} />
        {p.logo.light ? <img src={p.logo.light} alt="" style={{ height: 22, maxWidth: 120, objectFit: 'contain' }} /> : <span style={{ fontFamily: display, fontSize: 22, letterSpacing: '.18em' }}>{(p.displayName || 'APP').toUpperCase()}</span>}
        <span style={{ width: 22 }} />
      </div>
      <div style={{ margin: '14px 16px 0', borderRadius: r, background: accentText, color: p.color.onAccent, padding: 18, minHeight: 130, boxShadow: `0 12px 28px ${accentText}55` }}>
        <div style={{ fontSize: 13, opacity: .86 }}>Welcome back, Peter</div>
        <div style={{ fontFamily: display, fontSize: 48, lineHeight: 1.05, marginTop: 6 }}>1,781</div>
        <div style={{ fontSize: 10.5, letterSpacing: '.12em', textTransform: 'uppercase', marginTop: 10, opacity: .86 }}>Loyalty points</div>
        {p.logo.dark ? <img src={p.logo.dark} alt="" style={{ position: 'absolute', right: 32, top: 78, height: 20, maxWidth: 70, objectFit: 'contain' }} /> : null}
      </div>
      <div style={{ margin: '12px 16px 0', border: `1.5px solid ${p.color.line}`, borderRadius: Math.max(10, r - 8), display: 'flex' }}>
        {[['82', 'Visits'], ['2,781', 'Earned'], ...(p.modules.giftCards ? [[money(14950), 'Gift card']] : [])].map(([v, l]) => (
          <div key={l} style={{ flex: 1, textAlign: 'center', padding: '10px 4px', borderLeft: l === 'Visits' ? 'none' : `1px solid ${p.color.line}` }}>
            <div style={{ fontWeight: 600, fontSize: 15 }}>{v}</div>
            <div style={{ fontSize: 9.5, letterSpacing: '.1em', textTransform: 'uppercase', color: p.color.inkMuted }}>{l}</div>
          </div>
        ))}
      </div>
      <div style={{ margin: '14px 16px 0', display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span style={{ fontWeight: 600, fontSize: 14 }}>Ready to redeem</span><span style={{ fontSize: 12, color: accentText, fontWeight: 600 }}>All rewards</span>
      </div>
      <div style={{ margin: '8px 16px 0', display: 'flex', gap: 8 }}>
        {['Free garlic bread', 'Free coffee'].map((n) => (
          <div key={n} style={{ flex: 1, background: p.color.sunken, borderRadius: Math.max(10, r - 8), padding: 10 }}>
            <div style={{ width: 26, height: 26, borderRadius: 8, background: `${accentText}22`, marginBottom: 6 }} />
            <div style={{ fontSize: 12, fontWeight: 600 }}>{n}</div>
            <div style={{ fontSize: 11, color: p.color.inkMuted }}>100 pts</div>
          </div>
        ))}
      </div>
      {p.modules.stamps ? (
        <div style={{ margin: '12px 16px 0', border: `1.5px solid ${p.color.line}`, borderRadius: Math.max(10, r - 8), padding: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Coffee card · 7 of 10</div>
          <div style={{ display: 'flex', gap: 4 }}>{Array.from({ length: 10 }, (_, i) => <span key={i} style={{ width: 13, height: 13, borderRadius: 999, background: i < 7 ? p.color.accent : 'transparent', border: i < 7 ? 'none' : `1.5px solid ${p.color.line}` }} />)}</div>
        </div>
      ) : null}
      <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, borderTop: `1px solid ${p.color.line}`, background: p.color.surface, display: 'flex', padding: '8px 6px 18px' }}>
        {tabs.map(([l, on]) => (
          <div key={l} style={{ flex: 1, textAlign: 'center', fontSize: 9.5, fontWeight: on ? 600 : 400, color: on ? accentText : p.color.inkMuted }}>
            {l === 'Card' ? <div style={{ width: 36, height: 36, borderRadius: 12, background: accentText, margin: '-22px auto 4px' }} /> : <div style={{ height: 14 }} />}
            {l}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function MobileAppBrand() {
  const [state, setState] = useState({ loading: true, err: null });
  const [p, setP] = useState(null);
  const [saved, setSaved] = useState(null); // { tenantId, version, updatedAt }
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(null);
  const [msg, setMsg] = useState(null); // { kind: 'ok'|'err', text }
  const [idTouched, setIdTouched] = useState(false);
  const opsLocationId = getActiveLocationSync();

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const d = await callAdmin({ action: 'get', ops_location_id: opsLocationId });
        if (!alive) return;
        if (d.tenant) {
          setP(withFormDefaults({ ...d.tenant.payload, tenantId: d.tenant.tenantId }, d.defaults));
          setSaved({ tenantId: d.tenant.tenantId, version: d.tenant.version, updatedAt: d.tenant.updatedAt });
          setIdTouched(true);
        } else {
          setP(d.defaults);
        }
        setState({ loading: false, err: null });
      } catch (e) {
        if (alive) setState({ loading: false, err: e.message || String(e) });
      }
    })();
    return () => { alive = false; };
  }, [opsLocationId]);

  const problems = useMemo(() => (p ? formProblems(p) : []), [p]);
  const readout = useMemo(() => (p ? accentReadout(p.color.accent, p.color.surface) : null), [p]);
  const set = (patch) => setP((cur) => ({ ...cur, ...patch }));
  const setIn = (key, patch) => setP((cur) => ({ ...cur, [key]: { ...cur[key], ...patch } }));

  const setName = (v) => {
    setP((cur) => {
      const next = { ...cur, displayName: v };
      if (!saved && !idTouched) { next.tenantId = slugify(v); next.bundleId = bundleIdFor(next.tenantId); }
      return next;
    });
  };

  const upload = async (kind, file) => {
    if (!p) return;
    if (!ASSET_TYPES[file.type]) return setMsg({ kind: 'err', text: 'PNG, JPEG or SVG only.' });
    if (file.size > MAX_ASSET_BYTES) return setMsg({ kind: 'err', text: 'Image must be under 2 MB.' });
    setUploading(kind); setMsg(null);
    try {
      const base64 = await fileToBase64(file);
      const d = await callAdmin({ action: 'upload', ops_location_id: opsLocationId, tenantId: p.tenantId, kind, contentType: file.type, base64 });
      if (kind === 'icon') set({ icon: d.url });
      else setIn('logo', { [kind === 'logoLight' ? 'light' : 'dark']: d.url });
    } catch (e) {
      setMsg({ kind: 'err', text: e.message || String(e) });
    } finally { setUploading(null); }
  };

  const publish = async () => {
    if (!p || problems.length) return;
    setBusy(true); setMsg(null);
    try {
      const d = await callAdmin({ action: 'save', ops_location_id: opsLocationId, tenantId: p.tenantId, payload: cleanPayload(p) });
      setSaved({ tenantId: d.tenantId, version: d.version, updatedAt: new Date().toISOString() });
      setIdTouched(true);
      setMsg({ kind: 'ok', text: `Published. Version ${d.version}. Installed apps pick it up on their next launch.` });
    } catch (e) {
      setMsg({ kind: 'err', text: e.message || String(e) });
    } finally { setBusy(false); }
  };

  if (state.loading) return <div style={{ padding: 40, color: 'var(--t3)' }}>Loading the app brand…</div>;
  if (state.err) return <div style={{ padding: 40, color: 'var(--red, #e5484d)' }}>Could not load the app brand: {state.err}</div>;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(320px, 440px) 1fr', gap: 24, alignItems: 'start' }}>
      <div>
        <div style={S.card}>
          <h2 style={S.h2}>Identity</h2>
          <div style={S.field}>
            <label style={S.label} htmlFor="app-name">App name</label>
            <input id="app-name" style={S.input} value={p.displayName} maxLength={30} onChange={(e) => setName(e.target.value)} />
            <div style={S.hint}>Shown under the icon and in the app. Changing it after the first build needs a new build.</div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div style={S.field}>
              <label style={S.label} htmlFor="app-id">App id</label>
              <input id="app-id" style={{ ...S.input, opacity: saved ? .7 : 1 }} value={p.tenantId} disabled={!!saved} onChange={(e) => { setIdTouched(true); set({ tenantId: e.target.value.toLowerCase(), bundleId: bundleIdFor(e.target.value.toLowerCase()) }); }} />
              <div style={S.hint}>{saved ? 'Fixed once published.' : 'Lower case letters, digits and dashes.'}</div>
            </div>
            <div style={S.field}>
              <label style={S.label} htmlFor="app-bundle">Bundle id</label>
              <input id="app-bundle" style={S.input} value={p.bundleId || ''} onChange={(e) => set({ bundleId: e.target.value.trim() })} />
              <div style={S.hint}>Registered at Apple and Google. Fixed once the first build is submitted.</div>
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
            <AssetBox label="Logo, light background" url={p.logo.light} busy={uploading === 'logoLight'} onPick={(f) => upload('logoLight', f)} />
            <AssetBox label="Logo, dark background" url={p.logo.dark} dark busy={uploading === 'logoDark'} onPick={(f) => upload('logoDark', f)} />
            <AssetBox label="App icon" url={p.icon} busy={uploading === 'icon'} onPick={(f) => upload('icon', f)} hint="1024 square PNG, no transparency." />
          </div>
          <div style={{ ...S.hint, marginTop: 10 }}>Splash, the Android icon and the store screenshots are generated from these three.</div>
        </div>

        <div style={S.card}>
          <h2 style={S.h2}>Look</h2>
          <div style={S.field}>
            <label style={S.label} htmlFor="app-accent">Accent colour</label>
            <div style={S.row}>
              <input type="color" aria-label="Accent colour picker" value={isHex(p.color.accent) ? p.color.accent : '#A6412F'} onChange={(e) => setIn('color', { accent: e.target.value.toUpperCase() })} style={{ width: 44, height: 36, border: '1px solid var(--bdr2)', borderRadius: 8, padding: 2, background: 'var(--bg2)' }} />
              <input id="app-accent" style={{ ...S.input, width: 130 }} value={p.color.accent} onChange={(e) => setIn('color', { accent: e.target.value.trim() })} onBlur={(e) => { const v = e.target.value.trim(); if (/^[0-9a-f]{6}$/i.test(v)) setIn('color', { accent: `#${v.toUpperCase()}` }); }} />
              {readout && isHex(p.color.accent) ? (
                <span style={{ fontSize: 12.5, color: readout.passes ? 'var(--grn, #3fb950)' : 'var(--t2)' }}>
                  Contrast {readout.ratio}:1, {readout.passes ? 'passes' : <>too pale for text: the app uses <b style={{ color: readout.accentText }}>{readout.accentText}</b> for text and buttons</>}
                </span>
              ) : null}
            </div>
            <div style={S.hint}>Used as given for bars, dots and chips. Text and buttons use the corrected shade when the colour cannot read on white.</div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div style={S.field}>
              <label style={S.label} htmlFor="app-display">Display typeface</label>
              <select id="app-display" style={S.input} value={p.type.display} onChange={(e) => setIn('type', { display: e.target.value })}>{DISPLAY_FACES.map((f) => <option key={f}>{f}</option>)}</select>
              <div style={S.hint}>Headlines and the big balance.</div>
            </div>
            <div style={S.field}>
              <label style={S.label} htmlFor="app-body">Body typeface</label>
              <select id="app-body" style={S.input} value={p.type.body} onChange={(e) => setIn('type', { body: e.target.value })}>{BODY_FACES.map((f) => <option key={f}>{f}</option>)}</select>
              <div style={S.hint}>Stays sans for legibility.</div>
            </div>
          </div>
          <div style={S.field}>
            <label style={S.label} htmlFor="app-radius">Corner radius · {p.shape.radius}px</label>
            <input id="app-radius" type="range" min={RADIUS_MIN} max={RADIUS_MAX} value={p.shape.radius} onChange={(e) => setIn('shape', { radius: Number(e.target.value) })} style={{ width: '100%' }} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div style={S.field}>
              <label style={S.label} htmlFor="app-currency">Money</label>
              <select id="app-currency" style={S.input} value={p.currency} onChange={(e) => set({ currency: e.target.value })}>{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</select>
            </div>
            <div style={S.field}>
              <label style={S.label} htmlFor="app-locale">Language and dates</label>
              <select id="app-locale" style={S.input} value={p.locale} onChange={(e) => set({ locale: e.target.value })}>{LOCALES.map((c) => <option key={c}>{c}</option>)}</select>
            </div>
          </div>
        </div>

        <div style={S.card}>
          <h2 style={S.h2}>Modules in this app</h2>
          {MODULES.map(([key, label, hint]) => (
            <div key={key} style={{ ...S.row, justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--bdr)' }}>
              <div><div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--t1)' }}>{label}</div><div style={S.hint}>{hint}</div></div>
              <Toggle on={!!p.modules[key]} label={label} onChange={(v) => setIn('modules', { [key]: v })} />
            </div>
          ))}
          <div style={{ ...S.hint, marginTop: 10 }}>Switching a module off removes its tab, tile and menu row. No dead screens ship.</div>
        </div>

        <div style={S.card}>
          <h2 style={S.h2}>Links</h2>
          {[['privacyUrl', 'Privacy policy'], ['supportUrl', 'Help and support'], ['termsUrl', 'Terms']].map(([k, l]) => (
            <div key={k} style={S.field}>
              <label style={S.label} htmlFor={`app-${k}`}>{l}</label>
              <input id={`app-${k}`} style={S.input} placeholder="https://" value={p.support[k]} onChange={(e) => setIn('support', { [k]: e.target.value.trim() })} />
            </div>
          ))}
          <div style={S.hint}>The stores require a privacy policy and a support page on your own website. The app's Help row opens the support link.</div>
        </div>

        <div style={{ ...S.card, position: 'sticky', bottom: 12 }}>
          {problems.map((t) => <div key={t} style={S.problem}>{t}</div>)}
          {msg ? <div style={{ fontSize: 12.5, color: msg.kind === 'ok' ? 'var(--grn, #3fb950)' : 'var(--red, #e5484d)', marginBottom: 8 }}>{msg.text}</div> : null}
          <div style={{ ...S.row, justifyContent: 'space-between', marginTop: problems.length ? 10 : 0 }}>
            <span style={{ fontSize: 12.5, color: 'var(--t3)' }}>
              {saved ? `Published, version ${saved.version}. Installed apps pick changes up on their next launch.` : 'Not published yet. The app cannot be built until this is published.'}
            </span>
            <button type="button" style={{ ...S.btn, opacity: problems.length || busy ? .5 : 1 }} disabled={!!problems.length || busy} onClick={publish}>{busy ? 'Publishing…' : 'Publish theme'}</button>
          </div>
        </div>
      </div>

      <div style={{ position: 'sticky', top: 12 }}>
        <div style={{ ...S.card, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
          <div style={{ ...S.row, alignSelf: 'stretch', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)' }}><Icon name="phone" size={14} /> Live preview</span>
            <span style={{ fontSize: 11.5, color: 'var(--t4)' }}>Home screen, drawn from the same theme the app fetches</span>
          </div>
          <PhonePreview p={p} />
        </div>
      </div>
    </div>
  );
}
