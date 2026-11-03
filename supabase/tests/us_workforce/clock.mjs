// One scenario per process: node run_clock.mjs <scenario>
const sc = process.argv[2];
const env = { SUPABASE_URL: 'http://x', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
let handler; globalThis.Deno = { env: { get: (k) => env[k] }, serve: (h) => { handler = h; } };
const { DB } = await import(process.env.BUNDLE_DIR + '/mockdb.mjs');
const us = sc !== 'uk' && sc !== 'ukAuto';
// 5.12.52: the clock out auto deduct with a state rule (CA), none (Utah) and the UK.
const auto = { caAuto: { autoBreak: true, defaultBreakMins: 10, autoBreakHours: 4, usBreaks: { state: 'CA' } }, utAuto: { autoBreak: true, defaultBreakMins: 10, autoBreakHours: 4 }, ukAuto: { autoBreak: true, defaultBreakMins: 10, autoBreakHours: 4 } }[sc];
Object.assign(DB, {
  locations: [{ id: 'L1', org_id: 'O1', currency: us ? 'USD' : 'GBP', timezone: us ? 'America/Denver' : 'Europe/London' }],
  staff_members: [{ id: 'p1', name: 'Sam Server', pin: '1234', active: true, location_id: 'L1', role: 'Server' }],
  wf_staff: [{ id: 's1', location_id: 'L1', org_id: 'O1', name: 'Sam Server', pos_user_id: 'p1', status: 'active', role_key: 'server' }],
  wf_timesheets: [{ id: 't1', staff_id: 's1', location_id: 'L1', clock_in: new Date(Date.now() - 6 * 3600e3).toISOString(), clock_out: null, break_taken: 0, effective_rate: 2.13, rate_source: 'role', scheduled_hours: 6, status: 'open' }],
  wf_venue_settings: [{ location_id: 'L1', settings: auto || (sc === 'off' ? { askCashTips: false } : {}), premiums: {}, clock_geofence: {} }],
  wf_announcements: [], wf_training_assignments: [], wf_onboarding: [], wf_roles: [],
  __missingCols: sc === 'oldDb' ? ['declared_cash_tips'] : [],
});
await import(process.env.BUNDLE_DIR + '/wcl.mjs');
const call = async (body) => { const r = await handler(new Request('http://x/', { method: 'POST', headers: { Authorization: 'Bearer anon', 'content-type': 'application/json' }, body: JSON.stringify({ location_id: 'L1', pin: '1234', ...body }) })); return { status: r.status, j: await r.json() }; };
const st = await call({ action: 'status' });
const tips = { us: '24.50', off: '30', uk: '30', bad: 'abc', oldDb: '12', older: undefined, caAuto: '0', utAuto: '0', ukAuto: undefined }[sc];
const out = await call({ action: 'out', ...(tips !== undefined ? { cash_tips: tips } : {}) });
const sheet = DB.wf_timesheets[0];
if (auto) { console.log(JSON.stringify({ sc, breakMins: out.j.breakMins, autoBreak: out.j.autoBreak ?? null })); process.exit(0); }
console.log(JSON.stringify({ sc, askCashTips: st.j.askCashTips, outStatus: out.status, outError: out.j.error || null, field: out.j.field || null, clockedOut: !!sheet.clock_out, declared: sheet.declared_cash_tips ?? null, replyCashTips: out.j.cashTips ?? null }));
