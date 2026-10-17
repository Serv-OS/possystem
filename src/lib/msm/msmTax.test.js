// Multi site menu ROUND 2: VAT per order type (supabase/functions/_shared/msmTax.js) and the one time
// option group refresh (msmImport.refreshGroupsPayload).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapRateDescriptor, importTaxByType, isMirrorProfile, venueProfileIsMirror, cleanTaxByType, zeroKind } from '../../../supabase/functions/_shared/msmTax.js';
import { isLegacyMirror } from '../taxCompute.js';
import { assembleTaxProfiles, mapTaxRateRow } from '../../../supabase/functions/_shared/venueMenuCore.js';
import { proposeImport, buildCentral, refreshGroupsPayload, touchEverything } from '../../../supabase/functions/_shared/msmImport.js';
import { planSite, touchedFromChanges } from '../../../supabase/functions/_shared/msmPlan.js';
import { MIRROR_CASES, MIRROR_RATE_ID } from './msmMirrorFixtures.js';
import { idGen } from './msmFixture.js';
import { groupSites, ZERO, VAT } from './msmGroupFixture.js';

test('a rate maps by name and percent, then the only rate at that percent, then the 0% kind; never a foreign id', () => {
  const rates = [{ id: 'v', name: 'VAT', rate: 20 }, { id: 'z', name: 'Zero Rate', rate: 0 }, { id: 'e', name: 'Exempt', rate: 0 }];
  assert.deepEqual(mapRateDescriptor({ name: 'VAT', percent: 20 }, rates), { id: 'v', ok: true });
  assert.deepEqual(mapRateDescriptor({ name: 'Standard Rate', percent: 20 }, rates), { id: 'v', ok: true }, 'the only 20%');
  assert.deepEqual(mapRateDescriptor({ name: 'Zero rated', percent: 0 }, rates), { id: 'z', ok: true }, 'two 0% rates: the same kind');
  assert.deepEqual(mapRateDescriptor({ name: 'VAT exempt', percent: 0 }, rates), { id: 'e', ok: true });
  assert.deepEqual(mapRateDescriptor({ name: 'Reduced', percent: 5 }, rates), { id: null, ok: false });
  assert.equal(zeroKind('Outside the scope of VAT'), 'outside');
});

test('VAT by order type keeps only the four keys, each a name and percent', () => {
  assert.deepEqual(cleanTaxByType({ takeaway: { name: 'Zero', percent: 0 }, counter: { name: 'X', percent: 1 }, 'drive-thru': { name: 'Y', percent: 0 } }), { takeaway: { name: 'Zero', percent: 0 } });
  assert.equal(cleanTaxByType({}), null);
});

test('import: the group value is the most common rate; no key and an explicit null count as "same as the product"', () => {
  const rates = { a: [{ id: 'za', name: 'Zero Rate', rate: 0 }], b: [{ id: 'zb', name: 'Zero Rate', rate: 0 }], c: [{ id: 'zc', name: 'Zero Rate', rate: 0 }] };
  const members = [
    { loc: 'a', row: { tax_overrides: { takeaway: 'za' } } },
    { loc: 'b', row: { tax_overrides: { takeaway: null } } },
    { loc: 'c', row: { tax_overrides: { takeaway: 'zc', counter: 'zc' } } },
  ];
  const r = importTaxByType(members, (l) => rates[l], 'a');
  assert.deepEqual(r.taxByType, { takeaway: { name: 'Zero Rate', percent: 0 } });
  assert.deepEqual(r.kept.get('b'), { takeaway: null }, 'the explicit null is kept, never turned into "missing"');
  assert.deepEqual(r.kept.get('c'), { counter: 'zc' }, 'its other keys are kept as they are');
  assert.equal(r.kept.has('a'), false);
});

test('THE MIRROR CHECK: the planner, the till\'s engine and the database read one fixture list the same way', () => {
  for (const c of MIRROR_CASES) {
    const prof = { ...c.profile, id: 'p1' };
    const lines = c.lines.map((l, i) => ({ ...l, id: `l${i}`, profile_id: 'p1', location_id: prof.location_id, sort_order: i }));
    const planner = isMirrorProfile(prof, lines, c.rate);
    const assembled = assembleTaxProfiles([prof], lines)[0];
    const engine = isLegacyMirror(assembled, { [c.rate.id]: mapTaxRateRow(c.rate) });
    assert.equal(planner, engine, `${c.name}: the planner and the engine agree`);
    const publish = venueProfileIsMirror({ taxProfiles: [prof], taxProfileLines: lines, taxRates: c.rate.active === false ? [] : [c.rate] }, 'p1', c.itemRate);
    assert.equal(publish, c.expect, `${c.name}: publish clears it only when expected`);
    if (c.itemRate === MIRROR_RATE_ID) assert.equal(planner, c.expect, `${c.name}`);
  }
});

test('profiles that cannot be read: "cannot tell" (null), so publish blocks instead of guessing', () => {
  assert.equal(venueProfileIsMirror({ taxProfiles: null, taxProfileLines: null, taxRates: [] }, 'p', 'r'), null);
});

// ── The one time refresh ────────────────────────────────────────────────────

// A group menu as round 1 imported it: groups as a jsonb list (options with central productId),
// no nested groups, no option rows, no VAT by order type, no kept group rules.
function roundOneCentral(sites) {
  const { central } = buildCentral(proposeImport(sites, { idGen: idGen() }), sites, {}, { idGen: idGen('g') });
  const nested = new Set(central.options.filter((o) => o.sub_group_id).map((o) => o.sub_group_id));
  const groups = central.groups.filter((g) => !nested.has(g.id)).map((g) => ({
    ...g, archived: false,
    options: central.options.filter((o) => o.group_id === g.id).map((o) => ({ id: central.optionSites.find((s) => s.option_id === o.id && s.venue_option_id)?.venue_option_id, name: o.name, price: o.price, ...(o.product_id ? { productId: o.product_id } : {}) })),
  }));
  return {
    ...central,
    menu: { id: '99999999-0000-4000-8000-000000000002', name: 'Group menu', refreshed_at: null },
    groups,
    groupSites: central.groupSites.filter((r) => !nested.has(r.group_id)).map((r) => ({ ...r, kept: {} })),
    options: [], optionSites: [],
    products: central.products.map((p) => ({ ...p, tax_by_type: null })),
    productSites: central.productSites.map((ps) => { const k = { ...ps.kept }; delete k.tax_overrides; return { ...ps, kept: k }; }),
  };
}

test('the refresh brings the groups in as rows (and the groups they ask next), keeps every site\'s own, proves zero writes', () => {
  const sites = groupSites();
  const old = roundOneCentral(sites);
  const r = refreshGroupsPayload(old, sites, { idGen: idGen('r') });
  assert.equal(r.ok, true, r.words);
  assert.equal(r.check.writes, 0);
  const names = r.payload.groups.map((g) => g.name).sort();
  assert.deepEqual(names, ['Milk', 'Tea choice', 'Which syrup'], 'the Then ask group comes in');
  for (const g of old.groups) assert.ok(r.payload.groups.some((x) => x.id === g.id), 'groups already in the group menu keep their ids');
  const tea = r.payload.groups.find((g) => g.name === 'Tea choice');
  assert.deepEqual(tea.sites.find((s) => s.location_id === groupSites()[1].location_id).kept, { max: 2 });
  assert.ok(r.payload.options.length >= 6);
  const donut = r.payload.products.find((p) => old.products.find((x) => x.id === p.id)?.name === 'Donut');
  assert.deepEqual(donut.tax_by_type, { takeaway: { name: 'Zero Rate', percent: 0 } });
  assert.match(r.words, /Nothing changes at any site/);
  // The proof, again from the payload as the database will hold it.
  const next = {
    ...old, menu: { ...old.menu, refreshed_at: 'now' },
    groups: r.payload.groups.map((g) => ({ ...g, options: [], archived: false })),
    groupSites: r.payload.groups.flatMap((g) => g.sites.map((s) => ({ group_id: g.id, ...s }))),
    options: r.payload.options.map((o) => { const copy = { ...o }; delete copy.sites; return copy; }),
    optionSites: r.payload.options.flatMap((o) => o.sites.map((s) => ({ option_id: o.id, ...s }))),
    products: old.products.map((p) => ({ ...p, tax_by_type: r.payload.products.find((x) => x.id === p.id)?.tax_by_type ?? null })),
    productSites: old.productSites.map((ps) => ({ ...ps, kept: { ...ps.kept, ...(r.payload.products.find((x) => x.id === ps.product_id)?.sites.find((s) => s.location_id === ps.location_id)?.kept || {}) } })),
  };
  const touched = touchedFromChanges(touchEverything(next));
  for (const s of sites) assert.equal(planSite({ central: next, touched, locationId: s.location_id, venue: s.raw }).lines.length, 0, s.name);
});

test('the refresh refuses when a site could not be read (nothing saved)', () => {
  const sites = groupSites();
  const old = roundOneCentral(sites);
  const r = refreshGroupsPayload(old, sites.slice(0, 2));
  assert.equal(r.ok, false);
  assert.match(r.words, /Could not read every site/);
});

test('the B site\'s VAT of its own survives the refresh as kept', () => {
  const sites = groupSites();
  const r = refreshGroupsPayload(roundOneCentral(sites), sites, { idGen: idGen('r') });
  const B = sites[1].location_id;
  const anyKept = r.payload.products.flatMap((p) => p.sites).find((s) => s.location_id === B && s.kept.tax_overrides);
  assert.deepEqual(anyKept.kept.tax_overrides, { takeaway: false, counter: VAT.B, 'drive-thru': null });
  assert.ok(ZERO.B);
});
