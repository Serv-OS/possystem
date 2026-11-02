#!/usr/bin/env node
// run.mjs: proves 20261112a (one person, many sites, part two) on a local, throwaway PostgreSQL,
// before Peter runs it on the Ops database. It never connects to Supabase.
//
//   node supabase/tests/wf_people_across_sites_2/run.mjs
//
// Builds the live shape (schema.sql), applies the live chain 20261031a, 20261104a, 20261111a, then
// 20261112a, and proves:
//   1. it applies, its check row reads as documented, a second run is refused;
//   2. claims count every linked site: an open shift overlapping their shift at another site, or
//      taking them past the most hours a week counting every site, is refused; unlinked it is not;
//   3. Peter's week: 20 hours at Provo then 25 at Daybreak puts 5 overtime hours and the half time at
//      the blended rate on the Daybreak timesheet that crossed 40; a UK site never has overtime;
//   4. the columns follow every change (approve, edit hours, move a day, delete), cannot be written
//      from the API, and follow linking and unlinking;
//   5. PARITY: on random weeks (people at two or three sites, different time zones and week starts,
//      mixed statuses) every timesheet's stored overtime equals sheetOvertime in
//      supabase/functions/_shared/multiSiteOvertime.js, the rule payroll and the reports share;
//   6. the ROLLBACK puts the claim check back as it was and the migration applies again.
// Exit code 0 only when every check holds.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
const M = (f) => join(repo, 'supabase/migrations', f);
const CHAIN = ['20261031a_OPS_wf_open_shifts.sql', '20261104a_OPS_wf_staff_identity_fence.sql', '20261111a_OPS_wf_people_across_sites.sql'].map(M);
const MIGRATION = M('20261112a_OPS_wf_people_across_sites_2.sql');
const ROLLBACK = M('20261112a_OPS_wf_people_across_sites_2_ROLLBACK.sql');
const { sheetOvertime } = await import(pathToFileURL(join(repo, 'supabase/functions/_shared/multiSiteOvertime.js')).href);

const bin = (name) => (existsSync(`/opt/homebrew/bin/${name}`) ? `/opt/homebrew/bin/${name}` : name);
const env = { ...process.env, LC_ALL: 'en_US.UTF-8', PGOPTIONS: '-c client_min_messages=warning' };
let failures = 0, passes = 0;
const ok = (cond, msg) => { if (cond) { passes++; console.log(`  ok   ${msg}`); } else { failures++; console.log(`  FAIL ${msg}`); } };

const port = process.env.WFPB_PGPORT || String(55800 + Math.floor(Math.random() * 80));
const dir = mkdtempSync(join(tmpdir(), 'pgq.'));
const data = join(dir, 'data');
{
  let r = spawnSync(bin('initdb'), ['-D', data, '-U', 'postgres', '--auth=trust', '-E', 'UTF8'], { env, encoding: 'utf8' });
  if (r.status !== 0) { console.error(r.stderr || r.stdout); process.exit(2); }
  r = spawnSync(bin('pg_ctl'), ['-D', data, '-l', join(dir, 'pg.log'), '-w', '-o', `-p ${port} -c listen_addresses='' -k ${dir} -c timezone=UTC`, 'start'], { env, encoding: 'utf8' });
  if (r.status !== 0) { console.error(r.stderr || r.stdout); process.exit(2); }
}
function stop() { spawnSync(bin('pg_ctl'), ['-D', data, '-m', 'fast', '-w', 'stop'], { env, encoding: 'utf8' }); rmSync(dir, { recursive: true, force: true }); }
process.on('uncaughtException', (e) => { console.error(e); stop(); process.exit(2); });

const psqlArgs = (login, extra = []) => ['-h', dir, '-p', port, '-U', login, '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-X', '-q', '-At', ...extra];
function psql({ login = 'postgres', input, args = [], allowFail = false }) {
  const r = spawnSync(bin('psql'), psqlArgs(login, args), { env, input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0 && !allowFail) { console.error('psql failed:\n', input?.slice(0, 600), '\n', r.stderr || r.stdout); stop(); process.exit(2); }
  return r;
}
const sql = (q) => psql({ input: q }).stdout.trim();
const lit = (v) => (v == null ? 'null' : `'${String(v).replace(/'/g, "''")}'`);
const id = (p, n) => `${p}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ORG = id('0a000000', 1);
const PROVO = id('a0000000', 1), DAYBREAK = id('a0000000', 2), LEEDS = id('a0000000', 3), LA = id('a0000000', 4);
const MGR = id('10000000', 1);
const J = { provo: id('5a000000', 1), day: id('5a000000', 2) };
const SAM = id('5a000000', 3), UKP = id('5a000000', 4);
const PJ = id('9e000000', 1);

function as(role, body, { sub = null } = {}) {
  const claims = role === 'service_role' ? { role } : { role, sub, aud: 'authenticated', is_anonymous: false };
  const input = ['\\set VERBOSITY verbose', 'begin;', `select set_config('request.jwt.claims', ${lit(JSON.stringify(claims))}, true) \\g /dev/null`,
    `set local role ${role};`, body.trim().replace(/;?$/, ';'), 'commit;'].join('\n') + '\n';
  const r = psql({ login: 'authenticator', input, allowFail: true });
  const m = /ERROR:\s+([0-9A-Z]{5}):\s*(.*)/.exec(r.stderr || '');
  return { status: r.status, sqlstate: m ? m[1] : null, message: m ? m[2] : (r.stderr || '').trim(), out: r.stdout.trim() };
}
const ts = (staff, loc, at, hours, pay, status = 'approved', extra = '') => sql(`insert into public.wf_timesheets (location_id, org_id, staff_id, clock_in, clock_out, actual_hours, effective_rate, pay_amount, status${extra ? ', paid_break_mins' : ''})
  values (${lit(loc)}, ${lit(ORG)}, ${lit(staff)}, ${lit(at)}, ${lit(at)}::timestamptz + interval '${hours} hours', ${hours}, ${(pay / hours).toFixed(4)}, ${pay}, ${lit(status)}${extra ? `, ${extra}` : ''}) returning id`);
const otOf = (sheet) => sql(`select overtime_hours || '|' || overtime_premium from public.wf_timesheets where id = ${lit(sheet)}`);

try {
  console.log('schema and the live chain');
  psql({ args: ['-1', '-f', join(here, 'schema.sql')] });
  sql(`insert into public.locations (id, org_id, name, timezone, currency) values
         (${lit(PROVO)}, ${lit(ORG)}, 'Provo', 'America/Denver', 'USD'), (${lit(DAYBREAK)}, ${lit(ORG)}, 'Daybreak', 'America/Denver', 'USD'),
         (${lit(LEEDS)}, ${lit(ORG)}, 'Leeds', 'Europe/London', 'GBP'), (${lit(LA)}, ${lit(ORG)}, 'San Mateo', 'America/Los_Angeles', 'USD');
       insert into public.user_profiles (id, org_id, location_id, full_name, email, role) values (${lit(MGR)}, ${lit(ORG)}, ${lit(PROVO)}, 'Mo', 'mo@example.test', 'manager');
       insert into public.user_locations (user_id, location_id, role) values (${lit(MGR)}, ${lit(PROVO)}, 'manager'), (${lit(MGR)}, ${lit(DAYBREAK)}, 'manager');`);
  for (const f of CHAIN) psql({ args: ['-1', '-f', f] });
  sql(`insert into public.wf_staff (id, org_id, location_id, name, role_key, status, person_id) values
         (${lit(J.provo)}, ${lit(ORG)}, ${lit(PROVO)}, 'Jane', 'floor', 'active', ${lit(PJ)}),
         (${lit(J.day)}, ${lit(ORG)}, ${lit(DAYBREAK)}, 'Jane', 'floor', 'active', ${lit(PJ)}),
         (${lit(SAM)}, ${lit(ORG)}, ${lit(PROVO)}, 'Sam', 'floor', 'active', null),
         (${lit(UKP)}, ${lit(ORG)}, ${lit(LEEDS)}, 'Ula', 'floor', 'active', null);
       insert into public.wf_venue_settings (location_id, org_id, settings) values (${lit(PROVO)}, ${lit(ORG)}, '{"shiftSwaps": {"maxWeeklyHours": 30}}');`);

  console.log('1. the migration');
  const check = psql({ args: ['-1', '-f', MIGRATION] }).stdout.trim().split('\n').pop();
  ok(check === '2|t|f|3|t|0|t', `check row reads 2|t|f|3|t|0|t (got ${check})`);
  const again = psql({ args: ['-1', '-f', MIGRATION], allowFail: true });
  ok(again.status !== 0 && /has run already/.test(again.stderr), 'a second run is refused');

  console.log('2. claims count every linked site');
  // Next Tuesday and Wednesday in Denver, well in the future.
  const tue = sql(`select (current_date + 14 + ((2 - extract(isodow from current_date + 14)::int + 7) % 7))::text`);
  const wed = sql(`select (${lit(tue)}::date + 1)::text`);
  const thu = sql(`select (${lit(tue)}::date + 2)::text`);
  const shift = (loc, staff, date, a, b, status = 'published') => sql(`insert into public.wf_shifts (location_id, org_id, staff_id, role_key, shift_date, start_time, finish_time, status)
    values (${lit(loc)}, ${lit(ORG)}, ${staff ? lit(staff) : 'null'}, 'floor', ${lit(date)}, ${lit(a)}, ${lit(b)}, ${lit(status)}) returning id`);
  shift(DAYBREAK, J.day, tue, '12:00', '18:00');
  const open = shift(PROVO, null, tue, '14:00', '20:00');
  const problem = (sh, staff) => sql(`select coalesce(public._wf_claim_problem(${lit(sh)}, ${lit(staff)}, null, false), 'none')`);
  ok(problem(open, J.provo) === 'overlap', 'an open shift overlapping their Daybreak shift is refused');
  ok(problem(open, SAM) === 'none', 'someone not working at Daybreak can take it');
  const late = shift(PROVO, null, tue, '18:00', '23:00');
  ok(problem(late, J.provo) === 'none', 'a shift starting when the Daybreak one ends is fine');
  shift(DAYBREAK, J.day, wed, '08:00', '20:00'); shift(DAYBREAK, J.day, thu, '08:00', '17:00');   // 6 + 12 + 9 = 27 h at Daybreak
  const fri = shift(PROVO, null, sql(`select (${lit(tue)}::date + 3)::text`), '09:00', '14:00');
  ok(problem(fri, J.provo) === 'hours_cap', 'a 5 h shift on top of 27 h at Daybreak is over the 30 h most a week');
  ok(problem(fri, SAM) === 'none', 'and fine for someone with no other site');
  sql(`update public.wf_staff set person_id = null where id = ${lit(J.day)}`);
  ok(problem(open, J.provo) === 'none' && problem(fri, J.provo) === 'none', 'unlinked, Daybreak no longer counts');
  sql(`update public.wf_staff set person_id = ${lit(PJ)} where id = ${lit(J.day)}`);

  console.log("3. Peter's week");
  // Mon 26 Oct to Sun 1 Nov 2026 (Monday weeks). 15:00Z = 09:00 Denver.
  const s1 = ts(J.provo, PROVO, '2026-10-26T15:00:00Z', 8, 120), s2 = ts(J.provo, PROVO, '2026-10-27T15:00:00Z', 8, 120), s3 = ts(J.provo, PROVO, '2026-10-28T15:00:00Z', 4, 60);
  const d1 = ts(J.day, DAYBREAK, '2026-10-29T15:00:00Z', 8, 136), d2 = ts(J.day, DAYBREAK, '2026-10-30T15:00:00Z', 8, 136), d3 = ts(J.day, DAYBREAK, '2026-10-31T15:00:00Z', 9, 153);
  ok([s1, s2, s3, d1, d2].every((x) => otOf(x) === '0.00|0.00'), 'the first 40 hours carry no overtime');
  ok(otOf(d3) === '5.00|40.28', `the Daybreak timesheet that crossed 40 carries 5 h and $40.28 (got ${otOf(d3)})`);
  const lab = sql(`select pay from public.stock_rp__labour(${lit(DAYBREAK)}, '2026-10-26', '2026-11-01')`);
  ok(Number(lab) === 425 + 40.28, `Stock and GP labour at Daybreak adds the premium: 425 + 40.28 (got ${lab})`);
  const u1 = ts(UKP, LEEDS, '2026-10-26T09:00:00Z', 50, 600);
  ok(otOf(u1) === '0.00|0.00', 'a UK site never has overtime');

  console.log('4. the columns follow every change');
  const p = ts(J.provo, PROVO, '2026-10-26T23:00:00Z', 3, 45, 'pending');
  ok(otOf(p) === '0.00|0.00' && otOf(d3) === '5.00|40.28', 'a pending timesheet counts for nothing');
  sql(`update public.wf_timesheets set status = 'approved' where id = ${lit(p)}`);
  ok(otOf(p) === '0.00|0.00' && otOf(d3) === '8.00|64.17', `approving it (earlier in the week) moves 3 more hours to the Daybreak timesheet: 770 / 48 = 16.0417, 8 x half = 64.17 (got ${otOf(d3)})`);
  sql(`update public.wf_timesheets set clock_in = '2026-11-02T15:00:00Z', clock_out = '2026-11-02T18:00:00Z' where id = ${lit(p)}`);
  ok(otOf(d3) === '5.00|40.28' && otOf(p) === '0.00|0.00', 'moving it into next week puts this week back');
  sql(`update public.wf_timesheets set actual_hours = 10, pay_amount = 170 where id = ${lit(d3)}`);
  ok(otOf(d3) === '6.00|48.39', `editing hours recomputes: 742 / 46 = 16.1304, 6 x half = 48.39 (got ${otOf(d3)})`);
  sql(`delete from public.wf_timesheets where id = ${lit(d1)}`);
  ok(otOf(d3) === '0.00|0.00', 'deleting a timesheet recomputes');
  sql(`insert into public.wf_timesheets (id, location_id, org_id, staff_id, clock_in, clock_out, actual_hours, effective_rate, pay_amount, status) values
         (${lit(d1)}, ${lit(DAYBREAK)}, ${lit(ORG)}, ${lit(J.day)}, '2026-10-29T15:00:00Z', '2026-10-29T23:00:00Z', 8, 17, 136, 'approved')`);
  sql(`update public.wf_timesheets set actual_hours = 9, pay_amount = 153 where id = ${lit(d3)}`);
  ok(otOf(d3) === '5.00|40.28', 'and back');
  let r = as('authenticated', `update public.wf_timesheets set overtime_premium = 999, overtime_hours = 99 where id = ${lit(d3)}`, { sub: MGR });
  ok(r.status === 0 && otOf(d3) === '5.00|40.28', 'a Back Office write to the columns changes nothing');
  r = as('authenticated', `select public.wf_ot_recompute(${lit(J.day)}, now())`, { sub: MGR });
  ok(r.sqlstate === '42501', 'the recompute is not callable from the API');
  sql(`update public.wf_staff set person_id = null where id = ${lit(J.day)}`);
  ok(otOf(d3) === '0.00|0.00', 'unlinking recomputes: Daybreak alone is 25 h');
  sql(`update public.wf_staff set person_id = ${lit(PJ)} where id = ${lit(J.day)}`);
  ok(otOf(d3) === '5.00|40.28', 'linking again recomputes');

  console.log('5. parity with multiSiteOvertime.js on random weeks');
  let seed = 20261102;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  sql(`update public.wf_venue_settings set settings = settings || '{"workweekStart": "0"}' where location_id = ${lit(PROVO)};
       insert into public.wf_venue_settings (location_id, org_id, settings) values (${lit(LA)}, ${lit(ORG)}, '{"workweekStart": "3"}');`);
  const people = [];
  for (let i = 0; i < 6; i++) {
    const person = id('9f000000', i + 1);
    const sites = [PROVO, DAYBREAK, LA].filter((_, k) => k < 2 + (i % 2));
    const recs = sites.map((loc, k) => ({ id: id(`6${i}000000`, k + 1), loc }));
    sql(`insert into public.wf_staff (id, org_id, location_id, name, role_key, status, person_id) values ${recs.map((x) => `(${lit(x.id)}, ${lit(ORG)}, ${lit(x.loc)}, 'P${i}', 'floor', 'active', ${lit(person)})`).join(', ')}`);
    people.push({ person, recs });
  }
  const tzOf = { [PROVO]: 'America/Denver', [DAYBREAK]: 'America/Denver', [LA]: 'America/Los_Angeles' };
  const wsdOf = { [PROVO]: 0, [DAYBREAK]: 1, [LA]: 3 };
  const rows = [];
  const values = [];
  for (const pp of people) {
    for (let k = 0; k < 30; k++) {
      const rec = pp.recs[Math.floor(rnd() * pp.recs.length)];
      const start = Date.parse('2026-10-19T00:00:00Z') + Math.floor(rnd() * 14 * 24) * 3600000 + Math.floor(rnd() * 4) * 900000;
      const hours = Math.round((4 + rnd() * 8) * 100) / 100;
      const rate = [12.5, 15, 17.25, 19.8][Math.floor(rnd() * 4)];
      const pay = Math.round((hours * rate + (rnd() < 0.3 ? Math.round(rnd() * 2000) / 100 : 0)) * 100) / 100;
      const brk = [0, 0, 15, 30][Math.floor(rnd() * 4)];
      const status = ['approved', 'approved', 'paid', 'paid', 'approved', 'pending', 'rejected'][Math.floor(rnd() * 7)];
      const sid = id('7f000000', rows.length + 1);
      const iso = new Date(start).toISOString();
      rows.push({ id: sid, staff_id: rec.id, person: pp.person, clock_in: iso, actual_hours: hours, paid_break_mins: brk, pay_amount: pay, status, tz: tzOf[rec.loc], week_start_dow: wsdOf[rec.loc] });
      values.push(`(${lit(sid)}, ${lit(rec.loc)}, ${lit(ORG)}, ${lit(rec.id)}, ${lit(iso)}, ${lit(iso)}::timestamptz + interval '${hours} hours', ${hours}, ${rate}, ${pay}, ${lit(status)}, ${brk})`);
    }
  }
  // One at a time, the way the till and the Back Office write them (each fires the recompute).
  sql(values.map((v) => `insert into public.wf_timesheets (id, location_id, org_id, staff_id, clock_in, clock_out, actual_hours, effective_rate, pay_amount, status, paid_break_mins) values ${v};`).join('\n'));
  const stored = Object.fromEntries(sql(`select id || '|' || overtime_hours || '|' || overtime_premium from public.wf_timesheets where id::text like '7f000000%'`)
    .split('\n').map((l) => { const [a, h, pr] = l.split('|'); return [a, { overtime: Number(h), premium: Number(pr) }]; }));
  const counted = rows.filter((x) => x.status === 'approved' || x.status === 'paid');
  const js = sheetOvertime(counted, 40, { blend: 'pay_amount' });
  let same = 0, off = [];
  for (const x of rows) {
    const want = js[x.id] || { overtime: 0, premium: 0 };
    const got = stored[x.id];
    if (got && got.overtime === want.overtime && got.premium === want.premium) same++;
    else off.push(`${x.id} db ${JSON.stringify(got)} js ${JSON.stringify(want)}`);
  }
  const withOt = rows.filter((x) => (js[x.id]?.overtime || 0) > 0).length;
  ok(off.length === 0, `every one of ${rows.length} random timesheets matches the shared rule (${same} same, ${withOt} with overtime)${off.length ? `\n       ${off.slice(0, 5).join('\n       ')}` : ''}`);
  ok(withOt >= 5, `the random weeks really do reach overtime (${withOt} timesheets)`);

  console.log('6. rollback');
  const rb = psql({ args: ['-1', '-f', ROLLBACK] }).stdout.trim().split('\n').pop();
  ok(rb === '0|f|0|f|f', `rollback check row reads 0|f|0|f|f (got ${rb})`);
  ok(problem(open, J.provo) === 'none', 'claims count one site again');
  const re = psql({ args: ['-1', '-f', MIGRATION] }).stdout.trim().split('\n').pop();
  ok(re === '2|t|f|3|t|0|t', `the migration applies again (got ${re})`);
} finally {
  stop();
}
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
