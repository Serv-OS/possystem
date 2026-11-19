#!/usr/bin/env bash
# Proves 20261204a on a throwaway local Postgres (port 55437): the placeholder rows are
# repaired, typed names and unnamed products are left alone, a second run changes nothing,
# and the rollback puts the old values back.
set -euo pipefail
export LC_ALL="${LC_ALL:-C}"   # a shell with no locale makes the postmaster refuse to start
HERE="$(cd "$(dirname "$0")" && pwd)"
MIG="$HERE/../../migrations"
DIR="$(mktemp -d)"; PORT=55437
trap 'pg_ctl -D "$DIR" -m immediate stop >/dev/null 2>&1; rm -rf "$DIR"' EXIT
initdb -D "$DIR" -U postgres >/dev/null 2>&1
pg_ctl -D "$DIR" -o "-p $PORT -k $DIR" -l "$DIR/log" start >/dev/null || { cat "$DIR/log"; exit 1; }
P="psql -v ON_ERROR_STOP=1 -h $DIR -p $PORT -U postgres -d postgres -qtAX"

$P <<'SQL'
create role anon; create role authenticated;
create table public.menu_items (id text primary key, location_id text, name text, menu_name text, kitchen_name text, receipt_name text);
insert into public.menu_items values
  ('a', 'L1', 'Oreo Sandwich Filled Donut', 'Oreo Sandwich Filled Donut', 'New item', 'New item'),
  ('b', 'L1', 'Hot', 'Hot', 'New item 2', 'New item 2'),
  ('c', 'L2', 'Pint', 'Pint', 'New size', 'Pint'),
  ('d', 'L2', 'Latte', 'Latte', 'LAT', 'Latte'),
  ('e', 'L2', 'New item', 'New item', 'New item', 'New item'),
  ('f', 'L2', 'Espresso', 'Espresso', 'New item', 'ESPRESSO'),
  ('g', 'L3', 'Newish item', 'Newish item', 'New items', 'New item please');
SQL

$P -f "$MIG/20261204a_OPS_menu_placeholder_names_repair.sql" >/dev/null
check() { local got; got="$($P -c "$1")"; [ "$got" = "$2" ] || { echo "FAIL $3: got [$got] wanted [$2]"; exit 1; }; echo "ok   $3"; }
check "select kitchen_name||'|'||receipt_name from menu_items where id='a'" "Oreo Sandwich Filled Donut|Oreo Sandwich Filled Donut" "1 placeholder kitchen and receipt names become the product name"
check "select kitchen_name||'|'||receipt_name from menu_items where id='b'" "Hot|Hot" "2 a numbered placeholder is repaired too"
check "select kitchen_name||'|'||receipt_name from menu_items where id='c'" "Pint|Pint" "3 New size is repaired, a receipt name already right is untouched"
check "select kitchen_name||'|'||receipt_name from menu_items where id='d'" "LAT|Latte" "4 a typed kitchen name is left alone"
check "select kitchen_name||'|'||receipt_name from menu_items where id='e'" "New item|New item" "5 a product nobody has named yet is left alone"
check "select kitchen_name||'|'||receipt_name from menu_items where id='f'" "Espresso|ESPRESSO" "6 only the placeholder side changes"
check "select kitchen_name||'|'||receipt_name from menu_items where id='g'" "New items|New item please" "7 words that only start like the placeholder are not touched"
check "select count(*) from menu_items_name_repair_20261204" "4" "8 the keep table holds exactly the repaired rows"
$P -f "$MIG/20261204a_OPS_menu_placeholder_names_repair.sql" >/dev/null
check "select count(*) from menu_items_name_repair_20261204" "4" "9 a second run finds nothing new"
# Row a is renamed after the repair the way rule 10 does it (name and kitchen name together).
$P -c "update menu_items set kitchen_name='Oreo', menu_name='Oreo', name='Oreo' where id='a'" >/dev/null
$P -f "$MIG/20261204a_OPS_menu_placeholder_names_repair_ROLLBACK.sql" >/dev/null
check "select kitchen_name||'|'||receipt_name from menu_items where id='b'" "New item 2|New item 2" "10 rollback puts the old names back"
check "select kitchen_name||'|'||receipt_name from menu_items where id='a'" "Oreo|New item" "11 rollback leaves a kitchen name renamed since, and restores the receipt side"
check "select count(*) from pg_tables where tablename='menu_items_name_repair_20261204'" "0" "12 rollback drops the keep table"
echo "ALL PASS"
