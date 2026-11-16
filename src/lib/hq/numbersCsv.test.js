/**
 * numbersCsv.test.js: pasted daily numbers.
 * Run: `node --test src/lib/hq/numbersCsv.test.js`.
 *
 * Pinned:
 *   1. The Mozz column set pastes straight in; labor and labour both work; tabs count as commas.
 *   2. A store that is not one of the sites, or a date that cannot be read, refuses the WHOLE paste.
 *   3. Blank cells are null (not 0). Money signs, commas and % are stripped.
 *   4. A site named twice on one day is refused.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNumbersCsv, parseCsvDate, splitCsvLine, CSV_TEMPLATE } from './numbersCsv.js';

const SITES = [{ id: 'p', name: 'Provo', code: 'PRV' }, { id: 'm', name: 'Milk Block', code: 'MLK' }];

test('the template parses to one row with every field', () => {
  const { rows, errors } = parseNumbersCsv(CSV_TEMPLATE, SITES);
  assert.deepEqual(errors, []);
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.location_id, 'p');
  assert.equal(r.business_date, '2026-11-16');
  assert.equal(r.net_sales, 5230);
  assert.equal(r.cogs, 1510);
  assert.equal(r.labour, 1560);
  assert.equal(r.projected_lunch, 1720);
  assert.equal(r.cash_on_hand, 18400);
  assert.equal(r.reviews_count, 7);
  assert.equal(r.review_rating, 4.6);
  assert.equal(r.turnover_pct, 42);
  assert.equal(r.morale_score, 8.1);
  assert.equal(r.hires_needed, 2);
  assert.equal(r.notes, null);
  assert.equal(r.source, 'csv');
});

test('aliases, tabs, money signs, US dates and blanks', () => {
  const text = 'Site\tDate\tSales\tLabour\tCash\tRating\n' +
    'milk block\t11/16/2026\t$6,400.50\t\t"$15,947"\t4.47\n';
  const { rows, errors, ignoredColumns } = parseNumbersCsv(text, SITES);
  assert.deepEqual(errors, []);
  assert.deepEqual(ignoredColumns, []);
  assert.equal(rows[0].location_id, 'm');
  assert.equal(rows[0].business_date, '2026-11-16');
  assert.equal(rows[0].net_sales, 6400.5);
  assert.equal(rows[0].labour, null);
  assert.equal(rows[0].cash_on_hand, 15947);
  assert.equal(rows[0].review_rating, 4.47);
  assert.equal('cogs' in rows[0], false);
});

test('an unknown store refuses the whole paste and names the line', () => {
  const text = 'store,date,net_sales\nProvo,2026-11-16,100\nOgden,2026-11-16,100\n';
  const { rows, errors } = parseNumbersCsv(text, SITES);
  assert.deepEqual(rows, []);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /line 3: store "Ogden"/);
});

test('a bad date, a bad number, a rating out of range, a duplicate', () => {
  const text = 'store,date,net_sales,review_rating\nProvo,16th Nov,100,4\nProvo,2026-11-16,abc,4\nProvo,2026-11-17,100,7\nProvo,2026-11-18,100,4\nProvo,2026-11-18,200,4\n';
  const { rows, errors } = parseNumbersCsv(text, SITES);
  assert.deepEqual(rows, []);
  assert.equal(errors.length, 4);
  assert.match(errors[0], /line 2: date/);
  assert.match(errors[1], /line 3: net_sales "abc"/);
  assert.match(errors[2], /line 4: review_rating 7 is outside 0 to 5/);
  assert.match(errors[3], /line 6: Provo on 2026-11-18 appears twice/);
});

test('header without store or date, and an empty paste', () => {
  assert.match(parseNumbersCsv('date,net_sales\n2026-11-16,1', SITES).errors[0], /store column/);
  assert.match(parseNumbersCsv('store,net_sales\nProvo,1', SITES).errors[0], /date column/);
  assert.match(parseNumbersCsv('', SITES).errors[0], /Nothing to import/);
  assert.match(parseNumbersCsv('store,date\n', SITES).errors[0], /No rows/);
});

test('unknown columns are ignored and named back', () => {
  const { rows, errors, ignoredColumns } = parseNumbersCsv('store,date,weather,cogs\nProvo,2026-11-16,rain,10', SITES);
  assert.deepEqual(errors, []);
  assert.deepEqual(ignoredColumns, ['weather']);
  assert.equal(rows[0].cogs, 10);
});

test('parseCsvDate and splitCsvLine', () => {
  assert.equal(parseCsvDate('2026-2-3'), '2026-02-03');
  assert.equal(parseCsvDate('11/16/2026'), '2026-11-16');
  assert.equal(parseCsvDate('16/11/2026'), '2026-11-16');
  assert.equal(parseCsvDate('2026-13-01'), null);
  assert.equal(parseCsvDate('2026-02-30'), null);
  assert.deepEqual(splitCsvLine('a,"b, c","d ""e""",f'), ['a', 'b, c', 'd "e"', 'f']);
});
