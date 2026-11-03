#!/bin/zsh
# us_workforce/run.sh: the workforce functions run for real in node on made up rows (5.12.47 to 5.12.54).
#   clockin: staff app clock in follows the shift across linked sites (UK and US): lands at the shift's
#            site, asks which site with no shift, uses a picked site, refuses while open elsewhere and
#            clocks out there, leaves out a refusing site, a one site person is never asked.
#   leave:   holiday and PTO at the primary location (UK and US): a request filed at Daybreak is moved
#            to the Provo primary, charged there, and the balance adds up every linked site.
#   headoffice: head office staff (5.12.56, UK and US): a $60,000 salary pays $5,000 a month with no
#            timesheets (UK GBP 5,000), 15 of 30 days for a mid month start, nothing with the switch off or
#            before 20261119a; the till and the staff app refuse clock in in words; a cover shift at a
#            normal linked record lands there; an open shift claim is refused.
#   zsh supabase/tests/us_workforce/run.sh
# Bundles workforce-clock and workforce-compute with rolldown, points supabase-js at mockdb.mjs, then:
#   clock:   US asks and keeps cash tips; setting off, UK venue, older app keep nothing; a bad amount is
#            refused in words and the person stays clocked in; before 20261117a the clock out still works.
#   payroll: a Provo server on $2.13, 30 h with $60 card + $50 declared cash = $43.60 top up; declared
#            cash is reported and never added to the total; a UK venue reads exactly as before.
#   pto:     1 h per 30 h for hourly staff when switched on, never twice, never salaried, the yearly cap,
#            off writes nothing, a UK venue still accrues 12.07%.
#   breaks:  the clock out auto deduct floor is the state's meal rule (California 30), none for Utah
#            (the venue default 10), and the UK Working Time Regulations (20) for a UK venue.
#   california: a $15 cook, 13 h with no break and 8 h with no break: 4 h overtime + 1 h double time
#            ($45 premium) and two meal premiums ($30), total $415 with $25 tips.
set -e
HERE="${0:A:h}"; TOP="${HERE:h:h:h}"; B="$(mktemp -d)"; trap 'rm -rf "$B"' EXIT
cp "$HERE/mockdb.mjs" "$B/"
( cd "$TOP" && node --input-type=module -e "
import { build } from 'rolldown';
await build({ input: 'supabase/functions/workforce-clock/index.ts', external: [/^https:\/\//], output: { file: '$B/wcl.mjs', format: 'esm' }, logLevel: 'silent' });
await build({ input: 'supabase/functions/workforce-compute/index.ts', external: [/^https:\/\//], output: { file: '$B/wfc.mjs', format: 'esm' }, logLevel: 'silent' });
await build({ input: 'supabase/functions/staff-portal/index.ts', external: [/^https:\/\//], output: { file: '$B/sp.mjs', format: 'esm' }, logLevel: 'silent' });" )
sed -i '' 's#"https://esm.sh/@supabase/supabase-js@2"#"./mockdb.mjs"#' "$B/wcl.mjs" "$B/wfc.mjs" "$B/sp.mjs"
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
want break-ca "$(c caAuto)" '{"sc":"caAuto","breakMins":30,"autoBreak":30}'
want break-ut "$(c utAuto)" '{"sc":"utAuto","breakMins":10,"autoBreak":10}'
want break-uk "$(c ukAuto)" '{"sc":"ukAuto","breakMins":20,"autoBreak":20}'
want payroll-ca "$(node "$HERE/payroll.mjs" ca 2>/dev/null | tail -1)" '{"ot":4,"dt":1,"otPremium":45,"meal":30,"mealDays":2,"total":415}'
k() { node "$HERE/clockin.mjs" "$1" 2>/dev/null | tail -1; }
want clockin-shift  "$(k shift)"  '{"sc":"shift","statusSite":"Daybreak","ask":null,"elsewhere":null,"landed":"Daybreak","out":null,"sheets":"rd:open"}'
want clockin-ask    "$(k ask)"    '{"sc":"ask","statusSite":null,"ask":["Provo","Daybreak"],"elsewhere":null,"landed":null,"out":null,"sheets":""}'
want clockin-pick   "$(k pick)"   '{"sc":"pick","statusSite":null,"ask":["Provo","Daybreak"],"elsewhere":null,"landed":"Daybreak","out":null,"sheets":"rd:open"}'
want clockin-open   "$(k open)"   '{"sc":"open","statusSite":null,"ask":null,"elsewhere":"Provo","landed":null,"out":true,"sheets":"rp:closed"}'
want clockin-refuse "$(k refuse)" '{"sc":"refuse","statusSite":null,"ask":["Provo"],"elsewhere":null,"landed":null,"out":null,"sheets":""}'
want clockin-single "$(k single)" '{"sc":"single","statusSite":"Provo","ask":null,"elsewhere":null,"landed":"Provo","out":null,"sheets":"rp:open"}'
l() { node "$HERE/leave.mjs" "$1" 2>/dev/null | tail -1; }
want leave-primary "$(l primary)" '{"sc":"primary","ok":true,"error":null,"request":"rp@LP","taken":"rp@LP:-2","balance":0.5}'
want leave-single  "$(l single)"  '{"sc":"single","ok":true,"error":null,"request":"rp@LP","taken":"rp@LP:-2","balance":-0.5}'
h() { node "$HERE/headoffice.mjs" "$1" 2>/dev/null | tail -1; }
want ho-pay-us   "$(h payUs)"   '{"sc":"payUs","salary":5000,"basis":"period","hoTotal":5000,"server":300,"total":5300,"currency":"USD"}'
want ho-pay-part "$(h payPart)" '{"sc":"payPart","salary":2500,"basis":"part","hoTotal":2500,"server":300,"total":2800,"currency":"USD"}'
want ho-pay-off  "$(h payOff)"  '{"sc":"payOff","salary":null,"basis":null,"hoTotal":null,"server":300,"total":300,"currency":"USD"}'
want ho-pay-uk   "$(h payUk)"   '{"sc":"payUk","salary":5000,"basis":"period","hoTotal":5000,"server":300,"total":5300,"currency":"GBP"}'
want ho-pay-old  "$(h payOld)"  '{"sc":"payOld","salary":null,"basis":null,"hoTotal":null,"server":300,"total":300,"currency":"USD"}'
want ho-till     "$(h tillHo)"  '{"sc":"tillHo","headOffice":true,"posLoginClockIn":false,"inStatus":409,"inError":"Head office staff do not clock in. Your salary is paid each pay period.","sheets":0}'
want ho-till-off "$(h tillOff)" '{"sc":"tillOff","headOffice":false,"posLoginClockIn":true,"inStatus":200,"inError":null,"sheets":1}'
want ho-app      "$(h appHo)"   '{"sc":"appHo","headOffice":true,"statusSite":null,"refused":true,"reason":"Head office staff do not clock in. Your salary is paid each pay period.","landed":null,"sheets":""}'
want ho-cover    "$(h appCover)" '{"sc":"appCover","headOffice":false,"statusSite":"Daybreak","refused":false,"reason":null,"landed":"Daybreak","sheets":"rd:open"}'
want ho-claim    "$(h appClaim)" '{"sc":"appClaim","error":"Head office staff do not take shifts. Your salary is paid each pay period.","code":"head_office"}'
echo "us_workforce: 34 checks pass"
