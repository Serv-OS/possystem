// src/lib/msm/msmDemo.js
//
// MULTI SITE MENU (17 Oct 2026, v5.11.75): demo mode only (no database: lib/supabase.js isMock).
// A made up four site coffee company, held in memory by the same stand in client the tests use
// (fakeClient, which enforces the 1,000 row cap), so every screen can be tried end to end: the
// first import, the grid, the product sheet and Change prices. No real names, prices or takings
// (the repo is public). Never loaded in production: the screen imports it only when isMock.

import { fakeClient } from './fakeClient.js';
import { createMsmData } from './msmData.js';

export const DEMO_ORG = 'org-demo';
const SITES = [
  { id: 'demo-site-0001-4000-8000-00000000a001', name: 'Market Street' },
  { id: 'demo-site-0002-4000-8000-00000000b002', name: 'Station' },
  { id: 'demo-site-0003-4000-8000-00000000c003', name: 'Riverside' },
  { id: 'demo-site-0004-4000-8000-00000000d004', name: 'Old Town' },
];
const sfx = (l) => l.slice(-8);
const S = (base, loc, i) => (i === 0 ? base : `${base}_${sfx(loc)}`);

const CATS = [
  { key: 'hot', label: 'Hot drinks', icon: '☕', color: '#8B5A2B' },
  { key: 'cold', label: 'Cold drinks', icon: '🧊', color: '#2563EB' },
  { key: 'food', label: 'Food', icon: '🥪', color: '#16A34A' },
  { key: 'bake', label: 'Bakery', icon: '🥐', color: '#D97706' },
  { key: 'milk', label: 'Milks and extras', icon: '🥛', color: '#64748B' },
];
const PRODUCTS = [
  ['hot', 'Espresso', 2.2], ['hot', 'Americano', 2.8], ['hot', 'Flat white', 3.3], ['hot', 'Latte', 3.4], ['hot', 'Cappuccino', 3.4],
  ['hot', 'Mocha', 3.7], ['hot', 'Hot chocolate', 3.5], ['hot', 'Chai latte', 3.6], ['hot', 'Tea', 2.4], ['hot', 'Green tea', 2.6],
  ['hot', 'Cortado', 3.0], ['hot', 'Macchiato', 2.6], ['hot', 'Babyccino', 0.9], ['hot', 'Turmeric latte', 3.8],
  ['cold', 'Iced latte', 3.7], ['cold', 'Iced americano', 3.1], ['cold', 'Cold brew', 3.6], ['cold', 'Orange juice', 2.9],
  ['cold', 'Apple juice', 2.9], ['cold', 'Sparkling water', 1.9], ['cold', 'Still water', 1.6], ['cold', 'Cola', 2.3],
  ['cold', 'Lemonade', 2.6], ['cold', 'Iced tea', 2.9], ['cold', 'Berry smoothie', 4.4], ['cold', 'Mango smoothie', 4.4],
  ['food', 'Bacon roll', 4.5], ['food', 'Sausage roll', 3.6], ['food', 'Ham and cheese toastie', 5.2], ['food', 'Cheese toastie', 4.6],
  ['food', 'Tuna melt', 5.6], ['food', 'Avocado toast', 6.5], ['food', 'Porridge', 3.9], ['food', 'Granola pot', 3.8],
  ['food', 'Soup of the day', 4.9], ['food', 'Chicken wrap', 5.9], ['food', 'Falafel wrap', 5.7], ['food', 'Egg muffin', 4.2],
  ['bake', 'Croissant', 2.6], ['bake', 'Pain au chocolat', 2.9], ['bake', 'Almond croissant', 3.4], ['bake', 'Cinnamon bun', 3.3],
  ['bake', 'Blueberry muffin', 2.9], ['bake', 'Banana bread', 3.1], ['bake', 'Brownie', 3.0], ['bake', 'Flapjack', 2.7],
  ['bake', 'Carrot cake', 3.9], ['bake', 'Lemon drizzle', 3.6], ['bake', 'Cookie', 2.2], ['bake', 'Scone', 2.8],
  ['milk', 'Oat milk', 0.4], ['milk', 'Soya milk', 0.4], ['milk', 'Almond milk', 0.45], ['milk', 'Extra shot', 0.6],
  ['milk', 'Vanilla syrup', 0.5], ['milk', 'Caramel syrup', 0.5], ['milk', 'Hazelnut syrup', 0.5], ['milk', 'Whipped cream', 0.6],
];
// Site 2 (Station) charges 20p more on drinks; site 3 (Riverside) is a little cheaper on food.
const priceAt = (catKey, base, i) => {
  if (i === 1 && (catKey === 'hot' || catKey === 'cold')) return Math.round((base + 0.2) * 100) / 100;
  if (i === 2 && catKey === 'food') return Math.round((base - 0.3) * 100) / 100;
  return base;
};
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

function venueTables() {
  const t = { locations: [], menus: [], menu_categories: [], menu_items: [], modifier_groups: [], tax_rates: [], print_routing: [], printers: [], menu_category_links: [], tax_profiles: [], tax_profile_lines: [] };
  SITES.forEach((site, i) => {
    const loc = site.id;
    t.locations.push({ id: loc, org_id: DEMO_ORG, name: site.name, timezone: 'Europe/London', default_tax_profile_id: null });
    const menuId = S('dm-menu', loc, i);
    t.menus.push({ id: menuId, location_id: loc, name: 'All day', description: '', is_default: true, is_active: true, sort_order: 0, updated_at: '2026-10-01T10:00:00+00:00' });
    const vat = `dm-vat-${i}`;
    t.tax_rates.push({ id: vat, location_id: loc, name: 'Standard rate', rate: 20, active: true });
    CATS.forEach((c, ci) => {
      t.menu_categories.push({ id: S(`dm-cat-${c.key}`, loc, i), location_id: loc, menu_id: menuId, parent_id: null, label: c.label, icon: c.icon, color: c.color, accounting_group: '', sort_order: ci + 1, default_course: 1, image: null, master_id: i === 0 ? null : `dm-cat-${c.key}` });
      t.menu_category_links.push({ menu_id: menuId, category_id: S(`dm-cat-${c.key}`, loc, i), sort_order: ci + 1 });
    });
    t.print_routing.push({ id: `dm-pr-${i}`, location_id: loc, centres: [{ id: 'k', name: 'Kitchen' }, { id: 'b', name: 'Bar' }], routing: { k: { assignedCategories: [S('dm-cat-food', loc, i), S('dm-cat-bake', loc, i)], excludedItems: [] }, b: { assignedCategories: [S('dm-cat-hot', loc, i), S('dm-cat-cold', loc, i)], excludedItems: [] } } });
    PRODUCTS.forEach(([ck, name, base], pi) => {
      // Old Town (site 4) does not sell smoothies or the turmeric latte.
      if (i === 3 && (/smoothie/i.test(name) || name === 'Turmeric latte')) return;
      const id = S(`dm-${slug(name)}`, loc, i);
      t.menu_items.push({
        id, location_id: loc, name, menu_name: name, receipt_name: name, kitchen_name: name, description: '', type: ck === 'milk' ? 'subitem' : 'simple',
        cat: S(`dm-cat-${ck}`, loc, i), cats: [], parent_id: null, sort_order: pi,
        pricing: { base: priceAt(ck, base, i), dineIn: null, takeaway: null, collection: null, delivery: null, driveThru: null },
        allergens: ck === 'bake' ? ['gluten', 'eggs', 'milk'] : (ck === 'hot' && name !== 'Tea' && name !== 'Green tea' && name !== 'Espresso' && name !== 'Americano') ? ['milk'] : [],
        assigned_modifier_groups: [], visibility: { pos: true, kiosk: true, online: true, onlineDelivery: true }, sold_alone: ck !== 'milk',
        archived: i === 2 && name === 'Babyccino', tax_rate_id: vat, image: null, scope: i === 0 ? 'shared' : 'shared', org_id: DEMO_ORG,
        master_id: i === 0 ? null : `dm-${slug(name)}`, tags: [], item_code: null, centre_id: null, updated_at: '2026-10-01T10:00:00+00:00',
      });
    });
  });
  // Each site's own extras.
  const own = [[1, 'dm-station-meal-deal', 'Station meal deal', 'food', 6.5], [1, 'dm-station-porter-coffee', 'Commuter coffee', 'hot', 2.5],
    [2, 'dm-riverside-ice-cream', 'Ice cream tub', 'cold', 3.2], [3, 'dm-oldtown-afternoon-tea', 'Afternoon tea', 'bake', 14.5], [3, 'dm-oldtown-old-special', 'Old special', 'food', 7, true]];
  for (const [i, id, name, ck, price, archived] of own) {
    const loc = SITES[i].id;
    t.menu_items.push({
      id, location_id: loc, name, menu_name: name, receipt_name: name, kitchen_name: name, description: '', type: 'simple', cat: S(`dm-cat-${ck}`, loc, i), cats: [], parent_id: null,
      sort_order: 900, pricing: { base: price }, allergens: [], assigned_modifier_groups: [], visibility: { pos: true, kiosk: true, online: true, onlineDelivery: true },
      sold_alone: true, archived: !!archived, tax_rate_id: `dm-vat-${i}`, image: null, scope: 'local', org_id: DEMO_ORG, master_id: null, tags: [], item_code: null, centre_id: null,
    });
  }
  return t;
}

// The demo's msm_import_commit: the central tables from the payload, in memory.
function importCommit({ p_payload: p }, db) {
  if ((db.msm_menus || []).some((m) => m.org_id === p.org_id && m.status === 'live')) return { data: null, error: { message: 'This company already has a group menu.' } };
  const menuId = 'dddddddd-1111-4000-8000-000000000001';
  const now = new Date().toISOString();
  const noSites = (x) => { const c = { ...x }; delete c.sites; return c; };
  db.msm_menus = [{ id: menuId, org_id: p.org_id, name: p.menu.name, description: p.menu.description || '', use_name_everywhere: false, status: 'live', created_at: now, updated_at: now, last_version_no: 1, last_published_at: now, last_published_by: 'You (demo)' }];
  db.msm_menu_sites = p.sites.map((s) => ({ menu_id: menuId, location_id: s.location_id, venue_menu_id: s.venue_menu_id, joined_at: now }));
  db.msm_categories = p.categories.map((c) => ({ ...noSites(c), menu_id: menuId, archived: false }));
  db.msm_category_sites = p.categories.flatMap((c) => c.sites.map((s) => ({ category_id: c.id, ...s })));
  db.msm_modifier_groups = p.groups.map((g) => ({ ...noSites(g), menu_id: menuId }));
  db.msm_modifier_group_sites = p.groups.flatMap((g) => g.sites.map((s) => ({ group_id: g.id, ...s })));
  db.msm_products = p.products.map((x) => ({ ...noSites(x), menu_id: menuId, archived: false }));
  db.msm_product_sites = p.products.flatMap((x) => x.sites.map((s) => ({ product_id: x.id, ...s })));
  db.msm_versions = [{ id: 'dddddddd-2222-4000-8000-000000000001', menu_id: menuId, org_id: p.org_id, version_no: 1, kind: 'import', title: 'Import', status: 'done', created_by_name: 'You (demo)', created_at: now, changes: [] }];
  return { data: { ok: true, menu_id: menuId, products: db.msm_products.length, categories: db.msm_categories.length, sites: db.msm_menu_sites.length, words: 'Version 1: imported. 0 changes at 0 sites.' }, error: null };
}

let demo = null;
/** The demo data layer (one per page load), plus helpers the screens use in demo mode. */
export function demoMsm() {
  if (demo) return demo;
  const tables = { ...venueTables(), msm_menus: [], msm_menu_sites: [], msm_categories: [], msm_category_sites: [], msm_modifier_groups: [], msm_modifier_group_sites: [], msm_products: [], msm_product_sites: [], msm_site_groups: [], msm_change_sets: [], msm_changes: [], msm_versions: [], msm_version_sites: [] };
  const client = fakeClient(tables, {
    stamp: true,
    defaults: { msm_change_sets: { status: 'draft', kind: 'edit', lead_minutes: 5, apply_when_idle: true, run_local: null, version_id: null } },
    rpcs: {
      msm_my_access: () => ({ data: { companies: [{ org_id: DEMO_ORG, org_name: 'Demo company', enabled: true, role: 'editor' }] }, error: null }),
      msm_import_commit: importCommit,
    },
  });
  const api = createMsmData({ client, report: () => {} });
  const sites = () => client.db.locations.map((l) => ({ id: l.id, name: l.name, timezone: l.timezone }));
  // Made up plate costs for a few products, so the GP view has something to show.
  const costs = (loc) => {
    const m = new Map();
    for (const i of client.db.menu_items.filter((x) => x.location_id === loc)) {
      if (/latte|cappuccino|flat white|americano|espresso|croissant|bacon roll|toastie/i.test(i.name)) m.set(i.id, Math.round(Number(i.pricing?.base || 0) * 0.24 * 100) / 100);
    }
    return m;
  };
  demo = { api, client, sites, costs, orgId: DEMO_ORG };
  return demo;
}
