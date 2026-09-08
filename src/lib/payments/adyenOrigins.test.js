/**
 * adyenOrigins.test.js: the contract for BOTH copies of the origin and
 * storefront domain planner, src/lib/payments/adyenOrigins.js (this one) and
 * supabase/functions/_shared/adyenOrigins.ts (the Deno copy, which cannot
 * import from src/). When a test here changes, the Deno copy changes with it.
 *
 * Run: `npm test` (Node's built-in runner, no third party framework).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  STATIC_WEB_ORIGINS, SERVOS_APEX, SERVOS_DEV_ROOT,
  normaliseHost, originKey, domainKey, customDomainOrigin, dedupeBy,
  buildWebOrigins, buildStorefrontDomains, splitAgainstExisting,
  allowedOriginDomains, originsPlan, applePayDomainList, applePayDomainsPlan,
  pickApplePayMethod, hasApplePayEntries, applePayStatusNote, adyenRefusalMessage, isDuplicateRefusal,
  registrationLines,
} from './adyenOrigins.js';

const FIVE = [
  'https://app.serv-os.app',
  'https://serv-os.app',
  'https://dev.serv-os.app',
  'https://*.serv-os.app',
  'https://*.dev.serv-os.app',
];

// ── the static list ──────────────────────────────────────────────────────────

test('STATIC_WEB_ORIGINS is exactly the five ServOS origins, wildcards included, frozen', () => {
  assert.deepEqual([...STATIC_WEB_ORIGINS], FIVE);
  assert.ok(Object.isFrozen(STATIC_WEB_ORIGINS));
  assert.equal(SERVOS_APEX, 'serv-os.app');
  assert.equal(SERVOS_DEV_ROOT, 'dev.serv-os.app');
});

// ── host and key normalisation ───────────────────────────────────────────────

test('normaliseHost strips scheme, path, port, trailing dot and case; refuses garbage', () => {
  assert.equal(normaliseHost(' HTTPS://Shop.Example.com/order?x=1 '), 'shop.example.com');
  assert.equal(normaliseHost('shop.example.com:8443'), 'shop.example.com');
  assert.equal(normaliseHost('shop.example.com.'), 'shop.example.com');
  assert.equal(normaliseHost('*.example.com'), '*.example.com');
  assert.equal(normaliseHost('localhost'), '');           // one label is not a public host
  assert.equal(normaliseHost('not a host'), '');
  assert.equal(normaliseHost('-bad.example.com'), '');
  assert.equal(normaliseHost(''), '');
  assert.equal(normaliseHost(null), '');
  assert.equal(normaliseHost(undefined), '');
});

test('originKey compares scheme plus host, ignoring case, path and trailing slash; bare host is https', () => {
  assert.equal(originKey('https://App.Serv-OS.app/'), 'https://app.serv-os.app');
  assert.equal(originKey('https://app.serv-os.app/anything?x'), 'https://app.serv-os.app');
  assert.equal(originKey('app.serv-os.app'), 'https://app.serv-os.app');
  assert.equal(originKey('http://localhost:5173'), 'http://localhost:5173');   // a port stays: it is part of the origin
  assert.equal(originKey('https://*.serv-os.app'), 'https://*.serv-os.app');
  assert.equal(originKey(''), '');
  assert.equal(originKey(null), '');
});

test('domainKey is the bare host, whatever was typed', () => {
  assert.equal(domainKey('https://Peters-Cafe.serv-os.app/'), 'peters-cafe.serv-os.app');
  assert.equal(domainKey('peters-cafe.serv-os.app:443'), 'peters-cafe.serv-os.app');
  assert.equal(domainKey('  '), '');
});

test('customDomainOrigin is https on the normalised host, empty when there is none', () => {
  assert.equal(customDomainOrigin('Order.PetersCafe.co.uk/'), 'https://order.peterscafe.co.uk');
  assert.equal(customDomainOrigin(null), '');
  assert.equal(customDomainOrigin('nope'), '');
});

test('dedupeBy keeps the first of each key in order and drops keyless entries', () => {
  assert.deepEqual(dedupeBy(['A', 'a', 'b', '', 'B'], (s) => s.toLowerCase()), ['A', 'b']);
  assert.deepEqual(dedupeBy(null, (s) => s), []);
});

// ── the origin list ──────────────────────────────────────────────────────────

test('buildWebOrigins with no custom domain is the five, in order, no duplicates', () => {
  assert.deepEqual(buildWebOrigins(), FIVE);
  assert.deepEqual(buildWebOrigins({}), FIVE);
  assert.deepEqual(buildWebOrigins({ customDomain: null }), FIVE);
  assert.deepEqual(buildWebOrigins({ customDomain: '' }), FIVE);
});

test('buildWebOrigins appends the custom domain as an https origin, once', () => {
  assert.deepEqual(buildWebOrigins({ customDomain: 'Order.PetersCafe.co.uk' }), [...FIVE, 'https://order.peterscafe.co.uk']);
  assert.deepEqual(buildWebOrigins({ customDomain: 'https://order.peterscafe.co.uk/menu' }), [...FIVE, 'https://order.peterscafe.co.uk']);
  // A custom domain that IS one of the static hosts adds nothing.
  assert.deepEqual(buildWebOrigins({ customDomain: 'app.serv-os.app' }), FIVE);
  // Garbage adds nothing.
  assert.deepEqual(buildWebOrigins({ customDomain: 'not a host' }), FIVE);
});

// ── the storefront domain list ───────────────────────────────────────────────

test('buildStorefrontDomains is <slug>.serv-os.app then <slug>.dev.serv-os.app', () => {
  assert.deepEqual(buildStorefrontDomains({ slug: 'peters-cafe' }), ['peters-cafe.serv-os.app', 'peters-cafe.dev.serv-os.app']);
  assert.deepEqual(buildStorefrontDomains({ slug: ' Peters-Cafe ' }), ['peters-cafe.serv-os.app', 'peters-cafe.dev.serv-os.app']);
});

test('buildStorefrontDomains adds the custom domain and refuses a missing or invalid slug', () => {
  assert.deepEqual(buildStorefrontDomains({ slug: 'peters-cafe', customDomain: 'https://Order.PetersCafe.co.uk/' }),
    ['peters-cafe.serv-os.app', 'peters-cafe.dev.serv-os.app', 'order.peterscafe.co.uk']);
  assert.deepEqual(buildStorefrontDomains({ slug: null, customDomain: 'order.peterscafe.co.uk' }), ['order.peterscafe.co.uk']);
  assert.deepEqual(buildStorefrontDomains({ slug: '' }), []);
  assert.deepEqual(buildStorefrontDomains({ slug: 'ab' }), []);            // too short (customerUrl.js rule)
  assert.deepEqual(buildStorefrontDomains({ slug: '-bad-' }), []);
  assert.deepEqual(buildStorefrontDomains({ slug: 'peters cafe' }), []);
  assert.deepEqual(buildStorefrontDomains(), []);
  // The custom domain that equals a generated host is not repeated.
  assert.deepEqual(buildStorefrontDomains({ slug: 'peters-cafe', customDomain: 'PETERS-CAFE.serv-os.app' }),
    ['peters-cafe.serv-os.app', 'peters-cafe.dev.serv-os.app']);
});

test('buildStorefrontDomains honours a different apex and dev root', () => {
  assert.deepEqual(buildStorefrontDomains({ slug: 'x-y-z', apex: 'stage.serv-os.app', devRoot: 'dev.serv-os.app' }),
    ['x-y-z.stage.serv-os.app', 'x-y-z.dev.serv-os.app']);
});

// ── dedupe against what Adyen already lists ──────────────────────────────────

test('splitAgainstExisting keeps order, compares by key and collapses duplicates in wanted', () => {
  const r = splitAgainstExisting(
    ['https://app.serv-os.app', 'https://serv-os.app', 'https://app.serv-os.app', 'https://*.serv-os.app'],
    ['HTTPS://App.Serv-OS.app/', 'https://something-else.com'],
  );
  assert.deepEqual(r, { missing: ['https://serv-os.app', 'https://*.serv-os.app'], existing: ['https://app.serv-os.app'] });
});

test('splitAgainstExisting with nothing existing wants everything, and with everything existing wants nothing', () => {
  assert.deepEqual(splitAgainstExisting(FIVE, []), { missing: FIVE, existing: [] });
  assert.deepEqual(splitAgainstExisting(FIVE, null), { missing: FIVE, existing: [] });
  assert.deepEqual(splitAgainstExisting(FIVE, FIVE.map((o) => `${o}/`)), { missing: [], existing: FIVE });
});

test('allowedOriginDomains reads the GET /me/allowedOrigins shape and tolerates bare lists', () => {
  const resp = { data: [
    { id: 'AO1', domain: 'https://app.serv-os.app', _links: { self: { href: 'x' } } },
    { id: 'AO2', domain: 'http://localhost:5173' },
    { id: 'AO3' },
    null,
  ] };
  assert.deepEqual(allowedOriginDomains(resp), ['https://app.serv-os.app', 'http://localhost:5173']);
  assert.deepEqual(allowedOriginDomains(['https://a.com', { domain: 'https://b.com' }]), ['https://a.com', 'https://b.com']);
  assert.deepEqual(allowedOriginDomains(null), []);
  assert.deepEqual(allowedOriginDomains({}), []);
});

test('originsPlan: a credential with two of the five and localhost needs the other three', () => {
  const plan = originsPlan({ data: [
    { id: '1', domain: 'https://app.serv-os.app' },
    { id: '2', domain: 'https://serv-os.app/' },
    { id: '3', domain: 'http://localhost:5173' },
  ] });
  assert.deepEqual(plan.wanted, FIVE);
  assert.deepEqual(plan.existing, ['https://app.serv-os.app', 'https://serv-os.app']);
  assert.deepEqual(plan.missing, ['https://dev.serv-os.app', 'https://*.serv-os.app', 'https://*.dev.serv-os.app']);
});

test('originsPlan with the custom domain already present reports it as existing', () => {
  const plan = originsPlan({ data: FIVE.map((d, i) => ({ id: String(i), domain: d })).concat([{ id: 'c', domain: 'https://order.peterscafe.co.uk' }]) },
    { customDomain: 'order.peterscafe.co.uk' });
  assert.deepEqual(plan.missing, []);
  assert.equal(plan.existing.length, 6);
});

test('applePayDomainList reads { domains } and tolerates a bare array', () => {
  assert.deepEqual(applePayDomainList({ domains: ['a.serv-os.app', '', 7, 'b.serv-os.app'] }), ['a.serv-os.app', 'b.serv-os.app']);
  assert.deepEqual(applePayDomainList(['a.serv-os.app']), ['a.serv-os.app']);
  assert.deepEqual(applePayDomainList(null), []);
});

test('applePayDomainsPlan wants the storefront hosts Adyen does not list yet', () => {
  const plan = applePayDomainsPlan({ domains: ['Peters-Cafe.serv-os.app', 'other.serv-os.app'] }, { slug: 'peters-cafe' });
  assert.deepEqual(plan.wanted, ['peters-cafe.serv-os.app', 'peters-cafe.dev.serv-os.app']);
  assert.deepEqual(plan.existing, ['peters-cafe.serv-os.app']);
  assert.deepEqual(plan.missing, ['peters-cafe.dev.serv-os.app']);
  assert.deepEqual(applePayDomainsPlan(null, { slug: '' }), { wanted: [], missing: [], existing: [] });
});

// ── the Apple Pay payment method ─────────────────────────────────────────────

test('pickApplePayMethod finds applepay case insensitively and returns null when never requested', () => {
  assert.equal(pickApplePayMethod({ data: [{ id: 'v', type: 'visa' }, { id: 'm', type: 'mc' }] }), null);
  assert.equal(pickApplePayMethod({ data: [] }), null);
  assert.equal(pickApplePayMethod(null), null);
  assert.equal(pickApplePayMethod({ data: [{ id: 'ap', type: 'ApplePay' }] }).id, 'ap');
  assert.equal(pickApplePayMethod([{ id: 'ap2', type: 'applepay' }]).id, 'ap2');
});

test("pickApplePayMethod prefers the venue store entry, then the merchant level one, never another store's", () => {
  const rows = [
    { id: 'store-b', type: 'applepay', storeIds: ['ST_B'] },
    { id: 'merchant', type: 'applepay', storeIds: [] },
    { id: 'store-a', type: 'applepay', storeIds: ['ST_A'] },
  ];
  assert.equal(pickApplePayMethod({ data: rows }, 'ST_A').id, 'store-a');
  assert.equal(pickApplePayMethod({ data: rows }, 'ST_ZZ').id, 'merchant');
  assert.equal(pickApplePayMethod({ data: rows }, null).id, 'merchant');
  // Only other stores' entries: null, never rows[0] (that wrote this venue's
  // hosts onto another venue's entry).
  const others = rows.filter((r) => r.id !== 'merchant');
  assert.equal(pickApplePayMethod({ data: others }, null), null);
  assert.equal(pickApplePayMethod({ data: others }, 'ST_ZZ'), null);
  assert.equal(pickApplePayMethod({ data: others }, 'ST_B').id, 'store-b');
});

test('hasApplePayEntries tells store scoped from never requested', () => {
  assert.equal(hasApplePayEntries({ data: [{ id: 'store-b', type: 'applepay', storeIds: ['ST_B'] }] }), true);
  assert.equal(hasApplePayEntries([{ id: 'ap', type: 'ApplePay' }]), true);
  assert.equal(hasApplePayEntries({ data: [{ id: 'v', type: 'visa' }] }), false);
  assert.equal(hasApplePayEntries({ data: [] }), false);
  assert.equal(hasApplePayEntries(null), false);
});

test('applePayStatusNote says not requested, approved, pending or refused', () => {
  assert.match(applePayStatusNote(null, 'ServOS_UK'), /not requested on ServOS_UK yet/);
  assert.match(applePayStatusNote(null, 'ServOS_UK'), /Customer Area/);
  assert.equal(applePayStatusNote(null, 'ServOS_UK', { storeScoped: true }), "Apple Pay on ServOS_UK is set up per store and this venue's store has none yet. Create the store, request Apple Pay on it, then run this again.");
  assert.match(applePayStatusNote(null, null, { storeScoped: true }), /^Apple Pay is set up per store/);
  assert.match(applePayStatusNote({ verificationStatus: 'valid' }, 'M', { storeScoped: true }), /approved on M/);
  assert.equal(applePayStatusNote({ verificationStatus: 'valid' }, 'ServOS_UK'), 'Apple Pay is approved on ServOS_UK.');
  assert.match(applePayStatusNote({ verificationStatus: 'PENDING' }, 'ServOS_UK'), /not approved it yet/);
  assert.match(applePayStatusNote({ verificationStatus: 'rejected' }, null), /marked Apple Pay rejected\./);
  assert.match(applePayStatusNote({ verificationStatus: 'invalid' }, 'M'), /marked Apple Pay invalid on M/);
  assert.match(applePayStatusNote({}, 'M'), /status unknown/);
});

// ── refusals ─────────────────────────────────────────────────────────────────

test('adyenRefusalMessage prefers detail, then title, then message, then raw, then the status', () => {
  assert.equal(adyenRefusalMessage(422, { title: 'Bad', detail: 'Invalid domain' }), 'Invalid domain');
  assert.equal(adyenRefusalMessage(422, { title: 'Bad' }), 'Bad');
  assert.equal(adyenRefusalMessage(400, { message: 'nope' }), 'nope');
  assert.equal(adyenRefusalMessage(422, { detail: 'Invalid', invalidFields: [{ name: 'domain', message: 'must be https' }] }), 'Invalid domain: must be https');
  assert.equal(adyenRefusalMessage(500, { raw: '  <html>oops</html> ' }), '<html>oops</html>');
  assert.equal(adyenRefusalMessage(503, null), 'HTTP 503');
  assert.equal(adyenRefusalMessage(403, {}), 'HTTP 403');
});

test('isDuplicateRefusal: 409 or an already/duplicate/exists message, never a does-not-exist one', () => {
  assert.equal(isDuplicateRefusal(409, {}), true);
  assert.equal(isDuplicateRefusal(422, { detail: 'Allowed origin already exists' }), true);
  assert.equal(isDuplicateRefusal(422, { detail: 'Duplicate domain' }), true);
  assert.equal(isDuplicateRefusal(400, { title: 'Domain exists' }), true);
  assert.equal(isDuplicateRefusal(422, { detail: 'Payment method does not exist' }), false);
  assert.equal(isDuplicateRefusal(404, { detail: 'Not found' }), false);
  assert.equal(isDuplicateRefusal(422, { detail: 'Invalid domain' }), false);
  assert.equal(isDuplicateRefusal(403, null), false);
});

// ── the admin's result lines ─────────────────────────────────────────────────

test('registrationLines lists added, already there and each failure with its status and message', () => {
  const lines = registrationLines({
    ok: false,
    added: ['https://dev.serv-os.app'],
    existing: ['https://app.serv-os.app', 'https://serv-os.app'],
    failed: [{ origin: 'https://*.serv-os.app', status: 422, message: 'Invalid domain' }, { domain: 'x.serv-os.app', status: 500, message: '' }],
    note: 'Registered on the UK live API credential.',
  });
  assert.deepEqual(lines, [
    { tone: 'ok', text: 'Added: https://dev.serv-os.app' },
    { tone: 'info', text: 'Already there: https://app.serv-os.app, https://serv-os.app' },
    { tone: 'err', text: 'Failed: https://*.serv-os.app (422 Invalid domain)' },
    { tone: 'err', text: 'Failed: x.serv-os.app (500)' },
    { tone: 'info', text: 'Registered on the UK live API credential.' },
  ]);
});

test('registrationLines: a whole call failure is one error line, an empty answer says so, nothing given is nothing', () => {
  assert.deepEqual(registrationLines({ ok: false, error: 'ServOS admin only' }), [{ tone: 'err', text: 'ServOS admin only' }]);
  assert.deepEqual(registrationLines({ ok: true, added: [], existing: [], failed: [] }), [{ tone: 'info', text: 'Nothing to register.' }]);
  assert.deepEqual(registrationLines(null), []);
  assert.deepEqual(registrationLines(undefined), []);
  // A note that repeats the error is not shown twice; a note on a refused
  // call with no per item failures reads as a warning.
  const same = 'Apple Pay is not requested on M yet.';
  assert.deepEqual(registrationLines({ ok: false, error: same, note: same }), [{ tone: 'err', text: same }]);
  assert.deepEqual(registrationLines({ ok: false, note: 'Skipped: live keys not set.' }), [{ tone: 'warn', text: 'Skipped: live keys not set.' }]);
});
