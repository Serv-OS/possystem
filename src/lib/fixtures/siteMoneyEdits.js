// src/lib/fixtures/siteMoneyEdits.js
//
// 5.12.57 (batch 1, money and currency): the one site identity tests (oneSiteIdentity*.test.js,
// siteIdWiring.test.js, goLiveRules.test.js) prove a one site company runs main's screens by putting
// each screen's listed edits back and hashing the text. The site money edits of 5.12.57 (money in
// the site's own currency through useSiteMoney, the site Money cell, the headings built from the
// symbol) change nothing for a one site company: its site IS the signed in venue, so every helper
// gives the active currency, exactly as the imports did. This table puts them back first:
// [now, was] for each file (from src/), each now found exactly once. Generated from the diff
// against the 5.12.57 base and checked to give that base byte for byte. Characters outside plain
// ASCII, and every '<', are written as \u escapes, so the table never reads as a JSX tag.

import { US_STOCK_EDITS } from './usStockEdits.js';
import { DATES_BATCH8_EDITS } from './datesBatch8Edits.js';

export const SITE_MONEY_EDITS = Object.freeze({
  "backoffice/sections/purchasing/InvoicesSite.jsx": [
    ["import { useSiteMoney } from '../stock/useSiteCurrency';\n",
      "import { money, currencySymbol } from '../../../lib/currency';\n"],
    ["import { PageHeader, ReportTable, useSort, sortRows, SubToolbar, Tag } from '../reports/reportKit';\nimport { Money } from '../stock/SiteMoney';\n",
      "import { PageHeader, ReportTable, useSort, sortRows, SubToolbar, Tag, Money } from '../reports/reportKit';\n"],
    ["  // 5.12.57: this site's money (its own currency, not the signed in venue's), in place of the imports.\n  const { money, currencySymbol, code: cur } = useSiteMoney(siteId);\n",
      ""],
    ["    { key: 'total', label: 'Total', align: 'right', sortable: true, render: (inv) => \u003cMoney v={inv.total} code={cur} /> },\n",
      "    { key: 'total', label: 'Total', align: 'right', sortable: true, render: (inv) => \u003cMoney v={inv.total} /> },\n"],
    ["  ], [supplierNameOf, xeroOn, xeroPush, venueTz, cur]);\n",
      "  ], [supplierNameOf, xeroOn, xeroPush, venueTz]);\n"],
  ],
  "backoffice/sections/purchasing/PurchaseOrdersSite.jsx": [
    ["import { money } from '../../../lib/currency';\n",
      "import { money, currencySymbol } from '../../../lib/currency';\n"],
    ["import { useSiteMoney } from '../stock/useSiteCurrency';\n",
      ""],
    ["  // 5.12.57: this site's money (its own currency, not the signed in venue's), in place of the imports.\n  const { money, currencySymbol, code: cur } = useSiteMoney(siteId);\n",
      ""],
    ["                      \u003cSupplierItemTable key={filterKey} rows={shown} onQty={setRowQty} onQtyBlur={blurRowQty} onPrice={setRowPrice} lineRateDec={lineRateDec} cur={cur} />\n",
      "                      \u003cSupplierItemTable key={filterKey} rows={shown} onQty={setRowQty} onQtyBlur={blurRowQty} onPrice={setRowPrice} lineRateDec={lineRateDec} />\n"],
    ["function SupplierItemTable({ rows, onQty, onQtyBlur, onPrice, lineRateDec, cur = null }) {\n",
      "function SupplierItemTable({ rows, onQty, onQtyBlur, onPrice, lineRateDec }) {\n"],
    ["          {slice.map((r, i) => \u003cItemRow key={r.key} r={r} last={start + i === rows.length - 1} onQty={onQty} onQtyBlur={onQtyBlur} onPrice={onPrice} lineRateDec={lineRateDec} cur={cur} />)}\n",
      "          {slice.map((r, i) => \u003cItemRow key={r.key} r={r} last={start + i === rows.length - 1} onQty={onQty} onQtyBlur={onQtyBlur} onPrice={onPrice} lineRateDec={lineRateDec} />)}\n"],
    ["function ItemRow({ r, last, onQty, onQtyBlur, onPrice, lineRateDec, cur = null }) {\n",
      "function ItemRow({ r, last, onQty, onQtyBlur, onPrice, lineRateDec }) {\n"],
    ["          : \u003cspan title=\"net price of one pack, ex VAT\">{money(r.netPrice, cur)}\u003c/span>}\n",
      "          : \u003cspan title=\"net price of one pack, ex VAT\">{money(r.netPrice)}\u003c/span>}\n"],
    ["      \u003ctd style={{ ...num, ...cell, fontWeight: 600 }}>{r.line && Number(r.line.qtyPacks) > 0 ? money(rowLineValue(r), cur) : ''}\u003c/td>\n",
      "      \u003ctd style={{ ...num, ...cell, fontWeight: 600 }}>{r.line && Number(r.line.qtyPacks) > 0 ? money(rowLineValue(r)) : ''}\u003c/td>\n"],
  ],
  "backoffice/sections/purchasing/PriceChangesSite.jsx": [
    ["import { useSiteMoney } from '../stock/useSiteCurrency';\n",
      "import { money } from '../../../lib/currency';\n"],
    ["  // 5.12.57: this site's money (its own currency, not the signed in venue's), in place of the import.\n  const { money } = useSiteMoney(siteId);\n",
      ""],
  ],
  "backoffice/sections/produce/RecipesSite.jsx": [
    ["import { useSiteMoney } from '../stock/useSiteCurrency';\n",
      ""],
    ["// 5.12.57: cur is the site's currency (the screen's own site, not the signed in venue's).\nconst fmtCost = (v, cur = null) => (v == null || !Number.isFinite(Number(v)) ? '\u2014' : currencySymbol(cur) + Number(v).toFixed(4).replace(/0+$/, '').replace(/\\.$/, ''));\n",
      "const fmtCost = (v) => (v == null || !Number.isFinite(Number(v)) ? '\u2014' : currencySymbol() + Number(v).toFixed(4).replace(/0+$/, '').replace(/\\.$/, ''));\n"],
    ["  // 5.12.57: this site's money (its own currency, not the signed in venue's), in place of the import.\n  const { money, code: cur } = useSiteMoney(siteId);\n",
      ""],
    ["              \u003cRecipeStats draft={draft} cost={draft.recipeType === 'MENU' ? (costByType[otView === 'all' ? 'dine-in' : otView] || cost) : cost} menuPrice={menuPriceNet} viewType={otView} cur={cur} />\n",
      "              \u003cRecipeStats draft={draft} cost={draft.recipeType === 'MENU' ? (costByType[otView === 'all' ? 'dine-in' : otView] || cost) : cost} menuPrice={menuPriceNet} viewType={otView} />\n"],
    ["                              {noCost ? \u003cspan style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>\u003cIcon name=\"warn\" size={12} />no price set \u2014 add a supplier price on this item\u003c/span> : (comp ? `${fmtCost(comp.currentCost, cur)} / ${comp.baseUnit}` : '')}\n",
      "                              {noCost ? \u003cspan style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>\u003cIcon name=\"warn\" size={12} />no price set \u2014 add a supplier price on this item\u003c/span> : (comp ? `${fmtCost(comp.currentCost)} / ${comp.baseUnit}` : '')}\n"],
    ["                \u003cIngredientPicker items={items} onPick={addLine} disabled={locked} cur={cur} />\n",
      "                \u003cIngredientPicker items={items} onPick={addLine} disabled={locked} />\n"],
    ["function RecipeStats({ draft, cost, menuPrice, viewType, cur = null }) {\n",
      "function RecipeStats({ draft, cost, menuPrice, viewType }) {\n"],
    ["    return \u003cdiv style={{ display: 'flex', gap: 20, textAlign: 'right' }}>{stat('Cost', plate == null ? '\u2014' : money(plate, cur))}\u003cdiv style={{ fontSize: 12, color: 'var(--t3)', alignSelf: 'flex-end' }}>per {draft.yieldUnit}\u003c/div>\u003c/div>;\n",
      "    return \u003cdiv style={{ display: 'flex', gap: 20, textAlign: 'right' }}>{stat('Cost', plate == null ? '\u2014' : money(plate))}\u003cdiv style={{ fontSize: 12, color: 'var(--t3)', alignSelf: 'flex-end' }}>per {draft.yieldUnit}\u003c/div>\u003c/div>;\n"],
    ["        {stat('Plate cost', plate == null ? '\u2014' : money(plate, cur))}\n",
      "        {stat('Plate cost', plate == null ? '\u2014' : money(plate))}\n"],
    ["        {stat('GP', price != null && plate != null ? money(gpAmount(price, plate), cur) : '\u2014')}\n",
      "        {stat('GP', price != null && plate != null ? money(gpAmount(price, plate)) : '\u2014')}\n"],
    ["function IngredientPicker({ items, onPick, disabled = false, cur = null }) {\n",
      "function IngredientPicker({ items, onPick, disabled = false }) {\n"],
    ["              \u003cspan>{i.name}\u003c/span>\u003cspan style={{ color: 'var(--t3)', fontSize: 11 }}>{i.kind === 'MADE' ? 'prep \u00b7 ' : ''}{fmtCost(i.currentCost, cur)}/{i.baseUnit}\u003c/span>\n",
      "              \u003cspan>{i.name}\u003c/span>\u003cspan style={{ color: 'var(--t3)', fontSize: 11 }}>{i.kind === 'MADE' ? 'prep \u00b7 ' : ''}{fmtCost(i.currentCost)}/{i.baseUnit}\u003c/span>\n"],
  ],
  "backoffice/sections/produce/BatchesSite.jsx": [
    ["import { useSiteMoney } from '../stock/useSiteCurrency';\n",
      "import { money, currencySymbol } from '../../../lib/currency';\n"],
    ["import { PageHeader, PrimaryBtn, ReportTable, Tag } from '../reports/reportKit';\nimport { Money } from '../stock/SiteMoney';\n",
      "import { PageHeader, PrimaryBtn, ReportTable, Money, Tag } from '../reports/reportKit';\n"],
    ["  // 5.12.57: this site's money (its own currency, not the signed in venue's), in place of the imports.\n  const { money, currencySymbol, code: cur } = useSiteMoney(siteId);\n",
      ""],
    ["    { key: 'cost', label: 'Cost', align: 'right', render: b => \u003cMoney v={b.actualCost} code={cur} /> },\n",
      "    { key: 'cost', label: 'Cost', align: 'right', render: b => \u003cMoney v={b.actualCost} /> },\n"],
    ["  ], [itemName, venueTz, cur, currencySymbol]);\n",
      "  ], [itemName, venueTz]);\n"],
  ],
  "backoffice/sections/stock/items/StockItemsSplit.jsx": [
    ["      {/* 5.12.57: the example prices are in the venue's own symbol, never a typed pound sign. */}\n",
      ""],
    ["        Enter what you buy it in (a unit from the \u003cb>Units\u003c/b> tab) and what it costs \u2014 e.g. \u003cb>1 Keg for {currencySymbol()}152\u003c/b> or\n        \u003cb> 1 Case for {currencySymbol()}40\u003c/b>. The cost per {draft.baseUnit} is worked out for you and the \u003cb>preferred\u003c/b> line sets this\n",
      "        Enter what you buy it in (a unit from the \u003cb>Units\u003c/b> tab) and what it costs \u2014 e.g. \u003cb>1 Keg for \u00a3152\u003c/b> or\n        \u003cb> 1 Case for \u00a340\u003c/b>. The cost per {draft.baseUnit} is worked out for you and the \u003cb>preferred\u003c/b> line sets this\n"],
    ["            \u003cdiv style={{ fontSize: 11, color: 'var(--t4)', marginTop: 6 }}>e.g. \u003cb>1 Keg for {currencySymbol()}152\u003c/b>, or \u003cb>1 Case for {currencySymbol()}40\u003c/b>. Add units on the \u003cb>Units\u003c/b> tab.\u003c/div>\n",
      "            \u003cdiv style={{ fontSize: 11, color: 'var(--t4)', marginTop: 6 }}>e.g. \u003cb>1 Keg for \u00a3152\u003c/b>, or \u003cb>1 Case for \u00a340\u003c/b>. Add units on the \u003cb>Units\u003c/b> tab.\u003c/div>\n"],
  ],
  "backoffice/sections/stock/suppliers/SuppliersSplit.jsx": [
    ["import { money, currencySymbol } from '../../../../lib/currency';\n",
      "import { money } from '../../../../lib/currency';\n"],
    ["              {/* 5.12.57: the venue's own symbol, never a typed pound sign. */}\n              \u003cdiv>\u003clabel style={lbl}>Min order value\u003c/label>\u003cinput type=\"number\" min=\"0\" step=\"any\" value={draft.minOrderValue ?? ''} onChange={e => upd('minOrderValue', e.target.value)} style={field} placeholder={currencySymbol()} />\u003c/div>\n",
      "              \u003cdiv>\u003clabel style={lbl}>Min order value\u003c/label>\u003cinput type=\"number\" min=\"0\" step=\"any\" value={draft.minOrderValue ?? ''} onChange={e => upd('minOrderValue', e.target.value)} style={field} placeholder=\"\u00a3\" />\u003c/div>\n"],
  ],
  "backoffice/sections/StockOverview.jsx": [
    ["import { useSiteMoney } from './stock/useSiteCurrency';\n",
      "import { money, currencySymbol, signedMoney } from '../../lib/currency';\n"],
    ["  // 5.12.57: this site's money (its own currency, not the signed in venue's), in place of the imports.\n  const { money, signedMoney } = useSiteMoney(siteId);\n",
      ""],
  ],
  "backoffice/sections/StockCounts.jsx": [
    ["import { useSiteMoney } from './stock/useSiteCurrency';\n",
      "import { signedMoney } from '../../lib/currency';\n"],
    ["  // 5.12.57: this site's money (its own currency, not the signed in venue's), in place of the import.\n  const { signedMoney } = useSiteMoney(siteId);\n",
      ""],
  ],
  "backoffice/sections/Wastage.jsx": [
    ["import { useSiteMoney } from './stock/useSiteCurrency';\n",
      "import { money } from '../../lib/currency';\n"],
    ["  // 5.12.57: this site's money (its own currency, not the signed in venue's), in place of the import.\n  const { money } = useSiteMoney(siteId);\n",
      ""],
  ],
  "backoffice/sections/StockTransfers.jsx": [
    ["import { useSiteMoney } from './stock/useSiteCurrency';\n",
      "import { money } from '../../lib/currency';\n"],
    ["  // 5.12.57: this site's money (its own currency, not the signed in venue's), in place of the import;\n  // the new transfer and the detail are this site's too (locId).\n  const { money } = useSiteMoney(siteId);\n",
      ""],
    ["function NewTransfer({ locId, areas, items, itemsById, suppliers, holdings, venues, byName, onDone, onError, multi = false, onRequest = null }) {\n  const { money } = useSiteMoney(locId);\n",
      "function NewTransfer({ locId, areas, items, itemsById, suppliers, holdings, venues, byName, onDone, onError, multi = false, onRequest = null }) {\n"],
    ["function TransferDetail({ id, locId, areas, areaName, venueName, items, itemsById, byName, venueTz, onChanged }) {\n  const { money } = useSiteMoney(locId);\n",
      "function TransferDetail({ id, locId, areas, areaName, venueName, items, itemsById, byName, venueTz, onChanged }) {\n"],
  ],
  "backoffice/sections/StockAreas.jsx": [
    ["import { useSiteMoney } from './stock/useSiteCurrency';\n",
      "import { money } from '../../lib/currency';\n"],
    ["  // 5.12.57: this site's money (its own currency, not the signed in venue's), in place of the import.\n  const { money } = useSiteMoney(siteId);\n",
      ""],
  ],
  "backoffice/sections/StockReports.jsx": [
    ["import { currencySymbol } from '../../lib/currency';\n",
      "import { money, currencySymbol, signedMoney } from '../../lib/currency';\n"],
    ["import { useSiteMoney, useSiteMoneyHere, SiteCurrencyContext } from './stock/useSiteCurrency';\nimport { Money } from './stock/SiteMoney';\n",
      ""],
    ["  Signed, Tag, BarCell, RankChip, GradedChip, gradeOf,\n",
      "  Money, Signed, Tag, BarCell, RankChip, GradedChip, gradeOf,\n"],
    ["// 5.12.57: every figure is in the report's site currency (SiteCurrencyContext), not the signed in\n// venue's: a US site picked while signed in at a UK site read in pounds. cur is that currency.\nconst fmtCost = (v, cur = null) => (v == null || !Number.isFinite(Number(v)) ? '\u2014' : currencySymbol(cur) + Number(v).toFixed(4).replace(/0+$/, '').replace(/\\.$/, ''));\n",
      "const fmtCost = (v) => (v == null || !Number.isFinite(Number(v)) ? '\u2014' : currencySymbol() + Number(v).toFixed(4).replace(/0+$/, '').replace(/\\.$/, ''));\n"],
    ["  const { code: cur } = useSiteMoney(siteId);\n",
      ""],
    ["    \u003cSiteCurrencyContext.Provider value={cur}>\n",
      ""],
    ["    \u003c/SiteCurrencyContext.Provider>\n",
      ""],
    ["  const { money, signedMoney, code: cur } = useSiteMoneyHere();\n",
      ""],
    ["  }, [sorted, view, money]);\n",
      "  }, [sorted, view]);\n"],
    ["    { key:'cost', label:'Unit cost', align:'right', sortable:true, render:r => \u003cspan style={{ fontVariantNumeric:'tabular-nums', color:'var(--t3)' }}>{fmtCost(r.cost, cur)}\u003c/span> },\n",
      "    { key:'cost', label:'Unit cost', align:'right', sortable:true, render:r => \u003cspan style={{ fontVariantNumeric:'tabular-nums', color:'var(--t3)' }}>{fmtCost(r.cost)}\u003c/span> },\n"],
    ["  const { symbol } = useSiteMoneyHere();\n",
      ""],
    ["    { key:'gp', label:`GP ${symbol}`, align:'right', sortable:true, render:r => \u003cMoney v={r.gp}/> },\n",
      "    { key:'gp', label:'GP \u00a3', align:'right', sortable:true, render:r => \u003cMoney v={r.gp}/> },\n"],
    ["          {label:'Food %',key:'foodPct'},{label:`GP ${symbol}`,key:'gp'},{label:'GP %',key:'gpPct'},{label:'GP target %',key:'target'}]}/>\n",
      "          {label:'Food %',key:'foodPct'},{label:'GP \u00a3',key:'gp'},{label:'GP %',key:'gpPct'},{label:'GP target %',key:'target'}]}/>\n"],
    ["function ByArea({ items, byArea, onRefresh }) {\n  const { money } = useSiteMoneyHere();\n",
      "function ByArea({ items, byArea, onRefresh }) {\n"],
    ["  const { signedMoney } = useSiteMoneyHere();\n",
      ""],
    ["  const { signedMoney, symbol } = useSiteMoneyHere();\n",
      ""],
    ["    { key:'varValue', label:`Variance ${symbol}`, align:'right', sortable:true, render:r => \u003cMoney v={r.varValue} bold/> },\n",
      "    { key:'varValue', label:'Variance \u00a3', align:'right', sortable:true, render:r => \u003cMoney v={r.varValue} bold/> },\n"],
    ["          {label:'Waste',key:'waste'},{label:'Count adj qty',key:'countQty'},{label:`Variance ${symbol}`,key:'varValue'}]}/>\n",
      "          {label:'Waste',key:'waste'},{label:'Count adj qty',key:'countQty'},{label:'Variance \u00a3',key:'varValue'}]}/>\n"],
    ["function BySupplier({ items, suppliers, recipes, ctx, menuItems, taxRates, checks, periodLabel }) {\n  const { money } = useSiteMoneyHere();\n",
      "function BySupplier({ items, suppliers, recipes, ctx, menuItems, taxRates, checks, periodLabel }) {\n"],
  ],
  "backoffice/sections/OrderPad.jsx": [
    ["import { useSiteMoney } from './stock/useSiteCurrency';\n",
      "import { money } from '../../lib/currency';\n"],
    ["// 5.12.57: the money heading is in the site's own symbol ('Line $ (ex VAT)' at a US site).\nconst headersOne = (symbol) => ['Item', 'On hand', 'Use/day', 'Cover', 'Suggested', 'Order', 'Supplier', `Line ${symbol} (ex VAT)`];\n",
      "const HEADERS = ['Item', 'On hand', 'Use/day', 'Cover', 'Suggested', 'Order', 'Supplier', 'Line \u00a3 (ex VAT)'];\nconst HEADERS_ONE = HEADERS; // d3 multi: the screen swaps in the multi site columns (HEADERS_MULTI_OF) by name\n"],
    ["function MultiBasket({ basket, ctx, supName, spNet, itemName, symbol }) { // d3 multi\n",
      "function MultiBasket({ basket, ctx, supName, spNet, itemName }) { // d3 multi\n"],
    ["        const rules = basketRules({ goods, minOrder: s?.min_order_value, maxOrder: s?.max_order_value, fee: s?.delivery_fee, feeWaivedOverMin: s?.fee_waived_over_min === true, approvalLimit: s?.approval_limit, symbol }); // d3 multi\n",
      "        const rules = basketRules({ goods, minOrder: s?.min_order_value, maxOrder: s?.max_order_value, fee: s?.delivery_fee, feeWaivedOverMin: s?.fee_waived_over_min === true, approvalLimit: s?.approval_limit }); // d3 multi\n"],
    ["            \u003cb>{supName(sid)}\u003c/b> \u003cspan style={{ fontVariantNumeric: 'tabular-nums' }}>{moneyWords(goods, symbol)}\u003c/span>{/* // d3 multi */}\n",
      "            \u003cb>{supName(sid)}\u003c/b> \u003cspan style={{ fontVariantNumeric: 'tabular-nums' }}>{moneyWords(goods)}\u003c/span>{/* // d3 multi */}\n"],
    ["  // 5.12.57: this site's money (its own currency, not the signed in venue's), in place of the import.\n  const { money, symbol } = useSiteMoney(siteId);\n",
      ""],
    ["  const HEADERS = multi ? HEADERS_MULTI_OF(supplierFilter !== 'all' ? nextOf(supplierFilter)?.deliveryDow ?? null : null, symbol) : headersOne(symbol); // d3 multi\n",
      "  const HEADERS = multi ? HEADERS_MULTI_OF(supplierFilter !== 'all' ? nextOf(supplierFilter)?.deliveryDow ?? null : null) : HEADERS_ONE; // d3 multi\n"],
    ["    for (const [sid, ls] of groups) { const sup = padSupplierOf(ctx, sid); const goods = ls.reduce((t, { r, n }) => t + n * spNet(r.sp), 0); if (basketRules({ goods, maxOrder: sup?.max_order_value, symbol }).overMax) { showToast?.(`Over the maximum ${moneyWords(sup.max_order_value, symbol)} for ${supName(sid)}. Split the order or ask head office.`, 'error'); return; } } // d3 multi\n",
      "    for (const [sid, ls] of groups) { const sup = padSupplierOf(ctx, sid); const goods = ls.reduce((t, { r, n }) => t + n * spNet(r.sp), 0); if (basketRules({ goods, maxOrder: sup?.max_order_value }).overMax) { showToast?.(`Over the maximum ${moneyWords(sup.max_order_value)} for ${supName(sid)}. Split the order or ask head office.`, 'error'); return; } } // d3 multi\n"],
    ["        {multi && \u003cBudgetBar budget={ctx?.budget} basketTotal={basketTotal} symbol={symbol} />}{/* // d3 multi */}\n",
      "        {multi && \u003cBudgetBar budget={ctx?.budget} basketTotal={basketTotal} />}{/* // d3 multi */}\n"],
    ["        {multi && \u003cMultiBasket basket={basket} ctx={ctx} supName={supName} spNet={spNet} itemName={itemName} symbol={symbol} />}{/* // d3 multi */}\n",
      "        {multi && \u003cMultiBasket basket={basket} ctx={ctx} supName={supName} spNet={spNet} itemName={itemName} />}{/* // d3 multi */}\n"],
  ],
});

const keyOf = (file) => {
  const f = String(file instanceof URL ? file.pathname : file).replace(/\\/g, '/');
  return Object.keys(SITE_MONEY_EDITS).find((k) => f === k || f.endsWith(`/src/${k}`) || f.endsWith(`/${k}`)) || null;
};

const usKeyOf = (file) => {
  const f = String(file instanceof URL ? file.pathname : file).replace(/\\/g, '/');
  return Object.keys(US_STOCK_EDITS).find((k) => f === k || f.endsWith(`/src/${k}`) || f.endsWith(`/${k}`)) || null;
};

const datesKeyOf = (file) => {
  const f = String(file instanceof URL ? file.pathname : file).replace(/\\/g, '/');
  return Object.keys(DATES_BATCH8_EDITS).find((k) => f === k || f.endsWith(`/src/${k}`) || f.endsWith(`/${k}`)) || null;
};

/** The file's text with its 5.12.57 batch 8 edits put back (fixtures/datesBatch8Edits.js; unchanged for a file not listed). */
export function undoDatesBatch8(file, text) {
  const key = datesKeyOf(file);
  if (!key) return text;
  let t = String(text);
  for (const [now, was] of DATES_BATCH8_EDITS[key]) {
    const n = t.split(now).length - 1;
    if (n !== 1) throw new Error(`${key}: a 5.12.57 batch 8 edit is there ${n} times, not once: ${now.slice(0, 80)}`);
    t = t.replace(now, () => was);
  }
  return t;
}

/** The file's text with its 5.12.57 batch 7 edits put back (fixtures/usStockEdits.js; unchanged for a file not listed). */
export function undoUsStock(file, text) {
  const key = usKeyOf(file);
  if (!key) return text;
  let t = String(text);
  for (const [now, was] of US_STOCK_EDITS[key]) {
    const n = t.split(now).length - 1;
    if (n !== 1) throw new Error(`${key}: a 5.12.57 batch 7 edit is there ${n} times, not once: ${now.slice(0, 80)}`);
    t = t.replace(now, () => was);
  }
  return t;
}

/**
 * The file's text with its 5.12.57 site money edits put back (unchanged for a file not listed).
 * The batch 8 edits (datesBatch8Edits.js) go back first, then batch 7 (usStockEdits.js), so the batch 1
 * table finds its text.
 */
export function undoSiteMoney(file, text) {
  text = undoUsStock(file, undoDatesBatch8(file, text));   // batch 8, then batch 7, then the batch 1 table
  const key = keyOf(file);
  if (!key) return text;
  let t = String(text);
  for (const [now, was] of SITE_MONEY_EDITS[key]) {
    const n = t.split(now).length - 1;
    if (n !== 1) throw new Error(`${key}: a 5.12.57 site money edit is there ${n} times, not once: ${now.slice(0, 80)}`);
    t = t.replace(now, () => was);
  }
  return t;
}
