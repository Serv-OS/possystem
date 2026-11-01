// resolveHref (ARCHITECTURE.md section 6): page:<id> → site path, servos:<surface> → the venue's
// customer URL for the right location, anything else as is. Plus the route helpers it leans on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveHref, pickLocation, pagePath, venueUrl, isInternalHref } from './resolveHref.js';

const ctx = {
  customerRoot: 'serv-os.app',
  settings: { default_location_id: 'loc-b' },
  pages: [{ id: 'p-home', slug: '' }, { id: 'p-menu', slug: 'menu' }],
  locations: [{ id: 'loc-a', online_slug: 'mozz-a' }, { id: 'loc-b', online_slug: 'mozz-b' }, { id: 'loc-c', online_slug: null }],
};

test('page: links become site paths', () => {
  assert.equal(resolveHref(ctx, 'page:p-home'), '/');
  assert.equal(resolveHref(ctx, 'page:p-menu'), '/menu');
  assert.equal(resolveHref(ctx, 'page:menu'), '/menu', 'a slug works too');
  assert.equal(resolveHref(ctx, 'page:gone'), '');
});

test('servos: links go to the venue chooser on a multi venue site, to the one venue otherwise, or to the one named', () => {
  // 5.12.7 (Peter, 1 Nov): two venues here, so a plain order, catering or book link asks first.
  assert.equal(resolveHref(ctx, 'servos:order'), '/order');
  assert.equal(resolveHref(ctx, 'servos:catering'), '/order/catering');
  assert.equal(resolveHref(ctx, 'servos:book'), '/order/book');
  assert.equal(resolveHref(ctx, 'servos:order:default'), '/order');
  const one = { ...ctx, locations: [{ id: 'loc-b', online_slug: 'mozz-b' }, { id: 'loc-c', online_slug: null }] };
  assert.equal(resolveHref(one, 'servos:order'), 'https://mozz-b.serv-os.app/', 'one venue a visitor can order from: straight there');
  assert.equal(resolveHref(one, 'servos:catering'), 'https://mozz-b.serv-os.app/catering');
  assert.equal(resolveHref(one, 'servos:book'), 'https://mozz-b.serv-os.app/book');
  // Company wide surfaces never ask.
  assert.equal(resolveHref(ctx, 'servos:loyalty'), 'https://mozz-b.serv-os.app/account');
  assert.equal(resolveHref(ctx, 'servos:gift'), 'https://mozz-b.serv-os.app/gift');
  assert.equal(resolveHref(ctx, 'servos:waitlist'), 'https://mozz-b.serv-os.app/waitlist');
  assert.equal(resolveHref(ctx, 'servos:order:loc-a'), 'https://mozz-a.serv-os.app/');
  assert.equal(resolveHref(ctx, 'servos:order:mozz-a'), 'https://mozz-a.serv-os.app/');
  assert.equal(resolveHref({ ...ctx, customerRoot: 'dev.serv-os.app' }, 'servos:order:loc-b'), 'https://mozz-b.dev.serv-os.app/');
  assert.equal(resolveHref(ctx, 'servos:unknown'), '');
  assert.equal(resolveHref({ ...ctx, locations: [] }, 'servos:order'), '', 'no venue = no link, never a throw');
});

test('plain links pass through, bare words become site paths, junk becomes nothing', () => {
  assert.equal(resolveHref(ctx, '/find-us'), '/find-us');
  assert.equal(resolveHref(ctx, 'https://instagram.com/x'), 'https://instagram.com/x');
  assert.equal(resolveHref(ctx, 'mailto:a@b.c'), 'mailto:a@b.c');
  assert.equal(resolveHref(ctx, 'menu'), '/menu');
  assert.equal(resolveHref(ctx, 'javascript:alert(1)'), '');
  assert.equal(resolveHref(ctx, ''), '');
  assert.equal(resolveHref(null, 'page:x'), '');
});

test('pickLocation: by id, ops id or slug; else the default; else the first with a slug', () => {
  assert.equal(pickLocation(ctx, 'loc-a').id, 'loc-a');
  assert.equal(pickLocation(ctx, 'default').id, 'loc-b');
  assert.equal(pickLocation(ctx, 'all').id, 'loc-b');
  assert.equal(pickLocation(ctx, 'missing').id, 'loc-b');
  assert.equal(pickLocation({ locations: ctx.locations, settings: {} }, null).id, 'loc-a');
  assert.equal(pickLocation({ locations: [] }, 'x'), null);
});

test('pagePath, venueUrl and isInternalHref', () => {
  assert.equal(pagePath({ slug: '' }), '/');
  assert.equal(pagePath({ slug: '/menu' }), '/menu');
  assert.equal(venueUrl('mozz', '/gift/balance'), 'https://mozz.serv-os.app/gift/balance');
  assert.equal(venueUrl(null, '/'), '');
  assert.ok(isInternalHref('/menu') && !isInternalHref('//evil.com') && !isInternalHref('https://x'));
});

// 5.12.8: whose menu an unpinned menu block shows.
test('menuLocation: a pinned block keeps its venue; an unpinned one follows the visitor pick, else the default', async () => {
  const { menuLocation, menuVenues } = await import('./resolveHref.js');
  assert.equal(menuLocation(ctx, 'loc-a').id, 'loc-a', 'pinned = the starting venue');
  assert.equal(menuLocation({ ...ctx, menuVenue: 'mozz-a' }, 'loc-b').id, 'loc-a', '5.12.9: the visitor pick beats the starting venue');
  assert.equal(menuLocation({ ...ctx, menuVenue: 'mozz-a', pageKind: 'location' }, 'loc-b').id, 'loc-b', 'a venue page is that venue, pick ignored');
  assert.equal(menuLocation(ctx, 'default').id, 'loc-b', 'site default');
  assert.equal(menuLocation({ ...ctx, menuVenue: 'mozz-a' }, 'default').id, 'loc-a', 'the pick by slug');
  assert.equal(menuLocation({ ...ctx, menuVenue: 'loc-a' }, 'all').id, 'loc-a', 'the pick by id');
  assert.equal(menuLocation({ ...ctx, menuVenue: 'nowhere' }, 'default').id, 'loc-b', 'an unknown pick falls back to the default, never a throw');
  assert.equal(menuLocation({ ...ctx, locations: [] }, 'default'), null);
  const withOps = { ...ctx, locations: [{ id: 'loc-b', online_slug: 'mozz-b', ops_location_id: 'o2', name: 'Zed' }, { id: 'loc-a', online_slug: 'mozz-a', ops_location_id: 'o1', name: 'Alpha' }, { id: 'loc-c', online_slug: null, ops_location_id: 'o3', name: 'Dark' }] };
  assert.deepEqual(menuVenues(withOps).map((l) => l.id), ['loc-a', 'loc-b'], 'venues with a slug, by name; no slug = not switchable');
});
