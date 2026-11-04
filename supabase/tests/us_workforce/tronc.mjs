// node tronc.mjs <us|uk>: the real tronc.run on made up rows (5.12.57).
//   us: a $300 pool. The server (8 h) and the cook (8 h at weight 0.5) share it; the supervisor (management
//       group), the salaried manager (exempt by default) and the bar lead (ticked exempt) are left out.
//   uk: the same rows at a UK venue: everyone shares at their tronc weight, as before.
const sc = process.argv[2];
const env = { SUPABASE_URL: 'http://x', SUPABASE_SERVICE_ROLE_KEY: 'svc', PLATFORM_SUPABASE_URL: 'http://y', PLATFORM_SUPABASE_SERVICE_ROLE_KEY: 'svc2' };
let handler; globalThis.Deno = { env: { get: (k) => env[k] }, serve: (h) => { handler = h; } };
const { DB } = await import(process.env.BUNDLE_DIR + '/mockdb.mjs');
const uk = sc === 'uk';
const shift = (staff, role) => ({ location_id: 'L1', staff_id: staff, role_key: role, computed_hours: 8, shift_date: '2026-11-03', status: 'published' });
Object.assign(DB, {
  locations: [{ id: 'L1', org_id: 'O1', currency: uk ? 'GBP' : 'USD', timezone: uk ? 'Europe/London' : 'America/Denver' }],
  user_profiles: [{ id: 'u1', role: 'super_admin' }], user_locations: [],
  wf_venue_settings: [{ location_id: 'L1', settings: { overtimeExempt: { lead: true } } }],
  wf_roles: [
    { location_id: 'L1', key: 'server', grp: 'floor', pay_type: 'hourly', tronc_weight: 1 },
    { location_id: 'L1', key: 'cook', grp: 'kitchen', pay_type: 'hourly', tronc_weight: 0.5 },
    { location_id: 'L1', key: 'sup', grp: 'mgmt', pay_type: 'hourly', tronc_weight: 1 },
    { location_id: 'L1', key: 'gm', grp: 'floor', pay_type: 'salaried', tronc_weight: 1 },
    { location_id: 'L1', key: 'lead', grp: 'bar', pay_type: 'hourly', tronc_weight: 1 },
  ],
  wf_staff: [{ id: 's1', location_id: 'L1', role_key: 'server' }, { id: 's2', location_id: 'L1', role_key: 'cook' },
    { id: 's3', location_id: 'L1', role_key: 'sup' }, { id: 's4', location_id: 'L1', role_key: 'gm' }, { id: 's5', location_id: 'L1', role_key: 'lead' }],
  wf_shifts: [shift('s1', 'server'), shift('s2', 'cook'), shift('s3', 'sup'), shift('s4', 'gm'), shift('s5', 'lead')],
  wf_timesheets: [], wf_tronc_runs: [], wf_tronc_lines: [], wf_audit: [], wf_audit_log: [],
});
await import(process.env.BUNDLE_DIR + '/wfc.mjs');
const r = await (await handler(new Request('http://x/', { method: 'POST', headers: { Authorization: 'Bearer svc', 'content-type': 'application/json' }, body: JSON.stringify({ action: 'tronc.run', location_id: 'L1', week_start: '2026-11-02', pool: 300 }) }))).json();
if (!r.ok) { console.log(JSON.stringify(r)); process.exit(1); }
console.log(JSON.stringify({ sc, paid: r.total_paid, lines: r.lines.map((l) => `${l.staff_id}:${l.payout}`).join(','), leftOut: (r.left_out || []).map((x) => `${x.staff_id}:${x.reason}`).join(',') }));
