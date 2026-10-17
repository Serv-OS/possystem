// Multi site menu: staging, the publish preview, drift and undo (supabase/functions/_shared/msmDiff.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyChanges, unapply, mergeStaged, previewSet, sitesReached, siteDrift, keepVenueChanges, undoChanges } from '../../../supabase/functions/_shared/msmDiff.js';
import { proposeImport, buildCentral } from '../../../supabase/functions/_shared/msmImport.js';
import { A, B, C, sfx, ORG, importSites, idGen, venues } from './msmFixture.js';

function setup() {
  const v = venues();
  const sites = importSites(v);
  const { central } = buildCentral(proposeImport(sites, { idGen: idGen() }), sites, {}, { idGen: idGen('g') });
  central.menu = { id: '99999999-0000-4000-8000-000000000001', name: 'Group menu', description: '', use_name_everywhere: false };
  return { v, central, P: (n) => central.products.find((p) => p.name === n) };
}

test('applyChanges mirrors the database: update, remove (archived), create, a new product at a site; unapply puts it back', () => {
  const { central, P } = setup();
  const ch = [
    { target: 'product', entity_id: P('Latte').id, op: 'update', after: { default_price: 3.5 } },
    { target: 'product', entity_id: P('Cola').id, op: 'remove', after: {} },
    { target: 'product', entity_id: 'new-1', op: 'create', after: { name: 'New' } },
    { target: 'product_site', entity_id: 'new-1', location_id: A, op: 'create', after: { venue_item_id: 'msm-x_a', active: true } },
    { target: 'product', entity_id: P('Tea').id, op: 'update', after: { id: 'hijack' } },   // not allowed: skipped
  ];
  const { central: after, before } = applyChanges(central, ch);
  assert.equal(after.products.find((p) => p.name === 'Latte').default_price, 3.5);
  assert.equal(after.products.find((p) => p.name === 'Cola').archived, true);
  assert.ok(after.products.some((p) => p.id === 'new-1'));
  assert.ok(after.productSites.some((s) => s.product_id === 'new-1' && s.location_id === A && s.price === null));
  assert.ok(!after.products.some((p) => p.id === 'hijack'));
  assert.equal(central.products.find((p) => p.name === 'Latte').default_price, 3.2, 'the input is never changed');
  assert.deepEqual(unapply(after, before), JSON.parse(JSON.stringify(central)));
});

test('staging: one row per target, entity and site, the FIRST before kept; set back to where it started and it goes', () => {
  const base = { target: 'product_site', entity_id: 'p', location_id: A, op: 'update' };
  const first = mergeStaged(null, { ...base, after: { price: 3.1 }, before: { price: 3 } });
  assert.equal(first.action, 'insert');
  const second = mergeStaged(first.row, { ...base, after: { price: 3.2 }, before: { price: 3.1 } });
  assert.equal(second.action, 'update');
  assert.deepEqual(second.row.after, { price: 3.2 });
  assert.deepEqual(second.row.before, { price: 3 }, 'the first before wins');
  const back = mergeStaged(second.row, { ...base, after: { price: 3 }, before: { price: 3.2 } });
  assert.equal(back.action, 'delete');
  assert.equal(mergeStaged(null, { ...base, after: { price: 3 }, before: { price: 3 } }).action, 'none');
  assert.equal(mergeStaged(null, { ...base, after: { nope: 1 } }).action, 'none');
});

test('the sites a set reaches: every site for a group change, else the sites it names', () => {
  const { central, P } = setup();
  assert.deepEqual(sitesReached(central, [{ target: 'product', entity_id: P('Latte').id, op: 'update', after: { name: 'L' } }]).sort(), [A, B, C].sort());
  assert.deepEqual(sitesReached(central, [{ target: 'product_site', entity_id: P('Latte').id, location_id: B, op: 'update', after: { price: 1 } }]), [B]);
});

test('the publish preview: counts and lines per site in words, health, and "changed at the venue" warnings', () => {
  const { v, central, P } = setup();
  v[B].items.find((i) => i.id === `m-cola_${sfx(B)}`).pricing.base = 2.6;     // changed by hand at B since the import
  const changes = [{ target: 'product', entity_id: P('Cola').id, op: 'update', after: { default_price: 2.3 }, before: { default_price: 2.2 } }];
  const pv = previewSet(central, changes, v, { orgId: ORG, siteNames: { [A]: 'Site A', [B]: 'Site B', [C]: 'Site C' } });
  const a = pv.sites.find((s) => s.location_id === A);
  const b = pv.sites.find((s) => s.location_id === B);
  const c = pv.sites.find((s) => s.location_id === C);
  assert.equal(a.words, '1 price');
  assert.equal(a.lines[0].words, 'Cola: 2.20 to 2.30');
  assert.equal(c.words, 'Nothing changes here', 'site C has its own 2.40');
  assert.equal(b.drift.length, 1);
  assert.match(b.drift[0].words, /Cola was set to 2\.60 at the venue after it was last published\. Publishing sets 2\.30\./);
  assert.ok(b.health.warnings.some((w) => w.code === 'changed_at_venue'));
  assert.equal(pv.ok, true);
});

test('drift: what a venue changed by hand, against central plus what it keeps; "Keep the venue\'s" stages it', () => {
  const { v, central, P } = setup();
  assert.deepEqual(siteDrift(central, C, v[C]), [], 'straight after import: nothing');
  v[C].items.find((i) => i.id === `m-cola_${sfx(C)}`).pricing.base = 2.5;
  v[C].items.find((i) => i.id === `m-cola_${sfx(C)}`).name = 'Cola!';
  v[C].items.find((i) => i.id === `m-mocha_${sfx(C)}`).cat = `cat-hot_${sfx(C)}`;     // differs from what C keeps
  const d = siteDrift(central, C, v[C]);
  assert.deepEqual(d.map((x) => x.column).sort(), ['cat', 'name', 'pricing.base']);
  const keep = keepVenueChanges(central, C, d);
  const cola = keep.find((k) => k.entity_id === P('Cola').id);
  assert.deepEqual(cola.after, { price: 2.5, kept: { name: 'Cola!' } });
  const mocha = keep.find((k) => k.entity_id === P('Mocha').id);
  assert.deepEqual(mocha.after.kept, { cat: `cat-hot_${sfx(C)}` });
});

test('undo: after back to before; a new product is turned off, never deleted; a value changed since is flagged', () => {
  const { central, P } = setup();
  const latte = P('Latte');
  const version = { changes: [
    { target: 'product', entity_id: latte.id, op: 'update', before: { default_price: 3.2 }, after: { default_price: 3.3 } },
    { target: 'product', entity_id: 'np', op: 'create', before: null, after: { name: 'New' } },
    { target: 'product_site', entity_id: 'np', location_id: A, op: 'create', before: null, after: { venue_item_id: 'x', active: true } },
    { target: 'menu_site', entity_id: 'm', location_id: 'D', op: 'create', before: null, after: {} },
  ] };
  central.products.find((p) => p.id === latte.id).default_price = 3.4;   // changed again since
  const u = undoChanges(version, central);
  assert.deepEqual(u.changes, [
    { target: 'product', entity_id: latte.id, location_id: null, op: 'update', after: { default_price: 3.2 } },
    { target: 'product', entity_id: 'np', location_id: null, op: 'update', after: { archived: true } },
    { target: 'product_site', entity_id: 'np', location_id: A, op: 'update', after: { active: false } },
  ]);
  assert.ok(u.warnings.some((w) => /default price is 3\.40 now; undo sets it to 3\.20/.test(w)));
  assert.ok(u.warnings.some((w) => /turns off 1 new product/.test(w)));
  assert.equal(u.skipped.length, 1);
});
