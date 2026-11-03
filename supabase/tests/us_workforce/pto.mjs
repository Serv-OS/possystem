// node pto.mjs <us|off|uk|cap>: the real accrual.run on made up rows (5.12.51).
const sc = process.argv[2];
const env = { SUPABASE_URL: 'http://x', SUPABASE_SERVICE_ROLE_KEY: 'svc', PLATFORM_SUPABASE_URL: 'http://y', PLATFORM_SUPABASE_SERVICE_ROLE_KEY: 'svc2' };
let handler; globalThis.Deno = { env: { get: (k) => env[k] }, serve: (h) => { handler = h; } };
const { DB } = await import(process.env.BUNDLE_DIR + '/mockdb.mjs');
const uk = sc === 'uk';
const settings = sc === 'off' ? {} : sc === 'cap' ? { ptoEnabled: true, ptoEvery: 30, ptoYearCap: 1.5 } : { ptoEnabled: true };
const ts = (id, staff, day, hours) => ({ id, staff_id: staff, location_id: 'L1', status: 'approved', actual_hours: hours, effective_rate: 12, currency: uk ? 'GBP' : 'USD', clock_in: `${day}T17:00:00Z` });
Object.assign(DB, {
  locations: [{ id: 'L1', org_id: 'O1', currency: uk ? 'GBP' : 'USD', timezone: uk ? 'Europe/London' : 'America/Denver' }],
  user_profiles: [{ id: 'u1', role: 'super_admin' }], user_locations: [],
  wf_venue_settings: [{ location_id: 'L1', settings, accrual_rate: 0.1207, premiums: {} }],
  wf_staff: [{ id: 's1', location_id: 'L1', contract_type: 'partTime', role_key: 'server', rate_override: null },
             { id: 's2', location_id: 'L1', contract_type: 'salaried', role_key: 'mgr', rate_override: null }],
  wf_roles: [{ location_id: 'L1', key: 'server', base_rate: 12, salary_annual: null }, { location_id: 'L1', key: 'mgr', base_rate: null, salary_annual: 50000 }],
  wf_timesheets: [ts('t1', 's1', '2026-11-03', 30), ts('t2', 's1', '2026-11-04', 30), ts('t3', 's2', '2026-11-03', 40)],
  wf_holiday_accrual: [], wf_audit: [], wf_audit_log: [],
});
await import(process.env.BUNDLE_DIR + '/wfc.mjs');
const run = async () => (await handler(new Request('http://x/', { method: 'POST', headers: { Authorization: 'Bearer svc', 'content-type': 'application/json' }, body: JSON.stringify({ action: 'accrual.run', location_id: 'L1' }) }))).json();
const first = await run();
const again = await run();
const rows = DB.wf_holiday_accrual.map((r) => `${r.staff_id}:${r.accrued_hours}`).sort().join(',');
console.log(JSON.stringify({ sc, first: { accrued: first.accrued, hours: first.hours, off: first.off || null }, again: again.accrued, rows }));
