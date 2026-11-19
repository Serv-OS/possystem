import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { handoffCodeFrom, hashWithoutHandoff, claimHandoff } from './appHandoff.js';

const CODE = 'aGFuZG9mZjphOmI6MQ==.0a1b2c3d';

test('the app code is read from the fragment only, and only when it looks like a code', () => {
  assert.equal(handoffCodeFrom(`#app=${CODE}`), CODE);
  assert.equal(handoffCodeFrom(`#x=1&app=${encodeURIComponent(CODE)}`), CODE);
  assert.equal(handoffCodeFrom('#app='), null);
  assert.equal(handoffCodeFrom('#app=<script>'), null);
  assert.equal(handoffCodeFrom(''), null);
  assert.equal(handoffCodeFrom(null), null);
  assert.equal(hashWithoutHandoff(`#app=${CODE}`), '');
  assert.equal(hashWithoutHandoff(`#x=1&app=${CODE}&y=2`), '#x=1&y=2');
});

function fakeFetch(script) {
  const calls = [];
  const fn = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body, headers: init.headers });
    const r = script[body.action];
    if (r instanceof Error) throw r;
    return { ok: r.status === 200, status: r.status, json: async () => r.json };
  };
  fn.calls = calls;
  return fn;
}
const urls = { gatewayUrl: 'https://x/functions/v1/customer-app', otpUrl: 'https://x/functions/v1/loyalty-otp', anonKey: 'anon' };

test('a good code becomes the member state the page keeps, read from the refresh', async () => {
  const fetchFn = fakeFetch({
    handoff_claim: { status: 200, json: { token: 'tok1', customer: { id: 'c1', phone: '+447000000000' } } },
    refresh: { status: 200, json: { verified: true, token: 'tok2', customer: { id: 'c1', name: 'Jo', phone: '+447000000000' }, loyalty: { points_balance: 12 }, gift_cards: [{ code: 'G' }], stamp_cards: [{ id: 's' }] } },
  });
  const state = await claimHandoff({ ...urls, fetchFn, code: CODE, locationId: 'loc1' });
  assert.deepEqual(state, { phone: '+447000000000', verified: true, customer: { id: 'c1', name: 'Jo', phone: '+447000000000' }, loyalty: { points_balance: 12 }, giftCards: [{ code: 'G' }], stampCards: [{ id: 's' }], token: 'tok2' });
  assert.equal(fetchFn.calls[0].body.code, CODE);
  assert.equal(fetchFn.calls[0].headers.apikey, 'anon');
  assert.deepEqual(fetchFn.calls[1].body, { action: 'refresh', token: 'tok1', location_id: 'loc1' });
});

test('a refused code is null (the page shows its own sign in); a failed refresh still signs in', async () => {
  assert.equal(await claimHandoff({ ...urls, fetchFn: fakeFetch({ handoff_claim: { status: 401, json: { error: 'expired' } } }), code: CODE }), null);
  assert.equal(await claimHandoff({ ...urls, fetchFn: fakeFetch({ handoff_claim: new Error('offline') }), code: CODE }), null);
  assert.equal(await claimHandoff({ ...urls, fetchFn: fakeFetch({}), code: null }), null);
  const partial = await claimHandoff({ ...urls, fetchFn: fakeFetch({ handoff_claim: { status: 200, json: { token: 'tok1', customer: { id: 'c1', phone: '+1' } } }, refresh: { status: 500, json: {} } }), code: CODE });
  assert.deepEqual(partial, { phone: '+1', verified: true, customer: { id: 'c1', phone: '+1' }, loyalty: null, giftCards: [], stampCards: [], token: 'tok1' });
});

test('the ordering page claims the code on boot and the gateway offers both actions', () => {
  const page = fs.readFileSync(new URL('../../surfaces/online/OnlineSurface.jsx', import.meta.url), 'utf8');
  assert.match(page, /handoffCodeFrom\(window\.location\.hash\)/);
  assert.match(page, /claimHandoff\(\{/);
  assert.match(page, /hashWithoutHandoff\(/);
  const fn = fs.readFileSync(new URL('../../../supabase/functions/customer-app/index.ts', import.meta.url), 'utf8');
  assert.match(fn, /case 'handoff_start': return await handoffStart\(body\);/);
  assert.match(fn, /case 'handoff_claim': return await handoffClaim\(body\);/);
  const shared = fs.readFileSync(new URL('../../../supabase/functions/_shared/loyalty-session.ts', import.meta.url), 'utf8');
  assert.match(shared, /const payload = `handoff:\$\{customerId\}:\$\{companyId\}:\$\{now\}`;/);
  assert.match(shared, /if \(kind !== 'handoff'/);
});
