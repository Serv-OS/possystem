/**
 * stock/companyData.js: how the browser talks to the stock save and read functions (v5.11.84
 * Drop 0, v5.11.89 Drop 1). The client is passed in, so node --test drives every path with a stand
 * in (saveContract.test.js, companyApi.test.js); data.js, recipes.js, counts.js, areas.js and
 * stockApi.js hand in the real one.
 *
 *   callSave(client, fn, args)      one save function: { data, error, missing, conflict }
 *   callRead(client, fn, args)      one read function: the same answer, never a conflict
 *   liveOrAll(run)                  a read with archived rows left out; before 0a the column is
 *                                   not there and the read runs without the filter
 *   runRecipeSave(deps, draft, loc) the recipe, its lines and its till link in one call
 *   readAll(build)                  a table read past the 1,000 row cap (lifted from Phase 1)
 *   pollJobs(api, ids, onTick)      follows save queue jobs every 3 s until each is done or failed
 *   createStockApi(client)          every call the Drop 1 screens make, one answer shape
 *
 * Drop 1: 0b is live, so the Drop 0 fallbacks are gone. A database without a function this build
 * calls answers NEEDS_UPDATE ('This needs a database update. Ask ServOS to run it.'), never a
 * direct write to a table. Nothing here decides who may save: the database does (stock_co__guard).
 * Nothing is shown as done before the database answers.
 */

import { isMissingFunctionError } from './phase0Rules.js';
import { saveRefusal, isMissingColumnError, recipeSaveArgs, recipeSaveOutcome, NEEDS_UPDATE } from './saveRules.js';

export const PAGE_ROWS = 1000;

/**
 * True when the database has a function of this very name, only with other arguments: PostgREST
 * answers PGRST202 with a hint naming it ("Perhaps you meant to call the function
 * public.stock_save_item(...)"). That is a build that does not match its database, never "not
 * installed yet", so it is said as the database's own words.
 */
export function namesSameFunction(error, fn) {
  const text = `${error?.hint || ''} ${error?.details || ''}`;
  return !!fn && text.includes(`public.${fn}(`);
}

/** The error a screen shows when the database does not have the function yet. */
export function needsUpdateError(cause = null) {
  const err = new Error(NEEDS_UPDATE);
  err.code = 'needs_update';
  err.needsUpdate = true;
  if (cause) err.cause = cause;
  return err;
}

/** A table that is not there yet (42P01, PGRST205): the same "needs a database update". */
export const isMissingTableError = (e) => /42P01|PGRST205|relation .* does not exist|Could not find the table/i.test(`${e?.code || ''} ${e?.message || ''}`);

/**
 * Call one save function. A refusal inside a success answer ({ ok: false }, such as "someone saved
 * first") comes back as an error with the database's words, and its conflict when there is one.
 * `missing` (the database does not have the function yet) comes with the NEEDS_UPDATE words.
 */
export async function callSave(client, fn, args) {
  if (!client || typeof client.rpc !== 'function') return { data: null, error: new Error('No database'), missing: false, conflict: null };
  let res;
  try { res = await client.rpc(fn, args); } catch (e) { res = { data: null, error: e }; }
  if (res?.error) {
    const missing = isMissingFunctionError(res.error) && !namesSameFunction(res.error, fn);
    return { data: null, error: missing ? needsUpdateError(res.error) : res.error, missing, conflict: null };
  }
  const refused = saveRefusal(res?.data);
  if (refused) return { data: res.data, error: refused, missing: false, conflict: res.data?.conflict || null };
  return { data: res?.data ?? null, error: null, missing: false, conflict: null };
}

/** The read twin of callSave: { data, error, missing, conflict: null }. */
export async function callRead(client, fn, args) {
  if (!client || typeof client.rpc !== 'function') return { data: null, error: new Error('No database'), missing: false, conflict: null };
  let res;
  try { res = await client.rpc(fn, args); } catch (e) { res = { data: null, error: e }; }
  if (res?.error) {
    const missing = isMissingFunctionError(res.error) && !namesSameFunction(res.error, fn);
    return { data: null, error: missing ? needsUpdateError(res.error) : res.error, missing, conflict: null };
  }
  return { data: res?.data ?? null, error: null, missing: false, conflict: null };
}

/**
 * A read that leaves archived rows out. run(true) adds .is('archived_at', null); when the database
 * says that column does not exist (before Drop 0a) the read runs again with run(false).
 */
export async function liveOrAll(run) {
  const first = await run(true);
  if (first?.error && isMissingColumnError(first.error, 'archived_at')) return run(false);
  return first;
}

/**
 * The recipe save behind Recipes.jsx `save` and the Stock items Recipe tab.
 * deps: { client }. Answer: { data: { id, rowVersion, ... } | null, error, stage, costOk, conflict }.
 *   stage 'recipe' the recipe did not save (nothing was written; a missing function says
 *                  NEEDS_UPDATE)
 *   costOk false   the made item's cost was not rolled up (null: no made item)
 * The one call saves all of it or none of it, so it never answers 'lines' or 'link'.
 */
export async function runRecipeSave(deps, draft, locationId, opts = {}) {
  const { client } = deps || {};
  const r = await callSave(client, 'stock_save_recipe', recipeSaveArgs(draft, locationId, opts));
  if (r.error) return { data: null, error: r.error, stage: 'recipe', costOk: null, conflict: r.conflict, via: 'rpc' };
  const out = recipeSaveOutcome(r.data, draft);
  return { data: out, error: null, stage: null, costOk: draft.outputItemId ? out.costOk !== false : null, conflict: null, via: 'rpc' };
}

/** A table read past the 1,000 row cap: pages in a fixed order; a failed page is a failure. */
export async function readAll(build, max = 50) {
  const rows = [];
  for (let p = 0; p < max; p++) {
    let res;
    try { res = await build().range(p * PAGE_ROWS, p * PAGE_ROWS + PAGE_ROWS - 1); } catch (e) { res = { data: null, error: e }; }
    if (res?.error) return { data: null, error: res.error };
    rows.push(...(res?.data || []));
    if (!res?.data || res.data.length < PAGE_ROWS) return { data: rows, error: null };
  }
  return { data: null, error: new Error('Too many rows to show at once.') };
}

// ── the Drop 1 calls ──────────────────────────────────────────────────────────────────────────

/** The one answer shape of every stockApi method: { data, error, needsUpdate, conflict, queued }. */
export function answerOf(r) {
  const data = r?.data ?? null;
  const queued = Array.isArray(data?.queued) ? data.queued : [];
  return { data, error: r?.error || null, needsUpdate: !!r?.missing, conflict: r?.conflict || null, queued };
}

/** A table read in the same answer shape; a missing table or column says NEEDS_UPDATE. */
async function tableAnswer(run) {
  let res;
  try { res = await run(); } catch (e) { res = { data: null, error: e }; }
  if (res?.error) {
    const missing = isMissingTableError(res.error) || isMissingColumnError(res.error);
    return { data: null, error: missing ? needsUpdateError(res.error) : res.error, needsUpdate: missing, conflict: null, queued: [] };
  }
  return { data: res?.data ?? null, error: null, needsUpdate: false, conflict: null, queued: [] };
}

const nil = (v) => (v === undefined ? null : v);
const MAX_JOB_IDS = 100;

/**
 * Every call the Drop 1 screens make (contract 2.2). Each method is async, never throws, and
 * answers { data, error, needsUpdate, conflict, queued }.
 */
export function createStockApi(client) {
  const save = async (fn, args) => answerOf(await callSave(client, fn, args));
  const read = async (fn, args) => answerOf(await callRead(client, fn, args));
  const from = (table) => client.from(table);
  const noDb = () => ({ data: null, error: new Error('No database'), needsUpdate: false, conflict: null, queued: [] });
  const table = (run) => (client && typeof client.from === 'function' ? tableAnswer(run) : Promise.resolve(noDb()));
  return {
    // ── reads ──
    itemsPage: ({ orgId, sites = null, search = null, filters = null, after = null, limit = 100 } = {}) =>
      read('stock_items_page', { p_org: orgId, p_sites: nil(sites), p_search: search || null, p_filters: filters || null, p_after: after || null, p_limit: limit }),
    itemDetail: (itemId) => read('stock_item_detail', { p_item: itemId }),
    itemUsedIn: (itemId, after = null) => read('stock_item_used_in', { p_item: itemId, p_after: after || null, p_limit: 100 }),
    changesPage: (entity, id, after = null) => read('stock_changes_page', { p_entity: entity, p_id: id, p_after: after || null, p_limit: 100 }),
    suppliersPage: ({ orgId, sites = null, search = null, filters = null, after = null } = {}) =>
      read('stock_suppliers_page', { p_org: orgId, p_sites: nil(sites), p_search: search || null, p_filters: filters || null, p_after: after || null, p_limit: 100 }),
    supplierDetail: (supplierId) => read('stock_supplier_detail', { p_supplier: supplierId }),
    pricesPage: ({ supplierId, siteId = null, search = null, after = null } = {}) =>
      read('stock_prices_page', { p_supplier: supplierId, p_site: siteId || null, p_search: search || null, p_after: after || null, p_limit: 100 }),
    needsAttention: (orgId, sites = null) => read('stock_needs_attention', { p_org: orgId, p_sites: nil(sites) }),
    pausedItems: (locationId) => read('stock_paused_items', { p_location: locationId }),
    goLivePlan: (locationId) => read('stock_golive_plan', { p_location: locationId }),
    importCheck: (jobId, after = null) => read('stock_import_check', { p_job: jobId, p_after: after || null, p_limit: 200 }),
    categories: (orgId, { archived = false } = {}) => table(() => {
      let q = from('stock_co_categories').select('id, name, accounting_code, gp_target_pct, sort_order, archived_at, row_version').eq('org_id', orgId);
      if (!archived) q = q.is('archived_at', null);
      return q.order('sort_order').order('name').limit(1000);
    }),
    settings: async (orgId) => {
      if (!client || typeof client.from !== 'function') return noDb();
      const [co, sites] = await Promise.all([
        tableAnswer(() => from('stock_co_settings').select('*').eq('org_id', orgId).maybeSingle()),
        tableAnswer(() => from('stock_co_site_settings').select('location_id, cost_rule_override, waste_pin_over_value, count_second_approval_over, row_version').eq('org_id', orgId).limit(1000)),
      ]);
      const bad = co.error ? co : sites.error ? sites : null;
      if (bad) return bad;
      return { data: { settings: co.data || null, sites: sites.data || [] }, error: null, needsUpdate: false, conflict: null, queued: [] };
    },
    siteAreas: (locationId) => table(() => from('storage_areas').select('id, name, kind, sort_order')
      .eq('location_id', locationId).is('archived_at', null).order('sort_order').order('name').limit(1000)),
    // Integrator (Drop 1): the item page's Purchase VAT choices are every rate of the company's sites.
    siteTaxRates: (siteIds) => {
      const list = [...new Set((siteIds || []).filter(Boolean))].slice(0, MAX_JOB_IDS);
      if (!list.length) return Promise.resolve({ data: [], error: null, needsUpdate: false, conflict: null, queued: [] });
      return table(() => from('tax_rates').select('rate, name, active, location_id').in('location_id', list)
        .order('location_id').order('id').limit(1000));
    },
    // Integrator (Drop 1): the site groups with their row_version (stock_save_site_group checks it on an edit).
    siteGroups: (orgId) => table(() => from('stock_co_site_groups').select('id, name, location_ids, sort_order, row_version')
      .eq('org_id', orgId).order('sort_order').order('name').limit(1000)),
    queueJobs: (ids) => {
      const list = [...new Set((ids || []).filter((x) => x != null))].slice(0, MAX_JOB_IDS);
      if (!list.length) return Promise.resolve({ data: [], error: null, needsUpdate: false, conflict: null, queued: [] });
      return table(() => from('stock_save_queue').select('id, location_id, kind, status, progress, last_error, done_at').in('id', list));
    },
    catchingUp: (entityIds) => {
      const list = [...new Set((entityIds || []).filter(Boolean))].slice(0, MAX_JOB_IDS);
      if (!list.length) return Promise.resolve({ data: [], error: null, needsUpdate: false, conflict: null, queued: [] });
      return table(() => from('stock_save_queue').select('id, location_id, kind, status')
        .in('status', ['waiting', 'running']).overlaps('entity_ids', list).limit(100));
    },
    // ── items ──
    saveItem: ({ item, sites = null, version = null, section = 'inventory' } = {}) =>
      save('stock_save_item', { p_item: item, p_sites: nil(sites), p_version: nil(version), p_section: section }),
    archiveItem: (id, version, archived = true) =>
      save('stock_archive_item', { p_item: id, p_version: nil(version), p_archived: archived !== false, p_section: 'inventory' }),
    saveItemSite: (itemId, locationId, patch, version = null) =>
      save('stock_save_item_site', { p_item: itemId, p_location: locationId, p_patch: patch || {}, p_version: nil(version), p_section: 'inventory' }),
    setItemSites: ({ items, add = [], remove = [] } = {}) =>
      save('stock_set_item_sites', { p_items: items || [], p_add: add || [], p_remove: remove || [], p_section: 'inventory' }),
    pauseItems: ({ items, sites = null, from: fromDay = null, until = null, paused = true, section = 'inventory' } = {}) =>
      save('stock_pause_items', { p_items: items || [], p_sites: nil(sites), p_from: fromDay || null, p_until: until || null, p_paused: paused !== false, p_section: section }),
    savePack: (pack, version = null) => save('stock_save_pack', { p_pack: pack, p_version: nil(version), p_section: 'inventory' }),
    archivePack: (id, version = null, archived = true) => save('stock_archive_pack', { p_pack: id, p_version: nil(version), p_archived: archived !== false, p_section: 'inventory' }),
    setPackDefault: (id, which, version = null) => save('stock_set_pack_default', { p_pack: id, p_which: which === 'purchase' ? 'purchase' : 'count', p_version: nil(version), p_section: 'inventory' }),
    saveBridge: (bridge, version = null) => save('stock_save_bridge', { p_bridge: bridge, p_version: nil(version), p_section: 'inventory' }),
    archiveBridge: (id, version = null, archived = true) => save('stock_archive_bridge', { p_bridge: id, p_version: nil(version), p_archived: archived !== false, p_section: 'inventory' }),
    // ── suppliers ──
    saveSupplier: ({ supplier, sites = null, version = null, section = 'purchasing' } = {}) =>
      save('stock_save_supplier', { p_supplier: supplier, p_sites: nil(sites), p_version: nil(version), p_section: section }),
    archiveSupplier: (id, version, archived = true) =>
      save('stock_archive_supplier', { p_supplier: id, p_version: nil(version), p_archived: archived !== false, p_section: 'purchasing' }),
    saveSupplierSite: (supplierId, locationId, patch, version = null) =>
      save('stock_save_supplier_site', { p_supplier: supplierId, p_location: locationId, p_patch: patch || {}, p_version: nil(version), p_section: 'purchasing' }),
    saveSupplierItem: (si, version = null, section = 'purchasing') =>
      save('stock_save_supplier_item', { p_si: si, p_version: nil(version), p_section: section }),
    saveSupplierItemSite: (siId, locationId, patch, version = null, section = 'purchasing') =>
      save('stock_save_supplier_item_site', { p_si: siId, p_location: locationId, p_patch: patch || {}, p_version: nil(version), p_section: section }),
    archiveSupplierItem: (id, version = null, archived = true, section = 'purchasing') =>
      save('stock_archive_supplier_item', { p_si: id, p_version: nil(version), p_archived: archived !== false, p_section: section }),
    saveOrderRules: (supplierId, locationId, rules, version = null) =>
      save('stock_save_order_rules', { p_supplier: supplierId, p_location: locationId, p_rules: rules || [], p_version: nil(version), p_section: 'purchasing' }),
    copyOrderRules: (supplierId, fromId, toIds) =>
      save('stock_copy_order_rules', { p_supplier: supplierId, p_from: fromId, p_to: toIds || [], p_section: 'purchasing' }),
    // ── prices, imports, copy a site ──
    changePrices: (spec, { preview = true, section = 'inventory' } = {}) =>
      save('stock_change_prices', { p_spec: spec, p_preview: preview !== false, p_section: section }),
    cancelDatedPrice: (id, section = 'inventory') => save('stock_cancel_dated_price', { p_id: id, p_section: section }),
    importStage: (jobId, rows, meta = null) => save('stock_import_stage', { p_job: jobId || null, p_rows: rows || [], p_meta: meta || null }),
    importCommit: (jobId, sites = null) => save('stock_import_commit', { p_job: jobId, p_sites: nil(sites) }),
    importCancel: (jobId) => save('stock_import_cancel', { p_job: jobId }),
    copySite: (fromId, toId) => save('stock_copy_site', { p_from: fromId, p_to: toId, p_section: 'inventory' }),
    // ── company settings ──
    saveCategory: (cat, version = null) => save('stock_save_category', { p_cat: cat, p_version: nil(version), p_section: 'inventory' }),
    archiveCategory: (id, version = null, archived = true) => save('stock_archive_category', { p_id: id, p_version: nil(version), p_archived: archived !== false, p_section: 'inventory' }),
    saveSettings: (orgId, patch, version = null) => save('stock_save_settings', { p_org: orgId, p_patch: patch || {}, p_version: nil(version) }),
    saveCostRule: (orgId, rule, overrideLocationId = null) => save('stock_save_cost_rule', { p_org: orgId, p_rule: rule, p_override_location: overrideLocationId || null }),
    makeCompanyRecord: (entity, id, version = null) =>
      save('stock_make_company_record', { p_entity: entity, p_id: id, p_version: nil(version), p_section: entity === 'supplier' ? 'purchasing' : 'inventory' }),
    saveGoLiveStep: (locationId, step, version = null) => save('stock_save_golive_step', { p_loc: locationId, p_step: step, p_version: nil(version) }),
    saveSiteGroup: (group) => save('stock_save_site_group', { p_group: group }),
    deleteSiteGroup: (id) => save('stock_delete_site_group', { p_id: id }),
    setStockControl: (userId, level) => save('set_stock_control', { p_user: userId, p_level: level }),
    suggestChange: (entity, id, text) => save('stock_suggest_change', { p_entity: entity, p_id: id, p_text: text }),
    resyncSite: (locationId) => save('stock_resync_site', { p_loc: locationId }),
  };
}

const finishedJob = (j) => j && (j.status === 'done' || j.status === 'failed');

/**
 * Follow save queue jobs: api.queueJobs(ids) now and every `everyMs` until every job is done or
 * failed (or stopWhen(rows) says so, or the database does not have the queue), calling
 * onTick(rows) each time. Returns a stop function. No realtime: a poll, at most 100 ids.
 * opts.timers ({ set, clear }) is for tests.
 */
export function pollJobs(api, ids, onTick, { everyMs = 3000, stopWhen = null, timers = null } = {}) {
  const set = timers?.set || ((fn, ms) => setTimeout(fn, ms));
  const clear = timers?.clear || ((t) => clearTimeout(t));
  const list = [...new Set((ids || []).filter((x) => x != null))].slice(0, MAX_JOB_IDS);
  let stopped = false;
  let timer = null;
  const stop = () => { stopped = true; if (timer != null) clear(timer); timer = null; };
  if (!list.length || !api || typeof api.queueJobs !== 'function') return stop;
  const tick = async () => {
    timer = null;
    if (stopped) return;
    let r;
    try { r = await api.queueJobs(list); } catch (e) { r = { data: null, error: e }; }
    if (stopped) return;
    const rows = Array.isArray(r?.data) ? r.data : [];
    try { onTick?.(rows, r); } catch { /* the screen's own problem */ }
    if (r?.needsUpdate) { stopped = true; return; }
    const seen = new Set(rows.map((j) => String(j.id)));
    const allDone = !r?.error && list.every((id) => seen.has(String(id))) && rows.every(finishedJob);
    let stopNow = false;
    try { stopNow = !!(stopWhen && stopWhen(rows)); } catch { stopNow = false; }
    if (allDone || stopNow) { stopped = true; return; }
    timer = set(tick, everyMs);
  };
  tick();
  return stop;
}
