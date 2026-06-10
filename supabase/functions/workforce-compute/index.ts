// supabase/functions/workforce-compute
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

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Append a tamper-evident audit row (prev_hash/row_hash chain per location). */
async function writeAudit(loc: string, org: string | null, action: string, d: Record<string, unknown> = {}) {
  const { data: last } = await admin.from('wf_audit')
    .select('row_hash').eq('location_id', loc).order('at', { ascending: false }).limit(1).maybeSingle();
  const prev = last?.row_hash ?? '';
  const row_hash = await sha256(JSON.stringify({ loc, org, action, ...d, prev }));
  await admin.from('wf_audit').insert({
    location_id: loc, org_id: org, action,
    actor_id: d.actorId ?? null, actor_name: d.actorName ?? null,
    amount: d.amount ?? null, currency: d.currency ?? null, reason: d.reason ?? null,
    entity: d.entity ?? null, entity_id: d.entityId ?? null,
    before: d.before ?? null, after: d.after ?? null, prev_hash: prev, row_hash,
  });
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
  const { data } = await admin.from('locations').select('org_id').eq('id', loc).single();
  return data?.org_id ?? null;
}

/** Enforce the tenant fence: caller must have access to the location (or be super_admin). */
async function assertAccess(userId: string, loc: string): Promise<boolean> {
  const [{ data: ul }, { data: prof }] = await Promise.all([
    admin.from('user_locations').select('location_id').eq('user_id', userId),
    admin.from('user_profiles').select('location_id, role').eq('id', userId).maybeSingle(),
  ]);
  if (prof?.role === 'super_admin') return true;
  const allowed = new Set<string>([...(ul ?? []).map((r: any) => String(r.location_id))]);
  if (prof?.location_id) allowed.add(String(prof.location_id));
  return allowed.has(String(loc));
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const authHeader = req.headers.get('Authorization') ?? '';
  const { data: { user } } = await admin.auth.getUser(authHeader.replace('Bearer ', ''));
  if (!user) return json({ error: 'unauthorized' }, 401);

  let body: Record<string, any>;
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }

  const { action, location_id } = body;
  if (!action) return json({ error: 'action required' }, 400);
  if (!location_id) return json({ error: 'location_id required' }, 400);
  if (!(await assertAccess(user.id, location_id))) return json({ error: 'forbidden' }, 403);

  const org = await orgFor(location_id);

  try {
    // ── TRONC RUN ────────────────────────────────────────────────────────────
    if (action === 'tronc.run') {
      const { week_start, pool } = body;
      if (!week_start) return json({ error: 'week_start required' }, 400);
      const poolNum = Number(pool) || 0;
      const weekEnd = (() => { const d = new Date(week_start + 'T00:00:00'); d.setDate(d.getDate() + 6); return d.toISOString().slice(0, 10); })();

      // Immutability check + shifts + roles are independent → fetch in parallel.
      const [{ data: existing }, { data: shifts }, { data: roles }] = await Promise.all([
        admin.from('wf_tronc_runs').select('id, status').eq('location_id', location_id).eq('week_start', week_start).maybeSingle(),
        admin.from('wf_shifts').select('staff_id, computed_hours, role_key')
          .eq('location_id', location_id).gte('shift_date', week_start).lte('shift_date', weekEnd).eq('status', 'published'),
        admin.from('wf_roles').select('key, tronc_weight').eq('location_id', location_id),
      ]);
      if (existing && existing.status !== 'draft') return json({ error: `a ${existing.status} tronc run already exists for this week` }, 409);
      if (existing) await admin.from('wf_tronc_runs').delete().eq('id', existing.id).eq('status', 'draft'); // draft → replace (lines cascade)
      if (!shifts || !shifts.length) return json({ error: 'no published shifts for this week — publish the rota first' }, 400);
      const pts: Record<string, number> = {}; (roles ?? []).forEach((r: any) => { pts[r.key] = Number(r.tronc_weight ?? 1); });

      const byStaff: Record<string, { hours: number; role: string }> = {};
      shifts.forEach((s: any) => {
        const b = byStaff[s.staff_id] ?? (byStaff[s.staff_id] = { hours: 0, role: s.role_key });
        b.hours += Number(s.computed_hours || 0);
      });
      const rows = Object.entries(byStaff).map(([staff_id, v]) => ({ staff_id, hours: round2(v.hours), points: pts[v.role] ?? 1 }));

      const res = allocate(poolNum, rows);
      const { data: run, error: runErr } = await admin.from('wf_tronc_runs').insert({
        location_id, org_id: org, week_start, currency: 'GBP', pool: poolNum,
        units_total: res.totalUnits, point_value: res.pointValue, total_paid: res.totalPaid, residual: res.residual,
        status: 'run', lines: res.lines,
      }).select().single();
      if (runErr) return json({ error: runErr.message }, 500);

      const lineRows = res.lines.map(l => ({
        run_id: run.id, location_id, org_id: org, staff_id: l.staff_id,
        hours: round2(l.hours), points: l.points, units: l.units, share_pct: l.sharePct, payout: l.payout, currency: 'GBP',
      }));
      const { error: linesErr } = await admin.from('wf_tronc_lines').insert(lineRows);
      if (linesErr) { await admin.from('wf_tronc_runs').delete().eq('id', run.id); return json({ error: linesErr.message }, 500); }

      await writeAudit(location_id, org, 'tronc.run', {
        actorId: user.id, amount: res.totalPaid, currency: 'GBP', entity: 'wf_tronc_runs', entityId: run.id,
        reason: `pool £${poolNum.toFixed(2)} over ${rows.length} staff, residual £${res.residual.toFixed(2)}`,
        after: { week_start, pool: poolNum, total_paid: res.totalPaid },
      });
      return json({ ok: true, run_id: run.id, pool: poolNum, total_paid: res.totalPaid, residual: res.residual, point_value: res.pointValue, lines: res.lines });
    }

    // ── ACCRUAL RUN — UK: only HOURLY/irregular staff accrue 12.07% of hours.
    // Salaried/fixed staff get a fixed entitlement (28 days) tracked separately,
    // so they are skipped here.
    if (action === 'accrual.run') {
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
          accrual_rate: rate, currency: t.currency || 'GBP', source_timesheet_id: t.id,
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
          .gte('clock_in', `${from}T00:00:00`).lte('clock_in', `${to}T23:59:59`),
        admin.from('wf_venue_settings').select('settings').eq('location_id', location_id).maybeSingle(),
        // Base pay from APPROVED + already-PAID timesheets (paid rows keep the
        // preview of a closed period faithful to what was actually paid).
        admin.from('wf_timesheets').select('id, staff_id, actual_hours, effective_rate, paid_break_mins, pay_amount, clock_in, status')
          .eq('location_id', location_id).in('status', ['approved', 'paid'])
          .gte('clock_in', `${from}T00:00:00`).lte('clock_in', `${to}T23:59:59`),
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
            .gte('closed_at', `${from}T00:00:00`).lte('closed_at', `${to}T23:59:59`)
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

      const ids = new Set([...Object.keys(base), ...Object.keys(troncTips), ...Object.keys(directTips)]);
      const staff = [...ids].map((id) => {
        const b = base[id] ?? { hours: 0, pay: 0 };
        const tronc = round2(troncTips[id] ?? 0);
        const direct = round2(directTips[id] ?? 0);
        return { staff_id: id, hours: round2(b.hours), pay: round2(b.pay), tips_tronc: tronc, tips_direct: direct, tips: round2(tronc + direct), total: round2(b.pay + tronc + direct) };
      }).sort((a, b) => b.total - a.total);
      const totals = {
        pay: round2(staff.reduce((a, s) => a + s.pay, 0)),
        tips_tronc: round2(staff.reduce((a, s) => a + s.tips_tronc, 0)),
        tips_direct: round2(staff.reduce((a, s) => a + s.tips_direct, 0)),
        tips: round2(staff.reduce((a, s) => a + s.tips, 0)),
        total: round2(staff.reduce((a, s) => a + s.total, 0)),
      };
      const payload = {
        ok: true, from, to, staff, totals,
        policy: { tipMode, directPct: Math.round(directShare * 100), allocator, troncmasterName: policy.troncmasterName ?? null },
        unattributedTips: round2(unattributedTips),
        pendingTimesheets: pendingCount,
        closedRun: existingRun ? { id: existingRun.id, created_at: existingRun.created_at } : null,
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
        actorId: user.id, amount: totals.total, currency: 'GBP', entity: 'wf_payroll_runs', entityId: run.id,
        reason: `period ${from} – ${to}: ${staff.length} staff, pay £${totals.pay.toFixed(2)} + tips £${totals.tips.toFixed(2)}; ${tsIds.length} timesheet(s) marked paid`,
        after: { period_start: from, period_end: to, totals, timesheets_paid: tsIds.length },
      });
      return json({ ...payload, closedRun: { id: run.id, created_at: run.created_at }, timesheetsPaid: tsIds.length });
    }

    // ── LABOUR (daily revenue from closed_checks) ─────────────────────────────
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
