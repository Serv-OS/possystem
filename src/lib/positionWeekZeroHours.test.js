// 5.12.58 (Peter, 4 Nov 2026): "cant add a zero hour staff member". The Add role dialog sent Contracted
// week 0 and the database refused it (wf_roles_contracted_week_check, week > 0). The week on a position
// only divides a salary (salary / 52 / week); hours are the person's contract. So: an hourly position
// always saves 40 (never 0, never the box), a salaried one must give a week above 0 and is refused in
// words, and the person's Contract list still has Zero hours.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

describe('position week and zero hours (5.12.58)', () => {
  const pay = read('src/backoffice/sections/workforce/WfPay.jsx');

  it('an hourly or age banded position never sends the week box (0 cannot reach the database)', () => {
    assert.ok(pay.includes("contractedWeek: draft.payType === 'salaried' ? num(draft.contractedWeek) : 40"));
    assert.ok(!pay.includes('contractedWeek: num(draft.contractedWeek) ?? 40'));
  });

  it('a salaried position with no week, or 0, is refused in words before any save', () => {
    assert.ok(pay.includes('if (next.contractedWeek == null || next.contractedWeek <= 0) { setWeekRefused(true); return; }'));
    assert.ok(pay.includes("SALARY_WEEK_WORDS = 'Enter the hours a week the salary covers (above 0).'"));
    assert.ok(pay.includes("draft.payType === 'salaried' ? ("), 'the week box shows for salaried only');
  });

  it('hourly positions are told hours live on the person; the person still has Zero hours', () => {
    assert.ok(pay.includes("ZERO_HOURS_WORDS = 'Hours are set per person: Add staff member, Contract (Zero hours, Part time, Full time).'"));
    const wf = read('src/backoffice/sections/Workforce.jsx');
    assert.ok(wf.includes('<option value="zeroHours">Zero hours</option>'));
  });

  it('the labour rule still divides a salary by the week it was saved with', () => {
    const labour = read('src/staff/labour.js');
    assert.ok(labour.includes('rate: role.salary / 52 / cw'));
  });

  it('no long dashes in the new words', () => {
    for (const w of ['ZERO_HOURS_WORDS', 'SALARY_WEEK_WORDS']) {
      const line = pay.split('\n').find((l) => l.includes(`${w} = `));
      assert.ok(line && !/[–—]/.test(line));
    }
  });
});
