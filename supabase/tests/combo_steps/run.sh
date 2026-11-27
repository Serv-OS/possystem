#!/usr/bin/env bash
# Proves 20261215a (menu_items.combo, the steps of a Combo product) on a throwaway local Postgres
# (port 55438): the column arrives empty on every row, the check takes steps and refuses rubbish,
# a function that reads the whole row and a Multi site menu style update of named columns keep
# working and never touch the steps, a second run changes nothing, and the rollback keeps every
# Combo's steps in a keep table so they can be put back (and a later rollback never brings back
# steps that were taken off in between).
set -euo pipefail
export LC_ALL="${LC_ALL:-C}"   # a shell with no locale makes the postmaster refuse to start
HERE="$(cd "$(dirname "$0")" && pwd)"
MIG="$HERE/../../migrations"
DIR="$(mktemp -d)"; PORT=55438
trap 'pg_ctl -D "$DIR" -m immediate stop >/dev/null 2>&1; rm -rf "$DIR"' EXIT
initdb -D "$DIR" -U postgres >/dev/null 2>&1
pg_ctl -D "$DIR" -o "-p $PORT -k $DIR" -l "$DIR/log" start >/dev/null || { cat "$DIR/log"; exit 1; }
P="psql -v ON_ERROR_STOP=1 -h $DIR -p $PORT -U postgres -d postgres -qtAX"
check() { local got; got="$($P -c "$1")"; [ "$got" = "$2" ] || { echo "FAIL $3: got [$got] wanted [$2]"; exit 1; }; echo "ok   $3"; }
refused() { if $P -c "$1" >/dev/null 2>&1; then echo "FAIL $2: it was allowed"; exit 1; fi; echo "ok   $2"; }

$P <<'SQL'
create role anon; create role authenticated;
create table public.menu_items (
  id text primary key, location_id text, name text, menu_name text, type text default 'simple',
  pricing jsonb, visibility jsonb, archived boolean default false, updated_at timestamptz default now()
);
insert into public.menu_items (id, location_id, name, menu_name, type, pricing) values
  ('m-pizza',  'L1', 'Margherita', 'Margherita', 'simple', '{"base":16}'),
  ('m-combo',  'L1', 'Build Your Own Package', 'Build Your Own Package', 'combo', '{"base":149}'),
  ('m-plain',  'L1', 'Old Combo', 'Old Combo', 'combo', '{"base":30}'),
  ('m-other',  'L2', 'Lunch Combo', 'Lunch Combo', 'combo', '{"base":12}');

-- A function that reads the WHOLE row, the way _public_order_value does (r menu_items%rowtype).
create function public.whole_row_price(p_id text) returns numeric language plpgsql as $$
declare r public.menu_items%rowtype;
begin
  select * into r from public.menu_items m where m.id = p_id;
  return (r.pricing ->> 'base')::numeric;
end $$;

-- A write of NAMED columns from json, the way msm_apply_site updates a site's row.
create function public.named_update(p_id text, p_set jsonb) returns void language plpgsql as $$
begin
  update public.menu_items t set (name, menu_name, pricing, updated_at) =
    (select r.name, r.menu_name, r.pricing, now() from jsonb_populate_record(t, p_set) r)
  where t.id = p_id;
end $$;
SQL

# One session: the function is called (its plan is kept), the column arrives, it is called again.
got="$($P <<SQL
select public.whole_row_price('m-combo');
\i $MIG/20261215a_OPS_menu_item_combo_steps.sql
select public.whole_row_price('m-combo');
SQL
)"
echo "$got" | head -1 | grep -qx '149' || { echo "FAIL 1: whole row read before the column: [$got]"; exit 1; }
echo "$got" | tail -1 | grep -qx '149' || { echo "FAIL 1: whole row read after the column, same session: [$got]"; exit 1; }
echo "ok   1 a function that reads the whole row still works in the session that saw the column arrive"

check "select data_type||'|'||is_nullable from information_schema.columns where table_name='menu_items' and column_name='combo'" "jsonb|YES" "2 the column is jsonb and may be empty"
check "select count(*) from menu_items where combo is not null" "0" "3 every existing row is empty: nothing changes for any product"
check "select convalidated from pg_constraint where conname='menu_items_combo_shape_check'" "t" "4 the check is in place and validated"

STEPS='{"v":1,"steps":[{"id":"st-1","name":"Pick 5 pizzas","selectionType":"quantity","min":5,"max":5,"pricing":"set","products":[{"itemId":"m-pizza","bump":0}]}]}'
$P -c "update menu_items set combo='$STEPS' where id='m-combo'" >/dev/null
check "select jsonb_array_length(combo->'steps') from menu_items where id='m-combo'" "1" "5 steps save"
$P -c "update menu_items set combo='{\"v\":1,\"steps\":[]}' where id='m-other'" >/dev/null
check "select combo->>'v' from menu_items where id='m-other'" "1" "6 an empty list of steps is allowed"
$P -c "update menu_items set combo=null where id='m-other'" >/dev/null
check "select count(*) from menu_items where id='m-other' and combo is null" "1" "7 the steps can be cleared again"
refused "update menu_items set combo='\"just words\"' where id='m-plain'" "8 a bare string is refused"
refused "update menu_items set combo='[1,2]' where id='m-plain'" "9 a bare list is refused"
refused "update menu_items set combo='{\"v\":1}' where id='m-plain'" "10 an object with no steps list is refused"
refused "update menu_items set combo='{\"steps\":\"none\"}' where id='m-plain'" "11 steps that are not a list are refused"
refused "update menu_items set combo='42' where id='m-plain'" "12 a number is refused"

# A Multi site menu style publish of named columns: the steps are neither read nor written.
$P -c "select public.named_update('m-combo', '{\"name\":\"Build Your Own\",\"menu_name\":\"Build Your Own\",\"combo\":null}')" >/dev/null
check "select name||'|'||jsonb_array_length(combo->'steps') from menu_items where id='m-combo'" "Build Your Own|1" "13 a write of named columns leaves the steps alone, even when its json carries a combo key"
check "select public.whole_row_price('m-combo')" "149" "14 a whole row read works with steps on the row"

# A second run changes nothing.
$P -f "$MIG/20261215a_OPS_menu_item_combo_steps.sql" >/dev/null
check "select jsonb_array_length(combo->'steps') from menu_items where id='m-combo'" "1" "15 a second run keeps the steps"
check "select count(*) from pg_constraint where conname='menu_items_combo_shape_check'" "1" "16 a second run leaves one check"

# The rollback keeps the steps, then drops the column.
$P -f "$MIG/20261215a_OPS_menu_item_combo_steps_ROLLBACK.sql" >/dev/null 2>&1
check "select count(*) from information_schema.columns where table_name='menu_items' and column_name='combo'" "0" "17 rollback drops the column"
check "select id||'|'||location_id||'|'||name||'|'||jsonb_array_length(combo->'steps') from menu_items_combo_keep_20261215" "m-combo|L1|Build Your Own|1" "18 rollback keeps every Combo's steps (and only those)"
check "select public.whole_row_price('m-combo')" "149" "19 a whole row read works once the column is gone"
check "select has_table_privilege('anon','public.menu_items_combo_keep_20261215','select')::text" "false" "20 the keep table is not readable by the app"
$P -f "$MIG/20261215a_OPS_menu_item_combo_steps_ROLLBACK.sql" >/dev/null 2>&1
check "select count(*) from menu_items_combo_keep_20261215" "1" "21 a second rollback run is safe and keeps what it kept"

# And back again: the column returns empty, the kept steps go back exactly.
$P -f "$MIG/20261215a_OPS_menu_item_combo_steps.sql" >/dev/null
check "select count(*) from menu_items where combo is not null" "0" "22 the column comes back empty"
$P -c "update public.menu_items m set combo = k.combo from public.menu_items_combo_keep_20261215 k where m.id::text = k.id and m.combo is null" >/dev/null
check "select combo->'steps'->0->>'name' from menu_items where id='m-combo'" "Pick 5 pizzas" "23 the kept steps are put back exactly"

# A LATER rollback (the keep table was never dropped): it keeps the steps as they are THEN.
# Steps somebody has taken off since must not come back when the steps are put back again.
$P -c "update menu_items set combo=null where id='m-combo'" >/dev/null
$P -c "update menu_items set combo='$STEPS' where id='m-other'" >/dev/null
$P -f "$MIG/20261215a_OPS_menu_item_combo_steps_ROLLBACK.sql" >/dev/null 2>&1
check "select string_agg(id, ',' order by id) from menu_items_combo_keep_20261215" "m-other" "24 a later rollback keeps the steps as they are then, and nothing older"
$P -f "$MIG/20261215a_OPS_menu_item_combo_steps.sql" >/dev/null
$P -c "update public.menu_items m set combo = k.combo from public.menu_items_combo_keep_20261215 k where m.id::text = k.id and m.combo is null" >/dev/null
check "select count(*) from menu_items where id='m-combo' and combo is not null" "0" "25 steps taken off before that rollback do not come back"
check "select combo->'steps'->0->>'name' from menu_items where id='m-other'" "Pick 5 pizzas" "26 the steps it did keep are put back"
echo "ALL PASS"
