/**
 * phonesAddressesBatch3.test.js - 5.12.57, the US basics check, batch 3: phones, texts and
 * addresses follow the VENUE's country (its currency: USD is the US).
 *
 *   1. every phone reader that was UK only now reads a US number as +18015551234, and a UK
 *      number exactly as before (07931 129015 is +447931129015)
 *   2. the placeholders and labels typed with a UK example are gated by the venue's country
 *   3. the address search is told the venue's country
 *   4. the Adyen US store sends address.stateOrProvince and a +1 phone; a UK store is unchanged
 *   5. the default "order ready" text says pickup at a US venue, collection at a UK one
 *
 * Run: `node --test src/lib/phonesAddressesBatch3.test.js`
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { toE164 as sharedToE164 } from '../../supabase/functions/_shared/regionPack.js';
import { toE164 as manifestToE164, buildManifest } from './delivery/manifest.js';
import { buildHubriseOrder } from './delivery/hubriseOrder.js';
import { buildStorePayload, US_STATES } from '../../supabase/functions/_shared/adyenStorePayload.js';
import { getDefaultTemplate, orderReadyDefaultSms } from '../../supabase/functions/_shared/message-types.ts';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');

const US_TYPED = ['(801) 555-1234', '801-555-1234', '8015551234', '+1 801 555 1234'];
const US_E164 = '+18015551234';
const UK_TYPED = '07931 129015';
const UK_E164 = '+447931129015';

// ── 1. the phone readers ────────────────────────────────────────────────────────

test('the shared reader with a venue currency: US numbers get +1, a UK number reads as before', () => {
  for (const raw of US_TYPED) assert.equal(sharedToE164(raw, 'USD'), US_E164, raw);
  assert.equal(sharedToE164(UK_TYPED, 'GBP'), UK_E164);
  // No currency is the UK reading, as every reader did before.
  assert.equal(sharedToE164(UK_TYPED), UK_E164);
});

test('manifest.js toE164 (courier phones): the venue currency decides; UK unchanged', () => {
  for (const raw of US_TYPED) assert.equal(manifestToE164(raw, 'USD'), US_E164, raw);
  assert.equal(manifestToE164(UK_TYPED), UK_E164);
  assert.equal(manifestToE164(UK_TYPED, 'GBP'), UK_E164);
  assert.equal(manifestToE164('+447911123456'), '+447911123456');
  assert.equal(manifestToE164('44 7911 123456'), '+447911123456');
  assert.equal(manifestToE164(''), '');
});

test('buildManifest reads both phones with the quote currency (a US venue quotes in USD)', () => {
  for (const raw of US_TYPED) {
    const m = buildManifest({
      order: { ref: 'R1', items: [], customer: { name: 'Sam', phone: raw } },
      quote: { currency: 'USD' },
      pickup: { contact: { name: 'Kitchen', phone: raw } },
    });
    assert.equal(m.dropoff.phone, US_E164, raw);
    assert.equal(m.pickup.phone, US_E164, raw);
  }
  const uk = buildManifest({ order: { ref: 'R1', items: [], customer: { phone: UK_TYPED } }, quote: { currency: 'GBP' }, pickup: {} });
  assert.equal(uk.dropoff.phone, UK_E164);
});

test('buildHubriseOrder reads the customer phone with the order currency', () => {
  for (const raw of US_TYPED) {
    const b = buildHubriseOrder({ order: { ref: 'R1', items: [], customer: { name: 'Sam', phone: raw } }, quote: {}, currency: 'USD' });
    assert.equal(b.customer.phone, US_E164, raw);
  }
  const uk = buildHubriseOrder({ order: { ref: 'R1', items: [], customer: { phone: UK_TYPED } }, quote: {} });
  assert.equal(uk.customer.phone, UK_E164);
});

test('the browser reader (dispatch.js tracking text) follows the active venue', () => {
  // src/lib/regionPack.js toE164 is the shared reader with the active venue's currency (it
  // imports ./currency without an extension, so node cannot load it: its rule is held by source).
  const rp = read('./regionPack.js');
  assert.match(rp, /return toE164For\(raw, countryCodeOrVenue \?\? getActiveCurrencyCode\(\)\);/);
  const src = read('./delivery/dispatch.js');
  assert.match(src, /import \{ toE164 \} from '\.\.\/\.\.\/\.\.\/supabase\/functions\/_shared\/regionPack\.js'/);
  assert.match(src, /toE164\(phone, getActiveCurrencyCode\(\)\)/);
  assert.doesNotMatch(src, /from '\.\/manifest\.js'/);
});

// Edge functions: no Deno here, so each is held to calling the shared reader with the venue's
// currency, and the old UK only branch ('07' or '0' becomes '+44') is gone from its own reader.
const EDGE = [
  { file: '../../supabase/functions/order-notify/index.ts', imports: /import \{ toE164, regionOf \} from '\.\.\/_shared\/regionPack\.js'/, calls: [/toE164\(String\(raw \|\| ''\), currency \|\| 'GBP'\)/, /normalisePhone\(String\(customer\.phone \|\| ''\), currency\)/, /normalisePhone\(String\(orderContact\.phone \|\| ''\), currency\)/] },
  { file: '../../supabase/functions/_shared/delivery-dispatch.ts', imports: /import \{ toE164 \} from '\.\/regionPack\.js'/, calls: [/toE164\(s, currency \|\| 'GBP'\)/, /e164\(cust\.phone, currency\)/, /e164\(cfg\?\.pickup_contact\?\.phone \|\| '', currency\)/] },
  { file: '../../supabase/functions/ops-escalate/index.ts', imports: /import \{ toE164 as regionE164 \} from '\.\.\/_shared\/regionPack\.js'/, calls: [/regionE164\(d, currency \|\| 'GBP'\)/, /toE164\(r\.phone, currency\)/, /toE164\(s\.mobile, currency\)/, /toE164\(hr\.mobile, await venueCurrency\(a\.location_id\)\)/] },
  { file: '../../supabase/functions/send-welcome/index.ts', imports: /import \{ toE164 as regionE164 \} from '\.\.\/_shared\/regionPack\.js'/, calls: [/regionE164\(clean, currency \|\| 'GBP'\)/, /toE164\(customer\.phone, loc\?\.currency \?\? null\)/, /\.select\('name, currency'\)/] },
  { file: '../../supabase/functions/uber-direct/index.ts', imports: /import \{ toE164 as regionE164 \} from '\.\.\/_shared\/regionPack\.js'/, calls: [/regionE164\(s, venue \|\| 'GBP'\)/, /e164\(pc\.phone, venueCcy \? \{ currency: venueCcy \} : \{ country: pa\.country \|\| 'GB' \}\)/] },
  { file: '../../supabase/functions/review-request/index.ts', imports: /import \{ toE164 \} from '\.\.\/_shared\/regionPack\.js'/, calls: [/const phone = toE164\(typed, currency \|\| 'GBP'\) \|\| typed;/] },
];

for (const { file, imports, calls } of EDGE) {
  test(`${file.split('/').slice(-2).join('/')}: reads phones through the shared reader with the venue currency`, () => {
    const src = read(file);
    assert.match(src, imports);
    for (const c of calls) assert.match(src, c);
    // The old UK only branches of the function's own reader are gone.
    assert.doesNotMatch(src, /startsWith\('07'\)[^\n]*'\+44'/);
    assert.doesNotMatch(src, /if \(s\.startsWith\('0'\)\) return '\+44'/);
  });
}

test('order-notify reads the venue before the phone (the number needs the venue country)', () => {
  const src = read('../../supabase/functions/order-notify/index.ts');
  const venueRead = src.indexOf(".from('locations').select('name, currency, timezone')");
  assert.ok(venueRead > 0);
  assert.ok(venueRead < src.indexOf("normalisePhone(String(orderContact.phone || ''), currency)"));
  assert.ok(venueRead < src.indexOf("normalisePhone(String(customer.phone || ''), currency)"));
});

test('send-sms refusal names no UK number', () => {
  const src = read('../../supabase/functions/send-sms/index.ts');
  const refusal = src.split('\n').find((l) => l.includes('invalid phone number'));
  assert.ok(refusal);
  assert.doesNotMatch(refusal, /\+44/);
  assert.match(src, /it must be E\.164, a \+ then the country code and the number/);
});

// ── 2. placeholders and labels ──────────────────────────────────────────────────

// Every file in this batch that showed a UK example or a "Postcode" label. A line that still
// carries one must also carry the country gate that picks it (a US venue sees its own words).
const GATED_FILES = [
  '../backoffice/sections/ReceiptBranding.jsx',
  '../backoffice/sections/GiftCards.jsx',
  '../backoffice/sections/review/ReviewTriggers.jsx',
  '../backoffice/sections/GuestManageSettings.jsx',
  '../components/CustomerModal.jsx',
  '../components/OrderTypeModal.jsx',
  '../backoffice/sections/marketing/Compliance.jsx',
  '../backoffice/sections/marketing/Campaigns.jsx',
  '../backoffice/sections/LocationSettings.jsx',
  '../backoffice/sections/UberDirect.jsx',
  '../surfaces/catering/CateringCheckout.jsx',
  '../surfaces/qr/QrCheckout.jsx',
  '../surfaces/online/OnlineSurface.jsx',
  '../surfaces/mpos/MCustomerCapture.jsx',
  '../surfaces/waitlist/AddPartyDrawer.jsx',
  '../surfaces/TablesSurface.jsx',
  '../admin/components/AdyenGoLiveFlow.jsx',
];
const UK_WORDS = /\+44|07700|\bPostcode\b/;
const GATE = /activeCountry\(\) === 'US'|usVenue \?|=== 'USD' \?|=== 'us' \?/;

for (const f of GATED_FILES) {
  test(`${f.split('/').pop()}: no UK example or Postcode label without the venue's country gate`, () => {
    const lines = read(f).split('\n');
    const bad = [];
    lines.forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, '').replace(/\{\/\*.*?\*\/\}/g, '');
      if (/^\s*(\*|\/\*|\/\/)/.test(line)) return;          // comments
      if (UK_WORDS.test(code) && !GATE.test(code)) bad.push(`${i + 1}: ${line.trim()}`);
    });
    assert.deepEqual(bad, []);
  });
}

test('the gated placeholders use the region pack phone format and the ZIP label helper', () => {
  assert.match(read('../backoffice/sections/ReceiptBranding.jsx'), /activeCountry\(\) === 'US' \? activeRegionPack\(\)\.phoneFormat : '\+44 20 7123 4567'/);
  assert.match(read('../backoffice/sections/review/ReviewTriggers.jsx'), /activeRegionPack\(\)\.phoneFormat : '07700 900000'/);
  const cm = read('../components/CustomerModal.jsx');
  assert.match(cm, /\{postcodeLabel\(venueCcy\)\} <span/);
  assert.match(cm, /usVenue \? activeRegionPack\(\)\.phoneFormat : '07700 000000'/);
  assert.match(read('../surfaces/catering/CateringCheckout.jsx'), /\{postcodeLabel\(venueCcy\)\} \*/);
  assert.match(read('../backoffice/sections/UberDirect.jsx'), /\{postcodeLabel\(venueCcy\)\}/);
});

// ── 3. address search country ───────────────────────────────────────────────────

test('every address search that passed no country now passes the venue country', () => {
  for (const f of ['../backoffice/sections/UberDirect.jsx', '../components/CustomerModal.jsx', '../surfaces/catering/CateringCheckout.jsx']) {
    const src = read(f);
    const tags = src.match(/<AddressAutocomplete[\s\S]*?\/>/g) || [];
    assert.ok(tags.length > 0, f);
    for (const t of tags) assert.match(t, /country=\{addressCountry\(venueCcy\)\}/, f);
  }
});

// ── 4. the Adyen store ──────────────────────────────────────────────────────────

test('a US store sends stateOrProvince and a +1 phone', () => {
  for (const phone of US_TYPED) {
    const r = buildStorePayload({
      body: { address: { line1: '120 N University Ave', city: 'Provo', postal_code: '84601', state_or_province: 'ut' }, phone },
      locName: 'Mozz Pizza', venueCountry: 'US', live: true,
    });
    assert.equal(r.ok, true, phone);
    assert.equal(r.payload.phoneNumber, US_E164);
    assert.deepEqual(r.payload.address, { country: 'US', line1: '120 N University Ave', city: 'Provo', stateOrProvince: 'UT', postalCode: '84601' });
  }
});

test('a US store with no address is refused in words, on test too: no London, no made up phone', () => {
  for (const live of [true, false]) {
    const r = buildStorePayload({ body: { address: {}, phone: '' }, locName: 'Mozz', venueCountry: 'US', live });
    assert.equal(r.ok, false);
    assert.match(r.error, /street, city, state, ZIP code and phone number/);
    assert.doesNotMatch(JSON.stringify(r), /High Street|London|EC1A|\+44/);
  }
  const noState = buildStorePayload({ body: { address: { line1: '1 Main St', city: 'Provo', postal_code: '84601' }, phone: '8015551234' }, venueCountry: 'US' });
  assert.equal(noState.ok, false);
  assert.match(noState.error, /state/);
  assert.equal(buildStorePayload({ body: { address: { line1: '1 Main St', city: 'Provo', postal_code: '84601', state_or_province: 'ZZ' }, phone: '8015551234' }, venueCountry: 'US' }).ok, false);
  assert.equal(buildStorePayload({ body: { address: { line1: '1 Main St', city: 'Provo', postal_code: 'PR1 2AB', state_or_province: 'UT' }, phone: '8015551234' }, venueCountry: 'US' }).ok, false);
  assert.equal(buildStorePayload({ body: { address: { line1: '1 Main St', city: 'Provo', postal_code: '84601', state_or_province: 'UT' }, phone: '555' }, venueCountry: 'US' }).ok, false);
});

test('a UK store is built exactly as before (digits only phone, test placeholder, live refusal)', () => {
  const body = { address: { line1: '9 New Street', city: 'Huddersfield', postal_code: 'HD3 4LN' }, phone: '01484 123456' };
  assert.deepEqual(buildStorePayload({ body, locName: 'Hudds', venueCountry: 'GB', live: true }), {
    ok: true,
    payload: {
      description: 'Hudds', shopperStatement: 'Hudds', phoneNumber: '01484123456',
      address: { country: 'GB', line1: '9 New Street', city: 'Huddersfield', postalCode: 'HD3 4LN' },
    },
  });
  assert.deepEqual(buildStorePayload({ body: {}, locName: 'Hudds', venueCountry: 'GB', live: false }).payload, {
    description: 'Hudds', shopperStatement: 'Hudds', phoneNumber: '+441234567890',
    address: { country: 'GB', line1: '1 High Street', city: 'London', postalCode: 'EC1A 1AA' },
  });
  assert.deepEqual(buildStorePayload({ body: {}, locName: 'Hudds', venueCountry: 'GB', live: true }),
    { ok: false, error: 'A live store needs the venue address (street, town, postcode) and a phone number.' });
});

test('the state list is the 50 states and DC, and the function and the go live form use it', () => {
  assert.equal(US_STATES.length, 51);
  assert.equal(new Set(US_STATES.map(([c]) => c)).size, 51);
  assert.ok(US_STATES.every(([c]) => /^[A-Z]{2}$/.test(c)));
  assert.ok(US_STATES.some(([c]) => c === 'DC'));
  const fn = read('../../supabase/functions/adyen-terminal-admin/index.ts');
  assert.match(fn, /import \{ buildStorePayload \} from '\.\.\/_shared\/adyenStorePayload\.js'/);
  assert.match(fn, /buildStorePayload\(\{ body, locName: String\(loc\.name \|\| ''\), venueCountry, live: !!storeCfg\.live \}\)/);
  assert.doesNotMatch(fn, /'\+441234567890'|'EC1A 1AA'/);
  const flow = read('../admin/components/AdyenGoLiveFlow.jsx');
  assert.match(flow, /US_STATES\.map/);
  assert.match(flow, /usVenue \? \{ state_or_province: form\.state_or_province \} : \{\}/);
  assert.match(flow, /\['postal_code', usVenue \? 'ZIP code' : 'Postcode'\]/);
});

// ── 5. the order ready words ────────────────────────────────────────────────────

test('the default order ready text says pickup at a US venue and collection otherwise', () => {
  assert.match(getDefaultTemplate('order_ready', 'sms', 'US').body, /ready for pickup at/);
  assert.equal(getDefaultTemplate('order_ready', 'sms').body, 'Hi {{customer_name}}, your order #{{order_number}} is ready for collection at {{venue_name}}!');
  assert.equal(getDefaultTemplate('order_ready', 'sms', 'UK').body, getDefaultTemplate('order_ready', 'sms').body);
  assert.match(orderReadyDefaultSms('US'), /pickup/);
  // Types with no US words read as before at a US venue.
  assert.deepEqual(getDefaultTemplate('order_confirmation', 'sms', 'US'), getDefaultTemplate('order_confirmation', 'sms'));
  const fn = read('../../supabase/functions/order-notify/index.ts');
  assert.match(fn, /resolveAndRender\(companyId, messageType, 'sms', mergeData, \{ country: usVenue \? 'US' : null \}\)/);
  assert.match(fn, /usVenue\s*\n?\s*\? substituteTags\(orderReadyDefaultSms\('US'\), mergeData\)\s*\n?\s*: `Hi \$\{firstName\}, your order #\$\{ref\} is ready for collection at \$\{venueName\}!`/);
  const resolver = read('../../supabase/functions/_shared/template-resolver.ts');
  assert.match(resolver, /getDefaultTemplate\(messageType, channel, opts\?\.country\)/);
  // The custom template path is untouched: a venue's own words are never rewritten.
  assert.match(resolver, /body: substituteTags\(custom\.body_text, data\)/);
});
