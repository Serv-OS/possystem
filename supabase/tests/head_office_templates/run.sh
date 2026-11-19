#!/bin/zsh
# head_office_templates/run.sh: proves 20261203a (head office slice 6: project templates) on a
# throwaway local Postgres, on top of 20261130a.
#   zsh supabase/tests/head_office_templates/run.sh
# Same stubs and seed as head_office_hub/run.sh (company A: owner_a, manager_a on A1+A2; company B:
# manager_b on B1). Checks:
#   1. eleven hq_ tables with row level security on, template_id on hq_projects,
#   2. a manager of the company writes and reads a template; the other company sees nothing and
#      cannot insert into company A; a blank phases/tasks shape is refused,
#   3. a project made from the template carries template_id; deleting the template leaves the
#      project with template_id null; updated_at moves on update,
#   4. second run changes nothing; rollback leaves 20261130a's six tables; forward again.
set -e
export LC_ALL=en_US.UTF-8 LANG=en_US.UTF-8 PGOPTIONS="-c client_min_messages=warning"
HERE="${0:A:h}"; MIG="${HERE:h:h}/migrations"
F0="$MIG/20261130a_OPS_head_office_hub.sql"; F="$MIG/20261203a_OPS_head_office_templates.sql"; RB="$MIG/20261203a_OPS_head_office_templates_ROLLBACK.sql"
DIR="$(mktemp -d)"; PORT=55436
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


# 1. Both migrations apply.
P -f "$F0" >/dev/null
P -f "$F" >/dev/null
t=$(P -c "select count(*)||'|'||count(*) filter (where relrowsecurity) from pg_class where relname like 'hq\_%' and relkind = 'r'")
[[ "$t" == "7|7" ]] || fail "1 tables (count|rls on): $t"
c=$(P -c "select count(*) from information_schema.columns where table_name = 'hq_projects' and column_name = 'template_id'")
[[ "$c" == "1" ]] || fail "1 template_id column: $c"
echo "PASS 1 both migrations applied: 7 hq_ tables with row level security on, hq_projects.template_id present"

# 2. Writes and reads by company.
TPL=$(AS $MANAGER_A "insert into public.hq_project_templates (org_id, name, department, phases, tasks, duration_days)
  values ('$ORG_A', 'Open a site', 'finance', '[\"Plan\",\"Build\"]', '[{\"key\":\"a\",\"title\":\"Find a site\",\"due_days\":2,\"children\":[]}]', 45) returning id")
[[ -n "$TPL" ]] || fail "2 manager_a insert"
r=$(AS $OWNER_A "select name||'|'||jsonb_array_length(tasks)||'|'||created_by from public.hq_project_templates where id = '$TPL'")
[[ "$r" == "Open a site|1|$MANAGER_A" ]] || fail "2 owner_a reads it: $r"
r=$(AS $MANAGER_B "select count(*) from public.hq_project_templates")
[[ "$r" == "0" ]] || fail "2 manager_b sees company A templates: $r"
e=$(ERR $MANAGER_B "insert into public.hq_project_templates (org_id, name) values ('$ORG_A', 'Sneak')")
[[ "$e" == "42501" ]] || fail "2 manager_b inserted into company A: ${e:-allowed}"
e=$(ERR $MANAGER_A "insert into public.hq_project_templates (org_id, name, tasks) values ('$ORG_A', 'Bad', '{}')")
[[ "$e" == "23514" ]] || fail "2 tasks object accepted: ${e:-allowed}"
e=$(ERR $MANAGER_A "insert into public.hq_project_templates (org_id, name, duration_days) values ('$ORG_A', 'Bad', -1)")
[[ "$e" == "23514" ]] || fail "2 negative duration accepted: ${e:-allowed}"
echo "PASS 2 templates: company writes and reads; other company sees nothing and is refused (42501); bad shapes refused (23514)"

# 3. A project from the template; delete leaves the project unlinked; updated_at moves.
PRJ=$(AS $MANAGER_A "insert into public.hq_projects (org_id, name, department, template_id) values ('$ORG_A', 'Open Hull', 'finance', '$TPL') returning id")
[[ -n "$PRJ" ]] || fail "3 project insert"
r=$(AS $MANAGER_A "select template_id from public.hq_projects where id = '$PRJ'")
[[ "$r" == "$TPL" ]] || fail "3 template_id kept: $r"
u1=$(P -c "select updated_at from public.hq_project_templates where id = '$TPL'")
AS $MANAGER_A "update public.hq_project_templates set name = 'Open a site v2' where id = '$TPL'" >/dev/null
u2=$(P -c "select updated_at from public.hq_project_templates where id = '$TPL'")
[[ "$u1" != "$u2" ]] || fail "3 updated_at did not move"
r=$(AS $MANAGER_A "delete from public.hq_project_templates where id = '$TPL' returning id")
[[ "$r" == "$TPL" ]] || fail "3 delete: $r"
r=$(AS $MANAGER_A "select coalesce(template_id::text, 'null') from public.hq_projects where id = '$PRJ'")
[[ "$r" == "null" ]] || fail "3 project after template delete: $r"
echo "PASS 3 project carries template_id; template delete leaves the project with null; updated_at moves"

# 4. Second run, rollback, forward again.
COUNTS="select (select count(*) from pg_policy p join pg_class c on c.oid = p.polrelid where c.relname like 'hq\_%')||'|'||(select count(*) from pg_class where relname like 'hq\_%' and relkind = 'r')"
before=$(P -c "$COUNTS"); P -f "$F" >/dev/null; after=$(P -c "$COUNTS")
[[ "$before" == "$after" ]] || fail "4 second run changed counts: $before to $after"
P -f "$RB" >/dev/null
t=$(P -c "select count(*) from pg_class where relname like 'hq\_%' and relkind = 'r'")
[[ "$t" == "6" ]] || fail "4 rollback left $t tables"
c=$(P -c "select count(*) from information_schema.columns where table_name = 'hq_projects' and column_name = 'template_id'")
[[ "$c" == "0" ]] || fail "4 rollback left template_id"
P -f "$F" >/dev/null
echo "PASS 4 second run unchanged ($after); rollback leaves the six hub tables and no template_id; forward again ok"
echo "head_office_templates: 4 checks pass"
