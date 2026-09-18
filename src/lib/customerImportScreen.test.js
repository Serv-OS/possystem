// The Import customers screen: its rules, and the things about the screen file
// itself that must stay true.
//
// The rules that read the file are tested in customerImport.test.js. This one
// covers what the screen does with the answer: when the Import button may be
// pressed, what the preview table shows, what the confirm says, and what one
// plain line we put up when the writer is not deployed yet.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { readCsv, validateRows, summarise, TEMPLATE_COLUMNS } from './customerImport.js';
import {
  CHUNK_SIZE,
  PREVIEW_ROWS,
  MAX_ROWS,
  MAX_FILE_BYTES,
  TEMPLATE_FILE_NAME,
  count,
  importBlockReason,
  noProgrammeLine,
  confirmMessage,
  problemsByRow,
  skippedRowNumbers,
  previewRows,
  failedCsv,
  failedFileName,
  chunkRows,
  mergeResult,
  progressText,
  progressPercent,
  importErrorMessage,
  resultLine,
} from './customerImportScreen.js';

const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const PROGRAMMES = [{ id: 'prog-1', name: 'Coffee card', stamps_required: 9 }];

const READY_STATE = {
  fileRead: true,
  ready: 12,
  withStamps: 0,
  programmes: [],
  programId: '',
  consentGiven: true,
  busy: false,
};

// ── counting in words ───────────────────────────────────────────────────────

test('a number on the screen always says what it counts', () => {
  assert.equal(count(1, 'customer'), '1 customer');
  assert.equal(count(4, 'customer'), '4 customers');
  assert.equal(count(0, 'customer'), '0 customers');
  assert.equal(count(1, 'person', 'people'), '1 person');
  assert.equal(count(3, 'person', 'people'), '3 people');
  assert.equal(count(undefined, 'row'), '0 rows');
});

// ── when the Import button may be pressed ───────────────────────────────────

test('no file, no import', () => {
  assert.equal(importBlockReason({ ...READY_STATE, fileRead: false }), 'Pick a file first.');
  assert.equal(importBlockReason(null), 'Pick a file first.');
  assert.equal(importBlockReason(undefined), 'Pick a file first.');
});

test('a file with stamps and no stamp card keeps the Import button off', () => {
  const why = importBlockReason({ ...READY_STATE, withStamps: 412, programmes: [] });
  assert.ok(why, 'the button is off');
  assert.match(why, /stamp card/i);
  assert.match(why, /Loyalty/);
  assert.match(why, /412 people/, 'it says how many people are waiting');
});

test('one person with stamps is enough to need a stamp card', () => {
  const why = importBlockReason({ ...READY_STATE, withStamps: 1, programmes: [] });
  assert.ok(why);
  assert.match(why, /1 person have|1 person/);
});

test('stamp cards exist but none picked, still off', () => {
  const why = importBlockReason({ ...READY_STATE, withStamps: 5, programmes: PROGRAMMES, programId: '' });
  assert.equal(why, 'Pick which stamp card the stamps go on.');
});

test('stamps and a stamp card picked, the button comes on', () => {
  const why = importBlockReason({ ...READY_STATE, withStamps: 5, programmes: PROGRAMMES, programId: 'prog-1' });
  assert.equal(why, null);
});

test('a file with no stamps in it does not need a stamp card', () => {
  // Nobody's stamps can be lost by importing people who have none, so we do not
  // stop the whole job over a programme the file never uses.
  assert.equal(importBlockReason({ ...READY_STATE, withStamps: 0, programmes: [] }), null);
});

test('the tick box is the last thing standing between the file and the database', () => {
  const why = importBlockReason({ ...READY_STATE, consentGiven: false });
  assert.equal(why, 'Tick the box to say these people opted in.');
});

test('nothing usable in the file, nothing to press', () => {
  const why = importBlockReason({ ...READY_STATE, ready: 0 });
  assert.match(why, /Nothing in this file/);
});

test('while it runs, the button stays off', () => {
  assert.match(importBlockReason({ ...READY_STATE, busy: true }), /Importing/);
  // busy beats everything else, so a second press cannot start a second run
  assert.match(importBlockReason({ ...READY_STATE, busy: true, fileRead: false }), /Importing/);
});

test('a browser with no database behind it cannot import', () => {
  // Local dev runs in mock mode with no Supabase. The button must be off there,
  // not press and fail.
  assert.match(importBlockReason({ ...READY_STATE, demo: true }), /demo screen/);
});

test('a file that has gone in cannot be sent a second time', () => {
  // People are safe from a second press, stamps are not: a second run would add
  // the same stamps again. The button goes off the moment a run finishes.
  const why = importBlockReason({ ...READY_STATE, alreadyRan: true });
  assert.match(why, /has gone in/);
  assert.match(why, /Pick another file/);
});

test('the no stamp card line changes with what is in the file', () => {
  assert.match(noProgrammeLine(0), /no stamps in it/i);
  assert.match(noProgrammeLine(7), /7 people/);
  assert.match(noProgrammeLine(7), /Loyalty/);
});

// ── the confirm ─────────────────────────────────────────────────────────────

test('the confirm says the number and says it cannot be undone here', () => {
  const text = confirmMessage({ newCustomers: 412, alreadyKnown: 6, stampsTotal: 1204, rewardsTotal: 38 });
  assert.match(text, /412 new customers/);
  assert.match(text, /6 customers/);
  assert.match(text, /never overwrites/);
  assert.match(text, /1204 stamps/);
  assert.match(text, /38 free items/);
  assert.match(text, /cannot be undone from this screen/);
  assert.match(text, /Import now\?$/);
});

test('the confirm leaves out what is not happening', () => {
  const text = confirmMessage({ newCustomers: 1, alreadyKnown: 0, stampsTotal: 0, rewardsTotal: 0 });
  assert.match(text, /1 new customer\./);
  assert.ok(!/Stamps going on/.test(text), 'no stamp line when there are no stamps');
  assert.ok(!/fill in blanks/.test(text), 'no update line when nobody matches');
  assert.match(text, /cannot be undone/);
});

// ── the preview table ───────────────────────────────────────────────────────

const MESSY = [
  'first_name,last_name,phone,email,stamps,rewards_unused,marketing_opt_in',
  'Jane,Smith,07700 900123,jane@example.com,4,1,yes',
  'Bad,Phone,banana,bad@example.com,2,0,yes',
  'Jane,Twice,07700900123,jane2@example.com,1,0,no',
  'Ann,Jones,07700 900456,ann@example.com,0,0,',
].join('\n');

test('the preview is the file in file order, with the problems said in words', () => {
  const parsed = readCsv(MESSY);
  const checked = validateRows(parsed.rows);
  const rows = previewRows(checked, { raw: parsed.rows, existingKeys: ['+447700900456'] });

  assert.deepEqual(rows.map((r) => r.rowNumber), [2, 3, 4, 5], 'file order, header is line 1');
  assert.equal(rows[0].status, 'new');
  assert.equal(rows[0].name, 'Jane Smith');
  assert.equal(rows[0].phone, '+447700900123');
  assert.equal(rows[0].stamps, 4);

  assert.equal(rows[1].status, 'problem');
  assert.match(rows[1].note, /phone/i);
  assert.equal(rows[1].phone, 'banana', 'a problem row still shows what was typed');

  assert.equal(rows[2].status, 'problem', 'the same phone twice is a problem row');
  assert.match(rows[2].note, /row 2/i);

  assert.equal(rows[3].status, 'known', 'we already have Ann');
});

test('the preview stops at twenty rows', () => {
  const lines = ['first_name,phone'];
  for (let i = 0; i < 40; i++) lines.push('P' + i + ',+4477009001' + String(i).padStart(2, '0'));
  const parsed = readCsv(lines.join('\n'));
  const checked = validateRows(parsed.rows);
  assert.equal(previewRows(checked, { raw: parsed.rows }).length, PREVIEW_ROWS);
  assert.equal(previewRows(checked, { raw: parsed.rows, limit: 5 }).length, 5);
  assert.equal(previewRows(checked, { raw: parsed.rows, limit: 0 }).length, 40, 'limit 0 means all of them');
});

test('several problems on one row read as one line', () => {
  const csv = [
    'first_name,phone,stamps,birthday',
    'Bad,banana,-4,31/02/2020',
  ].join('\n');
  const checked = validateRows(readCsv(csv).rows);
  const byRow = problemsByRow(checked);
  assert.equal(byRow.size, 1);
  const text = byRow.get(2);
  assert.ok(text.length > 20, 'every problem on that row is in the one line');
  assert.deepEqual(skippedRowNumbers(checked), [2]);
});

test('the preview survives a file it has never seen', () => {
  assert.deepEqual(previewRows(null, {}), []);
  assert.deepEqual(previewRows({}, {}), []);
  assert.deepEqual(previewRows({ ready: [], errors: [], duplicatesInFile: [] }, { raw: null }), []);
  assert.equal(problemsByRow(null).size, 0);
});

// ── the file of rows to fix ─────────────────────────────────────────────────

test('the rows to fix come back as the same file plus a problem column', () => {
  const parsed = readCsv(MESSY);
  const checked = validateRows(parsed.rows);
  const byRow = problemsByRow(checked);
  const byNumber = new Map(parsed.rows.map((r) => [r.rowNumber, r]));
  const entries = Array.from(byRow.keys()).sort((a, b) => a - b)
    .map((n) => ({ row: byNumber.get(n), problem: byRow.get(n) }));

  const csv = failedCsv(entries);
  const lines = csv.trim().split('\r\n');
  assert.equal(lines[0], TEMPLATE_COLUMNS.join(',') + ',problem');
  assert.equal(lines.length, 3, 'the header and the two rows that did not go in');
  assert.ok(lines[1].includes('banana'), 'the cells come back as they were typed');
  assert.ok(lines[1].includes('phone') || lines[1].includes('Phone'));
  // it drops straight back into the screen: our own reader can read it again
  const again = readCsv(csv);
  assert.equal(again.found, true);
  assert.equal(again.rows.length, 2);
});

test('a formula in a cell cannot run when the file is reopened', () => {
  const csv = failedCsv([{ row: { name: '=cmd|/c calc', phone: '07700900123' }, problem: 'no' }]);
  assert.ok(csv.includes("'=cmd"), 'the leading = is neutralised, same rule as the customer export');
});

test('the rows to fix are named by the day', () => {
  assert.equal(failedFileName('2026-09-17T10:00:00.000Z'), 'customer-import-problems-2026-09-17.csv');
  assert.match(failedFileName(''), /^customer-import-problems-\d{4}-\d{2}-\d{2}\.csv$/);
  assert.match(failedFileName('nonsense'), /^customer-import-problems-\d{4}-\d{2}-\d{2}\.csv$/);
});

test('an empty list still writes a readable header', () => {
  const csv = failedCsv([]);
  assert.equal(csv.trim(), TEMPLATE_COLUMNS.join(',') + ',problem');
  assert.equal(failedCsv(null).trim(), TEMPLATE_COLUMNS.join(',') + ',problem');
});

// ── sending it ──────────────────────────────────────────────────────────────

test('rows go up in batches, and every row goes exactly once', () => {
  const rows = [];
  for (let i = 0; i < 450; i++) rows.push({ rowNumber: i + 2 });
  const chunks = chunkRows(rows, CHUNK_SIZE);
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].length, CHUNK_SIZE);
  assert.equal(chunks[2].length, 450 - CHUNK_SIZE * 2);
  const flat = chunks.flat();
  assert.equal(flat.length, 450);
  assert.equal(new Set(flat.map((r) => r.rowNumber)).size, 450);
});

test('batching never loops for ever on a silly size', () => {
  assert.equal(chunkRows([1, 2, 3], 0).length, 1);
  assert.equal(chunkRows([1, 2, 3], -5).length, 1);
  assert.deepEqual(chunkRows(null, 10), []);
  assert.deepEqual(chunkRows([], 10), []);
});

test('each batch adds to the running total', () => {
  let acc = { created: 0, updated: 0, skipped: 0, failed: [] };
  acc = mergeResult(acc, { created: 200, updated: 0, skipped: 0, failed: [], batch_id: 'b1' });
  acc = mergeResult(acc, { created: 190, updated: 6, skipped: 4, failed: [{ rowNumber: 44 }] });
  assert.equal(acc.created, 390);
  assert.equal(acc.updated, 6);
  assert.equal(acc.skipped, 4);
  assert.equal(acc.failed.length, 1);
  assert.equal(acc.batchId, 'b1', 'the batch id survives a later chunk that does not repeat it');
});

test('a batch that answers with nonsense does not poison the count', () => {
  const acc = mergeResult({ created: 5, failed: [] }, { created: 'lots', failed: 'none' });
  assert.equal(acc.created, 5);
  assert.deepEqual(acc.failed, []);
  assert.equal(mergeResult(null, null).created, 0);
});

test('progress reads as words and as a bar', () => {
  assert.equal(progressText(200, 412), 'Sent 200 of 412.');
  assert.equal(progressPercent(200, 400), 50);
  assert.equal(progressPercent(0, 0), 0, 'nothing to do is not a divide by zero');
  assert.equal(progressPercent(900, 400), 100, 'the bar never goes past the end');
  assert.equal(progressPercent(-5, 400), 0);
});

// ── when the writer is not there ────────────────────────────────────────────

test('a writer that is not deployed reads as nothing happened, not as an error', () => {
  const line = importErrorMessage(404, { message: 'Requested function was not found' });
  assert.match(line, /not live/i);
  assert.match(line, /Nothing has changed/);
  assert.ok(!/error|fail|404/i.test(line), 'no jargon and no status code on the screen');
});

test('the other stops all read as plain words', () => {
  assert.match(importErrorMessage(401, {}), /not allowed/i);
  assert.match(importErrorMessage(403, {}), /not allowed/i);
  assert.match(importErrorMessage(413, {}), /too much/i);
  assert.match(importErrorMessage(429, {}), /slow down/i);
  assert.match(importErrorMessage(500, {}), /Nothing more was sent/);
  assert.match(importErrorMessage(400, { error: 'org missing' }), /org missing/);
  assert.ok(importErrorMessage(0, null).length > 10);
});

test('the result line counts only what happened', () => {
  assert.equal(resultLine({ created: 412, updated: 0, skipped: 0, failed: [] }), '412 customers added.');
  const full = resultLine({ created: 1, updated: 2, skipped: 3, failed: [{}, {}] });
  assert.match(full, /1 customer added/);
  assert.match(full, /2 customers filled in/);
  assert.match(full, /3 rows skipped/);
  assert.match(full, /2 rows did not go in/);
  assert.equal(resultLine(null), '0 customers added.');
});

// ── a whole file, the way the screen does it ────────────────────────────────

test('a real file: read it, check it, count it, decide about the button', () => {
  const csv = [
    'Full Name,Mobile,Email Address,Stamps,Free Drinks,Opted In,Points',
    '"Smith, Jane",07700 900123,JANE@Example.com,4,1,yes,320',
    'Ann Jones,7700900456,ann@example.com,0,0,no,12',
    'No Phone,,,0,0,yes,0',
  ].join('\r\n');

  const parsed = readCsv(csv);
  assert.equal(parsed.found, true);
  assert.deepEqual(parsed.ignored, ['Points'], 'points are recognised and left out on purpose');

  const checked = validateRows(parsed.rows);
  const sum = summarise(checked, []);
  assert.equal(sum.ready, 2);
  assert.equal(sum.newCustomers, 2);
  assert.equal(sum.withStamps, 1);
  assert.equal(sum.problems, 1, 'the row with no phone and no email cannot go in');
  assert.equal(sum.phoneFixed, 1, 'the spreadsheet ate a leading zero and we put it back');
  assert.equal(sum.canEmail, 1);

  // stamps in the file and no stamp card at this company: the button stays off
  const blocked = importBlockReason({
    fileRead: true, ready: sum.ready, withStamps: sum.withStamps,
    programmes: [], programId: '', consentGiven: true, busy: false,
  });
  assert.ok(blocked, 'off');
  assert.match(blocked, /stamp card/i);

  // pick the card and it goes on
  const free = importBlockReason({
    fileRead: true, ready: sum.ready, withStamps: sum.withStamps,
    programmes: PROGRAMMES, programId: 'prog-1', consentGiven: true, busy: false,
  });
  assert.equal(free, null);
});

// ── the screen file itself ──────────────────────────────────────────────────

const SCREEN = '../backoffice/sections/CustomerImport.jsx';
const APP = '../backoffice/BackOfficeApp.jsx';

test('the screen reads the file with the shared rules, it never rolls its own', () => {
  const src = read(SCREEN);
  assert.match(src, /from '\.\.\/\.\.\/lib\/customerImport'/, 'the rules library is the reader');
  assert.ok(src.includes('readCsv') && src.includes('validateRows') && src.includes('summarise'),
    'reading, checking and counting all come from the rules library');
  assert.ok(!/\.split\(','\)/.test(src), 'no hand rolled CSV splitting, quoted commas would break it');
  assert.ok(!/replace\(\/\[\^\\d/.test(src), 'no second phone normaliser in the screen');
  assert.ok(!/startsWith\('07'\)|\+44/.test(src), 'the screen knows nothing about phone shapes');
});

test('the Download template button uses the template from the rules library', () => {
  const src = read(SCREEN);
  assert.ok(src.includes('templateCsv('), 'the template comes from the rules library');
  assert.ok(src.includes('new Blob('), 'the file is built in the browser');
  assert.ok(src.includes('Download template'), 'the button says what it does');
  assert.ok(src.includes(TEMPLATE_FILE_NAME) || src.includes('TEMPLATE_FILE_NAME'));
});

test('the Import button is off unless importBlockReason says it may be pressed', () => {
  const src = read(SCREEN);
  assert.ok(src.includes('importBlockReason('), 'the screen asks the rule');
  assert.match(src, /disabled=\{!!blockReason\}/, 'the button is disabled straight from that answer');
  assert.ok(src.includes('window.confirm(confirmMessage('), 'a confirm with the numbers comes first');
});

test('nothing is written before the operator presses Import', () => {
  const src = read(SCREEN);
  const body = src.slice(src.indexOf('export default function'));
  assert.ok(!/\.insert\(|\.upsert\(|\.update\(|\.delete\(/.test(body),
    'the screen never writes to a table itself, the edge function does the writing');
  const pick = body.slice(body.indexOf('const pickFile'), body.indexOf('const summary'));
  assert.ok(!pick.includes('fetch('), 'picking a file sends nothing anywhere');
});

test('the rows posted are the raw cells, so the server reads them again itself', () => {
  const src = read(SCREEN);
  assert.ok(src.includes('byNumber.get(checked.ready[i].rowNumber)'),
    'we send what was in the file, not our reading of it');
  assert.ok(src.includes('rows: chunks[i]'));
  assert.ok(src.includes('chunkRows(toSend, CHUNK_SIZE)'), 'it goes up in batches so progress is real');
});

test('a run that stops half way carries on instead of starting over', () => {
  // Half a file in and the connection drops. Starting again would send the
  // first half twice, and a second set of stamps is real money.
  const src = read(SCREEN);
  assert.ok(src.includes('const key = batchKey || newBatchKey();'), 'one batch key per file, kept across attempts');
  assert.ok(src.includes('const startAt = Math.min(doneBatches, chunks.length);'), 'it picks up where it stopped');
  assert.ok(src.includes('setDoneBatches(i + 1);'), 'progress is remembered batch by batch');
  assert.ok(src.includes('alreadyRan: finished'), 'only a finished run turns the button off for good');
  assert.ok(src.includes('Carry on importing'), 'the button says what it will do');
});

test('the screen still works when the writer is not deployed and when a load fails', () => {
  const src = read(SCREEN);
  assert.ok(src.includes('importErrorMessage('), 'a stop turns into one plain line');
  assert.ok(src.includes('catch'), 'every load is wrapped');
  assert.ok(src.includes('setLoadNote('), 'a failed load leaves a line, not a crash');
  assert.ok(src.includes('You can still get the template'), 'the template works even then');
  assert.ok(!/await import\(|import\(/.test(src.replace(/^import .*$/gm, '')),
    'no dynamic import, they fail silently in the production bundle');
});

test('the screen is registered in Back Office the way the others are', () => {
  const src = read(APP);
  assert.ok(src.includes("import CustomerImport from './sections/CustomerImport';"), 'imported');
  assert.match(src, /\{ id:'customer-import', label:'Import customers'/, 'in NAV');
  assert.ok(src.includes("['customer-import','Import customers']"), 'in the Customers group of the sidebar');
  assert.ok(src.includes("{section === 'customer-import' && <CustomerImport setSection={setSection} />}"), 'rendered');
  const ia = src.slice(src.indexOf("{ label:'Customers',"), src.indexOf("{ label:'Channels',"));
  assert.ok(ia.includes("['customer-import','Import customers']"), 'it sits in the Customers group, not somewhere else');
});

test('the screen and its rules are written in plain words with no dashes', () => {
  // House rule: never an em dash or an en dash, in code or on screen.
  for (const rel of [SCREEN, './customerImportScreen.js']) {
    const src = read(rel);
    assert.ok(!/[–—]/.test(src), rel + ' has no em or en dash');
  }
});

test('the caps are sane numbers, not magic ones', () => {
  assert.equal(CHUNK_SIZE, 200);
  assert.equal(PREVIEW_ROWS, 20);
  assert.ok(MAX_ROWS >= 10000);
  assert.ok(MAX_FILE_BYTES >= 1024 * 1024);
  assert.equal(TEMPLATE_FILE_NAME, 'customer-import-template.csv');
});
