import { PLANS, planForGtv, chargeForPeriod, money } from '../src/lib/billingPlans.js';

// Boundary-first: the pounds either side of every threshold are where billing goes wrong.
const cases = [
  [0,          'free',   0],
  [1,          'free',   0],
  [799999,     'free',   0],   // £7,999.99
  [800000,     'free',   0],   // £8,000.00 exactly -> still Free
  [800001,     'growth', 14900], // £8,000.01 -> Growth
  [1000000,    'growth', 14900],
  [1499999,    'growth', 14900],
  [1500000,    'growth', 14900], // £15,000.00 exactly -> still Growth
  [1500001,    'scale',  29900], // £15,000.01 -> Scale
  [99999999,   'scale',  29900],
];

let pass = 0, fail = 0;
for (const [gtv, wantPlan, wantAmount] of cases) {
  const c = chargeForPeriod(gtv);
  const ok = c.planCode === wantPlan && c.amountMinor === wantAmount;
  console.log(`${ok ? 'PASS' : 'FAIL'}  GTV ${money(gtv).padStart(12)} -> ${c.planName.padEnd(7)} ${money(c.totalMinor).padStart(8)}  (${c.deviceAllowance} devices)`);
  ok ? pass++ : fail++;
}

// No gaps and no overlaps in the ladder — a GTV that matches nothing, or two plans, is a silent mis-bill.
for (let i = 1; i < PLANS.length; i++) {
  const prev = PLANS[i-1], cur = PLANS[i];
  const contiguous = prev.toMinor !== null && cur.fromMinor === prev.toMinor + 1;
  console.log(`${contiguous ? 'PASS' : 'FAIL'}  ladder contiguous: ${prev.code} -> ${cur.code}`);
  contiguous ? pass++ : fail++;
}

const vat = chargeForPeriod(900000, { vatRatePct: 20 });
console.log(`\nVAT example @20%: net ${money(vat.amountMinor)} + VAT ${money(vat.vatMinor)} = ${money(vat.totalMinor)}`);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
