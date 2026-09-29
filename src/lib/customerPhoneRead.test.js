// src/lib/customerPhoneRead.test.js
//
// ONE READ OF A CUSTOMER BY PHONE, by the one phone match key (29 Sep 2026). Peter: "I just placed
// an order online and its registered me again as a customer". Drives
// supabase/functions/_shared/customerPhoneRead.js (the till's upsert, the customer display, the
// loyalty login, WiFi, bookings, gift cards and HubRise all read through it) against a fake
// customers table that answers like PostgREST, with the live shapes of 29 Sep 2026: Peter's
// imported member '+447931129015' and the duplicate the QR order made, '07931129015'.
// Run: `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readCustomerByPhone } from '../../supabase/functions/_shared/customerPhoneRead.js';

const ORG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_ORG = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function fakeDb(rows, { fail = false } = {}) {
  const calls = [];
  const from = (table) => {
    const q = { table, cols: '*', filters: [], order: null, lim: null, ins: null };
    const b = {
      select(cols) { q.cols = cols; return b; },
      eq(c, v) { q.filters.push((r) => r[c] != null && String(r[c]) === String(v)); return b; },
      is(c, v) { q.filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return b; },
      in(c, vs) { q.ins = vs.slice(); const set = new Set(vs.map(String)); q.filters.push((r) => r[c] != null && set.has(String(r[c]))); return b; },
      order(c, { ascending = true } = {}) { q.order = [c, ascending]; return b; },
      limit(k) { q.lim = k; return b; },
      maybeSingle() { throw new Error('never .maybeSingle() for a phone: two rows for one number made it error'); },
      then(ok, bad) {
        return Promise.resolve().then(() => {
          calls.push(q);
          if (fail) return { data: null, error: { message: 'read failed (fake)' } };
          let found = rows.filter((r) => q.filters.every((f) => f(r)));
          if (q.order) {
            const [c, asc] = q.order;
            found = found.slice().sort((a, z) => (String(a[c]) === String(z[c]) ? 0 : (String(a[c]) < String(z[c])) === asc ? -1 : 1));
          }
          if (q.lim != null) found = found.slice(0, q.lim);
          const cols = String(q.cols).split(',').map((c) => c.trim());
          const data = found.map((r) => (cols.includes('*') ? { ...r } : Object.fromEntries(cols.map((c) => [c, r[c] ?? null]))));
          return { data, error: null };
        }).then(ok, bad);
      },
    };
    return b;
  };
  return { from, calls };
}

const row = (id, phone, created_at, over = {}) => ({ id, org_id: ORG, phone, name: id, email: null, deleted_at: null, created_at, ...over });
// The live shapes, 29 Sep 2026 (Coffee Boy): the imported member and the QR order's duplicate.
const MEMBER = row('member', '+447931129015', '2026-09-21T09:00:00+00:00', { name: 'Peter Roberts', source: 'import' });
const QR_DUP = row('qr-duplicate', '07931129015', '2026-09-29T11:35:00+00:00', { name: '', source: 'qr' });
const LANDLINE = row('landline', '01172273489', '2026-09-21T09:00:00+00:00');
const NEIGHBOUR = row('neighbour', '+447931129016', '2026-09-21T09:00:00+00:00');

test('the bug: an order typed 07931129015 finds the imported +447931129015 member', async () => {
  const db = fakeDb([MEMBER, NEIGHBOUR]);
  for (const typed of ['07931129015', '07931 129015', '+44 7931 129015', '0044 7931 129015', '+44 (0) 7931 129015']) {
    const { data, error } = await readCustomerByPhone(db, { orgId: ORG, phone: typed, region: 'GB', cols: 'id, name' });
    assert.equal(error, null);
    assert.equal(data?.id, 'member', typed);
  }
});

test('two rows for one number: the member (stored as the key) wins, never an error', async () => {
  const db = fakeDb([QR_DUP, MEMBER]);
  for (const typed of ['07931129015', '+447931129015']) {
    const { data } = await readCustomerByPhone(db, { orgId: ORG, phone: typed, region: 'GB' });
    assert.equal(data.id, 'member', typed);
  }
  // with no row stored as the key, the oldest
  const older = row('older', '447931129015', '2026-09-01T00:00:00+00:00');
  const { data } = await readCustomerByPhone(fakeDb([QR_DUP, older]), { orgId: ORG, phone: '+447931129015', region: 'GB' });
  assert.equal(data.id, 'older');
});

test('rows older builds stored in other shapes are found: a national landline, the digits an online order stored', async () => {
  const digits = row('digits', '447700900123', '2026-09-20T12:00:00+00:00');
  const db = fakeDb([LANDLINE, digits]);
  assert.equal((await readCustomerByPhone(db, { orgId: ORG, phone: '+44 117 227 3489', region: 'GB' })).data.id, 'landline');
  assert.equal((await readCustomerByPhone(db, { orgId: ORG, phone: '0117 227 3489', region: 'GB' })).data.id, 'landline');
  assert.equal((await readCustomerByPhone(db, { orgId: ORG, phone: '07700 900123', region: 'GB' })).data.id, 'digits');
});

test('a stored number without its country code is read only where it cannot be another number', async () => {
  // A US venue keys a typed US number (+1), and finds the row stored as that key...
  const hank = row('hank', '+16505551234', '2026-09-10T12:00:00+00:00');
  for (const typed of ['+1 650 555 1234', '(650) 555-1234', '1-650-555-1234']) {
    assert.equal((await readCustomerByPhone(fakeDb([hank]), { orgId: ORG, phone: typed, region: 'US' })).data?.id, 'hank', typed);
  }
  // ...but never reads a STORED bare 10 digit number as American (review finding 3): a London
  // number stored without its 0 at a UK venue of the same organisation looks exactly the same.
  const london = row('london', '2014812891', '2026-09-10T12:00:00+00:00');
  for (const region of ['US', 'GB']) {
    assert.equal((await readCustomerByPhone(fakeDb([london]), { orgId: ORG, phone: '+1 201 481 2891', region })).data, null, region);
  }
  // review finding 2: a verified +32 number never finds a bare '3235550147' (a US number typed
  // without its +1 at a UK venue), in the loyalty login or at the till
  const la = row('la-visitor', '3235550147', '2026-09-10T12:00:00+00:00');
  assert.equal((await readCustomerByPhone(fakeDb([la]), { orgId: ORG, phone: '+32 3 555 01 47', region: 'GB' })).data, null);
  assert.equal((await readCustomerByPhone(fakeDb([la]), { orgId: ORG, phone: '+3235550147', typed: '+32 3 555 01 47', region: 'GB' })).data, null);
  // the old UK only rule is no lookup: '07931129015' typed in a US venue is not the +44 member
  assert.equal((await readCustomerByPhone(fakeDb([MEMBER]), { orgId: ORG, phone: '07931129015', region: 'US' })).data, null);
});

test('the till passes its own key: keyed again it is the same number, never a US one', async () => {
  // '+44 3887 9681' (one digit short) typed at a US venue: the key keeps its +, so the till's
  // read of its own key never finds the Maryland member '+14438879681'
  const maryland = row('maryland', '+14438879681', '2026-09-10T12:00:00+00:00');
  const db = fakeDb([maryland]);
  assert.equal((await readCustomerByPhone(db, { orgId: ORG, phone: '+4438879681', typed: '+44 3887 9681', region: 'US' })).data, null);
  assert.equal((await readCustomerByPhone(db, { orgId: ORG, phone: '(443) 887-9681', region: 'US' })).data?.id, 'maryland');
});

test('a long number (an extension) is still looked up by its key (review finding 6)', async () => {
  const ext = row('ext', '07931129015123456', '2026-09-10T12:00:00+00:00');
  const db = fakeDb([ext]);
  assert.equal((await readCustomerByPhone(db, { orgId: ORG, phone: '07931 129015 ext 123456', region: 'GB' })).data?.id, 'ext');
  assert.deepEqual(db.calls[0].ins, ['07931129015123456']);
});

test('(0)7931 129015 is the member (review finding 5)', async () => {
  const { data } = await readCustomerByPhone(fakeDb([QR_DUP, MEMBER]), { orgId: ORG, phone: '(0)7931 129015', region: 'GB' });
  assert.equal(data.id, 'member');
});

test('never another number, never another organisation, never a deleted profile', async () => {
  const theirs = { ...MEMBER, id: 'theirs', org_id: OTHER_ORG };
  const gone = { ...MEMBER, id: 'gone', deleted_at: '2026-09-25T00:00:00+00:00' };
  const db = fakeDb([NEIGHBOUR, theirs, gone]);
  assert.equal((await readCustomerByPhone(db, { orgId: ORG, phone: '07931129015', region: 'GB' })).data, null);
});

test('the read: one query, safe values, the key first, only the columns asked for', async () => {
  const db = fakeDb([MEMBER]);
  const { data } = await readCustomerByPhone(db, { orgId: ORG, phone: "07931,129015)'", region: 'GB', cols: 'id, name, email' });
  assert.deepEqual(data, { id: 'member', name: 'Peter Roberts', email: null });
  assert.equal(db.calls.length, 1);
  assert.equal(db.calls[0].ins[0], '+447931129015');
  for (const v of db.calls[0].ins) assert.match(v, /^\+?[0-9]{7,16}$/);
  // '*' is the whole row
  const whole = await readCustomerByPhone(fakeDb([MEMBER]), { orgId: ORG, phone: '07931129015', region: 'GB', cols: '*' });
  assert.equal(whole.data.source, 'import');
  // the number as typed is looked under too, beside the key
  const both = fakeDb([QR_DUP]);
  assert.equal((await readCustomerByPhone(both, { orgId: ORG, phone: '+447931129015', typed: '07931 129015', region: '' })).data.id, 'qr-duplicate');
});

test('nothing to read: too short, no org, no client; a failed read says so', async () => {
  const db = fakeDb([MEMBER]);
  assert.deepEqual(await readCustomerByPhone(db, { orgId: ORG, phone: '12345', region: 'GB' }), { data: null, error: null });
  assert.deepEqual(await readCustomerByPhone(db, { orgId: null, phone: '07931129015', region: 'GB' }), { data: null, error: null });
  assert.deepEqual(await readCustomerByPhone(null, { orgId: ORG, phone: '07931129015', region: 'GB' }), { data: null, error: null });
  assert.equal(db.calls.length, 0);
  const failed = await readCustomerByPhone(fakeDb([MEMBER], { fail: true }), { orgId: ORG, phone: '07931129015', region: 'GB' });
  assert.equal(failed.data, null);
  assert.equal(failed.error.message, 'read failed (fake)');
});
