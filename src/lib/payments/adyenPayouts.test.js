/**
 * adyenPayouts.test.js: ensurePushSweep (supabase/functions/_shared/
 * adyenPayouts.ts) over a fake Adyen. The PATCH decision for the payout
 * speed (10 Oct 2026): the kept sweep's priorities against the wanted ones,
 * one PATCH for everything that differs, and never a second sweep.
 *
 * The .ts is imported as it is (Node strips the types; the CI node does too,
 * see customerImportWiring.test.js).
 *
 * Run: `npm test`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ensurePushSweep } from '../../../supabase/functions/_shared/adyenPayouts.ts';

const BA = 'BA_VENUE';
const SI = 'SI_BANK';
// A sweep as GET /balanceAccounts/{id}/sweeps lists it (docs.adyen.com).
const row = (over = {}) => ({
  id: 'SWPC_1', type: 'push', category: 'bank', schedule: { type: 'daily' }, status: 'active',
  counterparty: { transferInstrumentId: SI }, currency: 'GBP', priorities: ['regular', 'fast'], ...over,
});
const REGULAR_FIRST = row();
const FAST_FIRST = row({ priorities: ['fast', 'regular'] });
const NO_PRIORITIES = (() => { const r = row(); delete r.priorities; return r; })();

// A fake Adyen: the GET answers the given sweeps, every write answers 200
// (or a refusal when asked), and every call is kept for the test to read.
function fakeAdyen(sweeps, { patchOk = true } = {}) {
  const calls = [];
  return {
    calls,
    api: {
      mgmt: async () => { throw new Error('ensurePushSweep never calls the management API'); },
      bcl: async (method, path, body, idem) => {
        calls.push({ method, path, body, idem });
        if (method === 'GET') return { ok: true, status: 200, data: { sweeps } };
        if (method === 'PATCH') {
          if (!patchOk) return { ok: false, status: 422, data: { errorCode: '30_112', message: 'refused' } };
          return { ok: true, status: 200, data: { ...sweeps[0], ...body } };
        }
        if (method === 'POST') return { ok: true, status: 200, data: { id: 'SWPC_NEW', status: 'active', ...body } };
        return { ok: false, status: 500, data: null };
      },
    },
  };
}
const writes = (calls) => calls.filter((c) => c.method !== 'GET');
const base = { balanceAccountId: BA, transferInstrumentId: SI, currency: 'GBP', schedule: 'daily', idempotencyKey: 'sweep:test:venue:SI_BANK' };

test('ensurePushSweep: a GBP sweep with regular first gets ONE PATCH { priorities } to fast, nothing else', async () => {
  const { api, calls } = fakeAdyen([REGULAR_FIRST]);
  const out = await ensurePushSweep(api, base);
  assert.equal(out.ok, true);
  assert.deepEqual(writes(calls), [{ method: 'PATCH', path: `/balanceAccounts/${BA}/sweeps/SWPC_1`, body: { priorities: ['fast', 'regular'] }, idem: undefined }]);
  assert.equal(out.stage, 'done');
  assert.equal(out.updated, true);
  assert.equal(out.updatedPriorities, true);
  assert.equal(out.created, false);
  assert.equal(out.existed, true);
  assert.equal(out.retargeted, null);
  assert.deepEqual(out.deactivated, []);
  assert.equal(out.sweep.id, 'SWPC_1');
  assert.deepEqual(out.sweep.priorities, ['fast', 'regular']);
  assert.equal(out.sweep.speed, 'fast');
  assert.equal(out.sweep.schedule, 'daily');
  assert.equal(out.sweep.transferInstrumentId, SI);
});

test('ensurePushSweep: a sweep already fast first is left alone (no write, updatedPriorities false)', async () => {
  const { api, calls } = fakeAdyen([FAST_FIRST]);
  const out = await ensurePushSweep(api, base);
  assert.equal(out.ok, true);
  assert.deepEqual(writes(calls), []);
  assert.equal(out.updated, false);
  assert.equal(out.updatedPriorities, false);
  assert.equal(out.existed, true);
  assert.equal(out.sweep.speed, 'fast');
  assert.deepEqual(out.sweep.priorities, ['fast', 'regular']);
});

test('ensurePushSweep: speed regular on a fast first sweep PATCHes back to regular', async () => {
  const { api, calls } = fakeAdyen([FAST_FIRST]);
  const out = await ensurePushSweep(api, { ...base, speed: 'regular' });
  assert.deepEqual(writes(calls).map((c) => c.body), [{ priorities: ['regular', 'fast'] }]);
  assert.equal(out.updatedPriorities, true);
  assert.equal(out.sweep.speed, 'regular');
  // and the same word again is no write
  const again = fakeAdyen([REGULAR_FIRST]);
  const o2 = await ensurePushSweep(again.api, { ...base, speed: 'regular' });
  assert.deepEqual(writes(again.calls), []);
  assert.equal(o2.updatedPriorities, false);
});

test('ensurePushSweep: a sweep with no priorities list gets the wanted list', async () => {
  const usd = fakeAdyen([NO_PRIORITIES]);
  const out = await ensurePushSweep(usd.api, { ...base, currency: 'USD' });
  assert.deepEqual(writes(usd.calls).map((c) => c.body), [{ priorities: ['regular', 'fast'] }]);
  assert.equal(out.updatedPriorities, true);
  assert.equal(out.sweep.speed, 'regular');
  const gbp = fakeAdyen([NO_PRIORITIES]);
  const o2 = await ensurePushSweep(gbp.api, base);
  assert.deepEqual(writes(gbp.calls).map((c) => c.body), [{ priorities: ['fast', 'regular'] }]);
  assert.equal(o2.sweep.speed, 'fast');
});

test('ensurePushSweep: USD with no speed wants regular, so a regular first sweep is left alone', async () => {
  const { api, calls } = fakeAdyen([REGULAR_FIRST]);
  const out = await ensurePushSweep(api, { ...base, currency: 'USD' });
  assert.deepEqual(writes(calls), []);
  assert.equal(out.updated, false);
  assert.equal(out.updatedPriorities, false);
  assert.equal(out.sweep.speed, 'regular');
});

test('ensurePushSweep: Adyen casing and a longer list still compare as a list', async () => {
  // Fast, Regular as Adyen might spell it: the same as fast, regular
  const spelt = fakeAdyen([row({ priorities: ['Fast', 'Regular'] })]);
  const out = await ensurePushSweep(spelt.api, base);
  assert.deepEqual(writes(spelt.calls), []);
  assert.equal(out.updatedPriorities, false);
  // fast alone is not fast, regular: the fallback is missing, so it is set
  const short = fakeAdyen([row({ priorities: ['fast'] })]);
  const o2 = await ensurePushSweep(short.api, base);
  assert.deepEqual(writes(short.calls).map((c) => c.body), [{ priorities: ['fast', 'regular'] }]);
  assert.equal(o2.updatedPriorities, true);
});

test('ensurePushSweep: a bank change and a speed change ride in ONE PATCH', async () => {
  const { api, calls } = fakeAdyen([row({ counterparty: { transferInstrumentId: 'SI_OLD' } })]);
  const out = await ensurePushSweep(api, base);
  assert.deepEqual(writes(calls).map((c) => c.body), [{ counterparty: { transferInstrumentId: SI }, schedule: { type: 'daily' }, priorities: ['fast', 'regular'] }]);
  assert.equal(out.retargeted, 'SWPC_1');
  assert.equal(out.updated, true);
  assert.equal(out.updatedPriorities, true);
  assert.equal(out.sweep.transferInstrumentId, SI);
  assert.equal(out.sweep.speed, 'fast');
});

test('ensurePushSweep: a schedule change and a speed change ride in ONE PATCH', async () => {
  const { api, calls } = fakeAdyen([row({ schedule: { type: 'weekly' } })]);
  const out = await ensurePushSweep(api, base);
  assert.deepEqual(writes(calls).map((c) => c.body), [{ schedule: { type: 'daily' }, priorities: ['fast', 'regular'] }]);
  assert.equal(out.updated, true);
  assert.equal(out.updatedPriorities, true);
  assert.equal(out.sweep.schedule, 'daily');
  assert.equal(out.sweep.speed, 'fast');
});

test('ensurePushSweep: a schedule change alone does not touch the priorities', async () => {
  const { api, calls } = fakeAdyen([{ ...FAST_FIRST, schedule: { type: 'weekly' } }]);
  const out = await ensurePushSweep(api, base);
  assert.deepEqual(writes(calls).map((c) => c.body), [{ schedule: { type: 'daily' } }]);
  assert.equal(out.updated, true);
  assert.equal(out.updatedPriorities, false);
  assert.equal(out.sweep.speed, 'fast');
});

test('ensurePushSweep: the schedule it has stays when the caller passes it back (set_payout_speed)', async () => {
  // the admin action hands the existing schedule back, so a weekly payout
  // keeps its day and only the priorities change
  const { api, calls } = fakeAdyen([row({ schedule: { type: 'weekly' } })]);
  const out = await ensurePushSweep(api, { ...base, schedule: 'weekly', speed: 'fast' });
  assert.deepEqual(writes(calls).map((c) => c.body), [{ priorities: ['fast', 'regular'] }]);
  assert.equal(out.sweep.schedule, 'weekly');
  // a cron schedule keeps its expression
  const cron = fakeAdyen([row({ schedule: { type: 'cron', cronExpression: '0 7 * * 1' } })]);
  const o2 = await ensurePushSweep(cron.api, { ...base, schedule: 'cron', cronExpression: '0 7 * * 1', speed: 'fast' });
  assert.deepEqual(writes(cron.calls).map((c) => c.body), [{ priorities: ['fast', 'regular'] }]);
  assert.equal(o2.sweep.schedule, 'cron');
});

test('ensurePushSweep: never a second sweep; with none at all the create carries the speed', async () => {
  const { api, calls } = fakeAdyen([]);
  const out = await ensurePushSweep(api, base);
  assert.equal(out.ok, true);
  assert.equal(out.created, true);
  assert.equal(out.updated, false);
  assert.equal(out.updatedPriorities, false);
  assert.equal(writes(calls).length, 1);
  assert.equal(writes(calls)[0].method, 'POST');
  assert.equal(writes(calls)[0].path, `/balanceAccounts/${BA}/sweeps`);
  assert.deepEqual(writes(calls)[0].body.priorities, ['fast', 'regular']);
  assert.equal(writes(calls)[0].idem, base.idempotencyKey);
  assert.equal(out.sweep.id, 'SWPC_NEW');
  assert.equal(out.sweep.speed, 'fast');
  assert.deepEqual(out.sweep.priorities, ['fast', 'regular']);
  // USD, speed fast asked for
  const usd = fakeAdyen([]);
  const o2 = await ensurePushSweep(usd.api, { ...base, currency: 'USD', speed: 'fast' });
  assert.deepEqual(writes(usd.calls)[0].body.priorities, ['fast', 'regular']);
  assert.equal(o2.sweep.speed, 'fast');
  // USD, nothing asked for
  const usdPlain = fakeAdyen([]);
  const o3 = await ensurePushSweep(usdPlain.api, { ...base, currency: 'USD' });
  assert.deepEqual(writes(usdPlain.calls)[0].body.priorities, ['regular', 'fast']);
  assert.equal(o3.sweep.speed, 'regular');
});

test('ensurePushSweep: with a sweep there, no POST ever happens (a speed change is never a second sweep)', async () => {
  for (const sweeps of [[REGULAR_FIRST], [FAST_FIRST], [NO_PRIORITIES], [row({ counterparty: { transferInstrumentId: 'SI_OLD' } })]]) {
    for (const speed of ['fast', 'regular', undefined]) {
      const { api, calls } = fakeAdyen(sweeps);
      const out = await ensurePushSweep(api, { ...base, speed });
      assert.equal(out.ok, true);
      assert.equal(out.created, false);
      assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
      assert.ok(calls.filter((c) => c.method === 'PATCH').length <= 1, 'at most one PATCH on the kept sweep');
    }
  }
});

test('ensurePushSweep: a refused PATCH answers stage update with updatedPriorities false and no create', async () => {
  const { api, calls } = fakeAdyen([REGULAR_FIRST], { patchOk: false });
  const out = await ensurePushSweep(api, base);
  assert.equal(out.ok, false);
  assert.equal(out.stage, 'update');
  assert.equal(out.status, 422);
  assert.equal(out.updated, false);
  assert.equal(out.updatedPriorities, false);
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
  assert.equal(out.sweep.id, 'SWPC_1');
  assert.equal(out.sweep.speed, 'regular');
  assert.deepEqual(out.data, { errorCode: '30_112', message: 'refused' });
});

test('ensurePushSweep: a sweep list that cannot be read stops at list, with updatedPriorities false', async () => {
  const calls = [];
  const api = {
    mgmt: async () => { throw new Error('never'); },
    bcl: async (method, path) => { calls.push({ method, path }); return { ok: false, status: 401, data: { message: 'no role' } }; },
  };
  const out = await ensurePushSweep(api, base);
  assert.equal(out.ok, false);
  assert.equal(out.stage, 'list');
  assert.equal(out.updatedPriorities, false);
  assert.equal(out.sweep, null);
  assert.equal(calls.length, 1);
});

test('ensurePushSweep: the other live push is switched off and the kept one gets the speed, still one PATCH on it', async () => {
  const other = row({ id: 'SWPC_2', counterparty: { transferInstrumentId: 'SI_OTHER' } });
  const { api, calls } = fakeAdyen([other, REGULAR_FIRST]);
  const out = await ensurePushSweep(api, base);
  assert.deepEqual(writes(calls).map((c) => [c.path.split('/').pop(), c.body]), [
    ['SWPC_2', { status: 'inactive' }],
    ['SWPC_1', { priorities: ['fast', 'regular'] }],
  ]);
  assert.deepEqual(out.deactivated, ['SWPC_2']);
  assert.equal(out.sweep.id, 'SWPC_1');
  assert.equal(out.updatedPriorities, true);
  assert.equal(out.sweep.speed, 'fast');
});
