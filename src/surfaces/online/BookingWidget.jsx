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

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AdyenCheckout, Dropin, Card, ApplePay, GooglePay } from '@adyen/adyen-web';
import '@adyen/adyen-web/styles/adyen.css';
import { supabase, ensureAuthToken, isMock } from '../../lib/supabase';
import { normalisePhone } from '../../lib/customerLookup';
import { readTheme, deriveVars, readableOn, DISPLAY_FONT, BODY_FONT } from '../menu/menuTheme';
import MenuHeader from '../menu/MenuHeader';
import OnlineItemSheet from './OnlineItemSheet';
import { sheetThemeFrom } from './sheetTheme';
import {
  itemHasOptions, itemNeedsSheetReturn, choiceSummary,
  optionGroupIdsFor, sizeChildren, MAX_CHOICE_NOTE,
} from '../../lib/bookings/preorderChoices';
import {
  plainChoice, choiceFromRow, choicePayload, menuRowFor, choicePriceFor, choiceExtra, choiceComplete,
} from '../../lib/bookings/guestChoicePricing';
import {
  CARD_ONLY_PAYMENT_METHODS, buildPaymentMethodsRequest, resolvePaymentMethods,
  offeredWalletTypes, walletConfiguration, missingWalletNote, droppedWalletNote,
} from '../../lib/payments/adyenWallets';

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
// v5.7.24 - OPTIONS within one choice group are alternatives: "Olives or
// Cheese Bread", never "and" (the guest picks one). joinAnd stays for the
// across-courses nudge, where "a starter, main and dessert" is correct.
function joinOr(list) {
  const a = list.filter(Boolean);
  if (a.length <= 1) return a[0] || 'choice';
  return `${a.slice(0, -1).join(', ')} or ${a[a.length - 1]}`;
}

// ── package money (POUNDS — the fn pre-computes `total`; per_cover = price × party)
function fmtGBP(n) {
  const v = Math.round((Number(n) || 0) * 100) / 100;
  return Number.isInteger(v) ? `£${v}` : `£${v.toFixed(2)}`;
}
// The card amount in the venue's currency (8 Sep 2026: a US venue's deposit
// is USD). GBP keeps the exact £ shape used everywhere else on the page.
function fmtMoney(n, currency = 'GBP') {
  const cur = String(currency || 'GBP').toUpperCase();
  if (cur === 'GBP') return fmtGBP(n);
  const v = Math.round((Number(n) || 0) * 100) / 100;
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur, minimumFractionDigits: Number.isInteger(v) ? 0 : 2 }).format(v);
  } catch { return `${cur} ${v.toFixed(2)}`; }
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
  // 10 Sep 2026 payment gate: the fn no longer offers a prepay or deposit
  // package when capture is off, so those lines only render with capture on.
  // A hold SAVES a card and takes nothing; no no-show charge exists, so none
  // is promised.
  if (model === 'prepay') {
    return captureOn ? 'Paid in full when you book. It comes off the bill on the night.' : null;
  }
  if (model === 'deposit') {
    return captureOn ? 'Deposit paid when you book. The rest is paid on the night.' : null;
  }
  if (model === 'hold') {
    if (!captureOn) return null;
    const min = Number(cfg?.cardCaptureMinCovers) || 0;
    if (min > 0 && party < min) return null;
    return 'A card is saved to hold the table. Nothing is taken today.';
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
    out.push({ head: `${label}: each guest picks one`, body: joinOr(names.map((n) => n)) });
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

// ── card capture ("Secure your booking") ──────────────────────────────────────
// Copy per paymentDue.kind. Two modes (v5.7.21 pay-before-commit):
//   required=true  — the booking is 'pending_payment': the table is HELD for
//                    20 minutes and only becomes confirmed/prepaid when the
//                    money lands (onPaid fires with the promoted status).
//   required=false — legacy screen (deploy skew: an old fn that confirmed
//                    before money); the soft "either way" copy stays there.
// 8 Sep 2026: the hardcoded card only list this file used to hand Drop-in is
// now the shared FALLBACK in src/lib/payments/adyenWallets.js. This card mounts
// the venue's REAL /paymentMethods response (same adyen-checkout
// `payment_methods` action the online and QR checkouts use), so Apple Pay and
// Google Pay appear here too. The money still runs through booking-widget's
// booking_pay, which knows the amount server-side, so only the METHOD LIST and
// the wallet configuration are shared, not the payment call.
// 10 Sep 2026: a hold SAVES the card and takes nothing today. No no-show
// charge exists, so the copy never promises one or quotes a held figure.
const PAY_TITLE = {
  prepay: (amt) => `Pay ${amt} now. It comes off your bill.`,
  deposit: (amt) => `Pay your ${amt} deposit`,
  hold: () => 'Save a card to hold your table. Nothing is taken today.',
};
const PAID_LINE = {
  prepay: (amt) => `Paid ${amt}`,
  deposit: (amt) => `Deposit paid ${amt}`,
  hold: () => 'Card saved',
};
// Under the card form while the table is held.
const HELD_NOTE = {
  prepay: 'Your table is held for 20 minutes while you pay. The booking only confirms once payment goes through.',
  deposit: 'Your table is held for 20 minutes while you pay. The booking only confirms once payment goes through.',
  hold: 'Your table is held for 20 minutes. The booking only confirms once your card is saved.',
};
const CONFIRM_POLL_MS = 4000;
const CONFIRM_POLL_MAX_MS = 120000;   // up to two minutes, then say so plainly

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

// ── guest pre-order choices: sizes and options (10 Sep 2026) ─────────────────
// A dish with sizes, modifier groups or instruction groups opens the SAME item
// sheet the online storefront uses (OnlineItemSheet), never a new picker. A
// pick is an object { name, itemId, mods, variantItemId, variantName, notes },
// compared on name where the page used to compare name strings. The server
// (booking-widget) re-checks every option against the menu and restamps its
// price, so this page only ever DISPLAYS prices. Extras are paid at the table.
const NO_ROWS = [];
const NO_STOCK = {};
// plainChoice, choiceFromRow, choicePayload, menuRowFor, choicePriceFor,
// choiceExtra and choiceComplete live in src/lib/bookings/guestChoicePricing.js
// (10 Sep 2026 review), where node:test covers them.

// The venue's menu for the choice sheet, loaded ONCE per venue the way
// OnlineSurface loads it (menu_items for the location, not archived, plus the
// config_pushes snapshot's instructionGroupDefs; both are public reads). Then
// the minimum of every modifier group on the offered dishes, so the page knows
// which dishes must be configured. For a future booking there is no 86 or
// stock list: a dish out today may be back on the night.
// Returns { status: 'off'|'loading'|'failed'|'ready', items, instGroupDefs, groupMin }.
function useGuestMenu(locationId, enabled, optionItemIds) {
  const menuKey = enabled && locationId && supabase && !isMock ? String(locationId) : null;
  const [menuRes, setMenuRes] = useState(null); // { key, items, instGroupDefs, failed }
  const loadedFor = useRef(null);
  useEffect(() => {
    if (!menuKey || loadedFor.current === menuKey) return undefined;
    let off = false;
    (async () => {
      let res = { key: menuKey, items: NO_ROWS, instGroupDefs: NO_ROWS, failed: true };
      try {
        const [iRes, pRes] = await Promise.allSettled([
          supabase.from('menu_items').select('*')
            .eq('location_id', menuKey).eq('archived', false).order('sort_order'),
          supabase.from('config_pushes').select('snapshot->instructionGroupDefs')
            .eq('location_id', menuKey).order('created_at', { ascending: false }).limit(1).maybeSingle(),
        ]);
        const iOk = iRes.status === 'fulfilled' && !iRes.value?.error;
        if (!iOk) console.warn('[BookingWidget] menu load failed, choices show without options');
        const defs = pRes.status === 'fulfilled' ? pRes.value?.data?.instructionGroupDefs : null;
        res = { key: menuKey, items: iOk ? (iRes.value.data || NO_ROWS) : NO_ROWS, instGroupDefs: Array.isArray(defs) ? defs : NO_ROWS, failed: !iOk };
      } catch (e) {
        console.warn('[BookingWidget] menu load threw:', e?.message);
      }
      if (off) return;
      loadedFor.current = menuKey;
      setMenuRes(res);
    })();
    return () => { off = true; };
  }, [menuKey]);

  const ready = !!menuKey && !!menuRes && menuRes.key === menuKey && !menuRes.failed;
  const items = ready ? menuRes.items : NO_ROWS;
  const wanted = new Set();
  if (ready) {
    for (const id of optionItemIds || []) {
      const row = items.find((r) => String(r.id) === String(id));
      if (!row) continue;
      for (const g of optionGroupIdsFor(row, items).mod) wanted.add(g);
      for (const kid of sizeChildren(row, items)) for (const g of optionGroupIdsFor(kid, items).mod) wanted.add(g);
    }
  }
  const groupIds = [...wanted].sort();
  const minKey = ready && groupIds.length ? `${menuKey}|${groupIds.join(',')}` : null;
  const [minRes, setMinRes] = useState(null); // { key, groupMin }
  useEffect(() => {
    if (!minKey) return undefined;
    let off = false;
    const ids = minKey.slice(minKey.indexOf('|') + 1).split(',');
    (async () => {
      let groupMin = null;
      try {
        const { data, error } = await supabase.from('modifier_groups').select('id, min').in('id', ids);
        if (error) console.warn('[BookingWidget] modifier group read failed:', error.message);
        else {
          groupMin = {};
          for (const g of data || []) groupMin[String(g.id)] = Number(g.min) || 0;
        }
      } catch (e) {
        console.warn('[BookingWidget] modifier group read threw:', e?.message);
      }
      if (!off) setMinRes({ key: minKey, groupMin });
    })();
    return () => { off = true; };
  }, [minKey]);

  const status = !menuKey ? 'off'
    : (!menuRes || menuRes.key !== menuKey) ? 'loading'
      : menuRes.failed ? 'failed' : 'ready';
  const groupMin = !ready ? null : !minKey ? {} : (minRes?.key === minKey ? minRes.groupMin : null);
  return { status, items, instGroupDefs: ready ? menuRes.instGroupDefs : NO_ROWS, groupMin };
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
// 10 Sep 2026: getSel returns a pick object (or null) and onPick receives one.
// A dish with options opens the online item sheet (see useGuestMenu above).
function GuestChoiceCards({ party, groups, getSel, onPick, getName, onName, brand, onBrand, menu = null, model = null, sheetTheme = null }) {
  const seats = Array.from({ length: Math.max(1, party) }, (_, i) => i + 1);
  // The open sheet: which guest, which course, which option and its menu row.
  const [sheet, setSheet] = useState(null);
  const rows = menu?.status === 'ready' ? menu.items : NO_ROWS;
  const tap = (seat, g, o) => {
    const cur = getSel(seat, g.course);
    const row = menuRowFor(menu, o.itemId);
    if (!row || !sheetTheme || !itemHasOptions(row, rows)) {
      onPick(seat, g.course, cur?.name === o.name ? cur : plainChoice(o));
      return;
    }
    // Nothing required: the tap chooses the dish straight away (the old rule)
    // and the sheet only adds options. A size or a required option: the dish
    // counts only once the sheet comes back.
    const mustFinish = itemNeedsSheetReturn(row, rows, { groupMin: menu.groupMin, instDefs: menu.instGroupDefs });
    if (!mustFinish && cur?.name !== o.name) onPick(seat, g.course, plainChoice(o));
    setSheet({ seat, course: g.course, option: o, row });
  };
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
            const curOpt = cur ? g.options.find((o) => o.name === cur.name) || null : null;
            const summary = curOpt ? choiceSummary(cur) : '';
            const extra = curOpt ? choiceExtra(cur, curOpt, menu, model) : 0;
            const unfinished = !!curOpt && !choiceComplete(cur, g.options, menu);
            return (
              <div key={g.course} style={{ marginTop: 9 }}>
                <div style={{
                  fontSize: 10.5, fontWeight: 700, color: 'var(--muted)',
                  letterSpacing: '.06em', textTransform: 'uppercase', marginBottom: 5,
                }}>{g.label}</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {g.options.map((o) => {
                    const on = cur?.name === o.name;
                    return (
                      <button key={o.lineId || o.name} type="button" aria-pressed={on}
                        onClick={() => tap(seat, g, o)}
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
                {/* The size and options on this guest's pick, in one line, and
                    what they add. Extras are paid at the table, never online. */}
                {summary && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', columnGap: 8, marginTop: 6, fontSize: 14, lineHeight: 1.45, minWidth: 0 }}>
                    <span style={{ flex: '1 1 140px', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--muted)' }}>
                      {summary}
                    </span>
                    {extra > 0 && (
                      <span style={{ flex: 'none', whiteSpace: 'nowrap', fontWeight: 700, color: 'var(--ink)' }}>
                        Extra {fmtGBP(extra)}, paid at the table
                      </span>
                    )}
                  </div>
                )}
                {unfinished && (
                  <div style={{ marginTop: 6, fontSize: 14, fontWeight: 700, color: '#b45309' }}>
                    Tap {curOpt.name} to choose its options.
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ))}
      {sheet && typeof document !== 'undefined' && createPortal(
        <OnlineItemSheet
          key={`${sheet.seat}|${sheet.course}|${sheet.option.name}`}
          item={sheet.row}
          theme={sheetTheme}
          allItems={rows}
          instGroupDefs={menu?.instGroupDefs || NO_ROWS}
          eightySixIds={NO_ROWS}
          stockLevels={NO_STOCK}
          cart={NO_ROWS}
          priceFor={choicePriceFor(model, sheet.option.priceOverride, sheet.row, rows)}
          lockQty
          addLabel="Save choice"
          notesMax={MAX_CHOICE_NOTE}
          strictRequired
          extraPrices
          onClose={() => setSheet(null)}
          onAdd={(finalItem, flatMods, _qty, notes) => {
            const sized = finalItem && String(finalItem.id) !== String(sheet.row.id)
              ? rows.find((r) => String(r.id) === String(finalItem.id)) || null
              : null;
            onPick(sheet.seat, sheet.course, {
              name: sheet.option.name,
              itemId: sheet.option.itemId || null,
              mods: Array.isArray(flatMods) ? flatMods : [],
              variantItemId: sized ? String(sized.id) : null,
              variantName: sized ? (sized.menu_name || sized.name || null) : null,
              notes: String(notes || '').slice(0, MAX_CHOICE_NOTE),
              configured: true,
            });
            setSheet(null);
          }}
        />,
        document.body,
      )}
    </div>
  );
}

// The confirmation screen's payment box — renders ONLY when the book response
// carried paymentDue (venue has card capture on; null = nothing to collect).
// ADVANCED-flow Adyen Card, same pattern as components/AdyenPaymentForm.jsx:
// the card encrypts in the browser, the money request runs through the
// booking-widget fn (booking_pay), which knows the amount server-side. In
// required mode the booking is pending_payment (failure = retry, then the
// 20-minute expiry); in legacy mode it was already confirmed, so every
// failure path stays soft — the guest can sort payment with the venue.
function BookingPaymentCard({ paymentDue, adyen, bookingId, opsId, venueName = '', required = false, onPaid = null }) {
  const holder = useRef(null);
  const dropinRef = useRef(null);
  const submittedRef = useRef(false); // pre-submit onError = setup failure → fallback copy
  const offeredWallets = useRef([]);  // wallet types the venue's Adyen config offers
  // 10 Sep 2026: the merchant reference booking_pay answered with, sent back
  // on booking_pay_details so the 3DS result settles the SAME payment row.
  const referenceRef = useRef(null);
  // The latest onPaid, read by the Drop-in callbacks and the confirm poll
  // without making either depend on a new closure every render.
  const onPaidRef = useRef(onPaid);
  useEffect(() => { onPaidRef.current = onPaid; });
  const [attempt, setAttempt] = useState(0); // bump to remount the form after a refusal
  // phase: init | ready | failed | refused | paid
  //        confirming (the server has not confirmed yet, polling)
  //        slow (still not confirmed after two minutes) | lost (released) | taken (paid, table gone)
  const [phase, setPhase] = useState('init');
  const [refusedText, setRefusedText] = useState(''); // the one plain sentence for 'refused'
  const [refusal, setRefusal] = useState('');
  const [payErr, setPayErr] = useState('');
  // phase 'stuck' (money or a saved card is in, the booking is not): the
  // server's error code, shown only behind Show detail.
  const [stuckCode, setStuckCode] = useState('');
  const [walletNote, setWalletNote] = useState(''); // one line when a wallet cannot render here
  const [paidInfo, setPaidInfo] = useState(null); // { pspReference }

  const kind = paymentDue?.kind;
  // 8 Sep 2026: the currency comes from the booking-widget fn (the venue's
  // platform currency), so a US venue's deposit is a USD payment on its US
  // merchant account. An older fn build without it is a GBP venue.
  const currency = String(adyen?.currency || 'GBP').toUpperCase();
  const amt = fmtMoney((Number(paymentDue?.amountMinor) || 0) / 100, currency);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        // What can this venue actually offer at THIS amount? Same
        // adyen-checkout `payment_methods` action as the online and QR
        // checkouts (see src/lib/payments/adyenWallets.js). A failure is card
        // only with a console warning, never a dead booking payment.
        const amountMinor = Number(paymentDue?.amountMinor) || 0;
        const countryCode = adyen?.region === 'US' ? 'US' : 'GB';
        // WALLETS ARE FOR MONEY, NOT FOR HOLDS. A 'hold' booking is a ZERO
        // value authorisation whose whole purpose is storePaymentMethod, so
        // the no-show charge can be taken later off session (booking_pay sends
        // amount 0 + UnscheduledCardOnFile). A wallet token is device bound and
        // cannot be stored and re-charged that way, and the sheet would have
        // shown the guest the hold figure while a £0 request went to Adyen.
        // Holds stay card only, deliberately.
        const walletsAllowed = kind !== 'hold';
        let resolvedPm = { response: CARD_ONLY_PAYMENT_METHODS, fallback: false, reason: null };
        if (walletsAllowed) {
          let pmRes;
          try {
            pmRes = await supabase.functions.invoke('adyen-checkout', {
              body: buildPaymentMethodsRequest({
                locationId: opsId,
                amountMinor,
                currency,
                shopperLocale: typeof navigator !== 'undefined' ? navigator.language : undefined,
              }),
            });
          } catch (e) {
            pmRes = { data: null, error: e };
          }
          if (!live) return;
          resolvedPm = resolvePaymentMethods(pmRes);
          if (resolvedPm.fallback) console.warn('[adyen] booking payment methods lookup fell back to card only:', resolvedPm.reason);
          // An entry Drop-in would have THROWN on (a googlepay with no Google
          // merchant ID is the common one) was filtered out before it could
          // take the booking's card form down with it.
          if (resolvedPm.dropped?.length) {
            console.warn('[adyen] wallet dropped before Drop-in could throw on it:', droppedWalletNote(resolvedPm.dropped));
          }
        }
        const paymentMethodsResponse = resolvedPm.response || CARD_ONLY_PAYMENT_METHODS;
        offeredWallets.current = offeredWalletTypes(paymentMethodsResponse);

        // onAuthorized fires BEFORE onSubmit and the payment waits on it, so
        // resolving is not optional once we supply it. A dismissed wallet
        // sheet arrives as name === 'CANCEL' and is not a failure.
        // A WALLET COMPONENT'S ERROR NEVER TAKES THE CARD FORM DOWN. phase
        // 'failed' hides the Drop-in holder entirely, so the guest cannot pay
        // and the held table expires after 20 minutes. ApplePayElement's
        // constructor loads apple-pay-sdk.js from Apple's CDN and, on failure,
        // calls handleError(SCRIPT_ERROR). And because
        // paymentMethodsConfiguration spreads last in buildElementProps, THIS
        // is that element's onError. A blocked CDN or an extension is a
        // wallet-availability non-event on a browser where the card works.
        // A dismissed sheet arrives as name === 'CANCEL', likewise nothing.
        const walletCallbacks = {
          onAuthorized: (_data, actions) => { setPayErr(''); actions.resolve(); },
          onError: (e) => {
            if (!live) return;
            if (!submittedRef.current || e?.name === 'CANCEL' || e?.name === 'SCRIPT_ERROR' || e?.name === 'IMPLEMENTATION_ERROR') {
              console.warn('[adyen] wallet unavailable:', e?.name, e?.message);
              return;
            }
            setPayErr('Something went wrong, please try again.');
          },
        };
        const wallets = walletConfiguration({
          response: paymentMethodsResponse,
          amountMinor,
          currency,
          countryCode,
          merchantName: venueName,
        });
        const paymentMethodsConfiguration = {};
        for (const [type, conf] of Object.entries(wallets)) {
          paymentMethodsConfiguration[type] = { ...conf, ...walletCallbacks };
        }

        // ONE reading of a booking-widget payment reply, shared by the first
        // /payments (onSubmit) and the 3DS completion (onAdditionalDetails).
        // 10 Sep 2026 payment gate: PAID means the SERVER says the booking is
        // confirmed or prepaid. Nothing else is ever shown as booked.
        const handleReply = (r, actions) => {
          if (!live) return;
          if (r?.reference) referenceRef.current = r.reference;
          if (r?.ok && (r.status === 'confirmed' || r.status === 'prepaid')) {
            setPaidInfo({ pspReference: r.pspReference || null });
            setPhase('paid');
            actions.resolve({ resultCode: 'Authorised' });
            onPaidRef.current?.(r.status);
            return;
          }
          if (r?.ok && r.action) {
            // A full page redirect cannot come back to this page (the booking
            // lives in memory here). Native 3DS runs inside the Drop-in.
            if (r.action.type === 'redirect') {
              setPayErr('Your bank asked for a step this page cannot finish. Nothing was taken. Please try another card.');
              actions.reject();
              return;
            }
            actions.resolve({ resultCode: r.resultCode || 'IdentifyShopper', action: r.action });
            return;
          }
          if (r?.ok && r.pending) {
            // Received or Pending: Adyen has not decided yet. The booking stays
            // unpaid; poll the server for its real status.
            setPhase('confirming');
            actions.resolve({ resultCode: r.resultCode || 'Pending' });
            return;
          }
          if (r?.error === 'card_refused' || r?.error === 'payment_not_completed') {
            setRefusal(r.refusalReason || '');
            setRefusedText(r.error === 'card_refused'
              ? 'Your card was refused. No money was taken.'
              : 'The payment was not finished. No money was taken.');
            setPhase('refused');
            actions.reject();
            return;
          }
          if (r?.error === 'paid_but_table_taken') {
            setPhase('taken');
            actions.reject();
            return;
          }
          // 10 Sep 2026 review: money (or a saved card) may already be in for
          // these. Never "could not take the payment", never a retry.
          if (r?.error === 'paid_but_booking_not_promotable' || r?.error === 'amount_short' || r?.error === 'paid_amount_short') {
            setStuckCode(String(r.error));
            setPhase('stuck');
            actions.reject();
            return;
          }
          if (r?.error === 'payment_record_failed') {
            // An older server: the bank may still say yes. Wait and check.
            setPhase('confirming');
            actions.resolve({ resultCode: 'Pending' });
            return;
          }
          if (r?.error === 'unknown_or_closed') {
            if (r.status === 'confirmed' || r.status === 'prepaid') {
              // Already paid and booked (the webhook got there first).
              setPhase('paid');
              actions.resolve({ resultCode: 'Authorised' });
              onPaidRef.current?.(r.status);
              return;
            }
            // Seated by the venue, or the 20 minutes ran out: nothing was charged here.
            setPhase(r.status === 'dining' ? 'seated' : 'released');
            actions.reject();
            return;
          }
          setPayErr('We could not confirm your payment. Check your bank app before you try again.');
          actions.reject();
        };

        // 8 Sep 2026: the book response carries region ('UK' | 'US') and
        // dropinEnvironment ('test' | 'live' | 'live-us') beside the client
        // key, so a US venue's live Drop-in mounts against Adyen's US data
        // centre. An older fn build without it falls back to the environment.
        const checkout = await AdyenCheckout({
          clientKey: adyen?.clientKey || undefined,
          environment: adyen?.dropinEnvironment || (adyen?.environment === 'live' ? 'live' : 'test'),
          countryCode,
          // A hold is a ZERO value check that saves the card (booking_pay sends
          // 0), so the Drop-in must not show "Pay £40.00" (10 Sep 2026 review).
          // At 0 Adyen labels its button with confirmPreauthorization.
          amount: { value: kind === 'hold' ? 0 : amountMinor, currency },
          translations: {
            'en-GB': { confirmPreauthorization: 'Save card' },
            'en-US': { confirmPreauthorization: 'Save card' },
          },
          paymentMethodsResponse,
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
            handleReply(r, actions);
          },
          // 3DS: the Drop-in ran the challenge; the server finishes it under
          // the same merchant reference and settles the same payment row.
          onAdditionalDetails: async (state, _component, actions) => {
            setPayErr('');
            const r = await callWidget({
              action: 'booking_pay_details',
              location_id: opsId,
              booking_id: bookingId,
              reference: referenceRef.current,
              details: state.data?.details,
              payment_data: state.data?.paymentData,
            });
            handleReply(r, actions);
          },
          onPaymentCompleted: () => {}, // success already handled on the server reply
          onPaymentFailed: () => {},    // refusal already handled on the server reply
          onError: (e) => {
            if (!live) return;
            // A dismissed Apple Pay / Google Pay sheet arrives as
            // name === 'CANCEL'. Nothing was charged and the form still works,
            // so it must not read as a failed payment (8 Sep 2026).
            if (e?.name === 'CANCEL') return;
            // Before any submit this is a setup failure (bad origin, network):
            // swap the form for the soft fallback. After a submit the server
            // reply has already driven the state; keep the form usable.
            if (!submittedRef.current) setPhase('failed');
            else setPayErr('Something went wrong, please try again.');
          },
        });
        if (!live) return;
        // `let` and not `const`: onReady closes over this, and a null read is
        // the quiet path (say nothing) rather than a wrong "wallet missing".
        let dropin = null;
        dropin = new Dropin(checkout, {
          paymentMethodComponents: [Card, ApplePay, GooglePay],
          paymentMethodsConfiguration,
          onReady: () => {
            if (!live || !dropin) return;
            // Availability checks are done, so this IS what the guest sees.
            const rendered = (dropin.paymentMethodElements || []).map((el) => el?.type).filter(Boolean);
            setWalletNote(missingWalletNote(offeredWallets.current, rendered) || '');
          },
        });
        dropinRef.current = dropin;
        dropin.mount(holder.current);
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

  // Received / Pending: poll the server for the booking's REAL status for up
  // to two minutes. Primitive deps only, and the latest onPaid is read from a
  // ref, so a parent re-render can never cancel the poll (the v5.7.12 timer
  // trap). Every setState here runs after an await, never synchronously.
  useEffect(() => {
    if (phase !== 'confirming') return undefined;
    let stopped = false;
    let timer = null;
    const started = Date.now();
    const tick = async () => {
      const r = await callWidget({ action: 'booking_status', location_id: opsId, booking_id: bookingId });
      if (stopped) return;
      if (r?.ok && (r.status === 'confirmed' || r.status === 'prepaid')) {
        setPhase('paid');
        onPaidRef.current?.(r.status);
        return;
      }
      if (r?.ok && r.status === 'dining') {
        setPhase('seated');
        return;
      }
      if (r?.ok && ['expired', 'cancelled', 'no_show', 'departed'].includes(r.status)) {
        setPhase('lost');
        return;
      }
      // The bank said no, or the card could not be saved, while we waited.
      if (r?.ok && r.payment?.status === 'failed') {
        setRefusedText(kind === 'hold'
          ? 'We could not save your card. Nothing was taken. Please try another card.'
          : 'The payment did not go through. No money was taken.');
        setPhase('refused');
        return;
      }
      if (Date.now() - started >= CONFIRM_POLL_MAX_MS) {
        setPhase('slow');
        return;
      }
      timer = setTimeout(tick, CONFIRM_POLL_MS);
    };
    timer = setTimeout(tick, CONFIRM_POLL_MS);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [phase, bookingId, opsId, kind]);

  const retry = () => {
    submittedRef.current = false;
    referenceRef.current = null;
    setRefusal('');
    setRefusedText('');
    setPayErr('');
    setPhase('init');
    setAttempt((n) => n + 1);
  };

  const callVenue = venueName || 'the venue';
  // One plain status: a bold line, then one short sentence.
  const statusBox = (title, body) => (
    <div role="status" style={{ marginTop: 10 }}>
      <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--ink)', lineHeight: 1.4 }}>{title}</div>
      {body && <div style={{ fontSize: 14, color: 'var(--muted)', lineHeight: 1.5, marginTop: 4 }}>{body}</div>}
    </div>
  );

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
      ) : phase === 'confirming' ? (
        statusBox(kind === 'hold' ? 'Your card is being checked' : 'Your payment is being confirmed', 'This can take a minute. Please keep this page open.')
      ) : phase === 'slow' ? (
        statusBox(kind === 'hold' ? 'Your card is still being checked' : 'Your payment is still being confirmed', `We will send you a message when your table is booked. If you do not hear from us, please call ${callVenue}.`)
      ) : phase === 'lost' ? (
        statusBox('We could not confirm your booking', `Your table is no longer held. If money was taken, call ${callVenue} to get it back.`)
      ) : phase === 'released' ? (
        statusBox('Your table is no longer held', `This payment was not taken. Please book again, or call ${callVenue}.`)
      ) : phase === 'seated' ? (
        statusBox('You are already seated', 'Please pay at the table. If money was taken online, tell your server.')
      ) : phase === 'taken' ? (
        kind === 'hold'
          ? statusBox('Your card was saved, but this table is no longer free', `Nothing was taken. Please call ${callVenue} to book again.`)
          : statusBox('Your payment went through, but this table is no longer free', `Please call ${callVenue} to get your money back.`)
      ) : phase === 'stuck' ? (
        <>
          {kind === 'hold'
            ? statusBox('Your card was saved, but we could not finish your booking', `Nothing was taken. Please call ${callVenue} to finish your booking.`)
            : statusBox('Your payment went through, but we could not finish your booking', `Please do not pay again. Call ${callVenue} to finish your booking.`)}
          {stuckCode && (
            <details style={{ marginTop: 6, fontSize: 12, color: 'var(--muted)' }}>
              <summary style={{ cursor: 'pointer' }}>Show detail</summary>
              {stuckCode}
            </details>
          )}
        </>
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
                {refusedText || 'Your card was refused. No money was taken.'}
              </div>
              {refusal && (
                <details style={{ marginTop: 4, fontSize: 12, color: 'var(--muted)' }}>
                  <summary style={{ cursor: 'pointer' }}>Show detail</summary>
                  {refusal}
                </details>
              )}
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
          {walletNote && showForm && (
            <div style={{ marginTop: 8, fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>{walletNote}</div>
          )}
          {payErr && showForm && (
            <div style={{ marginTop: 8, fontSize: 12.5, fontWeight: 600, color: '#b91c1c' }}>{payErr}</div>
          )}
          <div style={{ marginTop: 10, fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>
            {required
              ? (HELD_NOTE[kind] || HELD_NOTE.prepay)
              : 'Your table is booked either way. You can also sort payment with the venue.'}
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
function PreorderPage({ token, shell, brand, onBrand, venueName, opsId = null, sheetTheme = null }) {
  const [nonce, setNonce] = useState(0); // bump to retry a failed info load
  const infoKey = `${token}|${nonce}`;
  const [infoRes, setInfoRes] = useState(null); // { key, info, err }
  const loading = !infoRes || infoRes.key !== infoKey;
  const info = (!loading && !infoRes.err && infoRes.info) || null;

  // The guest's EDITS only — an untouched seat/course falls back to the saved
  // row at render time (prefill by render fallback, never effect-time setState).
  const [sel, setSel] = useState({});     // `${seat}|${course}` → the guest's pick object
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
    // The saved size, options and note come back too, so an amend keeps them.
    if (existingSel[k] === undefined && r.name) existingSel[k] = choiceFromRow(r);
    if (existingName[r.seat] === undefined && r.guestName) existingName[r.seat] = r.guestName;
  }
  const effSel = (seat, course) => {
    const k = `${seat}|${course}`;
    return sel[k] !== undefined ? sel[k] : (existingSel[k] || null);
  };
  const effName = (seat) => (names[seat] !== undefined ? names[seat] : (existingName[seat] || ''));

  const party = info?.party || 0;
  const groups = Array.isArray(info?.choiceGroups) ? info.choiceGroups : [];
  const seats = Array.from({ length: party }, (_, i) => i + 1);
  // The booking venue's menu, for sizes and options (10 Sep 2026).
  const optionItemIds = groups.flatMap((g) => (g.options || []).map((o) => o.itemId)).filter(Boolean);
  const guestMenu = useGuestMenu(info?.locationId || opsId, optionItemIds.length > 0, optionItemIds);
  // Complete = every guest holds a CURRENT option per group (a saved choice the
  // venue has since removed from the package no longer counts), configured
  // where the dish needs a size or a required option.
  const complete = party > 0 && groups.length > 0 && groups.every((g) =>
    seats.every((s) => choiceComplete(effSel(s, g.course), g.options, guestMenu)));

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
        const c = effSel(s, g.course);
        if (c) preorders.push(choicePayload(s, effName(s).trim() || undefined, g.course, c));
      }
    }
    const r = await callWidget({ action: 'preorder_submit', token, preorders });
    setSending(false);
    if (r?.ok) { setSaved(true); return; }
    setSendErr('Something went wrong. Please try again, or call the venue.');
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
          give your menu choices. They’ll be happy to help.
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
        <div style={S.sub}>See you then. Just give your name when you arrive.</div>
      </div>
    </Shell>;
  }

  return <Shell {...shell}>
    <div style={S.card}>
      <h1 style={{ ...S.h1, marginBottom: 4 }}>Your menu: {info.packageName}</h1>
      <div style={{ fontFamily: MONO, fontSize: 13.5, fontWeight: 700, color: 'var(--ink)', margin: '10px 0 2px' }}>
        {summaryLine}
      </div>
      <div style={{ ...S.sub, marginBottom: 16 }}>
        Choose one of each for every guest. Choices are due by {fmtDateLong(info.deadline)}.
      </div>

      {groups.length === 0 ? (
        <div style={S.sub}>No menu choices are needed for this booking.</div>
      ) : <>
        <GuestChoiceCards
          party={party} groups={groups} brand={brand} onBrand={onBrand}
          getSel={effSel}
          onPick={(seat, course, choice) => { setSel((m) => ({ ...m, [`${seat}|${course}`]: choice })); setSendErr(''); }}
          getName={effName}
          onName={(seat, v) => setNames((m) => ({ ...m, [seat]: v }))}
          menu={guestMenu} model={info.paymentModel || null} sheetTheme={sheetTheme}
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
  // The online item sheet's theme, built exactly as the storefront builds it
  // (10 Sep 2026, guest pre-order choices).
  const sheetTheme = useMemo(() => sheetThemeFrom(location.online_branding, location.name), [location.online_branding, location.name]);

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

  // "Choose later" skip (v5.7.21): even inside the pre-order window the guest
  // may defer — the fn mints the link and sends it. Keyed on package+date so a
  // switch resets it derivation-style, no effects.
  const [chooseLaterFor, setChooseLaterFor] = useState(null);

  // Everything about menu choices is DERIVED per render against the currently
  // selected offer — no effects, no resets.
  const forced = (forcedPre && selectedPkg && String(forcedPre.pkgId) === String(selectedPkg.id))
    ? forcedPre : null;
  const pkgGroups = (selectedPkg?.choiceGroups?.length ? selectedPkg.choiceGroups : forced?.groups) || [];
  const preDays = Number(selectedPkg?.preorderDaysBefore) || 0;
  // The choose-now fork is SERVER-decided from v5.7.21 (each offer carries
  // preorderChoiceAtBooking + preorderDeadline for this exact date): inside
  // the window the deadline has already passed, so choices are taken at
  // booking; outside it the guest gets a link, due by the deadline. The local
  // daysAhead test is only the deploy-skew fallback, and `forced` overrides
  // both when the fn disagrees.
  const daysAhead = Math.round((Date.parse(date) - Date.parse(cfg?.today || todayISO())) / 86400000);
  const inWindow = selectedPkg?.preorderChoiceAtBooking != null
    ? !!selectedPkg.preorderChoiceAtBooking
    : (!!selectedPkg?.requiresPreorder && daysAhead <= preDays);
  const chooseLater = !!selectedPkg && chooseLaterFor === `${String(selectedPkg.id)}|${date}`;
  const choicesNow = !!selectedPkg && pkgGroups.length > 0 && !chooseLater
    && (forced ? true : (!!selectedPkg.requiresPreorder && inWindow));
  const choicesLater = !!selectedPkg?.requiresPreorder && pkgGroups.length > 0 && !choicesNow;
  const preorderDeadlineISO = selectedPkg?.preorderDeadline || addDaysISO(-preDays, date);
  // A pick is an object since 10 Sep 2026 (sizes and options); null = none.
  const seatSel = (seat, course) =>
    (selectedPkg && preSel[`${String(selectedPkg.id)}|${seat}|${course}`]) || null;
  // The venue menu, loaded once a selected package has dishes to choose from.
  const optionItemIds = pkgGroups.flatMap((g) => (g.options || []).map((o) => o.itemId)).filter(Boolean);
  const guestMenu = useGuestMenu(opsId, optionItemIds.length > 0, optionItemIds);
  const choicesComplete = !choicesNow || pkgGroups.every((g) =>
    Array.from({ length: party }, (_, i) => i + 1)
      .every((s) => choiceComplete(seatSel(s, g.course), g.options, guestMenu)));
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
          if (sel) preorders.push(choicePayload(seat, (preNames[seat] || '').trim() || undefined, g.course, sel));
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
      // In-window skip: the fn accepts the booking without choices and sends
      // the pre-order link itself (v5.7.21 link-first).
      choose_later: chooseLater || undefined,
    });
    setSubmitting(false);
    // status is the REAL row status from v5.7.21: 'pending_payment' means the
    // next screen takes the card; 'prepaid' books a nothing-due prepay package;
    // legacy 'pending' = availability vanished mid-flight.
    if (r?.ok && ['confirmed', 'prepaid', 'pending_payment', 'pending'].includes(r.status)) { setResult(r); return; }
    if (r?.error === 'preorders_required') {
      // Defensive: the fn wants choices the page didn't collect (offer drift).
      // Reveal the section from ITS choiceGroups and walk the guest there.
      setForcedPre({
        pkgId: selectedPkg ? selectedPkg.id : null,
        groups: Array.isArray(r.choiceGroups) ? r.choiceGroups : [],
      });
      setSubmitErr('This menu needs a choice for each guest. Pick them below.');
      wantChoicesScrollRef.current = true;
      return;
    }
    if (r?.error === 'payment_unavailable') {
      // 10 Sep 2026 payment gate: this package needs payment and the venue
      // cannot take it online right now. No booking was made; keep the table flow.
      setSubmitErr(r.message || 'This menu cannot be booked online right now. You can still book the table.');
      setPkgPick({ id: null });
      setSlotsNonce((n) => n + 1);
      return;
    }
    if (r?.error === 'package_unavailable') {
      // The offer vanished between render and book (cap filled / window moved) —
      // drop it, re-quote the day, keep the table flow alive.
      setSubmitErr('That menu just sold out for this date. You can still book the table.');
      setPkgPick({ id: null });
      setSlotsNonce((n) => n + 1);
      return;
    }
    if (r?.error === 'slot_full') {
      // Someone took the slot between quote and write — refresh availability.
      setSubmitErr('That time was just booked out. Please pick another.');
      setTime(null);
      setSlotsNonce((n) => n + 1);
      return;
    }
    setSubmitErr('Something went wrong. Please try again, or call the venue.');
  };

  // Shared chrome props for the top-level Shell.
  const shell = { vars, mt, venueName };

  // Tokened completion flow replaces the whole booking page (checked before
  // the boot states — boot never leaves 'loading' when a token is present).
  if (urlPreorderToken) {
    return <PreorderPage token={urlPreorderToken} shell={shell}
      brand={brand} onBrand={onBrand} venueName={venueName}
      opsId={opsId} sheetTheme={sheetTheme} />;
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
            ? <>Please call {venueName} to book a table. They’ll be happy to help.</>
            : <>Please try again in a moment, or call {venueName} to book.</>}
        </div>
      </div>
    </Shell>;
  }

  // ── pay-before-commit screen (v5.7.21) ──────────────────────────────────────
  // The booking is 'pending_payment': the table is HELD, the money decides.
  // No "booked" language anywhere on this screen. Card refused → the payment
  // card offers a retry; the 20-minute sweep frees the table if payment never
  // lands. On sync success the card's onPaid promotes this page to the real
  // confirmation with the status the fn answered.
  if (result?.status === 'pending_payment') {
    return <Shell {...shell}>
      <div style={{ ...S.card, textAlign: 'center', padding: '34px 22px' }}>
        <div style={{ fontSize: 38, marginBottom: 10 }}>💳</div>
        <div style={S.h1}>
          {result.paymentDue?.kind === 'hold' ? 'Almost there, save a card to hold your table' : 'Almost there, payment secures your table'}
        </div>
        <div style={{
          fontFamily: MONO, fontSize: 15, fontWeight: 700, margin: '12px 0 14px',
          color: 'var(--ink)',
        }}>
          {fmtDateLong(result.date || date)} · {result.time || time} · {result.party || party} {(result.party || party) === 1 ? 'guest' : 'guests'}
        </div>
        {result.package && (
          <div style={{ fontSize: 13.5, color: 'var(--muted)', marginBottom: 12 }}>
            {result.package.name}
          </div>
        )}
        {!isMock && supabase && result.paymentDue && result.bookingId ? (
          <BookingPaymentCard
            paymentDue={result.paymentDue}
            adyen={result.adyen}
            bookingId={result.bookingId}
            opsId={opsId}
            venueName={cfg?.name || venueName}
            required
            // Only the server's own confirmed or prepaid moves this page to
            // "Booked" (10 Sep 2026 payment gate). Nothing else calls onPaid.
            onPaid={(status) => {
              if (status === 'confirmed' || status === 'prepaid') setResult((prev) => ({ ...(prev || {}), status, paid: true }));
            }}
          />
        ) : (
          <div style={S.sub}>We couldn’t start the payment here. Please call {venueName} to finish your booking.</div>
        )}
      </div>
    </Shell>;
  }

  // ── confirmed / pending screens ─────────────────────────────────────────────
  // 'prepaid' is the row status of a paid (or nothing-due) prepay-package
  // booking — the same confirmation screen.
  if (result?.status === 'confirmed' || result?.status === 'prepaid') {
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
        <div style={S.h1}>Booked at {cfg?.name || venueName}</div>
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
            {/* v5.7.21: the token now comes back for EVERY pre-order booking
                (the link lets guests amend), so key this off preordersTaken. */}
            {result.preordersTaken && (
              <div style={{ fontSize: 12.5, fontWeight: 700, color: '#15803d', marginTop: 8 }}>
                Menu choices received ✓
              </div>
            )}
            {result.paid && result.paymentDue && (
              <div style={{ fontSize: 12.5, fontWeight: 700, color: '#15803d', marginTop: 4 }}>
                {PAID_LINE[result.paymentDue.kind]
                  ? PAID_LINE[result.paymentDue.kind](fmtGBP((Number(result.paymentDue.amountMinor) || 0) / 100))
                  : 'Payment received'} ✓
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
        {/* Card capture — legacy deploy-skew path only: a NEW fn books money-due
            bookings as pending_payment (handled above), so this renders solely
            when an OLD fn confirmed first and still wants the card. Skipped
            once this page already took the payment (result.paid). */}
        {!isMock && supabase && result.paymentDue && result.bookingId && !result.paid && (
          <BookingPaymentCard
            paymentDue={result.paymentDue}
            adyen={result.adyen}
            bookingId={result.bookingId}
            opsId={opsId}
            venueName={cfg?.name || venueName}
          />
        )}
        {result.preorderToken && !result.preordersTaken && (
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
                ? <>, choices due by <b style={{ color: 'var(--ink)' }}>{fmtDateLong(result.preorderDeadline)}</b>.</>
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
          We’ve saved your details. Just give your name when you arrive.
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
      <div style={{ ...S.sub, marginBottom: 20 }}>Pick a time at {venueName}. It takes under a minute.</div>

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
          No online times for this date. Try another day, or call {venueName}.
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
              {/* v5.7.21 fork copy: same-day / short-notice bookings are inside
                  the pre-order window — the deadline has already passed, so the
                  kitchen needs the choices now (or the guest defers by link). */}
              <div style={{
                marginBottom: 10, padding: '9px 12px', borderRadius: 10, fontSize: 12.5,
                lineHeight: 1.5, color: 'var(--ink)', background: 'var(--bg)',
                border: '1px dashed var(--line)',
              }}>
                Your date is inside the pre-order window, so the kitchen needs everyone’s choices now.
              </div>
              <GuestChoiceCards
                party={party} groups={pkgGroups} brand={brand} onBrand={onBrand}
                getSel={seatSel}
                onPick={(seat, course, choice) => {
                  setPreSel((m) => ({ ...m, [`${String(selectedPkg.id)}|${seat}|${course}`]: choice }));
                  setSubmitErr('');
                }}
                getName={(seat) => preNames[seat] || ''}
                onName={(seat, v) => setPreNames((m) => ({ ...m, [seat]: v }))}
                menu={guestMenu} model={selectedPkg.paymentModel || null} sheetTheme={sheetTheme}
              />
              {/* Choose-later skip: mints the link server-side and sends it. */}
              <button type="button"
                onClick={() => { setChooseLaterFor(`${String(selectedPkg.id)}|${date}`); setSubmitErr(''); }}
                style={{
                  marginTop: 10, width: '100%', padding: '10px 12px', borderRadius: 10,
                  border: '1px dashed var(--line)', background: 'transparent', cursor: 'pointer',
                  fontFamily: 'inherit', fontSize: 13, fontWeight: 700, color: 'var(--muted)',
                }}>
                Choose later, email and text me a link instead
              </button>
            </div>
          )}
          {choicesLater && (
            <div style={{
              marginTop: 10, padding: '9px 12px', borderRadius: 10, fontSize: 12.5,
              lineHeight: 1.5, color: 'var(--muted)', background: 'var(--bg)',
              border: '1px dashed var(--line)',
            }}>
              {chooseLater ? (
                <>
                  Choosing later ✓. We will email and text you a link straight away
                  {inWindow
                    ? <>, please pick as soon as you can so the kitchen can prepare.</>
                    : <>, choices due by <b style={{ color: 'var(--ink)' }}>{fmtDateLong(preorderDeadlineISO)}</b>.</>}{' '}
                  <button type="button" style={{ ...S.linkBtn, fontSize: 12.5 }}
                    onClick={() => setChooseLaterFor(null)}>
                    Choose now instead
                  </button>
                </>
              ) : (
                <>
                  We will email and text you a link to choose everyone’s menu,
                  choices due by <b style={{ color: 'var(--ink)' }}>{fmtDateLong(preorderDeadlineISO)}</b>.
                </>
              )}
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
