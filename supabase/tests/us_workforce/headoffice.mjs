// node headoffice.mjs <scenario>: head office staff (5.12.56, UK and US), the real functions on made up rows.
//   payUs    a US site, monthly pay: a $60,000 head office person, no timesheets: $5,000, its own total;
//            the server beside them is paid exactly as before.
//   payPart  started on 16 Nov: 15 of 30 days, $2,500.
//   payOff   Head office staff off: no salary line, no head office total (a ticked person reads as before).
//   payUk    a UK site, the same person: GBP 5,000.
//   payOld   a database before 20261119a: no head office column, payroll exactly as before.
//   tillHo   the till: status says head office, clock in refused in words, no timesheet made.
//   tillOff  the till with the switch off: the ticked person clocks in as before.
//   appHo    the staff app: clock status says head office, clock in refused in words, no timesheet.
//   appCover head office at Provo and a normal record at Daybreak with a shift now: lands at Daybreak.
//   appClaim the staff app: an open shift claim is refused for head office.
const sc = process.argv[2];
const env = { SUPABASE_URL: 'http://x', SUPABASE_SERVICE_ROLE_KEY: 'svc', PLATFORM_SUPABASE_URL: 'http://y', PLATFORM_SUPABASE_SERVICE_ROLE_KEY: 'svc2' };
const handlers = []; globalThis.Deno = { env: { get: (k) => env[k] }, serve: (h) => { handlers.push(h); } };
const { DB } = await import(process.env.BUNDLE_DIR + '/mockdb.mjs');
const UK = sc === 'payUk';
const on = sc !== 'payOff' && sc !== 'tillOff';
const tz = UK ? 'Europe/London' : 'America/Denver';

if (sc.startsWith('pay')) {
  const ts = (id, staff, startIso, hours, rate) => ({ id, staff_id: staff, location_id: 'L1', status: 'approved', actual_hours: hours, effective_rate: rate, rate_source: 'role', paid_break_mins: 0, pay_amount: hours * rate, clock_in: startIso, clock_out: new Date(Date.parse(startIso) + hours * 3600e3).toISOString() });
  const head = { id: 'h1', location_id: 'L1', org_id: 'O1', name: 'Hana Office', role_key: null, person_id: null, status: 'active',
    ...(sc === 'payOld' ? {} : { head_office: true, salary_annual: 60000 }), ...(sc === 'payPart' ? { start_date: '2026-11-16' } : {}) };
  Object.assign(DB, {
    locations: [{ id: 'L1', org_id: 'O1', currency: UK ? 'GBP' : 'USD', timezone: tz }],
    user_profiles: [{ id: 'u1', role: 'super_admin' }], user_locations: [],
    wf_venue_settings: [{ location_id: 'L1', settings: { tipMode: 'direct', ...(on ? { headOffice: true } : {}) }, premiums: {}, pay_period_type: 'monthly' }],
    wf_staff: [{ id: 's1', location_id: 'L1', org_id: 'O1', name: 'Sam Server', pos_user_id: 'p1', role_key: 'server', person_id: null, status: 'active' }, head],
    wf_roles: [{ location_id: 'L1', key: 'server', pay_type: 'hourly', premium_eligible: true }],
    wf_timesheets: [ts('t1', 's1', '2026-11-03T17:00:00Z', 10, 15), ts('t2', 's1', '2026-11-04T17:00:00Z', 10, 15)],
    closed_checks: [], wf_payroll_runs: [], wf_tronc_runs: [], wf_tronc_lines: [], wf_time_off: [],
  });
  await import(process.env.BUNDLE_DIR + '/wfc.mjs');
  const res = await handlers[0](new Request('http://x/', { method: 'POST', headers: { Authorization: 'Bearer svc', 'content-type': 'application/json' }, body: JSON.stringify({ action: 'payroll.period', location_id: 'L1', from: '2026-11-01', to: '2026-11-30' }) }));
  const j = await res.json();
  if (!j.ok) { console.log(JSON.stringify(j)); process.exit(1); }
  const h = j.staff.find((s) => s.staff_id === 'h1') || null;
  const s1 = j.staff.find((s) => s.staff_id === 's1');
  console.log(JSON.stringify({ sc, salary: h?.salary ?? null, basis: h?.salary_basis ?? null, hoTotal: j.totals.head_office_salary ?? null, server: s1.total, total: j.totals.total, currency: j.region.currency }));
  process.exit(0);
}

if (sc.startsWith('till')) {
  Object.assign(DB, {
    locations: [{ id: 'L1', org_id: 'O1', currency: 'USD', timezone: tz }],
    staff_members: [{ id: 'p1', name: 'Hana Office', pin: '1234', active: true, location_id: 'L1', role: 'Manager' }],
    wf_staff: [{ id: 'h1', location_id: 'L1', org_id: 'O1', name: 'Hana Office', pos_user_id: 'p1', status: 'active', role_key: null, head_office: true, salary_annual: 60000 }],
    wf_timesheets: [],
    wf_venue_settings: [{ location_id: 'L1', settings: on ? { headOffice: true } : {}, premiums: {}, clock_geofence: { pos_login_clock_in: true } }],
    wf_announcements: [], wf_training_assignments: [], wf_onboarding: [], wf_roles: [], wf_shifts: [],
  });
  await import(process.env.BUNDLE_DIR + '/wcl.mjs');
  const call = async (body) => { const r = await handlers[0](new Request('http://x/', { method: 'POST', headers: { Authorization: 'Bearer anon', 'content-type': 'application/json' }, body: JSON.stringify({ location_id: 'L1', pin: '1234', ...body }) })); return { status: r.status, j: await r.json() }; };
  const st = await call({ action: 'status' });
  const inn = await call({ action: 'in' });
  console.log(JSON.stringify({ sc, headOffice: st.j.headOffice, posLoginClockIn: st.j.posLoginClockIn, inStatus: inn.status, inError: inn.j.error || null, sheets: DB.wf_timesheets.length }));
  process.exit(0);
}

// The staff app (staff-portal + workforce-clock, as clockin.mjs).
const parts = (d) => Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d).map((p) => [p.type, p.value]));
const now = new Date(); const a = parts(new Date(now - 30 * 60000)); const b = parts(new Date(+now + 5 * 3600e3));
const today = `${a.year}-${a.month}-${a.day}`;
const cover = sc === 'appCover';
Object.assign(DB, {
  locations: [{ id: 'LP', org_id: 'O1', name: 'Provo', timezone: tz, currency: 'USD' }, { id: 'LD', org_id: 'O1', name: 'Daybreak', timezone: tz, currency: 'USD' }],
  wf_staff: [{ id: 'rp', location_id: 'LP', org_id: 'O1', name: 'Hana', person_id: cover ? 'P1' : null, portal_user_id: 'u1', status: 'active', pos_user_id: 'mp', head_office: true, salary_annual: 60000 },
    ...(cover ? [{ id: 'rd', location_id: 'LD', org_id: 'O1', name: 'Hana', person_id: 'P1', status: 'active', pos_user_id: 'md' }] : [])],
  staff_members: [{ id: 'mp', name: 'Hana', pin: '1111', active: true, location_id: 'LP' }, { id: 'md', name: 'Hana', pin: '1111', active: true, location_id: 'LD' }],
  wf_venue_settings: [{ location_id: 'LP', settings: { headOffice: true }, clock_geofence: {} }, { location_id: 'LD', settings: { headOffice: true }, clock_geofence: {} }],
  wf_shifts: cover ? [{ id: 'sh1', staff_id: 'rd', location_id: 'LD', shift_date: today, start_time: `${a.hour}:${a.minute}`, finish_time: `${b.hour}:${b.minute}`, status: 'published' }] : [],
  wf_timesheets: [], wf_clock_events: [], wf_announcements: [], wf_training_assignments: [], wf_onboarding: [], wf_roles: [], user_profiles: [], user_locations: [],
});
await import(process.env.BUNDLE_DIR + '/wcl.mjs');
await import(process.env.BUNDLE_DIR + '/sp.mjs');
const [clock, portal] = handlers;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => (String(url).includes('/functions/v1/workforce-clock') ? clock(new Request('http://x/', init)) : realFetch(url, init));
const call = async (body) => (await portal(new Request('http://x/', { method: 'POST', headers: { Authorization: 'Bearer user', 'content-type': 'application/json' }, body: JSON.stringify(body) }))).json();
if (sc === 'appClaim') {
  const r = await call({ action: 'shift_claim', shift_id: '00000000-0000-4000-8000-000000000001' });
  console.log(JSON.stringify({ sc, error: r.error || null, code: r.code || null }));
  process.exit(0);
}
const st = await call({ action: 'clock_status' });
const r = await call({ action: 'clock_punch', kind: 'in', punch_id: 'p1' });
const sheets = DB.wf_timesheets.map((t) => `${t.staff_id}:${t.clock_out ? 'closed' : 'open'}`).sort().join(',');
console.log(JSON.stringify({ sc, headOffice: st.head_office ?? null, statusSite: st.clock_in_site ?? null, refused: r.refused === true, reason: r.reason || null, landed: r.site ?? null, sheets }));
