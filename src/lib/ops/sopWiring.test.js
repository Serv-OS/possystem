// SOPs (5.12.62): source pins for the wiring. The tool is in every place a tool must be (the two
// allowed lists, the definitions, the executor, both prompts), both upload screens offer the SOP
// box, the data layer carries the words, the SQL adds the columns and the tills' read rule, and the
// till's read never reaches a kiosk.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const ai = read('../../../api/ai.js');
const tools = read('../aiTools.js');
const chat = read('../../components/AIChat.jsx');
const docsLib = read('./documents.js');
const boDocs = read('../../backoffice/sections/operations/OpsDocuments.jsx');
const tablet = read('../../surfaces/ops/OpsDocsForms.jsx');
const route = read('../../../api/sop-text.js');
const sql = read('../../../supabase/migrations/20261122a_OPS_documents_sop.sql');
const rollback = read('../../../supabase/migrations/20261122a_OPS_documents_sop_ROLLBACK.sql');
const stmts = sql.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');

test('search_sops is a tool in every place a tool must be', () => {
  const foh = ai.match(/const ALLOWED_TOOLS_FOH = \[([^\]]*)\]/)[1];
  const boh = ai.match(/const ALLOWED_TOOLS_BOH = \[([^\]]*)\]/)[1];
  assert.match(foh, /'search_sops'/, 'the till assistant');
  assert.match(boh, /'search_sops'/, 'the Back Office assistant');
  assert.match(ai, /search_sops: \{\s*name: 'search_sops'/, 'the definition');
  assert.match(ai, /properties: \{ query: \{ type: 'string'/);
  assert.match(tools, /case 'search_sops': \{/, 'the executor');
  assert.match(tools, /import \{ fetchSops \} from '\.\/ops\/documents';/);
  assert.match(tools, /return \{ result: searchSops\(data, toolInput\.query \|\| ''\) \};/);
  assert.match(chat, /search_sops:\s+\['note', 'Reading the SOPs…'\]/, 'the badge');
});

test('both prompts tell the model to answer in the SOP\'s own words and never invent a step', () => {
  const foh = ai.slice(ai.indexOf('const SYSTEM_FOH'), ai.indexOf('const SYSTEM_BOH'));
  const boh = ai.slice(ai.indexOf('const SYSTEM_BOH'), ai.indexOf('const SYSTEM_ROTA'));
  for (const p of [foh, boh]) {
    assert.match(p, /search_sops/);
    assert.match(p, /OWN\s+WORDS/);
    assert.match(p, /Never (make up a procedure|invent a step)/);
  }
});

test('both upload screens offer the SOP box and read the words before the upload', () => {
  for (const src of [boDocs, tablet]) {
    assert.match(src, /SOP_WORDS\.box/);
    assert.match(src, /sopReadable\(file\)/);
    assert.match(src, /readSopText\(file\)/);
    assert.match(src, /isSop, sopText \}/);
  }
  assert.match(boDocs, /toggleSop/, 'Back Office can mark an existing document');
  assert.match(boDocs, /downloadDocumentFile\(d\)/);
  assert.match(boDocs, /setDocumentSop\(d\.id, true, locId, \{ sopText: r\.text \}\)/);
  assert.doesNotMatch(tablet, /setDocumentSop/, 'the tablet never changes an existing document (the update rule is Back Office only)');
});

test('the data layer carries the words and reads as before until the SQL has run', () => {
  assert.match(docsLib, /row\.is_sop = true; row\.sop_text = cleanSopText\(sopText\); row\.sop_text_at/);
  assert.match(docsLib, /if \(error && !isSop && noSopCols\(error\)\)/, 'a plain upload still saves before 20261122a');
  assert.match(docsLib, /if \(error && noSopCols\(error\)\) \(\{ data, error \} = await list\(OLD_COLS\)\)/, 'the list still loads before 20261122a');
  assert.match(docsLib, /export async function fetchSops/);
  assert.match(docsLib, /\.eq\('is_sop', true\)\.is\('archived_at', null\)/);
  assert.doesNotMatch(docsLib.slice(docsLib.indexOf('const DOC_COLS')).split('\n')[0], /sop_text[^_]/, 'the list never carries the text itself');
});

test('the route reads a PDF or a photo through the venue door and transcribes, never summarises', () => {
  assert.match(route, /requireVenueUser\(req, \{ locationId: req\.body\?\.location_id/);
  assert.match(route, /type: 'document', source: \{ type: 'base64', media_type: 'application\/pdf'/);
  assert.match(route, /Do not summarise/);
  assert.match(route, /image\.length > 8_500_000/);
});

test('the SQL adds the columns, the index and a tills read rule that never reaches a kiosk', () => {
  assert.match(stmts, /add column if not exists is_sop\s+boolean\s+not null default false/);
  assert.match(stmts, /add column if not exists sop_text\s+text/);
  assert.match(stmts, /add column if not exists sop_text_at timestamptz/);
  assert.match(stmts, /create index if not exists ops_documents_sop_idx/);
  assert.match(stmts, /create or replace function public\.ops_sop_reader_location_ids\(\)/);
  assert.match(stmts, /select l from public\.venue_message_reader_location_ids\(\) as l\s+union\s+select l from public\.ops_writable_location_uuids\(\) as l;/);
  assert.match(stmts, /create policy ops_documents_select_sop on public\.ops_documents\s+as permissive for select to authenticated\s+using \(is_sop and archived_at is null and location_id in \(select public\.ops_sop_reader_location_ids\(\)\)\)/);
  assert.doesNotMatch(stmts, /accessible_location_uuids\(\)/, 'never the broad device set (kiosks, kitchen screens, clocks)');
  assert.match(stmts, /revoke all on function public\.ops_sop_reader_location_ids\(\) from public, anon/);
  assert.match(rollback, /drop policy if exists ops_documents_select_sop/);
  assert.match(rollback, /drop function if exists public\.ops_sop_reader_location_ids\(\)/);
  assert.match(rollback, /drop column if exists is_sop/);
  for (const text of [sql, rollback]) assert.doesNotMatch(text, /[^\u0020-\u007e\n]/, 'ASCII only');
});
