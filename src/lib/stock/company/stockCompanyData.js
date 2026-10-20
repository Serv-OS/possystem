// src/lib/stock/company/stockCompanyData.js
//
// MULTI SITE STOCK, Phase 1 (v5.11.80): the screens' data layer for Shared stock. Every call goes
// to a database function of 20261019c, which checks who is asking itself; nothing is shown as done
// before the database answers (the vanishing categories lesson); every write reports to saveHealth;
// "not installed" (the update has not run) hides the feature instead of breaking a screen.
//
// A FACTORY so node:test drives it with a stand in client; the real one is stockCompanyApi.js.

import { accessFromRpc, isNotInstalledError, refusalWords } from './stockCompanyRules.js';

export const PAGE_ROWS = 1000;

export function createStockCompanyData({ client, report = () => {} } = {}) {
  const ok = (data) => ({ ok: true, data, error: null, words: '' });
  const bad = (error) => ({ ok: false, data: null, error, words: refusalWords(error), notInstalled: isNotInstalledError(error) });
  const rpc = async (name, args, entity = null) => {
    if (!client) return bad(new Error('No database'));
    let res;
    try { res = await client.rpc(name, args); } catch (e) { res = { data: null, error: e }; }
    if (entity) report(entity, res.error && !isNotInstalledError(res.error) ? res.error : null);
    return res.error ? bad(res.error) : ok(res.data);
  };
  // A table read past the 1,000 row cap: pages in a fixed order, a failed page is a failure.
  const readAll = async (build, max = 50) => {
    const rows = [];
    for (let p = 0; p < max; p++) {
      let res;
      try { res = await build().range(p * PAGE_ROWS, p * PAGE_ROWS + PAGE_ROWS - 1); } catch (e) { res = { data: null, error: e }; }
      if (res.error) return bad(res.error);
      rows.push(...(res.data || []));
      if (!res.data || res.data.length < PAGE_ROWS) return ok(rows);
    }
    return bad(new Error('Too many rows to show at once.'));
  };

  return {
    // ── who may open it ──────────────────────────────────────────────────────
    async access(orgId = null) {
      if (!client) return accessFromRpc(null, orgId);
      let res;
      try { res = await client.rpc('stock_my_access'); } catch (e) { res = { data: null, error: e }; }
      return accessFromRpc(res, orgId);
    },

    // ── ServOS (Company Admin) ───────────────────────────────────────────────
    adminStatus: (orgId) => rpc('stock_admin_status', { p_org: orgId }),
    adminSetEnabled: (orgId, on) => rpc('stock_admin_set_enabled', { p_org: orgId, p_on: !!on }, 'Shared stock switch'),
    adminSetMember: (orgId, userId, role) => rpc('stock_admin_set_member', { p_org: orgId, p_user: userId, p_role: role || null }, 'Shared stock people'),

    // ── pages (one value each: never past the row cap) ──────────────────────
    itemsPage: (orgId, { search = null, filter = null, offset = 0, limit = 100 } = {}) =>
      rpc('msm_stock_items_page', { p_org: orgId, p_search: search || null, p_filter: filter || null, p_offset: offset, p_limit: limit }),
    itemDetail: (orgId, itemId) => rpc('msm_stock_item_detail', { p_org: orgId, p_item: itemId }),
    suppliersPage: (orgId, { search = null, offset = 0, limit = 100 } = {}) =>
      rpc('msm_stock_suppliers_page', { p_org: orgId, p_search: search || null, p_offset: offset, p_limit: limit }),
    pricesPage: (orgId, { supplierId = null, search = null, offset = 0, limit = 100 } = {}) =>
      rpc('msm_stock_prices_page', { p_org: orgId, p_supplier: supplierId, p_search: search || null, p_offset: offset, p_limit: limit }),
    history: (orgId, { offset = 0, limit = 50 } = {}) => rpc('msm_stock_history', { p_org: orgId, p_offset: offset, p_limit: limit }),
    versionRows: (orgId, versionId, locationId, { offset = 0, limit = 200 } = {}) =>
      rpc('msm_stock_version_rows_page', { p_org: orgId, p_version: versionId, p_loc: locationId, p_offset: offset, p_limit: limit }),
    siteCards: (orgId) => rpc('msm_stock_site_cards', { p_org: orgId }),
    siteDrift: (orgId, locationId) => rpc('msm_stock_site_drift', { p_org: orgId, p_loc: locationId }),
    linkCandidates: (orgId, locationId, { offset = 0, limit = 500 } = {}) =>
      rpc('msm_stock_link_candidates', { p_org: orgId, p_loc: locationId, p_offset: offset, p_limit: limit }),

    /** One page of the open draft for the Review screen, each change with its names. { total, rows } */
    draftRows: (orgId, { offset = 0, limit = 300 } = {}) => rpc('msm_stock_draft_rows', { p_org: orgId, p_offset: offset, p_limit: limit }),

    /** The open draft's staged changes (every page). { ok, data: rows } */
    async draft(orgId) {
      if (!client) return ok([]);
      const d = await readAll(() => client.from('msm_stock_drafts').select('id').eq('org_id', orgId).eq('status', 'open').order('id'), 1);
      if (!d.ok) return d;
      const draftId = d.data[0]?.id;
      if (!draftId) return ok([]);
      return readAll(() => client.from('msm_stock_changes').select('id,target,entity_id,location_id,data,updated_at')
        .eq('draft_id', draftId).order('updated_at').order('id'));
    },

    // ── edits (into the draft) ───────────────────────────────────────────────
    async stage(orgId, changes) {
      const list = Array.isArray(changes) ? changes : [];
      let last = ok({ staged: 0 });
      for (let i = 0; i < list.length; i += 2000) {
        last = await rpc('msm_stock_stage', { p_org: orgId, p_changes: list.slice(i, i + 2000) }, 'Shared stock draft');
        if (!last.ok) return last;
      }
      return last;
    },
    unstage: (orgId, ids = null) => rpc('msm_stock_unstage', { p_org: orgId, p_ids: ids }, 'Shared stock draft'),
    stageSites: (orgId, { items = null, sites = null, on = true, withSuppliers = true } = {}) =>
      rpc('msm_stock_stage_sites', { p_org: orgId, p_items: items, p_sites: sites, p_on: !!on, p_with_suppliers: !!withSuppliers }, 'Shared stock draft'),
    copySites: (orgId, fromId, toId) => rpc('msm_stock_copy_sites', { p_org: orgId, p_from: fromId, p_to: toId }, 'Shared stock draft'),
    stageLinks: (orgId, locationId) => rpc('msm_stock_stage_links', { p_org: orgId, p_loc: locationId }, 'Shared stock draft'),
    changePrices: (orgId, { spIds = null, supplierId = null, pct = null, amount = null, sites = null, preview = true } = {}) =>
      rpc('msm_stock_change_prices', { p_org: orgId, p_sp_ids: spIds, p_supplier: supplierId, p_pct: pct, p_amount: amount, p_sites: sites, p_preview: !!preview },
        preview ? null : 'Shared stock prices'),

    // ── preview, publish, undo ───────────────────────────────────────────────
    preview: (orgId, sites = null) => rpc('msm_stock_preview', { p_org: orgId, p_sites: sites }),
    publish: (orgId, when = 'night', note = null) => rpc('msm_stock_publish', { p_org: orgId, p_when: when, p_note: note }, 'Shared stock publish'),
    runNow: (orgId, versionId) => rpc('msm_stock_run_now', { p_org: orgId, p_version: versionId }, 'Shared stock publish'),
    undo: (orgId, versionId) => rpc('msm_stock_undo', { p_org: orgId, p_version: versionId }, 'Shared stock undo'),
    keepSite: (orgId, locationId, kind, companyId) => rpc('msm_stock_keep_site', { p_org: orgId, p_loc: locationId, p_kind: kind, p_company_id: companyId }, 'Shared stock'),

    // ── set up ───────────────────────────────────────────────────────────────
    startFromSite: (orgId, locationId) => rpc('msm_stock_start_from_site', { p_org: orgId, p_loc: locationId }, 'Start from a site'),
    addAreas: (orgId, sites = null) => rpc('msm_stock_add_areas', { p_org: orgId, p_sites: sites }, 'Stock areas'),
    async importRows(orgId, importId, kind, rows) {
      for (let i = 0; i < rows.length; i += 2000) {
        const r = await rpc('msm_stock_import_stage', { p_org: orgId, p_import: importId, p_kind: kind, p_first_row: i + 1, p_rows: rows.slice(i, i + 2000) });
        if (!r.ok) return r;
      }
      return ok({ rows: rows.length });
    },
    importCommit: (orgId, importId, preview = true) => rpc('msm_stock_import_commit', { p_org: orgId, p_import: importId, p_preview: !!preview }, preview ? null : 'Stock import'),

    // ── the site's own screens ───────────────────────────────────────────────
    siteStatus: (locationId) => rpc('msm_stock_site_status', { p_location_id: locationId }),
  };
}
