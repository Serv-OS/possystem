// src/lib/customerImportCoffeeBoy.test.js
//
// THE COFFEE BOY FILE, END TO END. About 8,000 members come off 5Loyalty next
// week. Peter's team will open the export in Google Sheets or Excel, correct
// it, and save it before it is uploaded (Peter, 18 Sep 2026: "We will then edit
// the sheet so its accurate then upload"). So this test feeds TWO files through
// the whole importer:
//
//   1. a file with exactly the shape of the real 5Loyalty export of 17 Sep
//      (7,977 rows, columns name to notes, phones as "07954 412324", 290 blank
//      phones with the original in notes, 283 rows sharing 140 numbers and
//      marked so in notes, external ids "5L-788493", no opt in or sign up
//      dates, every row with an email, 2,876 opted in, stamps at most 9 of 10)
//   2. the same file after a spreadsheet has been at it: a BOM, semicolons,
//      re-typed headers, trailing empty columns, blank rows, phones without
//      their 0 or as 7.954412324E9, dates as 05/09/1984 and 5/9/1984, stamps as
//      2.0, and yes and no as TRUE, FALSE, Yes, Y
//
// The real file holds real people's details and is NOT in the repo. This one is
// built to the same counts, with made up names and example.com emails.
//
// "End to end" here is the screen's side (read, check, ask the server, drop the
// rows it refuses, send the raw cells in slices) and the server's side, run in
// the SAME ORDER as supabase/functions/customer-import/index.ts, with the same
// pure functions, against an in memory database that enforces the two unique
// indexes (org_id, phone) and (org_id, lower(email)), the unique stamp ledger
// key, and Postgres's refusal of a bulk upsert that touches one row twice
// (21000). What it cannot run is Deno and PostgREST themselves.
//
// And importing it TWICE must not double anybody's stamps, rewards or consent.

import test from 'node:test';
import assert from 'node:assert/strict';

import { readCsv, validateRows, rawRowsOnly, rowsToSend, summarise, verdictsByRow, problemRowNumbers } from './customerImport.js';
import {
  CHUNK_SIZE, PREVIEW_CHUNK_SIZE, chunkRows, sameCustomerAcrossFile, mergeResult, resultLine,
} from './customerImportScreen.js';
import {
  lookupKeys, indexExisting, decideRows, buildInsert, buildPatch, groupPatches, buildConsent,
  consentIsNew, consentDecision, stampsOwed, stampsSkipped, stampPlan, stampKey, STAMP_KEY_PREFIX,
  emptyProgress, skipRow, failRow, runNote, chunkAnswer, withheldLine, alreadyStampedLine,
  batchRecord,
} from '../../supabase/functions/_shared/customerImportPlan.ts';

const TODAY = '2026-09-18';
const GB = { country: 'GB' };
const OPTS = { today: TODAY, country: 'GB' };
const ORG = 'cd97f0f0-4807-4e45-801e-56114b22128a';
const COMPANY = 'cd97f0f0-4807-4e45-801e-56114b22128a';
const LOCATION = '1e252e7c-c875-4971-b91d-1e945c26956b';
const PROGRAM = { id: 'prog-coffee', stamps_required: 10 };
const CONSENT_TEXT = 'Imported from 5Loyalty. ServOS staff confirmed these people opted in there and the record can be shown.';

// ── the file, built to the real export's counts ─────────────────────────────

const COLUMNS = ['name', 'first_name', 'last_name', 'phone', 'email', 'stamps', 'rewards_unused', 'marketing_opt_in',
  'opt_in_date', 'opt_in_source', 'signed_up_date', 'birthday', 'external_id', 'notes'];

function lcg(seed) {
  let s = seed;
  return () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
}

function mobile(k) { return '07123 ' + String(400000 + k); }

/** The 7,977 rows, as objects keyed by the template columns. */
function coffeeBoyRows() {
  const kinds = [];
  // 140 numbers on 283 rows: 137 numbers twice, 3 numbers three times.
  for (let n = 0; n < 140; n++) {
    const times = n < 137 ? 2 : 3;
    for (let t = 0; t < times; t++) kinds.push({ kind: 'shared', number: n, times });
  }
  for (let i = 0; i < 290; i++) kinds.push({ kind: 'unusable', i });
  for (let i = 0; i < 940; i++) kinds.push({ kind: 'blank', i });
  for (let i = 0; i < 7; i++) kinds.push({ kind: 'landline', i });
  while (kinds.length < 7977) kinds.push({ kind: 'mobile', i: kinds.length });

  // A fixed shuffle, so the shared rows are spread through the file like the real one.
  const rand = lcg(17);
  for (let i = kinds.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = kinds[i]; kinds[i] = kinds[j]; kinds[j] = t;
  }

  const rows = [];
  let nextMobile = 1000;
  for (let i = 0; i < kinds.length; i++) {
    const k = kinds[i];
    const first = 'Member' + i;
    const last = 'Test';
    let phone = '';
    const notes = [];
    if (k.kind === 'shared') {
      phone = mobile(k.number);
      notes.push('shares this phone with ' + (k.times - 1) + ' other account(s)');
    } else if (k.kind === 'unusable') {
      notes.push('phone in 5Loyalty: ' + (k.i < 137 ? '44' : '79544' + String(k.i).padStart(3, '0')));
    } else if (k.kind === 'landline') {
      phone = k.i < 5 ? '0161 496 0' + String(100 + k.i) : '020 7946 0' + String(100 + k.i);
    } else if (k.kind === 'mobile') {
      phone = mobile(nextMobile++);
    }
    if (i % 15 === 3) notes.unshift((1 + (i % 3)) + ' expired');
    const stamps = (i * 7) % 10;                       // 0 to 9, never a full card of 10
    const rewards = i % 23 === 0 ? 1 + (i % 4) : 0;
    const y = 1950 + (i % 55);
    const m = 1 + (i % 12);
    const d = 1 + (i % 28);
    rows.push({
      name: first + ' ' + last,
      first_name: first,
      last_name: last,
      phone,
      email: 'member' + i + '@example.com',
      stamps: String(stamps),
      rewards_unused: String(rewards),
      marketing_opt_in: 'no',
      opt_in_date: '',
      opt_in_source: '5Loyalty',
      signed_up_date: '',
      birthday: i % 3 === 0 ? '' : y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0'),
      external_id: '5L-' + (780000 + i),
      notes: notes.join(' | '),
    });
  }
  // 2,876 opted in.
  for (let i = 0, yes = 0; i < rows.length && yes < 2876; i += 2) { rows[i].marketing_opt_in = 'yes'; yes++; }
  let yesCount = rows.filter((r) => r.marketing_opt_in === 'yes').length;
  for (let i = 1; yesCount < 2876; i += 2) { rows[i].marketing_opt_in = 'yes'; yesCount++; }
  // The real file has ONE email on five accounts: 5Loyalty's own guest
  // placeholder, on five phone-less, stamp-less, opted out rows. The first goes
  // in; the other four ARE the first as far as the database can tell (same
  // email, no phone) and are left out and named.
  let guests = 0;
  for (let i = rows.length - 1; i >= 0 && guests < 5; i--) {
    const r = rows[i];
    if (r.phone || r.notes || r.marketing_opt_in === 'yes') continue;
    r.email = guests === 0 ? 'guest@example.com' : 'Guest@Example.com';
    r.stamps = '0';
    r.rewards_unused = '0';
    guests++;
  }
  return rows;
}

function cell(v, sep) {
  const s = v == null ? '' : String(v);
  return s.includes(sep) || s.includes('"') || s.includes('\n') ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function cleanCsv(rows) {
  const lines = [COLUMNS.map((c) => cell(c, ',')).join(',')];
  for (const r of rows) lines.push(COLUMNS.map((c) => cell(r[c], ',')).join(','));
  return lines.join('\r\n') + '\r\n';
}

/** The same rows after a spreadsheet: every trick in item H at once. */
function mangledCsv(rows) {
  const header = ['NAME', 'First Name', 'last name', 'Phone', 'E-Mail', 'Stamps', 'Rewards Unused', 'Marketing Opt-In',
    'Opt In Date', 'Opt In Source', 'Signed Up Date', 'Birthday', 'External ID', 'Notes', '', ''];
  const yes = ['TRUE', 'Yes', 'Y', 'yes'];
  const no = ['FALSE', 'No', 'N'];
  const lines = [header.join(';')];
  rows.forEach((r, i) => {
    let phone = r.phone;
    const digits = phone.replace(/\s/g, '');
    if (/^07\d{9}$/.test(digits)) {
      const bare = digits.slice(1);
      if (i % 3 === 0) phone = bare;                                            // Excel ate the 0
      else if (i % 3 === 1) phone = bare.charAt(0) + '.' + bare.slice(1) + 'E9'; // and wrote it as a number
    } else if (/^0\d{10}$/.test(digits)) {
      phone = digits.slice(1);                                                  // a landline without its 0
    }
    let birthday = r.birthday;
    if (birthday) {
      const [y, m, d] = birthday.split('-');
      birthday = i % 2 ? d + '/' + m + '/' + y : Number(d) + '/' + Number(m) + '/' + y;
    }
    const cells = [
      r.name, r.first_name, r.last_name, phone, r.email,
      r.stamps + '.0', r.rewards_unused === '0' ? '0' : r.rewards_unused + '.0',
      r.marketing_opt_in === 'yes' ? yes[i % yes.length] : no[i % no.length],
      r.opt_in_date, r.opt_in_source, r.signed_up_date, birthday, r.external_id, r.notes, '', '',
    ];
    lines.push(cells.map((c) => cell(c, ';')).join(';'));
    if (i % 400 === 399) lines.push(';;;;;;;;;;;;;;;');                        // a blank row
  });
  return '﻿' + lines.join('\r\n') + '\r\n;;;;;;;;;;;;;;;\r\n';
}

const ROWS = coffeeBoyRows();
const CLEAN = cleanCsv(ROWS);
const MANGLED = mangledCsv(ROWS);

// ── an in memory database with the live unique indexes ──────────────────────

function newDb() {
  return {
    customers: [],
    consents: [],
    stampTx: [],
    cards: new Map(),          // customer id -> { stamps_collected, completed_count }
    members: new Set(),
    suppressions: new Set(),
    batches: new Map(),
    seq: 0,
  };
}

function uniqueClash(db, row, exceptId) {
  for (const c of db.customers) {
    if (c.id === exceptId) continue;
    if (row.phone && c.phone === row.phone) return true;
    if (row.email && c.email && String(c.email).toLowerCase() === String(row.email).toLowerCase()) return true;
  }
  return false;
}

function insertCustomer(db, payload) {
  if (uniqueClash(db, payload, null)) { const e = new Error('duplicate key value'); e.code = '23505'; throw e; }
  const row = { ...payload, id: 'cust-' + (++db.seq) };
  db.customers.push(row);
  return row;
}

/** One bulk upsert on id. Postgres refuses the whole statement if it touches a row twice. */
function upsertCustomers(db, slice) {
  const ids = slice.map((p) => p.id);
  if (new Set(ids).size !== ids.length) { const e = new Error('ON CONFLICT DO UPDATE command cannot affect row a second time'); e.code = '21000'; throw e; }
  for (const p of slice) {
    const c = db.customers.find((x) => x.id === p.id);
    if (uniqueClash(db, { ...c, ...p }, c.id)) { const e = new Error('duplicate key value'); e.code = '23505'; throw e; }
  }
  for (const p of slice) Object.assign(db.customers.find((x) => x.id === p.id), p);
}

// ── the server: one import call, in the order index.ts does it ──────────────

function readExisting(db, ready) {
  const { phones, raws, emails } = lookupKeys(ready);
  const P = new Set(phones);
  const R = new Set(raws);
  const E = new Set(emails);
  return db.customers.filter((c) => (c.phone && P.has(c.phone)) || (c.phone_raw && R.has(c.phone_raw)) || (c.email && E.has(c.email)));
}

function serverPreview(db, rows) {
  const checked = validateRows(rawRowsOnly(rows), OPTS);
  const existing = readExisting(db, checked.ready);
  return decideRows(checked.ready, indexExisting(existing, GB), GB)
    .map((d) => ({ row_number: d.rowNumber, verdict: d.verdict, reason: d.reason, customer_id: d.customerId }));
}

function serverImport(db, body) {
  const now = '2026-09-18T09:00:00.000Z';
  const batchId = body.batch_id;
  const ctx = { orgId: ORG, batchId, now };
  const posted = rawRowsOnly(body.rows);
  const checked = validateRows(posted, OPTS);
  const ready = checked.ready;
  const existing = readExisting(db, ready);
  const decisions = decideRows(ready, indexExisting(existing, GB), GB);
  const progress = emptyProgress();
  progress.rows = body.rows.length;
  for (const n of problemRowNumbers(checked)) skipRow(progress, n, 'problem');
  for (const d of checked.duplicatesInFile) skipRow(progress, d.rowNumber, d.message);

  if (!db.batches.has(batchId)) db.batches.set(batchId, batchRecord({ batchId, orgId: ORG, companyId: COMPANY, programId: PROGRAM.id, filename: 'coffeeboy.csv', userId: 'peter', consentText: CONSENT_TEXT }));

  const addressesOf = (r) => [r.email, r.phone, r.phoneE164].filter(Boolean);
  const hasStopped = (d) => addressesOf(d.row).some((a) => db.suppressions.has(a));

  for (const d of decisions) if (d.verdict === 'blocked') skipRow(progress, d.rowNumber, d.reason);
  const byId = new Map(existing.map((c) => [c.id, { ...c }]));
  for (const d of decisions.filter((x) => x.verdict === 'new')) {
    try {
      const row = insertCustomer(db, buildInsert(d.row, ctx, { allowOptIn: !hasStopped(d) }));
      d.customerId = row.id;
      progress.created++;
    } catch (e) {
      if (e.code !== '23505') throw e;
      const found = db.customers.find((c) => (d.row.phone && c.phone === d.row.phone) || (d.row.email && c.email === d.row.email));
      if (!found) { failRow(progress, d.rowNumber, 'We could not add this person.'); continue; }
      d.customerId = found.id; d.verdict = 'update'; byId.set(found.id, { ...found });
    }
  }
  {
    const seen = new Map();
    for (const d of decisions) {
      if (d.verdict === 'blocked' || !d.customerId) continue;
      if (seen.has(d.customerId)) { d.verdict = 'blocked'; skipRow(progress, d.rowNumber, 'same'); continue; }
      seen.set(d.customerId, d.rowNumber);
    }
  }
  const touched = decisions.filter((d) => d.verdict !== 'blocked' && d.customerId);
  const touchedIds = Array.from(new Set(touched.map((d) => d.customerId)));

  const priorAll = db.consents.filter((c) => touchedIds.includes(c.customer_id));
  const consentOf = new Map();
  const withheld = [];
  for (const d of touched) {
    const was = d.verdict === 'update' ? byId.get(d.customerId) : null;
    const v = consentDecision(d.row, {
      priorConsents: priorAll.filter((c) => c.customer_id === d.customerId),
      suppressed: hasStopped(d),
      currentFlag: was ? (was.marketing_opt_in ?? null) : null,
      now,
    });
    consentOf.set(d, v);
    if (v && v.withheld) withheld.push({ rowNumber: d.rowNumber, name: d.row.name });
  }
  progress.consentWithheld = withheld.length;
  runNote(progress, withheldLine(withheld));

  const patches = [];
  for (const d of decisions) {
    if (d.verdict !== 'update' || !d.customerId) continue;
    const was = byId.get(d.customerId);
    if (!was) continue;
    const v = consentOf.get(d);
    const patch = buildPatch(d.row, was, ctx, { allowOptIn: !v || v.setFlag });
    if (patch) patches.push(patch);
  }
  for (const group of groupPatches(patches)) {
    for (const slice of chunkRows(group, 100)) {
      upsertCustomers(db, slice);            // throws 21000 if one row is touched twice
      progress.updated += slice.length;       // counted when the write lands
    }
  }

  for (const d of touched) {
    const v = consentOf.get(d);
    if (!v || !v.write) continue;
    const consent = buildConsent(d.row, { customerId: d.customerId, orgId: ORG, companyId: COMPANY, locationId: LOCATION, consentText: CONSENT_TEXT, privacyVersion: null, now, createdAt: v.createdAt });
    if (consent && consentIsNew(consent, priorAll)) db.consents.push(consent);
  }

  for (const id of touchedIds) if (!db.members.has(id)) { db.members.add(id); progress.enrolled++; }

  const stamped = new Set(db.stampTx.filter((t) => t.idempotency_key.startsWith(STAMP_KEY_PREFIX) && touchedIds.includes(t.customer_id)).map((t) => t.customer_id));
  const leftAlone = stampsSkipped(decisions, stamped);
  progress.alreadyStamped = leftAlone.length;
  runNote(progress, alreadyStampedLine(leftAlone.length));
  for (const d of stampsOwed(decisions, stamped)) {
    const key = stampKey(batchId, d.customerId, PROGRAM.id);
    if (db.stampTx.some((t) => t.idempotency_key === key)) continue;
    db.stampTx.push({ customer_id: d.customerId, idempotency_key: key, stamps: d.row.stamps });
    const plan = stampPlan(d.row, db.cards.get(d.customerId) || null, PROGRAM.stamps_required);
    db.cards.set(d.customerId, { stamps_collected: plan.stampsCollected, completed_count: plan.completedCount });
    progress.stamped++;
  }
  return { ok: true, batch_id: batchId, chunk: chunkAnswer(progress) };
}

// ── the screen: read, check, ask, leave out, send ───────────────────────────

let batchSeq = 0;
function runScreen(db, text) {
  const parsed = readCsv(text);
  const checked = validateRows(parsed.rows, OPTS);
  const toAsk = rowsToSend(parsed.rows, checked);
  const all = [];
  for (const part of chunkRows(toAsk, PREVIEW_CHUNK_SIZE)) for (const v of serverPreview(db, part)) all.push(v);
  const verdicts = sameCustomerAcrossFile(all);
  const byRow = verdictsByRow(verdicts);
  const summary = summarise(checked, verdicts);
  const toSend = toAsk.filter((r) => (byRow.get(r.rowNumber)?.verdict || '') !== 'blocked');
  const batchId = '00000000-0000-4000-8000-' + String(++batchSeq).padStart(12, '0');
  let acc = null;
  const chunks = chunkRows(toSend, CHUNK_SIZE);
  for (let i = 0; i < chunks.length; i++) {
    acc = mergeResult(acc, serverImport(db, { rows: chunks[i], batch_id: batchId, chunk_index: i }));
  }
  return { parsed, checked, summary, result: acc };
}

/** What a customer looks like to the till, keyed by email, so two runs can be compared. */
function snapshot(db) {
  const out = new Map();
  for (const c of db.customers) {
    out.set(String(c.email).toLowerCase() + '|' + (c.phone || ''), {
      name: c.name, phone: c.phone, phone_raw: c.phone_raw, email: c.email, birthday: c.birthday,
      notes: c.notes, marketing_opt_in: c.marketing_opt_in, card: db.cards.get(c.id) || null,
    });
  }
  return out;
}

// ── the tests ───────────────────────────────────────────────────────────────

test('H: the fixture has the real export\'s shape', () => {
  assert.equal(ROWS.length, 7977);
  assert.equal(ROWS.filter((r) => !r.phone).length, 1230, '290 unusable plus 940 never given');
  assert.equal(ROWS.filter((r) => /phone in 5Loyalty/.test(r.notes)).length, 290);
  assert.equal(ROWS.filter((r) => /shares this phone/.test(r.notes)).length, 283);
  assert.equal(ROWS.filter((r) => r.marketing_opt_in === 'yes').length, 2876);
  assert.ok(ROWS.every((r) => r.email));
  assert.equal(ROWS.filter((r) => r.email.toLowerCase() === 'guest@example.com').length, 5, 'one placeholder email on five accounts');
  assert.equal(Math.max(...ROWS.map((r) => Number(r.stamps))), 9);
  assert.ok(ROWS.every((r) => /^5L-\d+$/.test(r.external_id)));
  assert.ok(ROWS.every((r) => !r.opt_in_date && !r.signed_up_date));
});

test('H: the Coffee Boy file and its spreadsheet mangled copy read to the SAME people', () => {
  const clean = validateRows(readCsv(CLEAN).rows, OPTS);
  const mangledRead = readCsv(MANGLED);
  assert.equal(mangledRead.delimiter, ';');
  assert.deepEqual(mangledRead.unknown, [], 'every re-typed header is recognised');
  assert.equal(mangledRead.rows.length, 7977, 'the blank rows are not people');
  const mangled = validateRows(mangledRead.rows, OPTS);

  assert.deepEqual(clean.errors.map((e) => e.text), [], 'the clean file imports cleanly');
  assert.deepEqual(mangled.errors.map((e) => e.text).slice(0, 5), [], 'and so does the mangled one');
  assert.deepEqual(clean.duplicatesInFile.map((d) => d.message.replace(/row \d+/, 'row N')),
    Array(4).fill('Same email as row N, and no phone to tell them apart. We keep the first one.'),
    'only the four extra guest placeholder rows are left out, and each is named');
  assert.equal(mangled.duplicatesInFile.length, 4);
  assert.equal(clean.ready.length, 7973);
  assert.equal(mangled.ready.length, 7973);

  const fields = ['name', 'phone', 'phoneE164', 'email', 'stamps', 'rewardsUnused', 'marketingOptIn', 'birthday', 'externalId', 'optInSource'];
  const byId = new Map(clean.ready.map((r) => [r.externalId, r]));
  let fixedZero = 0;
  for (const m of mangled.ready) {
    const c = byId.get(m.externalId);
    assert.ok(c, 'row ' + m.externalId + ' is in both');
    for (const f of fields) assert.deepEqual(m[f], c[f], m.externalId + ' ' + f);
    assert.deepEqual(m.sharedWith ? m.sharedWith.field : null, c.sharedWith ? c.sharedWith.field : null);
    if (m.phoneAssumed) fixedZero++;
  }
  assert.ok(fixedZero > 2000, 'thousands of phones got their 0 back: ' + fixedZero);
});

test('E: the 140 shared numbers: the first row keeps the phone, the others go in by email, and it is said', () => {
  const checked = validateRows(readCsv(CLEAN).rows, OPTS);
  const shared = checked.ready.filter((r) => r.sharedWith && r.sharedWith.field === 'phone');
  assert.equal(shared.length, 283 - 140, 'one row per number keeps it');
  for (const r of shared) {
    assert.equal(r.phone, null);
    assert.ok(r.email);
    assert.ok(checked.warnings.some((w) => w.rowNumber === r.rowNumber && /Shares a phone with row/.test(w.message)));
  }
  const s = summarise(checked, checked.ready.map((r) => ({ row_number: r.rowNumber, verdict: 'new' })));
  assert.equal(s.sharedPhone, 143);
  assert.equal(s.sharedEmail, 0, 'the guest placeholder rows have no phone of their own, so they are repeats, not shares');
  const phones = checked.ready.map((r) => r.phone).filter(Boolean);
  assert.equal(new Set(phones).size, phones.length, 'no phone twice, so (org_id, phone) holds');
});

test('the Coffee Boy file imports end to end, and a second run doubles nothing', () => {
  const db = newDb();
  const first = runScreen(db, CLEAN);
  assert.equal(first.summary.newCustomers, 7973, 'Coffee Boy have nobody in ServOS yet');
  assert.equal(first.result.created, 7973);
  assert.equal(first.result.failed.length, 0, first.result.failed.slice(0, 3).map((f) => f.text).join(' '));
  assert.equal(db.customers.length, 7973);
  assert.equal(db.customers.filter((c) => c.phone).length, 6747 - 143, 'every usable phone, once');
  assert.equal(db.customers.filter((c) => c.marketing_opt_in === true).length, 2876);
  assert.equal(db.consents.length, 7973, 'a yes or a no for everybody, all from the file');
  const withStamps = ROWS.filter((r) => Number(r.stamps) > 0 || Number(r.rewards_unused) > 0).length;
  assert.equal(db.cards.size, withStamps);
  assert.equal(db.stampTx.length, withStamps);
  const stampsIn = ROWS.reduce((n, r) => n + Number(r.stamps), 0);
  const rewardsIn = ROWS.reduce((n, r) => n + Number(r.rewards_unused), 0);
  const cards = Array.from(db.cards.values());
  assert.equal(cards.reduce((n, c) => n + c.stamps_collected, 0), stampsIn, 'every stamp landed');
  assert.equal(cards.reduce((n, c) => n + c.completed_count, 0), rewardsIn, 'every free drink owed landed');
  assert.equal(db.batches.size, 1, 'B: one import_batches row for the whole file');
  assert.equal(Array.from(db.batches.values())[0].created_by, 'peter', 'B: with who ran it');
  const before = snapshot(db);

  // The same file again, as a new run.
  const second = runScreen(db, CLEAN);
  assert.equal(second.summary.alreadyKnown, 7973, 'everybody is already in');
  assert.equal(second.summary.newCustomers, 0);
  assert.equal(second.result.created, 0);
  assert.equal(second.result.failed.length, 0);
  assert.equal(db.customers.length, 7973, 'nobody twice');
  assert.equal(db.stampTx.length, withStamps, 'no second stamp claim');
  assert.equal(db.consents.length, 7973, 'no second consent row');
  assert.equal(second.result.alreadyStamped, withStamps, 'and the cards left alone are counted');
  assert.ok(second.result.notes.some((n) => /already imported stamps/.test(n)), 'and said');
  const after = snapshot(db);
  for (const [key, was] of before) assert.deepEqual(after.get(key), was, 'unchanged: ' + key);
  assert.match(resultLine(second.result), /0 customers added/);
});

test('the mangled copy lands the same people and cards, and on top of the clean file doubles nothing', () => {
  const fromClean = newDb();
  runScreen(fromClean, CLEAN);
  const fromMangled = newDb();
  const run = runScreen(fromMangled, MANGLED);
  assert.equal(run.result.created, 7973);
  assert.equal(run.result.failed.length, 0);
  const a = snapshot(fromClean);
  const b = snapshot(fromMangled);
  assert.equal(b.size, a.size);
  for (const [key, was] of a) {
    const now = b.get(key);
    assert.ok(now, 'the same person: ' + key);
    // phone_raw is what the file said, and a note names the row in THAT file
    // (the mangled one has blank rows in it), so both honestly differ.
    // Everything the till uses is the same.
    const same = (x) => ({ ...x, phone_raw: null, notes: String(x.notes || '').replace(/row \d+/g, 'row N') });
    assert.deepEqual(same(now), same(was), key);
  }

  // Clean first, then the corrected spreadsheet: still one of everybody.
  const both = newDb();
  runScreen(both, CLEAN);
  const stampsBefore = both.stampTx.length;
  const consentsBefore = both.consents.length;
  const again = runScreen(both, MANGLED);
  assert.equal(again.result.created, 0);
  assert.equal(both.customers.length, 7973);
  assert.equal(both.stampTx.length, stampsBefore);
  assert.equal(both.consents.length, consentsBefore);
});

test('C: somebody who switched marketing off here is not switched back on by the file', () => {
  const db = newDb();
  runScreen(db, CLEAN);
  const yes = db.customers.filter((c) => c.marketing_opt_in === true).slice(0, 3);
  for (const c of yes) c.marketing_opt_in = false;          // the loyalty portal toggle, or a Back Office untick
  const consentsBefore = db.consents.length;
  const run = runScreen(db, CLEAN);
  for (const c of yes) assert.equal(db.customers.find((x) => x.id === c.id).marketing_opt_in, false, c.name + ' stays off');
  assert.equal(run.result.consentWithheld, 3);
  assert.ok(run.result.notes.some((n) => /We left marketing OFF for/.test(n) && yes.every((c) => n.includes(c.name))), 'named in the consent line');
  assert.equal(db.consents.length, consentsBefore, 'and no yes row is written that would switch them back on');
});

test('E: two file rows on one customer never reach Postgres as one statement touching a row twice', () => {
  const db = newDb();
  // Somebody the till already has, with a phone and an email.
  insertCustomer(db, { org_id: ORG, name: 'Till Jane', phone: '+447123400001', phone_raw: '07123 400001', email: 'jane@example.com', sources: [], source: 'pos', marketing_opt_in: null });
  // Row 2 finds her by phone, row 3 by email.
  const text = COLUMNS.join(',') + '\r\n'
    + ',Jane,Phone,07123 400001,other@example.com,1,0,yes,,5Loyalty,,,5L-1,\r\n'
    + ',Jane,Email,,jane@example.com,2,0,yes,,5Loyalty,,,5L-2,\r\n';
  const run = runScreen(db, text);                         // would throw 21000 if both patches went in one write
  assert.equal(run.summary.alreadyKnown, 1);
  assert.equal(run.summary.blocked, 1, 'the second row is left out');
  assert.equal(db.customers.length, 1, 'nobody new was made');
  assert.equal(db.stampTx.length, 1, 'one stamp claim, from the first row');
});
