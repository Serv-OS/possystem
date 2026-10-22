// src/backoffice/sections/produce/RecipeFactsLine.jsx
//
// MULTI SITE STOCK Drop 2 (map 4.5, contract 3.2): the one site company's allergen line, rendered
// under the recipe lines of today's Recipes screen (produce/RecipesSite.jsx, one import line and
// one render line, both removed before the identity hash). One stock_recipe_facts read for this
// site. It renders NOTHING when the read answers 'needs a database update' or any error, so a
// database without Drop 2 shows exactly today's screen. Otherwise a strip in the lock line's look:
// 'Allergens: Milk, Gluten' (or 'Allergens: none from the ingredients yet'), 'May contain: ...',
// '<n> kcal a portion', then 'Checked by <name>, <day>' or the Checked button (stock_facts_signoff)
// or 'Check again: <words>' with the button; 'Print label' (PPDS) once checked.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../../../store';
import { useStockScope } from '../../StockScope';
import { stockApi } from '../../../lib/stock/stockApi';
import { getLocationConfig } from '../../../lib/locationTime';
import { factsLineWords, factsWords, signedOff, PPDS_NOT_CHECKED } from '../../../lib/stock/recipeRules';
import { Btn, Pill, ui } from '../stock/stockUi';
import BatchLabels from './BatchLabels';

export default function RecipeFactsLine({ siteId, recipeId, menuItemId = null }) {
  const sc = useStockScope();
  const showToast = useStore((s) => s.showToast);
  const [row, setRow] = useState(null);   // the facts row, or null (nothing drawn)
  const [busy, setBusy] = useState(false);
  const [label, setLabel] = useState(false);
  const [tz, setTz] = useState(null);
  const seq = useRef(0);
  const say = (words, tone = 'success') => { try { showToast?.(words, tone); } catch { /* no toast, no harm */ } };

  const load = useCallback(async () => {
    if (!siteId || !recipeId || typeof stockApi.recipeFacts !== 'function') { setRow(null); return; }
    const mine = ++seq.current;
    const r = await stockApi.recipeFacts(recipeId, [siteId]);
    if (mine !== seq.current) return;
    if (r.error || r.needsUpdate) { setRow(null); return; }
    const rows = r.data?.rows || [];
    setRow(rows.find((x) => x.location_id === siteId && (!menuItemId || !x.menu_item_id || String(x.menu_item_id) === String(menuItemId))) || rows[0] || null);
  }, [siteId, recipeId, menuItemId]);
  useEffect(() => {
    if (!siteId || !recipeId || typeof stockApi.recipeFacts !== 'function') return undefined;
    let live = true;
    const mine = ++seq.current;
    stockApi.recipeFacts(recipeId, [siteId]).then((r) => {
      if (!live || mine !== seq.current) return;
      if (r.error || r.needsUpdate) { setRow(null); return; }
      const rows = r.data?.rows || [];
      setRow(rows.find((x) => x.location_id === siteId && (!menuItemId || !x.menu_item_id || String(x.menu_item_id) === String(menuItemId))) || rows[0] || null);
    });
    return () => { live = false; };
  }, [siteId, recipeId, menuItemId]);
  useEffect(() => {
    if (!siteId || !row) return undefined;
    let live = true;
    getLocationConfig(siteId).then((c) => { if (live) setTz(c?.timezone || null); }).catch(() => {});
    return () => { live = false; };
  }, [siteId, row]);

  if (!row) return null;

  const w = factsWords(row, tz);
  const itemId = row.menu_item_id || menuItemId || null;
  const canCheck = !!itemId && sc.canEditSite(siteId, 'site_facts');
  const signed = signedOff(row);
  const check = async () => {
    setBusy(true);
    const r = await stockApi.factsSignoff(siteId, itemId, 'produce');
    setBusy(false);
    if (r.error) { say(r.error.message, 'error'); return; }
    say(`Checked by ${r.data?.checked_by_name || 'you'}. Every channel shows these allergens.`);
    await load();
  };

  return (
    <div style={{ ...ui.lockline, marginTop: 12, color: 'var(--t2)' }} data-testid="recipe-facts-line">
      <span style={{ flex: '1 1 260px', minWidth: 0 }}>{factsLineWords(row).join(' · ')}</span>
      {w.state === 'check_again' && <Pill tone="warn">{w.words}</Pill>}
      {w.state === 'checked' && <span style={{ color: 'var(--t3)' }}>{w.words}</span>}
      {w.state === 'not_checked' && !canCheck && <span style={{ color: 'var(--t4)' }}>{w.words}</span>}
      {canCheck && w.state !== 'checked' && <Btn small kind="primary" disabled={busy} onClick={check}>{busy ? 'Saving…' : 'Checked'}</Btn>}
      {itemId && <Btn small kind="soft" disabled={!signed} title={signed ? undefined : PPDS_NOT_CHECKED} onClick={() => setLabel(true)}>Print label</Btn>}
      {label && <BatchLabels siteId={siteId} mode="ppds" menuItemId={itemId} recipeId={recipeId} onClose={() => setLabel(false)} />}
    </div>
  );
}
