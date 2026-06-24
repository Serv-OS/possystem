// src/surfaces/waitlist/WaitlistJoinSurface.jsx
//
// F2 — Tables Ready GUEST SELF-SERVICE surface (public, anonymous). Two views:
//   • view="join"    QR landing → name + phone + party size (+ optional zone) → self-join.
//   • view="status"  Live status page → position in queue + quoted wait + lifecycle, with
//                    "On my way" / "Cancel my spot" actions. Polls every 5s.
//
// Mirrors the customer-surface idioms used elsewhere in the app:
//   • ensureAuthToken() then a public-config RPC, "not available" screen when null
//     (CateringSurface).
//   • 5s polling status page + a bookmarkable ?t= URL that preserves ?loc=
//     (OrderTracker / its ShareLink).
//   • Branded LIGHT card chrome from location.online_branding — NOT the dark host skin
//     (ReviewSurface / WifiSurface).
//
// All DB access goes through the Agent-B data layer (src/lib/waitlist/waitlistData.js),
// which is isMock-safe AND table/RPC-absent-safe — every call returns empty/null rather
// than throwing, so this surface degrades softly when 20260623v isn't applied yet.

import { useEffect, useMemo, useState } from 'react';
import { ensureAuthToken } from '../../lib/supabase';
import {
  waitlistPublicConfig,
  waitlistSelfJoin,
  waitlistSelfStatus,
  waitlistSelfUpdate,
} from '../../lib/waitlist/waitlistData';
import { normalisePhone } from '../../lib/customerLookup';

const FONT = '-apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", system-ui, sans-serif';
const FALLBACK_ACCENT = '#15C36B';
const POLL_MS = 5_000;

// ── small helpers ─────────────────────────────────────────────────────────────

// Read the current ?loc=<slug> (preserved across the bookmarkable status URL).
function readSlug() {
  try { return new URLSearchParams(window.location.search || '').get('loc') || null; } catch { return null; }
}
// Read ?t=<token> for the status view (a returning/bookmarked guest).
function readToken() {
  try { return new URLSearchParams(window.location.search || '').get('t') || null; } catch { return null; }
}

// Contrast a hex colour to pick a readable foreground for accent-filled buttons.
function contrastFg(hex) {
  if (!hex) return '#fff';
  const c = String(hex).replace('#', '');
  const n = c.length === 3 ? c.split('').map((x) => x + x).join('') : c;
  if (n.length !== 6) return '#fff';
  const r = parseInt(n.slice(0, 2), 16), g = parseInt(n.slice(2, 4), 16), b = parseInt(n.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) > 128 ? '#1f1f24' : '#ffffff';
}

export default function WaitlistJoinSurface({ location, view = 'join' }) {
  // opsId is the OPS location id — the RPC contract keys on location.ops_location_id.
  const opsId = location.ops_location_id || location.id;
  const brand = location.online_branding || {};
  const venueName = location.name || 'us';
  const accent = brand.accent_color || brand.primary_color || FALLBACK_ACCENT;
  const logo = brand.logo_url || null;
  const slug = useMemo(readSlug, []);

  // boot: 'loading' | 'closed' (RPC null / disabled) | 'ready'
  const [boot, setBoot] = useState('loading');
  const [cfg, setCfg] = useState(null);            // { enabled, zones }
  const [mode, setMode] = useState(view);          // local view; flips join → status after a join

  // Join form
  const [form, setForm] = useState({ name: '', phone: '', size: 2, zone: '' });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  // Status
  const [token, setToken] = useState(view === 'status' ? readToken() : null);
  const [status, setStatus] = useState(null);      // mapped self-status payload
  const [statusErr, setStatusErr] = useState('');
  const [acting, setActing] = useState(false);

  // ── boot: auth then public config (null/!enabled = not open) ──────────────────
  useEffect(() => {
    let off = false;
    (async () => {
      try { await ensureAuthToken(); } catch { /* anon best-effort */ }
      const c = await waitlistPublicConfig(opsId);
      if (off) return;
      if (!c || !c.enabled) { setBoot('closed'); return; }
      setCfg(c);
      setBoot('ready');
    })();
    return () => { off = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opsId]);

  // ── status polling (status view, once we have a token) ────────────────────────
  useEffect(() => {
    if (mode !== 'status' || !token) return;
    let alive = true;
    const tick = async () => {
      const s = await waitlistSelfStatus(token);
      if (!alive) return;
      if (!s || s.found === false) { setStatusErr('not_found'); setStatus(null); return; }
      setStatusErr('');
      setStatus(s);
    };
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => { alive = false; clearInterval(id); };
  }, [mode, token]);

  const zones = Array.isArray(cfg?.zones) ? cfg.zones.filter(Boolean) : [];

  // ── join submit ───────────────────────────────────────────────────────────────
  const submitJoin = async () => {
    const name = form.name.trim();
    const phoneN = normalisePhone(form.phone);
    const size = Math.max(1, Math.round(Number(form.size) || 0));
    if (!name) { setError('Please enter your name.'); return; }
    if (!phoneN || phoneN.length < 7) { setError('Please enter a valid mobile number so we can text you.'); return; }
    setError(''); setSubmitting(true);
    try {
      const res = await waitlistSelfJoin({
        locationId: opsId, name, phone: phoneN, size,
        notes: '', zone: form.zone || null,
      });
      if (!res || !res.token) {
        setError('Sorry — we couldn’t add you to the list. Please see the host.');
        return;
      }
      // Make the status page bookmarkable: /waitlist/status?loc=<slug>&t=<token>,
      // preserving the ?loc= slug that resolved this venue (subdomain or query).
      try {
        const u = new URL(window.location.origin + '/waitlist/status');
        if (slug) u.searchParams.set('loc', slug);
        u.searchParams.set('t', res.token);
        window.history.pushState({}, '', u.toString());
      } catch { /* non-fatal — state still flips to status below */ }
      setToken(res.token);
      setStatus(null);
      setStatusErr('');
      setMode('status');
    } finally {
      setSubmitting(false);
    }
  };

  // ── status actions ────────────────────────────────────────────────────────────
  const doOnMyWay = async () => {
    if (!token || acting) return;
    setActing(true);
    const r = await waitlistSelfUpdate(token, 'on_my_way');
    setActing(false);
    if (r?.ok) {
      // Optimistic: stamp confirmedAt locally; the next 5s poll reconciles.
      setStatus((s) => (s ? { ...s, confirmedAt: Date.now(), status: r.status || s.status } : s));
    }
  };
  const doCancel = async () => {
    if (!token || acting) return;
    if (!window.confirm('Cancel your spot in the queue? This can’t be undone.')) return;
    setActing(true);
    const r = await waitlistSelfUpdate(token, 'cancel');
    setActing(false);
    if (r?.ok) setStatus((s) => (s ? { ...s, status: r.status || 'cancelled' } : s));
  };

  // ── chrome ────────────────────────────────────────────────────────────────────
  const page = brand.bg_image_url
    ? { ...S.page, background: `linear-gradient(rgba(15,15,20,.55), rgba(15,15,20,.7)), url("${brand.bg_image_url}")`, backgroundSize: 'cover', backgroundPosition: 'center' }
    : { ...S.page, background: '#0e0e10' };

  const Card = ({ children }) => (
    <div style={page}>
      <div style={S.card}>
        <div style={{ ...S.hero, background: `linear-gradient(135deg, ${accent}22, ${accent}08)` }}>
          {logo
            ? <img src={logo} alt={venueName} style={{ maxHeight: 60, maxWidth: '72%', objectFit: 'contain' }} />
            : <div style={{ ...S.logoBox, borderColor: `${accent}66` }}>{venueName}</div>}
        </div>
        <div style={{ padding: '22px 22px 26px' }}>{children}</div>
        <div style={S.footer}>Powered by Serv OS</div>
      </div>
    </div>
  );

  // ── boot states ───────────────────────────────────────────────────────────────
  if (boot === 'loading') {
    return <Card><div style={{ textAlign: 'center', padding: '28px 0' }}>
      <div style={{ fontSize: 40, marginBottom: 8 }}>⏳</div>
      <p style={S.sub}>One moment…</p>
    </div></Card>;
  }
  if (boot === 'closed') {
    return <Card><div style={{ textAlign: 'center', padding: '14px 0' }}>
      <div style={{ fontSize: 44, marginBottom: 8 }}>📋</div>
      <h1 style={S.h1}>Waitlist isn’t open right now</h1>
      <p style={S.sub}>Please see the host — they’ll get you on the list.</p>
    </div></Card>;
  }

  // ── STATUS view ─────────────────────────────────────────────────────────────────
  if (mode === 'status') {
    if (!token || statusErr === 'not_found') {
      return <Card><div style={{ textAlign: 'center', padding: '14px 0' }}>
        <div style={{ fontSize: 44, marginBottom: 8 }}>🔎</div>
        <h1 style={S.h1}>We couldn’t find your place</h1>
        <p style={S.sub}>This link may have expired. Please see the host to re-join.</p>
        <button onClick={() => { setMode('join'); setToken(null); }} style={{ ...S.btnOutline, marginTop: 14, color: accent, borderColor: `${accent}66` }}>Join the waitlist</button>
      </div></Card>;
    }
    const st = status?.status || 'waiting';
    const ready = st === 'ready';
    const cancelled = st === 'cancelled' || st === 'no_show' || st === 'walked_away' || st === 'removed';
    const seated = st === 'seated' || st === 'completed';
    const terminal = cancelled || seated;

    return (
      <Card>
        {!status ? (
          <div style={{ textAlign: 'center', padding: '24px 0' }}>
            <div style={{ fontSize: 40, marginBottom: 8 }}>⏳</div>
            <p style={S.sub}>Checking your place in the queue…</p>
          </div>
        ) : (
          <>
            {/* Headline status banner */}
            {ready ? (
              <div style={{ ...S.banner, background: `${accent}18`, border: `1.5px solid ${accent}`, textAlign: 'center' }}>
                <div style={{ fontSize: 46, marginBottom: 6 }}>🎉</div>
                <div style={{ fontSize: 22, fontWeight: 900, color: '#1f1f24', letterSpacing: '-0.02em' }}>Your table is ready!</div>
                <div style={{ fontSize: 13.5, color: '#56565e', marginTop: 6 }}>Come and see the host now{status.partyName ? `, ${status.partyName}` : ''}.</div>
              </div>
            ) : cancelled ? (
              <div style={{ ...S.banner, background: '#fef2f2', border: '1.5px solid #fecaca', textAlign: 'center' }}>
                <div style={{ fontSize: 42, marginBottom: 6 }}>🚫</div>
                <div style={{ fontSize: 20, fontWeight: 900, color: '#b91c1c' }}>Cancelled</div>
                <div style={{ fontSize: 13, color: '#9a4444', marginTop: 6 }}>You’re no longer on the list. See the host if you’d like to re-join.</div>
              </div>
            ) : seated ? (
              <div style={{ ...S.banner, background: `${accent}14`, border: `1.5px solid ${accent}55`, textAlign: 'center' }}>
                <div style={{ fontSize: 42, marginBottom: 6 }}>✅</div>
                <div style={{ fontSize: 20, fontWeight: 900, color: '#1f1f24' }}>You’re seated</div>
                <div style={{ fontSize: 13, color: '#56565e', marginTop: 6 }}>Enjoy your visit!</div>
              </div>
            ) : (
              <div style={{ textAlign: 'center', marginBottom: 4 }}>
                <h1 style={S.h1}>You’re on the list{status.partyName ? `, ${status.partyName}` : ''}</h1>
                <p style={S.sub}>We’ll text you when your table’s nearly ready. Keep this page open.</p>
              </div>
            )}

            {/* Live metrics — position + quoted wait (hidden once terminal) */}
            {!terminal && (
              <div style={S.metricRow}>
                <div style={S.metric}>
                  <div style={{ ...S.metricNum, color: accent }}>
                    {status.position != null ? (status.position <= 1 ? 'Next' : `#${status.position}`) : '—'}
                  </div>
                  <div style={S.metricLbl}>In the queue</div>
                </div>
                <div style={S.metric}>
                  <div style={{ ...S.metricNum, color: '#1f1f24' }}>
                    {status.quotedWaitMin != null ? `~${status.quotedWaitMin}` : '—'}
                    {status.quotedWaitMin != null && <span style={{ fontSize: 14, fontWeight: 700 }}> min</span>}
                  </div>
                  <div style={S.metricLbl}>Estimated wait</div>
                </div>
              </div>
            )}

            {/* Party recap */}
            {status.partySize != null && !terminal && (
              <div style={S.recap}>
                Party of <b>{status.partySize}</b>
                {status.confirmedAt ? <span style={{ color: accent, fontWeight: 700 }}> · You’ve let us know you’re on your way ✓</span> : null}
              </div>
            )}

            {/* Actions — only while live (waiting/notified/ready) */}
            {!terminal && (
              <div style={{ display: 'grid', gap: 10, marginTop: 16 }}>
                <button
                  onClick={doOnMyWay}
                  disabled={acting || !!status.confirmedAt}
                  style={{ ...S.btn, background: accent, color: contrastFg(accent), opacity: (acting || status.confirmedAt) ? 0.6 : 1 }}
                >
                  {status.confirmedAt ? 'You’re on your way ✓' : (acting ? 'Sending…' : 'On my way')}
                </button>
                <button
                  onClick={doCancel}
                  disabled={acting}
                  style={{ ...S.btnOutline, color: '#b91c1c', borderColor: '#fecaca' }}
                >
                  Cancel my spot
                </button>
              </div>
            )}

            {/* Re-join from a terminal state */}
            {cancelled && (
              <button onClick={() => { setMode('join'); setToken(null); setStatus(null); }} style={{ ...S.btnOutline, marginTop: 16, color: accent, borderColor: `${accent}66` }}>
                Join the waitlist again
              </button>
            )}
          </>
        )}
      </Card>
    );
  }

  // ── JOIN view ───────────────────────────────────────────────────────────────────
  return (
    <Card>
      <h1 style={S.h1}>Join the waitlist</h1>
      <p style={S.sub}>Pop in your details and we’ll text you when your table’s nearly ready at {venueName}.</p>

      <div style={{ display: 'grid', gap: 10 }}>
        <input
          style={S.input}
          placeholder="Your name"
          value={form.name}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
        />
        <input
          style={S.input}
          type="tel"
          inputMode="tel"
          placeholder="Mobile number"
          value={form.phone}
          onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
        />

        <div>
          <div style={S.fieldLbl}>Party size</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button type="button" aria-label="Fewer" onClick={() => setForm((f) => ({ ...f, size: Math.max(1, Number(f.size) - 1) }))} style={S.stepper}>−</button>
            <div style={{ minWidth: 48, textAlign: 'center', fontSize: 26, fontWeight: 900, color: '#1f1f24', fontFamily: FONT }}>{form.size}</div>
            <button type="button" aria-label="More" onClick={() => setForm((f) => ({ ...f, size: Math.min(50, Number(f.size) + 1) }))} style={S.stepper}>+</button>
          </div>
        </div>

        {zones.length > 0 && (
          <div>
            <div style={S.fieldLbl}>Where would you like to sit? (optional)</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              <button
                type="button"
                onClick={() => setForm((f) => ({ ...f, zone: '' }))}
                style={{ ...S.zone, ...(form.zone === '' ? { background: accent, color: contrastFg(accent), borderColor: accent } : {}) }}
              >No preference</button>
              {zones.map((z) => {
                const val = typeof z === 'string' ? z : (z.id || z.name || z.label || '');
                const lbl = typeof z === 'string' ? z : (z.label || z.name || z.id || '');
                if (!val) return null;
                const on = form.zone === val;
                return (
                  <button
                    key={val}
                    type="button"
                    onClick={() => setForm((f) => ({ ...f, zone: val }))}
                    style={{ ...S.zone, ...(on ? { background: accent, color: contrastFg(accent), borderColor: accent } : {}) }}
                  >{lbl}</button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {error && <div style={S.err}>{error}</div>}

      <button onClick={submitJoin} disabled={submitting} style={{ ...S.btn, background: accent, color: contrastFg(accent), marginTop: 16, opacity: submitting ? 0.7 : 1 }}>
        {submitting ? 'Adding you…' : 'Join the waitlist'}
      </button>

      <div style={S.legal}>
        We’ll only text you about your table. Standard message rates may apply.
      </div>
    </Card>
  );
}

const S = {
  page: { minHeight: '100vh', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '28px 16px', fontFamily: FONT },
  card: { width: '100%', maxWidth: 440, background: '#fff', borderRadius: 26, overflow: 'hidden', boxShadow: '0 14px 40px rgba(0,0,0,0.28)' },
  hero: { padding: '30px 22px', display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 96 },
  logoBox: { border: '1.5px dashed', borderRadius: 12, padding: '12px 20px', fontSize: 18, fontWeight: 800, letterSpacing: '-0.01em', color: '#1f1f24' },
  h1: { fontSize: 22, fontWeight: 800, color: '#1f1f24', margin: '0 0 8px', letterSpacing: '-0.02em', lineHeight: 1.2 },
  sub: { fontSize: 14, color: '#56565e', margin: '0 0 18px', lineHeight: 1.5 },
  input: { width: '100%', boxSizing: 'border-box', border: '1px solid #ececef', borderRadius: 10, padding: '13px 14px', fontSize: 15, fontFamily: 'inherit', outline: 'none', color: '#1f1f24', background: '#fafafb' },
  fieldLbl: { fontSize: 11.5, fontWeight: 700, color: '#8a8a92', letterSpacing: '0.04em', margin: '4px 0 8px', textTransform: 'uppercase' },
  stepper: { width: 46, height: 46, borderRadius: 12, border: '1px solid #ececef', background: '#fafafb', fontSize: 24, fontWeight: 800, color: '#1f1f24', cursor: 'pointer', lineHeight: 1, display: 'grid', placeItems: 'center', fontFamily: 'inherit' },
  zone: { padding: '9px 14px', borderRadius: 99, border: '1px solid #cbd5e1', background: '#fff', cursor: 'pointer', fontSize: 13.5, fontWeight: 700, fontFamily: 'inherit', color: '#1f1f24' },
  btn: { width: '100%', padding: '15px', borderRadius: 12, border: 'none', fontSize: 16, fontWeight: 800, cursor: 'pointer', fontFamily: 'inherit' },
  btnOutline: { width: '100%', padding: '13px', borderRadius: 12, border: '1.5px solid #ececef', background: 'transparent', fontSize: 15, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', color: '#1f1f24' },
  err: { marginTop: 12, fontSize: 13, color: '#b91c1c', fontWeight: 600 },
  legal: { marginTop: 14, fontSize: 11, color: '#9a9aa2', lineHeight: 1.5, textAlign: 'center' },
  footer: { textAlign: 'center', fontSize: 11, color: '#9a9aa2', padding: '14px', borderTop: '1px solid #f0f0f3', fontFamily: '"Spline Sans Mono", ui-monospace, monospace', letterSpacing: '0.06em' },
  banner: { borderRadius: 16, padding: '20px 18px', marginBottom: 16 },
  metricRow: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 6 },
  metric: { background: '#fafafb', border: '1px solid #ececef', borderRadius: 14, padding: '16px 12px', textAlign: 'center' },
  metricNum: { fontSize: 34, fontWeight: 900, letterSpacing: '-0.02em', lineHeight: 1 },
  metricLbl: { fontSize: 11, color: '#8a8a92', marginTop: 6, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' },
  recap: { marginTop: 12, fontSize: 13, color: '#56565e', textAlign: 'center' },
};
