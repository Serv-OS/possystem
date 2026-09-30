// src/lib/customerLinkRun.test.js
//
// "LINK TO EXISTING MEMBER", END TO END, AGAINST A FAKE DATABASE (27 Sep 2026).
//
// Peter: "if a customer adds their number and then a staff member can link that to a profile that
// currently has no number". Coffee Boy Leeds: "we have details disabled so only the phone number
// is there for takeaway and collection so nowhere to type those details in". Drives
// src/lib/customerLinkRun.js the way the store does (the search, then the link on a tap, then
// upsertCustomerRow when the order is paid) against an in memory customers table with the live
// unique indexes, answering like PostgREST. customer-merge is faked with the answers the deployed
// function gives, including its blank shell rule for a till.
// Run: `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { searchPhonelessMembers, readLinkFacts, linkOrderCustomer, LINK_SEARCH_COLS, LINK_FACT_COLS } from './customerLinkRun.js';
import { upsertCustomerRow } from './customerAutoJoinRun.js';
import { TimeoutError } from './withTimeout.js';

const ORG = 'cd97f0f0-4807-4e45-801e-56114b22128a';
const OTHER_ORG = '0a0a0a0a-0000-4000-8000-000000000009';
const LEEDS = '1e252e7c-c875-4971-b91d-1e945c26956b';
const SIMON = 'aaa70b4f-0000-4000-8000-000000000001';
const SHELL = 'c462cbfc-be83-4ee9-9459-91ea0a682215';
const PHONE = '+447762955142';
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
    const q = { op: 'select', filters: [], desc: [], cols: '*', lim: null, single: false, patch: null, rows: null, returning: false };
    const match = (r) => q.filters.every((f) => f(r));
    const project = (r) => (q.cols === '*' ? { ...r } : Object.fromEntries(String(q.cols).split(',').map((c) => c.trim()).filter(Boolean).map((c) => [c, r[c] === undefined ? null : r[c]])));
    const run = () => {
      log.push({ table, op: q.op, desc: q.desc.join(' '), cols: q.cols });
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
      if (q.sort) found = found.slice().sort(q.sort);
      if (q.lim != null) found = found.slice(0, q.lim);
      if (q.single) return { data: found[0] ? project(found[0]) : null, error: null };
      return { data: found.map(project), error: null };
    };
    const b = {
      select(cols) { q.cols = cols || '*'; if (q.op !== 'select') q.returning = true; return b; },
      eq(c, v) { q.desc.push(`eq:${c}`); q.filters.push((r) => r[c] != null && String(r[c]) === String(v)); return b; },
      in(c, vs) { q.desc.push(`in:${c}`); const set = new Set(vs.map(String)); q.filters.push((r) => r[c] != null && set.has(String(r[c]))); return b; },
      order(c, { ascending = true } = {}) {
        q.desc.push(`order:${c}`);
        const k = (r) => (r[c] == null ? '' : String(r[c]));
        q.sort = (a, z) => (k(a) === k(z) ? 0 : (k(a) < k(z)) === ascending ? -1 : 1);
        return b;
      },
      is(c, v) { q.desc.push(`is:${c}`); q.filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return b; },
      ilike(c, p) { q.desc.push(`ilike:${c}`); const rx = ilikeRx(p); q.filters.push((r) => r[c] != null && rx.test(String(r[c]))); return b; },
      or(expr) {
        q.desc.push(`or:${expr}`);
        const parts = String(expr).split(',').map((s) => { const [c, op, ...v] = s.split('.'); return [c, op, v.join('.')]; });
        q.filters.push((r) => parts.some(([c, op, v]) => {
          if (r[c] == null) return false;
          if (op === 'eq') return String(r[c]) === v;
          if (op === 'ilike') return ilikeRx(v).test(String(r[c]));
          throw new Error(`fake or(): ${op}`);
        }));
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
const shellRow = (over = {}) => ({ id: SHELL, org_id: ORG, name: '', email: null, phone: PHONE, phone_raw: '07762955142', ...over });
// The order's customer as the display left it: the phone as typed, no name, no email.
const orderCustomer = (over = {}) => ({ phone: '07762955142', name: '', stampSummary: [], blankProfile: true, isASAP: true, ...over });

/**
 * customer-merge, faked: the deployed function's answers. A till is let in only to fold in an
 * EMPTY shell (no name, email, orders...): `history` marks the shell as having an order, which the
 * server counts and the till cannot see.
 */
function fakeMerge(fdb, { history = false, mergeAnswers = null } = {}) {
  const calls = [];
  const post = async (body) => {
    calls.push(body);
    if (history) {
      return { status: 403, body: { ok: false, code: 'device_needs_blank_source', error: 'A till can only fold in an empty profile (no name, email, points, stamps or orders). Ask a manager to merge these two in Back Office.' } };
    }
    if (body.action === 'preview') {
      return { status: 200, body: { ok: true, action: 'preview', can_merge: true, source_blank: true, swapped: false, source_id: body.source_id, target_id: body.target_id } };
    }
    const next = mergeAnswers ? mergeAnswers.shift() : null;
    if (next && next.status !== 200) return next;
    const s = fdb.row(body.source_id);
    const t = fdb.row(body.target_id);
    const phone = s.phone; const raw = s.phone_raw;
    s.deleted_at = NOW; s.phone = null; s.phone_raw = null;
    s.tags = [...(s.tags || []), `merged_into:${t.id}`, `merge_phone:${phone}`, `merge_phone_raw:${raw}`, 'merge_done'];
    t.phone = phone; t.phone_raw = raw; t.tags = [...(t.tags || []), `merged:${s.id}`];
    return { status: 200, body: { ok: true, action: 'merge', survivor_id: t.id, merged_source_id: s.id, survivor: { id: t.id, name: t.name, phone: t.phone, email: t.email, marketing_opt_in: false, allergens: t.allergens } } };
  };
  return { post, calls };
}

const notices = () => { const sent = []; return { sent, send: async (b) => { sent.push(b); } }; };
/** The customer display's loyalty lookup (fetchCustomerByPhone), faked: Simon has 2 of 9 stamps. */
const lookupSimon = () => {
  const asked = [];
  const fn = async (phone) => {
    asked.push(phone);
    return {
      customerId: SIMON, name: 'Simon Hughes', knownCustomer: true, credit: 0, rewards: [],
      stampCards: [{ id: 'card-1', program_id: 'p1', name: 'Coffee card', icon: '☕', stamps_required: 9, stamps_collected: 2, rewards_available: 0 }],
      pointsEnabled: false, stampsEnabled: true,
    };
  };
  return { fn, asked };
};

// ── the search ───────────────────────────────────────────────────────────────

test('the search: name or email, this organisation, live, and ONLY profiles with no phone', async () => {
  const fdb = fakeDb([
    simonRow(),
    simonRow({ id: 'with-phone', name: 'Simon Phone', email: 'sp@example.com', phone: '+447700900123' }),
    simonRow({ id: 'raw-only', name: 'Simon Raw', email: 'sr@example.com', phone_raw: '07700 900124' }),
    simonRow({ id: 'gone', name: 'Simon Gone', email: 'sg@example.com', deleted_at: NOW }),
    simonRow({ id: 'elsewhere', org_id: OTHER_ORG, name: 'Simon Elsewhere', email: 'se@example.com' }),
    simonRow({ id: 'by-email', name: 'Hughes Family', email: 'SIMON.family@example.com' }),
  ]);
  const byName = await searchPhonelessMembers({ db: fdb, orgId: ORG, q: 'simon' });
  assert.equal(byName.ok, true);
  assert.deepEqual(byName.rows.map((r) => r.id).sort(), ['by-email', SIMON].sort());
  const byEmail = await searchPhonelessMembers({ db: fdb, orgId: ORG, q: 'simon_h@example.com' });
  assert.deepEqual(byEmail.rows.map((r) => r.id), [SIMON]);
  // the phone filter is in the query itself, so members with a phone never crowd the list
  const q = fdb.log.find((l) => l.op === 'select');
  assert.match(q.desc, /eq:org_id is:deleted_at is:phone or:name\.ilike\.%simon%,email\.ilike\.%simon%/);
  assert.equal(q.cols, LINK_SEARCH_COLS);
  // under three characters, or no organisation: no read at all
  const before = fdb.log.length;
  assert.deepEqual(await searchPhonelessMembers({ db: fdb, orgId: ORG, q: 'si' }), { ok: true, rows: [] });
  assert.deepEqual(await searchPhonelessMembers({ db: fdb, orgId: null, q: 'simon' }), { ok: true, rows: [] });
  assert.equal(fdb.log.length, before);
  // a failed read is an empty list, never an error on screen
  assert.deepEqual(await searchPhonelessMembers({ db: fakeDb([simonRow()], { readFail: true }), orgId: ORG, q: 'simon' }), { ok: false, rows: [] });
});

// ── the link: the display's empty profile folded into the member ─────────────

test('Leeds: number on the display, staff tap Simon, the empty profile folds into him, the chip shows 2/9, one notice, payment lands on Simon', async () => {
  const fdb = fakeDb([simonRow(), shellRow()]);
  const m = fakeMerge(fdb);
  const n = notices();
  const look = lookupSimon();
  const r = await linkOrderCustomer({
    customer: orderCustomer(), member: { id: SIMON, name: 'Simon Hughes' }, phoneN: PHONE,
    db: fdb, orgId: ORG, locId: LEEDS, postMerge: m.post, sendNotice: n.send, lookup: look.fn, now: NOW,
  });
  assert.equal(r.ok, true);
  assert.equal(r.how, 'joined');
  assert.equal(r.profileId, SIMON);
  assert.equal(r.toast, "Linked to Simon Hughes's loyalty");
  // customer-merge: preview, then merge; source = the display's empty profile, target = the member
  assert.deepEqual(m.calls, [
    { action: 'preview', target_id: SIMON, source_id: SHELL, location_id: LEEDS },
    { action: 'merge', target_id: SIMON, source_id: SHELL, location_id: LEEDS },
  ], 'the till never sends a phone choice');
  // the order's customer is now Simon, with his stamps and allergy, and no second offer
  assert.equal(r.customer.name, 'Simon Hughes');
  assert.equal(r.customer.phone, '07762955142', 'the phone stays as typed');
  assert.deepEqual(r.customer.allergens, ['nuts']);
  assert.equal(r.customer.memberLinked, true);
  assert.equal('blankProfile' in r.customer, false);
  assert.equal('email' in r.customer, false, "Simon's email is not put on the order");
  assert.deepEqual(r.customer.stampSummary.map((s) => [s.have, s.need]), [[2, 9]]);
  assert.deepEqual(look.asked, ['07762955142'], 'the same lookup the customer display uses');
  assert.equal(r.loyalty.known, true);
  assert.deepEqual(r.loyalty.stamps, r.customer.stampSummary);
  assert.equal(r.loyalty.pointsEnabled, false);
  // the notice: to the email's owner, once
  assert.deepEqual(n.sent, [{ customer_id: SIMON, source_id: SHELL }]);
  // the phone is Simon's now; paying the order (phone only, as always) lands on Simon
  assert.equal(fdb.row(SIMON).phone, PHONE);
  assert.equal(await upsertCustomerRow({ db: fdb, orgId: ORG, c: r.customer, phoneN: PHONE, now: NOW }), SIMON);
  assert.equal(fdb.row(SIMON).name, 'Simon Hughes');
  assert.equal(fdb.db.customers.filter((c) => !c.deleted_at).length, 1);
});

test('only the member id is trusted: the member is read again, never taken from the list', async () => {
  const fdb = fakeDb([simonRow({ phone: '+447700900123' }), shellRow()]);
  const m = fakeMerge(fdb);
  // the list (stale) said no phone; the member has one now
  const r = await linkOrderCustomer({
    customer: orderCustomer(), member: { id: SIMON, phone: null }, phoneN: PHONE, db: fdb, orgId: ORG, locId: LEEDS, postMerge: m.post, now: NOW,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'member_has_phone');
  assert.equal(r.message, 'That member already has a different phone number, so it was not linked.');
  assert.equal(m.calls.length, 0);
  assert.equal(fdb.row(SIMON).phone, '+447700900123', 'a phone is never moved');
});

test('after payment the empty profile has an order: the server refuses the till, plain words, nothing changes', async () => {
  const fdb = fakeDb([simonRow(), shellRow()]);
  const m = fakeMerge(fdb, { history: true });
  const n = notices();
  const r = await linkOrderCustomer({
    customer: orderCustomer(), member: { id: SIMON }, phoneN: PHONE, db: fdb, orgId: ORG, locId: LEEDS, postMerge: m.post, sendNotice: n.send, now: NOW,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'device_needs_blank_source');
  assert.equal(r.message, 'This customer already has an order. A manager can join them in Back Office > Customers.');
  assert.deepEqual(m.calls.map((c) => c.action), ['preview'], 'no merge is sent after a refused preview');
  assert.deepEqual(n.sent, []);
  assert.equal(fdb.row(SHELL).deleted_at, null);
  assert.equal(fdb.row(SIMON).phone, null);
});

test('a merge that stopped part way is sent once more and finishes; twice stopped says tap again', async () => {
  const fdb = fakeDb([simonRow(), shellRow()]);
  const m = fakeMerge(fdb, { mergeAnswers: [{ status: 500, body: { ok: false, code: 'step_failed', retry_safe: true } }, null] });
  const r = await linkOrderCustomer({ customer: orderCustomer(), member: { id: SIMON }, phoneN: PHONE, db: fdb, orgId: ORG, locId: LEEDS, postMerge: m.post, now: NOW });
  assert.equal(r.ok, true);
  assert.deepEqual(m.calls.map((c) => c.action), ['preview', 'merge', 'merge']);
  const fdb2 = fakeDb([simonRow(), shellRow()]);
  const stuck = { status: 500, body: { ok: false, code: 'step_failed', retry_safe: true } };
  const m2 = fakeMerge(fdb2, { mergeAnswers: [stuck, stuck] });
  const r2 = await linkOrderCustomer({ customer: orderCustomer(), member: { id: SIMON }, phoneN: PHONE, db: fdb2, orgId: ORG, locId: LEEDS, postMerge: m2.post, now: NOW });
  assert.equal(r2.ok, false);
  assert.equal(r2.code, 'join_unfinished');
  assert.equal(r2.message, 'Linking did not finish. Nothing is lost: tap the member again to finish.');
});

test('the member got a phone between preview and merge: the server refuses, plain words', async () => {
  const fdb = fakeDb([simonRow(), shellRow()]);
  const m = fakeMerge(fdb, { mergeAnswers: [{ status: 409, body: { ok: false, action: 'merge', code: 'refused', error: 'The two profiles have different phone numbers', refusals: [{ code: 'different_phones' }] } }] });
  const r = await linkOrderCustomer({ customer: orderCustomer(), member: { id: SIMON }, phoneN: PHONE, db: fdb, orgId: ORG, locId: LEEDS, postMerge: m.post, now: NOW });
  assert.equal(r.code, 'different_phones');
  assert.doesNotMatch(r.message, /different phone numbers \(/, 'never the raw server text');
});

// ── review, 27 Sep 2026: the server keeps the OLDER profile when neither has history ──────

/**
 * customer-merge's choice of survivor, faked from the deployed rule (customerMergePlan
 * chooseSurvivor, no history on either side): the older profile is kept, so an empty profile made
 * before the member turns the pair round and the MEMBER becomes the one folded in. A till (device)
 * is then refused; a till signed in as a manager (staff) gets a preview that says swapped.
 */
function fakeOlderWins(fdb, { as = 'device' } = {}) {
  const calls = [];
  const post = async (body) => {
    calls.push(body);
    const t = fdb.row(body.target_id); const src = fdb.row(body.source_id);
    const swapped = Date.parse(src.created_at) < Date.parse(t.created_at);
    if (!swapped) throw new Error('fake: only the turned round pair is modelled here');
    if (as === 'device') {
      return { status: 403, body: { ok: false, code: 'device_needs_blank_source', error: 'A till can only fold in an empty profile (no name, email, points, stamps or orders). Ask a manager to merge these two in Back Office.' } };
    }
    return { status: 200, body: { ok: true, action: 'preview', can_merge: true, swapped: true, source_blank: false, source_id: t.id, target_id: src.id } };
  };
  return { post, calls };
}

test('an older empty profile and a newer member: the server would fold the MEMBER in; plain words, never "already has an order"', async () => {
  for (const as of ['device', 'staff']) {
    const fdb = fakeDb([simonRow({ created_at: '2026-09-27T09:00:00Z' }), shellRow({ created_at: '2026-09-20T09:00:00Z' })]);
    const m = fakeOlderWins(fdb, { as });
    const n = notices();
    const r = await linkOrderCustomer({ customer: orderCustomer(), member: { id: SIMON }, phoneN: PHONE, db: fdb, orgId: ORG, locId: LEEDS, postMerge: m.post, sendNotice: n.send, now: NOW });
    assert.equal(r.ok, false, as);
    assert.equal(r.code, 'swapped', as);
    assert.equal(r.message, 'These two could not be linked here. A manager can join them in Back Office > Customers.', as);
    assert.doesNotMatch(r.message, /order/, as);
    assert.deepEqual(m.calls.map((c) => c.action), ['preview'], `${as}: no merge after a refused preview`);
    assert.deepEqual(n.sent, [], as);
    assert.equal(fdb.row(SHELL).deleted_at, null, as);
    assert.equal(fdb.row(SIMON).phone, null, as);
  }
});

test('the empty profile is the NEWER one and the server still refuses: it has an order, and staff are told so', async () => {
  const fdb = fakeDb([simonRow({ created_at: '2026-09-20T09:00:00Z' }), shellRow({ created_at: '2026-09-27T09:00:00Z' })]);
  const m = fakeMerge(fdb, { history: true });
  const r = await linkOrderCustomer({ customer: orderCustomer(), member: { id: SIMON }, phoneN: PHONE, db: fdb, orgId: ORG, locId: LEEDS, postMerge: m.post, now: NOW });
  assert.equal(r.code, 'device_needs_blank_source');
  assert.equal(r.message, 'This customer already has an order. A manager can join them in Back Office > Customers.');
});

test("the member holds this number written another way while the display's empty profile holds it exactly: refused, nothing written", async () => {
  // payment (upsertCustomerRow) and the stamp lookup find the EXACT number, the empty profile, so
  // "Linked" would be untrue (review, 27 Sep 2026)
  const fdb = fakeDb([simonRow({ phone: '07762955142' }), shellRow()]);
  const m = fakeMerge(fdb);
  const n = notices();
  const r = await linkOrderCustomer({ customer: orderCustomer(), member: { id: SIMON }, phoneN: PHONE, db: fdb, orgId: ORG, locId: LEEDS, postMerge: m.post, sendNotice: n.send, now: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'phone_elsewhere');
  assert.equal(m.calls.length, 0);
  assert.deepEqual(n.sent, []);
  assert.equal(fdb.log.filter((l) => l.op !== 'select').length, 0);
  // and with no empty profile at all: the member's own number in another form is not "linked" either
  const fdb2 = fakeDb([simonRow({ phone: '07762955142' })]);
  const r2 = await linkOrderCustomer({ customer: orderCustomer(), member: { id: SIMON }, phoneN: PHONE, db: fdb2, orgId: ORG, locId: LEEDS, now: NOW });
  assert.equal(r2.code, 'member_phone_format');
  assert.equal(fdb2.log.filter((l) => l.op !== 'select').length, 0);
});

test('the check reads created_at with the email join columns (to tell a turned round pair from an order)', async () => {
  assert.match(LINK_FACT_COLS, /^id, name, first_name, last_name, phone, phone_raw, email, allergens, tags, created_at$/);
  const fdb = fakeDb([simonRow({ created_at: '2026-09-27T09:00:00Z' }), shellRow({ created_at: '2026-09-20T09:00:00Z' })]);
  const facts = await readLinkFacts({ db: fdb, orgId: ORG, phoneN: PHONE, typedPhone: '07762955142', memberId: SIMON });
  assert.equal(facts.member.created_at, '2026-09-27T09:00:00Z');
  assert.equal(facts.phoneHit.created_at, '2026-09-20T09:00:00Z');
  for (const l of fdb.log) assert.equal(l.cols, LINK_FACT_COLS);
});

// ── the link: no profile has the number yet ──────────────────────────────────

test('no profile has the number yet (a staff typed phone not saved yet): the phone goes on the member, guarded', async () => {
  const fdb = fakeDb([simonRow()]);
  const n = notices();
  const r = await linkOrderCustomer({
    customer: orderCustomer({ blankProfile: undefined, phone: '07762 955142', name: 'Customer' }), member: { id: SIMON }, phoneN: PHONE,
    db: fdb, orgId: ORG, locId: LEEDS, postMerge: null, sendNotice: n.send, now: NOW,
  });
  assert.equal(r.ok, true);
  assert.equal(r.how, 'phone_added');
  assert.equal(fdb.row(SIMON).phone, PHONE);
  assert.equal(fdb.row(SIMON).phone_raw, '07762 955142');
  assert.equal(fdb.row(SIMON).name, 'Simon Hughes', 'a real name is never overwritten');
  assert.deepEqual(n.sent, [{ customer_id: SIMON }]);
  assert.equal(r.customer.name, 'Simon Hughes');
  assert.equal(r.loyalty, null, 'no lookup given: no stamps, the link still stands');
});

test('another till linked the same member a moment ago: the order just uses the member, no second notice', async () => {
  const fdb = fakeDb([simonRow({ phone: PHONE })]);
  const n = notices();
  const r = await linkOrderCustomer({ customer: orderCustomer(), member: { id: SIMON }, phoneN: PHONE, db: fdb, orgId: ORG, locId: LEEDS, sendNotice: n.send, now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.how, 'already');
  assert.deepEqual(n.sent, []);
  assert.equal(fdb.log.filter((l) => l.op !== 'select').length, 0);
});

// ── refusals that write nothing ──────────────────────────────────────────────

test('refusals write nothing: the number on a named profile, on another profile in another form, a member elsewhere', async () => {
  const cases = [
    [[simonRow(), shellRow({ name: 'Ela' })], 'phone_profile_has_details'],
    [[simonRow(), shellRow({ email: 'ela@example.com' })], 'phone_profile_has_details'],
    [[simonRow(), { id: 'raw', org_id: ORG, name: '', email: null, phone: null, phone_raw: '07762955142' }], 'phone_elsewhere'],
    [[simonRow({ org_id: OTHER_ORG })], 'member_gone'],
    [[simonRow({ deleted_at: NOW })], 'member_gone'],
  ];
  for (const [rows, code] of cases) {
    const fdb = fakeDb(rows);
    const m = fakeMerge(fdb);
    const r = await linkOrderCustomer({ customer: orderCustomer(), member: { id: SIMON }, phoneN: PHONE, db: fdb, orgId: ORG, locId: LEEDS, postMerge: m.post, now: NOW });
    assert.equal(r.ok, false, code);
    assert.equal(r.code, code);
    assert.equal(m.calls.length, 0, code);
    assert.equal(fdb.log.filter((l) => l.op !== 'select').length, 0, code);
  }
});

test('the order customer must be new: a named or emailed customer is never linked, and nothing is read', async () => {
  const fdb = fakeDb([simonRow(), shellRow()]);
  for (const c of [orderCustomer({ name: 'Ela', blankProfile: false }), orderCustomer({ email: 'x@example.com' }), orderCustomer({ memberLinked: true }), null, {}]) {
    const r = await linkOrderCustomer({ customer: c, member: { id: SIMON }, phoneN: PHONE, db: fdb, orgId: ORG, locId: LEEDS, now: NOW });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'not_new_customer');
  }
  assert.equal(fdb.log.length, 0);
});

test('nulls never crash (v5.9.86 and v5.9.88 were crashes on a null name, phone or email)', async () => {
  const fdb = fakeDb([simonRow({ name: null, email: null }), shellRow({ name: null, phone_raw: null })]);
  const m = fakeMerge(fdb);
  const r = await linkOrderCustomer({
    customer: { phone: '07762955142', name: null, email: null }, member: { id: SIMON, name: null, email: null }, phoneN: PHONE,
    db: fdb, orgId: ORG, locId: LEEDS, postMerge: m.post, lookup: async () => null, now: NOW,
  });
  assert.equal(r.ok, true);
  assert.equal(r.toast, "Linked to the member's loyalty");
  assert.equal(r.customer.name, '');
  for (const bad of [null, undefined, {}, { id: '' }]) {
    const x = await linkOrderCustomer({ customer: orderCustomer(), member: bad, phoneN: PHONE, db: fdb, orgId: ORG, locId: LEEDS, now: NOW });
    assert.equal(x.code, 'member_gone');
  }
  const y = await linkOrderCustomer({ customer: orderCustomer(), member: { id: SIMON }, phoneN: null, db: fdb, orgId: ORG, locId: LEEDS, now: NOW });
  assert.equal(y.code, 'no_phone');
});

test('a failed or slow check is a plain refusal; a slow merge may still land, so the notice checks for itself', async () => {
  const failing = fakeDb([simonRow(), shellRow()], { readFail: true });
  const a = await linkOrderCustomer({ customer: orderCustomer(), member: { id: SIMON }, phoneN: PHONE, db: failing, orgId: ORG, locId: LEEDS, now: NOW });
  assert.equal(a.code, 'read_failed');
  assert.equal(a.message, 'Could not reach the customer records just now. Nothing was changed. Try again.');
  const slowRead = fakeDb([simonRow(), shellRow()]);
  const b = await linkOrderCustomer({
    customer: orderCustomer(), member: { id: SIMON }, phoneN: PHONE, db: slowRead, orgId: ORG, locId: LEEDS, now: NOW,
    timeout: () => Promise.reject(new TimeoutError('Customer check', 1)),
  });
  assert.equal(b.code, 'read_failed');
  // the read answers, the merge does not
  const fdb = fakeDb([simonRow(), shellRow()]);
  const m = fakeMerge(fdb);
  const n = notices();
  let calls = 0;
  const timeout = (p, ms, label) => { calls += 1; return label === 'Linking the profiles' ? Promise.reject(new TimeoutError(label, ms)) : p; };
  const c = await linkOrderCustomer({ customer: orderCustomer(), member: { id: SIMON }, phoneN: PHONE, db: fdb, orgId: ORG, locId: LEEDS, postMerge: m.post, sendNotice: n.send, timeout, now: NOW });
  assert.equal(c.code, 'timeout');
  assert.equal(c.message, 'The till did not hear back in time. Tap the member again to finish.');
  assert.deepEqual(n.sent, [{ customer_id: SIMON, source_id: SHELL }]);
  assert.ok(calls >= 2);
});

test('the reads only ever touch customers, scoped to the organisation (no gift card, no loyalty table)', async () => {
  const fdb = fakeDb([simonRow(), shellRow()]);
  const m = fakeMerge(fdb);
  await searchPhonelessMembers({ db: fdb, orgId: ORG, q: 'simon' });
  await linkOrderCustomer({ customer: orderCustomer(), member: { id: SIMON }, phoneN: PHONE, db: fdb, orgId: ORG, locId: LEEDS, postMerge: m.post, now: NOW });
  for (const l of fdb.log) {
    assert.equal(l.table, 'customers');
    if (l.op === 'select') assert.match(l.desc, /eq:org_id/);
  }
  const facts = await readLinkFacts({ db: fdb, orgId: ORG, phoneN: PHONE, typedPhone: '07762955142', memberId: SIMON });
  assert.equal(facts.ok, true);
  assert.equal(facts.member.id, SIMON);
  assert.deepEqual(await readLinkFacts({ db: fdb, orgId: ORG, phoneN: '', memberId: SIMON }), { ok: false, code: 'nothing_to_check' });
});
