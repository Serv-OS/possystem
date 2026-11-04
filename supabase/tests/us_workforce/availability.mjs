// node availability.mjs <next|published|again|uk>: a staff app availability change applies from the next
// rota period in the real staff-portal (5.12.61, UK and US).
//   next:      no rota published: the change is filed with week_start = the Monday after this week; the base
//              row (week_start null) is untouched; the snapshot shows today's pattern and the pending one.
//   published: a rota is published two weeks out: the change is filed for the week after that.
//   again:     a second change before it applies updates the same pending row (one pending change at a time).
//   uk:        the same at a UK venue, words in UK date order.
const sc = process.argv[2];
const uk = sc === 'uk';
const env = { SUPABASE_URL: 'http://x', SUPABASE_SERVICE_ROLE_KEY: 'svc', PLATFORM_SUPABASE_URL: 'http://y', PLATFORM_SUPABASE_SERVICE_ROLE_KEY: 'svc2' };
const handlers = []; globalThis.Deno = { env: { get: (k) => env[k] }, serve: (h) => { handlers.push(h); } };
const { DB } = await import(process.env.BUNDLE_DIR + '/mockdb.mjs');
const tz = uk ? 'Europe/London' : 'America/Denver';
const ymd = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const today = ymd(new Date());
// Worked out on its own here: Monday of the week holding `base`, plus 7 days.
const mondayAfter = (base) => { const [y, m, d] = base.split('-').map(Number); const dt = new Date(Date.UTC(y, m - 1, d)); const dow = (dt.getUTCDay() + 6) % 7; dt.setUTCDate(dt.getUTCDate() - dow + 7); return dt.toISOString().slice(0, 10); };
const plus = (base, n) => { const [y, m, d] = base.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const lastPublished = sc === 'published' ? plus(today, 14) : null;
const expected = mondayAfter(lastPublished || today);
Object.assign(DB, {
  locations: [{ id: 'LP', org_id: 'O1', name: 'Provo', timezone: tz, currency: uk ? 'GBP' : 'USD' }],
  wf_staff: [{ id: 'rp', location_id: 'LP', org_id: 'O1', name: 'Sam', person_id: null, portal_user_id: 'u1', status: 'active', primary_venue_id: 'LP', created_at: '2026-10-01' }],
  wf_venue_settings: [{ location_id: 'LP', settings: {}, clock_geofence: {} }],
  wf_shifts: lastPublished ? [{ id: 'sh1', staff_id: 'rp', location_id: 'LP', shift_date: lastPublished, start_time: '09:00', finish_time: '17:00', status: 'published' }] : [],
  wf_availability: [{ id: 'base', staff_id: 'rp', location_id: 'LP', org_id: 'O1', recurring: true, week_start: null, per_day: [{ day: 1, state: 'unavailable' }], updated_at: '2026-10-01T00:00:00Z' }],
  wf_timesheets: [], wf_time_off: [], wf_clock_events: [], wf_announcements: [], wf_training_assignments: [], wf_onboarding: [], wf_roles: [],
  wf_holiday_accrual: [], wf_swap_requests: [], user_profiles: [], user_locations: [], wf_audit: [], wf_audit_log: [],
});
await import(process.env.BUNDLE_DIR + '/sp.mjs');
const portal = handlers[0];
const call = async (body) => { const res = await portal(new Request('http://x/', { method: 'POST', headers: { Authorization: 'Bearer user', 'content-type': 'application/json' }, body: JSON.stringify(body) })); return { status: res.status, body: await res.json() }; };
const perDay = (state) => [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, state: day === 3 ? state : 'available' }));
let r = await call({ action: 'availability_set', per_day: perDay('unavailable') });
if (sc === 'again') r = await call({ action: 'availability_set', per_day: perDay('preferred') });
const snap = await call({ action: 'snapshot' });
const av = snap.body?.availability ?? {};
const rows = DB.wf_availability.map((x) => `${x.week_start === expected ? 'NEXT' : x.week_start ?? 'base'}:${(x.per_day || []).filter((p) => p.state !== 'available').map((p) => `${p.day}=${p.state}`).join('+')}`).sort().join(',');
console.log(JSON.stringify({
  sc, status: r.status, changesFromOk: r.body.changesFrom === expected, words: r.body.words === av.words && /^Changes apply from Mon, .*, the next rota period\. Weeks already on the rota keep your current availability\.$/.test(av.words || '') ? 'ok' : av.words,
  rows, nowPattern: (av.perDay || []).map((p) => `${p.day}=${p.state}`).join('+'),
  pending: av.pending ? `${av.pending.from === expected ? 'NEXT' : av.pending.from}:${(av.pending.perDay || []).filter((p) => p.state !== 'available').map((p) => `${p.day}=${p.state}`).join('+')}` : null,
}));
