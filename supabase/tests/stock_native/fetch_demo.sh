#!/bin/zsh
# fetch_demo.sh: a READ ONLY copy of the stock rows of one or more companies from Ops, for rehearse.mjs.
#
#   zsh supabase/tests/stock_native/fetch_demo.sh <out.json> <org id> [<org id> ...]
#
# Uses the Supabase Management API query endpoint with "read_only": true (the token comes from
# ~/.zshrc, never from this file). Writes one JSON file OUTSIDE the repo (keep it in a scratch folder):
# it holds those companies' stock rows, which must never be committed. Names of people are left out
# (count and transfer sign offs, delivery checks, supplier contacts, notes): no stock number needs them.
set -e
source ~/.zshrc >/dev/null 2>&1
OUT="$1"; shift
[ -z "$OUT" ] || [ "$#" -lt 1 ] && { echo "usage: fetch_demo.sh <out.json> <org id> [...]"; exit 2; }
OUT="${OUT:A}"
TOP="$(git -C "${0:A:h}" rev-parse --show-toplevel 2>/dev/null || true)"
if [ -n "$TOP" ]; then
  case "$OUT" in "$TOP"/*) echo "write the copy outside the repo"; exit 2;; esac
fi
for o in "$@"; do
  [[ "$o" =~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' ]] || { echo "not an org id: $o"; exit 2; }
done
ORGS=$(printf "'%s'," "$@"); ORGS="${ORGS%,}"
LOCS="(select id from public.locations where org_id in ($ORGS))"
LOCT="(select id::text from public.locations where org_id in ($ORGS))"
TMP=$(mktemp -d)
q() {
  python3 -c 'import json,sys; print(json.dumps({"query": sys.argv[1], "read_only": True}))' "$2" > "$TMP/body.json"
  curl -s -X POST "https://api.supabase.com/v1/projects/tbetcegmszzotrwdtqhi/database/query" \
    -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -H "Content-Type: application/json" -d @"$TMP/body.json" > "$TMP/$1.json"
}
# rows as jsonb, with the named keys taken out
rows() { q "$1" "select to_jsonb(t) - '{$3}'::text[] as r from public.$1 t where $2"; }
q organisations "select jsonb_build_object('id', id, 'name', name) as r from public.organisations where id in ($ORGS)"
q locations "select jsonb_build_object('id', id, 'org_id', org_id, 'name', name, 'timezone', timezone, 'currency', currency, 'status', status, 'created_at', created_at) as r from public.locations where org_id in ($ORGS)"
for t in tax_rates storage_areas inventory_items item_packaging_formats inventory_item_conversions supplier_products inventory_item_areas \
         inventory_item_area_stock par_levels stock_movements recipes recipe_lines menu_item_recipes item_cost_history po_lines \
         supplier_invoice_lines stock_count_lines stock_count_areas stock_transfer_lines stock_site_settings stock_depletion_mode; do
  rows "$t" "t.location_id in $LOCS" ""
done
rows suppliers "t.location_id in $LOCS" "contact_name,email,phone,account_number,notes"
rows purchase_orders "t.location_id in $LOCS" "notes"
rows supplier_invoices "t.location_id in $LOCS" "raw_json,image_path"
rows waste_events "t.location_id in $LOCS" "note"
rows stock_counts "t.location_id in $LOCS" "started_by_name,approved_by_name,approval_note"
rows stock_transfers "t.location_id in $LOCS" "created_by_name,sent_by_name,received_by_name,cancelled_by_name,note"
rows production_batches "t.location_id in $LOCS" "notes"
rows prep_schedule "t.location_id in $LOCS" ""
rows deliveries "t.location_id in $LOCS" "checked_by_name,rejection_reason"
# After 0a ran live (20 Oct 2026) the site rows carry company_ref, so the copy also needs the company
# records 0a made and the venue clock: rehearse.mjs then loads the copy onto a base with 0a in, as live.
q has0a "select (to_regclass('public.stock_co_items') is not null) as r"
if grep -q 'true' "$TMP/has0a.json"; then
  for t in stock_co_settings stock_co_site_groups stock_co_items stock_co_packs stock_co_bridges stock_co_supplier_items stock_co_recipes; do
    rows "$t" "t.org_id in ($ORGS)" "notes"
  done
  for t in stock_co_item_sites stock_co_pack_sites stock_co_bridge_sites stock_co_supplier_sites stock_co_supplier_item_sites stock_co_recipe_sites \
           stock_co_site_settings venue_clock stock_periods stock_period_snapshots; do
    rows "$t" "t.location_id in $LOCS" ""
  done
  rows stock_co_suppliers "t.org_id in ($ORGS)" "contact_name,phone,email,notes"
  rows stock_co_recipe_lines "t.org_id in ($ORGS)" "note"
fi
rm -f "$TMP/has0a.json"
q menu_items "select jsonb_build_object('id', id, 'location_id', location_id, 'name', name, 'type', type, 'parent_id', parent_id, 'master_id', master_id, 'archived', archived, 'org_id', org_id, 'scope', scope) as r from public.menu_items where location_id in $LOCT"
q msm_company "select to_jsonb(t) as r from public.msm_company t where org_id in ($ORGS)"
q msm_menus "select jsonb_build_object('id', id, 'org_id', org_id, 'name', name, 'status', status) as r from public.msm_menus where org_id in ($ORGS)"
q msm_products "select jsonb_build_object('id', p.id, 'menu_id', p.menu_id, 'name', p.name, 'archived', p.archived, 'default_price', p.default_price) as r from public.msm_products p join public.msm_menus m on m.id = p.menu_id where m.org_id in ($ORGS)"
q msm_product_sites "select jsonb_build_object('product_id', s.product_id, 'location_id', s.location_id, 'venue_item_id', s.venue_item_id, 'active', s.active) as r from public.msm_product_sites s where s.location_id in $LOCT"
python3 - "$TMP" "$OUT" <<'PY'
import json, os, sys
tmp, out = sys.argv[1], sys.argv[2]
data = {}
for f in sorted(os.listdir(tmp)):
    if f.endswith('.json') and f != 'body.json':
        rows = json.load(open(os.path.join(tmp, f)))
        if not isinstance(rows, list):
            raise SystemExit(f"{f}: {rows}")
        data[f[:-5]] = [r['r'] for r in rows]
json.dump(data, open(out, 'w'))
print({k: len(v) for k, v in data.items()})
PY
rm -rf "$TMP"
