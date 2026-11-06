// visitPing.test.js (5.12.67): the page view ping's own rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldPing, pingPayload, sendPing } from './visitPing.js';
import { reviewsAskOf, reviewRowsForBlocks } from './reviewsOnPage.js';

test('a view is reported only on a live site with visits on', () => {
  const snapshot = { site: { settings: {} } };
  assert.equal(shouldPing({ snapshot }), true);
  assert.equal(shouldPing({ snapshot: { site: { settings: { analytics_enabled: false } } } }), false);
  assert.equal(shouldPing({ snapshot, preview: true }), false);
  assert.equal(shouldPing({ snapshot, editor: true }), false);
  assert.equal(shouldPing({ snapshot: null }), false);
});

test('the payload carries host, path, referrer, utm and the message token and nothing else', () => {
  const loc = { hostname: 'Mozz.sites.serv-os.app', pathname: '/menu', search: '?utm_source=servos&utm_medium=email&utm_campaign=c-1&sv_m=m-1&x=secret' };
  const b = pingPayload({ loc, referrer: 'https://google.com/search?q=pizza' });
  assert.deepEqual(b, { host: 'mozz.sites.serv-os.app', path: '/menu', referrer: 'https://google.com/search?q=pizza', utm_source: 'servos', utm_medium: 'email', utm_campaign: 'c-1', sv_m: 'm-1' });
  assert.deepEqual(pingPayload({ loc: { hostname: 'a.test', pathname: '/', search: '' } }), { host: 'a.test', path: '/' });
  assert.equal(pingPayload({ loc: null }), null);
  assert.equal(sendPing('', { host: 'a' }), false);
});

test('reviews: no site switch, the Reviews block on the page is the ask, the widest block wins', () => {
  const page = { layout: { content: [{ type: 'Reviews', props: { min_stars: 5, count: 3 } }, { type: 'Reviews', props: { min_stars: 3, count: 9 } }, { type: 'Text', props: {} }] } };
  assert.deepEqual(reviewsAskOf(page), { min: 3, count: 9 });
  assert.equal(reviewsAskOf({ layout: { content: [{ type: 'Text', props: {} }] } }), null);
  assert.deepEqual(reviewRowsForBlocks([{ rating: 5, comment: 'Great', author: 'Jane S.', created_at: '2026-11-01', source: 'google' }, { rating: 4, comment: '  ' }]),
    [{ rating: 5, text: 'Great', author: 'Jane S.', date: '2026-11-01', source: 'google' }]);
});
