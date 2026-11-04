#!/bin/zsh
# private_details/run.sh: proves 20261120a on a throwaway local Postgres (5.12.57, US basics batch 2).
#   zsh supabase/tests/private_details/run.sh
# Builds just enough of Ops (companies, logins, venue links, staff, the second step and org helpers,
# the 20261111a regrant helper), runs 20261120a, then checks who can read staff ID numbers and bank
# details, the tick and its guard, the re grant, and the rollback.
set -e
setopt pipefail
export LC_ALL=en_US.UTF-8 LANG=en_US.UTF-8
HERE="${0:A:h}"; MIG="${HERE:h:h}/migrations"
DIR="$(mktemp -d)"; PORT=55434
trap 'pg_ctl -D "$DIR" -m immediate stop >/dev/null 2>&1; rm -rf "$DIR"' EXIT
initdb -D "$DIR" -U postgres >/dev/null 2>&1
pg_ctl -D "$DIR" -o "-p $PORT -k $DIR" -l "$DIR/log" start >/dev/null
sleep 1
P() { psql -h "$DIR" -p $PORT -U postgres -d postgres -v ON_ERROR_STOP=1 -qAt "$@"; }
O1=11111111-1111-1111-1111-111111111111; O2=22222222-2222-2222-2222-222222222222
OWNER=aaaaaaaa-0000-0000-0000-000000000001; ADMIN=aaaaaaaa-0000-0000-0000-000000000002
MGR=aaaaaaaa-0000-0000-0000-000000000003; OTHER=aaaaaaaa-0000-0000-0000-000000000004
L1=bbbbbbbb-0000-0000-0000-000000000001; S1=cccccccc-0000-0000-0000-000000000001
P -c "create role anon; create role authenticated; create role service_role;
  create schema auth; create function auth.uid() returns uuid language sql stable as \$\$ select nullif(current_setting('test.uid', true), '')::uuid \$\$;
  grant usage on schema auth to anon, authenticated;
  create table public.locations (id uuid primary key, org_id uuid);
  create table public.user_profiles (id uuid primary key, org_id uuid, role text, updated_at timestamptz);
  create table public.user_locations (user_id uuid, location_id uuid, role text);
  create table public.wf_staff (id uuid primary key, org_id uuid, location_id uuid, name text, ni_number text, ssn_last4 text, tax_ref text,
    bank_sort_code text, bank_account text, bank_account_name text, bank_account_masked text, portal_user_id uuid, pos_user_id uuid,
    portal_invite_hash text, portal_invite_expires timestamptz, person_id uuid);
  create function public.is_super_admin() returns boolean language sql stable as \$\$ select current_setting('test.super', true) = '1' \$\$;
  create function public.is_anon_session() returns boolean language sql stable as \$\$ select false \$\$;
  create function public.second_step_ok() returns boolean language sql stable as \$\$ select coalesce(current_setting('test.step', true), '1') = '1' \$\$;
  create function public.user_accessible_orgs() returns setof text language sql stable security definer as \$\$ select org_id::text from public.user_profiles where id = auth.uid() \$\$;
  grant select, update on public.user_profiles to authenticated;
  grant select on public.locations, public.user_locations to authenticated;
  grant select on public.wf_staff to anon, authenticated;
  insert into public.locations values ('$L1', '$O1');
  insert into public.user_profiles values ('$OWNER', '$O1', 'owner', now()), ('$ADMIN', '$O1', 'manager', now()), ('$MGR', '$O1', 'manager', now()), ('$OTHER', '$O2', 'owner', now());
  insert into public.user_locations values ('$ADMIN', '$L1', 'admin'), ('$MGR', '$L1', 'manager');
  insert into public.wf_staff (id, org_id, location_id, name, ni_number, ssn_last4, bank_account, bank_account_masked) values ('$S1', '$O1', '$L1', 'Sam', 'QQ123456C', '1234', '12345678', '****5678');"
P -c "create or replace function public.wf_staff_regrant_api() returns integer language plpgsql security definer set search_path = public, pg_temp as \$f\$
  declare v_cols text; v_n integer;
  begin
    select string_agg(quote_ident(c.column_name), ', ' order by c.ordinal_position), count(*) into v_cols, v_n
      from information_schema.columns c where c.table_schema = 'public' and c.table_name = 'wf_staff'
       and c.column_name not in ('portal_user_id', 'pos_user_id', 'portal_invite_hash', 'portal_invite_expires', 'person_id');
    execute format('grant insert (%s), update (%s) on table public.wf_staff to authenticated', v_cols, v_cols);
    return v_n;
  end \$f\$;" >/dev/null
# As a signed in login: set role authenticated with the request claims PostgREST sets.
AS() { P -c "set test.uid = '$1'; set test.step = '${3:-1}'; select set_config('request.jwt.claims', '{\"role\":\"authenticated\"}', false); set role authenticated; $2" | tail -1; }
door() { AS "$1" "select count(*) || ':' || coalesce(max(ni_number), '-') from public.wf_staff_private_details(array['$S1']::uuid[])" "$2"; }

before=$(AS "$MGR" "select ni_number from public.wf_staff")
[ "$before" = "QQ123456C" ] || { echo "FAIL setup: a manager should read NI before: $before"; exit 1; }

out=$(P -f "$MIG/20261120a_OPS_wf_staff_private_details.sql" | tail -1)
[ "$out" = "f|t|t" ] || { echo "FAIL 1 visible check: $out"; exit 1; }

if AS "$MGR" "select ni_number from public.wf_staff" >/dev/null 2>&1; then echo "FAIL 2: a manager still reads ni_number"; exit 1; fi
if AS "$MGR" "select bank_account from public.wf_staff" >/dev/null 2>&1; then echo "FAIL 2b: a manager still reads bank_account"; exit 1; fi
n=$(AS "$MGR" "select name || '|' || bank_account_masked from public.wf_staff")
[ "$n" = "Sam|****5678" ] || { echo "FAIL 3: other columns must stay readable: $n"; exit 1; }

[ "$(door $MGR)" = "0:-" ] || { echo "FAIL 4: manager door"; exit 1; }
[ "$(door $OWNER)" = "1:QQ123456C" ] || { echo "FAIL 5: owner door"; exit 1; }
[ "$(door $ADMIN)" = "1:QQ123456C" ] || { echo "FAIL 6: admin door"; exit 1; }
[ "$(door $OTHER)" = "0:-" ] || { echo "FAIL 7: another company's owner"; exit 1; }
[ "$(door $OWNER 0)" = "0:-" ] || { echo "FAIL 8: no second step must see nothing"; exit 1; }

if AS "$MGR" "update public.user_profiles set payroll_details = true where id = '$MGR'" >/dev/null 2>&1; then echo "FAIL 9: a manager ticked themselves"; exit 1; fi
if AS "$ADMIN" "select public.set_payroll_details('$MGR', true)" >/dev/null 2>&1; then echo "FAIL 10: a non owner set the tick"; exit 1; fi
if AS "$OWNER" "select public.set_payroll_details('$OWNER', true)" >/dev/null 2>&1; then echo "FAIL 11: own login"; exit 1; fi
if AS "$OTHER" "select public.set_payroll_details('$MGR', true)" >/dev/null 2>&1; then echo "FAIL 12: another company"; exit 1; fi
AS "$OWNER" "select public.set_payroll_details('$MGR', true)" >/dev/null
[ "$(door $MGR)" = "1:QQ123456C" ] || { echo "FAIL 13: ticked manager door"; exit 1; }
AS "$OWNER" "select public.set_payroll_details('$MGR', false)" >/dev/null
[ "$(door $MGR)" = "0:-" ] || { echo "FAIL 14: unticked manager door"; exit 1; }

P -c "alter table public.wf_staff add column later_col text; select public.wf_staff_regrant_api();" >/dev/null
AS "$MGR" "select later_col from public.wf_staff" >/dev/null || { echo "FAIL 15: a later column must be readable after the re grant"; exit 1; }
if AS "$MGR" "select ni_number from public.wf_staff" >/dev/null 2>&1; then echo "FAIL 16: the re grant opened ni_number"; exit 1; fi

again=$(P -f "$MIG/20261120a_OPS_wf_staff_private_details.sql" | tail -1)
[ "$again" = "f|t|t" ] || { echo "FAIL 17 second run: $again"; exit 1; }

P -f "$MIG/20261120a_OPS_wf_staff_private_details_ROLLBACK.sql" >/dev/null
back=$(AS "$MGR" "select ni_number from public.wf_staff")
[ "$back" = "QQ123456C" ] || { echo "FAIL 18 rollback: $back"; exit 1; }
echo "private_details: 18 checks pass"
