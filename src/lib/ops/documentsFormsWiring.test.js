// 28 Sep 2026 (v5.11.4): Operations Documents and Forms, source pins for the wiring.
// The screens are reachable (Back Office menu, the tablet's Home tiles), the tablet never
// reads a submission, the migration keeps its access rules and set form, and the app and
// the SQL agree on categories, the size limit and the bucket.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DOC_CATEGORIES, MAX_FILE_BYTES, OPS_FILES_BUCKET } from './formRules.js';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const bo = read('../../backoffice/BackOfficeApp.jsx');
const surface = read('../../surfaces/OperationsSurface.jsx');
const tablet = read('../../surfaces/ops/OpsDocsForms.jsx');
const boDocs = read('../../backoffice/sections/operations/OpsDocuments.jsx');
const boForms = read('../../backoffice/sections/operations/OpsForms.jsx');
const viewer = read('../../components/OpsDocViewer.jsx');
const docsLib = read('./documents.js');
const formsLib = read('./forms.js');
const rules = read('./formRules.js');
const sql = read('../../../supabase/migrations/20260928c_OPS_documents_forms.sql');
const rollback = read('../../../supabase/migrations/20260928c_OPS_documents_forms_ROLLBACK.sql');
// SQL with the comments taken out, so pins read statements only.
const stmts = sql.split('\n').filter((l) => !/^\s*--/.test(l)).map((l) => l.replace(/\s--.*$/, '')).join('\n');

test('Back Office: Operations has Documents and Forms, and both render', () => {
  assert.match(bo, /import OpsDocuments from '\.\/sections\/operations\/OpsDocuments';/);
  assert.match(bo, /import OpsForms from '\.\/sections\/operations\/OpsForms';/);
  assert.match(bo, /\{ id:'ops-documents',\s+label:'Documents',[^}]*group:'Operations' \}/);
  assert.match(bo, /\{ id:'ops-forms',\s+label:'Forms',[^}]*group:'Operations' \}/);
  const ia = bo.match(/\{ label:'Operations', icon:'[^']+', children:\[(.*)\] \},/);
  assert.ok(ia, 'the Operations group is in the sidebar');
  assert.match(ia[1], /\['ops-documents','Documents'\]/);
  assert.match(ia[1], /\['ops-forms','Forms'\]/);
  assert.match(bo, /section === 'ops-documents'\s+&& <OpsDocuments \/>/);
  assert.match(bo, /section === 'ops-forms'\s+&& <OpsForms \/>/);
});

test('Operations tablet: Home tiles open Documents and Forms (also the Manager app Ops tab)', () => {
  assert.match(surface, /import \{ OpsDocuments, OpsForms \} from '\.\/ops\/OpsDocsForms';/);
  assert.match(surface, /onClick: \(\) => onOpen\('documents'\)/);
  assert.match(surface, /onClick: \(\) => onOpen\('forms'\)/);
  assert.match(surface, /view === 'documents' \? \([\s\S]{0,200}<OpsDocuments loc=\{loc\} operator=\{operator\}/);
  assert.match(surface, /view === 'forms' \? \(\s*<OpsForms loc=\{loc\} operator=\{operator\}/);
  assert.match(surface, /'alerts', 'documents', 'forms'\]\.includes\(jump\.view\)/);
});

test('the tablet never reads a submission; it adds one as the signed in staff member', () => {
  assert.doesNotMatch(tablet, /fetchSubmissions|signSubmissionFiles/);
  assert.match(tablet, /submitForm\(\{ form, answers, operator, source: 'tablet', submissionId \}, loc\)/);
  assert.match(tablet, /byName: operator\?\.name \|\| null, byStaffId: operator\?\.id \|\| null, source: 'tablet'/);
  // A photo input asks the shell whether it may open the camera (cameraCapture.test.js rule).
  assert.match(tablet, /\{\.\.\.photoInputProps\(\)\}/);
  assert.doesNotMatch(tablet, /<input[^>]*capture=/);
  // One submission id per fill, kept across retries.
  assert.match(tablet, /useState\(\(\) => newId\(\)\)/);
});

test('submissions: inserted without reading back, never in training mode, times from the database', () => {
  assert.match(formsLib, /await supabase\.from\('ops_form_submissions'\)\.insert\(row\);/);
  assert.doesNotMatch(formsLib, /from\('ops_form_submissions'\)\.insert\([^)]*\)\s*\.select/);
  assert.doesNotMatch(formsLib, /submitted_at:/, 'the device clock never stamps a submission');
  assert.match(formsLib, /if \(isTrainingMode\(\)\) return \{ data: null, error: new Error\('Training mode: this form was not saved\.'\) \};/);
  assert.match(formsLib, /String\(error\.code\) === '23505'\) return \{ data: \{ id \}, error: null, duplicate: true \}/);
  // Forms are compare and set on version.
  assert.match(formsLib, /\.eq\('location_id', locationId\)\.eq\('id', form\.id\)\.eq\('version', base\)\.select\('\*'\)/);
});

test('documents: never overwrite a file, open the tab before the await, archive only', () => {
  assert.match(docsLib, /upload\(path, file, \{ upsert: false, contentType, cacheControl: '3600' \}\)/);
  assert.match(formsLib, /upload\(path, body, \{ upsert: false, contentType, cacheControl: '3600' \}\)/);
  const open = docsLib.slice(docsLib.indexOf('export async function openDocument'));
  assert.ok(open.indexOf("win.open('', '_blank')") > 0);
  assert.ok(open.indexOf("win.open('', '_blank')") < open.indexOf('await signedFileUrl'), 'a browser only allows a new tab straight from the tap');
  assert.doesNotMatch(docsLib + formsLib, /\.delete\(\)|\.remove\(/, 'nothing is deleted');
  // The iOS shells and the Sunmi till app would load the file in place with no way back:
  // they get the in-app viewer, never a tab or a navigation.
  assert.match(open, /if \(mode === 'viewer'\) return \{ error: null, url, viewer: true \};/);
  assert.ok(open.indexOf("mode === 'viewer'") < open.indexOf('win.location.assign(url)'));
  for (const [name, src] of [['tablet', tablet], ['OpsDocuments', boDocs]]) {
    assert.match(src, /import OpsDocViewer from '[./]+components\/OpsDocViewer';/, name);
    assert.match(src, /if \(r\.viewer\) \{ setViewing\(\{ doc: d, url: r\.url \}\); return; \}/, name);
    assert.match(src, /\{viewing && <OpsDocViewer doc=\{viewing\.doc\} url=\{viewing\.url\} onClose=\{\(\) => setViewing\(null\)\} \/>\}/, name);
  }
  assert.match(viewer, /createPortal\(/);
  assert.match(viewer, />Close<\/button>/);
  assert.match(docsLib, /if \(isTrainingMode\(\)\) return/);
});

test('every read says "not set up yet" before the migration, never crashes', () => {
  for (const [name, src] of [['documents.js', docsLib], ['forms.js', formsLib]]) {
    assert.match(src, /isAbsentError\(/, name);
    assert.match(src, /NOT_SET_UP\./, name);
  }
  for (const [name, src] of [['tablet', tablet], ['OpsDocuments', boDocs], ['OpsForms', boForms]]) {
    assert.match(src, /setAbsent\(r\.absent \? r\.message : ''\)/, name);
  }
  assert.match(rules, /not set up yet/);
});

test('static imports only; no en or em dashes in anything added', () => {
  for (const [name, src] of [['tablet', tablet], ['OpsDocuments', boDocs], ['OpsForms', boForms], ['viewer', viewer], ['documents', docsLib], ['forms', formsLib], ['rules', rules], ['sql', sql], ['rollback', rollback]]) {
    assert.doesNotMatch(src, /\bimport\s*\(/, `${name}: no dynamic import`);
    assert.doesNotMatch(src, /[–—]/, `${name}: no en or em dash`);
  }
});

test('migration: three tables, row level security on, no delete anywhere', () => {
  for (const t of ['ops_documents', 'ops_forms', 'ops_form_submissions']) {
    assert.match(stmts, new RegExp(`create table if not exists public\\.${t} \\(`), t);
    assert.match(stmts, new RegExp(`alter table public\\.${t} enable row level security;`), t);
  }
  assert.doesNotMatch(stmts, /for delete/i);
  assert.doesNotMatch(stmts, /for all to public/i);
  assert.match(stmts, /revoke update, delete, truncate on public\.ops_form_submissions from anon, authenticated;/);
});

test('migration: set form helpers only, never a per row function call', () => {
  assert.doesNotMatch(stmts, /pos_can_access\s*\(|ops_can_write\s*\(|waitlist_can_write\s*\(/);
  assert.match(stmts, /to_regprocedure\('public\.ops_writable_location_uuids\(\)'\) is null/, 'stops if 20260927a has not run');
  // Submissions: Back Office reads, tablets and Back Office add.
  const subSel = stmts.match(/create policy ops_form_submissions_select[\s\S]*?;/)[0];
  assert.match(subSel, /for select to public/);
  assert.match(subSel, /\(\(location_id\)::text in \(select public\.user_accessible_locations\(\)\)\)/);
  assert.doesNotMatch(subSel, /ops_writable/);
  const subIns = stmts.match(/create policy ops_form_submissions_insert[\s\S]*?;/)[0];
  assert.match(subIns, /with check \(\(location_id in \(select public\.ops_writable_location_uuids\(\)\)\)\)/);
  // Forms: tablets read, Back Office writes. Documents: tablets read and add, Back Office changes.
  assert.match(stmts.match(/create policy ops_forms_select[\s\S]*?;/)[0], /ops_writable_location_uuids/);
  assert.match(stmts.match(/create policy ops_forms_insert[\s\S]*?;/)[0], /user_accessible_locations/);
  assert.match(stmts.match(/create policy ops_forms_update[\s\S]*?;/)[0], /user_accessible_locations[\s\S]*user_accessible_locations/);
  assert.match(stmts.match(/create policy ops_documents_insert[\s\S]*?;/)[0], /ops_writable_location_uuids/);
  assert.match(stmts.match(/create policy ops_documents_update[\s\S]*?;/)[0], /user_accessible_locations[\s\S]*user_accessible_locations/);
  // A submission's form must be the same venue's form.
  assert.match(stmts, /foreign key \(form_id, location_id\) references public\.ops_forms \(id, location_id\)/);
  assert.match(stmts, /new\.submitted_at := now\(\);/);
  assert.match(stmts, /second_step_fence/);
});

test('migration storage rules: the bucket, the folders, and objects.name in full', () => {
  assert.equal(OPS_FILES_BUCKET, 'ops-files');
  assert.match(stmts, /values \('ops-files', 'ops-files', false, 20971520, null\)/);
  assert.equal(MAX_FILE_BYTES, 20971520);
  assert.match(stmts, /size_bytes <= 20971520/);
  // An unqualified `name` inside a subquery binds to the subquery's table (ops_devices.name).
  assert.doesNotMatch(stmts, /foldername\(name\)/);
  const formsRead = stmts.match(/create policy ops_files_forms_read[\s\S]*?\);\n/)[0];
  assert.match(formsRead, /\[2\] = 'forms'/);
  assert.match(formsRead, /\[1\] in \(select public\.user_accessible_locations\(\)\)/);
  assert.match(formsRead, /objects\.created_at > now\(\) - interval '15 minutes'/);
  const docsRead = stmts.match(/create policy ops_files_documents_read[\s\S]*?\);\n/)[0];
  assert.match(docsRead, /\[2\] = 'documents'/);
  assert.match(docsRead, /ops_writable_location_uuids/);
  const ins = stmts.match(/create policy ops_files_insert[\s\S]*?\);\n/)[0];
  assert.match(ins, /\[2\] in \('documents', 'forms'\)/);
  assert.doesNotMatch(stmts, /on storage\.objects\s+as permissive for (update|delete)/);
});

test('the app and the SQL agree on the document categories', () => {
  const m = stmts.match(/check \(category in \(([^)]*)\)\)/);
  assert.ok(m);
  const sqlKeys = m[1].split(',').map((s) => s.trim().replace(/'/g, ''));
  assert.deepEqual(sqlKeys, DOC_CATEGORIES.map((c) => c.key));
});

test('rollback: refuses while records exist, removes the storage rules and tables', () => {
  assert.match(rollback, /v_force boolean := false;/);
  assert.match(rollback, /raise exception 'Rollback stopped, NOTHING changed/);
  for (const p of ['ops_files_documents_read', 'ops_files_forms_read', 'ops_files_insert']) {
    assert.match(rollback, new RegExp(`drop policy if exists ${p} on storage\\.objects;`));
  }
  for (const t of ['ops_form_submissions', 'ops_forms', 'ops_documents']) {
    assert.match(rollback, new RegExp(`drop table if exists public\\.${t};`));
  }
});
