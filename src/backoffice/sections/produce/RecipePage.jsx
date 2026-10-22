// src/backoffice/sections/produce/RecipePage.jsx
//
// MULTI SITE STOCK Drop 2 (mockup scrRecipe, contract 3.2): one company recipe. Only a multi site
// company ever sees it (sections/Recipes.jsx returns today's RecipesSite first for a one site
// company, so the one site check company keeps exactly today's screen).
//
//   Header   ‹ Recipes, the name (Local pill on a local recipe), '<Dish> · <Food> · sold as <names>
//            · target GP <n>%', Clone, Archive, Make it a company recipe (a local recipe, company
//            editors), and '<site> catching up' while queued saves run.
//   Tabs     Details | Ingredients | Sites | Allergens and nutrition | Recipe card | Changes. It
//            opens on Sites.
//   Data     one stock_recipe_detail read, read again after every save and on "Keep theirs".
//   Create   recipeId 'new': Details first, the lines, the Sites ticks pre ticked from the picker;
//            Save calls stock_save_recipe with { recipe, lines, sites } (one transaction: the company
//            recipe, every ingredient ticked at those sites) and opens the recipe on Ingredients.
//
// Who may change what: a company editor in Produce (a batch or prep recipe with a made item:
// Produce or Inventory). Everyone else sees the tabs read only under the lock line (the mockup's
// manager line) and the database refuses their saves (stock_co__guard, need 'company').

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../../store';
import { useStockScope } from '../../StockScope';
import { stockApi } from '../../../lib/stock/stockApi';
import { siteList, sortSites, checklistGroups } from '../../../lib/stock/itemListRules';
import { queuedNote } from '../../../lib/stock/itemPageRules';
import {
  recipeTabs, startTabOf, subLine, archiveWords, detailsDraft, recipeFields, toCompanyLines, sitesArg,
} from '../../../lib/stock/recipeRules';
import { Btn, Pill, PageHead, TabBar, CatchingUp, ErrorLine, Field, SiteChecklist, Notice, useConfirm, ui } from '../stock/stockUi';
import LockLine from '../stock/LockLine';
import RecipeDetailsTab, { RecipeDetailsFields } from './RecipeDetailsTab';
import RecipeIngredientsTab from './RecipeIngredientsTab';
import RecipeLinesEditor from './RecipeLinesEditor';
import RecipeSitesTab from './RecipeSitesTab';
import RecipeAllergensTab from './RecipeAllergensTab';
import RecipeCardTab from './RecipeCardTab';
import RecipeChangesTab from './RecipeChangesTab';
import CloneRecipeModal from './CloneRecipeModal';

const page = { ...ui.page, background: 'var(--bg0)', minHeight: '100%', boxSizing: 'border-box' };

export default function RecipePage({ recipeId, startTab = 'sites', focusSiteId = null, orgCtx, onBack, onOpenRecipe }) {
  const sc = useStockScope();
  const showToast = useStore((s) => s.showToast);
  const tabs = useMemo(() => recipeTabs(sc.multi), [sc.multi]);
  const [tab, setTab] = useState(() => startTabOf(recipeTabs(sc.multi), startTab));
  const [state, setState] = useState({ detail: null, error: null, loading: true });
  const [costAt, setCostAt] = useState('avg');
  const [cloneOpen, setCloneOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirm, confirmDialog] = useConfirm();
  const seq = useRef(0);
  const isNew = recipeId === 'new';
  const say = (words, tone = 'success') => { try { showToast?.(words, tone); } catch { /* no toast, no harm */ } };

  // the newest read wins: an older answer that lands late is dropped
  const take = useCallback((r, mine) => {
    if (mine !== seq.current) return;
    setState((old) => ({ detail: r.error ? old.detail : r.data, error: r.error || null, loading: false }));
  }, []);
  const load = useCallback(async () => {
    if (isNew) return;
    const mine = ++seq.current;
    take(await stockApi.recipeDetail(recipeId), mine);
  }, [recipeId, isNew, take]);
  useEffect(() => {
    if (isNew) return;
    const mine = ++seq.current;
    stockApi.recipeDetail(recipeId).then((r) => take(r, mine));
  }, [recipeId, isNew, take]);

  if (isNew) {
    return <NewRecipe orgCtx={orgCtx} focusSiteId={focusSiteId} onBack={onBack} onOpenRecipe={onOpenRecipe} />;
  }

  // a page opened on another recipe (Clone opens the copy) shows Loading until that recipe's read lands
  const detail = state.detail && state.detail.recipe?.id === recipeId ? state.detail : null;
  const recipe = detail?.recipe || null;

  if (!detail) {
    return (
      <div style={page}>
        <Btn small onClick={onBack}>‹ Recipes</Btn>
        <div style={{ marginTop: 14 }}>
          {state.loading ? <div style={{ padding: 16, color: 'var(--t3)', fontSize: 13 }}>Loading…</div> : <ErrorLine error={state.error} />}
        </div>
      </div>
    );
  }

  const madeItem = recipe.kind !== 'dish' && !!recipe.output_item_id;
  const editable = !!sc.canEditCompany('produce') || (madeItem && !!sc.canEditCompany('inventory'));
  const companyEditor = editable;
  const isLocal = !!recipe.local_location_id || detail.local === true;
  const localName = recipe.local_location_id ? (sc.siteName(recipe.local_location_id) || 'its site') : '';
  const version = detail.row_version ?? recipe.row_version ?? null;
  const soldAs = (detail.sites || []).filter((s) => s.on && s.menu_item_name).map((s) => s.menu_item_name);
  const mySite = focusSiteId || sc.oneSite?.id || (sc.sites || [])[0]?.id || null;
  const mySiteName = mySite ? (sc.siteName(mySite) || 'your site') : 'your site';

  const archive = async () => {
    const toArchive = !recipe.archived_at;
    if (toArchive) {
      const ok = await confirm({ title: archiveWords(recipe.name), words: 'Nothing is deleted. Sales of its till products then show under Recipe missing.', yes: 'Archive', no: 'Go back', danger: true });
      if (!ok) return;
    }
    setBusy(true);
    const r = await stockApi.archiveRecipe(recipe.id, version, toArchive, 'produce');
    setBusy(false);
    if (r.error) { say(r.error.message, 'error'); load(); return; }
    say(toArchive ? `${recipe.name} archived. Its history is kept.` : `${recipe.name} is back in the list.`);
    load();
  };
  const makeCompany = async () => {
    const ok = await confirm({ title: `Make ${recipe.name} a company recipe?`, words: `It stays on at ${localName}. You can then tick other sites on the Sites tab.`, yes: 'Make it a company recipe', no: 'Go back' });
    if (!ok) return;
    setBusy(true);
    const r = await stockApi.makeCompanyRecord('recipe', recipe.id, version);
    setBusy(false);
    if (r.error) { say(r.error.message, 'error'); load(); return; }
    say(`${recipe.name} is now a company recipe. It stays on at ${localName}.`);
    load();
  };

  const showLock = !editable && (tab === 'details' || tab === 'ingredients' || tab === 'sites');
  const common = { detail, editable, reload: load, focusSiteId, orgCtx };
  const title = (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <span>{recipe.name}</span>
      {isLocal && <Pill tone="blue" title={localName ? `Local to ${localName}` : undefined}>Local</Pill>}
      {recipe.archived_at && <Pill tone="neutral">Archived</Pill>}
    </span>
  );

  return (
    <div style={page}>
      <PageHead title={title} sub={subLine(recipe, soldAs)} back="‹ Recipes" onBack={onBack}>
        <CatchingUp entityIds={[recipe.id]} />
        {companyEditor && <Btn disabled={busy} onClick={() => setCloneOpen(true)}>Clone</Btn>}
        {editable && <Btn disabled={busy} onClick={archive}>{recipe.archived_at ? 'Restore' : 'Archive'}</Btn>}
        {isLocal && companyEditor && <Btn kind="soft" disabled={busy} onClick={makeCompany}>Make it a company recipe</Btn>}
      </PageHead>

      <div style={{ marginTop: 14 }}>
        <TabBar tabs={tabs} value={tab} onChange={setTab} />
      </div>

      <div style={{ marginTop: 14, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 12 }}>
        {state.error && <ErrorLine error={state.error} />}
        {showLock && (
          <div style={{ display: 'grid', gap: 8 }}>
            <div style={ui.lockline} data-testid="recipe-lock-line">🔒 Company recipe, set by head office. You see cost and GP for {mySiteName} and the recipe card.</div>
            <LockLine kind="company" entity="recipe" id={recipe.id} recordName={recipe.name} />
          </div>
        )}
        {tab === 'details' && <RecipeDetailsTab key={`details:${version ?? 0}`} {...common} />}
        {tab === 'ingredients' && <RecipeIngredientsTab key={`ingredients:${version ?? 0}`} {...common} costAt={costAt} setCostAt={setCostAt} />}
        {tab === 'sites' && <RecipeSitesTab {...common} />}
        {tab === 'allergens' && <RecipeAllergensTab detail={detail} editable={editable} />}
        {tab === 'card' && <RecipeCardTab detail={detail} focusSiteId={focusSiteId} />}
        {tab === 'changes' && <RecipeChangesTab recipeId={recipe.id} />}
      </div>

      {cloneOpen && (
        <CloneRecipeModal detail={detail} sites={sc.sites} onClose={() => setCloneOpen(false)}
          onDone={(newId) => { setCloneOpen(false); if (newId && onOpenRecipe) onOpenRecipe(newId, { tab: 'sites' }); else load(); }} />
      )}
      {confirmDialog}
    </div>
  );
}

/**
 * Create mode: the Details fields, the lines and the sites to start at (pre ticked from the picker).
 * One stock_save_recipe call with { recipe, lines, sites }: a company recipe, switched on at every
 * ticked site with every ingredient ticked there. Nothing is written until Save answers.
 */
function NewRecipe({ orgCtx, focusSiteId, onBack, onOpenRecipe }) {
  const sc = useStockScope();
  const showToast = useStore((s) => s.showToast);
  const say = (words, tone = 'success') => { try { showToast?.(words, tone); } catch { /* no toast, no harm */ } };
  const orgId = sc.orgId;
  const sites = useMemo(() => sortSites(siteList(sc.sites, sc.siteName)), [sc.sites, sc.siteName]);
  const groups = useMemo(() => checklistGroups(sc.groups, sites.map((s) => s.id)), [sc.groups, sites]);
  const preTicked = useMemo(() => {
    if (focusSiteId && sites.some((s) => s.id === focusSiteId)) return [focusSiteId];
    const inPicker = new Set((sc.scopeSites || []).map((s) => s.id));
    const ids = sites.filter((s) => inPicker.has(s.id)).map((s) => s.id);
    return ids.length ? ids : sites.map((s) => s.id);
  }, [sites, sc.scopeSites, focusSiteId]);
  const [draft, setDraft] = useState(() => detailsDraft(null));
  const [lines, setLines] = useState([]);
  const [view, setView] = useState('all');
  const [ids, setIds] = useState(preTicked);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);
  const editor = !!sc.canEditCompany('produce');

  const itemPicker = useMemo(() => ({
    search: async (text) => {
      const r = await stockApi.itemsPage({ orgId, sites: null, search: text || null, filters: null, after: null, limit: 20 });
      return (r.data?.rows || []).map((row) => ({ id: row.id, name: row.name + (row.name_suffix ? ` ${row.name_suffix}` : ''), hint: row.base_unit || '', ...row }));
    },
    detail: (itemId) => stockApi.itemDetail(itemId),
  }), [orgId]);

  const save = async () => {
    setProblem(null);
    const { fields, error } = recipeFields(draft);
    if (error) { setProblem(error); return; }
    const ticked = sites.filter((s) => ids.includes(s.id)).map((s) => s.id);
    if (!ticked.length) { setProblem('Tick at least one site.'); return; }
    const companyLines = toCompanyLines(lines);
    setBusy(true);
    const r = await stockApi.saveRecipe({ recipe: { ...fields, location_id: ticked[0] }, lines: companyLines, sites: sitesArg(ticked), version: null, section: 'produce' });
    setBusy(false);
    if (r.error) { setProblem(r.error.message); say(r.error.message, 'error'); return; }
    const refused = (r.data?.sites || []).filter((s) => s.refused);
    const note = queuedNote(r.queued);
    if (refused.length) say(`${fields.name} saved. ${refused.length} site${refused.length === 1 ? ' was' : 's were'} not switched on: ${refused[0].refused}`, 'warning');
    else say(`${fields.name} saved. On at ${ticked.length} site${ticked.length === 1 ? '' : 's'} with every ingredient ticked there.${note ? ` ${note}` : ''}`);
    const id = r.data?.id || null;
    if (id && onOpenRecipe) onOpenRecipe(id, { tab: 'ingredients' }); else onBack?.();
  };

  return (
    <div style={page}>
      <PageHead title="New recipe" sub="Give it a name and its ingredients, then tick the sites it starts at. Ingredients switch on at those sites by themselves." back="‹ Recipes" onBack={onBack} />
      {!editor && <div style={{ marginBottom: 12 }}><LockLine kind="company" entity={null} id={null} /></div>}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 12 }}>
        <div style={ui.card}>
          <RecipeDetailsFields draft={draft} onChange={setDraft} locked={!editor || busy} orgId={orgId} orgCtx={orgCtx} sitesOn={ids} />
        </div>
        <div style={ui.card}>
          <RecipeLinesEditor lines={lines} onChange={setLines} disabled={!editor || busy} recipeType={draft.kind === 'dish' ? 'MENU' : draft.kind === 'batch' ? 'BATCH' : 'PREP'}
            orderTypeView={view} onOrderTypeView={setView} lineCosts={{}} itemPicker={itemPicker} />
        </div>
        <div style={ui.card}>
          <Field label="Sites" hint="Pre ticked from the picker. Ticking a site also ticks every ingredient it needs there.">
            <SiteChecklist sites={sites} value={ids} onChange={setIds} groups={groups} />
          </Field>
          {problem && <Notice tone="bad">{problem}</Notice>}
          {editor && (
            <div style={{ ...ui.row, marginTop: 10 }}>
              <Btn kind="primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</Btn>
              <span style={ui.sub}>Link each site's till product on the Sites tab after this.</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
