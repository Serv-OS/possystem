// v5.10.0: a discount's approving manager is a name tag, never the staff record.
// 27 Sep 2026 (read only query on Ops): Coffee Boy Leeds closed_checks "Custom 100%" and
// "Staff Discount 50%" carried discounts[].manager = the whole staff_members row, PIN in plain
// text, permissions and staff card id included.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { approverStamp, scrubDiscount, scrubDiscounts, scrubItemDiscounts, scrubCheckApprovers } from './discountApprover.js';
import { closedCheckRow } from './closedCheckRow.js';
import { writeClosedCheckRow, resetMissingColumns } from './closedCheckWrite.js';

const SECRET_KEYS = ['pin', 'nfcCardId', 'nfc_card_id', 'permissions', 'authMethod'];

// The staff record the till holds for the signed in manager (lib/staffRoster.js shape).
const MANAGER = {
  id: 'b1f0c6e2-0000-4000-8000-000000000001', name: 'Sam Manager', role: 'Manager',
  pin: '4821', color: '#15C26A', initials: 'SM', permissions: ['manager', 'refunds', 'voids'],
  active: true, nfcCardId: '04A22B3C', authMethod: 'pin',
};

/** Every key path under `v` whose key is a secret, e.g. ['discounts[0].manager.pin']. */
function secretPaths(v, path = '') {
  if (Array.isArray(v)) return v.flatMap((x, i) => secretPaths(x, `${path}[${i}]`));
  if (!v || typeof v !== 'object') return [];
  return Object.entries(v).flatMap(([k, x]) => [
    ...(SECRET_KEYS.includes(k) ? [`${path}.${k}`] : []),
    ...secretPaths(x, `${path}.${k}`),
  ]);
}

// The discount DiscountModal used to emit for a signed in manager (Leeds shape).
const leedsDiscount = (label, value) => ({
  id: `disc-${value}`, label, type: 'percent', value, scope: 'check', itemUids: null,
  amount: 4.2, manager: { ...MANAGER },
});

test('approverStamp keeps id, name and role only', () => {
  assert.deepEqual(approverStamp(MANAGER), { id: MANAGER.id, name: 'Sam Manager', role: 'Manager' });
  assert.deepEqual(approverStamp({ id: 's1', name: 'Alex', pin: '1234' }), { id: 's1', name: 'Alex' });
  assert.equal(approverStamp(null), null);
  assert.equal(approverStamp('Alex'), null);
  assert.equal(approverStamp({ pin: '1234', permissions: ['manager'] }), null, 'a record with nothing safe is no tag at all');
});

test('scrubDiscount turns the Leeds staff record into a name tag and leaves the money alone', () => {
  const d = leedsDiscount('Custom 100%', 100);
  const s = scrubDiscount(d);
  assert.deepEqual(s.manager, { id: MANAGER.id, name: 'Sam Manager', role: 'Manager' });
  assert.deepEqual(secretPaths(s), []);
  for (const k of ['id', 'label', 'type', 'value', 'scope', 'itemUids', 'amount']) assert.deepEqual(s[k], d[k], k);
  assert.equal(d.manager.pin, '4821', 'the caller\'s object is not mutated');
});

test('nothing to scrub gives the same object back (no churn on every write)', () => {
  const plain = { id: 'd1', label: 'Staff meal', type: 'percent', value: 50, manager: null };
  assert.equal(scrubDiscount(plain), plain);
  const tagged = { id: 'd2', label: 'Comp', manager: { id: 's1', name: 'Alex', role: 'Manager' } };
  assert.equal(scrubDiscount(tagged), tagged);
  const named = { id: 'd3', label: 'MPOS', appliedBy: 'Alex', manager: 'Alex' };
  assert.equal(scrubDiscount(named), named);
  const list = [plain, tagged, named];
  assert.equal(scrubDiscounts(list), list);
  const items = [{ uid: 'i1', price: 3 }, { uid: 'i2', price: 4, discount: tagged }];
  assert.equal(scrubItemDiscounts(items), items);
  assert.equal(scrubDiscounts(undefined), undefined);
  assert.equal(scrubItemDiscounts(null), null);
});

test('a check written for close never carries pin, nfcCardId or permissions (closedCheckRow)', () => {
  const check = {
    id: 'chk-1', ref: 'R801', server: 'Jo', tableId: 't4', tableLabel: 'T4', method: 'card',
    subtotal: 8.4, total: 4.2, closedAt: Date.UTC(2026, 8, 27, 12, 0),
    items: [
      { uid: 'i1', name: 'Latte', price: 3.2, qty: 1 },
      { uid: 'i2', name: 'Toastie', price: 5.2, qty: 1, discount: { id: 'disc-i2', label: 'Comp', type: 'percent', value: 100, manager: { ...MANAGER } } },
    ],
    discounts: [leedsDiscount('Staff Discount 50%', 50), leedsDiscount('Custom 100%', 100)],
  };
  const row = closedCheckRow(check, 'loc-leeds');
  assert.deepEqual(secretPaths(row), [], 'no secret anywhere on the row');
  assert.equal(row.discounts.length, 2);
  assert.equal(row.discounts[0].manager.name, 'Sam Manager', 'the approver\'s name still reaches reports');
  assert.equal(row.discounts[1].manager.id, MANAGER.id);
  assert.equal(row.items[1].discount.manager.name, 'Sam Manager');
  assert.equal(row.items[0], check.items[0], 'undiscounted lines pass through untouched');
  assert.equal(check.discounts[0].manager.pin, '4821', 'the in-memory check is not mutated');
});

test('writeClosedCheckRow strips a staff record from any writer\'s row before it is sent', async () => {
  resetMissingColumns();
  let sent = null;
  const client = { from: () => ({ insert: (p) => { sent = p; return Promise.resolve({ data: null, error: null }); } }) };
  const row = {
    id: 'chk-2', location_id: 'loc-leeds', total: 0, method: 'cash',
    discounts: [leedsDiscount('Custom 100%', 100)],
    items: [{ uid: 'i1', name: 'Flat white', price: 3, qty: 1, discount: leedsDiscount('Comp', 100) }],
  };
  const res = await writeClosedCheckRow(client, row);
  assert.equal(res.error, null);
  assert.deepEqual(secretPaths(sent), []);
  assert.equal(sent.discounts[0].manager.name, 'Sam Manager');
  assert.equal(row.discounts[0].manager.pin, '4821', 'the caller\'s row is not mutated');
});

test('a reader job check_draft carries no staff record (scrubCheckApprovers)', () => {
  const draft = { source: 'pos', tableId: 't4', discounts: [leedsDiscount('Custom 100%', 100)], items: [{ uid: 'i1', price: 3 }] };
  const s = scrubCheckApprovers(draft);
  assert.deepEqual(secretPaths(s), []);
  assert.equal(s.items, draft.items);
  const clean = { source: 'pos', discounts: [], items: [] };
  assert.equal(scrubCheckApprovers(clean), clean);
});

// The till surfaces are React and the store imports supabase, so these pins read the source.
const src = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('pin: DiscountModal emits a name tag, never the manager record', () => {
  const m = src('../components/DiscountModal.jsx');
  assert.match(m, /import \{ approverStamp \} from '\.\.\/lib\/discountApprover'/);
  assert.match(m, /manager: approverStamp\(mgr\)/);
  assert.doesNotMatch(m, /manager: mgr\b/);
});

test('pin: every store add*Discount scrubs, and the reader job draft is scrubbed', () => {
  const s = src('../store/index.js');
  assert.match(s, /import \{ scrubDiscount \} from '\.\.\/lib\/discountApprover'/);
  assert.match(s, /addCheckDiscount: \(tableId, discount\) => \{\n\s+discount = scrubDiscount\(discount\);/);
  assert.match(s, /addItemDiscount: \(tableId, itemUid, discount\) => \{\n\s+discount = scrubDiscount\(discount\);/);
  assert.match(s, /discounts:\[\.\.\.\(s\.walkInOrder\?\.discounts\|\|\[\]\), scrubDiscount\(discount\)\]/);
  const j = src('./payments/terminalJobs.js');
  assert.match(j, /check_draft: scrubCheckApprovers\(p\.checkDraft \?\? \{\}\)/);
});
