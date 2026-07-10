// src/surfaces/ReviewSurface.jsx
//
// Screen 01 — Customer review card (public, mobile-first, no auth).
// Branded hero + 5-star selector (BAD/POOR/OK/GOOD/GREAT) + feedback. On Send
// the SERVER decides the branch (review-submit enforces is_public = rating >=
// venue threshold): happy → "thanks, we're posting it" with per-platform status;
// unhappy → private "tell us more + optional contact", never posted publicly.
//
// Part of Review Manager. Styling follows the design handoff (clean light card,
// the venue's brand accent); reuses the venue's online_branding for logo/colour.

import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

const STAR_LABELS = ['BAD', 'POOR', 'OK', 'GOOD', 'GREAT'];
const FALLBACK_ACCENT = '#5a51c2';
const PLATFORM_LABEL = { google: 'Google', tripadvisor: 'TripAdvisor', facebook: 'Facebook' };

async function callReview(body) {
  if (!supabase) return { mock: true };
  const { data, error } = await supabase.functions.invoke('review-submit', { body });
  if (error) {
    let msg = error.message || 'Something went wrong';
    try { const b = await error.context?.json?.(); if (b?.error) msg = b.error; } catch { /* keep */ }
    throw new Error(msg);
  }
  if (data?.error) throw new Error(data.error);
  return data;
}

export default function ReviewSurface({ location }) {
  const brand = location.online_branding || {};
  const accent = brand.accent_color || brand.primary_color || FALLBACK_ACCENT;
  const logo = brand.logo_url || null;
  const venueName = location.name || 'us';

  const [cfg, setCfg] = useState(null);
  const [phase, setPhase] = useState('rate');   // rate | sending | happy | unhappy | private_sent
  const [rating, setRating] = useState(0);
  const [hover, setHover] = useState(0);
  const [comment, setComment] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);    // { feedback_id, is_public, platforms }
  // recovery (private) form
  const [detail, setDetail] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [savingContact, setSavingContact] = useState(false);

  useEffect(() => {
    let off = false;
    callReview({ action: 'card_config', platform_location_id: location.id })
      .then((c) => { if (!off) setCfg(c || {}); })
      .catch(() => { if (!off) setCfg({}); });
    return () => { off = true; };
  }, [location.id]);

  const submit = async () => {
    if (!rating) { setError('Tap a star to rate us first.'); return; }
    setError(''); setPhase('sending');
    try {
      const r = await callReview({
        action: 'submit', platform_location_id: location.id,
        rating, comment: comment.trim() || null, channel: 'web',
      });
      setResult(r);
      setDetail(comment.trim());
      setPhase('thanks');   // de-gated: one honest outcome; everyone is offered the public path
    } catch (e) {
      setError(e.message || 'Could not send — please try again.');
      setPhase('rate');
    }
  };

  const sendPrivate = async () => {
    setSavingContact(true); setError('');
    try {
      await callReview({
        action: 'add_contact', feedback_id: result?.feedback_id,
        private_detail: detail.trim() || null,
        customer_email: email.trim() || null,
        customer_phone: phone.trim() || null,
      });
      setPhase('private_sent');
    } catch (e) {
      setError(e.message || 'Could not send — please try again.');
    } finally {
      setSavingContact(false);
    }
  };

  const heroBg = cfg?.hero_image_url || null;
  const btnBg = cfg?.card_button_style === 'accent' ? accent : '#1f1f24';
  const pageStyle = heroBg
    ? { ...S.page, background: `linear-gradient(rgba(15,15,20,.5), rgba(15,15,20,.62)), url("${heroBg}")`, backgroundSize: 'cover', backgroundPosition: 'center', backgroundAttachment: 'fixed' }
    : S.page;
  return (
    <div style={pageStyle}>
      <div style={S.card}>
        {/* Brand hero — show the venue's background image if set, else a soft brand tint */}
        <div style={{ ...S.hero, ...(heroBg ? { backgroundImage: `linear-gradient(rgba(0,0,0,.32), rgba(0,0,0,.42)), url("${heroBg}")`, backgroundSize: 'cover', backgroundPosition: 'center', minHeight: 120 } : { background: `linear-gradient(135deg, ${accent}14, ${accent}05)` }) }}>
          {logo
            /* v5.5.751: logo on a white plate so it reads on any background photo (was laid
               straight on the image, so a dark wordmark vanished into the photo). */
            ? <div style={{ background: '#fff', borderRadius: 14, padding: '10px 16px', boxShadow: '0 6px 20px rgba(0,0,0,0.22)', display: 'inline-flex', maxWidth: '78%', boxSizing: 'border-box' }}>
                <img src={logo} alt={venueName} style={{ height: 46, width: 'auto', maxWidth: '100%', objectFit: 'contain', display: 'block' }} />
              </div>
            : <div style={{ ...S.logoBox, borderColor: heroBg ? 'rgba(255,255,255,.7)' : `${accent}55`, color: heroBg ? '#fff' : accent }}>{venueName}</div>}
        </div>

        <div style={{ padding: '24px 22px 28px' }}>
          {phase === 'rate' || phase === 'sending' ? (
            <>
              <h1 style={S.h1}>{cfg?.page_title || `How did we do?`}</h1>
              <p style={S.sub}>{cfg?.intro_copy || `Your feedback helps ${venueName} get better.`}</p>

              {/* Star selector */}
              <div style={S.stars} onMouseLeave={() => setHover(0)}>
                {[1, 2, 3, 4, 5].map((n) => {
                  const on = (hover || rating) >= n;
                  return (
                    <button key={n} type="button" aria-label={`${n} star`}
                      onMouseEnter={() => setHover(n)} onClick={() => { setRating(n); setError(''); }}
                      style={{ ...S.star, color: on ? '#e0b748' : '#d6d6dc' }}>★</button>
                  );
                })}
              </div>
              <div style={{ ...S.starLabel, color: rating ? accent : '#9a9aa2' }}>
                {rating ? STAR_LABELS[rating - 1] : 'Tap to rate'}
              </div>

              <textarea value={comment} onChange={(e) => setComment(e.target.value)}
                placeholder="Tell us what stood out (optional)…" rows={4} style={S.textarea} />

              {error && <div style={S.err}>{error}</div>}

              <button onClick={submit} disabled={phase === 'sending'} style={{ ...S.sendBtn, background: btnBg }}>
                {phase === 'sending' ? 'Sending…' : 'Send →'}
              </button>
            </>
          ) : phase === 'thanks' ? (
            result?.low_rating ? (
              // Low rating: lead with the private manager route, but the public
              // Google path is still OFFERED (never hidden) — de-gating compliance.
              <>
                <h1 style={S.h1}>{cfg?.thanks_private_copy || 'Sorry we missed the mark.'}</h1>
                <p style={S.sub}>Tell us what happened — it goes straight to the manager so we can put it right.</p>
                <textarea value={detail} onChange={(e) => setDetail(e.target.value)} rows={4}
                  placeholder="What happened?" style={S.textarea} />
                <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
                  <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" placeholder="Email (optional)" style={S.input} />
                  <input value={phone} onChange={(e) => setPhone(e.target.value)} type="tel" placeholder="Phone (optional)" style={S.input} />
                </div>
                {error && <div style={S.err}>{error}</div>}
                <button onClick={sendPrivate} disabled={savingContact} style={{ ...S.sendBtn, background: btnBg }}>
                  {savingContact ? 'Sending…' : 'Send to the manager'}
                </button>
                {result?.google_review_url && (
                  <a href={result.google_review_url} target="_blank" rel="noopener noreferrer" style={S.googleLinkSecondary}>
                    Or post your review publicly on Google →
                  </a>
                )}
              </>
            ) : (
              // Happy: invite (don't auto-post — no platform allows that) a Google review.
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 44, marginBottom: 6 }}>🎉</div>
                <h1 style={S.h1}>{cfg?.thanks_public_copy || 'Thanks — that means a lot!'}</h1>
                <p style={S.sub}>If you’ve got a moment, would you share it on Google? It only takes a tap and really helps {venueName}.</p>
                {result?.google_review_url
                  ? <a href={result.google_review_url} target="_blank" rel="noopener noreferrer" style={{ ...S.googleBtn, background: btnBg }}><span style={S.gG}>G</span>&nbsp; Post my review on Google</a>
                  : <p style={{ fontSize: 13, color: '#9a9aa2' }}>Thanks again — we really appreciate it!</p>}
              </div>
            )
          ) : (
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 44, marginBottom: 6 }}>🙏</div>
              <h1 style={S.h1}>Thank you — we'll make this right.</h1>
              <p style={S.sub}>The manager at {venueName} has your feedback and will follow up{email || phone ? ' using the details you left' : ''}.</p>
            </div>
          )}
        </div>

        <div style={S.footer}>Powered by Serv OS</div>
      </div>
    </div>
  );
}

const S = {
  page: { minHeight: '100vh', background: '#e9e9ec', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '32px 16px', fontFamily: '"Hanken Grotesk", system-ui, -apple-system, sans-serif' },
  card: { width: '100%', maxWidth: 440, background: '#fff', borderRadius: 26, overflow: 'hidden', boxShadow: '0 10px 28px rgba(0,0,0,0.08)' },
  hero: { padding: '34px 22px', display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 96 },
  logoBox: { border: '1.5px dashed', borderRadius: 12, padding: '12px 20px', fontSize: 18, fontWeight: 800, letterSpacing: '-0.01em' },
  h1: { fontSize: 22, fontWeight: 800, color: '#1f1f24', margin: '0 0 8px', letterSpacing: '-0.02em', lineHeight: 1.2 },
  sub: { fontSize: 14, color: '#56565e', margin: '0 0 18px', lineHeight: 1.5 },
  stars: { display: 'flex', justifyContent: 'center', gap: 6, margin: '6px 0 2px' },
  star: { background: 'none', border: 'none', cursor: 'pointer', fontSize: 40, lineHeight: 1, padding: 2, transition: 'color .12s, transform .12s' },
  starLabel: { textAlign: 'center', fontSize: 12, fontWeight: 800, letterSpacing: '0.16em', textTransform: 'uppercase', marginBottom: 16, fontFamily: '"Spline Sans Mono", ui-monospace, monospace' },
  textarea: { width: '100%', boxSizing: 'border-box', border: '1px solid #ececef', borderRadius: 12, padding: '12px 14px', fontSize: 14, fontFamily: 'inherit', resize: 'vertical', outline: 'none', color: '#1f1f24', background: '#fafafb' },
  input: { width: '100%', boxSizing: 'border-box', border: '1px solid #ececef', borderRadius: 10, padding: '11px 14px', fontSize: 14, fontFamily: 'inherit', outline: 'none', color: '#1f1f24', background: '#fafafb' },
  sendBtn: { width: '100%', marginTop: 16, padding: '15px', borderRadius: 12, background: '#1f1f24', color: '#fff', border: 'none', fontSize: 16, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' },
  googleBtn: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '100%', boxSizing: 'border-box', marginTop: 8, padding: '15px', borderRadius: 12, background: '#1f1f24', color: '#fff', fontSize: 16, fontWeight: 700, textDecoration: 'none' },
  gG: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 24, height: 24, borderRadius: 99, background: '#fff', color: '#4285F4', fontWeight: 800, fontSize: 14 },
  googleLinkSecondary: { display: 'block', textAlign: 'center', marginTop: 14, fontSize: 13, color: '#56565e', textDecoration: 'underline' },
  err: { marginTop: 12, fontSize: 13, color: '#b06a3c', fontWeight: 600 },
  platforms: { marginTop: 18, display: 'grid', gap: 8, textAlign: 'left' },
  platformRow: { display: 'flex', alignItems: 'center', gap: 10, padding: '11px 14px', background: '#f5faf7', border: '1px solid #d3e7da', borderRadius: 12, fontSize: 14, color: '#1f1f24' },
  platformDot: { width: 26, height: 26, borderRadius: 8, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 800 },
  posting: { fontSize: 12, fontWeight: 700, color: '#3f7a55' },
  privateNote: { marginTop: 12, fontSize: 12, color: '#8a542e', background: '#f8f1ea', border: '1px solid #eaddce', borderRadius: 10, padding: '9px 12px' },
  footer: { textAlign: 'center', fontSize: 11, color: '#9a9aa2', padding: '14px', borderTop: '1px solid #f0f0f3', fontFamily: '"Spline Sans Mono", ui-monospace, monospace', letterSpacing: '0.06em' },
};
