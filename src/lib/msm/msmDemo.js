// src/lib/msm/msmDemo.js
//
// MULTI SITE MENU (17 Oct 2026, v5.11.75): demo mode only (no database: lib/supabase.js isMock).
// A made up four site coffee company, held in memory by the same stand in client the tests use
// (fakeClient, which enforces the 1,000 row cap), so every screen can be tried end to end: the
// first import, the grid, the product sheet and Change prices. No real names, prices or takings
// (the repo is public). Never loaded in production: the screen imports it only when isMock.

import { fakeClient } from './fakeClient.js';
import { createMsmData } from './msmData.js';
import { applyChanges } from '../../../supabase/functions/_shared/msmDiff.js';
import { planSite, touchedFromChanges } from '../../../supabase/functions/_shared/msmPlan.js';
import { checkSite, failWords } from '../../../supabase/functions/_shared/msmHealth.js';
import { dueAt } from '../../../supabase/functions/_shared/msmSchedule.js';
import { readVenueRaw } from '../../../supabase/functions/_shared/venueMenuCore.js';

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
    t.tax_rates.push({ id: vat, location_id: loc, name: 'Standard rate', rate: 20, active: true, is_default: true });
    // Round 2: a zero rate at three of the four sites (Old Town has none: the VAT by order type
    // picker then says so, which is the point of showing it).
    if (i < 3) t.tax_rates.push({ id: `dm-zero-${i}`, location_id: loc, name: 'Zero rate', rate: 0, active: true, is_default: false });
    // Round 2: two option groups at every site, the milks linked to their sub items.
    const milkGroup = S('dm-grp-milk', loc, i);
    const syrupGroup = S('dm-grp-syrup', loc, i);
    const sub = (nm) => S(`dm-${slug(nm)}`, loc, i);
    t.modifier_groups.push({
      id: milkGroup, location_id: loc, name: 'Milk options', min: 0, max: 1, min_select: 0, max_select: 1, selection_type: 'single', sort_order: 1,
      options: [
        { id: 'mo-oat', name: 'Oat milk', price: i === 1 ? 0.5 : 0.4, itemId: sub('Oat milk') },
        { id: 'mo-soy', name: 'Soya milk', price: 0.4, itemId: sub('Soya milk') },
        ...(i === 3 ? [] : [{ id: 'mo-alm', name: 'Almond milk', price: 0.45, itemId: sub('Almond milk') }]),
      ],
    });
    t.modifier_groups.push({
      id: syrupGroup, location_id: loc, name: 'Syrups', min: 0, max: 3, min_select: 0, max_select: 3, selection_type: 'multiple', sort_order: 2,
      options: [
        { id: 'sy-van', name: 'Vanilla syrup', price: 0.5, itemId: sub('Vanilla syrup') },
        { id: 'sy-car', name: 'Caramel syrup', price: 0.5, itemId: sub('Caramel syrup') },
        { id: 'sy-haz', name: 'Hazelnut syrup', price: 0.5, itemId: sub('Hazelnut syrup') },
      ],
    });
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
        assigned_modifier_groups: ['Flat white', 'Latte', 'Cappuccino', 'Mocha', 'Cortado', 'Iced latte'].includes(name) ? [{ groupId: S('dm-grp-milk', loc, i) }, { groupId: S('dm-grp-syrup', loc, i) }] : [],
        visibility: ck === 'milk' ? { pos: false, kiosk: false, online: false, onlineDelivery: false } : { pos: true, kiosk: true, online: true, onlineDelivery: true }, sold_alone: ck !== 'milk',
        archived: i === 2 && name === 'Babyccino', tax_rate_id: vat, image: null, scope: i === 0 ? 'shared' : 'shared', org_id: DEMO_ORG,
        master_id: i === 0 ? null : `dm-${slug(name)}`, tags: [], item_code: null, centre_id: null, updated_at: '2026-10-01T10:00:00+00:00',
      });
    });
  });
  // A fifth site that has just opened and has no menu yet: the one to show Add a site with.
  const NEW_SITE = 'demo-site-0005-4000-8000-00000000e005';
  t.locations.push({ id: NEW_SITE, org_id: DEMO_ORG, name: 'Canal Wharf (opening soon)', timezone: 'Europe/London', default_tax_profile_id: null });
  t.tax_rates.push({ id: 'dm-vat-4', location_id: NEW_SITE, name: 'Standard rate', rate: 20, active: true });
  t.print_routing.push({ id: 'dm-pr-4', location_id: NEW_SITE, centres: [{ id: 'k', name: 'Kitchen' }], routing: { k: { assignedCategories: [], excludedItems: [] } } });
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
  db.msm_modifier_options = (p.options || []).map((o) => ({ ...noSites(o), menu_id: menuId, archived: !!o.archived }));
  db.msm_modifier_option_sites = (p.options || []).flatMap((o) => (o.sites || []).map((s) => ({ option_id: o.id, ...s })));
  db.msm_versions = [{ id: 'dddddddd-2222-4000-8000-000000000001', menu_id: menuId, org_id: p.org_id, version_no: 1, kind: 'import', title: 'Import', status: 'done', created_by_name: 'You (demo)', created_at: now, changes: [] }];
  return { data: { ok: true, menu_id: menuId, products: db.msm_products.length, categories: db.msm_categories.length, sites: db.msm_menu_sites.length, words: 'Version 1: imported. 0 changes at 0 sites.' }, error: null };
}

// ── The demo's publish (what msm_publish_now, msm_schedule_set and the msm-publish function do on
// the real database, in memory, so Publish, Schedule, the timeline, history, Undo, Retry and Add a
// site can all be shown with no database). Scheduled sets run when their time comes, checked each
// time the screen reads the history (the real one runs every minute on the server).
const demoNow = () => Date.now();
const err = (message) => ({ data: null, error: { message } });

function centralFromDb(db, menuId) {
  const cats = (db.msm_categories || []).filter((c) => c.menu_id === menuId);
  const catIds = new Set(cats.map((c) => c.id));
  const groups = (db.msm_modifier_groups || []).filter((g) => g.menu_id === menuId);
  const groupIds = new Set(groups.map((g) => g.id));
  const products = (db.msm_products || []).filter((p) => p.menu_id === menuId);
  const pids = new Set(products.map((p) => p.id));
  const options = (db.msm_modifier_options || []).filter((o) => o.menu_id === menuId);
  const oids = new Set(options.map((o) => o.id));
  return {
    options, optionSites: (db.msm_modifier_option_sites || []).filter((r) => oids.has(r.option_id)),
    menu: (db.msm_menus || []).find((m) => m.id === menuId) || null,
    sites: (db.msm_menu_sites || []).filter((s) => s.menu_id === menuId),
    categories: cats, catSites: (db.msm_category_sites || []).filter((r) => catIds.has(r.category_id)),
    groups, groupSites: (db.msm_modifier_group_sites || []).filter((r) => groupIds.has(r.group_id)),
    products, productSites: (db.msm_product_sites || []).filter((r) => pids.has(r.product_id)),
  };
}

function freeze(db, setId, kind, runLocal, lead, idle) {
  const set = (db.msm_change_sets || []).find((x) => x.id === setId);
  if (!set) return err('No such set of changes.');
  if (set.status !== 'draft') return err(`This set is already ${set.status}.`);
  const changes = (db.msm_changes || []).filter((c) => c.change_set_id === setId);
  if (!changes.length) return err('There is nothing in this set to publish.');
  const menuSites = (db.msm_menu_sites || []).filter((s) => s.menu_id === set.menu_id).map((s) => s.location_id);
  const wide = changes.some((c) => c.target !== 'menu_site' && c.target !== 'product_site');
  const reach = [...new Set([...(wide ? menuSites : []), ...changes.map((c) => c.location_id).filter(Boolean)])];
  if (!reach.length) return err('This set does not reach any site.');
  const tzOf = (loc) => (db.locations || []).find((l) => l.id === loc)?.timezone || 'Europe/London';
  if (kind === 'scheduled') {
    if (!runLocal) return err('Pick a date and time.');
    const past = reach.find((loc) => (dueAt(runLocal, tzOf(loc), 0) ?? 0) <= demoNow());
    if (past) return err(`That time has already passed at ${(db.locations || []).find((l) => l.id === past)?.name || 'one site'}.`);
  }
  const versionId = `dddddddd-3333-4000-8000-${String(demoNow()).slice(-12).padStart(12, '0')}`;
  const leadM = Math.max(0, Math.min(240, Number(lead ?? 5)));
  db.msm_versions.push({
    id: versionId, menu_id: set.menu_id, org_id: DEMO_ORG, version_no: null, title: set.title, status: 'scheduled', apply_when_idle: idle !== false,
    kind: set.kind === 'undo' && kind === 'publish' ? 'undo' : set.kind === 'add_site' && kind === 'publish' ? 'add_site' : kind,
    change_set_id: setId, created_by_name: 'You (demo)', created_at: new Date().toISOString(), changes: [],
  });
  for (const loc of reach) {
    const due = kind === 'scheduled' ? dueAt(runLocal, tzOf(loc), leadM) : demoNow();
    db.msm_version_sites.push({ version_id: versionId, location_id: loc, org_id: DEMO_ORG, status: 'scheduled', due_at: new Date(due).toISOString(), attempts: 0, error: null, counts: null, writes: null });
  }
  Object.assign(set, { status: 'scheduled', version_id: versionId, scheduled_at: new Date().toISOString(), run_local: kind === 'scheduled' ? String(runLocal).replace('T', ' ') : null, lead_minutes: leadM, apply_when_idle: idle !== false, updated_at: new Date().toISOString() });
  return { data: { ok: true, version_id: versionId, sites: db.msm_version_sites.filter((v) => v.version_id === versionId).map((v) => ({ location_id: v.location_id, due_at: v.due_at })) }, error: null };
}

function stopSet(db, setId, to) {
  const set = (db.msm_change_sets || []).find((x) => x.id === setId);
  if (!set) return err('No such set of changes.');
  if (set.status !== 'scheduled') return err(`Only a scheduled set can be ${to === 'draft' ? 'unscheduled' : 'cancelled'} (this one is ${set.status}).`);
  const v = db.msm_versions.find((x) => x.id === set.version_id);
  const rows = db.msm_version_sites.filter((x) => x.version_id === set.version_id);
  if ((v && v.version_no != null) || rows.some((r) => r.status !== 'scheduled')) return err(`It has already started, so it cannot be ${to === 'draft' ? 'unscheduled' : 'cancelled'}.`);
  if (to === 'draft') {
    db.msm_versions = db.msm_versions.filter((x) => x.id !== set.version_id);
    db.msm_version_sites = db.msm_version_sites.filter((x) => x.version_id !== set.version_id);
    Object.assign(set, { status: 'draft', version_id: null, scheduled_at: null, run_local: null, updated_at: new Date().toISOString() });
  } else {
    for (const r of rows) Object.assign(r, { status: 'cancelled', finished_at: new Date().toISOString() });
    if (v) Object.assign(v, { status: 'cancelled', finished_at: new Date().toISOString() });
    set.status = 'cancelled';
  }
  return { data: { ok: true, status: to }, error: null };
}

function refreshVersion(db, v) {
  const rows = db.msm_version_sites.filter((x) => x.version_id === v.id);
  const open = rows.filter((r) => r.status === 'scheduled' || r.status === 'running').length;
  const done = rows.filter((r) => r.status === 'done' || r.status === 'nothing').length;
  const failed = rows.filter((r) => r.status === 'failed').length;
  v.status = open ? (v.version_no == null ? 'scheduled' : 'running') : !failed ? 'done' : !done ? 'failed' : 'partly_done';
  if (!open) v.finished_at = v.finished_at || new Date().toISOString();
  const set = (db.msm_change_sets || []).find((x) => x.id === v.change_set_id);
  if (set) set.status = v.status;
  if (v.status === 'done' || v.status === 'partly_done') {
    const m = db.msm_menus.find((x) => x.id === v.menu_id);
    if (m) Object.assign(m, { last_published_at: new Date().toISOString(), last_published_by: v.created_by_name });
  }
}

// The audit of one site, in the shape msm_apply_site stores (msm_version_sites.writes).
function auditOf(plan) {
  const by = new Map();
  for (const l of plan.lines) {
    if (l.table !== 'items' || l.column === '(new)') continue;
    const a = by.get(l.id) || { table: 'items', id: l.id, before: {}, after: {} };
    if (l.column.startsWith('pricing.')) {
      const k = l.column.slice(8);
      a.before.pricing = { ...(a.before.pricing || {}), [k]: l.before };
      a.after.pricing = { ...(a.after.pricing || {}), [k]: l.after };
    } else { a.before[l.column] = l.before; a.after[l.column] = l.after; }
    by.set(l.id, a);
  }
  const inserted = (plan.writes?.items?.insert || []).map((r) => ({ table: 'items', id: r.id, before: null, after: r }));
  const cats = (plan.writes?.categories?.insert || []).map((r) => ({ table: 'categories', id: r.id, before: null, after: r }));
  const menus = (plan.writes?.menus?.insert || []).map((r) => ({ table: 'menus', id: r.id, before: null, after: r }));
  return [...menus, ...cats, ...inserted, ...by.values()];
}

async function runVersion(client, versionId) {
  const db = client.db;
  const v = db.msm_versions.find((x) => x.id === versionId);
  if (!v) return { data: null, error: { message: 'No such publish.' } };
  if (v.status === 'cancelled') return { data: { ok: true, status: 'cancelled', sites: [] }, error: null };
  const changes = (db.msm_changes || []).filter((c) => c.change_set_id === v.change_set_id);
  if (v.version_no == null) {
    // msm_start_version: the set goes into the central tables, one version number.
    const { central: after, before } = applyChanges(centralFromDb(db, v.menu_id), changes);
    const keep = (t, ids) => db[t].filter((r) => !ids(r));
    const pids = new Set(after.products.map((p) => p.id));
    db.msm_categories = [...keep('msm_categories', (r) => r.menu_id === v.menu_id), ...after.categories.map((c) => ({ ...c, menu_id: v.menu_id }))];
    db.msm_products = [...keep('msm_products', (r) => r.menu_id === v.menu_id), ...after.products.map((p) => ({ ...p, menu_id: v.menu_id }))];
    db.msm_product_sites = [...keep('msm_product_sites', (r) => pids.has(r.product_id)), ...after.productSites];
    db.msm_menu_sites = [...keep('msm_menu_sites', (r) => r.menu_id === v.menu_id), ...after.sites.map((s) => ({ ...s, menu_id: v.menu_id }))];
    const gids = new Set(after.groups.map((g) => g.id));
    const oids = new Set(after.options.map((o) => o.id));
    db.msm_modifier_groups = [...keep('msm_modifier_groups', (r) => r.menu_id === v.menu_id), ...after.groups.map((g) => ({ ...g, menu_id: v.menu_id }))];
    db.msm_modifier_group_sites = [...keep('msm_modifier_group_sites', (r) => gids.has(r.group_id)), ...after.groupSites];
    db.msm_modifier_options = [...keep('msm_modifier_options', (r) => r.menu_id === v.menu_id), ...after.options.map((o) => ({ ...o, menu_id: v.menu_id }))];
    db.msm_modifier_option_sites = [...keep('msm_modifier_option_sites', (r) => oids.has(r.option_id)), ...after.optionSites];
    const m = db.msm_menus.find((x) => x.id === v.menu_id);
    Object.assign(m, after.menu, { last_version_no: (m.last_version_no || 0) + 1 });
    Object.assign(v, { version_no: m.last_version_no, status: 'running', started_at: new Date().toISOString(), changes: before });
  }
  const touched = touchedFromChanges(changes);
  for (const vs of db.msm_version_sites.filter((x) => x.version_id === versionId && x.status === 'scheduled' && Date.parse(x.due_at) <= demoNow())) {
    const central = centralFromDb(db, v.menu_id);
    const raw = await readVenueRaw(client, vs.location_id);
    const name = (db.locations || []).find((l) => l.id === vs.location_id)?.name || 'This site';
    const plan = planSite({ central, touched, locationId: vs.location_id, orgId: DEMO_ORG, venue: raw });
    const health = checkSite(plan);
    vs.attempts = (vs.attempts || 0) + 1;
    if (!health.ok) { Object.assign(vs, { status: 'failed', error: failWords(name, v.title, health.blocking), finished_at: new Date().toISOString() }); continue; }
    // msm_apply_site: the venue rows as planned, and the new ids remembered centrally.
    const A = plan.applied;
    const loc = vs.location_id;
    db.menus = [...db.menus.filter((r) => r.location_id !== loc), ...A.menus.map((r) => ({ ...r, location_id: loc }))];
    db.menu_categories = [...db.menu_categories.filter((r) => r.location_id !== loc), ...A.categories.map((r) => ({ ...r, location_id: loc }))];
    db.menu_items = [...db.menu_items.filter((r) => r.location_id !== loc), ...A.items.map((r) => ({ ...r, location_id: loc }))];
    db.modifier_groups = [...db.modifier_groups.filter((r) => r.location_id !== loc), ...A.groups.map((r) => ({ ...r, location_id: loc }))];
    const menuIds = new Set(A.menus.map((r) => r.id));
    db.menu_category_links = [...db.menu_category_links.filter((r) => !menuIds.has(r.menu_id)), ...A.links];
    for (const c of plan.writes.maps.categories) db.msm_category_sites.push({ ...c, location_id: loc });
    for (const g of plan.writes.maps.groups) db.msm_modifier_group_sites.push({ ...g, location_id: loc });
    for (const o of plan.writes.maps.options || []) { const os = db.msm_modifier_option_sites.find((r) => r.option_id === o.option_id && r.location_id === (o.location_id || loc)); if (os) os.venue_option_id = o.venue_option_id; }
    if (plan.writes.maps.menu_site) { const ms = db.msm_menu_sites.find((s) => s.menu_id === v.menu_id && s.location_id === loc); if (ms) Object.assign(ms, plan.writes.maps.menu_site); }
    Object.assign(vs, { status: plan.lines.length ? 'done' : 'nothing', counts: plan.counts, writes: auditOf(plan), error: null, finished_at: new Date().toISOString(), push_id: plan.lines.length ? `demo-push-${vs.attempts}` : null });
  }
  refreshVersion(db, v);
  return { data: { ok: true, status: v.status, version_no: v.version_no, sites: db.msm_version_sites.filter((x) => x.version_id === versionId) }, error: null };
}

async function runDue(client) {
  const due = new Set(client.db.msm_version_sites.filter((x) => x.status === 'scheduled' && Date.parse(x.due_at) <= demoNow()).map((x) => x.version_id));
  for (const id of due) await runVersion(client, id);
}

let demo = null;
/** The demo data layer (one per page load), plus helpers the screens use in demo mode. */
export function demoMsm() {
  if (demo) return demo;
  const tables = { ...venueTables(), msm_menus: [], msm_menu_sites: [], msm_categories: [], msm_category_sites: [], msm_modifier_groups: [], msm_modifier_group_sites: [], msm_products: [], msm_product_sites: [], msm_modifier_options: [], msm_modifier_option_sites: [], msm_site_groups: [], msm_change_sets: [], msm_changes: [], msm_versions: [], msm_version_sites: [] };
  const client = fakeClient(tables, {
    stamp: true,
    defaults: { msm_change_sets: { status: 'draft', kind: 'edit', lead_minutes: 5, apply_when_idle: true, run_local: null, version_id: null } },
    rpcs: {
      msm_my_access: () => ({ data: { companies: [{ org_id: DEMO_ORG, org_name: 'Demo company', enabled: true, role: 'editor' }] }, error: null }),
      // Round 2: made up sales and trading, so the warnings that need a tick can be shown.
      msm_sold_recently: (_args, db) => ({ data: (db.menu_items || []).filter((x) => /latte|flat white|croissant/i.test(x.name)).map((x, n) => ({ location_id: x.location_id, venue_item_id: x.id, sold: 40 + n * 3 })), error: null }),
      msm_sites_trading: (_args, db) => ({ data: (db.locations || []).slice(0, 4).map((l, n) => ({ location_id: l.id, trading: n === 1, local_time: null })), error: null }),
      msm_import_commit: importCommit,
      msm_publish_now: ({ p_set, p_apply_when_idle }, db) => freeze(db, p_set, 'publish', null, 0, p_apply_when_idle),
      msm_schedule_set: ({ p_set, p_run_local, p_lead_minutes, p_apply_when_idle }, db) => freeze(db, p_set, 'scheduled', String(p_run_local || '').replace(' ', 'T'), p_lead_minutes, p_apply_when_idle),
      msm_unschedule_set: ({ p_set }, db) => stopSet(db, p_set, 'draft'),
      msm_cancel_set: ({ p_set }, db) => stopSet(db, p_set, 'cancelled'),
      msm_retry_site: ({ p_version, p_location }, db) => {
        const vs = db.msm_version_sites.find((x) => x.version_id === p_version && x.location_id === p_location);
        if (!vs) return err('That site is not in this publish.');
        if (vs.status !== 'failed') return err(`Only a site that failed can be retried (this one is ${vs.status}).`);
        Object.assign(vs, { status: 'scheduled', due_at: new Date().toISOString(), error: null, finished_at: null });
        const v = db.msm_versions.find((x) => x.id === p_version);
        if (v) refreshVersion(db, v);
        return { data: { ok: true, status: 'scheduled' }, error: null };
      },
    },
  });
  client.functions = { invoke: async (_name, { body } = {}) => (body?.action === 'run_version' ? runVersion(client, body.version_id) : { data: null, error: { message: 'Unknown action' } }) };
  const api = createMsmData({ client, report: () => {} });
  const history = api.history;
  api.history = async (menuId, opts) => { await runDue(client); return history(menuId, opts); };
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
