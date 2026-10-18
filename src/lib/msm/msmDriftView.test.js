// Multi site menu round 2, design 3.3: changes made at a site, in Review and publish, with Keep or
// Put back (src/lib/msm/msmDriftView.js), proved with the real planner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proposeImport, buildCentral } from '../../../supabase/functions/_shared/msmImport.js';
import { planSite, touchedFromChanges } from '../../../supabase/functions/_shared/msmPlan.js';
import { applyChanges, previewSet, siteDrift, mergeStaged } from '../../../supabase/functions/_shared/msmDiff.js';
import { checkChange } from '../../../supabase/functions/_shared/msmModel.js';
import { A, B, C, ORG, idGen } from './msmFixture.js';
import { groupVenues, groupSites, S } from './msmGroupFixture.js';
import { publishDrift, overwriteCounts, putBackChanges, keepChanges, driftWords, driftKey } from './msmDriftView.js';

function setup() {
  const v = groupVenues();
  const sites = groupSites(v);
  const central = buildCentral(proposeImport(sites, { idGen: idGen() }), sites, {}, { idGen: idGen('g') }).central;
  central.menu = { id: '99999999-0000-4000-8000-000000000001', name: 'Group menu', description: '', use_name_everywhere: false, refreshed_at: '2026-10-17' };
  const names = Object.fromEntries([...central.products.map((p) => [p.id, p.name]), ...central.groups.map((g) => [g.id, g.name])]);
  return { v, central, names, P: (n) => central.products.find((p) => p.name === n), G: (n) => central.groups.find((g) => g.name === n) };
}
const plan = (central, changes, loc, venue) => planSite({ central: applyChanges(central, changes).central, touched: touchedFromChanges(changes), locationId: loc, orgId: ORG, venue });

test('a price changed by hand at a site is said in words, with the site\'s name and no codes', () => {
  const { v, central, names, P } = setup();
  v[B].items.find((i) => i.id === S('m-cola', B)).pricing.base = 2.5;
  const d = siteDrift(central, B, v[B], names).find((x) => x.productId === P('Cola').id);
  assert.equal(driftWords(d, 'Leeds', names), 'Cola price 2.50 at Leeds (group menu says 2.20)');
  assert.doesNotMatch(driftWords(d, 'Leeds', names), /pricing|_|venue/);
});

test('Put the group\'s back: the next publish writes the group price at THAT site only', () => {
  const { v, central, names, P } = setup();
  v[B].items.find((i) => i.id === S('m-cola', B)).pricing.base = 2.5;
  const d = siteDrift(central, B, v[B], names).find((x) => x.productId === P('Cola').id);
  const ch = putBackChanges(central, B, d);
  assert.equal(ch.length, 1);
  assert.ok(checkChange(ch[0]).ok, checkChange(ch[0]).words);
  assert.equal(mergeStaged(null, ch[0]).action, 'insert', 'it really goes into the draft');
  const pb = plan(central, ch, B, v[B]);
  assert.deepEqual(pb.lines.map((l) => [l.column, l.before, l.after]), [['pricing.base', 2.5, 2.2]]);
  assert.deepEqual(plan(central, ch, A, v[A]).lines, [], 'nothing at site A');
});

test('Keep Leeds\'s: the site\'s price becomes its own, nothing is written, the line goes', () => {
  const { v, central, names, P } = setup();
  v[B].items.find((i) => i.id === S('m-cola', B)).pricing.base = 2.5;
  const d = siteDrift(central, B, v[B], names).find((x) => x.productId === P('Cola').id);
  const ch = keepChanges(central, B, d);
  const after = applyChanges(central, ch).central;
  assert.deepEqual(plan(central, ch, B, v[B]).lines, []);
  assert.equal(siteDrift(after, B, v[B], names).filter((x) => x.productId === P('Cola').id).length, 0);
});

test('a name and a kept value changed by hand: Put back uses the group\'s value at that site', () => {
  const { v, central, names, P } = setup();
  v[B].items.find((i) => i.id === S('m-cola', B)).menu_name = 'Cola can';
  const d = siteDrift(central, B, v[B], names).find((x) => x.productId === P('Cola').id && x.column === 'menu_name');
  assert.ok(d);
  assert.equal(driftWords(d, 'Leeds', names), 'Cola: menu name was changed at Leeds');
  const pb = plan(central, putBackChanges(central, B, d), B, v[B]);
  assert.deepEqual(pb.lines.map((l) => [l.column, l.after]), [['menu_name', 'Cola']]);
});

test('option groups: an option price, an option turned off, and a rule changed at a site', () => {
  const { v, central, names, G } = setup();
  const milkB = v[B].groups.find((g) => g.id === S('mgd-milk', B));
  milkB.options.find((o) => o.id === 'opt-oat').price = 0.6;
  const lines = siteDrift(central, B, v[B], names);
  const oat = lines.find((x) => x.kind === 'group' && x.column === 'option');
  assert.equal(driftWords(oat, 'Leeds', names), 'Milk: Oat milk 0.60 at Leeds (group menu says 0.40)');
  const ch = putBackChanges(central, B, oat);
  assert.ok(checkChange(ch[0]).ok);
  const pb = plan(central, ch, B, v[B]);
  assert.equal(pb.lines.length, 1);
  assert.deepEqual([pb.lines[0].column, pb.lines[0].after.price], ['option', 0.4]);
  // A rule changed at site C: put back clears nothing kept and writes the group's rule there only.
  v[C].groups.find((g) => g.id === S('mgd-tea', C)).max = 3;
  const rule = siteDrift(central, C, v[C], names).find((x) => x.kind === 'group' && x.column === 'max');
  assert.ok(rule);
  assert.match(driftWords(rule, 'Site C', names), /^Tea choice: choose up to 3 at Site C \(group menu says 1\)$/);
  const pr = plan(central, putBackChanges(central, C, rule), C, v[C]);
  assert.deepEqual(pr.lines.map((l) => [l.column, l.after]), [['max', 1]]);
  void G;
});

test('publishDrift: which lines THIS publish overwrites; settled lines need no tick', () => {
  const { v, central, names, P } = setup();
  v[B].items.find((i) => i.id === S('m-cola', B)).pricing.base = 2.5;
  v[B].items.find((i) => i.id === S('m-latte', B)).menu_name = 'Big latte';
  // The draft changes the Cola's group price: at B it would overwrite B's 2.50 only if B follows.
  const draft = [{ target: 'product', entity_id: P('Cola').id, location_id: null, op: 'update', after: { default_price: 2.3 }, before: { default_price: 2.2 } }];
  const preview = previewSet(central, draft, v, { orgId: ORG, siteNames: { [A]: 'Site A', [B]: 'Leeds', [C]: 'Site C' } });
  const after = applyChanges(central, draft).central;
  const drift = publishDrift(central, after, preview, v, { siteNames: { [B]: 'Leeds' }, names });
  const atB = drift.find((s) => s.location_id === B);
  assert.ok(atB);
  const cola = atB.lines.find((l) => l.d.productId === P('Cola').id);
  const latte = atB.lines.find((l) => l.d.productId === P('Latte').id);
  assert.equal(cola.overwritten, true, 'the draft touches the Cola price');
  assert.equal(latte.overwritten, false, 'nothing in the draft touches the Latte name');
  assert.deepEqual(overwriteCounts(drift), { [B]: 1 });
  assert.equal(drift.some((s2) => s2.location_id === A), false, 'the draft\'s own change is what the publish does, never drift');
  assert.equal(atB.lines.some((l) => /VAT/.test(l.words)), false, 'a site\'s kept VAT keys as they are are not drift');
  const settled = new Set([driftKey(B, cola.d)]);
  assert.deepEqual(overwriteCounts(publishDrift(central, after, preview, v, { siteNames: { [B]: 'Leeds' }, names, settled })), {});
});

test('a kept VAT key changed again at a site: one line for that key, and Keep stores that key only', () => {
  const { v, central, names, P } = setup();
  const donut = v[B].items.find((i) => i.id === S('m-donut', B));
  donut.tax_overrides = { ...donut.tax_overrides, 'drive-thru': 'tr-b' };
  const lines = siteDrift(central, B, v[B], names).filter((x) => x.productId === P('Donut').id);
  assert.deepEqual(lines.map((x) => x.column), ['tax_overrides.drive-thru']);
  const ch = keepChanges(central, B, lines[0]);
  assert.ok(checkChange(ch[0]).ok, checkChange(ch[0]).words);
  assert.equal(ch[0].after.kept.tax_overrides['drive-thru'], 'tr-b');
  assert.equal(ch[0].after.kept.tax_overrides.counter, 'tr-b', 'the other kept keys stay');
  assert.equal(siteDrift(applyChanges(central, ch).central, B, v[B], names).filter((x) => x.productId === P('Donut').id).length, 0);
});
