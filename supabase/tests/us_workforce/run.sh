#!/bin/zsh
# us_workforce/run.sh: the US workforce functions run for real in node on made up rows (5.12.47, 5.12.49).
#   zsh supabase/tests/us_workforce/run.sh
# Bundles workforce-clock and workforce-compute with rolldown, points supabase-js at mockdb.mjs, then:
#   clock:   US asks and keeps cash tips; setting off, UK venue, older app keep nothing; a bad amount is
#            refused in words and the person stays clocked in; before 20261117a the clock out still works.
#   payroll: a Provo server on $2.13, 30 h with $60 card + $50 declared cash = $43.60 top up; declared
#            cash is reported and never added to the total; a UK venue reads exactly as before.
#   pto:     1 h per 30 h for hourly staff when switched on, never twice, never salaried, the yearly cap,
#            off writes nothing, a UK venue still accrues 12.07%.
set -e
HERE="${0:A:h}"; TOP="${HERE:h:h:h}"; B="$(mktemp -d)"; trap 'rm -rf "$B"' EXIT
cp "$HERE/mockdb.mjs" "$B/"
( cd "$TOP" && node --input-type=module -e "
import { build } from 'rolldown';
await build({ input: 'supabase/functions/workforce-clock/index.ts', external: [/^https:\/\//], output: { file: '$B/wcl.mjs', format: 'esm' }, logLevel: 'silent' });
await build({ input: 'supabase/functions/workforce-compute/index.ts', external: [/^https:\/\//], output: { file: '$B/wfc.mjs', format: 'esm' }, logLevel: 'silent' });" )
sed -i '' 's#"https://esm.sh/@supabase/supabase-js@2"#"./mockdb.mjs"#' "$B/wcl.mjs" "$B/wfc.mjs"
export BUNDLE_DIR="$B"
want() { [ "$2" = "$3" ] || { echo "FAIL $1"; echo "  got  $2"; echo "  want $3"; exit 1; }; }
c() { node "$HERE/clock.mjs" "$1" 2>/dev/null | tail -1; }
want clock-us    "$(c us)"    '{"sc":"us","askCashTips":true,"outStatus":200,"outError":null,"field":null,"clockedOut":true,"declared":24.5,"replyCashTips":24.5}'
want clock-off   "$(c off)"   '{"sc":"off","askCashTips":false,"outStatus":200,"outError":null,"field":null,"clockedOut":true,"declared":null,"replyCashTips":null}'
want clock-uk    "$(c uk)"    '{"sc":"uk","askCashTips":false,"outStatus":200,"outError":null,"field":null,"clockedOut":true,"declared":null,"replyCashTips":null}'
want clock-bad   "$(c bad)"   '{"sc":"bad","askCashTips":true,"outStatus":400,"outError":"Type the cash tips as dollars and cents, for example 24.50.","field":"cash_tips","clockedOut":false,"declared":null,"replyCashTips":null}'
want clock-oldDb "$(c oldDb)" '{"sc":"oldDb","askCashTips":true,"outStatus":200,"outError":null,"field":null,"clockedOut":true,"declared":null,"replyCashTips":null}'
want clock-older "$(c older)" '{"sc":"older","askCashTips":true,"outStatus":200,"outError":null,"field":null,"clockedOut":true,"declared":null,"replyCashTips":null}'
want payroll-us  "$(node "$HERE/payroll.mjs" us 2>/dev/null | tail -1)" '{"topUp":43.6,"cash":50,"total":410.1,"totals":675.1}'
want payroll-uk  "$(node "$HERE/payroll.mjs" uk 2>/dev/null | tail -1)" '{"topUp":null,"cash":null,"total":366.5,"totals":631.5}'
p() { node "$HERE/pto.mjs" "$1" 2>/dev/null | tail -1; }
want pto-us  "$(p us)"  '{"sc":"us","first":{"accrued":2,"hours":2,"off":null},"again":0,"rows":"s1:1,s1:1"}'
want pto-cap "$(p cap)" '{"sc":"cap","first":{"accrued":2,"hours":1.5,"off":null},"again":0,"rows":"s1:0.5,s1:1"}'
want pto-off "$(p off)" '{"sc":"off","first":{"accrued":0,"hours":0,"off":"Paid time off is switched off (Workforce settings, Paid time off)."},"again":0,"rows":""}'
want pto-uk  "$(p uk)"  '{"sc":"uk","first":{"accrued":2,"hours":7.24,"off":null},"again":0,"rows":"s1:3.62,s1:3.62"}'
echo "us_workforce: 12 checks pass"
