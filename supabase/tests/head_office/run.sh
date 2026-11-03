#!/bin/zsh
# head_office/run.sh: proves 20261119a on a throwaway local Postgres (5.12.56).
#   zsh supabase/tests/head_office/run.sh
# Builds a small wf_staff with the 20261104a identity fence's column grants (the regrant helper as
# 20261111a left it), runs 20261119a, then checks:
#   1. the check line says ready and the two columns exist (head_office false by default),
#   2. a Back Office login (authenticated) can write head_office and salary_annual,
#   3. it still cannot write an identity column (portal_user_id),
#   4. a salary below 0 is refused by the constraint,
#   5. a second run changes nothing and does not fail,
#   6. the Platform database is refused with nothing changed,
#   7. the rollback removes both columns.
set -e
export LC_ALL=en_US.UTF-8 LANG=en_US.UTF-8
HERE="${0:A:h}"; MIG="${HERE:h:h}/migrations"
DIR="$(mktemp -d)"; PORT=55433
trap 'pg_ctl -D "$DIR" -m immediate stop >/dev/null 2>&1; rm -rf "$DIR"' EXIT
initdb -D "$DIR" -U postgres >/dev/null
pg_ctl -D "$DIR" -o "-p $PORT -k $DIR" -l "$DIR/log" start >/dev/null
sleep 1
P() { psql -h "$DIR" -p $PORT -U postgres -d postgres -v ON_ERROR_STOP=1 -qAt "$@"; }
P -c "create role authenticated; create role anon; create role service_role;
      create table public.wf_staff (id uuid primary key, name text, portal_user_id uuid, pos_user_id uuid,
        portal_invite_hash text, portal_invite_expires timestamptz, person_id uuid);
      grant select on public.wf_staff to authenticated;
      insert into public.wf_staff (id, name) values ('11111111-1111-1111-1111-111111111111', 'Hana');"
# The regrant helper exactly as 20261111a defines it.
P -c "create or replace function public.wf_staff_regrant_api() returns integer language plpgsql security definer
      set search_path = public, pg_temp as \$f\$
      declare v_cols text; v_n integer;
      begin
        select string_agg(quote_ident(c.column_name), ', ' order by c.ordinal_position), count(*) into v_cols, v_n
          from information_schema.columns c
         where c.table_schema = 'public' and c.table_name = 'wf_staff'
           and c.column_name not in ('portal_user_id', 'pos_user_id', 'portal_invite_hash', 'portal_invite_expires', 'person_id');
        if v_n is null or v_n = 0 then raise exception 'wf_staff has no columns to grant'; end if;
        execute format('grant insert (%s), update (%s) on table public.wf_staff to authenticated', v_cols, v_cols);
        return v_n;
      end \$f\$;
      revoke insert, update on table public.wf_staff from authenticated;
      select public.wf_staff_regrant_api();" >/dev/null

out=$(P -f "$MIG/20261119a_OPS_wf_head_office.sql" | tail -1)
[ "$out" = "t" ] || { echo "FAIL 1 check line: $out"; exit 1; }
d=$(P -c "select head_office::text||'|'||coalesce(salary_annual::text,'null') from wf_staff")
[ "$d" = "false|null" ] || { echo "FAIL 1 default: $d"; exit 1; }

w=$(P -c "set role authenticated; update wf_staff set head_office = true, salary_annual = 60000 returning head_office::text||'|'||salary_annual::text")
[ "$w" = "true|60000.00" ] || { echo "FAIL 2 write: $w"; exit 1; }

if P -c "set role authenticated; update wf_staff set portal_user_id = gen_random_uuid()" >/dev/null 2>&1; then echo "FAIL 3: identity column writable"; exit 1; fi

if P -c "update wf_staff set salary_annual = -1" >/dev/null 2>&1; then echo "FAIL 4: negative salary kept"; exit 1; fi

again=$(P -f "$MIG/20261119a_OPS_wf_head_office.sql" | tail -1)
k=$(P -c "select head_office::text||'|'||salary_annual::text from wf_staff")
[ "$again" = "t" ] && [ "$k" = "true|60000.00" ] || { echo "FAIL 5 second run: $again $k"; exit 1; }

P -c "create table public.billing_state (id int)"
plat=$(P -f "$MIG/20261119a_OPS_wf_head_office.sql" 2>&1 | grep -c "This is the Platform database" || true)
[ "$plat" = "1" ] || { echo "FAIL 6: Platform not refused"; exit 1; }
P -c "drop table public.billing_state"

P -f "$MIG/20261119a_OPS_wf_head_office_ROLLBACK.sql" >/dev/null
gone=$(P -c "select count(*) from information_schema.columns where table_name = 'wf_staff' and column_name in ('head_office', 'salary_annual')")
[ "$gone" = "0" ] || { echo "FAIL 7 rollback: $gone"; exit 1; }
echo "head_office: 7 checks pass"
