// src/backoffice/sections/reports/StockAllergens.jsx
//
// MULTI SITE STOCK, Drop 4a (contract 3.4, web-reports): Allergen matrix. Per site menu: every
// product and its allergens, may contain and diet tags. This report needs Drop 2's tables
// (menu_item_stock_facts), so in 4a it makes no call and says 'Comes with the recipes update'.
// Drop 2 replaces this body.

import { StockReportFrame, LaterTile } from './_stockKit';
import { LATER_WORDS } from '../../../lib/stock/reportView.js';

const TITLE = 'Allergen matrix';
const SUB = 'Per site menu: every product and its allergens, may contain and diet tags, from the supplier each site buys from. Print or export.';

export default function StockAllergens({ onShare }) {
  return (
    <StockReportFrame title={TITLE} sub={SUB} meta={null} onShare={onShare}>
      <LaterTile words={LATER_WORDS.recipes} />
      <div style={{ fontSize: 12.5, color: 'var(--t3)', marginTop: 10 }}>Allergens per site come from the supplier item each site buys, with the recipes update. Nothing is read here until then.</div>
    </StockReportFrame>
  );
}
