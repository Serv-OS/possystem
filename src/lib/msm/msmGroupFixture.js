// src/lib/msm/msmGroupFixture.js: the round 2 fixture for the Multi site menu tests (option groups,
// sub items, VAT per order type). Built on msmFixture.js's three made up sites; no real names,
// prices or takings (the repo is public). Shaped like the live estate (read 17 Oct 2026):
//   * Milk at three sites, three different option sets: A has Oat 0.40 and Coconut 0.50; B has
//     Oat 0.40 and Coconut at 0.00 (its own price); C has Oat only (Coconut off there).
//   * A Syrup option at A that asks a "Which syrup" group next (Then ask).
//   * "Tea choice" with a different "up to" at B (a rule B keeps).
//   * VAT by order type: the Donut takes Zero Rate for takeaway at A and C; B has a counter key and
//     an explicit null for drive thru of its own.
//   * A tax profile at A that is a generated copy of VAT 20% on the Cola.

import { A, B, C, sfx, venues } from './msmFixture.js';

export const S = (base, loc) => `${base}_${sfx(loc)}`;
export const ZERO = { A: 'tz-a', B: 'tz-b', C: 'tz-c' };
export const VAT = { A: 'tr-a', B: 'tr-b', C: 'tr-c' };
export const PROFILE_A = 'pf-cola-a';

const sub = (loc, id, name, price, extra = {}) => ({
  id, location_id: loc, name, menu_name: name, receipt_name: name, kitchen_name: name, description: '', type: 'subitem',
  cat: null, cats: [], parent_id: null, sort_order: 0, pricing: { base: price }, allergens: [], assigned_modifier_groups: [],
  visibility: { pos: false, kiosk: false, online: false, onlineDelivery: false }, sold_alone: false, archived: false,
  tax_rate_id: null, image: null, scope: 'shared', org_id: null, master_id: null, tags: [], item_code: null, centre_id: null,
  tax_overrides: {}, tax_profile_id: null, ...extra,
});

export function groupVenues() {
  const v = venues();
  const a = v[A], b = v[B], c = v[C];
  for (const [x, loc, key] of [[a, A, 'A'], [b, B, 'B'], [c, C, 'C']]) {
    x.taxRates.push({ id: ZERO[key], location_id: loc, name: 'Zero Rate', rate: 0, active: true });
    for (const i of x.items) { i.tax_overrides = i.tax_overrides || {}; i.tax_profile_id = i.tax_profile_id || null; }
  }
  // Sub items: Coconut milk everywhere it is offered; vanilla and caramel syrups at A.
  a.items.push(sub(A, 'm-coco', 'Coconut milk', 0.5, { cat: 'cat-milk' }));
  b.items.push(sub(B, S('m-coco', B), 'Coconut milk', 0.5, { cat: S('cat-milk', B), master_id: 'm-coco' }));
  a.items.push(sub(A, 'm-van', 'Vanilla', 0.3), sub(A, 'm-car', 'Caramel', 0.3));
  // Milk, three shapes.
  a.groups[0].options = [
    { id: 'opt-oat', name: 'Oat milk', price: 0.4, itemId: 'm-oat' },
    { id: 'opt-coco', name: 'Coconut milk', price: 0.5, itemId: 'm-coco' },
    { id: 'opt-syrup', name: 'Syrup', price: 0, subGroupId: 'mgd-syrup' },
  ];
  b.groups[0].options = [
    { id: 'opt-oat', name: 'Oat milk', price: 0.4, itemId: S('m-oat', B) },
    { id: 'opt-coco', name: 'Coconut milk', price: 0, itemId: S('m-coco', B) },
  ];
  c.items.push(sub(C, S('m-oat', C), 'Oat milk', 0.4, { master_id: 'm-oat', cat: S('cat-hot', C) }));
  c.groups.push({ id: S('mgd-milk', C), location_id: C, name: 'Milk', min: 0, max: 1, selection_type: 'single', sort_order: 0, options: [{ id: 'opt-oat', name: 'Oat milk', price: 0.4, itemId: S('m-oat', C) }] });
  c.items.find((i) => i.id === S('m-latte', C)).assigned_modifier_groups = [{ groupId: S('mgd-milk', C) }];
  // Then ask at A.
  a.groups.push({ id: 'mgd-syrup', location_id: A, name: 'Which syrup', min: 1, max: 1, selection_type: 'single', sort_order: 1, options: [
    { id: 'opt-van', name: 'Vanilla', price: 0.3, itemId: 'm-van' }, { id: 'opt-car', name: 'Caramel', price: 0.3, itemId: 'm-car' },
  ] });
  // Tea choice: up to 1 at A and C, up to 2 at B (kept by B).
  a.groups.push({ id: 'mgd-tea', location_id: A, name: 'Tea choice', min: 0, max: 1, selection_type: 'single', sort_order: 2, options: [{ id: 'opt-earl', name: 'Earl grey', price: 0 }] });
  b.groups.push({ id: S('mgd-tea', B), location_id: B, name: 'Tea choice', min: 0, max: 2, selection_type: 'single', sort_order: 2, options: [{ id: 'opt-earl', name: 'Earl grey', price: 0 }] });
  c.groups.push({ id: S('mgd-tea', C), location_id: C, name: 'Tea choice', min: 0, max: 1, selection_type: 'single', sort_order: 2, options: [{ id: 'opt-earl', name: 'Earl grey', price: 0 }] });
  a.items.find((i) => i.id === 'm-tea').assigned_modifier_groups = [{ groupId: 'mgd-tea' }];
  b.items.find((i) => i.id === S('m-tea', B)).assigned_modifier_groups = [{ groupId: S('mgd-tea', B) }];
  c.items.find((i) => i.id === S('m-tea', C)).assigned_modifier_groups = [{ groupId: S('mgd-tea', C) }];
  // VAT by order type on a Donut.
  const donut = (loc, id, extra) => ({ ...a.items.find((i) => i.id === 'm-cola'), id, location_id: loc, name: 'Donut', menu_name: 'Donut', receipt_name: 'Donut', kitchen_name: 'Donut', assigned_modifier_groups: [], ...extra });
  a.items.push(donut(A, 'm-donut', { cat: 'cat-cold', pricing: { base: 2 }, tax_rate_id: VAT.A, tax_overrides: { takeaway: ZERO.A }, master_id: null }));
  b.items.push(donut(B, S('m-donut', B), { cat: S('cat-cold', B), pricing: { base: 2 }, tax_rate_id: VAT.B, tax_overrides: { counter: VAT.B, 'drive-thru': null }, master_id: 'm-donut' }));
  c.items.push(donut(C, S('m-donut', C), { cat: S('cat-cold', C), pricing: { base: 2 }, tax_rate_id: VAT.C, tax_overrides: { takeaway: ZERO.C }, master_id: 'm-donut' }));
  // A generated copy of VAT 20% as the Cola's tax profile at A.
  a.taxProfiles = [{ id: PROFILE_A, location_id: A, name: 'VAT', rounding: { mode: 'half_up', level: 'invoice' }, active: true, sort_order: 0, generated_from_rate_id: VAT.A }];
  a.taxProfileLines = [{ id: 'pl-1', profile_id: PROFILE_A, location_id: A, name: 'VAT', line_type: 'rate', rate: 20, mode: 'exclusive', compound: false, taxable: false, tax_basis: 'post_discount', order_types: ['all'], active: true, tax_service_charge: null, tax_delivery_fee: null }];
  a.taxRates.find((r) => r.id === VAT.A).type = 'exclusive';
  a.items.find((i) => i.id === 'm-cola').tax_profile_id = PROFILE_A;
  return v;
}

export function groupSites(v = groupVenues()) {
  return [
    { location_id: A, name: 'Site A', venue_menu_id: 'menu-a', raw: v[A] },
    { location_id: B, name: 'Site B', venue_menu_id: `menu-b_${sfx(B)}`, raw: v[B] },
    { location_id: C, name: 'Site C', venue_menu_id: `menu-c_${sfx(C)}`, raw: v[C] },
  ];
}
