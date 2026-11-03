const env = { SUPABASE_URL: 'http://x', SUPABASE_SERVICE_ROLE_KEY: 'svc', PLATFORM_SUPABASE_URL: 'http://y', PLATFORM_SUPABASE_SERVICE_ROLE_KEY: 'svc2' };
let handler; globalThis.Deno = { env: { get: (k) => env[k] }, serve: (h) => { handler = h; } };
const { DB } = await import(process.env.BUNDLE_DIR + '/mockdb.mjs');
const ts = (id, staff, startIso, hours, rate) => ({ id, staff_id: staff, location_id: 'L1', status: 'approved', actual_hours: hours, effective_rate: rate, rate_source: 'role', paid_break_mins: 0, pay_amount: hours * rate, clock_in: startIso, clock_out: new Date(Date.parse(startIso) + hours * 3600e3).toISOString() });
const GB = process.argv[2] === 'uk';
const CA = process.argv[2] === 'ca';   // 5.12.53: California daily overtime and meal premium
Object.assign(DB, {
  locations: [{ id: 'L1', org_id: 'O1', currency: GB ? 'GBP' : 'USD', timezone: GB ? 'Europe/London' : 'America/Denver' }],
  user_profiles: [{ id: 'u1', role: 'super_admin' }], user_locations: [],
  wf_venue_settings: [{ location_id: 'L1', settings: CA ? { tipMode: 'direct', usBreaks: { state: 'CA' } } : { tipMode: 'direct' }, premiums: {} }],
  wf_staff: [{ id: 's1', location_id: 'L1', org_id: 'O1', name: 'Sam Server', pos_user_id: 'p1', role_key: 'server', person_id: null },
             { id: 's2', location_id: 'L1', org_id: 'O1', name: 'Cora Cook', pos_user_id: 'p2', role_key: 'cook', person_id: null }],
  wf_roles: [{ location_id: 'L1', key: 'server', pay_type: 'hourly', premium_eligible: true }, { location_id: 'L1', key: 'cook', pay_type: 'hourly', premium_eligible: true }],
  wf_timesheets: [
    ({ ...ts('t1', 's1', '2026-11-03T17:00:00Z', 10, 2.13), declared_cash_tips: 50 }), ts('t2', 's1', '2026-11-04T17:00:00Z', 10, 2.13), ts('t3', 's1', '2026-11-05T17:00:00Z', 10, 2.13),
    ({ ...ts('t4', 's1', '2026-11-10T17:00:00Z', 10, 2.13), declared_cash_tips: 0 }), ts('t5', 's1', '2026-11-11T17:00:00Z', 10, 2.13),
    (CA ? { ...ts('t6', 's2', '2026-11-03T15:00:00Z', 13, 15), break_taken: 0 } : ts('t6', 's2', '2026-11-03T15:00:00Z', 8, 15)), ts('t7', 's2', '2026-11-04T15:00:00Z', 8, 15),
  ],
  closed_checks: [
    { location_id: 'L1', tip: 60, staff_id: 'p1', server: 'Sam', status: 'closed', closed_at: '2026-11-04T23:00:00Z' },
    { location_id: 'L1', tip: 200, staff_id: 'p1', server: 'Sam', status: 'closed', closed_at: '2026-11-11T23:00:00Z' },
    { location_id: 'L1', tip: 25, staff_id: 'p2', server: 'Cora', status: 'closed', closed_at: '2026-11-04T23:00:00Z' },
  ],
  wf_payroll_runs: [], wf_tronc_runs: [], wf_tronc_lines: [], wf_time_off: [],
});
await import(process.env.BUNDLE_DIR + '/wfc.mjs');
const res = await handler(new Request('http://x/', { method: 'POST', headers: { Authorization: 'Bearer svc', 'content-type': 'application/json' }, body: JSON.stringify({ action: 'payroll.period', location_id: 'L1', from: '2026-11-01', to: '2026-11-15' }) }));
const j = await res.json();
if (!j.ok) { console.log(JSON.stringify(j)); process.exit(1); }
if (CA) { const c = j.staff.find((s) => s.staff_id === 's2'); console.log(JSON.stringify({ ot: c.overtime_hours, dt: c.double_time_hours, otPremium: c.overtime_premium, meal: c.meal_premium, mealDays: c.meal_premium_days, total: c.total })); process.exit(0); }
const s1 = j.staff.find((s) => s.staff_id === 's1');
console.log(JSON.stringify({ topUp: s1.tip_credit_topup ?? null, cash: s1.tips_cash_declared ?? null, total: s1.total, totals: j.totals.total }));
