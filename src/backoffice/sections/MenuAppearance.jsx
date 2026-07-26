// src/backoffice/sections/MenuAppearance.jsx
//
// Back office → Channels → "Appearance" (v5.5.898, was "Menu appearance").
// ONE editor for every customer-facing surface. Four sections:
//   • Brand basics    — colour, logo, display/trading name, "Powered by" toggle
//   • Storefront      — body bg, header style/photo, open-status pills (online + catering)
//   • Loyalty portal  — scheme (match/light/dark), background override, hero banner
//   • Gift cards      — card art (emails/vouchers) + where-the-branding-comes-from note
// Live previews render through the SAME engines the customer sees (MenuHeader for the
// storefront, buildGiftTheme for portal + gift) so preview == live. Everything saves onto
// platform locations.online_branding jsonb — additive keys, no schema change; every consumer
// falls back per-key so untouched venues are unaffected.

import { useEffect, useRef, useState } from 'react';
import { platformSupabase, supabase, getLocationId } from '../../lib/supabase';
import MenuHeader from '../../surfaces/menu/MenuHeader';
import { readTheme, deriveVars, THEME_DEFAULTS, DISPLAY_FONT, BODY_FONT, FIXED } from '../../surfaces/menu/menuTheme';
import { buildGiftTheme } from '../../surfaces/gift/giftHelpers';

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
  tab: (on) => ({ padding: '9px 14px', borderRadius: 10, cursor: 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'inherit', border: `1px solid ${on ? 'var(--acc)' : 'var(--bdr)'}`, background: on ? 'var(--acc-d, rgba(232,116,60,.12))' : 'var(--bg1)', color: on ? 'var(--acc)' : 'var(--t2)', display: 'flex', alignItems: 'center', gap: 8 }),
  hint: { fontSize: 11.5, color: 'var(--t4)', marginTop: 5 },
  empty: { textAlign: 'center', padding: '60px 20px', color: 'var(--t3)', fontSize: 14 },
};

const HEADERS = [['cinematic', 'Cinematic'], ['framed', 'Framed'], ['compact', 'Compact']];
const SHAPES = [['auto', 'Auto'], ['square', 'Square'], ['wide', 'Wide'], ['tall', 'Tall'], ['circle', 'Circle']];
const SECTIONS = [
  ['brand', '🎨', 'Brand basics'],
  ['storefront', '🍽', 'Storefront'],
  ['portal', '⭐', 'Loyalty portal'],
  ['gift', '🎁', 'Gift cards'],
];

// Sample card for the storefront preview (mirrors the live storefront card style).
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

// Loyalty-portal preview — renders through the REAL buildGiftTheme so preview == live.
function PortalPreview({ branding, name, isMobile }) {
  const t = buildGiftTheme({ online_branding: branding, name });
  return (
    <div style={{ width: isMobile ? 380 : '100%', maxWidth: 560, background: t.bg, color: t.text, borderRadius: isMobile ? 24 : 14, overflow: 'hidden', border: isMobile ? '10px solid #14100d' : '1px solid var(--bdr)', fontFamily: 'system-ui, sans-serif' }}>
      {t.showHero && t.hero && <div style={{ height: 110, backgroundImage: `url(${t.hero})`, backgroundSize: 'cover', backgroundPosition: 'center' }} />}
      <div style={{ padding: '28px 22px 32px', textAlign: 'center' }}>
        {t.logo
          ? <img src={t.logo} alt="" style={{ height: 60, maxWidth: 200, objectFit: 'contain', background: '#fff', borderRadius: 12, padding: '8px 12px', boxSizing: 'border-box', marginBottom: 12 }} />
          : <div style={{ fontSize: 22, fontWeight: 800, marginBottom: 8 }}>{t.companyName || name}</div>}
        <div style={{ fontSize: 13, color: t.textMuted, marginBottom: 18 }}>Loyalty &amp; rewards</div>
        <div style={{ background: t.card, border: `1px solid ${t.border}`, borderRadius: t.radius, padding: 18, textAlign: 'left', marginBottom: 12 }}>
          <div style={{ fontSize: 11, color: t.textMuted, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6 }}>Your points</div>
          <div style={{ fontSize: 30, fontWeight: 900, color: t.accent }}>240</div>
          <div style={{ fontSize: 12, color: t.textMuted, marginTop: 4 }}>60 points until your next reward</div>
        </div>
        <button style={{ width: '100%', padding: '13px', borderRadius: 10, border: 'none', background: t.accent, color: t.accentText, fontSize: 14, fontWeight: 800, fontFamily: 'inherit' }}>Sign in with your phone</button>
        {t.showPoweredBy && <div style={{ fontSize: 11, color: t.textDim, marginTop: 16 }}>Powered by Serv OS</div>}
      </div>
    </div>
  );
}

// Gift purchase-page preview — same real theme engine.
function GiftPreview({ branding, name, isMobile }) {
  const t = buildGiftTheme({ online_branding: branding, name });
  const cardArt = branding.gift?.card_art_url || null;
  return (
    <div style={{ width: isMobile ? 380 : '100%', maxWidth: 560, background: t.bg, color: t.text, borderRadius: isMobile ? 24 : 14, overflow: 'hidden', border: isMobile ? '10px solid #14100d' : '1px solid var(--bdr)', fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ padding: '28px 22px 32px' }}>
        <div style={{ textAlign: 'center', marginBottom: 18 }}>
          {t.logo
            ? <img src={t.logo} alt="" style={{ height: 54, maxWidth: 180, objectFit: 'contain', background: '#fff', borderRadius: 12, padding: '8px 12px', boxSizing: 'border-box' }} />
            : <div style={{ fontSize: 20, fontWeight: 800 }}>{t.companyName || name}</div>}
          <div style={{ fontSize: 13, color: t.textMuted, marginTop: 6 }}>Gift cards</div>
        </div>
        <div style={{ borderRadius: 14, overflow: 'hidden', marginBottom: 14, border: `1px solid ${t.border}` }}>
          {cardArt
            ? <div style={{ height: 120, backgroundImage: `url(${cardArt})`, backgroundSize: 'cover', backgroundPosition: 'center' }} />
            : <div style={{ height: 120, background: `linear-gradient(120deg, ${t.accent}, ${t.accent}66)`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: t.accentText, fontWeight: 900, fontSize: 18 }}>{t.companyName || name}</div>}
        </div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          {['£25', '£50', '£75'].map((a, i) => (
            <div key={a} style={{ flex: 1, textAlign: 'center', padding: '11px 0', borderRadius: 10, border: `1.5px solid ${i === 1 ? t.accent : t.border}`, background: i === 1 ? t.card : 'transparent', fontWeight: 800, fontSize: 14 }}>{a}</div>
          ))}
        </div>
        <button style={{ width: '100%', padding: '13px', borderRadius: 10, border: 'none', background: t.accent, color: t.accentText, fontSize: 14, fontWeight: 800, fontFamily: 'inherit' }}>Buy gift card</button>
        {t.showPoweredBy && <div style={{ textAlign: 'center', fontSize: 11, color: t.textDim, marginTop: 16 }}>Powered by Serv OS</div>}
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
  const [section, setSection] = useState('brand');
  const [previewPage, setPreviewPage] = useState('ordering');
  const [previewVp, setPreviewVp] = useState('desktop');
  const [upLogo, setUpLogo] = useState(false);
  const [upHero, setUpHero] = useState(false);
  const [upArt, setUpArt] = useState(false);
  const logoRef = useRef(null); const heroRef = useRef(null); const artRef = useRef(null);

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
  const setPortal = (patch) => setBranding((b) => ({ ...b, portal: { ...(b.portal || {}), ...patch } }));
  const setGift = (patch) => setBranding((b) => ({ ...b, gift: { ...(b.gift || {}), ...patch } }));
  const mt = readTheme(branding);
  const vars = deriveVars(mt.brandColor, mt.bodyBg);

  const pickFile = async (kind, ref, setUp, apply) => {
    const file = ref.current?.files?.[0]; if (!file || !opsLocId) return;
    setUp(true); setSave({});
    try { const url = await uploadAsset(file, opsLocId, kind); apply(url); }
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
  if (!platformSupabase || !opsLocId) return <div style={S.empty}>Pick a location to set up its appearance.</div>;

  const pills = previewPage === 'catering' ? [{ label: 'Catering · Pre-order' }] : (mt.showOpenStatus ? [{ label: 'Open now', dot: true, green: true }, { label: '30 min prep time' }] : []);
  const isMobile = previewVp === 'mobile';
  const portalScheme = ['match', 'light', 'dark'].includes(branding.portal?.scheme) ? branding.portal.scheme : 'match';

  return (
    <div>
      <h1 style={S.h1}>Appearance</h1>
      <div style={S.sub}>One brand for everything your customers see — online menu, catering, loyalty portal, signup and gift cards. Changes preview live; Save publishes to all of them.</div>

      {/* Section tabs */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        {SECTIONS.map(([id, icon, label]) => (
          <button key={id} style={S.tab(section === id)} onClick={() => setSection(id)}><span>{icon}</span>{label}</button>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(300px, 380px) 1fr', gap: 20, alignItems: 'start' }}>
        {/* ── Controls ── */}
        <div>
          <div style={S.card}>
            {section === 'brand' && (<>
              <div style={S.field}><label style={S.label}>Brand colour</label>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                  <input type="color" value={mt.brandColor} onChange={(e) => set({ brand_color: e.target.value })} style={{ width: 46, height: 38, border: '1px solid var(--bdr2)', borderRadius: 8, background: 'none', cursor: 'pointer' }} />
                  <input style={{ ...S.input, maxWidth: 130 }} value={branding.brand_color || ''} onChange={(e) => set({ brand_color: e.target.value })} placeholder="#e2581f" />
                </div>
                <div style={S.hint}>Drives every accent on every customer page — menu, portal, gift cards.</div>
              </div>
              <div style={S.field}><label style={S.label}>Display name <span style={{ color: 'var(--t4)', fontWeight: 500 }}>optional</span></label>
                <input style={S.input} value={branding.display_name || ''} onChange={(e) => set({ display_name: e.target.value })} placeholder={name} />
                <div style={S.hint}>The trading name customers see everywhere. Blank = your venue name. Use this when your legal/company name isn’t your brand.</div>
              </div>
              <div style={S.field}><label style={S.label}>Logo</label>
                <input ref={logoRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={() => pickFile('logo', logoRef, setUpLogo, (url) => set({ logo_url: url }))} />
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  {branding.logo_url && <div style={{ height: 38, padding: 4, background: '#fff', border: '1px solid var(--bdr2)', borderRadius: 8 }}><img src={branding.logo_url} alt="logo" style={{ height: '100%', width: 'auto', objectFit: 'contain' }} /></div>}
                  <button style={S.ghost} onClick={() => logoRef.current?.click()} disabled={upLogo}>{upLogo ? 'Uploading…' : branding.logo_url ? 'Replace logo' : 'Upload logo'}</button>
                  {branding.logo_url && <button style={S.ghost} onClick={() => set({ logo_url: '' })}>Remove logo</button>}
                </div>
                <div style={{ marginTop: 10 }}><label style={S.label}>Logo shape</label>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{SHAPES.map(([v, l]) => <button key={v} style={S.seg(mt.logoShape === v)} onClick={() => set({ logo_shape: v })}>{l}</button>)}</div>
                </div>
              </div>
              <div style={S.field}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 600, color: 'var(--t2)', cursor: 'pointer' }}>
                  <input type="checkbox" checked={branding.show_powered_by !== false} onChange={(e) => set({ show_powered_by: e.target.checked })} /> Show “Powered by Serv OS” on customer pages
                </label>
              </div>
            </>)}

            {section === 'storefront' && (<>
              <div style={S.field}><label style={S.label}>Body background colour</label>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                  <input type="color" value={mt.bodyBg || '#f6f2ec'} onChange={(e) => set({ background: e.target.value })} style={{ width: 46, height: 38, border: '1px solid var(--bdr2)', borderRadius: 8, background: 'none', cursor: 'pointer' }} />
                  <input style={{ ...S.input, maxWidth: 130 }} value={branding.background || ''} onChange={(e) => set({ background: e.target.value })} placeholder="#f6f2ec" />
                  {branding.background && <button style={S.ghost} onClick={() => set({ background: '' })}>Reset</button>}
                </div>
                <div style={S.hint}>The page background behind the menu. Blank = the default warm cream.</div>
              </div>
              <div style={S.field}><label style={S.label}>Header style</label>
                <div style={{ display: 'flex', gap: 8 }}>{HEADERS.map(([v, l]) => <button key={v} style={S.seg(mt.headerStyle === v)} onClick={() => set({ header_style: v })}>{l}</button>)}</div>
              </div>
              <div style={S.field}><label style={S.label}>Header photo <span style={{ color: 'var(--t4)', fontWeight: 500 }}>optional</span></label>
                <input ref={heroRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={() => pickFile('hero', heroRef, setUpHero, (url) => set({ hero_url: url }))} />
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <button style={S.ghost} onClick={() => heroRef.current?.click()} disabled={upHero}>{upHero ? 'Uploading…' : branding.hero_url ? 'Replace photo' : 'Upload photo'}</button>
                  {branding.hero_url && <button style={S.ghost} onClick={() => set({ hero_url: '' })}>Remove</button>}
                </div>
                <div style={S.hint}>~1600×500. No photo → a brand ember gradient is used.</div>
              </div>
              <div style={S.field}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 600, color: 'var(--t2)', cursor: 'pointer' }}>
                  <input type="checkbox" checked={mt.showOpenStatus} onChange={(e) => set({ show_open_status: e.target.checked })} /> Show “Open now” / prep-time pills (online ordering)
                </label>
              </div>
            </>)}

            {section === 'portal' && (<>
              <div style={S.field}><label style={S.label}>Colour scheme</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  {[['match', 'Match storefront'], ['light', 'Light'], ['dark', 'Dark']].map(([v, l]) => (
                    <button key={v} style={S.seg(portalScheme === v)} onClick={() => setPortal({ scheme: v })}>{l}</button>
                  ))}
                </div>
                <div style={S.hint}>How the loyalty portal, signup and gift pages are toned. “Match” follows your storefront background.</div>
              </div>
              <div style={S.field}><label style={S.label}>Portal background override <span style={{ color: 'var(--t4)', fontWeight: 500 }}>optional</span></label>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                  <input type="color" value={branding.portal?.background || '#f6f2ec'} onChange={(e) => setPortal({ background: e.target.value })} style={{ width: 46, height: 38, border: '1px solid var(--bdr2)', borderRadius: 8, background: 'none', cursor: 'pointer' }} />
                  <input style={{ ...S.input, maxWidth: 130 }} value={branding.portal?.background || ''} onChange={(e) => setPortal({ background: e.target.value })} placeholder="inherit" />
                  {branding.portal?.background && <button style={S.ghost} onClick={() => setPortal({ background: null })}>Reset</button>}
                </div>
              </div>
              <div style={S.field}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 600, color: 'var(--t2)', cursor: 'pointer' }}>
                  <input type="checkbox" checked={branding.portal?.show_hero === true} onChange={(e) => setPortal({ show_hero: e.target.checked })} /> Show the header photo as a portal banner
                </label>
                <div style={S.hint}>Uses the Storefront header photo at the top of the loyalty portal.</div>
              </div>
            </>)}

            {section === 'gift' && (<>
              <div style={S.field}><label style={S.label}>Gift card art <span style={{ color: 'var(--t4)', fontWeight: 500 }}>optional</span></label>
                <input ref={artRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={() => pickFile('cardart', artRef, setUpArt, (url) => setGift({ card_art_url: url }))} />
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  {branding.gift?.card_art_url && <div style={{ height: 44, width: 78, borderRadius: 6, overflow: 'hidden', border: '1px solid var(--bdr2)' }}><img src={branding.gift.card_art_url} alt="card art" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /></div>}
                  <button style={S.ghost} onClick={() => artRef.current?.click()} disabled={upArt}>{upArt ? 'Uploading…' : branding.gift?.card_art_url ? 'Replace art' : 'Upload art'}</button>
                  {branding.gift?.card_art_url && <button style={S.ghost} onClick={() => setGift({ card_art_url: null })}>Remove</button>}
                </div>
                <div style={S.hint}>Shown on the purchase page and (soon) in gift delivery emails. ~1200×750. No art → a brand-colour card with your name.</div>
              </div>
              <div style={{ padding: '10px 12px', borderRadius: 10, background: 'var(--bg2)', border: '1px solid var(--bdr)', fontSize: 12, color: 'var(--t3)', lineHeight: 1.6 }}>
                Gift card <b>pages</b> use your brand automatically (colour, logo, display name — set in Brand basics).
                Amounts, expiry and limits live in <b>Gift cards → Settings</b>. The Stripe payment page itself is branded from your Stripe dashboard.
              </div>
            </>)}

            <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 6 }}>
              <button style={S.btn} onClick={saveAll} disabled={save.busy}>{save.busy ? 'Saving…' : 'Save appearance'}</button>
              {save.done && <span style={{ color: 'var(--grn)', fontWeight: 700, fontSize: 12.5 }}>✓ Published</span>}
              {save.err && <span style={{ color: 'var(--red)', fontSize: 12 }}>{save.err}</span>}
            </div>
          </div>
        </div>

        {/* ── Live preview ── */}
        <div>
          <div style={{ display: 'flex', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
            {(section === 'brand' || section === 'storefront') && (
              <div style={{ display: 'flex', gap: 6 }}>{[['ordering', 'Online ordering'], ['catering', 'Catering']].map(([v, l]) => <button key={v} style={S.seg(previewPage === v)} onClick={() => setPreviewPage(v)}>{l}</button>)}</div>
            )}
            <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>{[['desktop', 'Desktop'], ['mobile', 'Mobile']].map(([v, l]) => <button key={v} style={S.seg(previewVp === v)} onClick={() => setPreviewVp(v)}>{l}</button>)}</div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'center', background: 'var(--bg2)', borderRadius: 14, padding: (isMobile || section === 'portal' || section === 'gift') ? 20 : 0, overflow: 'hidden', border: '1px solid var(--bdr)' }}>
            {(section === 'brand' || section === 'storefront') && (
              <div style={{ ...vars, containerType: 'inline-size', width: isMobile ? 380 : '100%', maxWidth: '100%', background: 'var(--bg)', color: 'var(--ink)', fontFamily: BODY_FONT, borderRadius: isMobile ? 24 : 14, overflow: 'hidden', border: isMobile ? '10px solid #14100d' : 'none' }}>
                <MenuHeader theme={mt} name={branding.display_name || name} pills={pills} max={1120} />
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
            )}
            {section === 'portal' && <PortalPreview branding={branding} name={name} isMobile={isMobile} />}
            {section === 'gift' && <GiftPreview branding={branding} name={name} isMobile={isMobile} />}
          </div>
        </div>
      </div>
    </div>
  );
}
