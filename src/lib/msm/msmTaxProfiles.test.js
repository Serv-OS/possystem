import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realProfiles, profileNamed, siteDefaultProfile, groupRunsOnProfiles, isProfileTax, profileChoices, profileChoiceOf, choiceToProfile, sitesMissingProfile, siteTaxCell, groupTaxCell, assembleProfilesByLoc } from './msmTaxProfiles.js';

// Mozz as it stood on 25 Nov 2026: three profiles at each of five sites, the same names, two rates.
const SITES = ['sandy', 'daybreak', 'provo', 'milk', 'wood'];
const sales = { sandy: 0.0745, daybreak: 0.0745, provo: 0.0745, milk: 0.0845, wood: 0.0845 };
const rows = () => {
  const profiles = [], lines = [], locations = [];
  for (const loc of SITES) {
    profiles.push({ id: `${loc}-food`, location_id: loc, name: 'Prepared food', active: true, generated_from_rate_id: null },
      { id: `${loc}-retail`, location_id: loc, name: 'Retail', active: true, generated_from_rate_id: null },
      { id: `${loc}-exempt`, location_id: loc, name: 'Tax exempt', active: true, generated_from_rate_id: null });
    lines.push({ id: `${loc}-l1`, profile_id: `${loc}-food`, name: 'Sales tax', line_type: 'rate', rate: sales[loc], mode: 'exclusive', order_types: ['all'], sort_order: 0, active: true },
      { id: `${loc}-l2`, profile_id: `${loc}-food`, name: 'Restaurant tax', line_type: 'rate', rate: 0.01, mode: 'exclusive', order_types: ['all'], sort_order: 1, active: true },
      { id: `${loc}-l3`, profile_id: `${loc}-retail`, name: 'Sales tax', line_type: 'rate', rate: sales[loc], mode: 'exclusive', order_types: ['all'], sort_order: 0, active: true },
      { id: `${loc}-l4`, profile_id: `${loc}-exempt`, name: 'Tax exempt', line_type: 'rate', rate: 0, mode: 'exclusive', order_types: ['all'], sort_order: 0, active: true });
    locations.push({ id: loc, default_tax_profile_id: `${loc}-food` });
  }
  return { profiles, lines, locations };
};
const mozz = () => { const r = rows(); return assembleProfilesByLoc(SITES, r.profiles, r.lines, r.locations); };

test('the rows are put together per site, with each site\'s default', () => {
  const by = mozz();
  assert.deepEqual(Object.keys(by), SITES);
  assert.equal(by.sandy.profiles.length, 3);
  assert.deepEqual(by.sandy.profiles[0].lines.map((l) => l.name), ['Sales tax', 'Restaurant tax']);
  assert.equal(siteDefaultProfile(by.milk).name, 'Prepared food');
  assert.equal(groupRunsOnProfiles(by, SITES), true);
  assert.equal(groupRunsOnProfiles({}, SITES), false);
});

test('the choices are the profile NAMES, with each site\'s own rates said', () => {
  const c = profileChoices(mozz(), SITES);
  assert.deepEqual(c.map((x) => x.name), ['Prepared food', 'Retail', 'Tax exempt']);
  assert.equal(c[0].label, 'Prepared food (8.45% at 3 sites, 9.45% at 2 sites)');
  assert.equal(c[1].label, 'Retail (7.45% at 3 sites, 8.45% at 2 sites)');
  assert.equal(c[2].label, 'Tax exempt (0%)');
  assert.equal(c[0].value, 'profile:Prepared food');
  assert.equal(choiceToProfile(c[1].value), 'Retail');
  assert.equal(choiceToProfile('VAT|20'), null);
  assert.equal(profileChoiceOf({ tax_rate_name: ' Retail ', tax_rate_percent: null }), 'profile:Retail');
  assert.equal(profileChoiceOf({ tax_rate_name: 'VAT', tax_rate_percent: 20 }), '');
});

test('a profile only some sites have says so, and those without it are named', () => {
  const by = mozz();
  by.provo.profiles = by.provo.profiles.filter((p) => p.name !== 'Retail');
  const retail = profileChoices(by, SITES).find((x) => x.name === 'Retail');
  assert.equal(retail.label, 'Retail (7.45% at 2 sites, 8.45% at 2 sites) (at 4 of 5 sites)');
  assert.deepEqual(sitesMissingProfile('retail', by, SITES), ['provo']);
  assert.deepEqual(sitesMissingProfile('Prepared food', by, SITES), []);
  assert.deepEqual(sitesMissingProfile('', by, SITES), []);
  // A site that was not read is never called missing.
  assert.deepEqual(sitesMissingProfile('Retail', { sandy: by.sandy }, SITES), []);
});

test('a generated copy of a rate, a switched off profile and two of one name are never a choice', () => {
  const by = mozz();
  by.sandy.profiles.push({ id: 'mirror', location_id: 'sandy', name: 'Sales tax', active: true, generated_from_rate_id: 'r1', lines: [] },
    { id: 'off', location_id: 'sandy', name: 'Old', active: false, generated_from_rate_id: null, lines: [] },
    { id: 'dup', location_id: 'sandy', name: 'retail', active: true, generated_from_rate_id: null, lines: [] });
  assert.deepEqual(realProfiles(by.sandy).map((p) => p.id), ['sandy-food', 'sandy-retail', 'sandy-exempt', 'dup']);
  assert.equal(profileNamed(by.sandy, 'Retail'), null, 'two of one name: nothing is guessed');
  assert.equal(profileNamed(by.sandy, 'Sales tax'), null);
  const names = profileChoices({ sandy: by.sandy }, ['sandy']).map((x) => x.name);
  assert.deepEqual(names, ['Prepared food', 'Tax exempt']);
});

test('the Tax view: a product with no tax shows each site\'s own default profile and its rate', () => {
  const by = mozz();
  const pizza = { name: 'Cheese', tax_rate_name: null, tax_rate_percent: null };
  assert.deepEqual(siteTaxCell(pizza, 'sandy', by), { words: 'Prepared food 8.45%', named: false, missing: false });
  assert.deepEqual(siteTaxCell(pizza, 'milk', by), { words: 'Prepared food 9.45%', named: false, missing: false });
  assert.deepEqual(groupTaxCell(pizza, by, SITES), { words: "Each site's own", named: false });
});

test('the Tax view: a product that names a profile shows that site\'s own one, or says it is missing', () => {
  const by = mozz();
  const shirt = { name: 'Tee', tax_rate_name: 'retail', tax_rate_percent: null };
  assert.equal(isProfileTax(shirt), true);
  assert.deepEqual(siteTaxCell(shirt, 'sandy', by), { words: 'Retail 7.45%', named: true, missing: false });
  assert.deepEqual(siteTaxCell(shirt, 'wood', by), { words: 'Retail 8.45%', named: true, missing: false });
  assert.deepEqual(groupTaxCell(shirt, by, SITES), { words: 'retail profile', named: true });
  by.provo.profiles = by.provo.profiles.filter((p) => p.name !== 'Retail');
  assert.deepEqual(siteTaxCell(shirt, 'provo', by), { words: 'No "retail" profile here', named: true, missing: true });
});

test('a UK product on a rate, and a site with no real default profile, are left to the old cell', () => {
  const by = mozz();
  const latte = { name: 'Latte', tax_rate_name: 'VAT', tax_rate_percent: 20 };
  assert.equal(isProfileTax(latte), false);
  assert.equal(siteTaxCell(latte, 'sandy', by), null);
  assert.equal(groupTaxCell(latte, by, SITES), null);
  const uk = { leeds: { profiles: [{ id: 'm', name: 'Standard', active: true, generated_from_rate_id: 'r' }], defaultProfileId: 'm' } };
  assert.equal(siteTaxCell({ tax_rate_name: null, tax_rate_percent: null }, 'leeds', uk), null);
  assert.equal(groupTaxCell({ tax_rate_name: null, tax_rate_percent: null }, uk, ['leeds']), null);
  assert.equal(siteTaxCell({ tax_rate_name: null, tax_rate_percent: null }, 'not-read', by), null);
});
