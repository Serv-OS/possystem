// payLawBatch4.test.js: US basics, batch 4, pay and employment law (5.12.57). Run: node --test.
//
//   1. the UK contract is never offered at a US venue, and a venue's own templates come first there
//   2. a US tip pool leaves managers, supervisors and exempt positions out and adds no service charge
//      (the real tronc.run is run by supabase/tests/us_workforce/run.sh: tronc-us, tronc-uk)
//   3. every Payroll report row adds up to Total
//   4. at a US venue with PTO switched off, approved time off is unpaid and deducts nothing (the real
//      timeoff.decide: run.sh leave-us-off, leave-us-on)
//   5. the holiday word helper
//   6. a guard: no UK law words in Workforce or the staff app without a UK gate (see the guard below)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_TEMPLATES, templatesForVenue, noTemplateWords } from '../staff/docTemplates.js';
import { tipPoolExclusion, tipPoolExclusionWords, suggestedTipPool } from '../../supabase/functions/_shared/usTipPool.js';
import { payrollParts, payrollWageColumns, wagesOf, holidayWord, holidayWordLower, tipPoolName, tipWeightName, leaverBalanceWords, ukHoliday } from '../staff/payLaw.js';
import { timeOffPay } from '../../supabase/functions/_shared/usPto.js';
import { regionPack } from '../../supabase/functions/_shared/regionPack.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const UK = regionPack('GBP'), US = regionPack('USD'), IE = regionPack('EUR');

// ── 1. templates ─────────────────────────────────────────────────────────────
test('the built in UK contract is marked UK, the offer letter is country neutral', () => {
  const contract = DEFAULT_TEMPLATES.find((t) => t.id === 'builtin-contract');
  const offer = DEFAULT_TEMPLATES.find((t) => t.id === 'builtin-offer');
  assert.equal(contract.country, 'UK');
  assert.match(contract.body, /5\.6 weeks/);
  assert.equal(offer.country, null);
  // The offer letter names no country's law: pay, employment type and start date only.
  assert.doesNotMatch(offer.body, /UK|statutory|holiday|notice|£|\$/i);
});

test('a US venue is never offered the UK contract, and its own templates come first', () => {
  const own = [{ id: 'c1', kind: 'contract', name: 'Mozz employment agreement' }, { id: 'o1', kind: 'offer', name: 'Mozz offer' }];
  const contracts = templatesForVenue(own, { kind: 'contract', country: 'US' });
  assert.deepEqual(contracts.map((t) => t.id), ['c1']);
  const offers = templatesForVenue(own, { kind: 'offer', country: 'US' });
  assert.deepEqual(offers.map((t) => t.id), ['o1', 'builtin-offer']);   // own first: the first own one is preselected
  // No contract of its own: nothing to pick, and onboarding says where to add one.
  assert.deepEqual(templatesForVenue([], { kind: 'contract', country: 'US' }), []);
  assert.match(noTemplateWords('contract'), /Add your contract in Workforce settings, Contracts and letters/);
  assert.ok(!templatesForVenue(own, { country: 'US' }).some((t) => t.id === 'builtin-contract'));
});

test('a UK venue is offered exactly what it was before: the built ins first, then its own', () => {
  const own = [{ id: 'c1', kind: 'contract', name: 'Our contract' }];
  assert.deepEqual(templatesForVenue(own, { kind: 'contract', country: 'UK' }).map((t) => t.id), ['builtin-contract', 'c1']);
  assert.deepEqual(templatesForVenue([], { country: 'UK' }).map((t) => t.id), ['builtin-offer', 'builtin-contract']);
});

test('onboarding preselects the first template it is given and shows the add words when there is none', () => {
  const src = read('src/backoffice/sections/workforce/WfOnboarding.jsx');
  assert.match(src, /setSelId\(list\[0\]\?\.id \|\| ''\)/);
  assert.match(src, /!tpls\.length \? <div[^>]*>\{noTemplateWords\(kind\)\}<\/div>/);
  assert.match(read('src/staff/wfData.js'), /return templatesForVenue\(saved, \{ kind: kind \|\| null, country: activeCountry\(\) \}\);/);
});

// ── 2. US tip pool ───────────────────────────────────────────────────────────
test('a US tip pool leaves managers and supervisors, salaried and ticked exempt positions out', () => {
  const settings = { overtimeExempt: { lead: true, gm2: false } };
  const out = (grp, roleKey, payType) => tipPoolExclusion({ country: 'US', grp, roleKey, payType, settings });
  assert.equal(out('mgmt', 'sup', 'hourly'), 'manager');
  assert.equal(out('floor', 'gm', 'salaried'), 'exempt');        // salaried start ticked
  assert.equal(out('bar', 'lead', 'hourly'), 'exempt');          // ticked in Workforce settings
  assert.equal(out('floor', 'gm2', 'salaried'), null);           // salaried but unticked: paid overtime, shares tips
  assert.equal(out('floor', 'server', 'hourly'), null);
  assert.equal(out('kitchen', 'cook', 'hourly'), null);
  assert.match(tipPoolExclusionWords('manager'), /cannot share the tip pool at a US venue \(FLSA\)\. Set the tip pool weight to 0\./);
});

test('a UK venue shares the pool with everyone, as before', () => {
  for (const country of ['UK', 'IE']) {
    assert.equal(tipPoolExclusion({ country, grp: 'mgmt', roleKey: 'dutymgr', payType: 'salaried', settings: { overtimeExempt: { dutymgr: true } } }), null);
  }
});

test('a US pool is card tips only: a service charge is wages and never added', () => {
  assert.equal(suggestedTipPool({ country: 'US', cardTips: 200, serviceCharge: 150, pooledShare: 1 }), 200);
  assert.equal(suggestedTipPool({ country: 'US', cardTips: 200, serviceCharge: 150, pooledShare: 0.5 }), 100);
  assert.equal(suggestedTipPool({ country: 'US', cardTips: 0, serviceCharge: 150, pooledShare: 1 }), 0);
  // UK: service charge plus the pooled card tips, rounded once, exactly as WfTronc did.
  assert.equal(suggestedTipPool({ country: 'UK', cardTips: 200, serviceCharge: 150, pooledShare: 1 }), 350);
  assert.equal(suggestedTipPool({ country: 'UK', cardTips: 10.005, serviceCharge: 0.004, pooledShare: 1 }), Math.round((0.004 + 10.005) * 100) / 100);
});

test('the server and the screens use the one tip pool rule', () => {
  const wfc = read('supabase/functions/workforce-compute/index.ts');
  assert.match(wfc, /import \{ tipPoolExclusion \} from '\.\.\/_shared\/usTipPool\.js';/);
  assert.match(wfc, /if \(pack\.country !== 'US'\) return true;/);
  assert.match(read('src/backoffice/sections/workforce/WfTronc.jsx'), /suggestedTipPool\(\{ country: us \? 'US' : 'UK'/);
  const pay = read('src/backoffice/sections/workforce/WfPay.jsx');
  assert.match(pay, /const weightRefused = !!outReason && \(num\(draft\.troncWeight\) \?\? 1\) > 0;/);
  assert.match(pay, /disabled=\{busy \|\| !valid \|\| weightRefused\}/);
  assert.match(read('supabase/tests/us_workforce/run.sh'), /want tronc-us /);
});

// ── 3. payroll rows add up ───────────────────────────────────────────────────
// Lines shaped as workforce-compute payroll.period writes them (every part Total adds).
const usLine = { staff_id: 'a', hours: 50, pay: 750, holiday_hours: 8, holiday_pay: 120, premium_pay: 15, tips_tronc: 40, tips_direct: 60, tips: 100,
  overtime_premium: 75, meal_premium: 30, tip_credit_topup: 12.5, total: 1102.5 };
const hoLine = { staff_id: 'b', hours: 0, pay: 0, holiday_hours: 0, holiday_pay: 0, tips_tronc: 0, tips_direct: 0, tips: 0, salary: 5000, head_office: true, total: 5000 };
const ukLine = { staff_id: 'c', hours: 30, pay: 366.3, holiday_hours: 7.5, holiday_pay: 91.58, tips_tronc: 25, tips_direct: 0, tips: 25, total: 482.88 };

test('every payroll row adds up to Total, with every wage part in its own column', () => {
  for (const l of [usLine, hoLine, ukLine]) {
    const p = payrollParts(l);
    const sum = p.base + p.overtime + p.topUp + p.meal + p.premium + p.holiday + p.other + p.tipsDirect + p.tipsPooled;
    assert.equal(Math.round(sum * 100) / 100, l.total, l.staff_id);
    assert.equal(p.other, 0, l.staff_id);
    assert.equal(Math.round((p.wages + p.tips) * 100) / 100, l.total);
  }
  assert.deepEqual(payrollWageColumns([usLine, hoLine], US).map((c) => c.label),
    ['Overtime premium', 'Tip credit top up', 'Meal break premium', 'Premium pay', 'PTO pay']);
  assert.deepEqual(payrollWageColumns([ukLine], UK).map((c) => c.label), ['Holiday pay']);
  // A part Total holds that no column names still shows, so a row can never fail to add up.
  assert.deepEqual(payrollWageColumns([{ pay: 10, total: 12 }], UK).map((c) => c.key), ['other']);
});

test('a closed run\'s wages are Total minus tips: overtime, top up, holiday and head office salary included', () => {
  const totals = { pay: 750, holiday_pay: 120, tips: 100, tips_tronc: 40, tips_direct: 60, premium_pay: 15, overtime_premium: 75, meal_premium: 30, tip_credit_topup: 12.5, head_office_salary: 5000, total: 6102.5 };
  assert.equal(wagesOf(totals), 6002.5);
  assert.equal(payrollParts(totals, { totals: true }).base, 5750);
  assert.equal(payrollParts(totals, { totals: true }).other, 0);
  // Older runs with no tips key read the two tip lines.
  assert.equal(wagesOf({ pay: 100, tips_direct: 5, tips_tronc: 5, total: 110 }), 100);
});

test('the Payroll report and payroll history show wages that add up, and follow the site', () => {
  const rep = read('src/backoffice/sections/reports/PayrollReport.jsx');
  assert.doesNotMatch(rep, /money\(h\.totals\?\.pay/);
  assert.match(rep, /money\(wagesOf\(h\.totals \|\| \{\}\)\)/);
  assert.match(rep, /\.\.\.cols\.map\(c => c\.label\)/);                       // the CSV header
  assert.match(rep, /\.\.\.cols\.map\(c => sumOf\(h, c\.key\)\.toFixed\(2\)\)/);  // the CSV total row
  assert.match(rep, /\}, \[siteId\]\);/);
  assert.doesNotMatch(rep, /`£\$\{/);
  assert.doesNotMatch(rep, /name="pound"/);
  assert.doesNotMatch(read('src/backoffice/sections/workforce/WfPayroll.jsx'), /money\(h\.totals\.pay\)/);
});

// ── 4. PTO off ───────────────────────────────────────────────────────────────
test('at a US venue with PTO switched off approved time off is unpaid and deducts nothing', () => {
  assert.deepEqual(timeOffPay({ holidayRules: 'us', type: 'holiday', settings: {}, paid: true }), { paid: false, ptoOff: true });
  assert.deepEqual(timeOffPay({ holidayRules: 'us', type: 'holiday', settings: { ptoEnabled: true }, paid: true }), { paid: true, ptoOff: false });
  // Sick and parental leave are the approver's choice (some states require paid sick leave).
  assert.deepEqual(timeOffPay({ holidayRules: 'us', type: 'sick', settings: {}, paid: true }), { paid: true, ptoOff: false });
  // UK: unchanged.
  assert.deepEqual(timeOffPay({ holidayRules: 'uk', type: 'holiday', settings: {}, paid: true }), { paid: true, ptoOff: false });
  const wfc = read('supabase/functions/workforce-compute/index.ts');
  assert.match(wfc, /const deducts = status === 'approved' && paidNow === true && req\.type === 'holiday' && hours > 0;/);
  assert.match(read('supabase/tests/us_workforce/run.sh'), /want leave-us-off /);
});

// ── 5. words ─────────────────────────────────────────────────────────────────
test('the holiday word: Holiday under UK rules, PTO in the US', () => {
  assert.equal(holidayWord(UK), 'Holiday');
  assert.equal(holidayWord(IE), 'Holiday');
  assert.equal(holidayWord(US), 'PTO');
  assert.equal(holidayWord(null), 'Holiday');                   // no region (an old snapshot) reads as before
  assert.equal(holidayWord({ holidayRules: 'us' }), 'PTO');     // the staff app's snapshot region
  assert.equal(holidayWordLower(UK), 'holiday');
  assert.equal(holidayWordLower(US), 'PTO');
  assert.equal(ukHoliday(US), false);
  assert.equal(tipPoolName(UK), 'Tronc / tips');
  assert.equal(tipPoolName(US), 'Tip pool');
  assert.equal(tipWeightName(US), 'Tip pool weight');
  assert.equal(tipWeightName(UK), 'Tronc weight');
});

test('the leaver dialog at a US venue states the balance and sends deductions to state law', () => {
  assert.equal(leaverBalanceWords({ bal: -3, pack: UK }), null);   // UK keeps its own words
  const over = leaverBalanceWords({ name: 'Sam', bal: -3, pack: US });
  assert.match(over, /Sam leaves with a PTO balance of -3\.0 hours/);
  assert.match(over, /depends on your state's law/);
  assert.match(over, /check with your payroll provider/);
  assert.doesNotMatch(over, /recover it/i);
  assert.match(leaverBalanceWords({ name: 'Sam', bal: 4, pack: US }), /4\.0 hours of PTO not taken/);
  assert.match(read('src/backoffice/sections/Workforce.jsx'), /recover it from their final pay if their contract allows/);   // UK unchanged
});

test('the Workforce menu says Tip pool at a US venue and Tronc / tips at a UK one', () => {
  const src = read('src/lib/boSections.js');
  assert.match(src, /\['wf-tronc','Tronc \/ tips'\]/);
  assert.match(src, /LABEL_WHEN_US = Object\.freeze\(\{ 'wf-tronc': 'Tip pool' \}\)/);
});

// ── 6. the UK law words guard ────────────────────────────────────────────────
// Every line in Workforce, the staff app and the Payroll report that holds a UK law word must sit in an
// explicit UK branch. How a branch is detected: the line itself, or one of the 16 lines above it, holds
// a gate, one of
//   country === / !== 'UK' or 'US'      (a ternary whose UK side is the other arm counts: it is explicit)
//   holidayRules === / !== 'uk'          law === 'uk' (the break rule)
//   ukHoliday(, or `uk ?` / `uk &&` / `us ?` / `us &&` on a flag set from the country or holiday rules
//   isUK                                 currency === 'GBP'
// Comments (// lines, the text after a // comment, and /* ... */ blocks, JSX ones too, over any number of
// lines) are not words a person reads: skipped. The 16 line window covers a JSX block opened by
// `{currency === 'GBP' && (<>` above the text it holds (the troncmaster box in Workforce settings).
const TERMS = /Working Time Reg|Tipping Act|HMRC|NMW|12\.07|Right to Work/;
const GATE = /country\s*[!=]==?\s*['"](UK|US)['"]|holidayRules\s*[!=]==?\s*['"]uk['"]|law\s*[!=]==?\s*['"]uk['"]|ukHoliday\(|\b(uk|us)\s*(\?|&&)|\bisUK\b|currency\s*===?\s*['"]GBP['"]/;
const WINDOW = 16;

function guardFiles() {
  const out = ['src/backoffice/sections/Workforce.jsx', 'src/surfaces/StaffSurface.jsx', 'src/surfaces/TimeClockSurface.jsx', 'src/backoffice/sections/reports/PayrollReport.jsx'];
  for (const dir of ['src/backoffice/sections/workforce', 'src/staff']) {
    for (const f of readdirSync(join(ROOT, dir))) if (/\.(jsx?|tsx?)$/.test(f) && !/\.test\./.test(f)) out.push(`${dir}/${f}`);
  }
  return out;
}
const codeOf = (line) => {
  const t = line.trim();
  if (/^(\/\/|\*|\/\*|\{\/\*)/.test(t)) return '';
  const i = line.search(/(^|[^:'"`])\/\/\s/);   // a trailing // comment (never the // of https://)
  return i >= 0 ? line.slice(0, i + 1) : line;
};
/** The file's lines as code: every line inside a /* ... *\/ block (a JSX {/* ... *\/} one too) is blank. */
const codeLines = (src) => {
  let inBlock = false;
  return src.split('\n').map((line) => {
    if (inBlock) { if (line.includes('*/')) inBlock = false; return ''; }
    const open = line.indexOf('/*');
    if (open >= 0 && !line.includes('*/', open + 2)) { inBlock = true; return codeOf(line.slice(0, open)); }
    return codeOf(line.replace(/\/\*.*?\*\//g, ''));
  });
};

test('no UK law words in Workforce or the staff app without a UK gate', () => {
  const files = guardFiles();
  assert.ok(files.length > 20, 'the guard reads the Workforce screens and the staff app');
  const bad = [];
  for (const f of files) {
    const lines = codeLines(read(f));
    lines.forEach((line, i) => {
      if (!TERMS.test(line)) return;
      const near = lines.slice(Math.max(0, i - WINDOW), i + 1).join('\n');
      if (!GATE.test(near)) bad.push(`${f}:${i + 1}: ${line.trim().slice(0, 120)}`);
    });
  }
  assert.deepEqual(bad, [], `UK law words with no UK gate:\n${bad.join('\n')}`);
});

test('the guard catches an ungated UK word and lets a gated one through', () => {
  const check = (src) => {
    const lines = codeLines(src);
    return lines.some((line, i) => TERMS.test(line) && !GATE.test(lines.slice(Math.max(0, i - WINDOW), i + 1).join('\n')));
  };
  assert.equal(check("const s = 'The Tipping Act requires it';"), true);
  assert.equal(check("const s = pack.country === 'US' ? 'FLSA' : 'The Tipping Act requires it';"), false);
  assert.equal(check("// The Tipping Act, a comment"), false);
  assert.equal(check("{/* the Tipping Act\n   HMRC E24 says */}\n<div />"), false);
  assert.equal(check("{/* a comment */} <b>Right to Work</b>"), true);
});
