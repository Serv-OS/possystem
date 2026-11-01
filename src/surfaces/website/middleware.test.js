// The edge middleware that sends "/" on a website host to api/site.js (5.12.7). The static SPA
// index.html at "/" beat the vercel.json rewrite, so the home page of posup-test.sites.serv-os.app
// was the bare app shell: no server rendered page and no scroll.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import middleware, { isWebsiteHost, rewriteFor, config } from '../../../middleware.js';

const req = (url, host) => ({ url, headers: new Headers(host ? { host } : {}) });

test('only "/" and "/index.html" are matched, and only website hosts are rewritten', () => {
  assert.deepEqual(config.matcher, ['/', '/index.html']);
  assert.equal(isWebsiteHost('posup-test.sites.serv-os.app'), true);
  assert.equal(isWebsiteHost('www.mozzartisanpizza.com'), true, 'a venue\'s own domain');
  assert.equal(isWebsiteHost('app.serv-os.app'), false, 'the Back Office');
  assert.equal(isWebsiteHost('mozz.serv-os.app'), false, 'a customer surface host');
  assert.equal(isWebsiteHost('sites.serv-os.app'), false);
  assert.equal(isWebsiteHost('possystem-liard.vercel.app'), false);
  assert.equal(isWebsiteHost('localhost:5173'), false);
  assert.equal(isWebsiteHost(''), false);
});

test('rewriteFor: "/" on a site host goes to api/site with the path, other paths and hosts are left alone', () => {
  assert.equal(rewriteFor('https://posup-test.sites.serv-os.app/', 'posup-test.sites.serv-os.app'), 'https://posup-test.sites.serv-os.app/api/site?path=%2F');
  assert.equal(rewriteFor('https://posup-test.sites.serv-os.app/index.html?utm=x', 'posup-test.sites.serv-os.app'), 'https://posup-test.sites.serv-os.app/api/site?path=%2F&utm=x');
  assert.equal(rewriteFor('https://posup-test.sites.serv-os.app/menu', 'posup-test.sites.serv-os.app'), null);
  assert.equal(rewriteFor('https://app.serv-os.app/', 'app.serv-os.app'), null);
  assert.equal(rewriteFor('not a url', 'posup-test.sites.serv-os.app'), null, 'never throws');
});

test('middleware answers a rewrite response for a site home and nothing otherwise', () => {
  const r = middleware(req('https://posup-test.sites.serv-os.app/', 'posup-test.sites.serv-os.app'));
  assert.ok(r instanceof Response);
  assert.equal(r.headers.get('x-middleware-rewrite'), 'https://posup-test.sites.serv-os.app/api/site?path=%2F');
  assert.equal(middleware(req('https://app.serv-os.app/', 'app.serv-os.app')), undefined);
  // x-forwarded-host wins over host (Vercel's edge sets it to the visitor's host).
  const fwd = middleware({ url: 'https://x.vercel.app/', headers: new Headers({ host: 'x.vercel.app', 'x-forwarded-host': 'www.mozzartisanpizza.com' }) });
  assert.equal(fwd.headers.get('x-middleware-rewrite'), 'https://x.vercel.app/api/site?path=%2F');
  assert.equal(middleware({ url: 'bad', headers: { get: () => { throw new Error('boom'); } } }), undefined, 'an error means do nothing');
});
