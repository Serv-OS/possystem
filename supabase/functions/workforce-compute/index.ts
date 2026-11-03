// supabase/functions/workforce-compute
// MARKER 5.11.101 workforce-compute premiums and region
//
// Server-side compute for pay-critical Workforce maths. The client NEVER
// computes money for persistence — it calls this function, which runs with the
// service role (bypasses RLS) and therefore enforces the tenant fence itself by
// checking the caller's location access (mirroring user_accessible_locations).
//
// Actions:
//   tronc.run    { location_id, week_start, pool }  → largest-remainder split of
//                  the tip pool across published-shift hours × role points;
//                  writes wf_tronc_runs + wf_tronc_lines + a tamper-evident audit.
//   accrual.run  { location_id }                    → 12.07% (or venue rate) of
//                  approved timesheet hours → wf_holiday_accrual (idempotent).
//   pay.period   { location_id }                    → per-staff pay from approved
//                  timesheets (read-only summary).
//   labour       { location_id, from, to }          → daily closed_checks revenue.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { secondStepRefusal } from '../_shared/second-step.ts';
import { writeWfAudit } from '../_shared/wfAudit.js';
// v5.11.101: the venue's region (currency, US overtime) and the pay premiums, applied at last.
import { regionPack } from '../_shared/regionPack.js';
import { premiumFor, anyPremium, overtimeSplit, venueMidnightIso, workweekSpan, venueDay } from '../_shared/payPremiums.js';
import { tipCreditTopUps } from '../_shared/tipCredit.js';
import { ptoRules, ptoAccruals } from '../_shared/usPto.js';
import { caRules, caOvertimeAcrossSites } from '../_shared/caOvertime.js';
import { primaryRecord, personBalance } from '../_shared/primaryLocation.js';
import { acaReport, monthsBetween } from '../_shared/acaHours.js';
import { overtimeAcrossSites, overtimeRules } from '../_shared/multiSiteOvertime.js';
import { headOfficeOn, isHeadOffice, headOfficePay } from '../_shared/headOffice.js';

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

/** Append a tamper-evident audit row (prev_hash/row_hash chain per location). v5.10.3: the chain
 *  writer lives in _shared/wfAudit.js (same read, hash and columns as the copy that was here) so
 *  manager-approve writes the same chain. The action has already landed when this runs, so a
 *  failed audit is logged, not answered, exactly as before (it used to be dropped silently). */
async function writeAudit(loc: string, org: string | null, action: string, d: Record<string, unknown> = {}) {
  const { error } = await writeWfAudit(admin, loc, org, action, d);
  if (error) console.error(`[workforce-compute] ${action}: ${error}`);
}

/** Largest-remainder allocation of a pool (£) across weighted units → pennies. */
function allocate(pool: number, rows: { staff_id: string; hours: number; points: number }[]) {
  const poolCents = Math.round(pool * 100);
  const totalUnits = rows.reduce((a, r) => a + r.hours * r.points, 0);
  if (poolCents <= 0 || totalUnits <= 0) {
    return { totalUnits, pointValue: 0, totalPaid: 0, residual: round2(pool),
      lines: rows.map(r => ({ ...r, units: r.hours * r.points, sharePct: 0, payout: 0 })) };
  }
  const calc = rows.map((r, i) => {
    const units = r.hours * r.points;
    const exact = (poolCents * units) / totalUnits;
    const floor = Math.floor(exact);
    return { i, units, sharePct: units / totalUnits, floor, frac: exact - floor };
  });
  const cents = calc.map(c => c.floor);
  const remainder = poolCents - cents.reduce((a, c) => a + c, 0);
  const order = [...calc].sort((a, b) => b.frac - a.frac || b.units - a.units || a.i - b.i);
  for (let k = 0; k < remainder; k++) cents[order[k % order.length].i] += 1;
  const lines = calc.map((c, idx) => ({ ...rows[idx], units: c.units, sharePct: c.sharePct, payout: cents[idx] / 100 }));
  const totalPaid = cents.reduce((a, c) => a + c, 0) / 100;
  return { totalUnits, pointValue: poolCents / 100 / totalUnits, totalPaid, residual: round2(poolCents / 100 - totalPaid), lines };
}

async function orgFor(loc: string): Promise<string | null> {
  return (await venueOf(loc)).org_id;
}

/** The venue's company, currency and timezone (v5.11.101: tronc and payroll in the venue's money). */
async function venueOf(loc: string): Promise<{ org_id: string | null; currency: string; timezone: string }> {
  const { data } = await admin.from('locations').select('org_id, currency, timezone').eq('id', loc).single();
  return { org_id: data?.org_id ?? null, currency: String(data?.currency || 'GBP').toUpperCase(), timezone: data?.timezone || 'Europe/London' };
}

/** Enforce the tenant fence: caller must have access to the location (or be super_admin). */
// The same rule as the database's user_accessible_locations() after the stage 1 fence
// (20260919a section 4c): a user_locations row for the venue, or a super admin. Never the profile
// venue (user_profiles.location_id is only the venue Back Office opens on; before file A any login
// could set its own to any venue), never an anonymous session.
async function assertAccess(user: { id?: string; is_anonymous?: boolean } | null, loc: string): Promise<boolean> {
  if (!user?.id || user.is_anonymous) return false;
  const [{ data: ul }, { data: prof }] = await Promise.all([
    admin.from('user_locations').select('location_id').eq('user_id', user.id).eq('location_id', loc).limit(1),
    admin.from('user_profiles').select('role').eq('id', user.id).maybeSingle(),
  ]);
  if (prof?.role === 'super_admin') return true;
  return Array.isArray(ul) && ul.length > 0;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const secondStepBlock = await secondStepRefusal(req); if (secondStepBlock) return secondStepBlock; // docs/SECOND_STEP.md
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const authHeader = req.headers.get('Authorization') ?? '';
  const { data: { user } } = await admin.auth.getUser(authHeader.replace('Bearer ', ''));
  if (!user) return json({ error: 'unauthorized' }, 401);

  let body: Record<string, any>;
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }

  const { action, location_id } = body;
  if (!action) return json({ error: 'action required' }, 400);
  if (!location_id) return json({ error: 'location_id required' }, 400);
  if (!(await assertAccess(user, String(location_id)))) return json({ error: 'forbidden' }, 403);

  const venue = await venueOf(location_id);
  const org = venue.org_id;
  const pack = regionPack({ currency: venue.currency });
  const cur = pack.currency;      // GBP for a UK venue: every row and audit line reads as before
  const sym = pack.currencySymbol;

  try {
    // ── TRONC RUN ────────────────────────────────────────────────────────────
    if (action === 'tronc.run') {
      const { week_start, pool } = body;
      if (!week_start) return json({ error: 'week_start required' }, 400);
      const poolNum = Number(pool) || 0;
      const weekEnd = (() => { const d = new Date(week_start + 'T00:00:00'); d.setDate(d.getDate() + 6); return d.toISOString().slice(0, 10); })();
      const weekEndExcl = (() => { const d = new Date(week_start + 'T00:00:00'); d.setDate(d.getDate() + 7); return d.toISOString().slice(0, 10); })();

      // Immutability check + shifts + roles + (fallback) timesheets/staff — independent → in parallel.
      const [{ data: existing }, { data: shifts }, { data: roles }, { data: tsheets }, { data: staffRows }] = await Promise.all([
        admin.from('wf_tronc_runs').select('id, status').eq('location_id', location_id).eq('week_start', week_start).maybeSingle(),
        // v5.11.101: an open shift (nobody on it) shares no tips.
        admin.from('wf_shifts').select('staff_id, computed_hours, role_key')
          .eq('location_id', location_id).gte('shift_date', week_start).lte('shift_date', weekEnd).eq('status', 'published').not('staff_id', 'is', null),
        admin.from('wf_roles').select('key, tronc_weight').eq('location_id', location_id),
        admin.from('wf_timesheets').select('staff_id, actual_hours')
          .eq('location_id', location_id).in('status', ['approved', 'paid']).gte('clock_in', week_start).lt('clock_in', weekEndExcl),
        admin.from('wf_staff').select('id, role_key').eq('location_id', location_id),
      ]);
      if (existing && existing.status !== 'draft') return json({ error: `a ${existing.status} tronc run already exists for this week` }, 409);
      if (existing) await admin.from('wf_tronc_runs').delete().eq('id', existing.id).eq('status', 'draft'); // draft → replace (lines cascade)
      const pts: Record<string, number> = {}; (roles ?? []).forEach((r: any) => { pts[r.key] = Number(r.tronc_weight ?? 1); });
      const staffRole: Record<string, string> = {}; (staffRows ?? []).forEach((s: any) => { staffRole[s.id] = s.role_key; });

      // Distribute over PUBLISHED rota hours. If there's no published rota for the week, fall back to
      // ACTUAL worked hours from approved timesheets — so a venue that clocks staff in without publishing
      // a rota can still share tips (previously this just errored "publish the rota first").
      const byStaff: Record<string, { hours: number; role: string }> = {};
      if (shifts && shifts.length) {
        shifts.forEach((s: any) => {
          const b = byStaff[s.staff_id] ?? (byStaff[s.staff_id] = { hours: 0, role: s.role_key });
          b.hours += Number(s.computed_hours || 0);
        });
      } else if (tsheets && tsheets.length) {
        tsheets.forEach((t: any) => {
          const b = byStaff[t.staff_id] ?? (byStaff[t.staff_id] = { hours: 0, role: staffRole[t.staff_id] || '' });
          b.hours += Number(t.actual_hours || 0);
        });
      }
      const rows = Object.entries(byStaff)
        .map(([staff_id, v]) => ({ staff_id, hours: round2(v.hours), points: pts[v.role] ?? 1 }))
        .filter((r) => r.hours > 0);
      if (!rows.length) return json({ error: 'No staff hours for this week — there’s no one to share the tips across. Publish the rota or approve some timesheets for this week first, then run it again.' }, 400);

      const res = allocate(poolNum, rows);
      const { data: run, error: runErr } = await admin.from('wf_tronc_runs').insert({
        location_id, org_id: org, week_start, currency: cur, pool: poolNum,
        units_total: res.totalUnits, point_value: res.pointValue, total_paid: res.totalPaid, residual: res.residual,
        status: 'run', lines: res.lines,
      }).select().single();
      if (runErr) return json({ error: runErr.message }, 500);

      const lineRows = res.lines.map(l => ({
        run_id: run.id, location_id, org_id: org, staff_id: l.staff_id,
        hours: round2(l.hours), points: l.points, units: l.units, share_pct: l.sharePct, payout: l.payout, currency: cur,
      }));
      const { error: linesErr } = await admin.from('wf_tronc_lines').insert(lineRows);
      if (linesErr) { await admin.from('wf_tronc_runs').delete().eq('id', run.id); return json({ error: linesErr.message }, 500); }

      await writeAudit(location_id, org, 'tronc.run', {
        actorId: user.id, amount: res.totalPaid, currency: cur, entity: 'wf_tronc_runs', entityId: run.id,
        reason: `pool ${sym}${poolNum.toFixed(2)} over ${rows.length} staff, residual ${sym}${res.residual.toFixed(2)}`,
        after: { week_start, pool: poolNum, total_paid: res.totalPaid },
      });
      return json({ ok: true, run_id: run.id, pool: poolNum, total_paid: res.totalPaid, residual: res.residual, point_value: res.pointValue, lines: res.lines });
    }

    // ── ACCRUAL RUN — UK: only HOURLY/irregular staff accrue 12.07% of hours.
    // Salaried/fixed staff get a fixed entitlement (28 days) tracked separately,
    // so they are skipped here.
    if (action === 'accrual.run') {
      // v5.11.101: the 12.07% accrual is a UK rule (holidayRules 'uk'); a US venue has no statutory
      // accrual, so it is off there for now and nothing is written.
      // 5.12.51: a US venue earns PTO by its own rule (_shared/usPto.js) when switched on; any other
      // region without a rule writes nothing.
      if (pack.holidayRules !== 'uk' && pack.holidayRules !== 'us') return json({ ok: true, accrued: 0, hours: 0, rate: 0, off: 'Holiday accrual is off for this country.' });
      const { data: settings } = await admin.from('wf_venue_settings').select('accrual_rate').eq('location_id', location_id).maybeSingle();
      const rate = Number(settings?.accrual_rate ?? 0.1207);
      // Classify staff: salaried (contract_type='salaried' or a salaried role with no hourly rate) → no accrual.
      const [{ data: staffRows }, { data: roleRows }] = await Promise.all([
        admin.from('wf_staff').select('id, contract_type, role_key, rate_override').eq('location_id', location_id),
        admin.from('wf_roles').select('key, base_rate, salary_annual').eq('location_id', location_id),
      ]);
      const roleByKey: Record<string, any> = {}; (roleRows ?? []).forEach((r: any) => { roleByKey[r.key] = r; });
      const staffById: Record<string, any> = {};
      (staffRows ?? []).forEach((x: any) => { staffById[x.id] = x; });
      const isHourly = (sid: string) => {
        const s = staffById[sid];
        if (!s) return true;
        if (s.contract_type === 'salaried') return false;
        if (s.rate_override != null) return true;
        const role = roleByKey[s.role_key];
        if (role && role.base_rate != null) return true;
        if (role && role.salary_annual != null && role.base_rate == null) return false; // salaried role
        return true; // default to hourly (accrues)
      };
      // 5.12.51: US PAID TIME OFF. Off until the venue switches it on (Workforce settings, Paid time off).
      // 1 hour for every N hours worked (default 30), capped per calendar year when a cap is set; hourly
      // staff only, as the UK rule. Same ledger, so balances, requests and payroll work unchanged.
      if (pack.holidayRules === 'us') {
        const { data: vsr } = await admin.from('wf_venue_settings').select('settings').eq('location_id', location_id).maybeSingle();
        const rules = ptoRules((vsr as any)?.settings ?? null);
        if (!rules.on) return json({ ok: true, accrued: 0, hours: 0, rate: 0, off: 'Paid time off is switched off (Workforce settings, Paid time off).' });
        const [{ data: usSheets }, { data: ledger }] = await Promise.all([
          admin.from('wf_timesheets').select('id, staff_id, actual_hours, effective_rate, currency, clock_in')
            .eq('location_id', location_id).in('status', ['approved', 'paid']).limit(20000),
          admin.from('wf_holiday_accrual').select('staff_id, accrued_hours, source_timesheet_id')
            .eq('location_id', location_id).eq('kind', 'accrual').not('source_timesheet_id', 'is', null).limit(20000),
        ]);
        const yearOf: Record<string, string> = {};
        (usSheets ?? []).forEach((t: any) => { yearOf[t.id] = String(venueDay(t.clock_in, venue.timezone) || '').slice(0, 4); });
        const earned: Record<string, number> = {};
        const doneIds = new Set<string>();
        (ledger ?? []).forEach((e: any) => {
          doneIds.add(e.source_timesheet_id);
          const y = yearOf[e.source_timesheet_id]; if (!y) return;
          const k = `${e.staff_id}|${y}`; earned[k] = round2((earned[k] ?? 0) + Number(e.accrued_hours || 0));
        });
        const fresh = (usSheets ?? []).filter((t: any) => !doneIds.has(t.id) && yearOf[t.id]).map((t: any) => ({ ...t, year: yearOf[t.id] }));
        const rows = ptoAccruals(fresh, earned, rules, isHourly).map((r: any) => ({
          location_id, org_id: org, staff_id: r.staff_id, kind: 'accrual', accrued_hours: r.accrued_hours,
          accrued_pay: r.accrued_pay, accrual_rate: r.rate, currency: r.currency || cur, source_timesheet_id: r.source_timesheet_id,
        }));
        if (!rows.length) return json({ ok: true, accrued: 0, hours: 0, rate: round2(1 / rules.every * 10000) / 10000 });
        const { error } = await admin.from('wf_holiday_accrual').insert(rows);
        if (error) return json({ error: error.message }, 500);
        const totalHrs = round2(rows.reduce((a: number, r: any) => a + r.accrued_hours, 0));
        await writeAudit(location_id, org, 'accrual.run', { actorId: user.id, reason: `PTO: ${rows.length} timesheets at 1 h per ${rules.every} h -> ${totalHrs}h`, after: { count: rows.length, hours: totalHrs } });
        return json({ ok: true, accrued: rows.length, hours: totalHrs, rate: round2(1 / rules.every * 10000) / 10000, pto: true });
      }
      const { data: tss } = await admin.from('wf_timesheets')
        .select('id, staff_id, actual_hours, effective_rate, currency').eq('location_id', location_id).eq('status', 'approved');
      const { data: existing } = await admin.from('wf_holiday_accrual')
        .select('source_timesheet_id').eq('location_id', location_id).not('source_timesheet_id', 'is', null);
      const done = new Set((existing ?? []).map((e: any) => e.source_timesheet_id));
      const toInsert = (tss ?? []).filter((t: any) => !done.has(t.id) && Number(t.actual_hours) > 0 && isHourly(t.staff_id)).map((t: any) => {
        const hrs = round2(Number(t.actual_hours) * rate);
        return {
          location_id, org_id: org, staff_id: t.staff_id, kind: 'accrual', accrued_hours: hrs,
          accrued_pay: t.effective_rate != null ? round2(hrs * Number(t.effective_rate)) : null,
          accrual_rate: rate, currency: t.currency || cur, source_timesheet_id: t.id,
        };
      });
      if (toInsert.length) {
        const { error } = await admin.from('wf_holiday_accrual').insert(toInsert);
        if (error) return json({ error: error.message }, 500);
        const totalHrs = round2(toInsert.reduce((a, r) => a + r.accrued_hours, 0));
        await writeAudit(location_id, org, 'accrual.run', { actorId: user.id, reason: `${toInsert.length} timesheets @ ${(rate * 100).toFixed(2)}% → ${totalHrs}h`, after: { count: toInsert.length, hours: totalHrs } });
        return json({ ok: true, accrued: toInsert.length, hours: totalHrs, rate });
      }
      return json({ ok: true, accrued: 0, hours: 0, rate });
    }

    // ── TIME OFF DECISION — approve (paid/unpaid) or deny, with the ledger ───
    // Lives here and not in the client because the deduction is money: the
    // decision snapshots hours and rate, spends the accrual, and must be
    // idempotent. wf.decideTimeOff (client) remains only for mock mode.
    if (action === 'timeoff.decide') {
      const { time_off_id, status, paid, leave_days } = body;
      if (!time_off_id || !['approved', 'denied'].includes(status)) {
        return json({ error: 'time_off_id and status approved|denied required' }, 400);
      }
      if (status === 'approved' && typeof paid !== 'boolean') {
        return json({ error: 'approving needs paid: true|false — the approver decides' }, 400);
      }

      const { data: req } = await admin.from('wf_time_off')
        .select('*').eq('id', time_off_id).eq('location_id', location_id).maybeSingle();
      if (!req) return json({ error: 'request not found' }, 404);

      // 5.12.55 (Peter, 3 Nov 2026): holiday and PTO are earned at every linked site into one balance
      // and TAKEN at the person's primary location (_shared/primaryLocation.js). An approved request
      // filed at another site moves to the primary record first, so its deduction, labour and payroll
      // land there. A person at one site: their record is the primary, nothing moves.
      const { data: meRec } = await admin.from('wf_staff').select('id, person_id, org_id, location_id, primary_venue_id, created_at, status').eq('id', req.staff_id).maybeSingle();
      let linkedRecs: any[] = meRec ? [meRec] : [];
      if (meRec?.person_id) {
        const { data: lr } = await admin.from('wf_staff').select('id, location_id, primary_venue_id, created_at, status')
          .eq('org_id', meRec.org_id).eq('person_id', meRec.person_id);
        if (lr?.length) linkedRecs = lr;
      }
      const prim = primaryRecord(linkedRecs) || meRec;
      if (status === 'approved' && prim && prim.id !== req.staff_id) {
        const { error: mvErr } = await admin.from('wf_time_off').update({ staff_id: prim.id, location_id: prim.location_id }).eq('id', time_off_id);
        if (mvErr) return json({ error: `could not move the request to the primary location: ${mvErr.message}` }, 500);
        req.staff_id = prim.id; req.location_id = prim.location_id;
      }
      const chargeLoc = String(req.location_id || location_id);

      const { data: vsRow } = await admin.from('wf_venue_settings')
        .select('settings').eq('location_id', chargeLoc).maybeSingle();
      const fallbackDayHours = Math.max(1, Number((vsRow?.settings as any)?.holidayDayHours) || 8);

      const [{ data: st }, { data: roles }] = await Promise.all([
        // select('*'): head_office arrives with 20261119a and reads as not ticked before it has run.
        admin.from('wf_staff').select('*').eq('id', req.staff_id).maybeSingle(),
        admin.from('wf_roles').select('key, base_rate, salary_annual').eq('location_id', chargeLoc),
      ]);
      const role = (roles ?? []).find((r: any) => r.key === st?.role_key);
      // 5.12.56: a head office person is paid their salary through time off too: no hourly holiday pay on top.
      const salaried = st?.contract_type === 'salaried' || isHeadOffice(st, (vsRow?.settings as any) ?? null)
        || (role?.salary_annual != null && role?.base_rate == null && st?.rate_override == null);

      // UK statutory reference period (ERA 1996 s.224, post-Apr 2020 method,
      // mirroring avgHoursPerDay in src/staff/labour.js): the last 52 weeks the
      // person ACTUALLY worked — empty weeks are skipped, never diluting the
      // average — looking back at most 104 weeks; fewer weeks if they are newer.
      //   a day's leave  = total hours ÷ total days worked in those weeks
      //   the pay rate   = total pay   ÷ total hours in the same weeks
      // so a "day" is worth different hours for each person, and the rate
      // reflects what they actually earned (rate changes, premium shifts),
      // not whatever their base rate happens to be today. A flat 8h at base
      // rate is only the fallback for someone with no history yet.
      let dayHours = fallbackDayHours;
      let rate = salaried ? 0 : Number(st?.rate_override ?? role?.base_rate ?? 0);
      let avgUsed = false;
      if (!salaried) {
        const horizon = new Date(); horizon.setDate(horizon.getDate() - 104 * 7);
        const { data: hist } = await admin.from('wf_timesheets')
          .select('clock_in, actual_hours, effective_rate, pay_amount, paid_break_mins')
          .eq('staff_id', req.staff_id).in('status', ['approved', 'paid'])
          .gte('clock_in', horizon.toISOString()).limit(5000);
        const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        const weekStartOf = (d: Date) => { const x = new Date(d); x.setHours(0, 0, 0, 0); const dow = x.getDay(); x.setDate(x.getDate() + (dow === 0 ? -6 : 1 - dow)); return x; };
        const byDay: Record<string, { hours: number; pay: number }> = {};
        (hist ?? []).forEach((t: any) => {
          const hrs = Number(t.actual_hours || 0);
          if (!t.clock_in || hrs <= 0) return;
          const pay = t.pay_amount != null
            ? Number(t.pay_amount)
            : round2((hrs + Number(t.paid_break_mins || 0) / 60) * Number(t.effective_rate || 0));
          const k = ymd(new Date(t.clock_in));
          const b = byDay[k] ?? (byDay[k] = { hours: 0, pay: 0 });
          b.hours += hrs; b.pay += pay;
        });
        const weeks: Record<string, { hours: number; pay: number; days: number }> = {};
        Object.entries(byDay).forEach(([iso, v]) => {
          const wk = ymd(weekStartOf(new Date(iso + 'T00:00:00')));
          const b = weeks[wk] ?? (weeks[wk] = { hours: 0, pay: 0, days: 0 });
          b.hours += v.hours; b.pay += v.pay; b.days += 1;
        });
        const used = Object.keys(weeks).sort().reverse().slice(0, 52);
        const tot = used.reduce((a, wk) => ({
          hours: a.hours + weeks[wk].hours, pay: a.pay + weeks[wk].pay, days: a.days + weeks[wk].days,
        }), { hours: 0, pay: 0, days: 0 });
        if (tot.days > 0 && tot.hours > 0) {
          dayHours = Math.round((tot.hours / tot.days) * 100) / 100;
          rate = Math.round((tot.pay / tot.hours) * 100) / 100;
          avgUsed = true;
        }
      }

      // v5.6.9 — the approver can mark WHICH days are annual leave (a 7-day
      // request from a Mon-Fri person is 5 days of holiday + 2 ordinary days
      // off). Only marked days are valued and deducted. Server-validated: every
      // date must sit inside the requested range; absent = the whole request
      // (the pre-split behaviour, and what old clients send).
      let leaveDays: string[] | null = null;
      if (Array.isArray(leave_days)) {
        const ok = (d: unknown) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= req.start_date && d <= req.end_date;
        leaveDays = [...new Set(leave_days.filter(ok))].sort() as string[];
        if (leave_days.length > 0 && leaveDays.length !== leave_days.length) {
          return json({ error: 'leave_days must all fall inside the requested dates' }, 400);
        }
      }
      const days = leaveDays ? leaveDays.length : Number(req.days || 0);
      const hours = round2(days * dayHours);
      // Only HOLIDAY spends the holiday allowance. Sick/parental/unpaid leave is
      // recorded (and paid or not) but never deducts from it.
      const deducts = status === 'approved' && paid === true && req.type === 'holiday' && hours > 0;

      const patch: Record<string, unknown> = {
        status,
        decided_by: user.id, decided_at: new Date().toISOString(),
        paid: status === 'approved' ? paid : null,
        deducted_hours: deducts ? hours : null,
        pay_rate: status === 'approved' && paid ? rate : null,
        leave_days: status === 'approved' && req.type === 'holiday' ? leaveDays : null,
      };
      const { error: upErr } = await admin.from('wf_time_off').update(patch).eq('id', time_off_id);
      if (upErr) return json({ error: upErr.message }, 500);

      // A denial (or an approval flipped to denial) must give back anything a
      // previous approval spent.
      if (!deducts) {
        await admin.from('wf_holiday_accrual').delete().eq('source_time_off_id', time_off_id);
      } else {
        // Idempotent: the partial unique index makes a second approval a no-op.
        const { error: ledErr } = await admin.from('wf_holiday_accrual').insert({
          location_id: chargeLoc, org_id: org, staff_id: req.staff_id, kind: 'taken',
          accrued_hours: -hours, accrued_pay: rate > 0 ? round2(-hours * rate) : null,
          currency: cur, source_time_off_id: time_off_id,
          note: `${days} day${days === 1 ? '' : 's'}${leaveDays && days !== Number(req.days || 0) ? ` of ${req.days} requested` : ''} ${req.start_date} → ${req.end_date} @ ${dayHours}h/day${avgUsed ? ' (52-wk avg)' : ''}`,
        });
        if (ledErr && !String(ledErr.message).includes('duplicate key')) {
          return json({ error: `decision saved but the deduction failed: ${ledErr.message}` }, 500);
        }
      }

      // One balance: every linked record's ledger.
      const { data: led } = await admin.from('wf_holiday_accrual')
        .select('accrued_hours').in('staff_id', linkedRecs.length ? linkedRecs.map((r: any) => r.id) : [req.staff_id]);
      const balance = personBalance(led ?? []);

      await writeAudit(location_id, org, 'timeoff.decide', {
        actorId: user.id,
        reason: `${status}${status === 'approved' ? (paid ? ' (paid)' : ' (unpaid)') : ''} — ${days}d ${req.type} for ${req.staff_id}`,
        after: { time_off_id, status, paid: patch.paid, deducted_hours: patch.deducted_hours, rate, balance },
      });

      return json({ ok: true, status, paid: patch.paid, hours: deducts ? hours : 0, rate, day_hours: dayHours, statutory_average: avgUsed, balance, salaried });
    }

    // ── PAY PERIOD (read-only summary) ────────────────────────────────────────
    if (action === 'pay.period') {
      const { from, to } = body; // pay-period dates (optional; defaults to all approved)
      let q = admin.from('wf_timesheets')
        .select('staff_id, actual_hours, effective_rate, pay_amount, status, clock_in').eq('location_id', location_id).eq('status', 'approved');
      if (from) q = q.gte('clock_in', `${from}T00:00:00`);
      if (to) q = q.lte('clock_in', `${to}T23:59:59`);
      const { data: tss } = await q;
      const byStaff: Record<string, { hours: number; pay: number }> = {};
      (tss ?? []).forEach((t: any) => {
        const pay = t.pay_amount != null ? Number(t.pay_amount) : Number(t.actual_hours || 0) * Number(t.effective_rate || 0);
        const b = byStaff[t.staff_id] ?? (byStaff[t.staff_id] = { hours: 0, pay: 0 });
        b.hours += Number(t.actual_hours || 0); b.pay += pay;
      });
      const staff = Object.entries(byStaff).map(([staff_id, v]) => ({ staff_id, hours: round2(v.hours), pay: round2(v.pay) }));
      return json({ ok: true, from: from ?? null, to: to ?? null, staff, total: round2(staff.reduce((a, s) => a + s.pay, 0)) });
    }

    // ── PAYROLL PERIOD — base pay + tips for one locked pay period ───────────
    // Base pay: approved timesheets clocked within [from, to].
    // Tips, per the venue's tipping policy (wf_venue_settings.settings):
    //   tipMode 'pool'   → all card tips via tronc runs (current default)
    //   tipMode 'direct' → card tips go to the seller on each closed check
    //   tipMode 'hybrid' → seller keeps directPct% of their checks' tips;
    //                      the remainder is pooled via tronc
    // Tronc payouts come from persisted runs (status != draft) whose
    // week_start falls in [from, to] — each week belongs to exactly one
    // period, so consecutive periods never double-count. Direct tips are
    // attributed via closed_checks.staff_id → wf_staff.pos_user_id, falling
    // back to a case-insensitive server-name match; any tips that match no
    // staff record are reported as unattributed (the Tipping Act requires
    // 100% of qualifying tips to be allocated).
    if (action === 'payroll.period' || action === 'payroll.close') {
      const closing = action === 'payroll.close';
      const { from, to, pay_date } = body;
      if (!from || !to) return json({ error: 'from/to required' }, 400);
      // v5.11.101: a US venue's period is its own days: timesheets and checks between the venue's
      // midnights (a 6pm shift on the 15th in San Mateo is 1am UTC on the 16th and belongs to the 1st
      // to 15th). A UK venue reads exactly the window it always did.
      const nextDay = (iso: string) => new Date(Date.parse(`${iso}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
      const localWindow = pack.country === 'US';
      const fromTs = localWindow ? venueMidnightIso(from, venue.timezone) : `${from}T00:00:00`;
      const toTs = localWindow ? new Date(Date.parse(venueMidnightIso(nextDay(to), venue.timezone)) - 1).toISOString() : `${to}T23:59:59`;

      // All five reads are independent — ONE parallel round instead of five
      // sequential round-trips (this endpoint is hit on every payroll view).
      const [
        { data: existingRun },
        { data: pendingRows },
        { data: vs },
        { data: tss },
        { data: runs },
      ] = await Promise.all([
        admin.from('wf_payroll_runs').select('id, created_at, totals').eq('location_id', location_id).eq('period_start', from).maybeSingle(),
        admin.from('wf_timesheets').select('id').eq('location_id', location_id).eq('status', 'pending')
          .gte('clock_in', fromTs).lte('clock_in', toTs),
        admin.from('wf_venue_settings').select('settings, premiums, pay_period_type').eq('location_id', location_id).maybeSingle(),
        // Base pay from APPROVED + already-PAID timesheets (paid rows keep the
        // preview of a closed period faithful to what was actually paid).
        admin.from('wf_timesheets').select(`id, staff_id, actual_hours, effective_rate, rate_source, paid_break_mins, pay_amount, clock_in, clock_out, status${pack.country === 'US' ? ', declared_cash_tips' : ''}`)
          .eq('location_id', location_id).in('status', ['approved', 'paid'])
          .gte('clock_in', fromTs).lte('clock_in', toTs),
        admin.from('wf_tronc_runs').select('id, week_start, status, pool, total_paid')
          .eq('location_id', location_id).gte('week_start', from).lte('week_start', to).neq('status', 'draft'),
      ]);

      // A period closes exactly once — the run is the immutable record.
      if (closing && existingRun) return json({ ok: false, error: 'This pay period has already been closed — see Payroll history.' });

      // Pending timesheets BLOCK closing: every worked hour must be approved
      // (or deleted) before pay is finalised.
      const pendingCount = (pendingRows ?? []).length;
      if (closing && pendingCount > 0) {
        return json({ ok: false, error: `Finish approving timesheets first — ${pendingCount} timesheet${pendingCount === 1 ? ' is' : 's are'} still pending in this period (approve or delete them under Timesheets).` });
      }

      const policy = (vs?.settings ?? {}) as Record<string, any>;
      const tipMode = policy.tipMode === 'direct' || policy.tipMode === 'hybrid' ? policy.tipMode : 'pool';
      const directShare = tipMode === 'direct' ? 1 : tipMode === 'hybrid' ? Math.min(100, Math.max(0, Number(policy.directPct) || 0)) / 100 : 0;
      const allocator = policy.tipAllocator === 'troncmaster' ? 'troncmaster' : 'employer';

      // Pay is ALWAYS derived server-side from hours × snapshotted rate (+ any
      // paid break minutes) — never the client-writable pay_amount field, which
      // a back-office account could otherwise inflate before closing. For a
      // legitimate timesheet this equals the stored pay_amount exactly.
      const base: Record<string, { hours: number; pay: number }> = {};
      (tss ?? []).forEach((t: any) => {
        const hrs = Number(t.actual_hours || 0);
        const paidBreakHrs = Number(t.paid_break_mins || 0) / 60;
        const pay = round2((hrs + paidBreakHrs) * Number(t.effective_rate || 0));
        const b = base[t.staff_id] ?? (base[t.staff_id] = { hours: 0, pay: 0 });
        b.hours += hrs; b.pay += pay;
      });
      // v5.11.101: PAY PREMIUMS (Workforce settings), saved since the Workforce build and never applied
      // until now. Weekend, public holiday and night premiums on hourly pay for positions marked premium
      // eligible; the higher one where two apply (_shared/payPremiums.js, one rule with the rota cost).
      // A venue with no premiums set (every venue on 24 Oct 2026) adds nothing and its lines read as before.
      // 5.12.49: cash tips declared at clock out in the period (US venues; reported, never paid by the venue).
      const cashDeclared: Record<string, number> = {};
      let anyCashDeclared = false;
      if (pack.country === 'US') (tss ?? []).forEach((t: any) => {
        if (t.declared_cash_tips == null) return;
        anyCashDeclared = true;
        cashDeclared[t.staff_id] = round2((cashDeclared[t.staff_id] ?? 0) + Number(t.declared_cash_tips || 0));
      });
      const premiums = (vs as any)?.premiums ?? {};
      const premium: Record<string, { hours: number; pay: number }> = {};
      const withPremiums = anyPremium(premiums);
      if (withPremiums) {
        const [{ data: stRows }, { data: roleRows }] = await Promise.all([
          admin.from('wf_staff').select('id, role_key').eq('location_id', location_id),
          admin.from('wf_roles').select('key, premium_eligible').eq('location_id', location_id),
        ]);
        const roleOf: Record<string, string> = {}; (stRows ?? []).forEach((x: any) => { roleOf[x.id] = x.role_key; });
        const eligibleRole: Record<string, boolean> = {}; (roleRows ?? []).forEach((x: any) => { eligibleRole[x.key] = x.premium_eligible !== false; });
        (tss ?? []).forEach((t: any) => {
          if (!t.clock_in || !t.clock_out) return;
          const rk = roleOf[t.staff_id];
          const r = premiumFor({
            startMs: t.clock_in, endMs: t.clock_out, workedHours: Number(t.actual_hours || 0), rate: Number(t.effective_rate || 0),
            premiums, tz: venue.timezone, country: pack.country,
            eligible: rk ? (eligibleRole[rk] ?? true) : true, hourly: t.rate_source !== 'salaried',
          });
          if (!r.pay) return;
          const p = premium[t.staff_id] ?? (premium[t.staff_id] = { hours: 0, pay: 0 });
          p.hours += r.hours; p.pay += r.pay;
        });
      }
      // v5.11.101: US venues: regular and overtime hours by work week (federal: over 40), for the payroll
      // provider's export. Hours only; the provider pays the overtime rate.
      // Every work week touching the period is read whole (the days before and after it too), so a
      // week split by the period's edge counts its overtime once, in the period it fell in. The week
      // starts on the venue's day (Workforce settings, Work week starts; Monday when not set).
      // 5.12.36 (Peter, 2 Nov 2026: "20 hours at one site and 25 hours at another site, then that is 5
      // hours over time"): a person linked across sites (wf_staff.person_id, 20261111a) has their work
      // week counted across every one of them. Each overtime hour belongs to the site where it was
      // worked; the half time is owed at the week's blended regular rate (_shared/multiSiteOvertime.js).
      // A record that is not linked reads exactly as before, plus the premium and the rate.
      let overtime: Record<string, { regular: number; overtime: number; otherSiteHours: number; overtimePremium: number; regularRate: number | null }> | null = null;
      let caVenue = false;   // 5.12.53: California daily rules in force for this payroll
      // 5.12.47: the whole work weeks this site's tip credit top up is worked out on (set below).
      let tipWeeks: { sheets: any[]; spanFrom: string; spanTo: string; span: { from: string; to: string }; wsd: number; sheetRules: (t: any) => { exempt: boolean; min_wage: number }; premiumHere: (t: any) => number } | null = null;
      if (pack.overtimeWeeklyHours) {
        const wsd = Number.isInteger(Number(policy.workweekStart)) && Number(policy.workweekStart) >= 0 && Number(policy.workweekStart) <= 6 ? Number(policy.workweekStart) : 1;
        const span = workweekSpan(from, to, wsd);
        const spanFrom = venueMidnightIso(span.from, venue.timezone), spanTo = venueMidnightIso(nextDay(span.to), venue.timezone);
        const sheetCols = `staff_id, actual_hours, paid_break_mins, effective_rate, rate_source, clock_in, clock_out, status${pack.country === 'US' ? ', declared_cash_tips, break_taken' : ''}`;
        const [{ data: weekSheets }, { data: hereStaff }] = await Promise.all([
          admin.from('wf_timesheets').select(sheetCols).eq('location_id', location_id).in('status', ['approved', 'paid'])
            .gte('clock_in', spanFrom).lt('clock_in', spanTo),
          admin.from('wf_staff').select('id, person_id, role_key').eq('location_id', location_id),
        ]);
        const personOf: Record<string, string> = {};
        const roleOfStaff: Record<string, { loc: string; role: string | null }> = {};
        (hereStaff ?? []).forEach((x: any) => { personOf[x.id] = x.person_id || x.id; roleOfStaff[x.id] = { loc: location_id, role: x.role_key ?? null }; });
        const persons = [...new Set((hereStaff ?? []).map((x: any) => x.person_id).filter(Boolean))];
        // The same people's records at their other sites, and those sites' sheets, zones and premiums.
        let otherSheets: any[] = [];
        const zoneOf: Record<string, string> = { [location_id]: venue.timezone };
        const premiumsOf: Record<string, any> = { [location_id]: premiums };
        // 5.12.38: each sheet's week is its own site's work week (the same rule the reports' column uses).
        const wsdOf: Record<string, number> = { [location_id]: wsd };
        const eligibleOf: Record<string, Record<string, boolean>> = {};
        // 5.12.41: each site's overtime rules (exempt positions, the minimum wage for tip credit staff).
        const settingsOf: Record<string, any> = { [location_id]: policy };
        const payTypeOf: Record<string, Record<string, string>> = {};
        {
          const { data: hereRoles } = await admin.from('wf_roles').select('location_id, key, pay_type, premium_eligible').eq('location_id', location_id);
          (hereRoles ?? []).forEach((r: any) => { (payTypeOf[location_id] ??= {})[r.key] = r.pay_type; (eligibleOf[location_id] ??= {})[r.key] = r.premium_eligible !== false; });
        }
        if (persons.length) {
          const { data: linked } = await admin.from('wf_staff').select('id, person_id, location_id, role_key')
            .eq('org_id', org).in('person_id', persons).neq('location_id', location_id);
          (linked ?? []).forEach((x: any) => { personOf[x.id] = x.person_id; roleOfStaff[x.id] = { loc: x.location_id, role: x.role_key ?? null }; });
          const linkedIds = (linked ?? []).map((x: any) => x.id);
          const otherLocs = [...new Set((linked ?? []).map((x: any) => x.location_id))];
          if (linkedIds.length) {
            // One day either side: each site's own venue day decides its week below.
            const wideFrom = new Date(Date.parse(spanFrom) - 86400000).toISOString();
            const wideTo = new Date(Date.parse(spanTo) + 86400000).toISOString();
            const [{ data: os }, { data: locs }, { data: vss }, { data: rls }] = await Promise.all([
              admin.from('wf_timesheets').select(`${sheetCols}, location_id`).in('staff_id', linkedIds).in('status', ['approved', 'paid'])
                .gte('clock_in', wideFrom).lt('clock_in', wideTo),
              admin.from('locations').select('id, timezone').in('id', otherLocs),
              admin.from('wf_venue_settings').select('location_id, premiums, settings').in('location_id', otherLocs),
              admin.from('wf_roles').select('location_id, key, pay_type, premium_eligible').in('location_id', otherLocs),
            ]);
            otherSheets = os ?? [];
            (locs ?? []).forEach((l: any) => { zoneOf[l.id] = l.timezone || venue.timezone; });
            (vss ?? []).forEach((v: any) => {
              premiumsOf[v.location_id] = v.premiums ?? {};
              settingsOf[v.location_id] = v.settings ?? {};
              const d = Number(v.settings?.workweekStart);
              wsdOf[v.location_id] = Number.isInteger(d) && d >= 0 && d <= 6 ? d : 1;
            });
            (rls ?? []).forEach((r: any) => { (eligibleOf[r.location_id] ??= {})[r.key] = r.premium_eligible !== false; (payTypeOf[r.location_id] ??= {})[r.key] = r.pay_type; });
          }
        }
        // Pay premiums are part of the regular rate (shift differentials count), each by its own site's rules.
        const premiumPay = (t: any, loc: string) => {
          const pr = premiumsOf[loc] ?? {};
          if (!anyPremium(pr) || !t.clock_in || !t.clock_out) return 0;
          const rk = roleOfStaff[t.staff_id]?.role;
          const el = rk ? (eligibleOf[loc]?.[rk] ?? true) : true;
          return premiumFor({ startMs: t.clock_in, endMs: t.clock_out, workedHours: Number(t.actual_hours || 0), rate: Number(t.effective_rate || 0),
            premiums: pr, tz: zoneOf[loc] || venue.timezone, country: pack.country, eligible: el, hourly: t.rate_source !== 'salaried' }).pay;
        };
        const rulesOf = (t: any, loc: string) => {
          const rk = roleOfStaff[t.staff_id]?.role ?? null;
          const r = overtimeRules({ settings: settingsOf[loc] ?? {}, roleKey: rk, payType: rk ? payTypeOf[loc]?.[rk] ?? null : null, rateSource: t.rate_source ?? null });
          return { exempt: r.exempt, min_wage: r.minWage };
        };
        const all = [
          ...(weekSheets ?? []).map((t: any) => ({ ...t, location_id, person: personOf[t.staff_id] || t.staff_id, tz: venue.timezone, week_start_dow: wsd, premium_pay: premiumPay(t, location_id), ...rulesOf(t, location_id) })),
          ...otherSheets.map((t: any) => ({ ...t, person: personOf[t.staff_id] || t.staff_id, tz: zoneOf[t.location_id] || venue.timezone, week_start_dow: wsdOf[t.location_id] ?? 1, premium_pay: premiumPay(t, t.location_id), ...rulesOf(t, t.location_id) })),
        ];
        // 5.12.53: a California venue (State break rules = California) works daily overtime, double time
        // and the meal break premium (_shared/caOvertime.js); every other US venue is weekly, as before.
        const ca = pack.country === 'US' ? caRules(policy) : null;
        overtime = ca
          ? caOvertimeAcrossSites(all, { tz: venue.timezone, weekStartDow: wsd, from, to, here: location_id, rules: ca }) as any
          : overtimeAcrossSites(all, pack.overtimeWeeklyHours, { tz: venue.timezone, weekStartDow: wsd, from, to, here: location_id });
        caVenue = !!ca;
        tipWeeks = { sheets: weekSheets ?? [], spanFrom, spanTo, span, wsd, sheetRules: (t: any) => rulesOf(t, location_id), premiumHere: (t: any) => premiumPay(t, location_id) };
      }

      const troncTips: Record<string, number> = {};
      const runIds = (runs ?? []).map((r: any) => r.id);
      if (runIds.length) {
        const { data: lines } = await admin.from('wf_tronc_lines').select('staff_id, payout').in('run_id', runIds);
        (lines ?? []).forEach((l: any) => { troncTips[l.staff_id] = (troncTips[l.staff_id] ?? 0) + Number(l.payout || 0); });
      }

      // Direct tips from closed checks (seller attribution).
      const directTips: Record<string, number> = {};
      let unattributedTips = 0;
      if (directShare > 0) {
        const [{ data: checks }, { data: wfRows }] = await Promise.all([
          admin.from('closed_checks').select('tip, staff_id, server, status')
            .eq('location_id', String(location_id))
            .gte('closed_at', fromTs).lte('closed_at', toTs)
            .neq('status', 'voided').gt('tip', 0),
          admin.from('wf_staff').select('id, name, pos_user_id').eq('location_id', location_id),
        ]);
        // O(1) lookups per check: pos-user id, exact full name, and UNIQUE
        // first name (the till often stores just "Peter"). The old fallback
        // scanned every staff name per check — O(checks × staff).
        const byPos: Record<string, string> = {}; const byName: Record<string, string> = {};
        const byFirst: Record<string, string | false> = {}; // false = ambiguous
        (wfRows ?? []).forEach((w: any) => {
          if (w.pos_user_id) byPos[w.pos_user_id] = w.id;
          const full = String(w.name || '').trim().toLowerCase();
          if (!full) return;
          byName[full] = w.id;
          const first = full.split(/\s+/)[0];
          byFirst[first] = byFirst[first] === undefined ? w.id : false;
        });
        (checks ?? []).forEach((c: any) => {
          const tip = Number(c.tip) || 0;
          if (!tip) return;
          const server = String(c.server || '').trim().toLowerCase();
          const sid = (c.staff_id && byPos[c.staff_id])
            || (server && byName[server])
            || (server && byFirst[server] ? byFirst[server] : null)
            || null;
          if (sid) directTips[sid] = (directTips[sid] ?? 0) + tip * directShare;
          else unattributedTips += tip * directShare;
        });
      }

      // 5.12.47: US TIP CREDIT TOP UP (federal FLSA, _shared/tipCredit.js). A server paid below the
      // minimum wage (a Provo server on $2.13) must reach it each work week with their tips; when the
      // cash wage plus the tips they kept falls short, the employer pays the difference. Worked per
      // work week from this site's sheets, card tips on their own checks and their pooled tip share.
      // Cash tips are not recorded yet, so a top up can be higher than owed, never lower.
      let topUps: Record<string, { topUp: number; weeks: any[] }> = {};
      if (tipWeeks && pack.country === 'US') {
        const tw = tipWeeks;
        const sheetsTC = tw.sheets.map((t: any) => {
          const rules = tw.sheetRules(t);
          if (rules.exempt) return null;
          const hrs = Number(t.actual_hours || 0) + Number(t.paid_break_mins || 0) / 60;
          return { staff_id: t.staff_id, hours: hrs, rate: Number(t.effective_rate || 0), rate_source: t.rate_source ?? null,
            pay: round2(hrs * Number(t.effective_rate || 0)) + tw.premiumHere(t), clock_in: t.clock_in, min_wage: rules.min_wage };
        }).filter(Boolean) as any[];
        const tipped = sheetsTC.some((t: any) => t.rate_source !== 'salaried' && t.hours > 0 && t.rate < t.min_wage - 1e-9);
        if (tipped) {
          const tipRows: { staff_id: string; amount: number; day: string }[] = [];
          const runFrom = new Date(Date.parse(`${tw.span.from}T00:00:00Z`) - 6 * 86400000).toISOString().slice(0, 10);
          const [{ data: spanChecks }, { data: wfSellers }, { data: spanRuns }] = await Promise.all([
            directShare > 0
              ? admin.from('closed_checks').select('tip, staff_id, server, status, closed_at').eq('location_id', String(location_id))
                .gte('closed_at', tw.spanFrom).lt('closed_at', tw.spanTo).neq('status', 'voided').gt('tip', 0).limit(20000)
              : Promise.resolve({ data: [] as any[] }),
            admin.from('wf_staff').select('id, name, pos_user_id').eq('location_id', location_id),
            tipMode !== 'direct'
              ? admin.from('wf_tronc_runs').select('id, week_start').eq('location_id', location_id).gte('week_start', runFrom).lte('week_start', tw.span.to).neq('status', 'draft')
              : Promise.resolve({ data: [] as any[] }),
          ]);
          const byPos2: Record<string, string> = {}; const byName2: Record<string, string> = {}; const byFirst2: Record<string, string | false> = {};
          (wfSellers ?? []).forEach((w: any) => {
            if (w.pos_user_id) byPos2[w.pos_user_id] = w.id;
            const full = String(w.name || '').trim().toLowerCase(); if (!full) return;
            byName2[full] = w.id; const first = full.split(/\s+/)[0];
            byFirst2[first] = byFirst2[first] === undefined ? w.id : false;
          });
          (spanChecks ?? []).forEach((c: any) => {
            const tip = Number(c.tip) || 0; if (!tip) return;
            const server = String(c.server || '').trim().toLowerCase();
            const sid = (c.staff_id && byPos2[c.staff_id]) || (server && byName2[server]) || (server && byFirst2[server] ? byFirst2[server] : null) || null;
            const day = venueDay(c.closed_at, venue.timezone);
            if (sid && day) tipRows.push({ staff_id: sid, amount: tip * directShare, day });
          });
          const runDay: Record<string, string> = {}; (spanRuns ?? []).forEach((r: any) => { runDay[r.id] = r.week_start; });
          const spanRunIds = Object.keys(runDay);
          if (spanRunIds.length) {
            const { data: spanLines } = await admin.from('wf_tronc_lines').select('run_id, staff_id, payout').in('run_id', spanRunIds);
            (spanLines ?? []).forEach((l: any) => { if (l.staff_id && runDay[l.run_id]) tipRows.push({ staff_id: l.staff_id, amount: Number(l.payout || 0), day: runDay[l.run_id] }); });
          }
          // 5.12.49: the cash tips they declared at clock out count as tips kept that week.
          tw.sheets.forEach((t: any) => {
            const ct = Number(t.declared_cash_tips || 0);
            const day = ct > 0 ? venueDay(t.clock_in, venue.timezone) : null;
            if (day) tipRows.push({ staff_id: t.staff_id, amount: ct, day });
          });
          topUps = tipCreditTopUps(sheetsTC, tipRows, { tz: venue.timezone, weekStartDow: tw.wsd, from, to });
        }
      }

      // Mondays inside [from, to] with no tronc run = pooled tips not yet
      // distributed (only matters when something is pooled).
      const missingWeeks: string[] = [];
      if (tipMode !== 'direct') {
        const covered = new Set((runs ?? []).map((r: any) => r.week_start));
        for (const d = new Date(from + 'T00:00:00'); d <= new Date(to + 'T00:00:00'); d.setDate(d.getDate() + 1)) {
          if (d.getDay() === 1) {
            const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            if (!covered.has(iso)) missingWeeks.push(iso);
          }
        }
      }

      // Paid holiday in the period. Approved-paid requests carry snapshotted
      // deducted_hours and pay_rate from the moment of approval; a request that
      // straddles the period boundary contributes only its in-period share.
      // Without this the export listed only WORKED hours — a venue paying from
      // it had no idea paid leave happened that week or what it costs.
      const holiday: Record<string, { hours: number; pay: number }> = {};
      {
        const { data: leaveRows } = await admin.from('wf_time_off')
          .select('staff_id, start_date, end_date, days, deducted_hours, pay_rate')
          .eq('location_id', location_id).eq('status', 'approved').eq('paid', true)
          .not('deducted_hours', 'is', null)
          .lte('start_date', to).gte('end_date', from);
        const day = 86400000;
        (leaveRows ?? []).forEach((r: any) => {
          const s0 = Math.max(new Date(r.start_date + 'T00:00:00Z').getTime(), new Date(from + 'T00:00:00Z').getTime());
          const e0 = Math.min(new Date(r.end_date + 'T00:00:00Z').getTime(), new Date(to + 'T00:00:00Z').getTime());
          const spanDays = Math.max(0, Math.round((e0 - s0) / day) + 1);
          const totalDays = Math.max(1, Number(r.days || 0));
          const share = Math.min(1, spanDays / totalDays);
          const hrs = round2(Number(r.deducted_hours || 0) * share);
          const pay = round2(hrs * Number(r.pay_rate || 0));
          const h = holiday[r.staff_id] ?? (holiday[r.staff_id] = { hours: 0, pay: 0 });
          h.hours += hrs; h.pay += pay;
        });
      }

      // 5.12.56: HEAD OFFICE STAFF (Workforce settings, Head office staff; _shared/headOffice.js). Their
      // salary for the period with no timesheets: a full period is the year over the periods in a year,
      // a start or leave inside it pays the days employed. Leavers are read too, so a last part month is
      // paid. Only a site with the switch on reads them: every other payroll is exactly as before.
      const hoPay: Record<string, { pay: number; basis: string; days: number; periodDays: number }> = {};
      if (headOfficeOn(policy)) {
        const { data: hoRows } = await admin.from('wf_staff').select('id, salary_annual, start_date, leaver_date')
          .eq('location_id', location_id).eq('head_office', true);
        (hoRows ?? []).forEach((r: any) => {
          const p = headOfficePay({ salaryAnnual: r.salary_annual, from, to, periodType: (vs as any)?.pay_period_type || 'monthly',
            startDate: r.start_date, leaverDate: r.leaver_date });
          if (p.pay > 0) hoPay[r.id] = p;
        });
      }

      const ids = new Set([...Object.keys(base), ...Object.keys(troncTips), ...Object.keys(directTips), ...Object.keys(holiday), ...Object.keys(topUps), ...Object.keys(hoPay)]);
      const staff = [...ids].map((id) => {
        const b = base[id] ?? { hours: 0, pay: 0 };
        const tronc = round2(troncTips[id] ?? 0);
        const direct = round2(directTips[id] ?? 0);
        const hol = holiday[id] ?? { hours: 0, pay: 0 };
        const prem = premium[id] ?? { hours: 0, pay: 0 };
        const line: Record<string, any> = {
          staff_id: id, hours: round2(b.hours), pay: round2(b.pay),
          holiday_hours: round2(hol.hours), holiday_pay: round2(hol.pay),
          tips_tronc: tronc, tips_direct: direct, tips: round2(tronc + direct),
          total: round2(b.pay + round2(prem.pay) + hol.pay + tronc + direct),
        };
        // Only a venue that pays premiums or overtime carries these keys: every other line is as before.
        if (withPremiums) { line.premium_hours = round2(prem.hours); line.premium_pay = round2(prem.pay); }
        if (overtime) {
          const o = overtime[id];
          line.regular_hours = o?.regular ?? 0; line.overtime_hours = o?.overtime ?? 0;
          // 5.12.36: hours at the person's other sites, the half time owed and the blended rate.
          line.other_site_hours = o?.otherSiteHours ?? 0;
          line.overtime_premium = o?.overtimePremium ?? 0;
          line.regular_rate = o?.regularRate ?? null;
          line.total = round2(line.total + line.overtime_premium);
          // 5.12.53: California: double time hours (their premium is in overtime_premium) and the meal break premium.
          if (caVenue) {
            line.double_time_hours = (o as any)?.doubleTime ?? 0;
            line.meal_premium = (o as any)?.mealPremium ?? 0;
            line.meal_premium_days = (o as any)?.mealPremiumDays ?? 0;
            line.total = round2(line.total + line.meal_premium);
          }
        }
        // 5.12.47: only a US venue with a tip credit week carries these keys.
        if (topUps[id]) { line.tip_credit_topup = topUps[id].topUp; line.tip_credit_weeks = topUps[id].weeks; line.total = round2(line.total + line.tip_credit_topup); }
        // 5.12.49: declared cash tips are reported with the wages, never added to what the venue pays.
        if (anyCashDeclared) line.tips_cash_declared = cashDeclared[id] ?? 0;
        // 5.12.56: a head office person's salary for the period (only lines that have one carry the keys).
        if (hoPay[id]) {
          line.head_office = true; line.salary = hoPay[id].pay; line.salary_basis = hoPay[id].basis;
          line.salary_days = hoPay[id].days; line.total = round2(line.total + line.salary);
        }
        return line as { staff_id: string; hours: number; pay: number; holiday_hours: number; holiday_pay: number; tips_tronc: number; tips_direct: number; tips: number; total: number; premium_pay?: number };
      }).sort((a, b) => b.total - a.total);
      const totals: Record<string, number> = {
        pay: round2(staff.reduce((a, s) => a + s.pay, 0)),
        holiday_pay: round2(staff.reduce((a, s) => a + (s.holiday_pay || 0), 0)),
        tips_tronc: round2(staff.reduce((a, s) => a + s.tips_tronc, 0)),
        tips_direct: round2(staff.reduce((a, s) => a + s.tips_direct, 0)),
        tips: round2(staff.reduce((a, s) => a + s.tips, 0)),
        total: round2(staff.reduce((a, s) => a + s.total, 0)),
      };
      if (withPremiums) totals.premium_pay = round2(staff.reduce((a, s) => a + (s.premium_pay || 0), 0));
      if (overtime) totals.overtime_premium = round2(staff.reduce((a, s: any) => a + (s.overtime_premium || 0), 0));
      if (caVenue) totals.meal_premium = round2(staff.reduce((a, s: any) => a + (s.meal_premium || 0), 0));
      if (Object.keys(topUps).length) totals.tip_credit_topup = round2(staff.reduce((a, s: any) => a + (s.tip_credit_topup || 0), 0));
      if (anyCashDeclared) totals.tips_cash_declared = round2(staff.reduce((a, s: any) => a + (s.tips_cash_declared || 0), 0));
      // 5.12.56: head office salaries, its own total (in total, which is what the site pays out; never labour).
      if (Object.keys(hoPay).length) totals.head_office_salary = round2(staff.reduce((a, s: any) => a + (s.salary || 0), 0));
      const payload = {
        ok: true, from, to, staff, totals,
        policy: { tipMode, directPct: Math.round(directShare * 100), allocator, troncmasterName: policy.troncmasterName ?? null },
        unattributedTips: round2(unattributedTips),
        pendingTimesheets: pendingCount,
        closedRun: existingRun ? { id: existingRun.id, created_at: existingRun.created_at } : null,
        region: { country: pack.country, currency: cur, overtimeWeeklyHours: pack.overtimeWeeklyHours, payrollExport: pack.payrollExport },
        tronc: { runs: (runs ?? []).map((r: any) => ({ week_start: r.week_start, status: r.status, total_paid: r.total_paid })), missingWeeks },
      };
      if (!closing) return json(payload);

      // ── CLOSE: persist the run, mark the period's timesheets paid, audit. ──
      if (!staff.length) return json({ ok: false, error: 'Nothing to pay in this period — approve timesheets or run tronc first.' });
      const tsIds = (tss ?? []).filter((t: any) => t.status === 'approved').map((t: any) => t.id);
      const { data: run, error: runErr } = await admin.from('wf_payroll_runs').insert({
        location_id, org_id: org, period_start: from, period_end: to, pay_date: pay_date || null,
        status: 'completed', totals, lines: staff,
        policy: payload.policy, timesheet_ids: tsIds, run_by: user.id,
      }).select().single();
      if (runErr) return json({ error: runErr.message }, 500);

      if (tsIds.length) {
        const { error: tsErr } = await admin.from('wf_timesheets')
          .update({ status: 'paid', payroll_run_id: run.id }).in('id', tsIds).eq('status', 'approved');
        if (tsErr) {
          await admin.from('wf_payroll_runs').delete().eq('id', run.id);
          return json({ error: tsErr.message }, 500);
        }
      }

      await writeAudit(location_id, org, 'payroll.close', {
        actorId: user.id, amount: totals.total, currency: cur, entity: 'wf_payroll_runs', entityId: run.id,
        reason: `period ${from} – ${to}: ${staff.length} staff, pay ${sym}${totals.pay.toFixed(2)} + tips ${sym}${totals.tips.toFixed(2)}; ${tsIds.length} timesheet(s) marked paid`,
        after: { period_start: from, period_end: to, totals, timesheets_paid: tsIds.length },
      });
      return json({ ...payload, closedRun: { id: run.id, created_at: run.created_at }, timesheetsPaid: tsIds.length });
    }

    // ── LABOUR (daily revenue from closed_checks) ─────────────────────────────
    // ── HEALTH COVER HOURS (ACA), US only (5.12.38) ───────────────────────────
    // Hours of service per person per month at EVERY site they work at (linked records), the last 12
    // full months and this one; who is full time (130 h a month); and the company's full time plus
    // full time equivalents, against the 50 that makes an Applicable Large Employer. The company
    // figure needs every site's timesheets, so it is read here with the service role and only the
    // totals leave; the people listed are this site's own.
    if (action === 'aca.hours') {
      if (pack.country !== 'US') return json({ ok: false, error: 'Health cover hours are for US venues.' });
      const now = venueDay(new Date().toISOString(), venue.timezone) || new Date().toISOString().slice(0, 10);
      const [ny, nm] = now.slice(0, 7).split('-').map(Number);
      const startMonth = `${ny - 1}-${String(nm).padStart(2, '0')}`;   // 12 full months and this one
      const months = monthsBetween(startMonth, now.slice(0, 7));
      const fromIso = new Date(Date.parse(`${months[0]}-01T00:00:00Z`) - 86400000).toISOString();
      const [{ data: staffRows }, { data: locs }] = await Promise.all([
        admin.from('wf_staff').select('id, person_id, location_id, name').eq('org_id', org).limit(5000),
        admin.from('locations').select('id, timezone').eq('org_id', org),
      ]);
      const zone: Record<string, string> = {};
      (locs ?? []).forEach((l: any) => { zone[l.id] = l.timezone || venue.timezone; });
      const rows: any[] = [];
      for (let page = 0; page < 50; page++) {
        const { data, error } = await admin.from('wf_timesheets').select('id, staff_id, location_id, actual_hours, clock_in')
          .eq('org_id', org).in('status', ['approved', 'paid']).gte('clock_in', fromIso)
          .order('clock_in').order('id').range(page * 1000, page * 1000 + 999);
        if (error) return json({ ok: false, error: error.message });
        for (const t of data ?? []) {
          const d = venueDay(t.clock_in, zone[t.location_id] || venue.timezone);
          if (d) rows.push({ staff_id: t.staff_id, location_id: t.location_id, hours: Number(t.actual_hours) || 0, month: d.slice(0, 7) });
        }
        if ((data ?? []).length < 1000) break;
      }
      return json({ ok: true, months, ...acaReport({ rows, staff: staffRows ?? [], here: location_id, months }) });
    }

    if (action === 'labour') {
      const { from, to } = body;
      if (!from || !to) return json({ error: 'from/to required' }, 400);
      const { data } = await admin.from('closed_checks')
        .select('total, closed_at, status').eq('location_id', String(location_id))
        .gte('closed_at', `${from}T00:00:00`).lte('closed_at', `${to}T23:59:59`).neq('status', 'voided');
      const daily: Record<string, number> = {};
      (data ?? []).forEach((c: any) => { const d = new Date(c.closed_at).toISOString().slice(0, 10); daily[d] = (daily[d] || 0) + (Number(c.total) || 0); });
      return json({ ok: true, daily });
    }

    return json({ error: `unknown action "${action}"` }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
