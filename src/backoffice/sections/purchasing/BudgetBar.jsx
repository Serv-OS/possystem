// purchasing/BudgetBar.jsx: the Order pad's budget card (multi site stock Drop 3, v5.11.96, contract
// 4.2): 'Budget this week (a % of forecast sales)' and '£2,140 spent + £320 basket of £2,600' with the
// Over budget pill. Nothing at all when the site has no budget.

import { Pill } from '../stock/stockUi';
import { budgetWords, PILLS } from '../../../lib/stock/purchasingWords';

export default function BudgetBar({ budget, basketTotal = 0, symbol = '£' }) {
  const w = budgetWords(budget, basketTotal, symbol);
  if (!w) return null;
  const total = Number(budget.budget) || 0;
  const used = Math.min(100, total > 0 ? ((Number(budget.spent) || 0) + (Number(basketTotal) || 0)) / total * 100 : 0);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginTop: 10, padding: '10px 14px', borderRadius: 14, background: 'var(--bg1)', border: '1px solid var(--bdr)' }}>
      <div style={{ fontSize: 13 }}><b>{w.title}</b> <span style={{ color: 'var(--t3)' }}>{w.rule}</span></div>
      <div style={{ flex: '1 1 120px', height: 6, borderRadius: 4, background: 'var(--bg3)', overflow: 'hidden', minWidth: 80 }}>
        <div style={{ width: `${used}%`, height: '100%', background: w.over ? 'var(--red)' : 'var(--acc)' }} />
      </div>
      <div style={{ fontSize: 13, fontVariantNumeric: 'tabular-nums' }}>{w.right}</div>
      {w.over && <Pill tone={PILLS.overBudget.tone}>{PILLS.overBudget.text}</Pill>}
    </div>
  );
}
