#!/bin/zsh
# fetch_checks.sh: a READ ONLY copy of one company's recent closed checks from Ops, for the drainer step
# of rehearse.mjs (the in migration proof on real baskets, the sales rule parity on real rows, a replay
# of real baskets before and after the release).
#
#   zsh supabase/tests/stock_native/fetch_checks.sh <out.json> <org id> [days, default 7]
#
# Uses the Supabase Management API query endpoint with "read_only": true (the token comes from
# ~/.zshrc, never from this file). Writes one JSON file OUTSIDE the repo (keep it in a scratch folder):
# it holds that company's takings and must never be committed. Use it on the test company only.
#
# Kept: only what the stock rule (items, order_type, refunds, voided, status, source) and the sales rule
# (money columns, tenders, discounts, gift card, loyalty and promo credit, booking legs) read. Left out:
# every column that names or points at a person (staff, server, customer, phone, table, kiosk, drawer,
# shift), the column named after the old card processor, approver stamps on discounts, reasons and names
# on refunds, notes on lines, loyalty member codes, gift card codes, payment ids.
set -e
source ~/.zshrc >/dev/null 2>&1
OUT="$1"; ORG="$2"; DAYS="${3:-7}"
[ -z "$OUT" ] || [ -z "$ORG" ] && { echo "usage: fetch_checks.sh <out.json> <org id> [days]"; exit 2; }
OUT="${OUT:A}"
TOP="$(git -C "${0:A:h}" rev-parse --show-toplevel 2>/dev/null || true)"
if [ -n "$TOP" ]; then
  case "$OUT" in "$TOP"/*) echo "write the copy outside the repo"; exit 2;; esac
fi
[[ "$ORG" =~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' ]] || { echo "not an org id: $ORG"; exit 2; }
[[ "$DAYS" =~ '^[0-9]{1,2}$' ]] || { echo "days: a whole number under 100"; exit 2; }
TMP=$(mktemp -d)
read -r -d '' QUERY <<SQL || true
with c as (
  select c.* from public.closed_checks c
   where c.location_id in (select l.id::text from public.locations l where l.org_id = '$ORG')
     and c.closed_at >= now() - interval '$DAYS days'
   order by c.closed_at desc, c.id
   limit 5000
)
select jsonb_build_object(
  'id', c.id, 'location_id', c.location_id, 'ref', c.ref, 'closed_at', c.closed_at, 'order_type', c.order_type, 'source', c.source,
  'status', c.status, 'voided', c.voided, 'refunded', c.refunded, 'subtotal', c.subtotal, 'tax', c.tax, 'total', c.total,
  'tax_amount', c.tax_amount, 'tax_breakdown', c.tax_breakdown, 'service', c.service, 'tip', c.tip, 'method', c.method,
  'payment_method', c.payment_method, 'processor', c.processor,
  'items', case when jsonb_typeof(c.items) = 'array' then (
      select coalesce(jsonb_agg(case when jsonb_typeof(e.v) = 'object'
                                     then (e.v - '{note,notes,guest,guestName,seat,customer,customerName,staff,staffName,server}'::text[])
                                          || case when jsonb_typeof(e.v -> 'discount') = 'object'
                                                  then jsonb_build_object('discount', (e.v -> 'discount') - '{manager,approvedBy,by,staffName}'::text[])
                                                  else '{}'::jsonb end
                                     else e.v end order by e.n), '[]'::jsonb)
        from jsonb_array_elements(c.items) with ordinality as e(v, n)) else c.items end,
  'discounts', case when jsonb_typeof(c.discounts) = 'array' then (
      select coalesce(jsonb_agg(case when jsonb_typeof(e.v) = 'object' then e.v - '{manager,approvedBy,by,staffName,reason,note}'::text[] else e.v end order by e.n), '[]'::jsonb)
        from jsonb_array_elements(c.discounts) with ordinality as e(v, n)) else c.discounts end,
  'refunds', case when jsonb_typeof(c.refunds) = 'array' then (
      select coalesce(jsonb_agg(case when jsonb_typeof(e.v) = 'object' then e.v - '{reason,note,notes,staff,staffName,by,manager,approvedBy,customer}'::text[] else e.v end order by e.n), '[]'::jsonb)
        from jsonb_array_elements(c.refunds) with ordinality as e(v, n)) else c.refunds end,
  'tenders', case when jsonb_typeof(c.tenders) = 'array' then (
      select coalesce(jsonb_agg(case when jsonb_typeof(e.v) = 'object'
                                     then jsonb_build_object('method', e.v -> 'method', 'amount', e.v -> 'amount', 'tip', e.v -> 'tip', 'processor', e.v -> 'processor')
                                     else e.v end order by e.n), '[]'::jsonb)
        from jsonb_array_elements(c.tenders) with ordinality as e(v, n)) else c.tenders end,
  'gift_card', case when jsonb_typeof(c.gift_card) = 'object' then jsonb_build_object('applied', c.gift_card -> 'applied',
      'legs', case when jsonb_typeof(c.gift_card -> 'legs') = 'array' then (
          select coalesce(jsonb_agg(case when jsonb_typeof(e.v) = 'object' then jsonb_build_object('applied', e.v -> 'applied', 'commit_error', e.v -> 'commit_error') else e.v end order by e.n), '[]'::jsonb)
            from jsonb_array_elements(c.gift_card -> 'legs') with ordinality as e(v, n)) end) else c.gift_card end,
  'loyalty', case when jsonb_typeof(c.loyalty) = 'object' then jsonb_build_object('discount_value', c.loyalty -> 'discount_value') else c.loyalty end,
  'promo', case when jsonb_typeof(c.promo) = 'object' then jsonb_build_object('discount_value', c.promo -> 'discount_value') else c.promo end,
  'payment_intents', case when jsonb_typeof(c.payment_intents) = 'array' then (
      select coalesce(jsonb_agg(case when jsonb_typeof(e.v) = 'object'
                                     then jsonb_build_object('id', case when e.v -> 'id' is null or e.v -> 'id' = 'null'::jsonb then null else to_jsonb('x'::text) end,
                                                             'amountMinor', e.v -> 'amountMinor', 'method', e.v -> 'method')
                                     else e.v end order by e.n), '[]'::jsonb)
        from jsonb_array_elements(c.payment_intents) with ordinality as e(v, n)) else c.payment_intents end
) as r from c
SQL
python3 -c 'import json,sys; print(json.dumps({"query": sys.argv[1], "read_only": True}))' "$QUERY" > "$TMP/body.json"
curl -s -X POST "https://api.supabase.com/v1/projects/tbetcegmszzotrwdtqhi/database/query" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -H "Content-Type: application/json" -d @"$TMP/body.json" > "$TMP/out.json"
python3 - "$TMP/out.json" "$OUT" <<'PY'
import json, sys, collections
rows = json.load(open(sys.argv[1]))
if not isinstance(rows, list):
    raise SystemExit(f"the query failed: {rows}")
data = {'closed_checks': [r['r'] for r in rows]}
json.dump(data, open(sys.argv[2], 'w'))
print({'closed_checks': len(data['closed_checks']), 'per venue': dict(collections.Counter(r['location_id'] for r in data['closed_checks']))})
PY
rm -rf "$TMP"
