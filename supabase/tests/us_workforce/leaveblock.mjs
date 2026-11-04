// node leaveblock.mjs <us|uk|sick|outside|snapshot>: blocked periods in the real staff-portal (5.12.61, UK and US).
//   us:       a PTO request inside a block at a US venue is refused in words ("No PTO requests from Dec 20, 2026 ...").
//   uk:       the same at a UK venue reads "No holiday requests from 20 Dec 2026 to 3 Jan 2027 (Christmas)".
//   sick:     sick leave inside the block goes through.
//   outside:  a PTO request outside every block goes through.
//   snapshot: the snapshot lists the upcoming blocks with their words (past ones left out).
const sc = process.argv[2];
const uk = sc === 'uk';
const env = { SUPABASE_URL: 'http://x', SUPABASE_SERVICE_ROLE_KEY: 'svc', PLATFORM_SUPABASE_URL: 'http://y', PLATFORM_SUPABASE_SERVICE_ROLE_KEY: 'svc2' };
const handlers = []; globalThis.Deno = { env: { get: (k) => env[k] }, serve: (h) => { handlers.push(h); } };
const { DB } = await import(process.env.BUNDLE_DIR + '/mockdb.mjs');
Object.assign(DB, {
  locations: [{ id: 'LP', org_id: 'O1', name: 'Provo', timezone: uk ? 'Europe/London' : 'America/Denver', currency: uk ? 'GBP' : 'USD' }],
  wf_staff: [{ id: 'rp', location_id: 'LP', org_id: 'O1', name: 'Sam', person_id: null, portal_user_id: 'u1', status: 'active', primary_venue_id: 'LP', created_at: '2026-10-01' }],
  wf_venue_settings: [{ location_id: 'LP', settings: { leaveBlocks: [
    { from: '2026-12-20', to: '2027-01-03', note: 'Christmas' },
    { from: '2025-12-20', to: '2026-01-03', note: 'Last year' },
    { from: '2027-07-04', to: '2027-07-04', note: '' },
  ] }, clock_geofence: {} }],
  wf_shifts: [], wf_timesheets: [], wf_time_off: [], wf_clock_events: [], wf_announcements: [], wf_training_assignments: [], wf_onboarding: [], wf_roles: [],
  wf_holiday_accrual: [], wf_availability: [], wf_swap_requests: [], user_profiles: [], user_locations: [], wf_audit: [], wf_audit_log: [],
});
await import(process.env.BUNDLE_DIR + '/sp.mjs');
const portal = handlers[0];
const call = async (body) => { const res = await portal(new Request('http://x/', { method: 'POST', headers: { Authorization: 'Bearer user', 'content-type': 'application/json' }, body: JSON.stringify(body) })); return { status: res.status, body: await res.json() }; };
if (sc === 'snapshot') {
  const snap = await call({ action: 'snapshot' });
  const blocks = (snap.body?.leave?.blocks ?? []).map((b) => `${b.from}..${b.to}|${b.words}`);
  console.log(JSON.stringify({ sc, status: snap.status, blocks }));
  process.exit(0);
}
const req = sc === 'sick' ? { type: 'sick', from: '2026-12-28', to: '2026-12-29' }
  : sc === 'outside' ? { type: 'holiday', from: '2026-12-10', to: '2026-12-12' }
  : { type: 'holiday', from: '2026-12-28', to: '2027-01-02' };
const r = await call({ action: 'timeoff_request', ...req, note: '' });
console.log(JSON.stringify({ sc, status: r.status, error: r.body.error ?? null, code: r.body.code ?? null, filed: DB.wf_time_off.length }));
