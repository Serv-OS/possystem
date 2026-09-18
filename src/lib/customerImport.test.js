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

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TEMPLATE_COLUMNS,
  TEMPLATE_EXAMPLE,
  MAX_STAMPS,
  parseCsv,
  templateCsv,
  csvEscape,
  toCsv,
  canonicalHeader,
  isIgnoredHeader,
  mapHeaders,
  readCsv,
  readPhone,
  normalisePhoneUk,
  normaliseEmail,
  readWholeNumber,
  readYesNo,
  readDate,
  normaliseRow,
  validateRows,
  buildExistingKeys,
  summarise,
} from './customerImport.js';

// Every test pins the day, so nothing here goes red next April.
const OPTS = { today: '2026-09-17' };

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

// ── phones ──────────────────────────────────────────────────────────────────

test('a UK phone comes back in the shape the whole app looks customers up by', () => {
  assert.equal(normalisePhoneUk('07700900123'), '+447700900123');
  assert.equal(normalisePhoneUk('07700 900123'), '+447700900123');
  assert.equal(normalisePhoneUk('  07700 900 123  '), '+447700900123');
  assert.equal(normalisePhoneUk('(07700) 900-123'), '+447700900123');
  assert.equal(normalisePhoneUk('+44 7700 900123'), '+447700900123');
  assert.equal(normalisePhoneUk('447700900123'), '+447700900123');
  assert.equal(normalisePhoneUk('00447700900123'), '+447700900123');
  assert.equal(normalisePhoneUk('+44 (0)7700 900123'), '+447700900123');
  assert.equal(normalisePhoneUk('0113 496 0123'), '+441134960123', 'a landline is still a customer');
});

test('a spreadsheet eating the leading zero is put back, and says so', () => {
  const r = readPhone('7700900123');
  assert.equal(r.phone, '+447700900123');
  assert.equal(r.assumed, true, 'the screen must be able to say how many it did this to');
  assert.equal(readPhone('07700900123').assumed, false);
});

test('a number already in full international form is left alone', () => {
  assert.equal(normalisePhoneUk('+353 86 123 4567'), '+353861234567');
  assert.equal(normalisePhoneUk('+1 415 555 0123'), '+14155550123');
  assert.equal(readPhone('+353861234567').assumed, false);
});

test('a phone we cannot read is an error, never a guess', () => {
  for (const bad of ['123', '07700', 'ask at till', '07700 90012A', '999999999999999999', '+44 7700 9001234']) {
    const r = readPhone(bad);
    assert.equal(r.ok, false, 'should refuse: ' + bad);
    assert.equal(r.phone, null);
    assert.ok(r.reason.length > 0 && r.reason.length < 80, 'short plain reason for: ' + bad);
  }
});

test('an empty phone is empty, not an error', () => {
  for (const blank of ['', '   ', null, undefined, 'n/a', 'N/A', 'none', '-']) {
    const r = readPhone(blank);
    assert.equal(r.ok, true);
    assert.equal(r.empty, true);
    assert.equal(r.phone, null);
  }
});

// ── the other single values ─────────────────────────────────────────────────

test('emails are lowercased, and pulled out of angle brackets', () => {
  assert.equal(normaliseEmail(' Jane@Example.COM ').email, 'jane@example.com');
  assert.equal(normaliseEmail('Jane Smith <Jane@Example.com>').email, 'jane@example.com');
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

test('dates are read as ISO or the UK way, day first', () => {
  assert.equal(readDate('2025-04-12', OPTS).date, '2025-04-12');
  assert.equal(readDate('2025-04-12T09:30:00Z', OPTS).date, '2025-04-12');
  assert.equal(readDate('12/04/2025', OPTS).date, '2025-04-12');
  assert.equal(readDate('3/4/2025', OPTS).date, '2025-04-03', 'UK file, so day first');
  assert.equal(readDate('12-04-2025', OPTS).date, '2025-04-12');
  assert.equal(readDate('12.04.2025', OPTS).date, '2025-04-12');
  assert.equal(readDate('12 Apr 2025', OPTS).date, '2025-04-12');
  assert.equal(readDate('Apr 12, 2025', OPTS).date, '2025-04-12');
  assert.equal(readDate('12/04/25', OPTS).date, '2025-04-12');
  assert.equal(readDate('', OPTS).empty, true);
});

test('month first is only read when day first is impossible, and it is flagged', () => {
  const r = readDate('04/25/2025', OPTS);
  assert.equal(r.date, '2025-04-25');
  assert.equal(r.monthFirst, true);
  assert.equal(readDate('03/04/2025', OPTS).monthFirst, false);
});

test('a bad date is refused', () => {
  assert.equal(readDate('31/02/2025', OPTS).ok, false, 'there is no 31 February');
  assert.equal(readDate('last Tuesday', OPTS).ok, false);
  assert.equal(readDate('2027-01-01', OPTS).ok, false, 'a date in the future is wrong');
  assert.equal(readDate('1850-01-01', { today: OPTS.today, earliestYear: 1900 }).ok, false);
});

// ── one row ─────────────────────────────────────────────────────────────────

const row = (extra) => Object.assign({
  rowNumber: 2, name: '', first_name: '', last_name: '', phone: '', email: '',
  stamps: '', rewards_unused: '', marketing_opt_in: '', opt_in_date: '',
  opt_in_source: '', signed_up_date: '', birthday: '', external_id: '', notes: '',
}, extra);

test('a row with a missing name still gets one, because customers.name is NOT NULL', () => {
  const noName = normaliseRow(row({ phone: '07700 900123', email: 'jane@example.com' }), OPTS);
  assert.equal(noName.name, 'jane', 'the email local part when there is nothing else');
  assert.deepEqual(noName.problems, []);

  const phoneOnly = normaliseRow(row({ phone: '07700 900123' }), OPTS);
  assert.equal(phoneOnly.name, '+447700900123');

  const firstLast = normaliseRow(row({ first_name: 'Jane', last_name: 'Smith', phone: '07700 900123' }), OPTS);
  assert.equal(firstLast.name, 'Jane Smith');

  const both = normaliseRow(row({ name: 'Jane S', first_name: 'Jane', last_name: 'Smith', phone: '07700 900123' }), OPTS);
  assert.equal(both.name, 'Jane S', 'the name column wins when it is there');

  for (const r of [noName, phoneOnly, firstLast, both]) {
    assert.ok(typeof r.name === 'string' && r.name.length > 0, 'a name is never empty');
  }
});

test('a row with only an email is fine', () => {
  const r = normaliseRow(row({ email: 'BOB@example.com' }), OPTS);
  assert.deepEqual(r.problems, []);
  assert.equal(r.phone, null);
  assert.equal(r.email, 'bob@example.com');
  assert.equal(r.name, 'bob');
});

test('a row with neither phone nor email is refused in plain words', () => {
  const r = normaliseRow(row({ name: 'Ghost' }), OPTS);
  assert.equal(r.problems.length, 1);
  assert.equal(r.problems[0].message, 'We need a phone number or an email.');
});

test('a bad email does not lose a person we can still reach by phone', () => {
  const r = normaliseRow(row({ name: 'Jane', phone: '07700 900123', email: 'jane at example dot com' }), OPTS);
  assert.deepEqual(r.problems, []);
  assert.equal(r.email, null);
  assert.equal(r.warnings.length, 1);
  assert.equal(r.warnings[0].field, 'email');
});

test('a bad email with no phone IS a problem, because nothing is left', () => {
  const r = normaliseRow(row({ name: 'Jane', email: 'nope' }), OPTS);
  assert.ok(r.problems.some((p) => p.field === 'email'));
});

test('a negative stamp count is an error, not a zero', () => {
  const r = normaliseRow(row({ name: 'Jane', phone: '07700 900123', stamps: '-3' }), OPTS);
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
  }), OPTS);
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
  const once = normaliseRow(row({ name: 'Jane', phone: '07700 900123' }), OPTS);
  assert.equal(normaliseRow(once, OPTS), once);
});

// ── a whole messy file ──────────────────────────────────────────────────────

const MESSY = [
  'Full Name,Mobile,Email Address,Stamps,Free Drinks,Opted In,Opt In Date,Points,Shoe size',
  '"Smith, Jane",07700 900123,Jane@Example.com,4,1,yes,12/04/2025,240,9',           // 2 ok, quoted comma
  'Bob Jones,  07700 900124  ,bob@example.com,0,0,no,,10,8',                        // 3 ok, spaces round the phone
  ',07700 900125,,2,0,yes,2025-01-05,0,',                                           // 4 ok, no name at all
  'Dave Duplicate,07700900123,dave@example.com,9,0,yes,,0,',                        // 5 duplicate phone of row 2
  'Ella Early,07700 900126,ella@example.com,3,0,yes,31/02/2025,0,',                 // 6 bad date
  'Frank Minus,07700 900127,frank@example.com,-3,0,yes,,0,',                        // 7 negative stamps
  'Gina Ghost,,gina@example.com,1,0,yes,,0,',                                       // 8 ok, email only
  'Harry Half,07700,harry@example.com,0,0,yes,,0,',                                 // 9 unreadable phone
  ',7700900128,ivy@example.com,0,0,yes,,0,',                                        // 10 ok, Excel ate the zero
  'Jack Same,07700 900129,jane@example.com,0,0,yes,,0,',                            // 11 duplicate email of row 2
  '',                                                                               // blank line
  'Kate Maybe,07700 900130,kate@example.com,0,0,maybe,,0,',                         // 12 unreadable yes or no
].join('\r\n');

test('the messy file is read the way an operator would expect', () => {
  const read = readCsv(MESSY);
  assert.equal(read.found, true);
  assert.deepEqual(read.ignored, ['Points']);
  assert.deepEqual(read.unknown, ['Shoe size']);
  assert.ok(read.missing.includes('birthday'));
  assert.equal(read.rows.length, 11, 'the blank line is not a person');

  const out = validateRows(read.rows, OPTS);
  const ready = out.ready.map((r) => r.name);
  // Row 4 has no name and no email, so the phone becomes the name. It is never
  // empty, because customers.name is NOT NULL and a null is refused in silence.
  assert.deepEqual(ready, ['Smith, Jane', 'Bob Jones', '+447700900125', 'Gina Ghost', 'ivy']);

  // Every error names its row and says what is wrong, in short plain words.
  assert.deepEqual(out.errors.map((e) => e.rowNumber).sort((a, b) => a - b), [6, 7, 9, 12]);
  for (const e of out.errors) {
    assert.ok(e.text.startsWith('Row ' + e.rowNumber + ': '));
    assert.ok(e.message.length > 0 && e.message.length < 80, e.message);
  }

  // The same person twice is kept once, and the second one is named.
  assert.deepEqual(out.duplicatesInFile.map((d) => [d.rowNumber, d.field, d.firstRowNumber]), [
    [5, 'phone', 2],
    [11, 'email', 2],
  ]);
  assert.ok(out.duplicatesInFile[0].text.includes('row 2'));

  // Row 10 lost its zero in a spreadsheet, which we say out loud.
  assert.ok(out.warnings.some((w) => w.rowNumber === 10 && w.field === 'phone'));
});

test('no phone is ever written twice, whatever shape the file wrote it in', () => {
  const out = validateRows(readCsv(MESSY).rows, OPTS);
  const phones = out.ready.map((r) => r.phone).filter(Boolean);
  assert.equal(new Set(phones).size, phones.length);
  const emails = out.ready.map((r) => r.email).filter(Boolean);
  assert.equal(new Set(emails).size, emails.length);
});

test('validateRows on its own ready rows gives the same rows back', () => {
  const once = validateRows(readCsv(MESSY).rows, OPTS);
  const twice = validateRows(once.ready, OPTS);
  assert.deepEqual(twice.ready, once.ready);
  assert.deepEqual(twice.errors, []);
  assert.deepEqual(twice.duplicatesInFile, []);
});

// ── the preview numbers ─────────────────────────────────────────────────────

test('summarise counts what the preview screen shows', () => {
  const read = readCsv(MESSY);
  const s = summarise(read.rows, null, OPTS);
  assert.equal(s.ready, 5);
  assert.equal(s.newCustomers, 5, 'Coffee Boy has no customers today, so everybody is new');
  assert.equal(s.alreadyKnown, 0);
  assert.equal(s.problems, 4);
  assert.equal(s.duplicates, 2);
  assert.equal(s.total, 11);
  assert.equal(s.withStamps, 3);
  assert.equal(s.stampsTotal, 7);
  assert.equal(s.rewardsTotal, 1);
  assert.equal(s.canEmail, 3, 'yes in the file and an email to send to');
  assert.equal(s.optedOut, 1);
  assert.equal(s.phoneFixed, 1);
});

test('summarise knows who we already have, by phone or by email', () => {
  const read = readCsv(MESSY);
  const keys = buildExistingKeys([
    { phone: '+447700900123', email: null },
    { phone: null, email: 'GINA@example.com' },
  ]);
  const s = summarise(read.rows, keys, OPTS);
  assert.equal(s.alreadyKnown, 2);
  assert.equal(s.newCustomers, 3);
});

test('summarise takes a validateRows result, plain strings, or nothing at all', () => {
  const read = readCsv(MESSY);
  const checked = validateRows(read.rows, OPTS);
  assert.deepEqual(summarise(checked, null, OPTS), summarise(read.rows, null, OPTS));
  assert.equal(summarise(read.rows, ['07700 900123', 'gina@example.com'], OPTS).alreadyKnown, 2);
  assert.equal(summarise(read.rows, { phones: ['07700900123'], emails: [] }, OPTS).alreadyKnown, 1);
  assert.equal(summarise([], null, OPTS).total, 0);
});

test('buildExistingKeys is happy with its own output and with rubbish', () => {
  const once = buildExistingKeys([{ phone: '07700 900123', email: 'Jane@Example.com' }]);
  assert.deepEqual(Array.from(buildExistingKeys(once)).sort(), Array.from(once).sort());
  assert.equal(buildExistingKeys(null).size, 0);
  assert.equal(buildExistingKeys([null, 'nonsense', {}]).size, 0);
});

// ── speed ───────────────────────────────────────────────────────────────────

test('a 5000 row file is read, checked and counted quickly', () => {
  const lines = ['name,phone,email,stamps,rewards_unused,marketing_opt_in,opt_in_date'];
  for (let i = 0; i < 5000; i++) {
    const n = 900000 + i;                       // Ofcom drama range, never a real phone
    lines.push('"Person, ' + i + '",07700 ' + n + ',person' + i + '@example.com,' + (i % 9) + ',' + (i % 3) + ',yes,12/04/2025');
  }
  const text = lines.join('\r\n');
  const started = Date.now();
  const read = readCsv(text);
  const out = validateRows(read.rows, OPTS);
  const s = summarise(out, null, OPTS);
  const took = Date.now() - started;
  assert.equal(read.rows.length, 5000);
  assert.equal(out.ready.length, 5000);
  assert.equal(out.errors.length, 0);
  assert.equal(s.newCustomers, 5000);
  assert.ok(took < 3000, 'took ' + took + 'ms for 5000 rows');
});
