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
//
// Card capture (paymentDue on the book response): the confirmation screen
// mounts an Adyen Card (advanced flow, see BookingPaymentCard) that pays via
// the same fn (booking_pay). Only the card ENCRYPTION talks to Adyen directly.

import { useEffect, useRef, useState } from 'react';
import { AdyenCheckout, Dropin, Card } from '@adyen/adyen-web';
import '@adyen/adyen-web/styles/adyen.css';
import { supabase, ensureAuthToken, isMock } from '../../lib/supabase';
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

// "starter, main and dessert" — the under-button nudge builds from the REAL
// course-group labels, so a package with an On-arrival course still reads true.
function joinAnd(list) {
  const a = list.filter(Boolean);
  if (a.length <= 1) return a[0] || 'choice';
  return `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`;
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
// One-line payment rule in guest words — HONEST about when money moves
// (owner, 13 Aug: "you are pre paying the entire amount upfront but it doesn't
// say the right thing"). Keys on the venue's card-capture config: with capture
// ON the confirmation screen really does take the card, so prepay/deposit are
// paid at booking time; with capture OFF nothing is ever collected online, so
// the copy must hand the money to the venue. Hold language additionally
// respects the venue's covers threshold — below cardCaptureMinCovers no card
// is ever asked for, so no hold line may render. Unknown/missing models render
// nothing rather than a wrong promise.
function pkgRuleLine(model, cfg, party) {
  const captureOn = !!cfg?.cardCaptureEnabled;
  if (model === 'prepay') {
    return captureOn
      ? 'Paid in full when you book — comes off the bill on the night'
      : 'Payment taken at the venue';
  }
  if (model === 'deposit') {
    return captureOn
      ? 'Deposit paid when you book — the rest on the night'
      : 'Deposit arranged with the venue';
  }
  if (model === 'hold') {
    if (!captureOn) return null;
    const min = Number(cfg?.cardCaptureMinCovers) || 0;
    if (min > 0 && party < min) return null;
    return 'Card held to secure the table — nothing charged today';
  }
  return null;
}

// "What's included" lines from an offer's full line list (`includes` on the
// slots offer): fixed lines read as their name; choice lines collapse to one
// line per course group ("Starter — your choice of 2"). Labels mirror the fn's
// COURSE_LABEL — the course ints are the same ones the KDS fires by. A course
// with a single "choice" option is effectively fixed, so it reads as the name.
const COURSE_LABEL = { 0: 'On arrival', 1: 'Starter', 2: 'Main', 3: 'Dessert' };
// The owner's spec (13 Aug): the details must SAY the structure — "each guest
// picks one" per choice course, with the actual options named, and preset
// lines listed plainly as included for everyone.
function includesLines(includes) {
  const list = Array.isArray(includes) ? includes : [];
  const byCourse = new Map(); // course → choice option names
  for (const l of list) if (l.choice) byCourse.set(l.course, [...(byCourse.get(l.course) || []), l.name]);
  const fixed = list.filter((l) => !l.choice).map((l) => l.name);
  const out = [];
  // Choice courses first, in course order — the structure IS the story.
  for (const [course, names] of [...byCourse.entries()].sort((a, b) => a[0] - b[0])) {
    const label = COURSE_LABEL[course] || `Course ${course}`;
    if (names.length <= 1) { fixed.push(names[0]); continue; }   // one option = effectively preset
    out.push({ head: `${label} — each guest picks one`, body: joinAnd(names.map((n) => n)) });
  }
  if (fixed.length) {
    out.push({ head: out.length ? 'Included for everyone' : null, body: null, items: fixed });
  }
  return out;
}

// Shared by the package hero (landing) and the confirmation summary (compact).
// Pure render of includesLines() — no state.
function IncludesList({ includes, compact = false }) {
  const groups = includesLines(includes);
  if (!groups.length) return null;
  const fz = compact ? 12.5 : 13.5;
  return (
    <div style={{ marginTop: compact ? 8 : 12, textAlign: 'left' }}>
      <div style={{ ...S.fieldLbl, marginBottom: compact ? 4 : 6 }}>What’s included</div>
      <div style={{ display: 'grid', gap: compact ? 6 : 9 }}>
        {groups.map((g, i) => (
          <div key={i}>
            {g.head && (
              <div style={{ fontSize: compact ? 11 : 11.5, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 2 }}>
                {g.head}
              </div>
            )}
            {g.body && <div style={{ fontSize: fz, lineHeight: 1.5, color: 'var(--ink)' }}>{g.body}</div>}
            {g.items && (
              <div style={{ display: 'grid', gap: 2 }}>
                {g.items.map((it, j) => (
                  <div key={j} style={{ display: 'flex', gap: 8, fontSize: fz, lineHeight: 1.5, color: 'var(--ink)' }}>
                    <span aria-hidden style={{ color: 'var(--muted)', flex: 'none' }}>•</span>
                    <span>{it}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── confirmation-screen card capture ("Secure your booking") ──────────────────
// Copy per paymentDue.kind. The booking is ALREADY CONFIRMED when this card
// renders — no line here may ever imply the table is at risk.
const CARD_ONLY = { paymentMethods: [{ type: 'scheme', name: 'Credit or debit card', brands: ['visa', 'mc', 'amex'] }] };
const PAY_TITLE = {
  prepay: (amt) => `Pay ${amt} now — it comes off your bill`,
  deposit: (amt) => `Pay your ${amt} deposit`,
  hold: (amt) => `Hold your table with a card — ${amt} held, nothing charged today`,
};
const PAID_LINE = {
  prepay: (amt) => `Paid ${amt}`,
  deposit: (amt) => `Deposit paid ${amt}`,
  hold: () => 'Card held',
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

// One bordered sub-card per guest: an optional name plus ONE chip-row per
// course group (radio semantics — tapping another chip moves the pick, exactly
// one selectable per group per guest). Shared verbatim by the in-flow booking
// form and the tokened completion page; the STATE stays with the callers (they
// key it differently), so this stays a pure render of getSel/getName.
function GuestChoiceCards({ party, groups, getSel, onPick, getName, onName, brand, onBrand }) {
  const seats = Array.from({ length: Math.max(1, party) }, (_, i) => i + 1);
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {seats.map((seat) => (
        <div key={seat} style={{
          border: '1px solid var(--line)', borderRadius: 12, padding: '11px 12px 12px',
          background: 'var(--card)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ fontSize: 12.5, fontWeight: 800, color: 'var(--ink)', flex: 'none' }}>
              Guest {seat}
            </div>
            <input
              value={getName(seat)} onChange={(e) => onName(seat, e.target.value)}
              placeholder="Name (optional)" autoComplete="off" aria-label={`Guest ${seat} name`}
              style={{ ...S.input, height: 34, fontSize: 13, padding: '0 10px', flex: 1, minWidth: 0 }}
            />
          </div>
          {groups.map((g) => {
            const cur = getSel(seat, g.course);
            return (
              <div key={g.course} style={{ marginTop: 9 }}>
                <div style={{
                  fontSize: 10.5, fontWeight: 700, color: 'var(--muted)',
                  letterSpacing: '.06em', textTransform: 'uppercase', marginBottom: 5,
                }}>{g.label}</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {g.options.map((o) => {
                    const on = cur === o.name;
                    return (
                      <button key={o.lineId || o.name} type="button" aria-pressed={on}
                        onClick={() => onPick(seat, g.course, o.name)}
                        style={{
                          padding: '8px 12px', borderRadius: 999, fontSize: 12.5, fontWeight: 700,
                          fontFamily: 'inherit', cursor: 'pointer',
                          border: on ? `1.5px solid ${brand}` : '1px solid var(--line)',
                          background: on ? brand : 'var(--card)',
                          color: on ? onBrand : 'var(--ink)',
                        }}>{on ? '✓ ' : ''}{o.name}</button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

// The confirmation screen's payment box — renders ONLY when the book response
// carried paymentDue (venue has card capture on; null = nothing to collect).
// ADVANCED-flow Adyen Card, same pattern as components/AdyenPaymentForm.jsx:
// the card encrypts in the browser, the money request runs through the
// booking-widget fn (booking_pay), which knows the amount server-side. The
// booking is already confirmed before this mounts, so every failure path here
// stays soft — the guest can always sort payment with the venue instead.
function BookingPaymentCard({ paymentDue, adyen, bookingId, opsId }) {
  const holder = useRef(null);
  const dropinRef = useRef(null);
  const submittedRef = useRef(false); // pre-submit onError = setup failure → fallback copy
  const [attempt, setAttempt] = useState(0); // bump to remount the form after a refusal
  // phase: init | ready | failed | refused | paid
  const [phase, setPhase] = useState('init');
  const [refusal, setRefusal] = useState('');
  const [payErr, setPayErr] = useState('');
  const [paidInfo, setPaidInfo] = useState(null); // { pspReference }

  const kind = paymentDue?.kind;
  const amt = fmtGBP((Number(paymentDue?.amountMinor) || 0) / 100);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const checkout = await AdyenCheckout({
          clientKey: adyen?.clientKey || undefined,
          environment: adyen?.environment === 'live' ? 'live' : 'test',
          countryCode: 'GB',
          amount: { value: Number(paymentDue?.amountMinor) || 0, currency: 'GBP' },
          paymentMethodsResponse: CARD_ONLY,
          onSubmit: async (state, _component, actions) => {
            submittedRef.current = true;
            setPayErr('');
            const r = await callWidget({
              action: 'booking_pay',
              location_id: opsId,
              booking_id: bookingId,
              payment_method: state.data.paymentMethod,
              browser_info: state.data.browserInfo,
              origin: window.location.origin,
              return_url: window.location.href,
            });
            if (r?.ok && (r.already || r.resultCode === 'Authorised')) {
              // `already` = a previous attempt landed server-side — same success.
              setPaidInfo({ pspReference: r.pspReference || null });
              setPhase('paid');
              actions.resolve({ resultCode: r.resultCode || 'Authorised' });
              return;
            }
            if (r?.error === 'card_refused') {
              setRefusal(r.refusalReason || '');
              setPhase('refused');
              actions.reject();
              return;
            }
            setPayErr('We couldn’t take the payment — please try again.');
            actions.reject();
          },
          onPaymentCompleted: () => {}, // success already handled on the server reply
          onPaymentFailed: () => {},    // refusal already handled on the server reply
          onError: () => {
            if (!live) return;
            // Before any submit this is a setup failure (bad origin, network) —
            // swap the form for the soft fallback. After a submit the server
            // reply has already driven the state; keep the form usable.
            if (!submittedRef.current) setPhase('failed');
            else setPayErr('Something went wrong — please try again.');
          },
        });
        if (!live) return;
        dropinRef.current = new Dropin(checkout, { paymentMethodComponents: [Card] }).mount(holder.current);
        setPhase('ready');
      } catch {
        if (!live) return;
        setPhase('failed');
      }
    })();
    return () => {
      live = false;
      try { dropinRef.current?.unmount(); } catch { /* already gone */ }
    };
    // A retry (attempt bump) or another booking is a NEW payment — remount cleanly.
  }, [bookingId, attempt]); // eslint-disable-line react-hooks/exhaustive-deps

  const retry = () => {
    submittedRef.current = false;
    setRefusal('');
    setPayErr('');
    setPhase('init');
    setAttempt((n) => n + 1);
  };

  const showForm = phase === 'init' || phase === 'ready';
  return (
    <div style={{
      margin: '0 auto 14px', maxWidth: 380, padding: '14px 16px', borderRadius: 12,
      border: '1px solid var(--line)', background: 'var(--bg)', textAlign: 'left',
    }}>
      <div style={S.fieldLbl}>Secure your booking</div>
      <div style={{ fontFamily: DISPLAY_FONT, fontSize: 16, fontWeight: 800, color: 'var(--ink)', lineHeight: 1.35 }}>
        {PAY_TITLE[kind] ? PAY_TITLE[kind](amt) : `Pay ${amt}`}
      </div>

      {phase === 'paid' ? (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 14.5, fontWeight: 800, color: '#15803d' }}>
            ✓ {PAID_LINE[kind] ? PAID_LINE[kind](amt) : `Paid ${amt}`}
          </div>
          {paidInfo?.pspReference && (
            <div style={{ fontFamily: MONO, fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
              {paidInfo.pspReference}
            </div>
          )}
        </div>
      ) : (
        <div style={{ marginTop: 10 }}>
          {phase === 'init' && (
            <div style={{ padding: '12px 0', fontSize: 13, color: 'var(--muted)' }}>Loading secure payment…</div>
          )}
          {phase === 'failed' && (
            <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.5 }}>
              The card form couldn’t load here.
            </div>
          )}
          {phase === 'refused' && (
            <>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#b91c1c', lineHeight: 1.5 }}>
                Card refused{refusal ? ` — ${refusal}` : ''}. No charge was made.
              </div>
              <button type="button" onClick={retry} style={{
                marginTop: 8, width: '100%', height: 40, borderRadius: 10,
                border: '1px solid var(--line)', background: 'var(--card)', color: 'var(--ink)',
                fontSize: 13.5, fontWeight: 800, fontFamily: 'inherit', cursor: 'pointer',
              }}>
                Try another card
              </button>
            </>
          )}
          <div ref={holder} style={{ display: showForm ? 'block' : 'none' }} />
          {payErr && showForm && (
            <div style={{ marginTop: 8, fontSize: 12.5, fontWeight: 600, color: '#b91c1c' }}>{payErr}</div>
          )}
          <div style={{ marginTop: 10, fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>
            Your table is booked either way — you can also sort payment with the venue.
          </div>
        </div>
      )}
    </div>
  );
}

// ── guest pre-order completion page (?preorder=<token>) ──────────────────────
// The token IS the credential — no config/slots boot, no location resolution
// beyond what CustomerBoot already did (the `location` prop only themes the
// page). Everything renders from preorder_info; submit replaces wholesale via
// preorder_submit. Request-keyed like slotsRes in the main flow: a stale or
// absent key IS the loading state, so no synchronous setState in the effect.
function PreorderPage({ token, shell, brand, onBrand, venueName }) {
  const [nonce, setNonce] = useState(0); // bump to retry a failed info load
  const infoKey = `${token}|${nonce}`;
  const [infoRes, setInfoRes] = useState(null); // { key, info, err }
  const loading = !infoRes || infoRes.key !== infoKey;
  const info = (!loading && !infoRes.err && infoRes.info) || null;

  // The guest's EDITS only — an untouched seat/course falls back to the saved
  // row at render time (prefill by render fallback, never effect-time setState).
  const [sel, setSel] = useState({});     // `${seat}|${course}` → option name
  const [names, setNames] = useState({}); // seat → guest name
  const [sending, setSending] = useState(false);
  const [sendErr, setSendErr] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let off = false;
    const key = `${token}|${nonce}`;
    (async () => {
      try { await ensureAuthToken(); } catch { /* anon best-effort — fn is public */ }
      const r = await callWidget({ action: 'preorder_info', token });
      if (off) return;
      // Unknown/closed tokens come back non-2xx, which invoke collapses to a
      // bodyless error — every failure lands on the same polite screen.
      setInfoRes(r?.ok ? { key, info: r, err: null } : { key, info: null, err: r?.error || 'failed' });
    })();
    return () => { off = true; };
  }, [token, nonce]);

  const existingSel = {};
  const existingName = {};
  for (const r of info?.preorders || []) {
    const k = `${r.seat}|${r.course}`;
    if (existingSel[k] === undefined && r.name) existingSel[k] = r.name;
    if (existingName[r.seat] === undefined && r.guestName) existingName[r.seat] = r.guestName;
  }
  const effSel = (seat, course) => {
    const k = `${seat}|${course}`;
    return sel[k] !== undefined ? sel[k] : (existingSel[k] || '');
  };
  const effName = (seat) => (names[seat] !== undefined ? names[seat] : (existingName[seat] || ''));

  const party = info?.party || 0;
  const groups = Array.isArray(info?.choiceGroups) ? info.choiceGroups : [];
  const seats = Array.from({ length: party }, (_, i) => i + 1);
  // Complete = every guest holds a CURRENT option per group (a saved choice the
  // venue has since removed from the package no longer counts).
  const complete = party > 0 && groups.length > 0 && groups.every((g) =>
    seats.every((s) => g.options.some((o) => o.name === effSel(s, g.course))));

  const summaryLine = info
    ? `${info.venue} · ${fmtDateLong(info.date)} · ${info.time} · ${info.party} ${info.party === 1 ? 'guest' : 'guests'}`
    : '';

  const submit = async () => {
    if (!complete || sending) return;
    setSending(true);
    setSendErr('');
    const preorders = [];
    for (const s of seats) {
      for (const g of groups) {
        preorders.push({ seat: s, guestName: effName(s).trim() || undefined, name: effSel(s, g.course) });
      }
    }
    const r = await callWidget({ action: 'preorder_submit', token, preorders });
    setSending(false);
    if (r?.ok) { setSaved(true); return; }
    setSendErr('Something went wrong — please try again, or call the venue.');
  };

  if (loading) {
    return <Shell {...shell}>
      <div style={S.card}>
        <div style={{ textAlign: 'center', padding: '34px 0', color: 'var(--muted)', fontSize: 14 }}>
          <div style={{ fontSize: 30, marginBottom: 10 }}>⏳</div>
          Loading your booking…
        </div>
      </div>
    </Shell>;
  }

  if (!info) {
    return <Shell {...shell}>
      <div style={{ ...S.card, textAlign: 'center', padding: '34px 22px' }}>
        <div style={{ fontSize: 38, marginBottom: 10 }}>📞</div>
        <div style={S.h1}>We couldn’t find that booking</div>
        <div style={S.sub}>
          This menu link may have expired, or the booking has changed. Please call {venueName} to
          give your menu choices — they’ll be happy to help.
        </div>
        <div style={{ marginTop: 12 }}>
          <button type="button" onClick={() => setNonce((n) => n + 1)} style={S.linkBtn}>Try again</button>
        </div>
      </div>
    </Shell>;
  }

  if (saved) {
    return <Shell {...shell}>
      <div style={{ ...S.card, textAlign: 'center', padding: '34px 22px' }}>
        <div aria-hidden style={{
          width: 64, height: 64, borderRadius: '50%', margin: '0 auto 16px',
          background: brand, color: onBrand, display: 'flex', alignItems: 'center',
          justifyContent: 'center', fontSize: 34, fontWeight: 800,
        }}>✓</div>
        <div style={S.h1}>Choices sent to the kitchen ✓</div>
        <div style={{ fontFamily: MONO, fontSize: 15, fontWeight: 700, margin: '12px 0 14px', color: 'var(--ink)' }}>
          {summaryLine}
        </div>
        <div style={S.sub}>See you then — just give your name when you arrive.</div>
      </div>
    </Shell>;
  }

  return <Shell {...shell}>
    <div style={S.card}>
      <h1 style={{ ...S.h1, marginBottom: 4 }}>Your menu — {info.packageName}</h1>
      <div style={{ fontFamily: MONO, fontSize: 13.5, fontWeight: 700, color: 'var(--ink)', margin: '10px 0 2px' }}>
        {summaryLine}
      </div>
      <div style={{ ...S.sub, marginBottom: 16 }}>
        Choose one of each for every guest — choices due by {fmtDateLong(info.deadline)}.
      </div>

      {groups.length === 0 ? (
        <div style={S.sub}>No menu choices are needed for this booking.</div>
      ) : <>
        <GuestChoiceCards
          party={party} groups={groups} brand={brand} onBrand={onBrand}
          getSel={effSel}
          onPick={(seat, course, nm) => { setSel((m) => ({ ...m, [`${seat}|${course}`]: nm })); setSendErr(''); }}
          getName={effName}
          onName={(seat, v) => setNames((m) => ({ ...m, [seat]: v }))}
        />

        {sendErr && (
          <div style={{ marginTop: 14, fontSize: 13, fontWeight: 600, color: '#b91c1c' }}>{sendErr}</div>
        )}

        <button type="button" onClick={submit} disabled={!complete || sending}
          style={{
            width: '100%', height: 48, borderRadius: 12, border: 'none', marginTop: 16,
            background: brand, color: onBrand, fontSize: 15, fontWeight: 800,
            fontFamily: 'inherit', cursor: (complete && !sending) ? 'pointer' : 'default',
            opacity: (complete && !sending) ? 1 : 0.5,
          }}>
          {sending ? 'Sending…' : 'Send menu choices'}
        </button>
        {!complete && (
          <div style={{ marginTop: 8, fontSize: 12, color: 'var(--muted)', textAlign: 'center' }}>
            Choose a {joinAnd(groups.map((g) => String(g.label || '').toLowerCase()))} for each guest
          </div>
        )}
      </>}
    </div>
  </Shell>;
}

export default function BookingWidget({ location }) {
  // The fn contract keys on the OPS location id — the platform row carries it.
  const opsId = location.ops_location_id || location.id;
  const venueName = location.name || 'the venue';
  const mt = readTheme(location.online_branding);
  const vars = deriveVars(mt.brandColor, mt.bodyBg);
  const brand = vars['--brand'];
  const onBrand = readableOn(brand);

  // ?preorder=<token> → the page IS the guest completion flow, checked BEFORE
  // any booking boot (the token is the credential; config/slots never load).
  // Read once at mount, same idiom as the ?package deep link below.
  const [urlPreorderToken] = useState(() => {
    try { return new URLSearchParams(window.location.search).get('preorder') || null; } catch { return null; }
  });

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
  // /book?package=<id> is a MARKETING LANDING PAGE (owner, 13 Aug: "a link
  // direct to the packages so we can market that direct"): the linked offer
  // renders as a hero above the party/date flow. Keyed on linkPkgId (not the
  // guest's pkgPick) so the hero survives selection changes — it's the landing
  // content, not the selection. Derived from the CURRENT slots response, so
  // price/total always match the chosen date+party.
  const heroPkg = linkPkgId
    ? packages.find((p) => String(p.id) === String(linkPkgId)) || null
    : null;

  // ── menu choices (per-guest pre-orders) ─────────────────────────────────────
  // Selections key on `${pkgId}|${seat}|${course}`, guest names on seat alone
  // (names are facts about the party, not the package) — so a package switch or
  // a party change never needs an effect to reset anything: stale keys are
  // simply never read. Same derive-don't-sync idiom as pkgPick above.
  const [preSel, setPreSel] = useState({});
  const [preNames, setPreNames] = useState({});
  // Server-driven reveal (book → preorders_required): the fn's OWN groups,
  // keyed to the package they came back for — covers any drift between the
  // slots offer and the fn, and goes dormant if the guest switches cards.
  const [forcedPre, setForcedPre] = useState(null); // { pkgId, groups }

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

  // Terms acknowledgement under the Book button — no checkbox (UK norm: the
  // "By booking you agree…" line is the acknowledgement). Which disclosure is
  // open is the only state; the TEXT is derived per render, so a package
  // deselection while its terms are open simply renders nothing.
  const [termsOpen, setTermsOpen] = useState(null); // null | 'booking' | 'package'

  // ── boot: best-effort anon auth, then config ────────────────────────────────
  useEffect(() => {
    if (urlPreorderToken) return; // completion flow — PreorderPage boots itself
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
  }, [opsId, urlPreorderToken]);

  // ── slots: re-fetch whenever party or date changes (and on slot_full) ───────
  useEffect(() => {
    if (boot !== 'ready') return;
    let off = false;
    const key = `${date}|${party}|${slotsNonce}`;
    (async () => {
      const r = await callWidget({ action: 'slots', location_id: opsId, date, party });
      if (off) return;
      if (r?.ok && r.blocked) { setSlotsRes({ key, slots: [], packages: [], err: false, blocked: true }); setTime(null); return; }
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

  // Book → preorders_required reveals the section below; the scroll is a
  // DOM-only side effect, ref-flagged from the submit handler and fired once
  // the re-render has actually mounted the section (same no-dep idiom as the
  // deep-link scroll above).
  const choicesRef = useRef(null);
  const wantChoicesScrollRef = useRef(false);
  useEffect(() => {
    if (!wantChoicesScrollRef.current || !choicesRef.current) return;
    wantChoicesScrollRef.current = false;
    const el = choicesRef.current;
    requestAnimationFrame(() => el.scrollIntoView({ block: 'center' }));
  });

  // Everything about menu choices is DERIVED per render against the currently
  // selected offer — no effects, no resets.
  const forced = (forcedPre && selectedPkg && String(forcedPre.pkgId) === String(selectedPkg.id))
    ? forcedPre : null;
  const pkgGroups = (selectedPkg?.choiceGroups?.length ? selectedPkg.choiceGroups : forced?.groups) || [];
  const preDays = Number(selectedPkg?.preorderDaysBefore) || 0;
  // Window test on the VENUE's calendar (cfg.today, never the browser's):
  // inside the window the kitchen needs choices NOW; outside it the fn mints a
  // completion token instead. The server recomputes — this only decides what
  // the page shows first, and `forced` overrides it when the fn disagrees.
  const daysAhead = Math.round((Date.parse(date) - Date.parse(cfg?.today || todayISO())) / 86400000);
  const choicesNow = !!selectedPkg && pkgGroups.length > 0
    && (forced ? true : (!!selectedPkg.requiresPreorder && daysAhead <= preDays));
  const choicesLater = !!selectedPkg?.requiresPreorder && !choicesNow && daysAhead > preDays;
  const seatSel = (seat, course) =>
    (selectedPkg && preSel[`${String(selectedPkg.id)}|${seat}|${course}`]) || '';
  const choicesComplete = !choicesNow || pkgGroups.every((g) =>
    Array.from({ length: party }, (_, i) => i + 1)
      .every((s) => g.options.some((o) => o.name === seatSel(s, g.course))));
  const choicesHint = `Choose a ${joinAnd(pkgGroups.map((g) => String(g.label || '').toLowerCase()))} for each guest`;

  const maxCovers = Math.max(1, cfg?.maxCovers || 12);
  const maxDaysAhead = cfg?.maxDaysAhead ?? 90;
  // Terms in play right now: the venue's standing booking terms (config) plus
  // the selected package's own terms (rides the slots offer).
  const bookingTerms = String(cfg?.bookingTerms || '');
  const pkgTerms = String(selectedPkg?.terms || '');
  const termsText = termsOpen === 'booking' ? bookingTerms
    : termsOpen === 'package' ? pkgTerms : '';
  const phoneOk = (() => { const n = normalisePhone(phone); return !!n && n.length >= 7; })();
  const canSubmit = !!name.trim() && phoneOk && !!time && !submitting && choicesComplete;

  // ── book ────────────────────────────────────────────────────────────────────
  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setSubmitErr('');
    // In-window package: one row per guest per course group (seat = guest
    // index; the fn matches on the option's name). Outside the window nothing
    // is sent — the fn mints the completion token instead.
    let preorders;
    if (choicesNow && selectedPkg) {
      preorders = [];
      for (let seat = 1; seat <= party; seat++) {
        for (const g of pkgGroups) {
          const sel = seatSel(seat, g.course);
          if (sel) preorders.push({ seat, guestName: (preNames[seat] || '').trim() || undefined, name: sel });
        }
      }
    }
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
      preorders,
    });
    setSubmitting(false);
    if (r?.ok && (r.status === 'confirmed' || r.status === 'pending')) { setResult(r); return; }
    if (r?.error === 'preorders_required') {
      // Defensive: the fn wants choices the page didn't collect (offer drift).
      // Reveal the section from ITS choiceGroups and walk the guest there.
      setForcedPre({
        pkgId: selectedPkg ? selectedPkg.id : null,
        groups: Array.isArray(r.choiceGroups) ? r.choiceGroups : [],
      });
      setSubmitErr('This menu needs a choice for each guest — pick them below.');
      wantChoicesScrollRef.current = true;
      return;
    }
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

  // Tokened completion flow replaces the whole booking page (checked before
  // the boot states — boot never leaves 'loading' when a token is present).
  if (urlPreorderToken) {
    return <PreorderPage token={urlPreorderToken} shell={shell}
      brand={brand} onBrand={onBrand} venueName={venueName} />;
  }

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
          // The full story of what was booked (owner, 13 Aug: "it didn't show
          // any information about what it was"): name + total, what's included
          // (compact, from the booked offer in the last slots response), the
          // pre-order state, and the honest payment line.
          <div style={{
            margin: '0 auto 14px', maxWidth: 340, padding: '12px 14px', borderRadius: 12,
            border: '1px solid rgba(22,163,74,.4)', background: 'rgba(22,163,74,.08)',
            textAlign: 'left',
          }}>
            <div style={{ fontSize: 14, fontWeight: 800, color: 'var(--ink)' }}>{result.package.name}</div>
            {confPkg && (
              <div style={{ fontFamily: MONO, fontSize: 13, fontWeight: 700, color: 'var(--ink)', marginTop: 2 }}>
                {pkgTotalLabel(confPkg)}
              </div>
            )}
            {confPkg && <IncludesList includes={confPkg.includes} compact />}
            {result.preordersTaken && !result.preorderToken && (
              <div style={{ fontSize: 12.5, fontWeight: 700, color: '#15803d', marginTop: 8 }}>
                Menu choices received ✓
              </div>
            )}
            {(() => {
              const rule = pkgRuleLine(result.package.paymentModel, cfg, result.party || party);
              return rule && (
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', marginTop: 6, lineHeight: 1.5 }}>
                  {rule}
                </div>
              );
            })()}
          </div>
        )}
        {/* Card capture — only when the fn asked for it (paymentDue non-null)
            and there's a real backend to pay through. Sits ABOVE the
            choose-your-menu box: money first, menu after. */}
        {!isMock && supabase && result.paymentDue && result.bookingId && (
          <BookingPaymentCard
            paymentDue={result.paymentDue}
            adyen={result.adyen}
            bookingId={result.bookingId}
            opsId={opsId}
          />
        )}
        {result.preorderToken && (
          // Booked OUTSIDE the pre-order window: the guest chooses later via
          // this tokened link (the fn emails + texts the same one).
          <div style={{
            margin: '0 auto 14px', maxWidth: 380, padding: '14px 16px', borderRadius: 12,
            border: `1.5px solid ${brand}`, background: `${brand}14`,
          }}>
            <div style={{ fontFamily: DISPLAY_FONT, fontSize: 16, fontWeight: 800, color: 'var(--ink)' }}>
              Choose your menu
            </div>
            <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.5, marginTop: 4 }}>
              {result.package?.name || 'Your menu'} needs a choice for each guest
              {result.preorderDeadline
                ? <> — choices due by <b style={{ color: 'var(--ink)' }}>{fmtDateLong(result.preorderDeadline)}</b>.</>
                : '.'}
            </div>
            <a href={`${window.location.origin}/book?preorder=${result.preorderToken}`}
              style={{
                display: 'block', marginTop: 10, padding: '12px 14px', borderRadius: 11,
                background: brand, color: onBrand, fontSize: 14, fontWeight: 800,
                textAlign: 'center', textDecoration: 'none',
              }}>
              Choose your menu
            </a>
            <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 8, textAlign: 'center' }}>
              We’ll also email and text you this link.
            </div>
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
    {/* Package hero — the ?package= deep link's landing content: name, price,
        what's included, the honest payment rule, terms. The normal party/date/
        time flow continues below with the package pre-selected. */}
    {heroPkg && (
      <div style={{ ...S.card, marginBottom: 14 }}>
        <div style={S.fieldLbl}>Experience</div>
        <div style={{
          fontFamily: DISPLAY_FONT, fontSize: 26, fontWeight: 800, lineHeight: 1.2,
          letterSpacing: '-.01em', color: 'var(--ink)',
        }}>
          {heroPkg.name}
        </div>
        <div style={{ fontFamily: MONO, fontSize: 14.5, fontWeight: 800, color: 'var(--ink)', marginTop: 6 }}>
          {pkgTotalLabel(heroPkg)}
        </div>
        {heroPkg.description && (
          <div style={{ fontSize: 13.5, color: 'var(--muted)', lineHeight: 1.55, marginTop: 8 }}>
            {heroPkg.description}
          </div>
        )}
        <IncludesList includes={heroPkg.includes} />
        {(() => {
          const rule = pkgRuleLine(heroPkg.paymentModel, cfg, party);
          return rule && (
            <div style={{ fontSize: 12.5, fontWeight: 700, color: '#15803d', marginTop: 12 }}>{rule}</div>
          );
        })()}
        {!!heroPkg.terms && (
          <details style={{ marginTop: 10 }}>
            <summary style={{ cursor: 'pointer', fontSize: 12.5, fontWeight: 700, color: 'var(--muted)' }}>
              Package terms
            </summary>
            <div style={{
              marginTop: 6, fontSize: 12, color: 'var(--muted)', lineHeight: 1.6,
              whiteSpace: 'pre-wrap',
            }}>{heroPkg.terms}</div>
          </details>
        )}
      </div>
    )}
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
      ) : (slotsRes?.blocked || (cfg?.blockedDates || []).includes(date)) ? (
        <div style={{ padding: '18px 4px', fontSize: 13.5, color: 'var(--t2, #555)', lineHeight: 1.5 }}>
          The venue isn't taking online bookings for this date. Pick another day, or call the venue directly.
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
                const rule = pkgRuleLine(p.paymentModel, cfg, party);
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
                    {rule && (
                      <div style={{ fontSize: 11.5, fontWeight: 600, color: '#15803d', marginTop: 5 }}>
                        {rule}
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

          {/* In the pre-order window: capture one choice per guest per course
              group right here (the fn refuses the booking without them).
              Outside it: a soft note — the guest gets a tokened link instead. */}
          {choicesNow && (
            <div ref={choicesRef} style={{ marginTop: 14 }}>
              <div style={S.fieldLbl}>Menu choices</div>
              <GuestChoiceCards
                party={party} groups={pkgGroups} brand={brand} onBrand={onBrand}
                getSel={seatSel}
                onPick={(seat, course, nm) => {
                  setPreSel((m) => ({ ...m, [`${String(selectedPkg.id)}|${seat}|${course}`]: nm }));
                  setSubmitErr('');
                }}
                getName={(seat) => preNames[seat] || ''}
                onName={(seat, v) => setPreNames((m) => ({ ...m, [seat]: v }))}
              />
            </div>
          )}
          {choicesLater && (
            <div style={{
              marginTop: 10, padding: '9px 12px', borderRadius: 10, fontSize: 12.5,
              lineHeight: 1.5, color: 'var(--muted)', background: 'var(--bg)',
              border: '1px dashed var(--line)',
            }}>
              Menu choices aren’t needed yet — we’ll email and text you a link,
              choices due by {fmtDateLong(addDaysISO(-preDays, date))}.
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
      {choicesNow && !choicesComplete && (
        <div style={{ marginTop: 8, fontSize: 12, color: 'var(--muted)', textAlign: 'center' }}>
          {choicesHint}
        </div>
      )}

      {/* Terms acknowledgement — venue booking terms and/or the selected
          package's terms, each opening a small pre-wrap disclosure. The
          sentence reads correctly in all three combinations. */}
      {(bookingTerms || pkgTerms) && (
        <div style={{ marginTop: 10, fontSize: 12, color: 'var(--muted)', textAlign: 'center', lineHeight: 1.6 }}>
          By booking you agree to the{' '}
          {bookingTerms && (
            <button type="button" aria-expanded={termsOpen === 'booking'}
              onClick={() => setTermsOpen((o) => (o === 'booking' ? null : 'booking'))}
              style={{ ...S.linkBtn, fontSize: 12 }}>
              booking terms
            </button>
          )}
          {bookingTerms && pkgTerms && <> and the </>}
          {pkgTerms && (
            <button type="button" aria-expanded={termsOpen === 'package'}
              onClick={() => setTermsOpen((o) => (o === 'package' ? null : 'package'))}
              style={{ ...S.linkBtn, fontSize: 12 }}>
              {selectedPkg.name} terms
            </button>
          )}
        </div>
      )}
      {!!termsText && (
        <div style={{
          marginTop: 8, padding: '10px 12px', borderRadius: 10,
          border: '1px dashed var(--line)', background: 'var(--bg)',
          fontSize: 12, color: 'var(--muted)', lineHeight: 1.6, whiteSpace: 'pre-wrap',
        }}>
          {termsText}
        </div>
      )}
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
