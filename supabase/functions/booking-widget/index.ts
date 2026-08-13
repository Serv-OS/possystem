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
//
// Payments are NOT here yet — card capture ships dark behind
// booking_rules.card_capture_enabled and lands with the Adyen slice.

import { createClient } from 'npm:@supabase/supabase-js@2';
import {
  suggestTables, paceAt, turnFor, toMin,
  DEFAULT_TURN_BANDS, DEFAULT_RULES,
} from '../_shared/bookingOptimiser.js';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

// ── Adyen (bookings card capture — Phase 5) ──────────────────────────────────
// Same secrets and ADVANCED flow as the proven adyen-checkout fn: the card
// encrypts in the guest's browser, WE make the payment server-side.
const ADYEN_KEY = Deno.env.get('ADYEN_API_KEY') ?? '';
const ADYEN_MERCHANT = Deno.env.get('ADYEN_MERCHANT_ACCOUNT') ?? '';
const ADYEN_CLIENT_KEY = Deno.env.get('ADYEN_CLIENT_KEY') ?? '';
const ADYEN_ENV = (Deno.env.get('ADYEN_ENV') ?? 'test').toLowerCase();
const ADYEN_BASE = ADYEN_ENV === 'live' ? 'https://checkout-live.adyen.com' : 'https://checkout-test.adyen.com';

// What a booking owes at capture time. hold = zero-value auth that stores the
// card (no charge today; no-show capture comes later, off-session).
function paymentDueFor(bk: Record<string, unknown>, pkg: Record<string, unknown> | null, rules: { holdPerCover?: number } | Record<string, unknown>) {
  const covers = Number(bk.covers) || 1;
  if (pkg && pkg.payment_model === 'prepay') {
    const per = String(pkg.price_unit || '').includes('cover');
    const amt = per ? (Number(pkg.price) || 0) * covers : (Number(pkg.price) || 0);
    return { kind: 'prepay', amountMinor: Math.round(amt * 100), label: `${pkg.name} — paid now, comes off the bill` };
  }
  if (pkg && pkg.payment_model === 'deposit' && Number(pkg.deposit_per_cover) > 0) {
    const amt = (Number(pkg.deposit_per_cover) || 0) * covers;
    return { kind: 'deposit', amountMinor: Math.round(amt * 100), label: `Deposit — redeemed against the bill` };
  }
  // Hold only from the venue's covers threshold up (Peter, 13 Aug: "tables
  // over 4 require card capture, under that doesn't"). 0 = every booking.
  const minCovers = Number((rules as Record<string, unknown>).cardCaptureMinCovers) || 0;
  if (minCovers > 0 && covers < minCovers) return null;
  const hold = (Number((rules as Record<string, unknown>).holdPerCover) || 0) * covers;
  if (hold > 0) {
    return { kind: 'hold', amountMinor: Math.round(hold * 100), label: `Card held, nothing charged today` };
  }
  return null;
}

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
  };
}

// Load everything a quote needs, once per request.
async function loadVenue(locationId: string) {
  const [{ data: loc }, { data: rulesRow }, { data: floor }, { data: pkgs }, { data: choiceLines }] = await Promise.all([
    db.from('locations').select('id, org_id, name, timezone').eq('id', locationId).maybeSingle(),
    db.from('booking_rules').select('*').eq('location_id', locationId).maybeSingle(),
    db.from('floor_tables').select('id, label, max_covers, section').eq('location_id', locationId),
    db.from('packages').select('*').eq('location_id', locationId).eq('is_active', true).order('sort_order'),
    db.from('package_lines').select('id, package_id, item_id, display_name, course, qty_per_cover, is_preorder_choice, sort_order')
      .eq('location_id', locationId).order('sort_order'),
  ]);
  if (!loc) return null;
  return {
    loc,
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
    options: lines.map((l) => ({ lineId: l.id, itemId: l.item_id || null, name: l.display_name })),
  }));
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
      if (!bk || ['cancelled', 'no_show', 'departed'].includes(bk.status)) {
        return json({ ok: false, error: 'unknown_or_closed' }, 404);
      }
      const [{ data: loc2 }, { data: pkg2 }, { data: lines2 }, { data: existing }] = await Promise.all([
        db.from('locations').select('name, timezone').eq('id', bk.location_id).maybeSingle(),
        db.from('packages').select('*').eq('id', bk.package_id).maybeSingle(),
        db.from('package_lines').select('id, package_id, item_id, display_name, course, sort_order, is_preorder_choice')
          .eq('package_id', bk.package_id).eq('is_preorder_choice', true).order('sort_order'),
        db.from('booking_preorders').select('seat, guest_name, item_id, display_name, course').eq('booking_id', bk.id).order('seat'),
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
        deadline: dl.toISOString().slice(0, 10),
        choiceGroups: groups2,
        preorders: (existing || []).map((r) => ({ seat: r.seat, guestName: r.guest_name, itemId: r.item_id, name: r.display_name, course: r.course })),
      };
      if (action === 'preorder_info') return json(summary);

      // preorder_submit — replace wholesale with validated rows.
      const submitted2 = Array.isArray(body.preorders) ? body.preorders : [];
      const rows2 = submitted2
        .filter((r) => groups2.some((g) => g.options.some((o) =>
          (r.itemId && o.itemId && String(r.itemId) === String(o.itemId)) || String(r.name || '') === String(o.name))))
        .slice(0, bk.covers * Math.max(1, groups2.length))
        .map((r) => {
          const g = groups2.find((gg) => gg.options.some((o) =>
            (r.itemId && o.itemId && String(r.itemId) === String(o.itemId)) || String(r.name || '') === String(o.name)));
          const opt = g?.options.find((o) =>
            (r.itemId && o.itemId && String(r.itemId) === String(o.itemId)) || String(r.name || '') === String(o.name));
          return {
            location_id: bk.location_id,
            booking_id: bk.id,
            seat: Math.max(1, Math.min(bk.covers, Math.round(Number(r.seat) || 0) || 1)),
            guest_name: String(r.guestName || '').slice(0, 60) || null,
            item_id: opt?.itemId || null,
            display_name: opt?.name || 'Choice',
            course: g?.course ?? 0,
            notes: String(r.notes || '').slice(0, 120),
          };
        });
      if (!rows2.length) return json({ ok: false, error: 'no valid choices' }, 400);
      await db.from('booking_preorders').delete().eq('booking_id', bk.id);
      const { error: insErr } = await db.from('booking_preorders').insert(rows2);
      if (insErr) return json({ ok: false, error: insErr.message }, 500);
      return json({ ok: true, saved: rows2.length });
    }

    const locationId = String(body.location_id || '');
    if (!locationId || locationId === 'loc-demo') return json({ error: 'location required' }, 400);

    const venue = await loadVenue(locationId);
    if (!venue) return json({ error: 'unknown venue' }, 404);
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

    const bookings = await loadDayBookings(locationId, date);
    const quote = (time: string) => suggestTables({
      party, time, tables: venue.tables, bookings,
      joinGroups: rules.joinGroups, turnBands: rules.turnBands, rules, limit: 3,
    });
    const slotFull = (time: string) =>
      paceAt(toMin(time), bookings) >= rules.pacingCap || quote(time).length === 0;

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
        .not('package_id', 'is', null).not('status', 'in', '(cancelled,no_show)');
      const counts = new Map<string, number>();
      for (const r of pkgCounts || []) counts.set(r.package_id, (counts.get(r.package_id) || 0) + 1);
      const offers = venue.packages
        .map((p) => packageOffer(p, date, party, counts.get(String(p.id)) || 0))
        .filter(Boolean)
        .map((o) => {
          const pkgRow = venue.packages.find((x) => String(x.id) === String(o.id));
          const lines = venue.choiceLines.filter((l) => String(l.package_id) === String(o.id));
          return {
            ...o,
            choiceGroups: o.requiresPreorder ? choiceGroupsFor(String(o.id), venue.choiceLines) : [],
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

      // Optional package: re-validate the offer server-side (window, covers,
      // per-service cap) — never trust the card the page showed earlier.
      let pkg: Record<string, unknown> | null = null;
      if (body.package_id) {
        const row = venue.packages.find((x) => String(x.id) === String(body.package_id));
        let booked = 0;
        if (row?.max_per_service) {
          const { count } = await db.from('bookings')
            .select('id', { count: 'exact', head: true })
            .eq('location_id', locationId).eq('booking_date', date)
            .eq('package_id', String(row.id)).not('status', 'in', '(cancelled,no_show)');
          booked = count || 0;
        }
        const offer = row ? packageOffer(row, date, party, booked) : null;
        if (!offer) return json({ ok: false, error: 'package_unavailable' });
        pkg = row;
      }
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
      const validRows = submitted
        .filter((r) => groups.some((g) => g.options.some((o) =>
          (r.itemId && o.itemId && String(r.itemId) === String(o.itemId)) || String(r.name || r.displayName || '') === String(o.name))))
        .slice(0, party * Math.max(1, groups.length))
        .map((r) => {
          const g = groups.find((gg) => gg.options.some((o) =>
            (r.itemId && o.itemId && String(r.itemId) === String(o.itemId)) || String(r.name || r.displayName || '') === String(o.name)));
          const opt = g?.options.find((o) =>
            (r.itemId && o.itemId && String(r.itemId) === String(o.itemId)) || String(r.name || r.displayName || '') === String(o.name));
          return {
            seat: Math.max(1, Math.min(party, Math.round(Number(r.seat) || 0) || 1)),
            guest_name: String(r.guestName || r.guest_name || '').slice(0, 60) || null,
            item_id: opt?.itemId || null,
            display_name: opt?.name || 'Choice',
            course: g?.course ?? 0,
            notes: String(r.notes || '').slice(0, 120),
          };
        });
      const completeNow = groups.length > 0 && groups.every((g) =>
        validRows.filter((r) => r.course === g.course).length >= party);
      if (choicesDue && !completeNow) {
        return json({ ok: false, error: 'preorders_required', choiceGroups: groups, party });
      }

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
          p_status: pkg && pkg.payment_model === 'prepay' ? 'prepaid' : 'confirmed',
          p_source: 'widget',
          p_package_id: pkg ? String(pkg.id) : null,
          p_note: note,
          p_created_by: 'widget',
        });
        if (res?.ok) { bookedId = id; tableLabel = c.label; break; }
        // table_taken → try the next candidate (someone booked between quote and write)
      }

      // Persist choices; when the guest books far out, mint the completion token.
      let preorderToken: string | null = null;
      let preorderDeadline: string | null = null;
      if (bookedId && pkg?.requires_preorder) {
        if (validRows.length) {
          await db.from('booking_preorders').insert(validRows.map((r) => ({ ...r, location_id: locationId, booking_id: bookedId })));
        }
        if (!completeNow && groups.length > 0) {
          preorderToken = (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, '');
          const dl = new Date(`${date}T12:00:00`);
          dl.setDate(dl.getDate() - (Number(pkg.preorder_days_before) || 0));
          preorderDeadline = dl.toISOString().slice(0, 10);
          await db.from('bookings').update({ preorder_token: preorderToken }).eq('id', bookedId);
        }
      }

      // Booking confirmation SMS + email (Peter, 13 Aug: "didn't get SMS").
      // Fire-and-forget to booking-reminders — its ledger sends each channel once.
      if (bookedId) {
        fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/booking-reminders`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}` },
          body: JSON.stringify({ action: 'confirm', booking_id: bookedId }),
        }).catch(() => {});
      }

      // Every widget attempt lands in booking_requests — the audit/intake ledger.
      await db.from('booking_requests').insert({
        location_id: locationId,
        payload: { date, time, party, name, phone, email, note, package_id: pkg ? String(pkg.id) : null, consent: body.consent === true },
        status: bookedId ? 'accepted' : 'pending',
        booking_id: bookedId,
      });

      if (!bookedId) {
        // Availability vanished mid-flight: the venue follows up by phone.
        return json({ ok: true, status: 'pending', message: 'That time was just taken — the venue will confirm your booking shortly.' });
      }
      // Card capture (when the venue has it on): tell the page what this
      // booking owes so the confirmation screen can take the card.
      let paymentDue = null;
      if (bookedId && (venue.rules as Record<string, unknown>)?.cardCaptureEnabled !== false) {
        const { data: rulesRow2 } = await db.from('booking_rules').select('card_capture_enabled, hold_per_cover').eq('location_id', locationId).maybeSingle();
        if (rulesRow2?.card_capture_enabled) {
          paymentDue = paymentDueFor({ covers: party }, pkg, { holdPerCover: Number(rulesRow2.hold_per_cover) || 0 });
        }
      }
      return json({ ok: true, status: 'confirmed', bookingId: bookedId, table: tableLabel, time, date, party,
        package: pkg ? { id: pkg.id, name: pkg.name, paymentModel: pkg.payment_model } : null,
        preorderToken, preorderDeadline,
        preordersTaken: validRows.length > 0,
        paymentDue,
        ...(paymentDue ? { adyen: { clientKey: ADYEN_CLIENT_KEY, environment: ADYEN_ENV } } : {}) });
    }

    // ── booking_pay: charge/hold the card for a just-made booking ───────────
    // ADVANCED flow (mirrors adyen-checkout make_payment): payment_method is
    // the encrypted blob from the browser. prepay/deposit charge now; hold is
    // a ZERO-VALUE auth that stores the card against the guest for the
    // no-show capture later. Idempotent-ish: refuses when a successful row of
    // that kind already exists for the booking.
    if (action === 'booking_pay') {
      if (!ADYEN_KEY || !ADYEN_MERCHANT) return json({ ok: false, error: 'card capture not configured' }, 500);
      const bookingId = String(body.booking_id || '');
      const { data: bk } = await db.from('bookings')
        .select('id, location_id, covers, status, customer_id, customer, package_id, booking_date, start_time')
        .eq('id', bookingId).eq('location_id', locationId).maybeSingle();
      if (!bk || ['cancelled', 'no_show', 'departed'].includes(bk.status)) {
        return json({ ok: false, error: 'unknown_or_closed' }, 404);
      }
      const { data: rulesRow3 } = await db.from('booking_rules').select('card_capture_enabled, hold_per_cover').eq('location_id', locationId).maybeSingle();
      if (!rulesRow3?.card_capture_enabled) return json({ ok: false, error: 'card_capture_disabled' }, 403);
      const pkg3 = bk.package_id ? venue.packages.find((x) => String(x.id) === String(bk.package_id)) || null : null;
      const due = paymentDueFor(bk, pkg3 || null, { holdPerCover: Number(rulesRow3.hold_per_cover) || 0 });
      if (!due) return json({ ok: false, error: 'nothing_due' });
      if (!body.payment_method || typeof body.payment_method !== 'object') {
        return json({ ok: false, error: 'payment_method required' }, 400);
      }
      const { data: prior } = await db.from('booking_payments')
        .select('id').eq('booking_id', bookingId).eq('kind', due.kind)
        .in('status', ['authorised', 'captured']).limit(1);
      if (prior?.length) return json({ ok: true, already: true, kind: due.kind });

      const isHold = due.kind === 'hold';
      const reference = `bkpay-${bookingId}-${due.kind}`;
      const payment: Record<string, unknown> = {
        merchantAccount: ADYEN_MERCHANT,
        amount: { value: isHold ? 0 : due.amountMinor, currency: 'GBP' },
        reference,
        paymentMethod: body.payment_method,
        channel: 'Web',
        origin: String(body.origin || ''),
        returnUrl: String(body.return_url || 'https://dev.serv-os.app/'),
        shopperInteraction: 'Ecommerce',
        ...(bk.customer_id ? { shopperReference: bk.customer_id } : {}),
        // Store the card for holds (no-show capture is a later merchant-
        // initiated charge against the stored method).
        ...(isHold && bk.customer_id ? { storePaymentMethod: true, recurringProcessingModel: 'UnscheduledCardOnFile' } : {}),
      };
      if (body.browser_info) payment.browserInfo = body.browser_info;

      const res = await fetch(`${ADYEN_BASE}/v72/payments`, {
        method: 'POST',
        headers: { 'X-API-Key': ADYEN_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify(payment),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        console.error('[booking-widget] booking_pay failed:', res.status, JSON.stringify(j).slice(0, 300));
        return json({ ok: false, error: j.message || `payment refused (${res.status})` }, 502);
      }
      const authorised = j.resultCode === 'Authorised' || j.resultCode === 'Received';
      await db.from('booking_payments').insert({
        location_id: locationId,
        booking_id: bookingId,
        kind: due.kind,
        amount: due.amountMinor / 100,
        currency: 'gbp',
        status: authorised ? (isHold ? 'authorised' : 'captured') : (j.resultCode === 'Refused' ? 'failed' : 'pending'),
        psp_reference: j.pspReference || null,
        merchant_reference: reference,
        merchant_account: ADYEN_MERCHANT,
        stored_payment_method_id: j.additionalData?.['recurring.recurringDetailReference'] || null,
        card_last4: j.additionalData?.cardSummary || null,
        refusal_reason: j.refusalReason || null,
        ...(authorised ? { authorised_at: new Date().toISOString() } : {}),
        ...(authorised && !isHold ? { captured_at: new Date().toISOString() } : {}),
      });
      // Card-on-file onto the unified CRM record (never re-keyed).
      const storedId = j.additionalData?.['recurring.recurringDetailReference'] || null;
      if (isHold && authorised && storedId && bk.customer_id) {
        await db.from('customers').update({
          stored_payment_method_id: storedId,
          shopper_reference: bk.customer_id,
        }).eq('id', bk.customer_id);
      }
      if (!authorised && j.resultCode === 'Refused') {
        return json({ ok: false, error: 'card_refused', refusalReason: j.refusalReason || null });
      }
      return json({ ok: true, kind: due.kind, resultCode: j.resultCode, pspReference: j.pspReference || null,
        amountMinor: due.amountMinor, action: j.action || null });
    }

    return json({ error: `unknown action: ${action}` }, 400);
  } catch (e) {
    console.error('[booking-widget]', e);
    return json({ error: (e as Error).message || 'server error' }, 500);
  }
});
