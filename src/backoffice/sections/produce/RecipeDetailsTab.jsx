// src/backoffice/sections/produce/RecipeDetailsTab.jsx
//
// MULTI SITE STOCK Drop 2 (mockup scrRecipe 'details', contract 3.2): the company fields of one
// recipe. Name, Kind (Dish, Batch, Prep), Type (Food, Drink, Meal deal with Food %), Made item
// (batch and prep: a search over the company stock items, with Make a new item), Yield, Portion
// weight (g), Cooking yield (%), Wastage (%), Shelf life (days), Target GP (%), Menu product (the
// Multi site menu product this recipe follows), Photo link, Method (one step per line).
// Save sends only what changed, with the version this screen loaded (stock_save_recipe): every site
// changes straight away, no publish. When someone saved first, SavedFirstModal shows the fields that
// differ and nothing is overwritten; "Save mine on top" sends this screen against their version.
// A login that cannot change company recipes sees every field greyed (never hidden) under the lock
// line drawn by RecipePage.
//
// v5.11.96 (multi site stock Drop 3, contract 3.4, F11): Kitchen only. For a batch or prep recipe in a
// company with a central kitchen, company editors see a 'Kitchen only' switch with the kitchen
// (stock_set_recipe_restricted): the recipe is then made only at that kitchen, its method and cost
// sit where site managers cannot read them, and the method box saves through stock_save_recipe_secret.
// Other logins see 'Made by <kitchen>. The method is kept by the kitchen.'

import { useMemo, useState } from 'react';
import { useStore } from '../../../store';
import { useStockScope } from '../../StockScope';
import { stockApi } from '../../../lib/stock/stockApi';
import { UNITS, DIMENSIONS } from '../../../lib/stock/units';
import { queuedNote } from '../../../lib/stock/itemPageRules';
import {
  KIND_CHOICES, FOOD_KIND_CHOICES, detailsDraft, detailsPatch, recipeFields, conflictRows, costSiteOf,
} from '../../../lib/stock/recipeRules';
import { Btn, Field, ui } from '../stock/stockUi';
import SavedFirstModal from '../stock/SavedFirstModal';
import AddItemModal from '../stock/items/AddItemModal';
import { ItemSearch, SearchPick } from './RecipeLinesEditor';
import { useCompanyKitchens } from '../stock/SiteKindCard';
import { Switch } from '../stock/stockUi';

const UNIT_OPTS = Object.entries(UNITS).map(([code, u]) => ({ code, ...u }));
const DIM_ORDER = [DIMENSIONS.COUNT, DIMENSIONS.WEIGHT, DIMENSIONS.VOLUME];
const off = (locked) => (locked ? { opacity: 0.55, cursor: 'not-allowed' } : null);
const MENU_PRODUCT_NOTE = 'Links the recipe to the group menu, so adding the product to a site in the Multi site menu ticks this recipe there.';

/** The yield unit box: every unit ServOS knows, by dimension. */
function UnitSelect({ value, onChange, disabled = false, style }) {
  return (
    <select value={value || ''} onChange={(e) => onChange(e.target.value)} disabled={disabled} aria-label="Yield unit" style={{ ...ui.input, ...off(disabled), ...style }}>
      {DIM_ORDER.map((dim) => (
        <optgroup key={dim} label={dim[0] + dim.slice(1).toLowerCase()}>
          {UNIT_OPTS.filter((u) => u.dimension === dim).map((u) => <option key={u.code} value={u.code}>{u.code}</option>)}
        </optgroup>
      ))}
    </select>
  );
}

/**
 * The Details fields, shared by the tab and create mode (RecipePage NewRecipe). draft is
 * recipeRules.detailsDraft's shape; onChange gets the whole next draft. menuProduct: the current
 * { id, name, menu_name } for the Menu product box's words.
 */
export function RecipeDetailsFields({ draft, onChange, locked = false, orgId = null, orgCtx = null, sitesOn = [], menuProduct = null }) {
  const [addItem, setAddItem] = useState(false);
  const [menuName, setMenuName] = useState(menuProduct?.name ? `${menuProduct.name}${menuProduct.menu_name ? ` (${menuProduct.menu_name})` : ''}` : '');
  const d = draft || detailsDraft(null);
  const upd = (k, v) => onChange?.({ ...d, [k]: v });
  const field = { ...ui.input, ...off(locked) };
  const made = d.kind !== 'dish';
  const searchMenuProducts = useMemo(() => async (text) => {
    if (typeof stockApi.menuProducts !== 'function') return [];
    const r = await stockApi.menuProducts(orgId, text || null, null);
    return (r.data?.rows || []).map((p) => ({ id: p.id, name: p.name, hint: `${p.menu_name || ''}${p.sites != null ? ` · ${p.sites} site${p.sites === 1 ? '' : 's'}` : ''}`.replace(/^ · /, ''), row: p }));
  }, [orgId]);

  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '0 16px', maxWidth: 980 }}>
        <Field label="Name"><input value={d.name} disabled={locked} onChange={(e) => upd('name', e.target.value)} style={field} aria-label="Name" /></Field>
        <Field label="Kind">
          <select value={d.kind} disabled={locked} onChange={(e) => upd('kind', e.target.value)} style={field} aria-label="Kind">
            {KIND_CHOICES.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
          </select>
        </Field>
        <Field label="Type">
          <select value={d.food_kind || ''} disabled={locked} onChange={(e) => upd('food_kind', e.target.value)} style={field} aria-label="Type">
            <option value="">Not set</option>
            {FOOD_KIND_CHOICES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </Field>
        {d.food_kind === 'meal_deal' && (
          <Field label="Food %" hint="How much of the deal is food; the rest is drink.">
            <input type="number" min="0" max="100" step="any" value={d.meal_food_pct} disabled={locked} onChange={(e) => upd('meal_food_pct', e.target.value)} style={field} aria-label="Food %" />
          </Field>
        )}
        {made && (
          <Field label="Made item" hint="The stock item this batch produces. Its cost rolls up from this recipe.">
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <ItemSearch orgId={orgId} label={d.output_item_name || ''} disabled={locked} placeholder="Search the company stock items"
                onPick={(it) => onChange?.({ ...d, output_item_id: it?.id || null, output_item_name: it?.name || '', yield_unit: it?.base_unit || d.yield_unit })} />
              {!locked && <Btn small kind="soft" onClick={() => setAddItem(true)}>Make a new item</Btn>}
            </div>
          </Field>
        )}
        <Field label="Yield" hint={made ? 'How much one batch makes (10 l, 20 each).' : 'A dish is 1 plate unless it makes more.'}>
          <div style={{ display: 'flex', gap: 6 }}>
            <input type="number" min="0" step="any" value={d.yield_qty} disabled={locked} onChange={(e) => upd('yield_qty', e.target.value)} style={{ ...field, width: 90 }} aria-label="Yield" />
            <UnitSelect value={d.yield_unit} onChange={(v) => upd('yield_unit', v)} disabled={locked} style={{ width: 'auto', flex: 1 }} />
          </div>
        </Field>
        <Field label="Portion weight (g)" hint="One portion as served. Kcal a portion comes from this.">
          <input type="number" min="0" step="any" value={d.portion_weight_g} disabled={locked} onChange={(e) => upd('portion_weight_g', e.target.value)} style={field} aria-label="Portion weight (g)" />
        </Field>
        <Field label="Cooking yield (%)" hint="What is left after cooking: 80 means a fifth cooks away.">
          <input type="number" min="0" max="100" step="any" value={d.cooking_yield_pct} disabled={locked} onChange={(e) => upd('cooking_yield_pct', e.target.value)} style={field} aria-label="Cooking yield (%)" />
        </Field>
        <Field label="Wastage (%)" hint="Added to the cost for trim and spills.">
          <input type="number" min="0" max="100" step="any" value={d.wastage_pct} disabled={locked} onChange={(e) => upd('wastage_pct', e.target.value)} style={field} aria-label="Wastage (%)" />
        </Field>
        <Field label="Shelf life (days)" hint="Sets the use by on labels.">
          <input type="number" min="0" step="1" value={d.shelf_life_days} disabled={locked} onChange={(e) => upd('shelf_life_days', e.target.value)} style={field} aria-label="Shelf life (days)" />
        </Field>
        <Field label="Target GP (%)">
          <input type="number" min="0" max="100" step="any" value={d.gp_target_pct} disabled={locked} onChange={(e) => upd('gp_target_pct', e.target.value)} style={field} aria-label="Target GP (%)" />
        </Field>
        <Field label="Menu product" hint={MENU_PRODUCT_NOTE}>
          <SearchPick label={menuName} placeholder="Search the group menu" search={searchMenuProducts} disabled={locked} allowClear clearWords="No menu product"
            onPick={(r) => { setMenuName(r ? `${r.name}${r.row?.menu_name ? ` (${r.row.menu_name})` : ''}` : ''); upd('msm_product_id', r?.id || null); }} />
        </Field>
        <Field label="Photo link" hint="A web link to the photo on the recipe card.">
          <input value={d.photo} disabled={locked} onChange={(e) => upd('photo', e.target.value)} style={field} aria-label="Photo link" placeholder="https://" />
        </Field>
      </div>
      <Field label="Method" hint="One step per line. Staff see them numbered on the recipe card." style={{ maxWidth: 980 }}>
        <textarea value={d.method} disabled={locked} onChange={(e) => upd('method', e.target.value)} style={{ ...field, minHeight: 90, resize: 'vertical' }} aria-label="Method" />
      </Field>
      {addItem && (
        <AddItemModal orgCtx={orgCtx} local={false} presetSites={sitesOn || []} onClose={() => setAddItem(false)}
          onSaved={(made) => { setAddItem(false); if (made?.id) onChange?.({ ...d, output_item_id: made.id, output_item_name: made.item?.name || 'New item', yield_unit: made.item?.base_unit || d.yield_unit }); }} />
      )}
    </>
  );
}

export default function RecipeDetailsTab({ detail, editable = false, reload, orgCtx = null }) {
  const sc = useStockScope();
  const showToast = useStore((s) => s.showToast);
  const recipe = useMemo(() => detail?.recipe || {}, [detail]);
  const orgId = recipe.org_id || sc.orgId || null;
  const locked = !editable;
  const [draft, setDraft] = useState(() => detailsDraft(recipe));
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(null);
  const say = (words, tone = 'success') => { try { showToast?.(words, tone); } catch { /* no toast, no harm */ } };
  const sitesOn = useMemo(() => (detail?.sites || []).filter((s) => s.on).map((s) => s.location_id), [detail]);
  const costSite = costSiteOf(detail, sc.homeSite);
  // v5.11.96 (Drop 3): Kitchen only
  const kitchens = useCompanyKitchens(sc);
  const restricted = recipe.restricted === true;
  const kitchenName = recipe.kitchen_name || sc.siteName?.(recipe.kitchen_location_id) || 'the central kitchen';
  const showKitchen = sc.multi && kitchens.length > 0 && (recipe.kind === 'batch' || recipe.kind === 'prep' || draft.kind === 'batch' || draft.kind === 'prep');

  // Someone saved first: read their version and list the fields where the two versions differ.
  // Nothing of theirs clashes with this screen: save again on their version, no question.
  const openConflict = async (c, again = true) => {
    const fresh = await stockApi.recipeDetail(recipe.id);
    const freshRecipe = fresh.data?.recipe || null;
    if (!freshRecipe) { say(fresh.error?.message || c.message || 'Someone saved this first. Reload it, then save again.', 'error'); return false; }
    const mine = recipeFields(draft).fields || {};
    const theirs = recipeFields({ ...detailsDraft(freshRecipe), name: freshRecipe.name || '(none)' }).fields || {};
    const names = { [recipe.output_item_id]: recipe.output_item_name, [freshRecipe.output_item_id]: freshRecipe.output_item_name, [draft.output_item_id]: draft.output_item_name };
    const rows = conflictRows(mine, theirs, undefined, { names });
    const version = fresh.data?.row_version ?? freshRecipe.row_version ?? c.row_version ?? null;
    if (!rows.length && again) return save(version, false, freshRecipe, false);
    setConflict({ byName: c.by_name || 'Someone', at: c.at || null, rows, version, fresh: freshRecipe });
    return false;
  };

  const save = async (versionOverride = null, onTop = false, base = recipe, again = true) => {
    const { patch, error } = detailsPatch(draft, base);
    if (error) { say(error, 'error'); return false; }
    if (!Object.keys(patch).length) {
      if (base !== recipe) { setConflict(null); say('Nothing to save: the recipe already says what this screen says.', 'info'); reload?.(); return !onTop; }
      say('Nothing changed.', 'info');
      return true;
    }
    setSaving(true);
    // v5.11.96 (Drop 3): a kitchen only recipe keeps its method with the kitchen (stock_save_recipe_secret)
    if (restricted && Object.prototype.hasOwnProperty.call(patch, 'method')) {
      const sec = await stockApi.saveRecipeSecret(recipe.id, patch.method ?? null, recipe.secret_row_version ?? null);
      if (sec.error) { setSaving(false); say(sec.error.message || 'The method did not save.', 'error'); return false; }
      delete patch.method;
      if (!Object.keys(patch).length) { setSaving(false); say('Saved. The method is kept by the kitchen.'); reload?.(); return true; }
    }
    const r = await stockApi.saveRecipe({ recipe: { id: recipe.id, location_id: costSite || undefined, ...patch }, version: versionOverride ?? detail?.row_version ?? recipe.row_version ?? null, section: 'produce' });
    setSaving(false);
    if (r.conflict) { await openConflict(r.conflict, again && !onTop); return false; }
    if (r.error) { say(r.error.message, 'error'); return false; }
    const note = queuedNote(r.queued);
    if (!onTop) say(`Saved. Changed at every site straight away.${note ? ` ${note}` : ''}`);
    setConflict(null);
    reload?.();
    return true;
  };

  return (
    <div style={ui.card}>
      {showKitchen && (
        <KitchenOnly recipe={recipe} editable={editable} kitchens={kitchens} restricted={restricted} kitchenName={kitchenName} reload={reload} say={say} />
      )}
      <RecipeDetailsFields draft={draft} onChange={setDraft} locked={locked || saving} orgId={orgId} orgCtx={orgCtx} sitesOn={sitesOn} menuProduct={detail?.menu_product || null} />
      {editable && (
        <div style={{ ...ui.row, marginTop: 4 }}>
          <Btn kind="primary" onClick={() => save()} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Btn>
        </div>
      )}
      {conflict && (
        <SavedFirstModal byName={conflict.byName} at={conflict.at} rows={conflict.rows} busy={saving}
          onKeepTheirs={() => { setConflict(null); reload?.(); }}
          onSaveMine={() => save(conflict.version, true, conflict.fresh || recipe, false)}
          onClose={() => setConflict(null)} />
      )}
    </div>
  );
}

// v5.11.96 (multi site stock Drop 3, F11): the Kitchen only switch and the kitchen it belongs to.
function KitchenOnly({ recipe, editable, kitchens, restricted, kitchenName, reload, say }) {
  const [kitchenId, setKitchenId] = useState(recipe.kitchen_location_id || kitchens[0]?.id || '');
  const [busy, setBusy] = useState(false);
  if (!editable) {
    if (!restricted) return null;
    return <div style={{ ...ui.sub, marginBottom: 12, color: 'var(--t2)' }}>Made by {kitchenName}. The method is kept by the kitchen.</div>;
  }
  const flip = async (on) => {
    if (on && !kitchenId) { say('Pick the kitchen first.', 'error'); return; }
    setBusy(true);
    const r = await stockApi.setRecipeRestricted(recipe.id, on, on ? kitchenId : (recipe.kitchen_location_id || kitchenId || null), recipe.row_version ?? null);
    setBusy(false);
    if (r.conflict) { say('Someone saved this recipe first. Reload it, then try again.', 'error'); return; }
    if (r.error) { say(r.error.message || 'It did not save.', 'error'); return; }
    say(on ? `Kitchen only. Made at ${kitchens.find((k) => k.id === kitchenId)?.name || 'the kitchen'}; other sites buy it from the kitchen.` : 'Every site can make this recipe again.');
    reload?.();
  };
  return (
    <div style={{ ...ui.row, flexWrap: 'wrap', marginBottom: 14, padding: '10px 12px', borderRadius: 10, background: 'var(--bg2)' }}>
      <Switch on={restricted} disabled={busy} onChange={flip} ariaLabel="Kitchen only" />
      <b style={{ color: 'var(--t1)' }}>Kitchen only</b>
      {kitchens.length > 1 ? (
        <select value={kitchenId} disabled={busy || restricted} onChange={(e) => setKitchenId(e.target.value)} aria-label="Kitchen" style={{ ...ui.input, width: 'auto' }}>
          {kitchens.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
        </select>
      ) : <span style={ui.sub}>{kitchens[0]?.name}</span>}
      <span style={ui.sub}>{restricted ? 'Method and cost sit where site managers cannot read them. Sites hold the batch as a bought in item.' : 'Only the kitchen makes it; other sites buy it from the kitchen.'}</span>
    </div>
  );
}
