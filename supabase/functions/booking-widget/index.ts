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

const normPhone = (raw: string) => {
  const d = String(raw || '').replace(/[^\d+]/g, '');
  if (d.startsWith('+')) return d;
  if (d.startsWith('07') && d.length === 11) return '+44' + d.slice(1);
  if (d.startsWith('44')) return '+' + d;
  return d.length >= 7 ? d : null;
};

const todayISO = () => new Date().toISOString().slice(0, 10);

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
  };
}

// Load everything a quote needs, once per request.
async function loadVenue(locationId: string) {
  const [{ data: loc }, { data: rulesRow }, { data: floor }] = await Promise.all([
    db.from('locations').select('id, org_id, name').eq('id', locationId).maybeSingle(),
    db.from('booking_rules').select('*').eq('location_id', locationId).maybeSingle(),
    db.from('floor_tables').select('id, label, max_covers, section').eq('location_id', locationId),
  ]);
  if (!loc) return null;
  return {
    loc,
    rules: rulesFrom(rulesRow),
    tables: (floor || []).map((t) => ({ id: t.id, label: t.label || t.id, covers: t.max_covers || 2, section: t.section || null })),
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
    const locationId = String(body.location_id || '');
    if (!locationId || locationId === 'loc-demo') return json({ error: 'location required' }, 400);

    const venue = await loadVenue(locationId);
    if (!venue) return json({ error: 'unknown venue' }, 404);
    const rules = venue.rules;
    if (!rules) return json({ ok: true, widgetEnabled: false, reason: 'not configured' });

    if (action === 'config') {
      return json({
        ok: true,
        name: venue.loc.name,
        widgetEnabled: rules.widgetEnabled,
        serviceStart: rules.serviceStart,
        serviceEnd: rules.serviceEnd,
        slotMinutes: rules.slotMinutes,
        maxDaysAhead: rules.maxDaysAhead,
        maxCovers: 12,
      });
    }

    if (!rules.widgetEnabled) return json({ ok: false, error: 'widget_disabled' }, 403);

    const date = String(body.date || todayISO());
    const party = Math.max(1, Math.min(12, Math.round(Number(body.party) || 2)));
    const daysAhead = Math.round((Date.parse(date) - Date.parse(todayISO())) / 86400000);
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
      const nowGuard = date === todayISO() ? (new Date().getHours() * 60 + new Date().getMinutes()) : -1;
      const slots: { time: string; full: boolean }[] = [];
      for (let t = start; t < end; t += rules.slotMinutes) {
        const hh = String(Math.floor(t / 60)).padStart(2, '0'), mm = String(t % 60).padStart(2, '0');
        const time = `${hh}:${mm}`;
        slots.push({ time, full: t <= nowGuard || slotFull(time) });
      }
      return json({ ok: true, slots });
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
      const customerSnap = { name, phone, allergens };
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
          p_turn_minutes: turnFor(party, rules.turnBands),
          p_covers: party,
          p_table_ids: c.set,
          p_primary_table_id: c.set[0],
          p_customer_id: customerId,
          p_customer: customerSnap,
          p_status: 'confirmed',
          p_source: 'widget',
          p_note: note,
          p_created_by: 'widget',
        });
        if (res?.ok) { bookedId = id; tableLabel = c.label; break; }
        // table_taken → try the next candidate (someone booked between quote and write)
      }

      // Every widget attempt lands in booking_requests — the audit/intake ledger.
      await db.from('booking_requests').insert({
        location_id: locationId,
        payload: { date, time, party, name, phone, email, note, consent: body.consent === true },
        status: bookedId ? 'accepted' : 'pending',
        booking_id: bookedId,
      });

      if (!bookedId) {
        // Availability vanished mid-flight: the venue follows up by phone.
        return json({ ok: true, status: 'pending', message: 'That time was just taken — the venue will confirm your booking shortly.' });
      }
      return json({ ok: true, status: 'confirmed', bookingId: bookedId, table: tableLabel, time, date, party });
    }

    return json({ error: `unknown action: ${action}` }, 400);
  } catch (e) {
    console.error('[booking-widget]', e);
    return json({ error: (e as Error).message || 'server error' }, 500);
  }
});
