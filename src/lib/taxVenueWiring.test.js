// taxVenueWiring.test.js: the 27 Sep 2026 tax chase is wired where it has to be.
// Peter: "for some reason every products tax rate has been removed but they where there
// earlier I have re applied Tax to all products but thats wrong please chase".
// Ported from the tax root cause patch (v3) onto the stale tab branch, 27 Sep 2026. The rules are
// proved in venueTaxRates / bulkTax / boVenueBoot / boSessions / venueMenuRead tests; these read
// the source so a later edit cannot quietly unplug one of the doors. The patch's pins for code
// this branch does not take (its push guard, its whole row edit writer, the QR close VAT) are not
// here; the VAT recording pins shipped in v5.9.97 live in headlessTax.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.resolve(SRC, rel), 'utf8');
// Code only: comments may quote the old lines.
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
const between = (s, from, to) => { const i = s.indexOf(from); assert.ok(i >= 0, `missing ${from}`); const j = s.indexOf(to, i + from.length); return s.slice(i, j < 0 ? undefined : j); };

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(dir, e.name);
  if (e.isDirectory()) return walk(p);
  return /\.(jsx?|mjs)$/.test(e.name) && !/\.test\.js$/.test(e.name) ? [p] : [];
});

test('no tax rate loader anywhere keeps the old rates when a venue has none', () => {
  const offenders = walk(SRC).filter((f) => /\w+\?\.length\)\s*(patch\.taxRates\s*=|useStore\.setState\(\{\s*taxRates)/.test(code(fs.readFileSync(f, 'utf8'))));
  assert.deepEqual(offenders.map((f) => path.relative(SRC, f)), [], 'a successful read must replace (lib/venueTaxRates ratesAfterRead)');
  assert.match(code(read('sync/SyncBridge.jsx')), /ratesAfterRead\(/);
  assert.match(code(read('lib/useSupabaseInit.js')), /ratesAfterRead\(/);
  // The Back Office's own read takes the rates as read, an empty list included, and a failed read
  // keeps only this venue's (lib/venueMenuRead.js menuPatchFromRead).
  const vmr = code(read('lib/venueMenuRead.js'));
  assert.match(vmr, /if \(Array\.isArray\(read\.taxRates\)\) patch\.taxRates = read\.taxRates;/);
  assert.match(vmr, /const own = ownVenueRates\(state\.taxRates, locationId\);/);
  // Tax settings put the rates in the store tagged with their venue.
  assert.match(code(read('backoffice/sections/TaxManager.jsx')), /taxRates: fetched\.map\(mapTaxRateRow\)/);
  assert.match(code(read('lib/rowMapping.js')), /locationId: r\.location_id \?\? r\.locationId \?\? null,/);
});

test('an empty tax read is believed in Back Office; a till keeps its own rates, never another venue\'s', () => {
  // Applied AT ONCE against the store as it is then (a push may have landed meanwhile), never in
  // SyncBridge's late boot patch.
  const sb = code(read('sync/SyncBridge.jsx'));
  assert.doesNotMatch(sb, /patch\.taxRates\s*=/, 'the boot patch lands seconds later, over rates loaded meanwhile');
  assert.match(sb, /useStore\.setState\(s => \(\{ taxRates: ratesAfterRead\(taxRows, locationId, s\.taxRates, \{ trusted: isBackOfficeMode\(\) \}\) \}\)\)/);
  assert.match(sb, /if \(!\(isBackOfficeMode\(\) && useStore\.getState\(\)\.menuReadLocationId === locationId\)\)/, 'the Back Office\'s own read wins once it landed');
  assert.match(code(read('lib/useSupabaseInit.js')), /useStore\.setState\(s => \(\{ taxRates: ratesAfterRead\(taxRows, locId, s\.taxRates, \{ trusted: isBackOfficeMode\(\) \}\) \}\)\)/);
});

test('discount presets and rules carry their venue, pushed and taken only for it', () => {
  const bo = code(read('backoffice/BackOfficeApp.jsx'));
  assert.match(bo, /discountPresets: isMock \? \(useStore\.getState\(\)\.discountPresets \|\| \[\]\) : taggedVenueRows\(useStore\.getState\(\)\.discountPresets \|\| \[\], snapshotLocationId\)/);
  assert.match(bo, /discountRules: isMock \? \(useStore\.getState\(\)\.discountRules \|\| \[\]\) : taggedVenueRows\(useStore\.getState\(\)\.discountRules \|\| \[\], snapshotLocationId\)/);
  const store = code(read('store/index.js'));
  const apply = between(store, 'applyConfigUpdate: () => {', 'locationSections: defaultSections()');
  assert.match(apply, /const snapPresets = venueRowsFromSnapshot\(snap\.discountPresets, snap, pushVenue, get\(\)\.discountPresets\)/);
  assert.match(apply, /const snapRules = venueRowsFromSnapshot\(snap\.discountRules, snap, pushVenue, get\(\)\.discountRules\)/);
  assert.match(apply, /\.\.\.\(snapPresets \? \{ discountPresets: snapPresets \} : \{\}\)/);
  assert.doesNotMatch(apply, /snap\.discountPresets\?\.length \? \{ discountPresets: snap\.discountPresets \}/);
  assert.doesNotMatch(apply, /snap\.discountRules\?\.length \? \{ discountRules: snap\.discountRules \}/);
  const sb = code(read('sync/SyncBridge.jsx'));
  assert.match(sb, /id: d\.id, name: d\.name, label: d\.name, locationId,/);
  assert.match(sb, /id: r\.id, name: r\.name, active: r\.active, locationId,/);
  // A read replaces the slice, an empty one too when it is believed: always in Back Office, and on
  // a till read with a device's session (Provo's rules stayed on the Leeds tills otherwise).
  assert.match(sb, /const discTrusted = isBackOfficeMode\(\) \|\| await clientTrustsEmpty\(sb\);/);
  assert.match(sb, /if \(readMayReplace\(discRes, \{ trusted: discTrusted \}\)\) patch\.discountPresets/);
  assert.match(sb, /if \(readMayReplace\(rulesRes, \{ trusted: discTrusted \}\)\) patch\.discountRules/);
  const dm = code(read('backoffice/sections/DiscountManager.jsx'));
  assert.equal((dm.match(/locationId: [dr]\.location_id \?\? null/g) || []).length, 4, 'every Discounts screen mapping keeps the venue');
});

test('a product is stamped with, and a till line charged at, this venue\'s own rates only', () => {
  const store = code(read('store/index.js'));
  const add = between(store, 'addMenuItem: item => {', 'getItemPrice:');
  assert.match(add, /isBackOfficeMode\(\) \? venueTaxRates\(useStore\.getState\(\)\.taxRates, tabVenue\(\)\)/, 'never the default of rates pushed from another venue, nor of the venue another tab switched to');
  assert.match(code(read('lib/rowMapping.js')), /filter\(\(r\) => r && locationId && !r\.unverified && \(r\.locationId \?\? r\.location_id\) === locationId\)/, 'nor one a till took unchecked from an old push');
  const addItem = between(store, 'addItem: (item, mods=[], pizzaConfig=null, opts={}) => {', 'seat: \'shared\'');
  assert.match(addItem, /const refs = lineTaxRefs\(txRate, txOv, useStore\.getState\(\)\.taxRates\);/);
  assert.match(addItem, /console\.warn\('\[tax\] product', item\.id, 'names rate id\(s\)'/);
  // 8 Oct 2026 (D4): the line carries WHY a rate was cleaned away, so the sale records it.
  assert.match(addItem, /return \{ taxRateId: refs\.taxRateId, taxOverrides: refs\.taxOverrides, \.\.\.\(refs\.taxFallback \? \{ taxFallback: refs\.taxFallback \} : \{\}\) \};/);
});

test('a push carries only its own venue\'s rates, and a till takes only its own', () => {
  // The push's menu part is the fresh read (menuSnapshotFromRead), rates filtered to the read venue.
  const vmr = code(read('lib/venueMenuRead.js'));
  assert.match(vmr, /taxRates: read\.locationId \? taggedVenueRows\(read\.taxRates \|\| \[\], read\.locationId\) : \(read\.taxRates \|\| \[\]\),/);
  assert.match(vmr, /locationId: locationId \|\| null,/, 'the read records its venue');
  const bo = code(read('backoffice/BackOfficeApp.jsx'));
  assert.doesNotMatch(bo, /taxRates: useStore\.getState\(\)\.taxRates \|\| \[\]/);
  const store = code(read('store/index.js'));
  const apply = between(store, 'applyConfigUpdate: () => {', 'locationSections: defaultSections()');
  assert.match(apply, /const snapTaxRates = ratesFromSnapshot\(snap, pushVenue, get\(\)\.taxRates\);/, 'the till\'s own rates decide whether an untagged pushed rate may replace them');
  assert.match(apply, /snapTaxRates\.length \? \{ taxRates: snapTaxRates \}/);
  assert.doesNotMatch(apply, /snap\.taxRates\?\.length \? \{ taxRates: snap\.taxRates \}/);
  // Tax profiles have no venue on each row: a push labelled for another venue gives none.
  assert.match(apply, /const snapIsHere = !snap\.locationId \|\| !pushVenue \|\| String\(snap\.locationId\) === String\(pushVenue\);/);
  assert.match(apply, /\.\.\.\(snapIsHere && snap\.taxProfiles\?\.length \?/);
  assert.match(apply, /\.\.\.\(snapIsHere && 'venueDefaultTaxProfileId' in snap \?/);
});

test('a venue change clears the other venue\'s tax set up, discounts and packages', () => {
  const purge = between(code(read('sync/SyncBridge.jsx')), 'location changed', '_dataLocationId: null');
  for (const k of ['taxRates: []', 'taxProfiles: []', 'venueDefaultTaxProfileId: null', 'discountPresets: []', 'discountRules: []', 'packages: []']) assert.ok(purge.includes(k), k);
  const store = code(read('store/index.js'));
  const apply = between(store, 'applyConfigUpdate: () => {', 'locationSections: defaultSections()');
  assert.match(apply, /const snapPackages = venueRowsOnly\(snap\.packages, pushVenue\);/);
  assert.match(apply, /snapPackages\.length \? \{ packages: snapPackages \}/);
  assert.doesNotMatch(apply, /snap\.packages\?\.length \? \{ packages: snap\.packages \}/);
  assert.match(code(read('backoffice/BackOfficeApp.jsx')), /packages: venueRowsOnly\(useStore\.getState\(\)\.packages \|\| \[\], snapshotLocationId\)/);
});

test('Back Office reloads once when SyncBridge booted another venue\'s push', () => {
  const bo = code(read('backoffice/BackOfficeApp.jsx'));
  const resolve = between(bo, "localStorage.setItem('rpos-bo-location', JSON.stringify(effectiveLocId))", 'loadLocationData(effectiveLocId);');
  assert.match(resolve, /settleBoVenue\(\{ bootedFor: useStore\.getState\(\)\.bootLocationId, venue: effectiveLocId/);
  assert.match(resolve, /if \(bootAction === 'reload'\) \{[\s\S]*window\.location\.reload\(\);\s*return;/);
  assert.match(resolve, /if \(bootAction === 'purge'\) useStore\.setState\(foreignVenueSlices\(\)\)/);
  // SyncBridge records the venue it booted for (what settleBoVenue compares).
  assert.match(code(read('sync/SyncBridge.jsx')), /useStore\.setState\(\{ bootLocationId: locationId \}\);/);
});

test('the bulk tax apply is awaited, counted, venue only, and writes through the compare and set writer', () => {
  const mm = code(read('backoffice/sections/MenuManager.jsx'));
  assert.doesNotMatch(mm, /missingTax\.forEach\(/, 'the fire and forget loop is gone');
  assert.match(mm, /result = await useStore\.getState\(\)\.applyBulkTaxRates\(\{/);
  assert.match(mm, /planBulkTax\(\{ items: planItems, rates: ownNow, locationId: locKey, chosenRateId: pick\.id, copyRates \}\)/);
  assert.match(mm, /copyRates = await masterTaxRatesForCopies\(copies, loc\)/, 'shared copies take their master\'s rate');
  assert.match(mm, /bulkTaxWords\(\{ result, skipped: plan\.skipped, rateName: pick\.name, rates: ownNow, refreshed \}\)/);
  assert.match(mm, /const taxRates = liveVenueRatesOf\(allTaxRates\);/, 'the item editor offers this venue\'s live rates only');
  assert.match(mm, /const liveVenueRatesOf = \(rates\) => venueRatesOf\(rates\)\.filter\(r => r && r\.active !== false\);/);
  assert.match(mm, /!isMock && !ownTaxRates\.length\s*\?\s*' WARNING: this venue has no tax rates yet/, 'pulling shared products into a venue with no rates warns first');
  const store = code(read('store/index.js'));
  const action = between(store, 'applyBulkTaxRates: async', 'clearBOChanges:');
  assert.match(action, /await whenMenuLoadIdle\(\);/);
  assert.match(action, /edit: \(id, patch, prev, next, opened\) => menuWriters\.items\.edit\(id, patch, prev, next, \{ quiet: true, opened \}\)/, 'the compare and set writer every edit uses, checked against the plan\'s row');
  assert.match(action, /runBulkTax\(\{ assign, onProgress, shouldStop, ownRateIds, save \}\)/);
  assert.doesNotMatch(action, /upsertMenuItem|\.upsert\(|updateMenuItem\(|from\('menu_items'\)/, 'never a whole row write, never the size cascade');
  const bulk = code(read('lib/bulkTax.js'));
  assert.doesNotMatch(bulk, /\.upsert\(|\.update\(/, 'the pure module writes nothing itself');
  assert.match(between(bulk, 'export function bulkTaxSaver', '\n}\n'), /const r = await edit\(a\.id, \{ taxRateId: a\.taxRateId \}, prev, next, a\.item\);/, 'the plan\'s row is the token and the base (27 Sep 2026)');
});

test('the bulk tax apply reads the menu fresh BEFORE planning, and writes nothing without it', () => {
  const mm = code(read('backoffice/sections/MenuManager.jsx'));
  const go = between(mm, 'const go = async () => {', 'return (');
  const reread = go.indexOf('fresh = await loadVenueMenu(loc)');
  const plan = go.indexOf('planBulkTax(');
  assert.ok(reread > 0 && plan > reread, 'the fresh read comes before the plan');
  assert.match(go, /if \(!fresh\?\.applied \|\| !Array\.isArray\(fresh\.read\?\.menuItems\) \|\| !Array\.isArray\(fresh\.read\?\.taxRates\)\) \{/);
  assert.match(go, /Nothing was changed: this venue's products could not be read again first/, 'no fresh read, no writes');
  assert.match(go, /ownRateIds: plan\.ownRateIds/, 'a size follows its product\'s real rate');
  assert.match(go, /refreshed = taxRefreshed\(before, useStore\.getState\(\)\.menuItems\);/);
  assert.match(code(read('store/index.js')), /const applied = applyVenueMenuRead\(read, \{ \.\.\.ticket, locationId \}\);\s*return \{ ok: read\.ok, read, applied \};/);
});

test('the Items banner says what really happens to a product with no rate', () => {
  const mm = code(read('backoffice/sections/MenuManager.jsx'));
  assert.match(mm, /const defaultRate = offered\.find\(r => r\.isDefault \|\| r\.is_default\);/);
  assert.match(mm, /No rate here is set as the default, so until set they record NO/);
  assert.match(mm, /' \(an inactive rate\)'/, 'an inactive rate of this venue is not called another venue\'s');
  assert.match(mm, /if \(!taggedOwn\.length && hasProfiles && !bulkTaxResult\) return null;/);
  assert.match(mm, /ukVenue \? 'press Seed UK rates' : 'set up tax profiles or press Seed US rates'/);
  assert.match(mm, /This venue also has tax profiles: until a rate is set, they charge through those\./, 'a profile venue is not promised the venue default');
});

test('Tax settings: the empty read check counts only this venue\'s rates; a new rate or a seed maps the copies', () => {
  const tm = code(read('backoffice/sections/TaxManager.jsx'));
  assert.match(tm, /!expectEmpty && holdsOwnRates\(useStore\.getState\(\)\.taxRates, locId\)/);
  assert.match(between(tm, 'const seedRates = async', 'return ('), /await mapCopies\(locId\)/);
  assert.match(between(tm, 'const handleSave = async (form) => {', 'const handleDelete'), /form\.id \? '' : await mapCopies\(locId\)/);
  assert.match(between(tm, 'const mapCopies = async', 'useEffect('), /await loadVenueMenu\(locId\);/, 'Items then shows what was saved');
  assert.match(tm, /This venue has no tax rates, so its sales record no VAT/);
  assert.match(tm, /!rates\.length && !loading && !loadFailed && !noRatesIsFine/);
  const db = code(read('lib/db.js'));
  const map = between(db, 'export const mapCopiesTaxFromMasters', '\n};');
  assert.match(map, /copiesNeedingMasterRate\(rowsRes\.rows,/, 'copies with no rate or another venue\'s are re-mapped');
  assert.match(map, /return saveCopyTaxRates\(\{ client: supabase, locationId, copies, answers \}\);/, 'through the compare and set writer');
  assert.doesNotMatch(map, /\.update\(|\.upsert\(/, 'never its own write');
  const save = between(code(read('lib/bulkTax.js')), 'export async function saveCopyTaxRates', '\n}\n');
  assert.match(save, /cols: \{ tax_rate_id: taxRateId \},/, 'the tax column only');
  assert.match(save, /base: \{ tax_rate_id: prior \},/, 'checked against the rate it held when read');
});

test('both venue creation paths seed the rates, the Back Office one BEFORE pulling shared products', () => {
  const ca = code(read('backoffice/sections/CompanyAdmin.jsx'));
  const create = between(ca, 'const createLocation = async', 'const inviteOwner');
  const seed = create.indexOf('seedVenueTaxRates(');
  const pull = create.indexOf('pullSharedProductsTo(');
  assert.ok(seed > 0 && pull > 0 && seed < pull, 'rates first, so each copy maps its tax by name as it arrives');
  const admin = code(read('admin/CompanyAdminApp.jsx'));
  assert.match(between(admin, 'const createLocation = async', 'const createUser'), /seedVenueTaxRates\(\{/);
  const MIG = path.resolve(SRC, '../supabase/migrations');
  const sql = fs.readFileSync(path.join(MIG, '20260927d_OPS_tax_rates_seed.sql'), 'utf8');
  const sqlCode = sql.replace(/--.*$/gm, '');
  assert.match(sqlCode, /after insert on public\.locations/);
  assert.match(sqlCode, /exception when others then\s+raise warning/, 'seeding can never stop a venue being created');
  assert.match(sqlCode, /upper\(coalesce\(new\.currency, 'GBP'\)\) = 'GBP'/, 'US venues are skipped');
  assert.doesNotMatch(sqlCode, /publication/i, 'tax_rates is published once, by 20260927_OPS_menu_rows_server_time.sql');
  assert.match(fs.readFileSync(path.join(MIG, '20260927_OPS_menu_rows_server_time.sql'), 'utf8'), /array\['menu_items', 'tax_rates'\]/);
  const undo = fs.readFileSync(path.join(MIG, '20260927d_OPS_tax_rates_seed_ROLLBACK.sql'), 'utf8').replace(/--.*$/gm, '');
  assert.match(undo, /drop trigger if exists locations_seed_uk_tax_rates on public\.locations;/);
  assert.match(undo, /drop function if exists public\._seed_uk_tax_rates_for_new_location\(\);/);
  // 20260927a and 20260927b belong to another branch (RLS set form, cross tenant fix): never reused here.
  assert.deepEqual(fs.readdirSync(MIG).filter((f) => /^20260927[ab]_/.test(f) && /tax/.test(f)), []);
});

test('Back Office says when another tab of this browser is open on the same venue', () => {
  const bo = code(read('backoffice/BackOfficeApp.jsx'));
  assert.match(bo, /<OtherTabBanner key=\{orgCtx\?\.locationId \|\| 'none'\} venue=\{orgCtx\?\.locationId \|\| null\} \/>/);
  assert.match(bo, /import \{ startBoSessionWatch(, sameAuthUser)? \} from '\.\.\/lib\/boSessions';/);
});
