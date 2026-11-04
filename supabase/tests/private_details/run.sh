#!/bin/zsh
# private_details/run.sh: proves 20261120a on a throwaway local Postgres (5.12.57, US basics batch 2).
#   zsh supabase/tests/private_details/run.sh
# Also proves 20261121a (identity document files and rate overrides behind the same door, 5.12.59).
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
L2=bbbbbbbb-0000-0000-0000-000000000002; S2=cccccccc-0000-0000-0000-000000000002
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
  create function public.user_accessible_locations() returns setof text language sql stable security definer as \$\$ select location_id::text from public.user_locations where user_id = auth.uid() union select l.id::text from public.locations l join public.user_profiles p on p.org_id = l.org_id where p.id = auth.uid() and p.role = 'owner' \$\$;
  create schema storage;
  create table storage.objects (id serial primary key, bucket_id text, name text);
  create function storage.foldername(name text) returns text[] language sql immutable as \$\$ select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] \$\$;
  alter table storage.objects enable row level security;
  grant usage on schema storage to anon, authenticated;
  grant select on storage.objects to anon, authenticated;
  create policy wf_docs_select on storage.objects for select to authenticated
    using (bucket_id = 'wf-documents' and (storage.foldername(objects.name))[1] in (select public.user_accessible_locations()));
  insert into storage.objects (bucket_id, name) values ('wf-documents', '$L1/$S1/RTW-1786118689321.jpeg'), ('wf-documents', '$L1/$S1/foodHygieneL2-1786118689322.pdf'), ('wf-documents', '$L1/training/1786118689323-handbook.pdf');
  alter table public.wf_staff add column rate_override numeric;
  grant select, update on public.user_profiles to authenticated;
  grant select on public.locations, public.user_locations to authenticated;
  grant select on public.wf_staff to anon, authenticated;
  insert into public.locations values ('$L1', '$O1');
  insert into public.user_profiles values ('$OWNER', '$O1', 'owner', now()), ('$ADMIN', '$O1', 'manager', now()), ('$MGR', '$O1', 'manager', now()), ('$OTHER', '$O2', 'owner', now());
  insert into public.user_locations values ('$ADMIN', '$L1', 'admin'), ('$MGR', '$L1', 'manager');
  insert into public.wf_staff (id, org_id, location_id, name, ni_number, ssn_last4, bank_account, bank_account_masked, rate_override) values ('$S1', '$O1', '$L1', 'Sam', 'QQ123456C', '1234', '12345678', '****5678', 12.5);
  insert into public.locations values ('$L2', '$O1');
  insert into public.wf_staff (id, org_id, location_id, name, rate_override) values ('$S2', '$O1', '$L2', 'Sam', 14);"
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

before=$(AS "$MGR" "select ni_number from public.wf_staff where id = '$S1'")
[ "$before" = "QQ123456C" ] || { echo "FAIL setup: a manager should read NI before: $before"; exit 1; }

out=$(P -f "$MIG/20261120a_OPS_wf_staff_private_details.sql" | tail -1)
[ "$out" = "f|t|t" ] || { echo "FAIL 1 visible check: $out"; exit 1; }

if AS "$MGR" "select ni_number from public.wf_staff" >/dev/null 2>&1; then echo "FAIL 2: a manager still reads ni_number"; exit 1; fi
if AS "$MGR" "select bank_account from public.wf_staff" >/dev/null 2>&1; then echo "FAIL 2b: a manager still reads bank_account"; exit 1; fi
n=$(AS "$MGR" "select name || '|' || bank_account_masked from public.wf_staff where id = '$S1'")
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

# ---- 20261121a: identity document files and rate overrides behind the same door (5.12.59) ----
files() { AS "$1" "select string_agg(split_part(name, '/', 3), ',' order by name collate \"C\") from storage.objects" "$2"; }
# A refused site raises (42501), so psql prints no answer row: anything that is not numbers reads as "-".
rates() { local r; r=$(AS "$1" "select coalesce(string_agg(rate_override::text, ',' order by staff_id), '-') from public.wf_staff_rates('$2')" "${3:-1}" 2>/dev/null || true); [[ "$r" =~ ^[0-9.,]+$ ]] && echo "$r" || printf '%s\n' '-'; }   # zsh echo prints nothing for a lone dash
[ "$(files $MGR)" = "RTW-1786118689321.jpeg,foodHygieneL2-1786118689322.pdf,1786118689323-handbook.pdf" ] || { echo "FAIL 19 setup: a manager opens every file before: $(files $MGR)"; exit 1; }
[ "$(AS "$MGR" "select rate_override from public.wf_staff where id = '$S2'")" = "14" ] || { echo "FAIL 20 setup: a manager reads another site's rate before"; exit 1; }
out=$(P -f "$MIG/20261121a_OPS_wf_private_docs_rates.sql" | tail -1)
[ "$out" = "f|t|t" ] || { echo "FAIL 21 visible check: $out"; exit 1; }
[ "$(files $MGR)" = "foodHygieneL2-1786118689322.pdf,1786118689323-handbook.pdf" ] || { echo "FAIL 22: a manager must not open the right to work file: $(files $MGR)"; exit 1; }
[ "$(files $OWNER)" = "RTW-1786118689321.jpeg,foodHygieneL2-1786118689322.pdf,1786118689323-handbook.pdf" ] || { echo "FAIL 23: the owner opens every file: $(files $OWNER)"; exit 1; }
[ "$(files $ADMIN)" = "RTW-1786118689321.jpeg,foodHygieneL2-1786118689322.pdf,1786118689323-handbook.pdf" ] || { echo "FAIL 24: an admin opens every file"; exit 1; }
[ "$(files $OTHER)" = "" ] || { echo "FAIL 25: another company sees no file"; exit 1; }
AS "$OWNER" "select public.set_payroll_details('$MGR', true)" >/dev/null
[ "$(files $MGR)" = "RTW-1786118689321.jpeg,foodHygieneL2-1786118689322.pdf,1786118689323-handbook.pdf" ] || { echo "FAIL 26: a ticked manager opens the right to work file"; exit 1; }
AS "$OWNER" "select public.set_payroll_details('$MGR', false)" >/dev/null
if AS "$MGR" "select rate_override from public.wf_staff" >/dev/null 2>&1; then echo "FAIL 27: a manager still reads rate_override from the table"; exit 1; fi
[ "$(AS "$MGR" "select name || '|' || bank_account_masked from public.wf_staff where id = '$S1'")" = "Sam|****5678" ] || { echo "FAIL 28: other columns stay readable"; exit 1; }
[ "$(rates $MGR $L1)" = "12.5" ] || { echo "FAIL 29: a manager reads their own site's rates: $(rates $MGR $L1)"; exit 1; }
[ "$(rates $MGR $L2)" = "-" ] || { echo "FAIL 30: a manager must not read another site's rates: $(rates $MGR $L2)"; exit 1; }
[ "$(rates $OWNER $L2)" = "14" ] || { echo "FAIL 31: the owner reads every site's rates"; exit 1; }
[ "$(rates $ADMIN $L2)" = "14" ] || { echo "FAIL 32: an admin reads every site's rates"; exit 1; }
[ "$(rates $OTHER $L2)" = "-" ] || { echo "FAIL 33: another company reads nothing"; exit 1; }
[ "$(rates $OWNER $L2 0)" = "-" ] || { echo "FAIL 34: no second step reads nothing"; exit 1; }
AS "$OWNER" "select public.set_payroll_details('$MGR', true)" >/dev/null
[ "$(rates $MGR $L2)" = "14" ] || { echo "FAIL 35: a ticked manager reads another site's rates"; exit 1; }
AS "$OWNER" "select public.set_payroll_details('$MGR', false)" >/dev/null
P -c "alter table public.wf_staff add column later_col2 text; select public.wf_staff_regrant_api();" >/dev/null
if AS "$MGR" "select rate_override from public.wf_staff" >/dev/null 2>&1; then echo "FAIL 36: the re grant opened rate_override"; exit 1; fi
again=$(P -f "$MIG/20261121a_OPS_wf_private_docs_rates.sql" | tail -1)
[ "$again" = "f|t|t" ] || { echo "FAIL 37 second run: $again"; exit 1; }
P -f "$MIG/20261121a_OPS_wf_private_docs_rates_ROLLBACK.sql" >/dev/null
[ "$(files $MGR)" = "RTW-1786118689321.jpeg,foodHygieneL2-1786118689322.pdf,1786118689323-handbook.pdf" ] || { echo "FAIL 38 rollback files"; exit 1; }
[ "$(AS "$MGR" "select rate_override from public.wf_staff where id = '$S2'")" = "14" ] || { echo "FAIL 39 rollback rates"; exit 1; }

P -f "$MIG/20261120a_OPS_wf_staff_private_details_ROLLBACK.sql" >/dev/null
back=$(AS "$MGR" "select ni_number from public.wf_staff where id = '$S1'")
[ "$back" = "QQ123456C" ] || { echo "FAIL 18 rollback: $back"; exit 1; }
echo "private_details: 39 checks pass"
