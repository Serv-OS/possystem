// src/backoffice/sections/produce/RecipeCardTab.jsx
//
// MULTI SITE STOCK Drop 2 (mockup scrRecipe 'recipe', map 5.2, contract 3.2): the recipe card for
// staff, as the till item info, the KDS and the phone show it (stock_recipe_card): the photo, the
// build in the units as written, the numbered method steps, allergens and kcal. Never a cost. It is
// read for the focus site, else the cost site; another site can be picked, because a batch inside
// the build is named by what that site holds.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useStockScope } from '../../StockScope';
import { stockApi } from '../../../lib/stock/stockApi';
import { allergenWords, cardSteps, costSiteOf } from '../../../lib/stock/recipeRules';
import { Pill, ErrorLine, EmptyLine, ui } from '../stock/stockUi';

const NOTE = 'Shown from the item on the till, on the KDS (tap the item) and on the phone.';
const selectStyle = { ...ui.input, width: 'auto', minWidth: 160, padding: '6px 10px' };

export default function RecipeCardTab({ detail, focusSiteId = null }) {
  const sc = useStockScope();
  const recipe = detail?.recipe || {};
  const sitesOn = useMemo(() => (detail?.sites || []).filter((s) => s && s.on), [detail]);
  const first = (focusSiteId && sitesOn.some((s) => s.location_id === focusSiteId)) ? focusSiteId : costSiteOf(detail, sc.homeSite);
  const [siteId, setSiteId] = useState(first);
  const [state, setState] = useState({ key: null, card: null, error: null });
  const seq = useRef(0);
  const key = `${recipe.id}|${siteId}|${detail?.row_version ?? ''}`;

  useEffect(() => {
    if (!recipe.id || !siteId) return undefined;
    let live = true;
    const mine = ++seq.current;
    stockApi.recipeCard(siteId, { recipeId: recipe.id }).then((r) => {
      if (!live || mine !== seq.current) return;
      setState({ key, card: r.error ? null : r.data, error: r.error || null });
    });
    return () => { live = false; };
  }, [recipe.id, siteId, key]);

  const ready = state.key === key;
  const card = ready ? state.card : null;
  const steps = card ? (Array.isArray(card.method) ? card.method : cardSteps(card.method)) : cardSteps(recipe.method);
  const build = card?.build || [];

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 12 }}>
      {sitesOn.length > 1 && (
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <label htmlFor="recipe-card-site" style={{ ...ui.label, marginBottom: 0 }}>Card at</label>
          <select id="recipe-card-site" value={siteId || ''} onChange={(e) => setSiteId(e.target.value)} style={selectStyle}>
            {sitesOn.map((s) => <option key={s.location_id} value={s.location_id}>{s.name || sc.siteName(s.location_id)}</option>)}
          </select>
        </div>
      )}
      {ready && <ErrorLine error={state.error} />}
      <div style={ui.card}>
        {!ready ? <EmptyLine>Loading…</EmptyLine> : (
          <div style={{ display: 'grid', gridTemplateColumns: card?.photo ? 'minmax(0, 1fr) 220px' : 'minmax(0, 1fr)', gap: 18 }}>
            <div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <div style={{ fontSize: 15, fontWeight: 800 }}>Recipe card for staff</div>
                {card?.restricted && <Pill tone="neutral">Restricted</Pill>}
                {card && (card.signed_off ? <Pill tone="good">Allergens checked</Pill> : <Pill tone="neutral">Allergens not checked yet</Pill>)}
              </div>
              <div style={{ ...ui.sub, marginTop: 2 }}>{card?.name || recipe.name}{card?.portion_words ? ` · ${card.portion_words}` : ''}{card?.use_by_days != null ? ` · use within ${card.use_by_days} day${Number(card.use_by_days) === 1 ? '' : 's'}` : ''}</div>

              <div style={{ marginTop: 12 }}>
                <div style={ui.label}>Build</div>
                {build.length === 0 ? <div style={ui.sub}>No ingredients on the card yet.</div> : (
                  <ul style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 3, fontSize: 13.5 }}>
                    {build.map((b, i) => <li key={`${b.name}|${i}`}><b>{b.qty}{b.unit ? ` ${b.unit}` : ''}</b> {b.name}</li>)}
                  </ul>
                )}
              </div>

              <div style={{ marginTop: 12 }}>
                <div style={ui.label}>Method</div>
                {card?.restricted && !steps.length ? <div style={ui.sub}>The method of a restricted recipe is not shown at this site.</div>
                  : steps.length === 0 ? <div style={ui.sub}>No method written yet. Type one on the Details tab, one step per line.</div> : (
                    <ol style={{ margin: 0, paddingLeft: 20, display: 'grid', gap: 4, fontSize: 13.5, lineHeight: 1.5 }}>
                      {steps.map((s, i) => <li key={i}>{s}</li>)}
                    </ol>
                  )}
              </div>

              {card && (
                <div style={{ marginTop: 12, display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 13 }}>
                  <span><span style={{ color: 'var(--t3)' }}>Allergens</span> <b>{allergenWords(card.allergens) || 'none from the ingredients yet'}</b></span>
                  {(card.may_contain || []).length > 0 && <span><span style={{ color: 'var(--t3)' }}>May contain</span> <b>{allergenWords(card.may_contain)}</b></span>}
                  {card.kcal != null && <span><span style={{ color: 'var(--t3)' }}>Kcal a portion</span> <b>{Math.round(Number(card.kcal))}</b></span>}
                </div>
              )}
            </div>
            {card?.photo && (
              <div>
                <img src={card.photo} alt={`${card.name || recipe.name} as served`} style={{ width: '100%', borderRadius: 12, border: '1px solid var(--bdr)', objectFit: 'cover' }} />
              </div>
            )}
          </div>
        )}
      </div>
      <div style={ui.sub}>{NOTE}</div>
    </div>
  );
}
