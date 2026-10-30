// src/lib/authUserLookup.test.js
// 5.11.123: create-user finds an existing email with one filtered request, whatever the user count.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { adminUsersUrl, pickByEmail, findAuthUserByEmail } from '../../supabase/functions/_shared/authUserLookup.js';

const URL0 = 'https://tbetcegmszzotrwdtqhi.supabase.co';
const ok = (body) => ({ ok: true, json: async () => body });

test('the admin users URL carries the email filter, lower cased', () => {
  const u = new URL(adminUsersUrl(URL0, ' Mickey@NextFlavourKitchens.com '));
  assert.equal(u.pathname, '/auth/v1/admin/users');
  assert.equal(u.searchParams.get('filter'), 'mickey@nextflavourkitchens.com');
  assert.equal(u.searchParams.get('per_page'), '50');
});

test('pickByEmail: the exact address only (the filter is a contains match, kitchena is not kitchens)', () => {
  const users = [{ id: 'a', email: 'mickey@nextflavourkitchena.com' }, { id: 'b', email: 'Mickey@NextFlavourKitchens.com' }];
  assert.equal(pickByEmail(users, 'mickey@nextflavourkitchens.com').id, 'b');
  assert.equal(pickByEmail(users, 'mickey@nextflavourkitchen.com'), null);
});

test('one filtered request finds a July account behind 6,000 anonymous users; the walk is never needed', async () => {
  let walked = 0;
  const fetchFn = async (url, init) => {
    assert.match(url, /filter=mickey%40nextflavourkitchens\.com/);
    assert.equal(init.headers.apikey, 'svc'); assert.equal(init.headers.Authorization, 'Bearer svc');
    return ok({ users: [{ id: 'a2594a65', email: 'mickey@nextflavourkitchens.com' }], aud: 'authenticated' });
  };
  const hit = await findAuthUserByEmail({ supabaseUrl: URL0, serviceKey: 'svc', email: 'mickey@nextflavourkitchens.com', fetchFn, listUsers: async () => { walked++; return { data: { users: [] } }; } });
  assert.equal(hit.id, 'a2594a65'); assert.equal(walked, 0);
});

test('a well formed empty answer means nobody; a failed request falls back to the walk and finds page 3', async () => {
  const none = await findAuthUserByEmail({ supabaseUrl: URL0, serviceKey: 'svc', email: 'x@y.com', fetchFn: async () => ok({ users: [] }), listUsers: async () => { throw new Error('never'); } });
  assert.equal(none, null);
  const pages = { 1: Array.from({ length: 200 }, (_, i) => ({ id: `p1-${i}`, email: `anon${i}@x.com` })), 2: Array.from({ length: 200 }, (_, i) => ({ id: `p2-${i}`, email: `b${i}@x.com` })), 3: [{ id: 'deep', email: 'x@y.com' }] };
  const hit = await findAuthUserByEmail({ supabaseUrl: URL0, serviceKey: 'svc', email: 'x@y.com', fetchFn: async () => ({ ok: false, json: async () => ({}) }), listUsers: async ({ page }) => ({ data: { users: pages[page] || [] } }) });
  assert.equal(hit.id, 'deep');
  // Nothing anywhere, and a throwing fetch: null, never a throw.
  assert.equal(await findAuthUserByEmail({ supabaseUrl: URL0, serviceKey: 'svc', email: 'x@y.com', fetchFn: async () => { throw new Error('down'); }, listUsers: async () => ({ data: { users: [] } }) }), null);
  assert.equal(await findAuthUserByEmail({ supabaseUrl: URL0, serviceKey: 'svc', email: '', fetchFn: async () => ok({ users: [] }) }), null);
});

test('create-user is wired: filtered lookup, profile UPSERT, super admin sets the typed password, venue callers never do', () => {
  const src = readFileSync(new URL('../../supabase/functions/create-user/index.ts', import.meta.url), 'utf8');
  assert.match(src, /findAuthUserByEmail\(\{/);
  assert.ok(!/while \(page <= 20/.test(src), 'the 4,000 user walk is gone from the function');
  assert.match(src, /from\('user_profiles'\)\.upsert\(\{\s*id: userId,/);
  assert.match(src, /\}, \{ onConflict: 'id' \}\)\.select\('id, role'\)/);
  assert.match(src, /if \(isSuper && password\) \{\s*const \{ error: pwErr \} = await supabaseAdmin\.auth\.admin\.updateUserById\(userId, \{ password \}\);/);
  assert.ok(src.indexOf('if (isSuper && password)') < src.indexOf('if (alreadyExisted && !isSuper)'), 'the password is set only on the super path, before the venue caller branch');
  assert.match(src, /their password is unchanged/);
});
