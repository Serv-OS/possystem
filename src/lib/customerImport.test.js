// src/lib/customerImport.test.js
//
// The rules that read another system's customer file. Every case here is one we
// expect to meet in the Coffee Boy import: a file exported from a marketing
// system, opened in Excel once, and sent on.
//
// The two that cost money if they break:
//   * a phone we cannot read must be an ERROR, never a guess. The phone is the
//     customer's loyalty login and the key every till looks them up by.
//   * the same person twice in one file must be written ONCE. (org_id, phone)
//     and (org_id, lower(email)) are unique indexes.
//   * the phone we write is what the till would write for the same cell (shape
//     parity), and only a GB company gets a lost 0 put back.
//   * a file a spreadsheet mangled still reads, or says why it cannot.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TEMPLATE_COLUMNS,
  TEMPLATE_EXAMPLE,
  MAX_STAMPS,
  detectDelimiter,
  parseCsv,
  templateCsv,
  csvEscape,
  toCsv,
  canonicalHeader,
  isIgnoredHeader,
  mapHeaders,
  readCsv,
  normaliseCountry,
  countryFromVenue,
  readPhone,
  appPhone,
  phoneKeys,
  rawPhoneKeys,
  writtenPhone,
  normaliseEmail,
  readWholeNumber,
  readYesNo,
  readDate,
  normaliseRow,
  rawRowsOnly,
  validateRows,
  rowsToSend,
  verdictsByRow,
  summarise,
} from './customerImport.js';

// Every test pins the day, so nothing here goes red next April. The country is
// the COMPANY's (see countryFromVenue): Coffee Boy is GB.
const OPTS = { today: '2026-09-17', country: 'GB' };
const GB_OPTS = OPTS;
const GB = { country: 'GB' };
const US = { country: 'US' };
const NONE = {};

const row = (extra) => Object.assign({
  rowNumber: 2, name: '', first_name: '', last_name: '', phone: '', email: '',
  stamps: '', rewards_unused: '', marketing_opt_in: '', opt_in_date: '',
  opt_in_source: '', signed_up_date: '', birthday: '', external_id: '', notes: '',
}, extra);

// ── parseCsv ────────────────────────────────────────────────────────────────

test('parseCsv reads plain rows', () => {
  assert.deepEqual(parseCsv('a,b,c\n1,2,3'), [['a', 'b', 'c'], ['1', '2', '3']]);
});

test('parseCsv keeps a comma inside quotes', () => {
  assert.deepEqual(parseCsv('name,notes\n"Smith, Jane","Likes oat milk, no sugar"'), [
    ['name', 'notes'],
    ['Smith, Jane', 'Likes oat milk, no sugar'],
  ]);
});

test('parseCsv reads a quote inside a quoted field', () => {
  assert.deepEqual(parseCsv('notes\n"She said ""two sugars"" every time"'), [
    ['notes'],
    ['She said "two sugars" every time'],
  ]);
});

test('parseCsv handles CRLF, lone CR and a UTF-8 BOM', () => {
  assert.deepEqual(parseCsv('\uFEFFa,b\r\n1,2\r\n'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(parseCsv('a,b\r1,2'), [['a', 'b'], ['1', '2']]);
  assert.equal(parseCsv('\uFEFFname\nJane')[0][0], 'name');
});

test('parseCsv keeps a newline inside a quoted field', () => {
  assert.deepEqual(parseCsv('notes\n"line one\nline two"'), [['notes'], ['line one\nline two']]);
});

test('parseCsv drops blank lines, including the empty rows Excel leaves behind', () => {
  assert.deepEqual(parseCsv('a,b\n\n1,2\n , \n,,\n3,4\n\n'), [['a', 'b'], ['1', '2'], ['3', '4']]);
});

test('parseCsv never throws on rubbish', () => {
  assert.deepEqual(parseCsv(''), []);
  assert.deepEqual(parseCsv(null), []);
  assert.deepEqual(parseCsv(undefined), []);
  assert.deepEqual(parseCsv(42), []);
  assert.deepEqual(parseCsv('"never closed'), [['never closed']]);
});

test('parseCsv keeps empty cells in a row that has any content', () => {
  assert.deepEqual(parseCsv('a,b,c\n1,,3'), [['a', 'b', 'c'], ['1', '', '3']]);
});

// ── the template ────────────────────────────────────────────────────────────

test('the template columns are the agreed list, in order', () => {
  assert.deepEqual(TEMPLATE_COLUMNS, [
    'name', 'first_name', 'last_name', 'phone', 'email',
    'stamps', 'rewards_unused', 'marketing_opt_in', 'opt_in_date',
    'opt_in_source', 'signed_up_date', 'birthday', 'external_id', 'notes',
  ]);
});

test('templateCsv is a header row and ONE example row, and nothing else', () => {
  const rows = parseCsv(templateCsv());
  assert.equal(rows.length, 2, 'no second header line: a spreadsheet would read it as a person');
  assert.deepEqual(rows[0], TEMPLATE_COLUMNS);
  assert.equal(rows[1].length, TEMPLATE_COLUMNS.length);
});

test('the template example is a row we would accept ourselves', () => {
  const read = readCsv(templateCsv());
  assert.equal(read.found, true);
  assert.deepEqual(read.missing, []);
  const out = validateRows(read.rows, OPTS);
  assert.deepEqual(out.errors, []);
  assert.equal(out.ready.length, 1);
  assert.equal(out.ready[0].name, 'Jane Smith');
  assert.equal(out.ready[0].phone, '+447700900123');
  assert.equal(out.ready[0].stamps, 4);
  assert.equal(out.ready[0].rewardsUnused, 1);
  assert.equal(out.ready[0].marketingOptIn, true);
});

test('the example phone keeps its leading zero in a spreadsheet', () => {
  // '07700900123' loses the 0 the moment Excel opens the file and a leading +
  // is read as a formula. The space is what makes Excel treat it as text.
  assert.ok(/\s/.test(TEMPLATE_EXAMPLE.phone), 'the example phone has a space in it on purpose');
  assert.equal(TEMPLATE_EXAMPLE.phone.charAt(0), '0');
  assert.equal(csvEscape(TEMPLATE_EXAMPLE.phone), TEMPLATE_EXAMPLE.phone, 'and nothing gets prefixed to it');
});

test('templateCsv uses CRLF, and the BOM only when asked', () => {
  assert.ok(templateCsv().includes('\r\n'));
  assert.equal(templateCsv().charCodeAt(0), 'n'.charCodeAt(0));
  assert.equal(templateCsv({ bom: true }).charCodeAt(0), 0xfeff);
});

test('csvEscape neutralises a formula and quotes what needs quoting', () => {
  assert.equal(csvEscape('=1+1'), "'=1+1");
  assert.equal(csvEscape('@sum'), "'@sum");
  assert.equal(csvEscape('-5'), "'-5");
  assert.equal(csvEscape('Smith, Jane'), '"Smith, Jane"');
  assert.equal(csvEscape('say "hi"'), '"say ""hi"""');
  assert.equal(csvEscape(null), '');
  assert.equal(toCsv([['a', 'b'], ['1', '2']]), 'a,b\r\n1,2\r\n');
});

test('a file we write can be read straight back', () => {
  const text = toCsv([TEMPLATE_COLUMNS, ['Smith, Jane', 'Jane', 'Smith', '07700 900123', 'j@x.com', '2', '0', 'yes', '', '', '', '', '', 'said "no sugar"']]);
  const read = readCsv(text);
  assert.equal(read.rows.length, 1);
  assert.equal(read.rows[0].name, 'Smith, Jane');
  assert.equal(read.rows[0].notes, 'said "no sugar"');
});

// ── headers ─────────────────────────────────────────────────────────────────

test('headers are matched by name whatever the punctuation or case', () => {
  assert.equal(canonicalHeader('First Name'), 'first_name');
  assert.equal(canonicalHeader('first_name'), 'first_name');
  assert.equal(canonicalHeader('FIRST-NAME'), 'first_name');
  assert.equal(canonicalHeader(' Mobile Number '), 'phone');
  assert.equal(canonicalHeader('E-mail Address'), 'email');
  assert.equal(canonicalHeader('Date of Birth'), 'birthday');
  assert.equal(canonicalHeader('Free Drinks'), 'rewards_unused');
  assert.equal(canonicalHeader('Opted In'), 'marketing_opt_in');
  assert.equal(canonicalHeader('Shoe size'), '');
  assert.equal(canonicalHeader(''), '');
  assert.equal(canonicalHeader(null), '');
});

test('points are recognised and then ignored, never read as stamps', () => {
  assert.equal(canonicalHeader('Points'), '');
  assert.equal(isIgnoredHeader('Points'), true);
  assert.equal(isIgnoredHeader('Loyalty Points'), true);
  assert.equal(isIgnoredHeader('Stamps'), false);
  const head = mapHeaders(['Mobile', 'Points', 'Shoe size']);
  assert.deepEqual(head.ignored, ['Points']);
  assert.deepEqual(head.unknown, ['Shoe size']);
  assert.equal(head.index.stamps, undefined);
});

test('column order does not matter and a repeated column is reported', () => {
  const head = mapHeaders(['Email', 'Mobile', 'Phone', 'First Name']);
  assert.equal(head.index.email, 0);
  assert.equal(head.index.phone, 1);
  assert.equal(head.index.first_name, 3);
  assert.deepEqual(head.duplicates, ['Phone']);
  assert.equal(head.hasPhone, true);
  assert.equal(head.hasEmail, true);
});

test('a file with no header row we recognise is refused, not read as people', () => {
  const read = readCsv('Jane,07700 900123\nBob,07700 900124');
  assert.equal(read.found, false);
  assert.deepEqual(read.rows, []);
});

test('row numbers match the line a spreadsheet shows', () => {
  const read = readCsv('name,phone\nJane,07700 900123\nBob,07700 900124');
  assert.equal(read.rows[0].rowNumber, 2);
  assert.equal(read.rows[1].rowNumber, 3);
});


test('a blank row in the middle of the sheet still counts, so Row 44 is row 44 in the sheet', () => {
  const read = readCsv('name,phone\nJane,07700 900123\n,\nBob,07700 900124');
  assert.equal(read.rows.length, 2, 'the blank row is not a person');
  assert.equal(read.rows[0].rowNumber, 2);
  assert.equal(read.rows[1].rowNumber, 4, 'but it is a row the spreadsheet shows');
});

// ── the company's country ───────────────────────────────────────────────────

test('the country comes from locations.country, else the currency, and only GBP means GB', () => {
  assert.deepEqual(countryFromVenue({ country: 'United Kingdom', currency: 'USD' }), { country: 'GB', source: 'country', label: 'United Kingdom' });
  assert.deepEqual(countryFromVenue({ country: null, currency: 'GBP' }), { country: 'GB', source: 'currency', label: 'United Kingdom' });
  assert.equal(countryFromVenue({ currency: 'USD' }).country, 'US');
  assert.equal(countryFromVenue({ currency: 'EUR' }).country, '', 'EUR says nothing about the phones');
  assert.equal(countryFromVenue(null).country, '');
  assert.equal(normaliseCountry('uk'), 'GB');
  assert.equal(normaliseCountry('GBR'), 'GB');
  assert.equal(normaliseCountry('usa'), 'US');
  assert.equal(normaliseCountry('IE'), 'IE');
  assert.equal(normaliseCountry('Narnia'), '');
});

// ── phones: shape parity with the till ──────────────────────────────────────

test('a UK phone comes back in the shape the whole app looks customers up by', () => {
  for (const cell of ['07700900123', '07700 900123', '  07700 900 123  ', '(07700) 900-123', '+44 7700 900123', '447700900123', '00447700900123', '+44 (0)7700 900123']) {
    assert.equal(writtenPhone(cell, GB), '+447700900123', cell);
  }
});

test('the phone we write is the phone the APP writes, character for character', () => {
  // The three live copies of the rule hand a landline back as BARE DIGITS.
  assert.equal(appPhone('01614960000'), '01614960000');
  assert.equal(writtenPhone('0161 496 0000', GB), '01614960000', 'a landline is stored the way the till stores it');
  assert.equal(writtenPhone('0113 496 0123', GB), '01134960123');
  for (const typed of ['07700900123', '07700 900123', '+44 7700 900123', '447700900123', '0161 496 0000', '01614960000', '+353 86 123 4567']) {
    assert.equal(writtenPhone(typed, GB), appPhone(writtenPhone(typed, GB)), 'the importer writes a value the app rule leaves alone: ' + typed);
  }
});

test('A: a GB file puts back the 0 a spreadsheet ate, and only a GB file', () => {
  const r = readPhone('7700900123', GB);
  assert.equal(r.phone, '+447700900123', 'Peter: just insert a 0 in front of the number');
  assert.equal(r.assumed, true, 'the screen must be able to say how many it did this to');
  assert.equal(readPhone('07700900123', GB).assumed, false);
  assert.equal(writtenPhone('1614960000', GB), '01614960000', 'a UK landline too');

  // Anywhere else, or when we do not know, the cell goes through unchanged.
  for (const c of [US, NONE]) {
    assert.equal(writtenPhone('7700900123', c), '7700900123', 'no zero for ' + JSON.stringify(c));
    assert.equal(readPhone('7700900123', c).assumed, false);
  }
});

test('A: a US number with a 7xx area code is NEVER written as somebody\'s UK mobile', () => {
  // The round two bug: a zero went on, then the app rule turned 07 into +44.
  for (const cell of ['7001234567', '7185550123', '7735550188', '(773) 555-0188']) {
    const written = writtenPhone(cell, US);
    assert.ok(written && !written.startsWith('+44'), cell + ' became ' + written);
    assert.equal(written, appPhone(cell), 'the till would write exactly this for the same cell');
    assert.equal(writtenPhone(cell, NONE), appPhone(cell));
  }
});

test('A: a leading 44 is not the UK code outside a GB company, and is not refused as too short', () => {
  // NANP area codes 440 to 449 are Ohio and friends, not Britain.
  const r = readPhone('4405551234', US);
  assert.equal(r.ok, true, 'a real US number is not too short');
  assert.equal(r.phone, appPhone('4405551234'), 'written exactly as the till writes it');
  assert.equal(r.e164, null, 'no UK E.164 key is made up for it');
  assert.deepEqual(phoneKeys('4405551234', US), [appPhone('4405551234')]);
});

test('A: an E.164 key is built only when the cell had a + or the company is GB and it is a UK shape', () => {
  assert.equal(readPhone('0161 496 0000', GB).e164, '+441614960000', 'GB landline: the old importer shape is a key');
  assert.equal(readPhone('0161 496 0000', US).e164, null, 'never for a US company');
  assert.equal(readPhone('4155551234', NONE).e164, null);
  assert.equal(readPhone('+1 415 555 1234', US).e164, '+14155551234', 'the cell carried its own +');
  assert.equal(readPhone('+1 415 555 1234', NONE).e164, '+14155551234');
  // A US number in a GB file does not become a UK number: it is refused.
  assert.equal(readPhone('4155551234', GB).ok, false);
});

test('A: the till would find everybody we write, whatever the country (random cells)', () => {
  // Shape parity, on thousands of cells. For any cell we accept, what we write
  // is what appPhone gives for that cell, or (GB only) for the cell with its 0
  // put back, or for the cell with 00 read as + or a (0) after +44 dropped.
  let seed = 7;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const digits = (n) => { let s = ''; for (let i = 0; i < n; i++) s += Math.floor(rand() * 10); return s; };
  const fronts = ['', '0', '07', '44', '+44', '+1', '+353', '00', '1', '7', '2'];
  let checked = 0;
  for (let i = 0; i < 4000; i++) {
    const cell = fronts[Math.floor(rand() * fronts.length)] + digits(6 + Math.floor(rand() * 9));
    for (const c of [GB, US, NONE]) {
      const r = readPhone(cell, c);
      if (!r.ok || !r.phone) continue;
      checked++;
      const allowed = [appPhone(cell)];
      if (cell.startsWith('00')) allowed.push(appPhone('+' + cell.slice(2)));
      if (c === GB) allowed.push(appPhone('0' + cell));
      if (/^\+440/.test(cell)) allowed.push(appPhone('+44' + cell.slice(4)));
      assert.ok(allowed.includes(r.phone), JSON.stringify(c) + ' ' + cell + ' wrote ' + r.phone);
      assert.equal(appPhone(r.phone), r.phone, 'a value the app rule leaves alone');
      if (c !== GB && !cell.startsWith('+') && !cell.startsWith('00')) {
        assert.equal(r.phone, appPhone(cell), 'outside GB the cell goes through unchanged: ' + cell);
        assert.equal(r.e164, null, 'and no E.164 key is invented: ' + cell);
      }
    }
  }
  assert.ok(checked > 3000, 'enough cells were accepted to mean something: ' + checked);
});

test('a landline is found under BOTH shapes in a GB company, so it is never imported twice', () => {
  const keys = phoneKeys('0161 496 0000', GB);
  assert.ok(keys.includes('01614960000'), 'what the app writes');
  assert.ok(keys.includes('+441614960000'), 'what the old importer wrote');
  const fromE164 = phoneKeys('+441614960000', GB);
  assert.ok(fromE164.includes('+441614960000'));
});

test('D: phone_raw is asked for the cell exactly as the file wrote it', () => {
  assert.deepEqual(rawPhoneKeys('  0161 496 0000 '), ['0161 496 0000']);
  assert.deepEqual(rawPhoneKeys('0161  496 0000'), ['0161  496 0000', '0161 496 0000']);
  assert.deepEqual(rawPhoneKeys(''), []);
  assert.deepEqual(rawPhoneKeys(null), []);
  const r = normaliseRow(row({ name: 'Mo', phone: ' 0161 496 0000 ' }), GB_OPTS);
  assert.equal(r.phoneRaw, '0161 496 0000', 'phoneRaw is the cell as typed, trimmed, not a digits key');
});

test('a number already in full international form is left alone', () => {
  assert.equal(writtenPhone('+353 86 123 4567', GB), '+353861234567');
  assert.equal(writtenPhone('+1 415 555 0123', GB), '+14155550123');
  assert.equal(readPhone('+353861234567', GB).assumed, false);
});

test('a phone we cannot read is an error, never a guess', () => {
  for (const bad of ['123', '07700', 'ask at till', '07700 90012A', '999999999999999999', '+44 7700 9001234']) {
    for (const c of [GB, US, NONE]) {
      const r = readPhone(bad, c);
      assert.equal(r.ok, false, 'should refuse: ' + bad);
      assert.equal(r.phone, null);
      assert.ok(r.reason.length > 0 && r.reason.length < 90, 'short plain reason for: ' + bad);
    }
  }
});

test('an empty phone is empty, not an error', () => {
  for (const blank of ['', '   ', null, undefined, 'n/a', 'N/A', 'none', '-']) {
    const r = readPhone(blank, GB);
    assert.equal(r.ok, true);
    assert.equal(r.empty, true);
    assert.equal(r.phone, null);
  }
});

// ── H: what a spreadsheet does to a cell ────────────────────────────────────

test('H: a phone a spreadsheet turned into a number comes back, a rounded one is refused', () => {
  assert.equal(writtenPhone('7954412324', GB), '+447954412324', 'the 0 a spreadsheet ate');
  assert.equal(writtenPhone('7.954412324E9', GB), '+447954412324', 'scientific notation with every digit');
  assert.equal(writtenPhone('7.954412324e+9', GB), '+447954412324');
  assert.equal(writtenPhone('7954412324.0', GB), '+447954412324');
  assert.equal(writtenPhone("'07954 412324", GB), '+447954412324', 'a spreadsheet text marker');
  assert.equal(writtenPhone('447954412324', GB), '+447954412324', 'the + eaten off +44');
  const rounded = readPhone('7.95441E+09', GB);
  assert.equal(rounded.ok, false, 'the digits are gone, so we never guess them');
  assert.match(rounded.reason, /rounded/);
  assert.equal(readPhone('1614960000', GB).phone, '01614960000');
});

test('H: dates a spreadsheet wrote day first are read for a GB company', () => {
  assert.equal(readDate('05/09/1984', GB_OPTS).date, '1984-09-05');
  assert.equal(readDate('5/9/1984', GB_OPTS).date, '1984-09-05');
  assert.equal(readDate('05/09/1984 00:00', GB_OPTS).date, '1984-09-05', 'with the time a spreadsheet adds');
  assert.equal(readDate('05/09/1984 00:00:00', GB_OPTS).date, '1984-09-05');
  assert.equal(readDate('1984-09-05 00:00:00', GB_OPTS).date, '1984-09-05');
  assert.equal(readDate('05-09-1984', GB_OPTS).date, '1984-09-05');
  const serial = readDate('30930', GB_OPTS);
  assert.equal(serial.ok, false, 'a spreadsheet date number is refused, not guessed');
  assert.match(serial.reason, /spreadsheet date number/);
});

test('H: a date that could be either is refused when we do not know the country', () => {
  const r = readDate('05/09/1984', { today: '2026-09-18' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /day from the month/);
  assert.equal(readDate('25/09/1984', { today: '2026-09-18' }).date, '1984-09-25', 'only one way to read it');
  assert.equal(readDate('05/05/1984', { today: '2026-09-18' }).date, '1984-05-05', 'both ways the same');
  assert.equal(readDate('09/05/1984', { today: '2026-09-18', country: 'US' }).date, '1984-09-05', 'a US company reads month first');
});

test('H: a column a spreadsheet turned American refuses its dates that could be either', () => {
  const rows = [
    row({ rowNumber: 2, name: 'A', phone: '07700 900101', birthday: '12/25/1990' }),  // only month first
    row({ rowNumber: 3, name: 'B', phone: '07700 900102', birthday: '05/09/1984' }),  // could be either
    row({ rowNumber: 4, name: 'C', phone: '07700 900103', birthday: '25/12/1990' }),  // only day first
  ];
  const out = validateRows(rows, GB_OPTS);
  assert.deepEqual(out.ready.map((r) => r.name), ['A', 'C']);
  assert.equal(out.errors.length, 1);
  assert.equal(out.errors[0].rowNumber, 3);
  assert.match(out.errors[0].message, /Row 2 has a month first date/);
  assert.ok(out.warnings.some((w) => w.rowNumber === 2 && /month first/.test(w.message)), 'row 2 itself is read, and said');
  // Without the American one in the column, the same date is read day first.
  assert.equal(validateRows([rows[1], rows[2]], GB_OPTS).ready[0].birthday, '1984-09-05');
});

test('H: stamps a spreadsheet wrote as 2.0 or 2,0 are 2, and 2,5 is refused', () => {
  assert.equal(readWholeNumber('2.0').value, 2);
  assert.equal(readWholeNumber('2,0').value, 2, 'a comma decimal spreadsheet');
  assert.equal(readWholeNumber('2,00').value, 2);
  assert.equal(readWholeNumber('2,5').ok, false);
  assert.equal(readWholeNumber(' 9 ').value, 9);
});

test('H: yes and no as a spreadsheet writes them', () => {
  for (const yes of ['TRUE', 'True', 'Yes', 'Y', 'y', 'YES']) assert.equal(readYesNo(yes).value, true, yes);
  for (const no of ['FALSE', 'False', 'No', 'N', 'n']) assert.equal(readYesNo(no).value, false, no);
});

test('H: a semicolon file with a BOM, re-typed headers and trailing empty columns reads', () => {
  const text = '﻿NAME;Phone;E-Mail;STAMPS;Rewards Unused;Marketing Opt-In;;\r\n'
    + 'Jane Smith;7954412324;Jane@Example.com;2,0;1;TRUE;;\r\n'
    + ';;;;;;;\r\n'
    + '"Smith; Bob";07954 412325;bob@example.com;3.0;0;No;;\r\n';
  const read = readCsv(text);
  assert.equal(read.delimiter, ';');
  assert.equal(read.found, true);
  assert.deepEqual(read.unknown, []);
  assert.equal(read.rows.length, 2);
  assert.deepEqual(read.rows.map((r) => r.rowNumber), [2, 4]);
  const out = validateRows(read.rows, GB_OPTS);
  assert.deepEqual(out.errors, []);
  const [jane, bob] = out.ready;
  assert.equal(jane.phone, '+447954412324');
  assert.equal(jane.email, 'jane@example.com');
  assert.equal(jane.stamps, 2);
  assert.equal(jane.marketingOptIn, true);
  assert.equal(bob.name, 'Smith; Bob');
  assert.equal(bob.stamps, 3);
  assert.equal(bob.marketingOptIn, false);
});

test('H: a file saved in the wrong encoding is refused with the fix in words', () => {
  const r = normaliseRow(row({ name: 'Ren�e', phone: '07700 900123' }), GB_OPTS);
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0].message, /CSV UTF-8/);
});

test('detectDelimiter picks the separator the header uses', () => {
  assert.equal(detectDelimiter('a,b,c\n1;2'), ',');
  assert.equal(detectDelimiter('a;b;c\n1,2'), ';');
  assert.equal(detectDelimiter('a\tb\tc'), '\t');
  assert.equal(detectDelimiter('"a;b",c'), ',', 'a separator inside quotes does not count');
  assert.equal(detectDelimiter(''), ',');
});

// ── the other single values ─────────────────────────────────────────────────

test('emails are lowercased, and pulled out of angle brackets and mailto', () => {
  assert.equal(normaliseEmail(' Jane@Example.COM ').email, 'jane@example.com');
  assert.equal(normaliseEmail('Jane Smith <Jane@Example.com>').email, 'jane@example.com');
  assert.equal(normaliseEmail('mailto:Jane@Example.com').email, 'jane@example.com');
  assert.equal(normaliseEmail('').empty, true);
  assert.equal(normaliseEmail('n/a').empty, true);
  assert.equal(normaliseEmail('not an email').ok, false);
  assert.equal(normaliseEmail('jane@example').ok, false);
});

test('counts are whole numbers, 0 or more, blank means 0', () => {
  assert.equal(readWholeNumber('4').value, 4);
  assert.equal(readWholeNumber('4.0').value, 4);
  assert.equal(readWholeNumber(' 1,200 ').value, 1200);
  assert.equal(readWholeNumber('').value, 0);
  assert.equal(readWholeNumber('-1').ok, false);
  assert.equal(readWholeNumber('4.5').ok, false);
  assert.equal(readWholeNumber('four').ok, false);
  assert.equal(readWholeNumber('600', MAX_STAMPS, 'Stamps').ok, false, 'a points column in the stamps slot is caught');
});

test('yes and no are read however the old system wrote them, blank is nobody saying', () => {
  for (const yes of ['yes', 'YES', 'y', 'true', '1', 'Subscribed', 'opted in']) assert.equal(readYesNo(yes).value, true, yes);
  for (const no of ['no', 'N', 'false', '0', 'Unsubscribed', 'opted out']) assert.equal(readYesNo(no).value, false, no);
  assert.equal(readYesNo('').value, null);
  assert.equal(readYesNo('').ok, true);
  assert.equal(readYesNo('maybe').ok, false, 'we never turn a word we do not know into a yes');
});

test('dates are read as ISO or the UK way, day first, for a GB company', () => {
  assert.equal(readDate('2025-04-12', GB_OPTS).date, '2025-04-12');
  assert.equal(readDate('2025-04-12T09:30:00Z', GB_OPTS).date, '2025-04-12');
  assert.equal(readDate('12/04/2025', GB_OPTS).date, '2025-04-12');
  assert.equal(readDate('3/4/2025', GB_OPTS).date, '2025-04-03', 'UK file, so day first');
  assert.equal(readDate('12-04-2025', GB_OPTS).date, '2025-04-12');
  assert.equal(readDate('12.04.2025', GB_OPTS).date, '2025-04-12');
  assert.equal(readDate('12 Apr 2025', GB_OPTS).date, '2025-04-12');
  assert.equal(readDate('Apr 12, 2025', GB_OPTS).date, '2025-04-12');
  assert.equal(readDate('12/04/25', GB_OPTS).date, '2025-04-12');
  assert.equal(readDate('', GB_OPTS).empty, true);
});

test('month first is only read when day first is impossible, and it is flagged', () => {
  const r = readDate('04/25/2025', GB_OPTS);
  assert.equal(r.date, '2025-04-25');
  assert.equal(r.monthFirst, true);
  assert.equal(r.unusual, true);
  assert.equal(readDate('03/04/2025', GB_OPTS).monthFirst, false);
  assert.equal(readDate('03/04/2025', GB_OPTS).ambiguous, true);
});

test('a bad date is refused', () => {
  assert.equal(readDate('31/02/2025', GB_OPTS).ok, false, 'there is no 31 February');
  assert.equal(readDate('last Tuesday', GB_OPTS).ok, false);
  assert.equal(readDate('2027-01-01', GB_OPTS).ok, false, 'a date in the future is wrong');
  assert.equal(readDate('1850-01-01', { ...GB_OPTS, earliestYear: 1900 }).ok, false);
});

// ── one row ─────────────────────────────────────────────────────────────────

test('a row with a missing name still gets one, because customers.name is NOT NULL', () => {
  const noName = normaliseRow(row({ phone: '07700 900123', email: 'jane@example.com' }), GB_OPTS);
  assert.equal(noName.name, 'jane', 'the email local part when there is nothing else');
  assert.deepEqual(noName.problems, []);

  const phoneOnly = normaliseRow(row({ phone: '07700 900123' }), GB_OPTS);
  assert.equal(phoneOnly.name, '+447700900123');

  const firstLast = normaliseRow(row({ first_name: 'Jane', last_name: 'Smith', phone: '07700 900123' }), GB_OPTS);
  assert.equal(firstLast.name, 'Jane Smith');

  const both = normaliseRow(row({ name: 'Jane S', first_name: 'Jane', last_name: 'Smith', phone: '07700 900123' }), GB_OPTS);
  assert.equal(both.name, 'Jane S', 'the name column wins when it is there');

  for (const r of [noName, phoneOnly, firstLast, both]) {
    assert.ok(typeof r.name === 'string' && r.name.length > 0, 'a name is never empty');
  }
});

test('a row with only an email is fine', () => {
  const r = normaliseRow(row({ email: 'BOB@example.com' }), GB_OPTS);
  assert.deepEqual(r.problems, []);
  assert.equal(r.phone, null);
  assert.equal(r.email, 'bob@example.com');
  assert.equal(r.name, 'bob');
});

test('a row with neither phone nor email is refused in plain words', () => {
  const r = normaliseRow(row({ name: 'Ghost' }), GB_OPTS);
  assert.equal(r.problems.length, 1);
  assert.equal(r.problems[0].message, 'We need a phone number or an email.');
});

test('a bad email does not lose a person we can still reach by phone', () => {
  const r = normaliseRow(row({ name: 'Jane', phone: '07700 900123', email: 'jane at example dot com' }), GB_OPTS);
  assert.deepEqual(r.problems, []);
  assert.equal(r.email, null);
  assert.equal(r.warnings.length, 1);
  assert.equal(r.warnings[0].field, 'email');
});

test('a bad email with no phone IS a problem, because nothing is left', () => {
  const r = normaliseRow(row({ name: 'Jane', email: 'nope' }), GB_OPTS);
  assert.ok(r.problems.some((p) => p.field === 'email'));
});

test('a negative stamp count is an error, not a zero', () => {
  const r = normaliseRow(row({ name: 'Jane', phone: '07700 900123', stamps: '-3' }), GB_OPTS);
  assert.equal(r.problems.length, 1);
  assert.equal(r.problems[0].field, 'stamps');
  assert.ok(r.problems[0].message.includes('less than 0'));
});

test('the row keeps what was typed for phone_raw and reads the rest', () => {
  const r = normaliseRow(row({
    name: 'Jane Smith', phone: '(07700) 900 123', email: 'Jane@Example.com',
    stamps: '4', rewards_unused: '1', marketing_opt_in: 'yes', opt_in_date: '12/04/2025',
    opt_in_source: 'Old loyalty app', signed_up_date: '2024-11-03', birthday: '24/06/1990',
    external_id: 'CB-1042', notes: 'Likes oat milk',
  }), GB_OPTS);
  assert.deepEqual(r.problems, []);
  assert.equal(r.phone, '+447700900123');
  assert.equal(r.phoneRaw, '(07700) 900 123');
  assert.equal(r.email, 'jane@example.com');
  assert.equal(r.optInDate, '2025-04-12');
  assert.equal(r.signedUpDate, '2024-11-03');
  assert.equal(r.birthday, '1990-06-24');
  assert.equal(r.externalId, 'CB-1042');
  assert.equal(r.marketingOptIn, true);
});

test('normaliseRow on its own output changes nothing', () => {
  const once = normaliseRow(row({ name: 'Jane', phone: '07700 900123' }), GB_OPTS);
  assert.equal(normaliseRow(once, GB_OPTS), once);
});

// ── a whole messy file ──────────────────────────────────────────────────────

const MESSY = [
  'Full Name,Mobile,Email Address,Stamps,Free Drinks,Opted In,Opt In Date,Points,Shoe size',
  '"Smith, Jane",07700 900123,Jane@Example.com,4,1,yes,12/04/2025,240,9',           // 2 ok, quoted comma
  'Bob Jones,  07700 900124  ,bob@example.com,0,0,no,,10,8',                        // 3 ok, spaces round the phone
  ',07700 900125,,2,0,yes,2025-01-05,0,',                                           // 4 ok, no name at all
  'Dave Shares,07700900123,dave@example.com,9,0,yes,,0,',                           // 5 shares row 2's phone: goes in by email
  'Ella Early,07700 900126,ella@example.com,3,0,yes,31/02/2025,0,',                 // 6 bad date
  'Frank Minus,07700 900127,frank@example.com,-3,0,yes,,0,',                        // 7 negative stamps
  'Gina Ghost,,gina@example.com,1,0,yes,,0,',                                       // 8 ok, email only
  'Harry Half,07700,harry@example.com,0,0,yes,,0,',                                 // 9 unreadable phone
  ',7700900128,ivy@example.com,0,0,yes,,0,',                                        // 10 ok, Excel ate the zero
  'Jack Same,07700 900129,jane@example.com,0,0,yes,,0,',                            // 11 shares row 2's email: goes in by phone
  '',                                                                               // 12 blank line
  'Kate Maybe,07700 900130,kate@example.com,0,0,maybe,,0,',                         // 13 unreadable yes or no
  'Lee Twin,07700 900124,,1,0,yes,,0,',                                             // 14 row 3's phone and no email: IS row 3
].join('\r\n');

test('the messy file is read the way an operator would expect', () => {
  const read = readCsv(MESSY);
  assert.equal(read.found, true);
  assert.deepEqual(read.ignored, ['Points']);
  assert.deepEqual(read.unknown, ['Shoe size']);
  assert.ok(read.missing.includes('birthday'));
  assert.equal(read.rows.length, 12, 'the blank line is not a person');

  const out = validateRows(read.rows, GB_OPTS);
  const ready = out.ready.map((r) => r.name);
  assert.deepEqual(ready, ['Smith, Jane', 'Bob Jones', '+447700900125', 'Dave Shares', 'Gina Ghost', 'ivy', 'Jack Same']);

  assert.deepEqual(out.errors.map((e) => e.rowNumber).sort((a, b) => a - b), [6, 7, 9, 13]);
  for (const e of out.errors) {
    assert.ok(e.text.startsWith('Row ' + e.rowNumber + ': '));
    assert.ok(e.message.length > 0 && e.message.length < 100, e.message);
  }

  // Only a row with nothing of its own left is left out, and it is named.
  assert.deepEqual(out.duplicatesInFile.map((d) => [d.rowNumber, d.field, d.firstRowNumber]), [[14, 'phone', 3]]);
  assert.ok(out.duplicatesInFile[0].text.includes('row 3'));

  // E: two rows with one phone. The first keeps it; the second goes in by email.
  const dave = out.ready.find((r) => r.name === 'Dave Shares');
  assert.equal(dave.phone, null);
  assert.equal(dave.email, 'dave@example.com');
  assert.deepEqual(dave.sharedWith, { field: 'phone', rowNumber: 2, value: '+447700900123' });
  assert.ok(out.warnings.some((w) => w.rowNumber === 5 && /Shares a phone with row 2/.test(w.message)));
  const jack = out.ready.find((r) => r.name === 'Jack Same');
  assert.equal(jack.email, null, 'the email stays with row 2');
  assert.equal(jack.phone, '+447700900129');

  assert.ok(out.warnings.some((w) => w.rowNumber === 10 && w.field === 'phone'));
});

test('rowsToSend sends the raw cells, with a shared phone moved into the notes', () => {
  const read = readCsv(MESSY);
  const out = validateRows(read.rows, GB_OPTS);
  const sent = rowsToSend(read.rows, out);
  assert.equal(sent.length, out.ready.length);
  const dave = sent.find((r) => r.rowNumber === 5);
  assert.equal(dave.phone, '', 'the server must never see the shared phone on the second row');
  assert.match(dave.notes, /Phone \+447700900123 kept on row 2\./);
  const jane = sent.find((r) => r.rowNumber === 2);
  assert.equal(jane.email, 'Jane@Example.com', 'the cells go as the file wrote them');
  // And the server, reading one slice with only Dave in it, agrees.
  const again = validateRows(rawRowsOnly([dave]), GB_OPTS);
  assert.equal(again.ready.length, 1);
  assert.equal(again.ready[0].phone, null);
  assert.equal(again.ready[0].email, 'dave@example.com');
});

test('no phone is ever written twice, whatever shape the file wrote it in', () => {
  const out = validateRows(readCsv(MESSY).rows, GB_OPTS);
  const phones = out.ready.map((r) => r.phone).filter(Boolean);
  assert.equal(new Set(phones).size, phones.length);
  const emails = out.ready.map((r) => r.email).filter(Boolean);
  assert.equal(new Set(emails).size, emails.length);
  // Two spellings of one landline are one number.
  const two = validateRows([
    row({ rowNumber: 2, name: 'A', phone: '0161 496 0000', email: 'a@example.com' }),
    row({ rowNumber: 3, name: 'B', phone: '+44 161 496 0000', email: 'b@example.com' }),
  ], GB_OPTS);
  assert.equal(two.ready[1].phone, null, 'the second spelling does not make a second owner');
});

test('validateRows on its own ready rows gives the same rows back', () => {
  const once = validateRows(readCsv(MESSY).rows, GB_OPTS);
  const twice = validateRows(once.ready, GB_OPTS);
  assert.deepEqual(twice.ready, once.ready);
  assert.deepEqual(twice.errors, []);
  assert.deepEqual(twice.duplicatesInFile, []);
});

// ── the preview numbers ─────────────────────────────────────────────────────

const allNew = (checked) => checked.ready.map((r) => ({ row_number: r.rowNumber, verdict: 'new' }));

test('summarise counts what the preview screen shows', () => {
  const read = readCsv(MESSY);
  const checked = validateRows(read.rows, GB_OPTS);
  const s = summarise(checked, allNew(checked), GB_OPTS);
  assert.equal(s.ready, 7);
  assert.equal(s.newCustomers, 7);
  assert.equal(s.alreadyKnown, 0);
  assert.equal(s.problems, 4);
  assert.equal(s.duplicates, 1);
  assert.equal(s.total, 12);
  assert.equal(s.withStamps, 4);
  assert.equal(s.stampsTotal, 16);
  assert.equal(s.rewardsTotal, 1);
  assert.equal(s.canEmail, 4, 'yes in the file and an email to send to');
  assert.equal(s.optedOut, 1);
  assert.equal(s.phoneFixed, 1);
  assert.equal(s.sharedPhone, 1);
  assert.equal(s.sharedEmail, 1);
});

test('F3: before the server has answered, nobody is new and nobody is known', () => {
  const read = readCsv(MESSY);
  const s = summarise(read.rows, null, GB_OPTS);
  assert.equal(s.newCustomers, 0);
  assert.equal(s.alreadyKnown, 0);
  assert.equal(s.unchecked, 7, 'the screen says not checked instead of guessing');
});

test('F3: the tiles count the server\'s own verdicts, known, new and left out', () => {
  const read = readCsv(MESSY);
  const checked = validateRows(read.rows, GB_OPTS);
  const verdicts = checked.ready.map((r, i) => ({ row_number: r.rowNumber, verdict: i === 0 ? 'update' : i === 1 ? 'blocked' : 'new' }));
  const s = summarise(checked, verdicts, GB_OPTS);
  assert.equal(s.alreadyKnown, 1);
  assert.equal(s.blocked, 1);
  assert.equal(s.newCustomers, 5);
  assert.equal(s.ready, 6, 'a row the server will not touch is not counted as going in');
  assert.deepEqual(summarise(checked, verdictsByRow(verdicts), GB_OPTS), s, 'a Map or the list, the same answer');
});

// ── speed ───────────────────────────────────────────────────────────────────

test('a 5000 row file is read, checked and counted quickly', () => {
  const lines = ['name,phone,email,stamps,rewards_unused,marketing_opt_in,opt_in_date'];
  for (let i = 0; i < 5000; i++) {
    const n = String(400000 + i);
    lines.push('"Person, ' + i + '",07123 ' + n + ',person' + i + '@example.com,' + (i % 9) + ',' + (i % 3) + ',yes,12/04/2025');
  }
  const text = lines.join('\r\n');
  const started = Date.now();
  const read = readCsv(text);
  const out = validateRows(read.rows, GB_OPTS);
  const s = summarise(out, allNew(out), GB_OPTS);
  const took = Date.now() - started;
  assert.equal(read.rows.length, 5000);
  assert.equal(out.ready.length, 5000);
  assert.equal(out.errors.length, 0);
  assert.equal(s.newCustomers, 5000);
  assert.ok(took < 3000, 'took ' + took + 'ms for 5000 rows');
});
