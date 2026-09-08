// supabase/functions/workforce-clock
//
// Server-side time clock for the dedicated clock surface (mode=clock). Paired
// clock devices authenticate ANONYMOUSLY, so they cannot write wf_timesheets
// directly (RLS fences those to back-office users by design). Instead the device
// calls this function, which runs with the service role and enforces access by
// validating the entered PIN against staff_members for the device's location —
// the same on-premise trust model as the POS PIN pad, but PINs are matched
// server-side (never exposed to the client).
//
// Actions { location_id, pin, action }:
//   status       → who they are + current state (out | in | break) + today's hours
//   in           → open a timesheet (clock_in=now), link today's published shift,
//                  snapshot the effective pay rate so pay is reproducible
//   break_start  → mark break open (break_open_at=now)
//   break_end    → accumulate break minutes, clear break_open_at
//   out          → close the open break if any, set clock_out, compute
//                  actual_hours (minus breaks), variance vs scheduled, pay_amount
//
// A POS user with no wf_staff record yet is auto-given a minimal HR record on
// first clock-in (so they appear in Workforce → Staff), keeping it seamless.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const admin = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const round2 = (n: number) => Math.round(n * 100) / 100;
const initialsOf = (name: string) => (name || '').split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2) || '?';
const todayIso = () => new Date().toISOString().slice(0, 10);

async function orgFor(loc: string): Promise<string | null> {
  const { data } = await admin.from('locations').select('org_id').eq('id', loc).single();
  return data?.org_id ?? null;
}

/** Effective hourly rate for a wf_staff member: override → role base → salaried equiv. */
async function resolveRate(staff: any, loc: string): Promise<{ rate: number; source: string }> {
  if (staff.rate_override != null) return { rate: Number(staff.rate_override), source: 'override' };
  if (staff.role_key) {
    const { data: role } = await admin.from('wf_roles')
      .select('base_rate, salary_annual, contracted_week').eq('location_id', loc).eq('key', staff.role_key).maybeSingle();
    if (role?.base_rate != null) return { rate: Number(role.base_rate), source: 'base' };
    if (role?.salary_annual) return { rate: Number(role.salary_annual) / 52 / Number(role.contracted_week || 40), source: 'salaried' };
  }
  return { rate: 0, source: 'none' };
}

/** Get (or auto-create) the wf_staff record linked to a POS user. */
async function ensureWfStaff(member: any, loc: string, org: string | null) {
  const { data: existing } = await admin.from('wf_staff')
    .select('*').eq('location_id', loc).eq('pos_user_id', member.id).neq('status', 'leaver').maybeSingle();
  if (existing) return existing;
  const { data: created, error } = await admin.from('wf_staff').insert({
    location_id: loc, org_id: org, name: member.name, role_key: null, contract_type: 'partTime',
    primary_venue_id: loc, venue_ids: [loc], status: 'active', pos_user_id: member.id,
  }).select().single();
  if (error) throw new Error('could not create staff record: ' + error.message);
  return created;
}

function stateOf(open: any): { state: string; since: string | null; onBreak: boolean; breakSince: string | null } {
  if (!open) return { state: 'out', since: null, onBreak: false, breakSince: null };
  if (open.break_open_at) return { state: 'break', since: open.clock_in, onBreak: true, breakSince: open.break_open_at };
  return { state: 'in', since: open.clock_in, onBreak: false, breakSince: null };
}


// How many onboarding steps are genuinely open, derived from EVIDENCE — the
// stored steps array goes stale (it predates POS access / bank details landing
// via other paths). An explicitly-complete stored step still counts as done.
function openOnboardingSteps(row: any, staff: any): number {
  if (!row) return 0;
  const meta = row.meta || {};
  const done: Record<string, boolean> = {
    offer: !!(meta.offerAccepted || meta.offerSentAt),
    contract: !!meta.signature,
    rtw: !!meta.rtwPath,
    bank: !!(meta.bankMasked || staff?.bank_account_masked),
    posUser: !!staff?.pos_user_id,
  };
  (Array.isArray(row.steps) ? row.steps : []).forEach((st: any) => {
    if (st?.status === 'complete' && st.key in done) done[st.key] = true;
  });
  return Object.values(done).filter(v => !v).length;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const authHeader = req.headers.get('Authorization') ?? '';
  const bearer = authHeader.replace('Bearer ', '');
  // The staff app (staff-portal) clocks OUT through here with the service role
  // and an already-authenticated staff_id, so the hours, statutory-break and
  // pay maths below stays the ONE implementation. Without this seam the phone
  // path would need its own copy, and two copies of pay maths always drift.
  const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const isService = !!SERVICE_ROLE && bearer === SERVICE_ROLE;

  let body: Record<string, any>;
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const { location_id, pin, action } = body;
  const staffIdIn = isService ? body.staff_id : null;   // never honoured from a client

  if (!isService) {
    const { data: { user } } = await admin.auth.getUser(bearer);
    if (!user) return json({ error: 'unauthorized' }, 401); // valid (incl. anonymous) session required
  }
  if (!location_id || !action) return json({ error: 'location_id and action required' }, 400);
  if (!staffIdIn && !pin) return json({ error: 'pin required' }, 400);

  try {
    let member: any;
    let staff: any;
    let org: any;
    if (staffIdIn) {
      // Service-role path: the caller already proved who this is (staff-portal
      // resolves it from the portal JWT), so there is no PIN to check. Still
      // fenced to the venue, so a wrong location_id cannot reach someone else's
      // timesheet.
      const { data: sRow } = await admin.from('wf_staff')
        .select('*').eq('id', staffIdIn).eq('location_id', location_id).maybeSingle();
      if (!sRow) return json({ error: 'staff not found at this location' }, 404);
      staff = sRow;
      org = sRow.org_id ?? await orgFor(location_id);
      member = { id: sRow.pos_user_id ?? sRow.id, name: sRow.full_name ?? sRow.name ?? 'Staff',
                 role: sRow.role_key ?? null, color: '#15C26A', initials: null };
    } else {
      // Validate the PIN against active POS users at this location.
      const { data: members } = await admin.from('staff_members')
        .select('id, name, role, color, initials, active, pin').eq('location_id', location_id).eq('active', true);
      member = (members ?? []).find((m: any) => m.pin && String(m.pin) === String(pin));
      if (!member) return json({ error: 'PIN not recognised' }, 404);
      org = await orgFor(location_id);
      staff = await ensureWfStaff(member, location_id, org);
    }

    // Current open timesheet (no clock_out), latest first.
    const { data: openRows } = await admin.from('wf_timesheets')
      .select('*').eq('location_id', location_id).eq('staff_id', staff.id).is('clock_out', null)
      .order('clock_in', { ascending: false }).limit(1);
    const open = openRows?.[0] ?? null;

    const who = { name: member.name, initials: member.initials || initialsOf(member.name), color: member.color || '#15C26A', role: member.role };
    const now = new Date();

    if (action === 'status') {
      // "In-app" announcements land HERE: the Time Clock is the staff-facing
      // surface, so the last fortnight's messages (audience: all, or their
      // role) show whenever someone enters their PIN.
      const fortnightAgo = new Date(now.getTime() - 14 * 86400000).toISOString();
      const { data: ann } = await admin.from('wf_announcements')
        .select('body, audience, author_name, created_at')
        .eq('location_id', location_id).gte('created_at', fortnightAgo)
        .order('created_at', { ascending: false }).limit(10);
      const roleLc = String(member.role || '').toLowerCase();
      const announcements = (ann ?? []).filter((a: any) => {
        const k = a.audience?.kind;
        if (!k || k === 'all') return true;
        if (k === 'role') return String(a.audience?.value || '').toLowerCase() === roleLc;
        return false; // section-targeted stay in the BO feed for now
      }).slice(0, 3).map((a: any) => ({ body: a.body, author: a.author_name, at: a.created_at }));
      // v5.6.0 — outstanding work flagged AT THE CLOCK. The clock is the one
      // surface everyone touches every shift, so it is where "you have training
      // to do" actually gets seen. Read-only: they DO the training in the staff
      // app on their own phone, never here (that would tie up the tablet).
      let outstanding = { training: [], onboardingOpen: 0, total: 0 };
      try {
        const todayIso = now.toISOString().slice(0, 10);
        const [{ data: tr }, { data: onbRows }] = await Promise.all([
          admin.from('wf_training_assignments')
            .select('due_date, status, wf_training_modules(name)')
            .eq('staff_id', staff.id).eq('location_id', location_id).neq('status', 'complete'),
          admin.from('wf_onboarding').select('steps, meta').eq('staff_id', staff.id)
            .order('created_at', { ascending: false }).limit(1),
        ]);
        const training = (tr ?? []).map((a: any) => ({
          name: a.wf_training_modules?.name || 'Training',
          due: a.due_date,
          overdue: !!(a.due_date && a.due_date < todayIso),
        }));
        const onboardingOpen = openOnboardingSteps(onbRows?.[0], staff);
        outstanding = { training, onboardingOpen, total: training.length + onboardingOpen };
      } catch (e) { console.error('[workforce-clock] outstanding:', (e as Error).message); }
      // Does this venue want the till to offer a shift start on first sign-in?
      // The POS cannot read wf_venue_settings itself (RLS is scoped to Back
      // Office users, and a till runs an anonymous device session), so the
      // policy travels back with the status it already asks for.
      let posLoginClockIn = false;
      try {
        const { data: gs } = await admin.from('wf_venue_settings')
          .select('clock_geofence').eq('location_id', location_id).maybeSingle();
        posLoginClockIn = !!(gs?.clock_geofence as any)?.pos_login_clock_in;
      } catch { /* policy is optional; never block a status read */ }
      return json({ ok: true, staff: who, ...stateOf(open), announcements, outstanding, posLoginClockIn });
    }

    if (action === 'in') {
      if (open) return json({ error: 'already clocked in', staff: who, ...stateOf(open) }, 409);
      // Link today's published shift (if scheduled) + snapshot the rate.
      const { data: shifts } = await admin.from('wf_shifts')
        .select('id, computed_hours, effective_rate, rate_source, section')
        .eq('location_id', location_id).eq('staff_id', staff.id).eq('shift_date', todayIso()).eq('status', 'published').limit(1);
      const shift = shifts?.[0] ?? null;
      let rate = shift?.effective_rate != null ? Number(shift.effective_rate) : null;
      let source = shift?.rate_source ?? null;
      if (rate == null) { const r = await resolveRate(staff, location_id); rate = r.rate; source = r.source; }
      const { error } = await admin.from('wf_timesheets').insert({
        location_id, org_id: org, staff_id: staff.id, shift_id: shift?.id ?? null,
        clock_in: now.toISOString(), break_taken: 0,
        scheduled_hours: shift?.computed_hours ?? null,
        effective_rate: rate, rate_source: source, currency: 'GBP', status: 'pending',
      });
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, staff: who, state: 'in', since: now.toISOString() });
    }

    if (action === 'break_start') {
      if (!open) return json({ error: 'not clocked in' }, 409);
      if (open.break_open_at) return json({ error: 'already on break', staff: who, ...stateOf(open) }, 409);
      const { error } = await admin.from('wf_timesheets').update({ break_open_at: now.toISOString() }).eq('id', open.id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, staff: who, state: 'break', since: open.clock_in, breakSince: now.toISOString() });
    }

    if (action === 'break_end') {
      if (!open) return json({ error: 'not clocked in' }, 409);
      if (!open.break_open_at) return json({ error: 'not on break' }, 409);
      const mins = Math.max(0, Math.round((now.getTime() - new Date(open.break_open_at).getTime()) / 60000));
      // Keep the segment (start/end) so managers can see WHEN the break was,
      // not just how long — needed for UK rest-break compliance checks.
      const segs = Array.isArray(open.breaks) ? open.breaks : [];
      const { error } = await admin.from('wf_timesheets')
        .update({ break_taken: (open.break_taken || 0) + mins, break_open_at: null, breaks: [...segs, { start: open.break_open_at, end: now.toISOString() }] }).eq('id', open.id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, staff: who, state: 'in', since: open.clock_in, breakAdded: mins });
    }

    if (action === 'out') {
      if (!open) return json({ error: 'not clocked in' }, 409);
      let breakTaken = open.break_taken || 0;
      if (open.break_open_at) breakTaken += Math.max(0, Math.round((now.getTime() - new Date(open.break_open_at).getTime()) / 60000));
      const grossHrs = (now.getTime() - new Date(open.clock_in).getTime()) / 3600000;

      // v5.5.969 — VENUE BREAK POLICY at clock-out.
      // (a) Auto-deduct: no break punched + shift over the venue threshold →
      //     deduct the venue default, FLOORED at the UK statutory minimum for
      //     the worker's age (WTR 1998: 20 min over 6h; under-18s 30 min over
      //     4.5h) so a venue cannot configure itself below the law.
      // (b) Paid breaks: the existing "Breaks are paid" venue setting finally
      //     applies to CLOCK-PUNCHED sheets too (it always promised "new
      //     timesheets" but only BO-created ones honoured it).
      // OFF by default — no venue's pay records change until they opt in.
      const { data: vsRow } = await admin.from('wf_venue_settings')
        .select('settings').eq('location_id', location_id).maybeSingle();
      const vs = vsRow?.settings || {};
      let autoApplied = 0;
      if (breakTaken === 0 && vs.autoBreak === true) {
        const defMins = Math.max(0, Number(vs.defaultBreakMins ?? 30));
        const threshold = Math.max(1, Number(vs.autoBreakHours ?? 6));
        if (grossHrs > threshold && defMins > 0) {
          let statutory = grossHrs > 6 ? 20 : 0;
          const dob = staff?.dob ? new Date(staff.dob) : null;
          if (dob && !isNaN(dob.getTime())) {
            const age = (now.getTime() - dob.getTime()) / (365.25 * 86400000);
            if (age < 18 && grossHrs > 4.5) statutory = Math.max(statutory, 30);
          }
          autoApplied = Math.max(defMins, statutory);
          breakTaken = autoApplied;
        }
      }

      const actual = round2(Math.max(0, grossHrs - breakTaken / 60));
      const scheduled = open.scheduled_hours != null ? Number(open.scheduled_hours) : null;
      const variance = scheduled != null ? round2(actual - scheduled) : null;
      const rate = open.effective_rate != null ? Number(open.effective_rate) : 0;
      // Paid-break venues pay the break minutes on top of worked hours — the
      // exact formula the timesheet editor uses (WfTimesheets editCalc).
      const paidBreakMins = vs.paidBreaks === true ? breakTaken : 0;
      const pay = round2(Math.max(0, actual + paidBreakMins / 60) * rate);
      const update: Record<string, unknown> = {
        clock_out: now.toISOString(), break_taken: breakTaken, break_open_at: null,
        actual_hours: actual, variance, pay_amount: pay, status: 'pending',
        paid_break_mins: paidBreakMins,
      };
      if (autoApplied > 0) {
        // Visible audit trail: managers see WHY 30 min vanished with no punches.
        const segs = Array.isArray(open.breaks) ? open.breaks : [];
        update.breaks = [...segs, { auto: true, mins: autoApplied, at: now.toISOString() }];
      }
      const { error } = await admin.from('wf_timesheets').update(update).eq('id', open.id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, staff: who, state: 'out', actualHours: actual, breakMins: breakTaken, autoBreak: autoApplied || undefined, pay });
    }

    return json({ error: `unknown action "${action}"` }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
