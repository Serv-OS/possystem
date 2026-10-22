// src/backoffice/sections/produce/SwapIngredientModal.jsx
//
// MULTI SITE STOCK Drop 2 (contract 3.2, 1.8): swap one ingredient for another, or change its
// amount, across many recipes at once (stock_swap_ingredient). Swap | Change amount; From and To;
// an amount and unit or a factor; every recipe using it or chosen recipes. Preview first: the
// table says each recipe's line before and after, how many sites it is on, and any line the new
// item cannot take ('Give the amount in a unit <item> uses.'). Apply changes each recipe through
// the recipe writer (the facts and today's costs refreshed); over 200 recipes the rest are queued
// and this dialog follows the jobs until they are done.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../../store';
import { stockApi } from '../../../lib/stock/stockApi';
import { pollJobs } from '../../../lib/stock/companyData';
import { UNITS } from '../../../lib/stock/units';
import { jobIdsOf, jobsProgress } from '../../../lib/stock/itemListRules';
import { swapSpec, swapWords, lineWords } from '../../../lib/stock/recipeRules';
import { useStockScope } from '../../StockScope';
import { Btn, Modal, Segmented, Field, Notice, TableWrap, Th, Td, ui } from '../stock/stockUi';
import { ItemSearch, SearchPick } from './RecipeLinesEditor';

const UNIT_CODES = Object.keys(UNITS);
const BLANK = Object.freeze({ mode: 'swap', fromItemId: null, fromName: '', fromUnit: '', toItemId: null, toName: '', scope: 'all', recipes: [], amountHow: 'qty', qty: '', unit: '', factor: '' });

export default function SwapIngredientModal({ orgId, fromItem = null, onDone, onClose }) {
  const sc = useStockScope();
  const showToast = useStore((s) => s.showToast);
  const say = (words, tone = 'success') => { try { showToast?.(words, tone); } catch { /* no toast, no harm */ } };
  const [form, setForm] = useState(() => ({ ...BLANK, fromItemId: fromItem?.id || null, fromName: fromItem?.name || '', fromUnit: fromItem?.base_unit || '', unit: fromItem?.base_unit || '' }));
  const [preview, setPreview] = useState(null);   // { rows, total, words }
  const [busy, setBusy] = useState(null);   // 'preview' | 'apply' | null
  const [problem, setProblem] = useState(null);
  const [jobs, setJobs] = useState(null);   // { ids, rows }
  const stopRef = useRef(null);
  const upd = (patch) => { setForm((f) => ({ ...f, ...patch })); setPreview(null); setProblem(null); };
  useEffect(() => () => { if (stopRef.current) stopRef.current(); }, []);

  const searchRecipes = useCallback(async (text) => {
    const r = await stockApi.recipesPage({ orgId, sites: null, search: text || null, filters: null, after: null, limit: 20 });
    return (r.data?.rows || []).map((x) => ({ id: x.id, name: x.name, hint: x.kind && x.kind !== 'dish' ? x.kind : '' }));
  }, [orgId]);
  const spec = useMemo(() => swapSpec({ ...form, recipeIds: form.recipes.map((r) => r.id) }), [form]);

  const runPreview = async () => {
    setProblem(null);
    if (spec.error) { setProblem(spec.error); return; }
    setBusy('preview');
    const r = await stockApi.swapIngredient(spec.spec, { preview: true });
    setBusy(null);
    if (r.error) { setProblem(r.error.message); return; }
    setPreview({ rows: r.data?.rows || [], total: r.data?.total ?? (r.data?.rows || []).length, words: r.data?.words || '' });
  };
  const apply = async () => {
    setProblem(null);
    if (spec.error) { setProblem(spec.error); return; }
    setBusy('apply');
    const r = await stockApi.swapIngredient(spec.spec, { preview: false });
    if (r.error) { setBusy(null); setProblem(r.error.message); return; }
    const changed = Number(r.data?.changed) || 0;
    const ids = jobIdsOf(r.queued?.length ? r.queued : r.data?.queued);
    if (ids.length) {
      say(`${changed} recipe${changed === 1 ? '' : 's'} changed now. The rest follow within a minute.`, 'info');
      setJobs({ ids, rows: [] });
      stopRef.current = pollJobs(stockApi, ids, (rows) => {
        setJobs({ ids, rows });
        const done = rows.length && rows.every((j) => j.status === 'done' || j.status === 'failed');
        if (done) { setBusy(null); const failed = rows.filter((j) => j.status === 'failed'); if (failed.length) say(`${failed.length} job${failed.length === 1 ? '' : 's'} did not finish: ${failed[0].last_error || 'try again'}`, 'error'); else say('Every recipe is changed.'); onDone?.(r.data); }
      });
      return;
    }
    setBusy(null);
    say(`${changed} recipe${changed === 1 ? '' : 's'} changed. Costs and allergens at every site follow the new ingredient.`);
    onDone?.(r.data);
  };

  const sitesOf = (rows) => rows.reduce((a, x) => a + (Number(x.sites_on) || 0), 0);
  const words = preview ? (preview.words || swapWords({ recipes: preview.total, sites: sitesOf(preview.rows) })) : '';
  const problems = preview ? preview.rows.filter((x) => x.problem).length : 0;
  const progress = jobs ? jobsProgress(jobs.rows, jobs.ids, sc.siteName) : null;

  return (
    <Modal title="Swap an ingredient" sub="Change one ingredient across many recipes at once. Preview first; nothing changes until Apply." onClose={busy ? () => {} : onClose} width={820} dirty={!busy && !!form.fromItemId}
      footer={(
        <>
          <span style={{ flex: 1 }} />
          <Btn onClick={onClose} disabled={busy === 'apply'}>Cancel</Btn>
          <Btn kind="soft" onClick={runPreview} disabled={!!busy}>{busy === 'preview' ? 'Working…' : 'Preview'}</Btn>
          <Btn kind="primary" onClick={apply} disabled={!!busy || !preview || !preview.rows.length}>{busy === 'apply' ? 'Applying…' : 'Apply'}</Btn>
        </>
      )}>
      <div style={{ display: 'grid', gap: 10 }}>
        <Segmented value={form.mode} onChange={(v) => upd({ mode: v })} options={[{ value: 'swap', label: 'Swap' }, { value: 'amount', label: 'Change amount' }]} />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '0 14px' }}>
          <Field label="From" hint="The ingredient as the recipes use it now.">
            <ItemSearch orgId={orgId} label={form.fromName} onPick={(it) => upd({ fromItemId: it?.id || null, fromName: it?.name || '', fromUnit: it?.base_unit || '', unit: form.unit || it?.base_unit || '' })} disabled={!!busy} />
          </Field>
          {form.mode === 'swap' ? (
            <Field label="To" hint="The ingredient that takes its place, in the same amount and unit.">
              <ItemSearch orgId={orgId} label={form.toName} onPick={(it) => upd({ toItemId: it?.id || null, toName: it?.name || '' })} disabled={!!busy} />
            </Field>
          ) : (
            <Field label={form.amountHow === 'qty' ? 'Amount' : 'Factor'}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                <Segmented small value={form.amountHow} onChange={(v) => upd({ amountHow: v })} options={[{ value: 'qty', label: 'Set to' }, { value: 'factor', label: 'Multiply by' }]} />
                {form.amountHow === 'qty' ? (
                  <>
                    <input type="number" min="0" step="any" value={form.qty} disabled={!!busy} onChange={(e) => upd({ qty: e.target.value })} style={{ ...ui.input, width: 90 }} aria-label="Amount" />
                    <select value={form.unit} disabled={!!busy} onChange={(e) => upd({ unit: e.target.value })} style={{ ...ui.input, width: 'auto' }} aria-label="Unit">
                      <option value="">Unit</option>
                      {UNIT_CODES.map((u) => <option key={u} value={u}>{u}</option>)}
                    </select>
                  </>
                ) : (
                  <input type="number" min="0" step="any" value={form.factor} disabled={!!busy} onChange={(e) => upd({ factor: e.target.value })} style={{ ...ui.input, width: 90 }} aria-label="Factor" placeholder="1.1" />
                )}
              </div>
            </Field>
          )}
        </div>
        <Field label="Which recipes">
          <div style={{ display: 'grid', gap: 8 }}>
            <Segmented small value={form.scope} onChange={(v) => upd({ scope: v })} options={[{ value: 'all', label: 'Every recipe using it' }, { value: 'chosen', label: 'Chosen recipes' }]} />
            {form.scope === 'chosen' && (
              <>
                <SearchPick label="" placeholder="Search recipes" search={searchRecipes} disabled={!!busy} style={{ maxWidth: 360 }}
                  onPick={(r) => { if (r && !form.recipes.some((x) => x.id === r.id)) upd({ recipes: [...form.recipes, { id: r.id, name: r.name }] }); }} />
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {form.recipes.map((r) => <Btn key={r.id} small kind="soft" disabled={!!busy} onClick={() => upd({ recipes: form.recipes.filter((x) => x.id !== r.id) })} title="Remove">{r.name} x</Btn>)}
                  {!form.recipes.length && <span style={ui.sub}>Pick the recipes above.</span>}
                </div>
              </>
            )}
          </div>
        </Field>

        {problem && <Notice tone="bad">{problem}</Notice>}
        {progress && (
          <Notice tone={progress.failed.length ? 'bad' : 'info'}>
            {progress.line || `${jobs.ids.length} job${jobs.ids.length === 1 ? '' : 's'} waiting.`}
            {progress.failed.map((f) => <div key={f.id}>{f.words}</div>)}
          </Notice>
        )}
        {preview && (
          <div style={{ display: 'grid', gap: 8 }}>
            <div style={{ fontSize: 13, fontWeight: 700 }}>{words}{problems ? ` · ${problems} line${problems === 1 ? '' : 's'} cannot change` : ''}</div>
            {preview.rows.length === 0 ? <div style={ui.sub}>No recipe uses this ingredient.</div> : (
              <TableWrap minWidth={640}>
                <thead><tr><Th>Recipe</Th><Th>Before</Th><Th>After</Th><Th right>Sites</Th></tr></thead>
                <tbody>
                  {preview.rows.map((x) => (
                    <tr key={x.recipe_id}>
                      <Td strong>{x.name}</Td>
                      <Td>{lineWords(x.line_before)}</Td>
                      <Td>{x.problem ? <span style={{ color: 'var(--red)' }}>{x.problem}</span> : lineWords(x.line_after)}</Td>
                      <Td right num>{x.sites_on ?? ''}</Td>
                    </tr>
                  ))}
                </tbody>
              </TableWrap>
            )}
            {preview.total > preview.rows.length && <div style={ui.sub}>Showing the first {preview.rows.length} of {preview.total} recipes. Apply changes them all.</div>}
          </div>
        )}
      </div>
    </Modal>
  );
}
