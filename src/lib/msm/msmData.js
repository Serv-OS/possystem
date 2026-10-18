// src/lib/msm/msmData.js
//
// MULTI SITE MENU (17 Oct 2026, v5.11.75): the screens' data layer. Every read is paged past the
// 1,000 row cap; every write reports to saveHealth (the red banner) and is never shown as done
// before the database said so (the vanishing categories lesson); every call works out "not
// installed" (the migration has not run) and hides the feature rather than breaking a screen.
//
// A FACTORY, so node:test drives it with src/lib/msm/fakeClient.js (it imports no Supabase client
// and no Vite environment). The real one is wired in src/lib/msm/msmApi.js.
//
//   const api = createMsmData({ client, report, now })
//     client   the Ops Supabase client (the signed in person's: row level security decides)
//     report   saveHealth's reportSave(entity, error)
//
// STAGING AND TWO EDITORS (design review: several named drafts, compare and set)
//   Each edit is one msm_changes row per target, entity and site in the draft the person is
//   "Working on" (mergeStaged keeps the FIRST before). An update is sent with
//   `.eq('updated_at', <the row's time when this screen read it>)`; if another editor changed
//   that cell in between, nothing matches and the screen is told { conflict: true } with the
//   row as it is now, never a silent last write wins.

import { readCentral, readChanges, readLiveMenu, readHistory } from '../../../supabase/functions/_shared/msmRead.js';
import { readVenueRaw, readAllRows } from '../../../supabase/functions/_shared/venueMenuCore.js';
import { accessFromRpc, isNotInstalled } from '../../../supabase/functions/_shared/msmAccess.js';
import { mergeStaged, changeKey } from '../../../supabase/functions/_shared/msmDiff.js';

export const ACCESS_TIMEOUT_MS = 15000;

const race = (p, ms, label) => {
  let t;
  return Promise.race([
    Promise.resolve(p).finally(() => clearTimeout(t)),
    new Promise((_, rej) => { t = setTimeout(() => rej(Object.assign(new Error(`${label} took too long`), { code: 'TIMEOUT' })), ms); }),
  ]);
};
// Plain words for a database refusal, for the screen.
export const refusalWords = (error) => {
  const m = String(error?.message || error || '');
  if (!m) return 'It did not save. Try again.';
  if (/row-level security|42501/i.test(m)) return 'You cannot change the group menu (only people ServOS added as an editor can).';
  if (/jwt|expired|401/i.test(m)) return 'Your sign in has expired. Sign in again; nothing was saved.';
  return m.replace(/^ERROR:\s*/, '').slice(0, 300);
};

export function createMsmData({ client, report = () => {}, invokeTimeoutMs = 60000 } = {}) {
  let accessSeq = 0;
  const ok = (data) => ({ ok: true, data, error: null });
  const bad = (error, extra = {}) => ({ ok: false, data: null, error, words: refusalWords(error), notInstalled: isNotInstalled(error), ...extra });
  const write = (entity, res) => { report(entity, res?.error || null); return res; };
  const rpc = async (name, args, entity = null) => {
    if (!client) return bad(new Error('No database'));
    let res;
    try { res = await client.rpc(name, args); } catch (e) { res = { data: null, error: e }; }
    if (entity) report(entity, res.error && !isNotInstalled(res.error) ? res.error : null);
    return res.error ? bad(res.error) : ok(res.data);
  };

  const api = {
    // ── Access (the Admin gate) ───────────────────────────────────────────
    /**
     * May this login open the Multi site menu? Fail closed. A later call wins over an earlier one
     * that answers late (stale guard), so a sign out and sign in never shows the last person's.
     * Returns accessFromRpc(...) plus { stale } when a newer read has started.
     */
    async readAccess(orgId = null, { timeoutMs = ACCESS_TIMEOUT_MS } = {}) {
      const seq = ++accessSeq;
      let res;
      try { res = await race(client ? client.rpc('msm_my_access') : Promise.resolve({ error: new Error('No database') }), timeoutMs, 'Multi site menu access'); }
      catch (e) { res = { data: null, error: e }; }
      const out = accessFromRpc(res, orgId);
      return seq === accessSeq ? out : { ...out, canOpen: false, canEdit: false, stale: true };
    },

    // ── Reads ─────────────────────────────────────────────────────────────
    liveMenu: (orgId) => readLiveMenu(client, orgId),
    central: (menuId) => readCentral(client, menuId),
    changes: (setId) => readChanges(client, setId),
    history: (menuId, opts) => readHistory(client, menuId, opts),
    /**
     * What one publish wrote at each site (msm_version_sites.writes: the exact before and after of
     * every column), for the history's per site detail. { rows: [{ location_id, writes }], error }.
     */
    versionDetail: (versionId) => readAllRows(() => client.from('msm_version_sites').select('location_id,writes').eq('version_id', versionId).order('location_id')),
    /** Drafts and scheduled or running sets of a menu, newest first. */
    sets: (menuId) => readAllRows(() => client.from('msm_change_sets').select('*').eq('menu_id', menuId).in('status', ['draft', 'scheduled', 'running']).order('created_at', { ascending: false }).order('id')),
    /** A venue's rows, fresh and paged (for the import, the preview and drift). */
    venue: (locationId) => readVenueRaw(client, locationId),
    async venues(locationIds) {
      const out = {};
      const failed = [];
      await Promise.all((locationIds || []).map(async (l) => {
        const r = await readVenueRaw(client, l);
        if (r.ok) out[l] = r; else failed.push(l);
      }));
      return { venues: out, failed };
    },
    /**
     * The venue products the group menu manages at a venue, for the Menu Manager lock. null when
     * it cannot be read (not installed, switched off or a failure): Menu Manager then behaves as
     * today (the lock is a convenience, the database is the guard).
     * Returns Map(venueItemId -> { productId, kept: [columns] }) or null.
     */
    async managedItems(locationId) {
      if (!client || !locationId) return null;
      try {
        const res = await client.rpc('msm_managed_items', { p_location: locationId });
        if (res.error) return null;
        return new Map((res.data || []).map((r) => [r.venue_item_id, { productId: r.product_id, kept: r.kept || [] }]));
      } catch { return null; }
    },

    /**
     * Round 2: the option groups the group menu manages at a venue (Menu Manager lock, the sharing
     * engine's own gate). null when it cannot be read. Returns Map(venueGroupId -> { groupId,
     * kept: [columns], optionIds: [venue option ids the group menu owns there] }).
     */
    async managedGroups(locationId) {
      if (!client || !locationId) return null;
      try {
        const res = await client.rpc('msm_managed_groups', { p_location: locationId });
        if (res.error) return null;
        return new Map((res.data || []).map((r) => [r.venue_group_id, { groupId: r.group_id, kept: r.kept || [], optionIds: r.option_ids || [] }]));
      } catch { return null; }
    },
    /** Round 2: { ok, on, groups, items } at several venues at once (public.msm_managed_at). */
    async managedAt(locationIds) {
      const r = await rpc('msm_managed_at', { p_locations: [...new Set(locationIds || [])] });
      return r.ok ? { ok: true, on: r.data?.on === true, groups: r.data?.groups || [], items: r.data?.items || [] } : { ok: false, error: r.error, notInstalled: r.notInstalled };
    },
    /**
     * Round 2: how many of each venue product sold at each site in the last `days` days (the
     * "removing something that sells" tick). { ok, rows: [{ location_id, venue_item_id, sold }] }.
     */
    async soldRecently(menuId, days = 7, venueItemIds = null) {
      const r = await rpc('msm_sold_recently', { p_menu: menuId, p_days: days, p_item_ids: venueItemIds && venueItemIds.length ? venueItemIds : null });
      return r.ok ? { ok: true, rows: r.data || [] } : { ok: false, rows: [], error: r.error };
    },
    /** Round 2: which sites are trading now, with their local time. { ok, rows: [{ location_id, trading, local_time }] }. */
    async sitesTrading(menuId) {
      const r = await rpc('msm_sites_trading', { p_menu: menuId });
      return r.ok ? { ok: true, rows: r.data || [] } : { ok: false, rows: [], error: r.error };
    },
    /** Round 2: which order types the screens show (a setting: no draft, no publish, editors only). */
    setOrderTypes: (menuId, types) => rpc('msm_set_order_types', { p_menu: menuId, p_types: types == null ? null : [...new Set(types)] }, 'multi site menu order types'),
    /** Round 2: 2 once 20261017c has run, 1 before (the function is missing), null on a failure. */
    async sqlContract() {
      const r = await rpc('msm_sql_contract', {});
      if (r.ok) return Number(r.data) || 1;
      return r.notInstalled ? 1 : null;
    },
    /**
     * Round 2: the one time option group refresh (design 1.9). The msm-publish function reads every
     * site, brings the groups in as rows and proves zero writes first; nothing is saved otherwise.
     * Returns { ok, data: { counts, words } } or { ok: false, words }.
     */
    async refreshGroups(menuId) {
      if (!client?.functions?.invoke) return bad(new Error('No functions'));
      try {
        const res = await race(client.functions.invoke('msm-publish', { body: { action: 'refresh_groups', menu_id: menuId } }), invokeTimeoutMs, 'Refreshing option groups');
        report('multi site menu refresh', res.error || (res.data && res.data.ok === false ? new Error(res.data.error || 'not saved') : null));
        if (res.error) return bad(res.error);
        if (res.data && res.data.ok === false) return { ok: false, data: res.data, error: null, words: res.data.error || res.data.words || 'Nothing was changed.' };
        return ok(res.data);
      } catch (e) { report('multi site menu refresh', e); return bad(e); }
    },

    // ── Drafts ────────────────────────────────────────────────────────────
    async createDraft(menuId, title, kind = 'edit', { undoOf = null } = {}) {
      const t = String(title || '').trim().slice(0, 80);
      if (!t) return bad(new Error('Give the set of changes a name.'));
      const row = { menu_id: menuId, org_id: '00000000-0000-0000-0000-000000000000', title: t, kind };
      if (undoOf) row.undo_of_version = undoOf;
      const res = write('multi site menu draft', await client.from('msm_change_sets').insert(row).select('*').maybeSingle());
      return res.error ? bad(res.error) : ok(res.data);
    },
    async renameDraft(setId, title) {
      const t = String(title || '').trim().slice(0, 80);
      if (!t) return bad(new Error('Give the set of changes a name.'));
      const res = write('multi site menu draft', await client.from('msm_change_sets').update({ title: t }).eq('id', setId).eq('status', 'draft').select('id'));
      if (res.error) return bad(res.error);
      return res.data?.length ? ok(true) : bad(new Error('That set is no longer a draft.'));
    },
    async discardDraft(setId) {
      const res = write('multi site menu draft', await client.from('msm_change_sets').delete().eq('id', setId).eq('status', 'draft').select('id'));
      return res.error ? bad(res.error) : ok(true);
    },

    // ── Staging (compare and set) ─────────────────────────────────────────
    /**
     * Stage one edit into a draft.
     *   existing   the row this screen holds for the same target, entity and site (or null)
     *   change     { target, entity_id, location_id, op, after, before }
     * Returns { ok, action, row, conflict, words }.
     */
    async stage(setId, change, existing = null) {
      const m = mergeStaged(existing, change);
      if (m.action === 'none') return { ok: !m.words, action: 'none', row: existing, words: m.words || '' };
      const entity = 'multi site menu change';
      if (m.action === 'insert') {
        const row = { change_set_id: setId, menu_id: '00000000-0000-0000-0000-000000000000', org_id: '00000000-0000-0000-0000-000000000000', target: m.row.target, entity_id: m.row.entity_id, location_id: m.row.location_id || null, op: m.row.op, after: m.row.after, before: m.row.before || {} };
        const res = await client.from('msm_changes').insert(row).select('*').maybeSingle();
        if (res.error && /duplicate key|23505/i.test(String(res.error.message || res.error.code))) {
          report(entity, null);
          return { ok: false, action: 'insert', conflict: true, row: null, words: 'Someone else changed this at the same moment. It shows their change now; make yours again if it is still needed.' };
        }
        write(entity, res);
        return res.error ? { ...bad(res.error), action: 'insert' } : { ok: true, action: 'insert', row: res.data };
      }
      if (m.action === 'delete') {
        let q = client.from('msm_changes').delete().eq('id', existing.id);
        if (existing.updated_at) q = q.eq('updated_at', existing.updated_at);
        const res = write(entity, await q.select('id'));
        if (res.error) return { ...bad(res.error), action: 'delete' };
        if (!res.data?.length) return { ok: false, action: 'delete', conflict: true, row: existing, words: 'Someone else changed this at the same moment. It shows their change now.' };
        return { ok: true, action: 'delete', row: null };
      }
      let q = client.from('msm_changes').update({ op: m.row.op, after: m.row.after, before: m.row.before }).eq('id', existing.id);
      if (existing.updated_at) q = q.eq('updated_at', existing.updated_at);
      const res = write(entity, await q.select('*'));
      if (res.error) return { ...bad(res.error), action: 'update' };
      if (!res.data?.length) return { ok: false, action: 'update', conflict: true, row: existing, words: 'Someone else changed this at the same moment. It shows their change now; make yours again if it is still needed.' };
      return { ok: true, action: 'update', row: res.data[0] };
    },
    /**
     * Stage many edits (Change prices, the CSV import, Keep the venue's, Add a site, Undo).
     *   rows       the draft's current rows (to merge into)
     * Returns { ok, done, conflicts, failed: [{ change, words }] }. One at a time, in order, so a
     * failure says exactly which one.
     */
    async stageMany(setId, changes, rows = []) {
      const by = new Map((rows || []).map((r) => [changeKey(r), r]));
      let done = 0, conflicts = 0;
      const failed = [];
      for (const c of changes || []) {
        const r = await api.stage(setId, c, by.get(changeKey(c)) || null);
        if (r.ok && r.action === 'none') continue;
        if (r.ok) { done++; if (r.row) by.set(changeKey(r.row), r.row); else by.delete(changeKey(c)); }
        else if (r.conflict) conflicts++;
        else if (r.action !== 'none') failed.push({ change: c, words: r.words });
      }
      return { ok: !failed.length && !conflicts, done, conflicts, failed };
    },
    /** Throw one staged change away (compare and set on its time). */
    async unstage(row) {
      let q = client.from('msm_changes').delete().eq('id', row.id);
      if (row.updated_at) q = q.eq('updated_at', row.updated_at);
      const res = write('multi site menu change', await q.select('id'));
      if (res.error) return { ...bad(res.error), action: 'delete' };
      if (!res.data?.length) return { ok: false, action: 'delete', conflict: true, row, words: 'Someone else changed this at the same moment. It shows their change now.' };
      return { ok: true, action: 'delete', row: null };
    },

    // ── Publish ───────────────────────────────────────────────────────────
    /**
     * Publish now: the database freezes the set into a version due now (checking the person is an
     * editor with the second step), then the msm-publish function is asked to run it straight away.
     * If that call is lost, the scheduled job picks it up within a minute: the answer says so.
     */
    async publishNow(setId, { applyWhenIdle = true } = {}) {
      const r = await rpc('msm_publish_now', { p_set: setId, p_apply_when_idle: applyWhenIdle }, 'multi site menu publish');
      if (!r.ok) return r;
      const kick = await api.runVersion(r.data.version_id);
      return { ok: true, data: { ...r.data, run: kick.data || null, runWords: kick.ok ? '' : 'Publishing will start within a minute.' }, error: null };
    },
    async runVersion(versionId) {
      if (!client?.functions?.invoke) return bad(new Error('No functions'));
      try {
        const res = await race(client.functions.invoke('msm-publish', { body: { action: 'run_version', version_id: versionId } }), invokeTimeoutMs, 'Publishing');
        return res.error ? bad(res.error) : ok(res.data);
      } catch (e) { return bad(e); }
    },
    schedule: (setId, runLocal, leadMinutes = 5, applyWhenIdle = true) =>
      rpc('msm_schedule_set', { p_set: setId, p_run_local: String(runLocal).replace('T', ' '), p_lead_minutes: leadMinutes, p_apply_when_idle: applyWhenIdle }, 'multi site menu schedule'),
    unschedule: (setId) => rpc('msm_unschedule_set', { p_set: setId }, 'multi site menu schedule'),
    cancel: (setId) => rpc('msm_cancel_set', { p_set: setId }, 'multi site menu schedule'),
    async retrySite(versionId, locationId) {
      const r = await rpc('msm_retry_site', { p_version: versionId, p_location: locationId }, 'multi site menu publish');
      if (r.ok) await api.runVersion(versionId);
      return r;
    },
    importCommit: (payload) => rpc('msm_import_commit', { p_payload: payload }, 'multi site menu import'),

    // ── Saved site groups ─────────────────────────────────────────────────
    async saveSiteGroup(menuId, { id = null, name, locationIds }) {
      const row = { menu_id: menuId, org_id: '00000000-0000-0000-0000-000000000000', name: String(name || '').trim().slice(0, 60), location_ids: [...new Set(locationIds || [])] };
      if (!row.name) return bad(new Error('Give the group of sites a name.'));
      const res = write('multi site menu site group', id
        ? await client.from('msm_site_groups').update({ name: row.name, location_ids: row.location_ids }).eq('id', id).select('*')
        : await client.from('msm_site_groups').insert(row).select('*'));
      return res.error ? bad(res.error) : ok(Array.isArray(res.data) ? res.data[0] : res.data);
    },
    async deleteSiteGroup(id) {
      const res = write('multi site menu site group', await client.from('msm_site_groups').delete().eq('id', id).select('id'));
      return res.error ? bad(res.error) : ok(true);
    },

    /**
     * Round 2 (UI issue 12c): the company's sites with more than one active menu, for the Admin
     * switch's tick ("The multi site menu changes one menu per site for now"). Paged reads.
     * Returns { ok, sites: [{ location_id, name, menus: [names] }] }.
     */
    async sitesWithManyMenus(orgId) {
      if (!client || !orgId) return { ok: false, sites: [] };
      const locs = await readAllRows(() => client.from('locations').select('id,name').eq('org_id', orgId).order('name').order('id'));
      if (!locs.rows) return { ok: false, sites: [] };
      const ids = locs.rows.map((l) => l.id);
      if (!ids.length) return { ok: true, sites: [] };
      const menus = await readAllRows(() => client.from('menus').select('id,name,location_id,is_active').in('location_id', ids).order('location_id').order('id'));
      if (!menus.rows) return { ok: false, sites: [] };
      const by = new Map();
      for (const m of menus.rows) if (m.is_active !== false) { if (!by.has(m.location_id)) by.set(m.location_id, []); by.get(m.location_id).push(m.name || 'Menu'); }
      return { ok: true, sites: locs.rows.filter((l) => (by.get(l.id) || []).length > 1).map((l) => ({ location_id: l.id, name: l.name, menus: by.get(l.id) })) };
    },

    // ── Company Admin (ServOS only; the database checks) ──────────────────
    adminStatus: (orgId) => rpc('msm_admin_status', { p_org: orgId }),
    adminSetEnabled: (orgId, on) => rpc('msm_admin_set_enabled', { p_org: orgId, p_on: !!on }, 'multi site menu switch'),
    adminSetMember: (orgId, userId, role) => rpc('msm_admin_set_member', { p_org: orgId, p_user: userId, p_role: role || null }, 'multi site menu people'),
  };
  return api;
}
