#!/bin/zsh
# head_office_cash/run.sh: proves 20261201a (head office slice 2: targets, safe ledger, safe counts,
# bank deposits) on a throwaway local Postgres, on top of 20261130a.
#   zsh supabase/tests/head_office_cash/run.sh
# Same stubs and seed as head_office_hub/run.sh (company A: owner_a, manager_a on A1+A2, manager_a2
# nowhere; company B: manager_b on B1). Checks:
#   1. ten hq_ tables with row level security on,
#   2. targets: company reads, only the owner writes, one row per metric (nulls not distinct), a site
#      row the owner cannot manage is refused,
#   3. safe movements: the sign rule, a till event posts once (23505 on the second), append only
#      (update and delete refused), other company sees nothing, balance sums signed amounts,
#   4. safe counts: variance generated, append only,
#   5. deposits: insert and status update by the site's manager, other company refused,
#   6. second run changes nothing, rollback leaves 20261130a's six tables, forward again.
set -e
export LC_ALL=en_US.UTF-8 LANG=en_US.UTF-8 PGOPTIONS="-c client_min_messages=warning"
HERE="${0:A:h}"; MIG="${HERE:h:h}/migrations"
F0="$MIG/20261130a_OPS_head_office_hub.sql"; F="$MIG/20261201a_OPS_head_office_cash_targets.sql"; RB="$MIG/20261201a_OPS_head_office_cash_targets_ROLLBACK.sql"
DIR="$(mktemp -d)"; PORT=55435
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

# 1. Both migrations apply.
P -f "$F0" >/dev/null
P -f "$F" >/dev/null
t=$(P -c "select count(*)||'|'||count(*) filter (where relrowsecurity) from pg_class where relname like 'hq\_%' and relkind = 'r'")
[[ "$t" == "10|10" ]] || fail "1 tables (count|rls on): $t"
echo "PASS 1 both migrations applied: 10 hq_ tables with row level security on"

# 2. Targets.
e=$(ERR $MANAGER_A "insert into public.hq_targets (org_id, metric, green_to, amber_to) values ('$ORG_A', 'prime_cost_pct', 60, 65)")
[[ "$e" == "42501" ]] || fail "2 manager_a wrote a target: '$e'"
AS $OWNER_A "insert into public.hq_targets (org_id, metric, green_to, amber_to) values ('$ORG_A', 'prime_cost_pct', 60, 65)" >/dev/null
e=$(ERR $OWNER_A "insert into public.hq_targets (org_id, metric, green_to, amber_to) values ('$ORG_A', 'prime_cost_pct', 58, 62)")
[[ "$e" == "23505" ]] || fail "2 second company row for the metric was not refused: '$e'"
AS $OWNER_A "insert into public.hq_targets (org_id, location_id, metric, green_to, amber_to) values ('$ORG_A', '$A2', 'prime_cost_pct', 62, 66)" >/dev/null
e=$(ERR $OWNER_A "insert into public.hq_targets (org_id, location_id, metric, green_to, amber_to) values ('$ORG_B', '$B1', 'prime_cost_pct', 62, 66)")
[[ "$e" == "42501" ]] || fail "2 owner_a wrote a target for company B: '$e'"
n=$(AS $MANAGER_A "select count(*) from public.hq_targets")
[[ "$n" == "2" ]] || fail "2 manager_a reads $n targets, wanted 2"
n=$(AS $MANAGER_B "select count(*) from public.hq_targets")
[[ "$n" == "0" ]] || fail "2 manager_b reads $n targets of company A"
AS $OWNER_A "update public.hq_targets set green_to = 59 where metric = 'prime_cost_pct' and location_id is null" >/dev/null
u=$(AS $OWNER_A "select count(*) from public.hq_targets where updated_at > created_at")
[[ "$u" == "1" ]] || fail "2 updated_at did not move: $u"
echo "PASS 2 targets: manager_a refused (42501), owner_a writes company and A2 rows, duplicate metric refused (23505), company B row refused, manager_b sees none"

# 3. Safe movements.
MV="insert into public.hq_safe_movements (org_id, location_id, business_date, kind, amount, ref_kind, ref_id)"
e=$(ERR $MANAGER_A "$MV values ('$ORG_A', '$A1', '2026-11-16', 'drawer_in', -50, null, null)")
[[ "$e" == "23514" ]] || fail "3 negative drawer_in accepted: '$e'"
e=$(ERR $MANAGER_A "$MV values ('$ORG_A', '$A1', '2026-11-16', 'bank_out', 50, null, null)")
[[ "$e" == "23514" ]] || fail "3 positive bank_out accepted: '$e'"
e=$(ERR $MANAGER_A "$MV values ('$ORG_A', '$A1', '2026-11-16', 'drawer_in', 50, 'drawer_session', null)")
[[ "$e" == "23514" ]] || fail "3 ref_kind without ref_id accepted: '$e'"
AS $MANAGER_A "$MV values ('$ORG_A', '$A1', '2026-11-16', 'drawer_in', 812.40, 'drawer_session', 'ds-1')" >/dev/null
e=$(ERR $MANAGER_A "$MV values ('$ORG_A', '$A1', '2026-11-16', 'drawer_in', 812.40, 'drawer_session', 'ds-1')")
[[ "$e" == "23505" ]] || fail "3 the same drawer session posted twice: '$e'"
AS $MANAGER_A "$MV values ('$ORG_A', '$A1', '2026-11-16', 'drop_in', 200, 'cash_movement', 'cm-1')" >/dev/null
AS $MANAGER_A "$MV values ('$ORG_A', '$A1', '2026-11-17', 'float_out', -150, 'drawer_session', 'ds-2')" >/dev/null
AS $MANAGER_A "$MV values ('$ORG_A', '$A1', '2026-11-17', 'adjustment', -2.40, null, null)" >/dev/null
bal=$(AS $MANAGER_A "select sum(amount) from public.hq_safe_movements where location_id = '$A1'")
[[ "$bal" == "860.00" ]] || fail "3 balance: $bal, wanted 860.00"
e=$(ERR $MANAGER_B "$MV values ('$ORG_A', '$A1', '2026-11-16', 'drawer_in', 10, null, null)")
[[ "$e" == "42501" ]] || fail "3 manager_b posted to A1: '$e'"
n=$(AS $MANAGER_B "select count(*) from public.hq_safe_movements")
[[ "$n" == "0" ]] || fail "3 manager_b sees $n movements"
e=$(ERR $MANAGER_A "update public.hq_safe_movements set amount = 1 where location_id = '$A1'")
[[ "$e" == "42501" ]] || fail "3 update not refused: '$e'"
e=$(ERR $MANAGER_A "delete from public.hq_safe_movements where location_id = '$A1'")
[[ "$e" == "42501" ]] || fail "3 delete not refused: '$e'"
echo "PASS 3 safe movements: sign and ref rules (23514), one post per till event (23505), balance 860.00, manager_b refused and sees none, update and delete refused (42501)"

# 4. Safe counts.
AS $MANAGER_A "insert into public.hq_safe_counts (org_id, location_id, business_date, counted_total, expected_total) values ('$ORG_A', '$A1', '2026-11-17', 855, 860)" >/dev/null
v=$(AS $MANAGER_A "select variance from public.hq_safe_counts where location_id = '$A1'")
[[ "$v" == "-5.00" ]] || fail "4 variance: $v"
e=$(ERR $MANAGER_A "update public.hq_safe_counts set counted_total = 860 where location_id = '$A1'")
[[ "$e" == "42501" ]] || fail "4 count update not refused: '$e'"
e=$(ERR $MANAGER_B "insert into public.hq_safe_counts (org_id, location_id, business_date, counted_total, expected_total) values ('$ORG_A', '$A1', '2026-11-17', 1, 1)")
[[ "$e" == "42501" ]] || fail "4 manager_b counted A1: '$e'"
echo "PASS 4 safe counts: variance generated (-5.00), append only, other company refused"

# 5. Deposits.
AS $MANAGER_A "insert into public.hq_bank_deposits (id, org_id, location_id, business_date, amount, bag_reference) values ('dddddddd-dddd-4ddd-8ddd-000000000001', '$ORG_A', '$A1', '2026-11-17', 700, 'BAG-001')" >/dev/null
e=$(ERR $MANAGER_A "insert into public.hq_bank_deposits (org_id, location_id, business_date, amount) values ('$ORG_A', '$A1', '2026-11-17', 0)")
[[ "$e" == "23514" ]] || fail "5 zero deposit accepted: '$e'"
AS $MANAGER_A "update public.hq_bank_deposits set status = 'banked', banked_at = now() where id = 'dddddddd-dddd-4ddd-8ddd-000000000001'" >/dev/null
s=$(AS $MANAGER_A "select status||'|'||(updated_at > created_at)::text from public.hq_bank_deposits where id = 'dddddddd-dddd-4ddd-8ddd-000000000001'")
[[ "$s" == "banked|true" ]] || fail "5 status update: $s"
n=$(AS $MANAGER_B "update public.hq_bank_deposits set status = 'cancelled' where location_id = '$A1'" | sed -n 's/^UPDATE //p')
m=$(AS $MANAGER_A "select status from public.hq_bank_deposits where id = 'dddddddd-dddd-4ddd-8ddd-000000000001'")
[[ "$m" == "banked" ]] || fail "5 manager_b changed company A's deposit: $m"
e=$(ERR $MANAGER_B "insert into public.hq_bank_deposits (org_id, location_id, business_date, amount) values ('$ORG_A', '$A1', '2026-11-17', 5)")
[[ "$e" == "42501" ]] || fail "5 manager_b inserted a deposit for A1: '$e'"
echo "PASS 5 deposits: prepared then banked by manager_a, zero refused (23514), manager_b cannot insert or change"

# 6. Second run, rollback, forward again.
COUNTS="select (select count(*) from pg_policy p join pg_class c on c.oid = p.polrelid where c.relname like 'hq\_%')
        ||'|'||(select count(*) from pg_class where relname like 'hq\_%' and relkind = 'r')
        ||'|'||(select count(*) from public.hq_safe_movements)||'|'||(select count(*) from public.hq_targets)"
before=$(P -c "$COUNTS")
P -f "$F" >/dev/null
after=$(P -c "$COUNTS")
[[ "$before" == "$after" ]] || fail "6 second run changed counts (policies|tables|movements|targets): $before to $after"
P -f "$RB" >/dev/null
g=$(P -c "select count(*) from pg_class where relname like 'hq\_%' and relkind = 'r'")
[[ "$g" == "6" ]] || fail "6 rollback left $g tables, wanted 20261130a's 6"
P -f "$F" >/dev/null
t=$(P -c "select count(*) from pg_class where relname like 'hq\_%' and relkind = 'r' and relrowsecurity")
[[ "$t" == "10" ]] || fail "6 migration after rollback: $t tables"
echo "PASS 6 second run unchanged ($after); rollback left the six slice 1 tables; migration ran again"
# 7. Slice 3 (20261202a): sources column, 'system' source, twice, rollback and forward.
F3="$MIG/20261202a_OPS_head_office_numbers_sources.sql"
RB3="$MIG/20261202a_OPS_head_office_numbers_sources_ROLLBACK.sql"
P -f "$F3" >/dev/null
c=$(P -c "select data_type from information_schema.columns where table_name = 'hq_daily_numbers' and column_name = 'sources'")
[[ "$c" == "jsonb" ]] || fail "7 sources column: '$c'"
AS $MANAGER_A "insert into public.hq_daily_numbers (org_id, location_id, business_date, net_sales, cogs, source, sources) values ('$ORG_A', '$A1', '2026-11-01', 4453.9, 160, 'system', '{\"net_sales\":\"till\",\"cogs\":\"typed\"}')" >/dev/null
r=$(AS $MANAGER_A "select source||'|'||(sources->>'net_sales')||'|'||(sources->>'cogs') from public.hq_daily_numbers where location_id = '$A1' and business_date = '2026-11-01'")
[[ "$r" == "system|till|typed" ]] || fail "7 system row: '$r'"
e=$(ERR $MANAGER_A "insert into public.hq_daily_numbers (org_id, location_id, business_date, source) values ('$ORG_A', '$A1', '2026-11-02', 'guess')")
[[ "$e" == "23514" ]] || fail "7 unknown source accepted: '$e'"
e=$(ERR $MANAGER_A "insert into public.hq_daily_numbers (org_id, location_id, business_date, sources) values ('$ORG_A', '$A1', '2026-11-03', '[1]')")
[[ "$e" == "23514" ]] || fail "7 sources array accepted: '$e'"
P -f "$F3" >/dev/null
c=$(P -c "select count(*) from information_schema.columns where table_name = 'hq_daily_numbers' and column_name = 'sources'")
[[ "$c" == "1" ]] || fail "7 second run: $c sources columns"
P -f "$RB3" >/dev/null
r=$(P -c "select source||'|'||(select count(*) from information_schema.columns where table_name = 'hq_daily_numbers' and column_name = 'sources') from public.hq_daily_numbers where location_id = '$A1' and business_date = '2026-11-01'")
[[ "$r" == "typed|0" ]] || fail "7 rollback: '$r'"
P -f "$F3" >/dev/null
echo "PASS 7 slice 3 sources column, 'system' rows, unknown source and array refused (23514), twice, rollback and forward"
echo "head_office_cash: 7 checks pass"
