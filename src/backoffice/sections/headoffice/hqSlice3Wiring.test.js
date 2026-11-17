/**
 * hqSlice3Wiring.test.js: Daily numbers shows the system's figures and only takes an override.
 * Run: `node --test src/backoffice/sections/headoffice/hqSlice3Wiring.test.js`.
 * Reads the source files as text (no React): the form uses systemDay.js and fetchSystemDay, the
 * scorecard tags typed figures only, the migration and its proof exist.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..', '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

test('Daily numbers: system figure beside every box, override only, save keeps the sources', () => {
  const numbers = read('src/backoffice/sections/headoffice/HqNumbers.jsx');
  assert.match(numbers, /import \{ systemFields, resolveDay, typedBoxes, sourceWord, SYSTEM_KEYS \} from '\.\.\/\.\.\/\.\.\/lib\/hq\/systemDay\.js'/);
  assert.match(numbers, /fetchSystemDay\(siteId, date\)/);
  assert.match(numbers, /resolveDay\(form, fields \|\| \{\}, siteId, date\)/);
  assert.match(numbers, /placeholder=\{has \? 'Override' : 'Type it'\}/);
  assert.match(numbers, /Leave a box blank to keep that figure/);
  assert.doesNotMatch(numbers, /formFromRow/);
});

test('data layer: trading day and system day reads, save falls back before the migration', () => {
  const data = read('src/lib/hq/data.js');
  assert.match(data, /export async function fetchTradingDay\(locationId, ymd\)/);
  assert.match(data, /functions\.invoke\('trading-report', \{ body: \{ action: 'get', ops_location_id: locationId, from: ymd, to: ymd \} \}\)/);
  assert.match(data, /export async function fetchSystemDay\(locationId, ymd\)/);
  assert.match(data, /from\('review_feedback'\)/);
  assert.match(data, /from\('wf_staff'\)/);
  assert.match(data, /from\('stock_forecast_hours'\)/);
  assert.match(data, /\.not\('id', 'like', 'demo-%'\)/);
  assert.match(data, /error\.code === '42703' \|\| error\.code === 'PGRST204' \|\| error\.code === '23514'/);
  assert.match(data, /run migration 20261202a/);
});

test('scorecard: only a typed or pasted figure wears the tag', () => {
  const sc = read('src/backoffice/sections/headoffice/HqScorecard.jsx');
  assert.match(sc, /const isTyped = \(source\) => source === 'typed' \|\| source === 'csv'/);
  assert.match(sc, /typed=\{isTyped\(r\.from\.morale\)\}/);
  assert.match(sc, /typed=\{isTyped\(r\.from\.turnover\)\}/);
  assert.match(sc, /typed=\{isTyped\(r\.from\.rating\)\}/);
  const pc = read('src/lib/hq/primeCost.js');
  assert.match(pc, /export function fieldSources\(typed\)/);
});

test('migration 20261202a, its rollback and the proof harness exist', () => {
  const mig = read('supabase/migrations/20261202a_OPS_head_office_numbers_sources.sql');
  assert.match(mig, /add column if not exists sources jsonb not null default '\{\}'::jsonb/);
  assert.match(mig, /check \(source in \('typed', 'csv', 'system'\)\)/);
  assert.ok(existsSync(join(root, 'supabase/migrations/20261202a_OPS_head_office_numbers_sources_ROLLBACK.sql')));
  const harness = read('supabase/tests/head_office_cash/run.sh');
  assert.match(harness, /PASS 7 slice 3 sources column/);
  for (const f of ['src/lib/hq/systemDay.js', 'src/lib/hq/systemDay.test.js', 'supabase/migrations/20261202a_OPS_head_office_numbers_sources.sql']) {
    assert.doesNotMatch(read(f), new RegExp('[\\u2013\\u2014]'), `${f} has a long dash`);
  }
});
