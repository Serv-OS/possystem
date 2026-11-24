#!/usr/bin/env node
// run.mjs: proves 20261206b (the open shift claim judge reads the availability pattern for the
// SHIFT'S week) on a local, throwaway PostgreSQL, before Peter runs it on the Ops database. It never
// connects to Supabase.
//
//   node supabase/tests/wf_claim_availability_week/run.mjs
//
// It builds the live shape the people across sites harness uses (../wf_people_across_sites_2/schema.sql
// and the same chain of migrations up to 20261112a, which holds the judge as it is live), then:
//   1. BEFORE: the fault. A pattern filed for a week months ahead ("Unavailable on Saturdays") refuses
//      a Saturday claim two weeks from now, because the judge read the most recently EDITED pattern;
//      and the reverse, a later "available" pattern lets a claim through on a day that is blocked now;
//   2. the migration applies, its check row reads as documented, a second run is harmless;
//   3. AFTER: each shift is judged by the pattern in effect on its own day (greatest week_start on or
//      before it, a pattern with no week_start the earliest, the newest edit on a tie), and a part
//      day is not a block;
//   4. the ROLLBACK puts the old read back, and the migration applies again after it.
// Exit code 0 only when every check holds.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
const M = (f) => join(repo, 'supabase/migrations', f);
const SCHEMA = join(here, '..', 'wf_people_across_sites_2', 'schema.sql');
const CHAIN = ['20261031a_OPS_wf_open_shifts.sql', '20261104a_OPS_wf_staff_identity_fence.sql', '20261111a_OPS_wf_people_across_sites.sql', '20261112a_OPS_wf_people_across_sites_2.sql'].map(M);
const MIGRATION = M('20261206b_OPS_wf_claim_availability_week.sql');
const ROLLBACK = M('20261206b_OPS_wf_claim_availability_week_ROLLBACK.sql');

const bin = (name) => (existsSync(`/opt/homebrew/bin/${name}`) ? `/opt/homebrew/bin/${name}` : name);
const env = { ...process.env, LC_ALL: 'en_US.UTF-8', PGOPTIONS: '-c client_min_messages=warning' };
let failures = 0, passes = 0;
const ok = (cond, msg) => { if (cond) { passes++; console.log(`  ok   ${msg}`); } else { failures++; console.log(`  FAIL ${msg}`); } };

const port = process.env.WFCW_PGPORT || String(55900 + Math.floor(Math.random() * 80));
const dir = mkdtempSync(join(tmpdir(), 'pgw.'));
const data = join(dir, 'data');
{
  let r = spawnSync(bin('initdb'), ['-D', data, '-U', 'postgres', '--auth=trust', '-E', 'UTF8'], { env, encoding: 'utf8' });
  if (r.status !== 0) { console.error(r.stderr || r.stdout); process.exit(2); }
  r = spawnSync(bin('pg_ctl'), ['-D', data, '-l', join(dir, 'pg.log'), '-w', '-o', `-p ${port} -c listen_addresses='' -k ${dir} -c timezone=UTC`, 'start'], { env, encoding: 'utf8' });
  if (r.status !== 0) { console.error(r.stderr || r.stdout); process.exit(2); }
}
function stop() { spawnSync(bin('pg_ctl'), ['-D', data, '-m', 'fast', '-w', 'stop'], { env, encoding: 'utf8' }); rmSync(dir, { recursive: true, force: true }); }
process.on('uncaughtException', (e) => { console.error(e); stop(); process.exit(2); });

const psqlArgs = (extra = []) => ['-h', dir, '-p', port, '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-X', '-q', '-At', ...extra];
function psql({ input, args = [], allowFail = false }) {
  const r = spawnSync(bin('psql'), psqlArgs(args), { env, input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0 && !allowFail) { console.error('psql failed:\n', input?.slice(0, 600), '\n', r.stderr || r.stdout); stop(); process.exit(2); }
  return r;
}
const sql = (q) => psql({ input: q }).stdout.trim();
const lit = (v) => (v == null ? 'null' : `'${String(v).replace(/'/g, "''")}'`);
const id = (p, n) => `${p}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ORG = id('0a000000', 1), SITE = id('a0000000', 1);
const SAM = id('5a000000', 1), RIA = id('5a000000', 2), TIE = id('5a000000', 3), PIP = id('5a000000', 4);

try {
  console.log('schema and the live chain (the judge as it is live, 20261112a)');
  psql({ args: ['-1', '-f', SCHEMA] });
  sql(`insert into public.locations (id, org_id, name, timezone, currency) values (${lit(SITE)}, ${lit(ORG)}, 'Leeds', 'Europe/London', 'GBP');`);
  for (const f of CHAIN) psql({ args: ['-1', '-f', f] });
  sql(`insert into public.wf_staff (id, org_id, location_id, name, role_key, status) values
         (${lit(SAM)}, ${lit(ORG)}, ${lit(SITE)}, 'Sam', 'floor', 'active'), (${lit(RIA)}, ${lit(ORG)}, ${lit(SITE)}, 'Ria', 'floor', 'active'),
         (${lit(TIE)}, ${lit(ORG)}, ${lit(SITE)}, 'Tia', 'floor', 'active'), (${lit(PIP)}, ${lit(ORG)}, ${lit(SITE)}, 'Pip', 'floor', 'active');`);

  // Dates: the Monday two weeks from now, and the Monday 20 weeks from now. Saturday is day 5 (Monday 0).
  const mon = (weeks) => sql(`select (current_date + ${weeks * 7} - (extract(isodow from current_date)::int - 1))::text`);
  const nearMon = mon(2), farMon = mon(20);
  const sat = (m) => sql(`select (${lit(m)}::date + 5)::text`);
  const shift = (date) => sql(`insert into public.wf_shifts (location_id, org_id, staff_id, role_key, shift_date, start_time, finish_time, status)
    values (${lit(SITE)}, ${lit(ORG)}, null, 'floor', ${lit(date)}, '10:00', '16:00', 'published') returning id`);
  const nearSat = shift(sat(nearMon)), farSat = shift(sat(farMon));
  const problem = (sh, staff) => sql(`select coalesce(public._wf_claim_problem(${lit(sh)}, ${lit(staff)}, null, false), 'none')`);
  const pattern = (staff, weekStart, perDay, editedAgo) => sql(`insert into public.wf_availability (location_id, org_id, staff_id, week_start, per_day, updated_at)
    values (${lit(SITE)}, ${lit(ORG)}, ${lit(staff)}, ${weekStart ? lit(weekStart) : 'null'}, ${lit(JSON.stringify(perDay))}::jsonb, now() - interval '${editedAgo} minutes') returning id`);
  const OFF_SAT = [{ day: 5, state: 'unavailable' }], FREE = [], PART_SAT = [{ day: 5, state: 'partial', note: 'From 5pm' }];

  // Sam: free now (edited an hour ago), and "off Saturdays from the week 20 weeks ahead" typed a minute ago.
  pattern(SAM, null, FREE, 60); pattern(SAM, farMon, OFF_SAT, 1);
  // Ria: off Saturdays now (edited an hour ago), and "free again from the week 20 weeks ahead" typed a minute ago.
  pattern(RIA, null, OFF_SAT, 60); pattern(RIA, farMon, FREE, 1);
  // Tia: two edits of the same week; the newest wins.
  pattern(TIE, nearMon, FREE, 30); pattern(TIE, nearMon, OFF_SAT, 2);
  // Pip: a part day is not a block.
  pattern(PIP, null, PART_SAT, 5);

  console.log('1. before: the fault');
  ok(problem(nearSat, SAM) === 'unavailable', 'a pattern for a week 20 weeks ahead refuses a Saturday claim two weeks from now');
  ok(problem(nearSat, RIA) === 'none', 'and a later "available" pattern lets a claim through on a day that is blocked now');

  console.log('2. the migration');
  {
    const mig = psql({ args: ['-1', '-f', MIGRATION] });
    const row = mig.stdout.trim().split('\n').pop();
    ok(row === '_wf_claim_problem|t|f|f', `check row as documented (${row})`);
    const again = psql({ args: ['-1', '-f', MIGRATION] });
    ok(again.status === 0 && sql(`select count(*) from pg_proc where proname = '_wf_claim_problem'`) === '1', 'a second run is harmless: still one function');
    ok(sql(`select has_function_privilege('service_role', 'public._wf_claim_problem(uuid,uuid,uuid,boolean)', 'EXECUTE')::text`) === 'true', 'the service role may still call it');
  }

  console.log('3. after: each shift is judged by the pattern in effect on its own day');
  ok(problem(nearSat, SAM) === 'none', 'Sam is free two weeks from now, so the claim is allowed');
  ok(problem(farSat, SAM) === 'unavailable', 'and refused on a Saturday inside the week the later pattern starts');
  ok(problem(nearSat, RIA) === 'unavailable', 'Ria is off Saturdays now, so the near claim is refused');
  ok(problem(farSat, RIA) === 'none', 'and allowed once her later pattern has started');
  ok(problem(nearSat, TIE) === 'unavailable', 'two edits of the same week: the newest one is read');
  ok(problem(nearSat, PIP) === 'none', 'a part day is not a block');
  {
    // A pattern that starts ON the shift's own Monday counts; one that starts the Monday after does not.
    const NEW = id('5a000000', 5);
    sql(`insert into public.wf_staff (id, org_id, location_id, name, role_key, status) values (${lit(NEW)}, ${lit(ORG)}, ${lit(SITE)}, 'Ned', 'floor', 'active')`);
    pattern(NEW, nearMon, OFF_SAT, 10);
    ok(problem(nearSat, NEW) === 'unavailable', 'a pattern that starts on the Monday of the shift\'s week is in effect');
    sql(`update public.wf_availability set week_start = ${lit(nearMon)}::date + 7 where staff_id = ${lit(NEW)}`);
    ok(problem(nearSat, NEW) === 'none', 'a pattern that starts the week after is not, and with nothing in effect the person is available');
  }

  console.log('4. rollback');
  {
    const rb = psql({ args: ['-1', '-f', ROLLBACK] });
    const row = rb.stdout.trim().split('\n').pop();
    ok(row === '_wf_claim_problem|f', `rollback check row (${row})`);
    ok(problem(nearSat, SAM) === 'unavailable', 'the old read is back');
    const mig = psql({ args: ['-1', '-f', MIGRATION] });
    ok(mig.stdout.trim().split('\n').pop() === '_wf_claim_problem|t|f|f' && problem(nearSat, SAM) === 'none', 'the migration applies again after the rollback');
  }
} finally {
  stop();
}
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
