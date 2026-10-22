// src/surfaces/kds/KdsRecipeCard.jsx
//
// The recipe card for staff on the kitchen screen (v5.11.91, multi site stock Drop 2, contract 3.6):
// opened from the Recipe button on an item in the ticket pop out. It reads stock_recipe_card with
// the KDS's own device session (the function's device branch: a bound kds, pos or handheld device
// at its own venue; anyone else is refused and the card says so). The build and the method in the
// KDS type scale, the allergens, may contain, kcal and use by; never a cost or a price.
//
// 'Print label': a PPDS label (name, the ingredient declaration with allergens in bold, made and
// use by) through the Label printer role (lib/labelPrint.js, lib/stock/batchLabel.js). It refuses
// until the facts were checked at this site: 'Check the allergens first. The label prints once the
// recipe is checked.'

import { useMemo, useState } from 'react';
import { kitchenClient, supabase } from '../../lib/supabase';
import { useRecipeCard, buildRows, cardSteps, cardKcalWords, useByWords, portionHeading, RECIPE_CARD_REFUSED } from '../../lib/recipeCard';
// useByFrom is a plain date helper, not a hook: renamed here so the hooks lint does not read it as one.
import { ppdsLabelDoc, useByFrom as labelUseByDate, labelCols } from '../../lib/stock/batchLabel.js';
import { printLabel } from '../../lib/labelPrint.js';
import { ALLERGENS } from '../../data/seed';
import { C, SANS, MONO, ghostBtn, monoLabel } from './kdsStyles';

const labelOf = (id) => ALLERGENS.find((a) => a.id === id)?.label || (id ? String(id).charAt(0).toUpperCase() + String(id).slice(1) : '');
const labels = (ids) => (Array.isArray(ids) ? ids : []).map(labelOf).filter(Boolean).join(', ');

export default function KdsRecipeCard({ locationId, menuItemId, onClose, onPrintLabel = null }) {
  const client = useMemo(() => kitchenClient() || supabase, []);
  const { card, loading, error } = useRecipeCard(locationId, menuItemId, { client });
  const [printWords, setPrintWords] = useState('');
  const [printing, setPrinting] = useState(false);

  const print = async () => {
    if (!card || printing) return;
    const madeAt = new Date();
    const doc = ppdsLabelDoc({
      name: card.name, ingredientsText: card.ingredients_text || '', allergens: card.allergens || [],
      madeAt, useBy: labelUseByDate(madeAt, card.use_by_days, null), venueTz: null, signedOff: card.signed_off === true,
    }, { cols: labelCols(null) });
    if (!doc || doc.error) {
      const words = doc?.error || 'The label could not be built.';
      setPrintWords(words);
      if (onPrintLabel) onPrintLabel({ ok: false, error: words });
      return;
    }
    setPrinting(true);
    setPrintWords('Printing');
    let r;
    try { r = await printLabel(doc, { label: `PPDS ${card.name}` }); } catch (e) { r = { ok: false, error: e?.message || 'The label did not print.' }; }
    setPrinting(false);
    setPrintWords(r?.ok ? 'Label sent to the printer.' : (r?.error || 'The label did not print.'));
    if (onPrintLabel) onPrintLabel(r);
  };

  const rows = buildRows(card);
  const steps = cardSteps(card?.method);
  const kcal = cardKcalWords(card);
  const useBy = useByWords(card);
  const body = { font: `600 22px/1.35 ${SANS}`, color: C.item };
  const muted = { font: `500 18px/1.35 ${SANS}`, color: C.meta1 };

  return (
    <div onClick={(e) => e.stopPropagation()} style={{
      position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, background: C.modal, zIndex: 2,
      display: 'flex', flexDirection: 'column', animation: 'kdsKfade .16s ease',
    }}>
      <div style={{ padding: '24px 32px 18px', display: 'flex', alignItems: 'flex-start', gap: 20, borderBottom: `1px solid ${C.line}`, flex: 'none' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={monoLabel}>RECIPE CARD</div>
          <div style={{ font: `800 34px/1.1 ${SANS}`, color: '#fff', marginTop: 6, overflowWrap: 'anywhere' }}>{card?.name || (loading ? 'Loading' : 'Recipe card')}</div>
          {card?.portion_words && <div style={{ ...muted, marginTop: 4 }}>{card.portion_words}</div>}
        </div>
        <button type="button" className="kds-ghost" onClick={onClose} style={ghostBtn(false)}>Close</button>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '22px 32px', display: 'flex', flexDirection: 'column', gap: 22 }}>
        {loading && <div style={muted}>Loading the recipe card.</div>}
        {!loading && !card && (
          <div style={body}>{error?.message === RECIPE_CARD_REFUSED ? 'This screen is not a bound kitchen device here, so it cannot show recipe cards.' : 'No recipe card for this item yet.'}</div>
        )}
        {card && (
          <>
            <div>
              <div style={monoLabel}>{portionHeading(card).toUpperCase()}</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
                {rows.length === 0 && <div style={muted}>No lines on this recipe.</div>}
                {rows.map((r, i) => (
                  <div key={i} style={{ display: 'flex', gap: 16, alignItems: 'baseline', paddingBottom: 8, borderBottom: `1px solid ${C.row}` }}>
                    <span style={{ font: `700 20px ${MONO}`, color: C.mods, minWidth: 120, textAlign: 'right', flex: 'none' }}>{r.words}</span>
                    <span style={{ ...body, flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{r.name}</span>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <div style={monoLabel}>METHOD</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 10 }}>
                {steps.length === 0 && <div style={muted}>{card.restricted ? 'The method is kept by head office.' : 'No method written yet.'}</div>}
                {steps.map((s, i) => (
                  <div key={i} style={{ display: 'flex', gap: 14 }}>
                    <span style={{ font: `700 18px ${MONO}`, color: C.meta2, flex: 'none', minWidth: 28, paddingTop: 3 }}>{i + 1}</span>
                    <span style={{ ...body, flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{s}</span>
                  </div>
                ))}
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ font: `700 20px ${MONO}`, color: C.allergen }}>Allergens: {labels(card.allergens) || 'none'}</div>
              {Array.isArray(card.may_contain) && card.may_contain.length > 0 && <div style={muted}>May contain: {labels(card.may_contain)}</div>}
              {kcal && <div style={muted}>{kcal} a portion</div>}
              {useBy && <div style={muted}>{useBy}</div>}
              <div style={muted}>{card.signed_off ? 'Allergens checked at this site.' : 'Allergens not checked at this site yet.'}</div>
            </div>
          </>
        )}
      </div>

      <div style={{ flex: 'none', padding: '18px 26px', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', borderTop: `1px solid ${C.line}`, background: 'rgba(255,255,255,.02)' }}>
        <button type="button" className="kds-ghost" onClick={onClose} style={ghostBtn(false)}>Close</button>
        <div style={{ flex: 1, minWidth: 0, ...muted, overflowWrap: 'anywhere' }}>{printWords}</div>
        {card && <button type="button" className="kds-ghost" onClick={print} disabled={printing} style={ghostBtn(false)}>Print label</button>}
      </div>
    </div>
  );
}
