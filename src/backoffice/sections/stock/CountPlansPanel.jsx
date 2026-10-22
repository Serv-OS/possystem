// src/backoffice/sections/stock/CountPlansPanel.jsx
//
// MULTI SITE STOCK (v5.11.96, Drop 3, contract 3.3 and 4.3, map I3 and I6): count plans for head
// office: what is counted, how often, the time it is due by (venue time), which sites, and what a
// line nobody counted means at approval ('Use the estimate' or 'Use zero'). A plan only reminds:
// it never starts, posts or changes a count by itself. Saves go through stock_save_count_plan.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useStore } from '../../../store';
import { stockApi } from '../../../lib/stock/stockApi';
import {
  PLAN_COUNT_TYPES, PLAN_EVERY, IF_NOT_COUNTED, blankPlan, planProblem, planToSave, planSummary, hmOf,
} from '../../../lib/stock/countPlanRules';
import { useStockScope } from '../../StockScope';
import { Btn, Field, Segmented, Sheet, SiteChecklist, ui, ErrorLine, EmptyLine, useConfirm } from './stockUi';

const DAY_CHIPS = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [0, 'Sun']];
const chip = (on) => ({ fontSize: 12, padding: '5px 10px', borderRadius: 7, cursor: 'pointer', fontFamily: 'inherit', background: on ? 'var(--acc-d, var(--bg3))' : 'var(--bg2)', color: 'var(--t1)', border: `1px solid ${on ? 'var(--acc)' : 'var(--bdr)'}` });

export default function CountPlansPanel({ orgCtx = null }) {
  const sc = useStockScope();
  const orgId = sc.orgId || orgCtx?.orgId || null;
  const showToast = useStore((s) => s.showToast);
  const [plans, setPlans] = useState(null);
  const [templates, setTemplates] = useState([]);
  const [error, setError] = useState(null);
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [confirm, confirmDialog] = useConfirm();

  const load = useCallback(async () => {
    if (!orgId) return;
    const [p, t] = await Promise.all([stockApi.countPlans(orgId), stockApi.countTemplates(orgId)]);
    if (p.error) { setError(p.error); setPlans([]); return; }
    setError(null); setPlans(p.data || []); setTemplates(t.data || []);
  }, [orgId]);
  useEffect(() => { const t = setTimeout(load, 0); return () => clearTimeout(t); }, [load]);

  const names = useMemo(() => ({ siteName: sc.siteName, groupName: (id) => (sc.groups || []).find((g) => g.id === id)?.name || '' }), [sc.siteName, sc.groups]);
  const problem = draft ? planProblem(draft) : null;
  const set = (patch) => setDraft((d) => ({ ...d, ...patch }));

  const save = async (archived = false) => {
    if (!archived && problem) { showToast?.(problem, 'error'); return; }
    setBusy(true);
    const r = await stockApi.saveCountPlan(planToSave({ ...draft, archived }), draft.row_version ?? null);
    setBusy(false);
    if (r.error) { showToast?.(r.error.message, 'error'); return; }
    showToast?.(archived ? 'Plan archived.' : 'Plan saved.', 'success');
    setDraft(null);
    await load();
  };
  const archive = async () => {
    const yes = await confirm({ title: 'Archive this plan?', words: 'Sites stop being reminded. Counts already made stay as they are.', yes: 'Archive', danger: true });
    if (yes) await save(true);
  };

  return (
    <div>
      {confirmDialog}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <div style={{ ...ui.sub, flex: 1 }}>A plan says what each site counts and by when. Sites see it on Stock counts; a missed count is flagged to the managers.</div>
        <Btn kind="primary" onClick={() => setDraft(blankPlan())}>New plan</Btn>
      </div>
      <ErrorLine error={error} />
      {plans === null && <div style={{ fontSize: 13, color: 'var(--t3)' }}>Loading…</div>}
      {plans && plans.length === 0 && !error && <EmptyLine>No count plans yet.</EmptyLine>}
      {(plans || []).map((p) => (
        <div key={p.id} onClick={() => setDraft({ ...blankPlan(), ...p, due_by: hmOf(p.due_by) || '10:00', dows: p.dows || [], group_ids: p.group_ids || [] })}
          style={{ ...ui.card, padding: 14, marginBottom: 8, cursor: 'pointer', opacity: p.active === false ? 0.6 : 1 }}>
          <div style={{ fontWeight: 700 }}>{p.name}{p.active === false ? ' (off)' : ''}</div>
          <div style={{ ...ui.sub, marginTop: 3 }}>{planSummary(p, names)}</div>
        </div>
      ))}
      {draft && (
        <Sheet title={draft.id ? 'Count plan' : 'New count plan'} onClose={() => setDraft(null)} width={600}
          footer={<>
            {draft.id && <Btn kind="danger" onClick={archive} disabled={busy}>Archive</Btn>}
            <span style={{ marginLeft: 'auto', ...ui.err }}>{problem || ''}</span>
            <Btn onClick={() => setDraft(null)} disabled={busy}>Cancel</Btn>
            <Btn kind="primary" onClick={() => save(false)} disabled={busy || !!problem}>{busy ? 'Saving...' : 'Save'}</Btn>
          </>}>
          <Field label="Name"><input value={draft.name} onChange={(e) => set({ name: e.target.value })} style={ui.input} placeholder="Weekly full count" /></Field>
          <Field label="What is counted">
            <select value={draft.count_type} onChange={(e) => set({ count_type: e.target.value })} style={ui.input}>
              {PLAN_COUNT_TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
            </select>
          </Field>
          {templates.length > 0 && (
            <Field label="Template (optional)">
              <select value={draft.template_id || ''} onChange={(e) => set({ template_id: e.target.value || null })} style={ui.input}>
                <option value="">No template</option>
                {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </Field>
          )}
          <Field label="How often">
            <Segmented value={draft.every} onChange={(v) => set({ every: v })} options={PLAN_EVERY.map((e) => ({ value: e.id, label: e.label }))} />
          </Field>
          {draft.every === 'week' && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
              {DAY_CHIPS.map(([d, w]) => {
                const on = (draft.dows || []).map(Number).includes(d);
                return <button key={d} type="button" style={chip(on)} onClick={() => set({ dows: on ? draft.dows.filter((x) => Number(x) !== d) : [...(draft.dows || []), d] })}>{w}</button>;
              })}
            </div>
          )}
          {draft.every === 'month' && (
            <Field label="Day of the month (1 to 28)"><input type="number" min="1" max="28" value={draft.day_of_month ?? ''} onChange={(e) => set({ day_of_month: e.target.value === '' ? '' : Number(e.target.value) })} style={{ ...ui.input, width: 100 }} /></Field>
          )}
          <Field label="Count by" hint="The venue's own time."><input type="time" value={draft.due_by || ''} onChange={(e) => set({ due_by: e.target.value })} style={{ ...ui.input, width: 140 }} /></Field>
          <Field label="Sites" hint="None ticked means every open site.">
            <SiteChecklist sites={sc.sites || []} groups={sc.groups || []} value={draft.sites || []} onChange={(ids) => set({ sites: ids && ids.length ? ids : null })} />
          </Field>
          <Field label="If an item is not counted">
            <Segmented value={draft.if_not_counted} onChange={(v) => set({ if_not_counted: v })} options={IF_NOT_COUNTED.map((x) => ({ value: x.id, label: x.label }))} />
          </Field>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
            <input type="checkbox" checked={draft.active !== false} onChange={(e) => set({ active: e.target.checked })} /> Plan is on
          </label>
        </Sheet>
      )}
    </div>
  );
}
