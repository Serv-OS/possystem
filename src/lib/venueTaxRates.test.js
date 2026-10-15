// venueTaxRates.test.js: a venue only ever holds, offers, pushes and applies its OWN tax rates.
// 27 Sep 2026, Peter: "for some reason every products tax rate has been removed but they
// where there earlier I have re applied Tax to all products but thats wrong please chase".
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  toStoreRate, ownVenueRates, ratesAfterRead, readSucceeded, ratesForSnapshot, ratesFromSnapshot,
  holdsOwnRates, productsWithoutOwnRate, defaultSeedRatesFor, seedVenueTaxRates, seedWords,
  copiesNeedingMasterRate, verifiedVenueRates, readMayReplace,
  jwtClaims, sessionTrustsEmpty, clientTrustsEmpty, taggedVenueRows, venueRowsFromSnapshot,
  lineTaxRefs, noTaxRatesAlert,
} from './venueTaxRates.js';
import { resolveTaxRate, calculateOrderTax } from './tax.js';

const LEEDS = '1e252e7c-c875-4971-b91d-1e945c26956b';
const TS = '3f915972-7107-4f70-9b3d-de80ba9ab0c2';
const tsStd = { id: '6a159b5e-441b-4f69-93e9-9e04570812c1', name: 'Standard Rate', code: 'VAT20', rate: '0.2', type: 'inclusive', applies_to: ['all'], is_default: true, active: true, location_id: TS };
const tsRed = { id: '446937cd', name: 'Reduced Rate', code: 'VAT5', rate: '0.05', type: 'inclusive', applies_to: ['all'], is_default: false, active: true, location_id: TS };
const leedsStd = { id: 'leeds-std', name: 'Standard Rate', code: 'VAT20', rate: '0.2', type: 'inclusive', applies_to: ['all'], is_default: true, active: true, location_id: LEEDS };

test('a store rate carries the venue it belongs to', () => {
  const r = toStoreRate(tsStd);
  assert.equal(r.locationId, TS);
  assert.equal(r.rate, 0.2);
  assert.equal(r.isDefault, true);
  assert.equal(toStoreRate({ ...leedsStd, location_id: undefined }, LEEDS).locationId, LEEDS, 'the read venue tags a row that has no location column');
});

test('THE LEEDS BUG: an EMPTY read never keeps another venue\'s rates', () => {
  const held = [toStoreRate(tsStd), toStoreRate(tsRed)];   // Leeds Back Office held Train Station's rates
  const next = ratesAfterRead({ data: [], error: null }, LEEDS, held);
  assert.deepEqual(next, [], 'Leeds has no rates, so the store has none: never Train Station\'s');
  assert.equal(readSucceeded({ data: [], error: null }), true);
});

test('an EMPTY answer from a session that is not trusted keeps this venue\'s rates, pushed ones included', () => {
  // tax_rates answers EMPTY (not an error) to a caller with no session and to a password only login
  // held back by second_step_fence. Wiping the rates then would book NO VAT on every sale.
  const own = toStoreRate(leedsStd);
  assert.deepEqual(ratesAfterRead({ data: [], error: null }, LEEDS, [own, toStoreRate(tsStd)]).map((r) => r.id), ['leeds-std'], 'another venue\'s rate still goes');
  const unchecked = { ...toStoreRate(tsStd), locationId: LEEDS, unverified: true };   // an old style Leeds push
  assert.deepEqual(ratesAfterRead({ data: [], error: null }, LEEDS, [unchecked]).map((r) => r.id), [tsStd.id], 'the till keeps charging with what its push gave it');
  assert.deepEqual(ratesAfterRead({ data: [], error: null }, LEEDS, [unchecked], { trusted: false }).map((r) => r.id), [tsStd.id]);
  assert.deepEqual(ratesAfterRead({ data: null, error: { message: 'offline' } }, LEEDS, [unchecked]).map((r) => r.id), [tsStd.id], 'offline, the till charges with what its cached push gave it');
  assert.deepEqual(ratesAfterRead({ data: [leedsStd], error: null }, LEEDS, [unchecked]).map((r) => r.id), ['leeds-std'], 'rows always win');
});

test('REVIEW PROBE: an old style push, then an empty read with no session, keeps the rates (Train Station books VAT)', () => {
  // Every push made before this fix carries untagged rates. After deploy every till boots on one, so
  // its rates are unchecked until its own read answers; a read with no session answers empty.
  const oldTsPush = { locationId: TS, taxRates: [{ id: tsStd.id, name: 'Standard Rate', rate: 0.2, type: 'inclusive', isDefault: true }, { id: tsRed.id, name: 'Reduced Rate', rate: 0.05, type: 'inclusive' }] };
  const booted = ratesFromSnapshot(oldTsPush, TS, []);
  assert.equal(booted.length, 2);
  assert.ok(booted.every((r) => r.unverified));
  const afterRead = ratesAfterRead({ data: [], error: null }, TS, booted);
  assert.deepEqual(afterRead.map((r) => r.id), [tsStd.id, tsRed.id], 'v1 gave [] here: every sale at Train Station with no VAT');
  const t = calculateOrderTax([{ price: 3.6, qty: 1, taxRateId: null }], afterRead, 'dine-in');
  assert.equal(Math.round(t.totalTax * 100), 60, 'a £3.60 coffee still books 60p VAT');
});

test('an EMPTY answer from a trusted session is the truth: the venue has no live rates', () => {
  const own = toStoreRate(leedsStd);
  const unchecked = { ...toStoreRate(tsStd), locationId: LEEDS, unverified: true };
  assert.deepEqual(ratesAfterRead({ data: [], error: null }, LEEDS, [own, unchecked], { trusted: true }), [], 'a device or second step login reading nothing means nothing is there');
  assert.deepEqual(ratesAfterRead({ data: null, error: { message: 'x' } }, LEEDS, [own], { trusted: true }).map((r) => r.id), ['leeds-std'], 'a failed read is never the truth, trusted or not');
  assert.deepEqual(ratesAfterRead({ data: [leedsStd], error: null }, LEEDS, [], { trusted: true }).map((r) => r.id), ['leeds-std']);
});

const b64url = (o) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const jwt = (claims) => `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(claims)}.sig`;
const future = Math.floor(Date.now() / 1000) + 3600;

test('which sessions an empty answer can be believed from', () => {
  const s = (claims) => ({ access_token: jwt(claims) });
  assert.equal(sessionTrustsEmpty(s({ role: 'authenticated', is_anonymous: true, aal: 'aal1', exp: future })), true, 'a till, KDS or kiosk (anonymous device session)');
  assert.equal(sessionTrustsEmpty(s({ role: 'authenticated', is_anonymous: false, aal: 'aal2', exp: future })), true, 'a Back Office login that finished its second step');
  assert.equal(sessionTrustsEmpty(s({ role: 'authenticated', is_anonymous: false, aal: 'aal1', exp: future })), false, 'a password only login: the fence may answer it empty');
  assert.equal(sessionTrustsEmpty(s({ role: 'authenticated', is_anonymous: true, exp: Math.floor(Date.now() / 1000) - 5 })), false, 'expired: supabase-js may send the bare public key');
  assert.equal(sessionTrustsEmpty(s({ role: 'anon', is_anonymous: true, exp: future })), false, 'the public key role');
  assert.equal(sessionTrustsEmpty(null), false, 'no session at all');
  assert.equal(sessionTrustsEmpty({ access_token: 'not-a-jwt' }), false);
  assert.equal(sessionTrustsEmpty({ access_token: 'a.!!!.c' }), false);
  assert.equal(jwtClaims(jwt({ sub: 'x', aal: 'aal2' })).aal, 'aal2');
  assert.equal(jwtClaims(undefined), null);
});

test('clientTrustsEmpty asks the client for its session and never throws', async () => {
  const client = (session) => ({ auth: { getSession: async () => ({ data: { session } }) } });
  assert.equal(await clientTrustsEmpty(client({ access_token: jwt({ role: 'authenticated', is_anonymous: true, exp: future }) })), true);
  assert.equal(await clientTrustsEmpty(client(null)), false);
  assert.equal(await clientTrustsEmpty({ auth: { getSession: async () => { throw new Error('offline'); } } }), false);
  assert.equal(await clientTrustsEmpty(null), false);
});

test('discounts: rows replace; an empty answer replaces only from a trusted session; a failed read never', () => {
  assert.equal(readMayReplace({ data: [{ id: 'd' }], error: null }), true);
  assert.equal(readMayReplace({ data: [], error: null }, { trusted: true }), true, 'a venue with no discounts has none');
  assert.equal(readMayReplace({ data: [], error: null }, { trusted: false }), false, 'no session, or a fenced one: the policy answers empty for every venue');
  assert.equal(readMayReplace({ data: [], error: null }), false);
  assert.equal(readMayReplace({ data: null, error: { message: 'x' } }, { trusted: true }), false);
  assert.equal(readMayReplace(null, { trusted: true }), false);
});

test('THE LEEDS PUSH, discounts: a push carries only this venue\'s presets and rules; a till takes only its own', () => {
  const tsPreset = { id: 'staff50', name: 'Staff Discount 50%', locationId: TS };
  const provoRule = { id: 'lunch', name: 'Lunch Deal', locationId: 'provo' };
  const leedsPreset = { id: 'leeds-staff', name: 'Staff', locationId: LEEDS };
  assert.deepEqual(taggedVenueRows([tsPreset, provoRule, leedsPreset, { id: 'untagged' }], LEEDS).map((r) => r.id), ['leeds-staff'], 'untagged and foreign rows are never pushed');
  assert.deepEqual(taggedVenueRows([leedsPreset], null), []);
  // Till side.
  assert.equal(venueRowsFromSnapshot([tsPreset], { locationId: TS }, LEEDS, []), null, 'another venue\'s push gives nothing');
  assert.deepEqual(venueRowsFromSnapshot([leedsPreset, tsPreset], { locationId: LEEDS }, LEEDS, []).map((r) => r.id), ['leeds-staff']);
  const polluted = [{ id: 'staff50', name: 'Staff Discount 50%' }, { id: 'cup', name: 'Resuable Cup' }];   // old code, untagged
  assert.equal(venueRowsFromSnapshot(polluted, { locationId: LEEDS }, LEEDS, [leedsPreset]), null, 'a till holding its own keeps them');
  assert.deepEqual(venueRowsFromSnapshot(polluted, { locationId: LEEDS }, LEEDS, []).map((r) => r.id), ['staff50', 'cup'], 'with none of its own, an old labelled push still applies (the next push from fixed code replaces it)');
  assert.equal(venueRowsFromSnapshot(polluted, {}, LEEDS, []), null, 'an unlabelled push is not taken untagged');
  assert.equal(venueRowsFromSnapshot([], { locationId: LEEDS }, LEEDS, []), null, 'an empty pushed list changes nothing');
  assert.deepEqual(venueRowsFromSnapshot([{ id: 'r', location_id: LEEDS }], { locationId: LEEDS }, LEEDS, [leedsPreset]).map((r) => r.id), ['r'], 'snake case tag too');
});

test('a till line never books no VAT because its product names another venue\'s rate', () => {
  const rates = [toStoreRate(leedsStd), toStoreRate({ ...leedsStd, id: 'leeds-zero', name: 'Zero Rate', rate: '0', is_default: false })];
  const r = lineTaxRefs(tsStd.id, { takeaway: tsRed.id, delivery: 'leeds-zero' }, rates);
  assert.equal(r.taxRateId, null, 'unknown here: the venue default applies');
  assert.deepEqual(r.taxOverrides, { delivery: 'leeds-zero' }, 'an unknown override is dropped, a known one kept');
  assert.deepEqual(r.dropped.sort(), [tsRed.id, tsStd.id].sort());
  const t = calculateOrderTax([{ price: 3.6, qty: 1, taxRateId: r.taxRateId, taxOverrides: r.taxOverrides }], rates, 'dine-in');
  assert.equal(Math.round(t.totalTax * 100), 60, 'the venue default, never zero');
  // 8 Oct 2026 (D4): the engine itself now gives a foreign id the venue default and flags the
  // line (before 8 Oct it resolved no rate and booked no VAT; this cleaning was the only guard).
  const raw = calculateOrderTax([{ uid: 'l1', price: 3.6, qty: 1, taxRateId: tsStd.id }], rates, 'dine-in');
  assert.equal(Math.round(raw.totalTax * 100), 60, 'the engine agrees without the cleaning');
  assert.deepEqual(raw.fallbacks.map((f) => [f.reason, f.rateId, f.lineId]), [['rate-not-found', tsStd.id, 'l1']]);
  // ...and a cleaned line carries WHY, so the engine records it on the sale too.
  assert.deepEqual(r.taxFallback, { reason: 'rate-not-found', rateId: tsStd.id });
  const cleaned = calculateOrderTax([{ uid: 'l2', price: 3.6, qty: 1, taxRateId: r.taxRateId, taxOverrides: r.taxOverrides, taxFallback: r.taxFallback }], rates, 'dine-in');
  assert.deepEqual(cleaned.fallbacks.map((f) => [f.reason, f.rateId, f.lineId]), [['rate-not-found', tsStd.id, 'l2']]);
  assert.equal(lineTaxRefs('leeds-std', { takeaway: tsRed.id }, rates).taxFallback.reason, 'override-rate-not-found', 'only an override dropped: the item rate stands');
  assert.deepEqual(lineTaxRefs('leeds-zero', {}, rates), { taxRateId: 'leeds-zero', taxOverrides: {}, dropped: [] }, 'a known rate is untouched, and carries no flag');
  assert.deepEqual(lineTaxRefs(tsStd.id, { takeaway: tsRed.id }, []).taxRateId, tsStd.id, 'with no rates loaded yet, nothing is judged');
  assert.equal(lineTaxRefs('leeds-std', {}, [{ ...toStoreRate(leedsStd), active: false }]).taxRateId, 'leeds-std', 'only inactive rates held: nothing to judge by');
  assert.equal(lineTaxRefs('gone', {}, [toStoreRate(leedsStd), { ...toStoreRate(leedsStd), id: 'gone', active: false }]).taxRateId, null, 'an inactive rate charges nothing, so it is not held');
  assert.equal(lineTaxRefs(null, null, rates).taxRateId, null);
});

test('the Items banner lists products whose order type override is another venue\'s', () => {
  const rates = [toStoreRate(leedsStd)];
  const r = productsWithoutOwnRate([
    { id: 'a', name: 'Latte', taxRateId: 'leeds-std', taxOverrides: { takeaway: tsRed.id } },
    { id: 'b', name: 'Tea', taxRateId: 'leeds-std', taxOverrides: { takeaway: null } },
    { id: 'c', name: 'Mocha', taxRateId: 'leeds-std', tax_overrides: { delivery: 'leeds-std' } },
  ], rates, LEEDS);
  assert.deepEqual(r.foreignOverride.map((i) => i.id), ['a']);
  assert.deepEqual(r.all, [], 'their own rate is fine, so a bulk apply never touches them');
});

test('the no rates alert: only after a trusted read, never with tax profiles, in the venue\'s words', () => {
  assert.equal(noTaxRatesAlert({ trusted: false, rateCount: 0 }), null, 'an untrusted empty answer proves nothing');
  assert.equal(noTaxRatesAlert({ trusted: true, rateCount: 3 }), null);
  assert.equal(noTaxRatesAlert({ trusted: true, rateCount: 0, hasProfiles: true }), null, 'a profile venue charges through its profiles');
  assert.match(noTaxRatesAlert({ trusted: true, rateCount: 0, currency: 'GBP' }).body, /no VAT.*Seed UK rates/);
  const us = noTaxRatesAlert({ trusted: true, rateCount: 0, currency: 'USD' });
  assert.match(us.body, /no sales tax.*tax profiles/);
  assert.doesNotMatch(us.body, /Seed UK rates|no VAT/);
});

test('a successful read replaces with this venue\'s rows, tagged', () => {
  const next = ratesAfterRead({ data: [leedsStd], error: null }, LEEDS, [toStoreRate(tsStd)]);
  assert.deepEqual(next.map((r) => [r.id, r.locationId]), [['leeds-std', LEEDS]]);
});

test('a row for another venue in a read is never taken', () => {
  const next = ratesAfterRead({ data: [leedsStd, tsStd], error: null }, LEEDS, []);
  assert.deepEqual(next.map((r) => r.id), ['leeds-std']);
});

test('a FAILED read keeps only what is known to be this venue\'s', () => {
  const held = [toStoreRate(leedsStd), toStoreRate(tsStd), { id: 'untagged', rate: 0.2 }];
  assert.deepEqual(ratesAfterRead({ data: null, error: { message: 'offline' } }, LEEDS, held).map((r) => r.id), ['leeds-std']);
  assert.deepEqual(ratesAfterRead(null, LEEDS, held).map((r) => r.id), ['leeds-std'], 'a read that threw is a failed read');
  assert.equal(readSucceeded(null), false);
  assert.equal(readSucceeded({ data: null, error: { message: 'x' } }), false);
});

test('a push snapshot carries only the push venue\'s rates', () => {
  const store = [toStoreRate(tsStd), toStoreRate(tsRed)];
  assert.deepEqual(ratesForSnapshot(store, LEEDS), [], 'Leeds push never carries Train Station\'s rates');
  assert.deepEqual(ratesForSnapshot([...store, toStoreRate(leedsStd)], LEEDS).map((r) => r.id), ['leeds-std']);
  assert.deepEqual(ratesForSnapshot(store, null), [], 'no venue, no rates');
  assert.deepEqual(ownVenueRates([{ id: 'x' }], LEEDS), [], 'an untagged rate is not known to be this venue\'s');
});

test('a till takes from a snapshot only its own venue\'s rates', () => {
  const tagged = { locationId: LEEDS, taxRates: [toStoreRate(leedsStd), toStoreRate(tsStd)] };
  assert.deepEqual(ratesFromSnapshot(tagged, LEEDS).map((r) => r.id), ['leeds-std']);
  assert.deepEqual(ratesFromSnapshot({ locationId: TS, taxRates: [toStoreRate(tsStd)] }, LEEDS), [], 'another venue\'s push gives nothing');
  // An untagged rate from Back Office code older than this fix: taken only when the
  // snapshot says it is for this venue, and tagged on the way in.
  const legacy = { locationId: LEEDS, taxRates: [{ id: 'old', rate: 0.2, isDefault: true }] };
  assert.deepEqual(ratesFromSnapshot(legacy, LEEDS).map((r) => [r.id, r.locationId, r.unverified]), [['old', LEEDS, true]], 'usable to charge, marked unchecked');
  assert.equal(ratesFromSnapshot(tagged, LEEDS)[0].unverified, undefined, 'a tagged rate is checked');
  assert.deepEqual(ratesFromSnapshot({ taxRates: [{ id: 'old' }] }, LEEDS), [], 'untagged rates in an unlabelled snapshot are not taken');
  assert.deepEqual(ratesFromSnapshot({ locationId: LEEDS }, LEEDS), [], 'no rates in the snapshot');
});

test('THE LEEDS PUSH: a Leeds labelled push carrying Train Station\'s rates untagged never replaces Leeds\' own', () => {
  // Every Leeds push from 26 Sep 06:47 (old Back Office code) was labelled Leeds and carried
  // Train Station's three rates with no venue tag.
  const polluted = { locationId: LEEDS, taxRates: [{ id: tsStd.id, name: 'Standard Rate', rate: 0.2, isDefault: true }, { id: tsRed.id, name: 'Reduced Rate', rate: 0.05 }] };
  const held = [toStoreRate(leedsStd)];   // the till already read Leeds' own rates from the database
  assert.deepEqual(ratesFromSnapshot(polluted, LEEDS, held), [], 'nothing taken: the till keeps its own');
  assert.deepEqual(ratesFromSnapshot(polluted, LEEDS, [toStoreRate(tsStd)]).map((r) => r.id), [tsStd.id, tsRed.id],
    'holding only another venue\'s rates is holding none of its own (an offline boot takes the labelled push, tagged for Leeds)');
  const tagged = { locationId: LEEDS, taxRates: [toStoreRate({ ...leedsStd, name: 'Standard 20%' })] };
  assert.deepEqual(ratesFromSnapshot(tagged, LEEDS, held).map((r) => r.name), ['Standard 20%'], 'a tagged Leeds rate still refreshes the till');
});

test('the tax settings safety check only counts rates held for THIS venue', () => {
  assert.equal(holdsOwnRates([toStoreRate(tsStd)], LEEDS), false, 'Train Station\'s rates held at Leeds do not make an empty Leeds read suspicious');
  assert.equal(holdsOwnRates([toStoreRate(leedsStd)], LEEDS), true);
  assert.equal(holdsOwnRates([{ ...toStoreRate(tsStd), locationId: LEEDS, unverified: true }], LEEDS), false, 'nor do rates an old style push labelled Leeds');
});

test('an unchecked rate is never offered on a screen or pushed on again (the Leeds loop)', () => {
  const unchecked = { ...toStoreRate(tsStd), locationId: LEEDS, unverified: true };
  assert.deepEqual(ratesForSnapshot([unchecked, toStoreRate(leedsStd)], LEEDS).map((r) => r.id), ['leeds-std']);
  assert.deepEqual(verifiedVenueRates([unchecked], LEEDS), []);
  assert.deepEqual(ownVenueRates([unchecked], LEEDS).map((r) => r.id), [tsStd.id], 'the till may still charge with it until its own read answers');
});

test('products with no rate, or with ANOTHER venue\'s rate, are listed', () => {
  const rates = [toStoreRate(leedsStd)];
  const items = [
    { id: 'a', name: 'Latte', taxRateId: null },
    { id: 'b', name: 'Mocha', taxRateId: tsStd.id },          // Train Station's id, the Leeds case
    { id: 'c', name: 'Tea', taxRateId: 'leeds-std' },
    { id: 'd', name: 'Old', archived: true },
    { id: 'e', name: '', type: 'spacer' },
  ];
  const r = productsWithoutOwnRate(items, rates, LEEDS);
  assert.deepEqual(r.missing.map((i) => i.id), ['a']);
  assert.deepEqual(r.foreign.map((i) => i.id), ['b']);
  assert.deepEqual(r.all.map((i) => i.id), ['a', 'b']);
  assert.deepEqual(productsWithoutOwnRate(items, [toStoreRate(tsStd)], LEEDS).all.map((i) => i.id), ['a', 'b', 'c'], 'with no rates of its own, every product is listed');
  const inactive = [{ ...toStoreRate(leedsStd), active: false }];
  const off = productsWithoutOwnRate([{ id: 'c', taxRateId: 'leeds-std' }], inactive, LEEDS);
  assert.deepEqual(off.all.map((i) => i.id), ['c'], 'an inactive rate charges nothing (resolveTaxRate), so it counts as none');
  // Second review (27 Sep 2026): but it is this venue's own rate, not another venue's.
  assert.deepEqual(off.inactive.map((i) => i.id), ['c']);
  assert.deepEqual(off.foreign, [], 'an inactive rate of this venue is never called another venue\'s');
  assert.deepEqual(r.inactive, []);
});

test('when a venue gains rates, the copies with none (or another venue\'s) are the ones re-mapped from their master', () => {
  const rows = [
    { id: 'latte_5c26956b', master_id: 'latte', tax_rate_id: null },            // arrived before Leeds had rates
    { id: 'milk_5c26956b', master_id: 'milk', tax_rate_id: tsRed.id },          // the bulk apply wrote Train Station's id
    { id: 'tea_5c26956b', master_id: 'tea', tax_rate_id: 'leeds-std' },         // already one of ours: untouched
    { id: 'own', master_id: 'own', tax_rate_id: null },                         // a master here is this venue's to set
    { id: 'gone_5c26956b', master_id: 'gone', tax_rate_id: null, archived: true },
    { id: 'local', master_id: null, tax_rate_id: null },
    { id: 'cake_5c26956b', masterId: 'cake', taxRateId: null },                 // store shape too
  ];
  assert.deepEqual(copiesNeedingMasterRate(rows, ['leeds-std']).map((r) => r.id), ['latte_5c26956b', 'milk_5c26956b', 'cake_5c26956b']);
  assert.deepEqual(copiesNeedingMasterRate(rows, []).map((r) => r.id), ['latte_5c26956b', 'milk_5c26956b', 'tea_5c26956b', 'cake_5c26956b']);
});

test('a new UK venue gets Standard 20% (default), Reduced 5% and Zero; others get none here', () => {
  const uk = defaultSeedRatesFor('GBP');
  assert.deepEqual(uk.map((r) => [r.code, r.rate, r.type, r.is_default]), [['VAT20', 0.2, 'inclusive', true], ['VAT5', 0.05, 'inclusive', false], ['ZERO', 0, 'inclusive', false]]);
  assert.deepEqual(uk.map((r) => r.name), ['Standard Rate', 'Reduced Rate', 'Zero Rate'], 'the same names as Train Station and Barnsley, so shared copies map by name');
  assert.equal(defaultSeedRatesFor('gbp').length, 3);
  assert.equal(defaultSeedRatesFor('USD'), null, 'US venues keep the tax profile flow');
  assert.equal(defaultSeedRatesFor('EUR'), null);
  assert.equal(defaultSeedRatesFor(undefined), null);
  uk[0].applies_to.push('x');
  assert.deepEqual(defaultSeedRatesFor('GBP')[0].applies_to, ['all'], 'a copy, never the shared constant');
});

test('seeding: one insert of all three rows, only into an empty table', async () => {
  const inserted = [];
  const r = await seedVenueTaxRates({
    locationId: LEEDS, currency: 'GBP',
    readExisting: async () => ({ data: [], error: null }),
    insertRows: async (rows) => { inserted.push(rows); return { data: rows.map((x, i) => ({ id: `r${i}`, ...x })), error: null }; },
  });
  assert.equal(r.ok, true);
  assert.equal(r.added, 3);
  assert.equal(inserted.length, 1, 'one statement, so a venue is never half seeded');
  assert.ok(inserted[0].every((x) => x.location_id === LEEDS));
  assert.match(seedWords(r, 'Leeds'), /3 UK tax rates added to Leeds/);
});

test('seeding never adds on top of existing rates, and never when it could not check', async () => {
  let calls = 0;
  const insertRows = async () => { calls += 1; return { data: [], error: null }; };
  const has = await seedVenueTaxRates({ locationId: TS, currency: 'GBP', readExisting: async () => ({ data: [tsStd], error: null }), insertRows });
  assert.deepEqual([has.ok, has.added, has.skipped], [true, 0, 'has-rates']);
  const failedRead = await seedVenueTaxRates({ locationId: TS, currency: 'GBP', readExisting: async () => ({ data: null, error: { message: 'permission denied' } }), insertRows });
  assert.equal(failedRead.ok, false);
  assert.match(failedRead.error, /could not check/);
  const threw = await seedVenueTaxRates({ locationId: TS, currency: 'GBP', readExisting: async () => { throw new Error('offline'); }, insertRows });
  assert.equal(threw.ok, false);
  assert.equal(calls, 0, 'no insert in any of these');
  const us = await seedVenueTaxRates({ locationId: 'us', currency: 'USD', readExisting: async () => ({ data: [], error: null }), insertRows });
  assert.deepEqual([us.ok, us.skipped], [true, 'not-uk']);
  assert.equal(seedWords(us), null);
  const none = await seedVenueTaxRates({ locationId: null, currency: 'GBP', readExisting: async () => ({ data: [] }), insertRows });
  assert.equal(none.ok, false);
});

test('seeding reports a refused or short insert, in words', async () => {
  const refused = await seedVenueTaxRates({ locationId: LEEDS, currency: 'GBP', readExisting: async () => ({ data: [], error: null }), insertRows: async () => ({ data: null, error: { message: 'new row violates row-level security policy' } }) });
  assert.equal(refused.ok, false);
  assert.match(seedWords(refused, 'Leeds'), /NOT added to Leeds: new row violates.*Seed UK rates/);
  const short = await seedVenueTaxRates({ locationId: LEEDS, currency: 'GBP', readExisting: async () => ({ data: [], error: null }), insertRows: async () => ({ data: [{ id: 'one' }], error: null }) });
  assert.equal(short.ok, false);
  assert.match(short.error, /only 1 of 3/);
});

test('with its own rates, a product with no rate books the VENUE\'s default VAT', () => {
  const rates = [toStoreRate(leedsStd), toStoreRate({ ...leedsStd, id: 'leeds-zero', name: 'Zero Rate', rate: '0', is_default: false })];
  const r = resolveTaxRate({ taxRateId: null }, rates, 'dine-in');
  assert.equal(r.id, 'leeds-std', 'Leeds\' own default, never Train Station\'s');
  const t = calculateOrderTax([{ price: 3.6, qty: 1, taxRateId: null }], rates, 'dine-in');
  assert.equal(Math.round(t.totalTax * 100), 60, '£3.60 inclusive of 20% VAT is 60p');
  assert.equal(t.breakdown[0].rate.locationId, LEEDS);
});

test('28 Sep 2026: an unverified rate (old style push) never makes a line drop its own rate', async () => {
  const { lineTaxRefs } = await import('./venueTaxRates.js');
  const foreign = [{ id: 'ts-std', active: true, unverified: true }];
  const r = lineTaxRefs('leeds-std', { takeaway: 'leeds-zero' }, foreign);
  assert.equal(r.taxRateId, 'leeds-std', 'kept until the venue own read answers');
  assert.deepEqual(r.dropped, []);
  const own = [{ id: 'leeds-std', active: true }];
  assert.equal(lineTaxRefs('ts-std', {}, own).taxRateId, null, 'a verified own list still drops a foreign id');
});
