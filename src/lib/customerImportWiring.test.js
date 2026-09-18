// src/lib/customerImportWiring.test.js
//
// THE SCREEN AND THE WRITER HAVE TO BE TALKING TO EACH OTHER.
//
// Every rule in customerImport.js can be perfect and the import still do
// nothing at all, because the two halves were never held together by anything:
//
//   * the screen posted to `customers-import`. The function directory is
//     `customer-import`. Every single import 404ed, and importErrorMessage
//     dressed that 404 up as "The import is not live on this site yet", which
//     reads as "nothing to do here" rather than "this is broken".
//   * the body disagreed with the function on FIVE keys: no `action` at all
//     (400 'action required'), `location_id` where the function reads
//     `ops_location_id`, and `batch_key` where it reads `batch_id`, so every
//     chunk minted a fresh batch id and a 20,000 row file would have written
//     100 import_batches rows with nothing to carry on from.
//   * the answer's numbers live under `chunk`, and the screen read the top
//     level, so a run that worked reported "0 customers added".
//
// None of that is a rule about a customer. It is wiring, and wiring is exactly
// what no unit test was looking at. These tests read the real files.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  IMPORT_FUNCTION,
  importRequestBody,
  previewRequestBody,
  contextRequestBody,
  mergeResult,
  failedFromChunk,
  resultLine,
} from './customerImportScreen.js';
import {
  readCsv,
  validateRows,
  summarise,
  rawRowsOnly,
  problemRowNumbers,
  normaliseRow,
  appPhone,
} from './customerImport.js';
import { decideRows, indexExisting } from '../../supabase/functions/_shared/customerImportPlan.ts';

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const read = (rel) => fs.readFileSync(here(rel), 'utf8');

const SCREEN = '../admin/sections/AdminCustomerImport.jsx';
const FUNCTION_INDEX = '../../supabase/functions/customer-import/index.ts';
const FUNCTIONS_DIR = '../../supabase/functions';

const OPTS = { today: '2026-09-18', country: 'GB' };

// ── 1. the URL names a function that exists ─────────────────────────────────

test('the screen posts to a function directory that actually exists', () => {
  const dirs = fs.readdirSync(here(FUNCTIONS_DIR), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  assert.ok(dirs.includes(IMPORT_FUNCTION),
    IMPORT_FUNCTION + ' is not a directory under supabase/functions. A name that is not there is a 404, and the screen reads a 404 back to the operator as "not live yet".');
  assert.ok(fs.existsSync(path.join(here(FUNCTIONS_DIR), IMPORT_FUNCTION, 'index.ts')),
    'the function directory has an index.ts');

  // And the screen builds its URL from that one constant, not from a string of
  // its own that can drift again.
  const src = read(SCREEN);
  assert.ok(src.includes('${FUNCTIONS_URL}/${IMPORT_FUNCTION}'), 'the URL is built from IMPORT_FUNCTION');

  // Nothing in the screen names a function that is not there.
  const named = src.match(/\$\{FUNCTIONS_URL\}\/([a-z0-9-]+)/g) || [];
  for (const hit of named) {
    const name = hit.split('/').pop();
    assert.ok(dirs.includes(name), 'the screen posts to ' + name + ', which is not a function');
  }
});

// ── 2. the body is the keys the function reads ──────────────────────────────

/** Every `body.x` / `body?.x` the edge function actually reads. */
function keysTheFunctionReads() {
  const src = read(FUNCTION_INDEX);
  const hits = src.match(/body\??\.[a-z_]+/g) || [];
  return Array.from(new Set(hits.map((h) => h.replace(/^body\??\./, '')))).sort();
}

test('the posted body is exactly the keys the edge function reads', () => {
  const posted = Object.keys(importRequestBody({
    opsLocationId: 'loc-1', orgId: 'org-1', rows: [{ name: 'Jane' }], batchId: 'b1',
    filename: 'coffeeboy.csv', today: '2026-09-18', programId: 'prog-1',
    consentText: 'Imported from 5Loyalty.', chunkIndex: 0,
  })).sort();
  const reads = keysTheFunctionReads();

  assert.deepEqual(posted, reads,
    'the screen and the writer must agree key for key. Posted: ' + posted.join(', ') + ' / read: ' + reads.join(', '));

  // The three that were actually wrong, named so a future rename is loud.
  assert.ok(posted.includes('action'), 'no action is a 400 before anything else happens');
  assert.ok(posted.includes('ops_location_id'), 'the function reads ops_location_id, never location_id');
  assert.ok(posted.includes('batch_id'), 'the function reads batch_id, never batch_key');
  assert.ok(!posted.includes('location_id'));
  assert.ok(!posted.includes('batch_key'));
  assert.ok(posted.includes('org_id'), 'the company the operator picked, which the function checks');

  // The preview and context bodies only carry keys the function reads.
  for (const body of [previewRequestBody({}), contextRequestBody({})]) {
    for (const key of Object.keys(body)) assert.ok(reads.includes(key), key + ' is read by the function');
  }
  assert.equal(previewRequestBody({}).action, 'preview');
  assert.equal(contextRequestBody({}).action, 'context');
});

test('the screen sends the body through that one builder, not by hand', () => {
  const src = read(SCREEN);
  assert.ok(src.includes('importRequestBody('), 'one shape, built in one place, under test');
  assert.ok(!src.includes('batch_key'), 'the key the function never read is gone');
  assert.ok(!src.includes('location_id:'), 'the key the function never read is gone');
});

test('the import action is the only one the screen can ask for', () => {
  const body = importRequestBody({ opsLocationId: 'loc-1', rows: [] });
  assert.equal(body.action, 'import');
  assert.equal(body.chunk_index, 0);
  assert.deepEqual(importRequestBody(null).rows, []);
});

// ── a recorded answer, straight out of the writer ───────────────────────────

// Exactly what supabase/functions/customer-import/index.ts returns, copied from
// the json({...}) at the end of it. If the shape changes, this goes red.
const RECORDED_ANSWER = {
  ok: true,
  batch_id: '7f0a2c1e-1111-4b2a-9c3d-abcdefabcdef',
  batch_tag: 'import:7f0a2c1e-1111-4b2a-9c3d-abcdefabcdef',
  batch_table: true,
  chunk_index: 0,
  chunk: {
    rows: 200,
    created: 188,
    updated: 9,
    skipped: 3,
    stamped: 150,
    enrolled: 188,
    already_stamped: 4,
    consent_withheld: 1,
    skipped_rows: [{ row_number: 7, reason: 'Same phone and email as row 2. We keep the first one.' }],
    failed: [{ row_number: 44, reason: 'We could not add this person. duplicate key value' }],
    notes: ['We already imported stamps for 4 of these people, so we left their cards alone.'],
  },
  totals: { row_count: 200, created_count: 188, updated_count: 9, skipped_count: 3 },
  counts: { total: 200, newCustomers: 188, updates: 9, blocked: 0, withStamps: 154, stampsTotal: 600, rewardsTotal: 30 },
};

test('a real answer from the writer produces real numbers on the screen', () => {
  const acc = mergeResult(null, RECORDED_ANSWER);
  assert.equal(acc.created, 188, 'the counts live under chunk, not at the top level');
  assert.equal(acc.updated, 9);
  assert.equal(acc.skipped, 3);
  assert.equal(acc.stamped, 150);
  assert.equal(acc.enrolled, 188);
  assert.equal(acc.alreadyStamped, 4);
  assert.equal(acc.consentWithheld, 1);
  assert.equal(acc.batchId, RECORDED_ANSWER.batch_id);
  assert.equal(acc.failed.length, 1);
  assert.equal(acc.failed[0].rowNumber, 44, 'the row number comes back out of the line, so it can be found in the file');
  assert.equal(acc.notes.length, 1);

  // And the line the operator reads is not a row of zeroes.
  const line = resultLine(acc);
  assert.match(line, /188 customers added/);
  assert.ok(!/^0 customers added/.test(line));
});

test('two chunks add up, and the batch id survives the second one', () => {
  let acc = mergeResult(null, RECORDED_ANSWER);
  acc = mergeResult(acc, { ...RECORDED_ANSWER, batch_id: undefined, chunk: { ...RECORDED_ANSWER.chunk, created: 12, failed: [], notes: [] } });
  assert.equal(acc.created, 200);
  assert.equal(acc.batchId, RECORDED_ANSWER.batch_id, 'one batch id for the whole file, or the stamps double');
});

test('failedFromChunk keeps the words and finds the row, and never makes a row out of a run line', () => {
  const out = failedFromChunk({ errors: ['Row 7: That date is not a real day.', 'something with no row number'] });
  assert.equal(out.length, 1, 'a line with no row number is a note, not a failed row 0');
  assert.equal(out[0].rowNumber, 7);
  assert.equal(out[0].reason, 'That date is not a real day.');
  assert.deepEqual(failedFromChunk({ failed: [{ row_number: 9, reason: 'no' }] }).map((f) => f.rowNumber), [9]);
  assert.deepEqual(failedFromChunk(null), []);
});

// ── 5. nothing off the wire is trusted to have been checked ─────────────────

test('an already shaped row cannot walk past the checks', () => {
  // validateRows is the edge function's ONLY guard, and normaliseRow hands an
  // already normalised row straight back. Any signed in Back Office user of the
  // venue could POST this and give themselves a hundred thousand stamps.
  const forged = {
    rowNumber: 2,
    name: 'Forged',
    phone: '+447700900123',
    phoneRaw: null,
    phoneAssumed: false,
    email: null,
    stamps: 100000,
    rewardsUnused: 5000,
    marketingOptIn: true,
    optInDate: null,
    problems: [],
    warnings: [],
  };

  // Straight in, it is waved through. This is the hole.
  const naive = validateRows([forged], OPTS);
  assert.equal(naive.ready.length, 1);
  assert.equal(naive.ready[0].stamps, 100000, 'the passthrough exists, and this is why it is dangerous');

  // Through the projection the edge function now uses, the cooked verdict is
  // gone and every value left is a CELL that has to survive the rules.
  const stripped = rawRowsOnly([forged]);
  assert.equal(Object.prototype.hasOwnProperty.call(stripped[0], 'problems'), false, 'no pre cooked verdict survives');
  assert.equal(Object.prototype.hasOwnProperty.call(stripped[0], 'phoneRaw'), false, 'nor the marker that made it look checked');
  assert.equal(Object.prototype.hasOwnProperty.call(stripped[0], 'marketingOptIn'), false, 'nor a cooked opt in');
  assert.equal(stripped[0].marketing_opt_in, '', 'there was no marketing_opt_in CELL, so nobody said');
  assert.equal(stripped[0].stamps, '100000', 'a stamps CELL is still only a cell');

  const checked = validateRows(stripped, OPTS);
  assert.equal(checked.ready.length, 0, 'and the cap refuses it, which the passthrough never did');
  assert.ok(checked.errors.some((e) => /too high/i.test(e.message)), 'a hundred thousand stamps is checked like any other number');
});

test('a forged opt in cannot give somebody consent they never gave', () => {
  // Under the cap, so the row IS written. The forged marketingOptIn must still
  // count for nothing, because the only thing that can say yes is the cell.
  const forged = {
    rowNumber: 2, name: 'Forged', phone: '07700 900123', phoneRaw: null,
    stamps: 4, marketingOptIn: true, problems: [], warnings: [],
  };
  const [row] = validateRows(rawRowsOnly([forged]), OPTS).ready;
  assert.ok(row, 'the person is fine, it is the verdict we throw away');
  assert.equal(row.marketingOptIn, null, 'nobody said, and a blank is never a yes');
  assert.equal(row.stamps, 4);
});

test('the projection keeps a real row exactly as the file wrote it', () => {
  const real = { rowNumber: 2, name: 'Jane Smith', phone: '07954 412324', stamps: '4', rewards_unused: '1', marketing_opt_in: 'yes' };
  const stripped = rawRowsOnly([real]);
  assert.equal(stripped[0].name, 'Jane Smith');
  assert.equal(stripped[0].phone, '07954 412324');
  assert.equal(stripped[0].stamps, '4');
  assert.equal(stripped[0].rowNumber, 2, 'the row number is how the operator finds it in the spreadsheet');
  const checked = validateRows(stripped, OPTS);
  assert.equal(checked.ready.length, 1);
  assert.equal(checked.ready[0].stamps, 4);
});

test('the edge function strips every posted row before it checks it', () => {
  const src = read(FUNCTION_INDEX);
  assert.ok(src.includes('rawRowsOnly(rawRows)'), 'rows off the wire are projected down to the template cells');
  assert.ok(!/validateRows\(rawRows/.test(src), 'nothing posted goes into validateRows unstripped');
});

// ── 9. the numbers count rows, not complaints ───────────────────────────────

test('one row with three problems is one skipped row, not three', () => {
  const rows = [
    { rowNumber: 2, name: 'Bad', phone: '07700 900123', stamps: '-3', rewards_unused: '-1', birthday: '31/02/2025' },
  ];
  const checked = validateRows(rows, OPTS);
  assert.ok(checked.errors.length >= 3, 'three separate complaints about one row');
  assert.deepEqual(problemRowNumbers(checked), [2], 'but one row');
  assert.equal(summarise(rows, null, OPTS).problems, 1);
  assert.equal(summarise(rows, null, OPTS).total, 1, 'the total is the file, not the complaints');
});

const allNew = (checked) => checked.ready.map((r) => ({ row_number: r.rowNumber, verdict: 'new' }));

test('the writer counts skipped ROWS and only counts an update it actually made', () => {
  const src = read(FUNCTION_INDEX);
  assert.ok(src.includes('for (const n of problemRowNumbers(checked)) skipRow(progress, n'), 'skipped counts distinct rows');
  assert.ok(!/progress\.skipped = checked\.errors\.length/.test(src), 'never the number of complaints');
  assert.ok(!/progress\.updated = updated\.size/.test(src), 'never every match');
  assert.ok(!/patches\.push\(patch\);\s*\n\s*progress\.updated\+\+;/.test(src), 'never when the patch is only built');
  assert.ok(src.includes('if (!error) { progress.updated += slice.length; continue; }'), 'updated goes up when the write lands');
});

// ── the file Coffee Boy is actually going to hand us ────────────────────────

// The real 5Loyalty export, column for column. Phones arrive UK local with a
// space, external_id is 5L-xxxxxx, opt_in_source is 5Loyalty, and opt_in_date
// and signed_up_date are EMPTY, because 5Loyalty do not expose them.
const COFFEE_BOY = [
  'name,first_name,last_name,phone,email,stamps,rewards_unused,marketing_opt_in,opt_in_date,opt_in_source,signed_up_date,birthday,external_id,notes',
  'Jane Smith,Jane,Smith,07954 412324,jane@example.com,4,1,yes,,5Loyalty,,1990-06-24,5L-788493,Likes oat milk',
  'Bob Jones,Bob,Jones,07954 412325,bob@example.com,8,0,no,,5Loyalty,,,5L-788494,',
  'Ann Patel,Ann,Patel,07954 412326,,0,2,yes,,5Loyalty,,,5L-788495,',
  // The shop opened the file in Excel once before sending it, so this one lost
  // its leading zero.
  'Dev Rao,Dev,Rao,7954412327,dev@example.com,2,0,yes,,5Loyalty,,,5L-788496,',
  // And this venue takes landline numbers too.
  'Mo Khan,Mo,Khan,0161 496 0000,mo@example.com,1,0,,,5Loyalty,,,5L-788497,',
].join('\r\n');

test('the Coffee Boy file off 5Loyalty imports cleanly, end to end', () => {
  const parsed = readCsv(COFFEE_BOY);
  assert.equal(parsed.found, true);
  assert.equal(parsed.hasPhone, true);
  assert.equal(parsed.rows.length, 5);
  assert.deepEqual(parsed.unknown, [], 'we know every column in their export');
  assert.deepEqual(parsed.missing, [], 'and their export has every column we ask for');

  // The edge function strips the posted rows first, exactly as it does live.
  const checked = validateRows(rawRowsOnly(parsed.rows), OPTS);
  assert.deepEqual(checked.errors, [], 'nobody is refused: ' + checked.errors.map((e) => e.text).join(' '));
  assert.deepEqual(checked.duplicatesInFile, []);
  assert.equal(checked.ready.length, 5);

  const [jane, bob, ann, dev, mo] = checked.ready;

  // The phone is the login. Every one of these is the shape the till writes.
  assert.equal(jane.phone, '+447954412324');
  assert.equal(jane.phoneRaw, '07954 412324', 'what they typed is kept as well');
  assert.equal(bob.phone, '+447954412325');
  assert.equal(ann.phone, '+447954412326');
  assert.equal(dev.phone, '+447954412327', 'the zero Excel ate is back');
  assert.equal(dev.phoneAssumed, true, 'and we say so on the screen');
  assert.equal(mo.phone, '01614960000', 'a landline is stored the way the till stores it, not as +44');

  // Stamps and rewards are two different numbers and neither is a points balance.
  assert.equal(jane.stamps, 4);
  assert.equal(jane.rewardsUnused, 1);
  assert.equal(ann.rewardsUnused, 2, 'two free drinks already earned and not taken');

  // Marketing: a yes, a no, and one nobody answered. A blank is never a yes.
  assert.equal(jane.marketingOptIn, true);
  assert.equal(bob.marketingOptIn, false);
  assert.equal(mo.marketingOptIn, null);

  // 5Loyalty give no dates at all, and that is not an error.
  assert.equal(jane.optInDate, null);
  assert.equal(jane.signedUpDate, null);
  assert.equal(jane.optInSource, '5Loyalty');
  assert.equal(jane.externalId, '5L-788493');
  assert.equal(jane.birthday, '1990-06-24');

  // Every one of them has a name, because customers.name is NOT NULL.
  for (const r of checked.ready) assert.ok(r.name && r.name.length > 0);

  const s = summarise(checked, allNew(checked), OPTS);
  assert.equal(s.ready, 5);
  assert.equal(s.newCustomers, 5, 'Coffee Boy have nobody in RPOS yet');
  assert.equal(s.problems, 0);
  assert.equal(s.duplicates, 0);
  assert.equal(s.withStamps, 5, 'every one of them is carrying something');
  assert.equal(s.stampsTotal, 15);
  assert.equal(s.rewardsTotal, 3);
  assert.equal(s.canEmail, 2, 'a yes AND an email to send to');
  assert.equal(s.optedOut, 1);
  assert.equal(s.notSaid, 1);
  assert.equal(s.phoneFixed, 1);
});

test('the same Coffee Boy file read twice says exactly the same thing', () => {
  // Running the file again is the obvious human move. It must be the same
  // answer every time, or the second run is not idempotent either.
  const once = validateRows(rawRowsOnly(readCsv(COFFEE_BOY).rows), OPTS);
  const twice = validateRows(rawRowsOnly(readCsv(COFFEE_BOY).rows), OPTS);
  assert.deepEqual(twice, once);
  assert.deepEqual(summarise(twice, allNew(twice), OPTS), summarise(once, allNew(once), OPTS));
});

test('a second Coffee Boy row for somebody we already have is an update, not a twin', () => {
  const rows = readCsv(COFFEE_BOY).rows;
  const checked = validateRows(rawRowsOnly(rows), OPTS);
  // The till already has Mo, stored the way the app stores a landline, and Jane
  // under the E.164 form an earlier run of this importer wrote.
  const existing = [
    { id: 'mo', phone: '01614960000', email: null },
    { id: 'jane', phone: '+447954412324', email: null },
  ];
  const decisions = decideRows(checked.ready, indexExisting(existing, { country: 'GB' }), { country: 'GB' });
  const known = decisions.filter((d) => d.verdict === 'update').map((d) => d.customerId).sort();
  assert.deepEqual(known, ['jane', 'mo'], 'both shapes find their person');
  const verdicts = decisions.map((d) => ({ row_number: d.rowNumber, verdict: d.verdict, customer_id: d.customerId }));
  assert.equal(summarise(checked, verdicts, OPTS).alreadyKnown, 2);
  assert.equal(summarise(checked, verdicts, OPTS).newCustomers, 3);
});

// ── the words on the screen ─────────────────────────────────────────────────

test('the screen and its wiring have no em or en dashes', () => {
  for (const rel of [SCREEN, './customerImportScreen.js', './customerImport.js', FUNCTION_INDEX]) {
    assert.ok(!/[–—]/.test(read(rel)), rel + ' has no em or en dash');
  }
});

test('A: only a GB company gets a 0 put back, and nobody gets a country code invented', () => {
  // A GB file: a bare ten digit UK number gets its 0 and then the app rule.
  for (const bare of ['7954412327', '1614960000']) {
    const r = normaliseRow({ rowNumber: 2, name: 'X', phone: bare }, OPTS);
    assert.deepEqual(r.problems, [], bare + ' is readable');
    assert.equal(r.phone, appPhone('0' + bare), 'a zero on the front, then the app rule and only the app rule');
    assert.equal(r.phoneAssumed, true);
  }
  // A US company, or one whose country we do not know: the cell goes through
  // the app rule UNCHANGED. 7xx is a US area code, not a UK mobile.
  for (const country of ['US', '']) {
    for (const bare of ['4155551234', '7185550123', '4405551234']) {
      const r = normaliseRow({ rowNumber: 2, name: 'Hank', phone: bare }, { today: OPTS.today, country });
      assert.deepEqual(r.problems, [], bare + ' is readable');
      assert.equal(r.phone, appPhone(bare), 'exactly what the till writes for that cell');
      assert.equal(r.phoneAssumed, false);
      assert.equal(r.phoneE164, null, 'no +44 key invented');
      assert.ok(!String(r.phone).startsWith('+447'), bare + ' is nobody\'s UK mobile');
    }
  }
  // A US number in a GB file is refused, not turned into a UK one.
  assert.ok(normaliseRow({ rowNumber: 2, name: 'Hank', phone: '4155551234' }, OPTS).problems.length > 0);
});
