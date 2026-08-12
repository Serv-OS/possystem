// src/surfaces/online/BookingWidget.jsx
//
// PUBLIC guest booking page (Phase 5 of the bookings handoff, screen 7) —
// served on each venue's subdomain at /book (e.g. location1.dev.serv-os.app/book)
// and embeddable in an iframe on the venue's website. One ~560px centred column,
// NO fixed viewport heights (the page scrolls naturally inside an iframe),
// works from 320px wide.
//
// This page talks ONLY to the deployed `booking-widget` edge function via
// supabase.functions.invoke — never to the booking tables directly. The fn is
// the sole door: it quotes availability with the same optimiser the host stand
// uses and books through the create_booking RPC, so the widget can never
// double-book and THE PACING CAP IS ABSOLUTE here (no manager override online).
//
// `location` is the PLATFORM row CustomerBoot resolved from the subdomain slug;
// the fn keys on the OPS location id (location.ops_location_id) — same idiom as
// WaitlistJoinSurface.
//
// Theming: same MenuTheme engine as the storefront (brand CSS vars via
// deriveVars + MenuHeader) so the venue's Menu-appearance branding applies —
// token-based, neutral, no servos skin.

import { useEffect, useState } from 'react';
import { supabase, ensureAuthToken } from '../../lib/supabase';
import { normalisePhone } from '../../lib/customerLookup';
import { readTheme, deriveVars, readableOn, DISPLAY_FONT, BODY_FONT } from '../menu/menuTheme';
import MenuHeader from '../menu/MenuHeader';

const MONO = 'var(--font-mono, ui-monospace, monospace)';

// ── date helpers (all local-time; the fn validates the range server-side) ─────
function toISO(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
const todayISO = () => toISO(new Date());
function addDaysISO(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return toISO(d);
}
function fmtDateLong(iso) {
  const d = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }).format(d);
}

// Every request goes through the edge fn — one door, one shape. Non-2xx
// responses surface as a FunctionsHttpError with no body, so they collapse to a
// generic { ok:false }; per-case errors we act on (slot_full) come back as 200s.
async function callWidget(body) {
  if (!supabase) return { ok: false, error: 'offline' };
  try {
    const { data, error } = await supabase.functions.invoke('booking-widget', { body });
    if (error) return { ok: false, error: error.message || 'network' };
    return data || { ok: false, error: 'empty' };
  } catch (e) {
    return { ok: false, error: e?.message || 'network' };
  }
}

// Themed page chrome: brand CSS vars on the root, storefront MenuHeader, one
// centred 560px column. Top-level (not created during render) so React keeps
// the subtree mounted across state changes.
// The app shell CSS sets overflow:hidden on html/body/#root, so — exactly like
// OnlineSurface and the ClosedScreen — this surface is its own scroll container
// (fixed inset:0 + overflowY:auto). Inside an iframe that fills the frame and
// scrolls naturally; content height stays fluid (no fixed inner heights).
function Shell({ vars, mt, venueName, children }) {
  return (
    <div style={{
      ...vars, position: 'fixed', inset: 0, overflowY: 'auto', overflowX: 'hidden',
      WebkitOverflowScrolling: 'touch', background: 'var(--bg)', color: 'var(--ink)',
      fontFamily: BODY_FONT, containerType: 'inline-size',
    }}>
      <MenuHeader theme={mt} name={venueName} pills={[{ label: 'Book a table' }]} max={560} />
      <div style={{ maxWidth: 560, margin: '0 auto', padding: '18px 16px 56px' }}>
        {children}
        <div style={{ textAlign: 'center', marginTop: 26, fontSize: 11, color: 'var(--muted)' }}>
          Powered by Serv OS
        </div>
      </div>
    </div>
  );
}

export default function BookingWidget({ location }) {
  // The fn contract keys on the OPS location id — the platform row carries it.
  const opsId = location.ops_location_id || location.id;
  const venueName = location.name || 'the venue';
  const mt = readTheme(location.online_branding);
  const vars = deriveVars(mt.brandColor, mt.bodyBg);
  const brand = vars['--brand'];
  const onBrand = readableOn(brand);

  // boot: 'loading' | 'off' (widget disabled / not configured) | 'error' | 'ready'
  const [boot, setBoot] = useState('loading');
  const [cfg, setCfg] = useState(null);

  // Booking inputs
  const [party, setParty] = useState(2);
  const [date, setDate] = useState(todayISO());
  const [slotsNonce, setSlotsNonce] = useState(0); // bump to force a re-fetch (slot_full)
  // Slots arrive keyed on the request that asked for them — a stale/absent key
  // IS the loading state, so a party/date change flips to "Loading times…"
  // without any synchronous setState inside the fetch effect.
  const slotsKey = `${date}|${party}|${slotsNonce}`;
  const [slotsRes, setSlotsRes] = useState(null); // { key, slots, err }
  const [time, setTime] = useState(null);
  const slotsLoading = boot === 'ready' && (!slotsRes || slotsRes.key !== slotsKey);
  const slots = (!slotsLoading && slotsRes?.slots) || [];
  const slotsErr = !slotsLoading && !!slotsRes?.err;

  // Guest details
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [note, setNote] = useState('');
  const [consent, setConsent] = useState(false);

  // Submit lifecycle
  const [submitting, setSubmitting] = useState(false);
  const [submitErr, setSubmitErr] = useState('');
  const [result, setResult] = useState(null); // { status:'confirmed'|'pending', ... }

  // ── boot: best-effort anon auth, then config ────────────────────────────────
  useEffect(() => {
    let off = false;
    (async () => {
      try { await ensureAuthToken(); } catch { /* anon best-effort — fn is public */ }
      const c = await callWidget({ action: 'config', location_id: opsId });
      if (off) return;
      if (!c?.ok) { setBoot(c?.error === 'offline' ? 'off' : 'error'); return; }
      if (c.widgetEnabled === false) { setBoot('off'); return; }
      setCfg(c);
      setBoot('ready');
    })();
    return () => { off = true; };
  }, [opsId]);

  // ── slots: re-fetch whenever party or date changes (and on slot_full) ───────
  useEffect(() => {
    if (boot !== 'ready') return;
    let off = false;
    const key = `${date}|${party}|${slotsNonce}`;
    (async () => {
      const r = await callWidget({ action: 'slots', location_id: opsId, date, party });
      if (off) return;
      if (!r?.ok) { setSlotsRes({ key, slots: [], err: true }); setTime(null); return; }
      const next = Array.isArray(r.slots) ? r.slots : [];
      setSlotsRes({ key, slots: next, err: false });
      // Keep the selection only if that time is still open.
      setTime((t) => (t && next.some((s) => s.time === t && !s.full)) ? t : null);
    })();
    return () => { off = true; };
  }, [boot, opsId, date, party, slotsNonce]);

  const maxCovers = Math.max(1, cfg?.maxCovers || 12);
  const maxDaysAhead = cfg?.maxDaysAhead ?? 90;
  const phoneOk = (() => { const n = normalisePhone(phone); return !!n && n.length >= 7; })();
  const canSubmit = !!name.trim() && phoneOk && !!time && !submitting;

  // ── book ────────────────────────────────────────────────────────────────────
  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setSubmitErr('');
    const r = await callWidget({
      action: 'book',
      location_id: opsId,
      date,
      time,
      party,
      name: name.trim(),
      phone,
      email: email.trim() || undefined,
      note: note.trim() || undefined,
      consent: consent || undefined,
    });
    setSubmitting(false);
    if (r?.ok && (r.status === 'confirmed' || r.status === 'pending')) { setResult(r); return; }
    if (r?.error === 'slot_full') {
      // Someone took the slot between quote and write — refresh availability.
      setSubmitErr('That time was just booked out — please pick another.');
      setTime(null);
      setSlotsNonce((n) => n + 1);
      return;
    }
    setSubmitErr('Something went wrong — please try again, or call the venue.');
  };

  // Shared chrome props for the top-level Shell.
  const shell = { vars, mt, venueName };

  if (boot === 'loading') {
    return <Shell {...shell}>
      <div style={S.card}>
        <div style={{ textAlign: 'center', padding: '34px 0', color: 'var(--muted)', fontSize: 14 }}>
          <div style={{ fontSize: 30, marginBottom: 10 }}>⏳</div>
          Checking availability…
        </div>
      </div>
    </Shell>;
  }

  if (boot === 'off' || boot === 'error') {
    return <Shell {...shell}>
      <div style={{ ...S.card, textAlign: 'center', padding: '34px 22px' }}>
        <div style={{ fontSize: 38, marginBottom: 10 }}>📞</div>
        <div style={S.h1}>
          {boot === 'off' ? 'Online booking isn’t available' : 'We couldn’t load online booking'}
        </div>
        <div style={S.sub}>
          {boot === 'off'
            ? <>Please call {venueName} to book a table — they’ll be happy to help.</>
            : <>Please try again in a moment, or call {venueName} to book.</>}
        </div>
      </div>
    </Shell>;
  }

  // ── confirmed / pending screens ─────────────────────────────────────────────
  if (result?.status === 'confirmed') {
    return <Shell {...shell}>
      <div style={{ ...S.card, textAlign: 'center', padding: '34px 22px' }}>
        <div aria-hidden style={{
          width: 64, height: 64, borderRadius: '50%', margin: '0 auto 16px',
          background: brand, color: onBrand, display: 'flex', alignItems: 'center',
          justifyContent: 'center', fontSize: 34, fontWeight: 800,
        }}>✓</div>
        <div style={S.h1}>Booked — {cfg?.name || venueName}</div>
        <div style={{
          fontFamily: MONO, fontSize: 15, fontWeight: 700, margin: '12px 0 14px',
          color: 'var(--ink)',
        }}>
          {fmtDateLong(result.date || date)} · {result.time || time} · {result.party || party} {(result.party || party) === 1 ? 'guest' : 'guests'}
        </div>
        <div style={S.sub}>
          We’ve saved your details — just give your name when you arrive.
        </div>
      </div>
    </Shell>;
  }

  if (result?.status === 'pending') {
    return <Shell {...shell}>
      <div style={{ ...S.card, textAlign: 'center', padding: '34px 22px' }}>
        <div style={{ fontSize: 38, marginBottom: 10 }}>🕐</div>
        <div style={S.h1}>Almost there</div>
        <div style={S.sub}>
          {result.message || 'The venue will confirm your booking shortly.'}
        </div>
      </div>
    </Shell>;
  }

  // ── main booking form ───────────────────────────────────────────────────────
  const partyOptions = Array.from({ length: maxCovers }, (_, i) => i + 1);

  return <Shell {...shell}>
    <div style={S.card}>
      <h1 style={{ ...S.h1, marginBottom: 4 }}>Book a table</h1>
      <div style={{ ...S.sub, marginBottom: 20 }}>Pick a time at {venueName} — it takes under a minute.</div>

      {/* Party size */}
      <div style={S.fieldLbl}>Guests</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 18 }}>
        {partyOptions.map((n) => {
          const on = party === n;
          return (
            <button key={n} type="button" aria-pressed={on}
              onClick={() => setParty(n)}
              style={{
                minWidth: 44, height: 44, padding: '0 8px', borderRadius: 11,
                fontSize: 15, fontWeight: 800, cursor: 'pointer', fontFamily: 'inherit',
                border: on ? `1.5px solid ${brand}` : '1px solid var(--line)',
                background: on ? brand : 'var(--card)',
                color: on ? onBrand : 'var(--ink)',
              }}>{n}</button>
          );
        })}
      </div>

      {/* Date */}
      <div style={S.fieldLbl}>Date</div>
      <input
        type="date" aria-label="Booking date"
        value={date} min={todayISO()} max={addDaysISO(maxDaysAhead)}
        onChange={(e) => { if (e.target.value) setDate(e.target.value); }}
        style={{ ...S.input, marginBottom: 18 }}
      />

      {/* Times */}
      <div style={S.fieldLbl}>Available times</div>
      {slotsLoading ? (
        <div style={{ padding: '18px 0', fontSize: 13, color: 'var(--muted)' }}>Loading times…</div>
      ) : slotsErr ? (
        <div style={{ padding: '14px 0', fontSize: 13, color: 'var(--muted)' }}>
          We couldn’t load times for that date.{' '}
          <button type="button" onClick={() => setSlotsNonce((n) => n + 1)} style={S.linkBtn}>Try again</button>
        </div>
      ) : slots.length === 0 ? (
        <div style={{ padding: '14px 0', fontSize: 13, color: 'var(--muted)' }}>
          No online times for this date — try another day, or call {venueName}.
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
          {slots.map((s) => {
            const on = time === s.time;
            return (
              <button key={s.time} type="button" disabled={s.full} aria-pressed={on}
                onClick={() => { setTime(s.time); setSubmitErr(''); }}
                style={{
                  padding: '12px 2px', borderRadius: 10, textAlign: 'center',
                  fontSize: 13, fontWeight: 700, fontFamily: MONO,
                  cursor: s.full ? 'default' : 'pointer',
                  border: on ? `1.5px solid ${brand}` : '1px solid var(--line)',
                  background: on ? `${brand}1f` : (s.full ? 'transparent' : 'var(--card)'),
                  color: on ? brand : (s.full ? 'var(--muted)' : 'var(--ink)'),
                  opacity: s.full ? 0.55 : 1,
                }}>{s.time}</button>
            );
          })}
        </div>
      )}
      <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 8, marginBottom: 20 }}>
        Greyed times are at the kitchen’s capacity, not closed.
      </div>

      {/* Guest details */}
      <div style={{ display: 'grid', gap: 9 }}>
        <input style={S.input} placeholder="Full name" autoComplete="name"
          value={name} onChange={(e) => setName(e.target.value)} />
        <input style={S.input} placeholder="Mobile number" type="tel" inputMode="tel" autoComplete="tel"
          value={phone} onChange={(e) => setPhone(e.target.value)} />
        <input style={S.input} placeholder="Email (optional)" type="email" inputMode="email" autoComplete="email"
          value={email} onChange={(e) => setEmail(e.target.value)} />
        <input style={S.input} placeholder="Allergies or occasion (optional)"
          value={note} onChange={(e) => setNote(e.target.value)} />
      </div>

      {/* Marketing consent — unticked by default, plain wording */}
      <label style={{
        display: 'flex', alignItems: 'center', gap: 10, marginTop: 14,
        fontSize: 13, color: 'var(--ink)', cursor: 'pointer',
      }}>
        <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)}
          style={{ width: 18, height: 18, accentColor: brand, flex: 'none' }} />
        Keep me posted on news and offers
      </label>

      {submitErr && (
        <div style={{ marginTop: 14, fontSize: 13, fontWeight: 600, color: '#b91c1c' }}>{submitErr}</div>
      )}

      {/* Confirm */}
      <button type="button" onClick={submit} disabled={!canSubmit}
        style={{
          width: '100%', height: 48, borderRadius: 12, border: 'none', marginTop: 16,
          background: brand, color: onBrand, fontSize: 15, fontWeight: 800,
          fontFamily: 'inherit', cursor: canSubmit ? 'pointer' : 'default',
          opacity: canSubmit ? 1 : 0.5,
        }}>
        {submitting ? 'Booking…' : 'Book table'}
      </button>
    </div>
  </Shell>;
}

// ── styles ────────────────────────────────────────────────────────────────────
const S = {
  card: {
    background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 16,
    padding: '22px 18px', boxShadow: '0 1px 2px rgba(36,31,28,.04)',
  },
  h1: {
    fontFamily: DISPLAY_FONT, fontSize: 22, fontWeight: 700, letterSpacing: '-.01em',
    margin: 0, lineHeight: 1.25, color: 'var(--ink)',
  },
  sub: { fontSize: 14, color: 'var(--muted)', lineHeight: 1.6, marginTop: 6 },
  fieldLbl: {
    fontSize: 11, fontWeight: 700, color: 'var(--muted)', letterSpacing: '.06em',
    textTransform: 'uppercase', marginBottom: 8,
  },
  input: {
    width: '100%', boxSizing: 'border-box', height: 44, borderRadius: 11,
    border: '1px solid var(--line)', background: 'var(--card)', color: 'var(--ink)',
    padding: '0 14px', fontSize: 15, fontFamily: 'inherit', outline: 'none',
  },
  linkBtn: {
    background: 'none', border: 'none', padding: 0, cursor: 'pointer',
    color: 'var(--brand)', fontSize: 13, fontWeight: 700, fontFamily: 'inherit',
    textDecoration: 'underline',
  },
};
