// src/backoffice/sections/MenuAppearance.jsx
//
// Back office → Channels → "Menu appearance". The venue owner chooses how their customer menu looks —
// brand colour, header style, header photo, logo + logo shape, open/prep status — with a LIVE PREVIEW
// that renders the SAME storefront header (MenuHeader) so preview == live. Saves a MenuTheme onto the
// platform location's online_branding jsonb (brand_color / header_style / logo_shape / show_open_status
// + the existing logo_url / hero_url), which both storefronts read.

import { useEffect, useRef, useState } from 'react';
import { platformSupabase, supabase, getLocationId } from '../../lib/supabase';
import MenuHeader from '../../surfaces/menu/MenuHeader';
import { readTheme, deriveVars, THEME_DEFAULTS, DISPLAY_FONT, BODY_FONT, FIXED } from '../../surfaces/menu/menuTheme';

const ASSET_BUCKET = 'receipt-assets';
async function uploadAsset(file, locationId, kind) {
  const ext = (file.name.split('.').pop() || 'png').toLowerCase();
  const path = `locations/${locationId}/online/${kind}.${ext}`;
  const { error } = await supabase.storage.from(ASSET_BUCKET).upload(path, file, { upsert: true, contentType: file.type });
  if (error) throw error;
  const { data } = supabase.storage.from(ASSET_BUCKET).getPublicUrl(path);
  return `${data.publicUrl}?t=${Date.now()}`;
}

const S = {
  h1: { fontSize: 22, fontWeight: 800, color: 'var(--t1)', margin: 0, letterSpacing: '-.01em' },
  sub: { fontSize: 13, color: 'var(--t3)', marginTop: 4, marginBottom: 18 },
  card: { border: '1px solid var(--bdr)', borderRadius: 14, background: 'var(--bg1)', padding: 18, marginBottom: 16 },
  label: { display: 'block', fontSize: 12, fontWeight: 700, color: 'var(--t2)', marginBottom: 6 },
  input: { width: '100%', boxSizing: 'border-box', border: '1px solid var(--bdr2)', borderRadius: 10, padding: '9px 12px', fontSize: 13.5, fontFamily: 'inherit', color: 'var(--t1)', background: 'var(--bg2)' },
  field: { marginBottom: 14 },
  btn: { padding: '9px 18px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 13.5, fontWeight: 700, fontFamily: 'inherit', background: 'var(--acc)', color: '#0b0c10' },
  ghost: { padding: '7px 12px', borderRadius: 8, cursor: 'pointer', fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit', background: 'transparent', color: 'var(--t2)', border: '1px solid var(--bdr2)' },
  seg: (on) => ({ padding: '7px 12px', borderRadius: 8, cursor: 'pointer', fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit', border: `1px solid ${on ? 'var(--acc)' : 'var(--bdr2)'}`, background: on ? 'var(--acc)' : 'transparent', color: on ? '#0b0c10' : 'var(--t2)' }),
  empty: { textAlign: 'center', padding: '60px 20px', color: 'var(--t3)', fontSize: 14 },
};

const HEADERS = [['cinematic', 'Cinematic'], ['framed', 'Framed'], ['compact', 'Compact']];
const SHAPES = [['auto', 'Auto'], ['square', 'Square'], ['wide', 'Wide'], ['tall', 'Tall'], ['circle', 'Circle']];

// Sample card for the preview (mirrors the live storefront card style).
function SampleCard({ name, desc, price, img }) {
  return (
    <div style={{ background: '#fff', border: '1px solid var(--line)', borderRadius: 16, padding: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      {img && <div style={{ width: '100%', height: 120, background: 'repeating-linear-gradient(135deg,#efe7df 0 8px,#e7ddd2 8px 16px)' }} />}
      <div style={{ padding: 14 }}>
        <div style={{ fontFamily: DISPLAY_FONT, fontWeight: 600, fontSize: 15, color: FIXED.ink }}>{name}</div>
        {desc && <div style={{ fontSize: 12.5, color: FIXED.muted, marginTop: 3, lineHeight: 1.5 }}>{desc}</div>}
        <div style={{ marginTop: 8, fontFamily: DISPLAY_FONT, fontWeight: 700, fontSize: 16, color: 'var(--brand)' }}>{price}</div>
      </div>
    </div>
  );
}

export default function MenuAppearance() {
  const [loading, setLoading] = useState(true);
  const [opsLocId, setOpsLocId] = useState(null);
  const [row, setRow] = useState(null);
  const [name, setName] = useState('Your venue');
  const [branding, setBranding] = useState({});
  const [save, setSave] = useState({});
  const [previewPage, setPreviewPage] = useState('ordering');
  const [previewVp, setPreviewVp] = useState('desktop');
  const [upLogo, setUpLogo] = useState(false);
  const [upHero, setUpHero] = useState(false);
  const logoRef = useRef(null); const heroRef = useRef(null);

  useEffect(() => {
    (async () => {
      try {
        const id = await getLocationId().catch(() => null); setOpsLocId(id);
        if (!platformSupabase || !id) { setLoading(false); return; }
        let r = (await platformSupabase.from('locations').select('id, name, online_branding').eq('ops_location_id', id).maybeSingle()).data;
        if (!r) r = (await platformSupabase.from('locations').select('id, name, online_branding').eq('id', id).maybeSingle()).data;
        setRow(r); setName(r?.name || 'Your venue');
        const b = r?.online_branding || {};
        // Seed brand_color from any prior brand/accent, else the default orange.
        setBranding({ ...b, brand_color: b.brand_color || b.accent_color || THEME_DEFAULTS.brandColor, header_style: b.header_style || THEME_DEFAULTS.headerStyle, logo_shape: b.logo_shape || THEME_DEFAULTS.logoShape, show_open_status: b.show_open_status !== false });
      } catch { /* leave defaults */ } finally { setLoading(false); }
    })();
  }, []);

  const set = (patch) => setBranding((b) => ({ ...b, ...patch }));
  const mt = readTheme(branding);
  const vars = deriveVars(mt.brandColor, mt.bodyBg);

  const pickFile = async (kind, setUp) => {
    const ref = kind === 'logo' ? logoRef : heroRef;
    const file = ref.current?.files?.[0]; if (!file || !opsLocId) return;
    setUp(true); setSave({});
    try { const url = await uploadAsset(file, opsLocId, kind); set(kind === 'logo' ? { logo_url: url } : { hero_url: url }); }
    catch (e) { setSave({ err: e.message || 'Upload failed' }); } finally { setUp(false); }
  };

  const saveAll = async () => {
    if (!platformSupabase || !row) { setSave({ err: 'No customer-facing location found — set a slug in Online ordering first.' }); return; }
    setSave({ busy: true });
    try {
      const next = { ...(row.online_branding || {}), ...branding, brand_color: mt.brandColor, header_style: mt.headerStyle, logo_shape: mt.logoShape, show_open_status: mt.showOpenStatus, logo_url: branding.logo_url || null, hero_url: branding.hero_url || null, background: branding.background || null };
      const { error } = await platformSupabase.from('locations').update({ online_branding: next }).eq('id', row.id);
      if (error) throw error;
      setRow((r) => ({ ...r, online_branding: next }));
      setSave({ done: true }); setTimeout(() => setSave((s) => (s.done ? {} : s)), 2500);
    } catch (e) { setSave({ err: e.message || 'Save failed' }); }
  };

  if (loading) return <div style={S.empty}>Loading…</div>;
  if (!platformSupabase || !opsLocId) return <div style={S.empty}>Pick a location to set up its menu appearance.</div>;

  const pills = previewPage === 'catering' ? [{ label: 'Catering · Pre-order' }] : (mt.showOpenStatus ? [{ label: 'Open now', dot: true, green: true }, { label: '30 min prep time' }] : []);
  const isMobile = previewVp === 'mobile';

  return (
    <div>
      <h1 style={S.h1}>Menu appearance</h1>
      <div style={S.sub}>Choose how your online ordering &amp; catering menus look. Changes preview live; Save to publish to your customer sites.</div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(300px, 380px) 1fr', gap: 20, alignItems: 'start' }}>
        {/* ── Controls ── */}
        <div>
          <div style={S.card}>
            <div style={S.field}><label style={S.label}>Brand colour</label>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <input type="color" value={mt.brandColor} onChange={(e) => set({ brand_color: e.target.value })} style={{ width: 46, height: 38, border: '1px solid var(--bdr2)', borderRadius: 8, background: 'none', cursor: 'pointer' }} />
                <input style={{ ...S.input, maxWidth: 130 }} value={branding.brand_color || ''} onChange={(e) => set({ brand_color: e.target.value })} placeholder="#e2581f" />
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--t4)', marginTop: 5 }}>Drives every accent — header, prices, buttons, links.</div>
            </div>
            <div style={S.field}><label style={S.label}>Body background colour</label>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <input type="color" value={mt.bodyBg || '#f6f2ec'} onChange={(e) => set({ background: e.target.value })} style={{ width: 46, height: 38, border: '1px solid var(--bdr2)', borderRadius: 8, background: 'none', cursor: 'pointer' }} />
                <input style={{ ...S.input, maxWidth: 130 }} value={branding.background || ''} onChange={(e) => set({ background: e.target.value })} placeholder="#f6f2ec" />
                {branding.background && <button style={S.ghost} onClick={() => set({ background: '' })}>Reset</button>}
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--t4)', marginTop: 5 }}>The page background behind the menu. Blank = the default warm cream.</div>
            </div>
            <div style={S.field}><label style={S.label}>Header style</label>
              <div style={{ display: 'flex', gap: 8 }}>{HEADERS.map(([v, l]) => <button key={v} style={S.seg(mt.headerStyle === v)} onClick={() => set({ header_style: v })}>{l}</button>)}</div>
            </div>
            <div style={S.field}><label style={S.label}>Header photo <span style={{ color: 'var(--t4)', fontWeight: 500 }}>optional</span></label>
              <input ref={heroRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={() => pickFile('hero', setUpHero)} />
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <button style={S.ghost} onClick={() => heroRef.current?.click()} disabled={upHero}>{upHero ? 'Uploading…' : branding.hero_url ? 'Replace photo' : 'Upload photo'}</button>
                {branding.hero_url && <button style={S.ghost} onClick={() => set({ hero_url: '' })}>Remove</button>}
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--t4)', marginTop: 5 }}>~1600×500. No photo → a brand ember gradient is used.</div>
            </div>
            <div style={S.field}><label style={S.label}>Logo</label>
              <input ref={logoRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={() => pickFile('logo', setUpLogo)} />
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                {branding.logo_url && <div style={{ height: 38, padding: 4, background: '#fff', border: '1px solid var(--bdr2)', borderRadius: 8 }}><img src={branding.logo_url} alt="logo" style={{ height: '100%', width: 'auto', objectFit: 'contain' }} /></div>}
                <button style={S.ghost} onClick={() => logoRef.current?.click()} disabled={upLogo}>{upLogo ? 'Uploading…' : branding.logo_url ? 'Replace logo' : 'Upload logo'}</button>
                {branding.logo_url && <button style={S.ghost} onClick={() => set({ logo_url: '' })}>Remove logo</button>}
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--t4)', marginTop: 5 }}>No logo → a clean header with just your venue name (no logo box).</div>
              <div style={{ marginTop: 10 }}><label style={S.label}>Logo shape</label>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{SHAPES.map(([v, l]) => <button key={v} style={S.seg(mt.logoShape === v)} onClick={() => set({ logo_shape: v })}>{l}</button>)}</div>
                <div style={{ fontSize: 11.5, color: 'var(--t4)', marginTop: 5 }}>Auto fits the logo’s own proportions. Circle crops to a circle.</div>
              </div>
            </div>
            <div style={S.field}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 600, color: 'var(--t2)', cursor: 'pointer' }}>
                <input type="checkbox" checked={mt.showOpenStatus} onChange={(e) => set({ show_open_status: e.target.checked })} /> Show “Open now” / prep-time pills (online ordering)
              </label>
            </div>
            <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
              <button style={S.btn} onClick={saveAll} disabled={save.busy}>{save.busy ? 'Saving…' : 'Save appearance'}</button>
              {save.done && <span style={{ color: 'var(--grn)', fontWeight: 700, fontSize: 12.5 }}>✓ Published</span>}
              {save.err && <span style={{ color: 'var(--red)', fontSize: 12 }}>{save.err}</span>}
            </div>
          </div>
        </div>

        {/* ── Live preview ── */}
        <div>
          <div style={{ display: 'flex', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', gap: 6 }}>{[['ordering', 'Online ordering'], ['catering', 'Catering']].map(([v, l]) => <button key={v} style={S.seg(previewPage === v)} onClick={() => setPreviewPage(v)}>{l}</button>)}</div>
            <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>{[['desktop', 'Desktop'], ['mobile', 'Mobile']].map(([v, l]) => <button key={v} style={S.seg(previewVp === v)} onClick={() => setPreviewVp(v)}>{l}</button>)}</div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'center', background: 'var(--bg2)', borderRadius: 14, padding: isMobile ? 20 : 0, overflow: 'hidden', border: '1px solid var(--bdr)' }}>
            <div style={{ ...vars, containerType: 'inline-size', width: isMobile ? 380 : '100%', maxWidth: '100%', background: 'var(--bg)', color: 'var(--ink)', fontFamily: BODY_FONT, borderRadius: isMobile ? 24 : 14, overflow: 'hidden', border: isMobile ? '10px solid #14100d' : 'none' }}>
              <MenuHeader theme={mt} name={name} pills={pills} max={1120} />
              <div style={{ padding: '20px 18px 28px' }}>
                {previewPage === 'catering' && (
                  <div style={{ background: '#fff', border: '1px solid var(--line)', borderRadius: 16, padding: 16, marginBottom: 20 }}>
                    <div style={{ fontFamily: DISPLAY_FONT, fontWeight: 700, color: FIXED.ink, marginBottom: 6 }}>Your event</div>
                    <div style={{ fontSize: 12.5, color: FIXED.muted }}>Date &amp; time pickers · “Orders at least 1 day ahead. Minimum order £100.”</div>
                  </div>
                )}
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 16 }}>
                  <h2 style={{ fontFamily: DISPLAY_FONT, fontWeight: 700, fontSize: 'clamp(20px,4.4cqw,28px)', margin: 0, color: FIXED.ink }}>Sourdough Pizza</h2>
                  <span style={{ height: 1, flex: 1, background: 'var(--line)' }} /><span style={{ fontSize: 12, color: FIXED.muted, fontWeight: 600 }}>3 items</span>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(47%, 280px), 1fr))', gap: 14 }}>
                  <SampleCard name="Margherita" desc="Tomato, Mozzarella, Basil, EVOO" price="£16.00" img />
                  <SampleCard name="Pepperoni" desc="Tomato, Mozzarella, Pepperoni, Oregano" price="£16.00" img />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
