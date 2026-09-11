// supabase/functions/booking-widget/index.ts
//
// The PUBLIC booking widget's only door (Phase 5 of the bookings handoff).
// The guest page never touches the booking tables: this fn (service_role)
// validates, quotes availability with the SAME optimiser the host stand uses
// (parity-tested copy in _shared/bookingOptimiser.js), and books through the
// create_booking RPC — so the widget can never double-book, and the PACING CAP
// IS ABSOLUTE here (host stands can override with a manager PIN; the widget
// cannot, by design — Peter, 11 Aug).
//
// Actions:
//   config → is the widget on, service window, covers bounds
//   slots  → per-slot availability for a date+party (full = pacing OR no table)
//   book   → create the guest (unified org-scoped CRM, only-fill-blank),
//            book the best candidate; audit row in booking_requests either way
//   booking_pay         → take the card for a pending_payment booking
//   booking_pay_details → finish a 3DS challenge on the SAME payment row
//   booking_status      → the booking's status, polled while a payment confirms
//
// THE PAYMENT GATE (10 Sep 2026, Peter: "payment must be paid before booking
// confirms on the system"). Only this server confirms a booking that needs
// payment, and only after Adyen authorises the full amount due:
//   - a package that needs payment is not offered or booked unless card
//     capture is on and the venue's Adyen config is usable; a Deposit at 0 or
//     a Prepay at 0 is never offered
//   - book writes 'confirmed' (nothing due) or 'pending_payment' (anything
//     due), never 'prepaid', and stores what was due on the booking
//   - Authorised is the only success; the promote runs through
//     _shared/bookingPromote.ts (shared with adyen-webhook)
//
// Payments (v5.7.21, pay-before-commit): when card capture is on and the
// booking owes money (prepay/deposit/hold), book INSERTS with status
// 'pending_payment' — never 'prepaid'/'confirmed' before money. booking_pay
// promotes it on synchronous success (prepay → 'prepaid', deposit/hold →
// 'confirmed'); the adyen-webhook bkpay capture is the async backstop. A
// SQL-only pg_cron job expires unpaid pending_payment bookings after 20
// minutes (migration 20260824). Bookings with nothing due keep the old
// statuses exactly.
//
// Pre-order links (v5.7.21, link-first): the preorder_token is minted at
// create for EVERY requires_preorder booking — even when choices are taken
// at booking, so the link can amend them later. Deferred choices trigger the
// booking-reminders 'send_link' action (fire-and-forget, ledger-audited).

import { createClient } from 'npm:@supabase/supabase-js@2';
import {
  suggestTables, paceAt, turnFor, toMin, sessionsToBlocks,
  DEFAULT_TURN_BANDS, DEFAULT_RULES,
} from '../_shared/bookingOptimiser.js';
import {
  adyenConfig, adyenAccountForLocation, platformLocationIdFor, checkoutBase, adyenFetch,
  adyenNotConfiguredMessage, paymentIdempotencyKey, effectiveMerchantAccount, type AdyenConfig,
} from '../_shared/adyen.ts';
// THE PAYMENT GATE (10 Sep 2026, Peter: "payment must be paid before booking
// confirms on the system"). The rules are pure and shared with adyen-webhook
// and the web app; the promote is the one server door to confirmed/prepaid.
import {
  paymentDue as computePaymentDue, packagePaymentNeed, packageSellableOnline, statusAtBooking,
  amountCovers, paymentSatisfiesDue, stuckPaymentReason,
} from '../_shared/bookingPayment.js';
import { promotePaidBooking, markPaymentNeedsRefund, isMissingColumnError, loadBookingDue } from '../_shared/bookingPromote.ts';
// GUEST PRE ORDER CHOICES (10 Sep 2026): sizes and options on a pick are
// validated here against the dish's real groups, never trusted from the page.
import { sanitiseChoice, optionGroupIdsFor, matchChoice, MAX_CHOICE_NOTE } from '../_shared/preorderChoices.js';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
// The venue's Adyen environment lives on the PLATFORM DB (merchant_adyen_accounts).
const platformAdmin = createClient(
  Deno.env.get('PLATFORM_SUPABASE_URL') ?? '',
  Deno.env.get('PLATFORM_SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { autoRefreshToken: false, persistSession: false } },
);

// ── Adyen (bookings card capture — Phase 5) ──────────────────────────────────
// Same ADVANCED flow as the proven adyen-checkout fn: the card encrypts in the
// guest's browser, WE make the payment server-side.
// PER VENUE ENVIRONMENT (7 Sep 2026): the widget carries the OPS location id;
// map it to the platform id, read the venue's environment, and pick that
// secret set (key, client key, merchant account, Checkout host). A live venue
// without live keys fails closed.
// PER VENUE REGION (8 Sep 2026): the venue's region ('UK' | 'US') picks the
// live secret set and the Checkout host; the guest page gets
// { clientKey, environment, region, dropinEnvironment, currency } so the
// Drop-in mounts against the right data centre ('live' for UK, 'live-us' for
// US) and the payment is made in the venue's currency (GBP or USD).
//
// ONLY the ops -> platform id mapping is cached (it never changes). The
// environment and the merchant account are read on EVERY call, so a Back
// Office flip between test and live applies to the next guest immediately. A
// venue the platform DB does not know is a 404 (thrown, caught by the
// handler), never the ADYEN_ENV fallback; a DB error throws as well.
const DEFAULT_RETURN_URL = 'https://app.serv-os.app/';
const platformIdCache = new Map<string, string>();
class VenueNotFound extends Error { status = 404; constructor() { super('location not found'); } }
// The venue's charging currency (8 Sep 2026): platform locations.currency
// (GBP or USD), else by region. booking_pay used to charge GBP on every
// venue, which posted a GBP payment to a US venue's US merchant account.
const venueCurrency = (value: unknown, region: string): string => {
  const c = String(value ?? '').trim().toUpperCase();
  return /^[A-Z]{3}$/.test(c) ? c : (region === 'US' ? 'USD' : 'GBP');
};
async function adyenCfgForOps(opsLocationId: string): Promise<{ cfg: AdyenConfig; merchantAccount: string; store: string | null; platformId: string; currency: string }> {
  let platformId = platformIdCache.get(opsLocationId) ?? null;
  if (!platformId) {
    platformId = await platformLocationIdFor(platformAdmin, opsLocationId);   // throws on a DB error: never guess
    if (platformId) platformIdCache.set(opsLocationId, platformId);
  }
  if (!platformId) throw new VenueNotFound();
  const [{ env, region, row }, ploc] = await Promise.all([
    adyenAccountForLocation<{ merchant_account?: string | null; store_id?: string | null; receive_payments_ok?: boolean | null }>(
      platformAdmin, platformId, ['merchant_account', 'store_id', 'receive_payments_ok']),
    platformAdmin.from('locations').select('currency').eq('id', platformId).maybeSingle(),
  ]);
  if (ploc?.error) throw new Error(`currency lookup failed: ${ploc.error.message ?? String(ploc.error)}`);
  const cfg = adyenConfig(env, region);   // the venue's environment AND region set (8 Sep 2026)
  // THE STORE TRAVELS WITH THE MERCHANT ACCOUNT (8 Sep 2026). On the Balance
  // Platform card routing hangs off the store, not the merchant account, and
  // adyen-checkout has sent it on every /payments and /paymentMethods since
  // 26 Aug. booking_pay never did, so the browser was told which wallets and
  // which gatewayMerchantId apply under the store's acquirer routing (the
  // wallet lookup goes through adyen-checkout `payment_methods`, which DOES
  // send the store) and the authorisation was then made storeless. Same guard
  // as adyen-checkout's resolveVenue: only a store the venue can receive
  // payments on.
  const store = row?.receive_payments_ok && row?.store_id ? String(row.store_id) : null;
  // Never the OTHER environment's merchant name on this host (8 Sep 2026).
  return { cfg, merchantAccount: effectiveMerchantAccount(cfg, row?.merchant_account), store, platformId, currency: venueCurrency(ploc?.data?.currency, cfg.region) };
}
// Is this config usable for taking a card in the widget? The Drop-in needs
// the client key, the payment needs a merchant account, and live needs the
// live key and prefix. Checked BEFORE a pending_payment booking is created.
const adyenUsable = (v: { cfg: AdyenConfig; merchantAccount: string }): boolean =>
  v.cfg.configured && !!v.cfg.clientKey && !!v.merchantAccount;

// Slots only: can this venue take a card right now? A lookup failure reads as
// NO, so a payment package is simply not offered (the page never breaks).
async function venueAdyenUsable(opsLocationId: string): Promise<boolean> {
  try {
    return adyenUsable(await adyenCfgForOps(opsLocationId));
  } catch (e) {
    console.warn('[booking-widget] Adyen lookup failed, payment packages hidden:', (e as Error).message);
    return false;
  }
}

// What a booking owes (pure rules in _shared/bookingPayment.js). prepay and
// deposit come from the package; a hold saves the card and takes NOTHING
// (no no-show charge exists yet), only with card capture on and from the
// venue's covers threshold up (Peter, 13 Aug). The label rides the response.
const DUE_LABEL: Record<string, string> = {
  prepay: 'Paid now, comes off the bill',
  deposit: 'Deposit, comes off the bill',
  hold: 'Card saved, nothing taken today',
};
function paymentDueFor(covers: unknown, pkg: Record<string, unknown> | null, rules: Record<string, unknown>) {
  const due = computePaymentDue({ covers, pkg, rules });
  return due ? { ...due, label: DUE_LABEL[due.kind] || '' } : null;
}

// Plain words for a package that needs payment but cannot take it right now.
const PAYMENT_UNAVAILABLE_MESSAGE = 'This menu cannot be booked online right now. You can still book the table.';

// /payments/details gets its OWN idempotency key, derived from the booking's
// merchant reference and the exact details sent: a retransmit replays Adyen's
// answer, a different challenge result is a fresh request.
async function detailsIdempotencyKey(reference: string, details: unknown): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${reference}|${JSON.stringify(details ?? null)}`));
  const hex = Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
  return `bkdet:${hex.slice(0, 56)}`;
}

// Apple Pay runs its own authentication; everything else asks for native 3DS2
// so the challenge runs inside the Drop-in (same list as adyen-checkout).
const NO_NATIVE_3DS_TYPES = ['applepay'];

const normPhone = (raw: string) => {
  const d = String(raw || '').replace(/[^\d+]/g, '');
  if (d.startsWith('+')) return d;
  if (d.startsWith('07') && d.length === 11) return '+44' + d.slice(1);
  if (d.startsWith('44')) return '+' + d;
  return d.length >= 7 ? d : null;
};

// "Today" is the VENUE's today, never the server's. The fn runs in UTC; a UK
// guest booking at 11pm BST was getting date_out_of_range because UTC had
// already rolled to tomorrow (caught in live verification, 11 Aug).
const venueToday = (tz: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const venueNowMin = (tz: string) => {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
  const [h, m] = parts.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};
// v5.7.23 - epoch ms → minute-of-day on the VENUE clock, passed into
// sessionsToBlocks (the fn runs in UTC; a session's seatedAt read with
// getHours() here would be the UTC minute, an hour out all UK summer).
const epochToVenueMin = (tz: string) => (epochMs: number) => {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(epochMs));
  const [h, m] = parts.split(':').map(Number);
  return ((h === 24 ? 0 : h) || 0) * 60 + (m || 0);
};

function rulesFrom(r: Record<string, unknown> | null) {
  if (!r) return null;
  return {
    turnBands: { '1-2': r.turn_1_2, '3-4': r.turn_3_4, '5-6': r.turn_5_6, '7+': r.turn_7_plus } as Record<string, number>,
    maxJoin: r.max_join as number,
    tolerance: r.waste_tolerance as number,
    pacingCap: (r.pacing_cap as number) ?? DEFAULT_RULES.pacingCap,
    protectLargeTables: r.protect_large_tables !== false,
    serviceStart: String(r.service_start || '17:00').slice(0, 5),
    serviceEnd: String(r.service_end || '23:00').slice(0, 5),
    slotMinutes: (r.slot_minutes as number) || 15,
    joinGroups: Array.isArray(r.join_groups) ? r.join_groups : [],
    widgetEnabled: r.widget_enabled !== false,
    maxDaysAhead: (r.widget_max_days_ahead as number) ?? 90,
    cardCaptureEnabled: !!r.card_capture_enabled,
    cardCaptureMinCovers: (r.card_capture_min_covers as number) ?? 0,
    holdPerCover: Number(r.hold_per_cover) || 0,
    bookingTerms: String(r.booking_terms || ''),
    blockedDates: Array.isArray(r.blocked_dates) ? (r.blocked_dates as string[]) : [],
    noOnlineTables: Array.isArray(r.no_online_tables) ? (r.no_online_tables as string[]) : [],
  };
}

// Load everything a quote needs, once per request.
async function loadVenue(locationId: string) {
  // The rules read is checked (10 Sep 2026): a failed read used to look like
  // "no rules", which the book path read as "nothing due".
  const [{ data: loc }, { data: rulesRow, error: rulesError }, { data: floor }, { data: pkgs }, { data: choiceLines }] = await Promise.all([
    db.from('locations').select('id, org_id, name, timezone').eq('id', locationId).maybeSingle(),
    db.from('booking_rules').select('*').eq('location_id', locationId).maybeSingle(),
    db.from('floor_tables').select('id, label, max_covers, section').eq('location_id', locationId),
    db.from('packages').select('*').eq('location_id', locationId).eq('is_active', true).order('sort_order'),
    db.from('package_lines').select('id, package_id, item_id, display_name, course, qty_per_cover, is_preorder_choice, sort_order, price_override')
      .eq('location_id', locationId).order('sort_order'),
  ]);
  if (!loc) return null;
  return {
    loc,
    rulesError: rulesError ? String(rulesError.message || rulesError) : null,
    rules: rulesFrom(rulesRow),
    tables: (floor || []).map((t) => ({ id: t.id, label: t.label || t.id, covers: t.max_covers || 2, section: t.section || null })),
    packages: pkgs || [],
    choiceLines: choiceLines || [],
  };
}

// Guests pick ONE per course group (Peter, 12 Aug: "choose one of these per
// person — starters, mains and desserts"). Groups derive from the package's
// pre-order-choice lines' course ints — the same ints the KDS fires by.
const COURSE_LABEL: Record<number, string> = { 0: 'On arrival', 1: 'Starter', 2: 'Main', 3: 'Dessert' };
function choiceGroupsFor(packageId: string, choiceLines: Record<string, unknown>[]) {
  const mine = choiceLines.filter((l) => String(l.package_id) === String(packageId) && l.is_preorder_choice);
  const byCourse = new Map<number, Record<string, unknown>[]>();
  for (const l of mine) {
    const c = Number(l.course) || 0;
    byCourse.set(c, [...(byCourse.get(c) || []), l]);
  }
  return [...byCourse.entries()].sort((a, b) => a[0] - b[0]).map(([course, lines]) => ({
    course,
    label: COURSE_LABEL[course] || `Course ${course}`,
    // priceOverride (10 Sep 2026): the page prices a size or an option
    // relative to this line, with the same package rule the till uses.
    options: lines.map((l) => ({
      lineId: l.id, itemId: l.item_id || null, name: l.display_name,
      priceOverride: l.price_override == null ? null : Number(l.price_override),
    })),
  }));
}

// ── guest pre-order choices (10 Sep 2026) ─────────────────────────────────
// One matcher for both writers (book and preorder_submit): matchChoice in
// _shared/preorderChoices.js (tested). Course plus name, then name, then item.

// The size and options for each pick, checked against the venue's menu: only
// a live size of the dish, only options on the dish's modifier groups (sub
// groups included) or its instruction groups (config_pushes snapshot), prices
// restamped from the database, list capped. Any read failure keeps the pick
// with no options (the till's Options badge still asks), never a guess.
const blankChoice = () => ({ mods: [] as unknown[], variant_item_id: null as string | null, variant_name: null as string | null });
async function choiceFieldsFor(locationId: string, picks: { itemId: unknown; variantItemId: unknown; mods: unknown }[]) {
  const wants = picks.some((p) => (Array.isArray(p.mods) && p.mods.length > 0) || !!p.variantItemId);
  if (!wants) return picks.map(blankChoice);
  try {
    const [itemsRes, snapRes] = await Promise.all([
      db.from('menu_items').select('*').eq('location_id', locationId),
      db.from('config_pushes').select('snapshot->instructionGroupDefs')
        .eq('location_id', locationId).order('created_at', { ascending: false }).limit(1).maybeSingle(),
    ]);
    if (itemsRes.error) {
      console.error('[booking-widget] menu read for pre-order choices failed:', itemsRes.error.message);
      return picks.map(blankChoice);
    }
    // deno-lint-ignore no-explicit-any
    const rows = (itemsRes.data || []) as any[];
    if (snapRes.error) console.warn('[booking-widget] instruction groups read failed, instructions dropped:', snapRes.error.message);
    // deno-lint-ignore no-explicit-any
    const defsRaw = (snapRes.data as any)?.instructionGroupDefs;
    const instDefs = Array.isArray(defsRaw) ? defsRaw : [];
    const want = new Set<string>();
    for (const p of picks) {
      const line = rows.find((r) => String(r.id) === String(p.itemId));
      if (!line) continue;
      const size = p.variantItemId ? rows.find((r) => String(r.id) === String(p.variantItemId) && String(r.parent_id) === String(line.id)) : null;
      for (const id of optionGroupIdsFor(size || line, rows).mod) want.add(id);
    }
    // deno-lint-ignore no-explicit-any
    const groups = new Map<string, any>();
    let queue = [...want];
    for (let depth = 0; queue.length && depth < 6; depth++) {
      const { data, error } = await db.from('modifier_groups').select('id, name, min, max, selection_type, options').in('id', queue);
      if (error) { console.error('[booking-widget] modifier groups read failed, options dropped:', error.message); break; }
      const next = new Set<string>();
      for (const g of data || []) {
        groups.set(String(g.id), g);
        for (const o of Array.isArray(g.options) ? g.options : []) {
          if (o?.subGroupId) next.add(String(o.subGroupId));
        }
      }
      queue = [...next].filter((id) => !groups.has(id));
    }
    return picks.map((p) => {
      const c = sanitiseChoice({ lineItemId: p.itemId, variantItemId: p.variantItemId, mods: p.mods, rows, groups: [...groups.values()], instDefs });
      return { mods: c.mods as unknown[], variant_item_id: c.variantItemId as string | null, variant_name: c.variantName as string | null };
    });
  } catch (e) {
    console.error('[booking-widget] pre-order choices check failed, options dropped:', (e as Error).message);
    return picks.map(blankChoice);
  }
}

// Insert pre-order rows; before migration 20260910 Part B the three choice
// columns do not exist, so retry without them (the pick itself still lands).
// deno-lint-ignore no-explicit-any
async function insertPreorders(rows: Record<string, any>[]) {
  if (!rows.length) return null;
  const { error } = await db.from('booking_preorders').insert(rows);
  if (!error || !isMissingColumnError(error)) return error;
  const bare = rows.map((r) => {
    const { mods: _m, variant_item_id: _v, variant_name: _n, ...rest } = r;
    return rest;
  });
  const { error: e2 } = await db.from('booking_preorders').insert(bare);
  return e2;
}

// A booking's saved picks, with the choice columns when they exist.
async function loadPreorderRows(bookingId: string) {
  const BASE = 'seat, guest_name, item_id, display_name, course, notes';
  let res = await db.from('booking_preorders').select(`${BASE}, mods, variant_item_id, variant_name`).eq('booking_id', bookingId).order('seat');
  if (res.error && isMissingColumnError(res.error)) {
    // deno-lint-ignore no-explicit-any
    res = await db.from('booking_preorders').select(BASE).eq('booking_id', bookingId).order('seat') as any;
  }
  return res;
}

// A package a GUEST may attach: active, inside its date/day window, party within
// its covers bounds, and under its per-service cap for the chosen date.
function packageOffer(p: Record<string, unknown>, date: string, party: number, bookedCount: number) {
  const day = new Date(`${date}T12:00:00`).getDay();
  if (p.available_from && date < String(p.available_from)) return null;
  if (p.available_to && date > String(p.available_to)) return null;
  const days = Array.isArray(p.available_days) ? p.available_days : [];
  if (days.length && !days.includes(day)) return null;
  if (party < ((p.min_covers as number) || 1)) return null;
  if (p.max_covers && party > (p.max_covers as number)) return null;
  if (p.max_per_service && bookedCount >= (p.max_per_service as number)) return null;
  const perCover = String(p.price_unit || '').includes('cover');
  return {
    id: p.id,
    name: p.name,
    description: p.description || '',
    price: Number(p.price) || 0,
    priceUnit: p.price_unit,
    paymentModel: p.payment_model,
    total: perCover ? (Number(p.price) || 0) * party : (Number(p.price) || 0),
    turnMinutes: p.turn_minutes || null,
    requiresPreorder: !!p.requires_preorder,
    preorderDaysBefore: Number(p.preorder_days_before) || 0,
  };
}

async function loadDayBookings(locationId: string, date: string) {
  const { data: rows } = await db.from('bookings')
    .select('id, start_time, turn_minutes, covers, status, primary_table_id')
    .eq('location_id', locationId).eq('booking_date', date);
  const ids = (rows || []).map((b) => b.id);
  const members = new Map<string, string[]>();
  if (ids.length) {
    const { data: bt } = await db.from('booking_tables').select('booking_id, table_id').in('booking_id', ids);
    for (const r of bt || []) {
      const arr = members.get(r.booking_id) || [];
      arr.push(r.table_id);
      members.set(r.booking_id, arr);
    }
  }
  return (rows || []).map((b) => ({
    id: b.id,
    tables: members.get(b.id) || [b.primary_table_id],
    startMin: toMin(String(b.start_time).slice(0, 5)),
    turnMinutes: b.turn_minutes,
    covers: b.covers,
    status: b.status,
  }));
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const body = await req.json().catch(() => ({}));
    const action = body.action || 'config';

    // ── guest pre-order completion (tokened — the token IS the credential) ──
    if (action === 'preorder_info' || action === 'preorder_submit') {
      const token = String(body.token || '');
      if (token.length < 32) return json({ ok: false, error: 'bad token' }, 400);
      const { data: bk } = await db.from('bookings')
        .select('id, location_id, booking_date, start_time, covers, status, package_id, customer')
        .eq('preorder_token', token).maybeSingle();
      if (!bk || ['cancelled', 'no_show', 'departed', 'expired'].includes(bk.status)) {
        return json({ ok: false, error: 'unknown_or_closed' }, 404);
      }
      const [{ data: loc2 }, { data: pkg2 }, { data: lines2 }, { data: existing }] = await Promise.all([
        db.from('locations').select('name, timezone').eq('id', bk.location_id).maybeSingle(),
        db.from('packages').select('*').eq('id', bk.package_id).maybeSingle(),
        db.from('package_lines').select('id, package_id, item_id, display_name, course, sort_order, is_preorder_choice, price_override')
          .eq('package_id', bk.package_id).eq('is_preorder_choice', true).order('sort_order'),
        loadPreorderRows(String(bk.id)),
      ]);
      const groups2 = choiceGroupsFor(String(bk.package_id), (lines2 || []) as Record<string, unknown>[]);
      const dl = new Date(`${bk.booking_date}T12:00:00`);
      dl.setDate(dl.getDate() - (Number(pkg2?.preorder_days_before) || 0));
      const summary = {
        ok: true,
        venue: loc2?.name || 'the venue',
        date: bk.booking_date,
        time: String(bk.start_time).slice(0, 5),
        party: bk.covers,
        guestName: (bk.customer as Record<string, unknown>)?.name || null,
        packageName: pkg2?.name || 'your menu',
        // 10 Sep 2026: the page prices sizes and options with the package rule,
        // and loads the menu of the booking's own venue.
        paymentModel: pkg2?.payment_model || null,
        locationId: bk.location_id,
        deadline: dl.toISOString().slice(0, 10),
        choiceGroups: groups2,
        // The size, options and note ride back so the link page prefills them
        // and an amend (wholesale replace below) never wipes them.
        // deno-lint-ignore no-explicit-any
        preorders: ((existing || []) as any[]).map((r) => ({
          seat: r.seat, guestName: r.guest_name, itemId: r.item_id, name: r.display_name, course: r.course,
          notes: r.notes || '',
          mods: Array.isArray(r.mods) ? r.mods : [],
          variantItemId: r.variant_item_id || null,
          variantName: r.variant_name || null,
        })),
      };
      if (action === 'preorder_info') return json(summary);

      // preorder_submit — replace wholesale with validated rows.
      const submitted2 = Array.isArray(body.preorders) ? body.preorders : [];
      // deno-lint-ignore no-explicit-any
      const pairs2: { raw: any; row: Record<string, unknown> }[] = [];
      for (const r of submitted2) {
        const hit = matchChoice(groups2, r);
        if (!hit) continue;
        pairs2.push({
          raw: r,
          row: {
            location_id: bk.location_id,
            booking_id: bk.id,
            seat: Math.max(1, Math.min(bk.covers, Math.round(Number(r.seat) || 0) || 1)),
            guest_name: String(r.guestName || '').slice(0, 60) || null,
            item_id: hit.opt.itemId || null,
            display_name: hit.opt.name || 'Choice',
            course: hit.g.course ?? 0,
            notes: String(r.notes || '').slice(0, MAX_CHOICE_NOTE),
          },
        });
      }
      const kept2 = pairs2.slice(0, bk.covers * Math.max(1, groups2.length));
      if (!kept2.length) return json({ ok: false, error: 'no valid choices' }, 400);
      // Checked BEFORE the delete, so the replace window stays short.
      const extras2 = await choiceFieldsFor(String(bk.location_id), kept2.map((p) => ({
        itemId: p.row.item_id, variantItemId: p.raw?.variantItemId, mods: p.raw?.mods,
      })));
      const rows2 = kept2.map((p, i) => ({ ...p.row, ...extras2[i] }));
      await db.from('booking_preorders').delete().eq('booking_id', bk.id);
      const insErr = await insertPreorders(rows2);
      if (insErr) return json({ ok: false, error: insErr.message }, 500);
      return json({ ok: true, saved: rows2.length });
    }

    const locationId = String(body.location_id || '');
    if (!locationId || locationId === 'loc-demo') return json({ error: 'location required' }, 400);

    const venue = await loadVenue(locationId);
    if (!venue) return json({ error: 'unknown venue' }, 404);
    // FAIL CLOSED (10 Sep 2026): a rules read that ERRORED is not "no rules".
    // No slot, no booking, no payment runs on rules we could not read.
    if (venue.rulesError) {
      console.error('[booking-widget] booking_rules read failed:', venue.rulesError);
      return json({ ok: false, error: 'rules_unavailable' }, 503);
    }
    const rules = venue.rules;
    if (!rules) return json({ ok: true, widgetEnabled: false, reason: 'not configured' });

    if (action === 'config') {
      const cfgTz = (venue.loc as { timezone?: string }).timezone || 'Europe/London';
      return json({
        ok: true,
        name: venue.loc.name,
        // The VENUE's today — the page must anchor its date picker here, never
        // on the browser's local date (a guest in another timezone would offer
        // a date the venue has already finished).
        today: venueToday(cfgTz),
        timezone: cfgTz,
        widgetEnabled: rules.widgetEnabled,
        serviceStart: rules.serviceStart,
        serviceEnd: rules.serviceEnd,
        slotMinutes: rules.slotMinutes,
        maxDaysAhead: rules.maxDaysAhead,
        maxCovers: 12,
        cardCaptureEnabled: (rules as Record<string, unknown>).cardCaptureEnabled === true,
        cardCaptureMinCovers: (rules as Record<string, unknown>).cardCaptureMinCovers ?? 0,
        bookingTerms: (rules as Record<string, unknown>).bookingTerms || '',
        blockedDates: (rules as Record<string, unknown>).blockedDates || [],
      });
    }

    if (!rules.widgetEnabled) return json({ ok: false, error: 'widget_disabled' }, 403);

    const tz = (venue.loc as { timezone?: string }).timezone || 'Europe/London';
    const today = venueToday(tz);
    const date = String(body.date || today);
    const party = Math.max(1, Math.min(12, Math.round(Number(body.party) || 2)));
    const daysAhead = Math.round((Date.parse(date) - Date.parse(today)) / 86400000);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || daysAhead < 0 || daysAhead > rules.maxDaysAhead) {
      return json({ ok: false, error: 'date_out_of_range' }, 400);
    }

    // Tables the widget must never offer (host stand unaffected). Filtered
    // BEFORE the optimiser so joins can only form from online-bookable tables.
    const noOnline = new Set(((rules as Record<string, unknown>).noOnlineTables as string[]) || []);
    if (noOnline.size) venue.tables = venue.tables.filter((t: { id: string }) => !noOnline.has(String(t.id)));

    // Blackout dates: the online door is CLOSED for these days, full stop.
    const blockedSet = new Set(((rules as Record<string, unknown>).blockedDates as string[]) || []);
    const dateBlocked = blockedSet.has(date);
    if (dateBlocked && action === 'book') {
      await db.from('booking_requests').insert({
        location_id: locationId,
        payload: { date, time: String(body.time || ''), party, reason: 'date_blocked' },
        status: 'rejected',
      });
      return json({ ok: false, error: 'date_blocked' });
    }

    const bookings = await loadDayBookings(locationId, date);
    // TODAY only: a live POS tab (walk-in opened straight on the till) blocks
    // its table exactly like a dining booking — the widget must never sell a
    // slot the venue physically cannot seat. Same sessionsToBlocks the host
    // stand uses (parity copy), fed from active_sessions.
    if (date === today) {
      try {
        const { data: sess } = await db.from('active_sessions')
          .select('table_id, session').eq('location_id', locationId);
        const sessTables = (sess || []).filter((r) => r.table_id).map((r) => ({
          id: r.table_id,
          session: {
            seatedAt: (r.session as Record<string, unknown>)?.seatedAt,
            covers: (r.session as Record<string, unknown>)?.covers,
          },
        }));
        bookings.push(...sessionsToBlocks(sessTables, bookings, rules.turnBands, venueNowMin(tz), epochToVenueMin(tz)));
      } catch { /* availability falls back to bookings-only — never blocks the door */ }
    }
    const quote = (time: string) => suggestTables({
      party, time, tables: venue.tables, bookings,
      joinGroups: rules.joinGroups, turnBands: rules.turnBands, rules, limit: 3,
    });
    const slotFull = (time: string) =>
      paceAt(toMin(time), bookings) >= rules.pacingCap || quote(time).length === 0;

    if (action === 'slots' && dateBlocked) {
      return json({ ok: true, date, blocked: true, slots: [], packages: [] });
    }
    if (action === 'slots') {
      const start = toMin(rules.serviceStart), end = toMin(rules.serviceEnd);
      const nowGuard = date === today ? venueNowMin(tz) : -1;
      const slots: { time: string; full: boolean }[] = [];
      for (let t = start; t < end; t += rules.slotMinutes) {
        const hh = String(Math.floor(t / 60)).padStart(2, '0'), mm = String(t % 60).padStart(2, '0');
        const time = `${hh}:${mm}`;
        slots.push({ time, full: t <= nowGuard || slotFull(time) });
      }
      // Packages a guest could add for this date+party (the widget's upsell
      // card + the /book?package= deep link). Caps count that date's bookings.
      const { data: pkgCounts } = await db.from('bookings')
        .select('package_id')
        .eq('location_id', locationId).eq('booking_date', date)
        .not('package_id', 'is', null).not('status', 'in', '(cancelled,no_show,expired)');
      const counts = new Map<string, number>();
      for (const r of pkgCounts || []) counts.set(r.package_id, (counts.get(r.package_id) || 0) + 1);
      // THE PAYMENT GATE (10 Sep 2026): a package that needs payment is only
      // offered when the venue can actually take it (card capture on AND a
      // usable Adyen config). A Deposit at 0 or a Prepay at 0 is never offered.
      // The Adyen lookup only runs when there is something to pay for.
      const captureOn = rules.cardCaptureEnabled === true;
      const anyPaid = captureOn && venue.packages.some((p) => packagePaymentNeed(p).needsPayment);
      const canTakeCard = anyPaid ? await venueAdyenUsable(locationId) : false;
      const offers = venue.packages
        .filter((p) => packageSellableOnline(p, { captureOn, adyenUsable: canTakeCard }).ok)
        .map((p) => packageOffer(p, date, party, counts.get(String(p.id)) || 0))
        .filter(Boolean)
        .map((o) => {
          const pkgRow = venue.packages.find((x) => String(x.id) === String(o.id));
          const lines = venue.choiceLines.filter((l) => String(l.package_id) === String(o.id));
          // The choose-now fork, decided SERVER-side for this date: inside the
          // pre-order window the deadline has already passed, so choices are
          // taken at booking; outside it the guest gets a link, due by the
          // deadline date. The page keys its copy off these two fields.
          const dl = new Date(`${date}T12:00:00`);
          dl.setDate(dl.getDate() - (o.preorderDaysBefore || 0));
          return {
            ...o,
            choiceGroups: o.requiresPreorder ? choiceGroupsFor(String(o.id), venue.choiceLines) : [],
            // v5.7.26 - the fork and the deadline only exist when the package
            // actually has something to choose.
            preorderChoiceAtBooking: o.requiresPreorder
              && choiceGroupsFor(String(o.id), venue.choiceLines).length > 0
              && daysAhead <= (o.preorderDaysBefore || 0),
            preorderDeadline: o.requiresPreorder && choiceGroupsFor(String(o.id), venue.choiceLines).length > 0
              ? dl.toISOString().slice(0, 10) : null,
            terms: String(pkgRow?.terms || ''),
            // What the package includes, for the landing/confirmation display.
            includes: lines.map((l) => ({ name: l.display_name, course: l.course ?? 0, choice: !!l.is_preorder_choice })),
          };
        });
      return json({ ok: true, slots, packages: offers });
    }

    if (action === 'book') {
      const time = String(body.time || '');
      const name = String(body.name || '').trim().slice(0, 80);
      const phone = normPhone(String(body.phone || ''));
      if (!/^\d{2}:\d{2}$/.test(time) || !name || !phone) {
        return json({ ok: false, error: 'name, valid mobile and time required' }, 400);
      }
      // THE WIDGET NEVER SELLS PAST THE CAP — no override path exists here.
      if (paceAt(toMin(time), bookings) >= rules.pacingCap) {
        return json({ ok: false, error: 'slot_full' });
      }

      // Optional package: re-validate the offer server-side (window, covers,
      // per-service cap) — never trust the card the page showed earlier.
      // 10 Sep 2026: moved BEFORE the CRM write, so a refused package writes
      // no row anywhere.
      let pkg: Record<string, unknown> | null = null;
      if (body.package_id) {
        const row = venue.packages.find((x) => String(x.id) === String(body.package_id));
        let booked = 0;
        if (row?.max_per_service) {
          const { count } = await db.from('bookings')
            .select('id', { count: 'exact', head: true })
            .eq('location_id', locationId).eq('booking_date', date)
            .eq('package_id', String(row.id)).not('status', 'in', '(cancelled,no_show,expired)');
          booked = count || 0;
        }
        const offer = row ? packageOffer(row, date, party, booked) : null;
        if (!offer) return json({ ok: false, error: 'package_unavailable' });
        // A Deposit at 0 or a Prepay at 0 is misconfigured: never sold.
        if (packagePaymentNeed(row).misconfigured) return json({ ok: false, error: 'package_unavailable' });
        pkg = row;
      }
      const pkgNeed = packagePaymentNeed(pkg);

      // ── THE PAYMENT GATE (10 Sep 2026) ───────────────────────────────────
      // What is due is decided HERE, on the server, from the package and the
      // rules loadVenue already read (checked, never a second unchecked read).
      //   - a package that needs payment while capture is off, or while the
      //     venue cannot take a card: refused in plain words, NO row written
      //   - nothing due: 'confirmed'
      //   - anything due: 'pending_payment' (the table is held while the guest
      //     pays; only booking_pay or adyen-webhook promote it, after Adyen
      //     authorises the full amount). NEVER 'prepaid' at book time.
      if (pkgNeed.needsPayment && !rules.cardCaptureEnabled) {
        return json({ ok: false, error: 'payment_unavailable', message: PAYMENT_UNAVAILABLE_MESSAGE });
      }
      const paymentDue = paymentDueFor(party, pkg, rules as unknown as Record<string, unknown>);
      const createStatus = statusAtBooking(paymentDue);
      // Resolve the venue's Adyen config BEFORE the booking exists, and refuse
      // here when it cannot take a card (live without live keys, no client
      // key, no merchant account): the guest gets a clear error and no
      // orphaned pending_payment row sits on the table for 20 minutes. The
      // page needs the client key and environment to take the card next.
      let guestAdyen: { clientKey: string; environment: 'test' | 'live'; region: string; dropinEnvironment: string; currency: string } | null = null;
      if (paymentDue) {
        const v = await adyenCfgForOps(locationId).catch((e) => {
          console.error('[booking-widget] Adyen config lookup failed at book:', (e as Error).message);
          return null;
        });
        if (!v || !adyenUsable(v)) {
          if (pkgNeed.needsPayment) {
            return json({ ok: false, error: 'payment_unavailable', message: PAYMENT_UNAVAILABLE_MESSAGE });
          }
          return json({ ok: false, error: v?.cfg.live ? adyenNotConfiguredMessage(v.cfg) : 'card capture not configured' }, 503);
        }
        guestAdyen = { clientKey: v.cfg.clientKey, environment: v.cfg.env, region: v.cfg.region, dropinEnvironment: v.cfg.dropinEnvironment, currency: v.currency };
      }

      // Unified CRM (org-scoped, phone-matched, only-fill-blank — the same
      // semantics as every other customers writer).
      const email = String(body.email || '').trim().toLowerCase() || null;
      let customerId: string | null = null;
      let allergens: string[] = [];
      const { data: existing } = await db.from('customers')
        .select('id, name, email, allergens')
        .eq('org_id', venue.loc.org_id).eq('phone', phone).is('deleted_at', null).maybeSingle();
      if (existing) {
        customerId = existing.id;
        allergens = existing.allergens || [];
        const patch: Record<string, unknown> = {};
        if (!existing.name && name) patch.name = name;
        if (!existing.email && email) patch.email = email;
        if (Object.keys(patch).length) await db.from('customers').update(patch).eq('id', existing.id);
      } else {
        const { data: created } = await db.from('customers')
          .insert({ org_id: venue.loc.org_id, name, phone, phone_raw: String(body.phone || ''), email, source: 'booking_widget' })
          .select('id').maybeSingle();
        customerId = created?.id || null;
      }
      // A card hold with no CRM record would go to Adyen with no shopper
      // reference, so no card could be stored and nothing would secure the
      // table (10 Sep 2026 review). Refuse the booking; no row is written.
      if (paymentDue?.kind === 'hold' && !customerId) {
        console.error('[booking-widget] card hold due but the customer record could not be written, booking refused');
        return json({ ok: false, error: 'booking_failed' });
      }
      if (body.consent === true && customerId) {
        // Consent is an AUDIT event, not a flag — customer_consents is the record.
        await db.from('customer_consents').insert({
          customer_id: customerId, org_id: venue.loc.org_id, location_id: locationId,
          channel: 'both', purpose: 'marketing', consented: true,
          source: 'booking_widget', method: 'explicit_optin',
        }).then(() => db.from('customers').update({ marketing_opt_in: true, marketing_opt_in_at: new Date().toISOString() }).eq('id', customerId));
      }

      const note = String(body.note || '').slice(0, 300);
      const customerSnap = { name, phone, email, allergens };   // email rides the snapshot — the reminder fn needs it

      // (The package was re-validated, and the payment gate run, above.)
      const turnOverride = pkg?.turn_minutes ? Number(pkg.turn_minutes) : null;

      // ── pre-order choices (Peter, 12 Aug) ────────────────────────────────
      // Inside the deadline window (visit − preorder_days_before ≤ today) the
      // widget MUST collect one choice per guest per course group. Further
      // out, we book now and hand back a token — the guest chooses later via
      // the link (reminded by email + SMS as the deadline approaches).
      const groups = pkg?.requires_preorder ? choiceGroupsFor(String(pkg.id), venue.choiceLines) : [];
      const choicesDue = !!pkg?.requires_preorder && groups.length > 0
        && daysAhead <= (Number(pkg.preorder_days_before) || 0);
      const submitted = Array.isArray(body.preorders) ? body.preorders : [];
      // Keep only rows matching a real choice option; cap at party × groups.
      // deno-lint-ignore no-explicit-any
      const validPairs: { raw: any; row: { seat: number; guest_name: string | null; item_id: string | null; display_name: string; course: number; notes: string } }[] = [];
      for (const r of submitted) {
        const hit = matchChoice(groups, r);
        if (!hit) continue;
        validPairs.push({
          raw: r,
          row: {
            seat: Math.max(1, Math.min(party, Math.round(Number(r.seat) || 0) || 1)),
            guest_name: String(r.guestName || r.guest_name || '').slice(0, 60) || null,
            item_id: hit.opt.itemId || null,
            display_name: hit.opt.name || 'Choice',
            course: hit.g.course ?? 0,
            notes: String(r.notes || '').slice(0, MAX_CHOICE_NOTE),
          },
        });
      }
      validPairs.splice(party * Math.max(1, groups.length));
      const validRows = validPairs.map((p) => p.row);
      const completeNow = groups.length > 0 && groups.every((g) =>
        validRows.filter((r) => r.course === g.course).length >= party);
      // "Choose later" skip (Peter, 19 Aug): even inside the window the guest
      // may defer — the token + send_link below carry them to the link flow.
      if (choicesDue && !completeNow && body.choose_later !== true) {
        return json({ ok: false, error: 'preorders_required', choiceGroups: groups, party });
      }

      // (What is due, the status and the Adyen config were settled by the
      // payment gate above, before any row was written.)
      const candidates = quote(time);
      let bookedId: string | null = null;
      let tableLabel: string | null = null;
      for (const c of candidates) {
        const id = `bk-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const { data: res } = await db.rpc('create_booking', {
          p_id: id,
          p_location_id: locationId,
          p_booking_date: date,
          p_start_time: time,
          p_turn_minutes: turnOverride || turnFor(party, rules.turnBands),
          p_covers: party,
          p_table_ids: c.set,
          p_primary_table_id: c.set[0],
          p_customer_id: customerId,
          p_customer: customerSnap,
          p_status: createStatus,
          p_source: 'widget',
          p_package_id: pkg ? String(pkg.id) : null,
          p_note: note,
          p_created_by: 'widget',
        });
        if (res?.ok) { bookedId = id; tableLabel = c.label; break; }
        // table_taken → try the next candidate (someone booked between quote and write)
      }

      // Persist choices; mint the completion token for requires_preorder
      // bookings THAT HAVE CHOICE LINES (v5.7.26 — a package with pre-order on
      // but nothing marked "guest chooses" used to mint a token and nag the
      // guest toward a page with nothing to pick). Even when choices came in
      // at booking, the link lets guests amend them later.
      let preorderToken: string | null = null;
      let preorderDeadline: string | null = null;
      if (bookedId && pkg?.requires_preorder && groups.length > 0) {
        if (validRows.length) {
          // The guest's sizes and options, checked against the menu (10 Sep 2026).
          const extras = await choiceFieldsFor(locationId, validPairs.map((p) => ({
            itemId: p.row.item_id, variantItemId: p.raw?.variantItemId, mods: p.raw?.mods,
          })));
          const poErr = await insertPreorders(validRows.map((r, i) => ({ ...r, ...extras[i], location_id: locationId, booking_id: bookedId })));
          if (poErr) console.error('[booking-widget] booking_preorders insert failed for', bookedId, poErr.message);
        }
        preorderToken = (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, '');
        const dl = new Date(`${date}T12:00:00`);
        dl.setDate(dl.getDate() - (Number(pkg.preorder_days_before) || 0));
        preorderDeadline = dl.toISOString().slice(0, 10);
        await db.from('bookings').update({ preorder_token: preorderToken }).eq('id', bookedId);
      }

      // Store WHAT WAS DUE on the booking (10 Sep 2026, migration 20260910):
      // booking_pay charges exactly this, so a package edited or switched off
      // between booking and paying can never change the charge. Before the
      // migration the columns are absent: booking_pay then recomputes from the
      // booking's own package, so the booking still works.
      if (bookedId && paymentDue) {
        const { error: dueErr } = await db.from('bookings').update({
          payment_kind: paymentDue.kind,
          payment_due_minor: paymentDue.amountMinor,
          payment_currency: guestAdyen?.currency || null,
        }).eq('id', bookedId);
        if (dueErr && !isMissingColumnError(dueErr)) {
          console.error('[booking-widget] could not store what is due on', bookedId, dueErr.message);
        }
      }

      // Booking confirmation SMS + email (Peter, 13 Aug: "didn't get SMS").
      // Fire-and-forget to booking-reminders — its ledger sends each channel
      // once. NOT for pending_payment: no money, no "your table is booked" —
      // the promote paths (booking_pay sync / adyen-webhook async) fire it.
      const remindersUrl = `${Deno.env.get('SUPABASE_URL')}/functions/v1/booking-reminders`;
      const remindersAuth = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}` };
      if (bookedId && createStatus !== 'pending_payment') {
        fetch(remindersUrl, {
          method: 'POST', headers: remindersAuth,
          body: JSON.stringify({ action: 'confirm', booking_id: bookedId }),
        }).catch(() => {});
        // Choices deferred (far-out booking, or the choose-later skip): send
        // the pre-order link straight away, on top of the confirmation.
        if (pkg?.requires_preorder && groups.length > 0 && !completeNow) {
          fetch(remindersUrl, {
            method: 'POST', headers: remindersAuth,
            body: JSON.stringify({ action: 'send_link', booking_id: bookedId }),
          }).catch(() => {});
        }
      }

      // Every widget attempt lands in booking_requests — the audit/intake ledger.
      await db.from('booking_requests').insert({
        location_id: locationId,
        payload: { date, time, party, name, phone, email, note, package_id: pkg ? String(pkg.id) : null, consent: body.consent === true },
        // 10 Sep 2026: an unpaid booking is not accepted yet.
        status: bookedId && createStatus !== 'pending_payment' ? 'accepted' : 'pending',
        booking_id: bookedId,
      });

      if (!bookedId) {
        // Availability vanished mid-flight: the venue follows up by phone.
        return json({ ok: true, status: 'pending', message: 'That time was just taken — the venue will confirm your booking shortly.' });
      }
      // status is the REAL row status: 'pending_payment' means the page must
      // take the card next (paymentDue says what for); the pg_cron sweep
      // expires it in 20 minutes if it never pays.
      return json({ ok: true, status: createStatus, bookingId: bookedId, table: tableLabel, time, date, party,
        package: pkg ? { id: pkg.id, name: pkg.name, paymentModel: pkg.payment_model } : null,
        preorderToken, preorderDeadline,
        preordersTaken: validRows.length > 0,
        paymentDue,
        ...(guestAdyen ? { adyen: guestAdyen } : {}) });
    }

    // ── booking_status: the guest page polls this while a payment confirms ──
    // Answers the booking's status only (10 Sep 2026 payment gate): the page
    // says "booked" only when this says confirmed or prepaid.
    if (action === 'booking_status') {
      const bookingId = String(body.booking_id || '');
      if (!bookingId) return json({ ok: false, error: 'booking_id required' }, 400);
      const { data: st, error: stErr } = await db.from('bookings')
        .select('status').eq('id', bookingId).eq('location_id', locationId).maybeSingle();
      if (stErr) return json({ ok: false, error: 'lookup_failed' }, 503);
      if (!st) return json({ ok: false, error: 'unknown_booking' }, 404);
      // The latest payment attempt's state, so the page can say plainly when a
      // card could not be saved or the bank said no while it was waiting.
      // Best effort: a failed read just leaves it out.
      const { data: lastPay } = await db.from('booking_payments')
        .select('status, kind').eq('booking_id', bookingId)
        .order('created_at', { ascending: false }).limit(1);
      const last = lastPay?.[0] || null;
      return json({ ok: true, status: st.status, payment: last ? { status: last.status, kind: last.kind } : null });
    }

    // ── booking_pay / booking_pay_details: THE PAYMENT GATE (10 Sep 2026) ───
    // ADVANCED flow (mirrors adyen-checkout make_payment + payment_details):
    // payment_method is the encrypted blob from the browser; a 3DS challenge
    // runs inside the Drop-in and comes back through booking_pay_details.
    //   - Authorised is the ONLY success. Received or Pending write a pending
    //     row and leave the booking pending_payment (the sweep skips a young
    //     pending row for 30 minutes; the webhook settles it).
    //   - The amount is what was STORED on the booking at book time. Without it
    //     (older bookings) it is recomputed from the booking's OWN package,
    //     fetched by id, inactive packages included.
    //   - "Already paid" keys on the booking and its references, never on a
    //     recomputed kind, so a changed package can never charge twice.
    //   - Promote only after the authorised amount covers what is due (a hold
    //     saves a card and takes nothing, so it is excepted), through
    //     _shared/bookingPromote.ts: pending_payment, or expired only when its
    //     tables are still free (else the payment is marked needs_refund).
    //     cancelled, no_show, departed and dining never promote.
    if (action === 'booking_pay' || action === 'booking_pay_details') {
      const venueAdyen = await adyenCfgForOps(locationId);
      const cfg = venueAdyen.cfg;
      if (!adyenUsable(venueAdyen)) {
        return json({ ok: false, error: cfg.live ? adyenNotConfiguredMessage(cfg) : 'card capture not configured' }, 503);
      }
      const merchantAccount = venueAdyen.merchantAccount;
      const currency = String(venueAdyen.currency).toUpperCase();
      const bookingId = String(body.booking_id || '');
      if (!bookingId) return json({ ok: false, error: 'booking_id required' }, 400);

      // The booking and what it owes RIGHT NOW (10 Sep 2026 review): never the
      // stored due alone, which a browser could rewrite before migration
      // 20260910. loadBookingDue weighs the stored due, the booking's own
      // package (by id, inactive included), the package and party in the
      // widget's booking_requests audit row and the venue hold rule, and takes
      // the largest; a stored card hold where money is owed is refused.
      const dueRes = await loadBookingDue(db, bookingId);
      const bk = (dueRes.booking || null) as Record<string, unknown> | null;
      if (!dueRes.ok && dueRes.error === 'lookup_failed') {
        console.error('[booking-widget] booking lookup failed for', bookingId);
        return json({ ok: false, error: 'lookup_failed' }, 503);
      }
      if (!bk || String(bk.location_id) !== locationId) return json({ ok: false, error: 'unknown_or_closed' }, 404);
      // booking_pay starts a NEW charge only while the booking is waiting for it
      // (pending_payment). Seated (dining), cancelled, expired, confirmed: no
      // charge. booking_pay_details may still finish a payment already in flight
      // for a booking that expired during the challenge (the promote then checks
      // its tables), but never one staff have seated, cancelled or closed.
      const open = action === 'booking_pay' ? ['pending_payment'] : ['pending_payment', 'expired'];
      if (!open.includes(String(bk.status))) {
        // 200, not 404: the guest page can only read a body on a 2xx reply,
        // and it must be able to say plainly what happened to this booking.
        return json({ ok: false, error: 'unknown_or_closed', status: bk.status });
      }
      if (!dueRes.ok) {
        // due_mismatch: the booking no longer matches what it owed. Nothing is charged.
        console.error('[booking-widget] what booking', bookingId, 'owes does not match its package, NOT charging:', dueRes.error);
        return json({ ok: false, error: 'due_mismatch' });
      }
      const guestCtx = {
        guestName: (bk.customer as Record<string, unknown> | null)?.name ? String((bk.customer as Record<string, unknown>).name) : null,
        time: bk.start_time ? String(bk.start_time) : null,
      };

      // Promote, then fire the confirmation and (when choices are missing) the
      // pre-order link. A payment that landed too late is flagged for refund.
      const settlePromotion = async (kind: string, rowIds: string[]) => {
        const pr = await promotePaidBooking(db, bookingId, kind);
        if (pr.promoted) {
          const url = `${Deno.env.get('SUPABASE_URL')}/functions/v1/booking-reminders`;
          const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}` };
          fetch(url, { method: 'POST', headers, body: JSON.stringify({ action: 'confirm', booking_id: bookingId }) }).catch(() => {});
          if (bk.package_id) {
            const { data: ownPkg } = await db.from('packages').select('requires_preorder').eq('id', String(bk.package_id)).maybeSingle();
            if (ownPkg?.requires_preorder) {
              // v5.7.26 - no choice lines = nothing to nag about.
              const { count: choiceLines } = await db.from('package_lines')
                .select('id', { count: 'exact', head: true })
                .eq('package_id', String(bk.package_id)).eq('is_preorder_choice', true);
              const { count: picked } = await db.from('booking_preorders')
                .select('id', { count: 'exact', head: true }).eq('booking_id', bookingId);
              if ((choiceLines || 0) > 0 && (picked || 0) < (Number(bk.covers) || 1)) {
                fetch(url, { method: 'POST', headers, body: JSON.stringify({ action: 'send_link', booking_id: bookingId }) }).catch(() => {});
              }
            }
          }
        } else {
          // 10 Sep 2026 review: EVERY payment that cannot secure its booking is
          // flagged (seated, cancelled, closed, gone, or its table taken), not
          // only table_taken, and raised on the venue's activity feed. A lookup
          // that failed is not flagged: the webhook may still promote it.
          const why = stuckPaymentReason(pr);
          if (why) await markPaymentNeedsRefund(db, rowIds, why, guestCtx);
        }
        return pr;
      };
      // Money is in but the booking cannot promote: say so honestly. 200 with
      // ok:false, because the guest page can only read a body on a 2xx reply.
      const promotionFailed = (pr: { status: string | null; error?: string }, extra: Record<string, unknown> = {}) =>
        json({ ...extra, ok: false, error: pr.error === 'table_taken' ? 'paid_but_table_taken' : 'paid_but_booking_not_promotable', status: pr.status });

      // One Adyen answer (/payments or /payments/details) → the ledger row and
      // the page reply. rowId null = a new attempt (insert); else the SAME row.
      // deno-lint-ignore no-explicit-any
      const finish = async (j: Record<string, any>, ctx: { rowId: string | null; reference: string; kind: string; dueMinor: number; sentMinor: number }) => {
        const code = String(j.resultCode || '');
        const authorised = code === 'Authorised';
        const refused = code === 'Refused';
        const notCompleted = code === 'Cancelled' || code === 'Error';
        const isHold = ctx.kind === 'hold';
        const nowIso = new Date().toISOString();
        const storedId = j.additionalData?.['tokenization.storedPaymentMethodId'] || j.additionalData?.['recurring.recurringDetailReference'] || null;
        // A card hold is only real when the card was STORED (10 Sep 2026
        // review). Authorised with no stored card secures nothing: the attempt
        // stays pending (the webhook may still bring the saved card and promote
        // it, or fail it), and the page waits instead of saying booked.
        // 10 Sep 2026 (integrator): an authorised hold confirms even when Adyen
        // sends no saved card token. No no-show charge exists yet, and 30 days of
        // live Adyen events carried no token at all, so requiring one would leave
        // every hold booking unconfirmed until the sweep expired it. The token is
        // still kept whenever it arrives (either additionalData key).
        const holdNoCard = false;
        const fields: Record<string, unknown> = {
          status: holdNoCard ? 'pending'
            : authorised ? (isHold ? 'authorised' : 'captured') : (refused || notCompleted) ? 'failed' : 'pending',
          ...(j.pspReference ? { psp_reference: j.pspReference } : {}),
          ...(storedId ? { stored_payment_method_id: storedId } : {}),
          ...(j.additionalData?.cardSummary ? { card_last4: j.additionalData.cardSummary } : {}),
          refusal_reason: holdNoCard ? 'Waiting for the saved card' : (j.refusalReason || (notCompleted ? code : null)),
          ...(authorised ? { authorised_at: nowIso } : {}),
          ...(authorised && !isHold ? { captured_at: nowIso } : {}),
        };
        const successWrite = fields.status === 'captured' || fields.status === 'authorised';
        // Success never revives money already flagged for refund, refunded or
        // cancelled; a non-success never downgrades a settled row.
        // deno-lint-ignore no-explicit-any
        const guard = (q: any) => (successWrite
          ? q.not('status', 'in', '(needs_refund,refunded,cancelled)')
          : q.in('status', ['pending', 'failed']));
        let rowId = ctx.rowId;
        if (!rowId) {
          const { data: ins, error: insErr } = await db.from('booking_payments').insert({
            location_id: locationId,
            booking_id: bookingId,
            kind: ctx.kind,
            amount: ctx.dueMinor / 100,
            currency: currency.toLowerCase(),
            merchant_reference: ctx.reference,
            merchant_account: merchantAccount,
            ...fields,
          }).select('id').maybeSingle();
          if (insErr) {
            // A retransmit of this attempt (same idempotency key) already wrote
            // the row carrying this psp: settle THAT row, never a second one.
            const { data: same } = j.pspReference
              ? await db.from('booking_payments').select('id').eq('psp_reference', j.pspReference).eq('booking_id', bookingId).maybeSingle()
              : { data: null };
            if (same?.id) {
              rowId = String(same.id);
              await guard(db.from('booking_payments').update(fields).eq('id', rowId));
            } else {
              // Money Adyen authorised is still real: the checks below still
              // run on the verified amount and the error is loud. A result that
              // is not final (3DS, Received, Pending) still goes back to the page
              // so it waits and polls instead of asking the guest to pay again;
              // the webhook writes the missing row from the event (10 Sep 2026
              // review). A refusal still reads as a refusal.
              console.error('[booking-widget] booking_payments insert FAILED for', ctx.reference, code, insErr.message);
            }
          } else {
            rowId = ins?.id ? String(ins.id) : null;
          }
        } else {
          // Settle the SAME row: by psp_reference first (the webhook may have
          // stamped it already), else the attempt row itself.
          let settled = false;
          if (j.pspReference) {
            const { data: byPsp } = await guard(db.from('booking_payments').update(fields)
              .eq('psp_reference', j.pspReference).eq('booking_id', bookingId)).select('id');
            if (byPsp?.length) { settled = true; rowId = String(byPsp[0].id); }
          }
          if (!settled) {
            const { error: upErr } = await guard(db.from('booking_payments').update(fields).eq('id', rowId));
            if (upErr) console.error('[booking-widget] booking_payments settle failed for', ctx.reference, upErr.message);
          }
        }
        // Card on file onto the unified CRM record (never re-keyed).
        if (isHold && authorised && storedId && bk.customer_id) {
          await db.from('customers').update({ stored_payment_method_id: storedId, shopper_reference: bk.customer_id }).eq('id', bk.customer_id);
        }

        const base = { kind: ctx.kind, resultCode: code || null, pspReference: j.pspReference || null, amountMinor: ctx.dueMinor, reference: ctx.reference };
        if (authorised && !holdNoCard) {
          const paidMinor = j.amount?.value !== undefined ? Number(j.amount.value) : ctx.sentMinor;
          const paidCurrency = j.amount?.currency ? String(j.amount.currency) : currency;
          if (!amountCovers({ kind: ctx.kind, dueMinor: ctx.dueMinor, paidMinor, dueCurrency: currency, paidCurrency })) {
            console.error('[booking-widget] authorised amount does not cover what is due, NOT promoting:', ctx.reference, paidMinor, paidCurrency, ctx.dueMinor, currency);
            // Money is in but short: it cannot secure the booking, so it goes back.
            await markPaymentNeedsRefund(db, rowId ? [rowId] : [], 'the amount paid did not cover what the booking owed', guestCtx);
            // 200: the guest page can only read a body on a 2xx reply.
            return json({ ...base, ok: false, error: 'amount_short' });
          }
          const pr = await settlePromotion(ctx.kind, rowId ? [rowId] : []);
          if (!pr.ok) return promotionFailed(pr, base);
          return json({ ...base, ok: true, status: pr.status });
        }
        if (refused) return json({ ...base, ok: false, error: 'card_refused', refusalReason: j.refusalReason || null });
        if (notCompleted) return json({ ...base, ok: false, error: 'payment_not_completed' });
        // A 3DS action for the Drop-in, or Received / Pending: the booking
        // stays pending_payment. No status in the reply: it is not booked.
        return json({ ...base, ok: true, action: j.action || null, pending: !j.action });
      };

      if (action === 'booking_pay_details') {
        const reference = String(body.reference || '');
        if (!reference.startsWith(`bkpay-${bookingId}-`)) return json({ ok: false, error: 'bad reference' }, 400);
        if (!body.details || typeof body.details !== 'object') return json({ ok: false, error: 'details required' }, 400);
        const { data: atts, error: attErr } = await db.from('booking_payments')
          .select('id, kind, amount, currency, status')
          .eq('booking_id', bookingId).eq('merchant_reference', reference)
          .order('created_at', { ascending: false }).limit(1);
        if (attErr) return json({ ok: false, error: 'lookup_failed' }, 503);
        const owedDue = dueRes.due;
        // deno-lint-ignore no-explicit-any
        let att: any = atts?.[0] || null;
        if (!att) {
          // booking_pay's insert failed (10 Sep 2026 review) but the attempt is
          // real: rebuild it from the reference's kind and what the booking owes.
          // finish() then writes the row, so the challenge is never stranded.
          const refKind = reference.match(/^bkpay-.+-(hold|deposit|prepay)-a\d+$/)?.[1] || null;
          if (!refKind || !owedDue || owedDue.kind !== refKind) return json({ ok: false, error: 'unknown_payment', reference });
          att = { id: null, kind: refKind, amount: owedDue.amountMinor / 100, currency: currency.toLowerCase(), status: 'pending' };
        }
        const dueMinor = Math.round(Number(att.amount) * 100);
        // What the BOOKING owes (loadBookingDue), never only what the attempt row says.
        const owed = owedDue
          ? { kind: owedDue.kind, amountMinor: owedDue.amountMinor, currency: owedDue.currency || currency }
          : { kind: att.kind, amountMinor: dueMinor, currency };
        const attemptCovers = paymentSatisfiesDue(owed, { kind: att.kind, amountMinor: dueMinor, currency: att.currency });
        if (att.status === 'captured' || att.status === 'authorised') {
          // The webhook settled it first. Promote only if that payment still
          // covers what the booking owes.
          if (!attemptCovers) return json({ ok: false, error: 'paid_amount_short', reference });
          const pr = await settlePromotion(String(att.kind), [String(att.id)]);
          if (!pr.ok) return promotionFailed(pr, { reference, kind: att.kind });
          return json({ ok: true, kind: att.kind, resultCode: 'Authorised', amountMinor: dueMinor, reference, status: pr.status });
        }
        if (att.status !== 'pending') return json({ ok: false, error: 'payment_not_completed', reference });
        // An attempt that could never cover the booking is not finished: no money moves.
        if (!attemptCovers) {
          console.error('[booking-widget] 3DS attempt does not cover what booking', bookingId, 'owes, NOT finishing it');
          return json({ ok: false, error: 'due_mismatch', reference });
        }
        const res = await adyenFetch('POST', `${checkoutBase(cfg)}/payments/details`,
          { details: body.details, ...(body.payment_data ? { paymentData: body.payment_data } : {}) },
          { cfg, idempotencyKey: await detailsIdempotencyKey(reference, body.details) });
        const j = res.data ?? {};
        if (!res.ok) {
          console.error('[booking-widget] booking_pay_details failed:', res.status, JSON.stringify(j).slice(0, 300));
          return json({ ok: false, error: j.message || `payment details refused (${res.status})` }, 502);
        }
        if (j.merchantReference && String(j.merchantReference) !== reference) {
          console.error('[booking-widget] details answered for another reference:', j.merchantReference, reference);
          return json({ ok: false, error: 'reference_mismatch' }, 409);
        }
        return await finish(j, { rowId: att.id ? String(att.id) : null, reference, kind: String(att.kind), dueMinor, sentMinor: att.kind === 'hold' ? 0 : dueMinor });
      }

      // ── booking_pay ──
      if (!rules.cardCaptureEnabled) return json({ ok: false, error: 'card_capture_disabled' }, 403);
      // What to charge: loadBookingDue above (the stored due, the booking's own
      // package, the audit row's package and party, the rules; largest wins).
      const due = dueRes.due;
      if (!due) return json({ ok: false, error: 'nothing_due' });
      if (due.currency && due.currency !== currency) {
        console.error('[booking-widget] venue currency changed since booking:', bookingId, due.currency, currency);
        return json({ ok: false, error: 'currency_changed' }, 409);
      }
      if (!body.payment_method || typeof body.payment_method !== 'object') {
        return json({ ok: false, error: 'payment_method required' }, 400);
      }

      // Already paid? Every successful payment on THIS booking's references,
      // whatever kind it was: never charge a second time.
      const { data: prior, error: priorErr } = await db.from('booking_payments')
        .select('id, kind, amount, currency, status')
        .eq('booking_id', bookingId).like('merchant_reference', `bkpay-${bookingId}-%`)
        .in('status', ['authorised', 'captured']);
      if (priorErr) return json({ ok: false, error: 'lookup_failed' }, 503);
      if (prior?.length) {
        const covering = prior.find((p: Record<string, unknown>) => paymentSatisfiesDue(
          { kind: due.kind, amountMinor: due.amountMinor, currency },
          { kind: p.kind, amountMinor: Math.round(Number(p.amount) * 100), currency: p.currency },
        ));
        if (!covering) {
          console.error('[booking-widget] an earlier payment does not cover what is due, NOT charging again:', bookingId);
          // 200: the guest page can only read a body on a 2xx reply.
          return json({ ok: false, error: 'paid_amount_short', kind: due.kind });
        }
        const pr = await settlePromotion(due.kind, [String(covering.id)]);
        if (!pr.ok) return promotionFailed(pr, { kind: due.kind });
        return json({ ok: true, already: true, kind: due.kind, status: pr.status });
      }

      const isHold = due.kind === 'hold';
      // v5.7.23 - every attempt gets its OWN merchant reference (-a<N>); the
      // webhook settles by pspReference. Counted per booking, so a reference
      // is unique across kinds too.
      const { count: priorAttempts } = await db.from('booking_payments')
        .select('id', { count: 'exact', head: true })
        .eq('booking_id', bookingId);
      const attempt = (priorAttempts || 0) + 1;
      const reference = `bkpay-${bookingId}-${due.kind}-a${attempt}`;
      const pmType = String((body.payment_method as Record<string, unknown>).type || '').toLowerCase();
      const payment: Record<string, unknown> = {
        merchantAccount,
        // A hold is a ZERO-value authorisation that saves the card. No money.
        amount: { value: isHold ? 0 : due.amountMinor, currency },   // the venue's currency, never a literal GBP (8 Sep 2026)
        reference,
        paymentMethod: body.payment_method,
        channel: 'Web',
        origin: String(body.origin || ''),
        returnUrl: String(body.return_url || DEFAULT_RETURN_URL),
        shopperInteraction: 'Ecommerce',
        // Native 3DS2: the challenge runs in the Drop-in and finishes through
        // booking_pay_details (a redirect could never come back to this page).
        ...(NO_NATIVE_3DS_TYPES.includes(pmType) ? {} : { authenticationData: { threeDSRequestData: { nativeThreeDS: 'preferred' } } }),
        ...(bk.customer_id ? { shopperReference: bk.customer_id } : {}),
        ...(isHold && bk.customer_id ? { storePaymentMethod: true, recurringProcessingModel: 'UnscheduledCardOnFile' } : {}),
      };
      if (body.browser_info) payment.browserInfo = body.browser_info;
      // The same store the wallet lookup was scoped to (see adyenCfgForOps).
      if (venueAdyen.store) payment.store = venueAdyen.store;

      // Idempotency-Key = reference + attempt: a retransmit of this attempt
      // replays Adyen's first answer instead of charging the guest twice.
      const res = await adyenFetch('POST', `${checkoutBase(cfg)}/payments`, payment,
        { cfg, idempotencyKey: await paymentIdempotencyKey(reference, attempt) });
      const j = res.data ?? {};
      if (!res.ok) {
        console.error('[booking-widget] booking_pay failed:', res.status, JSON.stringify(j).slice(0, 300));
        return json({ ok: false, error: j.message || `payment refused (${res.status})` }, 502);
      }
      return await finish(j, { rowId: null, reference, kind: due.kind, dueMinor: due.amountMinor, sentMinor: isHold ? 0 : due.amountMinor });
    }

    return json({ error: `unknown action: ${action}` }, 400);
  } catch (e) {
    console.error('[booking-widget]', e);
    const status = (e as { status?: number })?.status === 404 ? 404 : 500;
    return json({ error: (e as Error).message || 'server error' }, status);
  }
});
