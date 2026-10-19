#!/bin/zsh
# fetch_demo.sh: a READ ONLY copy of one or more companies' stock rows from Ops, for rehearse.mjs.
#
#   zsh supabase/tests/stock_company/fetch_demo.sh <out.json> <org id> [<org id> ...]
#
# Uses the Supabase Management API query endpoint with "read_only": true (the token comes from
# ~/.zshrc, never from this file). Writes one JSON file OUTSIDE the repo (keep it in a scratch folder):
# it holds that company's stock rows, which must never be committed.
set -e
source ~/.zshrc >/dev/null 2>&1
OUT="$1"; shift
[ -z "$OUT" ] || [ "$#" -lt 1 ] && { echo "usage: fetch_demo.sh <out.json> <org id> [...]"; exit 2; }
case "$OUT" in "$(git rev-parse --show-toplevel 2>/dev/null)"*) echo "write the copy outside the repo"; exit 2;; esac
ORGS=$(printf "'%s'," "$@"); ORGS="${ORGS%,}"
LOCS="(select id from public.locations where org_id in ($ORGS))"
TMP=$(mktemp -d)
q() {
  python3 -c 'import json,sys; print(json.dumps({"query": sys.argv[1], "read_only": True}))' "$2" > "$TMP/body.json"
  curl -s -X POST "https://api.supabase.com/v1/projects/tbetcegmszzotrwdtqhi/database/query" \
    -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -H "Content-Type: application/json" -d @"$TMP/body.json" > "$TMP/$1.json"
}
q organisations "select id, name from public.organisations where id in ($ORGS)"
q locations "select id, org_id, name, timezone, created_at from public.locations where org_id in ($ORGS)"
for t in inventory_items item_packaging_formats inventory_item_conversions suppliers supplier_products storage_areas \
         inventory_item_areas inventory_item_area_stock par_levels tax_rates; do
  q "$t" "select * from public.$t where location_id in $LOCS"
done
q stock_movements "select * from public.stock_movements where location_id in $LOCS"
python3 - "$TMP" "$OUT" <<'PY'
import json, os, sys
tmp, out = sys.argv[1], sys.argv[2]
data = {}
for f in sorted(os.listdir(tmp)):
    if f.endswith('.json') and f != 'body.json':
        rows = json.load(open(os.path.join(tmp, f)))
        if not isinstance(rows, list):
            raise SystemExit(f"{f}: {rows}")
        data[f[:-5]] = rows
json.dump(data, open(out, 'w'))
print({k: len(v) for k, v in data.items()})
PY
rm -rf "$TMP"
