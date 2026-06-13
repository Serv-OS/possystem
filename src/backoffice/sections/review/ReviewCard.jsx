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
import { customerUrl } from '../../../lib/env';
import QRCode from 'qrcode';

const FALLBACK_ACCENT = '#5a51c2';
const DEFAULTS = {
  page_title: 'How was your visit?',
  intro_copy: 'We’d love to hear how we did — it only takes a few seconds.',
  thanks_public_copy: 'Thanks — that means a lot!',
  thanks_private_copy: 'Sorry we missed the mark.',
};

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
  const [venue, setVenue] = useState({ name: 'Your venue', slug: null, branding: {} });
  const [copy, setCopy] = useState(DEFAULTS);
  const [save, setSave] = useState({});
  const [preview, setPreview] = useState('rate');   // rate | happy | private
  const [qr, setQr] = useState(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const id = await getActiveLocationSync();
        setLocId(id);
        if (!supabase || !id) { setLoading(false); return; }
        // venue brand + slug (platform locations — readable by the BO client)
        let v = { name: 'Your venue', slug: null, branding: {} };
        try {
          const { data: loc } = await platformSupabase.from('locations')
            .select('name, online_slug, online_branding').or(`ops_location_id.eq.${id},id.eq.${id}`).maybeSingle();
          if (loc) v = { name: loc.name || 'Your venue', slug: loc.online_slug || null, branding: loc.online_branding || {} };
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
            <div style={S.hint}>Logo &amp; colours come from this venue’s brand kit (Settings → Location → branding).</div>
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
          <Phone accent={accent} logo={logo} venue={venue.name} copy={copy} state={preview} />
        </div>
      </div>
    </div>
  );
}

// Faithful mini-render of ReviewSurface (the customer card).
function Phone({ accent, logo, venue, copy, state }) {
  const P = {
    frame: { width: 280, margin: '0 auto', background: '#0e0e10', borderRadius: 30, padding: 9 },
    screen:{ background: '#e9e9ec', borderRadius: 22, padding: 14, fontFamily: '"Hanken Grotesk",system-ui,sans-serif' },
    cardEl:{ background: '#fff', borderRadius: 20, overflow: 'hidden' },
    hero:  { padding: '20px 14px', display: 'flex', alignItems: 'center', justifyContent: 'center', background: `linear-gradient(135deg, ${accent}14, ${accent}05)` },
    logo:  { border: `1.5px dashed ${accent}66`, borderRadius: 9, padding: '8px 14px', fontSize: 13, fontWeight: 800, color: accent },
    body:  { padding: '16px 15px 18px' },
    title: { fontSize: 16, fontWeight: 800, color: '#1f1f24', letterSpacing: '-.02em', margin: '0 0 5px' },
    sub:   { fontSize: 11.5, color: '#56565e', lineHeight: 1.4, margin: '0 0 12px' },
    dark:  { background: '#1f1f24', color: '#fff', borderRadius: 9, padding: 10, textAlign: 'center', fontSize: 13, fontWeight: 700 },
    field: { border: '1px solid #ececef', borderRadius: 9, background: '#fafafb', padding: '8px 10px', fontSize: 11, color: '#9a9aa2' },
  };
  return (
    <div style={P.frame}><div style={P.screen}><div style={P.cardEl}>
      <div style={P.hero}>{logo ? <img src={logo} alt={venue} style={{ maxHeight: 38, maxWidth: '70%', objectFit: 'contain' }} /> : <div style={P.logo}>{venue}</div>}</div>
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
