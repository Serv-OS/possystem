// Multi site menu, 17 Oct 2026 recheck (screens, drafts and the kiosk). Each test here failed on the
// branch at 4f3a576d and passes after the fix. Made up sites and products only (the repo is public).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { proposeImport, buildCentral } from '../../../supabase/functions/_shared/msmImport.js';
import { applyChanges, mergeStaged, changeKey, previewSet } from '../../../supabase/functions/_shared/msmDiff.js';
import { planAddSite } from '../../../supabase/functions/_shared/msmSites.js';
import { previewHeadline } from './msmPublishView.js';
import { siteActiveChange, activeMany } from './msmEdit.js';
import { summarise } from './msmSummary.js';
import { sizeVatWords } from './msmWords.js';
import { statusBar, undoFor, draftCount, siteCount, countWords } from './msmStatus.js';
import { idGen, A, C, venues, importSites } from './msmFixture.js';
import { planJoinSite, planJoinSiteAsync, joinableProducts } from './msmBringIn.js';
import { createKioskRefresh, kioskRetryDelayMs, KIOSK_RETRY_FIRST_MS, KIOSK_RETRY_MAX_MS, KIOSK_READ_GIVE_UP_MS } from './msmTillWatch.js';
import { groupVenues, groupSites } from './msmGroupFixture.js';

function fold(rows, changes) {
  const by = new Map(rows.map((r) => [changeKey(r), r]));
  for (const c of changes) {
    const m = mergeStaged(by.get(changeKey(c)) || null, c);
    if (m.action === 'insert' || m.action === 'update') by.set(changeKey(c), m.row);
    else if (m.action === 'delete') by.delete(changeKey(c));
  }
  return [...by.values()];
}
const all = (r) => (r.changes ? r.changes : [r.change, ...(r.extra || [])]).filter(Boolean);
const keys = (rows) => rows.map((r) => `${changeKey(r)}:${r.op}`).sort();

// Pie is sold at Site C only, with a required "Pie size" group (Then ask "Pie sauce") and an
// optional "Pie extras" group that only C has. Pasty (also at C only) uses the same groups.
function pieAtC() {
  const v = groupVenues();
  const c = v[C];
  c.groups.push(
    { id: 'mgd-piesize', location_id: C, name: 'Pie size', min: 1, max: 1, selection_type: 'single', sort_order: 5, options: [{ id: 'opt-small', name: 'Small', price: 0, subGroupId: 'mgd-sauce' }, { id: 'opt-big', name: 'Big', price: 1 }] },
    { id: 'mgd-sauce', location_id: C, name: 'Pie sauce', min: 1, max: 1, selection_type: 'single', sort_order: 6, options: [{ id: 'opt-gravy', name: 'Gravy', price: 0 }] },
    { id: 'mgd-pieext', location_id: C, name: 'Pie extras', min: 0, max: 3, selection_type: 'multiple', sort_order: 7, options: [{ id: 'opt-peas', name: 'Peas', price: 0.5 }] },
  );
  c.items.find((i) => i.id === 'l-pie-c').assigned_modifier_groups = [{ groupId: 'mgd-piesize' }, { groupId: 'mgd-pieext' }];
  const sites = groupSites(v);
  const built = buildCentral(proposeImport(sites, { idGen: idGen() }), sites, {}, { idGen: idGen('g') });
  assert.ok(built.check.ok, JSON.stringify(built.check.problems));
  const central = built.central;
  central.menu = { id: '99999999-0000-4000-8000-000000000001', name: 'Group menu', description: '', use_name_everywhere: false, refreshed_at: '2026-10-17' };
  const pie = central.products.find((p) => p.name === 'Pie');
  central.products.push({ ...pie, id: 'eeeeeeee-0000-4000-8000-0000000000e1', name: 'Pasty', menu_name: 'Pasty', family_base: null, sort_order: 99 });
  central.productSites.push({ product_id: 'eeeeeeee-0000-4000-8000-0000000000e1', location_id: C, venue_item_id: 'l-pasty-c', active: true, price: null, channel_prices: null, kept: {} });
  return { v, central, pie, pasty: central.products.find((p) => p.name === 'Pasty') };
}

test('recheck 1: turning a product with option groups on at a site and off again leaves nothing in the draft', () => {
  const { central, pie } = pieAtC();
  let rows = fold([], all(siteActiveChange({ live: central, eff: central }, pie.id, A, true)));
  assert.equal(rows.filter((r) => r.target === 'modifier_option_site').length, 4, 'on at A stages its 4 option rows');
  const eff = applyChanges(central, rows).central;
  const off = siteActiveChange({ live: central, eff }, pie.id, A, false);
  assert.ok(off.change.dropCreate);
  rows = fold(rows, all(off));
  assert.deepEqual(rows, [], 'off again: the product row and its option rows are gone');
  assert.deepEqual(summarise(rows, central), [], 'the summary says nothing is turned on');
  assert.match(statusBar({ working: { status: 'draft', title: 'x' }, rows }).words, /Empty so far/);
});

test('recheck 1: only the option rows that turn on staged go (another product still on there keeps them)', () => {
  const { central, pie, pasty } = pieAtC();
  let rows = fold([], all(siteActiveChange({ live: central, eff: central }, pie.id, A, true)));
  let eff = applyChanges(central, rows).central;
  rows = fold(rows, all(siteActiveChange({ live: central, eff }, pasty.id, A, true)));
  assert.equal(rows.filter((r) => r.target === 'modifier_option_site').length, 4, 'Pasty needs no new rows: Pie staged them');
  // Pie off: Pasty is still on at A and needs the groups, so the option rows stay.
  eff = applyChanges(central, rows).central;
  const pieOff = siteActiveChange({ live: central, eff }, pie.id, A, false);
  assert.ok(!all(pieOff).some((c) => c.target === 'modifier_option_site'));
  rows = fold(rows, all(pieOff));
  assert.deepEqual(keys(rows).filter((k) => k.startsWith('product_site')), [`product_site|${pasty.id}|${A}:create`]);
  assert.equal(rows.filter((r) => r.target === 'modifier_option_site').length, 4);
  // Pasty off too: now nothing needs them.
  eff = applyChanges(central, rows).central;
  rows = fold(rows, all(siteActiveChange({ live: central, eff }, pasty.id, A, false)));
  assert.deepEqual(rows, []);
  // Both off in one bulk action: the same.
  let both = fold([], all(activeMany({ live: central, eff: central }, [pie.id, pasty.id], [A], true)));
  assert.equal(both.filter((r) => r.target === 'modifier_option_site').length, 4);
  eff = applyChanges(central, both).central;
  both = fold(both, all(activeMany({ live: central, eff }, [pie.id, pasty.id], [A], false)));
  assert.deepEqual(both, [], 'bulk Turn off at takes the option rows out with them');
  // A site where the group already is (live) is never touched: Latte off at C keeps every option row.
  const latte = central.products.find((p) => p.name === 'Latte');
  assert.ok(!all(siteActiveChange({ live: central, eff: central }, latte.id, C, false)).some((c) => c.target === 'modifier_option_site'));
});

test('recheck 2: Undo on "taken out of the draft again" stages the turn on again, exactly as it was', () => {
  const { central, pie } = pieAtC();
  const before = fold([], all(siteActiveChange({ live: central, eff: central }, pie.id, A, true)));
  const eff = applyChanges(central, before).central;
  const off = all(siteActiveChange({ live: central, eff }, pie.id, A, false));
  const back = undoFor(eff, off, before);
  assert.ok(!back.updates.some((u) => u.target === 'product_site' && u.entity_id === pie.id), 'never an update for a row that is gone (the guard refused it)');
  assert.equal(back.restage.length, 5, 'the product row and its 4 option rows come back');
  const after = fold(before, off);
  assert.deepEqual(after, []);
  const undone = fold(after, [...back.restage, ...back.updates]);
  assert.deepEqual(keys(undone), keys(before));
  for (const r of before) assert.deepEqual(undone.find((u) => changeKey(u) === changeKey(r)).after, r.after);
  // The screen wires it: the Undo stages back.restage.
  const screen = fs.readFileSync(new URL('../../backoffice/sections/msm/MultiSiteMenu.jsx', import.meta.url), 'utf8');
  assert.match(screen, /undoFor\(effRef\.current, list, rowsRef\.current\)/);
  assert.match(screen, /\.\.\.\(back\.restage \|\| \[\]\)/);
});

// ── Recheck 3: the kiosk's re read after a head office update ────────────────
function fakeTimers() {
  let now = 0, seq = 0;
  const jobs = new Map();
  return {
    setTimeout: (fn, ms) => { const id = ++seq; jobs.set(id, { at: now + ms, fn }); return id; },
    clearTimeout: (id) => { jobs.delete(id); },
    pending: () => jobs.size,
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...jobs.entries()].filter(([, j]) => j.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        jobs.delete(next[0]);
        now = next[1].at;
        next[1].fn();
      }
      now = end;
    },
  };
}

test('recheck 3: a kiosk that never hears of a head office update sets no timer and reads nothing', () => {
  const timers = fakeTimers();
  let reads = 0;
  const ctl = createKioskRefresh({ isIdle: () => true, reload: () => { reads++; }, timers });
  timers.advance(60 * 60 * 1000);
  assert.equal(reads, 0);
  assert.equal(timers.pending(), 0);
  ctl.stop();
});

test('recheck 3: the kiosk waits for the read in flight, never starts a second one, and backs off to 5 minutes', () => {
  const timers = fakeTimers();
  let idle = false, reads = 0;
  const ctl = createKioskRefresh({ isIdle: () => idle, reload: () => { reads++; }, timers });
  ctl.heard();
  timers.advance(30000);
  assert.equal(reads, 0, 'never mid order');
  idle = true;
  timers.advance(5000);
  assert.equal(reads, 1, 'read at the next idle moment');
  // A slow link: the read takes a minute. No second read starts meanwhile (the old loop asked
  // again every 5 seconds and threw this one away).
  ctl.heard();
  timers.advance(60000);
  assert.equal(reads, 1);
  ctl.readDone(false);
  // Failed: 5 s, then 10 s, 20 s ... never more than 5 minutes apart.
  const waits = [];
  for (let i = 0; i < 9; i++) {
    const before = reads;
    let waited = 0;
    while (reads === before) { timers.advance(1000); waited += 1000; }
    waits.push(waited);
    ctl.readDone(false);
  }
  assert.deepEqual(waits, [5000, 10000, 20000, 40000, 80000, 160000, 300000, 300000, 300000]);
  assert.equal(kioskRetryDelayMs(1), KIOSK_RETRY_FIRST_MS);
  assert.equal(kioskRetryDelayMs(50), KIOSK_RETRY_MAX_MS);
  // A good read covers both updates heard: nothing more.
  timers.advance(KIOSK_RETRY_MAX_MS);
  ctl.readDone(true);
  const settled = reads;
  timers.advance(60 * 60 * 1000);
  assert.equal(reads, settled);
  assert.equal(timers.pending(), 0);
  ctl.stop();
});

test('recheck 3: an update heard during a read is read once more after it; a read that never answers counts as failed', () => {
  const timers = fakeTimers();
  let reads = 0;
  const ctl = createKioskRefresh({ isIdle: () => true, reload: () => { reads++; }, timers });
  ctl.heard();
  assert.equal(reads, 1);
  ctl.heard();
  ctl.readDone(true);
  assert.equal(reads, 2, 'the newer update is read too');
  // The second read hangs: after 2 minutes it counts as failed and the next one follows.
  timers.advance(KIOSK_READ_GIVE_UP_MS);
  assert.equal(ctl.state().reading, false);
  timers.advance(KIOSK_RETRY_FIRST_MS);
  assert.equal(reads, 3);
  ctl.readDone(true);
  assert.equal(ctl.state().have, ctl.state().wanted);
  ctl.stop();
});

test('recheck 3: the kiosk wiring: first load as before the multi site menu, re reads through the controller', () => {
  const kiosk = fs.readFileSync(new URL('../../surfaces/KioskApp.jsx', import.meta.url), 'utf8');
  // The first load is the code the kiosk ran before (main), untouched.
  assert.ok(kiosk.includes(`          setData({
            items: iRes.data || [],
            categories: cRes.data || [],
            menus: mRes.data || [],
            links: lRes.data || [],
            // v5.7.33: both reads must have succeeded - never keep line-less profiles.
            taxProfiles: (Array.isArray(tpRes.data) && Array.isArray(tlRes.data))
              ? assembleTaxProfiles(tpRes.data, tlRes.data) : [],
            // v5.7.34: venue default profile for the seam's cascade step 4.
            venueDefaultTaxProfileId: defRes?.data?.default_tax_profile_id ?? null,
          });`));
  assert.match(kiosk, /if \(reloadKey > 0\) \{/);
  const hook = kiosk.slice(kiosk.indexOf('function useMsmKioskRefresh'), kiosk.indexOf('// PRICING'));
  assert.ok(hook.includes('createKioskRefresh('));
  assert.ok(!/setInterval\(tryNow/.test(hook), 'no 5 second re read loop');
  // Before it has heard of a head office update: no read at load and no catch up timer.
  assert.match(hook, /if \(heardBefore\) \{\n\s+\/\/ The newest push at load is what this kiosk already reads\.\n\s+latest\(\)/);
  assert.equal((hook.match(/setInterval\(/g) || []).length, 1, 'the only timer is the catch up, started once a head office update was heard');
});

// ── Recheck 5: one counting rule on every screen ─────────────────────────────
test('recheck 5: one counting rule: products, option groups, categories and sites, in words', () => {
  const { v, central, pie } = pieAtC();
  // Pie on at A brings 4 option rows: the status bar said "5 changes"; it is one product.
  const on = all(siteActiveChange({ live: central, eff: central }, pie.id, A, true));
  const rows = fold([], on);
  const eff = applyChanges(central, rows).central;
  assert.equal(rows.length, 5);
  assert.equal(draftCount(rows, eff).words, '1 product changed');
  const bar = statusBar({ working: { status: 'draft', title: 'x' }, rows, central: eff });
  assert.equal(bar.words, '1 product changed, not on the tills yet.');
  assert.equal(bar.count, 1);
  // The publish tab: the same words, with the sites it reaches; the site tab counts the same way
  // (the groups Pie brings to A are part of Pie).
  const preview = previewSet(central, rows, v, { orgId: 'org' });
  assert.equal(previewHeadline(preview, draftCount(rows, eff)).words, '1 product changed at 1 site');
  const a = preview.sites.find((s) => s.location_id === A);
  assert.ok(a.plan.lines.length >= 5, 'a category, 3 option groups and the product are written at A');
  assert.equal(siteCount(a.plan.lines, preview.after, A).words, '1 product changed');
  // A size counts with its product; an option change counts as its option group.
  const latte = central.products.find((p) => p.name === 'Latte');
  const cola = central.products.find((p) => p.name === 'Cola');
  const opt = central.options.find((o) => !o.archived);
  const mixed = [
    { target: 'product', entity_id: latte.id, location_id: null, op: 'update', after: { default_price: 3.3 } },
    { target: 'product_site', entity_id: cola.id, location_id: A, op: 'update', after: { price: 2.2 } },
    { target: 'product_site', entity_id: cola.id, location_id: C, op: 'update', after: { price: 2.4 } },
    { target: 'modifier_option', entity_id: opt.id, location_id: null, op: 'update', after: { price: 0.6 } },
    { target: 'modifier_option_site', entity_id: opt.id, location_id: A, op: 'update', after: { price: 0.7 } },
    { target: 'category', entity_id: 'cat-new', location_id: null, op: 'create', after: { label: 'Soups' } },
  ];
  assert.equal(draftCount(mixed, central).words, '2 products, 1 option group and 1 category changed');
  // Add a site: one site added, its products changed; the option rows it brings count with them.
  const add = planAddSite(central, { locationId: 'dddddddd-0000-4000-8000-0000000d0004', venueMenuId: null, prices: 'default' });
  const c = draftCount(add.changes, central);
  assert.equal(c.sites, 1);
  assert.equal(c.groups, 0);
  assert.equal(c.words, `1 site added, ${c.products} products changed`);
  assert.equal(countWords({}), '');
  assert.match(statusBar({ working: { status: 'draft', title: 'x' }, rows: [], central }).words, /Empty so far/);
});

test('recheck 5: every screen counts with draftCount, never the rows the database holds', () => {
  const read = (f) => fs.readFileSync(new URL(`../../backoffice/sections/msm/${f}`, import.meta.url), 'utf8');
  const uses = {
    'MultiSiteMenu.jsx': /const counted = draftCount\(rows, eff\);/,
    'MsmChangesPanel.jsx': /draftCount\(rows, eff\)/,
    'MsmPublish.jsx': /previewHeadline\(preview, counted\)/,
    'MsmProductSheet.jsx': /`Add to draft: \$\{draftCount\(plan\.changes, eff\)\.words\}`/,
    'MsmGroupSheet.jsx': /`Add to draft: \$\{draftCount\(result\.changes, eff\)\.words\}`/,
    'MsmCsv.jsx': /`Add to draft: \$\{draftCount\(result\.changes, eff\)\.words\}`/,
    'MsmChangePrices.jsx': /`Add to draft: \$\{draftCount\(staging, eff\)\.words\}`/,
    'MsmTimeline.jsx': /draftCount\(changesOf\[e\.set\.id\]/,
  };
  for (const [f, re] of Object.entries(uses)) assert.match(read(f), re, f);
  for (const f of Object.keys(uses)) {
    const src = read(f);
    assert.doesNotMatch(src, /\$\{(rows|plan\.changes|result\.changes|result\?\.changes|undo\.plan\.changes)\.length( \|\| 0)?\} change/, `${f} still counts rows`);
    assert.doesNotMatch(src, /\(\$\{rows\.length\}\)/, `${f} still counts rows`);
  }
});

// ── Recheck 4 and 7: small screen fixes ──────────────────────────────────────
test('recheck 4: the "Version N" label stays on one line in the publish history', () => {
  const src = fs.readFileSync(new URL('../../backoffice/sections/msm/MsmTimeline.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /width: 54, fontSize: 12/);
  assert.match(src, /data-testid="msm-version-label" style=\{\{ minWidth: VERSION_W, flexShrink: 0, whiteSpace: 'nowrap'/);
});

test('recheck 7: the product sheet says how sizes take their product\'s VAT by order type', () => {
  assert.equal(sizeVatWords({ size: true, product: 'Latte', taxByType: { takeaway: { name: 'Zero Rate', percent: 0 } } }),
    'This size follows Latte: Takeaway Zero Rate (0%). To change it, change it on Latte.');
  assert.match(sizeVatWords({ size: true, product: 'Latte', taxByType: {} }), /^This size uses its VAT for every order type, as Latte does\./);
  assert.equal(sizeVatWords({ size: false, sizes: 3 }), 'Its 3 sizes use these too.');
  assert.equal(sizeVatWords({ size: false, sizes: 0 }), '');
  const sheet = fs.readFileSync(new URL('../../backoffice/sections/msm/MsmProductSheet.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(sheet, /A size uses the VAT by order type of/);
  assert.match(sheet, /sizeVatWords\(\{ size: true/);
});

// ── Recheck 6: Add a site for a site that already sells the group's products ─
test('recheck 6: a site that already sells the group\'s products joins with them as they are, writing nothing there', () => {
  const v = venues();
  const sites = importSites(v).filter((s) => s.location_id !== C);
  const live = buildCentral(proposeImport(sites, { idGen: idGen() }), sites, {}, { idGen: idGen('g') }).central;
  live.menu = { id: '99999999-0000-4000-8000-000000000001', name: 'Group menu', refreshed_at: '2026-10-17' };
  const menuC = importSites(v).find((s) => s.location_id === C).venue_menu_id;
  // Add a site as before: Site C already sells the group's Latte, Mocha and Cola, so it is refused.
  const add = planAddSite(live, { locationId: C, venueMenuId: menuC, prices: 'default' });
  const before = previewSet(live, add.changes, v, { orgId: 'org' });
  assert.ok(before.sites[0].health.blocking.some((b) => b.code === 'site_has_product'), 'a plain Add a site still never takes a site\'s own products over');
  // Join: the site row plus Bring in for each of the group's products it sells.
  const j = planJoinSite(live, { locationId: C, venueMenuId: menuC, raw: v[C], idGen: idGen('j'), siteName: 'Site C' });
  assert.ok(j.ok, j.problems.join(' '));
  assert.deepEqual(j.linked, ['Cola', 'Latte', 'Mocha']);
  assert.deepEqual(j.own, ['Pie'], 'its own Pie stays its own');
  assert.equal(j.changes[0].target, 'menu_site');
  assert.ok(j.changes.filter((c) => c.target === 'product_site').every((c) => c.op === 'create' && c.after.kept && typeof c.after.kept === 'object'), 'every link carries what the site keeps');
  const pv = previewSet(live, j.changes, v, { orgId: 'org' });
  assert.ok(pv.ok, JSON.stringify(pv.sites.map((s) => s.health?.blocking)));
  assert.equal(pv.sites.find((s) => s.location_id === C).plan.lines.length, 0, 'publishing it writes nothing at Site C');
  assert.match(j.words[0], /^Site C joins the group menu with the 3 products of the group's it already sells/);
  // The words a manager reads: the new site counted the one way.
  assert.equal(draftCount(j.changes, applyChanges(live, j.changes).central).words, '1 site added, 3 products changed');
  // No menu of its own picked: said, nothing staged.
  assert.match(planJoinSite(live, { locationId: C, venueMenuId: null, raw: v[C], siteName: 'Site C' }).problems[0], /Pick the menu Site C's products are in/);
  // The screen offers it instead of the dead end.
  const screen = fs.readFileSync(new URL('../../backoffice/sections/msm/MsmSites.jsx', import.meta.url), 'utf8');
  assert.match(screen, /Join with what it sells now/);
  assert.match(screen, /planJoinSiteAsync\(live, \{ locationId: loc, venueMenuId: joinMenuId \|\| null, raw/);
  assert.match(screen, /Check what joining changes/);
  assert.doesNotMatch(screen, /bring its products in on the Sites tab instead/);
});

test('recheck 6: the join is worked out a product at a time (progress, and it stops when the sheet closes)', async () => {
  const v = venues();
  const sites = importSites(v).filter((s) => s.location_id !== C);
  const live = buildCentral(proposeImport(sites, { idGen: idGen() }), sites, {}, { idGen: idGen('g') }).central;
  live.menu = { id: '99999999-0000-4000-8000-000000000001', name: 'Group menu', refreshed_at: '2026-10-17' };
  const menuC = importSites(v).find((s) => s.location_id === C).venue_menu_id;
  assert.deepEqual(joinableProducts(live, C, v[C], menuC).map((o) => o.name), ['Cola', 'Latte', 'Mocha'], 'what Add a site says it joins with');
  const seen = [];
  const r = await planJoinSiteAsync(live, { locationId: C, venueMenuId: menuC, raw: v[C], idGen: idGen('j'), siteName: 'Site C' }, { onProgress: (d, t) => seen.push(`${d}/${t}`), pause: async () => {} });
  assert.ok(r.ok);
  assert.deepEqual(seen, ['1/4', '2/4', '3/4', '4/4']);
  assert.deepEqual(r.changes.map((c) => changeKey(c)), planJoinSite(live, { locationId: C, venueMenuId: menuC, raw: v[C], idGen: idGen('j'), siteName: 'Site C' }).changes.map((c) => changeKey(c)));
  let n = 0;
  const stopped = await planJoinSiteAsync(live, { locationId: C, venueMenuId: menuC, raw: v[C], siteName: 'Site C' }, { shouldStop: () => ++n > 1, pause: async () => {} });
  assert.equal(stopped, null);
});
