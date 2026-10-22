// node --test: the pure rules of the report-export edge function (supabase/functions/report-export/
// rules.js, v5.11.92, multi site stock Drop 4a, contract section 4), and the wiring of its index.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  EXPORT_KEY_CHECK, BUCKET, PAGES_PER_RUN, CLAIM_MAX, RUN_BUDGET_MS, KEEP_DAYS, CSV_BOM, LINE_END, DOWNLOAD_WORDS,
  exportAccess, accessWords, isMissingFunction, isUuid, plainNumber, dayCell, csvCell, csvEscape, cleanColumns, csvHeader, csvRow, csvPart,
  folderOf, partName, indexName, partNames, missingParts, exportFileName, indexBody, readClaim, readPage, partNumber, outOfTime,
  runSummary, downloadRefusal, downloadHeaders, chunks, resumeStep, lostPartWords, clearedPatch, CLEARED_STATUSES,
} from '../../../supabase/functions/report-export/rules.js';

const read = (rel) => fs.readFileSync(new URL(`../../../${rel}`, import.meta.url), 'utf8');
const JOB = '20000000-0000-4000-8000-000000000001';
const USER = '30000000-0000-4000-8000-000000000001';
const ORG = '40000000-0000-4000-8000-000000000001';
const PREFIX = `${ORG}/${USER}/${JOB}/`;
// The two long dashes, built from their codes so this file carries neither of them itself.
const LONG_DASHES = new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`);

test('who may start a run: the service role or the right cron key; everything else refuses (fails closed)', () => {
  assert.deepEqual(exportAccess({ service: true }), { ok: true, by: 'service_role', status: 200, reason: null });
  assert.deepEqual(exportAccess({ key: 'k', check: { data: true, error: null } }), { ok: true, by: 'cron_key', status: 200, reason: null });
  assert.equal(exportAccess({}).reason, 'no_cron_key');
  assert.equal(exportAccess({ key: 'k', check: { data: false, error: null } }).reason, 'wrong_cron_key');
  assert.equal(exportAccess({ key: 'k', check: { data: null, error: null } }).reason, 'wrong_cron_key', 'only a real true lets it in');
  assert.equal(exportAccess({ key: 'k', check: { data: 'true', error: null } }).ok, false);
  assert.deepEqual(exportAccess({ key: 'k', check: { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.report_export_cron_ok' } } }),
    { ok: false, by: null, status: 503, reason: 'needs_database_update' }, 'before 20261026a: refused, never open');
  assert.equal(exportAccess({ key: 'k', check: { data: null, error: { code: '57014', message: 'timeout' } } }).reason, 'cron_key_check_failed');
  assert.equal(exportAccess({ key: 'k', check: null }).ok, false);
  assert.equal(accessWords('needs_database_update'), 'This needs a database update (20261026a). Nothing was run.');
  assert.equal(accessWords('wrong_cron_key'), 'not authorised');
  assert.equal(isMissingFunction({ code: '42883', message: 'x' }), true);
  assert.equal(isMissingFunction({ message: 'function public.report_export_claim(integer) does not exist' }), true);
  assert.equal(isMissingFunction(null), false);
  assert.equal(EXPORT_KEY_CHECK, 'report_export_cron_ok');
  assert.equal(BUCKET, 'report-exports');
  assert.equal(PAGES_PER_RUN, 25);
  assert.equal(CLAIM_MAX, 3);
  assert.equal(RUN_BUDGET_MS, 90000);
  assert.equal(KEEP_DAYS, 7);
});

test('cells: money and quantities as plain numbers, days as YYYY-MM-DD, words as they are, nothing made up', () => {
  assert.equal(plainNumber(1234.5), '1234.5');
  assert.equal(plainNumber('12.30'), '12.3');
  assert.equal(plainNumber(0.1 + 0.2), '0.3', 'float noise taken off');
  assert.equal(plainNumber(null), '');
  assert.equal(plainNumber('abc'), '');
  assert.equal(plainNumber(Infinity), '');
  assert.equal(dayCell('2026-10-13'), '2026-10-13');
  assert.equal(dayCell('2026-10-13T06:00:00+01:00'), '2026-10-13');
  assert.equal(dayCell('not a day'), '');
  assert.equal(dayCell(null), '');
  assert.equal(csvCell(18420, 'money'), '18420');
  assert.equal(csvCell('72.8', 'pct'), '72.8');
  assert.equal(csvCell(4, 'qty'), '4');
  assert.equal(csvCell('2026-10-13', 'day'), '2026-10-13');
  assert.equal(csvCell('amber', 'rag'), 'amber');
  assert.equal(csvCell('Milk, whole', 'text'), 'Milk, whole');
  assert.equal(csvCell({ a: 1 }, 'text'), '{"a":1}');
  assert.equal(csvCell(undefined, 'money'), '');
  assert.equal(csvCell(null, 'text'), '');
  // the house quoting rule (reports/_csv.js)
  assert.equal(csvEscape('plain'), 'plain');
  assert.equal(csvEscape('Milk, whole'), '"Milk, whole"');
  assert.equal(csvEscape('say "hi"'), '"say ""hi"""');
  assert.equal(csvEscape('two\nlines'), '"two\nlines"');
  assert.equal(csvEscape(null), '');
});

test('columns and parts: every column of the job, the header on the first part only, CRLF, a trailing line end so parts join', () => {
  const columns = [
    { key: 'site', label: 'Site', kind: 'text' }, { key: 'sales_net', label: 'Sales', kind: 'money' },
    { key: 'gp_pct', label: 'GP %', kind: 'pct' }, { key: 'day', label: 'Day', kind: 'day' },
    { bad: true }, null, { key: '', label: 'nameless' }, { key: 'rag' },
  ];
  assert.deepEqual(cleanColumns(columns), [
    { key: 'site', label: 'Site', kind: 'text' }, { key: 'sales_net', label: 'Sales', kind: 'money' },
    { key: 'gp_pct', label: 'GP %', kind: 'pct' }, { key: 'day', label: 'Day', kind: 'day' }, { key: 'rag', label: 'rag', kind: 'text' },
  ]);
  assert.deepEqual(cleanColumns(null), []);
  assert.equal(csvHeader(columns), 'Site,Sales,GP %,Day,rag');
  const rows = [
    { site: 'North, Site A', sales_net: 18420.5, gp_pct: 72.8, day: '2026-10-13', rag: 'green', extra: 'never exported' },
    { site: 'Morley', sales_net: null, gp_pct: 0, day: null },
  ];
  assert.equal(csvRow(columns, rows[0]), '"North, Site A",18420.5,72.8,2026-10-13,green');
  assert.equal(csvRow(columns, rows[1]), 'Morley,,0,,');
  const first = csvPart(columns, rows, { header: true });
  assert.equal(first, `Site,Sales,GP %,Day,rag${LINE_END}"North, Site A",18420.5,72.8,2026-10-13,green${LINE_END}Morley,,0,,${LINE_END}`);
  const second = csvPart(columns, rows.slice(1));
  assert.equal(second, `Morley,,0,,${LINE_END}`, 'later parts carry no header');
  assert.equal(csvPart(columns, []), '', 'an empty later page is an empty part');
  assert.equal(csvPart(columns, [], { header: true }), `Site,Sales,GP %,Day,rag${LINE_END}`, 'a report with no rows still gets its header');
  // joined parts read as one file
  const whole = first + second;
  assert.equal(whole.split(LINE_END).filter(Boolean).length, 4);
  assert.equal(CSV_BOM, '﻿');
});

test('file names: the database prefix kept as one folder, parts numbered by the page counter, index.json beside them', () => {
  assert.equal(folderOf(PREFIX), PREFIX);
  assert.equal(folderOf(PREFIX.replace(/\/$/, '')), PREFIX, 'exactly one trailing slash');
  assert.equal(folderOf(`${PREFIX}//`), PREFIX);
  assert.equal(folderOf(''), '');
  assert.equal(partName(PREFIX, 1), `${PREFIX}part-0001.csv`);
  assert.equal(partName(PREFIX, 250), `${PREFIX}part-0250.csv`);
  assert.equal(partName(PREFIX, 0), `${PREFIX}part-0001.csv`, 'never a part 0');
  assert.equal(indexName(PREFIX), `${PREFIX}index.json`);
  assert.deepEqual(partNames(PREFIX, 3), [`${PREFIX}part-0001.csv`, `${PREFIX}part-0002.csv`, `${PREFIX}part-0003.csv`]);
  assert.deepEqual(partNames(PREFIX, 0), []);
  // the part number is the database's page counter at claim plus the pages read this run
  assert.equal(partNumber({ pages: 0 }, 1), 1);
  assert.equal(partNumber({ pages: 25 }, 1), 26);
  assert.equal(partNumber({ pages: 25 }, 25), 50);
  assert.equal(partNumber({}, 3), 3);
  // a run that died between the page call and the upload left a hole, found from the folder listing
  assert.deepEqual(missingParts(3, ['part-0001.csv', 'part-0003.csv', 'index.json']), [2]);
  assert.deepEqual(missingParts(3, [{ name: 'part-0001.csv' }, { name: 'part-0002.csv' }, { name: 'part-0003.csv' }]), []);
  assert.deepEqual(missingParts(2, [`${PREFIX}part-0001.csv`, `${PREFIX}part-0002.csv`]), [], 'full paths count too');
  assert.deepEqual(missingParts(2, []), [1, 2]);
  assert.deepEqual(missingParts(0, []), []);
  assert.equal(exportFileName('gap', { from: '2026-10-01', to: '2026-10-15' }), 'gap-2026-10-01-2026-10-15.csv');
  assert.equal(exportFileName('product_gp', { from: '2026-10-01T05:00:00Z', to: '2026-10-31' }), 'product_gp-2026-10-01-2026-10-31.csv');
  assert.equal(exportFileName('../x y"z', {}), 'x-y-z-start-end.csv', 'nothing a browser or a header could trip on');
  assert.equal(exportFileName(null, null), 'report-start-end.csv');
  const ix = indexBody({ job: { report: 'gap', args: { sites: ['a'], from: '2026-10-01', to: '2026-10-15', opts: {} }, file_prefix: PREFIX }, parts: 2, rows: 1400, columns: [{ key: 'site', label: 'Site', kind: 'text' }, { bad: 1 }] });
  assert.deepEqual(ix, {
    report: 'gap', args: { sites: ['a'], from: '2026-10-01', to: '2026-10-15', opts: {} }, parts: 2, rows: 1400,
    columns: [{ key: 'site', label: 'Site', kind: 'text' }], files: [`${PREFIX}part-0001.csv`, `${PREFIX}part-0002.csv`], kept_days: 7,
  });
  assert.deepEqual(chunks([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunks([], 100), []);
  assert.deepEqual(chunks(null, 0), []);
});

test('the database\'s answers are read leniently: a claim with jobs and expired files, a page with rows, next and columns, a failed page', () => {
  const job = { id: JOB, file_prefix: PREFIX, report: 'gap', args: {}, cursor: null, pages: 0, rows: 0 };
  assert.deepEqual(readClaim({ jobs: [job, { id: 'not a uuid', file_prefix: PREFIX }, { id: JOB }], expired: [{ id: JOB, file_prefix: PREFIX }, { id: 'x' }] }),
    { jobs: [job], expired: [{ id: JOB, file_prefix: PREFIX }] });
  assert.deepEqual(readClaim([job]), { jobs: [job], expired: [] }, 'a bare list is the jobs');
  assert.deepEqual(readClaim(null), { jobs: [], expired: [] });
  assert.deepEqual(readClaim({}), { jobs: [], expired: [] });
  const page = readPage({ rows: [{ a: 1 }], next: { gap_value: -3, company_item_id: 'c' }, columns: [{ key: 'a', label: 'A', kind: 'qty' }] });
  assert.deepEqual(page, { rows: [{ a: 1 }], next: { gap_value: -3, company_item_id: 'c' }, columns: [{ key: 'a', label: 'A', kind: 'qty' }], failed: false, error: null, stopped: null });
  assert.equal(readPage({ rows: [], next: null }).next, null);
  assert.equal(readPage({ rows: [] }).next, null, 'no next means the last page');
  assert.deepEqual(readPage({ failed: true, error: 'This login no longer reaches Site A.' }), { rows: [], next: null, columns: [], failed: true, error: 'This login no longer reaches Site A.', stopped: 'failed' });
  assert.equal(readPage({ status: 'failed', error: 'Stopped after 5 tries.' }).error, 'Stopped after 5 tries.');
  assert.equal(readPage({ status: 'cancelled' }).error, 'Cancelled.');
  assert.equal(readPage({ ok: false }).error, 'The report could not be read.');
  assert.equal(readPage(null).failed, false);
  assert.equal(readPage(null).stopped, null);
  // the database answers status 'running' for a page it read, and the job's own status otherwise
  assert.equal(readPage({ rows: [{ a: 1 }], next: null, status: 'running' }).stopped, null);
  assert.equal(readPage({ rows: [], next: null, status: 'cancelled' }).stopped, 'cancelled');
  assert.equal(readPage({ rows: [], next: null, status: 'failed', error: 'This login no longer reaches Site A.' }).stopped, 'failed');
  assert.equal(readPage({ rows: [], next: null, status: 'done' }).stopped, 'done', 'a job already done is never written again');
  assert.equal(readPage({ rows: [], next: null, status: 'expired' }).stopped, 'expired');
  assert.equal(readPage({ rows: [], next: null, status: 'done' }).failed, false);
  assert.equal(isUuid(JOB), true);
  assert.equal(isUuid('nope'), false);
});

test('the budget: a run stops cleanly at 90 seconds and the summary names every job', () => {
  assert.equal(outOfTime(0, 89999), false);
  assert.equal(outOfTime(0, 90000), true);
  assert.equal(outOfTime(1000, 2000, 500), true);
  const s = runSummary({ by: 'cron_key', startedMs: 1000, nowMs: 4000, jobs: [{ id: JOB, status: 'done', parts: 3, pages_this_run: 3, error: null }], expiredRemoved: 2, cancelledRemoved: 0, errors: [] });
  assert.deepEqual(s, { ok: true, by: 'cron_key', started_at: '1970-01-01T00:00:01.000Z', ms: 3000, jobs: [{ id: JOB, status: 'done', parts: 3, pages_this_run: 3, error: null }], expired_removed: 2, cancelled_removed: 0, errors: [] });
  assert.equal(runSummary({ by: 'service_role', startedMs: 0, nowMs: 1, jobs: [], errors: ['claim: timeout'] }).ok, false);
  assert.deepEqual(runSummary({ by: 'x', startedMs: 0, nowMs: 1, jobs: [{ id: JOB, status: 'running' }] }).jobs, [{ id: JOB, status: 'running', parts: null, pages_this_run: 0, error: null }]);
});

test('a download is refused in words: not there, not yours, not ready, failed, cancelled, expired', () => {
  const now = Date.parse('2026-10-21T12:00:00Z');
  const done = { id: JOB, user_id: USER, status: 'done', expires_at: '2026-10-28T12:00:00Z', parts: 2 };
  assert.equal(downloadRefusal({ job: done, userId: USER, nowMs: now }), null);
  assert.deepEqual(downloadRefusal({ job: null, userId: USER, nowMs: now }), { status: 404, error: 'That export was not found.' });
  assert.deepEqual(downloadRefusal({ job: done, userId: 'someone-else', nowMs: now }), { status: 403, error: 'That export is not yours.' });
  assert.deepEqual(downloadRefusal({ job: done, userId: null, nowMs: now }), { status: 403, error: 'That export is not yours.' });
  assert.deepEqual(downloadRefusal({ job: { ...done, status: 'running' }, userId: USER, nowMs: now }), { status: 404, error: 'That export is not ready yet.' });
  assert.deepEqual(downloadRefusal({ job: { ...done, status: 'waiting' }, userId: USER, nowMs: now }), { status: 404, error: 'That export is not ready yet.' });
  assert.deepEqual(downloadRefusal({ job: { ...done, status: 'failed', error: 'This login no longer reaches Site A.' }, userId: USER, nowMs: now }), { status: 404, error: 'That export failed. This login no longer reaches Site A.' });
  assert.deepEqual(downloadRefusal({ job: { ...done, status: 'failed' }, userId: USER, nowMs: now }), { status: 404, error: 'That export failed.' });
  assert.deepEqual(downloadRefusal({ job: { ...done, status: 'cancelled' }, userId: USER, nowMs: now }), { status: 404, error: 'That export was cancelled.' });
  assert.deepEqual(downloadRefusal({ job: { ...done, status: 'expired' }, userId: USER, nowMs: now }), { status: 404, error: 'That export has expired. Files are kept for 7 days.' });
  assert.deepEqual(downloadRefusal({ job: { ...done, expires_at: '2026-10-21T11:59:59Z' }, userId: USER, nowMs: now }), { status: 404, error: 'That export has expired. Files are kept for 7 days.' }, 'past expires_at even while the row still says done');
  assert.equal(downloadRefusal({ job: { ...done, expires_at: null }, userId: USER, nowMs: now }), null, 'no expiry recorded: the status decides');
  assert.deepEqual(downloadHeaders('gap-2026-10-01-2026-10-15.csv'), {
    'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="gap-2026-10-01-2026-10-15.csv"',
    'Cache-Control': 'no-store', 'Access-Control-Expose-Headers': 'Content-Disposition',
  });
  for (const w of Object.values(DOWNLOAD_WORDS)) assert.doesNotMatch(w, LONG_DASHES, w);
});

test('index.ts wiring: the cron key check, the claim, page and finish functions, the bucket, the user re check, no JWT at the gateway (source)', () => {
  const src = read('supabase/functions/report-export/index.ts');
  const rules = read('supabase/functions/report-export/rules.js');
  assert.doesNotMatch(src, LONG_DASHES);
  assert.doesNotMatch(rules, LONG_DASHES);
  assert.match(src, /import \{ CRON_KEY_HEADER, isServiceRoleBearer, bearerOf \} from '\.\.\/_shared\/cronKey\.js';/);
  assert.match(src, /await ops\.rpc\(EXPORT_KEY_CHECK, \{ p_key: key \}\)/, 'the database says whether the cron key is right');
  assert.match(src, /exportAccess\(\{ service, key, check/);
  assert.match(src, /call\('report_export_claim', \{ p_max: CLAIM_MAX \}\)/);
  assert.match(src, /ops\.rpc\('report_export_page', \{ p_job: job\.id \}\)/);
  assert.match(src, /call\('report_export_finish', \{ p_job: jobId, p_patch: patch \}\)/);
  assert.match(src, /ops\.rpc\('report_export_reach_ok', \{ p_job: jobId, p_user: user\.id \}\)/, 'the download re checks the reach as that user');
  assert.match(src, /ops\.auth\.getUser\(token\)/, 'the download reads the caller from their own JWT');
  assert.match(src, /secondStepRefusal\(req\)/, 'the Back Office second step applies to a download');
  assert.match(src, /downloadRefusal\(\{ job, userId: user\.id, nowMs: Date\.now\(\) \}\)/);
  assert.match(src, /upsert: false/, 'a part is never overwritten');
  assert.match(src, /partName\(prefix, partNo\)/);
  assert.match(src, /header: partNo === 1/, 'the first part carries the header');
  assert.match(src, /missingParts\(parts, /, 'a hole in the parts is found, never handed over');
  assert.match(src, /outOfTime\(startedMs, Date\.now\(\)\)/, 'the 90 second budget');
  assert.match(src, /controller\.enqueue\(encoder\.encode\(CSV_BOM\)\)/, 'one UTF-8 mark at the start of the download, never in a part');
  assert.match(src, /\.in\('status', CLEARED_STATUSES as unknown as string\[\]\)\.gt\('parts', 0\)/, 'cancelled, expired and failed jobs lose their parts');
  assert.match(src, /const patch = clearedPatch\(j\);/, 'the clear up keeps each job\'s status');
  assert.doesNotMatch(src, /status: 'cancelled', parts: 0/, 'the database refuses cancelled as a finish status');
  assert.match(src, /resumeStep\(job, missing\)/, 'a job picked up again is checked before any page is read');
  assert.match(src, /if \(page\.stopped\) \{/, 'a job no longer running is never written again');
  assert.match(src, /--no-verify-jwt/, 'deployed with no JWT at the gateway: the cron sends only x-cron-key');
  assert.match(src, /'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-key'/);
  // nothing here writes a job row directly: every write is a database function
  assert.doesNotMatch(src, /from\('report_export_jobs'\)\s*\.\s*(update|insert|delete|upsert)\(/);
  assert.doesNotMatch(src, /\.from\('report_export_jobs'\)\.(update|insert|delete|upsert)/);
  // the word s t r i p e never appears in either file
  assert.doesNotMatch(src.toLowerCase(), new RegExp(['st', 'ri', 'pe'].join('')));
  assert.doesNotMatch(rules.toLowerCase(), new RegExp(['st', 'ri', 'pe'].join('')));
  // the rules file is pure: no Deno, no network, nothing imported
  assert.doesNotMatch(rules, /Deno\.|fetch\(|^import /m);
});

test('a job picked up again: a lost part fails it, a job whose last page was read is marked done, anything else reads on', () => {
  assert.equal(resumeStep({ pages: 0, cursor: null }, []), 'read', 'a new job starts');
  assert.equal(resumeStep({ pages: 3, cursor: { value: 10, inventory_item_id: 'i' } }, []), 'read', 'carries on from the cursor');
  assert.equal(resumeStep({ pages: 3, cursor: null }, []), 'finish', 'the last page was read: never read again from the top');
  assert.equal(resumeStep({ pages: 3 }, []), 'finish');
  assert.equal(resumeStep({ pages: 3, cursor: { a: 1 } }, [2]), 'lost_part');
  assert.equal(resumeStep({ pages: 3, cursor: null }, [3]), 'lost_part', 'a hole wins over finishing');
  assert.equal(resumeStep(null, []), 'read');
  assert.equal(resumeStep({ pages: 0, cursor: null }, [1]), 'read', 'no page counted, nothing can be missing');
  assert.equal(lostPartWords(2), 'A part of the file was lost (part 2). Start the export again.');
});

test('clearing an old job records parts 0 and never changes its status', () => {
  assert.deepEqual([...CLEARED_STATUSES], ['cancelled', 'expired', 'failed']);
  assert.deepEqual(clearedPatch({ status: 'cancelled' }), { status: 'running', parts: 0 }, 'the database keeps cancelled whatever the patch says');
  assert.deepEqual(clearedPatch({ status: 'expired' }), { status: 'running', parts: 0 });
  assert.deepEqual(clearedPatch({ status: 'failed', error: 'Stopped after 5 tries.' }), { status: 'failed', parts: 0, error: 'Stopped after 5 tries.' }, 'its own words stay');
  assert.deepEqual(clearedPatch({ status: 'failed' }), { status: 'failed', parts: 0, error: 'The export stopped.' });
  assert.equal(clearedPatch({ status: 'running' }), null, 'a running job is never cleared');
  assert.equal(clearedPatch({ status: 'done' }), null);
  assert.equal(clearedPatch({ status: 'waiting' }), null);
  assert.equal(clearedPatch(null), null);
});

test('the clear up matches what the database does with a finish patch (migration source)', () => {
  const sql = read('supabase/migrations/20261026a_OPS_stock_native_4a.sql');
  const body = sql.slice(sql.indexOf('create or replace function public.report_export_finish'), sql.indexOf('create or replace function public.report_export_reach_ok'));
  assert.match(body, /when j\.status in \('cancelled', 'expired'\) then j\.status else v_status end/, 'cancelled and expired keep their status');
  assert.match(body, /v_status not in \('done', 'failed', 'running'\)/, 'only done, failed and running are accepted');
  assert.match(sql, /'status', 'running'\);\s*end\s*\$fn\$;/, 'a page read answers status running');
});
