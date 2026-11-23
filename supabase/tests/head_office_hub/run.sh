#!/bin/zsh
# head_office_hub/run.sh: proves 20261130a (head office hub, six hq_* tables) on a throwaway local Postgres.
#   zsh supabase/tests/head_office_hub/run.sh
# Stubs auth.uid(), locations, user_profiles, user_locations and the four Back Office helpers the
# policies call (user_accessible_locations, user_accessible_orgs, is_super_admin, second_step_ok),
# seeds company A (sites A1, A2) and company B (site B1) with an owner and managers, runs 20261130a,
# then checks:
#   1. six hq_ tables exist with row level security on, both helper functions exist,
#   2. hq_is_company_owner: true for the owner, false for a manager and for another company's manager,
#   3. daily numbers: the site rule on insert and select, upsert in place, updated_at moves,
#   4. projects, tasks, sub tasks, updates: company rule, no task into another company's project,
#      cascade delete, an update's author must be the login,
#   5. check ins: author and owner read, other managers do not, one row per week, department and site,
#   6. questions: the owner writes, managers only read,
#   7. a second run changes nothing,
#   8. the rollback drops everything and the migration runs again after it.
set -e
export LC_ALL=en_US.UTF-8 LANG=en_US.UTF-8 PGOPTIONS="-c client_min_messages=warning"
HERE="${0:A:h}"; MIG="${HERE:h:h}/migrations"
F="$MIG/20261130a_OPS_head_office_hub.sql"; RB="$MIG/20261130a_OPS_head_office_hub_ROLLBACK.sql"
DIR="$(mktemp -d)"; PORT=55434
trap 'pg_ctl -D "$DIR" -m immediate stop >/dev/null 2>&1; rm -rf "$DIR"' EXIT
initdb -D "$DIR" -U postgres >/dev/null 2>&1
pg_ctl -D "$DIR" -o "-p $PORT -k $DIR" -l "$DIR/log" start >/dev/null
sleep 1
P() { psql -h "$DIR" -p $PORT -U postgres -d postgres -v ON_ERROR_STOP=1 -qAt "$@"; }
# AS <login uuid> <sql>: runs the sql as that Back Office login (authenticated role, jwt sub set).
AS() { P -c "set role authenticated; set request.jwt.claim.sub to '$1'; $2"; }
# ERR <login uuid> <sql>: the SQLSTATE the sql fails with as that login (empty when it succeeded).
ERR() { psql -h "$DIR" -p $PORT -U postgres -d postgres -v VERBOSITY=verbose -qAt \
          -c "set role authenticated; set request.jwt.claim.sub to '$1'; $2" 2>&1 \
          | sed -n 's/^ERROR:  \([0-9A-Z][0-9A-Z][0-9A-Z][0-9A-Z][0-9A-Z]\):.*/\1/p' | head -1; }
fail() { echo "FAIL $*"; exit 1; }

ORG_A=aaaaaaaa-aaaa-4aaa-8aaa-000000000001; ORG_B=bbbbbbbb-bbbb-4bbb-8bbb-000000000001
A1=aaaaaaaa-aaaa-4aaa-8aaa-000000000011; A2=aaaaaaaa-aaaa-4aaa-8aaa-000000000012; B1=bbbbbbbb-bbbb-4bbb-8bbb-000000000011
OWNER_A=11111111-1111-1111-1111-111111111111; MANAGER_A=22222222-2222-2222-2222-222222222222
MANAGER_B=33333333-3333-3333-3333-333333333333; MANAGER_A2=44444444-4444-4444-4444-444444444444

# Stubs: the roles, auth.uid() driven by the jwt sub setting, the three tables and four helpers
# the policies lean on (same shape as production, nothing more).
P -c "create role authenticated; create role anon; create role service_role;
      create schema auth;
      create function auth.uid() returns uuid language sql stable
        as \$\$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid \$\$;
      grant usage on schema auth to authenticated, anon, service_role;
      grant usage on schema public to authenticated, anon, service_role;
      create table public.locations (id uuid primary key, name text, org_id uuid);
      create table public.user_profiles (id uuid primary key, org_id uuid, role text default 'owner', bo_access boolean default true);
      create table public.user_locations (user_id uuid, location_id uuid, role text);
      grant select on public.locations, public.user_profiles, public.user_locations to authenticated;
      create function public.user_accessible_locations() returns setof text language sql stable security definer
        set search_path = public as \$\$
          select ul.location_id::text from public.user_locations ul where ul.user_id = auth.uid()
          union
          select l.id::text from public.locations l join public.user_profiles p on p.org_id = l.org_id
           where p.id = auth.uid() and p.role = 'owner' \$\$;
      create function public.user_accessible_orgs() returns setof text language sql stable security definer
        set search_path = public as \$\$
          select distinct l.org_id::text from public.locations l
           where l.id::text in (select public.user_accessible_locations()) \$\$;
      create function public.is_super_admin() returns boolean language sql stable security definer as \$\$ select false \$\$;
      create function public.second_step_ok() returns boolean language sql stable security definer as \$\$ select true \$\$;
      grant execute on function public.user_accessible_locations(), public.user_accessible_orgs(),
        public.is_super_admin(), public.second_step_ok() to authenticated;
      insert into public.locations values ('$A1', 'A1', '$ORG_A'), ('$A2', 'A2', '$ORG_A'), ('$B1', 'B1', '$ORG_B');
      insert into public.user_profiles (id, org_id, role) values
        ('$OWNER_A', '$ORG_A', 'owner'), ('$MANAGER_A', '$ORG_A', 'manager'), ('$MANAGER_B', '$ORG_B', 'manager');
      insert into public.user_locations values ('$OWNER_A', '$A1', 'owner'),
        ('$MANAGER_A', '$A1', 'manager'), ('$MANAGER_A', '$A2', 'manager'), ('$MANAGER_B', '$B1', 'manager');"

# 1. The migration applies.
P -f "$F" >/dev/null
t=$(P -c "select count(*)||'|'||count(*) filter (where relrowsecurity) from pg_class where relname like 'hq\_%' and relkind = 'r'")
[[ "$t" == "6|6" ]] || fail "1 tables (count|rls on): $t"
f=$(P -c "select count(*) from pg_proc where proname in ('hq_is_company_owner', 'hq_touch_updated_at')")
[[ "$f" == "2" ]] || fail "1 helpers: $f"
echo "PASS 1 migration applied: 6 hq_ tables with row level security on, hq_is_company_owner and hq_touch_updated_at exist"

# 2. Who is a company owner.
o=$(AS $OWNER_A "select public.hq_is_company_owner('$ORG_A')")
m=$(AS $MANAGER_A "select public.hq_is_company_owner('$ORG_A')")
b=$(AS $MANAGER_B "select public.hq_is_company_owner('$ORG_A')")
[[ "$o|$m|$b" == "t|f|f" ]] || fail "2 hq_is_company_owner owner_a|manager_a|manager_b: $o|$m|$b"
echo "PASS 2 hq_is_company_owner(org A): owner_a true, manager_a false, manager_b false"

# 3. Daily numbers.
r=$(AS $MANAGER_A "insert into public.hq_daily_numbers (location_id, business_date, org_id, cash_on_hand)
                   values ('$A2', '2026-11-15', '$ORG_A', 250) returning cash_on_hand")
[[ "$r" == "250.00" ]] || fail "3 manager_a insert A2: $r"
r=$(AS $MANAGER_A "select cash_on_hand||'|'||created_by from public.hq_daily_numbers where location_id = '$A2'")
[[ "$r" == "250.00|$MANAGER_A" ]] || fail "3 manager_a read back: $r"
e=$(ERR $MANAGER_B "insert into public.hq_daily_numbers (location_id, business_date, org_id, cash_on_hand)
                    values ('$A2', '2026-11-16', '$ORG_A', 1)")
[[ "$e" == "42501" ]] || fail "3 manager_b insert for A2: ${e:-allowed}"
n=$(AS $MANAGER_B "select count(*) from public.hq_daily_numbers")
[[ "$n" == "0" ]] || fail "3 manager_b sees org A rows: $n"
u=$(AS $MANAGER_A "insert into public.hq_daily_numbers (location_id, business_date, org_id, cash_on_hand)
                   values ('$A2', '2026-11-15', '$ORG_A', 300)
                   on conflict (location_id, business_date) do update set cash_on_hand = excluded.cash_on_hand
                   returning cash_on_hand||'|'||(updated_at > created_at)")
[[ "$u" == "300.00|true" ]] || fail "3 upsert (cash|updated_at moved): $u"
n=$(P -c "select count(*) from public.hq_daily_numbers")
[[ "$n" == "1" ]] || fail "3 upsert made a second row: $n"
echo "PASS 3 daily numbers: manager_a writes and reads A2, manager_b refused (42501) and sees 0 rows, upsert updated in place and updated_at moved"

# 4. Projects, tasks, sub tasks, updates.
pid=$(AS $MANAGER_A "insert into public.hq_projects (org_id, name, department) values ('$ORG_A', 'New oven rollout', 'operations') returning id")
tid=$(AS $MANAGER_A "insert into public.hq_tasks (project_id, org_id, title) values ('$pid', '$ORG_A', 'Pick a supplier') returning id")
sid=$(AS $MANAGER_A "insert into public.hq_tasks (project_id, org_id, parent_task_id, title) values ('$pid', '$ORG_A', '$tid', 'Get three quotes') returning id")
[[ -n "$pid" && -n "$tid" && -n "$sid" ]] || fail "4 manager_a inserts: $pid $tid $sid"
n=$(AS $MANAGER_B "select (select count(*) from public.hq_projects)||'|'||(select count(*) from public.hq_tasks)")
[[ "$n" == "0|0" ]] || fail "4 manager_b sees org A projects|tasks: $n"
e1=$(ERR $MANAGER_B "insert into public.hq_tasks (project_id, org_id, title) values ('$pid', '$ORG_B', 'Sneak in as org B')")
e2=$(ERR $MANAGER_B "insert into public.hq_tasks (project_id, org_id, title) values ('$pid', '$ORG_A', 'Sneak in as org A')")
[[ "$e1" == "23503" && "$e2" == "42501" ]] || fail "4 manager_b task into org A project: as org B ${e1:-allowed}, as org A ${e2:-allowed}"
d=$(AS $MANAGER_A "delete from public.hq_tasks where id = '$tid' returning id")
n=$(P -c "select count(*) from public.hq_tasks where id in ('$tid', '$sid')")
[[ "$d" == "$tid" && "$n" == "0" ]] || fail "4 cascade delete left rows: $n"
uid=$(AS $MANAGER_A "insert into public.hq_project_updates (project_id, org_id, body) values ('$pid', '$ORG_A', 'Supplier shortlisted') returning id")
r=$(AS $OWNER_A "select body||'|'||author_id from public.hq_project_updates where id = '$uid'")
[[ "$r" == "Supplier shortlisted|$MANAGER_A" ]] || fail "4 owner_a reads manager_a update: $r"
e=$(ERR $MANAGER_A "insert into public.hq_project_updates (project_id, org_id, body, author_id) values ('$pid', '$ORG_A', 'Forged', '$OWNER_A')")
[[ "$e" == "42501" ]] || fail "4 update with another author: ${e:-allowed}"
echo "PASS 4 projects: manager_a project, task and sub task; manager_b sees none and cannot add a task (org B 23503, org A 42501); parent delete cascaded; update readable by owner_a; forged author refused"

# 5. Check ins.
P -c "insert into public.user_profiles (id, org_id, role) values ('$MANAGER_A2', '$ORG_A', 'manager');
      insert into public.user_locations values ('$MANAGER_A2', '$A1', 'manager');"
c1=$(AS $MANAGER_A "insert into public.hq_checkins (org_id, week_start, department, answers, score)
                    values ('$ORG_A', '2026-11-09', 'operations', jsonb_build_object('q1', 'Fine'), 4) returning id||'|'||author_id")
[[ "${c1#*|}" == "$MANAGER_A" ]] || fail "5 author_id default: $c1"
c1="${c1%|*}"
r=$(AS $OWNER_A "select count(*) from public.hq_checkins where id = '$c1'")
[[ "$r" == "1" ]] || fail "5 owner_a cannot read the check in: $r"
r=$(AS $MANAGER_B "select count(*) from public.hq_checkins")
[[ "$r" == "0" ]] || fail "5 manager_b sees check ins: $r"
c2=$(AS $MANAGER_A2 "insert into public.hq_checkins (org_id, week_start, department, answers)
                     values ('$ORG_A', '2026-11-09', 'operations', jsonb_build_object('q1', 'Busy')) returning id")
r=$(AS $MANAGER_A2 "select string_agg(id::text, ',') from public.hq_checkins")
[[ "$r" == "$c2" ]] || fail "5 manager_a2 should see only their own row: $r"
r=$(AS $MANAGER_A "update public.hq_checkins set answers = jsonb_build_object('q1', 'Better') where id = '$c1' returning answers->>'q1'")
[[ "$r" == "Better" ]] || fail "5 manager_a update own answers: $r"
r=$(AS $MANAGER_A "update public.hq_checkins set answers = jsonb_build_object('q1', 'Hacked') where id = '$c2' returning id")
[[ -z "$r" ]] || fail "5 manager_a updated manager_a2's row: $r"
r=$(AS $OWNER_A "select answers->>'q1' from public.hq_checkins where id = '$c2'")
[[ "$r" == "Busy" ]] || fail "5 manager_a2's answers changed: $r"
e=$(ERR $MANAGER_A "insert into public.hq_checkins (org_id, week_start, department) values ('$ORG_A', '2026-11-09', 'operations')")
[[ "$e" == "23505" ]] || fail "5 second check in same week, department, no site: ${e:-allowed}"
r=$(AS $MANAGER_A "insert into public.hq_checkins (org_id, week_start, department, location_id) values ('$ORG_A', '2026-11-09', 'operations', '$A1') returning location_id")
[[ "$r" == "$A1" ]] || fail "5 same week for a site: $r"
echo "PASS 5 check ins: author defaults to login; owner_a reads it; manager_b and manager_a2 do not; own update ok, other's update 0 rows; duplicate week refused (23505), another site allowed"

# 6. Questions.
e=$(ERR $MANAGER_A "insert into public.hq_checkin_questions (org_id, questions) values ('$ORG_A', '[]')")
[[ "$e" == "42501" ]] || fail "6 manager_a inserted questions: ${e:-allowed}"
r=$(AS $OWNER_A "insert into public.hq_checkin_questions (org_id, questions) values ('$ORG_A', jsonb_build_array('How was the week?'))
                 on conflict (org_id) do update set questions = excluded.questions, updated_by = auth.uid(), updated_at = now()
                 returning jsonb_array_length(questions)")
[[ "$r" == "1" ]] || fail "6 owner_a insert questions: $r"
r=$(AS $OWNER_A "insert into public.hq_checkin_questions (org_id, questions) values ('$ORG_A', jsonb_build_array('How was the week?', 'Any blockers?'))
                 on conflict (org_id) do update set questions = excluded.questions, updated_by = auth.uid(), updated_at = now()
                 returning jsonb_array_length(questions)")
[[ "$r" == "2" ]] || fail "6 owner_a upsert questions: $r"
r=$(AS $MANAGER_A "select questions->>1 from public.hq_checkin_questions where org_id = '$ORG_A'")
[[ "$r" == "Any blockers?" ]] || fail "6 manager_a read questions: $r"
r=$(AS $MANAGER_A "update public.hq_checkin_questions set questions = '[]' where org_id = '$ORG_A' returning org_id")
[[ -z "$r" ]] || fail "6 manager_a updated questions: $r"
echo "PASS 6 questions: manager_a insert refused (42501) and update 0 rows; owner_a upserts; manager_a reads them"

# 7. Second run.
COUNTS="select (select count(*) from pg_policy p join pg_class c on c.oid = p.polrelid where c.relname like 'hq\_%')
        ||'|'||(select count(*) from pg_class where relname like 'hq\_%' and relkind = 'r')
        ||'|'||(select count(*) from public.hq_checkins)||'|'||(select count(*) from public.hq_daily_numbers)"
before=$(P -c "$COUNTS")
P -f "$F" >/dev/null
after=$(P -c "$COUNTS")
[[ "$before" == "$after" ]] || fail "7 second run changed counts (policies|tables|checkins|daily): $before to $after"
echo "PASS 7 second run: no error, counts unchanged (policies|tables|checkins|daily numbers = $after)"

# 8. Rollback, then forward again.
P -f "$RB" >/dev/null
g=$(P -c "select (select count(*) from pg_class where relname like 'hq\_%')||'|'||(select count(*) from pg_proc where proname like 'hq\_%')")
[[ "$g" == "0|0" ]] || fail "8 rollback left relations|functions: $g"
P -f "$F" >/dev/null
t=$(P -c "select count(*) from pg_class where relname like 'hq\_%' and relkind = 'r' and relrowsecurity")
[[ "$t" == "6" ]] || fail "8 migration after rollback: $t tables"
echo "PASS 8 rollback dropped all six tables and both functions; migration ran again after it"
echo "head_office_hub: 8 checks pass"
