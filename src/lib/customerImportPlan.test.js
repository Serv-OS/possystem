// src/lib/customerImportPlan.test.js
//
// The decisions the customer importer makes, and the guards on the edge
// function that carries them out.
//
// customerImport.ts reads the file. customerImportPlan.ts decides what to do
// with what it read: who is new, who is an update, who we refuse to touch,
// which columns an update may change, and what a stamp balance becomes.
// supabase/functions/customer-import/index.ts does the talking to the two
// databases and nothing else, so the rules can be tested here without one.
//
// Four of these tests are about somebody's money or somebody's permission:
//   - fill blanks only            an import must not overwrite a name or an
//                                 email somebody typed at the till
//   - never clear a yes           marketing_opt_in only ever goes true
//   - never double a stamp        the same file twice is not free coffee twice
//   - never lose a stamp          a stamp earned between export and import
//                                 survives the import
//
// The plan module lives once, in supabase/functions/_shared, because only the
// edge function needs it. The file reading rules live twice (src/lib and
// _shared) and have their own parity test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { normaliseRow } from '../../supabase/functions/_shared/customerImport.ts';
import {
  MAX_ROWS_PER_CALL, READ_CHUNK, WRITE_CHUNK, IMPORT_SOURCE, STAMP_KEY_PREFIX,
  batchTag, stampKey, chunk,
  indexExisting, lookupKeys, decideRows, planCounts, needsProgramme, programmeCheck,
  buildInsert, buildPatch, groupPatches, buildConsent, consentIsNew, consentDecision,
  stampPlan, stampsOwed, stampsSkipped, alreadyStampedLine, emptyProgress,
  collapsePatches, withheldLine, sameAsReason, skipRow, failRow, runNote, chunkAnswer,
  staffVerdict, isBatchId, batchRecord,
  withheldLines, deletedLine, DELETED_REASON, parseStaffEmails, STAFF_EMAILS_ENV, IMPORT_SWITCHED_OFF,
  BATCH_TABLE_MISSING, batchTableGate, patchChanges, phoneRawFor, damagedPhoneRaw, emailIlikeFilter, EMAIL_READ_CHUNK,
} from '../../supabase/functions/_shared/customerImportPlan.ts';
import { sameAsReason as screenSameAsReason } from './customerImportScreen.js';

const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const BATCH = '7f0a2c1e-1111-4b2a-9c3d-abcdefabcdef';
const ORG = 'cd97f0f0-4807-4e45-801e-56114b22128a';
const NOW = '2026-09-18T09:00:00.000Z';
const CTX = { orgId: ORG, batchId: BATCH, now: NOW, country: 'GB' };
const OPTS = { today: '2026-09-18', country: 'GB' };
const GB = { country: 'GB' };

const row = (fields) => normaliseRow(fields, OPTS);

// ── the tags that make a run findable again ─────────────────────────────────

test('a batch tag is the batch id with import in front of it', () => {
  assert.equal(batchTag(BATCH), 'import:' + BATCH);
  assert.equal(batchTag(''), '');
  assert.equal(batchTag(null), '');
  assert.equal(batchTag(undefined), '');
});

test('a stamp key names the batch, the person and the card', () => {
  const key = stampKey(BATCH, 'cust-1', 'prog-1');
  assert.equal(key, 'import:' + BATCH + ':cust-1:prog-1');
  assert.ok(key.startsWith(STAMP_KEY_PREFIX), 'every import key starts with the prefix we search by');
  assert.notEqual(stampKey(BATCH, 'cust-1', 'prog-2'), key, 'two cards are two keys');
  assert.notEqual(stampKey('other', 'cust-1', 'prog-1'), key, 'two runs are two keys');
});

test('chunk slices a file and never loses a row', () => {
  const list = Array.from({ length: 1001 }, (_, i) => i);
  const slices = chunk(list, 500);
  assert.equal(slices.length, 3);
  assert.deepEqual(slices.map((s) => s.length), [500, 500, 1]);
  assert.deepEqual(slices.flat(), list);
  assert.deepEqual(chunk([], 10), []);
  assert.deepEqual(chunk([1, 2], 0), [[1, 2]], 'a silly size gives one slice, never an endless loop');
  assert.deepEqual(chunk(null, 10), []);
});

test('the sizes are the ones a twenty thousand row file needs', () => {
  assert.equal(MAX_ROWS_PER_CALL, 500);
  assert.ok(READ_CHUNK <= MAX_ROWS_PER_CALL && READ_CHUNK > 0);
  assert.ok(WRITE_CHUNK <= MAX_ROWS_PER_CALL && WRITE_CHUNK > 0);
  assert.equal(Math.ceil(20000 / MAX_ROWS_PER_CALL), 40, '20,000 rows is 40 calls');
});

// ── who have we already got ─────────────────────────────────────────────────

test('existing customers are keyed the way the file will be read', () => {
  const index = indexExisting([
    { id: 'a', phone: '+447700900123', email: 'Jane@Example.COM' },
    { id: 'b', phone: '07700900456', email: null },
    { id: 'c', phone: null, email: 'bob@example.com' },
    { id: null, phone: '07700900999' },
    null,
    'nonsense',
  ], GB);
  assert.equal(index.byPhone.get('+447700900123').id, 'a');
  assert.equal(index.byPhone.get('07700900456').id, 'b', 'exactly as stored');
  assert.equal(index.byPhone.get('+447700900456').id, 'b', 'a stored 07 number is found by its international form');
  assert.equal(index.byEmail.get('jane@example.com').id, 'a', 'stored case does not matter');
  assert.equal(index.byEmail.get('bob@example.com').id, 'c');
  assert.equal(index.byPhone.get('07700900999'), undefined, 'a row with no id is not indexed');
});

test('a landline on file the OLD way is still the same person', () => {
  // The first version of this importer wrote every number as E.164, so a
  // Manchester landline the till had as 01614960000 could be on file either
  // way. Both shapes must find the one customer, or the second run of the file
  // creates a duplicate with the stamps on the row the till cannot see.
  for (const stored of ['01614960000', '+441614960000']) {
    const index = indexExisting([{ id: 'cust-1', phone: stored, email: null }]);
    const [d] = decideRows([row({ name: 'Jane', phone: '0161 496 0000' })], index);
    assert.equal(d.verdict, 'update', 'stored as ' + stored);
    assert.equal(d.customerId, 'cust-1');
    assert.equal(d.matchedOn, 'phone');
  }
  // And phone_raw, which is whatever they typed at the till.
  const index = indexExisting([{ id: 'cust-2', phone: null, phone_raw: '0161 496 0000', email: null }]);
  const [d] = decideRows([row({ name: 'Jane', phone: '01614960000' })], index);
  assert.equal(d.customerId, 'cust-2');
});

test('a lookup asks for every shape a phone could be on file in', () => {
  const keys = lookupKeys([
    row({ name: 'A', phone: '07700 900123', email: 'jane@example.com' }),
    row({ name: 'B', phone: '+44 7700 900123', email: 'JANE@EXAMPLE.COM' }),
    row({ name: 'C', phone: '0161 496 0000', email: '' }),
  ]);
  assert.ok(keys.phones.includes('+447700900123'), 'the app shape for a mobile');
  assert.ok(!keys.phones.includes('07700900123'), 'customers.phone never holds a 07 mobile, the app turns it into +44');
  assert.ok(keys.phones.includes('01614960000'), 'the app shape for a landline');
  assert.ok(keys.phones.includes('+441614960000'), 'and the shape the old importer wrote');
  assert.equal(new Set(keys.phones).size, keys.phones.length, 'each one asked for once');
  assert.deepEqual(keys.emails, ['jane@example.com']);
  assert.deepEqual(lookupKeys(null), { phones: [], raws: [], emails: [] });
});

test('D: phone_raw is asked for the cell as typed, and the ways a person types the number', () => {
  const keys = lookupKeys([row({ name: 'A', phone: '0161 496 0000' }), row({ name: 'B', phone: '07700 900123' })]);
  assert.ok(keys.raws.includes('0161 496 0000'), 'the cell exactly as the file wrote it');
  assert.ok(keys.raws.includes('07700 900123'));
  assert.ok(keys.raws.includes('07700900123'), 'the number typed without spaces');
  assert.ok(keys.raws.includes('+447700900123'));
  assert.ok(keys.raws.includes('01614960000'));
  // And the index agrees with what was asked: a phone_raw found by any of
  // those values is matched to the row, never read and then ignored.
  for (const typed of ['0161 496 0000', '01614960000', '+441614960000']) {
    const index = indexExisting([{ id: 'c-raw', phone: null, phone_raw: typed, email: null }], GB);
    const [d] = decideRows([row({ name: 'Mo', phone: '0161 496 0000' })], index, GB);
    assert.equal(d.customerId, 'c-raw', 'phone_raw ' + typed);
    assert.ok(keys.raws.includes(typed), 'and it is one of the values the database is asked for: ' + typed);
  }
});

test('A: a US number never matches a UK customer through an invented +44 key', () => {
  // The old dialled() made '+44' + national for every number, so a US row
  // 7001234567 was looked up as +447001234567 and could land on a stranger.
  const ukCustomer = [{ id: 'uk-1', phone: '+447001234567', email: null }];
  const us = normaliseRow({ rowNumber: 2, name: 'Hank', phone: '7001234567' }, { today: '2026-09-18', country: 'US' });
  assert.equal(us.phone, '7001234567');
  const [d] = decideRows([us], indexExisting(ukCustomer, { country: 'US' }), { country: 'US' });
  assert.equal(d.verdict, 'new', 'Hank is not the UK customer');
  assert.ok(!lookupKeys([us]).phones.some((k) => k.startsWith('+44')), 'no +44 key is ever asked for');
});

// ── new, update, or leave alone ─────────────────────────────────────────────

test('a customer we have never seen is new', () => {
  const [d] = decideRows([row({ name: 'Jane', phone: '07700900123' })], []);
  assert.equal(d.verdict, 'new');
  assert.equal(d.customerId, null);
  assert.equal(d.matchedOn, '');
});

test('the phone is matched first, whatever shape it is written in', () => {
  const existing = [{ id: 'cust-1', phone: '+447700900123', email: 'old@example.com' }];
  for (const typed of ['07700900123', '07700 900123', '+44 7700 900123', '447700900123', '0044 7700 900123']) {
    const [d] = decideRows([row({ name: 'Jane', phone: typed })], existing);
    assert.equal(d.verdict, 'update', typed + ' finds the person we already have');
    assert.equal(d.customerId, 'cust-1');
    assert.equal(d.matchedOn, 'phone');
  }
});

test('with no phone match we fall back to the email', () => {
  const existing = [{ id: 'cust-1', phone: null, email: 'jane@example.com' }];
  const [d] = decideRows([row({ name: 'Jane', phone: '07700900123', email: 'Jane@Example.com' })], existing);
  assert.equal(d.verdict, 'update');
  assert.equal(d.matchedOn, 'email');
  assert.equal(d.customerId, 'cust-1');
});

test('an email that already belongs to somebody else stops the row, it never merges two people', () => {
  const existing = [{ id: 'cust-1', phone: '+447700900999', email: 'shared@example.com' }];
  const [d] = decideRows([row({ name: 'Jane', phone: '07700900123', email: 'shared@example.com' })], existing);
  assert.equal(d.verdict, 'blocked');
  assert.match(d.reason, /belongs to somebody else/);
  assert.ok(!/error|invalid|constraint/i.test(d.reason), 'the reason is plain words, not database words');
});

test('deciding twice changes nothing', () => {
  const rows = [row({ name: 'Jane', phone: '07700900123' }), row({ name: 'Bob', phone: '07700900456' })];
  const once = decideRows(rows, [{ id: 'cust-1', phone: '+447700900123' }]);
  const twice = decideRows(once, [{ id: 'cust-1', phone: '+447700900123' }]);
  assert.deepEqual(twice, once);
});

test('the counts are what the screen puts in front of the operator', () => {
  const existing = [{ id: 'cust-1', phone: '+447700900123' }, { id: 'cust-9', phone: '+447700900999', email: 'shared@example.com' }];
  const decisions = decideRows([
    row({ name: 'Jane', phone: '07700900123', stamps: '4' }),
    row({ name: 'Bob', phone: '07700900456', stamps: '2', rewards_unused: '1' }),
    row({ name: 'Sue', phone: '07700900789' }),
    row({ name: 'Clash', phone: '07700900321', email: 'shared@example.com', stamps: '9' }),
  ], existing);
  const counts = planCounts(decisions);
  assert.equal(counts.total, 4);
  assert.equal(counts.updates, 1);
  assert.equal(counts.newCustomers, 2);
  assert.equal(counts.blocked, 1);
  assert.equal(counts.withStamps, 2, 'the blocked row is not counted, we are not writing it');
  assert.equal(counts.stampsTotal, 6, 'the blocked row takes its 9 stamps with it');
  assert.equal(counts.rewardsTotal, 1);
});

// ── the stamp card has to exist before a stamp can land on it ───────────────

test('stamps with no stamp card refuse the whole run, in words the operator can act on', () => {
  const rows = [row({ name: 'Jane', phone: '07700900123', stamps: '4' })];
  assert.equal(needsProgramme(rows), true);
  const verdict = programmeCheck({ rows, programId: '', program: null, companyId: ORG });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.message, 'These people have stamps. Make a stamp card in Loyalty first, then import again.');
});

test('a file with no stamps needs no stamp card', () => {
  const rows = [row({ name: 'Jane', phone: '07700900123' })];
  assert.equal(needsProgramme(rows), false);
  assert.equal(programmeCheck({ rows, programId: '', program: null, companyId: ORG }).ok, true);
});

test('a stamp card from another company is refused', () => {
  const rows = [row({ name: 'Jane', phone: '07700900123', stamps: '4' })];
  const verdict = programmeCheck({
    rows, programId: 'prog-1', companyId: ORG,
    program: { id: 'prog-1', company_id: 'some-other-company', stamps_required: 9 },
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.message, /different company/);
});

test('a stamp card we cannot find is refused', () => {
  const verdict = programmeCheck({ rows: [], programId: 'prog-gone', program: null, companyId: ORG });
  assert.equal(verdict.ok, false);
  assert.match(verdict.message, /cannot find that stamp card/);
});

test('a stamp card with no stamps set on it is refused', () => {
  const verdict = programmeCheck({
    rows: [], programId: 'prog-1', companyId: ORG,
    program: { id: 'prog-1', company_id: ORG, stamps_required: 0 },
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.message, /no stamps set/);
});

test('a real stamp card at the right company goes ahead', () => {
  const rows = [row({ name: 'Jane', phone: '07700900123', stamps: '4' })];
  assert.deepEqual(
    programmeCheck({ rows, programId: 'prog-1', companyId: ORG, program: { id: 'prog-1', company_id: ORG, stamps_required: 9 } }),
    { ok: true, message: '' },
  );
});

// ── a new customer row ──────────────────────────────────────────────────────

test('a new customer is never written with a null name', () => {
  // customers.name is NOT NULL with no default. A null there is refused
  // silently and it broke every loyalty sign up on 17 Sep 2026.
  for (const fields of [
    { phone: '07700900123' },
    { phone: '07700900123', name: '   ' },
    { email: 'jane@example.com' },
    { phone: '07700900123', first_name: '', last_name: '' },
  ]) {
    const insert = buildInsert(row(fields), CTX);
    assert.equal(typeof insert.name, 'string');
    assert.notEqual(insert.name.trim(), '', JSON.stringify(fields) + ' still gets a name');
  }
});

test('a new customer carries the org, the source and this run tag', () => {
  const insert = buildInsert(row({ name: 'Jane Smith', phone: '07700 900123', email: 'Jane@Example.com', birthday: '12/04/1990', notes: 'likes oat milk' }), CTX);
  assert.equal(insert.org_id, ORG);
  assert.equal(insert.phone, '+447700900123');
  assert.equal(insert.phone_raw, '07700 900123', 'what they typed is kept for the operator to read');
  assert.equal(insert.email, 'jane@example.com');
  assert.equal(insert.birthday, '1990-04-12');
  assert.equal(insert.notes, 'likes oat milk');
  assert.equal(insert.source, IMPORT_SOURCE);
  assert.deepEqual(insert.sources, [IMPORT_SOURCE, 'import:' + BATCH]);
});

test('only a yes in the file is a yes on the new customer', () => {
  const yes = buildInsert(row({ name: 'A', phone: '07700900123', marketing_opt_in: 'yes', opt_in_date: '2025-04-12' }), CTX);
  assert.equal(yes.marketing_opt_in, true);
  assert.equal(yes.marketing_opt_in_at, '2025-04-12', 'the date they actually opted in, not today');

  const yesNoDate = buildInsert(row({ name: 'A', phone: '07700900123', marketing_opt_in: 'yes' }), CTX);
  assert.equal(yesNoDate.marketing_opt_in_at, NOW, 'with no date on the file we stamp the import time');

  for (const answer of ['no', '', '   ', 'n/a']) {
    const other = buildInsert(row({ name: 'A', phone: '07700900123', marketing_opt_in: answer }), CTX);
    assert.equal(other.marketing_opt_in, false, JSON.stringify(answer) + ' is not a yes');
    assert.equal(other.marketing_opt_in_at, null);
  }
});

// ── an update: blanks only ──────────────────────────────────────────────────

test('an import never overwrites what is already there', () => {
  const existing = {
    id: 'cust-1',
    name: 'Jane at the counter',
    first_name: 'Jane',
    last_name: 'Cooper',
    phone: '+447700900123',
    phone_raw: '07700 900123',
    email: 'jane.real@example.com',
    birthday: '1990-04-12',
    notes: 'Allergic to hazelnuts',
    source: 'pos',
    sources: ['pos'],
  };
  const patch = buildPatch(row({
    name: 'JANE SMITH', first_name: 'Janey', last_name: 'Smith',
    phone: '07700900123', email: 'old-system@example.com',
    birthday: '01/01/1980', notes: 'from the old system',
  }), existing, CTX);

  // Everything is already there, so there is nothing to write at all. The run
  // tag on its own is not a change (6a).
  assert.equal(patch, null, 'nothing real to change is no write');

  // With one real blank to fill, the patch still touches NOTHING else.
  const noBirthday = buildPatch(row({
    name: 'JANE SMITH', first_name: 'Janey', last_name: 'Smith',
    phone: '07700900123', email: 'old-system@example.com',
    birthday: '01/01/1980', notes: 'from the old system',
  }), { ...existing, birthday: null }, CTX);
  for (const column of ['first_name', 'last_name', 'email', 'phone', 'phone_raw', 'notes', 'source']) {
    assert.equal(column in noBirthday, false, 'an import must not touch ' + column + ' when it is already set');
  }
  assert.equal(noBirthday.birthday, '1980-01-01');
  // `name` IS in every patch, because customers.name is NOT NULL with no
  // default and an upsert on conflict id is still an INSERT to Postgres: the
  // proposed tuple is constraint checked before the conflict is resolved, so a
  // patch with no name raised 23502 on every single bulk write. The value is
  // the name they ALREADY have, never the one in the file.
  assert.equal(noBirthday.name, 'Jane at the counter', 'the filler is their own name, never the file"s');
  assert.deepEqual(noBirthday.sources, ['pos', IMPORT_SOURCE, 'import:' + BATCH], 'the run tag rides along with a real change');
  assert.equal(noBirthday.id, 'cust-1');
  assert.equal(noBirthday.org_id, ORG);
  assert.equal(noBirthday.updated_at, NOW);
  assert.deepEqual(patchChanges(noBirthday, { ...existing, birthday: null }), ['birthday'], 'and only the birthday counts as filled in');
});

test('every patch carries the columns a NOT NULL insert tuple needs', () => {
  // customers.name is NOT NULL with no default and customers.org_id is NOT
  // NULL. Postgres runs ExecConstraints on the tuple an upsert PROPOSES, before
  // ON CONFLICT is resolved, so both have to be on every patch or the whole
  // bulk write is refused with 23502 and the file falls back to one request a
  // customer, silently.
  const existings = [
    { id: 'c1', name: 'Jane at the counter', sources: ['pos'], source: 'pos', phone: '+447700900123' },
    { id: 'c2', name: '', sources: [], phone: null },
    { id: 'c3', name: null, sources: null, email: null },
  ];
  for (const existing of existings) {
    const patch = buildPatch(row({ name: 'Jane Smith', phone: '07700900123', email: 'jane@example.com' }), existing, CTX);
    assert.ok(patch, 'each of these has a real blank to fill');
    assert.equal(typeof patch.name, 'string');
    assert.ok(patch.name.length > 0, 'never null, never empty');
    assert.equal(patch.org_id, ORG);
    assert.equal(patch.id, existing.id);
  }
});

test('an import fills in the blanks it finds', () => {
  const existing = { id: 'cust-1', name: '', first_name: null, last_name: null, phone: null, email: null, birthday: null, notes: null, source: null, sources: [] };
  const patch = buildPatch(row({
    name: 'Jane Smith', first_name: 'Jane', last_name: 'Smith',
    phone: '07700 900123', email: 'jane@example.com', birthday: '12/04/1990', notes: 'oat milk',
  }), existing, CTX);
  assert.equal(patch.name, 'Jane Smith');
  assert.equal(patch.first_name, 'Jane');
  assert.equal(patch.last_name, 'Smith');
  assert.equal(patch.phone, '+447700900123');
  assert.equal(patch.phone_raw, '07700 900123');
  assert.equal(patch.email, 'jane@example.com');
  assert.equal(patch.birthday, '1990-04-12');
  assert.equal(patch.notes, 'oat milk');
  assert.equal(patch.source, IMPORT_SOURCE);
});

test('a yes is never cleared by an import', () => {
  const said = { id: 'cust-1', name: 'Jane', first_name: 'Jane', last_name: 'Smith', phone: '+447700900123', phone_raw: '07700900123', email: 'jane@example.com', birthday: '1990-04-12', notes: 'oat milk', sources: [IMPORT_SOURCE, 'import:' + BATCH], source: 'pos', marketing_opt_in: true, marketing_opt_in_at: '2024-01-01T00:00:00.000Z' };
  for (const answer of ['no', 'unsubscribed', 'opted out', '', 'n/a']) {
    const patch = buildPatch(row({ name: 'Jane', phone: '07700900123', email: 'jane@example.com', marketing_opt_in: answer }), said, CTX);
    assert.equal(patch, null, JSON.stringify(answer) + ' leaves the customer alone entirely');
  }
});

test('a yes in the file turns the flag on for somebody who never said', () => {
  const never = { id: 'cust-1', name: 'Jane', source: 'pos', sources: ['pos'], marketing_opt_in: false, marketing_opt_in_at: null };
  const patch = buildPatch(row({ name: 'Jane', phone: '07700900123', marketing_opt_in: 'yes', opt_in_date: '2025-04-12' }), never, CTX);
  assert.equal(patch.marketing_opt_in, true);
  assert.equal(patch.marketing_opt_in_at, '2025-04-12');
});

test('no patch ever sets marketing_opt_in to false', () => {
  const cases = [
    { id: 'c', name: 'A', sources: [], marketing_opt_in: true },
    { id: 'c', name: 'A', sources: [], marketing_opt_in: false },
    { id: 'c', name: 'A', sources: [], marketing_opt_in: null },
  ];
  for (const existing of cases) {
    for (const answer of ['yes', 'no', '', 'maybe']) {
      const patch = buildPatch(row({ name: 'A', phone: '07700900123', marketing_opt_in: answer }), existing, CTX);
      if (patch && 'marketing_opt_in' in patch) {
        assert.equal(patch.marketing_opt_in, true, 'the flag only ever goes true');
      }
    }
  }
});

test('running the same file twice under the same run tag does nothing the second time', () => {
  const existing = { id: 'cust-1', name: 'Jane', first_name: 'Jane', last_name: 'Smith', phone: '+447700900123', phone_raw: '07700900123', email: 'jane@example.com', birthday: '1990-04-12', notes: 'oat milk', source: IMPORT_SOURCE, sources: [IMPORT_SOURCE, 'import:' + BATCH], marketing_opt_in: true };
  const r = row({ name: 'Jane', phone: '07700900123', email: 'jane@example.com', marketing_opt_in: 'yes' });
  assert.equal(buildPatch(r, existing, CTX), null);
});

test('a patch with nobody to patch is no patch', () => {
  assert.equal(buildPatch(row({ name: 'A', phone: '07700900123' }), null, CTX), null);
  assert.equal(buildPatch(row({ name: 'A', phone: '07700900123' }), { id: '' }, CTX), null);
});

test('patches are grouped by the columns they touch, never padded out', () => {
  const groups = groupPatches([
    { id: '1', org_id: ORG, updated_at: NOW, sources: ['a'] },
    { id: '2', org_id: ORG, updated_at: NOW, sources: ['b'] },
    { id: '3', org_id: ORG, updated_at: NOW, sources: ['c'], email: 'x@y.com' },
    null,
  ]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].length, 2);
  assert.equal(groups[1].length, 1);
  for (const group of groups) {
    const shape = Object.keys(group[0]).sort().join('|');
    for (const p of group) assert.equal(Object.keys(p).sort().join('|'), shape, 'one write, one set of columns');
  }
  assert.deepEqual(groupPatches(null), []);
});

// ── consent ─────────────────────────────────────────────────────────────────

const CONSENT_ARGS = {
  customerId: 'cust-1',
  orgId: ORG,
  companyId: ORG,
  locationId: '1e252e7c-c875-4971-b91d-1e945c26956b',
  consentText: 'Opted in on Loyalzoo, exported 17 Sep 2026.',
  privacyVersion: '2026-01',
  now: NOW,
};

test('1: a yes gets a consent row, and a no and a blank get NONE', () => {
  const yes = buildConsent(row({ name: 'A', phone: '07700900123', marketing_opt_in: 'yes' }), CONSENT_ARGS);
  assert.equal(yes.consented, true);
  assert.equal(yes.source, IMPORT_SOURCE);
  assert.equal(yes.method, 'imported_optin');
  assert.equal(yes.channel, 'both');
  assert.equal(yes.purpose, 'marketing');
  assert.equal(yes.consent_text, CONSENT_ARGS.consentText);
  assert.equal(yes.privacy_version, '2026-01');
  assert.equal(typeof yes.location_id, 'string', 'customer_consents.location_id is text NOT NULL');

  // A no from another system means only that it holds no consent. A no row
  // dated today would be the NEWEST ledger row and switch off a yes given here.
  for (const noAnswer of ['no', 'N', 'FALSE', 'unsubscribed', 'opted out']) {
    assert.equal(buildConsent(row({ name: 'A', phone: '07700900123', marketing_opt_in: noAnswer }), CONSENT_ARGS), null,
      JSON.stringify(noAnswer) + ' never becomes a no row');
  }

  for (const blankAnswer of ['', '   ', 'n/a', 'maybe']) {
    assert.equal(buildConsent(row({ name: 'A', phone: '07700900123', marketing_opt_in: blankAnswer }), CONSENT_ARGS), null,
      'nobody said, so we do not put words in their mouth');
  }
  assert.equal(buildConsent(row({ name: 'A', phone: '07700900123', marketing_opt_in: 'yes' }), { ...CONSENT_ARGS, customerId: '' }), null);
});

test('the same consent is not written twice, and a different one is', () => {
  const yes = buildConsent(row({ name: 'A', phone: '07700900123', marketing_opt_in: 'yes' }), CONSENT_ARGS);
  assert.equal(consentIsNew(yes, []), true);
  assert.equal(consentIsNew(yes, [{ customer_id: 'cust-1', source: 'import', consented: true, consent_text: CONSENT_ARGS.consentText }]), false);
  assert.equal(consentIsNew(yes, [{ customer_id: 'cust-1', source: 'import', consented: false, consent_text: CONSENT_ARGS.consentText }]), true, 'they changed their mind, record it');
  assert.equal(consentIsNew(yes, [{ customer_id: 'cust-1', source: 'import', consented: true, consent_text: 'a different system' }]), true, 'a new file is a new record');
  assert.equal(consentIsNew(yes, [{ customer_id: 'cust-1', source: 'wifi', consented: true, consent_text: CONSENT_ARGS.consentText }]), true, 'the wifi portal record is not ours');
  assert.equal(consentIsNew(yes, [{ customer_id: 'cust-2', source: 'import', consented: true, consent_text: CONSENT_ARGS.consentText }]), true, 'somebody else entirely');
});

// ── never clear a yes has a mirror: never undo a no ─────────────────────────

const yesRow = (fields) => row({ name: 'Jane', phone: '07700900123', marketing_opt_in: 'yes', ...fields });

test('a yes out of the file is a yes when nobody has said stop', () => {
  const v = consentDecision(yesRow({ opt_in_date: '2025-04-12' }), { priorConsents: [], suppressed: false, now: NOW });
  assert.equal(v.write, true);
  assert.equal(v.consented, true);
  assert.equal(v.setFlag, true, 'marketing_opt_in goes on');
  assert.equal(v.withheld, false);
  assert.equal(v.createdAt.slice(0, 10), '2025-04-12', 'dated when they actually opted in, not now');
});

test('a stale file NEVER re-consents somebody who opted out here since', () => {
  // The whole of finding 7. They pressed unsubscribe in June. The third party
  // export was written in April. marketing-send takes the NEWEST consent row,
  // so a yes written today would beat their withdrawal and the emails start
  // again, which is the venue's fine.
  const withdrawal = [{ customer_id: 'cust-1', consented: false, source: 'unsubscribe', created_at: '2026-06-01T10:00:00.000Z' }];
  const v = consentDecision(yesRow({ opt_in_date: '2025-04-12' }), { priorConsents: withdrawal, suppressed: false, now: NOW });
  assert.equal(v.setFlag, false, 'the flag is left exactly as it is');
  assert.equal(v.withheld, true);
  assert.ok(v.reason.length > 0 && v.reason.length < 120, 'plain words for the operator');
  assert.equal(v.write, true, 'the ledger still records what the file said');
  assert.equal(v.createdAt.slice(0, 10), '2025-04-12', 'dated with the FILE"s day, so it cannot jump the withdrawal');
  assert.ok(v.createdAt < withdrawal[0].created_at, 'and it is genuinely older than the no');
});

test('a yes with NO date cannot prove it is newer, so the withdrawal wins', () => {
  // 5Loyalty do not expose opt_in_date at all, which is exactly this case.
  const withdrawal = [{ customer_id: 'cust-1', consented: false, source: 'unsubscribe', created_at: '2026-06-01T10:00:00.000Z' }];
  const v = consentDecision(yesRow({}), { priorConsents: withdrawal, suppressed: false, now: NOW });
  assert.equal(v.setFlag, false);
  assert.equal(v.withheld, true);
  assert.equal(v.write, false, 'and no row at all, because the only date we could put on it is now');
});

test('a marketing_suppressions row is a stop, whatever the consent ledger says', () => {
  const v = consentDecision(yesRow({ opt_in_date: '2025-04-12' }), { priorConsents: [], suppressed: true, now: NOW });
  assert.equal(v.setFlag, false);
  assert.equal(v.withheld, true);
});

test('a withdrawal OLDER than the file does not block the yes', () => {
  const old = [{ customer_id: 'cust-1', consented: false, source: 'unsubscribe', created_at: '2024-01-01T10:00:00.000Z' }];
  const v = consentDecision(yesRow({ opt_in_date: '2025-04-12' }), { priorConsents: old, suppressed: false, now: NOW });
  assert.equal(v.setFlag, true, 'they opted back in after the no, and the file proves it');
  assert.equal(v.withheld, false);
});

test('1: a NO in the file writes nothing at all, and a blank is never a consent row', () => {
  for (const currentFlag of [true, false, null]) {
    const no = consentDecision(row({ name: 'A', phone: '07700900123', marketing_opt_in: 'no' }), { priorConsents: [], suppressed: false, currentFlag, now: NOW });
    assert.equal(no.write, false, 'no consent row, whatever they said here (' + currentFlag + ')');
    assert.equal(no.setFlag, false);
    assert.equal(no.withheld, false, 'nothing held back, and nothing named');
  }
  assert.equal(consentDecision(row({ name: 'A', phone: '07700900123' }), { priorConsents: [], suppressed: false, now: NOW }), null);
});

test('a withheld yes never turns the flag on, on an update OR on a new row', () => {
  const r = yesRow({ opt_in_date: '2025-04-12' });
  const patch = buildPatch(r, { id: 'cust-1', name: 'Jane', marketing_opt_in: false, sources: [] }, CTX, { allowOptIn: false });
  assert.equal('marketing_opt_in' in (patch || {}), false, 'the flag is left exactly as it is');
  const insert = buildInsert(r, CTX, { allowOptIn: false });
  assert.equal(insert.marketing_opt_in, false, 'a brand new row for somebody on the stop list starts opted out');
  assert.equal(insert.marketing_opt_in_at, null);
  // And with nothing in the way, the yes lands as it always did.
  assert.equal(buildInsert(r, CTX).marketing_opt_in, true);
  assert.equal(buildPatch(r, { id: 'cust-1', name: 'Jane', marketing_opt_in: false, sources: [] }, CTX).marketing_opt_in, true);
});

test('the consent row carries the date the decision gave it', () => {
  const v = consentDecision(yesRow({ opt_in_date: '2025-04-12' }), { priorConsents: [], suppressed: false, now: NOW });
  const consent = buildConsent(yesRow({ opt_in_date: '2025-04-12' }), { ...CONSENT_ARGS, createdAt: v.createdAt });
  assert.equal(consent.created_at, v.createdAt);
  // And with no date given it is still now, which is what it always was.
  assert.equal(buildConsent(yesRow({}), CONSENT_ARGS).created_at, NOW);
});

// ── stamps ──────────────────────────────────────────────────────────────────

test('imported stamps are ADDED to the card, so a stamp earned in between is not lost', () => {
  const plan = stampPlan(row({ name: 'A', phone: '07700900123', stamps: '4', rewards_unused: '1' }), { stamps_collected: 2, completed_count: 3 }, 9);
  assert.equal(plan.stampsCollected, 6, 'the two they earned at the till are still there');
  assert.equal(plan.completedCount, 4);
  assert.equal(plan.stampsAdded, 4);
  assert.equal(plan.rewardsAdded, 1);
});

test('a pile bigger than a card rolls over into free ones, the loyalty-earn maths', () => {
  const plan = stampPlan(row({ name: 'A', phone: '07700900123', stamps: '25' }), null, 9);
  assert.equal(plan.completedCount, 2);
  assert.equal(plan.stampsCollected, 7);
  const exact = stampPlan(row({ name: 'A', phone: '07700900123', stamps: '9' }), null, 9);
  assert.equal(exact.completedCount, 1);
  assert.equal(exact.stampsCollected, 0, 'a full card is a free one, not a card sitting at full');
});

test('a card with no stamps set on it cannot spin the rollover forever', () => {
  for (const required of [0, -3, null, undefined, NaN, 'nine']) {
    const plan = stampPlan(row({ name: 'A', phone: '07700900123', stamps: '5' }), null, required);
    assert.ok(Number.isFinite(plan.completedCount) && plan.completedCount >= 0);
    assert.ok(plan.stampsCollected >= 0);
  }
});

test('a row with nothing to add leaves the card exactly as it was', () => {
  const plan = stampPlan(row({ name: 'A', phone: '07700900123' }), { stamps_collected: 5, completed_count: 2 }, 9);
  assert.equal(plan.stampsCollected, 5);
  assert.equal(plan.completedCount, 2);
  assert.equal(plan.stampsAdded, 0);
});

test('anybody an import has already stamped is skipped, whichever run did it', () => {
  const decisions = [
    { rowNumber: 2, verdict: 'update', customerId: 'cust-1', row: row({ name: 'A', phone: '07700900123', stamps: '4' }) },
    { rowNumber: 3, verdict: 'new', customerId: 'cust-2', row: row({ name: 'B', phone: '07700900456', stamps: '2' }) },
    { rowNumber: 4, verdict: 'new', customerId: 'cust-3', row: row({ name: 'C', phone: '07700900789' }) },
    { rowNumber: 5, verdict: 'blocked', customerId: 'cust-4', row: row({ name: 'D', phone: '07700900321', stamps: '9' }) },
    { rowNumber: 6, verdict: 'new', customerId: null, row: row({ name: 'E', phone: '07700900654', stamps: '3' }) },
  ];
  const owed = stampsOwed(decisions, new Set(['cust-1']));
  assert.deepEqual(owed.map((d) => d.customerId), ['cust-2'],
    'already stamped, no stamps, blocked and never written all drop out');
  assert.deepEqual(stampsOwed(decisions, ['cust-1', 'cust-2']).map((d) => d.customerId), []);
  assert.equal(stampsOwed(null, null).length, 0);
});

test('the same file twice adds the stamps once', () => {
  const decisions = [{ rowNumber: 2, verdict: 'new', customerId: 'cust-1', row: row({ name: 'A', phone: '07700900123', stamps: '4' }) }];

  const first = stampsOwed(decisions, new Set());
  assert.equal(first.length, 1);
  const afterFirst = stampPlan(first[0].row, null, 9);
  assert.equal(afterFirst.stampsCollected, 4);

  // The run wrote an import earn row for cust-1, so the second run, even under a
  // brand new batch id, finds it and leaves the balance alone.
  const second = stampsOwed(decisions, new Set(['cust-1']));
  assert.equal(second.length, 0, 'no second helping of free coffee');
});

test('the stamps we did NOT give are handed back, never swallowed', () => {
  // The guard is right. The SILENCE was the bug: a second, corrected export
  // dropped every stamp for everybody already imported and reported success, so
  // the operator had no way of knowing their fix had not landed.
  const decisions = [
    { rowNumber: 2, verdict: 'update', customerId: 'cust-1', row: row({ name: 'A', phone: '07700900123', stamps: '4' }) },
    { rowNumber: 3, verdict: 'update', customerId: 'cust-2', row: row({ name: 'B', phone: '07700900456', stamps: '2' }) },
    { rowNumber: 4, verdict: 'new', customerId: 'cust-3', row: row({ name: 'C', phone: '07700900789', stamps: '9' }) },
    { rowNumber: 5, verdict: 'new', customerId: 'cust-9', row: row({ name: 'D', phone: '07700900321' }) },
  ];
  const done = new Set(['cust-1', 'cust-2']);

  const owed = stampsOwed(decisions, done);
  const left = stampsSkipped(decisions, done);
  assert.deepEqual(owed.map((d) => d.customerId), ['cust-3']);
  assert.deepEqual(left.map((d) => d.customerId), ['cust-1', 'cust-2'], 'named, so the screen can say how many');
  assert.deepEqual(left.map((d) => d.rowNumber), [2, 3]);

  // Nobody is in both lists, and nobody with no stamps is in either.
  const both = owed.filter((d) => left.indexOf(d) >= 0);
  assert.equal(both.length, 0);
  assert.equal(owed.length + left.length, 3, 'the person with no stamps at all is in neither');

  assert.equal(stampsSkipped(null, null).length, 0);
});

test('the line about the cards we left alone says the number out loud', () => {
  assert.equal(alreadyStampedLine(0), '', 'nothing to say when nothing was skipped');
  assert.equal(alreadyStampedLine(1), 'We already imported stamps for 1 of these people, so we left their cards alone.');
  assert.equal(alreadyStampedLine(4), 'We already imported stamps for 4 of these people, so we left their cards alone.');
  assert.ok(!/error|idempot|skip/i.test(alreadyStampedLine(4)), 'plain words, not database words');
  assert.equal(alreadyStampedLine('rubbish'), '');
});

test('the writer counts and reports the cards it left alone', () => {
  const src = read('../../supabase/functions/customer-import/index.ts');
  assert.ok(src.includes('stampsSkipped(decisions, stamped)'), 'it works out who it skipped');
  assert.ok(src.includes('alreadyStampedLine('), 'and turns that into a line');
  assert.ok(src.includes('runNote(progress, alreadyStampedLine(leftAlone.length))'), 'which comes back as a note, not as a row');
  assert.ok(src.includes('chunk: chunkAnswer(progress)'), 'and the answer is built in one place');
  const p = emptyProgress();
  p.alreadyStamped = 4;
  assert.equal(chunkAnswer(p).already_stamped, 4, 'as a number the screen puts in a tile');
  assert.equal(emptyProgress().alreadyStamped, 0);
});

test('the decisions never read a clock of their own', () => {
  // The venue clock invariant: business time is the venue's, so every time and
  // date is handed in. A server clock read in here would stamp a Leeds import
  // with a Los Angeles date.
  const PLAN = read('../../supabase/functions/_shared/customerImportPlan.ts');
  assert.ok(!/new Date\(|Date\.now\(/.test(PLAN), 'no clock read anywhere in the rules');
  assert.equal(buildInsert(row({ name: 'A', phone: '07700900123', marketing_opt_in: 'yes' }), CTX).marketing_opt_in_at, NOW,
    'the time comes from the caller');
});

// ── the guards on the edge function itself ──────────────────────────────────

const FN = read('../../supabase/functions/customer-import/index.ts');

test('the importer only ever uses the service role, never a browser key', () => {
  assert.ok(FN.includes("Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')"), 'Ops writes use the service role');
  assert.ok(FN.includes("Deno.env.get('PLATFORM_SUPABASE_SERVICE_ROLE_KEY')"), 'Platform writes use the service role');
  assert.ok(!/ANON_KEY/.test(FN), 'no anon key anywhere near a customer import');
});

test('G: every action, preview included, is ServOS staff only', () => {
  assert.ok(FN.includes('const auth = await staffAuth(req);'), 'one staff check');
  const check = FN.indexOf('const auth = await staffAuth(req);');
  assert.ok(check < FN.indexOf("if (action === 'context')"), 'before context');
  assert.ok(check < FN.indexOf("if (action === 'preview')"), 'before preview');
  assert.ok(check < FN.indexOf("from('locations')", FN.indexOf('Deno.serve')), 'before anything about the venue is even read');
  assert.ok(!FN.includes("from('user_locations')"), 'a user_locations row, which a venue owner has, is NOT enough any more');
  assert.ok(FN.includes('staffVerdict({ user, role: prof?.role, allowlist: STAFF_EMAILS })'), 'the rule is the pure one below');
  assert.ok(FN.includes('parseStaffEmails(Deno.env.get(STAFF_EMAILS_ENV)'), 'the list comes from the environment');
  assert.equal(STAFF_EMAILS_ENV, 'SERVOS_IMPORT_STAFF_EMAILS');
  assert.ok(!/SERVOS_STAFF_EMAIL_DOMAINS|STAFF_DOMAINS/.test(FN), 'the domain rule is gone');
  assert.ok(FN.includes('if (!STAFF_EMAILS.length) return { ok: false, userId: null, reason: IMPORT_SWITCHED_OFF }'), 'no list, nobody but the service role');
  assert.ok(FN.includes('if (SERVICE_ROLE && token === SERVICE_ROLE)'), 'a service role bearer passes');
  assert.ok(FN.includes('if (!auth.ok) return json({ error: auth.reason'), 'anybody else is a 403');
});

test('4: the staff rule: service role, or a super_admin whose email is EXACTLY on the list', () => {
  const LIST = ['peter@posup.co.uk'];
  const peter = { id: 'u1', email: 'peter@posup.co.uk', email_confirmed_at: '2026-01-01T00:00:00Z' };
  assert.equal(staffVerdict({ serviceRole: true }).ok, true, 'the service role passes with no list at all');
  assert.equal(staffVerdict({ user: peter, role: 'super_admin', allowlist: LIST }).ok, true);
  assert.equal(staffVerdict({ user: { ...peter, email: 'PETER@PosUp.co.uk' }, role: 'super_admin', allowlist: LIST }).ok, true, 'case does not matter');
  assert.equal(staffVerdict({ user: peter, role: 'super_admin', allowlist: 'Neil@posup.co.uk, peter@posup.co.uk ' }).ok, true, 'the raw variable reads too');

  // No list: switched off for everybody but the service role, and said plainly.
  for (const unset of [undefined, null, '', ' , ', []]) {
    const v = staffVerdict({ user: peter, role: 'super_admin', allowlist: unset });
    assert.equal(v.ok, false, 'unset list ' + JSON.stringify(unset));
    assert.equal(v.reason, IMPORT_SWITCHED_OFF);
  }
  assert.match(IMPORT_SWITCHED_OFF, /import is switched off: no staff emails configured/i);

  // Not a super_admin: refused even when on the list.
  assert.equal(staffVerdict({ user: peter, role: 'owner', allowlist: LIST }).ok, false, 'the list alone is not enough');
  assert.equal(staffVerdict({ user: peter, role: null, allowlist: LIST }).ok, false);

  // A super_admin NOT on the list: refused. A ServOS domain proves nothing,
  // because create-user lets a venue owner make a confirmed login for any
  // address; only a named person on the list gets in.
  for (const email of ['someone@serv-os.app', 'owner@posup.co.uk', 'peter@posup.co.uk.evil.com', 'xpeter@posup.co.uk', 'peter@posup.co']) {
    assert.equal(staffVerdict({ user: { ...peter, email }, role: 'super_admin', allowlist: LIST }).ok, false, email);
  }
  const owner = { id: 'u2', email: 'owner@coffeeboy.co.uk', email_confirmed_at: '2026-01-01T00:00:00Z' };
  assert.equal(staffVerdict({ user: owner, role: 'super_admin', allowlist: LIST }).ok, false, 'an owner who made themselves super_admin is still refused');

  // Anonymous, signed out, unconfirmed.
  assert.equal(staffVerdict({ user: { ...peter, is_anonymous: true }, role: 'super_admin', allowlist: LIST }).ok, false);
  assert.equal(staffVerdict({ user: null, role: 'super_admin', allowlist: LIST }).ok, false);
  assert.equal(staffVerdict({ user: { ...peter, email_confirmed_at: null }, role: 'super_admin', allowlist: LIST }).ok, false);
  assert.equal(staffVerdict({}).ok, false);
  for (const v of [staffVerdict({ user: owner, role: 'owner', allowlist: LIST }), staffVerdict({ allowlist: LIST })]) assert.ok(v.reason.length > 0 && v.reason.length < 60);

  assert.deepEqual(parseStaffEmails(' Peter@PosUp.co.uk,,neil@posup.co.uk , peter@posup.co.uk, notanemail '), ['peter@posup.co.uk', 'neil@posup.co.uk']);
  assert.deepEqual(parseStaffEmails(undefined), []);
});

test('G: the venue picked must be in the company picked', () => {
  assert.ok(FN.includes("const pickedOrg = String(body?.org_id ?? '').trim();"), 'the screen says which company it means');
  assert.ok(FN.includes("if (orgId !== pickedOrg) return json({ error: 'That venue is not in the company you picked."), 'and a mismatch stops everything');
});

test('preview writes nothing at all', () => {
  const preview = FN.indexOf("if (action === 'preview')");
  assert.ok(preview > 0, 'there is a preview branch');
  for (const write of ['.insert(', '.upsert(', '.update(', '.delete(']) {
    const at = FN.indexOf(write);
    assert.ok(at === -1 || at > preview, 'preview returns before the first ' + write);
  }
});

test('nothing is written when the stamp card is missing or somebody elses', () => {
  const refusal = FN.indexOf('if (!programVerdict.ok) return json');
  assert.ok(refusal > 0, 'the run is refused on a bad stamp card');
  for (const write of ['.insert(', '.upsert(', '.update(']) {
    assert.ok(FN.indexOf(write) > refusal, 'the refusal comes before the first ' + write);
  }
  assert.ok(FN.includes("programmeCheck({ rows: ready, programId, program, companyId })"), 'the card is checked against this company');
});

test('the importer never deletes anything', () => {
  assert.ok(!FN.includes('.delete('), 'no import ever deletes a customer, a consent or a stamp');
});

test('a bulk patch that is refused is SAID, never quietly swallowed', () => {
  // The bulk upsert used to raise 23502 on every group with no name in it,
  // because customers.name is NOT NULL and Postgres constraint checks the
  // tuple an upsert PROPOSES before ON CONFLICT is resolved. Every error was
  // treated alike, so the whole file silently degraded to one request per
  // customer and nobody ever saw why.
  const bulk = FN.indexOf("from('customers').upsert(slice, { onConflict: 'id' })");
  assert.ok(bulk > 0, 'the bulk write is still the fast path');
  const after = FN.slice(bulk, bulk + 1200);
  assert.ok(/runNote\(progress, 'We had to fill in/.test(after), 'a refused bulk write is reported, as a note about the run');
  assert.ok(after.indexOf('runNote(') < after.indexOf("from('customers').update("),
    'the reason is said out loud FIRST, then we go row by row');
  assert.ok(after.includes(".eq('id', id).eq('org_id', orgId)"), 'and the row by row path is a real update, fenced to this tenant');
});

test('the tenant fence is on the one at a time update, not carried in the row', () => {
  const bulk = FN.indexOf("from('customers').upsert(slice, { onConflict: 'id' })");
  const after = FN.slice(bulk, bulk + 1200);
  assert.ok(/org_id: _org/.test(after), 'org_id comes off the patch and goes into the where clause');
});

test('the importer never writes a no over an existing opt in', () => {
  // The only two mentions in the whole function are the header comment and the
  // list of columns we READ to compare against. Nothing in here assigns one.
  assert.ok(!/marketing_opt_in\s*[:=]/.test(FN), 'the opt in columns are only ever set by the plan module, which only ever sets true');
  assert.ok(!/marketing_opt_in.*false/.test(FN), 'nothing here writes a no over an opt in');
  assert.ok(FN.includes('buildPatch'), 'an update is built by the plan module, which fills blanks only');
});

test('stamps are claimed before they are given, and only once', () => {
  assert.ok(FN.includes('STAMP_KEY_PREFIX'), 'we look for any earlier import stamp for this programme');
  assert.ok(FN.includes("like('idempotency_key', STAMP_KEY_PREFIX + '%')"), 'the search is by prefix, so a fresh batch id cannot double a balance');
  assert.ok(FN.includes('stampKey(batchId, d.customerId, programId)'), 'each row carries its own unique key');
  const ledger = FN.indexOf("from('stamp_transactions').insert(ledger)");
  const card = FN.indexOf("from('customer_stamp_cards')\n          .upsert(payload");
  assert.ok(ledger > 0 && card > ledger, 'the ledger row is claimed BEFORE the card moves');
});

test('a new customer id is matched back to that person, never by position', () => {
  // Getting this wrong would put one customer's stamps on another customer's card.
  assert.ok(FN.includes('idByPhone') && FN.includes('idByEmail'), 'ids come back keyed by the persons own phone or email');
  assert.ok(!/data\[i\]\.id/.test(FN), 'nothing trusts the position of a row in the answer');
  assert.ok(FN.includes('if (!id) id = (await reReadOne(orgId, d.row))?.id ?? null'), 'a person we cannot map is read back, never inserted a second time');
});

test('a row refused for one reason does not lose the other ninety nine', () => {
  assert.ok(FN.includes('for (const d of slice)'), 'a refused slice is retried one row at a time');
  assert.ok(FN.includes('if (oneErr && isDuplicate(oneErr))'), 'a row that already exists becomes an update');
  assert.ok(FN.includes("d.verdict = 'update'"), 'and is patched with the same blanks only rule');
});

test('a file bigger than one call is refused with a number, not a crash', () => {
  assert.ok(FN.includes('rawRows.length > MAX_ROWS_PER_CALL'), 'an oversized call is refused');
  assert.ok(FN.includes('Send up to ${MAX_ROWS_PER_CALL} rows at a time.'), 'and says how many to send');
  assert.ok(FN.includes('chunk_index'), 'each call reports which slice it was');
  assert.ok(FN.includes('batch_id: batchId'), 'every call answers with the batch id the next call must send');
});

test('the operator has to say where these people opted in', () => {
  assert.ok(FN.includes("code: 'consent_text'"), 'an import with an opt in answer and no sentence is refused');
  assert.ok(FN.includes("method: 'imported_optin'") || FN.includes('buildConsent'), 'consent rows are built by the plan module');
});

// ── the migration ───────────────────────────────────────────────────────────

const MIGRATION = read('../../supabase/migrations/20260918_OPS_customer_import_batches.sql');

test('the batch table migration is idempotent and hand run by Peter', () => {
  assert.ok(/OPS project \(tbetcegmszzotrwdtqhi\)/.test(MIGRATION), 'the header names the project');
  assert.ok(/Peter runs this by hand/i.test(MIGRATION), 'the header says who runs it');
  assert.ok(/create table if not exists public\.import_batches/.test(MIGRATION));
  assert.ok(/create index if not exists/.test(MIGRATION));
  assert.ok(/drop policy if exists import_batches_read/.test(MIGRATION), 'policies are dropped before they are added');
  assert.ok(/enable row level security/.test(MIGRATION));
  for (const column of ['org_id', 'company_id', 'program_id', 'filename', 'row_count', 'created_count', 'updated_count', 'skipped_count', 'created_by', 'created_at', 'notes']) {
    assert.ok(new RegExp('\\n\\s+' + column + '\\s').test(MIGRATION), 'the table has ' + column);
  }
});

test('5: no record, no import: the import refuses without the batch table, preview still works', () => {
  assert.deepEqual(batchTableGate('import', false), { ok: false, message: BATCH_TABLE_MISSING });
  assert.deepEqual(batchTableGate('import', undefined), { ok: false, message: BATCH_TABLE_MISSING }, 'not known is not there');
  assert.equal(batchTableGate('import', true).ok, true);
  assert.equal(batchTableGate('preview', false).ok, true, 'preview writes nothing, so it still runs');
  assert.equal(batchTableGate('context', false).ok, true);
  assert.equal(BATCH_TABLE_MISSING, 'Run the import_batches migration first.');

  assert.ok(FN.includes('function tableMissing'), 'a missing table is recognised');
  assert.ok(FN.includes("code === '42P01'") && FN.includes("code === 'PGRST205'"), 'both ways Postgres and PostgREST say it');
  assert.ok(FN.includes('batch_table: batchTable'), 'context tells the screen');
  // The refusal is BEFORE the first customer write, and after the preview return.
  const refusal = FN.indexOf("if (!gate.ok) return json({ error: gate.message, code: 'batch_table' }, 409);");
  assert.ok(refusal > 0, 'the import is refused with the plain line');
  assert.ok(refusal > FN.indexOf("if (action === 'preview')"), 'preview has already answered by then');
  assert.ok(refusal < FN.indexOf("from('customers').insert("), 'before any person is written');
  assert.ok(refusal < FN.indexOf("from('customer_consents').insert("), 'before any consent');
  assert.ok(refusal < FN.indexOf("from('stamp_transactions').insert("), 'before any stamp');
  assert.ok(!/batchTable = false;\n\s+\}\s*else \{\n\s+\/\/ A batch id is a uuid/.test(FN), 'the old carry on without a record is gone');
});

// ── C: a withdrawal made HERE, through the only two paths this app has ───────

test('C: an existing marketing_opt_in false holds a file yes back, and only a real withdrawal is called one', () => {
  // Back Office (staff untick Marketing) and the loyalty portal toggle write
  // ONLY customers.marketing_opt_in = false, and leave marketing_opt_in_at,
  // which every path that switches somebody ON stamps. So false WITH a time is
  // "was on, then switched off here".
  for (const fileDay of ['2025-04-12', '']) {
    const v = consentDecision(yesRow({ opt_in_date: fileDay }), { priorConsents: [], suppressed: false, currentFlag: false, currentFlagAt: '2025-01-01T00:00:00Z', now: NOW });
    assert.equal(v.withheld, true, 'held back, file dated ' + JSON.stringify(fileDay));
    assert.equal(v.kind, 'withdrawn');
    assert.equal(v.setFlag, false, 'the flag stays off');
    assert.equal(v.write, false, 'and no yes row: marketing-send reads the ledger FIRST, so any yes row would switch them back on');
    assert.match(v.reason, /switched marketing off here/);
  }
  // false with NO time is the column default: never opted in, never said stop.
  for (const fileDay of ['2025-04-12', '']) {
    const v = consentDecision(yesRow({ opt_in_date: fileDay }), { priorConsents: [], suppressed: false, currentFlag: false, currentFlagAt: null, now: NOW });
    assert.equal(v.withheld, true, 'round three rule kept: still held back');
    assert.equal(v.kind, 'not_opted_in');
    assert.equal(v.setFlag, false);
    assert.equal(v.write, false);
    assert.doesNotMatch(v.reason, /switched|said stop/, 'we do not claim they said stop');
    assert.match(v.reason, /Not opted in here, so the file's yes was not applied/);
  }
  // A ledger no or a suppression IS a withdrawal, whatever the flag says.
  const ledgerNo = consentDecision(yesRow({}), { priorConsents: [{ consented: false, created_at: '2026-01-01T00:00:00Z' }], currentFlag: false, now: NOW });
  assert.equal(ledgerNo.kind, 'withdrawn');
  assert.equal(consentDecision(yesRow({}), { suppressed: true, currentFlag: null, now: NOW }).kind, 'withdrawn');
  // Somebody who never said anything (null) is not a withdrawal.
  const never = consentDecision(yesRow({ opt_in_date: '2025-04-12' }), { priorConsents: [], suppressed: false, currentFlag: null, now: NOW });
  assert.equal(never.setFlag, true);
  // A no in the file for somebody switched off writes nothing either.
  const no = consentDecision(row({ name: 'A', phone: '07700900123', marketing_opt_in: 'no' }), { priorConsents: [], currentFlag: false, now: NOW });
  assert.equal(no.withheld, false);
  assert.equal(no.write, false);
});

test('C: the patch for a switched off customer never turns the flag back on', () => {
  const was = { id: 'cust-1', name: 'Jane', marketing_opt_in: false, sources: [] };
  const v = consentDecision(yesRow({ opt_in_date: '2025-04-12' }), { priorConsents: [], currentFlag: was.marketing_opt_in, now: NOW });
  const patch = buildPatch(yesRow({ opt_in_date: '2025-04-12' }), was, CTX, { allowOptIn: !v || v.setFlag });
  assert.equal('marketing_opt_in' in (patch || {}), false);
});

test('C: the edge function hands the current flag to the rule and names the rows', () => {
  assert.ok(FN.includes("currentFlag: was ? (was.marketing_opt_in ?? null) : null"), 'the flag it already read is used');
  assert.ok(FN.includes('marketing_opt_in, marketing_opt_in_at'), 'and it is one of the columns read');
  assert.ok(FN.includes("currentFlagAt: was ? (was.marketing_opt_in_at ?? null) : null"), 'and when it was switched on, which tells a withdrawal from a default');
  assert.ok(FN.includes('withheld.push({ rowNumber: d.rowNumber, name: d.row.name, kind: verdict.kind })'), 'by row, by name and by kind');
  assert.ok(FN.includes('for (const line of withheldLines(withheld)) runNote(progress, line);'));
  const lines = withheldLines([
    { rowNumber: 14, name: 'Jane Smith', kind: 'withdrawn' },
    { rowNumber: 20, name: 'Bob Jones', kind: 'not_opted_in' },
    { rowNumber: 21, name: 'Ann Lee', kind: 'not_opted_in' },
  ]);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /1 person who switched it off here/);
  assert.match(lines[0], /row 14 \(Jane Smith\)/);
  assert.doesNotMatch(lines[0], /Bob Jones/);
  assert.match(lines[1], /^2 people are not opted in here, so the file's yes was not applied: row 20 \(Bob Jones\), row 21 \(Ann Lee\)\.$/);
  assert.doesNotMatch(lines[1], /said stop|switched/, 'a default false is never called a stop');
  assert.deepEqual(withheldLines([]), []);
  assert.equal(withheldLine([]), '');
});

// ── E: two rows, one customer ───────────────────────────────────────────────

test('E: row A by phone and row B by email on ONE customer: the second is left out and named', () => {
  const existing = [{ id: 'cust-1', phone: '+447700900123', email: 'jane@example.com', name: 'Jane' }];
  const a = normaliseRow({ rowNumber: 2, name: 'Jane', phone: '07700 900123', email: 'other@example.com' }, OPTS);
  const b = normaliseRow({ rowNumber: 3, name: 'Jane S', email: 'jane@example.com' }, OPTS);
  const [da, db] = decideRows([a, b], existing, GB);
  assert.equal(da.verdict, 'update');
  assert.equal(da.customerId, 'cust-1');
  assert.equal(db.verdict, 'blocked', 'never a second patch for the same customer');
  assert.equal(db.sameAs, 2);
  assert.equal(db.reason, sameAsReason(2));
  assert.match(db.reason, /Same person as row 2/);
  assert.equal(screenSameAsReason(2), sameAsReason(2), 'the screen says exactly what the server says');
  // Deciding again on its own output keeps the same answer.
  assert.deepEqual(decideRows([da, db], existing, GB).map((d) => d.verdict), ['update', 'blocked']);
});

test('E: patches are collapsed to ONE per customer before grouping, so 21000 cannot happen', () => {
  const groups = groupPatches([
    { id: 'c1', org_id: ORG, name: 'Jane', sources: ['a'] },
    { id: 'c1', org_id: ORG, name: 'Other', email: 'x@y.com' },
    { id: 'c2', org_id: ORG, name: 'Bob', sources: ['b'] },
  ]);
  const ids = groups.flat().map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, 'no id twice in any write');
  const c1 = groups.flat().find((p) => p.id === 'c1');
  assert.equal(c1.name, 'Jane', 'the first patch wins what it has');
  assert.equal(c1.email, 'x@y.com', 'a later one only adds what the first did not touch');
  assert.deepEqual(collapsePatches(null), []);
});

// ── F: counting honestly ────────────────────────────────────────────────────

test('F: run notes and row failures are kept apart, and only rows are rows', () => {
  const p = emptyProgress();
  skipRow(p, 5, 'Same person as row 2.');
  failRow(p, 9, 'We could not add this person.');
  runNote(p, 'Loyalty is switched off for this company.');
  runNote(p, 'Loyalty is switched off for this company.');
  runNote(p, '');
  const answer = chunkAnswer(p);
  assert.equal(answer.skipped, 1);
  assert.deepEqual(answer.skipped_rows, [{ row_number: 5, reason: 'Same person as row 2.' }]);
  assert.deepEqual(answer.failed, [{ row_number: 9, reason: 'We could not add this person.' }]);
  assert.deepEqual(answer.notes, ['Loyalty is switched off for this company.'], 'said once, never counted');
  assert.ok(!('errors' in answer), 'no mixed list of rows and run lines any more');
});

test('F: updated is counted when the write lands, never when the patch is built', () => {
  assert.ok(!/patches\.push\(patch\);\s*\n\s*progress\.updated\+\+/.test(FN), 'not when the patch is built');
  assert.ok(FN.includes('if (!error) { progress.updated += slice.length; continue; }'), 'the bulk write landed');
  assert.ok(FN.includes('if (!oneErr) { progress.updated++; continue; }'), 'or the one at a time write landed');
  assert.ok(!FN.includes('progress.errors'), 'nothing mixes run lines into the row list');
});

// ── B: the batch row ────────────────────────────────────────────────────────

test('B: the batch row is written on EVERY chunk, as an upsert on the id the screen sent', () => {
  assert.ok(!FN.includes('if (!body?.batch_id)'), 'the old never-true first chunk test is gone');
  assert.ok(FN.includes("from('import_batches')\n      .upsert(batchRecord("), 'an upsert');
  assert.ok(FN.includes("{ onConflict: 'id', ignoreDuplicates: true }"), 'that never overwrites the row a first chunk made');
  assert.ok(FN.includes('userId: auth.userId'), 'recording the ServOS staff member who ran it');
  assert.ok(FN.includes('if (!isBatchId(batchId)) return json('), 'a batch id that is not a uuid is refused before anything is written');
  assert.ok(FN.includes("if (String(mine.org_id) !== orgId)"), 'another company\'s batch id is refused');
  const rec = batchRecord({ batchId: BATCH, orgId: ORG, companyId: 'co', programId: null, filename: 'coffeeboy.csv', userId: 'staff-1', consentText: 'Imported from 5Loyalty.' });
  assert.equal(rec.id, BATCH);
  assert.equal(rec.org_id, ORG);
  assert.equal(rec.created_by, 'staff-1');
  assert.equal(rec.filename, 'coffeeboy.csv');
  assert.equal(rec.notes, 'Imported from 5Loyalty.');
  assert.equal(isBatchId(BATCH), true);
  assert.equal(isBatchId('imp-abc-123'), false);
  assert.equal(isBatchId(''), false);
});

test('B: the totals update finds the row, because the row now exists', () => {
  const up = FN.indexOf("from('import_batches')\n      .upsert(");
  const totals = FN.indexOf(".update(totals).eq('id', batchId).eq('org_id', orgId)");
  assert.ok(up > 0 && totals > up, 'written first, totalled last');
  assert.ok(FN.includes('We could not find the record of this import'), 'and if it is somehow not there, that is said, not swallowed');
});

// ── 2: erased people stay erased ────────────────────────────────────────────

test('2: a row that is somebody deleted here is left out by name, on every key, and never made again', () => {
  const gone = { id: 'cust-gone', name: 'Deleted Dan', phone: '+447700900123', phone_raw: '07700 900123', email: 'dan@example.com', deleted_at: '2026-08-01T10:00:00Z' };
  const cases = [
    { name: 'Dan', phone: '07700900123' },                        // by phone
    { name: 'Dan', phone: '7.7009E9' },                            // (refused cell, so by email below)
    { name: 'Dan', email: 'DAN@example.com' },                     // by email
    { name: 'Dan', phone: '+44 7700 900123', email: 'new@example.com' }, // by phone, with a new email
  ];
  for (const fields of cases) {
    const r = normaliseRow({ rowNumber: 7, ...fields }, OPTS);
    if (r.problems.length) continue;
    const [d] = decideRows([r], [gone], GB);
    assert.equal(d.verdict, 'blocked', JSON.stringify(fields));
    assert.equal(d.deleted, true);
    assert.equal(d.customerId, null, 'nothing downstream can touch the deleted row');
    assert.equal(d.reason, DELETED_REASON);
  }
  // By the typed phone_raw alone.
  const rawOnly = decideRows([normaliseRow({ rowNumber: 8, name: 'Dan', phone: '07700 900123' }, OPTS)],
    [{ ...gone, phone: null }], GB);
  assert.equal(rawOnly[0].deleted, true);

  // A deleted row never matches as an update, even when a live row shares nothing.
  const live = { id: 'cust-live', name: 'Live Liz', phone: '+447700900999', email: 'liz@example.com' };
  const ds = decideRows([
    normaliseRow({ rowNumber: 2, name: 'Liz', phone: '07700 900999' }, OPTS),
    normaliseRow({ rowNumber: 3, name: 'Dan', phone: '07700 900123' }, OPTS),
    normaliseRow({ rowNumber: 4, name: 'Newbie', phone: '07700 900555' }, OPTS),
  ], [live, gone], GB);
  assert.deepEqual(ds.map((d) => d.verdict), ['update', 'blocked', 'new']);
  assert.equal(ds[1].deleted, true);
  assert.equal(ds[0].deleted, undefined);

  assert.equal(deletedLine([{ rowNumber: 3, name: 'Deleted Dan' }, { rowNumber: 9, name: '' }]),
    'Left out because they were deleted here: row 3 (Deleted Dan), row 9 (no name).');
  assert.equal(deletedLine([]), '');
});

test('2: the edge function reads deleted customers too, and names them in the run note', () => {
  const read = FN.slice(FN.indexOf('async function readExisting('), FN.indexOf('async function reReadOne('));
  assert.ok(!read.includes("is('deleted_at', null)"), 'readExisting no longer hides deleted people from the matcher');
  assert.ok(FN.includes('marketing_opt_in_at, deleted_at'), 'deleted_at is one of the columns read');
  assert.ok(FN.includes('runNote(progress, deletedLine(gone));'), 'named in the run note');
  assert.ok(FN.includes('deleted: d.deleted === true'), 'the preview says which rows are deleted people');
  assert.ok(!/deleted_at\s*:\s*null/.test(FN), 'nothing ever un-deletes');
});

// ── 3: phone_raw is the repaired number ─────────────────────────────────────

test('3: phone_raw is written as a clean number from a mangled cell, never the spreadsheet damage', () => {
  for (const cell of ['7.954412324E9', '7954412324', "'+447954412324", '0044 7954 412324', '447954412324', '07954412324', '+44 (0)7954 412324', '7954412324.0']) {
    const r = normaliseRow({ name: 'Jane', phone: cell }, OPTS);
    assert.deepEqual(r.problems, [], cell);
    const insert = buildInsert(r, CTX);
    assert.equal(insert.phone, '+447954412324', cell);
    assert.equal(insert.phone_raw, '07954 412324', cell + ' is written the way a person types it');
    const patch = buildPatch(r, { id: 'c', name: 'Jane', phone: null, sources: [] }, CTX);
    assert.equal(patch.phone_raw, '07954 412324', cell + ' on a patch too');
  }
  // Landlines and the US.
  assert.equal(phoneRawFor(normaliseRow({ phone: '1614960000' }, OPTS), 'GB'), '0161 496 0000');
  assert.equal(phoneRawFor(normaliseRow({ phone: '02079460100' }, OPTS), 'GB'), '020 7946 0100');
  assert.equal(phoneRawFor(normaliseRow({ phone: '4155550123' }, { today: OPTS.today, country: 'US' }), 'US'), '(415) 555-0123');
  assert.equal(phoneRawFor(normaliseRow({ phone: '+353 86 123 4567' }, OPTS), 'GB'), '+353861234567', 'not a UK number: the number we store');
  assert.equal(phoneRawFor(normaliseRow({ email: 'a@b.com' }, OPTS), 'GB'), '', 'no phone, no phone_raw');
});

test('3: the damaged cell is still a MATCH key against a phone_raw typed that way', () => {
  const r = normaliseRow({ rowNumber: 2, name: 'Jane', phone: '7.954412324E9' }, OPTS);
  const keys = lookupKeys([r]);
  assert.ok(keys.raws.includes('7.954412324E9'), 'the cell as the file wrote it');
  assert.ok(keys.raws.includes('07954 412324'), 'and the clean form this importer writes');
  const [d] = decideRows([r], [{ id: 'old', phone: null, phone_raw: '7.954412324E9', name: 'Jane' }], GB);
  assert.equal(d.customerId, 'old');
});

test('3: a later import corrects a damaged phone_raw it wrote itself, and never one typed at the till', () => {
  const r = normaliseRow({ name: 'Jane', phone: '07954 412324' }, OPTS);
  const imported = { id: 'c', name: 'Jane', phone: '+447954412324', source: IMPORT_SOURCE, sources: [IMPORT_SOURCE] };
  for (const damage of ['7.954412324E9', '7954412324', "'+447954412324", '0044 7954 412324', '447954412324']) {
    assert.equal(damagedPhoneRaw(damage, r, 'GB'), true, damage);
    const patch = buildPatch(r, { ...imported, phone_raw: damage }, CTX);
    assert.equal(patch.phone_raw, '07954 412324', damage + ' is put right');
    assert.deepEqual(patchChanges(patch, { ...imported, phone_raw: damage }), ['phone_raw']);
  }
  // Clean, or somebody else's typing, or a till customer: left exactly alone.
  for (const kept of ['07954 412324', '07954412324', '+44 7954 412324']) {
    assert.equal(buildPatch(r, { ...imported, phone_raw: kept }, CTX), null, kept + ' is clean');
  }
  assert.equal(buildPatch(r, { ...imported, source: 'pos', sources: ['pos'], phone_raw: '7954412324' }, CTX), null,
    'a till customer\'s phone_raw is theirs, even when it looks odd');
  assert.equal(damagedPhoneRaw('07700 900123', r, 'GB'), false, 'a different number is never "corrected"');
});

// ── 6a: filled in means filled in ───────────────────────────────────────────

test('6a: a person whose only change would be the batch tag is already up to date, not filled in', () => {
  const r = normaliseRow({ name: 'Jane', phone: '07700 900123', email: 'jane@example.com', marketing_opt_in: 'no' }, OPTS);
  const had = { id: 'c', name: 'Jane', phone: '+447700900123', phone_raw: '07700 900123', email: 'jane@example.com', source: IMPORT_SOURCE, sources: [IMPORT_SOURCE, 'import:some-older-batch'], marketing_opt_in: false };
  assert.equal(buildPatch(r, had, CTX), null, 'a NEW batch id alone is not a change');
  assert.equal(buildPatch(r, { ...had, source: null, sources: [] }, CTX), null, 'nor is the source column');
  assert.deepEqual(patchChanges(null), []);
  assert.deepEqual(patchChanges({ id: 'c', org_id: ORG, updated_at: NOW, sources: ['x'], source: 'import', name: 'Jane' }, had), [],
    'bookkeeping and the name read back are not changes');
  assert.deepEqual(patchChanges({ id: 'c', name: 'Jane Smith' }, { id: 'c', name: '' }), ['name'], 'a blank name filled IS a change');
  assert.ok(FN.includes('if (!patch || !patchChanges(patch, was).length) { progress.upToDate++; continue; }'), 'the writer counts them apart');
  const p = emptyProgress();
  assert.equal(p.upToDate, 0);
  assert.equal(chunkAnswer(p).up_to_date, 0);
});

// ── 6c: the country ─────────────────────────────────────────────────────────

test('6c: the edge function prefers the country and the Platform currency, and the Ops currency is last', () => {
  const fn = FN.slice(FN.indexOf('async function venueCountry('), FN.indexOf('async function readExisting('));
  assert.ok(fn.includes('countryFromVenue({ country, platformCountry, platformCurrency, opsCurrency })'));
  assert.ok(FN.includes('country_source: country.source'), 'and the screen is told where it came from');
});

test('2: emails are read case blind, so a deleted Jane@Example.com is found by jane@example.com', () => {
  assert.equal(emailIlikeFilter(['jane@example.com', 'Bob.Smith@Example.co.uk', '', null]),
    'email.ilike."jane@example.com",email.ilike."bob.smith@example.co.uk"');
  assert.equal(emailIlikeFilter(['a"b@x.com']), 'email.ilike."a\\"b@x.com"', 'a quote cannot break out of the value');
  assert.equal(emailIlikeFilter(null), '');
  assert.ok(EMAIL_READ_CHUNK <= 50, 'the URL stays short');
  const read = FN.slice(FN.indexOf('async function readExisting('), FN.indexOf('async function reReadOne('));
  assert.ok(read.includes('.or(emailIlikeFilter(slice))'), 'the email arm uses it');
  assert.ok(!read.includes(".in('email', slice)"), 'and no longer compares exactly');
  // And the matcher itself is case blind on what it reads back.
  const r = normaliseRow({ rowNumber: 2, name: 'Jane', email: 'jane@example.com' }, OPTS);
  const [d] = decideRows([r], [{ id: 'gone', name: 'Jane', email: 'Jane@Example.COM', deleted_at: '2026-08-01T00:00:00Z' }], GB);
  assert.equal(d.deleted, true);
});
