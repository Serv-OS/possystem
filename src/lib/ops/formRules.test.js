// 28 Sep 2026 (v5.11.4): Operations Documents and Forms, the pure rules.
// Form and answer checks, the Accident book template, CSV export, document size and type
// checks, bucket paths and the print page.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_FILE_BYTES, DOC_CATEGORIES, docCategoryLabel, isDocCategory, formatBytes, fileExtension,
  contentTypeFor, fileKind, checkDocumentFile, checkPhotoFile, checkDocumentDraft, safeFileName,
  titleFromFileName, documentPath, formFilePath, pathInVenue, docOpenMode, isAbsentError, isUuid,
  newId, newFieldId, blankField, FIELD_TYPES, normaliseField, normaliseForm, validateFieldDef,
  validateFormDef, isAnswered, validateAnswer, validateAnswers, cleanAnswers, dataUrlToBytes,
  extForMime, ACCIDENT_BOOK_TEMPLATE, formFromTemplate, answerText, submissionFields, formatWhen,
  csvCell, submissionsToCsv, csvFileName, escapeHtml, submissionFilePaths, buildSubmissionPrintHtml,
} from './formRules.js';

const LOC = '7218c716-eeb4-4f96-b284-f3500823595c';
const file = (name, type, size) => ({ name, type, size });
const MB = 1024 * 1024;

// ── Documents: size and type ──────────────────────────────────────────────────
test('document files: any type, up to 20 MB exactly', () => {
  assert.equal(MAX_FILE_BYTES, 20 * MB);
  assert.equal(checkDocumentFile(file('menu.pdf', 'application/pdf', 20 * MB)).ok, true);
  assert.equal(checkDocumentFile(file('plan.dwg', 'application/acad', 1234)).ok, true, 'an unusual type is still allowed');
  assert.equal(checkDocumentFile(file('noext', '', 10)).ok, true);
  const big = checkDocumentFile(file('video.mov', 'video/quicktime', 20 * MB + 1));
  assert.equal(big.ok, false);
  assert.match(big.error, /The limit is 20 MB/);
  assert.match(checkDocumentFile(file('empty.txt', 'text/plain', 0)).error, /empty/);
  assert.match(checkDocumentFile(null).error, /Choose a file/);
  assert.equal(checkDocumentFile(file('x', '', -1)).ok, false);
  assert.equal(checkDocumentFile(file('x', '', NaN)).ok, false);
  assert.equal(checkDocumentFile({ name: 'x' }).ok, false, 'no size is not a readable file');
});

test('photo answers must be pictures, same 20 MB limit', () => {
  assert.equal(checkPhotoFile(file('a.jpg', 'image/jpeg', 3 * MB)).ok, true);
  assert.equal(checkPhotoFile(file('IMG_0001.HEIC', '', 2 * MB)).ok, true, 'an iPhone HEIC with no type passes by its name');
  assert.match(checkPhotoFile(file('a.pdf', 'application/pdf', 1000)).error, /not a photo/);
  assert.match(checkPhotoFile(file('a.jpg', 'image/jpeg', 21 * MB)).error, /20 MB/);
});

test('content type: the browser type when clean, else the extension, else binary', () => {
  assert.equal(contentTypeFor(file('a.pdf', 'application/pdf', 1)), 'application/pdf');
  assert.equal(contentTypeFor(file('Report.DOCX', '', 1)), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.equal(contentTypeFor(file('a.xyz', '', 1)), 'application/octet-stream');
  assert.equal(contentTypeFor(file('a.png', 'not a type', 1)), 'image/png');
  assert.equal(contentTypeFor(file('a.JPG', 'IMAGE/JPEG', 1)), 'image/jpeg');
});

test('file kind and extension', () => {
  assert.equal(fileExtension('Menu.Final.PDF'), 'pdf');
  assert.equal(fileExtension('.bashrc'), '');
  assert.equal(fileExtension('noext'), '');
  assert.equal(fileKind('a.pdf', ''), 'pdf');
  assert.equal(fileKind('a', 'image/webp'), 'image');
  assert.equal(fileKind('a.docx', ''), 'word');
  assert.equal(fileKind('a.xlsx', ''), 'sheet');
  assert.equal(fileKind('a.csv', 'text/csv'), 'sheet');
  assert.equal(fileKind('a.pptx', ''), 'slides');
  assert.equal(fileKind('a.txt', ''), 'text');
  assert.equal(fileKind('a.zip', 'application/zip'), 'other');
});

test('file names are storage safe and never climb out of their folder', () => {
  assert.equal(safeFileName('../../etc/passwd'), 'passwd');
  assert.equal(safeFileName('C:\\Users\\me\\Café menu (v2).PDF'), 'Cafe-menu-v2.pdf');
  assert.equal(safeFileName(''), 'file');
  assert.equal(safeFileName('???.pdf'), 'file.pdf');
  const long = safeFileName(`${'a'.repeat(300)}.pdf`);
  assert.ok(long.length <= 104 && long.endsWith('.pdf'));
  assert.equal(titleFromFileName('Fire-risk_assessment  2026.pdf'), 'Fire risk assessment 2026');
});

test('bucket paths: the venue first, then documents or forms', () => {
  const p = documentPath(LOC, 'd1', 'Pest report.pdf');
  assert.equal(p, `${LOC}/documents/d1/Pest-report.pdf`);
  assert.equal(pathInVenue(p, LOC, 'documents'), true);
  assert.equal(pathInVenue(p, 'other-venue', 'documents'), false);
  assert.equal(pathInVenue(p, LOC, 'forms'), false);
  assert.equal(formFilePath(LOC, 's1', 'signature', 'png', 'ab12cd'), `${LOC}/forms/s1/signature-ab12cd.png`);
  assert.equal(pathInVenue(formFilePath(LOC, 's1', 'photo', 'jpg'), LOC, 'forms'), true);
});

test('a new document needs a title, a category and a file', () => {
  const ok = checkDocumentDraft({ title: 'Allergen matrix', category: 'food_safety', file: file('a.pdf', 'application/pdf', 10) });
  assert.equal(ok.ok, true);
  const bad = checkDocumentDraft({ title: '  ', category: 'nope', file: null });
  assert.equal(bad.ok, false);
  assert.deepEqual(Object.keys(bad.errors).sort(), ['category', 'file', 'title']);
  assert.match(checkDocumentDraft({ title: 'x'.repeat(201), category: 'other', file: file('a', '', 1) }).errors.title, /200/);
});

test('categories: the 5 Peter asked for', () => {
  assert.deepEqual(DOC_CATEGORIES.map((c) => c.label), ['Food safety', 'Health and safety', 'Certificates', 'Policies', 'Other']);
  assert.equal(isDocCategory('certificates'), true);
  assert.equal(isDocCategory('Certificates'), false);
  assert.equal(docCategoryLabel('health_safety'), 'Health and safety');
  assert.equal(docCategoryLabel('unknown'), 'Other');
});

test('formatBytes', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(950), '950 B');
  assert.equal(formatBytes(12 * 1024), '12 KB');
  assert.equal(formatBytes(3.44 * MB), '3.4 MB');
  assert.equal(formatBytes(20 * MB), '20 MB');
});

test('"not set up yet" is a missing table, column, function or bucket, never a refusal', () => {
  for (const code of ['PGRST205', '42P01', 'PGRST202', '42883', '42703', 'PGRST204']) assert.equal(isAbsentError({ code }), true, code);
  assert.equal(isAbsentError({ message: 'relation "public.ops_forms" does not exist' }), true);
  assert.equal(isAbsentError({ message: 'Bucket not found' }), true);
  assert.equal(isAbsentError({ code: '42501', message: 'new row violates row-level security policy' }), false);
  assert.equal(isAbsentError(new TypeError('Failed to fetch')), false);
  assert.equal(isAbsentError(null), false);
});

test('opening a document: a browser gets a tab, the Android shell the phone viewer, iOS and Sunmi the in-app viewer', () => {
  // A browser (desktop Back Office, an iPad in Safari, a Chrome tablet).
  assert.equal(docOpenMode({ navigator: { userAgent: 'Mozilla/5.0 (Macintosh) Safari/605' } }), 'tab');
  assert.equal(docOpenMode({ navigator: { userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) Version/17.0 Mobile/15E148 Safari/604.1' } }), 'tab');
  // android/webshell ShellActivity: sends a page link off app.serv-os.app to the phone's viewer.
  assert.equal(docOpenMode({ navigator: { userAgent: 'Mozilla/5.0 (Linux; Android 13) Chrome/120 RposAndroid/1.4.0' } }), 'navigate');
  assert.equal(docOpenMode({ RposAndroid: {}, navigator: { userAgent: 'Mozilla/5.0 (Linux; Android 13)' } }), 'navigate');
  // iOS shells keep *.supabase.co in the app with no back gesture: never navigate there.
  assert.equal(docOpenMode({ RposIOS: { hasCamera: false }, navigator: { userAgent: 'Mozilla' } }), 'viewer');
  assert.equal(docOpenMode({ navigator: { userAgent: 'Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 RposIOS/1.2' } }), 'viewer');
  // The old RestaurantOS iOS app and the Sunmi till app allow the Supabase host in place.
  assert.equal(docOpenMode({ navigator: { userAgent: 'Mozilla/5.0 (Linux; Android 11; Sunmi) Chrome/120.0.0.0 Mobile Safari/537.36 RestaurantOS/1.0 Sunmi/1.0' } }), 'viewer');
  assert.equal(docOpenMode({ navigator: { userAgent: 'Mozilla/5.0 (iPad) Safari/604.1 RestaurantOS/1.0 RPOS-iOS/1.0' } }), 'viewer');
});

test('ids: v4 uuids, from randomUUID or getRandomValues', () => {
  const a = newId();
  assert.equal(isUuid(a), true);
  assert.notEqual(a, newId());
  const b = newId({ getRandomValues: (arr) => { arr.fill(7); return arr; } });
  assert.match(b, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(isUuid('not-a-uuid'), false);
  assert.equal(isUuid(null), false);
});

// ── Forms: questions ─────────────────────────────────────────────────────────
test('field types: exactly the 10 Peter asked for', () => {
  assert.deepEqual(FIELD_TYPES.map((t) => t.key), ['short_text', 'long_text', 'number', 'date', 'time', 'yes_no', 'single_choice', 'multi_choice', 'photo', 'signature']);
});

test('question ids are unique within a form', () => {
  let n = 0;
  const rand = () => [0, 0, 0, 0, 0, 0, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5][n++ % 12];
  const first = newFieldId([], rand);
  const second = newFieldId([first], rand);
  assert.notEqual(first, second);
  assert.match(first, /^f_[a-z0-9]{6}$/);
  const choice = blankField('single_choice', []);
  assert.deepEqual(choice.options, ['Option 1', 'Option 2']);
  assert.deepEqual(blankField('photo', []).options, []);
  assert.equal(blankField('nonsense', []).type, 'short_text');
});

test('normaliseField: known type, trimmed, options only on choices, required is strictly true', () => {
  assert.deepEqual(normaliseField({ id: ' q1 ', type: 'weird', label: ' Name ', help: ' h ', required: 'yes', options: ['a'] }),
    { id: 'q1', type: 'short_text', label: 'Name', help: 'h', required: false, options: [] });
  assert.deepEqual(normaliseField({ id: 'q2', type: 'multi_choice', label: 'L', options: [' Red ', 'red', '', 'Blue'], required: true }).options, ['Red', 'Blue']);
  const f = normaliseForm({ name: ' Accident ', description: null, fields: [{ id: 'a', type: 'date', label: 'When' }] });
  assert.equal(f.name, 'Accident');
  assert.equal(f.description, '');
  assert.equal(f.fields[0].type, 'date');
});

test('validateFieldDef', () => {
  assert.deepEqual(validateFieldDef({ id: 'q1', type: 'short_text', label: 'Name' }), []);
  assert.match(validateFieldDef({ id: 'q1', type: 'short_text', label: ' ' }).join(), /needs a label/);
  assert.match(validateFieldDef({ id: 'Bad Id!', type: 'short_text', label: 'x' }).join(), /no usable id/);
  assert.match(validateFieldDef({ id: 'q', type: 'single_choice', label: 'x', options: ['Only'] }).join(), /at least 2 options/);
  assert.match(validateFieldDef({ id: 'q', type: 'multi_choice', label: 'x', options: ['A', 'a', 'B'] }).join(), /same/);
  assert.match(validateFieldDef({ id: 'q', type: 'short_text', label: 'x'.repeat(201) }).join(), /200/);
  assert.match(validateFieldDef({ id: 'q', type: 'short_text', label: 'x', help: 'h'.repeat(501) }).join(), /help line/);
  assert.match(validateFieldDef({ id: 'q', type: 'hologram', label: 'x' }).join(), /question type/);
});

test('validateFormDef', () => {
  const ok = validateFormDef({ name: 'Cleaning log', fields: [{ id: 'a', type: 'yes_no', label: 'Done?' }] });
  assert.equal(ok.ok, true);
  assert.match(validateFormDef({ name: '', fields: [{ id: 'a', type: 'yes_no', label: 'x' }] }).errors.join(), /name/);
  assert.match(validateFormDef({ name: 'x', fields: [] }).errors.join(), /at least one question/);
  const dup = validateFormDef({ name: 'x', fields: [{ id: 'a', type: 'number', label: 'A' }, { id: 'a', type: 'number', label: 'B' }] });
  assert.equal(dup.ok, false);
  assert.match(dup.fieldErrors[1].join(), /share an id/);
  const q2 = validateFormDef({ name: 'x', fields: [{ id: 'a', type: 'number', label: 'A' }, { id: 'b', type: 'number', label: '' }] });
  assert.equal(q2.ok, false);
  assert.match(q2.errors[0], /^Question 2: /);
  assert.equal(validateFormDef({ name: 'x', fields: Array.from({ length: 101 }, (_, i) => ({ id: `q${i}`, type: 'number', label: 'n' })) }).ok, false);
});

// ── Forms: answers ───────────────────────────────────────────────────────────
const F = (type, extra = {}) => ({ id: 'q', type, label: 'Q', required: false, options: [], ...extra });

test('required questions must be answered; optional ones may be blank', () => {
  assert.equal(validateAnswer(F('short_text', { required: true }), '  '), 'This is required.');
  assert.equal(validateAnswer(F('short_text'), ''), '');
  assert.equal(validateAnswer(F('multi_choice', { required: true, options: ['A', 'B'] }), []), 'This is required.');
  assert.equal(validateAnswer(F('yes_no', { required: true }), null), 'This is required.');
  assert.equal(validateAnswer(F('signature', { required: true }), ''), 'This is required.');
  assert.equal(validateAnswer(F('photo', { required: true }), null), 'This is required.');
  assert.equal(isAnswered(F('number'), 0), true, 'zero is an answer');
});

test('each question type checks its own answer', () => {
  assert.equal(validateAnswer(F('number'), '12.5'), '');
  assert.equal(validateAnswer(F('number'), '-3'), '');
  assert.equal(validateAnswer(F('number'), 'abc'), 'Enter a number.');
  assert.equal(validateAnswer(F('number'), '1,000'), 'Enter a number.');
  assert.equal(validateAnswer(F('date'), '2026-09-28'), '');
  assert.equal(validateAnswer(F('date'), '2026-02-30'), 'Enter a date.');
  assert.equal(validateAnswer(F('date'), '28/09/2026'), 'Enter a date.');
  assert.equal(validateAnswer(F('time'), '23:59'), '');
  assert.equal(validateAnswer(F('time'), '24:00'), 'Enter a time.');
  assert.equal(validateAnswer(F('yes_no'), 'yes'), '');
  assert.equal(validateAnswer(F('single_choice', { options: ['Staff', 'Customer'] }), 'Staff'), '');
  assert.equal(validateAnswer(F('single_choice', { options: ['Staff', 'Customer'] }), 'Boss'), 'Choose one of the options.');
  assert.equal(validateAnswer(F('multi_choice', { options: ['A', 'B'] }), ['A', 'B']), '');
  assert.equal(validateAnswer(F('multi_choice', { options: ['A', 'B'] }), ['A', 'Z']), 'Choose from the options.');
  assert.match(validateAnswer(F('short_text'), 'x'.repeat(501)), /500/);
  assert.equal(validateAnswer(F('long_text'), 'x'.repeat(5000)), '');
  assert.match(validateAnswer(F('long_text'), 'x'.repeat(5001)), /5000/);
  assert.equal(validateAnswer(F('photo'), file('p.jpg', 'image/jpeg', 1000)), '');
  assert.match(validateAnswer(F('photo'), file('p.pdf', 'application/pdf', 1000)), /not a photo/);
  assert.equal(validateAnswer(F('signature'), 'data:image/png;base64,iVBORw0KGgo='), '');
  assert.match(validateAnswer(F('signature'), 'data:text/html;base64,PGgxPg=='), /Sign/);
  assert.equal(validateAnswer(F('signature'), `${LOC}/forms/s/signature-x.png`), '', 'a stored path is a signature');
});

test('validateAnswers keys errors by question id', () => {
  const fields = [F('short_text', { id: 'name', required: true }), F('number', { id: 'age' })];
  const r = validateAnswers(fields, { age: 'old' });
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors, { name: 'This is required.', age: 'Enter a number.' });
  assert.equal(validateAnswers(fields, { name: 'Sam', age: '31' }).ok, true);
});

test('cleanAnswers: known questions only, trimmed, numbers as numbers, choices in form order', () => {
  const photo = file('p.jpg', 'image/jpeg', 10);
  const fields = [
    F('short_text', { id: 'a' }), F('number', { id: 'n' }), F('multi_choice', { id: 'm', options: ['X', 'Y', 'Z'] }),
    F('yes_no', { id: 'y' }), F('photo', { id: 'p' }), F('long_text', { id: 'blank' }),
  ];
  const out = cleanAnswers(fields, { a: '  hi ', n: ' 7 ', m: ['Z', 'X'], y: 'no', p: photo, blank: '   ', sneaky: 'x' });
  assert.deepEqual(out, { a: 'hi', n: 7, m: ['X', 'Z'], y: 'no', p: photo });
});

test('a signature data URL turns into PNG bytes', () => {
  const d = dataUrlToBytes('data:image/png;base64,iVBORw0KGgo=');
  assert.equal(d.mime, 'image/png');
  assert.deepEqual([...d.bytes.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  assert.equal(dataUrlToBytes('not a data url'), null);
  assert.equal(extForMime('image/png'), 'png');
  assert.equal(extForMime('image/jpeg'), 'jpg');
  assert.equal(extForMime('application/pdf'), '');
});

// ── The Accident book ────────────────────────────────────────────────────────
test('Accident book template: every question Peter listed, in order, with the right types', () => {
  assert.equal(ACCIDENT_BOOK_TEMPLATE.key, 'accident_book');
  assert.equal(ACCIDENT_BOOK_TEMPLATE.name, 'Accident book');
  const shape = ACCIDENT_BOOK_TEMPLATE.fields.map((f) => [f.id, f.type, f.required]);
  assert.deepEqual(shape, [
    ['injured_name', 'short_text', true],
    ['injured_role', 'single_choice', true],
    ['injured_contact', 'long_text', false],
    ['incident_date', 'date', true],
    ['incident_time', 'time', true],
    ['location', 'short_text', true],
    ['what_happened', 'long_text', true],
    ['injury', 'long_text', true],
    ['body_part', 'short_text', true],
    ['first_aid_given', 'long_text', true],
    ['first_aid_by', 'short_text', false],
    ['witnesses', 'long_text', false],
    ['riddor', 'yes_no', true],
    ['reported_by', 'short_text', true],
    ['signature', 'signature', true],
  ]);
  const role = ACCIDENT_BOOK_TEMPLATE.fields.find((f) => f.id === 'injured_role');
  assert.deepEqual([...role.options], ['Staff', 'Customer', 'Contractor', 'Other']);
  const riddor = ACCIDENT_BOOK_TEMPLATE.fields.find((f) => f.id === 'riddor');
  assert.match(riddor.label, /RIDDOR/);
  assert.match(riddor.help, /7 days/);
  assert.match(riddor.help, /hospital/);
  assert.match(riddor.help, /hse\.gov\.uk\/riddor/);
});

test('Accident book is a valid form, copied fresh each time, and the template cannot be changed', () => {
  const a = formFromTemplate('accident_book');
  assert.equal(validateFormDef(a).ok, true);
  assert.equal(a.templateKey, 'accident_book');
  a.fields[1].options.push('Visitor');
  a.fields[0].label = 'changed';
  assert.deepEqual([...ACCIDENT_BOOK_TEMPLATE.fields[1].options], ['Staff', 'Customer', 'Contractor', 'Other']);
  assert.equal(ACCIDENT_BOOK_TEMPLATE.fields[0].label, "Injured person's name");
  assert.equal(Object.isFrozen(ACCIDENT_BOOK_TEMPLATE.fields[0]), true);
  assert.equal(formFromTemplate('nope'), null);
  for (const f of ACCIDENT_BOOK_TEMPLATE.fields) {
    assert.doesNotMatch(`${f.label} ${f.help}`, /[\u2013\u2014]/, `${f.id}: no en or em dashes`);
  }
});

test('an Accident book entry: a filled one passes, a half filled one names each missing answer', () => {
  const a = formFromTemplate('accident_book');
  const good = {
    injured_name: 'Sam Jones', injured_role: 'Customer', incident_date: '2026-09-28', incident_time: '13:05',
    location: 'Front door step', what_happened: 'Slipped on a wet step', injury: 'Sprain', body_part: 'Left ankle',
    first_aid_given: 'Ice pack', riddor: 'no', reported_by: 'Alex', signature: 'data:image/png;base64,iVBORw0KGgo=',
  };
  assert.equal(validateAnswers(a.fields, good).ok, true);
  const half = validateAnswers(a.fields, { injured_name: 'Sam' });
  assert.equal(half.ok, false);
  assert.ok(half.errors.signature && half.errors.riddor && half.errors.incident_date);
  assert.equal(half.errors.witnesses, undefined, 'witnesses are optional');
});

// ── Showing and exporting ────────────────────────────────────────────────────
test('answerText', () => {
  assert.equal(answerText(F('yes_no'), 'yes'), 'Yes');
  assert.equal(answerText(F('yes_no'), 'no'), 'No');
  assert.equal(answerText(F('multi_choice', { options: ['A', 'B'] }), ['A', 'B']), 'A, B');
  assert.equal(answerText(F('photo'), 'loc/forms/s/p.jpg'), 'Photo attached');
  assert.equal(answerText(F('signature'), 'loc/forms/s/s.png'), 'Signed');
  assert.equal(answerText(F('date'), '2026-09-28'), '28/09/2026');
  assert.equal(answerText(F('number'), 0), '0');
  assert.equal(answerText(F('short_text'), undefined), '');
});

test('times show on the venue clock', () => {
  assert.equal(formatWhen('2026-09-28T13:05:00Z', 'Europe/London'), '28/09/2026 14:05');
  assert.equal(formatWhen('2026-09-28T13:05:00Z', 'America/Denver'), '28/09/2026 07:05');
  assert.equal(formatWhen('2026-12-28T13:05:00Z', 'Not/AZone'), '28/12/2026 13:05', 'a bad zone falls back to London');
  assert.equal(formatWhen(null, 'Europe/London'), '');
});

test('csvCell: quotes when needed and never lets a spreadsheet run a formula', () => {
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell('a, b'), '"a, b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('line1\nline2'), '"line1\nline2"');
  assert.equal(csvCell('=HYPERLINK("http://x")'), '"\'=HYPERLINK(""http://x"")"');
  assert.equal(csvCell('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(csvCell('+44 7700 900000'), "'+44 7700 900000");
  assert.equal(csvCell('-3'), '-3', 'a negative number stays a number');
  assert.equal(csvCell(0), '0');
  assert.equal(csvCell(null), '');
});

test('submissionsToCsv: header, venue times, every answer as words, removed questions kept', () => {
  const form = {
    name: 'Accident book',
    fields: [
      { id: 'name', type: 'short_text', label: 'Name' },
      { id: 'role', type: 'single_choice', label: 'Role', options: ['Staff', 'Customer'] },
      { id: 'parts', type: 'multi_choice', label: 'Body parts', options: ['Hand', 'Arm'] },
      { id: 'riddor', type: 'yes_no', label: 'RIDDOR' },
      { id: 'when', type: 'date', label: 'Date' },
      { id: 'sig', type: 'signature', label: 'Signature' },
    ],
  };
  const subs = [
    {
      submittedAt: '2026-09-28T13:05:00Z', submittedByName: 'Alex',
      fields: [...form.fields, { id: 'old', type: 'short_text', label: 'Old question' }],
      answers: { name: 'Sam, Jones', role: 'Customer', parts: ['Hand', 'Arm'], riddor: 'no', when: '2026-09-28', sig: 'x/forms/s/sig.png', old: '=1+1' },
    },
    { submittedAt: '2026-09-27T08:00:00Z', submittedByName: '', fields: form.fields, answers: { name: 'Kim', riddor: 'yes' } },
  ];
  const csv = submissionsToCsv(form, subs, { timeZone: 'Europe/London' });
  const lines = csv.split('\r\n');
  assert.equal(lines.length, 3);
  assert.equal(lines[0], 'Submitted at,Submitted by,Name,Role,Body parts,RIDDOR,Date,Signature,Old question');
  assert.equal(lines[1], `28/09/2026 14:05,Alex,"Sam, Jones",Customer,"Hand, Arm",No,28/09/2026,Signed,'=1+1`);
  assert.equal(lines[2], '27/09/2026 09:00,,Kim,,,Yes,,,');
  assert.deepEqual(submissionFields(form, subs).map((f) => f.id), ['name', 'role', 'parts', 'riddor', 'when', 'sig', 'old']);
});

test('csvFileName', () => {
  assert.equal(csvFileName('Accident book', new Date(2026, 8, 28, 12)), 'accident-book-submissions-2026-09-28.csv');
  assert.equal(csvFileName('  ', new Date(2026, 0, 2)), 'form-submissions-2026-01-02.csv');
});

test('print page: every answer escaped, pictures only from https links', () => {
  const submission = {
    formName: 'Accident <b>book</b>', submittedAt: '2026-09-28T13:05:00Z', submittedByName: 'Alex <script>',
    fields: [
      { id: 'what', type: 'long_text', label: 'What happened' },
      { id: 'photo', type: 'photo', label: 'Photo' },
      { id: 'sig', type: 'signature', label: 'Signature' },
      { id: 'none', type: 'short_text', label: 'Witnesses' },
    ],
    answers: { what: '<img src=x onerror=alert(1)>\nsecond line', photo: 'p1', sig: 's1' },
  };
  const html = buildSubmissionPrintHtml({
    submission, venueName: 'Coffee Boy Leeds', timeZone: 'Europe/London',
    fileUrls: { p1: 'javascript:alert(1)', s1: 'https://x.supabase.co/storage/v1/object/sign/ops-files/s1?token=a"b' },
  });
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;<br>second line/);
  assert.doesNotMatch(html, /javascript:alert/);
  assert.match(html, /Photo attached/, 'no https link: the words, not a picture');
  assert.match(html, /<img src="https:\/\/x\.supabase\.co\/[^"]*token=a&quot;b" alt="Signature" class="sig">/);
  assert.match(html, /No answer/);
  assert.match(html, /Accident &lt;b&gt;book&lt;\/b&gt;/);
  assert.match(html, /Coffee Boy Leeds &middot; Submitted 28\/09\/2026 14:05 by Alex &lt;script&gt;/);
  assert.match(html, /window\.print\(\)/);
  assert.equal(escapeHtml(`<a href="x">'`), '&lt;a href=&quot;x&quot;&gt;&#39;');
});

test('submissionFilePaths: only stored photo and signature paths', () => {
  const s = {
    fields: [{ id: 'p', type: 'photo' }, { id: 's', type: 'signature' }, { id: 't', type: 'short_text' }, { id: 'q', type: 'photo' }],
    answers: { p: 'loc/forms/1/p.jpg', s: 'data:image/png;base64,xx', t: 'loc/forms/not/a/file', q: null },
  };
  assert.deepEqual(submissionFilePaths(s), ['loc/forms/1/p.jpg']);
});
