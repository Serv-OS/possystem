#!/bin/zsh
# unit_bridges_proof.sh: proves 20261208a_OPS_stock_import_unit_bridges.sql (and its rollback) on the
# throwaway local PostgreSQL the stock_native rig builds. It never connects to Supabase.
#
#   STOCKN_KEEP=1 STOCKN_STOP_AT=40 node supabase/tests/stock_native/run.mjs --drop3 --quick
#   # the last line prints:  kept: psql -h <dir> -p <port> -U postgres -d n_prop0
#   zsh supabase/tests/stock_native/unit_bridges_proof.sh <dir> <port>
#
# It copies the rig's n_d3_after database (0a to Drop 3, the import functions byte for byte as live)
# and checks: the paste and a second paste; the check screen's answer for good and bad unit bridge
# rows; the commit through the real queue (company row, a row at every site the item is on, the cost
# of an item bought by volume and kept by weight); a second run changes nothing; a changed amount is
# a Change; the same bridge written the other way round is Same; the rollback.
# Exit code 0 only when every check holds.
set -u
H=$1; PORT=$2
REPO=${0:A:h}/../../..
MIG=$REPO/supabase/migrations/20261208a_OPS_stock_import_unit_bridges.sql
RB=$REPO/supabase/migrations/20261208a_OPS_stock_import_unit_bridges_ROLLBACK.sql
OWNER=10000000-0000-4000-8000-00000000000a
ORG=a59a6d97-ffaa-470e-8bb7-04cba789f335
PROVO=7218c716-eeb4-4f96-b284-f3500823595c
LOC2=c3ebfa7f-61b3-4fbc-a192-e7e3949f370e
P=(psql -h $H -p $PORT -U postgres -X -q -A -t -v ON_ERROR_STOP=1)
fails=0; checks=0
ok() { checks=$((checks+1)); if [ "$1" = "$2" ]; then echo "  ok   $3"; else echo "  FAIL $3 (got: $1, want: $2)"; fails=$((fails+1)); fi }
q() { $P -d ul_t -c "$1" 2>&1; }
# one statement as the signed in owner, the way PostgREST runs it
as() { $P -d ul_t 2>&1 <<SQL
begin;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"$OWNER","aal":"aal2","is_anonymous":false,"aud":"authenticated"}', true) \g /dev/null
set local role authenticated;
$1;
commit;
SQL
}
run_queue() { for i in 1 2 3 4 5 6 7 8; do n=$(q "select coalesce(min(id)::text, '') from stock_save_queue where status = 'waiting' and due_at <= now()"); [ -z "$n" ] && break; q "select public.stock_co__run_job($n)" >/dev/null; done }
md5s() { q "select string_agg(md5(p.prosrc), ',' order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('stock_import_stage', 'stock_co__import_check_row', 'stock_co__import_apply')"; }
stage() { as "select public.stock_import_stage(null, '$1'::jsonb, '{\"org_id\":\"$ORG\",\"source\":\"csv\",\"file_name\":\"$2\",\"sites\":[\"$PROVO\",\"$LOC2\"]}'::jsonb)"; }
field() { echo "$1" | python3 -c "import sys,json; d=json.loads(sys.stdin.read().strip().splitlines()[-1]); print(eval('d'+sys.argv[1]))" "$2" 2>/dev/null; }

$P -d postgres -c "drop database if exists ul_t with (force)" -c "create database ul_t template n_d3_after" >/dev/null
BEFORE=$(md5s)
echo "== 1. the paste"
out=$($P -d ul_t -f $MIG 2>&1); ok "$?" "0" "the file runs (${out##*$'\n'})"
AFTER=$(md5s)
ok "$([ "$BEFORE" != "$AFTER" ] && echo changed)" "changed" "the three functions are replaced"
out=$($P -d ul_t -f $MIG 2>&1); ok "$?" "0" "a second paste is harmless"
ok "$(md5s)" "$AFTER" "and leaves the same three bodies"
ok "$(q "select count(*) from pg_constraint where conname = 'stock_co_import_rows_kind_check' and pg_get_constraintdef(oid) like '%bridge%'")" "1" "the kind check allows a bridge row"

echo "== 2. the check screen"
ROWS='[
 {"row_no":1000002,"kind":"item","data":{"name":"UL Olives","base_unit":"oz","type":"food"}},
 {"row_no":6000002,"kind":"bridge","data":{"item":"UL Olives","from_qty":30,"from_unit":"oz","to_qty":40,"to_unit":"floz"}},
 {"row_no":6000003,"kind":"bridge","data":{"item":"Lemons","from_qty":1,"from_unit":"each","to_qty":100,"to_unit":"g"}},
 {"row_no":6000004,"kind":"bridge","data":{"item":"Lemons","from_qty":16,"from_unit":"oz","to_qty":1,"to_unit":"lb"}},
 {"row_no":6000005,"kind":"bridge","data":{"item":"Lemons","from_qty":1,"from_unit":"each","to_qty":3,"to_unit":"cupz"}},
 {"row_no":6000006,"kind":"bridge","data":{"item":"No such item","from_qty":1,"from_unit":"each","to_qty":3,"to_unit":"g"}},
 {"row_no":6000007,"kind":"bridge","data":{"item":"Lemons","from_qty":0,"from_unit":"each","to_qty":3,"to_unit":"ml"}},
 {"row_no":6000008,"kind":"bridge","data":{"from_qty":1,"from_unit":"each","to_qty":3,"to_unit":"ml"}}
]'
r=$(stage "$ROWS" bridges.csv)
JOB=$(field "$r" "['job_id']")
ok "$(field "$r" "['counts']['new_bridges']")" "2" "two good unit bridges read New (one on an item new in the same file)"
ok "$(field "$r" "['counts']['problem']")" "5" "five bad rows are problems"
ok "$(q "select problem from stock_co_import_rows where job_id = '$JOB' and row_no = 6000004")" "oz and lb measure the same thing, so they need no unit bridge." "two units of the same kind are refused in words"
ok "$(q "select problem from stock_co_import_rows where job_id = '$JOB' and row_no = 6000005")" '"cupz" is not a unit ServOS knows (g, kg, ml, l, each, ...).' "an unknown unit is refused in words"
ok "$(q "select problem from stock_co_import_rows where job_id = '$JOB' and row_no = 6000006")" "No stock item called No such item. Add it to the file or the list first." "an unknown item is refused in words"
ok "$(q "select problem from stock_co_import_rows where job_id = '$JOB' and row_no = 6000007")" "Both amounts of a unit bridge must be numbers above 0." "a zero amount is refused in words"
ok "$(q "select problem from stock_co_import_rows where job_id = '$JOB' and row_no = 6000008")" "Add the stock item." "a row with no item is refused in words"
r=$(as "select public.stock_import_commit('$JOB')")
ok "$(echo "$r" | grep -c "Fix or skip the 5 rows with problems first")" "1" "a file with problems cannot be committed"
as "select public.stock_import_cancel('$JOB')" >/dev/null

echo "== 3. the commit"
LEMON_COST_BEFORE=$(q "select string_agg(coalesce(i.current_cost::text, 'null'), ',' order by i.location_id) from inventory_items i join stock_co_item_sites s on s.site_item_id = i.id join stock_co_items c on c.id = s.item_id where c.org_id = '$ORG' and c.name = 'Lemons'")
GOOD='[
 {"row_no":1000002,"kind":"item","data":{"name":"UL Olives","base_unit":"oz","type":"food"}},
 {"row_no":2000002,"kind":"supplier","data":{"name":"UL Supplier"}},
 {"row_no":3000002,"kind":"supplier_item","data":{"supplier":"UL Supplier","item":"UL Olives","pack_qty":1,"inner_qty":1,"inner_unit":"l","pack_price":7.04}},
 {"row_no":6000002,"kind":"bridge","data":{"item":"UL Olives","from_qty":30,"from_unit":"oz","to_qty":40,"to_unit":"floz"}},
 {"row_no":6000003,"kind":"bridge","data":{"item":"Lemons","from_qty":1,"from_unit":"each","to_qty":100,"to_unit":"g"}}
]'
r=$(stage "$GOOD" good.csv); JOB=$(field "$r" "['job_id']")
ok "$(field "$r" "['counts']['problem']")/$(field "$r" "['counts']['new_bridges']")" "0/2" "the clean file: no problems, two new unit bridges"
r=$(as "select public.stock_import_commit('$JOB')"); run_queue
ok "$(q "select status from stock_co_import_jobs where id = '$JOB'")" "done" "the real queue commits it"
ok "$(q "select count(*) from stock_co_import_rows where job_id = '$JOB' and problem is not null")" "0" "no row was refused at commit"
ok "$(q "select b.from_qty::text || ' ' || b.from_unit || ' = ' || b.to_qty::text || ' ' || b.to_unit from stock_co_bridges b join stock_co_items i on i.id = b.item_id where i.org_id = '$ORG' and i.name = 'UL Olives'")" "30 oz = 40 floz" "the company bridge of the new item"
ok "$(q "select count(*) from stock_co_bridge_sites bs join stock_co_bridges b on b.id = bs.bridge_id join stock_co_items i on i.id = b.item_id join inventory_item_conversions t on t.id = bs.site_bridge_id where i.name = 'UL Olives' and t.from_qty = 30 and t.to_qty = 40 and t.archived_at is null")" "2" "its row at both sites the item was ticked at (inventory_item_conversions)"
ok "$(q "select count(*) from stock_co_bridge_sites bs join stock_co_bridges b on b.id = bs.bridge_id join stock_co_items i on i.id = b.item_id where i.org_id = '$ORG' and i.name = 'Lemons' and b.from_unit = 'each' and b.to_unit = 'g'")" "2" "the bridge of an item already on at two sites reaches both"
# 1 litre for 7.04; 40 UK fl oz = 30 oz, so 1 oz = 40/30 fl oz = 37.88408333 ml and costs 7.04 * 37.88408333 / 1000
ok "$(q "select string_agg(distinct round(i.current_cost, 4)::text, ',') from inventory_items i join stock_co_item_sites s on s.site_item_id = i.id join stock_co_items c on c.id = s.item_id where c.name = 'UL Olives'")" "0.2667" "bought by the litre, kept by the ounce: the cost per oz comes through the bridge"
ok "$(q "select string_agg(coalesce(i.current_cost::text, 'null'), ',' order by i.location_id) from inventory_items i join stock_co_item_sites s on s.site_item_id = i.id join stock_co_items c on c.id = s.item_id where c.org_id = '$ORG' and c.name = 'Lemons'")" "$LEMON_COST_BEFORE" "an item whose packs need no bridge keeps its cost"
ok "$(q "select count(*) from stock_change_log where entity = 'bridge' and field = 'created' and source = 'import'")" "2" "both are in the change log as import"
ok "$(q "select count(*) from stock_movements m join stock_co_item_sites s on s.site_item_id = m.inventory_item_id join stock_co_items c on c.id = s.item_id where c.name = 'UL Olives'")" "0" "nothing was posted to the ledger"

echo "== 4. again, changed, and the other way round"
N0=$(q "select count(*) || '/' || coalesce(sum(row_version), 0) from stock_co_bridges where org_id = '$ORG'")
r=$(stage "$GOOD" good.csv); JOB=$(field "$r" "['job_id']")
ok "$(q "select string_agg(action, ',' order by row_no) from stock_co_import_rows where job_id = '$JOB' and kind = 'bridge'")" "same,same" "the same file again: both unit bridges read Same"
as "select public.stock_import_commit('$JOB')" >/dev/null; run_queue
ok "$(q "select count(*) || '/' || coalesce(sum(row_version), 0) from stock_co_bridges where org_id = '$ORG'")" "$N0" "committing it makes no row and changes none"
r=$(stage '[{"row_no":6000002,"kind":"bridge","data":{"item":"UL Olives","from_qty":40,"from_unit":"floz","to_qty":30,"to_unit":"oz"}}]' flipped.csv)
ok "$(field "$r" "['counts']['same']")" "1" "the same bridge written the other way round reads Same"
as "select public.stock_import_cancel('$(field "$r" "['job_id']")')" >/dev/null
r=$(stage '[{"row_no":6000002,"kind":"bridge","data":{"item":"UL Olives","from_qty":30,"from_unit":"oz","to_qty":45,"to_unit":"floz"}}]' changed.csv); JOB=$(field "$r" "['job_id']")
ok "$(field "$r" "['counts']['changed_bridges']")" "1" "a different amount reads Change"
as "select public.stock_import_commit('$JOB')" >/dev/null; run_queue
ok "$(q "select count(*) || ' rows, ' || string_agg(distinct t.to_qty::float8::text, ',') from stock_co_bridges b join stock_co_items i on i.id = b.item_id join stock_co_bridge_sites bs on bs.bridge_id = b.id join inventory_item_conversions t on t.id = bs.site_bridge_id where i.name = 'UL Olives' and b.to_qty = 45")" "2 rows, 45" "the change reaches the company row and both site rows (still one bridge, not two)"
ok "$(q "select string_agg(distinct round(i.current_cost, 4)::text, ',') from inventory_items i join stock_co_item_sites s on s.site_item_id = i.id join stock_co_items c on c.id = s.item_id where c.name = 'UL Olives'")" "0.3000" "and the cost follows it (45 fl oz to 30 oz)"

echo "== 5. the rollback"
out=$($P -d ul_t -f $RB 2>&1); ok "$?" "0" "the rollback runs"
ok "$(md5s)" "$BEFORE" "the three functions are the bodies from before, by md5"
ok "$(q "select count(*) from stock_co_bridges b join stock_co_items i on i.id = b.item_id where i.name = 'UL Olives'")" "1" "unit bridges the import made stay"
r=$(stage '[{"row_no":6000002,"kind":"bridge","data":{"item":"UL Olives","from_qty":30,"from_unit":"oz","to_qty":45,"to_unit":"floz"}}]' after.csv)
ok "$(echo "$r" | grep -c 'must be one of: item, supplier, supplier_item, par, recipe\.')" "1" "after the rollback a bridge row is refused at the door"
out=$($P -d ul_t -f $RB 2>&1); ok "$?" "0" "a second rollback is harmless"
$P -d postgres -c "drop database if exists ul_t2 with (force)" -c "create database ul_t2 template n_d3_after" >/dev/null
$P -d ul_t2 -f $MIG >/dev/null 2>&1; $P -d ul_t2 -f $RB >/dev/null 2>&1
ok "$($P -d ul_t2 -c "select pg_get_constraintdef(oid) from pg_constraint where conname = 'stock_co_import_rows_kind_check'")" "$($P -d n_d3_after -c "select pg_get_constraintdef(oid) from pg_constraint where conname = 'stock_co_import_rows_kind_check'")" "with no bridge row staged, the kind check goes back too"
out=$($P -d ul_t -f $MIG 2>&1); ok "$?" "0" "and the file can be run again after its rollback"

echo
echo "$([ $fails -eq 0 ] && echo PASS || echo FAIL): $((checks-fails))/$checks checks"
exit $([ $fails -eq 0 ] && echo 0 || echo 1)
