// src/backoffice/sections/produce/RecipeOptionsEditor.jsx
//
// MULTI SITE STOCK Drop 2 (design D11, contract 3.2): the option rules of a company dish, under its
// lines. 'When the customer picks [option] then replace [ingredient] with [ingredient]' or 'remove
// [ingredient]'. The option is a company stock item (the replacing item) and may also name a Multi
// site menu product. stock_save_option_rule resolves each site's own modifier id when it saves (the
// msm product, the same master id, the name inside the dish's modifier groups); a site it cannot
// resolve shows 'Not found at <site>: link it', where a company editor picks that site's sub item
// by hand (site_modifiers). The drainer reads the resolved ids on the next sale; an archived rule
// does nothing. Company need: everyone else sees the rules read only.

import { useMemo, useState } from 'react';
import { useStore } from '../../../store';
import { useStockScope } from '../../StockScope';
import { stockApi } from '../../../lib/stock/stockApi';
import { fetchSiteStockContext } from '../../../lib/stock/siteContext';
import { optionRuleWords, optionSiteWords } from '../../../lib/stock/recipeRules';
import { menuItemLabel } from '../../../lib/stock/recipeMatch';
import { Btn, Pill, Popover, Segmented, Field, Notice, useConfirm, ui } from '../stock/stockUi';
import { ItemSearch, SearchPick } from './RecipeLinesEditor';

const BLANK = Object.freeze({ kind: 'replace', option_name: '', option_company_item_id: null, option_item_name: '', option_msm_product_id: null, msm_name: '', replaces_item_id: '', removes_item_id: '' });

export default function RecipeOptionsEditor({ detail, editable = false, reload }) {
  const sc = useStockScope();
  const showToast = useStore((s) => s.showToast);
  const say = (words, tone = 'success') => { try { showToast?.(words, tone); } catch { /* no toast, no harm */ } };
  const recipe = detail?.recipe || {};
  const orgId = recipe.org_id || sc.orgId || null;
  const rules = useMemo(() => (detail?.option_rules || []).filter((r) => r && !r.archived_at), [detail]);
  const lines = useMemo(() => (detail?.lines || []).filter((l) => l && l.component_item_id), [detail]);
  const sitesOn = useMemo(() => (detail?.sites || []).filter((s) => s && s.on), [detail]);
  const names = useMemo(() => {
    const out = {};
    for (const l of lines) out[l.component_item_id] = l.name;
    for (const r of rules) {
      if (r.option_company_item_id && r.option_item_name) out[r.option_company_item_id] = r.option_item_name;
      if (r.replaces_item_id && r.replaces_item_name) out[r.replaces_item_id] = r.replaces_item_name;
      if (r.removes_item_id && r.removes_item_name) out[r.removes_item_id] = r.removes_item_name;
    }
    return out;
  }, [lines, rules]);
  const [form, setForm] = useState(null);   // null = closed; else the add form
  const [busy, setBusy] = useState(null);
  const [problem, setProblem] = useState(null);
  const [subItems, setSubItems] = useState({});   // siteId -> 'loading' | [{ id, name }]
  const [confirm, confirmDialog] = useConfirm();

  const saveRule = async (rule, version, okWords) => {
    setBusy(rule.id || 'new');
    setProblem(null);
    const r = await stockApi.saveOptionRule(rule, version ?? null);
    setBusy(null);
    if (r.error) { setProblem(r.error.message); say(r.error.message, 'error'); return null; }
    const notFound = r.data?.not_found || [];
    say(`${okWords}${notFound.length ? ` Not found at ${notFound.join(', ')}: link it under the rule.` : ''}`, notFound.length ? 'warning' : 'success');
    reload?.();
    return r.data;
  };

  const addRule = async () => {
    const f = form || BLANK;
    const rule = { recipe_id: recipe.id, kind: f.kind, option_name: (f.option_name || f.option_item_name || f.msm_name || '').trim() || null, option_msm_product_id: f.option_msm_product_id || null };
    if (!rule.option_name) { setProblem('Say what the customer picks (the option).'); return; }
    if (f.kind === 'replace') {
      if (!f.replaces_item_id) { setProblem('Pick the ingredient the option replaces.'); return; }
      if (!f.option_company_item_id) { setProblem('Pick the stock item that replaces it.'); return; }
      if (f.option_company_item_id === f.replaces_item_id) { setProblem('Pick two different ingredients.'); return; }
      rule.replaces_item_id = f.replaces_item_id;
      rule.option_company_item_id = f.option_company_item_id;
    } else {
      if (!f.removes_item_id) { setProblem('Pick the ingredient the option removes.'); return; }
      rule.removes_item_id = f.removes_item_id;
    }
    const made = await saveRule(rule, null, 'Option rule saved. Sales with that option take stock off through it from now.');
    if (made) setForm(null);
  };

  const archive = async (rule) => {
    const ok = await confirm({ title: 'Remove this option rule?', words: `${optionRuleWords(rule, names)}. The rule is archived, never deleted; sales with the option then take the normal recipe off.`, yes: 'Remove', no: 'Go back', danger: true });
    if (!ok) return;
    setBusy(rule.id);
    const r = await stockApi.archiveOptionRule(rule.id, rule.row_version ?? null, true);
    setBusy(null);
    if (r.error) { say(r.error.message, 'error'); return; }
    say('Option rule removed. It does nothing from now on.');
    reload?.();
  };

  const loadSubItems = async (siteId) => {
    if (!siteId || subItems[siteId]) return;
    setSubItems((m) => ({ ...m, [siteId]: 'loading' }));
    const r = await fetchSiteStockContext(siteId);
    const all = (r?.menuItems || []).filter((m) => m && !m.archived);
    const byId = new Map(all.map((m) => [String(m.id), m]));
    const rows = all.filter((m) => (m.parentId ?? m.parent_id) != null).map((m) => ({ id: String(m.id), name: menuItemLabel(m, byId) }))
      .sort((a, b) => a.name.localeCompare(b.name, 'en-GB', { numeric: true, sensitivity: 'base' }));
    setSubItems((m) => ({ ...m, [siteId]: rows }));
  };
  const linkByHand = (rule, siteId, modifierId) => {
    const kept = (rule.sites || []).filter((s) => s.resolved_by === 'hand' && s.site_modifier_id && s.location_id !== siteId).map((s) => ({ location_id: s.location_id, site_modifier_id: s.site_modifier_id }));
    const site = sc.siteName(siteId) || 'that site';
    return saveRule({
      id: rule.id, recipe_id: recipe.id, kind: rule.kind, option_name: rule.option_name, option_msm_product_id: rule.option_msm_product_id || null,
      option_company_item_id: rule.option_company_item_id || null, replaces_item_id: rule.replaces_item_id || null, removes_item_id: rule.removes_item_id || null,
      site_modifiers: [...kept, { location_id: siteId, site_modifier_id: modifierId }],
    }, rule.row_version ?? null, `Linked at ${site}.`);
  };

  const searchMenuProducts = useMemo(() => async (text) => {
    if (typeof stockApi.menuProducts !== 'function') return [];
    const r = await stockApi.menuProducts(orgId, text || null, null);
    return (r.data?.rows || []).map((p) => ({ id: p.id, name: p.name, hint: p.menu_name || '' }));
  }, [orgId]);
  const f = form || BLANK;
  const upd = (patch) => setForm((x) => ({ ...(x || BLANK), ...patch }));

  return (
    <div style={ui.card}>
      {confirmDialog}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <div style={ui.h2}>Options</div>
        <span style={{ flex: 1 }} />
        {editable && !form && <Btn small kind="soft" onClick={() => setForm({ ...BLANK, replaces_item_id: lines[0]?.component_item_id || '', removes_item_id: lines[0]?.component_item_id || '' })}>+ Add an option rule</Btn>}
      </div>
      {rules.length === 0 && !form && <div style={ui.sub}>No option rules yet. An option can replace one ingredient with another (oat milk for whole milk) or remove one (no cheese).</div>}
      <div style={{ display: 'grid', gap: 8 }}>
        {rules.map((rule) => (
          <div key={rule.id} style={{ border: '1px solid var(--bdr)', borderRadius: 10, padding: '10px 12px', background: 'var(--bg2)' }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap' }}>
              <div style={{ flex: '1 1 260px', fontSize: 13, color: 'var(--t1)' }}>{optionRuleWords(rule, names)}</div>
              {editable && <Btn small kind="danger" disabled={busy === rule.id} onClick={() => archive(rule)}>Remove</Btn>}
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
              {sitesOn.map((s) => {
                const row = (rule.sites || []).find((x) => x.location_id === s.location_id) || null;
                const w = optionSiteWords(row, s.name || sc.siteName(s.location_id));
                if (w.found || !editable) return <Pill key={s.location_id} tone={w.found ? 'good' : 'warn'}>{w.words}</Pill>;
                const list = subItems[s.location_id];
                return (
                  <Popover key={s.location_id} label={<Pill tone="warn">{w.words}</Pill>} kind="link" width={300} ariaLabel={w.words}>
                    {(close) => (
                      <div onMouseEnter={() => loadSubItems(s.location_id)} onFocus={() => loadSubItems(s.location_id)}>
                        <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 6 }}>Which option on the menu at {s.name || sc.siteName(s.location_id)}?</div>
                        {!list && <Btn small kind="soft" onClick={() => loadSubItems(s.location_id)}>Show the sub items</Btn>}
                        {list === 'loading' && <div style={ui.sub}>Loading…</div>}
                        {Array.isArray(list) && list.length === 0 && <div style={ui.sub}>This site's menu has no sub items.</div>}
                        {Array.isArray(list) && list.length > 0 && (
                          <div style={{ display: 'grid', gap: 2, maxHeight: 240, overflowY: 'auto' }}>
                            {list.map((m) => (
                              <button key={m.id} type="button" disabled={busy === rule.id} onClick={async () => { const r = await linkByHand(rule, s.location_id, m.id); if (r) close(); }}
                                style={{ textAlign: 'left', background: 'transparent', border: 'none', borderRadius: 8, padding: '7px 8px', cursor: 'pointer', fontFamily: 'inherit', color: 'var(--t1)', fontSize: 13 }}>{m.name}</button>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </Popover>
                );
              })}
              {sitesOn.length === 0 && <span style={ui.sub}>The recipe is on at no site yet.</span>}
            </div>
          </div>
        ))}
      </div>

      {form && editable && (
        <div style={{ marginTop: 12, border: '1px solid var(--bdr)', borderRadius: 10, padding: 12 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
            <span style={{ fontSize: 13 }}>When the customer picks the option, then</span>
            <Segmented small value={f.kind} onChange={(v) => upd({ kind: v })} options={[{ value: 'replace', label: 'replace an ingredient' }, { value: 'remove', label: 'remove an ingredient' }]} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '0 14px' }}>
            {f.kind === 'replace' ? (
              <>
                <Field label="Replace">
                  <select value={f.replaces_item_id} onChange={(e) => upd({ replaces_item_id: e.target.value })} style={ui.input} aria-label="Replace">
                    <option value="">Pick an ingredient</option>
                    {lines.map((l) => <option key={l.component_item_id} value={l.component_item_id}>{l.name}</option>)}
                  </select>
                </Field>
                <Field label="With" hint="The company stock item the option uses instead. Its name is the option's name unless you type one.">
                  <ItemSearch orgId={orgId} label={f.option_item_name} placeholder="Search the company stock items"
                    onPick={(it) => upd({ option_company_item_id: it?.id || null, option_item_name: it?.name || '', option_name: f.option_name || it?.name || '' })} />
                </Field>
              </>
            ) : (
              <Field label="Remove">
                <select value={f.removes_item_id} onChange={(e) => upd({ removes_item_id: e.target.value })} style={ui.input} aria-label="Remove">
                  <option value="">Pick an ingredient</option>
                  {lines.map((l) => <option key={l.component_item_id} value={l.component_item_id}>{l.name}</option>)}
                </select>
              </Field>
            )}
            <Field label="Option name" hint="As the customer sees it on the till ('Oat milk', 'No cheese'). Each site's own option is found by this name when nothing else matches.">
              <input value={f.option_name} onChange={(e) => upd({ option_name: e.target.value })} style={ui.input} aria-label="Option name" />
            </Field>
            <Field label="Menu product (optional)" hint="The option product in the Multi site menu, so every site's own option is found at once.">
              <SearchPick label={f.msm_name} placeholder="Search the group menu" search={searchMenuProducts} allowClear clearWords="No menu product"
                onPick={(r) => upd({ option_msm_product_id: r?.id || null, msm_name: r?.name || '', option_name: f.option_name || r?.name || '' })} />
            </Field>
          </div>
          {problem && <div style={{ marginBottom: 8 }}><Notice tone="bad">{problem}</Notice></div>}
          <div style={{ ...ui.row, justifyContent: 'flex-end' }}>
            <Btn onClick={() => { setForm(null); setProblem(null); }} disabled={busy === 'new'}>Cancel</Btn>
            <Btn kind="primary" onClick={addRule} disabled={busy === 'new'}>{busy === 'new' ? 'Saving…' : 'Save'}</Btn>
          </div>
        </div>
      )}
    </div>
  );
}
