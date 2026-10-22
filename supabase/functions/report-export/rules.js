// supabase/functions/report-export/rules.js
//
// The pure rules of the report-export edge function (v5.11.92, multi site stock Drop 4a, contract
// section 4). No Deno, no network: node --test drives every branch (src/lib/stock/reportExportEdge
// .test.js) and report-export/index.ts imports this file.
//
// WHAT THE FUNCTION DOES. A stock report with more than 1,000 rows is exported in the background:
// stock_report_export_start writes a report_export_jobs row, pg_cron 'report-export-run' posts
// { "action": "run" } here every minute with the header x-cron-key (a key that lives only in the
// database vault, checked by report_export_cron_ok), and this function:
//   * claims up to CLAIM_MAX jobs (report_export_claim),
//   * reads up to PAGES_PER_RUN pages a job (report_export_page, run AS the job's user, so a site the
//     login lost since the start fails the job in words),
//   * turns each page into CSV text and saves it as one part file in the private bucket
//     report-exports under <org>/<user>/<job>/part-NNNN.csv (the first part carries the header),
//   * marks the job done (and writes index.json), running (more pages next minute) or failed.
// A download (action=download&job=<id>, the user's own JWT) re checks the owner and the reach
// (report_export_reach_ok) and streams the parts in order as one CSV file.
//
//   exportAccess     who may start a run: the service role, or the pg_cron key the database says is
//                    right. Fails closed, exactly as stock-nightly: no key, a wrong key, a failed
//                    check, or a database without the check function (before 20261026a) all refuse.
//   csvPart          one page of rows as CSV text: every column of the job's `columns`, money and
//                    quantities as plain numbers, days as YYYY-MM-DD, the house quoting rule
//                    (reports/_csv.js), CRLF line ends, a trailing line end so parts join cleanly.
//   partName         <prefix>part-0001.csv; the part number is the database's own page counter
//                    (report_export_jobs.pages after report_export_page), so a run that died between
//                    the page call and the upload is found (missingParts) and never papered over.
//   downloadRefusal  the words and the status for a download that must not happen.

export const EXPORT_KEY_CHECK = 'report_export_cron_ok';
export const BUCKET = 'report-exports';
/** Pages read per job per run; the next minute carries on from the stored cursor. */
export const PAGES_PER_RUN = 25;
/** Jobs claimed per run. */
export const CLAIM_MAX = 3;
/** Wall clock a run may use before it stops cleanly and leaves the rest for the next minute. */
export const RUN_BUDGET_MS = 90000;
/** Files are kept this long after the job is done (the database sets expires_at the same way). */
export const KEEP_DAYS = 7;
/** Excel reads UTF-8 only behind this mark; it goes once at the start of the download, never in a part. */
export const CSV_BOM = '\uFEFF';
export const LINE_END = '\r\n';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);

// The check function is missing (PostgREST PGRST202, Postgres 42883, or its words).
export function isMissingFunction(error) {
  if (!error) return false;
  const code = String(error.code || '');
  const msg = String(error.message || '');
  return code === 'PGRST202' || code === '42883' || /could not find the function|function .*does not exist|schema cache/i.test(msg);
}

/**
 * service: the caller is the service role. key: the x-cron-key header ('' when none).
 * check: { data, error } from rpc(EXPORT_KEY_CHECK, { p_key: key }), or null when not asked.
 * Returns { ok, by, status, reason }. The stock-nightly shape, word for word.
 */
export function exportAccess({ service = false, key = '', check = null } = {}) {
  if (service) return { ok: true, by: 'service_role', status: 200, reason: null };
  if (!key) return { ok: false, by: null, status: 401, reason: 'no_cron_key' };
  if (check?.error && isMissingFunction(check.error)) return { ok: false, by: null, status: 503, reason: 'needs_database_update' };
  if (check?.error) return { ok: false, by: null, status: 401, reason: 'cron_key_check_failed' };
  if (check && check.data === true) return { ok: true, by: 'cron_key', status: 200, reason: null };
  return { ok: false, by: null, status: 401, reason: 'wrong_cron_key' };
}

/** The words for a refused run, from exportAccess's reason. */
export function accessWords(reason) {
  if (reason === 'needs_database_update') return 'This needs a database update (20261026a). Nothing was run.';
  return 'not authorised';
}

// ── CSV ──────────────────────────────────────────────────────────────────────

const NUMBER_KINDS = new Set(['money', 'pct', 'qty']);
const YMD_RE = /^\d{4}-\d{2}-\d{2}/;

/** A plain number with float noise taken off (0.30000000000000004 is 0.3), or '' when it is not a number. */
export function plainNumber(v) {
  if (v === null || v === undefined || v === '') return '';
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return '';
  return String(Math.round(n * 1e6) / 1e6);
}

/** 'YYYY-MM-DD' from a day string or an instant, or '' when it is not a day. */
export function dayCell(v) {
  if (v === null || v === undefined || v === '') return '';
  const s = String(v);
  if (YMD_RE.test(s)) return s.slice(0, 10);
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : '';
}

/**
 * One cell's text for a column kind: 'money' | 'pct' | 'qty' (plain numbers), 'day' (YYYY-MM-DD),
 * 'text' | 'rag' | anything else (the words; an object as JSON). null and undefined are ''.
 */
export function csvCell(value, kind) {
  if (value === null || value === undefined) return '';
  if (NUMBER_KINDS.has(kind)) return plainNumber(value);
  if (kind === 'day') return dayCell(value);
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** The house quoting rule (reports/_csv.js): quote when the text holds a comma, a quote or a line end. */
export function csvEscape(s) {
  const t = s === null || s === undefined ? '' : String(s);
  if (t.includes(',') || t.includes('"') || t.includes('\n') || t.includes('\r')) return `"${t.replace(/"/g, '""')}"`;
  return t;
}

/** The columns a job carries, each with a key, a label and a kind; anything malformed is dropped. */
export function cleanColumns(columns) {
  return (Array.isArray(columns) ? columns : [])
    .filter((c) => c && typeof c === 'object' && typeof c.key === 'string' && c.key)
    .map((c) => ({ key: c.key, label: typeof c.label === 'string' && c.label ? c.label : c.key, kind: typeof c.kind === 'string' ? c.kind : 'text' }));
}

export function csvHeader(columns) {
  return cleanColumns(columns).map((c) => csvEscape(c.label)).join(',');
}

export function csvRow(columns, row) {
  return cleanColumns(columns).map((c) => csvEscape(csvCell(row?.[c.key], c.kind))).join(',');
}

/**
 * One part's text: the header when `header` is true, then one line per row, CRLF line ends and a
 * trailing line end, so the parts of a job join into one well formed file. No rows and no header
 * is an empty string (an empty last page writes an empty part, which joins to nothing).
 */
export function csvPart(columns, rows, { header = false } = {}) {
  const cols = cleanColumns(columns);
  const lines = [];
  if (header) lines.push(csvHeader(cols));
  for (const r of Array.isArray(rows) ? rows : []) lines.push(csvRow(cols, r));
  return lines.length ? `${lines.join(LINE_END)}${LINE_END}` : '';
}

// ── files ────────────────────────────────────────────────────────────────────

/** 'org/user/job/' with exactly one trailing slash (the database writes it that way; this keeps it so). */
export function folderOf(prefix) {
  const p = String(prefix || '').replace(/\/+$/, '');
  return p ? `${p}/` : '';
}

export function partName(prefix, n) {
  return `${folderOf(prefix)}part-${String(Math.max(1, Math.floor(Number(n) || 1))).padStart(4, '0')}.csv`;
}

export function indexName(prefix) {
  return `${folderOf(prefix)}index.json`;
}

/** The part files of a job with `parts` parts, in order. */
export function partNames(prefix, parts) {
  const n = Math.max(0, Math.floor(Number(parts) || 0));
  return Array.from({ length: n }, (_, i) => partName(prefix, i + 1));
}

/**
 * The part numbers (1 based) a folder is missing, given the names the bucket lists for it (bare
 * names or full paths). A folder listing is the one truth about what was saved: a run that died
 * between the page call and the upload left the database one page ahead of the files.
 */
export function missingParts(parts, listedNames) {
  const have = new Set((Array.isArray(listedNames) ? listedNames : []).map((n) => String(typeof n === 'string' ? n : n?.name || '').split('/').pop()));
  const out = [];
  for (let i = 1; i <= Math.max(0, Math.floor(Number(parts) || 0)); i += 1) {
    if (!have.has(partName('', i))) out.push(i);
  }
  return out;
}

/** '<report>-<from>-<to>.csv', safe for a filename header (letters, digits, dash and underscore only). */
export function exportFileName(report, args) {
  const safe = (v, fallback) => {
    const s = String(v ?? '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
    return s || fallback;
  };
  return `${safe(report, 'report')}-${safe(dayCell(args?.from) || args?.from, 'start')}-${safe(dayCell(args?.to) || args?.to, 'end')}.csv`;
}

/** The index.json a done job leaves beside its parts. */
export function indexBody({ job, parts, rows, columns }) {
  return {
    report: job?.report ?? null, args: job?.args ?? null, parts, rows,
    columns: cleanColumns(columns), files: partNames(job?.file_prefix, parts), kept_days: KEEP_DAYS,
  };
}

// ── the database's answers ───────────────────────────────────────────────────

/** report_export_claim's answer: { jobs, expired }, however it was shaped (a bare list is jobs). */
export function readClaim(data) {
  if (Array.isArray(data)) return { jobs: data.filter(isJob), expired: [] };
  const jobs = Array.isArray(data?.jobs) ? data.jobs.filter(isJob) : [];
  const expired = (Array.isArray(data?.expired) ? data.expired : []).filter((e) => e && typeof e === 'object' && e.file_prefix);
  return { jobs, expired };
}

const isJob = (j) => j && typeof j === 'object' && isUuid(j.id) && typeof j.file_prefix === 'string' && j.file_prefix;

/**
 * report_export_page's answer: { rows, next, columns, failed, error, stopped }. A page that says the
 * job failed (the function sets 'failed' itself when the login lost a site) is `failed` with its
 * words. `stopped` is the job's status when the page was not read because the job is no longer
 * running (cancelled by the user meanwhile, failed, done, expired): the runner then stops at once
 * and never writes a part or finishes the job a second time. null while the job runs.
 */
export function readPage(data) {
  const d = data && typeof data === 'object' ? data : {};
  const status = typeof d.status === 'string' ? d.status : null;
  const failed = d.failed === true || d.ok === false || status === 'failed' || status === 'cancelled';
  const stopped = status && status !== 'running' ? status : (failed ? 'failed' : null);
  return {
    rows: Array.isArray(d.rows) ? d.rows : [],
    next: d.next === undefined ? null : d.next,
    columns: cleanColumns(d.columns),
    failed,
    error: failed ? String(d.error || (status === 'cancelled' ? 'Cancelled.' : 'The report could not be read.')) : null,
    stopped,
  };
}

/**
 * What a claimed job needs before any page is read:
 *   'lost_part'  the database counts more pages than the folder holds parts (a run died between the
 *                page call and the upload): the job fails in words, never handed over with a hole
 *   'finish'     every page was read already (pages counted and no cursor left: the run that read
 *                the last page died before it marked the job done): mark it done now, never read
 *                the report again from the top (that would repeat every row)
 *   'read'       carry on from the stored cursor (or start)
 * @param {{ pages?: number, cursor?: unknown }} job  the claim's row
 * @param {number[]} missing  missingParts(job.pages, the folder listing)
 */
export function resumeStep(job, missing = []) {
  const pages = Math.max(0, Math.floor(Number(job?.pages) || 0));
  if (pages > 0 && Array.isArray(missing) && missing.length) return 'lost_part';
  if (pages > 0 && (job?.cursor === null || job?.cursor === undefined)) return 'finish';
  return 'read';
}

/** The words of a job whose part file was lost. */
export const lostPartWords = (n) => `A part of the file was lost (part ${n}). Start the export again.`;

/**
 * The tidy up after a job that will never be downloaded (cancelled, expired or failed) whose
 * folder was cleared: the report_export_finish patch that records parts 0 WITHOUT changing the
 * job's status. The database keeps a cancelled or expired status whatever the patch says (and
 * refuses 'cancelled' as a patch status), so those pass 'running'; a failed job passes 'failed'
 * with its own words so they stay. Anything else answers null (nothing to record).
 */
export function clearedPatch(job) {
  const status = String(job?.status || '');
  if (status === 'cancelled' || status === 'expired') return { status: 'running', parts: 0 };
  if (status === 'failed') return { status: 'failed', parts: 0, error: job?.error ? String(job.error) : 'The export stopped.' };
  return null;
}

/** The job statuses whose files are cleared by the run (they can never be downloaded). */
export const CLEARED_STATUSES = Object.freeze(['cancelled', 'expired', 'failed']);

/** The part number of the n th page read this run (1 based), from the database's page counter at claim. */
export function partNumber(job, n) {
  return Math.max(0, Math.floor(Number(job?.pages) || 0)) + Math.max(1, Math.floor(Number(n) || 1));
}

/** True when the run has used its budget: the job is left 'running' and the next minute carries on. */
export function outOfTime(startedMs, nowMs, budgetMs = RUN_BUDGET_MS) {
  return nowMs - startedMs >= budgetMs;
}

/** The pieces of one run's summary line for the function log. */
export function runSummary({ by, startedMs, nowMs, jobs, expiredRemoved, cancelledRemoved, errors }) {
  return {
    ok: !(errors || []).length, by, started_at: new Date(startedMs).toISOString(), ms: nowMs - startedMs,
    jobs: (jobs || []).map((j) => ({ id: j.id, status: j.status, parts: j.parts ?? null, pages_this_run: j.pages_this_run ?? 0, error: j.error ?? null })),
    expired_removed: expiredRemoved || 0, cancelled_removed: cancelledRemoved || 0, errors: errors || [],
  };
}

// ── downloads ────────────────────────────────────────────────────────────────

export const DOWNLOAD_WORDS = Object.freeze({
  no_job: 'Which export? Pass its job id.',
  not_found: 'That export was not found.',
  not_yours: 'That export is not yours.',
  not_ready: 'That export is not ready yet.',
  cancelled: 'That export was cancelled.',
  expired: `That export has expired. Files are kept for ${KEEP_DAYS} days.`,
  failed: 'That export failed.',
  incomplete: 'That export is incomplete. Start it again.',
  reach_lost: 'This login no longer reaches one of the sites in that export.',
  sign_in: 'Sign in to Back Office to download an export.',
});

/**
 * Why a download must not happen, or null when it may: { status, error }. 404 for a job that is
 * not there, not done, failed, cancelled or expired; 403 for another login's job.
 */
export function downloadRefusal({ job, userId, nowMs = Date.now() }) {
  if (!job) return { status: 404, error: DOWNLOAD_WORDS.not_found };
  if (!userId || String(job.user_id) !== String(userId)) return { status: 403, error: DOWNLOAD_WORDS.not_yours };
  const status = String(job.status || '');
  if (status === 'failed') return { status: 404, error: job.error ? `${DOWNLOAD_WORDS.failed} ${job.error}` : DOWNLOAD_WORDS.failed };
  if (status === 'cancelled') return { status: 404, error: DOWNLOAD_WORDS.cancelled };
  if (status === 'expired') return { status: 404, error: DOWNLOAD_WORDS.expired };
  if (status !== 'done') return { status: 404, error: DOWNLOAD_WORDS.not_ready };
  const exp = Date.parse(job.expires_at || '');
  if (Number.isFinite(exp) && exp <= nowMs) return { status: 404, error: DOWNLOAD_WORDS.expired };
  return null;
}

/** The headers of the one CSV a download streams. */
export function downloadHeaders(fileName) {
  return {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${fileName}"`,
    'Cache-Control': 'no-store',
    'Access-Control-Expose-Headers': 'Content-Disposition',
  };
}

/** A list of paths in groups of `size` (storage.remove takes a list; keep each call modest). */
export function chunks(list, size = 100) {
  const items = Array.isArray(list) ? list : [];
  const n = Math.max(1, Math.floor(Number(size) || 1));
  const out = [];
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
}
