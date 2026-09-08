// src/backoffice/sections/review/ReviewCard.jsx
//
// "Your card" — the branded customer-facing review page, shown + managed in the
// back office. Left: the wording editor (saved to review_settings via review-admin).
// Right: a LIVE phone preview of exactly what the guest sees (brand pulled from
// the venue's online_branding), with chips to preview the rate / happy / private
// states. Plus the shareable link + a QR code (for tables, receipts, counter).
// The card itself lives at customerUrl(slug, '/review').

import { useEffect, useMemo, useState } from 'react';
import { supabase, platformSupabase, getActiveLocationSync } from '../../../lib/supabase';
import { patchBranding } from '../../../lib/locationAdmin';
import { customerUrl } from '../../../lib/env';
import QRCode from 'qrcode';

const FALLBACK_ACCENT = '#5a51c2';
const ASSET_BUCKET = 'receipt-assets';   // shared image bucket (same as online/receipt assets)
const DEFAULTS = {
  page_title: 'How was your visit?',
  intro_copy: 'We’d love to hear how we did — it only takes a few seconds.',
  thanks_public_copy: 'Thanks — that means a lot!',
  thanks_private_copy: 'Sorry we missed the mark.',
  hero_image_url: '',
  card_button_style: 'dark',
};

async function uploadBackground(file, opsId) {
  const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
  const path = `locations/${opsId}/review/background.${ext}`;
  const { error } = await supabase.storage.from(ASSET_BUCKET).upload(path, file, { upsert: true, contentType: file.type });
  if (error) throw error;
  const { data } = supabase.storage.from(ASSET_BUCKET).getPublicUrl(path);
  return `${data.publicUrl}?t=${Date.now()}`;   // cache-bust on replace
}

// v5.5.752: an optional review-card-only logo, stored on online_branding.review_logo_url.
async function uploadReviewLogo(file, opsId) {
  const ext = (file.name.split('.').pop() || 'png').toLowerCase();
  const path = `locations/${opsId}/review/logo.${ext}`;
  const { error } = await supabase.storage.from(ASSET_BUCKET).upload(path, file, { upsert: true, contentType: file.type });
  if (error) throw error;
  const { data } = supabase.storage.from(ASSET_BUCKET).getPublicUrl(path);
  return `${data.publicUrl}?t=${Date.now()}`;
}

const S = {
  h1:    { fontSize: 22, fontWeight: 800, color: 'var(--t1)', margin: 0, letterSpacing: '-.01em' },
  sub:   { fontSize: 13, color: 'var(--t3)', marginTop: 4, marginBottom: 18 },
  grid:  { display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 300px', gap: 20, alignItems: 'start' },
  card:  { border: '1px solid var(--bdr)', borderRadius: 14, background: 'var(--bg1)', padding: 18, marginBottom: 16 },
  h2:    { fontSize: 15.5, fontWeight: 800, color: 'var(--t1)', margin: '0 0 12px' },
  label: { display: 'block', fontSize: 12, fontWeight: 700, color: 'var(--t2)', marginBottom: 6 },
  input: { width: '100%', boxSizing: 'border-box', border: '1px solid var(--bdr2)', borderRadius: 10, padding: '9px 12px', fontSize: 13.5, fontFamily: 'inherit', color: 'var(--t1)', background: 'var(--bg2)', outline: 'none' },
  area:  { width: '100%', boxSizing: 'border-box', minHeight: 60, border: '1px solid var(--bdr2)', borderRadius: 10, padding: '9px 12px', fontSize: 13.5, fontFamily: 'inherit', color: 'var(--t1)', background: 'var(--bg2)', outline: 'none', resize: 'vertical', lineHeight: 1.5 },
  field: { marginBottom: 14 },
  hint:  { fontSize: 11.5, color: 'var(--t4)', marginTop: 5, lineHeight: 1.45 },
  btn:   { padding: '8px 16px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'inherit', background: 'var(--acc)', color: '#0b0c10' },
  ghost: { padding: '7px 12px', borderRadius: 8, cursor: 'pointer', fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit', background: 'transparent', color: 'var(--t2)', border: '1px solid var(--bdr2)' },
  ok:    { fontSize: 12.5, color: 'var(--grn)', fontWeight: 700 },
  err:   { fontSize: 12, color: 'var(--red)' },
  chip:  (on) => ({ padding: '5px 10px', borderRadius: 99, border: '1px solid var(--bdr2)', background: on ? 'var(--acc)' : 'var(--bg2)', color: on ? '#0b0c10' : 'var(--t3)', fontSize: 11.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }),
  empty: { textAlign: 'center', padding: '60px 20px', color: 'var(--t3)', fontSize: 14 },
  linkBox: { display: 'flex', gap: 8, alignItems: 'center', border: '1px solid var(--bdr2)', borderRadius: 10, padding: '8px 10px', background: 'var(--bg2)' },
};

export default function ReviewCard() {
  const [locId, setLocId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [venue, setVenue] = useState({ id: null, name: 'Your venue', slug: null, branding: {} });
  const [copy, setCopy] = useState(DEFAULTS);
  const [save, setSave] = useState({});
  const [preview, setPreview] = useState('rate');   // rate | happy | private
  const [qr, setQr] = useState(null);
  const [copied, setCopied] = useState(false);
  const [bgBusy, setBgBusy] = useState(false);
  const [logoBusy, setLogoBusy] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const id = await getActiveLocationSync();
        setLocId(id);
        if (!supabase || !id) { setLoading(false); return; }
        // venue brand + slug (platform locations — readable by the BO client)
        let v = { id: null, name: 'Your venue', slug: null, branding: {} };
        try {
          const { data: loc } = await platformSupabase.from('locations')
            .select('id, name, online_slug, online_branding').or(`ops_location_id.eq.${id},id.eq.${id}`).maybeSingle();
          if (loc) v = { id: loc.id, name: loc.name || 'Your venue', slug: loc.online_slug || null, branding: loc.online_branding || {} };
        } catch { /* brand best-effort */ }
        setVenue(v);
        // saved copy
        const { data } = await supabase.functions.invoke('review-admin', { body: { action: 'get_config', ops_location_id: id } });
        const s = data?.settings || {};
        setCopy({
          page_title: s.page_title || DEFAULTS.page_title,
          intro_copy: s.intro_copy || DEFAULTS.intro_copy,
          thanks_public_copy: s.thanks_public_copy || DEFAULTS.thanks_public_copy,
          thanks_private_copy: s.thanks_private_copy || DEFAULTS.thanks_private_copy,
          hero_image_url: s.hero_image_url || '',
          card_button_style: s.card_button_style || 'dark',
        });
      } catch { /* leave defaults */ }
      finally { setLoading(false); }
    })();
  }, []);

  const reviewUrl = useMemo(() => (venue.slug ? customerUrl(venue.slug, '/review') : null), [venue.slug]);

  useEffect(() => {
    if (!reviewUrl) { setQr(null); return; }
    QRCode.toDataURL(reviewUrl, { width: 480, margin: 1, errorCorrectionLevel: 'M' }).then(setQr).catch(() => setQr(null));
  }, [reviewUrl]);

  const accent = venue.branding?.accent_color || venue.branding?.primary_color || FALLBACK_ACCENT;
  const logo = venue.branding?.logo_url || null;
  const reviewLogo = venue.branding?.review_logo_url || null;
  const set = (patch) => setCopy(c => ({ ...c, ...patch }));

  const saveCopy = async () => {
    setSave({ busy: true });
    try {
      const { data, error } = await supabase.functions.invoke('review-admin', { body: { action: 'save_settings', ops_location_id: locId, settings: copy } });
      if (error) { let b = null; try { b = await error.context?.json?.(); } catch {} throw new Error(b?.error || error.message); }
      if (data?.error) throw new Error(data.error);
      setSave({ done: true }); setTimeout(() => setSave(s => (s.done ? {} : s)), 2200);
    } catch (e) { setSave({ err: e.message || 'Save failed' }); }
  };

  const copyLink = async () => { try { await navigator.clipboard.writeText(reviewUrl); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch {} };

  // Look changes (background, button style) save immediately so the preview + the
  // live card stay in sync without a separate Save click.
  const persist = async (patch) => {
    const next = { ...copy, ...patch };
    setCopy(next);
    try { await supabase.functions.invoke('review-admin', { body: { action: 'save_settings', ops_location_id: locId, settings: next } }); }
    catch (e) { setSave({ err: e.message || 'Save failed' }); }
  };
  const onBgFile = async (e) => {
    const file = e.target.files?.[0]; if (!file) return;
    setBgBusy(true); setSave({});
    try { const url = await uploadBackground(file, locId); await persist({ hero_image_url: url }); }
    catch (err) { setSave({ err: err.message || 'Upload failed' }); }
    finally { setBgBusy(false); }
  };

  // v5.5.752: the review-card logo lives on the venue's online_branding jsonb
  // (review_logo_url) — no new table/column, and the customer card reads it directly.
  // The write goes through the location-admin edge fn (service_role): the browser no
  // longer holds UPDATE on platform.locations, and the fn MERGES the patch server-side,
  // so this screen and Menu appearance can't clobber each other's keys. We pass the OPS
  // location id — the fn resolves the platform row itself.
  const persistBranding = async (patch) => {
    if (!venue.id) { setSave({ err: 'No customer-facing location yet — set a slug in Online ordering first.' }); return; }
    const before = venue.branding || {};
    setVenue(v => ({ ...v, branding: { ...(v.branding || {}), ...patch } }));   // optimistic — snappy preview
    const { data, error } = await patchBranding(locId, patch);
    if (error || !data) {
      // Roll the preview back: a logo left on screen that the live card will never
      // serve is worse than no logo at all.
      setVenue(v => ({ ...v, branding: before }));
      setSave({ err: error?.message || 'Save failed' });
      return;
    }
    setVenue(v => ({ ...v, branding: data }));
  };
  const onLogoFile = async (e) => {
    const file = e.target.files?.[0]; if (!file) return;
    setLogoBusy(true); setSave({});
    try { const url = await uploadReviewLogo(file, locId); await persistBranding({ review_logo_url: url }); }
    catch (err) { setSave({ err: err.message || 'Upload failed' }); }
    finally { setLogoBusy(false); }
  };

  if (loading) return <div style={S.empty}>Loading…</div>;
  if (!supabase || !locId) return <div style={S.empty}>{!locId ? 'Pick a location to manage its review card.' : 'Mock mode — connect Supabase to manage the review card.'}</div>;

  return (
    <div>
      <h1 style={S.h1}>Your review card</h1>
      <div style={S.sub}>The branded page guests land on at your review link. Edit the wording on the left; the preview on the right is exactly what they see.</div>

      <div style={S.grid}>
        {/* ── left: editor + share ── */}
        <div>
          <div style={S.card}>
            <h2 style={S.h2}>Wording</h2>
            <div style={S.field}><label style={S.label}>Title</label>
              <input style={S.input} value={copy.page_title} maxLength={80} onChange={e => set({ page_title: e.target.value })} /></div>
            <div style={S.field}><label style={S.label}>Intro</label>
              <textarea style={S.area} value={copy.intro_copy} onChange={e => set({ intro_copy: e.target.value })} /></div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div style={S.field}><label style={S.label}>Thanks — happy</label>
                <textarea style={S.area} value={copy.thanks_public_copy} onChange={e => set({ thanks_public_copy: e.target.value })} /></div>
              <div style={S.field}><label style={S.label}>Thanks — needs work</label>
                <textarea style={S.area} value={copy.thanks_private_copy} onChange={e => set({ thanks_private_copy: e.target.value })} /></div>
            </div>
            <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
              <button style={S.btn} onClick={saveCopy} disabled={save.busy}>{save.busy ? 'Saving…' : 'Save wording'}</button>
              {save.done && <span style={S.ok}>✓ Saved</span>}
              {save.err && <span style={S.err}>{save.err}</span>}
            </div>
            <div style={S.hint}>Logo &amp; colours come from <b>Menu appearance</b>. You can also set a logo just for this card under “Look” below.</div>
          </div>

          <div style={S.card}>
            <h2 style={S.h2}>Look</h2>
            <div style={S.field}>
              <label style={S.label}>Background image</label>
              {copy.hero_image_url ? (
                <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                  <img src={copy.hero_image_url} alt="Background" style={{ width: 96, height: 60, objectFit: 'cover', borderRadius: 8, border: '1px solid var(--bdr)' }} />
                  <label style={{ ...S.ghost, display: 'inline-block' }}>{bgBusy ? 'Uploading…' : 'Replace'}<input type="file" accept="image/*" onChange={onBgFile} style={{ display: 'none' }} /></label>
                  <button style={S.ghost} onClick={() => persist({ hero_image_url: '' })}>Remove</button>
                </div>
              ) : (
                <label style={{ ...S.ghost, display: 'inline-block' }}>{bgBusy ? 'Uploading…' : 'Upload background'}<input type="file" accept="image/*" onChange={onBgFile} style={{ display: 'none' }} /></label>
              )}
              <div style={S.hint}>A photo of your venue/food works well. It sits behind the card with a subtle dark overlay for legibility. JPG or PNG.</div>
            </div>
            <div style={S.field}>
              <label style={S.label}>Logo for this card (optional)</label>
              {venue.branding?.review_logo_url ? (
                <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                  <div style={{ padding: 6, background: '#0e0e10', borderRadius: 8, border: '1px solid var(--bdr)' }}>
                    <img src={venue.branding.review_logo_url} alt="Review logo" style={{ height: 34, width: 'auto', maxWidth: 120, objectFit: 'contain', display: 'block' }} />
                  </div>
                  <label style={{ ...S.ghost, display: 'inline-block' }}>{logoBusy ? 'Uploading…' : 'Replace'}<input type="file" accept="image/*" onChange={onLogoFile} style={{ display: 'none' }} /></label>
                  <button style={S.ghost} onClick={() => persistBranding({ review_logo_url: '' })}>Remove</button>
                </div>
              ) : (
                <label style={{ ...S.ghost, display: 'inline-block' }}>{logoBusy ? 'Uploading…' : 'Upload logo'}<input type="file" accept="image/*" onChange={onLogoFile} style={{ display: 'none' }} /></label>
              )}
              <div style={S.hint}>Only for the review card. Handy when a background photo makes your normal logo hard to read — upload a version tuned for it (e.g. a white logo). It shows as-is (no white plate). Leave blank to use your menu logo on a white plate.</div>
            </div>
            <div style={S.field}>
              <label style={S.label}>Button style</label>
              <div style={{ display: 'flex', gap: 8 }}>
                {[['dark', 'Dark'], ['accent', 'Brand colour']].map(([k, l]) =>
                  <button key={k} onClick={() => persist({ card_button_style: k })}
                    style={{ padding: '8px 14px', borderRadius: 8, border: '1px solid var(--bdr2)', cursor: 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'inherit', background: copy.card_button_style === k ? 'var(--acc)' : 'var(--bg2)', color: copy.card_button_style === k ? '#0b0c10' : 'var(--t2)' }}>{l}</button>)}
              </div>
            </div>
          </div>

          <div style={S.card}>
            <h2 style={S.h2}>Share it</h2>
            {reviewUrl ? (
              <>
                <label style={S.label}>Customer link</label>
                <div style={S.linkBox}>
                  <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: 'var(--t2)', fontFamily: 'var(--font-mono,monospace)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{reviewUrl}</span>
                  <button style={S.ghost} onClick={copyLink}>{copied ? 'Copied ✓' : 'Copy'}</button>
                </div>
                <div style={{ display: 'flex', gap: 16, alignItems: 'center', marginTop: 14 }}>
                  {qr && <img src={qr} alt="Review card QR" width={104} height={104} style={{ borderRadius: 8, border: '1px solid var(--bdr)' }} />}
                  <div style={{ fontSize: 12.5, color: 'var(--t3)', lineHeight: 1.5 }}>
                    Put this QR on tables, receipts or the counter. {qr && <a href={qr} download={`review-qr-${venue.slug}.png`} style={{ color: 'var(--acc)', fontWeight: 700 }}>Download QR</a>}
                  </div>
                </div>
              </>
            ) : (
              <div style={S.hint}>This venue has no online slug yet — set one in Settings → Location → online ordering to get a shareable review link.</div>
            )}
          </div>
        </div>

        {/* ── right: live phone preview ── */}
        <div style={{ position: 'sticky', top: 8 }}>
          <div style={{ display: 'flex', gap: 6, marginBottom: 10, justifyContent: 'center' }}>
            {[['rate', 'Rate'], ['happy', 'Happy'], ['private', 'Needs work']].map(([k, l]) =>
              <button key={k} style={S.chip(preview === k)} onClick={() => setPreview(k)}>{l}</button>)}
          </div>
          <Phone accent={accent} logo={reviewLogo || logo} rawLogo={!!reviewLogo} venue={venue.name} copy={copy} state={preview} />
        </div>
      </div>
    </div>
  );
}

// Faithful mini-render of ReviewSurface (the customer card).
function Phone({ accent, logo, rawLogo, venue, copy, state }) {
  const bg = copy.hero_image_url || null;
  const btnBg = copy.card_button_style === 'accent' ? accent : '#1f1f24';
  const heroBgStyle = bg
    ? { backgroundImage: `linear-gradient(rgba(0,0,0,.32), rgba(0,0,0,.42)), url("${bg}")`, backgroundSize: 'cover', backgroundPosition: 'center', minHeight: 84 }
    : { background: `linear-gradient(135deg, ${accent}14, ${accent}05)` };
  const screenBg = bg
    ? { background: `linear-gradient(rgba(15,15,20,.5), rgba(15,15,20,.62)), url("${bg}") center/cover` }
    : { background: '#e9e9ec' };
  const P = {
    frame: { width: 280, margin: '0 auto', background: '#0e0e10', borderRadius: 30, padding: 9 },
    screen:{ ...screenBg, borderRadius: 22, padding: 14, fontFamily: '"Hanken Grotesk",system-ui,sans-serif' },
    cardEl:{ background: '#fff', borderRadius: 20, overflow: 'hidden' },
    hero:  { padding: '20px 14px', display: 'flex', alignItems: 'center', justifyContent: 'center', ...heroBgStyle },
    logo:  { border: `1.5px dashed ${bg ? 'rgba(255,255,255,.7)' : `${accent}66`}`, borderRadius: 9, padding: '8px 14px', fontSize: 13, fontWeight: 800, color: bg ? '#fff' : accent },
    body:  { padding: '16px 15px 18px' },
    title: { fontSize: 16, fontWeight: 800, color: '#1f1f24', letterSpacing: '-.02em', margin: '0 0 5px' },
    sub:   { fontSize: 11.5, color: '#56565e', lineHeight: 1.4, margin: '0 0 12px' },
    dark:  { background: btnBg, color: '#fff', borderRadius: 9, padding: 10, textAlign: 'center', fontSize: 13, fontWeight: 700 },
    field: { border: '1px solid #ececef', borderRadius: 9, background: '#fafafb', padding: '8px 10px', fontSize: 11, color: '#9a9aa2' },
  };
  return (
    <div style={P.frame}><div style={P.screen}><div style={P.cardEl}>
      <div style={P.hero}>{logo
        ? (rawLogo
            ? <img src={logo} alt={venue} style={{ maxHeight: 42, maxWidth: '72%', objectFit: 'contain' }} />
            : <div style={{ background: '#fff', borderRadius: 9, padding: '7px 11px', boxShadow: '0 4px 14px rgba(0,0,0,.22)', display: 'inline-flex', maxWidth: '74%' }}><img src={logo} alt={venue} style={{ height: 30, width: 'auto', maxWidth: '100%', objectFit: 'contain', display: 'block' }} /></div>)
        : <div style={P.logo}>{venue}</div>}</div>
      <div style={P.body}>
        {state === 'rate' && <>
          <div style={P.title}>{copy.page_title}</div>
          <div style={P.sub}>{copy.intro_copy}</div>
          <div style={{ textAlign: 'center', fontSize: 26, letterSpacing: 3, color: '#e0b748' }}>★★★★<span style={{ color: '#d6d6dc' }}>★</span></div>
          <div style={{ textAlign: 'center', fontSize: 9.5, fontWeight: 800, letterSpacing: '.16em', color: accent, margin: '4px 0 10px', fontFamily: 'ui-monospace,monospace' }}>GOOD</div>
          <div style={{ ...P.field, minHeight: 34 }}>Tell us what stood out…</div>
          <div style={{ ...P.dark, marginTop: 10 }}>Send</div>
        </>}
        {state === 'happy' && <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 26, marginBottom: 2 }}>🎉</div>
          <div style={P.title}>{copy.thanks_public_copy}</div>
          <div style={P.sub}>Would you share it on Google? One tap and it really helps {venue}.</div>
          <div style={{ ...P.dark, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7 }}>
            <span style={{ width: 18, height: 18, borderRadius: 99, background: '#fff', color: '#4285F4', fontWeight: 800, fontSize: 11, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>G</span> Post my review on Google
          </div>
        </div>}
        {state === 'private' && <>
          <div style={P.title}>{copy.thanks_private_copy}</div>
          <div style={P.sub}>Tell us what happened — it goes straight to the manager.</div>
          <div style={{ ...P.field, minHeight: 30 }}>What happened?</div>
          <div style={{ ...P.field, marginTop: 7 }}>Email (optional)</div>
          <div style={{ ...P.dark, marginTop: 9 }}>Send to the manager</div>
          <div style={{ textAlign: 'center', marginTop: 9, fontSize: 10.5, color: '#56565e', textDecoration: 'underline' }}>Or post on Google →</div>
        </>}
      </div>
    </div></div></div>
  );
}
