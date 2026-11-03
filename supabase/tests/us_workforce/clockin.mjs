// node clockin.mjs <shift|ask|pick|open|refuse|single>: the real staff-portal + workforce-clock (5.12.54).
const sc = process.argv[2];
const env = { SUPABASE_URL: 'http://x', SUPABASE_SERVICE_ROLE_KEY: 'svc', PLATFORM_SUPABASE_URL: 'http://y', PLATFORM_SUPABASE_SERVICE_ROLE_KEY: 'svc2' };
const handlers = []; globalThis.Deno = { env: { get: (k) => env[k] }, serve: (h) => { handlers.push(h); } };
const { DB } = await import(process.env.BUNDLE_DIR + '/mockdb.mjs');
const tz = 'America/Denver';
const parts = (d) => Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d).map((p) => [p.type, p.value]));
const now = new Date(); const a = parts(new Date(now - 30 * 60000)); const b = parts(new Date(+now + 5 * 3600e3));
const today = `${a.year}-${a.month}-${a.day}`;
const linked = sc !== 'single';
Object.assign(DB, {
  locations: [{ id: 'LP', org_id: 'O1', name: 'Provo', timezone: tz, currency: 'USD' }, { id: 'LD', org_id: 'O1', name: 'Daybreak', timezone: tz, currency: 'USD' }],
  wf_staff: [{ id: 'rp', location_id: 'LP', org_id: 'O1', name: 'Sam', person_id: linked ? 'P1' : null, portal_user_id: 'u1', status: 'active', pos_user_id: 'mp' },
    ...(linked ? [{ id: 'rd', location_id: 'LD', org_id: 'O1', name: 'Sam', person_id: 'P1', status: 'active', pos_user_id: 'md' }] : [])],
  staff_members: [{ id: 'mp', name: 'Sam', pin: '1111', active: true, location_id: 'LP' }, { id: 'md', name: 'Sam', pin: '1111', active: true, location_id: 'LD' }],
  wf_venue_settings: [{ location_id: 'LP', settings: {}, clock_geofence: {} }, { location_id: 'LD', settings: sc === 'refuse' ? { clockInNoShift: 'refuse' } : {}, clock_geofence: {} }],
  wf_shifts: sc === 'shift' ? [{ id: 'sh1', staff_id: 'rd', location_id: 'LD', shift_date: today, start_time: `${a.hour}:${a.minute}`, finish_time: `${b.hour}:${b.minute}`, status: 'published' }] : [],
  wf_timesheets: sc === 'open' ? [{ id: 'old', staff_id: 'rp', location_id: 'LP', clock_in: new Date(now - 5 * 3600e3).toISOString(), clock_out: null, break_taken: 0, effective_rate: 12 }] : [],
  wf_clock_events: [], wf_announcements: [], wf_training_assignments: [], wf_onboarding: [], wf_roles: [], user_profiles: [], user_locations: [],
});
await import(process.env.BUNDLE_DIR + '/wcl.mjs');
await import(process.env.BUNDLE_DIR + '/sp.mjs');
const [clock, portal] = handlers;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => (String(url).includes('/functions/v1/workforce-clock') ? clock(new Request('http://x/', init)) : realFetch(url, init));
const call = async (body) => (await portal(new Request('http://x/', { method: 'POST', headers: { Authorization: 'Bearer user', 'content-type': 'application/json' }, body: JSON.stringify(body) }))).json();
const st = await call({ action: 'clock_status' });
let r = await call({ action: 'clock_punch', kind: 'in', punch_id: 'p1' });
if (sc === 'pick') r = await call({ action: 'clock_punch', kind: 'in', punch_id: 'p2', site_id: 'LD' });
let out = null;
if (sc === 'open') out = await call({ action: 'clock_punch', kind: 'out', punch_id: 'p3' });
const sheets = DB.wf_timesheets.map((t) => `${t.staff_id}:${t.clock_out ? 'closed' : 'open'}`).sort().join(',');
console.log(JSON.stringify({ sc, statusSite: st.clock_in_site ?? null, ask: (r.ask_site || st.ask_site || null)?.map((x) => x.site) ?? null, elsewhere: r.open_elsewhere?.site ?? null, landed: r.site ?? null, out: out ? (out.ok === true) : null, sheets }));
