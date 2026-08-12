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

import { useEffect, useRef, useState } from 'react';
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
function addDaysISO(days, fromISO = null) {
  const d = fromISO ? new Date(`${fromISO}T12:00:00`) : new Date();
  d.setDate(d.getDate() + days);
  return toISO(d);
}
function fmtDateLong(iso) {
  const d = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }).format(d);
}

// ── package money (POUNDS — the fn pre-computes `total`; per_cover = price × party)
function fmtGBP(n) {
  const v = Math.round((Number(n) || 0) * 100) / 100;
  return Number.isInteger(v) ? `£${v}` : `£${v.toFixed(2)}`;
}
// "£240 · £60 per person" for per-cover offers; plain total otherwise.
function pkgTotalLabel(p) {
  return p.priceUnit === 'per_cover' ? `${fmtGBP(p.total)} · ${fmtGBP(p.price)} per person` : fmtGBP(p.total);
}
// One-line payment rule in guest words. Online card capture is NOT live, so
// never promise an online charge here — every model settles at the venue for
// now. Unknown/missing models render nothing rather than a wrong promise.
const PKG_RULE = {
  prepay: 'Paid on the night for now — pre-orders reach the kitchen',
  deposit: 'Deposit taken at the venue',
  hold: 'No charge today',
};

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

  // ── package upsell ──────────────────────────────────────────────────────────
  // ?package=<id> deep link, read once at mount (absent = normal flow).
  const [linkPkgId] = useState(() => {
    try { return new URLSearchParams(window.location.search).get('package') || null; } catch { return null; }
  });
  // The guest's explicit choice: null = untouched (the deep link may pre-select),
  // { id: null } = "No thanks", { id } = tapped a card. The EFFECTIVE selection is
  // DERIVED against the offers in the CURRENT slots response, so a party/date
  // change that drops the offer clears it with no effect-time setState — same
  // request-keyed idiom as slotsRes above.
  const [pkgPick, setPkgPick] = useState(null);
  const packages = (!slotsLoading && slotsRes?.packages) || [];
  const wantedPkgId = pkgPick ? pkgPick.id : linkPkgId;
  const selectedPkg = wantedPkgId
    ? packages.find((p) => String(p.id) === String(wantedPkgId)) || null
    : null;
  // Deep-link miss → the small amber note (only until the guest interacts).
  const linkPkgMissing = !pkgPick && !!linkPkgId && !slotsLoading && !slotsErr
    && !packages.some((p) => String(p.id) === String(linkPkgId));

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
      // Anchor the calendar on the VENUE's today (config.today), never the
      // browser's — a guest in another timezone would otherwise default to a
      // date the venue has already finished (caught live, 11 Aug: a Pacific
      // browser offered "today" to a London venue at 7am the next morning).
      if (c.today) setDate((d) => (d < c.today ? c.today : d));
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
      if (!r?.ok) { setSlotsRes({ key, slots: [], packages: [], err: true }); setTime(null); return; }
      const next = Array.isArray(r.slots) ? r.slots : [];
      // Offers ride the same response — valid for exactly this date+party.
      setSlotsRes({ key, slots: next, packages: Array.isArray(r.packages) ? r.packages : [], err: false });
      // Keep the selection only if that time is still open.
      setTime((t) => (t && next.some((s) => s.time === t && !s.full)) ? t : null);
    })();
    return () => { off = true; };
  }, [boot, opsId, date, party, slotsNonce]);

  // Deep link: the first time the ?package offer renders selected, bring the
  // section into view. DOM-only side effect (no setState), ref-guarded so it
  // fires once; no dep array because it watches derived render output.
  const pkgSectionRef = useRef(null);
  const linkScrolledRef = useRef(false);
  useEffect(() => {
    if (linkScrolledRef.current || !linkPkgId || pkgPick) return;
    if (String(selectedPkg?.id) !== String(linkPkgId)) return;
    if (pkgSectionRef.current) {
      linkScrolledRef.current = true;
      // Instant (not smooth) and deferred one frame: the slots response lands
      // as two setStates, and the re-render cancels an in-flight smooth scroll
      // (observed in the rig — it died 1px in).
      const el = pkgSectionRef.current;
      requestAnimationFrame(() => el.scrollIntoView({ block: 'center' }));
    }
  });

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
      package_id: selectedPkg ? selectedPkg.id : undefined,
    });
    setSubmitting(false);
    if (r?.ok && (r.status === 'confirmed' || r.status === 'pending')) { setResult(r); return; }
    if (r?.error === 'package_unavailable') {
      // The offer vanished between render and book (cap filled / window moved) —
      // drop it, re-quote the day, keep the table flow alive.
      setSubmitErr('That menu just sold out for this date — you can still book the table.');
      setPkgPick({ id: null });
      setSlotsNonce((n) => n + 1);
      return;
    }
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
    // The fn's confirm carries { id, name, paymentModel } only — the money
    // figures come from the offer card in the last slots response (still keyed
    // to the date+party that was booked; nothing re-fetched since).
    const confPkg = result.package
      ? (slotsRes?.packages || []).find((p) => String(p.id) === String(result.package.id)) || null
      : null;
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
        {result.package && (
          <div style={{
            margin: '0 auto 14px', maxWidth: 340, padding: '10px 14px', borderRadius: 12,
            border: '1px solid rgba(22,163,74,.4)', background: 'rgba(22,163,74,.08)',
          }}>
            <div style={{ fontSize: 14, fontWeight: 800, color: 'var(--ink)' }}>{result.package.name}</div>
            {confPkg && (
              <div style={{ fontFamily: MONO, fontSize: 13, fontWeight: 700, color: 'var(--ink)', marginTop: 2 }}>
                {pkgTotalLabel(confPkg)}
              </div>
            )}
          </div>
        )}
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
        value={date} min={cfg?.today || todayISO()} max={addDaysISO(maxDaysAhead, cfg?.today)}
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

      {/* Package upsell — the offers the fn returned for THIS date+party.
          Selection is derived (pkgPick vs current offers) so a stale card can
          never be booked from here; the fn re-validates server-side anyway. */}
      {(packages.length > 0 || linkPkgMissing) && (
        <div ref={pkgSectionRef} style={{ marginBottom: 20 }}>
          {packages.length > 0 && <div style={S.fieldLbl}>Add an experience</div>}
          {linkPkgMissing && (
            <div style={{
              padding: '8px 12px', borderRadius: 10, marginBottom: 8,
              background: 'rgba(217,119,6,.09)', border: '1px solid rgba(217,119,6,.35)',
              color: '#b45309', fontSize: 12.5, fontWeight: 600,
            }}>
              That menu isn’t available for this date or party size
            </div>
          )}
          {packages.length > 0 && (
            <div style={{ display: 'grid', gap: 8 }}>
              {packages.map((p) => {
                const on = selectedPkg && String(selectedPkg.id) === String(p.id);
                return (
                  <button key={p.id} type="button" aria-pressed={!!on}
                    onClick={() => { setPkgPick({ id: on ? null : p.id }); setSubmitErr(''); }}
                    style={{
                      display: 'block', width: '100%', textAlign: 'left',
                      padding: '12px 14px', borderRadius: 12,
                      cursor: 'pointer', fontFamily: 'inherit', color: 'var(--ink)',
                      border: on ? '1.5px solid #16a34a' : '1px solid rgba(22,163,74,.35)',
                      background: on ? 'rgba(22,163,74,.14)' : 'rgba(22,163,74,.06)',
                    }}>
                    {/* Name + right-aligned mono total share the top row; the
                        total's two halves wrap only at the gap so 320px never
                        splits "per person" mid-phrase. */}
                    <div style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
                      <div style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: 800 }}>
                        {on ? '✓ ' : ''}{p.name}
                      </div>
                      <div style={{
                        fontFamily: MONO, fontSize: 13, fontWeight: 800, textAlign: 'right',
                        flex: 'none', maxWidth: '55%',
                      }}>
                        <span style={{ whiteSpace: 'nowrap' }}>{fmtGBP(p.total)}</span>
                        {p.priceUnit === 'per_cover' && <>
                          {' '}
                          <span style={{ whiteSpace: 'nowrap' }}>· {fmtGBP(p.price)} per person</span>
                        </>}
                      </div>
                    </div>
                    {p.description && (
                      <div style={{
                        fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.45, marginTop: 3,
                        display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                        overflow: 'hidden',
                      }}>{p.description}</div>
                    )}
                    {PKG_RULE[p.paymentModel] && (
                      <div style={{ fontSize: 11.5, fontWeight: 600, color: '#15803d', marginTop: 5 }}>
                        {PKG_RULE[p.paymentModel]}
                      </div>
                    )}
                  </button>
                );
              })}
              <button type="button" aria-pressed={!selectedPkg}
                onClick={() => { setPkgPick({ id: null }); setSubmitErr(''); }}
                style={{
                  width: '100%', padding: '10px 14px', borderRadius: 12, textAlign: 'left',
                  border: '1px dashed var(--line)', background: 'transparent',
                  cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, fontWeight: 700,
                  color: selectedPkg ? 'var(--muted)' : 'var(--ink)',
                }}>
                No thanks, just the table
              </button>
            </div>
          )}
        </div>
      )}

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
