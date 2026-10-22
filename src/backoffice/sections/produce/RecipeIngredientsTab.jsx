// src/backoffice/sections/produce/RecipeIngredientsTab.jsx
//
// MULTI SITE STOCK Drop 2 (mockup scrRecipe 'ingredients', contract 3.2): the lines of one company
// recipe and what they cost. 'Cost at' picks Company average or one site the recipe is on: the same
// recipe costed at any site, through stock_recipe_cost (the SQL twin of costing.js, so the figure
// equals the drainer and the reports). The cost table reads the saved lines; the editor below
// changes them and Save lines sends them all in one stock_save_recipe call (the company form).
// Make sizes (stock_make_sizes) and, for dishes, the option rules (RecipeOptionsEditor) sit under.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../../store';
import { useStockScope } from '../../StockScope';
import { stockApi } from '../../../lib/stock/stockApi';
import { money } from '../../../lib/currency';
import { queuedNote } from '../../../lib/stock/itemPageRules';
import {
  editorLinesOf, toCompanyLines, costAtOptions, costSiteOf, missingWords, totalLabel, perYieldLabel, kindToType, sizesMadeWords,
} from '../../../lib/stock/recipeRules';
import { Btn, TableWrap, Th, Td, ErrorLine, ui } from '../stock/stockUi';
import RecipeLinesEditor, { OrderTypeTag } from './RecipeLinesEditor';
import RecipeOptionsEditor from './RecipeOptionsEditor';
import MakeSizesModal from './MakeSizesModal';

const grey = { color: 'var(--t4)' };
const selectStyle = { ...ui.input, width: 'auto', minWidth: 180, padding: '7px 10px' };

/** The per line costs of one stock_recipe_cost answer, keyed by line id: a site, or the average over sites. */
function lineCostsOf(answer, siteName) {
  const rows = answer?.rows || [];
  const out = {};
  const sums = new Map();
  for (const row of rows) {
    const name = siteName?.(row.location_id) || '';
    for (const m of row.missing || []) out[m.line_id] = { cost: null, words: missingWords(m.why, name) };
    for (const l of row.lines || []) {
      if (l.cost == null) continue;
      const s = sums.get(l.line_id) || { total: 0, n: 0 };
      s.total += Number(l.cost); s.n += 1;
      sums.set(l.line_id, s);
    }
  }
  for (const [lineId, s] of sums) if (!out[lineId]) out[lineId] = { cost: s.n ? s.total / s.n : null, words: null };
  return out;
}

export default function RecipeIngredientsTab({ detail, editable = false, reload, costAt = 'avg', setCostAt }) {
  const sc = useStockScope();
  const showToast = useStore((s) => s.showToast);
  const say = (words, tone = 'success') => { try { showToast?.(words, tone); } catch { /* no toast, no harm */ } };
  const recipe = useMemo(() => detail?.recipe || {}, [detail]);
  const orgId = recipe.org_id || sc.orgId || null;
  const isDish = (recipe.kind || 'dish') === 'dish';
  const options = useMemo(() => costAtOptions(detail, sc.siteName), [detail, sc.siteName]);
  const at = options.some((o) => o.value === costAt) ? costAt : 'avg';
  const costSite = costSiteOf(detail, sc.homeSite);
  const cur = (sc.sites || []).find((s) => s.id === (at === 'avg' ? costSite : at))?.currency || undefined;

  const [lines, setLines] = useState(() => editorLinesOf(detail?.lines));
  const [view, setView] = useState('all');
  const [cost, setCost] = useState({ key: null, data: null, error: null });
  const [saving, setSaving] = useState(false);
  const [sizes, setSizes] = useState(false);
  const seq = useRef(0);

  // the cost of the SAVED lines at the chosen place, for the order type shown
  const costKey = JSON.stringify([recipe.id, at, view, detail?.row_version]);
  useEffect(() => {
    if (!recipe.id) return undefined;
    let live = true;
    const mine = ++seq.current;
    stockApi.recipeCost(recipe.id, at === 'avg' ? null : [at], isDish && view !== 'all' ? view : null).then((r) => {
      if (!live || mine !== seq.current) return;
      setCost({ key: costKey, data: r.data || null, error: r.error || null });
    });
    return () => { live = false; };
  }, [recipe.id, at, view, isDish, costKey]);

  const costReady = cost.key === costKey;
  const lineCosts = useMemo(() => (costReady ? lineCostsOf(cost.data, sc.siteName) : {}), [costReady, cost.data, sc.siteName]);
  const total = useMemo(() => {
    if (!costReady || !cost.data) return { total: null, perYield: null, missing: 0 };
    const rows = cost.data.rows || [];
    if (at !== 'avg') {
      const row = rows[0];
      return { total: row?.total ?? null, perYield: row?.per_yield ?? null, missing: (row?.missing || []).length };
    }
    const ok = rows.filter((r) => r.total != null);
    const avg = cost.data.avg ?? (ok.length ? ok.reduce((a, r) => a + Number(r.total), 0) / ok.length : null);
    const per = ok.length ? ok.reduce((a, r) => a + Number(r.per_yield || 0), 0) / ok.length : null;
    return { total: avg, perYield: per, missing: rows.length - ok.length };
  }, [costReady, cost.data, at]);

  const dirty = useMemo(() => JSON.stringify(toCompanyLines(lines)) !== JSON.stringify(toCompanyLines(editorLinesOf(detail?.lines))), [lines, detail]);
  const itemPicker = useMemo(() => ({
    search: async (text) => {
      const r = await stockApi.itemsPage({ orgId, sites: null, search: text || null, filters: null, after: null, limit: 20 });
      return (r.data?.rows || []).map((row) => ({ id: row.id, name: row.name + (row.name_suffix ? ` ${row.name_suffix}` : ''), hint: row.base_unit || '', ...row }));
    },
    detail: (itemId) => stockApi.itemDetail(itemId),
  }), [orgId]);

  const saveLines = async () => {
    const companyLines = toCompanyLines(lines);
    if (!companyLines.length) { say('A recipe needs at least one ingredient with an amount above 0.', 'error'); return; }
    setSaving(true);
    const r = await stockApi.saveRecipe({ recipe: { id: recipe.id, location_id: costSite || undefined }, lines: companyLines, version: detail?.row_version ?? recipe.row_version ?? null, section: 'produce' });
    setSaving(false);
    if (r.conflict) { say(r.error?.message || 'Someone saved this recipe first. It is read again: check the lines, then save.', 'error'); reload?.(); return; }
    if (r.error) { say(r.error.message, 'error'); return; }
    const note = queuedNote(r.queued);
    say(`Saved. Changed at every site straight away.${note ? ` ${note}` : ''}`);
    reload?.();
  };

  const savedLines = detail?.lines || [];
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 12 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <label htmlFor="recipe-cost-at" style={{ ...ui.label, marginBottom: 0 }}>Cost at</label>
        <select id="recipe-cost-at" value={at} onChange={(e) => setCostAt?.(e.target.value)} style={selectStyle}>
          {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <span style={ui.sub}>See the same recipe costed at any site.</span>
      </div>

      {cost.error && costReady && <ErrorLine error={cost.error} />}
      <TableWrap minWidth={620}>
        <thead>
          <tr><Th>Ingredient</Th><Th>Amount</Th><Th>Tag</Th><Th right>Cost</Th></tr>
        </thead>
        <tbody>
          {savedLines.length === 0 && <tr><Td grey>No ingredients saved yet. Add them below and press Save lines.</Td><Td /><Td /><Td /></tr>}
          {savedLines.map((l) => {
            const lc = lineCosts[l.id] || null;
            return (
              <tr key={l.id}>
                <Td strong>{l.name}{l.kind_at_site === 'MADE' && <span style={{ ...grey, fontWeight: 400 }}> (batch)</span>}</Td>
                <Td>{l.qty} {l.pack_id ? (l.pack_name || 'pack') : l.unit}{l.usable_pct != null && Number(l.usable_pct) !== 100 ? <span style={grey}> · {l.usable_pct}% usable</span> : null}</Td>
                <Td><OrderTypeTag orderTypes={l.order_types} /></Td>
                <Td right num>{!costReady ? <span style={grey}>…</span> : lc?.words ? <span style={{ color: 'var(--red)' }}>{lc.words}</span> : lc?.cost != null ? money(lc.cost, cur) : <span style={grey}>Not costed</span>}</Td>
              </tr>
            );
          })}
          {savedLines.length > 0 && (
            <tr>
              <Td strong>{totalLabel(recipe)}</Td>
              <Td>{total.missing > 0 && costReady ? <span style={{ color: 'var(--red)', fontSize: 12 }}>{total.missing} {total.missing === 1 ? 'line' : 'lines'} not costed</span> : null}</Td>
              <Td />
              <Td right num strong>{!costReady ? '…' : total.total != null ? money(total.total, cur) : <span style={grey}>Not costed</span>}</Td>
            </tr>
          )}
          {savedLines.length > 0 && !isDish && (
            <tr>
              <Td strong>{perYieldLabel(recipe, savedLines[0]?.base_unit)}</Td>
              <Td /><Td />
              <Td right num strong>{!costReady ? '…' : total.perYield != null ? money(total.perYield, cur) : <span style={grey}>Not costed</span>}</Td>
            </tr>
          )}
        </tbody>
      </TableWrap>
      {recipe.wastage_pct != null && Number(recipe.wastage_pct) > 0 && <div style={ui.sub}>Wastage of {recipe.wastage_pct}% is in the total.</div>}

      <div style={ui.card}>
        <RecipeLinesEditor lines={lines} onChange={setLines} disabled={!editable || saving} recipeType={kindToType(recipe.kind)}
          orderTypeView={view} onOrderTypeView={setView} lineCosts={lineCosts} itemPicker={itemPicker} />
        {editable && (
          <div style={{ ...ui.row, marginTop: 14, flexWrap: 'wrap' }}>
            <Btn kind="primary" onClick={saveLines} disabled={saving || !dirty}>{saving ? 'Saving…' : 'Save lines'}</Btn>
            {dirty && <Btn onClick={() => setLines(editorLinesOf(detail?.lines))} disabled={saving}>Undo changes</Btn>}
            <span style={{ flex: 1 }} />
            <Btn kind="soft" onClick={() => setSizes(true)} disabled={saving || !savedLines.length}>Make sizes</Btn>
          </div>
        )}
      </div>

      {isDish && <RecipeOptionsEditor detail={detail} editable={editable} reload={reload} />}
      <div style={ui.sub}>Options set here: "Oat milk replaces Whole milk", "No cheese removes Cheddar". Make sizes from this recipe by a factor.</div>

      {sizes && (
        <MakeSizesModal detail={detail} onClose={() => setSizes(false)}
          onDone={(res) => { setSizes(false); const n = (res?.recipes || []).length; say(sizesMadeWords(n)); reload?.(); }} />
      )}
    </div>
  );
}
