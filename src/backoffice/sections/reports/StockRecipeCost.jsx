// src/backoffice/sections/reports/StockRecipeCost.jsx
//
// MULTI SITE STOCK, Drop 4a (contract 3.4, web-reports): Recipe cost alerts and trends. This report
// needs Drop 2's tables (recipe_cost_daily, menu_item_stock_facts), so in 4a it makes no call and
// says 'Comes with the recipes update'. Drop 2 replaces this body.

import { StockReportFrame, LaterTile } from './_stockKit';
import { LATER_WORDS } from '../../../lib/stock/reportView.js';

const TITLE = 'Recipe cost alerts';
const SUB = 'Recipes whose cost rose over a set share in the period, recipes now over target cost, with the price change that caused it, and a cost trend per recipe and site.';

export default function StockRecipeCost({ onShare }) {
  return (
    <StockReportFrame title={TITLE} sub={SUB} meta={null} onShare={onShare}>
      <LaterTile words={LATER_WORDS.recipes} />
      <div style={{ fontSize: 12.5, color: 'var(--t3)', marginTop: 10 }}>The stored daily recipe cost per site arrives with the recipes update. Nothing is read here until then.</div>
    </StockReportFrame>
  );
}
