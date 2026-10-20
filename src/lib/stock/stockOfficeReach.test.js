// node --test: who reaches a venue from an edge function (v5.11.84, multi site stock Drop 0, plan 6.2).
// Two answers, never one: officeReachesVenue (everything) is unchanged; stockOfficeReachesVenue adds
// Stock control 'all' in the venue's own company, and only stock work uses it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  officeReachesVenue, stockOfficeReachesVenue, STOCK_CONTROL_LEVELS, isMissingColumn, readReachProfile, readOfficeReachFacts,
} from '../../../supabase/functions/_shared/stockOfficeReach.js';

const read = (rel) => fs.readFileSync(new URL(`../../../${rel}`, import.meta.url), 'utf8');
// Source without // line comments, for "the code does X" checks.
const code = (src) => src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

const A = 'org-a';
const B = 'org-b';
const user = { id: 'u1' };

test('officeReachesVenue is unchanged: link, super admin, owner of the venue\'s company; never anonymous', () => {
  assert.deepEqual(officeReachesVenue({ user, linked: true }), { ok: true, via: 'link' });
  assert.deepEqual(officeReachesVenue({ user, profile: { role: 'super_admin' } }), { ok: true, via: 'super_admin' });
  assert.deepEqual(officeReachesVenue({ user, profile: { role: 'owner', org_id: A }, venueOrgId: A }), { ok: true, via: 'owner' });
  assert.deepEqual(officeReachesVenue({ user, profile: { role: 'owner', org_id: A }, venueOrgId: B }), { ok: false, via: null });
  assert.deepEqual(officeReachesVenue({ user: { id: 'd1', is_anonymous: true }, linked: true }), { ok: false, via: null });
  assert.deepEqual(officeReachesVenue({}), { ok: false, via: null });
  // Stock control never widens the everything rule
  assert.deepEqual(officeReachesVenue({ user, profile: { role: 'manager', org_id: A, stock_control: 'all' }, venueOrgId: A }), { ok: false, via: null });
});

test('stockOfficeReachesVenue: everything officeReachesVenue allows, plus Stock control all in the venue\'s OWN company', () => {
  // the same as officeReachesVenue first
  assert.deepEqual(stockOfficeReachesVenue({ user, linked: true }), { ok: true, via: 'link' });
  assert.deepEqual(stockOfficeReachesVenue({ user, profile: { role: 'super_admin' } }), { ok: true, via: 'super_admin' });
  assert.deepEqual(stockOfficeReachesVenue({ user, profile: { role: 'owner', org_id: A }, venueOrgId: A }), { ok: true, via: 'owner' });
  // a Stock control all manager, not linked, at a site of their own company
  assert.deepEqual(stockOfficeReachesVenue({ user, profile: { role: 'manager', org_id: A, stock_control: 'all' }, venueOrgId: A }), { ok: true, via: 'stock_control' });
  // ...never in another company (a login linked into a second company is 'sites' there)
  assert.deepEqual(stockOfficeReachesVenue({ user, profile: { role: 'manager', org_id: A, stock_control: 'all' }, venueOrgId: B }), { ok: false, via: null });
  // an owner of company A is not an owner in company B, and their level never applies there
  assert.deepEqual(stockOfficeReachesVenue({ user, profile: { role: 'owner', org_id: A, stock_control: 'all' }, venueOrgId: B }), { ok: false, via: null });
  // a role owner with no company reaches nothing by the owner rule or the level
  assert.deepEqual(stockOfficeReachesVenue({ user, profile: { role: 'owner', org_id: null, stock_control: 'all' }, venueOrgId: A }), { ok: false, via: null });
  // the other levels do not widen reach (they are about what a login may change, not where)
  for (const level of [null, undefined, 'sites', 'sites_full']) {
    assert.deepEqual(stockOfficeReachesVenue({ user, profile: { role: 'manager', org_id: A, stock_control: level }, venueOrgId: A }), { ok: false, via: null }, String(level));
  }
  // never an anonymous session, whatever its profile says
  assert.deepEqual(stockOfficeReachesVenue({ user: { id: 'd1', is_anonymous: true }, profile: { org_id: A, stock_control: 'all' }, venueOrgId: A }), { ok: false, via: null });
  assert.deepEqual(stockOfficeReachesVenue({ user: null, profile: { org_id: A, stock_control: 'all' }, venueOrgId: A }), { ok: false, via: null });
  // no venue company, no level answer
  assert.deepEqual(stockOfficeReachesVenue({ user, profile: { role: 'manager', org_id: A, stock_control: 'all' }, venueOrgId: null }), { ok: false, via: null });
  assert.deepEqual(STOCK_CONTROL_LEVELS, ['sites', 'sites_full', 'all']);
});

test('property: stock reach is a superset of office reach, and differs only by the Stock control all branch', () => {
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
  for (let i = 0; i < 2000; i++) {
    const facts = {
      user: pick([null, { id: 'u' }, { id: 'u', is_anonymous: true }, { id: 'u', is_anonymous: false }]),
      profile: pick([null, { role: pick(['owner', 'manager', 'super_admin', 'staff', undefined]), org_id: pick([A, B, null]), stock_control: pick([null, 'sites', 'sites_full', 'all']) }]),
      linked: rnd() < 0.3,
      venueOrgId: pick([A, B, null]),
    };
    const office = officeReachesVenue(facts);
    const stock = stockOfficeReachesVenue(facts);
    if (office.ok) assert.deepEqual(stock, office, 'office reach always carries over unchanged');
    if (stock.ok && !office.ok) {
      assert.equal(stock.via, 'stock_control');
      assert.equal(facts.profile.stock_control, 'all');
      assert.equal(facts.profile.org_id, facts.venueOrgId);
      assert.notEqual(facts.user?.is_anonymous, true);
    }
  }
});

// a stand in for the service role client: one table answer per select
function fakeSb({ profileError = null, profile = null, linked = false, venueOrg = null } = {}) {
  const calls = [];
  return {
    calls,
    from(table) {
      const st = { table, select: null, filters: [] };
      const q = {
        select(cols) { st.select = cols; return q; },
        eq(k, v) { st.filters.push([k, v]); return q; },
        async maybeSingle() {
          calls.push({ ...st });
          if (table === 'user_profiles') {
            if (profileError && st.select.includes('stock_control')) return { data: null, error: profileError };
            if (!profile) return { data: null, error: null };
            const cols = st.select.split(',').map((c) => c.trim());
            return { data: Object.fromEntries(cols.filter((c) => c in profile).map((c) => [c, profile[c]])), error: null };
          }
          if (table === 'user_locations') return { data: linked ? { location_id: 'L' } : null, error: null };
          if (table === 'locations') return { data: venueOrg ? { org_id: venueOrg } : null, error: null };
          return { data: null, error: null };
        },
      };
      return q;
    },
  };
}

test('the profile read takes stock_control, and before 20261021a falls back to role and org_id (nobody refused who passes today)', async () => {
  const missing = { code: '42703', message: 'column user_profiles.stock_control does not exist' };
  assert.equal(isMissingColumn(missing, 'stock_control'), true);
  assert.equal(isMissingColumn({ code: '42703', message: 'column user_profiles.other does not exist' }, 'stock_control'), false, 'another column is a real error');
  assert.equal(isMissingColumn({ code: '57014', message: 'canceling statement due to statement timeout' }, 'stock_control'), false);
  assert.equal(isMissingColumn(null), false);

  const now = fakeSb({ profile: { role: 'manager', org_id: A, stock_control: 'all' } });
  assert.deepEqual(await readReachProfile(now, 'u1'), { role: 'manager', org_id: A, stock_control: 'all' });
  assert.equal(now.calls.length, 1);

  const before = fakeSb({ profileError: missing, profile: { role: 'owner', org_id: A, stock_control: 'all' } });
  assert.deepEqual(await readReachProfile(before, 'u1'), { role: 'owner', org_id: A }, 'no stock_control before the migration');
  assert.equal(before.calls.length, 2);

  const broken = fakeSb({ profileError: { code: '57014', message: 'timeout' }, profile: { role: 'owner', org_id: A } });
  assert.equal(await readReachProfile(broken, 'u1'), null, 'any other failure reads as no profile (refuses, never widens)');
  assert.equal(await readReachProfile(null, 'u1'), null);
});

test('readOfficeReachFacts reads the link, the profile and the venue company; nothing for an anonymous session', async () => {
  const sb = fakeSb({ profile: { role: 'manager', org_id: A, stock_control: 'all' }, linked: false, venueOrg: A });
  const facts = await readOfficeReachFacts(sb, user, 'L');
  assert.deepEqual(facts, { user, profile: { role: 'manager', org_id: A, stock_control: 'all' }, linked: false, venueOrgId: A });
  assert.equal(officeReachesVenue(facts).ok, false);
  assert.deepEqual(stockOfficeReachesVenue(facts), { ok: true, via: 'stock_control' });
  const anon = fakeSb({ profile: { role: 'owner', org_id: A }, linked: true, venueOrg: A });
  assert.deepEqual(await readOfficeReachFacts(anon, { id: 'd', is_anonymous: true }, 'L'), { user: { id: 'd', is_anonymous: true }, profile: null, linked: false, venueOrgId: null });
  assert.equal(anon.calls.length, 0, 'nothing is read for a device session');
});

test('manager-approve: the everything rule for every action, the stock rule only for po.raise, po.receive and stock.* (source)', () => {
  const src = code(read('supabase/functions/manager-approve/index.ts'));
  assert.match(src, /import \{ officeReachesVenue, stockOfficeReachesVenue, readOfficeReachFacts \} from '\.\.\/_shared\/stockOfficeReach\.js';/);
  assert.match(src, /const isStockAction = \(action: string\) => action === 'po\.raise' \|\| action === 'po\.receive' \|\| action\.startsWith\('stock\.'\);/);
  assert.match(src, /return \(stockAction \? stockOfficeReachesVenue\(facts\) : officeReachesVenue\(facts\)\)\.ok;/);
  // both fences ask the same question with the same action kind
  assert.match(src, /const stockAction = isStockAction\(String\(action\)\);/);
  assert.match(src, /if \(!\(await deviceAuthorized\(caller, loc, stockAction\)\)\) return json\(\{ error: 'no access to this location' \}, 403\);/);
  assert.match(src, /const op = pin \? await resolveOperator\(loc, pin\) : await boOperator\(caller, loc, stockAction\);/);
  // no link only check left
  assert.doesNotMatch(src, /if \(!ul && prof\?\.role !== 'super_admin'\) return null;/);
  assert.doesNotMatch(src, /return !!\(ul \|\| prof\?\.role === 'super_admin'\);/);
  // the timesheet and time off actions are not stock actions
  for (const a of ['timesheet.clock_out', 'timesheet.approve', 'timeoff.decide']) assert.ok(!(a === 'po.raise' || a === 'po.receive' || a.startsWith('stock.')), a);
});

test('manager-approve: the staff PIN rule (any staff PIN for the phone\'s stock steps, a manager PIN to approve a count) (source)', () => {
  const src = code(read('supabase/functions/manager-approve/index.ts'));
  assert.match(src, /if \(action === 'stock\.count_approve' && !pin\) return json\(\{ error: 'PIN required' \}, 403\);/);
  assert.match(src, /const staffPinEnough = String\(action\)\.startsWith\('stock\.'\) && action !== 'stock\.count_approve';/);
  assert.match(src, /if \(!staffPinEnough && !canApprove\(op\)\) return json\(\{ error: 'not allowed to approve' \}, 403\);/);
  // the PIN check comes before the try block that runs any action
  assert.ok(src.indexOf('const staffPinEnough') < src.indexOf("if (action === 'timesheet.clock_out')"));
  // the stock steps are landed before the unknown action line, each named
  const stock = src.slice(src.indexOf("if (String(action).startsWith('stock.')) {"), src.lastIndexOf("return json({ error: 'unknown action' }, 400);"));
  for (const a of ['stock.areas', 'stock.count_open', 'stock.items', 'stock.count_sheet', 'stock.count_save', 'stock.count_approve', 'stock.waste']) assert.match(stock, new RegExp(`action === '${a.replace('.', '\\.')}'`), a);
  assert.match(stock, /stockPhone\.approve\(sb, loc, String\(target_id\), who, \{ id: op\.id, name: op\.name \|\| null \}\)/, 'the PIN holder goes to the count');
  assert.match(stock, /if \(out\?\.code === 'needs_cost'\) return json\(\{ ok: false, code: 'needs_cost', needs_cost: out\.needs_cost \|\| \[\], error: out\.error \}, 200\);/, 'the phone can name the items with no cost');
});

test('manager-approve: the old receive fallback is gone; archived packs and bridges are left out of new orders and receives (source)', () => {
  const src = code(read('supabase/functions/manager-approve/index.ts'));
  assert.doesNotMatch(src, /costAfterReceipt|post_stock_movement|from\('item_cost_history'\)|current_cost: newAvg|oneCall/, 'no browser style cost writer on the phone path');
  assert.match(src, /sb\.rpc\('stock_receive', \{/);
  assert.match(src, /if \(missing\) return json\(\{ error: 'could not book the order into stock: this needs a database update\. Nothing was received\. Ask ServOS to run it\.', done: false \}, 503\);/);
  const raise = src.slice(src.indexOf("if (action === 'po.raise') {"), src.indexOf("if (action === 'po.receive') {"));
  assert.match(raise, /stockPhone\.liveOrAll\(\(live: boolean\) => stockPhone\.liveFilter\(sb\.from\('supplier_products'\)/);
  assert.match(raise, /stockPhone\.liveOrAll\(\(live: boolean\) => stockPhone\.liveFilter\(sb\.from\('inventory_item_conversions'\)/);
  const recv = src.slice(src.indexOf("if (action === 'po.receive') {"));
  assert.match(recv, /stockPhone\.liveOrAll\(\(live: boolean\) => stockPhone\.liveFilter\(sb\.from\('inventory_item_conversions'\)\.select\('\*'\)/);
});

test('manager-snapshot: the everything rule for the whole snapshot; Stock control all alone gets the stock blocks only (source)', () => {
  const src = code(read('supabase/functions/manager-snapshot/index.ts'));
  assert.match(src, /if \(officeReachesVenue\(facts\)\.ok\) return \{ ok: true, scope: 'all' \};/);
  assert.match(src, /if \(stockOfficeReachesVenue\(facts\)\.ok\) return \{ ok: true, scope: 'stock' \};/);
  assert.ok(src.indexOf("if (officeReachesVenue(facts).ok) return { ok: true, scope: 'all' }") < src.indexOf("if (stockOfficeReachesVenue(facts).ok) return { ok: true, scope: 'stock' }"), 'the everything rule is asked first');
  assert.match(src, /const full = acc\.scope === 'all';/);
  // sales, team and floor are not even read for a stock only caller
  assert.match(src, /= !full\s+\? \[\[\], \[\], \{ data: null \}, \[\], \[\], \[\], \[\], \[\]\] as any\[\]\s+: await Promise\.all\(\[/);
  assert.match(src, /let pendingTimesheets: any\[\] = \[\], pendingTimeOff: any\[\] = \[\];\s+if \(full\) try \{/);
  assert.match(src, /let ops = \{ openMaintenance: 0, activeAlerts: 0 \};\s+if \(full\) try \{/);
  // ...and never answered
  assert.match(src, /money: full \? money : null,/);
  assert.match(src, /floor: full \? floor : null,/);
  assert.match(src, /team: full \? \{ punches, shifts: teamShifts, ratesMinor, pendingTimesheets, pendingTimeOff, breakPolicy \} : null,/);
  assert.match(src, /ops: full \? ops : null,/);
  assert.match(src, /kitchen: \{ items: kitchenItems, deliveries: kitchenDeliveries, batches: kitchenBatches, trackedItems \},/);
  // the phone's Count stock button reads the tracked item count
  assert.match(src, /\.select\('id', \{ count: 'exact', head: true \}\)\s+\.eq\('location_id', loc\)\.is\('archived_at', null\)\.eq\('is_tracked', true\);/);
  // archived supplier prices and bridges are left out of the order lists; the open order pack codes keep them (history)
  assert.match(src, /pagedRows\('supplier packs', \(\) => liveFilter\(sb\.from\('supplier_products'\)/);
  assert.match(src, /pagedRows\('unit conversions', \(\) => liveFilter\(sb\.from\('inventory_item_conversions'\)/);
  assert.match(src, /pagedRows\('pack codes', \(\) => sb\.from\('supplier_products'\)\.select\('id, inventory_item_id, supplier_id, supplier_sku'\)/);
});

test('po-send and xero-bills take the stock reach; owner-snapshot and the non stock functions keep theirs (source)', () => {
  const po = code(read('supabase/functions/po-send/index.ts'));
  assert.match(po, /reach = stockOfficeReachesVenue\(\{ user: u, profile: prof \|\| null, linked, venueOrgId: venue\?\.org_id \|\| null \}\);/);
  assert.match(po, /readReachProfile\(admin, u\.id\)/);
  const xb = code(read('supabase/functions/xero-bills/index.ts'));
  assert.match(xb, /const facts = await readOfficeReachFacts\(sb, caller, opsLocationId\);/);
  assert.match(xb, /const reach = office\.ok \? office : stockOfficeReachesVenue\(facts\);/);
  // the Owner app shows sales: never the Stock control branch (plan 6.2, owner-snapshot is Drop 4)
  assert.doesNotMatch(read('supabase/functions/owner-snapshot/index.ts'), /stockOfficeReachesVenue/);
  // venueWriter (bookings, marketing, reviews, location-admin writes) is not widened (open question 3)
  assert.doesNotMatch(read('supabase/functions/_shared/venueWriter.js'), /stock_control|stockOfficeReachesVenue/);
  assert.doesNotMatch(read('supabase/functions/location-admin/index.ts'), /stockOfficeReachesVenue/);
});
