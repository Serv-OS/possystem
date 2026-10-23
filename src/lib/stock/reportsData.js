/**
 * stock/reportsData.js: how the browser talks to the head office report functions (v5.11.92, multi
 * site stock Drop 4a, contract 2.1). The client is passed in, so node --test drives every path
 * with a stand in (reportsData.test.js); stockReportsApi.js hands in the real one.
 *
 *   createStockReportsApi(client)   every call the Stock and GP screens make, one answer shape
 *   pollExport(api, jobId, onTick)  follows a background export every 3 s until it is finished
 *
 * The answer shape is createStockApi's: { data, error, needsUpdate, conflict, queued }. A database
 * without a function this build calls answers NEEDS_UPDATE ('This needs a database update. Ask
 * ServOS to run it.'), never a figure of its own. Nothing here decides who may read: the database
 * does (stock_report_guard: every site in reach, never a till, kiosk or customer session). Nothing
 * here works a number out: every figure is the database's, from the stored day totals.
 */

import { callRead, callSave, answerOf, needsUpdateError, isMissingTableError } from './companyData.js';
import { isMissingColumnError } from './saveRules.js';
// v5.11.92 integration: the key item editor's product search lives with the other reads here.
import { searchMenuProducts } from './dashboardRules.js';

export const REPORT_PAGE = 1000;
const MAX_JOB_IDS = 100;
const nil = (v) => (v === undefined ? null : v);

/** A table read in the one answer shape; a missing table or column says NEEDS_UPDATE. */
async function tableAnswer(run) {
  let res;
  try { res = await run(); } catch (e) { res = { data: null, error: e }; }
  if (res?.error) {
    const missing = isMissingTableError(res.error) || isMissingColumnError(res.error);
    return { data: null, error: missing ? needsUpdateError(res.error) : res.error, needsUpdate: missing, conflict: null, queued: [] };
  }
  return { data: res?.data ?? null, error: null, needsUpdate: false, conflict: null, queued: [] };
}

const noDb = () => ({ data: null, error: new Error('No database'), needsUpdate: false, conflict: null, queued: [] });

/** Where the edge functions live, from the client when it says, else the given base. */
export function functionsBaseOf(client, functionsUrl = null) {
  if (typeof functionsUrl === 'string' && functionsUrl) return functionsUrl.replace(/\/+$/, '');
  const url = client?.supabaseUrl || client?.functions?.url || null;
  if (typeof url === 'string' && url) return /\/functions\/v1$/.test(url) ? url : `${url.replace(/\/+$/, '')}/functions/v1`;
  return '/functions/v1';
}

/**
 * Every call the Stock and GP screens make (contract 2.1). Each method is async, never throws,
 * and answers { data, error, needsUpdate, conflict, queued }.
 */
export function createStockReportsApi(client, { functionsUrl = null } = {}) {
  const read = async (fn, args) => answerOf(await callRead(client, fn, args));
  const save = async (fn, args) => answerOf(await callSave(client, fn, args));
  const from = (table) => client.from(table);
  const table = (run) => (client && typeof client.from === 'function' ? tableAnswer(run) : Promise.resolve(noDb()));
  const base = functionsBaseOf(client, functionsUrl);

  const report = (name, { orgId, sites, from: fromDay, to, opts = null, after = null, limit = REPORT_PAGE } = {}) =>
    read(`stock_report_${name}`, {
      p_org: nil(orgId), p_sites: Array.isArray(sites) ? sites : nil(sites), p_from: nil(fromDay), p_to: nil(to),
      p_opts: opts || null, p_after: after || null, p_limit: Math.min(Math.max(Number(limit) || REPORT_PAGE, 1), REPORT_PAGE),
    });

  /**
   * Page one and every page after it, following `next` until null or `maxRows` rows are held.
   * data: { meta, totals, rows, next, capped } (capped true when more rows exist past the cap:
   * the screen shows "Showing the first 1,000 rows. Export for all.").
   */
  const allPages = async (name, args, { maxRows = REPORT_PAGE } = {}) => {
    let after = null;
    let meta = null, totals = null;
    const rows = [];
    for (let page = 0; page < 100; page++) {
      const r = await report(name, { ...args, after, limit: Math.min(REPORT_PAGE, Math.max(1, maxRows - rows.length)) });
      if (r.error) return r;
      const d = r.data || {};
      if (page === 0) { meta = d.meta ?? null; totals = d.totals ?? null; }
      if (Array.isArray(d.rows)) rows.push(...d.rows);
      after = d.next || null;
      if (!after) return { data: { meta, totals, rows, next: null, capped: false }, error: null, needsUpdate: false, conflict: null, queued: [] };
      if (rows.length >= maxRows) return { data: { meta, totals, rows: rows.slice(0, maxRows), next: after, capped: true }, error: null, needsUpdate: false, conflict: null, queued: [] };
    }
    return { data: { meta, totals, rows, next: after, capped: true }, error: null, needsUpdate: false, conflict: null, queued: [] };
  };

  return {
    report,
    allPages,
    // ── targets and key items ──
    targets: (orgId) => table(() => from('stock_targets').select('id, location_id, metric, green_to, amber_to, row_version')
      .eq('org_id', orgId).order('metric').order('location_id').limit(1000)),
    keyRatios: (orgId, { archived = false } = {}) => table(() => {
      let q = from('stock_key_ratios').select('id, name, used_item_id, used_unit, sold_rule, recipe_amount, sort_order, archived_at, row_version').eq('org_id', orgId);
      if (!archived) q = q.is('archived_at', null);
      return q.order('sort_order').order('name').limit(1000);
    }),
    saveTargets: (orgId, rows) => save('stock_save_targets', { p_org: orgId, p_rows: rows || [], p_section: 'reports' }),
    saveKeyRatios: (orgId, rows) => save('stock_save_key_ratios', { p_org: orgId, p_rows: rows || [], p_section: 'reports' }),
    // ── exports ──
    exportStart: (reportName, args) => save('stock_report_export_start', { p_report: reportName, p_args: args || {} }),
    exportCancel: (jobId) => save('stock_report_export_cancel', { p_job: jobId }),
    exportJobs: (ids) => {
      const list = [...new Set((ids || []).filter((x) => x != null).map(String))].slice(0, MAX_JOB_IDS);
      if (!list.length) return Promise.resolve({ data: [], error: null, needsUpdate: false, conflict: null, queued: [] });
      return table(() => from('report_export_jobs').select('id, report, status, pages, parts, rows, error, created_at, done_at, expires_at').in('id', list));
    },
    myExports: () => table(() => from('report_export_jobs').select('id, report, status, pages, parts, rows, error, created_at, done_at, expires_at')
      .order('created_at', { ascending: false }).limit(20)),
    exportDownloadUrl: (jobId) => `${base}/report-export?action=download&job=${encodeURIComponent(String(jobId ?? ''))}`,
    // ── the key item editor's 'Chosen products' search (menu_items at the sites in scope, at most 50) ──
    menuProducts: (args) => searchMenuProducts(client, args),
    // ── v5.11.100 (Drop 4b): the closing stock journal (xero-stock-journal: 'preview' or 'send') ──
    monthEndJournal: (action, body = {}) => monthEndJournalCall(client, action, body),
  };
}

/**
 * One call of the xero-stock-journal edge function as the signed in login: { data, error }. A refusal
 * the function sends with words ({ error: 'Lock the month at every site of ... first.' }) comes back as
 * error with those words; a status answer ({ status: 'needs_reconnect', words }) comes back as data.
 * It never sends anything by itself: 'send' runs only when a person presses Send.
 */
export async function monthEndJournalCall(client, action, body = {}) {
  const fail = (e) => ({ data: null, error: e instanceof Error ? e : new Error(String(e || 'The closing stock journal call failed.')), needsUpdate: false, conflict: null, queued: [] });
  if (!client?.functions || typeof client.functions.invoke !== 'function') return fail('No database');
  if (action !== 'preview' && action !== 'send') return fail('Pick preview or send.');
  let res;
  try { res = await client.functions.invoke('xero-stock-journal', { body: { ...(body || {}), action } }); } catch (e) { return fail(e); }
  if (res?.error) {
    let words = null;
    try { const j = await res.error.context?.json?.(); words = j?.error || j?.words || null; } catch { /* the body was not JSON */ }
    return fail(words || res.error.message || 'The closing stock journal call failed.');
  }
  const d = res?.data ?? null;
  if (d && typeof d === 'object' && typeof d.error === 'string' && d.error) return fail(d.error);
  return { data: d, error: null, needsUpdate: false, conflict: null, queued: [] };
}

/** A job that will not change again. */
export const finishedExport = (j) => !!j && ['done', 'failed', 'cancelled', 'expired'].includes(j.status);

/**
 * Follow one background export: api.exportJobs([jobId]) now and every `everyMs` until the job is
 * done, failed, cancelled or expired (or the database does not have the table), calling
 * onTick(job, answer) each time (job null when the row is not there yet). Returns a stop function.
 * opts.timers ({ set, clear }) is for tests.
 */
export function pollExport(api, jobId, onTick, { everyMs = 3000, timers = null } = {}) {
  const set = timers?.set || ((fn, ms) => setTimeout(fn, ms));
  const clear = timers?.clear || ((t) => clearTimeout(t));
  let stopped = false;
  let timer = null;
  const stop = () => { stopped = true; if (timer != null) clear(timer); timer = null; };
  if (jobId == null || !api || typeof api.exportJobs !== 'function') return stop;
  const tick = async () => {
    timer = null;
    if (stopped) return;
    let r;
    try { r = await api.exportJobs([jobId]); } catch (e) { r = { data: null, error: e }; }
    if (stopped) return;
    const job = (Array.isArray(r?.data) ? r.data : []).find((j) => String(j.id) === String(jobId)) || null;
    try { onTick?.(job, r); } catch { /* the screen's own problem */ }
    if (r?.needsUpdate || finishedExport(job)) { stopped = true; return; }
    timer = set(tick, everyMs);
  };
  tick();
  return stop;
}
