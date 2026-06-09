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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const authHeader = req.headers.get('Authorization') ?? '';
  const { data: { user } } = await admin.auth.getUser(authHeader.replace('Bearer ', ''));
  if (!user) return json({ error: 'unauthorized' }, 401); // valid (incl. anonymous) session required

  let body: Record<string, any>;
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const { location_id, pin, action } = body;
  if (!location_id || !pin || !action) return json({ error: 'location_id, pin and action required' }, 400);

  try {
    // Validate the PIN against active POS users at this location.
    const { data: members } = await admin.from('staff_members')
      .select('id, name, role, color, initials, active, pin').eq('location_id', location_id).eq('active', true);
    const member = (members ?? []).find((m: any) => m.pin && String(m.pin) === String(pin));
    if (!member) return json({ error: 'PIN not recognised' }, 404);

    const org = await orgFor(location_id);
    const staff = await ensureWfStaff(member, location_id, org);

    // Current open timesheet (no clock_out), latest first.
    const { data: openRows } = await admin.from('wf_timesheets')
      .select('*').eq('location_id', location_id).eq('staff_id', staff.id).is('clock_out', null)
      .order('clock_in', { ascending: false }).limit(1);
    const open = openRows?.[0] ?? null;

    const who = { name: member.name, initials: member.initials || initialsOf(member.name), color: member.color || '#15C26A', role: member.role };
    const now = new Date();

    if (action === 'status') {
      return json({ ok: true, staff: who, ...stateOf(open) });
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
      const { error } = await admin.from('wf_timesheets')
        .update({ break_taken: (open.break_taken || 0) + mins, break_open_at: null }).eq('id', open.id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, staff: who, state: 'in', since: open.clock_in, breakAdded: mins });
    }

    if (action === 'out') {
      if (!open) return json({ error: 'not clocked in' }, 409);
      let breakTaken = open.break_taken || 0;
      if (open.break_open_at) breakTaken += Math.max(0, Math.round((now.getTime() - new Date(open.break_open_at).getTime()) / 60000));
      const grossHrs = (now.getTime() - new Date(open.clock_in).getTime()) / 3600000;
      const actual = round2(Math.max(0, grossHrs - breakTaken / 60));
      const scheduled = open.scheduled_hours != null ? Number(open.scheduled_hours) : null;
      const variance = scheduled != null ? round2(actual - scheduled) : null;
      const rate = open.effective_rate != null ? Number(open.effective_rate) : 0;
      const pay = round2(actual * rate);
      const { error } = await admin.from('wf_timesheets').update({
        clock_out: now.toISOString(), break_taken: breakTaken, break_open_at: null,
        actual_hours: actual, variance, pay_amount: pay, status: 'pending',
      }).eq('id', open.id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, staff: who, state: 'out', actualHours: actual, breakMins: breakTaken, pay });
    }

    return json({ error: `unknown action "${action}"` }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
