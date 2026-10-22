// src/backoffice/sections/stock/MenuItemFactsPanel.jsx
//
// The read only 'From the recipe at this site' panel (v5.11.93, multi site stock Drop 2, contract
// 3.6 and 4.5), shown under the allergen chips in Menu Manager and, per site, in the Multi site
// menu's product sheet. It reads ONE facts row (menu_item_stock_facts, through
// stockApi.menuStockFacts) and says what the stock recipe linked at this site adds: allergens,
// may contain, kcal, who checked it and when, and a 'Check again' line when something changed.
// It never writes: the chips above stay what was typed, and the facts are stock owned.
//
// Nothing is drawn while the row loads, when there is no row (a product with no recipe link), or
// when the database has no Drop 2 yet (NEEDS_UPDATE), so today's screens look the same.

import { useEffect, useState } from 'react';
import { stockApi } from '../../../lib/stock/stockApi';
import { ALLERGENS } from '../../../data/seed';
import { factsPanelWords } from '../../../lib/menuStockFacts';

const labelOf = (id) => ALLERGENS.find((a) => a.id === id)?.label || (id ? id.charAt(0).toUpperCase() + id.slice(1) : '');
const labels = (ids) => (ids || []).map(labelOf).filter(Boolean).join(', ');

export const PANEL_TITLE = 'From the recipe at this site';
export const PANEL_NOTE = 'These come from the stock recipe linked here and are added to what is ticked above on every channel. They are never removed by themselves.';

export default function MenuItemFactsPanel({ locationId, menuItemId, siteName = null }) {
  // The row is kept with the site and product it was read for, so another product shows nothing
  // until its own row comes back (no reset inside the effect).
  const key = locationId && menuItemId ? `${locationId}|${menuItemId}` : null;
  const [got, setGot] = useState({ key: null, row: null });
  useEffect(() => {
    if (!locationId || !menuItemId || typeof stockApi?.menuStockFacts !== 'function') return undefined;
    let live = true;
    const forKey = `${locationId}|${menuItemId}`;
    Promise.resolve(stockApi.menuStockFacts(locationId, [menuItemId])).then((r) => {
      if (!live) return;
      const rows = Array.isArray(r?.data) ? r.data : [];
      setGot({ key: forKey, row: rows.find((x) => x && String(x.menu_item_id) === String(menuItemId)) || null });
    }, () => { if (live) setGot({ key: forKey, row: null }); });
    return () => { live = false; };
  }, [locationId, menuItemId]);
  const row = key && got.key === key ? got.row : null;

  const w = factsPanelWords(row);
  if (!w) return null;
  const line = { fontSize: 12, color: 'var(--t2)', lineHeight: 1.5 };
  return (
    <div style={{ marginTop: 14, padding: '10px 12px', borderRadius: 10, background: 'var(--bg2)', border: '1px solid var(--bdr)' }}>
      <div style={{ fontSize: 11.5, fontWeight: 800, color: 'var(--t2)', marginBottom: 4 }}>
        {siteName ? `From the recipe at ${siteName}` : PANEL_TITLE}
      </div>
      <div style={line}>Allergens: {w.allergens.length ? labels(w.allergens) : 'none from the ingredients yet'}</div>
      {w.mayContain.length > 0 && <div style={line}>May contain: {labels(w.mayContain)}</div>}
      {w.kcal && <div style={line}>{w.kcal} a portion</div>}
      <div style={{ ...line, color: row?.checked_at ? 'var(--grn, #2f8f4e)' : 'var(--t3)' }}>{w.checked}</div>
      {w.check && <div style={{ ...line, color: 'var(--orn, #b45309)', fontWeight: 700 }}>{w.check}</div>}
      <div style={{ fontSize: 11, color: 'var(--t4)', marginTop: 6, lineHeight: 1.5 }}>{PANEL_NOTE}</div>
    </div>
  );
}
