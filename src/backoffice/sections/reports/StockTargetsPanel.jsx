// src/backoffice/sections/reports/StockTargetsPanel.jsx
//
// MULTI SITE STOCK, Drop 4a (contract 3.3, design 5.1 "Targets per site"): the Targets panel opened
// from the head office dashboard. Two tabs.
//
//   Targets: a table, a row for the company default and a row per site in scope, a green and an
//   amber box per metric. Empty site boxes follow the company; a value is an override; Clear removes
//   it (back to the company row). The words under each pair say what the site is measured against
//   (targetRules targetWords). One stock_save_targets call; Someone saved first on a conflict.
//
//   Key items: the key ratios (milk per milk drink, beans per shot, cups against cup drinks sold):
//   name, the stock item used, its unit, what counts as sold, the recipe amount; add, edit, archive
//   through stock_save_key_ratios (20 live at most; the database says so too).
//
// Level all edits; every other level reads. The database checks again whatever the screen shows.
// Words and the save rows: dashboardRules.js (tested); the metric list and defaults: targetRules.js.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../../store';
import { Sheet, Modal, Btn, Pill, Field, TabBar, TableWrap, Th, Td, ErrorLine, EmptyLine, Notice, useConfirm, ui } from '../stock/stockUi';
import SavedFirstModal from '../stock/SavedFirstModal';
import { stockApi } from '../../../lib/stock/stockApi';
import { supabase } from '../../../lib/supabase';
import { TARGET_METRICS, TARGET_DEFAULTS, BETTER_HIGH, targetWords } from '../../../lib/stock/targetRules';
import {
  READ_ONLY_TARGETS, KEY_ITEMS_HINT, MAX_KEY_ITEMS, USED_UNITS, SOLD_RULE_CHOICES,
  targetKey, metricList, effectiveTarget, savedTarget, parseTargetCell, targetProblems, targetSaveRows,
  targetConflictRows, withFreshVersions, siteNameOf,
  soldRuleChoice, soldRuleWords, keyRatioProblem, keyRatioSaveRow, keyRatioDraft, searchMenuProducts,
} from '../../../lib/stock/dashboardRules';

const box = { width: 64, boxSizing: 'border-box', padding: '5px 8px', borderRadius: 7, fontSize: 13, fontFamily: 'inherit', outline: 'none', textAlign: 'right', fontVariantNumeric: 'tabular-nums', background: 'var(--bg2)', border: '1px solid var(--bdr2)', color: 'var(--t1)' };
const tiny = { fontSize: 11, color: 'var(--t4)', whiteSpace: 'normal', maxWidth: 170, lineHeight: 1.4 };
const linkBtn = { border: 'none', background: 'transparent', padding: 0, font: 'inherit', fontSize: 11.5, color: 'var(--acc)', cursor: 'pointer', fontWeight: 600 };

/** The saved rows as the typed draft: strings in the boxes, '' for no row. */
const draftFrom = (saved, metrics, siteIds) => {
  const out = {};
  const cell = (loc, m) => {
    const r = savedTarget(saved, loc, m);
    return { green_to: r && r.green_to != null ? String(r.green_to) : '', amber_to: r && r.amber_to != null ? String(r.amber_to) : '' };
  };
  for (const m of metrics) {
    out[targetKey(null, m.key)] = cell(null, m.key);
    for (const id of siteIds) out[targetKey(id, m.key)] = cell(id, m.key);
  }
  return out;
};

export default function StockTargetsPanel({ orgId, sites, siteById, level, api, onClose, onSaved }) {
  const showToast = useStore((s) => s.showToast);
  const [confirm, confirmDialog] = useConfirm();
  const canEdit = level === 'all';
  const metrics = useMemo(() => metricList(TARGET_METRICS), []);
  // Keyed on the ids themselves, so a parent render with a new array of the same sites asks nothing again.
  const siteKey = (sites || []).filter(Boolean).map(String).join(',');
  const siteIds = useMemo(() => (siteKey ? siteKey.split(',') : []), [siteKey]);
  const nameOf = (id) => siteNameOf(siteById, id, 'A site');
  const [tab, setTab] = useState('targets');

  // ── targets ──
  const [saved, setSaved] = useState(null);        // { rows, error }
  const [reloads, setReloads] = useState(0);
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [clash, setClash] = useState(null);        // { byName, at, rows, saveRows, fresh }

  useEffect(() => {
    if (!orgId || !api?.targets) return undefined;
    let live = true;
    api.targets(orgId).then((r) => {
      if (!live) return;
      const rows = r.error ? null : (Array.isArray(r.data) ? r.data : []);
      setSaved({ rows, error: r.error || null });
      if (rows) setDraft(draftFrom(rows, metrics, siteIds));
    });
    return () => { live = false; };
  }, [orgId, api, reloads, metrics, siteIds]);

  const rows = saved?.rows || null;
  const problems = useMemo(() => targetProblems(draft, BETTER_HIGH), [draft]);
  const saveRows = useMemo(() => (rows ? targetSaveRows(draft, rows) : []), [draft, rows]);
  const dirty = saveRows.length > 0;

  const setCell = (key, which, value) => {
    setProblem('');
    setDraft((d) => ({ ...(d || {}), [key]: { ...(d?.[key] || { green_to: '', amber_to: '' }), [which]: value } }));
  };
  const clearCell = (key) => { setProblem(''); setDraft((d) => ({ ...(d || {}), [key]: { green_to: '', amber_to: '' } })); };

  const runSave = async (toSave) => {
    setBusy(true);
    const r = await api.saveTargets(orgId, toSave);
    setBusy(false);
    if (r.conflict) {
      const fresh = await api.targets(orgId);
      const freshRows = Array.isArray(fresh.data) ? fresh.data : [];
      setClash({ byName: r.conflict.by_name || 'Someone', at: r.conflict.at || null, rows: targetConflictRows(toSave, freshRows, metrics, nameOf), saveRows: toSave, fresh: freshRows });
      return false;
    }
    if (r.error) { setProblem(r.error.message || 'It did not save. Try again.'); return false; }
    setClash(null);
    showToast?.('Targets saved. The league colours use them now.', 'success');
    setReloads((n) => n + 1);
    onSaved?.();
    return true;
  };

  const save = async () => {
    const firstProblem = Object.values(problems)[0];
    if (firstProblem) { setProblem(firstProblem); return; }
    if (!saveRows.length) { setProblem('Nothing changed.'); return; }
    if (saveRows.length > 100) { setProblem('That is more than 100 changes at once. Save some, then the rest.'); return; }
    await runSave(saveRows);
  };

  // ── key items ──
  const [ratios, setRatios] = useState(null);      // { rows, error }
  const [ratioReloads, setRatioReloads] = useState(0);
  const [itemNames, setItemNames] = useState({});
  const [editing, setEditing] = useState(null);    // the editor's draft or null
  const [ratioBusy, setRatioBusy] = useState(false);

  useEffect(() => {
    if (!orgId || !api?.keyRatios) return undefined;
    let live = true;
    api.keyRatios(orgId).then((r) => { if (live) setRatios({ rows: r.error ? null : (Array.isArray(r.data) ? r.data : []), error: r.error || null }); });
    return () => { live = false; };
  }, [orgId, api, ratioReloads]);

  const liveRatios = useMemo(() => (ratios?.rows || []).filter((r) => !r.archived_at), [ratios]);
  const wantNames = useMemo(() => [...new Set(liveRatios.map((r) => r.used_item_id).filter(Boolean))].filter((id) => itemNames[id] === undefined).join(','), [liveRatios, itemNames]);
  useEffect(() => {
    if (!wantNames) return undefined;
    let live = true;
    const ids = wantNames.split(',');
    Promise.all(ids.map((id) => stockApi.itemDetail(id).then((r) => [id, r.data?.item?.name || r.data?.name || null]))).then((pairs) => {
      if (!live) return;
      setItemNames((n) => ({ ...n, ...Object.fromEntries(pairs.map(([id, name]) => [id, name || ''])) }));
    });
    return () => { live = false; };
  }, [wantNames]);

  const saveRatio = async (d, { archive = false } = {}) => {
    const why = archive ? null : keyRatioProblem(d, ratios?.rows || []);
    if (why) return { error: why };
    setRatioBusy(true);
    const r = await api.saveKeyRatios(orgId, [keyRatioSaveRow(d, { archive })]);
    setRatioBusy(false);
    if (r.error) {
      if (r.conflict) setRatioReloads((n) => n + 1);
      return { error: r.error.message || 'It did not save. Try again.' };
    }
    showToast?.(archive ? `${d.name.trim()} archived. Its tile is gone from the dashboard.` : `${d.name.trim()} saved. Its tile is on the dashboard now.`, 'success');
    setRatioReloads((n) => n + 1);
    onSaved?.();
    return { ok: true };
  };

  const archive = async (row) => {
    const ok = await confirm({ title: `Archive ${row.name}?`, words: 'Its tile leaves the dashboard. Nothing else changes; the history stays.', yes: 'Archive', no: 'Keep it', danger: true });
    if (!ok) return;
    const r = await saveRatio(keyRatioDraft(row, itemNames[row.used_item_id]), { archive: true });
    if (r.error) showToast?.(r.error, 'error');
  };

  const tabs = [{ id: 'targets', label: 'Targets' }, { id: 'key', label: 'Key items', count: liveRatios.length || undefined }];

  return (
    <Sheet title="Targets and key items" sub="Company default, site override. Cells go green, amber, red against these." onClose={onClose} width={900}
      dirty={dirty && canEdit} dirtyWords="You have target changes that are not saved."
      footer={tab === 'targets' ? (
        <>
          {problem && <div role="alert" style={{ ...ui.err, flex: '1 1 100%' }}>{problem}</div>}
          <span style={{ flex: 1 }} />
          <Btn onClick={onClose} disabled={busy}>Close</Btn>
          {canEdit && <Btn kind="primary" onClick={save} disabled={busy || !rows || !dirty}>{busy ? 'Saving…' : dirty ? `Save ${saveRows.length} change${saveRows.length === 1 ? '' : 's'}` : 'Saved'}</Btn>}
        </>
      ) : (
        <>
          <span style={{ flex: 1 }} />
          <Btn onClick={onClose} disabled={ratioBusy}>Close</Btn>
        </>
      )}>
      {confirmDialog}
      {!canEdit && <Notice tone="warn">{READ_ONLY_TARGETS}</Notice>}
      <TabBar tabs={tabs} value={tab} onChange={setTab} />

      {tab === 'targets' && (
        <div data-testid="stock-targets-tab">
          <div style={{ ...ui.sub, marginBottom: 10 }}>
            GP %: green from the green number. Every other metric: green up to it. Amber up to the amber number, red past it. Empty site boxes follow the company default.
          </div>
          <ErrorLine error={saved?.error} />
          {!saved && <EmptyLine>Loading targets{'…'}</EmptyLine>}
          {rows && draft && (
            <TableWrap minWidth={220 + metrics.length * 190}>
              <thead>
                <tr>
                  <Th sticky>Site</Th>
                  {metrics.map((m) => <Th key={m.key} right hint="Green, then amber">{m.label}</Th>)}
                </tr>
              </thead>
              <tbody>
                <tr>
                  <Td sticky strong>Company default</Td>
                  {metrics.map((m) => (
                    <Td key={m.key} right>
                      <CellPair metric={m.key} cellKey={targetKey(null, m.key)} draft={draft} saved={rows} canEdit={canEdit}
                        problem={problems[targetKey(null, m.key)]} onChange={setCell} onClear={clearCell} />
                    </Td>
                  ))}
                </tr>
                {siteIds.map((id) => (
                  <tr key={id}>
                    <Td sticky strong>{nameOf(id)}</Td>
                    {metrics.map((m) => (
                      <Td key={m.key} right>
                        <CellPair metric={m.key} cellKey={targetKey(id, m.key)} siteId={id} draft={draft} saved={rows} canEdit={canEdit}
                          problem={problems[targetKey(id, m.key)]} onChange={setCell} onClear={clearCell} />
                      </Td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          )}
          {rows && !siteIds.length && <EmptyLine>No sites in scope: only the company default shows.</EmptyLine>}
        </div>
      )}

      {tab === 'key' && (
        <div data-testid="stock-key-items-tab">
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
            <div style={{ flex: '1 1 300px', ...ui.sub }}>{KEY_ITEMS_HINT}. Each tile shows the recipe amount against what the stock really used per sale.</div>
            {canEdit && (
              <Btn kind="primary" small disabled={ratioBusy || !ratios?.rows || liveRatios.length >= MAX_KEY_ITEMS}
                title={liveRatios.length >= MAX_KEY_ITEMS ? 'That is 20 key items. Archive one first.' : undefined}
                onClick={() => setEditing(keyRatioDraft(null))}>+ Add a key item</Btn>
            )}
          </div>
          <ErrorLine error={ratios?.error} />
          {!ratios && <EmptyLine>Loading key items{'…'}</EmptyLine>}
          {ratios?.rows && !liveRatios.length && <EmptyLine>No key items yet.</EmptyLine>}
          {liveRatios.length > 0 && (
            <TableWrap minWidth={680}>
              <thead>
                <tr>
                  <Th>Key item</Th>
                  <Th>Stock item used</Th>
                  <Th>Unit</Th>
                  <Th>Counts as sold</Th>
                  <Th right hint="What one sale uses">Recipe</Th>
                  {canEdit && <Th right>{''}</Th>}
                </tr>
              </thead>
              <tbody>
                {liveRatios.map((r) => (
                  <tr key={r.id}>
                    <Td strong>{r.name}</Td>
                    <Td>{itemNames[r.used_item_id] === undefined ? <span style={ui.grey}>Loading{'…'}</span> : (itemNames[r.used_item_id] || <span style={ui.grey}>Item not found</span>)}</Td>
                    <Td>{r.used_unit}</Td>
                    <Td>{soldRuleWords(r.sold_rule)}</Td>
                    <Td right num>{r.recipe_amount == null ? <span style={ui.grey}>Not set</span> : `${Number(r.recipe_amount).toLocaleString('en-GB', { maximumFractionDigits: 2 })} ${r.used_unit}`}</Td>
                    {canEdit && (
                      <Td right>
                        <span style={{ display: 'inline-flex', gap: 6 }}>
                          <Btn small kind="soft" disabled={ratioBusy} onClick={() => setEditing(keyRatioDraft(r, itemNames[r.used_item_id]))}>Edit</Btn>
                          <Btn small kind="danger" disabled={ratioBusy} onClick={() => archive(r)}>Archive</Btn>
                        </span>
                      </Td>
                    )}
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          )}
        </div>
      )}

      {editing && (
        <KeyItemEditor draft={editing} orgId={orgId} sites={siteIds} siteName={nameOf} api={api} busy={ratioBusy} live={ratios?.rows || []}
          onChange={setEditing} onClose={() => setEditing(null)}
          onSave={async () => { const r = await saveRatio(editing); if (!r.error) setEditing(null); return r; }} />
      )}

      {clash && (
        <SavedFirstModal byName={clash.byName} at={clash.at} rows={clash.rows} busy={busy}
          onKeepTheirs={() => { setClash(null); setReloads((n) => n + 1); }}
          onSaveMine={() => runSave(withFreshVersions(clash.saveRows, clash.fresh))}
          onClose={() => setClash(null)} />
      )}
    </Sheet>
  );
}

/**
 * The green and amber boxes of one site (or the company) and metric. A site pair with nothing typed
 * shows what it follows in grey placeholders; the words under say the target the site is measured
 * against and where it comes from.
 */
function CellPair({ metric, cellKey, siteId = null, draft, saved, canEdit, problem, onChange, onClear }) {
  const cell = draft[cellKey] || { green_to: '', amber_to: '' };
  const typed = parseTargetCell(cell);
  const hasValue = typed.green_to != null || typed.amber_to != null;
  const follows = effectiveTarget(saved, siteId, metric, TARGET_DEFAULTS);
  const measured = hasValue && typed.green_to != null && typed.amber_to != null && typeof typed.green_to === 'number' && typeof typed.amber_to === 'number'
    ? { green_to: typed.green_to, amber_to: typed.amber_to }
    : { green_to: follows.green_to, amber_to: follows.amber_to };
  const source = hasValue ? (siteId ? 'Own target' : 'Company default') : siteId ? (follows.source === 'site' ? 'Own target' : follows.source === 'company' ? 'Follows the company' : 'Default') : 'Default';
  const placeholder = (v) => (v == null ? '' : String(v));
  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3 }}>
      <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
        <input type="text" inputMode="decimal" aria-label={`${metric} green${siteId ? ' at this site' : ''}`} value={cell.green_to} disabled={!canEdit}
          placeholder={placeholder(follows.green_to)} onChange={(e) => onChange(cellKey, 'green_to', e.target.value)}
          style={{ ...box, borderColor: problem ? 'var(--red)' : 'var(--bdr2)', opacity: canEdit ? 1 : 0.55 }} />
        <input type="text" inputMode="decimal" aria-label={`${metric} amber${siteId ? ' at this site' : ''}`} value={cell.amber_to} disabled={!canEdit}
          placeholder={placeholder(follows.amber_to)} onChange={(e) => onChange(cellKey, 'amber_to', e.target.value)}
          style={{ ...box, borderColor: problem ? 'var(--red)' : 'var(--bdr2)', opacity: canEdit ? 1 : 0.55 }} />
      </span>
      <span style={{ ...tiny, textAlign: 'right' }}>
        {problem ? <span style={{ color: 'var(--red)' }}>{problem}</span> : (
          <>
            <span style={{ color: hasValue ? 'var(--t3)' : 'var(--t4)' }}>{source}</span>
            {' · '}
            {targetWords(metric, measured)}
            {canEdit && siteId && hasValue && <> {' '}<button type="button" style={linkBtn} onClick={() => onClear(cellKey)}>Clear</button></>}
          </>
        )}
      </span>
    </span>
  );
}

/** The add or edit box of one key item. */
function KeyItemEditor({ draft, orgId, sites, siteName, api, busy, live, onChange, onClose, onSave }) {
  const [problem, setProblem] = useState('');
  const [search, setSearch] = useState('');
  const [foundFor, setFoundFor] = useState(null);      // { q, rows }: the last answer and the words it answered
  const [productSearch, setProductSearch] = useState('');
  const [productsFor, setProductsFor] = useState(null);
  const timer = useRef(null);
  // The till products at the sites in scope (menu_items, read only, the Ops client).
  const menuProducts = typeof api?.menuProducts === 'function' ? api.menuProducts : (args) => searchMenuProducts(supabase, args);
  const canPickProducts = sites.length > 0;
  const choice = soldRuleChoice(draft.sold_rule);
  const set = (patch) => { setProblem(''); onChange({ ...draft, ...patch }); };
  // Results show only for what is typed now (two letters or more); clearing the box clears the list.
  const q = search.trim();
  const found = q.length >= 2 && foundFor && foundFor.q === q ? foundFor.rows : null;
  const pq = productSearch.trim();
  const products = pq.length >= 2 && productsFor && productsFor.q === pq ? productsFor.rows : null;

  // The stock item search: a page of company items whose name contains the words, 300 ms after typing.
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (q.length < 2) return undefined;
    timer.current = setTimeout(async () => {
      const r = await stockApi.itemsPage({ orgId, search: q, limit: 20 });
      setFoundFor({ q, rows: r.error ? [] : (r.data?.rows || []) });
    }, 300);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [q, orgId]);

  useEffect(() => {
    if (!canPickProducts || pq.length < 2) return undefined;
    let live2 = true;
    const t = setTimeout(async () => {
      const r = await menuProducts({ sites, search: pq, limit: 30 });
      if (live2) setProductsFor({ q: pq, rows: r.error ? [] : (Array.isArray(r.data) ? r.data : (r.data?.rows || [])), error: r.error || null });
    }, 300);
    return () => { live2 = false; clearTimeout(t); };
    // menuProducts is made each render from api; api and sites decide it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pq, canPickProducts, api, sites]);

  const pickItem = (it) => {
    const unit = USED_UNITS.includes(String(it.base_unit || '').toLowerCase()) ? String(it.base_unit).toLowerCase() : draft.used_unit;
    set({ used_item_id: it.id, used_item_name: it.name, used_unit: unit });
    setSearch('');
  };
  const pickChoice = (id) => {
    const c = SOLD_RULE_CHOICES.find((x) => x.id === id) || SOLD_RULE_CHOICES[0];
    const keep = draft.sold_rule || {};
    const rule = c.id === 'category' ? { kind: 'category', accounting_group: keep.kind === 'category' && !['drinks', 'food'].includes(soldRuleChoice(keep)) ? keep.accounting_group : '' }
      : c.id === 'items' ? { kind: 'items', menu_item_ids: Array.isArray(keep.menu_item_ids) ? keep.menu_item_ids : [] }
        : { ...c.rule };
    set({ sold_rule: rule });
  };
  const chosen = Array.isArray(draft.sold_rule?.menu_item_ids) ? draft.sold_rule.menu_item_ids : [];
  const toggleProduct = (id) => set({ sold_rule: { kind: 'items', menu_item_ids: chosen.includes(id) ? chosen.filter((x) => x !== id) : [...chosen, id] } });

  const save = async () => {
    const why = keyRatioProblem(draft, live);
    if (why) { setProblem(why); return; }
    const r = await onSave();
    if (r?.error) setProblem(r.error);
  };

  const dirty = !!(draft.name || draft.used_item_id || draft.recipe_amount);
  return (
    <Modal title={draft.id ? `Edit ${draft.name || 'key item'}` : 'Add a key item'} width={620} onClose={onClose} dirty={dirty && !draft.id}
      footer={(
        <>
          {problem && <div role="alert" style={{ ...ui.err, flex: '1 1 100%' }}>{problem}</div>}
          <span style={{ flex: 1 }} />
          <Btn onClick={onClose} disabled={busy}>Cancel</Btn>
          <Btn kind="primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</Btn>
        </>
      )}>
      <Field label="Name" hint="As the tile will read it, for example Milk per milk drink">
        <input value={draft.name} maxLength={80} autoFocus onChange={(e) => set({ name: e.target.value })} style={ui.input} aria-label="Name" />
      </Field>
      <Field label="Stock item it uses" hint={draft.used_item_name ? `Using ${draft.used_item_name}` : 'Type two or more letters of the item\'s name'}>
        <input value={search} placeholder={draft.used_item_name || 'Search the company stock items'} onChange={(e) => setSearch(e.target.value)} style={ui.input} aria-label="Search stock items" />
        {found && (
          <div style={{ marginTop: 6, border: '1px solid var(--bdr)', borderRadius: 9, maxHeight: 180, overflowY: 'auto', background: 'var(--bg1)' }}>
            {!found.length && <EmptyLine>No item matches that.</EmptyLine>}
            {found.map((it) => (
              <button key={it.id} type="button" onClick={() => pickItem(it)}
                style={{ display: 'flex', width: '100%', justifyContent: 'space-between', gap: 10, padding: '8px 10px', border: 'none', borderBottom: '1px solid var(--bdr)', background: 'transparent', color: 'var(--t1)', fontFamily: 'inherit', fontSize: 13, cursor: 'pointer', textAlign: 'left' }}>
                <span>{it.name}{it.name_suffix ? ` ${it.name_suffix}` : ''}</span>
                <span style={ui.grey}>{[it.category, it.base_unit].filter(Boolean).join(' · ')}</span>
              </button>
            ))}
          </div>
        )}
      </Field>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <Field label="Unit" hint="The base unit the tile shows">
          <select value={draft.used_unit} onChange={(e) => set({ used_unit: e.target.value })} style={ui.input} aria-label="Unit">
            {USED_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
          </select>
        </Field>
        <Field label="Recipe amount" hint="What the recipe says one sale uses, in that unit. Leave empty if not sure.">
          <input value={draft.recipe_amount} inputMode="decimal" placeholder="200" onChange={(e) => set({ recipe_amount: e.target.value })} style={ui.input} aria-label="Recipe amount" />
        </Field>
      </div>
      <Field label="What counts as sold">
        <select value={choice} onChange={(e) => pickChoice(e.target.value)} style={ui.input} aria-label="What counts as sold">
          {SOLD_RULE_CHOICES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
        </select>
        {choice === 'category' && (
          <input value={draft.sold_rule?.accounting_group || ''} placeholder="The menu category's accounting group, for example Retail" onChange={(e) => set({ sold_rule: { kind: 'category', accounting_group: e.target.value } })}
            style={{ ...ui.input, marginTop: 8 }} aria-label="Accounting group" />
        )}
        {choice === 'items' && !canPickProducts && (
          <div style={{ marginTop: 8 }}><Notice tone="warn">Pick at least one site first: the products come from the sites in scope.</Notice></div>
        )}
        {choice === 'items' && canPickProducts && (
          <div style={{ marginTop: 8 }}>
            <input value={productSearch} placeholder="Search the till products" onChange={(e) => setProductSearch(e.target.value)} style={ui.input} aria-label="Search products" />
            <div style={{ ...ui.sub, marginTop: 6 }}>{chosen.length ? `${chosen.length} chosen` : 'None chosen yet'}</div>
            {products && (
              <div style={{ marginTop: 6, border: '1px solid var(--bdr)', borderRadius: 9, maxHeight: 180, overflowY: 'auto', background: 'var(--bg1)' }}>
                {productsFor?.error && <ErrorLine error={productsFor.error} />}
                {!products.length && !productsFor?.error && <EmptyLine>No product matches that.</EmptyLine>}
                {products.map((p) => (
                  <label key={p.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '7px 10px', borderBottom: '1px solid var(--bdr)', fontSize: 13, cursor: 'pointer' }}>
                    <input type="checkbox" checked={chosen.includes(p.id)} onChange={() => toggleProduct(p.id)} />
                    <span>{p.name}</span>
                    {(p.site || p.location_id) && <Pill tone="neutral">{p.site || siteName(p.location_id)}</Pill>}
                  </label>
                ))}
              </div>
            )}
          </div>
        )}
      </Field>
    </Modal>
  );
}
