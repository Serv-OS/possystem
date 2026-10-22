// src/backoffice/sections/reports/StockKeyItemTiles.jsx
//
// MULTI SITE STOCK, Drop 4a (contract 3.2, the mockup `tile`): the key item tiles on the head office
// dashboard. One tile per key ratio (milk per milk drink, beans per shot, cups against cup drinks
// sold): the title, Recipe and Actual side by side, one pill with the difference in the server's rag
// colour. No ratios: one tile 'Choose your key items' that opens the Targets panel.
//
// The rows are stock_report_dashboard's rows.key_items (the key_ratios totals): used against sold
// from the stored day totals, never from the stock take off. Words and sums: dashboardRules.js.

import { Btn, Pill } from '../stock/stockUi';
import { tileRows, tileOf, CHOOSE_KEY_ITEMS, KEY_ITEMS_HINT } from '../../../lib/stock/dashboardRules';

const grid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12, marginBottom: 16 };
const tile = { background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 12, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0, textAlign: 'left', fontFamily: 'inherit', color: 'var(--t1)', cursor: 'pointer' };
const label = { fontSize: 12, color: 'var(--t3)' };
const pair = { display: 'flex', gap: 16, alignItems: 'baseline', flexWrap: 'wrap' };
const small = { fontSize: 12, color: 'var(--t3)', marginRight: 4 };
const big = { fontSize: 18, fontWeight: 700, fontVariantNumeric: 'tabular-nums', letterSpacing: '-.01em' };

/**
 * keyItems: rows.key_items of the dashboard answer.
 * onOpenReport(viewId, opts): a tile opens Key item ratios for that ratio.
 * onOpenTargets(): the empty tile's button (shown when canEdit).
 */
export default function StockKeyItemTiles({ keyItems, onOpenReport, onOpenTargets, canEdit = false }) {
  const rows = tileRows(keyItems);
  if (!rows.length) {
    return (
      <div style={grid} data-testid="stock-key-item-tiles">
        <div style={{ ...tile, cursor: 'default' }}>
          <span style={label}>Key items</span>
          <span style={{ fontSize: 15, fontWeight: 700 }}>{CHOOSE_KEY_ITEMS}</span>
          <span style={{ fontSize: 12, color: 'var(--t4)', lineHeight: 1.5 }}>{KEY_ITEMS_HINT}.</span>
          {canEdit
            ? <span><Btn kind="soft" small onClick={onOpenTargets}>Open Targets</Btn></span>
            : <span style={{ fontSize: 12, color: 'var(--t4)' }}>A Stock control All sites login chooses them in Targets.</span>}
        </div>
      </div>
    );
  }
  return (
    <div style={grid} data-testid="stock-key-item-tiles">
      {rows.map((r) => {
        const t = tileOf(r);
        return (
          <button key={t.key} type="button" style={tile} title="Open Key item ratios"
            onClick={() => onOpenReport?.('stock_key_ratios', { ratio_id: t.ratioId })}>
            <span style={label}>{t.title}</span>
            <span style={pair}>
              <span><span style={small}>Recipe</span><b style={big}>{t.recipeText}</b></span>
              <span><span style={small}>Actual</span><b style={big}>{t.actualText}</b></span>
            </span>
            <span style={{ fontSize: 12 }}>
              {t.tone ? <Pill tone={t.tone}>{t.pillText}</Pill> : <span style={{ color: 'var(--t4)' }}>{t.pillText}</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}
