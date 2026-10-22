// supabase/functions/report-export/index.ts
//
// Background exports of the head office stock reports (v5.11.92, multi site stock Drop 4a, contract
// section 4). A report with more than 1,000 rows on screen is exported as a file: the screen calls
// stock_report_export_start (a report_export_jobs row), pg_cron job 'report-export-run' (migration
// 20261026a, public.report_export_run_due()) posts { "action": "run" } here every minute with the
// header x-cron-key, and this function builds the file in slices and streams it back on download.
//
//   action 'run' (POST; the service role, or the cron key the database says is right through
//   report_export_cron_ok: a database without that function refuses, it has nothing to do then):
//     1. report_export_claim(3): up to three jobs waiting, or running but silent for three minutes.
//        The same answer names done jobs past their seven days (expired): their files are removed.
//        Cancelled jobs that still hold part files have them removed too.
//     2. For each job, up to PAGES_PER_RUN pages: report_export_page(job) runs the report AS the
//        job's user (the database re checks that login still reaches every site: a site lost fails
//        the job with 'This login no longer reaches <site>.'), each page becomes CSV text (the job's
//        columns; money as plain numbers; days as YYYY-MM-DD; the first part carries the header)
//        saved as <org>/<user>/<job>/part-NNNN.csv in the private bucket report-exports, never
//        overwriting (upsert false). The part number is the database's own page counter, so a run
//        that died between the page call and the upload is found on the next claim and the job is
//        failed in words rather than handed over with a hole in it.
//     3. report_export_finish: 'running' (more pages: the next minute carries on from the stored
//        cursor), 'done' (index.json is written beside the parts), or 'failed' with the words.
//     Budget 90 seconds of wall clock a run; it stops cleanly and resumes next minute.
//   action 'download' (GET ?action=download&job=<id>, or POST { action, job }; the user's own JWT):
//     the job must be the caller's, done and not expired (403 or 404 in words); the database re
//     checks the reach (report_export_reach_ok); every part must be there; then the parts are
//     streamed in order as one text/csv file named <report>-<from>-<to>.csv.
//
// Nothing here writes a report_export_jobs row directly: every write is one of the service role
// database functions above. The bucket is written and cleared with the service role; a storage
// policy lets the owner read their own folder (a signed URL per part is possible later).
//
// Deploy (Peter): npx supabase functions deploy report-export --project-ref tbetcegmszzotrwdtqhi --no-verify-jwt
// (no JWT at the gateway: pg_net sends only the x-cron-key header; the download checks its own JWT).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { secondStepRefusal } from '../_shared/second-step.ts';
import { CRON_KEY_HEADER, isServiceRoleBearer, bearerOf } from '../_shared/cronKey.js';
import {
  EXPORT_KEY_CHECK, BUCKET, PAGES_PER_RUN, CLAIM_MAX, CSV_BOM, DOWNLOAD_WORDS,
  exportAccess, accessWords, isMissingFunction, isUuid, csvPart, partName, partNames, indexName, indexBody, folderOf,
  missingParts, exportFileName, readClaim, readPage, partNumber, outOfTime, runSummary, downloadRefusal, downloadHeaders, chunks,
  resumeStep, lostPartWords, clearedPatch, CLEARED_STATUSES,
} from './rules.js';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const ops = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } });
const files = () => ops.storage.from(BUCKET);

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-key',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Expose-Headers': 'Content-Disposition',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
const errText = (e: unknown) => String((e as any)?.message || e || 'unknown error');

// One database call; a failure is an Error carrying the database's words.
async function call(fn: string, args: Record<string, unknown> = {}): Promise<any> {
  const { data, error } = await ops.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data;
}

// Every file name in a job's folder (bare names), paged past the listing cap.
async function listFolder(prefix: string): Promise<string[]> {
  const folder = folderOf(prefix).replace(/\/$/, '');
  const out: string[] = [];
  const page = 1000;
  for (let offset = 0; ; offset += page) {
    const { data, error } = await files().list(folder, { limit: page, offset, sortBy: { column: 'name', order: 'asc' } });
    if (error) throw new Error(`list ${folder}: ${error.message}`);
    const names = (data ?? []).map((f: any) => String(f?.name || '')).filter(Boolean);
    out.push(...names);
    if (names.length < page) break;
  }
  return out;
}

// Remove every file in a job's folder. Returns how many were removed.
async function removeFolder(prefix: string): Promise<number> {
  const names = await listFolder(prefix);
  const paths = names.map((n) => `${folderOf(prefix)}${n}`);
  for (const group of chunks(paths, 100)) {
    const { error } = await files().remove(group);
    if (error) throw new Error(`remove ${folderOf(prefix)}: ${error.message}`);
  }
  return paths.length;
}

async function finish(jobId: string, patch: Record<string, unknown>): Promise<any> {
  return await call('report_export_finish', { p_job: jobId, p_patch: patch });
}

// The job's status now (the service role may read the table): used only before marking a job
// failed after a page error, so a job the user cancelled mid run is never overwritten.
async function statusNow(jobId: string): Promise<string | null> {
  const { data } = await ops.from('report_export_jobs').select('status').eq('id', jobId).maybeSingle();
  return data?.status ? String(data.status) : null;
}

type JobOut = { id: string; status: string; parts: number; pages_this_run: number; error: string | null };

// A job that will never be downloaded (it failed, or the user cancelled it mid run): its part
// files go now, best effort (the sweep in run() catches anything left once parts is recorded).
async function dropParts(prefix: string, jobId: string): Promise<void> {
  try { await removeFolder(prefix); } catch (e) { console.warn(`[report-export] could not clear ${jobId}: ${errText(e)}`); }
}

// Write index.json beside the parts and mark the job done.
async function markDone(job: any, parts: number, rows: number, columns: unknown[]): Promise<void> {
  const prefix = String(job.file_prefix);
  const index = indexBody({ job, parts, rows, columns });
  const ix = await files().upload(indexName(prefix), new Blob([JSON.stringify(index)], { type: 'application/json' }), { contentType: 'application/json', upsert: true });
  if (ix.error) console.warn(`[report-export] index.json for ${job.id}: ${ix.error.message}`);
  await finish(String(job.id), { status: 'done', parts });
}

// One claimed job: up to PAGES_PER_RUN pages, each saved as a part, then finished.
async function runJob(job: any, startedMs: number): Promise<JobOut> {
  const prefix = String(job.file_prefix);
  let columns = Array.isArray(job.columns) ? job.columns : [];
  let parts = Math.max(0, Math.floor(Number(job.pages) || 0));
  let rows = Math.max(0, Math.floor(Number(job.rows) || 0));
  let pagesThisRun = 0;
  const out = (status: string, error: string | null = null): JobOut => ({ id: String(job.id), status, parts, pages_this_run: pagesThisRun, error });

  // A job picked up again: every part the database counts must be in the folder, and a job whose
  // last page was read already is marked done (reading again from the top would repeat every row).
  const missing = parts > 0 ? missingParts(parts, await listFolder(prefix)) : [];
  const step = resumeStep(job, missing);
  if (step === 'lost_part') {
    const error = lostPartWords(missing[0]);
    await finish(String(job.id), { status: 'failed', parts: 0, error });
    await dropParts(prefix, String(job.id));
    return out('failed', error);
  }
  if (step === 'finish') {
    await markDone(job, parts, rows, columns);
    return out('done');
  }

  for (let n = 1; n <= PAGES_PER_RUN; n += 1) {
    if (outOfTime(startedMs, Date.now())) {
      await finish(String(job.id), { status: 'running', parts });
      return out('running');
    }
    const { data, error } = await ops.rpc('report_export_page', { p_job: job.id });
    if (error) {
      // The page function raised: the job is unchanged unless the user cancelled it meanwhile.
      const now = await statusNow(String(job.id));
      if (now && now !== 'running') {
        if (now === 'cancelled' || now === 'failed') await dropParts(prefix, String(job.id));
        return out(now);
      }
      const words = isMissingFunction(error) ? 'This needs a database update (20261026a).' : `The report could not be read. ${error.message}`;
      await finish(String(job.id), { status: 'failed', parts: 0, error: words });
      await dropParts(prefix, String(job.id));
      return out('failed', words);
    }
    const page = readPage(data);
    if (page.stopped) {
      // The job is no longer running: the database failed it (a site lost: its own words), or the
      // user cancelled it meanwhile. Nothing more is written for it, and its parts go.
      if (page.stopped === 'cancelled' || page.stopped === 'failed') await dropParts(prefix, String(job.id));
      return out(page.stopped, page.error);
    }
    if (!columns.length) columns = page.columns;
    const partNo = partNumber(job, n);
    const text = csvPart(columns, page.rows, { header: partNo === 1 });
    const up = await files().upload(partName(prefix, partNo), new Blob([text], { type: 'text/csv' }), { contentType: 'text/csv', upsert: false });
    if (up.error) {
      const words = `Could not save part ${partNo}. ${up.error.message}`;
      await finish(String(job.id), { status: 'failed', parts: 0, error: words });
      await dropParts(prefix, String(job.id));
      return out('failed', words);
    }
    parts = partNo;
    rows += page.rows.length;
    pagesThisRun += 1;
    if (page.next === null) {
      await markDone(job, parts, rows, columns);
      return out('done');
    }
  }
  await finish(String(job.id), { status: 'running', parts });
  return out('running');
}

async function run(req: Request): Promise<Response> {
  // Who may start it: the service role, or the cron job's key (asked of the database).
  const service = isServiceRoleBearer(req.headers.get('Authorization'), SERVICE_ROLE);
  const key = String(req.headers.get(CRON_KEY_HEADER) ?? '').trim();
  const check = !service && key ? await ops.rpc(EXPORT_KEY_CHECK, { p_key: key }) : null;
  const access = exportAccess({ service, key, check: check ? { data: check.data, error: check.error } : null });
  if (!access.ok) return json({ error: accessWords(access.reason), reason: access.reason }, access.status);

  const startedMs = Date.now();
  const errors: string[] = [];
  const jobs: JobOut[] = [];
  let expiredRemoved = 0;
  let cancelledRemoved = 0;

  let claim: { jobs: any[]; expired: any[] } = { jobs: [], expired: [] };
  try {
    claim = readClaim(await call('report_export_claim', { p_max: CLAIM_MAX }));
  } catch (e) {
    errors.push(`claim: ${errText(e)}`);
  }

  // Files of jobs past their seven days (the claim set them 'expired').
  for (const e of claim.expired) {
    try { expiredRemoved += await removeFolder(String(e.file_prefix)); } catch (err) { errors.push(`expired ${e.id ?? ''}: ${errText(err)}`); }
  }

  // Cancelled, expired or failed jobs that still hold parts (cancelled between two runs, an
  // expired folder whose removal failed, a job the claim stopped after 5 tries): cleared, and the
  // count set to 0 through report_export_finish so each is done once. clearedPatch keeps the
  // job's status (the database keeps cancelled and expired whatever the patch says).
  try {
    const { data, error } = await ops.from('report_export_jobs').select('id, file_prefix, parts, status, error').in('status', CLEARED_STATUSES as unknown as string[]).gt('parts', 0).order('created_at').limit(20);
    if (error) throw new Error(error.message);
    for (const j of data ?? []) {
      try {
        cancelledRemoved += await removeFolder(String(j.file_prefix));
        const patch = clearedPatch(j);
        if (patch) await finish(String(j.id), patch);
      } catch (err) { errors.push(`clear ${j.id}: ${errText(err)}`); }
    }
  } catch (e) {
    errors.push(`clear old jobs: ${errText(e)}`);
  }

  for (const job of claim.jobs) {
    if (outOfTime(startedMs, Date.now())) { errors.push(`out of time before job ${job.id}: it runs next minute`); break; }
    try { jobs.push(await runJob(job, startedMs)); } catch (e) { errors.push(`job ${job.id}: ${errText(e)}`); }
  }

  const summary = runSummary({ by: access.by, startedMs, nowMs: Date.now(), jobs, expiredRemoved, cancelledRemoved, errors });
  console.log(`[report-export] summary ${JSON.stringify(summary)}`);
  return json(summary, 200);
}

async function download(req: Request, jobId: string): Promise<Response> {
  // The Back Office second step applies to a person's download as it does to the screens.
  const refusal = await secondStepRefusal(req);
  if (refusal) return refusal;
  const token = bearerOf(req.headers.get('Authorization'));
  if (!token) return json({ error: DOWNLOAD_WORDS.sign_in }, 401);
  const { data: { user } } = await ops.auth.getUser(token);
  if (!user || (user as any).is_anonymous === true) return json({ error: DOWNLOAD_WORDS.sign_in }, 401);
  if (!isUuid(jobId)) return json({ error: DOWNLOAD_WORDS.no_job }, 400);

  const { data: job, error: jobErr } = await ops.from('report_export_jobs')
    .select('id, user_id, org_id, report, args, status, parts, rows, file_prefix, expires_at, error').eq('id', jobId).maybeSingle();
  if (jobErr) return json({ error: `Could not read the export: ${jobErr.message}` }, 500);
  const no = downloadRefusal({ job, userId: user.id, nowMs: Date.now() });
  if (no) return json({ error: no.error }, no.status);

  // The reach, re checked now by the database (the login may have lost a site since the export).
  const { data: ok, error: reachErr } = await ops.rpc('report_export_reach_ok', { p_job: jobId, p_user: user.id });
  if (reachErr) return json({ error: isMissingFunction(reachErr) ? 'This needs a database update (20261026a).' : `Could not check the sites: ${reachErr.message}` }, isMissingFunction(reachErr) ? 503 : 500);
  if (ok !== true) return json({ error: DOWNLOAD_WORDS.reach_lost }, 403);

  const prefix = String(job.file_prefix);
  const parts = Math.max(0, Math.floor(Number(job.parts) || 0));
  let listed: string[] = [];
  try { listed = await listFolder(prefix); } catch (e) { return json({ error: `Could not read the file: ${errText(e)}` }, 500); }
  if (!parts || missingParts(parts, listed).length) return json({ error: DOWNLOAD_WORDS.incomplete }, 404);

  const paths = partNames(prefix, parts);
  const encoder = new TextEncoder();
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(encoder.encode(CSV_BOM)); },
    async pull(controller) {
      if (i >= paths.length) { controller.close(); return; }
      const path = paths[i];
      i += 1;
      const { data, error } = await files().download(path);
      if (error || !data) { controller.error(new Error(`part ${path}: ${error?.message || 'missing'}`)); return; }
      controller.enqueue(new Uint8Array(await data.arrayBuffer()));
    },
  });
  return new Response(body, { status: 200, headers: { ...cors, ...downloadHeaders(exportFileName(job.report, job.args)) } });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST' && req.method !== 'GET') return json({ error: 'method not allowed' }, 405);
  const url = new URL(req.url);
  let body: any = {};
  if (req.method === 'POST') { try { body = await req.json(); } catch { body = {}; } }
  const action = String(body?.action ?? url.searchParams.get('action') ?? (req.method === 'GET' ? 'download' : 'run'));
  try {
    if (action === 'run') {
      if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
      return await run(req);
    }
    if (action === 'download') return await download(req, String(body?.job ?? url.searchParams.get('job') ?? '').trim());
    return json({ error: `unknown action: ${action}` }, 400);
  } catch (e) {
    console.error(`[report-export] ${action}: ${errText(e)}`);
    return json({ error: errText(e) }, 500);
  }
});
