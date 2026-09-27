// src/lib/customerAutoJoinRun.test.js
//
// THE TILL'S JOIN BY EMAIL, END TO END, AGAINST A FAKE DATABASE (27 Sep 2026).
//
// Drives src/lib/customerAutoJoinRun.js the way the store does (autoJoinCustomer on Confirm, then
// upsertCustomerRow when the order closes) against an in memory customers table that enforces the
// live unique indexes (idx_customers_org_phone (org_id, phone) and idx_customers_org_email
// (org_id, lower(email)), both where deleted_at is null) and answers like PostgREST. customer-merge
// is a fake too, with the same answers the deployed function gives. What it cannot run is React,
// Deno and PostgREST themselves.
// Run: `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { upsertCustomerRow, autoJoinCustomer, readAutoJoinFacts } from './customerAutoJoinRun.js';
import { TimeoutError } from './withTimeout.js';

const ORG = 'cd97f0f0-4807-4e45-801e-56114b22128a';
const LEEDS = '1e252e7c-c875-4971-b91d-1e945c26956b';
const SIMON = 'aaa70b4f-0000-4000-8000-000000000001';
const SHELL = 'c462cbfc-be83-4ee9-9459-91ea0a682215';
const PHONE = '+447415748167';
const NOW = '2026-09-27T12:00:00.000Z';

// ── a customers table that answers like PostgREST ─────────────────────────────

const lower = (v) => (v == null ? null : String(v).toLowerCase());
const UNIQUES = [
  { name: 'customers_pkey', key: (r) => r.id },
  { name: 'idx_customers_org_phone', key: (r) => (r.phone != null && r.deleted_at == null ? `${r.org_id}|${r.phone}` : null) },
  { name: 'idx_customers_org_email', key: (r) => (r.email != null && r.deleted_at == null ? `${r.org_id}|${lower(r.email)}` : null) },
];
function violation(rows) {
  for (const u of UNIQUES) {
    const seen = new Set();
    for (const r of rows) {
      const k = u.key(r);
      if (k == null) continue;
      if (seen.has(k)) return { code: '23505', message: `duplicate key value violates unique constraint "${u.name}"` };
      seen.add(k);
    }
  }
  return null;
}
const ilikeRx = (pattern) => {
  let re = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '\\' && i + 1 < pattern.length) { i += 1; re += pattern[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
    else if (ch === '%' || ch === '*') re += '.*';
    else if (ch === '_') re += '.';
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
};

function fakeDb(rows, hooks = {}) {
  const db = { customers: rows.map((r) => ({ tags: [], deleted_at: null, first_name: null, last_name: null, allergens: [], ...r })) };
  const log = [];
  let n = 0;
  const from = (table) => {
    const q = { table, op: 'select', filters: [], desc: [], cols: '*', lim: null, single: false, patch: null, rows: null, returning: false };
    const match = (r) => q.filters.every((f) => f(r));
    const project = (r) => (q.cols === '*' ? { ...r } : Object.fromEntries(String(q.cols).split(',').map((c) => c.trim()).filter(Boolean).map((c) => [c, r[c] === undefined ? null : r[c]])));
    const run = () => {
      log.push({ table, op: q.op, desc: q.desc.join(' ') });
      if (hooks.before) hooks.before({ table, op: q.op, db, desc: q.desc.join(' ') });
      if (hooks.readFail && q.op === 'select') return { data: null, error: { message: 'read failed (fake)' } };
      const all = db[table] || [];
      if (q.op === 'update') {
        const hit = all.filter(match);
        const next = all.map((r) => (match(r) ? { ...r, ...q.patch } : r));
        const err = violation(next);
        if (err) return { data: null, error: err };
        db[table] = next;
        const ids = new Set(hit.map((r) => r.id));
        return { data: q.returning ? next.filter((r) => ids.has(r.id)).map(project) : null, error: null };
      }
      if (q.op === 'insert') {
        n += 1;
        const added = q.rows.map((r) => ({ id: `new-${n}`, deleted_at: null, tags: [], ...r }));
        const next = [...all, ...added];
        const err = violation(next);
        if (err) return { data: null, error: err };
        db[table] = next;
        const out = added.map(project);
        return { data: q.single ? out[0] : out, error: null };
      }
      let found = all.filter(match);
      if (q.lim != null) found = found.slice(0, q.lim);
      if (q.single) return { data: found[0] ? project(found[0]) : null, error: null };
      return { data: found.map(project), error: null };
    };
    const b = {
      select(cols) { q.cols = cols || '*'; if (q.op !== 'select') q.returning = true; return b; },
      eq(c, v) { q.desc.push(`eq:${c}`); q.filters.push((r) => r[c] != null && String(r[c]) === String(v)); return b; },
      is(c, v) { q.desc.push(`is:${c}`); q.filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return b; },
      ilike(c, p) { q.desc.push(`ilike:${c}`); const rx = ilikeRx(p); q.filters.push((r) => r[c] != null && rx.test(String(r[c]))); return b; },
      or(expr) {
        q.desc.push('or');
        const parts = String(expr).split(',').map((s) => { const [c, op, ...v] = s.split('.'); assert.equal(op, 'eq'); return [c, v.join('.')]; });
        q.filters.push((r) => parts.some(([c, v]) => r[c] != null && String(r[c]) === v));
        return b;
      },
      limit(k) { q.lim = k; return b; },
      maybeSingle() { q.single = true; return b; },
      single() { q.single = true; return b; },
      update(patch) { q.op = 'update'; q.patch = patch; return b; },
      insert(r) { q.op = 'insert'; q.rows = Array.isArray(r) ? r : [r]; return b; },
      then(ok, bad) { return Promise.resolve().then(run).then(ok, bad); },
    };
    return b;
  };
  return { from, db, log, row: (id) => db.customers.find((r) => r.id === id) };
}

const simonRow = (over = {}) => ({ id: SIMON, org_id: ORG, name: 'Simon Hughes', email: 'simon_h@example.com', phone: null, phone_raw: null, allergens: ['nuts'], tags: [], sources: ['import:5loyalty'], ...over });
const shellRow = (over = {}) => ({ id: SHELL, org_id: ORG, name: '', email: null, phone: PHONE, phone_raw: '07415748167', ...over });
const typed = (over = {}) => ({ name: 'Simon', phone: '07415 748167', email: 'Simon_H@example.com', ...over });

/** customer-merge, faked: the answers the deployed function gives, and the fold it makes. */
function fakeMerge(fdb, { preview = {}, mergeAnswers = null } = {}) {
  const calls = [];
  const post = async (body) => {
    calls.push(body);
    if (body.action === 'preview') {
      return { status: 200, body: { ok: true, action: 'preview', can_merge: true, source_blank: true, swapped: false, source_id: body.source_id, target_id: body.target_id, ...preview } };
    }
    const next = mergeAnswers ? mergeAnswers.shift() : null;
    if (next && next.status !== 200) return next;
    // The core's fold: the source lets go of its phone and is soft deleted; the target takes it.
    const s = fdb.row(body.source_id);
    const t = fdb.row(body.target_id);
    const phone = s.phone; const raw = s.phone_raw;
    s.deleted_at = NOW; s.phone = null; s.phone_raw = null;
    s.tags = [...(s.tags || []), `merged_into:${t.id}`, `merge_phone:${phone}`, `merge_phone_raw:${raw}`, 'merge_done'];
    t.phone = phone; t.phone_raw = raw; t.tags = [...(t.tags || []), `merged:${s.id}`];
    return { status: 200, body: { ok: true, action: 'merge', survivor_id: t.id, merged_source_id: s.id, survivor: { id: t.id, name: t.name, phone: t.phone, email: t.email, allergens: t.allergens } } };
  };
  return { post, calls };
}

const notices = () => { const sent = []; return { sent, send: async (b) => { sent.push(b); } }; };

// ── (a) ──────────────────────────────────────────────────────────────────────

test('(a) Simon: the phone goes on his imported profile, the order uses it, the close finds it, one notice', async () => {
  const fdb = fakeDb([simonRow()]);
  const n = notices();
  const r = await autoJoinCustomer({ customer: typed(), openedWithEmail: '', phoneN: PHONE, db: fdb, orgId: ORG, locId: LEEDS, sendNotice: n.send, now: NOW });
  assert.equal(r.kind, 'linked');
  assert.equal(r.how, 'phone_added');
  assert.equal(r.profileId, SIMON);
  assert.equal(r.toast, "Linked to Simon Hughes's loyalty (joined by email)");
  assert.deepEqual(r.customer.allergens, ['nuts'], "the member's allergy travels with the order");
  assert.equal(r.customer.email, 'Simon_H@example.com', 'the email stays on the order for the receipt');
  const s = fdb.row(SIMON);
  assert.equal(s.phone, PHONE);
  assert.equal(s.phone_raw, '07415 748167');
  assert.equal(s.name, 'Simon Hughes', 'a real name is never overwritten');
  assert.deepEqual(s.tags, [`email_join:${PHONE}`, `email_join_at:${NOW}`], 'the join is written on the profile');
  assert.deepEqual(n.sent, [{ customer_id: SIMON }]);
  // Order close: phone only, and it lands on Simon; no second profile, no clash.
  const id = await upsertCustomerRow({ db: fdb, orgId: ORG, c: r.customer, phoneN: PHONE, now: NOW });
  assert.equal(id, SIMON);
  assert.equal(fdb.db.customers.length, 1);
});

test('(a) an empty name on the email profile is filled from the form', async () => {
  const fdb = fakeDb([simonRow({ name: '' })]);
  const r = await autoJoinCustomer({ customer: typed({ name: 'Simon H' }), phoneN: PHONE, db: fdb, orgId: ORG, now: NOW });
  assert.equal(r.kind, 'linked');
  assert.equal(fdb.row(SIMON).name, 'Simon H');
  assert.equal(r.toast, "Linked to Simon H's loyalty (joined by email)");
});

test('(a) the profile got a phone a moment ago: nothing is overwritten, no notice', async () => {
  const fdb = fakeDb([simonRow()], {
    before: ({ op, db }) => { if (op === 'update') db.customers[0].phone = '+447700900123'; },
  });
  const n = notices();
  const r = await autoJoinCustomer({ customer: typed(), phoneN: PHONE, db: fdb, orgId: ORG, sendNotice: n.send, now: NOW });
  assert.equal(r.kind, 'apart');
  assert.equal(r.reason, 'changed');
  assert.equal(fdb.row(SIMON).phone, '+447700900123');
  assert.deepEqual(n.sent, []);
});

test('(a) another till saved this phone a moment ago: plain words, not the unique index', async () => {
  const fdb = fakeDb([simonRow()], {
    before: ({ op, db }) => { if (op === 'update' && db.customers.length === 1) db.customers.push({ id: 'other', org_id: ORG, name: '', phone: PHONE, email: null, deleted_at: null, tags: [] }); },
  });
  const r = await autoJoinCustomer({ customer: typed(), phoneN: PHONE, db: fdb, orgId: ORG, now: NOW });
  assert.equal(r.kind, 'apart');
  assert.equal(r.reason, 'phone_taken');
  assert.match(r.toast, /^Saved without the email: this phone was just saved on another customer/);
  assert.equal(fdb.row(SIMON).phone, null);
});

// ── (b) ──────────────────────────────────────────────────────────────────────

test('(b) the empty profile the display made is folded into Simon by customer-merge; trail, notice', async () => {
  const fdb = fakeDb([simonRow(), shellRow()]);
  const m = fakeMerge(fdb);
  const n = notices();
  const r = await autoJoinCustomer({ customer: typed(), phoneN: PHONE, db: fdb, orgId: ORG, locId: LEEDS, postMerge: m.post, sendNotice: n.send, now: NOW });
  assert.equal(r.kind, 'linked');
  assert.equal(r.how, 'joined');
  assert.equal(r.profileId, SIMON);
  assert.equal(r.toast, "Linked to Simon Hughes's loyalty (joined by email)");
  assert.deepEqual(m.calls.map((c) => c.action), ['preview', 'merge']);
  assert.deepEqual(m.calls[1], { action: 'merge', target_id: SIMON, source_id: SHELL, location_id: LEEDS }, 'the till never sends a phone choice');
  const s = fdb.row(SIMON);
  assert.equal(s.phone, PHONE);
  assert.ok(s.tags.includes(`merged:${SHELL}`));
  assert.ok(s.tags.includes(`email_join:${PHONE}`), 'the survivor says it was an email match');
  assert.deepEqual(n.sent, [{ customer_id: SIMON, source_id: SHELL }]);
  // Order close finds Simon by the phone; the shell stays folded in.
  assert.equal(await upsertCustomerRow({ db: fdb, orgId: ORG, c: r.customer, phoneN: PHONE, now: NOW }), SIMON);
  assert.equal(fdb.db.customers.filter((c) => !c.deleted_at).length, 1);
});

test('(b) customer-merge says the phone profile is not empty (points, stamps, orders): no merge, no notice', async () => {
  const fdb = fakeDb([simonRow(), shellRow()]);
  const m = fakeMerge(fdb, { preview: { source_blank: false } });
  const n = notices();
  const r = await autoJoinCustomer({ customer: typed(), phoneN: PHONE, db: fdb, orgId: ORG, locId: LEEDS, postMerge: m.post, sendNotice: n.send, now: NOW });
  assert.equal(r.kind, 'apart');
  assert.equal(r.reason, 'join_refused');
  assert.deepEqual(m.calls.map((c) => c.action), ['preview']);
  assert.deepEqual(n.sent, []);
  assert.equal(fdb.row(SHELL).deleted_at, null);
  // Order close: phone only, lands on the shell, the email is left off (it is Simon's).
  assert.equal(await upsertCustomerRow({ db: fdb, orgId: ORG, c: typed(), phoneN: PHONE, now: NOW }), SHELL);
  assert.equal(fdb.row(SHELL).email, null);
  assert.equal(fdb.row(SHELL).name, 'Simon', 'the rest of the save is kept');
});

test('(b) customer-merge would keep the phone profile (swapped): the till does not join', async () => {
  const fdb = fakeDb([simonRow(), shellRow()]);
  const m = fakeMerge(fdb, { preview: { swapped: true } });
  const r = await autoJoinCustomer({ customer: typed(), phoneN: PHONE, db: fdb, orgId: ORG, locId: LEEDS, postMerge: m.post, now: NOW });
  assert.equal(r.reason, 'join_refused');
  assert.equal(m.calls.length, 1);
});

test('(b) a merge that stopped part way is sent once more and finishes', async () => {
  const fdb = fakeDb([simonRow(), shellRow()]);
  const m = fakeMerge(fdb, { mergeAnswers: [{ status: 500, body: { ok: false, code: 'step_failed', retry_safe: true } }, null] });
  const r = await autoJoinCustomer({ customer: typed(), phoneN: PHONE, db: fdb, orgId: ORG, locId: LEEDS, postMerge: m.post, now: NOW });
  assert.equal(r.kind, 'linked');
  assert.deepEqual(m.calls.map((c) => c.action), ['preview', 'merge', 'merge']);
});

test('(b) a merge refused by the server: plain words, the save goes on phone only', async () => {
  const fdb = fakeDb([simonRow(), shellRow()]);
  const m = fakeMerge(fdb, { mergeAnswers: [{ status: 403, body: { ok: false, code: 'device_needs_blank_source', error: 'x' } }] });
  const n = notices();
  const r = await autoJoinCustomer({ customer: typed(), phoneN: PHONE, db: fdb, orgId: ORG, locId: LEEDS, postMerge: m.post, sendNotice: n.send, now: NOW });
  assert.equal(r.kind, 'apart');
  assert.equal(r.reason, 'join_refused');
  assert.deepEqual(n.sent, []);
});

// ── (c) and the gates ────────────────────────────────────────────────────────

test('(c) the email is on a profile with a different phone: nothing is written by the check, the close saves without the email', async () => {
  const fdb = fakeDb([simonRow({ phone: '+447700900123' })]);
  const n = notices();
  const r = await autoJoinCustomer({ customer: typed(), phoneN: PHONE, db: fdb, orgId: ORG, sendNotice: n.send, now: NOW });
  assert.equal(r.kind, 'apart');
  assert.equal(r.reason, 'holder_has_phone');
  assert.equal(fdb.log.filter((l) => l.op !== 'select').length, 0);
  assert.deepEqual(n.sent, []);
  const id = await upsertCustomerRow({ db: fdb, orgId: ORG, c: typed(), phoneN: PHONE, now: NOW });
  const made = fdb.row(id);
  assert.equal(made.phone, PHONE);
  assert.equal(made.email, null, 'the email is left off, never a "DB error"');
  assert.equal(made.name, 'Simon');
  assert.equal(fdb.row(SIMON).phone, '+447700900123', "Simon's phone is never moved");
});

test('an email the form opened with (a reopened order, a table guest) joins nothing and reads nothing', async () => {
  const fdb = fakeDb([simonRow()]);
  const r = await autoJoinCustomer({ customer: typed(), openedWithEmail: 'simon_h@EXAMPLE.com', phoneN: PHONE, db: fdb, orgId: ORG, now: NOW });
  assert.deepEqual(r, { kind: 'none', customer: typed() });
  assert.equal(fdb.log.length, 0);
  assert.equal(fdb.row(SIMON).phone, null);
});

test('a few digits typed by mistake never go on a member (seven digit floor), and nothing is read', async () => {
  const fdb = fakeDb([simonRow()]);
  const r = await autoJoinCustomer({ customer: typed({ phone: '123' }), phoneN: '123', db: fdb, orgId: ORG, now: NOW });
  assert.equal(r.kind, 'none');
  assert.equal(fdb.log.length, 0);
  assert.deepEqual(await readAutoJoinFacts({ db: fdb, orgId: ORG, phoneN: '12', email: 'simon_h@example.com' }), { ok: false, code: 'nothing_to_check' });
});

test('a failed or slow check is no join (a slow network never holds the order)', async () => {
  const failing = fakeDb([simonRow()], { readFail: true });
  assert.equal((await autoJoinCustomer({ customer: typed(), phoneN: PHONE, db: failing, orgId: ORG })).kind, 'none');
  const slow = fakeDb([simonRow()]);
  const timeout = () => Promise.reject(new TimeoutError('Customer check', 1));
  assert.equal((await autoJoinCustomer({ customer: typed(), phoneN: PHONE, db: slow, orgId: ORG, timeout })).kind, 'none');
  assert.equal(slow.row(SIMON).phone, null);
});

test('the check is exact: another email that only looks alike is never matched', async () => {
  const fdb = fakeDb([simonRow({ email: 'simonXh@example.com' })]);
  const r = await autoJoinCustomer({ customer: typed({ email: 'simon_h@example.com' }), phoneN: PHONE, db: fdb, orgId: ORG, now: NOW });
  assert.equal(r.kind, 'none');
  assert.equal(fdb.row(SIMON).phone, null);
  const facts = await readAutoJoinFacts({ db: fdb, orgId: ORG, phoneN: PHONE, email: 'simon_h@example.com' });
  assert.deepEqual(facts.emailHits, []);
});

test('the join only ever touches customers: no gift card, loyalty or other table (the 18 Sep rule)', async () => {
  const fdb = fakeDb([simonRow(), shellRow()]);
  const m = fakeMerge(fdb);
  await autoJoinCustomer({ customer: typed(), phoneN: PHONE, db: fdb, orgId: ORG, locId: LEEDS, postMerge: m.post, now: NOW });
  const a = fakeDb([simonRow()]);
  await autoJoinCustomer({ customer: typed(), phoneN: PHONE, db: a, orgId: ORG, now: NOW });
  for (const l of [...fdb.log, ...a.log]) assert.equal(l.table, 'customers');
});

// ── every save: phone only, and a clashing email never loses the rest ────────

test('upsertCustomerRow never looks an email up, and a clash never loses the name, allergies or the visit', async () => {
  const fdb = fakeDb([simonRow(), shellRow()]);
  const id = await upsertCustomerRow({ db: fdb, orgId: ORG, c: { ...typed(), allergens: ['milk'] }, phoneN: PHONE, now: NOW });
  assert.equal(id, SHELL);
  assert.equal(fdb.row(SHELL).email, null);
  assert.equal(fdb.row(SHELL).name, 'Simon');
  assert.deepEqual(fdb.row(SHELL).allergens, ['milk']);
  assert.equal(fdb.log.some((l) => l.desc.includes('ilike') || l.desc.includes('eq:email')), false);
});

test('upsertCustomerRow: a new profile that lost the race for its phone is that profile', async () => {
  const fdb = fakeDb([], {
    before: ({ op, db }) => { if (op === 'insert' && !db.customers.length) db.customers.push({ id: 'first', org_id: ORG, name: '', phone: PHONE, email: null, deleted_at: null, tags: [] }); },
  });
  assert.equal(await upsertCustomerRow({ db: fdb, orgId: ORG, c: typed({ email: '' }), phoneN: PHONE, now: NOW }), 'first');
});
