// src/backoffice/sections/produce/CloneRecipeModal.jsx
//
// MULTI SITE STOCK Drop 2 (map 4.5 A16, contract 3.2): a copy of a company recipe with every line,
// named '<name> (copy)' unless typed, on the sites ticked here (pre ticked from the recipe's own
// sites). One stock_save_recipe call with { recipe, lines, sites }: the copy, its lines and every
// ingredient ticked at those sites, in one transaction. No till link is made: the Sites tab links
// each site's till product. No menu product either (one product follows one recipe).

import { useMemo, useState } from 'react';
import { useStore } from '../../../store';
import { useStockScope } from '../../StockScope';
import { stockApi } from '../../../lib/stock/stockApi';
import { checklistGroups } from '../../../lib/stock/itemListRules';
import { cloneFields, editorLinesOf, toCompanyLines, sitesArg } from '../../../lib/stock/recipeRules';
import { Btn, Modal, Field, SiteChecklist, Notice, ui } from '../stock/stockUi';

const NOTE = 'A copy of this recipe with every line. Tick the sites it starts at. Link its till product on the Sites tab.';

export default function CloneRecipeModal({ detail, sites, onDone, onClose }) {
  const sc = useStockScope();
  const showToast = useStore((s) => s.showToast);
  const recipe = detail?.recipe || {};
  const list = useMemo(() => (sites || sc.sites || []).map((s) => ({ id: s.id, name: s.name })), [sites, sc.sites]);
  const groups = useMemo(() => checklistGroups(sc.groups, list.map((s) => s.id)), [sc.groups, list]);
  const preTicked = useMemo(() => {
    const on = new Set((detail?.sites || []).filter((s) => s && s.on).map((s) => s.location_id));
    const ids = list.filter((s) => on.has(s.id)).map((s) => s.id);
    return ids.length ? ids : list.slice(0, 1).map((s) => s.id);
  }, [list, detail]);
  const [name, setName] = useState(`${recipe.name || 'Recipe'} (copy)`);
  const [ids, setIds] = useState(preTicked);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);
  const say = (words, tone = 'success') => { try { showToast?.(words, tone); } catch { /* no toast, no harm */ } };

  const run = async () => {
    setProblem(null);
    if (!name.trim()) { setProblem('Give the copy a name.'); return; }
    const ticked = list.filter((s) => ids.includes(s.id)).map((s) => s.id);
    if (!ticked.length) { setProblem('Tick at least one site.'); return; }
    const fields = cloneFields(detail, name);
    if (!fields) { setProblem('This recipe cannot be copied as it is: check its Details first.'); return; }
    setBusy(true);
    const r = await stockApi.saveRecipe({ recipe: { ...fields, location_id: ticked[0] }, lines: toCompanyLines(editorLinesOf(detail?.lines)), sites: sitesArg(ticked), version: null, section: 'produce' });
    setBusy(false);
    if (r.error || !r.data?.id) { setProblem(r.error?.message || 'The copy did not save. Try again.'); return; }
    const refused = (r.data?.sites || []).filter((s) => s.refused);
    const n = ticked.length - refused.length;
    if (refused.length) say(`${name.trim()} saved. Not switched on at ${refused.length} site${refused.length === 1 ? '' : 's'}: ${refused[0].refused}`, 'warning');
    else say(`${name.trim()} saved. On at ${n} site${n === 1 ? '' : 's'} with every ingredient ticked there.`);
    onDone?.(r.data.id);
  };

  return (
    <Modal title={`Clone ${recipe.name || 'recipe'}`} sub={NOTE} onClose={busy ? () => {} : onClose} width={560}
      footer={<><span style={{ flex: 1 }} /><Btn onClick={onClose} disabled={busy}>Cancel</Btn><Btn kind="primary" onClick={run} disabled={busy}>{busy ? 'Saving…' : 'Clone'}</Btn></>}>
      <Field label="Name">
        <input value={name} onChange={(e) => setName(e.target.value)} style={ui.input} aria-label="Name" />
      </Field>
      <Field label="Sites" hint="Pre ticked from this recipe's sites.">
        <SiteChecklist sites={list} value={ids} onChange={setIds} groups={groups} />
      </Field>
      {problem && <Notice tone="bad">{problem}</Notice>}
    </Modal>
  );
}
