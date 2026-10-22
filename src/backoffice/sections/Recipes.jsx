/**
 * Recipes (Produce > Recipes): the router (multi site stock Drop 2, v5.11.91, contract 3.1).
 *
 *   scope not loaded yet  the Loading line
 *   one site company      RecipesSite: today's screen, field for field and word for word, plus the
 *                         read only allergen line and the Checked button under the ingredient lines
 *                         (src/lib/stock/oneSiteIdentityRecipes.test.js proves the rest is main's text)
 *   a recipe open         RecipePage (Details, Ingredients, Sites, Allergens and nutrition, Card,
 *                         Changes); 'new' is a new recipe
 *   otherwise             RecipeList: All recipes and Recipe missing for the sites in the picker
 *                         (on one picked site it is the list in its one site shape)
 *
 * Non editors see the company screens read only under the lock line; the database refuses their
 * saves. No StockSiteGate: on All sites the router shows the company view.
 */

import { useEffect, useState } from 'react';
import { useStockScope } from '../StockScope';
import RecipesSite from './produce/RecipesSite';
import RecipeList from './produce/RecipeList';
import RecipePage from './produce/RecipePage';

/**
 * Another screen asked for one recipe (an item's Used in tab, through go('recipes', { open })): it is
 * taken once and opened, so a later visit starts on the list. Multi site companies only.
 */
function OpenOnArrival({ take, onOpen }) {
  useEffect(() => { const o = take?.('recipes'); if (o?.recipeId) onOpen(o); }, [take, onOpen]);
  return <div style={{ padding: 16, color: 'var(--t3)', fontSize: 13 }}>Loading…</div>;
}

export default function Recipes({ orgCtx = null, siteId = null } = {}) {
  const sc = useStockScope();
  const [open, setOpen] = useState(null); // { recipeId, tab, siteId } ('new' for a new recipe)
  if (!sc.ready) return <div style={{ padding: 16, color: 'var(--t3)', fontSize: 13 }}>Loading…</div>;
  if (!sc.multi) return <RecipesSite siteId={siteId} />;
  if (!open && sc.peekOpen?.('recipes')?.recipeId) return <OpenOnArrival take={sc.takeOpen} onOpen={setOpen} />;
  if (open) return <RecipePage recipeId={open.recipeId} startTab={open.tab || 'sites'} focusSiteId={open.siteId || null} orgCtx={orgCtx} onBack={() => setOpen(null)} onOpenRecipe={(recipeId, opts = {}) => setOpen({ recipeId, ...opts })} />;
  return <RecipeList orgCtx={orgCtx} onOpen={(recipeId, opts = {}) => setOpen({ recipeId, ...opts })} />;
}
