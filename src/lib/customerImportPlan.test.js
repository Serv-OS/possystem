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
  buildInsert, buildPatch, groupPatches, buildConsent, consentIsNew,
  stampPlan, stampsOwed,
} from '../../supabase/functions/_shared/customerImportPlan.ts';

const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const BATCH = '7f0a2c1e-1111-4b2a-9c3d-abcdefabcdef';
const ORG = 'cd97f0f0-4807-4e45-801e-56114b22128a';
const NOW = '2026-09-18T09:00:00.000Z';
const CTX = { orgId: ORG, batchId: BATCH, now: NOW };
const OPTS = { today: '2026-09-18' };

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
  ]);
  assert.equal(index.byPhone.get('+447700900123').id, 'a');
  assert.equal(index.byPhone.get('+447700900456').id, 'b', 'a stored 07 number is found by its international form');
  assert.equal(index.byEmail.get('jane@example.com').id, 'a', 'stored case does not matter');
  assert.equal(index.byEmail.get('bob@example.com').id, 'c');
  assert.equal(index.byPhone.size, 2, 'a row with no id is not indexed');
});

test('a lookup asks for each phone and each email once', () => {
  const keys = lookupKeys([
    row({ name: 'A', phone: '07700 900123', email: 'jane@example.com' }),
    row({ name: 'B', phone: '+44 7700 900123', email: 'JANE@EXAMPLE.COM' }),
    row({ name: 'C', phone: '07700900456', email: '' }),
  ]);
  assert.deepEqual(keys.phones, ['+447700900123', '+447700900456']);
  assert.deepEqual(keys.emails, ['jane@example.com']);
  assert.deepEqual(lookupKeys(null), { phones: [], emails: [] });
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

  assert.ok(patch, 'the run tag alone is a change');
  for (const column of ['name', 'first_name', 'last_name', 'email', 'phone', 'phone_raw', 'birthday', 'notes', 'source']) {
    assert.equal(column in patch, false, 'an import must not touch ' + column + ' when it is already set');
  }
  assert.deepEqual(patch.sources, ['pos', IMPORT_SOURCE, 'import:' + BATCH]);
  assert.equal(patch.id, 'cust-1');
  assert.equal(patch.org_id, ORG);
  assert.equal(patch.updated_at, NOW);
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

test('a yes and a no both get a consent row, a blank gets none', () => {
  const yes = buildConsent(row({ name: 'A', phone: '07700900123', marketing_opt_in: 'yes' }), CONSENT_ARGS);
  assert.equal(yes.consented, true);
  assert.equal(yes.source, IMPORT_SOURCE);
  assert.equal(yes.method, 'imported_optin');
  assert.equal(yes.channel, 'both');
  assert.equal(yes.purpose, 'marketing');
  assert.equal(yes.consent_text, CONSENT_ARGS.consentText);
  assert.equal(yes.privacy_version, '2026-01');
  assert.equal(typeof yes.location_id, 'string', 'customer_consents.location_id is text NOT NULL');

  const no = buildConsent(row({ name: 'A', phone: '07700900123', marketing_opt_in: 'no' }), CONSENT_ARGS);
  assert.equal(no.consented, false, 'a no is recorded, not thrown away');

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

test('the caller must have the location, or be super_admin, or be the service role', () => {
  assert.ok(FN.includes("from('user_locations')"), 'a staff token is checked against user_locations');
  assert.ok(FN.includes("prof?.role === 'super_admin'"), 'super_admin is the fallback, same as marketing-admin');
  assert.ok(FN.includes('if (token === SERVICE_ROLE) return'), 'a service role bearer passes');
  assert.ok(FN.includes("if (!auth.ok) return json({ error: 'no access to this location' }, 403)"), 'no access is a 403 and stops there');
});

test('the tenant is resolved server side and never taken from the browser', () => {
  assert.ok(FN.includes("from('locations').select('org_id').eq('id', opsLocationId)"), 'org_id comes from the location');
  assert.ok(FN.includes("select('company_id').eq('ops_location_id', opsLocationId)"), 'company_id comes from the location');
  assert.ok(!/body\??\.\s*org_id|body\[.org_id.\]/.test(FN), 'org_id is never read off the body');
  assert.ok(!/body\??\.\s*company_id|body\[.company_id.\]/.test(FN), 'company_id is never read off the body');
  assert.ok(FN.includes("eq('org_id', orgId)"), 'reads are fenced to the org');
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

test('the app works before the migration is applied', () => {
  assert.ok(FN.includes('function tableMissing'), 'a missing table is recognised');
  assert.ok(FN.includes("code === '42P01'") && FN.includes("code === 'PGRST205'"), 'both ways Postgres and PostgREST say it');
  assert.ok(FN.includes('batchTable = false'), 'and it carries on');
  assert.ok(FN.includes('batch_table: batchTable'), 'the screen is told, so it can say one plain line');
  const missing = FN.indexOf('if (!tableMissing(error)) return json');
  assert.ok(missing > 0, 'a real error still fails, only a missing table is shrugged off');
});
