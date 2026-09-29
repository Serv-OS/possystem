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
  storefrontHostFor, applePayStateKey, applePayRetryDue, adyenErrorCode, applePayAnswerCode, isPermissionRefusal,
  applePayGuidance, applePayStateFrom, clipText,
  APPLE_PAY_RETRY_MS, APPLE_PAY_RECHECK_MS, APPLE_PAY_CLOCK_SKEW_MS, APPLE_PAY_STATE_PREFIX, APPLE_PAY_MANUAL_TRIGGERS,
  APPLE_PAY_PERMISSION_GUIDANCE, APPLE_PAY_GUIDANCE_MAX,
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

// ── ONE HOST ON LIVE (29 Sep 2026, v5.11.17) ─────────────────────────────────
// Coffee Boy: registering <slug>.serv-os.app AND <slug>.dev.serv-os.app on the
// live merchant let a refused dev host turn the live answer into ok false.
// A test venue keeps both ServOS hosts: production Back Office opens a venue
// still on Adyen test at <slug>.serv-os.app (review, 29 Sep 2026).

test('buildStorefrontDomains: live is the live host plus the custom domain, test is every address it opens on', () => {
  assert.deepEqual(buildStorefrontDomains({ slug: 'coffee-boy-leeds', environment: 'live' }), ['coffee-boy-leeds.serv-os.app']);
  assert.deepEqual(buildStorefrontDomains({ slug: 'coffee-boy-leeds', environment: 'LIVE ' }), ['coffee-boy-leeds.serv-os.app']);
  assert.deepEqual(buildStorefrontDomains({ slug: 'coffee-boy-leeds', environment: 'live', customDomain: 'order.coffeeboy.co.uk' }),
    ['coffee-boy-leeds.serv-os.app', 'order.coffeeboy.co.uk']);
  // test: the dev host first (the main one), then the production address and
  // the custom domain, all on the test merchant, which cannot touch live
  assert.deepEqual(buildStorefrontDomains({ slug: 'coffee-boy-leeds', environment: 'test' }), ['coffee-boy-leeds.dev.serv-os.app', 'coffee-boy-leeds.serv-os.app']);
  assert.deepEqual(buildStorefrontDomains({ slug: 'coffee-boy-leeds', environment: 'test', customDomain: 'order.coffeeboy.co.uk' }),
    ['coffee-boy-leeds.dev.serv-os.app', 'coffee-boy-leeds.serv-os.app', 'order.coffeeboy.co.uk']);
  // live never carries the dev host, whatever else is set
  for (const customDomain of [null, 'order.coffeeboy.co.uk']) {
    assert.ok(!buildStorefrontDomains({ slug: 'coffee-boy-leeds', environment: 'live', customDomain }).some((h) => h.endsWith('.dev.serv-os.app')));
  }
  // no environment (or a word that is not one) keeps the legacy pair
  assert.deepEqual(buildStorefrontDomains({ slug: 'coffee-boy-leeds' }), ['coffee-boy-leeds.serv-os.app', 'coffee-boy-leeds.dev.serv-os.app']);
  assert.deepEqual(buildStorefrontDomains({ slug: 'coffee-boy-leeds', environment: 'staging' }), ['coffee-boy-leeds.serv-os.app', 'coffee-boy-leeds.dev.serv-os.app']);
  // a bad slug gives no ServOS host on any environment
  assert.deepEqual(buildStorefrontDomains({ slug: 'ab', environment: 'live' }), []);
  assert.deepEqual(buildStorefrontDomains({ slug: null, environment: 'test' }), []);
});

test('storefrontHostFor is the main host of the environment, empty for a bad slug', () => {
  assert.equal(storefrontHostFor({ slug: 'coffee-boy-huddersfield', environment: 'live' }), 'coffee-boy-huddersfield.serv-os.app');
  assert.equal(storefrontHostFor({ slug: ' Coffee-Boy-Huddersfield ', environment: 'test' }), 'coffee-boy-huddersfield.dev.serv-os.app');
  assert.equal(storefrontHostFor({ slug: 'coffee-boy-huddersfield' }), 'coffee-boy-huddersfield.serv-os.app');
  assert.equal(storefrontHostFor({ slug: '-bad-', environment: 'live' }), '');
  assert.equal(storefrontHostFor({}), '');
  assert.equal(storefrontHostFor(), '');
});

test('applePayDomainsPlan with an environment wants that environment\'s hosts only', () => {
  const held = { domains: ['location1.serv-os.app', 'coffee-boy-leeds.dev.serv-os.app'] };
  assert.deepEqual(applePayDomainsPlan(held, { slug: 'coffee-boy-leeds', environment: 'live' }),
    { wanted: ['coffee-boy-leeds.serv-os.app'], missing: ['coffee-boy-leeds.serv-os.app'], existing: [] });
  assert.deepEqual(applePayDomainsPlan(held, { slug: 'coffee-boy-leeds', environment: 'test' }),
    { wanted: ['coffee-boy-leeds.dev.serv-os.app', 'coffee-boy-leeds.serv-os.app'], missing: ['coffee-boy-leeds.serv-os.app'], existing: ['coffee-boy-leeds.dev.serv-os.app'] });
  assert.deepEqual(applePayDomainsPlan(held, { slug: 'location1', environment: 'live' }),
    { wanted: ['location1.serv-os.app'], missing: [], existing: ['location1.serv-os.app'] });
});

// ── THE KEPT ROW AND THE THROTTLE ────────────────────────────────────────────

test('applePayStateKey is applepay_state:<env>:<platform id>, empty when a part is missing', () => {
  assert.equal(APPLE_PAY_STATE_PREFIX, 'applepay_state');
  assert.equal(applePayStateKey('live', '15559aa9-018d-43aa-890d-6da704a08c64'), 'applepay_state:live:15559aa9-018d-43aa-890d-6da704a08c64');
  assert.equal(applePayStateKey(' TEST ', 'abc'), 'applepay_state:test:abc');
  assert.equal(applePayStateKey('staging', 'abc'), '');
  assert.equal(applePayStateKey('live', ''), '');
  assert.equal(applePayStateKey(null, null), '');
});

const HOUR = 60 * 60 * 1000;
const T0 = Date.parse('2026-09-29T12:00:00.000Z');
const HOST = 'coffee-boy-huddersfield.serv-os.app';
const MERCHANT = 'FranPOS_QSR_UK';
const row = (over = {}) => ({ checkedAt: new Date(T0).toISOString(), host: HOST, merchant: MERCHANT, registered: false, ...over });
const due = (state, at, over = {}) => applePayRetryDue(state, { now: at, host: HOST, merchant: MERCHANT, trigger: 'checkout', ...over });

test('applePayRetryDue: 6 hours after a refusal, 24 once registered', () => {
  assert.equal(APPLE_PAY_RETRY_MS, 6 * HOUR);
  assert.equal(APPLE_PAY_RECHECK_MS, 24 * HOUR);
  // nothing kept yet, or a row that is not an object: ask
  assert.equal(due(null, T0), true);
  assert.equal(due(undefined, T0), true);
  assert.equal(due('garbage', T0), true);
  assert.equal(due([], T0), true);
  // refused: not before 6 hours, then yes
  assert.equal(due(row(), T0 + 1000), false);
  assert.equal(due(row(), T0 + 6 * HOUR - 1), false);
  assert.equal(due(row(), T0 + 6 * HOUR), true);
  // registered: not before 24 hours, then yes
  assert.equal(due(row({ registered: true }), T0 + 6 * HOUR), false);
  assert.equal(due(row({ registered: true }), T0 + 24 * HOUR - 1), false);
  assert.equal(due(row({ registered: true }), T0 + 24 * HOUR), true);
});

test('applePayRetryDue: a changed host or merchant asks at once; a manual trigger always asks', () => {
  assert.equal(due(row(), T0 + 1000, { host: 'coffee-boy-leeds.serv-os.app' }), true);
  assert.equal(due(row(), T0 + 1000, { host: 'HTTPS://Coffee-Boy-Huddersfield.serv-os.app/' }), false);   // the same host, typed differently
  assert.equal(due(row(), T0 + 1000, { merchant: 'FranPOS_UK' }), true);
  assert.equal(due(row({ registered: true }), T0 + 1000, { host: '' }), true);   // the slug was cleared
  assert.deepEqual([...APPLE_PAY_MANUAL_TRIGGERS], ['admin', 'go_live', 'adyen_link']);
  for (const trigger of APPLE_PAY_MANUAL_TRIGGERS) {
    assert.equal(due(row({ registered: true }), T0 + 1000, { trigger }), true, trigger);
    assert.equal(due(row(), T0 + 1000, { trigger }), true, trigger);
  }
  for (const trigger of ['checkout', 'golive_state', '', undefined]) assert.equal(due(row(), T0 + 1000, { trigger }), false, String(trigger));
});

test('applePayRetryDue: a different Apple Pay payment method asks at once, when both are known', () => {
  const PM = 'PM3224R223224K5KFSH7X5G8B';
  assert.equal(due(row({ paymentMethodId: PM }), T0 + 1000, { paymentMethodId: PM }), false);
  assert.equal(due(row({ paymentMethodId: PM, registered: true }), T0 + 1000, { paymentMethodId: 'PM_OTHER_STORE_ENTRY' }), true);
  assert.equal(due(row({ paymentMethodId: PM }), T0 + 1000, { paymentMethodId: ` ${PM} ` }), false);
  // unknown on either side: the other rules decide
  assert.equal(due(row({ paymentMethodId: PM }), T0 + 1000, { paymentMethodId: '' }), false);
  assert.equal(due(row({ paymentMethodId: PM }), T0 + 1000), false);
  assert.equal(due(row({ paymentMethodId: null }), T0 + 1000, { paymentMethodId: PM }), false);
});

test('applePayRetryDue: a bad or future checkedAt asks; a few seconds of clock skew does not', () => {
  assert.equal(due(row({ checkedAt: 'yesterday' }), T0), true);
  assert.equal(due(row({ checkedAt: null }), T0), true);
  assert.equal(due(row({ checkedAt: new Date(T0 + HOUR).toISOString() }), T0), true);
  assert.equal(due(row({ checkedAt: new Date(T0 + APPLE_PAY_CLOCK_SKEW_MS + 1).toISOString() }), T0), true);
  assert.equal(due(row({ checkedAt: new Date(T0 + 5000).toISOString() }), T0), false);
});

test('adyenErrorCode reads errorCode from a refusal body', () => {
  assert.equal(adyenErrorCode({ status: 403, errorCode: '00_403', title: 'Forbidden' }), '00_403');
  assert.equal(adyenErrorCode({ errorCode: 901 }), '901');
  assert.equal(adyenErrorCode({ title: 'Forbidden' }), null);
  assert.equal(adyenErrorCode({ errorCode: '  ' }), null);
  assert.equal(adyenErrorCode(null), null);
  assert.equal(adyenErrorCode('403'), null);
});

// The answers registerApplePayDomains gives, as the function builds them.
const LIST_403 = { ok: false, environment: 'live', merchant: MERCHANT, host: HOST, status: 403, code: 'scope_missing', errorCode: '00_403', message: 'Forbidden', error: 'The UK live API key cannot read the payment methods on FranPOS_QSR_UK (403). It needs the Management API role "Payment methods read and write".', added: [], existing: [], failed: [] };
const POST_403 = { ok: false, environment: 'live', merchant: MERCHANT, host: HOST, paymentMethodId: 'PM3224R223224K5KFSH7X5G8B', verificationStatus: 'valid', added: [], existing: [], failed: [{ domain: HOST, status: 403, errorCode: '00_403', message: 'Forbidden' }] };
const POST_422 = { ok: false, environment: 'live', merchant: MERCHANT, host: HOST, verificationStatus: 'valid', added: [], existing: [], failed: [{ domain: HOST, status: 422, errorCode: '702', message: 'Domain could not be verified' }] };
const NOT_REQUESTED = { ok: false, environment: 'live', merchant: MERCHANT, host: HOST, code: 'apple_pay_not_requested', error: 'Apple Pay is not requested on FranPOS_QSR_UK yet.' };
const STORE_SCOPED = { ok: false, environment: 'live', merchant: MERCHANT, host: HOST, code: 'apple_pay_store_scoped', error: 'Apple Pay on FranPOS_QSR_UK is set up per store.' };
const NO_STOREFRONT = { ok: false, environment: 'live', merchant: MERCHANT, host: null, code: 'no_storefront', error: 'This venue has no online slug yet.' };
const TIMEOUT = { ok: false, error: 'Apple Pay domains: Adyen did not answer GET /merchants/FranPOS_QSR_UK/paymentMethodSettings within 15s' };
const ADDED = { ok: true, environment: 'live', merchant: MERCHANT, host: HOST, paymentMethodId: 'PM1', verificationStatus: 'valid', added: [HOST], existing: [], failed: [] };
const THERE = { ok: true, environment: 'live', merchant: MERCHANT, host: HOST, paymentMethodId: 'PM1', verificationStatus: 'valid', added: [], existing: [HOST], failed: [] };
const PENDING = { ...THERE, verificationStatus: 'pending' };

test('isPermissionRefusal: a 401 or 403 on the list read or on any host, or scope_missing', () => {
  assert.equal(isPermissionRefusal(LIST_403), true);
  assert.equal(isPermissionRefusal(POST_403), true);
  assert.equal(isPermissionRefusal({ code: 'scope_missing' }), true);
  assert.equal(isPermissionRefusal({ status: 401 }), true);
  assert.equal(isPermissionRefusal(POST_422), false);
  assert.equal(isPermissionRefusal(TIMEOUT), false);
  assert.equal(isPermissionRefusal(null), false);
});

test('applePayAnswerCode names a timed out call', () => {
  assert.equal(applePayAnswerCode(TIMEOUT), 'timeout');
  assert.equal(applePayAnswerCode(NOT_REQUESTED), 'apple_pay_not_requested');
  assert.equal(applePayAnswerCode(POST_422), '');
  assert.equal(applePayAnswerCode(undefined), '');
});

test('applePayGuidance: the one sentence for each answer', () => {
  assert.equal(APPLE_PAY_PERMISSION_GUIDANCE, 'Ask FranPOS to tick Management API: Payment methods read and write on the ServOS API credential.');
  assert.equal(applePayGuidance(LIST_403), APPLE_PAY_PERMISSION_GUIDANCE);
  // a POST refused with 403 only shows in failed[], and still names the role
  assert.equal(applePayGuidance(POST_403), APPLE_PAY_PERMISSION_GUIDANCE);
  assert.equal(applePayGuidance(NOT_REQUESTED), "Apple Pay is not switched on for this Adyen account. Ask FranPOS to request it with Adyen's certificate.");
  assert.equal(applePayGuidance(STORE_SCOPED), "Apple Pay is set up store by store and this venue's store has none. Ask FranPOS to add it.");
  assert.equal(applePayGuidance(NO_STOREFRONT), 'This venue has no online address yet. Set it in Channels first.');
  assert.equal(applePayGuidance(TIMEOUT), 'Adyen did not answer. ServOS tries again by itself.');
  assert.equal(applePayGuidance(POST_422), `Adyen would not add ${HOST}: Domain could not be verified.`);
  assert.equal(applePayGuidance({ ok: false, code: 'read_failed', status: 500, message: 'Internal error' }), 'Adyen could not be asked about Apple Pay: Internal error. ServOS tries again by itself.');
  // registered: nothing to do, unless Adyen has not approved Apple Pay yet
  assert.equal(applePayGuidance(ADDED), null);
  assert.equal(applePayGuidance(THERE), null);
  assert.match(applePayGuidance(PENDING), /not approved it yet/);
  // a read only probe that proved the host missing has no advice beyond that
  assert.equal(applePayGuidance({ read: true, registered: false, missing: [HOST] }), null);
  assert.equal(applePayGuidance({ read: false, registered: false, status: 403, code: 'scope_missing' }), APPLE_PAY_PERMISSION_GUIDANCE);
  assert.equal(applePayGuidance(null), null);
});

test('applePayGuidance fits a step hint even when Adyen says a lot, and never uses a dash', () => {
  const long = { ...POST_422, failed: [{ domain: HOST, status: 422, message: 'x'.repeat(400) }] };
  const g = applePayGuidance(long);
  assert.ok(g.length <= APPLE_PAY_GUIDANCE_MAX, `${g.length}`);
  assert.match(g, /^Adyen would not add coffee-boy-huddersfield\.serv-os\.app: x+\.\.\.$/);
  const read = applePayGuidance({ ok: false, code: 'read_failed', message: 'y'.repeat(400) });
  assert.ok(read.length <= APPLE_PAY_GUIDANCE_MAX, `${read.length}`);
  for (const a of [LIST_403, POST_403, POST_422, NOT_REQUESTED, STORE_SCOPED, NO_STOREFRONT, TIMEOUT, long]) {
    const t = applePayGuidance(a);
    assert.ok(t.length <= APPLE_PAY_GUIDANCE_MAX, t);
    assert.doesNotMatch(t, /[–—]/, t);
  }
});

test('clipText cuts with an ellipsis and folds whitespace', () => {
  assert.equal(clipText('  a\n b  ', 10), 'a b');
  assert.equal(clipText('abcdefghij', 5), 'ab...');
  assert.equal(clipText(null, 5), '');
});

const opts = (over = {}) => ({ trigger: 'checkout', host: HOST, now: T0, previous: null, ...over });

test('applePayStateFrom: every outcome', () => {
  assert.equal(applePayStateFrom(THERE, opts()).outcome, 'registered');
  assert.equal(applePayStateFrom(ADDED, opts()).outcome, 'added');
  assert.equal(applePayStateFrom(LIST_403, opts()).outcome, 'refused');
  assert.equal(applePayStateFrom(POST_403, opts()).outcome, 'refused');
  assert.equal(applePayStateFrom(POST_422, opts()).outcome, 'refused');
  assert.equal(applePayStateFrom(NOT_REQUESTED, opts()).outcome, 'not_requested');
  assert.equal(applePayStateFrom(STORE_SCOPED, opts()).outcome, 'store_scoped');
  assert.equal(applePayStateFrom(NO_STOREFRONT, opts({ host: '' })).outcome, 'no_storefront');
  assert.equal(applePayStateFrom(TIMEOUT, opts()).outcome, 'error');
  assert.equal(applePayStateFrom({ ok: false, code: 'read_failed', status: 500, message: 'boom' }, opts()).outcome, 'error');
  // ok with no host is never registered
  assert.equal(applePayStateFrom({ ok: true }, opts({ host: '' })).registered, false);
});

test('applePayStateFrom keeps Adyen\'s code and message, the guidance, when and from where', () => {
  const s = applePayStateFrom(LIST_403, opts());
  assert.deepEqual(s, {
    v: 1, environment: 'live', host: HOST, merchant: MERCHANT, paymentMethodId: null, verification: null,
    registered: false, outcome: 'refused', code: 'scope_missing', status: 403, errorCode: '00_403', error: 'Forbidden',
    failed: [], added: [], guidance: APPLE_PAY_PERMISSION_GUIDANCE,
    checkedAt: '2026-09-29T12:00:00.000Z', trigger: 'checkout', failures: 1,
  });
  const p = applePayStateFrom(POST_422, opts({ trigger: 'admin' }));
  assert.equal(p.status, 422);
  assert.equal(p.errorCode, '702');
  assert.equal(p.error, 'Domain could not be verified');
  assert.deepEqual(p.failed, [{ domain: HOST, status: 422, errorCode: '702', message: 'Domain could not be verified' }]);
  assert.equal(p.paymentMethodId, null);
  assert.equal(p.trigger, 'admin');
  const t = applePayStateFrom(TIMEOUT, opts());
  assert.equal(t.code, 'timeout');
  assert.match(t.error, /did not answer/);
  assert.equal(t.guidance, 'Adyen did not answer. ServOS tries again by itself.');
  const a = applePayStateFrom(ADDED, opts());
  assert.equal(a.registered, true);
  assert.deepEqual(a.added, [HOST]);
  assert.equal(a.error, null);
  assert.equal(a.guidance, null);
  assert.equal(a.paymentMethodId, 'PM1');
  assert.equal(a.verification, 'valid');
});

test('applePayStateFrom counts failures in a row and resets on success', () => {
  const one = applePayStateFrom(LIST_403, opts());
  assert.equal(one.failures, 1);
  const two = applePayStateFrom(LIST_403, opts({ previous: one }));
  assert.equal(two.failures, 2);
  const three = applePayStateFrom(TIMEOUT, opts({ previous: two }));
  assert.equal(three.failures, 3);
  const ok = applePayStateFrom(THERE, opts({ previous: three }));
  assert.equal(ok.failures, 0);
  assert.equal(applePayStateFrom(POST_403, opts({ previous: ok })).failures, 1);
  assert.equal(applePayStateFrom(POST_403, opts({ previous: { failures: 'x' } })).failures, 1);
  // a bad clock never throws
  assert.match(applePayStateFrom(THERE, opts({ now: NaN })).checkedAt, /^\d{4}-\d\d-\d\dT/);
});

test('applePayStateFrom then applePayRetryDue: a refusal waits 6 hours, a registration 24', () => {
  const refused = applePayStateFrom(POST_403, opts());
  assert.equal(applePayRetryDue(refused, { now: T0 + HOUR, host: HOST, merchant: MERCHANT, trigger: 'checkout' }), false);
  assert.equal(applePayRetryDue(refused, { now: T0 + 6 * HOUR, host: HOST, merchant: MERCHANT, trigger: 'checkout' }), true);
  const registered = applePayStateFrom(THERE, opts());
  assert.equal(applePayRetryDue(registered, { now: T0 + 23 * HOUR, host: HOST, merchant: MERCHANT, trigger: 'golive_state' }), false);
  assert.equal(applePayRetryDue(registered, { now: T0 + 23 * HOUR, host: HOST, merchant: MERCHANT, trigger: 'admin' }), true);
});

test('registrationLines adds the guidance as a warning, once', () => {
  const lines = registrationLines({ ...POST_403, guidance: APPLE_PAY_PERMISSION_GUIDANCE });
  assert.deepEqual(lines, [
    { tone: 'err', text: `Failed: ${HOST} (403 Forbidden)` },
    { tone: 'warn', text: APPLE_PAY_PERMISSION_GUIDANCE },
  ]);
  // the guidance already said by the error or the note is not repeated
  const same = "Apple Pay is not switched on for this Adyen account. Ask FranPOS to request it with Adyen's certificate.";
  assert.deepEqual(registrationLines({ ok: false, error: same, guidance: same }), [{ tone: 'err', text: same }]);
  assert.deepEqual(registrationLines({ ok: true, added: [HOST], note: `Apple Pay is requested on M but Adyen has not approved it yet. ${same}`, guidance: same }),
    [{ tone: 'ok', text: `Added: ${HOST}` }, { tone: 'info', text: `Apple Pay is requested on M but Adyen has not approved it yet. ${same}` }]);
});

// ── THE TWO COPIES AGREE (29 Sep 2026) ───────────────────────────────────────
// adyen-terminal-admin runs _shared/adyenOrigins.ts; Node strips its types
// natively from 23.6, an older Node skips this one test instead of failing.
const TS_MIRROR = '../../../supabase/functions/_shared/adyenOrigins.ts';
test('TS mirror: the storefront, throttle, guidance and state helpers answer exactly as the JS copy', async (t) => {
  let ts;
  try { ts = await import(TS_MIRROR); }
  catch (e) { t.skip(`this node cannot import the .ts mirror here (${e?.code || e?.message})`); return; }
  for (const k of ['SERVOS_APEX', 'SERVOS_DEV_ROOT', 'APPLE_PAY_RETRY_MS', 'APPLE_PAY_RECHECK_MS', 'APPLE_PAY_CLOCK_SKEW_MS', 'APPLE_PAY_STATE_PREFIX', 'APPLE_PAY_PERMISSION_GUIDANCE', 'APPLE_PAY_GUIDANCE_MAX']) {
    assert.deepEqual(ts[k], { SERVOS_APEX, SERVOS_DEV_ROOT, APPLE_PAY_RETRY_MS, APPLE_PAY_RECHECK_MS, APPLE_PAY_CLOCK_SKEW_MS, APPLE_PAY_STATE_PREFIX, APPLE_PAY_PERMISSION_GUIDANCE, APPLE_PAY_GUIDANCE_MAX }[k], k);
  }
  assert.deepEqual([...ts.APPLE_PAY_MANUAL_TRIGGERS], [...APPLE_PAY_MANUAL_TRIGGERS]);
  assert.deepEqual([...ts.STATIC_WEB_ORIGINS], [...STATIC_WEB_ORIGINS]);
  const storefronts = [
    { slug: 'coffee-boy-leeds', environment: 'live' }, { slug: 'coffee-boy-leeds', environment: 'test' }, { slug: 'coffee-boy-leeds' },
    { slug: 'coffee-boy-leeds', environment: 'live', customDomain: 'https://Order.CoffeeBoy.co.uk/' },
    { slug: 'coffee-boy-leeds', environment: 'test', customDomain: 'order.coffeeboy.co.uk' },
    { slug: 'ab', environment: 'live' }, { slug: null, customDomain: 'order.coffeeboy.co.uk' }, {},
  ];
  const held = { domains: ['coffee-boy-leeds.serv-os.app', 'x.dev.serv-os.app'] };
  for (const sf of storefronts) {
    assert.deepEqual(ts.buildStorefrontDomains(sf), buildStorefrontDomains(sf), JSON.stringify(sf));
    assert.equal(ts.storefrontHostFor(sf), storefrontHostFor(sf), JSON.stringify(sf));
    assert.deepEqual(ts.applePayDomainsPlan(held, sf), applePayDomainsPlan(held, sf), JSON.stringify(sf));
  }
  for (const [env, id] of [['live', 'L1'], ['TEST', 'L2'], ['x', 'L3'], ['live', ''], [null, null]]) assert.equal(ts.applePayStateKey(env, id), applePayStateKey(env, id));
  const answers = [LIST_403, POST_403, POST_422, NOT_REQUESTED, STORE_SCOPED, NO_STOREFRONT, TIMEOUT, ADDED, THERE, PENDING, null, {}, { ok: false, code: 'read_failed', message: 'z'.repeat(300) }, { read: true, registered: false, missing: [HOST] }];
  for (const a of answers) {
    const label = JSON.stringify(a)?.slice(0, 80);
    assert.equal(ts.applePayGuidance(a), applePayGuidance(a), label);
    assert.equal(ts.isPermissionRefusal(a), isPermissionRefusal(a), label);
    assert.equal(ts.applePayAnswerCode(a), applePayAnswerCode(a), label);
    for (const previous of [null, { failures: 2 }]) {
      for (const host of [HOST, '']) {
        const o = { trigger: 'checkout', host, now: T0, previous };
        assert.deepEqual(ts.applePayStateFrom(a, o), applePayStateFrom(a, o), label);
      }
    }
  }
  for (const d of [{ errorCode: '00_403' }, { errorCode: 7 }, {}, null]) assert.equal(ts.adyenErrorCode(d), adyenErrorCode(d));
  const states = [null, row(), row({ registered: true }), row({ checkedAt: 'bad' }), row({ checkedAt: new Date(T0 + HOUR).toISOString() }), row({ paymentMethodId: 'PM1' })];
  for (const st of states) {
    for (const at of [T0 + 1000, T0 + 6 * HOUR, T0 + 24 * HOUR]) {
      for (const trigger of ['checkout', 'golive_state', 'admin', 'go_live', 'adyen_link']) {
        for (const host of [HOST, 'other.serv-os.app']) {
          for (const paymentMethodId of [undefined, 'PM1', 'PM2']) {
            const o = { now: at, host, merchant: MERCHANT, trigger, paymentMethodId };
            assert.equal(ts.applePayRetryDue(st, o), applePayRetryDue(st, o), JSON.stringify({ st, o }));
          }
        }
      }
    }
  }
  assert.equal(ts.clipText('abcdefghij', 5), clipText('abcdefghij', 5));
});

// ── THE GO LIVE SCREEN'S OWN APPLE PAY WRITES (29 Sep 2026 review) ───────────
// Source pins on adyen-terminal-admin golive_state: it registers by itself
// only what the checkout registers, a probe that threw is "could not check",
// and a registered read brings a kept refusal up to date.
test('golive_state: automatic registration only on the checkout\'s own store and method', async () => {
  const { readFileSync } = await import('node:fs');
  const ADMIN = readFileSync(new URL('../../../supabase/functions/adyen-terminal-admin/index.ts', import.meta.url), 'utf8');
  const block = ADMIN.slice(ADMIN.indexOf("if (action === 'golive_state')"), ADMIN.indexOf('── step 5, Card rates and payouts'));
  assert.ok(block.length > 0);
  assert.match(block, /const probeIsCheckouts = targetEnv === env && !merchantOverride && !pickedStoreId && storeIdNow === rowStoreId;/);
  assert.match(block, /if \(env === 'live' && probeIsCheckouts && a\.read === true && !!a\.paymentMethodId && probeMissing > 0\)/);
  // the row's store, never the screen's pick, and the method just read
  assert.match(block, /ensureApplePayDomains\(targetCfg, merchantConfigured, rowStoreId, 'golive_state', storefront, String\(a\.paymentMethodId\)\)/);
  assert.doesNotMatch(block, /ensureApplePayDomains\([^)]*storeIdNow/);
  // a probe that threw is registered false and read false, with a code
  const probeCatch = block.slice(block.indexOf('const failedRead = {'), block.indexOf('return { ...failedRead'));
  assert.match(probeCatch, /registered: false, read: false/);
  assert.match(probeCatch, /code: \/did not answer\/i\.test\(msg\) \? 'timeout' : 'read_failed'/);
  // a registered read refreshes a kept "no", on the checkout's own method only
  assert.match(block, /if \(probeIsCheckouts && a\.read === true && a\.registered === true && kept\.ok && kept\.state && kept\.state\.registered !== true\)/);
  // ensure passes the method on to the throttle
  assert.match(ADMIN, /applePayRetryDue\(prev\.state, \{ now: Date\.now\(\), host, merchant: regMerchant, trigger, paymentMethodId \}\)/);
});
