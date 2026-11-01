// 5.12.8: the Header and navigation card's pure half (navDraft.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoNavRows, navRowsFrom, navPatchFrom, moveRow, moveSibling, setUnder, removeRow, orderedRows, parentOptions, headerDraft, MAX_NAV_ITEMS } from './navDraft.js';
import { navProblems, settingsProblems, themeProblems } from '../../../../supabase/functions/_shared/websiteRules.js';

const pages = [
  { id: 'p1', slug: '', title: 'Home', kind: 'home', status: 'published' },
  { id: 'p2', slug: 'menu', title: 'Menu', kind: 'menu', status: 'published' },
  { id: 'p3', slug: 'leeds', title: 'Leeds', kind: 'location', status: 'published' },
  { id: 'p4', slug: 'story', title: 'Our story', kind: 'custom', status: 'draft' },
];

test('no saved nav: the automatic list (published pages, no venue pages), marked auto', () => {
  const { rows, auto } = navRowsFrom({ nav: [] }, pages);
  assert.equal(auto, true);
  assert.deepEqual(rows.map((r) => [r.label, r.page_id]), [['Home', 'p1'], ['Menu', 'p2']]);
  assert.deepEqual(autoNavRows(null), []);
});

test('saved nav: rows by id or slug, link rows kept, a missing page keeps its id so the owner sees it', () => {
  const site = { nav: [{ label: 'Home', kind: 'page', page_id: 'p1' }, { label: 'Food', kind: 'page', page_id: 'menu' }, { label: 'Insta', kind: 'link', href: 'https://instagram.com/x' }, { label: 'Old', kind: 'page', page_id: 'gone' }, null] };
  const { rows, auto } = navRowsFrom(site, pages);
  assert.equal(auto, false);
  assert.deepEqual(rows.map((r) => [r.label, r.kind, r.page_id, r.href]), [['Home', 'page', 'p1', ''], ['Food', 'page', 'p2', ''], ['Insta', 'link', '', 'https://instagram.com/x'], ['Old', 'page', 'gone', '']]);
});

test('navPatchFrom: what the server accepts, and plain problems for the rest', () => {
  const good = navPatchFrom([{ label: ' Home ', kind: 'page', page_id: 'p1' }, { label: 'Insta', kind: 'link', href: 'https://instagram.com/x' }, { label: 'Menu', kind: 'link', href: '/menu' }]);
  assert.deepEqual(good.errors, []);
  assert.deepEqual(good.nav, [{ label: 'Home', kind: 'page', page_id: 'p1' }, { label: 'Insta', kind: 'link', href: 'https://instagram.com/x' }, { label: 'Menu', kind: 'link', href: '/menu' }]);
  assert.deepEqual(navProblems(good.nav), [], 'the server agrees');
  const bad = navPatchFrom([{ label: '', kind: 'page', page_id: 'p1' }, { label: 'x'.repeat(61), kind: 'page', page_id: 'p1' }, { label: 'No page', kind: 'page', page_id: '' }, { label: 'No link', kind: 'link', href: '' }, { label: 'Odd', kind: 'link', href: 'javascript:alert(1)' }]);
  assert.equal(bad.errors.length, 5);
  assert.match(bad.errors[0], /Item 1 needs a label/);
  assert.match(bad.errors[4], /starts with https/);
  const many = navPatchFrom(Array.from({ length: MAX_NAV_ITEMS + 1 }, (_, i) => ({ label: `L${i}`, kind: 'link', href: '/x' })));
  assert.match(many.errors[0], /at most 30/);
});

test('moveRow swaps neighbours and never falls off an end', () => {
  const rows = ['a', 'b', 'c'];
  assert.deepEqual(moveRow(rows, 0, 1), ['b', 'a', 'c']);
  assert.deepEqual(moveRow(rows, 2, -1), ['a', 'c', 'b']);
  assert.equal(moveRow(rows, 0, -1), rows);
  assert.equal(moveRow(rows, 2, 1), rows);
});

test('headerDraft fills defaults; the server validates settings.header the same way', () => {
  assert.deepEqual(headerDraft(null), { brand: 'logo', cta: 'none', sticky: true, logo_size: 'normal' });
  assert.deepEqual(headerDraft({ settings: { header: { brand: 'both', cta: 'book', sticky: false, logo_size: 'xlarge' } } }), { brand: 'both', cta: 'book', sticky: false, logo_size: 'xlarge' });
  assert.deepEqual(headerDraft({ settings: { header: { brand: 'x', cta: 'y', sticky: 'z', logo_size: 'giant' } } }), { brand: 'logo', cta: 'none', sticky: true, logo_size: 'normal' });
  assert.deepEqual(settingsProblems({ header: { brand: 'both', cta: 'order', sticky: true, logo_size: 'large' } }), []);
  // 5.12.15: the server accepts the four logo sizes and nothing else.
  assert.equal(settingsProblems({ header: { logo_size: 'giant' } }).length, 1);
  assert.deepEqual(settingsProblems({ header: null }), []);
  assert.equal(settingsProblems({ header: 'x' }).length, 1);
  const bad = settingsProblems({ header: { brand: 'huge', cta: 'buy', sticky: 'yes', colour: 'red' } });
  assert.equal(bad.length, 4, bad.join(' | '));
});


// ── 5.12.12 nav dropdowns, 5.12.19 rows under rows ──────────────────────────────
test('dropdown rows: a locations item and a group come back as rows (the group as a parent with rows under it) and go out the same', () => {
  const site = { nav: [{ label: 'Locations', kind: 'locations' }, { label: 'Menu', kind: 'group', page_id: 'menu', children: [{ label: 'Brunch', kind: 'page', page_id: 'menu' }, { label: 'News', kind: 'link', href: '/blog' }] }, { label: 'More', kind: 'group', children: [{ label: 'Home', kind: 'page', page_id: 'p1' }] }] };
  const { rows, auto } = navRowsFrom(site, pages);
  assert.equal(auto, false);
  assert.deepEqual(rows.map((r) => [r.label, r.kind, r.page_id, r.href, r.under ? rows.find((x) => x.key === r.under).label : '']), [
    ['Locations', 'locations', '', '', ''], ['Menu', 'page', 'p2', '', ''], ['Brunch', 'page', 'p2', '', 'Menu'], ['News', 'link', '', '/blog', 'Menu'], ['More', 'group', '', '', ''], ['Home', 'page', 'p1', '', 'More'],
  ]);
  assert.deepEqual(orderedRows(rows).map((r) => r.label), ['Locations', 'Menu', 'Brunch', 'News', 'More', 'Home']);
  const out = navPatchFrom(rows);
  assert.deepEqual(out.errors, []);
  assert.deepEqual(out.nav, [
    { label: 'Locations', kind: 'locations' },
    { label: 'Menu', kind: 'group', page_id: 'p2', children: [{ label: 'Brunch', kind: 'page', page_id: 'p2' }, { label: 'News', kind: 'link', href: '/blog' }] },
    { label: 'More', kind: 'group', children: [{ label: 'Home', kind: 'page', page_id: 'p1' }] },
  ]);
  assert.deepEqual(navProblems(out.nav), [], 'the server agrees');
  const bad = navPatchFrom([{ key: 'g', label: 'Empty', kind: 'group', page_id: '', href: '', under: '' }]);
  assert.equal(bad.errors.length, 1);
  assert.ok(bad.errors[0].includes('nothing under it'));
  const loc = navPatchFrom([{ key: 'l', label: 'Shops', kind: 'locations', page_id: '', href: '', under: '' }, { key: 'c', label: 'Menu', kind: 'page', page_id: 'p2', href: '', under: 'l' }]);
  assert.ok(loc.errors[0].includes('nothing can sit under it'));
});

test('setUnder, removeRow, moveSibling: one level deep, nothing lost, moves stay among siblings', () => {
  const { rows } = navRowsFrom({ nav: [{ label: 'Home', kind: 'page', page_id: 'p1' }, { label: 'Menu', kind: 'page', page_id: 'p2' }, { label: 'Leeds', kind: 'page', page_id: 'p3' }, { label: 'Shops', kind: 'locations' }] }, pages);
  const [home, menu, leeds, shops] = rows;
  assert.deepEqual(parentOptions(rows, leeds.key).map((r) => r.label), ['Home', 'Menu'], 'not itself, not the venues dropdown');
  let r1 = setUnder(rows, leeds.key, menu.key);
  assert.equal(r1.find((r) => r.key === leeds.key).under, menu.key);
  assert.equal(setUnder(r1, menu.key, home.key).find((r) => r.key === leeds.key).under, '', 'a parent that moves under another lifts its own rows (one level only)');
  assert.equal(setUnder(r1, shops.key, home.key), r1, 'a venues dropdown cannot sit under anything');
  assert.equal(setUnder(r1, home.key, leeds.key), r1, 'a row under another cannot hold rows');
  const r2 = removeRow(r1, menu.key);
  assert.deepEqual(r2.map((r) => [r.label, r.under]), [['Home', ''], ['Shops', ''], ['Leeds', '']], 'removing a parent lifts its rows');
  r1 = setUnder(r1, home.key, menu.key);
  assert.deepEqual(orderedRows(r1).map((r) => r.label), ['Menu', 'Leeds', 'Home', 'Shops']);
  const r3 = moveSibling(r1, home.key, -1);
  assert.deepEqual(orderedRows(r3).map((r) => r.label), ['Menu', 'Home', 'Leeds', 'Shops'], 'moves among the rows under Menu');
  assert.equal(moveSibling(r3, home.key, -1), r3, 'already first');
  assert.deepEqual(orderedRows(moveSibling(r3, shops.key, -1)).map((r) => r.label), ['Shops', 'Menu', 'Home', 'Leeds'], 'a top row moves among top rows');
});


// ── 5.12.15: site colours the server accepts ────────────────────────────────────────────────
test('themeProblems accepts bg_color, card_color and text_color as hex or null and refuses anything else', () => {
  assert.deepEqual(themeProblems({ mood: 'light', bg_color: '#1A237E', card_color: null, text_color: '#ffffff' }), []);
  assert.equal(themeProblems({ bg_color: 'blue' }).length, 1);
  assert.equal(themeProblems({ bg_color: '#fff' }).length, 1, 'six digits only, like brand_color');
  assert.equal(themeProblems({ page_color: '#ffffff' }).length, 1, 'an unknown theme key is refused');
});
