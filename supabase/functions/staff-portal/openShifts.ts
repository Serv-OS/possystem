// supabase/functions/staff-portal/openShifts.ts
//
// v5.11.101: open shifts, swaps and availability in the staff app. The staff member is ALWAYS the
// one behind the portal login (index.ts staffFromJwt), never an id the phone sends. Every change
// goes through the database judge (20261031a: wf_shift_claim, wf_shift_drop, wf_swap_cancel,
// wf_swap_decline), which locks the shift and checks every rule again; this file lists what the
// person can take and why not (_shared/openShiftRules.js, the same rules), sends the texts and
// writes the audit row.

import { claimProblem, swapMode, problemText, eligibleStaff, shiftWords,
  textOpenShift, textOffered, textTaken, textAsked, textOfferDeclined } from '../_shared/openShiftRules.js';
import { regionPack } from '../_shared/regionPack.js';
import { writeWfAudit } from '../_shared/wfAudit.js';
import { notifyStaff } from '../_shared/staffNotify.ts';

type Admin = any;
type Venue = { id: string; name: string; currency: string; timezone: string; country: string; todayIso: string; nowMin: number };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hm = (t: unknown) => String(t || '').slice(0, 5);
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

/** The venue's row and its clock now. */
export async function venueFacts(admin: Admin, locationId: string): Promise<Venue> {
  const { data } = await admin.from('locations').select('id, name, currency, timezone').eq('id', locationId).maybeSingle();
  const tz = data?.timezone || 'Europe/London';
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date()).map((x) => [x.type, x.value]));
  const pack = regionPack({ currency: data?.currency || 'GBP' });
  return {
    id: locationId, name: data?.name || '', currency: data?.currency || 'GBP', timezone: tz, country: pack.country,
    todayIso: `${parts.year}-${parts.month}-${parts.day}`, nowMin: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

/** What the staff app shows about the venue's region (money, dates, which payroll fields). */
export function regionForApp(v: Venue) {
  const p = regionPack({ currency: v.currency });
  return { country: p.country, currency: p.currency, currencySymbol: p.currencySymbol, locale: p.locale, dateFormat: p.dateFormat,
    bankDetails: p.bankDetails, workDocLabel: p.workDocLabel, holidayRules: p.holidayRules };
}

const mapShift = (s: any) => s && ({
  id: s.id, locationId: s.location_id, staffId: s.staff_id, roleKey: s.role_key, date: s.shift_date,
  start: hm(s.start_time), finish: hm(s.finish_time), breakMins: s.break_mins || 0, status: s.status,
  section: s.section || null, computedHours: s.computed_hours != null ? Number(s.computed_hours) : null,
});
const mapReq = (r: any) => r && ({ id: r.id, shiftId: r.shift_id, kind: r.kind, status: r.status, fromStaffId: r.from_staff_id, toStaffId: r.to_staff_id, note: r.note || null });
const mapStaff = (s: any) => ({ id: s.id, name: s.name, roleKey: s.role_key, status: s.status, locationId: s.location_id, mobile: s.mobile || null });
const SHIFT_COLS = 'id, location_id, staff_id, role_key, shift_date, start_time, finish_time, break_mins, status, section, computed_hours';
// Reasons that mean the shift is simply not for this person: it is left out of their list.
const HIDDEN = new Set(['not_published', 'past', 'not_on_team', 'own', 'role', 'not_offered', 'offered_elsewhere']);

/** The swaps part of the snapshot: what I can take, offers to me, my requests, my colleagues. */
export async function swapsSnapshot(admin: Admin, staff: any, v: Venue) {
  const loc = staff.location_id;
  const horizon = addDays(v.todayIso, 21);
  const since = new Date(Date.now() - 14 * 86400000).toISOString();
  const [{ data: live }, { data: mineRows }, { data: openRows }, { data: myShifts }, { data: team }, { data: roles }, { data: vs }, { data: av }, { data: leave }] = await Promise.all([
    admin.from('wf_swap_requests').select('id, shift_id, kind, status, from_staff_id, to_staff_id, note, created_at').eq('location_id', loc).in('status', ['open', 'pending']).limit(500),
    admin.from('wf_swap_requests').select('id, shift_id, kind, status, from_staff_id, to_staff_id, note, decided_how, decided_at, created_at, updated_at, shift_snapshot')
      .eq('location_id', loc).or(`from_staff_id.eq.${staff.id},to_staff_id.eq.${staff.id}`).gte('updated_at', since).order('updated_at', { ascending: false }).limit(40),
    admin.from('wf_shifts').select(SHIFT_COLS).eq('location_id', loc).is('staff_id', null).eq('status', 'published')
      .gte('shift_date', v.todayIso).lte('shift_date', horizon).order('shift_date').limit(200),
    admin.from('wf_shifts').select(SHIFT_COLS).eq('staff_id', staff.id).in('status', ['draft', 'published'])
      .gte('shift_date', addDays(v.todayIso, -7)).lte('shift_date', addDays(horizon, 7)).limit(300),
    admin.from('wf_staff').select('id, name, role_key, status, location_id').eq('location_id', loc).eq('status', 'active').limit(1000),
    admin.from('wf_roles').select('key, label').eq('location_id', loc),
    admin.from('wf_venue_settings').select('settings').eq('location_id', loc).maybeSingle(),
    admin.from('wf_availability').select('per_day, updated_at, created_at').eq('staff_id', staff.id).order('updated_at', { ascending: false }).order('created_at', { ascending: false }).limit(1),
    admin.from('wf_time_off').select('status, start_date, end_date').eq('staff_id', staff.id).eq('status', 'approved'),
  ]);
  const liveReqs = (live ?? []).map(mapReq);
  const reqByShift: Record<string, any> = {};
  for (const r of liveReqs) if (r.shiftId) reqByShift[r.shiftId] = r;
  // Shifts someone has put up (dropped or offered), at this venue.
  const upIds = liveReqs.filter((r: any) => r.shiftId && (r.kind === 'drop' || r.kind === 'offer')).map((r: any) => r.shiftId);
  const mineShiftIds = (mineRows ?? []).map((r: any) => r.shift_id).filter(Boolean);
  const wantIds = [...new Set([...upIds, ...mineShiftIds])];
  const { data: upRows } = wantIds.length
    ? await admin.from('wf_shifts').select(SHIFT_COLS).in('id', wantIds).eq('location_id', loc)
    : { data: [] };
  const shiftById: Record<string, any> = {};
  for (const s of [...(openRows ?? []), ...(upRows ?? [])]) shiftById[s.id] = mapShift(s);
  const nameOf: Record<string, string> = {};
  for (const t of team ?? []) nameOf[t.id] = t.name;
  const roleLabel: Record<string, string> = {};
  for (const r of roles ?? []) roleLabel[r.key] = r.label || r.key;
  const settings = vs?.settings ?? {};
  const me = { id: staff.id, locationId: loc, status: staff.status, roleKey: staff.role_key };
  const theirShifts = (myShifts ?? []).map(mapShift);
  const availability = av?.[0] ? { perDay: Array.isArray(av[0].per_day) ? av[0].per_day : [] } : null;
  const leaveRows = (leave ?? []).map((l: any) => ({ status: l.status, startDate: l.start_date, endDate: l.end_date }));

  const judge = (sh: any, rq: any) => claimProblem({ shift: sh, claimer: me, request: rq || null, theirShifts, leave: leaveRows, availability,
    settings, todayIso: v.todayIso, nowMin: v.nowMin, roleLabel: roleLabel[sh.roleKey], country: v.country });
  const card = (sh: any, rq: any, why: any) => ({
    shiftId: sh.id, requestId: rq?.id || null, kind: rq?.kind === 'offer' ? 'offer' : sh.staffId ? 'drop' : 'open',
    date: sh.date, start: sh.start, finish: sh.finish, breakMins: sh.breakMins, section: sh.section,
    role: roleLabel[sh.roleKey] || sh.roleKey || null, fromName: rq?.fromStaffId ? (nameOf[rq.fromStaffId] || 'A colleague') : null,
    note: rq?.note || null, why: why ? why.text : null, whyCode: why ? why.code : null,
  });

  const open: any[] = [], offers: any[] = [];
  for (const sh of Object.values(shiftById)) {
    if (sh.date < v.todayIso || sh.date > horizon) continue;
    const rq = reqByShift[sh.id] || null;
    if (sh.staffId && !(rq && (rq.kind === 'drop' || rq.kind === 'offer'))) continue;
    const why = judge(sh, rq);
    if (why && HIDDEN.has(why.code)) continue;
    if (rq?.kind === 'offer') offers.push(card(sh, rq, why)); else open.push(card(sh, rq, why));
  }
  const byWhen = (a: any, b: any) => (a.date + a.start).localeCompare(b.date + b.start);
  open.sort(byWhen); offers.sort(byWhen);

  const mine = (mineRows ?? []).filter((r: any) => !(r.kind === 'offer' && r.status === 'open' && r.to_staff_id === staff.id)).map((r: any) => {
    const sh = shiftById[r.shift_id];
    const snap = r.shift_snapshot || {};
    const giving = r.from_staff_id === staff.id;
    const other = giving ? r.to_staff_id : r.from_staff_id;
    return {
      requestId: r.id, kind: r.kind, status: r.status, side: giving ? 'giving' : 'taking',
      date: sh?.date || snap.date || null, start: sh?.start || snap.start || null, finish: sh?.finish || snap.finish || null,
      otherName: other ? (nameOf[other] || 'A colleague') : null, decidedHow: r.decided_how || null, at: r.updated_at,
    };
  }).filter((m: any) => m.date);

  return {
    swaps: {
      mode: swapMode(settings),
      open, offers, mine,
      colleagues: (team ?? []).filter((t: any) => t.id !== staff.id).map((t: any) => ({ id: t.id, name: t.name, roleKey: t.role_key })),
      upShiftIds: liveReqs.filter((r: any) => r.fromStaffId === staff.id && r.shiftId).map((r: any) => r.shiftId),
    },
    availability: availability || { perDay: [] },
  };
}

const err = (status: number, error: string, code?: string) => ({ status, body: { error, ...(code ? { code } : {}) } });

async function auditSwap(admin: Admin, staff: any, action: string, entityId: string, after: unknown) {
  const { error } = await writeWfAudit(admin, staff.location_id, staff.org_id, action, {
    actorId: null, actorName: `${staff.name} (staff app)`, entity: 'wf_swap_requests', entityId: String(entityId || ''), after,
  });
  if (error) console.error(`[staff-portal] audit ${action}: ${error}`);
}

/** Who could take this shift now (the same rules), with their mobiles, for the "open shift" text. */
async function whoCouldTake(admin: Admin, shift: any, ownerId: string | null, request: any, v: Venue) {
  const { data: team } = await admin.from('wf_staff').select('id, name, role_key, status, location_id, mobile').eq('location_id', shift.locationId).eq('status', 'active').limit(1000);
  const people = eligibleStaff(shift, (team ?? []).map(mapStaff), ownerId);
  if (!people.length) return [];
  const ids = people.map((p: any) => p.id);
  const mon = addDays(shift.date, -7), sun = addDays(shift.date, 7);
  const [{ data: sh }, { data: lv }, { data: av }, { data: vs }] = await Promise.all([
    admin.from('wf_shifts').select(SHIFT_COLS).in('staff_id', ids).in('status', ['draft', 'published']).gte('shift_date', mon).lte('shift_date', sun).limit(5000),
    admin.from('wf_time_off').select('staff_id, status, start_date, end_date').in('staff_id', ids).eq('status', 'approved').lte('start_date', shift.date).gte('end_date', shift.date),
    admin.from('wf_availability').select('staff_id, per_day, updated_at, created_at').in('staff_id', ids).order('updated_at', { ascending: false }),
    admin.from('wf_venue_settings').select('settings').eq('location_id', shift.locationId).maybeSingle(),
  ]);
  const shiftsOf: Record<string, any[]> = {};
  for (const s of sh ?? []) (shiftsOf[s.staff_id] ||= []).push(mapShift(s));
  const availOf: Record<string, any> = {};
  for (const a of av ?? []) if (!availOf[a.staff_id]) availOf[a.staff_id] = { perDay: Array.isArray(a.per_day) ? a.per_day : [] };
  return people.filter((p: any) => !claimProblem({
    shift, claimer: p, request, theirShifts: shiftsOf[p.id] || [],
    leave: (lv ?? []).filter((l: any) => l.staff_id === p.id).map((l: any) => ({ status: l.status, startDate: l.start_date, endDate: l.end_date })),
    availability: availOf[p.id] || null, settings: vs?.settings ?? {}, todayIso: v.todayIso, nowMin: v.nowMin, country: v.country,
  }));
}

const DAY_STATES = new Set(['available', 'preferred', 'unavailable']);

/** The staff app's swap and availability actions. null when the action is not one of these. */
export async function handleSwapAction(admin: Admin, staff: any, action: string, body: any): Promise<{ status: number; body: any } | null> {
  if (!['shift_claim', 'shift_drop', 'swap_cancel', 'swap_decline', 'availability_set'].includes(action)) return null;

  if (action === 'availability_set') {
    const raw = Array.isArray(body.per_day) ? body.per_day : null;
    if (!raw) return err(400, 'Pick a choice for each day');
    const perDay = raw.map((d: any) => ({ day: Number(d?.day), state: String(d?.state || '') }))
      .filter((d: any) => Number.isInteger(d.day) && d.day >= 0 && d.day <= 6 && DAY_STATES.has(d.state));
    if (perDay.length !== raw.length || new Set(perDay.map((d: any) => d.day)).size !== perDay.length) return err(400, 'Pick a choice for each day');
    perDay.sort((a: any, b: any) => a.day - b.day);
    const { data: rows } = await admin.from('wf_availability').select('id').eq('staff_id', staff.id).order('updated_at', { ascending: false }).limit(1);
    const w = rows?.[0]
      ? await admin.from('wf_availability').update({ per_day: perDay, recurring: true, week_start: null, updated_at: new Date().toISOString() }).eq('id', rows[0].id).eq('staff_id', staff.id)
      : await admin.from('wf_availability').insert({ location_id: staff.location_id, org_id: staff.org_id, staff_id: staff.id, recurring: true, week_start: null, per_day: perDay });
    if (w.error) return err(500, w.error.message);
    const { error } = await writeWfAudit(admin, staff.location_id, staff.org_id, 'availability.set', {
      actorId: null, actorName: `${staff.name} (staff app)`, entity: 'wf_availability', entityId: String(staff.id), after: { per_day: perDay },
    });
    if (error) console.error(`[staff-portal] audit availability.set: ${error}`);
    return { status: 200, body: { ok: true, perDay } };
  }

  const v = await venueFacts(admin, staff.location_id);

  if (action === 'shift_claim') {
    const shiftId = String(body.shift_id || '');
    if (!UUID.test(shiftId)) return err(400, 'Pick a shift');
    const { data: r, error } = await admin.rpc('wf_shift_claim', { p_staff_id: staff.id, p_shift_id: shiftId });
    if (error) return err(500, error.message);
    if (!r?.ok) return err(409, problemText(r?.code), r?.code);
    const { data: shRow } = await admin.from('wf_shifts').select(SHIFT_COLS).eq('id', shiftId).maybeSingle();
    const sh = mapShift(shRow);
    await auditSwap(admin, staff, r.outcome === 'assigned' ? 'swap.claimed' : 'swap.claim_requested', r.request_id, { shift_id: shiftId, outcome: r.outcome, from_staff_id: r.from_staff_id || null });
    if (sh && r.outcome === 'assigned' && r.from_staff_id) {
      const { data: owner } = await admin.from('wf_staff').select('id, name, mobile').eq('id', r.from_staff_id).maybeSingle();
      if (owner) await notifyStaff(v, [owner], textTaken(v.name, staff.name, sh, v.country), { ref: r.request_id });
    }
    if (sh && r.outcome === 'pending') {
      try {
        await admin.from('activity_events').insert({
          location_id: staff.location_id, kind: 'staff', severity: 'info',
          title: `${staff.name} asked for the shift ${shiftWords(sh, v.country)}`,
          body: 'Approve or decline it in Back Office (Workforce, Rota) or the Manager app (Team).',
          ref_type: 'wf_swap_requests', ref_id: String(r.request_id), actor_name: `${staff.name} (staff app)`,
        });
      } catch { /* best effort */ }
      await notifyStaff(v, [staff], textAsked(v.name, sh, v.country), { ref: r.request_id });
    }
    return { status: 200, body: { ok: true, outcome: r.outcome } };
  }

  if (action === 'shift_drop') {
    const shiftId = String(body.shift_id || '');
    const to = body.to_staff_id ? String(body.to_staff_id) : null;
    if (!UUID.test(shiftId) || (to && !UUID.test(to))) return err(400, 'Pick a shift');
    const { data: r, error } = await admin.rpc('wf_shift_drop', { p_staff_id: staff.id, p_shift_id: shiftId, p_to_staff_id: to, p_note: String(body.note || '').slice(0, 300) || null });
    if (error) return err(500, error.message);
    if (!r?.ok) return err(409, problemText(r?.code), r?.code);
    const { data: shRow } = await admin.from('wf_shifts').select(SHIFT_COLS).eq('id', shiftId).maybeSingle();
    const sh = mapShift(shRow);
    await auditSwap(admin, staff, r.kind === 'offer' ? 'swap.offered' : 'swap.dropped', r.request_id, { shift_id: shiftId, to_staff_id: to });
    let texted = 0;
    if (sh && r.kind === 'offer' && to) {
      const { data: co } = await admin.from('wf_staff').select('id, name, mobile').eq('id', to).maybeSingle();
      if (co) texted = (await notifyStaff(v, [co], textOffered(v.name, staff.name, sh, v.country), { ref: r.request_id })).sent;
    } else if (sh) {
      const people = await whoCouldTake(admin, sh, staff.id, { id: r.request_id, kind: 'drop', status: 'open', fromStaffId: staff.id, toStaffId: null }, v);
      texted = (await notifyStaff(v, people, textOpenShift(v.name, sh, v.country), { ref: r.request_id })).sent;
    }
    return { status: 200, body: { ok: true, kind: r.kind, texted } };
  }

  const requestId = String(body.request_id || '');
  if (!UUID.test(requestId)) return err(400, 'Pick a request');
  if (action === 'swap_cancel') {
    const { data: r, error } = await admin.rpc('wf_swap_cancel', { p_staff_id: staff.id, p_request_id: requestId });
    if (error) return err(500, error.message);
    if (!r?.ok) return err(409, problemText(r?.code), r?.code);
    await auditSwap(admin, staff, 'swap.cancelled', requestId, { outcome: r.outcome });
    return { status: 200, body: { ok: true, outcome: r.outcome } };
  }
  // swap_decline
  const { data: r, error } = await admin.rpc('wf_swap_decline', { p_staff_id: staff.id, p_request_id: requestId });
  if (error) return err(500, error.message);
  if (!r?.ok) return err(409, problemText(r?.code), r?.code);
  await auditSwap(admin, staff, 'swap.offer_declined', requestId, { from_staff_id: r.from_staff_id });
  if (r.from_staff_id && r.shift_id) {
    const [{ data: owner }, { data: shRow }] = await Promise.all([
      admin.from('wf_staff').select('id, name, mobile').eq('id', r.from_staff_id).maybeSingle(),
      admin.from('wf_shifts').select(SHIFT_COLS).eq('id', r.shift_id).maybeSingle(),
    ]);
    const sh = mapShift(shRow);
    if (owner && sh) {
      await notifyStaff(v, [owner], textOfferDeclined(v.name, staff.name, sh, v.country), { ref: requestId });
    }
  }
  return { status: 200, body: { ok: true, outcome: 'declined' } };
}
