// node leave.mjs <primary|single|usOff|usOn>: the real timeoff.decide with a primary location (5.12.55, UK and US).
//   usOff: a US venue with PTO switched off: the approved request is unpaid and nothing is deducted (5.12.57).
//   usOn:  the same with PTO on: paid and deducted, as holiday is.
const sc = process.argv[2];
const us = sc === 'usOff' || sc === 'usOn';
const env = { SUPABASE_URL: 'http://x', SUPABASE_SERVICE_ROLE_KEY: 'svc', PLATFORM_SUPABASE_URL: 'http://y', PLATFORM_SUPABASE_SERVICE_ROLE_KEY: 'svc2' };
let handler; globalThis.Deno = { env: { get: (k) => env[k] }, serve: (h) => { handler = h; } };
const { DB } = await import(process.env.BUNDLE_DIR + '/mockdb.mjs');
const linked = sc === 'primary';
Object.assign(DB, {
  locations: [{ id: 'LP', org_id: 'O1', currency: us ? 'USD' : 'GBP', timezone: us ? 'America/Denver' : 'Europe/London' }, { id: 'LD', org_id: 'O1', currency: 'GBP', timezone: 'Europe/London' }],
  user_profiles: [{ id: 'u1', role: 'super_admin' }], user_locations: [],
  wf_venue_settings: [{ location_id: 'LP', settings: { holidayDayHours: 2, ...(sc === 'usOn' ? { ptoEnabled: true } : {}) } }, { location_id: 'LD', settings: { holidayDayHours: 2 } }],
  wf_staff: [{ id: 'rp', location_id: 'LP', org_id: 'O1', person_id: linked ? 'P1' : null, primary_venue_id: 'LP', created_at: '2026-10-01', status: 'active', contract_type: 'partTime', role_key: 'server' },
    ...(linked ? [{ id: 'rd', location_id: 'LD', org_id: 'O1', person_id: 'P1', primary_venue_id: 'LP', created_at: '2026-11-01', status: 'active', contract_type: 'partTime', role_key: 'server' }] : [])],
  wf_roles: [{ location_id: 'LP', key: 'server', base_rate: 12 }, { location_id: 'LD', key: 'server', base_rate: 12 }],
  wf_timesheets: [],
  wf_holiday_accrual: [{ location_id: 'LP', staff_id: 'rp', kind: 'accrual', accrued_hours: 1.5 }, ...(linked ? [{ location_id: 'LD', staff_id: 'rd', kind: 'accrual', accrued_hours: 1 }] : [])],
  wf_time_off: [{ id: 'to1', location_id: linked ? 'LD' : 'LP', staff_id: linked ? 'rd' : 'rp', type: 'holiday', start_date: '2026-11-10', end_date: '2026-11-10', days: 1, status: 'pending' }],
  wf_audit: [], wf_audit_log: [],
});
await import(process.env.BUNDLE_DIR + '/wfc.mjs');
const r = await (await handler(new Request('http://x/', { method: 'POST', headers: { Authorization: 'Bearer svc', 'content-type': 'application/json' }, body: JSON.stringify({ action: 'timeoff.decide', location_id: linked ? 'LD' : 'LP', time_off_id: 'to1', status: 'approved', paid: true }) }))).json();
const req = DB.wf_time_off[0];
const taken = DB.wf_holiday_accrual.filter((x) => x.kind === 'taken').map((x) => `${x.staff_id}@${x.location_id}:${x.accrued_hours}`).join(',');
if (us) { console.log(JSON.stringify({ sc, ok: r.ok ?? null, paid: req.paid, deducted: req.deducted_hours ?? null, taken, balance: r.balance ?? null, note: r.note ?? null })); process.exit(0); }
console.log(JSON.stringify({ sc, ok: r.ok ?? null, error: r.error ?? null, request: `${req.staff_id}@${req.location_id}`, taken, balance: r.balance ?? null }));
