// purchasing/BasketRulesLine.jsx: under each supplier's total on the Order pad (multi site stock
// Drop 3, v5.11.96, contract 4.2): the minimum, the maximum, the delivery fee or its waiver, and the
// approval words. rules is basketRules' answer.

import { Pill } from '../stock/stockUi';

const COLOUR = { amber: 'var(--amber, #F5A623)', red: 'var(--red)', plain: 'var(--t3)' };

export default function BasketRulesLine({ rules }) {
  if (!rules) return null;
  return (
    <span style={{ display: 'inline-flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', fontSize: 12 }}>
      {(rules.words || []).map((w) => <span key={w.text} style={{ color: COLOUR[w.tone] || COLOUR.plain, fontWeight: w.tone === 'plain' ? 400 : 700 }}>{w.text}</span>)}
      {rules.approval && (rules.needsApproval
        ? <Pill tone="warn">{rules.approval.text}</Pill>
        : <span style={{ color: 'var(--t4)' }}>{rules.approval.text}</span>)}
    </span>
  );
}
