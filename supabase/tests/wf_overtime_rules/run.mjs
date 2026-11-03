#!/usr/bin/env node
// run.mjs: proves 20261114a (US overtime rules: exempt positions and tip credit) on a local,
// throwaway PostgreSQL, before Peter runs it on the Ops database. It never connects to Supabase.
//
//   node supabase/tests/wf_overtime_rules/run.mjs
//
// Live chain 20261031a, 20261104a, 20261111a, 20261112a, 20261113a, then 20261114a. Proves:
//   1. it applies, its check row reads as documented, a second run is refused;
//   2. tip credit: a $2.13 server on 45 h carries 5 h and $18.13 (half of $7.25), not $5.32;
//      a site minimum wage of $9 makes it $22.50 and the change recomputes by itself;
//   3. exempt: a salaried manager on 50 h has no overtime; switching the position off makes the
//      overtime appear, switching it on takes it away; changing the pay type recomputes;
//   4. PARITY: random weeks with tipped, hourly and salaried staff at sites with different minimum
//      wages and exempt switches: every stored figure equals multiSiteOvertime.js sheetOvertime with
//      overtimeRules, the rule payroll uses;
//   5. the ROLLBACK puts 20261112a's recompute back and the migration applies again.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
const M = (f) => join(repo, 'supabase/migrations', f);
const CHAIN = ['20261031a_OPS_wf_open_shifts.sql', '20261104a_OPS_wf_staff_identity_fence.sql', '20261111a_OPS_wf_people_across_sites.sql',
  '20261112a_OPS_wf_people_across_sites_2.sql', '20261113a_OPS_till_users_across_sites.sql'].map(M);
const MIGRATION = M('20261114a_OPS_wf_overtime_rules.sql');
const ROLLBACK = M('20261114a_OPS_wf_overtime_rules_ROLLBACK.sql');
const { sheetOvertime, overtimeRules } = await import(pathToFileURL(join(repo, 'supabase/functions/_shared/multiSiteOvertime.js')).href);

const bin = (name) => (existsSync(`/opt/homebrew/bin/${name}`) ? `/opt/homebrew/bin/${name}` : name);
const env = { ...process.env, LC_ALL: 'en_US.UTF-8', PGOPTIONS: '-c client_min_messages=warning' };
let failures = 0, passes = 0;
const ok = (cond, msg) => { if (cond) { passes++; console.log(`  ok   ${msg}`); } else { failures++; console.log(`  FAIL ${msg}`); } };
const port = process.env.WFOR_PGPORT || String(56000 + Math.floor(Math.random() * 80));
const dir = mkdtempSync(join(tmpdir(), 'pgs.'));
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
const PROVO = id('a0000000', 1), DAY = id('a0000000', 2);
const S = { sam: id('5a000000', 1), max: id('5a000000', 2) };
const ts = (staff, loc, at, hours, rate, status = 'approved', rateSource = 'base') => sql(`insert into public.wf_timesheets (location_id, org_id, staff_id, clock_in, clock_out, actual_hours, effective_rate, rate_source, pay_amount, status)
  values (${lit(loc)}, ${lit(ORG)}, ${lit(staff)}, ${lit(at)}, ${lit(at)}::timestamptz + interval '${hours} hours', ${hours}, ${rate}, ${lit(rateSource)}, ${Math.round(hours * rate * 100) / 100}, ${lit(status)}) returning id`);
const otOf = (sheet) => sql(`select overtime_hours || '|' || overtime_premium from public.wf_timesheets where id = ${lit(sheet)}`);
const totalOf = (staff) => sql(`select sum(overtime_hours) || '|' || sum(overtime_premium) from public.wf_timesheets where staff_id = ${lit(staff)}`);

try {
  console.log('schema and the live chain');
  psql({ args: ['-1', '-f', join(here, 'schema.sql')] });
  sql(`insert into public.locations (id, org_id, name, timezone, currency) values
         (${lit(PROVO)}, ${lit(ORG)}, 'Provo', 'America/Denver', 'USD'), (${lit(DAY)}, ${lit(ORG)}, 'Daybreak', 'America/Denver', 'USD');`);
  for (const f of CHAIN) psql({ args: ['-1', '-f', f] });
  sql(`insert into public.wf_roles (location_id, org_id, key, label, base_rate, pay_type) values
         (${lit(PROVO)}, ${lit(ORG)}, 'server', 'Server', 2.13, 'hourly'), (${lit(PROVO)}, ${lit(ORG)}, 'mgmt', 'Manager', null, 'salaried'),
         (${lit(DAY)}, ${lit(ORG)}, 'server', 'Server', 2.13, 'hourly'), (${lit(DAY)}, ${lit(ORG)}, 'host', 'Host', 12, 'hourly'),
         (${lit(DAY)}, ${lit(ORG)}, 'mgmt', 'Manager', null, 'salaried');
       insert into public.wf_venue_settings (location_id, org_id, settings) values (${lit(PROVO)}, ${lit(ORG)}, '{}'), (${lit(DAY)}, ${lit(ORG)}, '{}');
       insert into public.wf_staff (id, org_id, location_id, name, role_key, status) values
         (${lit(S.sam)}, ${lit(ORG)}, ${lit(PROVO)}, 'Sam', 'server', 'active'), (${lit(S.max)}, ${lit(ORG)}, ${lit(PROVO)}, 'Max', 'mgmt', 'active');`);
  const days = ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30'];
  const samSheets = days.map((d) => ts(S.sam, PROVO, `${d}T15:00:00Z`, 9, 2.13));
  const maxSheets = days.map((d) => ts(S.max, PROVO, `${d}T15:00:00Z`, 10, 25, 'approved', 'salaried'));
  ok(totalOf(S.sam) === '5.00|5.33', `before: the $2.13 server's 5 h carry $5.33, half of $2.13 (got ${totalOf(S.sam)})`);
  ok(totalOf(S.max) === '10.00|125.00', `before: the salaried manager carries 10 h and $125 (got ${totalOf(S.max)})`);

  console.log('1. the migration');
  const check = psql({ args: ['-1', '-f', MIGRATION] }).stdout.trim().split('\n').pop();
  ok(check === 't|t|2|f', `check row reads t|t|2|f (got ${check})`);
  const again = psql({ args: ['-1', '-f', MIGRATION], allowFail: true });
  ok(again.status !== 0 && /has run already/.test(again.stderr), 'a second run is refused');

  console.log('2. tip credit');
  ok(totalOf(S.sam) === '5.00|18.13', `the backfill: 5 h and $18.13, half of $7.25 (got ${totalOf(S.sam)})`);
  ok(otOf(samSheets[4]) === '5.00|18.13', 'on the timesheet that crossed 40');
  sql(`update public.wf_venue_settings set settings = settings || '{"minimumWage": 9}' where location_id = ${lit(PROVO)}`);
  ok(totalOf(S.sam) === '5.00|22.50', `a site minimum wage of $9 recomputes by itself: $22.50 (got ${totalOf(S.sam)})`);
  sql(`update public.wf_venue_settings set settings = settings - 'minimumWage' where location_id = ${lit(PROVO)}`);
  ok(totalOf(S.sam) === '5.00|18.13', 'taking it off goes back to the federal $7.25');

  console.log('3. exempt');
  ok(totalOf(S.max) === '0.00|0.00', `the salaried manager on 50 h has no overtime (got ${totalOf(S.max)})`);
  sql(`update public.wf_venue_settings set settings = settings || '{"overtimeExempt": {"mgmt": false}}' where location_id = ${lit(PROVO)}`);
  ok(totalOf(S.max) === '10.00|125.00', `switched off (salaried but not exempt): overtime comes back (got ${totalOf(S.max)})`);
  sql(`update public.wf_venue_settings set settings = settings || '{"overtimeExempt": {"mgmt": true, "server": true}}' where location_id = ${lit(PROVO)}`);
  ok(totalOf(S.max) === '0.00|0.00' && totalOf(S.sam) === '0.00|0.00', 'switched on, for any position (servers too)');
  sql(`update public.wf_venue_settings set settings = settings - 'overtimeExempt' where location_id = ${lit(PROVO)}`);
  sql(`update public.wf_roles set pay_type = 'salaried' where location_id = ${lit(PROVO)} and key = 'server'`);
  ok(totalOf(S.sam) === '0.00|0.00', `a position made salaried recomputes: no overtime (got ${totalOf(S.sam)})`);
  sql(`update public.wf_roles set pay_type = 'hourly' where location_id = ${lit(PROVO)} and key = 'server'`);
  ok(totalOf(S.sam) === '5.00|18.13', 'back to hourly: the overtime is back');
  ok(totalOf(S.max) === '0.00|0.00', 'a timesheet paid a salary equivalent stays exempt');

  console.log('4. parity with multiSiteOvertime.js');
  let seed = 31102026;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const siteSettings = { [PROVO]: { minimumWage: 8.5, overtimeExempt: { host: true } }, [DAY]: { overtimeExempt: { mgmt: false } } };
  for (const loc of [PROVO, DAY]) sql(`update public.wf_venue_settings set settings = ${lit(JSON.stringify(siteSettings[loc]))}::jsonb where location_id = ${lit(loc)}`);
  sql(`insert into public.wf_roles (location_id, org_id, key, label, base_rate, pay_type) values (${lit(PROVO)}, ${lit(ORG)}, 'host', 'Host', 11, 'hourly')`);
  const payType = { [PROVO]: { server: 'hourly', mgmt: 'salaried', host: 'hourly' }, [DAY]: { server: 'hourly', host: 'hourly', mgmt: 'salaried' } };
  const roleKeys = ['server', 'host', 'mgmt'];
  const people = [];
  for (let i = 0; i < 8; i++) {
    const person = id('9f000000', i + 1);
    const recs = [PROVO, DAY].map((loc, k) => ({ id: id(`6${i}000000`, k + 1), loc, role: roleKeys[(i + k) % 3] }));
    sql(`insert into public.wf_staff (id, org_id, location_id, name, role_key, status, person_id) values ${recs.map((x) => `(${lit(x.id)}, ${lit(ORG)}, ${lit(x.loc)}, 'P${i}', ${lit(x.role)}, 'active', ${lit(person)})`).join(', ')}`);
    people.push({ person, recs });
  }
  const rows = [], inserts = [];
  for (const pp of people) {
    for (let k = 0; k < 14; k++) {
      const rec = pp.recs[Math.floor(rnd() * 2)];
      const start = Date.parse('2026-10-19T00:00:00Z') + Math.floor(rnd() * 7 * 24) * 3600000;
      const hours = Math.round((4 + rnd() * 6) * 100) / 100;
      const salaried = rec.role === 'mgmt';
      const rate = salaried ? 24 : rec.role === 'server' ? 2.13 : [11, 12.5, 15][Math.floor(rnd() * 3)];
      const pay = Math.round(hours * rate * 100) / 100;
      const brk = [0, 0, 15, 30][Math.floor(rnd() * 4)];
      const status = ['approved', 'approved', 'paid', 'pending'][Math.floor(rnd() * 4)];
      const sid = id('7f000000', rows.length + 1);
      const iso = new Date(start).toISOString();
      const rs = salaried ? 'salaried' : 'base';
      const rule = overtimeRules({ settings: siteSettings[rec.loc], roleKey: rec.role, payType: payType[rec.loc][rec.role], rateSource: rs });
      rows.push({ id: sid, staff_id: rec.id, person: pp.person, clock_in: iso, actual_hours: hours, paid_break_mins: brk, pay_amount: pay, effective_rate: rate, status, tz: 'America/Denver', week_start_dow: 1, exempt: rule.exempt, min_wage: rule.minWage });
      inserts.push(`insert into public.wf_timesheets (id, location_id, org_id, staff_id, clock_in, clock_out, actual_hours, effective_rate, rate_source, pay_amount, status, paid_break_mins) values (${lit(sid)}, ${lit(rec.loc)}, ${lit(ORG)}, ${lit(rec.id)}, ${lit(iso)}, ${lit(iso)}::timestamptz + interval '${hours} hours', ${hours}, ${rate}, ${lit(rs)}, ${pay}, ${lit(status)}, ${brk});`);
    }
  }
  sql(inserts.join('\n'));
  const stored = Object.fromEntries(sql(`select id || '|' || overtime_hours || '|' || overtime_premium from public.wf_timesheets where id::text like '7f000000%'`)
    .split('\n').map((l) => { const [a, h, p] = l.split('|'); return [a, { overtime: Number(h), premium: Number(p) }]; }));
  const js = sheetOvertime(rows.filter((x) => x.status !== 'pending'), 40, { blend: 'pay_amount' });
  const off = rows.filter((x) => { const w = js[x.id] || { overtime: 0, premium: 0 }; const g = stored[x.id]; return !g || g.overtime !== w.overtime || g.premium !== w.premium; })
    .map((x) => `${x.id} db ${JSON.stringify(stored[x.id])} js ${JSON.stringify(js[x.id] || { overtime: 0, premium: 0 })} (${x.exempt ? 'exempt' : ''} rate ${x.effective_rate})`);
  const withOt = rows.filter((x) => (js[x.id]?.overtime || 0) > 0).length;
  const tipped = rows.filter((x) => (js[x.id]?.overtime || 0) > 0 && x.effective_rate < x.min_wage).length;
  ok(off.length === 0, `every one of ${rows.length} random timesheets matches the shared rule (${withOt} with overtime, ${tipped} tipped)${off.length ? `\n       ${off.slice(0, 5).join('\n       ')}` : ''}`);
  ok(withOt >= 5 && tipped >= 1, `the random weeks reach overtime, tipped staff included (${withOt}, ${tipped})`);

  console.log('5. rollback');
  const rb = psql({ args: ['-1', '-f', ROLLBACK] }).stdout.trim().split('\n').pop();
  ok(rb === 'f|0', `rollback check row reads f|0 (got ${rb})`);
  const re = psql({ args: ['-1', '-f', MIGRATION] }).stdout.trim().split('\n').pop();
  ok(re === 't|t|2|f', `the migration applies again (got ${re})`);
} finally {
  stop();
}
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
