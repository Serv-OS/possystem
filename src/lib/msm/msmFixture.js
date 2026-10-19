// src/lib/msm/msmFixture.js: a made up company shaped like a real multi site coffee chain, for
// the Multi site menu tests. No real names, prices or takings (the repo is public).
//
// Three sites. Site A holds the masters. It has what the live estate has (read 17 Oct 2026):
//   * shared families: master `m-latte` at A, copies `m-latte_<8 of B>` and `m-latte_<8 of C>`
//   * a master DEMOTED to local whose copies still carry the suffix (`m-mocha`, copy master_id null)
//   * a row whose master_id is its own id (`m-tea`)
//   * a copy with NO category (cat null, cats {}) at B (removed from the menu by hand)
//   * a copy archived at C only
//   * a copy in a DIFFERENT category at C
//   * a different price at B and C for the same product, and a size of a product
//   * a sub item used only as an option (oat milk) in a modifier group
//   * a product only at C, an archived product only at B, and a same name product at A and B
//     that is not in a family (matched by name only)
//   * a lunch menu tier price at A (pricing.menus), venue owned

export const A = 'aaaaaaaa-0000-4000-8000-0000000a0001';
export const B = 'bbbbbbbb-0000-4000-8000-0000000b0002';
export const C = 'cccccccc-0000-4000-8000-0000000c0003';
export const sfx = (l) => l.slice(-8);
export const ORG = 'oooooooo-0000-4000-8000-00000000000o'.replace(/o/g, '0');

const rate = (loc, id, name = 'VAT', r = 20) => ({ id, location_id: loc, name, rate: r, active: true });
const cat = (loc, id, label, extra = {}) => ({ id, location_id: loc, menu_id: extra.menu_id, parent_id: null, label, icon: '☕', color: '#3b82f6', accounting_group: '', sort_order: 0, default_course: 1, image: null, master_id: null, ...extra });
const item = (loc, id, name, extra = {}) => ({
  id, location_id: loc, name, menu_name: name, receipt_name: name, kitchen_name: name, description: '', type: 'simple',
  cat: null, cats: [], parent_id: null, sort_order: 0, pricing: { base: 3, dineIn: null, takeaway: null, collection: null, delivery: null, driveThru: null },
  allergens: [], assigned_modifier_groups: [], visibility: { pos: true, kiosk: true, online: true, onlineDelivery: true },
  sold_alone: true, archived: false, tax_rate_id: null, image: null, scope: 'shared', org_id: null, master_id: null,
  tags: [], item_code: null, centre_id: null, updated_at: '2026-10-01T10:00:00.000+00:00', ...extra,
});

export function venues() {
  const mA = 'menu-a', mB = `menu-b_${sfx(B)}`, mC = `menu-c_${sfx(C)}`;
  const vA = 'tr-a', vB = 'tr-b', vC = 'tr-c';
  const a = {
    locationId: A,
    menus: [{ id: mA, location_id: A, name: 'Main', description: '', is_default: true, is_active: true, sort_order: 0, updated_at: '2026-10-01T10:00:00+00:00' }],
    categories: [
      cat(A, 'cat-hot', 'Hot drinks', { menu_id: mA, sort_order: 1 }),
      cat(A, 'cat-cold', 'Cold drinks', { menu_id: mA, sort_order: 2 }),
      cat(A, 'cat-milk', 'Milks', { menu_id: mA, sort_order: 9 }),
    ],
    items: [
      item(A, 'm-latte', 'Latte', { cat: 'cat-hot', pricing: { base: 3, menus: { [mA]: { base: 2.5 } } }, tax_rate_id: vA, assigned_modifier_groups: [{ groupId: 'mgd-milk' }] }),
      item(A, 'm-latte-l', 'Large latte', { cat: 'cat-hot', parent_id: 'm-latte', pricing: { base: 3.5 }, tax_rate_id: vA }),
      item(A, 'm-mocha', 'Mocha', { cat: 'cat-hot', pricing: { base: 3.2 }, tax_rate_id: vA, scope: 'local' }),
      item(A, 'm-tea', 'Tea', { cat: 'cat-hot', pricing: { base: 2 }, tax_rate_id: vA, master_id: 'm-tea' }),
      item(A, 'm-cola', 'Cola', { cat: 'cat-cold', pricing: { base: 2.2 }, tax_rate_id: vA }),
      item(A, 'm-oat', 'Oat milk', { cat: 'cat-milk', type: 'subitem', sold_alone: false, pricing: { base: 0.4 }, tax_rate_id: vA }),
      item(A, 'l-cookie-a', 'Cookie', { cat: 'cat-cold', pricing: { base: 1.5 }, tax_rate_id: vA, scope: 'local' }),
    ],
    links: [{ menu_id: mA, category_id: 'cat-hot', sort_order: 1 }, { menu_id: mA, category_id: 'cat-cold', sort_order: 2 }, { menu_id: mA, category_id: 'cat-milk', sort_order: 9 }],
    groups: [{ id: 'mgd-milk', location_id: A, name: 'Milk', min: 0, max: 1, selection_type: 'single', sort_order: 0, options: [{ id: 'opt-oat', name: 'Oat milk', price: 0.4, itemId: 'm-oat' }] }],
    taxRates: [rate(A, vA)],
    printRouting: { id: 'pr-a', location_id: A, centres: [{ id: 'pc-k', name: 'Kitchen' }, { id: 'pc-b', name: 'Bar' }], routing: { 'pc-k': { assignedCategories: ['cat-hot'], excludedItems: [] }, 'pc-b': { assignedCategories: ['cat-cold'], excludedItems: [] } } },
    printers: [{ id: 'prn-1', location_id: A, name: 'Epson', connection: 'network', ip: '10.0.0.2', port: 9100, paper_width: 80, meta: { model: 'tm-m30', roles: ['kitchen'] } }],
    taxProfiles: [], taxProfileLines: [],
    location: { id: A, org_id: ORG, name: 'Site A', timezone: 'Europe/London', default_tax_profile_id: null },
  };
  const S = (base, loc) => `${base}_${sfx(loc)}`;
  const b = {
    locationId: B,
    menus: [{ id: mB, location_id: B, name: 'Main', description: '', is_default: true, is_active: true, sort_order: 0 }],
    categories: [
      cat(B, S('cat-hot', B), 'Hot drinks', { menu_id: mB, sort_order: 1, master_id: 'cat-hot' }),
      cat(B, S('cat-cold', B), 'Cold drinks', { menu_id: mB, sort_order: 2, master_id: 'cat-cold' }),
      cat(B, S('cat-milk', B), 'Milks', { menu_id: mB, sort_order: 9, master_id: 'cat-milk' }),
    ],
    items: [
      item(B, S('m-latte', B), 'Latte', { cat: S('cat-hot', B), pricing: { base: 3.2 }, tax_rate_id: vB, master_id: 'm-latte', assigned_modifier_groups: [{ groupId: S('mgd-milk', B) }] }),
      item(B, S('m-latte-l', B), 'Large latte', { cat: S('cat-hot', B), parent_id: S('m-latte', B), pricing: { base: 3.7 }, tax_rate_id: vB, master_id: 'm-latte-l' }),
      // the demoted master's copy: no master_id, suffix only
      item(B, S('m-mocha', B), 'Mocha', { cat: S('cat-hot', B), pricing: { base: 3.2 }, tax_rate_id: vB }),
      item(B, S('m-tea', B), 'Tea', { cat: null, cats: [], pricing: { base: 2 }, tax_rate_id: vB, master_id: 'm-tea' }),   // removed from the menu by hand
      item(B, S('m-cola', B), 'Cola', { cat: S('cat-cold', B), pricing: { base: 2.2 }, tax_rate_id: vB, master_id: 'm-cola' }),
      item(B, S('m-oat', B), 'Oat milk', { cat: S('cat-milk', B), type: 'subitem', sold_alone: false, pricing: { base: 0.4 }, tax_rate_id: vB, master_id: 'm-oat' }),
      item(B, 'l-cookie-b', 'Cookie', { cat: S('cat-cold', B), pricing: { base: 1.5 }, tax_rate_id: vB, scope: 'local' }),
      item(B, 'l-old-b', 'Old special', { cat: S('cat-hot', B), pricing: { base: 4 }, tax_rate_id: vB, archived: true, scope: 'local' }),
    ],
    links: [{ menu_id: mB, category_id: S('cat-hot', B), sort_order: 1 }, { menu_id: mB, category_id: S('cat-cold', B), sort_order: 2 }, { menu_id: mB, category_id: S('cat-milk', B), sort_order: 9 }],
    groups: [{ id: S('mgd-milk', B), location_id: B, name: 'Milk', min: 0, max: 1, selection_type: 'single', sort_order: 0, options: [{ id: 'opt-oat', name: 'Oat milk', price: 0.4, itemId: S('m-oat', B) }] }],
    taxRates: [rate(B, vB, 'Standard Rate', 20)],
    printRouting: { id: 'pr-b', location_id: B, centres: [{ id: 'pc-kb', name: 'Kitchen' }], routing: { 'pc-kb': { assignedCategories: [S('cat-hot', B), S('cat-cold', B)], excludedItems: [] } } },
    printers: [], taxProfiles: [], taxProfileLines: [],
    location: { id: B, org_id: ORG, name: 'Site B', timezone: 'Europe/London', default_tax_profile_id: null },
  };
  const c = {
    locationId: C,
    menus: [{ id: mC, location_id: C, name: 'Main', description: '', is_default: true, is_active: true, sort_order: 0 }],
    categories: [
      cat(C, S('cat-hot', C), 'Hot drinks', { menu_id: mC, sort_order: 1, master_id: 'cat-hot' }),
      cat(C, S('cat-cold', C), 'Cold drinks', { menu_id: mC, sort_order: 2, master_id: 'cat-cold' }),
      cat(C, 'cat-c-own', 'Specials', { menu_id: mC, sort_order: 3 }),
    ],
    items: [
      item(C, S('m-latte', C), 'Latte', { cat: S('cat-hot', C), pricing: { base: 3.2 }, tax_rate_id: vC, master_id: 'm-latte' }),
      item(C, S('m-mocha', C), 'Mocha', { cat: 'cat-c-own', pricing: { base: 3.2 }, tax_rate_id: vC }),     // in a different category here
      item(C, S('m-tea', C), 'Tea', { cat: S('cat-hot', C), pricing: { base: 2 }, tax_rate_id: vC, master_id: 'm-tea', archived: true }),   // off at C only
      item(C, S('m-cola', C), 'Cola', { cat: S('cat-cold', C), pricing: { base: 2.4 }, tax_rate_id: vC, master_id: 'm-cola' }),
      item(C, 'l-pie-c', 'Pie', { cat: 'cat-c-own', pricing: { base: 4.5 }, tax_rate_id: vC, scope: 'local' }),
    ],
    links: [{ menu_id: mC, category_id: S('cat-hot', C), sort_order: 1 }, { menu_id: mC, category_id: S('cat-cold', C), sort_order: 2 }, { menu_id: mC, category_id: 'cat-c-own', sort_order: 3 }],
    groups: [],
    taxRates: [rate(C, vC)],
    printRouting: null,
    printers: [], taxProfiles: [], taxProfileLines: [],
    location: { id: C, org_id: ORG, name: 'Site C', timezone: 'Europe/London', default_tax_profile_id: null },
  };
  return { [A]: a, [B]: b, [C]: c };
}

export function importSites(v = venues()) {
  return [
    { location_id: A, name: 'Site A', venue_menu_id: 'menu-a', raw: v[A] },
    { location_id: B, name: 'Site B', venue_menu_id: `menu-b_${sfx(B)}`, raw: v[B] },
    { location_id: C, name: 'Site C', venue_menu_id: `menu-c_${sfx(C)}`, raw: v[C] },
  ];
}

// Ids that read like uuids, one after another, for repeatable tests.
export function idGen(prefix = 'f') {
  let n = 0;
  return () => `${prefix}0000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
}
