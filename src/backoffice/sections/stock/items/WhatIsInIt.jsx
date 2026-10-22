// src/backoffice/sections/stock/items/WhatIsInIt.jsx
//
// MULTI SITE STOCK Drop 2 (contract 3.4, 4.4): what is in one supplier item. Opened from the
// 'What is in it' expander under a supplier row on the item's Suppliers tab. Each site's allergens
// come from what that site actually buys, so the facts live on the supplier item, never on the
// stock item: the 14 allergens, May contain, Diets, the ingredient list in weight order, nutrition
// per 100 g, and who checked it and when.
//   Save  stock_save_supplier_item with { id, location_id, allergens, may_contain, diets,
//         ingredients_text, nutrition } and the row version this screen read. The database clears
//         'checked', rolls the allergens up to the item and rebuilds the facts of every till product
//         whose recipe uses the item, at every site. Toast: 'Saved. Every recipe using <item> at
//         every site now shows these allergens.'
// A login that cannot change company records sees every field greyed under the lock line drawn by
// ItemPage (never hidden). An allergen is never taken off anywhere by itself: the recipe facts keep
// the union and ask someone to check (the database's rule).

import { useMemo, useState } from 'react';
import { useStore } from '../../../../store';
import { useStockScope } from '../../../StockScope';
import { stockApi } from '../../../../lib/stock/stockApi';
import { homeSiteOf, queuedNote } from '../../../../lib/stock/itemPageRules';
import {
  ALLERGEN_CHIPS, DIETS, NUTRITION_FIELDS, factsOf, factsDraft, factsPatch, checkedWords, savedFactsWords,
} from '../../../../lib/stock/factsRules';
import { Btn, Pill, Field, Notice, ui } from '../stockUi';

const chipStyle = (on, locked) => ({
  fontSize: 12, padding: '5px 10px', borderRadius: 6, cursor: locked ? 'not-allowed' : 'pointer', fontFamily: 'inherit',
  background: on ? 'var(--bg3)' : 'var(--bg2)', color: on ? 'var(--t1)' : 'var(--t3)', border: `1px solid ${on ? 'var(--acc)' : 'var(--bdr)'}`,
  opacity: locked ? 0.55 : 1,
});

/** Tick chips: options [{ id, label }], value [ids]. */
function Chips({ options, value, onChange, locked, label }) {
  const list = Array.isArray(value) ? value : [];
  return (
    <div role="group" aria-label={label} style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      {options.map((o) => {
        const on = list.includes(o.id);
        return (
          <button key={o.id} type="button" disabled={locked} aria-pressed={on} style={chipStyle(on, locked)}
            onClick={() => onChange(on ? list.filter((x) => x !== o.id) : [...list, o.id])}>
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export default function WhatIsInIt({ detail, supplierItem, editable = false, reload, onMakeNewItem = null, tz = null }) {
  const sc = useStockScope();
  const showToast = useStore((s) => s.showToast);
  const item = detail?.item || {};
  const si = useMemo(() => supplierItem || {}, [supplierItem]);
  const facts = useMemo(() => factsOf(si), [si]);
  const [draft, setDraft] = useState(() => factsDraft(si));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);
  const siteIds = useMemo(() => (sc.sites || []).map((s) => s.id), [sc.sites]);
  const homeSiteId = homeSiteOf(detail, siteIds, sc.homeSite);
  const locked = !editable || !!si.archived_at;
  const upd = (k, v) => setDraft((d) => ({ ...d, [k]: v }));
  const updNutrition = (k, v) => setDraft((d) => ({ ...d, nutrition: { ...d.nutrition, [k]: v } }));
  const say = (words, tone = 'success') => { try { showToast?.(words, tone); } catch { /* no toast, no harm */ } };
  const { changed } = factsPatch(draft, si);
  const field = { ...ui.input, ...(locked ? { opacity: 0.55, cursor: 'not-allowed' } : null) };

  const save = async () => {
    setProblem(null);
    const { patch, changed: dirty, error } = factsPatch(draft, si);
    if (error) { setProblem(error); return; }
    if (!dirty) { say('Nothing changed.', 'info'); return; }
    setBusy(true);
    const r = await stockApi.saveSupplierItem({ id: si.id, location_id: homeSiteId || undefined, ...patch }, si.row_version ?? null, 'inventory');
    setBusy(false);
    if (r.error) { setProblem(r.error.message); return; }
    const note = queuedNote(r.queued);
    say(`${savedFactsWords(item.name)}${note ? ` ${note}` : ''}`);
    reload?.();
  };

  return (
    <div style={{ padding: '12px 14px 14px', background: 'var(--bg2)', borderTop: '1px solid var(--bdr)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)' }}>What is in it</div>
        <div style={ui.sub}>{si.supplier_name ? `${si.supplier_name}'s ${item.name || 'item'}` : item.name}</div>
        <span style={{ flex: 1 }} />
        {facts.checked_at
          ? <span style={{ fontSize: 12.5, color: 'var(--t2)' }}>{checkedWords(facts.checked_by_name, facts.checked_at, tz)}</span>
          : <Pill tone="neutral">Not checked yet</Pill>}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '0 18px' }}>
        <div>
          <Field label="Allergens" hint="What the pack says it contains.">
            <Chips options={ALLERGEN_CHIPS} value={draft.allergens} onChange={(v) => upd('allergens', v)} locked={locked} label="Allergens" />
          </Field>
          <Field label="May contain" hint="Traces the pack warns about.">
            <Chips options={ALLERGEN_CHIPS} value={draft.may_contain} onChange={(v) => upd('may_contain', v)} locked={locked} label="May contain" />
          </Field>
          <Field label="Diets" hint="A dish is only vegan when every ingredient is.">
            <Chips options={DIETS} value={draft.diets} onChange={(v) => upd('diets', v)} locked={locked} label="Diets" />
          </Field>
        </div>
        <div>
          <Field label="Ingredients (in weight order)" hint="As printed on the pack. Used for the ingredient declaration on labels.">
            <textarea value={draft.ingredients_text} disabled={locked} onChange={(e) => upd('ingredients_text', e.target.value)}
              aria-label="Ingredients (in weight order)" style={{ ...field, minHeight: 72, resize: 'vertical' }} />
          </Field>
          <Field label="Nutrition per 100 g" hint="Or per 100 ml for a drink. Leave a box empty when the pack does not say.">
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: '8px 10px' }}>
              {NUTRITION_FIELDS.map((f) => (
                <label key={f.key} style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 11.5, color: 'var(--t3)' }}>
                  <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{f.label}{f.key === 'kcal' ? '' : ' (g)'}</span>
                  <input type="number" min="0" step="any" inputMode="decimal" value={draft.nutrition[f.key]} disabled={locked}
                    onChange={(e) => updNutrition(f.key, e.target.value)} aria-label={`${f.label} per 100 g`} style={{ ...field, padding: '6px 8px' }} />
                </label>
              ))}
            </div>
          </Field>
        </div>
      </div>

      {problem && <div style={{ marginBottom: 10 }}><Notice tone="bad">{problem}</Notice></div>}
      <div style={{ ...ui.row, flexWrap: 'wrap' }}>
        {editable && !si.archived_at && (
          <Btn kind="primary" small onClick={save} disabled={busy || !changed}>{busy ? 'Saving…' : 'Save'}</Btn>
        )}
        {editable && !si.archived_at && typeof onMakeNewItem === 'function' && (
          <Btn kind="ghost" small disabled={busy} onClick={() => onMakeNewItem(si)}>Make it a new item</Btn>
        )}
        <span style={{ flex: 1 }} />
        <span style={ui.sub}>Every site that buys this pack gets these facts in its recipes.</span>
      </div>
    </div>
  );
}
