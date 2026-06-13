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
      setPhase(r.is_public ? 'happy' : 'unhappy');
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

  return (
    <div style={S.page}>
      <div style={S.card}>
        {/* Brand hero */}
        <div style={{ ...S.hero, background: `linear-gradient(135deg, ${accent}14, ${accent}05)` }}>
          {logo
            ? <img src={logo} alt={venueName} style={{ maxHeight: 56, maxWidth: '70%', objectFit: 'contain' }} />
            : <div style={{ ...S.logoBox, borderColor: `${accent}55`, color: accent }}>{venueName}</div>}
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

              <button onClick={submit} disabled={phase === 'sending'} style={S.sendBtn}>
                {phase === 'sending' ? 'Sending…' : 'Send →'}
              </button>
            </>
          ) : phase === 'happy' ? (
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 44, marginBottom: 6 }}>🎉</div>
              <h1 style={S.h1}>{cfg?.thanks_public_copy || 'Thanks — that means a lot!'}</h1>
              <p style={S.sub}>
                {result?.platforms?.length
                  ? 'Your review is being posted to our pages automatically.'
                  : 'Thanks for the kind words — we really appreciate it.'}
              </p>
              {result?.platforms?.length > 0 && (
                <div style={S.platforms}>
                  {result.platforms.map((p) => (
                    <div key={p.platform} style={S.platformRow}>
                      <span style={{ ...S.platformDot, background: accent }}>{(PLATFORM_LABEL[p.platform] || p.platform)[0]}</span>
                      <span style={{ flex: 1, textAlign: 'left', fontWeight: 600 }}>{PLATFORM_LABEL[p.platform] || p.platform}</span>
                      <span style={S.posting}>⟳ Posting…</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : phase === 'unhappy' ? (
            <>
              <h1 style={S.h1}>{cfg?.thanks_private_copy || 'Sorry we missed the mark.'}</h1>
              <p style={S.sub}>Tell us what happened — this goes <strong>privately</strong> to the manager, not posted publicly.</p>
              <textarea value={detail} onChange={(e) => setDetail(e.target.value)} rows={4}
                placeholder="What happened?" style={S.textarea} />
              <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
                <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" placeholder="Email (optional)" style={S.input} />
                <input value={phone} onChange={(e) => setPhone(e.target.value)} type="tel" placeholder="Phone (optional)" style={S.input} />
              </div>
              <div style={S.privateNote}>🔒 Not posted publicly — only the venue sees this.</div>
              {error && <div style={S.err}>{error}</div>}
              <button onClick={sendPrivate} disabled={savingContact} style={S.sendBtn}>
                {savingContact ? 'Sending…' : 'Send privately'}
              </button>
            </>
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
  err: { marginTop: 12, fontSize: 13, color: '#b06a3c', fontWeight: 600 },
  platforms: { marginTop: 18, display: 'grid', gap: 8, textAlign: 'left' },
  platformRow: { display: 'flex', alignItems: 'center', gap: 10, padding: '11px 14px', background: '#f5faf7', border: '1px solid #d3e7da', borderRadius: 12, fontSize: 14, color: '#1f1f24' },
  platformDot: { width: 26, height: 26, borderRadius: 8, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 800 },
  posting: { fontSize: 12, fontWeight: 700, color: '#3f7a55' },
  privateNote: { marginTop: 12, fontSize: 12, color: '#8a542e', background: '#f8f1ea', border: '1px solid #eaddce', borderRadius: 10, padding: '9px 12px' },
  footer: { textAlign: 'center', fontSize: 11, color: '#9a9aa2', padding: '14px', borderTop: '1px solid #f0f0f3', fontFamily: '"Spline Sans Mono", ui-monospace, monospace', letterSpacing: '0.06em' },
};
