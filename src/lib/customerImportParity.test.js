// src/lib/customerImportParity.test.js
//
// The import rules exist TWICE:
//   src/lib/customerImport.js                    the admin portal screen
//   supabase/functions/_shared/customerImport.ts the edge function that writes
//
// They have to live twice because an edge function is deployed on its own, and
// sometimes by pasting the files under supabase/functions into the Supabase
// dashboard editor, so it cannot import out of src/. The danger here is worse
// than a wrong ticket: the screen shows the operator 412 people and 3 problems,
// the function writes something else, and the difference is somebody's phone
// number, which is their loyalty login and the key every till searches by.
//
// So this file is the join. It runs ONE case table through BOTH modules and
// compares every output, and it compares the rule tables field by field. Edit
// one file without the other and this goes red.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import * as js from './customerImport.js';
import * as ts from '../../supabase/functions/_shared/customerImport.ts';

// The day is pinned, so a clock read creeping into either file shows up here.
const OPTS = { today: '2026-09-17', country: 'GB' };
// Every rule that depends on the company's country runs under all of these.
const COUNTRIES = [{ country: 'GB' }, { country: 'US' }, {}, { country: 'IE' }, null];

// ── the shared case table ───────────────────────────────────────────────────

const PHONES = [
  '07700900123', '07700 900123', '  07700 900 123  ', '(07700) 900-123',
  '+44 7700 900123', '+447700900123', '447700900123', '00447700900123',
  '+44 (0)7700 900123', '0113 496 0123', '7700900123', '113 496 0123',
  '+353 86 123 4567', '+1 415 555 0123', '0044 7700 900123',
  '07700', '123', '', '   ', 'n/a', 'N/A', 'none', '-', 'ask at till',
  '07700 90012A', '999999999999999999', '+44 7700 9001234', '++4477', '07700-900-123',
  '07700.900.123', '0770090012', '077009001234', null, undefined, 447700900123, 0,
  '7954412324', '7.954412324E9', '7.95441E+09', '7954412324.0', "'07954 412324", '4405551234',
  '7001234567', '(773) 555-0188', '+44 (0)161 496 0000', '440161', '1614960000', '2125550199',
];

const EMAILS = [
  'jane@example.com', ' Jane@Example.COM ', 'Jane Smith <Jane@Example.com>',
  'jane+loyalty@example.co.uk', 'not an email', 'jane@example', 'jane@@example.com',
  '', '   ', 'n/a', 'none', null, undefined, 42, 'JANE@EXAMPLE.COM',
];

const NUMBERS = ['0', '4', '4.0', '4.5', '-1', '-0', ' 1,200 ', 'four', '', '   ', 'n/a', '600', '99999', null, undefined, 3, 3.5, -2];

const YES_NOS = ['yes', 'YES', 'y', 'true', 'T', '1', 'on', 'Subscribed', 'opted in', 'signed up',
  'no', 'N', 'false', '0', 'Unsubscribed', 'opted out', 'declined', 'maybe', 'perhaps', '', '  ', 'n/a', null, undefined, 1, 0, true, false];

const DATES = [
  '2025-04-12', '2025-04-12T09:30:00Z', '2025/04/12', '12/04/2025', '3/4/2025',
  '12-04-2025', '12.04.2025', '12 Apr 2025', '12 April 2025', 'Apr 12, 2025',
  'April 12 2025', '12/04/25', '12/04/65', '04/25/2025', '31/02/2025', '29/02/2024',
  '29/02/2025', '2027-01-01', '2026-09-17', '2026-09-18', '1850-01-01', 'last Tuesday',
  '', '  ', 'n/a', null, undefined, 20250412,
];

const HEADERS = [
  'name', 'Full Name', 'first_name', 'First Name', 'FIRST-NAME', 'Surname',
  'Mobile', ' Mobile Number ', 'Phone', 'Telephone', 'Email', 'E-mail Address',
  'Stamps', 'Free Drinks', 'Opted In', 'Consent', 'Opt In Date', 'Date of Birth',
  'Points', 'Loyalty Points', 'Total Spend', 'Postcode', 'Shoe size', 'Notes',
  'external id', 'Member Number', '', '   ', null, undefined, 42,
];

const HEADER_ROWS = [
  ['Full Name', 'Mobile', 'Email Address', 'Stamps', 'Free Drinks', 'Opted In', 'Points', 'Shoe size'],
  ['Email', 'Mobile', 'Phone', 'First Name'],
  ['nothing', 'we', 'know'],
  [],
  null,
  'not an array',
  [null, undefined, '', 'Phone'],
];

const FILES = [
  '',
  'name,phone\nJane,07700 900123',
  '\uFEFFname,phone\r\nJane,07700 900123\r\n',
  'Full Name,Mobile,Email Address,Stamps,Free Drinks,Opted In,Opt In Date,Points\n'
    + '"Smith, Jane",07700 900123,Jane@Example.com,4,1,yes,12/04/2025,240\n'
    + 'Bob Jones,  07700 900124  ,bob@example.com,0,0,no,,10\n'
    + ',07700 900125,,2,0,yes,2025-01-05,0\n'
    + 'Dave Duplicate,07700900123,dave@example.com,9,0,yes,,0\n'
    + 'Ella Early,07700 900126,ella@example.com,3,0,yes,31/02/2025,0\n'
    + 'Frank Minus,07700 900127,frank@example.com,-3,0,yes,,0\n'
    + 'Gina Ghost,,gina@example.com,1,0,yes,,0\n'
    + 'Harry Half,07700,harry@example.com,0,0,yes,,0\n'
    + ',7700900128,ivy@example.com,0,0,yes,,0\n'
    + 'Jack Same,07700 900129,jane@example.com,0,0,yes,,0\n'
    + '\n'
    + 'Kate Maybe,07700 900130,kate@example.com,0,0,maybe,,0\n',
  'notes\n"line one\nline two"\n"she said ""two sugars"""',
  'a,b\n\n1,2\n , \n,,\n3,4\n\n',
  'Jane,07700 900123\nBob,07700 900124',
  '"never closed',
  'name,name,phone\nJane,Janet,07700 900123',
];

const RAW_ROWS = [
  { rowNumber: 2, name: 'Jane Smith', phone: '07700 900123', email: 'Jane@Example.com', stamps: '4', rewards_unused: '1', marketing_opt_in: 'yes', opt_in_date: '12/04/2025', opt_in_source: 'Old app', signed_up_date: '2024-11-03', birthday: '24/06/1990', external_id: 'CB-1', notes: 'oat milk' },
  { rowNumber: 3, first_name: 'Bob', last_name: 'Jones', phone: '7700900124' },
  { rowNumber: 4, email: 'only@example.com' },
  { rowNumber: 5, name: '', phone: '', email: '' },
  { rowNumber: 6, name: 'Bad Phone', phone: '07700', email: 'bad@example.com' },
  { rowNumber: 7, name: 'Bad Email', phone: '07700 900127', email: 'nope' },
  { rowNumber: 8, name: 'Bad Both', phone: 'ring the shop', email: 'nope' },
  { rowNumber: 9, name: 'Minus', phone: '07700 900129', stamps: '-3' },
  { rowNumber: 10, name: 'Too Many', phone: '07700 900130', stamps: '900' },
  { rowNumber: 11, name: 'Maybe', phone: '07700 900131', marketing_opt_in: 'maybe' },
  { rowNumber: 12, name: 'Future', phone: '07700 900132', opt_in_date: '2027-01-01' },
  { rowNumber: 13, name: 'Old', phone: '07700 900133', birthday: '1850-01-01' },
  { rowNumber: 14, name: 'Month First', phone: '07700 900134', opt_in_date: '04/25/2025' },
  { rowNumber: 15, external_id: 'CB-2', phone: '07700 900135' },
  { rowNumber: 16 },
  {},
  null,
  undefined,
  'not a row',
  42,
];

const VERDICTS = [
  null,
  undefined,
  [],
  [{ row_number: 2, verdict: 'update', customer_id: 'c1' }, { row_number: 3, verdict: 'blocked', reason: 'no' }],
  [{ rowNumber: 2, verdict: 'new' }, { row_number: 4, verdict: 'new' }, null, 'junk', { verdict: 'new' }],
  new Map([[2, { verdict: 'update', reason: '', customerId: 'c1' }]]),
  'rubbish',
];

// ── the exports themselves ──────────────────────────────────────────────────

test('both modules export exactly the same names', () => {
  // Interfaces and type aliases leave nothing behind at runtime, so the two
  // runtime export lists must be identical.
  assert.deepEqual(Object.keys(ts).sort(), Object.keys(js).sort());
});

test('the rule tables are identical', () => {
  assert.deepEqual([...ts.TEMPLATE_COLUMNS], [...js.TEMPLATE_COLUMNS]);
  assert.deepEqual({ ...ts.TEMPLATE_EXAMPLE }, { ...js.TEMPLATE_EXAMPLE });
  assert.deepEqual({ ...ts.HEADER_ALIASES }, { ...js.HEADER_ALIASES });
  assert.deepEqual([...ts.IGNORED_HEADERS], [...js.IGNORED_HEADERS]);
  assert.equal(ts.MAX_STAMPS, js.MAX_STAMPS);
  assert.equal(ts.MAX_REWARDS, js.MAX_REWARDS);
  assert.equal(ts.EARLIEST_BIRTH_YEAR, js.EARLIEST_BIRTH_YEAR);
});

// ── behaviour, function by function ─────────────────────────────────────────

test('parseCsv reads every file the same way', () => {
  for (const f of FILES) assert.deepEqual(ts.parseCsv(f), js.parseCsv(f), 'parseCsv: ' + String(f).slice(0, 30));
  for (const junk of [null, undefined, 42, {}, []]) assert.deepEqual(ts.parseCsv(junk), js.parseCsv(junk));
});

test('the template file is byte for byte the same', () => {
  assert.equal(ts.templateCsv(), js.templateCsv());
  assert.equal(ts.templateCsv({ bom: true }), js.templateCsv({ bom: true }));
  assert.equal(ts.templateCsv(null), js.templateCsv(null));
});

test('csvEscape and toCsv agree', () => {
  const cells = ['plain', '=1+1', '+44', '-5', '@sum', 'Smith, Jane', 'say "hi"', 'line\nbreak', '\tstart', '', null, undefined, 42];
  for (const c of cells) assert.equal(ts.csvEscape(c), js.csvEscape(c), 'csvEscape: ' + String(c));
  assert.equal(ts.toCsv([cells, ['a', 'b']]), js.toCsv([cells, ['a', 'b']]));
  assert.equal(ts.toCsv(null), js.toCsv(null));
  assert.equal(ts.toCsv(['flat']), js.toCsv(['flat']));
});

test('headers are resolved the same, column by column', () => {
  for (const h of HEADERS) {
    assert.equal(ts.normaliseHeader(h), js.normaliseHeader(h), 'normaliseHeader: ' + String(h));
    assert.equal(ts.canonicalHeader(h), js.canonicalHeader(h), 'canonicalHeader: ' + String(h));
    assert.equal(ts.isIgnoredHeader(h), js.isIgnoredHeader(h), 'isIgnoredHeader: ' + String(h));
  }
  for (const row of HEADER_ROWS) assert.deepEqual(ts.mapHeaders(row), js.mapHeaders(row));
});

test('readCsv returns the identical rows and the identical column report', () => {
  for (const f of FILES) assert.deepEqual(ts.readCsv(f), js.readCsv(f), 'readCsv: ' + String(f).slice(0, 30));
  assert.deepEqual(ts.readCsv(js.templateCsv()), js.readCsv(ts.templateCsv()));
});

test('every phone reads the same, including the ones we refuse', () => {
  let compared = 0;
  for (const p of PHONES) {
    for (const c of COUNTRIES) {
      assert.deepEqual(ts.readPhone(p, c), js.readPhone(p, c), 'readPhone: ' + String(p) + ' ' + JSON.stringify(c));
      assert.equal(ts.writtenPhone(p, c), js.writtenPhone(p, c), 'writtenPhone: ' + String(p));
      assert.deepEqual(ts.phoneKeys(p, c), js.phoneKeys(p, c), 'phoneKeys: ' + String(p));
    }
    assert.deepEqual(ts.rawPhoneKeys(p), js.rawPhoneKeys(p), 'rawPhoneKeys: ' + String(p));
    assert.equal(ts.appPhone(p), js.appPhone(p), 'appPhone: ' + String(p));
    compared++;
  }
  assert.ok(compared >= 30, 'the case table should be big enough to mean something');
});

test('emails, counts and yes or no all agree', () => {
  for (const e of EMAILS) assert.deepEqual(ts.normaliseEmail(e), js.normaliseEmail(e), 'normaliseEmail: ' + String(e));
  for (const n of NUMBERS) {
    assert.deepEqual(ts.readWholeNumber(n), js.readWholeNumber(n), 'readWholeNumber: ' + String(n));
    assert.deepEqual(ts.readWholeNumber(n, ts.MAX_STAMPS, 'Stamps'), js.readWholeNumber(n, js.MAX_STAMPS, 'Stamps'));
    assert.deepEqual(ts.readWholeNumber(n, ts.MAX_REWARDS, 'Rewards'), js.readWholeNumber(n, js.MAX_REWARDS, 'Rewards'));
  }
  for (const v of YES_NOS) assert.deepEqual(ts.readYesNo(v), js.readYesNo(v), 'readYesNo: ' + String(v));
});

test('the country is read the same', () => {
  for (const v of ['GB', 'uk', 'United Kingdom', 'US', 'usa', 'IE', 'Narnia', '', null, undefined, 42]) {
    assert.equal(ts.normaliseCountry(v), js.normaliseCountry(v));
    assert.equal(ts.countryLabel(v), js.countryLabel(v));
  }
  for (const venue of [{ country: 'GB' }, { currency: 'GBP' }, { currency: 'USD' }, { currency: 'EUR' }, { country: 'uk', currency: 'USD' }, null, {},
    { platformCurrency: 'USD', opsCurrency: 'GBP' }, { platformCountry: 'US', opsCurrency: 'GBP' }, { opsCurrency: 'GBP' },
    { platformCurrency: 'EUR', opsCurrency: 'GBP' }, { country: 'GB', platformCurrency: 'USD' }]) {
    assert.deepEqual(ts.countryFromVenue(venue), js.countryFromVenue(venue));
  }
  for (const t of ['a,b;c', 'a;b;c', 'a\tb\tc', '"a;b",c', '', null]) assert.equal(ts.detectDelimiter(t), js.detectDelimiter(t));
});

test('every date reads the same, on the same day, in every country', () => {
  for (const d of DATES) {
    for (const c of COUNTRIES) {
      const o = { today: OPTS.today, ...(c || {}) };
      assert.deepEqual(ts.readDate(d, o), js.readDate(d, o), 'readDate: ' + String(d) + ' ' + JSON.stringify(c));
    }
    assert.deepEqual(ts.readDate(d, OPTS), js.readDate(d, OPTS), 'readDate: ' + String(d));
    assert.deepEqual(
      ts.readDate(d, { today: OPTS.today, earliestYear: ts.EARLIEST_BIRTH_YEAR }),
      js.readDate(d, { today: OPTS.today, earliestYear: js.EARLIEST_BIRTH_YEAR }),
      'readDate birthday: ' + String(d),
    );
    assert.deepEqual(ts.readDate(d, { today: new Date('2026-09-17T12:00:00Z') }), js.readDate(d, { today: new Date('2026-09-17T12:00:00Z') }));
  }
});

test('normaliseRow builds the identical row, problems and warnings alike', () => {
  for (const r of RAW_ROWS) {
    assert.deepEqual(ts.normaliseRow(r, OPTS), js.normaliseRow(r, OPTS), 'normaliseRow: ' + JSON.stringify(r));
  }
  // and with no options at all, where both fall back to the machine clock
  for (const r of RAW_ROWS) {
    const a = ts.normaliseRow(r);
    const b = js.normaliseRow(r);
    assert.deepEqual(a, b);
  }
});

test('validateRows sorts every file the same way', () => {
  for (const f of FILES) {
    const rows = js.readCsv(f).rows;
    assert.deepEqual(ts.validateRows(rows, OPTS), js.validateRows(rows, OPTS), 'validateRows: ' + String(f).slice(0, 30));
  }
  assert.deepEqual(ts.validateRows(RAW_ROWS, OPTS), js.validateRows(RAW_ROWS, OPTS));
  assert.deepEqual(ts.validateRows(null, OPTS), js.validateRows(null, OPTS));
  // running it on its own ready rows must not diverge either
  const once = js.validateRows(RAW_ROWS, OPTS);
  assert.deepEqual(ts.validateRows(once.ready, OPTS), js.validateRows(once.ready, OPTS));
});

test('verdictsByRow reads every shape the same', () => {
  for (const v of VERDICTS) {
    const a = ts.verdictsByRow(v);
    const b = js.verdictsByRow(v);
    assert.deepEqual(a ? Array.from(a.entries()) : a, b ? Array.from(b.entries()) : b);
  }
});

test('rowsToSend sends the same cells', () => {
  for (const f of FILES) {
    const rows = js.readCsv(f).rows;
    assert.deepEqual(ts.rowsToSend(rows, ts.validateRows(rows, OPTS)), js.rowsToSend(rows, js.validateRows(rows, OPTS)));
  }
});

test('summarise counts the same, against every shape of what we already have', () => {
  for (const f of FILES) {
    const rows = js.readCsv(f).rows;
    for (const v of VERDICTS) {
      assert.deepEqual(ts.summarise(rows, v, OPTS), js.summarise(rows, v, OPTS), 'summarise: ' + String(f).slice(0, 20));
    }
    for (const c of COUNTRIES) {
      const o = { today: OPTS.today, ...(c || {}) };
      assert.deepEqual(ts.validateRows(rows, o), js.validateRows(rows, o), 'validateRows by country');
    }
  }
  const checked = js.validateRows(RAW_ROWS, OPTS);
  assert.deepEqual(ts.summarise(checked, null, OPTS), js.summarise(checked, null, OPTS));
  assert.deepEqual(ts.summarise(RAW_ROWS, null, OPTS), js.summarise(RAW_ROWS, null, OPTS));
  assert.deepEqual(ts.summarise([], null, OPTS), js.summarise([], null, OPTS));
  assert.deepEqual(ts.summarise(null, null, OPTS), js.summarise(null, null, OPTS));
});

test('one module can finish what the other started', () => {
  // The screen checks the file and the edge function checks it again. Whichever
  // way round the two halves run, the answer has to be the same.
  const text = FILES[3];
  const mixedOne = ts.summarise(js.validateRows(js.readCsv(text).rows, OPTS), null, OPTS);
  const mixedTwo = js.summarise(ts.validateRows(ts.readCsv(text).rows, OPTS), null, OPTS);
  assert.deepEqual(mixedOne, mixedTwo);
  assert.deepEqual(mixedOne, js.summarise(js.readCsv(text).rows, null, OPTS));
});

// ── the app's own phone rule, the three live copies ─────────────────────────

/**
 * The body of one live copy of the till's phone rule, as a function. Read from
 * the file itself, so a change to any of the three shows up here.
 */
function liveRule(rel, start) {
  const src = fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
  const at = src.indexOf(start);
  assert.ok(at >= 0, 'found the rule in ' + rel);
  const open = src.indexOf('{', at);
  let depth = 0;
  let end = open;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  return new Function('raw', src.slice(open + 1, end));
}

test('A: appPhone IS the till, the kiosk and the loyalty login, cell for cell', () => {
  // The invariant is shape parity: customers.phone is looked up with .eq(), so
  // what we write must be exactly what these three produce for the same cell.
  const copies = [
    liveRule('./customerLookup.js', 'export function normalisePhone(raw)'),
    liveRule('../store/index.js', '_normalisePhone: (raw) =>'),
    liveRule('../../supabase/functions/loyalty-otp/index.ts', 'function normalisePhone(raw: string): string | null'),
  ];
  const cells = PHONES.concat(['7700900123', '447700900123', '4405551234', '+14155551234', '07700900123', '0161 496 0000']);
  for (const cell of cells) {
    for (const rule of copies) {
      assert.equal(js.appPhone(cell), rule(cell), 'appPhone disagrees with a live copy for ' + String(cell));
      assert.equal(ts.appPhone(cell), rule(cell));
    }
  }
});

test('A: for a cell with nothing to repair, what we write is what the till writes', () => {
  const till = liveRule('./customerLookup.js', 'export function normalisePhone(raw)');
  for (const cell of ['07954 412324', '0161 496 0000', '447954412324', '+44 7954 412324', '+1 415 555 1234', '+353 86 123 4567']) {
    assert.equal(js.writtenPhone(cell, { country: 'GB' }), till(cell), cell);
  }
  for (const cell of ['4155551234', '7001234567', '4405551234', '07954 412324', '+1 415 555 1234']) {
    for (const c of [{ country: 'US' }, {}]) assert.equal(js.writtenPhone(cell, c), till(cell), cell + ' ' + JSON.stringify(c));
  }
});
