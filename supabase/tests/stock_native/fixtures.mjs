// fixtures.mjs: the companies, venues, logins, devices and stock rows of the Drop 0 proof. Ids and
// neutral words only (the repo is public). The two site test company, Provo and Location 2 carry
// their LIVE ids because 0a links exactly those (stock_co__link with literal ids, contract 2.5);
// every other company has a made up id.
//
// The rows are shaped to meet every link rule of 0a step 20 (contract 2.5), so the expected answers
// are known: 6 shared items (Brioche Bun twins at Provo stay apart, Oat Milk in l and ml stays
// apart, and Free Range Eggs stays apart: its tray of 30 at Provo and tray of 15 at Location 2 come
// from the one shared supplier and do not pair, so linking the item would add a supplier pack at the
// other site), 1 shared supplier (Dry Goods Ltd, same name but another email, stays apart), 2 shared
// supplier items (milk and butter), recipe pairs merged 2 / differ 3 / Location 2 only 2, and the
// fills at Location 2: 5 packs (one nested under its parent) and 2 unit bridges. rehearse.mjs checks
// the live figures (26, 4, 25, 1 / 5 / 2, 55, 7) on a copy of the live rows.

export const id = (prefix, tail) => `${prefix}-0000-4000-8000-${String(tail).padStart(12, '0')}`;

export const ORG_T = 'a59a6d97-ffaa-470e-8bb7-04cba789f335';   // the two site test company (live id)
export const PROVO = '7218c716-eeb4-4f96-b284-f3500823595c';   // its keep site (live id)
export const LOC2 = 'c3ebfa7f-61b3-4fbc-a192-e7e3949f370e';    // its link site (live id)
export const ORG_S = id('0b000000', 'b5');                      // a one site company that holds stock
export const SOLO = id('b1000000', 'b51');
export const ORG_G = id('0c000000', 'c9');                      // a seven site group with no stock
export const G = Array.from({ length: 7 }, (_, k) => id('c1000000', `c9${k + 1}`));
export const ORG_X = id('0d000000', 'd0');                      // another company (its owner is a manager at Provo)
export const X1 = id('d1000000', 'd01');

export const U = {
  ownerT: id('10000000', 'a'),        // owner of the test company
  ownerX: id('10000000', 'd'),        // owner of company X, linked as a manager at Provo
  ownerNoOrg: id('10000000', 'e'),    // role owner with no company, linked as a manager at Provo
  mgrProvo: id('10000000', 'a1'),     // manager at Provo (Stock control null = sites)
  mgrLoc2: id('10000000', 'a2'),      // manager at Location 2 (sites)
  mgrFull: id('10000000', 'af'),      // manager at Location 2, Stock control sites_full (set after 0a)
  mgrAll: id('10000000', 'aa'),       // manager at Location 2 only, Stock control all (set after 0a)
  mgrAllPurch: id('10000000', 'ab'),  // Stock control all, Back Office sections: purchasing only
  areaMgr: id('10000000', 'a12'),     // area manager over Provo and Location 2
  soloMgr: id('10000000', 'b1'),      // manager of the one site company
  soloOwner: id('10000000', 'b'),     // owner of the one site company
  groupMgr: id('10000000', 'c1'),     // manager at the group's first site
  superAdmin: id('10000000', 'ff'),
  noStep: id('10000000', 'a9'),       // manager at Provo whose session has not done the second step
};
export const DEV = {
  tillProvo: id('20000000', 'a1'), kioskProvo: id('20000000', 'ba1'), mposProvo: id('20000000', 'da1'),
  tillLoc2: id('20000000', 'a2'), opsLoc2: id('20000000', 'ea2'), tillSolo: id('20000000', 'b1'),
};
export const CUSTOMER = id('30000000', '1');

export const AR = {
  pBar: id('50000000', 'a11'), pKitchen: id('50000000', 'a12'), pCellar: id('50000000', 'a13'),
  lBar: id('50000000', 'a21'), lKitchen: id('50000000', 'a22'), sBar: id('50000000', 'b11'),
};
export const TAX = {
  pStd: id('63000000', 'a11'), pRed: id('63000000', 'a12'), pZero: id('63000000', 'a13'),
  lStd: id('63000000', 'a21'), lRed: id('63000000', 'a22'), lZero: id('63000000', 'a23'),
  sStd: id('63000000', 'b11'),
};
export const I = {
  pMilk: id('40000000', 'a01'), pButter: id('40000000', 'a02'), pEggs: id('40000000', 'a03'), pBeans: id('40000000', 'a04'),
  pCups: id('40000000', 'a05'), pBrioche1: id('40000000', 'a06'), pBrioche2: id('40000000', 'a07'), pKeg: id('40000000', 'a08'),
  pLemons: id('40000000', 'a09'), pSoup: id('40000000', 'a10'), pSyrup: id('40000000', 'a11'), pOat: id('40000000', 'a12'),
  lMilk: id('40000000', 'b01'), lButter: id('40000000', 'b02'), lEggs: id('40000000', 'b03'), lBeans: id('40000000', 'b04'),
  lCups: id('40000000', 'b05'), lBrioche: id('40000000', 'b06'), lLemons: id('40000000', 'b09'), lSoup: id('40000000', 'b10'),
  lOat: id('40000000', 'b12'), lBread: id('40000000', 'b13'),
  sWater: id('40000000', 'c01'),
};
export const PACK = {
  pMilkCase: id('62000000', 'a01'), pMilkBottle: id('62000000', 'a02'), pButterBox: id('62000000', 'a03'), pEggsTray: id('62000000', 'a04'),
  pBeansBag: id('62000000', 'a05'), pCupsSleeve: id('62000000', 'a06'), pSyrupBottle: id('62000000', 'a07'),
  sWaterCase: id('62000000', 'c01'), sWaterBottle: id('62000000', 'c02'),
};
export const CONV = { pMilk: id('64000000', 'a01'), pButter: id('64000000', 'a02'), pEggs: id('64000000', 'a03'), pSyrup: id('64000000', 'a04') };
export const SUP = {
  pDairy: id('60000000', 'a01'), pBean: id('60000000', 'a02'), pDry: id('60000000', 'a03'),
  lDairy: id('60000000', 'b01'), lBakery: id('60000000', 'b02'), lDry: id('60000000', 'b03'), sDrinks: id('60000000', 'c01'),
};
export const SP = {
  pMilk: id('61000000', 'a01'), pButter: id('61000000', 'a02'), pEggs: id('61000000', 'a03'), pBeans: id('61000000', 'a04'),
  pCups: id('61000000', 'a05'), pSyrup: id('61000000', 'a06'),
  lMilk: id('61000000', 'b01'), lButter: id('61000000', 'b02'), lEggs: id('61000000', 'b03'), lBread: id('61000000', 'b04'),
  sWater: id('61000000', 'c01'),
};
export const R = {
  pLatte: id('65000000', 'a01'), pFlat: id('65000000', 'a02'), pBurger: id('65000000', 'a03'), pSoupBatch: id('65000000', 'a04'),
  pSoupBowl: id('65000000', 'a05'), pBoard: id('65000000', 'a06'),
  lLatte: id('65000000', 'b01'), lFlat: id('65000000', 'b02'), lBurger: id('65000000', 'b03'), lSoupBatch: id('65000000', 'b04'),
  lSoupBowl: id('65000000', 'b05'), lBread: id('65000000', 'b06'), lLemonade: id('65000000', 'b07'),
  sWater: id('65000000', 'c01'),
};
// Till products (menu_items ids are text; Location 2's carry the live suffix _949f370e)
export const M = {
  pLatte: 'm-latte', pFlat: 'm-flat', pBurger: 'm-burger', pSoup: 'm-soup', pBoard: 'm-board',
  lLatte: 'm-latte_949f370e', lFlat: 'm-flat_949f370e', lBurger: 'm-burger_949f370e', lSoup: 'm-soup_949f370e',
  lBread: 'm-bread_949f370e', lLemonade: 'm-lemonade_949f370e', sWater: 'm-water',
};
export const MSM = { menu: id('66000000', 'f0'), latte: id('66000000', 'f1'), flat: id('66000000', 'f2'), burger: id('66000000', 'f3') };

// What 0a must find on these rows (contract 5.3 check row, fixture values)
export const EXPECT = {
  itemsShared: 6, suppliersShared: 1, supplierItemsShared: 2,
  recipePairs: { merged: 2, differ: 3, link_only: 2 },
  packsFilled: 5, bridgesFilled: 2,
  companyItemsT: 16, companySuppliersT: 5, companySupplierItemsT: 8, companyRecipesT: 11,
  revalue: { [PROVO]: 1.0, [LOC2]: 2.0 },
};

const anonSession = (sub) => ({ sub, role: 'authenticated', is_anonymous: true, aud: 'authenticated' });
const login = (sub, aal = 'aal2') => ({ sub, role: 'authenticated', is_anonymous: false, aud: 'authenticated', aal });
const who = (sub, what, aal) => ({ login: 'authenticator', role: 'authenticated', claims: login(sub, aal), what });
export const CALLERS = {
  ownerT: who(U.ownerT, 'owner of the test company'),
  ownerX: who(U.ownerX, 'owner of company X, a manager at Provo'),
  ownerNoOrg: who(U.ownerNoOrg, 'role owner with no company, a manager at Provo'),
  mgrProvo: who(U.mgrProvo, 'manager at Provo (sites)'),
  mgrLoc2: who(U.mgrLoc2, 'manager at Location 2 (sites)'),
  mgrFull: who(U.mgrFull, 'franchisee at Location 2 (sites_full)'),
  mgrAll: who(U.mgrAll, 'Stock control all, linked to Location 2 only'),
  mgrAllPurch: who(U.mgrAllPurch, 'Stock control all with Purchasing only'),
  areaMgr: who(U.areaMgr, 'area manager over Provo and Location 2'),
  soloMgr: who(U.soloMgr, 'manager of a one site company'),
  soloOwner: who(U.soloOwner, 'owner of a one site company'),
  groupMgr: who(U.groupMgr, 'manager in the seven site group'),
  superAdmin: who(U.superAdmin, 'ServOS staff (super admin)'),
  noStep: who(U.noStep, 'manager at Provo without the second step', 'aal1'),
  tillProvo: { login: 'authenticator', role: 'authenticated', claims: anonSession(DEV.tillProvo), what: 'till bound to Provo' },
  kioskProvo: { login: 'authenticator', role: 'authenticated', claims: anonSession(DEV.kioskProvo), what: 'kiosk bound to Provo' },
  mposProvo: { login: 'authenticator', role: 'authenticated', claims: anonSession(DEV.mposProvo), what: 'MPOS phone bound to Provo' },
  tillLoc2: { login: 'authenticator', role: 'authenticated', claims: anonSession(DEV.tillLoc2), what: 'till bound to Location 2' },
  opsLoc2: { login: 'authenticator', role: 'authenticated', claims: anonSession(DEV.opsLoc2), what: 'ops tablet of Location 2' },
  tillSolo: { login: 'authenticator', role: 'authenticated', claims: anonSession(DEV.tillSolo), what: 'till bound to the one site venue' },
  customer: { login: 'authenticator', role: 'authenticated', claims: anonSession(CUSTOMER), what: 'customer (anonymous, bound to nothing)' },
  anonKey: { login: 'authenticator', role: 'anon', claims: { role: 'anon' }, what: 'bare anon key' },
  service: { login: 'authenticator', role: 'service_role', claims: { role: 'service_role' }, what: 'service role (edge function)' },
  sqlEditor: { login: 'postgres', what: 'SQL editor / pg_cron' },
};

// The rows, as the SQL editor would insert them (before the migrations, as Ops had them).
export function seedSql() {
  const loc = (lid, org, name, ago) => `('${lid}', '${org}', '${name}', 'Europe/London', 'GBP', 'active', now() - interval '${ago}')`;
  return `
insert into organisations (id, name) values ('${ORG_T}', 'Two site test company'), ('${ORG_S}', 'One site company'),
  ('${ORG_G}', 'Seven site group'), ('${ORG_X}', 'Another company');
insert into locations (id, org_id, name, timezone, currency, status, created_at) values
  ${loc(PROVO, ORG_T, 'Provo', '40 days')}, ${loc(LOC2, ORG_T, 'Location 2', '30 days')}, ${loc(SOLO, ORG_S, 'Solo venue', '60 days')},
  ${G.map((g, k) => loc(g, ORG_G, `Group site ${k + 1}`, `${20 - k} days`)).join(', ')}, ${loc(X1, ORG_X, 'Other company site', '10 days')};
insert into auth.users (id, email) select x, 'login-' || substr(x::text, 25) || '@example.test' from unnest(array[${Object.values(U).map((u) => `'${u}'`).join(',')}]::uuid[]) x;
insert into user_profiles (id, org_id, location_id, role, email, full_name) values
  ('${U.ownerT}', '${ORG_T}', '${PROVO}', 'owner', 'owner-t@example.test', 'Owner T'),
  ('${U.ownerX}', '${ORG_X}', '${X1}', 'owner', 'owner-x@example.test', 'Owner X'),
  ('${U.ownerNoOrg}', null, '${PROVO}', 'owner', 'owner-n@example.test', 'Owner N'),
  ('${U.mgrProvo}', '${ORG_T}', '${PROVO}', 'manager', 'm1@example.test', 'Manager One'),
  ('${U.mgrLoc2}', '${ORG_T}', '${LOC2}', 'manager', 'm2@example.test', 'Manager Two'),
  ('${U.mgrFull}', '${ORG_T}', '${LOC2}', 'manager', 'mf@example.test', 'Franchisee'),
  ('${U.mgrAll}', '${ORG_T}', '${LOC2}', 'manager', 'ma@example.test', 'Head Office'),
  ('${U.mgrAllPurch}', '${ORG_T}', '${LOC2}', 'manager', 'mp@example.test', 'Buyer'),
  ('${U.areaMgr}', '${ORG_T}', '${PROVO}', 'manager', 'am@example.test', 'Area Manager'),
  ('${U.soloMgr}', '${ORG_S}', '${SOLO}', 'manager', 'sm@example.test', 'Solo Manager'),
  ('${U.soloOwner}', '${ORG_S}', '${SOLO}', 'owner', 'so@example.test', 'Solo Owner'),
  ('${U.groupMgr}', '${ORG_G}', '${G[0]}', 'manager', 'gm@example.test', 'Group Manager'),
  ('${U.superAdmin}', null, null, 'super_admin', 'staff@example.test', 'ServOS Staff'),
  ('${U.noStep}', '${ORG_T}', '${PROVO}', 'manager', 'ns@example.test', 'No Step');
update user_profiles set bo_sections = array['purchasing'] where id = '${U.mgrAllPurch}';
insert into user_locations (user_id, location_id, role) values
  ('${U.ownerX}', '${PROVO}', 'manager'), ('${U.ownerNoOrg}', '${PROVO}', 'manager'), ('${U.mgrProvo}', '${PROVO}', 'manager'),
  ('${U.mgrLoc2}', '${LOC2}', 'manager'), ('${U.mgrFull}', '${LOC2}', 'manager'), ('${U.mgrAll}', '${LOC2}', 'manager'),
  ('${U.mgrAllPurch}', '${LOC2}', 'manager'), ('${U.areaMgr}', '${PROVO}', 'manager'), ('${U.areaMgr}', '${LOC2}', 'manager'),
  ('${U.soloMgr}', '${SOLO}', 'manager'), ('${U.groupMgr}', '${G[0]}', 'manager'), ('${U.noStep}', '${PROVO}', 'manager');
insert into devices (location_id, name, type, status, device_uid, bound_via, last_seen) values
  ('${PROVO}', 'POS 1', 'pos', 'online', '${DEV.tillProvo}', 'claim_device_v2', now()),
  ('${PROVO}', 'Kiosk 1', 'kiosk', 'active', '${DEV.kioskProvo}', 'claim_kiosk', now()),
  ('${PROVO}', 'MPOS 1', 'mpos', 'active', '${DEV.mposProvo}', 'claim_device_v2', now()),
  ('${LOC2}', 'POS 1', 'pos', 'online', '${DEV.tillLoc2}', 'claim_device_v2', now()),
  ('${SOLO}', 'POS 1', 'pos', 'online', '${DEV.tillSolo}', 'claim_device_v2', now());
insert into ops_devices (location_id, org_id, device_uid, name) values ('${LOC2}', '${ORG_T}', '${DEV.opsLoc2}', 'Ops tablet');
insert into staff_members (location_id, org_id, name, role, pin, permissions) values
  ('${PROVO}', '${ORG_T}', 'Duty Manager', 'Manager', '4321', '[]'), ('${PROVO}', '${ORG_T}', 'Server One', 'Server', '1111', '[]'),
  ('${PROVO}', '${ORG_T}', 'Approver One', 'Server', '2468', '["manager_approvals"]'),
  ('${LOC2}', '${ORG_T}', 'Duty Manager Two', 'Manager', '5555', '[]'), ('${SOLO}', '${ORG_S}', 'Solo Duty Manager', 'Manager', '7777', '[]');
insert into tax_rates (id, location_id, name, rate, is_default) values
  ('${TAX.pStd}', '${PROVO}', 'VAT', 0.2, true), ('${TAX.pRed}', '${PROVO}', 'Reduced Rate', 0.05, false), ('${TAX.pZero}', '${PROVO}', 'Zero Rate', 0, false),
  ('${TAX.lStd}', '${LOC2}', 'Standard Rate', 0.2, true), ('${TAX.lRed}', '${LOC2}', 'Reduced Rate', 0.05, false), ('${TAX.lZero}', '${LOC2}', 'Zero Rate', 0, false),
  ('${TAX.sStd}', '${SOLO}', 'VAT', 0.2, true);
insert into storage_areas (id, location_id, name, kind) values
  ('${AR.pBar}', '${PROVO}', 'Bar', 'bar'), ('${AR.pKitchen}', '${PROVO}', 'Kitchen', 'kitchen'), ('${AR.pCellar}', '${PROVO}', 'Cellar', 'cellar'),
  ('${AR.lBar}', '${LOC2}', 'Bar', 'bar'), ('${AR.lKitchen}', '${LOC2}', 'Kitchen', 'kitchen'), ('${AR.sBar}', '${SOLO}', 'Bar', 'bar');

-- stock items (org_id null on two Provo rows, as live has it on some)
insert into inventory_items (id, location_id, org_id, name, kind, base_unit, category, accounting_group, sku, purchase_tax_rate_id, allergens) values
  ('${I.pMilk}', '${PROVO}', '${ORG_T}', 'Whole Milk 2L', 'PURCHASED', 'l', 'Dairy', 'Food', 'MILK2', null, '["milk"]'),
  ('${I.pButter}', '${PROVO}', '${ORG_T}', 'Salted Butter 250g', 'PURCHASED', 'each', 'Dairy', 'Food', 'BUT250', '${TAX.pZero}', '["milk"]'),
  ('${I.pEggs}', '${PROVO}', '${ORG_T}', 'Free Range Eggs', 'PURCHASED', 'each', 'Dairy', 'Food', null, null, '["egg"]'),
  ('${I.pBeans}', '${PROVO}', '${ORG_T}', 'Coffee Beans', 'PURCHASED', 'kg', 'Coffee', 'Food', 'BEANS', '${TAX.pStd}', '[]'),
  ('${I.pCups}', '${PROVO}', '${ORG_T}', 'Cups 12oz', 'PURCHASED', 'each', 'Packaging', 'Packaging', 'CUP12', '${TAX.pStd}', '[]'),
  ('${I.pBrioche1}', '${PROVO}', '${ORG_T}', 'Brioche Bun', 'PURCHASED', 'each', 'Bakery', 'Food', null, null, '["gluten"]'),
  ('${I.pBrioche2}', '${PROVO}', '${ORG_T}', 'Brioche Bun', 'PURCHASED', 'each', 'Bakery', 'Food', null, null, '["gluten"]'),
  ('${I.pKeg}', '${PROVO}', '${ORG_T}', 'Lager Keg 50L', 'PURCHASED', 'l', 'Beer', 'Drink', 'KEG50', '${TAX.pStd}', '[]'),
  ('${I.pLemons}', '${PROVO}', '${ORG_T}', 'Lemons', 'PURCHASED', 'each', 'Fruit', 'Food', null, null, '[]'),
  ('${I.pSoup}', '${PROVO}', '${ORG_T}', 'Soup of the Day (10L)', 'MADE', 'l', 'Prep', 'Food', null, null, '["milk"]'),
  ('${I.pSyrup}', '${PROVO}', null, 'Vanilla Syrup', 'PURCHASED', 'ml', 'Syrups', 'Food', 'SYR', '${TAX.pRed}', '[]'),
  ('${I.pOat}', '${PROVO}', null, 'Oat Milk', 'PURCHASED', 'l', 'Dairy', 'Food', null, null, '[]'),
  ('${I.lMilk}', '${LOC2}', '${ORG_T}', 'Whole Milk 2L', 'PURCHASED', 'l', 'Dairy', 'Food', 'MILK2', null, '["milk"]'),
  ('${I.lButter}', '${LOC2}', '${ORG_T}', 'Salted Butter 250g', 'PURCHASED', 'each', 'Dairy', 'Food', 'BUT250', '${TAX.lZero}', '["milk"]'),
  ('${I.lEggs}', '${LOC2}', '${ORG_T}', 'Free Range Eggs', 'PURCHASED', 'each', 'Dairy', 'Food', null, null, '["egg"]'),
  ('${I.lBeans}', '${LOC2}', '${ORG_T}', 'Coffee Beans', 'PURCHASED', 'kg', 'Coffee', 'Food', 'BEANS', '${TAX.lStd}', '[]'),
  ('${I.lCups}', '${LOC2}', '${ORG_T}', 'Cups 12oz', 'PURCHASED', 'each', 'Packaging', 'Packaging', 'CUP12', '${TAX.lStd}', '[]'),
  ('${I.lBrioche}', '${LOC2}', '${ORG_T}', 'Brioche Bun', 'PURCHASED', 'each', 'Bakery', 'Food', null, null, '["gluten"]'),
  ('${I.lLemons}', '${LOC2}', '${ORG_T}', 'Lemons', 'PURCHASED', 'each', 'Fruit', 'Food', null, null, '[]'),
  ('${I.lSoup}', '${LOC2}', '${ORG_T}', 'Soup of the Day (10L)', 'MADE', 'l', 'Prep', 'Food', null, null, '["milk"]'),
  ('${I.lOat}', '${LOC2}', '${ORG_T}', 'Oat Milk', 'PURCHASED', 'ml', 'Dairy', 'Food', null, null, '[]'),
  ('${I.lBread}', '${LOC2}', '${ORG_T}', 'Local Bread', 'PURCHASED', 'each', 'Bakery', 'Food', 'BREAD', null, '["gluten"]'),
  ('${I.sWater}', '${SOLO}', '${ORG_S}', 'Bottled Water', 'PURCHASED', 'each', 'Soft drinks', 'Drink', 'WATER', '${TAX.sStd}', '[]');
insert into inventory_item_areas (location_id, inventory_item_id, area_id, is_primary) values
  ('${PROVO}', '${I.pMilk}', '${AR.pBar}', true), ('${PROVO}', '${I.pBeans}', '${AR.pCellar}', true), ('${PROVO}', '${I.pButter}', '${AR.pKitchen}', true),
  ('${LOC2}', '${I.lMilk}', '${AR.lBar}', true), ('${SOLO}', '${I.sWater}', '${AR.sBar}', true);
insert into item_packaging_formats (id, location_id, inventory_item_id, name, qty_in_base, is_purchase_default, is_count_default) values
  ('${PACK.pMilkCase}', '${PROVO}', '${I.pMilk}', 'Case', 12, true, false),
  ('${PACK.pButterBox}', '${PROVO}', '${I.pButter}', 'Box', 40, true, true),
  ('${PACK.pEggsTray}', '${PROVO}', '${I.pEggs}', 'Tray', 30, true, true),
  ('${PACK.pBeansBag}', '${PROVO}', '${I.pBeans}', 'Bag', 1, true, true),
  ('${PACK.pCupsSleeve}', '${PROVO}', '${I.pCups}', 'Sleeve', 50, true, true),
  ('${PACK.pSyrupBottle}', '${PROVO}', '${I.pSyrup}', 'Bottle', 700, true, true),
  ('${PACK.sWaterCase}', '${SOLO}', '${I.sWater}', 'Case', 24, true, false);
insert into item_packaging_formats (id, location_id, inventory_item_id, name, qty_in_base, parent_format_id, is_count_default) values
  ('${PACK.pMilkBottle}', '${PROVO}', '${I.pMilk}', 'Bottle', 2, '${PACK.pMilkCase}', true),
  ('${PACK.sWaterBottle}', '${SOLO}', '${I.sWater}', 'Bottle', 1, '${PACK.sWaterCase}', true);
insert into inventory_item_conversions (id, location_id, inventory_item_id, from_qty, from_unit, to_qty, to_unit) values
  ('${CONV.pMilk}', '${PROVO}', '${I.pMilk}', 1, 'l', 1000, 'ml'),
  ('${CONV.pButter}', '${PROVO}', '${I.pButter}', 1, 'each', 250, 'g'),
  ('${CONV.pEggs}', '${PROVO}', '${I.pEggs}', 1, 'each', 60, 'g'),
  ('${CONV.pSyrup}', '${PROVO}', '${I.pSyrup}', 1, 'ml', 1.3, 'g');
insert into suppliers (id, location_id, org_id, name, email, account_number, delivery_days, cutoff_time) values
  ('${SUP.pDairy}', '${PROVO}', '${ORG_T}', 'Dairy Co', 'orders@dairy.example.test', 'P-100', '["Mon","Thu"]', '14:00'),
  ('${SUP.pBean}', '${PROVO}', null, 'Bean Co', 'orders@beans.example.test', 'P-200', '[]', null),
  ('${SUP.pDry}', '${PROVO}', '${ORG_T}', 'Dry Goods Ltd', null, null, '["Wed"]', null),
  ('${SUP.lDairy}', '${LOC2}', '${ORG_T}', 'Dairy Co', 'orders@dairy.example.test', 'L-900', '["Tue"]', '12:00'),
  ('${SUP.lDry}', '${LOC2}', '${ORG_T}', 'Dry Goods Ltd', 'sales@drygoods.example.test', null, '[]', null),
  ('${SUP.lBakery}', '${LOC2}', '${ORG_T}', 'Bakery Local', null, null, '[]', null),
  ('${SUP.sDrinks}', '${SOLO}', '${ORG_S}', 'Drinks Ltd', null, 'S-1', '[]', null);
insert into supplier_products (id, location_id, inventory_item_id, supplier_id, supplier_sku, pack_description, pack_qty, inner_qty, inner_unit, pack_price, is_preferred, purchase_tax_rate_id) values
  ('${SP.pMilk}', '${PROVO}', '${I.pMilk}', '${SUP.pDairy}', 'D-MILK', '6 x 2 l', 6, 2, 'l', 13.20, true, null),
  ('${SP.pButter}', '${PROVO}', '${I.pButter}', '${SUP.pDairy}', 'D-BUT', 'Box of 40', 1, 40, 'each', 30.00, true, '${TAX.pZero}'),
  ('${SP.pEggs}', '${PROVO}', '${I.pEggs}', '${SUP.pDairy}', 'D-EGG', 'Tray of 30', 1, 30, 'each', 9.00, true, null),
  ('${SP.pBeans}', '${PROVO}', '${I.pBeans}', '${SUP.pBean}', 'B-1KG', 'Bag 1 kg', 1, 1, 'kg', 18.00, true, '${TAX.pStd}'),
  ('${SP.pCups}', '${PROVO}', '${I.pCups}', '${SUP.pDry}', 'DG-CUP', 'Sleeve of 50', 1, 50, 'each', 4.00, true, '${TAX.pStd}'),
  ('${SP.pSyrup}', '${PROVO}', '${I.pSyrup}', '${SUP.pDry}', 'DG-SYR', '700 ml', 1, 700, 'ml', 6.30, true, '${TAX.pRed}'),
  ('${SP.lMilk}', '${LOC2}', '${I.lMilk}', '${SUP.lDairy}', 'D-MILK', '6 x 2 l', 6, 2, 'l', 14.40, true, null),
  ('${SP.lButter}', '${LOC2}', '${I.lButter}', '${SUP.lDairy}', 'D-BUT', 'Box of 40', 1, 40, 'each', 30.00, true, '${TAX.lZero}'),
  ('${SP.lEggs}', '${LOC2}', '${I.lEggs}', '${SUP.lDairy}', 'D-EGG', 'Tray of 15', 1, 15, 'each', 4.80, true, null),
  ('${SP.lBread}', '${LOC2}', '${I.lBread}', '${SUP.lBakery}', 'BK-LOAF', 'Ten loaves', 1, 10, 'each', 12.00, true, null),
  ('${SP.sWater}', '${SOLO}', '${I.sWater}', '${SUP.sDrinks}', 'DR-W24', 'Case of 24', 1, 24, 'each', 9.60, true, '${TAX.sStd}');
update inventory_items i set default_supplier_id = sp.supplier_id from supplier_products sp where sp.inventory_item_id = i.id and sp.is_preferred;
insert into par_levels (location_id, inventory_item_id, par_level, reorder_point, min_level) values
  ('${PROVO}', '${I.pMilk}', 24, 12, 6), ('${PROVO}', '${I.pBeans}', 6, 2, null), ('${LOC2}', '${I.lMilk}', 12, 6, 3);

-- recipes and their till links
insert into recipes (id, location_id, name, recipe_type, output_item_id, yield_qty, yield_unit) values
  ('${R.pLatte}', '${PROVO}', 'Latte', 'MENU', null, 1, 'each'), ('${R.pFlat}', '${PROVO}', 'Flat White', 'MENU', null, 1, 'each'),
  ('${R.pBurger}', '${PROVO}', 'Brioche Burger', 'MENU', null, 1, 'each'),
  ('${R.pSoupBatch}', '${PROVO}', 'Soup of the Day (10L)', 'BATCH', '${I.pSoup}', 10, 'l'),
  ('${R.pSoupBowl}', '${PROVO}', 'Soup Bowl', 'MENU', null, 1, 'each'), ('${R.pBoard}', '${PROVO}', 'Butter Board', 'MENU', null, 1, 'each'),
  ('${R.lLatte}', '${LOC2}', 'Latte', 'MENU', null, 1, 'each'), ('${R.lFlat}', '${LOC2}', 'Flat White', 'MENU', null, 1, 'each'),
  ('${R.lBurger}', '${LOC2}', 'Brioche Burger', 'MENU', null, 1, 'each'),
  ('${R.lSoupBatch}', '${LOC2}', 'Soup of the Day (10L)', 'BATCH', '${I.lSoup}', 10, 'l'),
  ('${R.lSoupBowl}', '${LOC2}', 'Soup Bowl', 'MENU', null, 1, 'each'), ('${R.lBread}', '${LOC2}', 'Bread Basket', 'MENU', null, 1, 'each'),
  ('${R.lLemonade}', '${LOC2}', 'Lemonade', 'MENU', null, 1, 'each'),
  ('${R.sWater}', '${SOLO}', 'Water', 'MENU', null, 1, 'each');
insert into recipe_lines (location_id, recipe_id, component_item_id, qty, unit, sort_order, order_types) values
  ('${PROVO}', '${R.pLatte}', '${I.pMilk}', 0.25, 'l', 0, null), ('${PROVO}', '${R.pLatte}', '${I.pBeans}', 18, 'g', 1, null),
  ('${PROVO}', '${R.pLatte}', '${I.pCups}', 1, 'each', 2, null),
  ('${PROVO}', '${R.pFlat}', '${I.pMilk}', 150, 'ml', 0, null), ('${PROVO}', '${R.pFlat}', '${I.pBeans}', 0.018, 'kg', 1, null),
  ('${PROVO}', '${R.pBurger}', '${I.pBrioche1}', 1, 'each', 0, null), ('${PROVO}', '${R.pBurger}', '${I.pButter}', 10, 'g', 1, null),
  ('${PROVO}', '${R.pSoupBatch}', '${I.pMilk}', 2, 'l', 0, null), ('${PROVO}', '${R.pSoupBatch}', '${I.pButter}', 4, 'each', 1, null),
  ('${PROVO}', '${R.pSoupBowl}', '${I.pSoup}', 0.35, 'l', 0, null),
  ('${PROVO}', '${R.pBoard}', '${I.pButter}', 0.1, '@${PACK.pButterBox}', 0, null),
  ('${LOC2}', '${R.lLatte}', '${I.lMilk}', 0.25, 'l', 0, null), ('${LOC2}', '${R.lLatte}', '${I.lBeans}', 18, 'g', 1, null),
  ('${LOC2}', '${R.lLatte}', '${I.lCups}', 1, 'each', 2, null),
  ('${LOC2}', '${R.lFlat}', '${I.lMilk}', 150, 'ml', 0, null), ('${LOC2}', '${R.lFlat}', '${I.lBeans}', 0.018, 'kg', 1, '["takeaway"]'),
  ('${LOC2}', '${R.lBurger}', '${I.lBrioche}', 1, 'each', 0, null), ('${LOC2}', '${R.lBurger}', '${I.lButter}', 0.04, 'each', 1, null),
  ('${LOC2}', '${R.lSoupBatch}', '${I.lMilk}', 2, 'l', 0, null), ('${LOC2}', '${R.lSoupBatch}', '${I.lButter}', 4, 'each', 1, null),
  ('${LOC2}', '${R.lSoupBatch}', '${I.lLemons}', 1, 'each', 2, null),
  ('${LOC2}', '${R.lSoupBowl}', '${I.lSoup}', 0.35, 'l', 0, null),
  ('${LOC2}', '${R.lBread}', '${I.lBread}', 2, 'each', 0, null), ('${LOC2}', '${R.lLemonade}', '${I.lLemons}', 1, 'each', 0, null),
  ('${SOLO}', '${R.sWater}', '${I.sWater}', 1, '@${PACK.sWaterBottle}', 0, null);
insert into menu_items (id, location_id, name, master_id) values
  ('${M.pLatte}', '${PROVO}', 'Latte', null), ('${M.pFlat}', '${PROVO}', 'Flat White', null), ('${M.pBurger}', '${PROVO}', 'Brioche Burger', null),
  ('${M.pSoup}', '${PROVO}', 'Soup Bowl', null), ('${M.pBoard}', '${PROVO}', 'Butter Board', null),
  ('${M.lLatte}', '${LOC2}', 'Latte', null), ('${M.lFlat}', '${LOC2}', 'Flat White', null), ('${M.lBurger}', '${LOC2}', 'Brioche Burger', null),
  ('${M.lSoup}', '${LOC2}', 'Soup Bowl', '${M.pSoup}'), ('${M.lBread}', '${LOC2}', 'Bread Basket', null), ('${M.lLemonade}', '${LOC2}', 'Lemonade', null),
  ('${M.sWater}', '${SOLO}', 'Water', null);
insert into menu_item_recipes (location_id, menu_item_id, recipe_id, portion) values
  ('${PROVO}', '${M.pLatte}', '${R.pLatte}', 1), ('${PROVO}', '${M.pFlat}', '${R.pFlat}', 1), ('${PROVO}', '${M.pBurger}', '${R.pBurger}', 1),
  ('${PROVO}', '${M.pSoup}', '${R.pSoupBowl}', 1), ('${PROVO}', '${M.pBoard}', '${R.pBoard}', 1),
  ('${LOC2}', '${M.lLatte}', '${R.lLatte}', 1), ('${LOC2}', '${M.lFlat}', '${R.lFlat}', 1), ('${LOC2}', '${M.lBurger}', '${R.lBurger}', 1),
  ('${LOC2}', '${M.lSoup}', '${R.lSoupBowl}', 1), ('${LOC2}', '${M.lBread}', '${R.lBread}', 1), ('${LOC2}', '${M.lLemonade}', '${R.lLemonade}', 1),
  ('${SOLO}', '${M.sWater}', '${R.sWater}', 1);
insert into msm_company (org_id, enabled) values ('${ORG_T}', true);
insert into msm_menus (id, org_id, name) values ('${MSM.menu}', '${ORG_T}', 'Company menu');
insert into msm_products (id, menu_id, name, default_price) values ('${MSM.latte}', '${MSM.menu}', 'Latte', 3.2),
  ('${MSM.flat}', '${MSM.menu}', 'Flat White', 3.1), ('${MSM.burger}', '${MSM.menu}', 'Brioche Burger', 9.5);
insert into msm_product_sites (product_id, location_id, venue_item_id) values
  ('${MSM.latte}', '${PROVO}', '${M.pLatte}'), ('${MSM.latte}', '${LOC2}', '${M.lLatte}'),
  ('${MSM.flat}', '${PROVO}', '${M.pFlat}'), ('${MSM.flat}', '${LOC2}', '${M.lFlat}'),
  ('${MSM.burger}', '${PROVO}', '${M.pBurger}'), ('${MSM.burger}', '${LOC2}', '${M.lBurger}');
`;
}

// Stock on the shelves, through the posting core as the database itself (after the migrations),
// then two costs moved with no ledger line (as old browser cost writes did) so the revalue file has
// work: Provo milk 1.10 to 1.15 on 20 l (+1.00), Location 2 butter 0.75 to 0.80 on 40 (+2.00).
export function stockSql() {
  const rows = [
    [PROVO, I.pMilk, 20, 1.10, AR.pBar], [PROVO, I.pButter, 80, 0.75, AR.pKitchen], [PROVO, I.pEggs, 60, 0.30, null],
    [PROVO, I.pBeans, 5, 18, AR.pCellar], [PROVO, I.pCups, 400, 0.08, null], [PROVO, I.pBrioche1, 95, 0.414, null],
    [PROVO, I.pBrioche2, 30, 0.30, null], [PROVO, I.pKeg, 50, 3.44, AR.pCellar], [PROVO, I.pLemons, 10, 0.30, null],
    [PROVO, I.pSoup, 10, 0.5, null], [PROVO, I.pSyrup, 1400, 0.009, null], [PROVO, I.pOat, 6, 1.4, null],
    [LOC2, I.lMilk, 12, 1.20, AR.lBar], [LOC2, I.lButter, 40, 0.75, null], [LOC2, I.lEggs, 30, 0.32, null], [LOC2, I.lBeans, 2, 17.5, null],
    [LOC2, I.lCups, 200, 0.08, null], [LOC2, I.lBrioche, 40, 0.35, null], [LOC2, I.lLemons, 12, 0.30, null], [LOC2, I.lSoup, 5, 0.55, null],
    [LOC2, I.lOat, 3000, 0.0015, null], [LOC2, I.lBread, 20, 1.2, null],
    [SOLO, I.sWater, 48, 0.40, AR.sBar],
  ];
  const lines = rows.map(([loc, item, qty, cost, area], k) =>
    `select public._post_stock_movement('${loc}', '${item}', ${qty}, '${item === I.pSoup || item === I.lSoup ? 'PRODUCTION_OUTPUT' : 'PURCHASE_RECEIPT'}', ${cost}, 'purchase_order', 'seed', 'seed:${k}', now() - interval '3 days', null, null, ${area ? `'${area}'` : 'null'});
     update inventory_items set current_cost = ${cost} where id = '${item}';`);
  return `${lines.join('\n')}
select public._post_stock_movement('${PROVO}', '${I.pLemons}', -14, 'SALE_DEPLETION', 0.30, 'closed_check', 'seed-neg', 'sale:seed-neg:${I.pLemons}', now() - interval '2 days');
update inventory_items set archived_at = now() - interval '1 day' where id = '${I.pKeg}';
update inventory_items set current_cost = 1.15 where id = '${I.pMilk}';
update inventory_items set current_cost = 0.80 where id = '${I.lButter}';
`;
}
